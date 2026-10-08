/** Live-page action transport: explicit tab, serialized calls, document-bound snapshots. */
import { preparePersistentPageActionTarget, assertTabLeaseOwnerActive } from './tabLease.js';
import { createPageSnapshotRegistry, readDocumentTarget, targetError } from './documentTarget.js';
import { consumeDispatchTicket, dropDispatchTicket } from './dispatchTicket.js';
import {
  classifyRisk,
  needsDispatchTicket,
  mergeBatchClassification,
  CLASSIFIED_SOURCE_SW,
  RISK_PAYMENT,
  CONF_KNOWN
} from './riskClassify.js';
import { hashOperationPayload } from './payloadHash.js';
import {
  applyUploadToTab,
  hashUploadPayloadBytes,
  coerceUploadBytes,
  takeUploadStage,
  uploadOwnerKey
} from './uploadChannel.js';
import { captureVisibleJpeg } from './pageScreenshot.js';
import { handleWorkspaceTabListen } from './tabListen.js';
import {
  shouldAttachPageScreenshot,
  screenshotToModelParts,
  observeDocumentKey
} from '../sessionWorkspace/actionObserve.js';
import {
  POINTER_SETTLE_MS,
  coarseScreenshotHash,
  cssViewportPoint,
  jpegPixelSize,
  settleVisualPointer,
  viewportAspectMismatch,
  visualReplayBlocked,
  withVisualFallback
} from './visualClick.js';

const snapshots = createPageSnapshotRegistry();
const lastControls = new Map();
const lastPageByTab = new Map();
/** executionId → Set<observeDocumentKey> — dual-observed documents this turn. */
const observedByExecution = new Map();
const actionQueues = new Map();

function forgetObservedForTab(tabId) {
  const prefix = `${Number(tabId)}:`;
  for (const set of observedByExecution.values()) {
    for (const key of [...set]) {
      if (key.startsWith(prefix)) set.delete(key);
    }
  }
}

function hasObservedDocument(executionId, tabId, page) {
  const key = observeDocumentKey(tabId, page);
  if (!key) return false;
  const set = observedByExecution.get(String(executionId || ''));
  return Boolean(set && set.has(key));
}

function markObservedDocument(executionId, tabId, page) {
  const key = observeDocumentKey(tabId, page);
  if (!key) return;
  const exec = String(executionId || '');
  let set = observedByExecution.get(exec);
  if (!set) {
    set = new Set();
    observedByExecution.set(exec, set);
  }
  set.add(key);
}

export function invalidatePageActionTarget(tabId) {
  snapshots.invalidate(tabId);
  lastControls.delete(Number(tabId));
  lastPageByTab.delete(Number(tabId));
  forgetObservedForTab(tabId);
}

const MUTATIONS = new Set(['click', 'fill', 'fill_form', 'select', 'press', 'scroll', 'upload', 'pointer', 'hover', 'dblclick', 'contextmenu', 'toggle']);

function rememberControls(tabId, controls) {
  lastControls.set(Number(tabId), Array.isArray(controls) ? controls : []);
}

function lookupControl(tabId, ref, name) {
  return findControl(lastControls.get(Number(tabId)) || [], ref, name);
}

/**
 * Control facts for intent resolution. Offscreen passes the cached snapshot's own
 * controls (it never sees the SW map); the SW registry snapshot has none and falls
 * back to the SW map captured with that same rev. Both sides must hash and classify
 * the same control, or the last door refuses with APPROVAL_MISMATCH.
 */
function lookupSnapshotControl(snapshot, tabId, ref, name) {
  if (Array.isArray(snapshot?.controls)) return findControl(snapshot.controls, ref, name);
  return lookupControl(tabId, ref, name);
}

function findControl(list, ref, name) {
  const want = String(ref || '').trim();
  if (want) {
    const hit = list.find((row) => String(row.ref || '') === want || String(row.ref || '').endsWith(want));
    if (hit) return hit;
  }
  if (name) {
    const hit = list.find((row) => String(row.name || '') === String(name));
    if (hit) return hit;
  }
  return null;
}

export function actionHashInput(op, request, control, extra = {}) {
  return {
    channel: 'action',
    op,
    ref: extra.ref || request.ref || control?.ref || '',
    name: control?.name || request.name || request.label || '',
    key: request.key,
    deltaY: request.deltaY,
    url: control?.frameUrl || extra.frameUrl || '',
    frameUrl: control?.frameUrl || extra.frameUrl || '',
    tabId: extra.tabId ?? request.tabId,
    documentId: control?.documentId || extra.documentId || '',
    frameId: extra.frameId ?? control?.frameId ?? null,
    value: request.value,
    fields: request.fields,
    path: extra.path || request.path || '',
    bytesHash: extra.bytesHash || request.bytesHash || '',
    itemId: extra.itemId || request.itemId || '',
    artifactId: extra.artifactId || request.artifactId || '',
    method: op === 'upload' ? '' : (extra.method || request.method || ''),
    uploadMethod: op === 'upload' ? (extra.uploadMethod || request.method || 'auto') : undefined,
    x: extra.x ?? request.x,
    y: extra.y ?? request.y
  };
}

export function batchFillHashInput(request, frameIntents, tabId) {
  const fields = (Array.isArray(frameIntents) ? frameIntents : []).map((row) => ({
    ref: row.prefixed || row.control?.ref || row.field?.ref || '',
    name: row.control?.name || row.field?.name || row.field?.label || '',
    valueChars: row.field?.value != null ? String(row.field.value).length : 0,
    frameId: row.frameId ?? row.control?.frameId ?? null,
    frameUrl: row.control?.frameUrl || row.extra?.frameUrl || '',
    documentId: row.control?.documentId || row.extra?.documentId || ''
  })).sort((a, b) => {
    const af = Number(a.frameId) - Number(b.frameId);
    if (af) return af;
    return String(a.ref).localeCompare(String(b.ref));
  });
  const docs = [...new Set(fields.map((field) => field.documentId).filter(Boolean))];
  return {
    channel: 'action',
    op: 'fill_form',
    tabId,
    documentId: docs.length === 1 ? docs[0] : '',
    fields
  };
}

function classifyInputFromControl(op, request, control, extra = {}) {
  return {
    channel: 'action',
    op,
    ref: extra.ref || request.ref || control?.ref,
    name: control?.name || request.name || request.label,
    key: request.key,
    url: control?.frameUrl || extra.frameUrl,
    frameUrl: control?.frameUrl || extra.frameUrl,
    control,
    hints: control?.hints,
    tabId: extra.tabId ?? request.tabId,
    frameId: extra.frameId ?? control?.frameId,
    documentId: control?.documentId || extra.documentId,
    path: extra.path || request.path,
    bytesHash: extra.bytesHash || request.bytesHash,
    itemId: extra.itemId || request.itemId,
    artifactId: extra.artifactId || request.artifactId,
    uploadMethod: extra.uploadMethod || request.method,
    method: extra.method || request.method,
    x: extra.x ?? request.x,
    y: extra.y ?? request.y
  };
}

async function authorizePageActionDispatch(request, extra = {}) {
  const op = String(extra.op || request.op || '').toLowerCase();
  if (!MUTATIONS.has(op)) return { ok: true, skipped: true };
  const control = extra.control || lookupControl(extra.tabId, extra.ref || request.ref, request.name || request.label);
  let bytesHash = extra.bytesHash || request.bytesHash || '';
  if (op === 'upload') {
    const bytes = coerceUploadBytes(request.bytes);
    if (bytes) bytesHash = await hashUploadPayloadBytes(bytes);
  }
  const hashExtra = { ...extra, bytesHash };
  const classifyInput = classifyInputFromControl(op, request, control, hashExtra);
  const classified = classifyRisk(classifyInput);
  if (!needsDispatchTicket(classified) && classified.risk === 'read') return { ok: true, classified, skipped: true };
  const payloadHash = await hashOperationPayload(actionHashInput(op, request, control, hashExtra));
  return consumeDispatchTicket({
    ...request,
    payloadHash,
    tabId: classifyInput.tabId,
    documentId: classifyInput.documentId
  }, classifyInput);
}

function isRestrictedPageActionUrl(url) {
  const raw = String(url || '');
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('view-source:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com') return true;
    if (host === 'chrome.google.com' && /\/webstore\b/.test(parsed.pathname)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function resolvePageActionTab(request) {
  const tabId = Number(request?.tabId ?? request?.defaultTabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return { tabId: NaN, url: '', title: '' };
  const tab = await chrome.tabs.get(tabId);
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw targetError('TARGET_CHANGED', 'Page navigation is in progress.');
  return { tabId, url: tab.url || '', title: String(tab.title || '') };
}

async function decorateTabLeaseDenied(denied) {
  if (!denied || denied.code !== 'TAB_LEASED') return denied;
  let title = denied.title || '';
  if (!title && denied.tabId) {
    try {
      title = String((await chrome.tabs.get(denied.tabId))?.title || '');
    } catch {
      /* holder tab may already be gone */
    }
  }
  return title ? { ...denied, title } : denied;
}

function withPageActionTab(result, tabId, title) {
  if (!result || typeof result !== 'object') return result;
  const id = Number(tabId);
  if (!Number.isFinite(id) || id <= 0 || result.tabId != null) return result;
  return title ? { ...result, tabId: id, title } : { ...result, tabId: id };
}


function parseActionRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const framed = s.match(/^f(\d+)\.(a\d+)$/i);
  if (framed) return { frameId: Number(framed[1]), local: framed[2].toLowerCase() };
  const local = s.match(/^(a\d+)$/i);
  if (local) return { frameId: null, local: local[1].toLowerCase() };
  return null;
}

function resolvePrefixedRef(snapshot, ref) {
  const parsed = parseActionRef(ref);
  if (!parsed) return { ok: false, error: 'need ref or name', code: 'NO_TARGET' };
  const frameId = parsed.frameId != null ? parsed.frameId : 0;
  if (snapshot?.frames && !snapshot.frames.some((frame) => frame.frameId === frameId)) {
    return { ok: false, error: 'Target frame was not in the snapshot.', code: 'STALE_REF' };
  }
  return { frameId, local: parsed.local };
}

async function listPageActionFrames(tabId) {
  if (chrome.webNavigation && typeof chrome.webNavigation.getAllFrames === 'function') {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames || []).filter((f) => {
        if (!f || !Number.isFinite(f.frameId)) return false;
        const lower = String(f.url || '').toLowerCase();
        if (
          lower.startsWith('chrome://') ||
          lower.startsWith('chrome-extension://') ||
          lower.startsWith('edge://') ||
          lower.startsWith('devtools://') ||
          lower.startsWith('view-source:')
        ) {
          return false;
        }
        return true;
      });
    } catch {
      /* permission or tab gone */
    }
  }
  return [{ frameId: 0 }];
}

async function sendPageActionToFrame(tabId, frameId, payload, expected = null) {
  const mutation = MUTATIONS.has(payload.op);
  if (mutation && !expected?.documentId) throw targetError('STALE_REF', 'Target frame was not in the snapshot.');
  const target = await readDocumentTarget(chrome, tabId, frameId, expected || {});
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'workspace_page_action', ...payload },
      { frameId, documentId: target.documentId });
  } catch (error) {
    const msg = String(error?.message || error);
    if (/Receiving end does not exist|Could not establish connection|No frame with id/i.test(msg)) {
      throw Object.assign(targetError('NEED_PAGE', msg), { frameUnreachable: true });
    }
    if (mutation) throw Object.assign(targetError('ACTION_OUTCOME_UNKNOWN',
      'Page action response was lost. Inspect the page before deciding whether to retry.'), { outcome: 'unknown' });
    throw error;
  }
}

export async function ensurePageActionScripts(tabId) {
  const frames = await listPageActionFrames(tabId);
  const missing = [];
  for (const fr of frames) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: fr.frameId });
      if (pong && pong.status === 'pong') continue;
    } catch {
      /* not injected */
    }
    missing.push(fr.frameId);
  }
  if (!missing.length) return;
  const candidates = ['src/content_script.js', 'content_script.js'];
  for (const frameId of missing) {
    let injected = false;
    for (const file of candidates) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: [file]
        });
        injected = true;
        break;
      } catch {
        /* try next path */
      }
    }
    if (!injected) {
      for (const file of candidates) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: [file]
          });
          break;
        } catch {
          /* last resort */
        }
      }
    }
  }
}

async function resolveFillFormTargets(request, tabId, snapshot) {
  const fields = Array.isArray(request.fields) ? request.fields : [];
  if (!fields.length) return { ok: false, error: 'fields is required', code: 'BAD_INPUT' };
  const targets = [];
  for (const field of fields) {
    if (!field || typeof field !== 'object') {
      return { ok: false, error: 'invalid field', code: 'BAD_INPUT' };
    }
    let hit;
    if (field.ref) {
      hit = resolvePrefixedRef(snapshot, field.ref);
      if (hit.code) return { ok: false, error: hit.error, code: hit.code };
    } else if (field.name || field.label) {
      hit = await resolveNameAcrossFrames(tabId, field.name || field.label, snapshot);
      if (hit.code) return { ok: false, error: hit.error, code: hit.code };
    } else {
      return { ok: false, error: 'each field needs ref or name', code: 'BAD_INPUT' };
    }
    const frameId = hit.frameId;
    const localRef = hit.local || '';
    const expectedFrame = snapshot?.frames.find((frame) => frame.frameId === frameId);
    const prefixed = localRef ? `f${frameId}.${localRef}` : (field.ref || '');
    const found = lookupSnapshotControl(snapshot, tabId, prefixed, field.name || field.label);
    const control = {
      ...(found || {}),
      name: found?.name || field.name || field.label || '',
      ref: prefixed,
      role: found?.role || '',
      hints: found?.hints,
      frameUrl: expectedFrame?.url || found?.frameUrl || hit.frameUrl || '',
      documentId: expectedFrame?.documentId || found?.documentId || hit.documentId || '',
      frameId
    };
    const extra = {
      op: 'fill_form',
      tabId,
      frameId,
      documentId: control.documentId,
      frameUrl: control.frameUrl,
      ref: prefixed,
      control
    };
    targets.push({
      field: { ...field, ref: localRef, name: field.name || field.label },
      frameId,
      localRef,
      prefixed,
      control,
      extra,
      classified: classifyRisk(classifyInputFromControl('fill_form', request, control, extra))
    });
  }
  return { ok: true, targets };
}

function fillFormBatchResult(request, tabId, targets) {
  const classified = mergeBatchClassification(targets.map((row) => row.classified), targets);
  classified.source = CLASSIFIED_SOURCE_SW;
  const uniqueFrames = classified.target?.frames || [];
  const top = targets.find((row) => row.classified.risk === classified.risk) || targets[0];
  return {
    ok: true,
    op: 'fill_form',
    tabId,
    frameId: top.frameId,
    documentId: uniqueFrames.length === 1 ? top.control.documentId : '',
    frameUrl: top.control.frameUrl,
    ref: top.prefixed,
    name: top.control.name,
    control: top.control,
    frames: uniqueFrames,
    batchSize: uniqueFrames.length,
    classified,
    targets
  };
}

async function authorizeFillFormBatch(request, tabId, targets) {
  const batch = fillFormBatchResult(request, tabId, targets);
  const classified = batch.classified;
  if (classified.risk === RISK_PAYMENT && classified.confidence === CONF_KNOWN) {
    if (request.operationId) await dropDispatchTicket(request.operationId);
    return {
      ok: false,
      code: 'PAYMENT_DENIED',
      error: 'Known payment is never dispatched.',
      classified,
      frames: batch.frames
    };
  }
  const payloadHash = await hashOperationPayload(batchFillHashInput(request, targets, tabId));
  const classifyInput = {
    ...classifyInputFromControl('fill_form', request, batch.control, {
      op: 'fill_form',
      tabId,
      frameId: batch.frameId,
      documentId: batch.documentId,
      frameUrl: batch.frameUrl,
      ref: batch.ref,
      control: batch.control
    }),
    batchSize: batch.batchSize,
    frames: batch.frames
  };
  const gate = await consumeDispatchTicket({
    ...request,
    payloadHash,
    tabId,
    documentId: batch.documentId
  }, classifyInput);
  return { ...gate, classified, frames: batch.frames, payloadHash, batchSize: batch.batchSize };
}

async function resolveMutationIntent(request, tabId, snapshot) {
  const op = String(request.targetOp || request.act || request.intentOp || '').toLowerCase();
  if (!MUTATIONS.has(op)) {
    return { ok: true, skipped: true, op, classified: classifyRisk({ channel: 'action', op }) };
  }
  if (op === 'fill_form') {
    const resolved = await resolveFillFormTargets(request, tabId, snapshot);
    if (!resolved.ok) return resolved;
    const batch = fillFormBatchResult(request, tabId, resolved.targets);
    const payloadHash = await hashOperationPayload(batchFillHashInput(request, resolved.targets, tabId));
    return { ...batch, payloadHash };
  }
  let frameId = 0;
  let localRef = '';
  let hit = null;
  if (request.ref) {
    hit = resolvePrefixedRef(snapshot, request.ref);
    if (hit.code) return { ok: false, error: hit.error, code: hit.code };
  } else if (request.name || request.label) {
    hit = await resolveNameAcrossFrames(tabId, request.name || request.label, snapshot);
    if (hit.code) return { ok: false, error: hit.error, code: hit.code };
  } else if (
    op === 'press' ||
    op === 'upload' ||
    op === 'pointer' ||
    (op === 'wait' && request.ms != null && !request.text)
  ) {
    hit = { frameId: 0, local: '', frameUrl: '', documentId: '' };
  } else {
    return { ok: false, error: 'need ref or name', code: 'NO_TARGET' };
  }
  frameId = hit.frameId;
  localRef = hit.local || '';
  const expectedFrame = snapshot?.frames.find((f) => f.frameId === frameId);
  const prefixed = localRef ? `f${frameId}.${localRef}` : (request.ref || '');
  const found = lookupSnapshotControl(snapshot, tabId, prefixed, request.name || request.label || request.fields?.[0]?.name);
  const control = {
    ...(found || {}),
    name: found?.name || request.name || request.label || '',
    ref: prefixed,
    role: found?.role || '',
    hints: found?.hints,
    frameUrl: expectedFrame?.url || found?.frameUrl || hit.frameUrl || '',
    documentId: expectedFrame?.documentId || found?.documentId || hit.documentId || '',
    frameId
  };
  const extra = {
    op,
    tabId,
    frameId,
    documentId: control.documentId,
    frameUrl: control.frameUrl,
    ref: prefixed,
    control,
    path: request.path,
    bytesHash: request.bytesHash,
    itemId: request.itemId,
    artifactId: request.artifactId,
    uploadMethod: request.method,
    method: request.method,
    x: request.x,
    y: request.y
  };
  const classifyInput = classifyInputFromControl(op, request, control, extra);
  const classified = { ...classifyRisk(classifyInput), source: CLASSIFIED_SOURCE_SW };
  const payloadHash = await hashOperationPayload(actionHashInput(op, request, control, extra));
  return {
    ok: true,
    op,
    tabId,
    frameId,
    documentId: control.documentId,
    frameUrl: control.frameUrl,
    ref: prefixed,
    name: control.name,
    control,
    classified,
    payloadHash,
    hashInput: extra
  };
}

function prefixFrameRefs(controls, frameId, frameMeta = {}) {
  return (Array.isArray(controls) ? controls : []).map((c) => {
    if (!c || typeof c !== 'object') return c;
    const local = String(c.ref || '').replace(/^f\d+\./i, '');
    return {
      ...c,
      ref: 'f' + frameId + '.' + local,
      frameId,
      frameUrl: c.frameUrl || frameMeta.url || '',
      documentId: c.documentId || frameMeta.documentId || ''
    };
  });
}

async function readLivePage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let documentId = '';
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    documentId = frame?.documentId || '';
  } catch {
    /* frame may be gone */
  }
  return { url: tab.url || '', title: String(tab.title || ''), documentId };
}

async function snapshotPageActionFrames(tabId, { scope = 'all', workflowTarget, workflowObserve = false } = {}) {
  const root = await readDocumentTarget(chrome, tabId, 0);
  await ensurePageActionScripts(tabId);
  const listed = await listPageActionFrames(tabId);
  const frames = scope === 'top' ? listed.filter((fr) => Number(fr.frameId) === 0) : listed;
  if (scope === 'top' && !frames.some((fr) => Number(fr.frameId) === 0)) frames.unshift({ frameId: 0 });
  const controls = [];
  const framesOut = [];
  const mediaElements = [];
  const workflowTexts = [];
  let canvasCount = 0;
  for (const fr of frames) {
    try {
      const target = await readDocumentTarget(chrome, tabId, fr.frameId, fr);
      const raw = await sendPageActionToFrame(tabId, fr.frameId, { op: 'snapshot', ...(workflowTarget ? { workflowTarget } : {}), ...(workflowObserve ? { workflowObserve: true } : {}) }, target);
      if (!raw || raw.ok === false) continue;
      const list = prefixFrameRefs(raw.controls, fr.frameId, {
        url: raw.frameUrl || target.url || fr.url || '',
        documentId: target.documentId
      });
      controls.push(...list);
      if (workflowObserve && raw.text) workflowTexts.push(String(raw.text));
      canvasCount += Number(raw.canvasCount) || 0;
      for (const media of (Array.isArray(raw.mediaElements) ? raw.mediaElements : []).slice(0, 6)) {
        if (mediaElements.length < 6) mediaElements.push({ ...media, frameId: fr.frameId, documentId: target.documentId });
      }
      framesOut.push({ ...target, title: raw.title || '', count: list.length, canvasCount: Number(raw.canvasCount) || 0 });
    } catch (error) {
      if (error?.code === 'TARGET_CHANGED') throw error;
      if (workflowObserve && (!workflowTarget?.frameUrl || fr.url === workflowTarget.frameUrl)) throw targetError('WORKFLOW_FRAME_UNAVAILABLE', 'A frame could not be observed reliably.');
      // Unreachable subframes are omitted, never assigned usable references.
    }
  }
  await readDocumentTarget(chrome, tabId, 0, root);
  for (const frame of framesOut) await readDocumentTarget(chrome, tabId, frame.frameId, frame);
  if (!framesOut.some(frame => frame.frameId === 0)) throw targetError('NEED_PAGE', 'No top-frame snapshot was returned.');
  const { rev } = snapshots.capture(tabId, framesOut);
  const capped = controls.slice(0, 80);
  rememberControls(tabId, capped);
  const page = { url: root.url, title: framesOut.find((f) => f.frameId === 0)?.title || '', documentId: root.documentId };
  return {
    ok: true,
    op: 'snapshot',
    rev,
    documentId: root.documentId,
    count: capped.length,
    controls: capped,
    ...(workflowObserve ? { text: workflowTexts.join('\n').slice(0, 200000) } : {}),
    frames: framesOut,
    canvasCount,
    mediaElements,
    page,
    after: { url: root.url, documentId: root.documentId, count: capped.length }
  };
}

async function snapshotAllPageActionFrames(tabId) {
  return snapshotPageActionFrames(tabId, { scope: 'all' });
}

async function observeAfterAction(tabId) {
  try {
    return await snapshotPageActionFrames(tabId, { scope: 'top' });
  } catch (error) {
    snapshots.invalidate(tabId);
    let page = null;
    try { page = await readLivePage(tabId); } catch { /* tab may be gone */ }
    return {
      observationError: { code: error?.code || 'NEED_PAGE', error: error?.message || String(error) },
      page
    };
  }
}

function attachFreshSnapshot(result, snap) {
  if (!result || typeof result !== 'object' || !snap) return result;
  const page = snap.page || result.page;
  if (snap.observationError) {
    return page
      ? { ...result, observationError: snap.observationError, page }
      : { ...result, observationError: snap.observationError };
  }
  return {
    ...result,
    documentId: snap.documentId,
    rev: snap.rev,
    controls: snap.controls,
    count: snap.count,
    frames: snap.frames,
    canvasCount: snap.canvasCount,
    mediaElements: snap.mediaElements,
    page: page || result.page,
    after: result.after || snap.after
  };
}

async function maybeAttachScreenshot(result, request, tabId) {
  if (!result || typeof result !== 'object') return result;
  const previous = lastPageByTab.get(Number(tabId)) || null;
  const page = result.page;
  if (page) lastPageByTab.set(Number(tabId), page);
  if (result.ok === false && !result.observationError && !request?.observe) return result;
  const observed = hasObservedDocument(request?.executionId, tabId, page);
  const attach = shouldAttachPageScreenshot({
    observe: request?.observe,
    page,
    previousPage: previous,
    controlCount: result.count ?? (Array.isArray(result.controls) ? result.controls.length : undefined),
    canvasCount: result.canvasCount,
    unobservedThisExecution: Boolean(page) && !observed
  });
  if (!attach) return result;
  const shot = await captureVisibleJpeg(chrome, tabId);
  if (!shot.ok) {
    return { ...result, screenshotError: { code: shot.code || 'NEED_PAGE', error: shot.error || '' } };
  }
  markObservedDocument(request?.executionId, tabId, page);
  return {
    ...result,
    screenshot: { attached: true, mediaType: shot.mediaType || 'image/jpeg' },
    modelParts: screenshotToModelParts({ ...shot, label: 'Page screenshot' })
  };
}

/**
 * Classify a mutation using a cached snapshot (rev + controls) without a SW RPC.
 * Name-only targets that are not in the cache return null so the caller can RPC.
 */
export async function classifyCachedMutation(request, snapshot) {
  if (!request || !snapshot || !Array.isArray(snapshot.controls)) return null;
  const op = String(request.op || request.targetOp || '').toLowerCase();
  if (!MUTATIONS.has(op)) return { ok: true, skipped: true, op };
  const patched = { ...request, targetOp: op };
  if (op === 'fill_form') {
    const fields = Array.isArray(request.fields) ? request.fields : [];
    if (!fields.length) return null;
    if (fields.some((field) => !field?.ref)) return null;
  } else if (!request.ref && (request.name || request.label) && op !== 'press' && op !== 'upload' && op !== 'pointer') {
    const hits = snapshot.controls.filter((row) => String(row.name || '') === String(request.name || request.label));
    if (hits.length !== 1) return null;
    patched.ref = hits[0].ref;
  }
  try {
    return await resolveMutationIntent(patched, Number(request.tabId), {
      frames: snapshot.frames || [],
      controls: snapshot.controls
    });
  } catch {
    return null;
  }
}

function parsePointerPoint(request) {
  const x = Number(request?.x);
  const y = Number(request?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) {
    return { ok: false, code: 'BAD_INPUT', error: 'pointer requires x and y in 0–1 viewport units' };
  }
  return { ok: true, x, y };
}

async function readCssLayoutViewport(debuggee) {
  const metrics = await chrome.debugger.sendCommand(debuggee, 'Page.getLayoutMetrics', {});
  const css = metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
  const clientWidth = Number(css.clientWidth);
  const clientHeight = Number(css.clientHeight);
  if (!(clientWidth > 0) || !(clientHeight > 0)) return null;
  return { clientWidth, clientHeight };
}

async function executePointerCdp(tabId, x, y, viewport) {
  if (typeof chrome.debugger?.attach !== 'function' || typeof chrome.debugger?.sendCommand !== 'function') {
    return { ok: false, code: 'SYS_DENIED', error: 'debugger API unavailable' };
  }
  const point = cssViewportPoint(x, y, viewport);
  if (!point) return { ok: false, code: 'COORD_MISMATCH', error: 'CSS viewport size is missing.' };
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/Another debugger|already attached|attached/i.test(msg)) {
      return { ok: false, code: 'CDP_BUSY', error: msg };
    }
    return { ok: false, code: 'SYS_DENIED', error: msg };
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    return { ok: true, op: 'pointer', methodUsed: 'cdp', x, y, trusted: false };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'SYS_FAILED',
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch { /* already gone */ }
  }
}

function waitPointerSettle(tabId, ms = POINTER_SETTLE_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { chrome.webNavigation?.onCommitted?.removeListener(onNav); } catch { /* listener optional */ }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onNav = (details) => {
      if (Number(details?.tabId) === Number(tabId) && Number(details?.frameId) === 0) finish();
    };
    try { chrome.webNavigation?.onCommitted?.addListener(onNav); } catch { /* timer still bounds the wait */ }
  });
}

async function forceViewportScreenshot(result, tabId) {
  if (!result || result.modelParts) return result;
  const shot = await captureVisibleJpeg(chrome, tabId);
  if (!shot.ok) {
    return { ...result, screenshotError: { code: shot.code || 'NEED_PAGE', error: shot.error || '' } };
  }
  return {
    ...result,
    screenshot: { attached: true, mediaType: shot.mediaType || 'image/jpeg' },
    modelParts: screenshotToModelParts({ ...shot, label: 'Viewport for visual pointer' })
  };
}

function pageIdentity(page, fallback) {
  const src = page && typeof page === 'object' ? page : {};
  const alt = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    url: src.url || alt.url || '',
    documentId: src.documentId || alt.documentId || ''
  };
}

async function reflectCdpPointer(request, tabId, point, expectedTop) {
  if (visualReplayBlocked(request.executionId, point.x, point.y)) {
    return {
      ok: false,
      code: 'VISUAL_UNCHANGED',
      error: 'This viewport point already produced no visible change.',
      hint: 'Do not repeat the same pointer coordinates in this execution.'
    };
  }
  if (typeof chrome.debugger?.attach !== 'function' || typeof chrome.debugger?.sendCommand !== 'function') {
    return { ok: false, code: 'SYS_DENIED', error: 'debugger API unavailable' };
  }
  const debuggee = { tabId };
  let viewport = null;
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    viewport = await readCssLayoutViewport(debuggee);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/Another debugger|already attached|attached/i.test(msg)) {
      return { ok: false, code: 'CDP_BUSY', error: msg };
    }
    return { ok: false, code: 'SYS_DENIED', error: msg };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(debuggee); } catch { /* inspect attach is separate from the click */ }
    }
  }
  if (!viewport) return { ok: false, code: 'COORD_MISMATCH', error: 'CSS viewport size is missing.' };
  const beforeShot = await captureVisibleJpeg(chrome, tabId);
  const shotSize = beforeShot.ok ? jpegPixelSize(beforeShot.base64) : null;
  if (shotSize && viewportAspectMismatch(shotSize.width, shotSize.height, viewport.clientWidth, viewport.clientHeight)) {
    return {
      ok: false,
      code: 'COORD_MISMATCH',
      error: 'Screenshot aspect does not match the CSS viewport.',
      hint: 'Snapshot again and choose x,y against the current viewport.'
    };
  }
  const before = {
    ...pageIdentity(expectedTop),
    hash: beforeShot.ok ? await coarseScreenshotHash(beforeShot.base64) : ''
  };
  let raw;
  try {
    await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
    raw = await executePointerCdp(tabId, point.x, point.y, viewport);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      code: error?.code || 'NEED_PAGE',
      ...(error?.outcome ? { outcome: error.outcome } : {}),
      ...(error?.frameUnreachable ? { frameUnreachable: true } : {})
    };
  }
  if (!raw || raw.ok === false) return raw || { ok: false, code: 'SYS_FAILED', error: 'CDP pointer failed' };
  await waitPointerSettle(tabId);
  const snap = await observeAfterAction(tabId);
  const afterShot = await captureVisibleJpeg(chrome, tabId);
  const after = {
    ...pageIdentity(snap?.page, snap),
    hash: afterShot.ok ? await coarseScreenshotHash(afterShot.base64) : ''
  };
  const withShot = afterShot.ok
    ? {
        screenshot: { attached: true, mediaType: afterShot.mediaType || 'image/jpeg' },
        modelParts: screenshotToModelParts({ ...afterShot, label: 'Page screenshot after pointer' })
      }
    : {};
  const settled = settleVisualPointer({
    executionId: request.executionId,
    x: point.x,
    y: point.y,
    before,
    after
  });
  if (settled.code === 'VISUAL_UNCHANGED') {
    return {
      ok: false,
      code: 'VISUAL_UNCHANGED',
      error: 'Pointer did not change the URL, document, or viewport.',
      hint: 'Do not repeat the same pointer coordinates in this execution.',
      methodUsed: 'cdp',
      ...withShot
    };
  }
  return { ...attachFreshSnapshot(raw, snap), ...withShot };
}

async function resolveNameAcrossFrames(tabId, name, snapshot) {
  const frames = snapshot?.frames || await listPageActionFrames(tabId);
  const hits = [];
  for (const fr of frames) {
    try {
      const raw = await sendPageActionToFrame(tabId, fr.frameId, { op: 'resolve_name', name }, fr);
      const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
      for (const m of matches) {
        if (!m || !m.ref) continue;
        hits.push({
          frameId: fr.frameId,
          local: String(m.ref).replace(/^f\d+\./i, ''),
          name: m.name || name,
          ref: 'f' + fr.frameId + '.' + String(m.ref).replace(/^f\d+\./i, ''),
          frameUrl: fr.url || '',
          documentId: fr.documentId || ''
        });
      }
    } catch (error) {
      if (error?.code === 'TARGET_CHANGED') throw error;
    }
  }
  if (!hits.length) {
    return { ok: false, error: 'no control matches name', code: 'NO_TARGET' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: 'name matches multiple controls',
      code: 'AMBIGUOUS',
      matches: hits.map((h) => ({ ref: h.ref, name: h.name }))
    };
  }
  return hits[0];
}

async function waitTextAnyFrame(tabId, request) {
  const frames = await listPageActionFrames(tabId);
  const started = Date.now();
  if (!frames.length) {
    return { ok: false, error: 'no frames', code: 'NEED_PAGE' };
  }
  const pending = frames.map((fr) =>
    sendPageActionToFrame(tabId, fr.frameId, {
      op: 'wait',
      text: request.text,
      ms: request.ms
    }).catch(() => null)
  );
  const hit = await new Promise((resolve) => {
    let left = pending.length;
    for (const p of pending) {
      p.then((r) => {
        if (r && r.ok) resolve(r);
        else if (--left === 0) resolve(null);
      });
    }
  });
  const snap = await observeAfterAction(tabId);
  if (hit) {
    return maybeAttachScreenshot(
      attachFreshSnapshot({ ...hit, waited: hit.waited ?? Date.now() - started }, snap),
      request,
      tabId
    );
  }
  return maybeAttachScreenshot(
    attachFreshSnapshot(
      { ok: false, error: 'wait timed out', code: 'NO_TARGET', waited: Date.now() - started },
      snap
    ),
    request,
    tabId
  );
}

async function executePageUpload(request, tabId, frameId, expectedFrame, localRef) {
  let bytes = coerceUploadBytes(request.bytes);
  if (!bytes && request.stageId) {
    const taken = takeUploadStage(request.stageId, uploadOwnerKey(request.sessionId, request.executionId));
    if (!taken.ok) return taken;
    bytes = taken.bytes;
    if (request.bytesHash) {
      const assembled = await hashUploadPayloadBytes(bytes);
      if (assembled !== String(request.bytesHash)) {
        return { ok: false, code: 'APPROVAL_MISMATCH', error: 'assembled upload hash does not match ticket' };
      }
    }
  }
  if (!bytes) return { ok: false, code: 'BAD_INPUT', error: 'upload bytes missing (host must read guest FS)' };
  let selector = request.selector ? String(request.selector) : '';
  const token = `paw-upload-${Date.now().toString(36)}`;
  if (localRef) {
    try {
      const marked = await sendPageActionToFrame(tabId, frameId, {
        op: 'mark_upload',
        ref: localRef,
        token
      }, expectedFrame);
      if (marked?.ok) selector = `[data-paw-upload="${CSS && CSS.escape ? CSS.escape(token) : token}"]`;
    } catch {
      /* auto still scans file inputs */
    }
  }
  const spec = {
    tabId,
    documentId: expectedFrame?.documentId || request.documentId,
    frameId,
    bytes,
    filename: request.filename,
    mimeType: request.mimeType,
    method: request.method || 'auto',
    selector,
    accept: request.accept,
    name: request.name
  };
  let applied;
  if (String(request.method || 'auto').toLowerCase() === 'cdp') {
    applied = await uploadViaCdpOnce(chrome, spec, tabId);
  } else {
    applied = await applyUploadToTab(chrome, spec);
  }
  if (!applied || applied.ok === false) return applied;
  return {
    ok: true,
    op: 'upload',
    methodUsed: applied.methodUsed,
    tabId,
    documentId: spec.documentId,
    frameId,
    path: request.path,
    filename: spec.filename,
    mimeType: spec.mimeType,
    bytes: bytes.byteLength,
    filesCount: applied.filesCount ?? 0,
    changeDispatched: applied.changeDispatched === true,
    trusted: applied.trusted === true,
    target: applied.target || {},
    siteAccepted: 'unknown',
    warning: applied.warning
  };
}

/**
 * action op=upload method=cdp. Unlike sys.cdp, this attach is not registered to the
 * execution, so nothing would detach it at the end of the turn: detach right here,
 * like the other action paths that borrow the debugger. Only detaches what it attached.
 */
export async function uploadViaCdpOnce(chromeRef, spec, tabId) {
  const debuggee = { tabId };
  let attached = false;
  try {
    return await applyUploadToTab(chromeRef, spec, {
      ensureAttached: async () => {
        if (attached) return;
        try {
          await chromeRef.debugger.attach(debuggee, '1.3');
          attached = true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/Another debugger|already attached|attached/i.test(msg)) {
            throw Object.assign(new Error(msg), { code: 'CDP_BUSY' });
          }
          throw Object.assign(new Error(msg), { code: 'SYS_DENIED' });
        }
      },
      send: (method, params) => chromeRef.debugger.sendCommand(debuggee, method, params || {})
    });
  } finally {
    if (attached) {
      try { await chromeRef.debugger.detach(debuggee); } catch { /* already gone */ }
    }
  }
}

export function handleWorkspacePageAction(request) {
  const key = Number(request?.tabId ?? request?.defaultTabId);
  const previous = actionQueues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => runWorkspacePageAction(request));
  actionQueues.set(key, pending);
  void pending.finally(() => { if (actionQueues.get(key) === pending) actionQueues.delete(key); }).catch(() => {});
  return pending;
}

async function runWorkspacePageAction(request) {
  let result;
  try { result = await executeWorkspacePageAction(request); }
  catch (error) { result = { ok: false, code: error?.code || 'NEED_PAGE', error: error?.message || String(error),
    ...(error?.outcome ? { outcome: error.outcome } : {}),
    ...(error?.frameUnreachable ? { frameUnreachable: true } : {}) }; }
  const tabId = Number(request?.tabId ?? request?.defaultTabId ?? result?.tabId);
  const op = String(request?.op || '').trim().toLowerCase();
  result = withVisualFallback(result, op);
  if (result?.code === 'FALLBACK_VISUAL' && Number.isFinite(tabId) && tabId > 0) {
    result = await forceViewportScreenshot(result, tabId);
  }
  let title = result?.title;
  if ((!title || result?.tabId == null) && Number.isFinite(tabId) && tabId > 0) {
    try {
      title = title || String((await chrome.tabs.get(tabId))?.title || '');
    } catch {
      /* receipt title is optional */
    }
  }
  return withPageActionTab(result, tabId, title);
}

async function executeWorkspacePageAction(request) {
  const gated = await preparePersistentPageActionTarget(request);
  if (!gated.ok) return decorateTabLeaseDenied(gated);
  const resolved = await resolvePageActionTab(request);
  const tabId = resolved.tabId;
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'page action requires an explicit tabId', code: 'NEED_EXPLICIT_TAB' };
  }
  if (isRestrictedPageActionUrl(resolved.url)) {
    return {
      ok: false,
      error: 'cannot act on chrome://, Web Store, or extension pages',
      code: 'NEED_PAGE'
    };
  }
  const op = String(request?.op || '').trim().toLowerCase();
  if (op === 'choose') {
    // choose runs in offscreen; each click arrives here as its own ticketed op=click.
    return { ok: false, code: 'BAD_INPUT', error: 'choose is not a page op; the workspace dispatches each chosen click separately.' };
  }
  if (op === 'listen' || op === 'record') {
    return handleWorkspaceTabListen({ ...request, tabId, url: resolved.url });
  }
  try {
    await ensurePageActionScripts(tabId);
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: error?.code || 'NEED_PAGE', ...(error?.outcome ? { outcome: error.outcome } : {}) };
  }

  if (op === 'snapshot') {
    const snap = await snapshotPageActionFrames(tabId, {
      scope: String(request.observe || '').toLowerCase() === 'top' ? 'top' : 'all', workflowTarget: request.workflowTarget, workflowObserve: request.workflowObserve
    });
    return maybeAttachScreenshot(snap, request, tabId);
  }

  if (op === 'scrape') {
    const frames = await snapshotPageActionFrames(tabId, {
      scope: 'all', workflowTarget: request.target, workflowObserve: true
    });
    const items = [];
    for (const frame of frames.frames || []) {
      try {
        const raw = await sendPageActionToFrame(tabId, frame.frameId, {
          op: 'scrape', kind: request.kind, columns: request.columns, itemKey: request.itemKey, target: request.target
        }, frame);
        for (const item of raw?.items || []) items.push({ ...item, frameUrl: frame.url || item.frameUrl });
      } catch { /* inaccessible frame */ }
    }
    return { ok: true, op: 'scrape', items, count: items.length, kind: request.kind || 'links', result: { items, count: items.length, kind: request.kind || 'links' } };
  }

  if (op === 'resolve_intent') {
    const snap = snapshots.require(tabId, request.rev);
    for (const frame of snap.frames) await readDocumentTarget(chrome, tabId, frame.frameId, frame);
    await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
    return resolveMutationIntent(request, tabId, snap);
  }

  const usesRef = !!request.ref || (Array.isArray(request.fields) && request.fields.some(f => f?.ref));
  const snapshot = MUTATIONS.has(op) || usesRef ? snapshots.require(tabId, request.rev) : null;
  if (snapshot) {
    for (const frame of snapshot.frames) await readDocumentTarget(chrome, tabId, frame.frameId, frame);
  }
  await assertTabLeaseOwnerActive(request.sessionId, request.executionId);

  if (op === 'wait' && request?.text && !request?.ref) {
    return waitTextAnyFrame(tabId, request);
  }

  if (op === 'fill_form') {
    const resolved = await resolveFillFormTargets(request, tabId, snapshot);
    if (!resolved.ok) return resolved;
    const formGate = await authorizeFillFormBatch(request, tabId, resolved.targets);
    if (!formGate.ok) return formGate;
    const byFrame = new Map();
    for (const target of resolved.targets) {
      const list = byFrame.get(target.frameId) || [];
      list.push({ ...target.field, ref: target.localRef, name: target.field.name });
      byFrame.set(target.frameId, list);
    }
    const results = [];
    let allOk = true;
    for (const [frameId, frameFields] of byFrame) {
      let raw;
      try {
        await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
        raw = await sendPageActionToFrame(tabId, frameId, { op: 'fill_form', fields: frameFields }, snapshot?.frames.find(f => f.frameId === frameId));
      } catch (error) {
        allOk = false;
        results.push({
          ok: false,
          error: error?.message || String(error),
          code: error?.code || 'NEED_PAGE',
          outcome: error?.outcome,
          ...(error?.frameUnreachable ? { frameUnreachable: true } : {})
        });
        break;
      }
      if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') {
        allOk = false;
        results.push({ ok: false, code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown',
          error: 'Missing form receipt. Some fields may have changed; inspect before retrying.' });
        break;
      }
      const rows = Array.isArray(raw.results) ? raw.results : [];
      if (!raw || raw.ok === false) allOk = false;
      for (const row of rows) {
        const local = row && row.ref ? String(row.ref).replace(/^f\d+\./i, '') : '';
        results.push({
          ...row,
          ref: local ? 'f' + frameId + '.' + local : row?.ref
        });
      }
      if (!rows.length && raw.ok === false) {
        results.push({ ok: false, error: raw.error, code: raw.code || 'NEED_PAGE' });
      }
      if (raw.ok === false || rows.some(row => row?.ok === false)) { allOk = false; break; }
    }
    const snap = await observeAfterAction(tabId);
    const failure = results.find(row => row?.ok === false);
    if (!allOk && failure?.code === 'STALE_REF') {
      try { await snapshotPageActionFrames(tabId, { scope: 'all' }); } catch { /* still stale */ }
    }
    return maybeAttachScreenshot(attachFreshSnapshot({ ok: allOk, op: 'fill_form', results,
      ...(!allOk ? { partial: true, code: failure?.code || 'FORM_PARTIAL',
        ...(failure?.code === 'STALE_REF' ? { refreshed: true } : {}),
        ...(failure?.frameUnreachable ? { frameUnreachable: true } : {}),
        ...(failure?.outcome ? { outcome: failure.outcome } : {}) } : {}) }, snap), request, tabId);
  }

  if (op === 'pointer') {
    const point = parsePointerPoint(request);
    if (!point.ok) return point;
    const method = String(request.method || '').toLowerCase();
    if (method !== 'point' && method !== 'cdp') {
      return { ok: false, code: 'BAD_INPUT', error: 'pointer method must be point or cdp' };
    }
    if (method === 'cdp' && visualReplayBlocked(request.executionId, point.x, point.y)) {
      return {
        ok: false,
        code: 'VISUAL_UNCHANGED',
        error: 'This viewport point already produced no visible change.',
        hint: 'Do not repeat the same pointer coordinates in this execution.'
      };
    }
    const expectedTop = snapshot?.frames.find((f) => f.frameId === 0);
    const gate = await authorizePageActionDispatch(request, {
      op,
      tabId,
      frameId: 0,
      documentId: expectedTop?.documentId || request.documentId,
      frameUrl: expectedTop?.url || '',
      method,
      x: point.x,
      y: point.y,
      control: {
        name: request.name || '',
        frameUrl: expectedTop?.url || '',
        documentId: expectedTop?.documentId || request.documentId || '',
        frameId: 0
      }
    });
    if (!gate.ok) return gate;
    if (method === 'cdp') return reflectCdpPointer(request, tabId, point, expectedTop);
    let raw;
    try {
      await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
      raw = await sendPageActionToFrame(tabId, 0, { op: 'pointer', x: point.x, y: point.y }, expectedTop);
    } catch (error) {
      return { ok: false, error: error?.message || String(error), code: error?.code || 'NEED_PAGE', ...(error?.outcome ? { outcome: error.outcome } : {}), ...(error?.frameUnreachable ? { frameUnreachable: true } : {}) };
    }
    if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') {
      return { ok: false, error: 'Empty page action result; inspect before retrying.', code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' };
    }
    const snap = await observeAfterAction(tabId);
    return maybeAttachScreenshot(attachFreshSnapshot(raw, snap), request, tabId);
  }

  let frameId = null;
  let localRef = '';
  const parsed = parseActionRef(request?.ref);
  if (parsed) {
    frameId = parsed.frameId != null ? parsed.frameId : 0;
    localRef = parsed.local;
  } else if (request?.name || request?.label) {
    const hit = await resolveNameAcrossFrames(tabId, request.name || request.label, snapshot);
    if (hit.code) return hit;
    frameId = hit.frameId;
    localRef = hit.local;
  } else if (op === 'press' || op === 'upload' || (op === 'wait' && request?.ms != null && !request?.text && !request?.ref)) {
    frameId = 0;
  } else {
    return { ok: false, error: 'need ref or name', code: 'NO_TARGET' };
  }

  const payload = {
    op,
    ref: localRef || undefined,
    name: request?.name || request?.label,
    value: request?.value,
    key: request?.key,
    deltaY: request?.deltaY,
    text: request?.text,
    ms: request?.ms
  };
  let expectedFrame = snapshot?.frames.find(f => f.frameId === frameId);
  if ((op === 'click' || op === 'fill') && !expectedFrame?.documentId) {
    try {
      const refreshed = await snapshotPageActionFrames(tabId, { scope: 'all' });
      expectedFrame = (refreshed?.frames || []).find((frame) => frame.frameId === frameId) || null;
    } catch { /* frame is still missing */ }
    if (!expectedFrame?.documentId) {
      return { ok: false, code: 'STALE_REF', refreshed: true, error: 'Target frame was not in the snapshot.' };
    }
  }
  if (MUTATIONS.has(op)) {
    const prefixed = localRef ? `f${frameId}.${localRef}` : request.ref;
    const found = lookupControl(tabId, prefixed, request?.name || request?.label);
    const gate = await authorizePageActionDispatch(request, {
      op,
      tabId,
      frameId,
      documentId: expectedFrame?.documentId || found?.documentId || request.documentId,
      frameUrl: expectedFrame?.url || found?.frameUrl || '',
      ref: prefixed,
      path: request.path,
      bytesHash: request.bytesHash,
      itemId: request.itemId,
      artifactId: request.artifactId,
      uploadMethod: request.method,
      control: {
        ...(found || {}),
        name: found?.name || request?.name || request?.label,
        ref: prefixed,
        frameUrl: expectedFrame?.url || found?.frameUrl || '',
        documentId: expectedFrame?.documentId || found?.documentId || '',
        frameId
      }
    });
    if (!gate.ok) return gate;
  }
  if (op === 'upload') {
    const raw = await executePageUpload(request, tabId, frameId, expectedFrame, localRef);
    const snap = await observeAfterAction(tabId);
    return maybeAttachScreenshot(attachFreshSnapshot(raw, snap), request, tabId);
  }
  let raw;
  try {
    await assertTabLeaseOwnerActive(request.sessionId, request.executionId);
    raw = await sendPageActionToFrame(tabId, frameId, payload, expectedFrame);
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: error?.code || 'NEED_PAGE', ...(error?.outcome ? { outcome: error.outcome } : {}), ...(error?.frameUnreachable ? { frameUnreachable: true } : {}) };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') {
    return { ok: false, error: 'Empty page action result; inspect before retrying.', code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' };
  }
  if ((op === 'click' || op === 'fill') && raw.ok === false && raw.code === 'STALE_REF') {
    try { await snapshotPageActionFrames(tabId, { scope: 'all' }); } catch { /* still stale */ }
    raw = { ...raw, refreshed: true };
  }
  if (raw.after && raw.after.ref) {
    raw.after = {
      ...raw.after,
      ref: 'f' + frameId + '.' + String(raw.after.ref).replace(/^f\d+\./i, '')
    };
  }
  const snap = await observeAfterAction(tabId);
  return maybeAttachScreenshot(attachFreshSnapshot(raw, snap), request, tabId);
}
