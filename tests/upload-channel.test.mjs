import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallJournal, createMemoryCallJournal, createUnavailableCallJournal } from '../src/agent/vnext/host/callJournal.js';
import { gatedDispatch } from '../src/agent/vnext/host/operationGate.js';
import {
  classifyRisk,
  decideAccess,
  needsDispatchTicket
} from '../src/agent/vnext/host/riskClassify.js';
import { hashOperationPayload } from '../src/agent/vnext/host/payloadHash.js';
import { verifyPostconditions, applyVerifyToJournalState } from '../src/agent/vnext/host/postcondition.js';
import { resetTabLeases } from '../src/agent/vnext/host/tabLease.js';

globalThis.chrome = globalThis.chrome || { debugger: {} };
const { handleWorkspacePageAction, invalidatePageActionTarget } = await import('../src/agent/vnext/host/pageActionHost.js');
const { handleWorkspaceSys } = await import('../src/agent/vnext/host/browserSysHost.js');
import {
  assertUploadGuestPath,
  planUploadApply,
  applyUploadInPage,
  applyUploadViaScripting,
  applyUploadToTab,
  splitBase64Chunks,
  bytesToBase64,
  hashUploadPayloadBytes,
  omitUploadBytes,
  buildPageActionTransport,
  buildStagedUploadEnvelope,
  dispatchStagedUpload,
  putUploadStageChunk,
  takeUploadStage,
  resetUploadStages,
  uploadOwnerKey,
  UPLOAD_BYTES_MAX,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_RUNTIME_MESSAGE_CHAR_MAX
} from '../src/agent/vnext/host/uploadChannel.js';
import { resolveUploadSource } from '../src/agent/vnext/sessionWorkspace/uploadSource.js';
import {
  createRunDeadline,
  clampRunTimeout,
  extendDeadlineForWaitFor,
  RUN_TIMEOUT_DEFAULT_MS,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_MAX_MS,
  WAIT_FOR_DEADLINE_SLACK_MS
} from '../src/agent/vnext/sessionWorkspace/runDeadline.js';
import { createGuestSys } from '../src/agent/vnext/sessionWorkspace/browserSys.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createGroup, addWebItem, bindGroupsToSession } from '../src/agent/vnext/sessionWorkspace/groups.js';
import { createArtifact } from '../src/agent/vnext/sessionWorkspace/artifacts.js';
import { itemBlobKey } from '../src/agent/vnext/sessionWorkspace/itemPixels.js';
import { installTestPolicy, resetTestPolicy, seedAutoTicket } from './helpers/policyTestKit.mjs';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function installSysChrome({ url = 'https://example.com/app', documentId = 'doc-a' } = {}) {
  const scripting = [];
  const debuggerCalls = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url, title: 'Upload tab' }),
      sendMessage: async (_tabId, message) => {
        if (message?.action === 'ping' || message?.op === 'ping') return { status: 'pong' };
        if (message?.op === 'snapshot') {
          return {
            ok: true,
            controls: [{ ref: 'a1', name: 'Upload', type: 'file' }],
            frameUrl: url
          };
        }
        if (message?.op === 'resolve_name') return { matches: [{ ref: 'a1', name: message.name || 'Upload' }] };
        if (message?.op === 'mark_upload') return { ok: true };
        return { ok: true };
      }
    },
    webNavigation: {
      getFrame: async ({ frameId }) => ({
        frameId,
        documentId,
        documentLifecycle: 'active',
        url
      }),
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId, url }]
    },
    scripting: {
      executeScript: async (opts) => {
        scripting.push({
          world: opts.world,
          hasFunc: typeof opts.func === 'function',
          phase: opts.args?.[0]?.phase,
          method: opts.args?.[0]?.method
        });
        if (opts.files) return [];
        if (opts.args?.[0]?.phase === 'chunk') return [{ result: { ok: true, stored: opts.args[0].index } }];
        return [{
          result: {
            ok: true,
            methodUsed: opts.args?.[0]?.method === 'drop' ? 'drop' : 'input',
            filesCount: 1,
            changeDispatched: opts.args?.[0]?.method !== 'drop',
            trusted: false,
            siteAccepted: 'unknown',
            target: { selector: 'input[type=file]', tag: 'input' }
          }
        }];
      }
    },
    debugger: {
      attach: async (target) => { debuggerCalls.push({ op: 'attach', target }); },
      sendCommand: async (target, method) => {
        debuggerCalls.push({ op: 'send', method });
        return {};
      },
      detach: async () => {},
      getTargets: async () => []
    }
  };
  return { scripting, debuggerCalls };
}

function installUploadDom({ hasInput = true, hidden = true } = {}) {
  const events = [];
  const state = { files: null };
  const inputEl = {
    tagName: 'INPUT',
    type: 'file',
    accept: 'image/*',
    get files() { return state.files; },
    set files(value) { state.files = value; },
    getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 40, height: 20 }),
    dispatchEvent(ev) { events.push(ev.type); return true; },
    closest() { return null; },
    parentElement: null
  };
  const body = {
    tagName: 'BODY',
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    dispatchEvent(ev) { events.push(`body:${ev.type}`); return true; }
  };
  class FakeFile {
    constructor(parts, name, opts = {}) {
      const buf = parts[0];
      this.name = name;
      this.type = opts.type || '';
      this.size = buf?.byteLength ?? buf?.length ?? 0;
    }
  }
  class FakeDT {
    constructor() {
      this.items = {
        add: (file) => {
          this.files = { length: 1, 0: file };
        }
      };
      this.files = { length: 0 };
    }
  }
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.isTrusted = false;
    }
  }
  class FakeDragEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer;
    }
  }
  globalThis.File = FakeFile;
  globalThis.DataTransfer = FakeDT;
  globalThis.Event = FakeEvent;
  globalThis.DragEvent = FakeDragEvent;
  globalThis.getComputedStyle = () => ({
    display: hidden ? 'none' : 'block',
    visibility: 'visible'
  });
  globalThis.document = {
    querySelector(sel) {
      if (sel && String(sel).includes('input') && hasInput) return inputEl;
      if (sel === '[data-paw-upload]') return null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'input[type=file]') return hasInput ? [inputEl] : [];
      return [];
    },
    body
  };
  return { inputEl, events, state };
}

test('upload path jail stays inside the three guest mounts', () => {
  assert.equal(assertUploadGuestPath('/scratch/mid.png').ok, true);
  assert.equal(assertUploadGuestPath('/artifacts/out.png').path, '/artifacts/out.png');
  assert.equal(assertUploadGuestPath('/context/note.txt').ok, true);
  assert.equal(assertUploadGuestPath('/scratch').ok, false);
  assert.equal(assertUploadGuestPath('/tmp/other/x').code, 'FS_DENIED');
  assert.equal(assertUploadGuestPath('/session/other/artifacts/x').code, 'FS_DENIED');
  assert.equal(assertUploadGuestPath('/artifacts/../../etc/passwd').code, 'FS_DENIED');
  assert.equal(assertUploadGuestPath('C:\\\\Users\\\\x.png').code, 'BAD_INPUT');
  assert.equal(assertUploadGuestPath('blob:https://example/1').code, 'BAD_INPUT');
  assert.equal(assertUploadGuestPath('chrome-extension://abc/x').code, 'BAD_INPUT');
  assert.equal(assertUploadGuestPath('/artifacts/../scratch/mid.png').path, '/scratch/mid.png');
});

test('upload plan never auto-attaches CDP', () => {
  const autoInput = planUploadApply({ method: 'auto', hasFileInput: true });
  assert.deepEqual(autoInput.steps, ['input', 'drop']);
  assert.equal(autoInput.autoCdp, false);
  const autoDrop = planUploadApply({ method: 'auto', hasFileInput: false });
  assert.deepEqual(autoDrop.steps, ['drop']);
  assert.equal(autoDrop.autoCdp, false);
  assert.equal(planUploadApply({ method: 'input' }).autoCdp, false);
  const cdp = planUploadApply({ method: 'cdp' });
  assert.equal(cdp.explicitCdp, true);
  assert.ok(cdp.steps.includes('cdp-drag'));
});

test('MAIN-world apply assigns DataTransfer files and never claims siteAccepted', () => {
  installUploadDom({ hasInput: true });
  applyUploadInPage({ phase: 'chunk', token: 't1', index: 0, b64: bytesToBase64(PNG) });
  const out = applyUploadInPage({
    phase: 'apply',
    token: 't1',
    filename: 'poster.png',
    mimeType: 'image/png',
    method: 'auto'
  });
  assert.equal(out.ok, true);
  assert.equal(out.methodUsed, 'input');
  assert.equal(out.filesCount, 1);
  assert.equal(out.trusted, false);
  assert.equal(out.siteAccepted, 'unknown');
  assert.equal(out.changeDispatched, true);
});

test('auto falls back to script drop when no file input exists', () => {
  installUploadDom({ hasInput: false });
  applyUploadInPage({ phase: 'chunk', token: 't2', index: 0, b64: bytesToBase64(PNG) });
  const out = applyUploadInPage({
    phase: 'apply',
    token: 't2',
    filename: 'poster.png',
    mimeType: 'image/png',
    method: 'auto'
  });
  assert.equal(out.ok, true);
  assert.equal(out.methodUsed, 'drop');
  assert.equal(out.trusted, false);
  assert.equal(out.siteAccepted, 'unknown');
});

test('scripting transport uses MAIN world args and chunks; 8MB+1 is TOO_LARGE', async () => {
  const chunks = splitBase64Chunks(bytesToBase64(new Uint8Array(400 * 1024)), UPLOAD_CHUNK_SIZE);
  assert.ok(chunks.length >= 2);
  const calls = [];
  const chromeRef = {
    scripting: {
      executeScript: async (opts) => {
        calls.push(opts);
        return [{ result: opts.args[0].phase === 'chunk' ? { ok: true } : { ok: true, methodUsed: 'input', trusted: false, siteAccepted: 'unknown', filesCount: 1 } }];
      }
    }
  };
  const applied = await applyUploadViaScripting(chromeRef, {
    tabId: 3,
    documentId: 'doc-a',
    bytes: new Uint8Array(400 * 1024),
    filename: 'big.bin',
    mimeType: 'application/octet-stream',
    method: 'auto'
  });
  assert.equal(applied.ok, true);
  assert.ok(calls.every((c) => c.world === 'MAIN' && typeof c.func === 'function' && Array.isArray(c.args)));
  assert.ok(calls.length >= 3);
  const over = await applyUploadViaScripting(chromeRef, {
    tabId: 3,
    bytes: new Uint8Array(UPLOAD_BYTES_MAX + 1),
    filename: 'over.bin',
    mimeType: 'application/octet-stream'
  });
  assert.equal(over.code, 'TOO_LARGE');
});

test('applyUploadToTab auto never calls the CDP helper', async () => {
  let cdpCalled = false;
  const chromeRef = {
    scripting: {
      executeScript: async () => [{ result: { ok: true, methodUsed: 'input', trusted: false, siteAccepted: 'unknown', filesCount: 1 } }]
    },
    debugger: {
      attach: async () => { cdpCalled = true; },
      sendCommand: async () => { cdpCalled = true; return {}; }
    }
  };
  const out = await applyUploadToTab(chromeRef, {
    tabId: 4,
    bytes: PNG,
    filename: 'a.png',
    mimeType: 'image/png',
    method: 'auto'
  }, {
    ensureAttached: async () => { cdpCalled = true; },
    send: async () => { cdpCalled = true; return {}; }
  });
  assert.equal(out.ok, true);
  assert.equal(cdpCalled, false);
});

test('action upload on a known payment host is PAYMENT even when method is cdp', () => {
  const pay = classifyRisk({
    channel: 'action',
    op: 'upload',
    name: 'Upload',
    url: 'https://checkout.stripe.com/c/pay',
    uploadMethod: 'cdp',
    method: 'cdp'
  });
  assert.equal(pay.risk, 'payment');
  assert.equal(pay.confidence, 'known');
  assert.equal(decideAccess(pay), 'deny');
});

test('typed upload is known external-commit; payment host stays PAYMENT; CDP is raw', () => {
  const action = classifyRisk({ channel: 'action', op: 'upload', name: 'Upload', url: 'https://canva.com/design' });
  assert.equal(action.risk, 'external-commit');
  assert.equal(action.confidence, 'known');
  assert.equal(decideAccess(action), 'auto');
  assert.equal(needsDispatchTicket(action), true);

  const sys = classifyRisk({ channel: 'sys', op: 'upload', path: '/scratch/a.png', url: 'https://remove.bg/' });
  assert.equal(sys.risk, 'external-commit');
  assert.equal(sys.confidence, 'known');

  const pay = classifyRisk({
    channel: 'sys',
    op: 'upload',
    uploadMethod: 'auto',
    url: 'https://checkout.stripe.com/c/pay'
  });
  assert.equal(pay.risk, 'payment');
  assert.equal(decideAccess(pay), 'deny');

  const payCdp = classifyRisk({
    channel: 'sys',
    op: 'upload',
    uploadMethod: 'cdp',
    url: 'https://checkout.stripe.com/c/pay'
  });
  assert.equal(payCdp.risk, 'payment');

  const raw = classifyRisk({
    channel: 'sys',
    op: 'upload',
    uploadMethod: 'cdp',
    url: 'https://example.com'
  });
  assert.equal(raw.risk, 'raw-escape');
  assert.equal(decideAccess(raw), 'auto');
});

test('sys.upload without a ticket is TICKET_REQUIRED and does not inject', async () => {
  installTestPolicy();
  resetTabLeases();
  const { scripting, debuggerCalls } = installSysChrome();
  const out = await handleWorkspaceSys({
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { tabId: 11, path: '/scratch/a.png', bytes: PNG, filename: 'a.png' }
  });
  assert.equal(out.code, 'TICKET_REQUIRED');
  assert.equal(scripting.filter((c) => c.hasFunc).length, 0);
  assert.equal(debuggerCalls.length, 0);
  resetTestPolicy();
});

test('action op=upload without a ticket is TICKET_REQUIRED', async () => {
  installTestPolicy();
  resetTabLeases();
  invalidatePageActionTarget(11);
  const { scripting } = installSysChrome();
  const snap = await handleWorkspacePageAction({
    tabId: 11, sessionId: 's', executionId: 'e', op: 'snapshot'
  });
  const bare = await handleWorkspacePageAction({
    tabId: 11,
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    rev: snap.rev,
    path: '/scratch/a.png',
    bytes: PNG
  });
  assert.equal(bare.code, 'TICKET_REQUIRED');
  assert.equal(scripting.filter((c) => c.hasFunc).length, 0);
  resetTestPolicy();
});

test('SW recomputes upload hash; a ticket with the host hash can dispatch', async () => {
  installTestPolicy();
  resetTabLeases();
  const { scripting } = installSysChrome();
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const req = {
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: {
      tabId: 11,
      path: '/scratch/a.png',
      bytes: PNG,
      filename: 'a.png',
      documentId: 'doc-a'
    }
  };
  Object.assign(req, await seedAutoTicket(req, {
    channel: 'sys',
    path: '/scratch/a.png',
    bytesHash,
    tabId: 11,
    documentId: 'doc-a',
    url: 'https://example.com/app',
    frameUrl: 'https://example.com/app'
  }));
  const out = await handleWorkspaceSys(req);
  assert.equal(out.ok, true);
  assert.equal(out.result.siteAccepted, 'unknown');
  assert.equal(out.result.trusted, false);
  assert.equal(out.result.methodUsed, 'input');
  assert.ok(scripting.some((c) => c.world === 'MAIN' && c.hasFunc));
  const forged = await handleWorkspaceSys({
    ...req,
    operationId: req.operationId,
    ticketNonce: req.ticketNonce,
    params: { ...req.params, bytes: new Uint8Array([9, 9, 9]) }
  });
  assert.ok(['TICKET_REQUIRED', 'APPROVAL_MISMATCH'].includes(forged.code));
  resetTestPolicy();
});

test('upload on a known payment host is PAYMENT_DENIED even with a ticket', async () => {
  installTestPolicy({ mode: 'full' });
  resetTabLeases();
  const { scripting } = installSysChrome({ url: 'https://checkout.stripe.com/c/pay', documentId: 'doc-pay' });
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const req = {
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { tabId: 22, path: '/scratch/card.png', bytes: PNG, filename: 'card.png', documentId: 'doc-pay' }
  };
  Object.assign(req, await seedAutoTicket(req, {
    channel: 'sys',
    path: '/scratch/card.png',
    bytesHash,
    tabId: 22,
    documentId: 'doc-pay',
    url: 'https://checkout.stripe.com/c/pay',
    frameUrl: 'https://checkout.stripe.com/c/pay'
  }));
  const out = await handleWorkspaceSys(req);
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(scripting.filter((c) => c.hasFunc).length, 0);
  resetTestPolicy();
});

test('CDP upload is no longer refused by mode and takes the debugger path', async () => {
  installTestPolicy();
  resetTabLeases();
  const { debuggerCalls } = installSysChrome();
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const req = {
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { tabId: 11, path: '/scratch/a.png', bytes: PNG, method: 'cdp', filename: 'a.png', documentId: 'doc-a' }
  };
  Object.assign(req, await seedAutoTicket(req, {
    channel: 'sys',
    path: '/scratch/a.png',
    bytesHash,
    tabId: 11,
    documentId: 'doc-a',
    url: 'https://example.com/app',
    frameUrl: 'https://example.com/app',
    uploadMethod: 'cdp',
    method: 'cdp'
  }));
  const out = await handleWorkspaceSys(req);
  assert.notEqual(out.code, 'RAW_ESCAPE_DENIED');
  assert.ok(debuggerCalls.length > 0, 'method:cdp reaches chrome.debugger');
  resetTestPolicy();
});

test('journal unavailable fail-closes upload and does not send', async () => {
  installTestPolicy();
  let sent = 0;
  const out = await gatedDispatch(
    {
      channel: 'sys',
      op: 'upload',
      path: '/scratch/a.png',
      bytesHash: 'abc',
      sessionId: 's',
      executionId: 'e',
      tabId: 11,
      documentId: 'doc-a',
      url: 'https://example.com',
      frameUrl: 'https://example.com'
    },
    {
      journal: createUnavailableCallJournal(),
      readPolicy: async () => ({ mode: 'guarded' }),
      send: async () => { sent += 1; return { ok: true }; }
    }
  );
  assert.equal(out.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(sent, 0);
  resetTestPolicy();
});

test('memory journal can authorize a known upload; SW hash includes path and bytesHash', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  let sent = 0;
  const out = await gatedDispatch(
    {
      channel: 'sys',
      op: 'upload',
      path: '/scratch/a.png',
      bytesHash: 'deadbeef',
      sessionId: 's',
      executionId: 'e',
      tabId: 11,
      documentId: 'doc-a',
      url: 'https://example.com',
      frameUrl: 'https://example.com'
    },
    {
      journal,
      readPolicy: async () => ({ mode: 'guarded' }),
      putTicket: async () => {},
      send: async () => { sent += 1; return { ok: true, result: { filesCount: 1, siteAccepted: 'unknown' } }; }
    }
  );
  assert.equal(out.ok, true);
  assert.equal(sent, 1);
  const a = await hashOperationPayload({
    channel: 'sys', op: 'upload', sysOp: 'upload', path: '/scratch/a.png', bytesHash: 'deadbeef', tabId: 11, documentId: 'doc-a'
  });
  const b = await hashOperationPayload({
    channel: 'sys', op: 'upload', sysOp: 'upload', path: '/scratch/b.png', bytesHash: 'deadbeef', tabId: 11, documentId: 'doc-a'
  });
  assert.notEqual(a, b);
  resetTestPolicy();
});

test('upload postcondition stays succeeded and is never verified', async () => {
  const row = {
    op: 'upload',
    risk: 'external-commit',
    state: 'succeeded',
    intent: { channel: 'sys', op: 'upload' }
  };
  const out = await verifyPostconditions(row, {
    facts: { filesCount: 1, siteAccepted: 'unknown', modelEvidence: 'Canva imported it' }
  });
  assert.equal(out.status, 'skipped');
  assert.notEqual(out.status, 'verified');
  assert.equal(applyVerifyToJournalState(row, out), 'succeeded');
});

test('upload source accepts three mounts, itemId copy, and denies cross-session artifacts', async () => {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's' });
  store.put('sessions', 'other', { sessionId: 'other' });
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  fs.writeFile('/scratch/mid.png', PNG, { mimeType: 'image/png' });
  fs.writeFile('/artifacts/final.png', PNG, { mimeType: 'image/png' });
  store.putBlob('fs:/session/s/context/note.txt', new TextEncoder().encode('ctx'), { mimeType: 'text/plain' });
  store.put('fsNodes', '/session/s/context/note.txt', {
    path: '/session/s/context/note.txt',
    guestPath: '/context/note.txt',
    kind: 'file',
    sessionId: 's'
  });

  const scratch = await resolveUploadSource({ store, fs, sessionId: 's', path: '/scratch/mid.png' });
  assert.equal(scratch.ok, true);
  assert.equal(scratch.path, '/scratch/mid.png');
  const artPath = await resolveUploadSource({ store, fs, sessionId: 's', path: '/artifacts/final.png' });
  assert.equal(artPath.ok, true);
  const ctx = await resolveUploadSource({ store, fs, sessionId: 's', path: '/context/note.txt' });
  assert.equal(ctx.ok, true);

  const both = await resolveUploadSource({ store, fs, sessionId: 's', path: '/scratch/mid.png', itemId: 'x' });
  assert.equal(both.code, 'BAD_INPUT');

  const otherFs = createSessionGuestFs(store, { sessionId: 'other', executionId: 'e' });
  const foreign = createArtifact(store, otherFs, {
    sessionId: 'other',
    name: 'secret.txt',
    content: 'nope',
    mimeType: 'text/plain',
    skipValidation: true
  });
  const stolen = await resolveUploadSource({ store, fs, sessionId: 's', artifactId: foreign.artifactId });
  assert.equal(stolen.code, 'AUTH_DENIED');

  const group = createGroup(store, { name: 'Pins' });
  bindGroupsToSession(store, 's', [group.groupId]);
  const item = addWebItem(store, group.groupId, {
    filename: 'photo.png',
    kindHint: 'image',
    name: 'photo.png',
    labelKind: 'image',
    labelN: 1
  });
  const before = structuredClone(store.get('items', item.webItemId));
  store.putBlob(itemBlobKey(item.webItemId), PNG, { mimeType: 'image/png' });
  const fromItem = await resolveUploadSource({ store, fs, sessionId: 's', itemId: item.webItemId });
  assert.equal(fromItem.ok, true);
  assert.match(fromItem.path, /^\/scratch\/upload\//);
  assert.deepEqual(store.get('items', item.webItemId).capture, before.capture);
  assert.equal(store.get('groupMembers', group.groupId).length, 1);
  assert.equal(store.keys('artifacts').length, 1);
});

test('host extends the run deadline for waitFor instead of raising every run default', async () => {
  assert.equal(clampRunTimeout(undefined), RUN_TIMEOUT_DEFAULT_MS);
  assert.equal(clampRunTimeout(null), RUN_TIMEOUT_DEFAULT_MS);
  const clock = createRunDeadline(15_000);
  const before = clock.expiresAt;
  const cover = extendDeadlineForWaitFor(clock, undefined);
  assert.equal(cover, WAIT_FOR_DEFAULT_MS + WAIT_FOR_DEADLINE_SLACK_MS);
  assert.ok(clock.expiresAt > before);
  assert.ok(clock.remaining() > 16_000);

  const calls = [];
  const sys = createGuestSys({
    deadline: clock,
    hostSys: async (op, params) => {
      calls.push({ op, deadline: clock.expiresAt, params });
      return { ok: true, result: { ready: true } };
    }
  });
  await sys.waitFor({ text: 'ready' });
  assert.equal(calls[0].op, 'waitFor');
  assert.ok(calls[0].deadline - Date.now() > 16_000);

  await assert.rejects(
    () => createGuestSys({ hostSys: async () => ({ ok: true }) }).upload({ path: '/scratch/a.png', bytes: PNG }),
    { code: 'BAD_INPUT' }
  );

  const huge = createRunDeadline(15_000);
  extendDeadlineForWaitFor(huge, 999_000);
  assert.ok(huge.remaining() <= WAIT_FOR_MAX_MS + WAIT_FOR_DEADLINE_SLACK_MS + 50);
});

test('pre-authorize page-action envelopes omit file bytes', () => {
  const raw = {
    op: 'upload',
    path: '/scratch/a.png',
    bytes: PNG,
    base64: 'abc',
    chunks: ['x'],
    rev: 't1',
    params: { bytes: PNG, path: '/scratch/a.png' }
  };
  const intent = buildPageActionTransport(raw, { op: 'resolve_intent', targetOp: 'upload' });
  assert.equal(intent.op, 'resolve_intent');
  assert.equal(intent.targetOp, 'upload');
  assert.equal(intent.path, '/scratch/a.png');
  assert.equal(intent.bytes, undefined);
  assert.equal(intent.base64, undefined);
  assert.equal(intent.chunks, undefined);
  assert.equal(intent.params.bytes, undefined);
  assert.equal(omitUploadBytes(raw).rev, 't1');
});

test('offscreen→SW upload envelope chunks below the runtime message cap and apply carries no bytes', () => {
  const bytes = new Uint8Array(400 * 1024);
  bytes.set(PNG, 0);
  const envelope = buildStagedUploadEnvelope({
    path: '/scratch/big.bin',
    bytes,
    bytesHash: 'deadbeef',
    tabId: 3,
    filename: 'big.bin'
  });
  assert.equal(envelope.ok, true);
  assert.ok(envelope.stageMessages.length >= 2);
  for (const msg of envelope.stageMessages) {
    assert.equal(msg.op, 'upload.stage');
    assert.ok(JSON.stringify(msg).length <= UPLOAD_RUNTIME_MESSAGE_CHAR_MAX);
    assert.ok(String(msg.params.b64 || '').length <= UPLOAD_CHUNK_SIZE);
  }
  assert.equal(envelope.applyParams.bytes, undefined);
  assert.equal(envelope.applyParams.base64, undefined);
  assert.equal(envelope.applyParams.stageId, envelope.stageId);
  assert.equal(envelope.applyParams.path, '/scratch/big.bin');
  const eight = new Uint8Array(UPLOAD_BYTES_MAX);
  const big = buildStagedUploadEnvelope({ path: '/scratch/8.bin', bytes: eight, bytesHash: 'ab' });
  assert.equal(big.ok, true);
  assert.equal(big.applyParams.bytes, undefined);
  for (const msg of big.stageMessages) {
    assert.ok(JSON.stringify(msg).length <= UPLOAD_RUNTIME_MESSAGE_CHAR_MAX);
  }
});

test('upload.stage does not inject; apply without a ticket stays TICKET_REQUIRED', async () => {
  installTestPolicy();
  resetTabLeases();
  resetUploadStages();
  const { scripting } = installSysChrome();
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const envelope = buildStagedUploadEnvelope({
    path: '/scratch/a.png',
    bytes: PNG,
    bytesHash,
    filename: 'a.png',
    tabId: 11,
    documentId: 'doc-a'
  });
  for (const msg of envelope.stageMessages) {
    const staged = await handleWorkspaceSys({
      sessionId: 's',
      executionId: 'e',
      op: 'upload.stage',
      params: msg.params
    });
    assert.equal(staged.ok, true);
    assert.equal(staged.result.injected, false);
  }
  assert.equal(scripting.filter((c) => c.hasFunc).length, 0);
  const bare = await handleWorkspaceSys({
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { ...envelope.applyParams, tabId: 11, documentId: 'doc-a' }
  });
  assert.equal(bare.code, 'TICKET_REQUIRED');
  assert.equal(scripting.filter((c) => c.hasFunc).length, 0);
  resetUploadStages();
  resetTestPolicy();
});

test('staged upload with a matching ticket dispatches; forged assembled hash is rejected', async () => {
  installTestPolicy();
  resetTabLeases();
  resetUploadStages();
  const { scripting } = installSysChrome();
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const envelope = buildStagedUploadEnvelope({
    path: '/scratch/a.png',
    bytes: PNG,
    bytesHash,
    filename: 'a.png',
    tabId: 11,
    documentId: 'doc-a'
  });
  const req = {
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { ...envelope.applyParams, tabId: 11, documentId: 'doc-a', filename: 'a.png' }
  };
  Object.assign(req, await seedAutoTicket(req, {
    channel: 'sys',
    path: '/scratch/a.png',
    bytesHash,
    tabId: 11,
    documentId: 'doc-a',
    url: 'https://example.com/app',
    frameUrl: 'https://example.com/app'
  }));
  for (const msg of envelope.stageMessages) {
    const staged = await handleWorkspaceSys({
      sessionId: 's',
      executionId: 'e',
      op: 'upload.stage',
      params: msg.params
    });
    assert.equal(staged.ok, true);
  }
  const out = await handleWorkspaceSys(req);
  assert.equal(out.ok, true);
  assert.equal(out.result.siteAccepted, 'unknown');
  assert.ok(scripting.some((c) => c.world === 'MAIN' && c.hasFunc));

  resetUploadStages();
  const otherHash = await hashUploadPayloadBytes(new Uint8Array([1, 2, 3]));
  const mismatch = buildStagedUploadEnvelope({
    path: '/scratch/a.png',
    bytes: PNG,
    bytesHash: otherHash,
    filename: 'a.png',
    tabId: 11,
    documentId: 'doc-a'
  });
  const bad = {
    sessionId: 's',
    executionId: 'e',
    op: 'upload',
    params: { ...mismatch.applyParams, tabId: 11, documentId: 'doc-a', filename: 'a.png' }
  };
  Object.assign(bad, await seedAutoTicket(bad, {
    channel: 'sys',
    path: '/scratch/a.png',
    bytesHash: otherHash,
    tabId: 11,
    documentId: 'doc-a',
    url: 'https://example.com/app',
    frameUrl: 'https://example.com/app'
  }));
  for (const msg of mismatch.stageMessages) {
    await handleWorkspaceSys({
      sessionId: 's',
      executionId: 'e',
      op: 'upload.stage',
      params: msg.params
    });
  }
  const forged = await handleWorkspaceSys(bad);
  assert.equal(forged.code, 'APPROVAL_MISMATCH');
  resetUploadStages();
  resetTestPolicy();
});

test('payment deny never stages bytes to SW; send is not called', async () => {
  installTestPolicy({ mode: 'full' });
  resetUploadStages();
  let stages = 0;
  let applies = 0;
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const out = await gatedDispatch(
    {
      channel: 'sys',
      op: 'upload',
      path: '/scratch/card.png',
      bytesHash,
      bytes: PNG,
      uploadMethod: 'cdp',
      sessionId: 's',
      executionId: 'e',
      tabId: 22,
      documentId: 'doc-pay',
      url: 'https://checkout.stripe.com/c/pay',
      frameUrl: 'https://checkout.stripe.com/c/pay'
    },
    {
      journal: createCallJournal(createMemoryCallJournal()),
      readPolicy: async () => ({ mode: 'full' }),
      putTicket: async () => {},
      send: async (req) =>
        dispatchStagedUpload(req, {
          sendStage: async () => {
            stages += 1;
            return { ok: true };
          },
          sendApply: async () => {
            applies += 1;
            return { ok: true };
          }
        })
    }
  );
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(stages, 0);
  assert.equal(applies, 0);
  resetUploadStages();
  resetTestPolicy();
});

test('dispatchStagedUpload is the authorized send path: stage then apply without bytes', async () => {
  const seen = [];
  const bytesHash = await hashUploadPayloadBytes(PNG);
  const out = await dispatchStagedUpload(
    { path: '/scratch/a.png', bytes: PNG, bytesHash, tabId: 11 },
    {
      sendStage: async (msg) => {
        seen.push(msg);
        return { ok: true };
      },
      sendApply: async (params) => {
        seen.push({ op: 'upload', params });
        return { ok: true, result: { siteAccepted: 'unknown' } };
      }
    }
  );
  assert.equal(out.ok, true);
  assert.ok(seen.some((row) => row.op === 'upload.stage'));
  const apply = seen.find((row) => row.op === 'upload');
  assert.equal(apply.params.bytes, undefined);
  assert.ok(apply.params.stageId);
  const owner = uploadOwnerKey('s', 'e');
  const staged = putUploadStageChunk({
    stageId: 'stg_test',
    owner,
    index: 0,
    total: 1,
    b64: bytesToBase64(PNG),
    bytesHash
  });
  assert.equal(staged.ok, true);
  assert.equal(takeUploadStage('stg_test', owner).ok, true);
  resetUploadStages();
});
