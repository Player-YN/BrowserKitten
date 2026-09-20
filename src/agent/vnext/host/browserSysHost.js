/**
 * Service-worker side of browserbot-sys-v1.
 * Guest never sees chrome.*. This file is the syscall implementation.
 */

import { isInjectableTabUrl } from '../sessionWorkspace/pageContext.js';
import { SYS_EVAL_JSON_MAX, SYS_EVAL_SOURCE_MAX, SYS_FETCH_BYTES_MAX, SYS_HELP, SYS_UPLOAD_BYTES_MAX, SYS_WAIT_TIMEOUT_MS, clampWaitTimeout } from '../sessionWorkspace/browserSys.js';
import { acquireTabLease, assertTabLeaseOwnerActive } from './tabLease.js';
import { readDocumentTarget, targetError } from './documentTarget.js';
import { consumeDispatchTicket } from './dispatchTicket.js';
import { classifyRisk, needsDispatchTicket } from './riskClassify.js';
import { hashOperationPayload } from './payloadHash.js';
import {
  applyUploadToTab,
  assertUploadGuestPath,
  coerceUploadBytes,
  hashUploadPayloadBytes,
  putUploadStageChunk,
  takeUploadStage,
  uploadOwnerKey,
  UPLOAD_BYTES_MAX
} from './uploadChannel.js';

function classifySysRequest(request, extras = {}) {
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const isUpload = request.op === 'upload';
  return {
    channel: 'sys',
    op: request.op,
    sysOp: request.op,
    url: extras.url || extras.frameUrl || params.url,
    frameUrl: extras.frameUrl || extras.url || params.url,
    method: isUpload ? '' : (extras.method || params.init?.method || params.method),
    uploadMethod: extras.uploadMethod || (isUpload ? (params.method || extras.method) : undefined),
    path: extras.path || params.path,
    bytesHash: extras.bytesHash,
    itemId: extras.itemId || params.itemId,
    artifactId: extras.artifactId || params.artifactId,
    code: params.code ?? params.source,
    action: params.action,
    tabId: extras.tabId ?? params.tabId,
    documentId: extras.documentId || params.documentId,
    init: params.init,
    bodyText: typeof params.init?.body === 'string' ? params.init.body : '',
    filename: extras.filename || params.filename
  };
}

async function authorizeSysDispatch(request, extras = {}) {
  const classifyInput = classifySysRequest(request, extras);
  const classified = classifyRisk(classifyInput);
  if (!needsDispatchTicket(classified)) return { ok: true, classified, skipped: true };
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const isUpload = request.op === 'upload';
  const payloadHash = await hashOperationPayload(isUpload
    ? {
        channel: 'sys',
        op: request.op,
        sysOp: request.op,
        url: extras.frameUrl || extras.url || params.url || '',
        frameUrl: extras.frameUrl || extras.url || '',
        method: '',
        path: extras.path || params.path || '',
        bytesHash: extras.bytesHash || '',
        itemId: extras.itemId || params.itemId || '',
        artifactId: extras.artifactId || params.artifactId || '',
        tabId: extras.tabId ?? params.tabId,
        documentId: extras.documentId || params.documentId || ''
      }
    : {
        channel: 'sys',
        op: request.op,
        sysOp: request.op,
        url: params.url || '',
        method: params.init?.method || params.method || '',
        code: params.code ?? params.source,
        tabId: extras.tabId ?? params.tabId,
        documentId: params.documentId || ''
      });
  return consumeDispatchTicket({
    ...request,
    payloadHash,
    tabId: extras.tabId ?? params.tabId,
    documentId: isUpload
      ? (extras.documentId || params.documentId || '')
      : (params.documentId || '')
  }, { ...classifyInput, params });
}

const SYS_TIMEOUT_MS = 20000;
const SYS_UPLOAD_TIMEOUT_MS = 120000;
const SYS_CDP_TIMEOUT_MS = 60000;
const SYS_CDP_RESULT_MAX = 6_000_000;
const SYS_CDP_EVENT_CAP = 300;
const SYS_CDP_EVENT_JSON_MAX = 8000;
const CDP_PROTOCOL = '1.3';

/** @type {Set<string>} */
const cdpAttached = new Set();
const cdpAttaching = new Map();
const cdpOwners = new Map();
/** @type {Map<string, Array<{ method: string, params: unknown, ts: number }>>} */
const cdpEventBuf = new Map();

installCdpHooks();

const sysCalls = new Map();
const cancelledCalls = new Map();

export async function handleWorkspaceSys(request = {}) {
  const now = Date.now();
  for (const [id, expiry] of cancelledCalls) if (expiry <= now) cancelledCalls.delete(id);
  const callId = String(request.callId || crypto.randomUUID());
  const owner = `${request.sessionId || ''}:${request.executionId || ''}`;
  if (request.op === 'cancel') {
    const active = sysCalls.get(callId);
    if (active && active.owner !== owner) return { ok: false, code: 'SYS_DENIED', error: 'call owner mismatch' };
    cancelledCalls.set(`${owner}:${callId}`, now + 120000);
    if (cancelledCalls.size > 512) cancelledCalls.delete(cancelledCalls.keys().next().value);
    active?.controller.abort();
    return { ok: true, result: { callId, cancelled: true, outcome: 'unknown' } };
  }
  if (cancelledCalls.has(`${owner}:${callId}`)) return { ok: false, code: 'SYS_ABORTED', error: 'call cancelled before dispatch' };
  if (sysCalls.has(callId)) return { ok: false, code: 'SYS_BUSY', error: 'call already in flight' };
  if (sysCalls.size >= 128) return { ok: false, code: 'SYS_BUSY', error: 'too many browser calls' };
  const controller = new AbortController();
  const maximum =
    request.op === 'cdp' ? SYS_CDP_TIMEOUT_MS :
    request.op === 'waitFor' ? SYS_WAIT_TIMEOUT_MS :
    request.op === 'upload' ? SYS_UPLOAD_TIMEOUT_MS :
    SYS_TIMEOUT_MS;
  const remaining = Number.isFinite(request.deadline) ? request.deadline - now : maximum;
  if (remaining <= 0) return { ok: false, code: 'SYS_TIMEOUT', error: 'call deadline expired before dispatch' };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(maximum, remaining));
  sysCalls.set(callId, { owner, controller });
  const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({
    ok: false, code: timedOut ? 'SYS_TIMEOUT' : 'SYS_ABORTED',
    error: 'Browser call stopped; already dispatched page actions may have completed. Verify state before retrying.',
    callId, outcome: 'unknown'
  }), { once: true }));
  try {
    const result = await Promise.race([
      dispatchWorkspaceSys({ ...request, params: { ...(request.params || {}), _signal: controller.signal } }),
      aborted
    ]);
    return { ...result, callId };
  } finally {
    clearTimeout(timer);
    sysCalls.delete(callId);
    controller.abort();
  }
}

async function dispatchWorkspaceSys(request = {}) {
  const op = String(request.op || '');
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  try {
    if (op === 'help') return { ok: true, result: SYS_HELP };
    if (op === 'capabilities') {
      const denied = await userScriptsDenied();
      return { ok: true, result: {
        abi: SYS_HELP.abi,
        userScripts: { available: !denied, reason: denied?.error || null },
        debugger: typeof chrome.debugger?.attach === 'function',
        screenshot: typeof chrome.tabs?.captureVisibleTab === 'function',
        download: typeof chrome.downloads?.download === 'function',
        limits: { fetchBytes: SYS_FETCH_BYTES_MAX, evalChars: SYS_EVAL_JSON_MAX, cdpChars: SYS_CDP_RESULT_MAX, uploadBytes: SYS_UPLOAD_BYTES_MAX },
        cancellation: 'Extension fetch is abortable; dispatched page/CDP side effects may have completed. Verify state before retrying.'
      } };
    }
    if (op === 'tabs.list') return { ok: true, result: await sysTabsList() };
    if (op === 'tabs.current') return { ok: true, result: await sysTabsCurrent(params) };
    if (op === 'tabs.frames') return { ok: true, result: await sysTabsFrames(params) };
    // Reads above do not dispatch effects. Fence every other execution-owned call.
    await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
    params._signal?.throwIfAborted();
    if (op === 'upload.stage') return await sysUploadStage(params, request);
    if (op === 'eval') return await sysEval(params, request);
    if (op === 'waitFor') return await sysWaitFor(params, request);
    if (op === 'fetch') return await sysFetch(params, request);
    if (op === 'cdp') return await sysCdp(params, request);
    if (op === 'download') return await sysDownload(params, request);
    if (op === 'screenshot') return await sysScreenshot(params, request);
    if (op === 'upload') return await sysUpload(params, request);
    if (op === 'tabs.open') return await sysTabsOpen(params, request);
    if (op === 'tabs.navigate') return await sysTabsNavigate(params, request);
    if (op === 'tabs.reload') return await sysTabsReload(params, request);
    if (op === 'tabs.close') return await sysTabsClose(params, request);
    if (op === 'tabs.focus') return await sysTabsFocus(params, request);
    return { ok: false, code: 'BAD_INPUT', error: `unknown sys op: ${op}` };
  } catch (error) {
    return {
      ok: false,
      code: sysFailureCode(error),
      error: error instanceof Error ? error.message : String(error),
      ...(error?.outcome ? { outcome: error.outcome } : {})
    };
  }
}

async function sysTabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => publicTab(tab));
}

async function sysTabsCurrent(params) {
  const tab = await resolveTab(params);
  return publicTab(tab);
}

async function sysTabsFrames(params) {
  const tab = await resolveTab(params);
  if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
    return [{ frameId: 0, parentFrameId: -1, url: tab.url || '' }];
  }
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  return frames.map((f) => ({
    frameId: f.frameId,
    parentFrameId: f.parentFrameId,
    url: f.url || '',
    documentId: f.documentId || null,
    documentLifecycle: f.documentLifecycle || null,
    injectable: isSysInjectableUrl(f.url)
  }));
}

async function sysTabsOpen(params, request = {}) {
  const url = String(params.url || 'about:blank').trim();
  if (!isNavigableUrl(url)) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.tabs.open only allows http(s) or about:blank' };
  }
  await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
  params._signal?.throwIfAborted();
  const navGate = await authorizeSysDispatch(request, { url });
  if (!navGate.ok) return navGate;
  const tab = await chrome.tabs.create({
    url,
    active: params.active !== false
  });
  if (tab?.id) {
    const lease = await acquireTabLease(tab.id, request.sessionId, request.executionId, 'tabs.open');
    if (!lease.ok) return { ...lease, outcome: 'unknown' };
  }
  return { ok: true, result: publicTab(tab) };
}

async function sysTabsNavigate(params, request = {}) {
  const url = String(params.url || '').trim();
  if (!isNavigableUrl(url)) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.tabs.navigate only allows http(s) or about:blank' };
  }
  const tab = await resolveTab(params);
  const denied = await acquireSysTab(request, tab.id, 'tabs.navigate');
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const navGate = await authorizeSysDispatch(request, { url, tabId: tab.id });
  if (!navGate.ok) return navGate;
  const updated = await chrome.tabs.update(tab.id, { url });
  return { ok: true, result: publicTab(updated || tab) };
}

async function sysTabsReload(params, request = {}) {
  const tab = await resolveTab(params);
  const denied = await acquireSysTab(request, tab.id, 'tabs.reload');
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const navGate = await authorizeSysDispatch(request, { tabId: tab.id });
  if (!navGate.ok) return navGate;
  await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
  return { ok: true, result: publicTab(await chrome.tabs.get(tab.id)) };
}

async function sysTabsClose(params, request = {}) {
  const tab = await resolveTab(params);
  const denied = await acquireSysTab(request, tab.id, 'tabs.close');
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const gate = await authorizeSysDispatch(request, { tabId: tab.id });
  if (!gate.ok) return gate;
  await chrome.tabs.remove(tab.id);
  return { ok: true, result: { closed: tab.id } };
}

async function sysTabsFocus(params, request = {}) {
  const tab = await resolveTab(params);
  const denied = await acquireSysTab(request, tab.id, 'tabs.focus');
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const gate = await authorizeSysDispatch(request, { tabId: tab.id });
  if (!gate.ok) return gate;
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  const updated = await chrome.tabs.update(tab.id, { active: true });
  return { ok: true, result: publicTab(updated || tab) };
}

/** chrome.downloads.download: this profile's cookie jar + this-machine IP. No tab Referer. Not credentials:omit. */
async function sysDownload(params, request = {}) {
  let url = String(params.url || '').trim();
  if (params.base64 != null && String(params.base64)) {
    const mime = String(params.mimeType || 'application/octet-stream').replace(/[^\w.+/-]/g, '') || 'application/octet-stream';
    url = `data:${mime};base64,${String(params.base64).replace(/\s+/g, '')}`;
  }
  if (!url) return { ok: false, code: 'BAD_INPUT', error: 'sys.download requires url or base64' };
  if (!/^https?:/i.test(url) && !url.startsWith('data:')) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.download only allows http(s) or data: url' };
  }
  const filename = sanitizeDownloadName(params.filename);
  const gate = await authorizeSysDispatch(request, { url, filename });
  if (!gate.ok) return gate;
  const downloadId = await chrome.downloads.download({
    url,
    filename: filename || undefined,
    saveAs: params.saveAs === true,
    conflictAction: 'uniquify'
  });
  return { ok: true, result: { downloadId, filename: filename || null } };
}

async function sysScreenshot(params, request = {}) {
  const tab = await resolveTab(params);
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) return { ok: false, code: 'TAB_NOT_VISIBLE', error: 'Target tab is not visible. Focus it first or use CDP Page.captureScreenshot.' };
  params._signal?.throwIfAborted();
  const shotGate = await authorizeSysDispatch(request, { tabId: tab.id, url: tab.url });
  if (!shotGate.ok) return shotGate;
  const format = String(params.format || 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format,
    quality: format === 'jpeg' ? 90 : undefined
  });
  const parsed = splitDataUrl(dataUrl);
  const [after] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (after?.id !== tab.id) return { ok: false, code: 'TARGET_CHANGED', error: 'Active tab changed during capture; discard this screenshot.' };
  if (!parsed) return { ok: false, code: 'SYS_FAILED', error: 'screenshot produced no image' };
  if (parsed.base64.length > SYS_CDP_RESULT_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: 'screenshot exceeds cap', bytes: parsed.base64.length };
  }
  return {
    ok: true,
    result: {
      tabId: tab.id,
      format,
      contentType: parsed.contentType,
      base64: parsed.base64
    }
  };
}

async function sysUploadStage(params, request = {}) {
  const owner = uploadOwnerKey(request.sessionId, request.executionId);
  const stored = putUploadStageChunk({
    stageId: params.stageId,
    owner,
    index: params.index,
    total: params.total,
    b64: params.b64,
    bytesHash: params.bytesHash || request.bytesHash
  });
  if (!stored.ok) return stored;
  return { ok: true, result: { ...stored, injected: false } };
}

async function sysUpload(params, request = {}) {
  const method = String(params.method || 'auto').toLowerCase();
  if (!['auto', 'input', 'drop', 'cdp'].includes(method)) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.upload method must be auto|input|drop|cdp' };
  }
  const pathGate = assertUploadGuestPath(params.path);
  if (!pathGate.ok) return pathGate;
  const owner = uploadOwnerKey(request.sessionId, request.executionId);
  const inline = coerceUploadBytes(params.bytes);
  if (!inline && !params.stageId) {
    return { ok: false, code: 'BAD_INPUT', error: 'upload bytes missing (host must read guest FS)' };
  }
  if (inline && inline.byteLength > UPLOAD_BYTES_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
  }
  const tab = await resolveTab(params);
  if (!isSysInjectableUrl(tab.url)) {
    return { ok: false, code: 'NEED_PAGE', error: `tab is not injectable: ${tab.url || '(no url)'}` };
  }
  const leased = await acquireSysTab(request, tab.id, 'upload');
  if (leased) return leased;
  const frameId = params.frameId == null ? 0 : Number(params.frameId);
  const document = await readDocumentTarget(chrome, tab.id, frameId, {
    documentId: params.documentId,
    url: params.expectedUrl
  });
  const frameUrl = document.url || tab.url || '';
  const bytesHash = inline
    ? await hashUploadPayloadBytes(inline)
    : String(params.bytesHash || '');
  if (!bytesHash) {
    return { ok: false, code: 'BAD_INPUT', error: 'upload bytesHash required when staging' };
  }
  const filename = String(params.filename || pathGate.path.split('/').pop() || 'upload.bin');
  const mimeType = String(params.mimeType || '').trim() || 'application/octet-stream';
  params._signal?.throwIfAborted();
  const gate = await authorizeSysDispatch(request, {
    tabId: tab.id,
    documentId: document.documentId,
    url: frameUrl,
    frameUrl,
    path: pathGate.path,
    bytesHash,
    uploadMethod: method,
    filename,
    itemId: params.itemId,
    artifactId: params.artifactId
  });
  if (!gate.ok) {
    if (params.stageId) takeUploadStage(params.stageId, owner);
    return gate;
  }
  let bytes = inline;
  if (!bytes) {
    const taken = takeUploadStage(params.stageId, owner);
    if (!taken.ok) return taken;
    bytes = taken.bytes;
    const assembled = await hashUploadPayloadBytes(bytes);
    if (assembled !== bytesHash) {
      return { ok: false, code: 'APPROVAL_MISMATCH', error: 'assembled upload hash does not match ticket' };
    }
  }
  if (bytes.byteLength > UPLOAD_BYTES_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
  }
  const spec = {
    tabId: tab.id,
    documentId: document.documentId,
    frameId,
    bytes,
    filename,
    mimeType,
    method,
    selector: params.selector,
    accept: params.accept,
    name: params.name
  };
  let applied;
  if (method === 'cdp') {
    const debuggee = { tabId: tab.id };
    const key = debuggeeKey(debuggee);
    cdpOwners.set(key, {
      sessionId: String(request.sessionId || ''),
      executionId: String(request.executionId || ''),
      debuggee
    });
    applied = await applyUploadToTab(chrome, spec, {
      ensureAttached: async () => ensureCdpAttached(debuggee),
      send: (cdpMethod, cdpParams) => chrome.debugger.sendCommand(debuggee, cdpMethod, cdpParams || {})
    });
  } else {
    applied = await applyUploadToTab(chrome, spec);
  }
  if (!applied || applied.ok === false) return applied;
  return {
    ok: true,
    result: {
      ok: true,
      op: 'upload',
      methodUsed: applied.methodUsed,
      tabId: tab.id,
      documentId: document.documentId,
      frameId,
      path: pathGate.path,
      filename,
      mimeType,
      bytes: bytes.byteLength,
      filesCount: applied.filesCount ?? 0,
      changeDispatched: applied.changeDispatched === true,
      trusted: applied.trusted === true,
      target: applied.target || {},
      siteAccepted: 'unknown',
      warning: applied.warning,
      methodTried: applied.methodTried
    }
  };
}

async function sysCdp(params, request = {}) {
  if (!chrome.debugger?.attach) {
    return { ok: false, code: 'SYS_DENIED', error: 'chrome.debugger unavailable (need debugger permission)' };
  }
  const action = String(params.action || (params.method ? 'send' : '')).toLowerCase();
  if (action === 'targets') {
    const targets = await chrome.debugger.getTargets();
    return {
      ok: true,
      result: (targets || []).map((t) => ({
        attached: t.attached === true,
        type: t.type || '',
        title: t.title || '',
        url: t.url || '',
        tabId: t.tabId ?? null,
        targetId: t.id || null
      }))
    };
  }

  const debuggee = await resolveDebuggee(params);
  if (debuggee.tabId) {
    const denied = await acquireSysTab(request, debuggee.tabId, `cdp:${action || 'send'}`);
    if (denied) return denied;
  }
  const cdpKey = debuggeeKey(debuggee);
  const owner = cdpOwners.get(cdpKey);
  if (owner && (owner.sessionId !== String(request.sessionId || '') || owner.executionId !== String(request.executionId || ''))) {
    return { ok: false, code: 'CDP_BUSY', error: 'CDP belongs to another execution.' };
  }
  params._signal?.throwIfAborted();
  if (action === 'attach' || (action === 'send' || params.method)) {
    const gate = await authorizeSysDispatch(request, { tabId: debuggee.tabId, method: params.method, action });
    if (!gate.ok) return gate;
  }
  cdpOwners.set(cdpKey, { sessionId: String(request.sessionId || ''), executionId: String(request.executionId || ''), debuggee });
  if (action === 'attach') {
    await ensureCdpAttached(debuggee);
    return { ok: true, result: { attached: true, ...publicDebuggee(debuggee) } };
  }
  if (action === 'detach') {
    await detachCdp(debuggee);
    return { ok: true, result: { attached: false, ...publicDebuggee(debuggee) } };
  }
  if (action === 'events') {
    const key = debuggeeKey(debuggee);
    const list = cdpEventBuf.get(key) || [];
    if (params.clear === true) cdpEventBuf.set(key, []);
    return { ok: true, result: { ...publicDebuggee(debuggee), events: list, count: list.length } };
  }
  if (action !== 'send' && !params.method) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.cdp needs method or action attach|detach|events|targets' };
  }

  const method = String(params.method || '');
  if (!method || method.startsWith('_')) {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.cdp method required' };
  }
  await ensureCdpAttached(debuggee);
  params._signal?.throwIfAborted();
  const cdpParams = params.params && typeof params.params === 'object' ? params.params : {};
  let raw;
  try {
    const cmd =
      Object.keys(cdpParams).length > 0
        ? chrome.debugger.sendCommand(debuggee, method, cdpParams)
        : chrome.debugger.sendCommand(debuggee, method);
    raw = await withTimeout(cmd, SYS_CDP_TIMEOUT_MS, `sys.cdp ${method} timed out`);
  } catch (error) {
    return {
      ok: false,
      code: sysFailureCode(error, 'CDP_FAILED'),
      error: error instanceof Error ? error.message : String(error),
      method,
      ...publicDebuggee(debuggee)
    };
  }
  const clipped = clipCdpResult(raw);
  if (clipped.tooLarge) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      error: `sys.cdp ${method} result exceeds ${SYS_CDP_RESULT_MAX} chars`,
      bytes: clipped.bytes
    };
  }
  return { ok: true, result: { method, ...publicDebuggee(debuggee), result: clipped.value } };
}

function installCdpHooks() {
  if (!chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener((source, method, eventParams) => {
    const key = debuggeeKey(source);
    if (!key) return;
    const list = cdpEventBuf.get(key) || [];
    list.push({
      method: String(method || ''),
      params: clipCdpEventParams(eventParams),
      ts: Date.now()
    });
    if (list.length > SYS_CDP_EVENT_CAP) list.splice(0, list.length - SYS_CDP_EVENT_CAP);
    cdpEventBuf.set(key, list);
  });
  chrome.debugger.onDetach.addListener((source) => {
    const key = debuggeeKey(source);
    if (key) {
      cdpAttached.delete(key);
      cdpEventBuf.delete(key);
      cdpOwners.delete(key);
    }
  });
}

async function resolveDebuggee(params) {
  if (params.targetId) {
    const id = String(params.targetId);
    if (!id || id.length > 200) {
      const err = new Error('invalid targetId');
      err.code = 'BAD_INPUT';
      throw err;
    }
    const targets = await chrome.debugger.getTargets();
    const target = (targets || []).find((item) => item.id === id);
    if (!target) {
      const err = new Error(`unknown target ${id}`);
      err.code = 'NEED_PAGE';
      throw err;
    }
    if (!isCdpAttachableUrl(target.url)) {
      const err = new Error(`target is not attachable: ${target.url || '(no url)'}`);
      err.code = 'NEED_PAGE';
      throw err;
    }
    if (!Number.isInteger(target.tabId) || target.tabId <= 0) {
      throw targetError('NEED_PAGE', 'CDP target must resolve to a browser tab with ownership.');
    }
    return { tabId: target.tabId };
  }
  const tab = await resolveTab(params);
  if (!isCdpAttachableUrl(tab.url)) {
    const err = new Error(`tab is not attachable: ${tab.url || '(no url)'}`);
    err.code = 'NEED_PAGE';
    throw err;
  }
  return { tabId: tab.id };
}

async function ensureCdpAttached(debuggee) {
  const key = debuggeeKey(debuggee);
  if (cdpAttached.has(key)) return;
  if (cdpAttaching.has(key)) return cdpAttaching.get(key);
  const pending = attachCdp(debuggee, key);
  cdpAttaching.set(key, pending);
  try { await pending; }
  finally { cdpAttaching.delete(key); }
}

async function attachCdp(debuggee, key) {
  try {
    await chrome.debugger.attach(debuggee, CDP_PROTOCOL);
    cdpAttached.add(key);
    if (!cdpEventBuf.has(key)) cdpEventBuf.set(key, []);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/Another debugger|already attached|attached/i.test(msg) && await reclaimAttachedDebugger(debuggee, key)) {
      return;
    }
    const err = new Error(msg);
    err.code = /Another debugger|already attached|attached/i.test(msg) ? 'CDP_BUSY' : 'SYS_DENIED';
    throw err;
  }
}

/** SW memory can forget an attach that Chrome still holds. sendCommand succeeding means this extension owns the pipe. */
async function reclaimAttachedDebugger(debuggee, key) {
  try {
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: 'void 0',
      returnByValue: true
    });
    cdpAttached.add(key);
    if (!cdpEventBuf.has(key)) cdpEventBuf.set(key, []);
    return true;
  } catch {
    return false;
  }
}

async function detachCdp(debuggee) {
  const key = debuggeeKey(debuggee);
  if (cdpAttaching.has(key)) await cdpAttaching.get(key).catch(() => {});
  try {
    await chrome.debugger.detach(debuggee);
  } catch {
    /* already detached */
  }
  cdpAttached.delete(key);
  cdpEventBuf.delete(key);
  cdpOwners.delete(key);
}

function debuggeeKey(debuggee) {
  if (!debuggee || typeof debuggee !== 'object') return '';
  if (debuggee.targetId) return `target:${debuggee.targetId}`;
  if (debuggee.tabId != null) return `tab:${debuggee.tabId}`;
  return '';
}

function publicDebuggee(debuggee) {
  return {
    tabId: debuggee.tabId ?? null,
    targetId: debuggee.targetId ?? null
  };
}

function clipCdpResult(value) {
  if (value == null) return { value: null, tooLarge: false, bytes: 0 };
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: { note: 'NOT_CLONEABLE' }, tooLarge: false, bytes: 0 };
  }
  if (json.length > SYS_CDP_RESULT_MAX) return { value: null, tooLarge: true, bytes: json.length };
  return { value, tooLarge: false, bytes: json.length };
}

function clipCdpEventParams(params) {
  try {
    const json = JSON.stringify(params);
    if (!json) return params ?? null;
    if (json.length <= SYS_CDP_EVENT_JSON_MAX) return params;
    return { truncated: true, preview: json.slice(0, SYS_CDP_EVENT_JSON_MAX) };
  } catch {
    return { note: 'NOT_CLONEABLE' };
  }
}

function isNavigableUrl(url) {
  const s = String(url || '');
  if (s === 'about:blank') return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isCdpAttachableUrl(url) {
  return isSysInjectableUrl(url);
}

function sanitizeDownloadName(name) {
  const raw = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = raw.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return cleaned.slice(0, 180);
}

function splitDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(s);
  if (!m) return null;
  return { contentType: m[1] || 'application/octet-stream', base64: m[3] || '' };
}

async function sysEval(params, request = {}) {
  const source = String(params.code ?? params.source ?? '');
  if (!source.trim()) return { ok: false, code: 'BAD_INPUT', error: 'sys.eval requires code' };
  if (source.length > SYS_EVAL_SOURCE_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `sys.eval code exceeds ${SYS_EVAL_SOURCE_MAX} chars` };
  }
  const tab = await resolveTab(params);
  if (!isSysInjectableUrl(tab.url)) {
    return { ok: false, code: 'NEED_PAGE', error: `tab is not injectable: ${tab.url || '(no url)'}` };
  }
  const leased = await acquireSysTab(request, tab.id, 'eval');
  if (leased) return leased;
  const world = normalizeWorld(params.world);
  const denied = await userScriptsDenied();
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const frameId = params.frameId == null ? 0 : Number(params.frameId);
  const document = await readDocumentTarget(chrome, tab.id, frameId, {
    documentId: params.documentId, url: params.expectedUrl
  });
  const target = { tabId: tab.id, documentIds: [document.documentId] };
  params._signal?.throwIfAborted();
  const gate = await authorizeSysDispatch(request, { tabId: tab.id, documentId: document.documentId, url: tab.url });
  if (!gate.ok) return gate;
  const wrapped = wrapEvalSource(source);
  const results = await withTimeout(
    chrome.userScripts.execute({
      target,
      world,
      injectImmediately: true,
      js: [{ code: wrapped }]
    }),
    SYS_TIMEOUT_MS,
    'sys.eval timed out'
  );
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || (first.documentId && first.documentId !== document.documentId)) {
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown',
      error: 'No matching document result was returned. Inspect state before retrying.' };
  }
  if (first?.error) return { ok: false, code: 'EVAL_FAILED', error: String(first.error) };
  const payload = first && typeof first === 'object' && 'result' in first ? first.result : first;
  if (payload && typeof payload === 'object' && payload.ok === false) {
    return payload;
  }
  if (payload && typeof payload === 'object' && payload.ok === true) {
    return { ok: true, result: { world, tabId: tab.id, documentId: document.documentId, frameId: first?.frameId ?? frameId ?? 0, value: payload.value } };
  }
  return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown', error: 'Missing eval receipt. Inspect before retrying.' };
}

/**
 * Poll inside the page until a predicate / selector / text is satisfied, then
 * return its JSON value. The wait loop runs in the page with its own setTimeout,
 * so it is not bound by the ~20s single-eval cap — timeoutMs can reach 120s.
 */
async function sysWaitFor(params, request = {}) {
  const mode = params.code != null && String(params.code).trim() ? 'code'
    : params.selector != null && String(params.selector).trim() ? 'selector'
    : params.text != null && String(params.text) !== '' ? 'text'
    : null;
  if (!mode) return { ok: false, code: 'BAD_INPUT', error: 'sys.waitFor requires code, selector, or text' };
  if (mode === 'code' && String(params.code).length > SYS_EVAL_SOURCE_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `sys.waitFor code exceeds ${SYS_EVAL_SOURCE_MAX} chars` };
  }
  const tab = await resolveTab(params);
  if (!isSysInjectableUrl(tab.url)) {
    return { ok: false, code: 'NEED_PAGE', error: `tab is not injectable: ${tab.url || '(no url)'}` };
  }
  const leased = await acquireSysTab(request, tab.id, 'waitFor');
  if (leased) return leased;
  const world = normalizeWorld(params.world);
  const denied = await userScriptsDenied();
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const timeoutMs = clampWaitTimeout(params.timeoutMs);
  const pollMs = clampPollMs(params.pollMs);
  const stableMs = clampStableMs(params.stableMs);
  const frameId = params.frameId == null ? 0 : Number(params.frameId);
  const document = await readDocumentTarget(chrome, tab.id, frameId, {
    documentId: params.documentId, url: params.expectedUrl
  });
  const target = { tabId: tab.id, documentIds: [document.documentId] };
  params._signal?.throwIfAborted();
  const waitGate = await authorizeSysDispatch(request, { tabId: tab.id, documentId: document.documentId, url: tab.url });
  if (!waitGate.ok) return waitGate;
  const source = wrapWaitForSource({ mode, params, timeoutMs, pollMs, stableMs });
  const results = await withTimeout(
    chrome.userScripts.execute({
      target,
      world,
      injectImmediately: true,
      js: [{ code: source }]
    }),
    timeoutMs + 5000,
    'sys.waitFor timed out'
  );
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || (first.documentId && first.documentId !== document.documentId)) {
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown',
      error: 'No matching document result was returned. Inspect state before retrying.' };
  }
  if (first?.error) return { ok: false, code: 'EVAL_FAILED', error: String(first.error) };
  const payload = first && typeof first === 'object' && 'result' in first ? first.result : first;
  if (payload && typeof payload === 'object' && payload.ok === false) {
    return payload;
  }
  if (payload && typeof payload === 'object' && payload.ok === true) {
    return { ok: true, result: {
      world,
      tabId: tab.id,
      documentId: document.documentId,
      frameId: first?.frameId ?? frameId ?? 0,
      value: payload.value ?? null,
      waitedMs: payload.waitedMs ?? null,
      stable: payload.stable === true,
      timedOut: payload.timedOut === true
    } };
  }
  return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown', error: 'sys.waitFor produced no result; inspect before retrying.' };
}

/** Build the page-world async IIFE that polls until the condition is met. */
export function wrapWaitForSource({ mode, params, timeoutMs, pollMs, stableMs }) {
  let predicateBody;
  if (mode === 'selector') {
    const sel = JSON.stringify(String(params.selector));
    predicateBody = `var __el = document.querySelector(${sel}); return __el ? { matched: true, text: (__el.innerText || "").slice(0, 4000) } : null;`;
  } else if (mode === 'text') {
    const txt = JSON.stringify(String(params.text));
    predicateBody = `return (((document.body && document.body.innerText) || "").indexOf(${txt}) >= 0) ? { matched: true } : null;`;
  } else {
    predicateBody = `return await (async function() {\n${String(params.code)}\n})();`;
  }
  return [
    '(async function() {',
    '  var __t0 = Date.now();',
    `  var __deadline = __t0 + ${timeoutMs};`,
    `  var __poll = ${pollMs};`,
    `  var __stable = ${stableMs};`,
    '  function __sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }',
    '  async function __predicate() {',
    `    ${predicateBody}`,
    '  }',
    '  function __ser(v) {',
    '    var j;',
    '    try { j = JSON.stringify(v); } catch (e) { return { __err: "NOT_CLONEABLE", msg: String(e && e.message || e) }; }',
    `    if (j && j.length > ${SYS_EVAL_JSON_MAX}) return { __err: "TOO_LARGE", bytes: j.length };`,
    '    return { json: j == null ? "null" : j };',
    '  }',
    '  var __lastErr = null, __stableJson = null, __stableSince = 0;',
    '  while (Date.now() < __deadline) {',
    '    var __v = null;',
    '    try { __v = await __predicate(); } catch (e) { __lastErr = String(e && e.message || e); __v = null; }',
    '    if (__v) {',
    '      var __s = __ser(__v);',
    '      if (__s.__err) return { ok: false, code: __s.__err, error: __s.msg || null, bytes: __s.bytes || null };',
    '      if (__stable > 0) {',
    '        if (__stableJson === __s.json) {',
    '          if (Date.now() - __stableSince >= __stable) return { ok: true, value: JSON.parse(__s.json), waitedMs: Date.now() - __t0, stable: true };',
    '        } else { __stableJson = __s.json; __stableSince = Date.now(); }',
    '      } else {',
    '        return { ok: true, value: JSON.parse(__s.json), waitedMs: Date.now() - __t0, stable: false };',
    '      }',
    '    }',
    '    await __sleep(__poll);',
    '  }',
    '  if (__stable > 0 && __stableJson != null) return { ok: true, value: JSON.parse(__stableJson), waitedMs: Date.now() - __t0, stable: false, timedOut: true };',
    '  return { ok: false, code: "WAIT_TIMEOUT", error: __lastErr || "condition not met before timeout", waitedMs: Date.now() - __t0 };',
    '})()'
  ].join('\n');
}

function clampPollMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 500;
  return Math.max(50, Math.min(n, 5000));
}

function clampStableMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 15000));
}

/** Omit as → extension (credentials:omit). Model should pass as:"page" for user session URLs. */
async function sysFetch(params, request = {}) {
  const as = String(params.as || 'extension').toLowerCase();
  if (as === 'page') return sysFetchAsPage(params, request);
  if (as === 'extension') return sysFetchAsExtension(params, request);
  return { ok: false, code: 'BAD_INPUT', error: 'sys.fetch as must be page or extension' };
}

async function sysFetchAsPage(params, request = {}) {
  const tab = await resolveTab(params);
  if (!isSysInjectableUrl(tab.url)) {
    return { ok: false, code: 'NEED_PAGE', error: `tab is not injectable: ${tab.url || '(no url)'}` };
  }
  const leased = await acquireSysTab(request, tab.id, 'fetch:page');
  if (leased) return leased;
  let url;
  try {
    url = new URL(String(params.url || ''), tab.url || undefined);
  } catch {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.fetch: invalid url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.fetch page only allows http(s)' };
  }
  const init = sanitizeFetchInit(params.init);
  const source = wrapPageFetchSource(url.href, init);
  const denied = await userScriptsDenied();
  if (denied) return denied;
  params._signal?.throwIfAborted();
  const frameId = params.frameId == null ? 0 : Number(params.frameId);
  const document = await readDocumentTarget(chrome, tab.id, frameId, {
    documentId: params.documentId, url: params.expectedUrl
  });
  const target = { tabId: tab.id, documentIds: [document.documentId] };
  params._signal?.throwIfAborted();
  const fetchGate = await authorizeSysDispatch(request, {
    tabId: tab.id,
    documentId: document.documentId,
    url: url.href,
    method: init.method
  });
  if (!fetchGate.ok) return fetchGate;
  const results = await withTimeout(
    chrome.userScripts.execute({
      target,
      world: 'MAIN',
      injectImmediately: true,
      js: [{ code: source }]
    }),
    SYS_TIMEOUT_MS,
    'sys.fetch(page) timed out'
  );
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || (first.documentId && first.documentId !== document.documentId)) {
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown',
      error: 'No matching document result was returned. Inspect state before retrying.' };
  }
  if (first?.error) return { ok: false, code: 'FETCH_FAILED', error: String(first.error) };
  const payload = first?.result;
  if (payload && payload.ok === false) return payload;
  if (!payload || payload.ok !== true) return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown', error: 'Missing fetch receipt. Inspect before retrying.' };
  return { ok: true, result: { as: 'page', tabId: tab.id, documentId: document.documentId, ...(payload && payload.value ? payload.value : payload || {}) } };
}

async function sysFetchAsExtension(params, request = {}) {
  let parsed;
  try {
    parsed = new URL(String(params.url || ''));
  } catch {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.fetch: invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'BAD_INPUT', error: 'sys.fetch extension only allows http(s)' };
  }
  const init = sanitizeFetchInit(params.init);
  const method = String(init.method || 'GET').toUpperCase();
  const fetchGate = await authorizeSysDispatch(request, { url: parsed.href, method });
  if (!fetchGate.ok) return fetchGate;
  const res = await fetch(parsed.href, {
      method,
      headers: init.headers,
      body: init.body,
      credentials: 'omit',
      redirect: 'follow',
      signal: params._signal
    });
  const bytes = method === 'HEAD' ? new Uint8Array() : await readResponseBytes(res, SYS_FETCH_BYTES_MAX);
  if (bytes.byteLength > SYS_FETCH_BYTES_MAX) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      error: `sys.fetch exceeds ${SYS_FETCH_BYTES_MAX} bytes`,
      status: res.status,
      bytes: bytes.byteLength
    };
  }
  return {
    ok: true,
    result: {
      as: 'extension',
      ok: res.ok,
      status: res.status,
      url: res.url,
      contentType: res.headers.get('content-type') || '',
      headers: pickHeaders(res.headers),
      base64: bytesToBase64(bytes),
      bytes: bytes.byteLength
    }
  };
}

async function acquireSysTab(request, tabId, kind) {
  const acquired = await acquireTabLease(tabId, request?.sessionId, request?.executionId, kind);
  request?.params?._signal?.throwIfAborted();
  if (acquired.ok) return null;
  let title = '';
  try {
    title = String((await chrome.tabs.get(tabId))?.title || '');
  } catch {
    /* title is optional on TAB_LEASED */
  }
  return title ? { ...acquired, title } : acquired;
}

async function resolveTab(params, opts = {}) {
  params._signal?.throwIfAborted();
  const id = Number(params.tabId ?? params.defaultTabId);
  if (Number.isFinite(id) && id > 0) {
    try {
      const tab = await chrome.tabs.get(id);
      params._signal?.throwIfAborted();
      return tab;
    } catch {
      const err = new Error(`unknown tab ${id}`);
      err.code = 'NEED_PAGE';
      throw err;
    }
  }
  const err = new Error('tabId required');
  err.code = 'NEED_PAGE';
  throw err;
}

function publicTab(tab) {
  const url = tab?.url || '';
  return {
    id: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    groupId: tab?.groupId ?? -1,
    url,
    title: tab?.title || '',
    active: tab?.active === true,
    audible: tab?.audible === true,
    muted: tab?.mutedInfo?.muted === true,
    discarded: tab?.discarded === true,
    pinned: tab?.pinned === true,
    status: tab?.status || '',
    injectable: isSysInjectableUrl(url)
  };
}

export function isSysInjectableUrl(url) {
  return isInjectableTabUrl(url);
}

async function userScriptsDenied() {
  try {
    if (typeof chrome.userScripts?.getScripts !== 'function') {
      return {
        ok: false,
        code: 'SYS_DENIED',
        error: 'chrome.userScripts unavailable (need userScripts permission and Chrome 120+; execute needs 135+)'
      };
    }
    await chrome.userScripts.getScripts();
  } catch {
    return {
      ok: false,
      code: 'SYS_DENIED',
      error:
        'userScripts is off. Chrome 138+: extension details → Allow User Scripts. Older: chrome://extensions → Developer mode.'
    };
  }
  if (typeof chrome.userScripts.execute !== 'function') {
    return {
      ok: false,
      code: 'SYS_DENIED',
      error: 'chrome.userScripts.execute unavailable (need Chrome 135+)'
    };
  }
  return null;
}

function normalizeWorld(world) {
  const w = String(world || 'MAIN').toUpperCase();
  if (w === 'USER' || w === 'USER_SCRIPT' || w === 'ISOLATED') return 'USER_SCRIPT';
  return 'MAIN';
}

function wrapEvalSource(source) {
  return [
    '(async function() {',
    '  try {',
    '    const value = await (async function() {',
    String(source || ''),
    '    })();',
    '    if (value === undefined) return { ok: true, value: null };',
    '    var json;',
    '    try { json = JSON.stringify(value); }',
    '    catch (e) { return { ok: false, code: "NOT_CLONEABLE", error: String(e && e.message || e) }; }',
    `    if (json && json.length > ${SYS_EVAL_JSON_MAX}) return { ok: false, code: "TOO_LARGE", bytes: json.length };`,
    '    return { ok: true, value: JSON.parse(json) };',
    '  } catch (e) {',
    '    return { ok: false, code: "EVAL_FAILED", error: String(e && e.message || e) };',
    '  }',
    '})()'
  ].join('\n');
}

function wrapPageFetchSource(href, init) {
  const hrefJson = JSON.stringify(href);
  const initJson = JSON.stringify({
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body == null ? undefined : init.body,
    credentials: 'include'
  });
  return [
    '(async function() {',
    '  var controller = new AbortController();',
    `  var timer = setTimeout(function() { controller.abort(); }, ${SYS_TIMEOUT_MS});`,
    '  try {',
    `    var url = ${hrefJson};`,
    `    var init = ${initJson};`,
    '    init.signal = controller.signal;',
    '    var res = await fetch(url, init);',
    `    var bytes = await (${readResponseBytes.toString()})(res, ${SYS_FETCH_BYTES_MAX});`,
    '    var binary = "";',
    '    var chunk = 0x8000;',
    '    for (var i = 0; i < bytes.length; i += chunk) {',
    '      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));',
    '    }',
    '    var headers = {};',
    '    res.headers.forEach(function(v, k) { headers[k] = v; });',
    '    return { ok: true, value: {',
    '      ok: res.ok, status: res.status, url: res.url,',
    '      contentType: res.headers.get("content-type") || "",',
    '      headers: headers, base64: btoa(binary), bytes: bytes.byteLength',
    '    }};',
    '  } catch (e) {',
    '    return { ok: false, code: e.code || (controller.signal.aborted ? "SYS_TIMEOUT" : "FETCH_FAILED"), error: String(e && e.message || e) };',
    '  } finally { clearTimeout(timer); }',
    '})()'
  ].join('\n');
}

function sanitizeFetchInit(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const method = String(src.method || 'GET').toUpperCase();
  const allowed = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const headers = {};
  if (src.headers && typeof src.headers === 'object' && !Array.isArray(src.headers)) {
    for (const [k, v] of Object.entries(src.headers)) {
      headers[String(k)] = String(v);
    }
  }
  let body;
  if (src.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof src.body === 'string' ? src.body : JSON.stringify(src.body);
  }
  return { method: allowed.has(method) ? method : 'GET', headers, body };
}

function pickHeaders(headers) {
  const out = {};
  for (const name of ['content-type', 'content-length', 'last-modified', 'etag', 'cache-control']) {
    const value = headers.get(name);
    if (value != null) out[name] = value;
  }
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Self-contained: also serialized into the page-world fetch wrapper.
export async function readResponseBytes(response, limit) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw Object.assign(new Error(`Response exceeds ${limit} bytes`), { code: 'TOO_LARGE' });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isAbortLike(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function sysFailureCode(error, fallback = 'SYS_FAILED') {
  if (isAbortLike(error)) return 'SYS_ABORTED';
  if (typeof error?.code === 'string' && error.code) return error.code;
  return fallback;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'SYS_TIMEOUT';
      reject(err);
    }, ms);
    Promise.resolve(promise)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/** End-of-execution cleanup. Caller revokes ownership before entering this function. */
export async function releaseBrowserSysResources(sessionId, executionId, leasedTabs = []) {
  const sid = String(sessionId || '');
  const eid = String(executionId || '');
  if (!sid || !eid) return;
  const ownerKey = `${sid}:${eid}`;
  for (const active of sysCalls.values()) if (active.owner === ownerKey) active.controller.abort();
  const targets = new Map();
  for (const [key, owner] of cdpOwners) {
    if (owner.sessionId === sid && owner.executionId === eid) targets.set(key, owner.debuggee);
  }
  // After SW restart Chrome may still hold our attachment while the JS map is empty.
  for (const lease of leasedTabs) {
    if (lease.sessionId === sid && lease.executionId === eid && lease.kinds?.some(kind => kind.startsWith('cdp:'))) {
      const target = { tabId: lease.tabId };
      targets.set(debuggeeKey(target), target);
    }
  }
  for (const target of targets.values()) await detachCdp(target);
}
