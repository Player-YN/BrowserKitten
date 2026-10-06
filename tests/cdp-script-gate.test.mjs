import test from 'node:test';
import assert from 'node:assert/strict';
import { resetTabLeases } from '../src/agent/vnext/host/tabLease.js';
import { cdpCommandRunsScript } from '../src/agent/vnext/host/cdpScriptGate.js';
import { installTestPolicy, seedAutoTicket } from './helpers/policyTestKit.mjs';
globalThis.chrome = { debugger: {} };
const { handleWorkspaceSys } = await import('../src/agent/vnext/host/browserSysHost.js');
const { releaseBrowserExecution } = await import('../src/agent/vnext/host/browserExecution.js');
const { uploadViaCdpOnce } = await import('../src/agent/vnext/host/pageActionHost.js');

/** userScripts: 'missing' = optional permission not granted, 'off' = granted but toggle off, 'on' = usable. */
function setup({ userScripts = 'missing', busy = false } = {}) {
  installTestPolicy();
  resetTabLeases();
  const state = { attaches: [], detaches: [], sent: [] };
  const us = userScripts === 'missing' ? undefined : {
    getScripts: async () => { if (userScripts === 'off') throw new Error('off'); return []; },
    execute: async () => []
  };
  globalThis.chrome = {
    tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Test' }) },
    webNavigation: { getFrame: async ({ frameId }) => ({ frameId, documentId: 'doc-1', documentLifecycle: 'active', url: 'https://example.com' }) },
    ...(us ? { userScripts: us } : {}),
    debugger: {
      attach: async target => {
        if (busy) throw new Error('Another debugger is already attached to the tab');
        state.attaches.push(target.tabId);
      },
      detach: async target => state.detaches.push(target.tabId),
      sendCommand: async (_target, method, params) => { state.sent.push({ method, params }); return { ok: method }; },
      getTargets: async () => []
    }
  };
  return state;
}

let nextExecution = 0;
async function cdp(params) {
  const executionId = `e${++nextExecution}`;
  const req = { op: 'cdp', params, sessionId: 's', executionId };
  Object.assign(req, await seedAutoTicket(req, { channel: 'sys', op: 'cdp', params }));
  const out = await handleWorkspaceSys(req);
  await releaseBrowserExecution('s', executionId);
  return out;
}

const REQUIRED_BLOCKS = [
  ['Runtime.evaluate', { expression: '1' }],
  ['Runtime.callFunctionOn', { functionDeclaration: '() => 1', objectId: 'x' }],
  ['Runtime.compileScript', { expression: '1', sourceURL: '', persistScript: true }],
  ['Runtime.runScript', { scriptId: '1' }],
  ['Page.addScriptToEvaluateOnNewDocument', { source: 'alert(1)' }],
  ['Page.createIsolatedWorld', { frameId: 'f', worldName: 'w' }],
  ['Debugger.setScriptSource', { scriptId: '1', scriptSource: '' }],
  ['Debugger.evaluateOnCallFrame', { callFrameId: 'c', expression: '1' }],
  ['Page.navigate', { url: 'javascript:alert(1)' }],
  ['Page.navigate', { url: ' JavaScript:alert(1)' }],
  ['Page.navigate', { url: 'java\tscript:alert(1)' }],
  ['Target.createTarget', { url: 'javascript:alert(1)' }]
];

test('script-capable CDP is classified as script; plain observation and input are not', () => {
  for (const [method, params] of REQUIRED_BLOCKS) assert.equal(cdpCommandRunsScript(method, params), true, method);
  for (const [method, params] of [
    ['Debugger.setBreakpointByUrl', { lineNumber: 1, condition: 'fetch("x")' }],
    ['Fetch.fulfillRequest', { requestId: '1', responseCode: 200 }],
    ['Page.setDocumentContent', { frameId: 'f', html: '<script>1</script>' }],
    ['DOM.setOuterHTML', { nodeId: 1, outerHTML: '<img onerror=1>' }],
    ['DOM.setAttributeValue', { nodeId: 1, name: 'onclick', value: 'x()' }],
    ['DOM.setAttributeValue', { nodeId: 1, name: 'href', value: 'javascript:x()' }],
    ['DOM.setAttributesAsText', { nodeId: 1, text: 'src=x onerror="y()"' }],
    ['Target.attachToTarget', { targetId: 't', flatten: true }],
    ['Page.navigate', { url: 'data:text/html,<script>1</script>' }],
    ['SomeFutureDomain.doThing', {}]
  ]) assert.equal(cdpCommandRunsScript(method, params), true, method);
  for (const [method, params] of [
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }],
    ['Page.getLayoutMetrics', {}],
    ['Page.captureScreenshot', {}],
    ['Page.navigate', { url: 'https://example.com/a' }],
    ['Target.createTarget', { url: 'about:blank' }],
    ['DOM.getDocument', { depth: 0 }],
    ['DOM.setFileInputFiles', { files: ['/tmp/a'], nodeId: 1 }],
    ['DOM.setAttributeValue', { nodeId: 1, name: 'value', value: 'hello' }],
    ['Network.enable', {}],
    ['Network.getResponseBody', { requestId: '1' }],
    ['Accessibility.getFullAXTree', {}],
    ['Runtime.enable', {}],
    ['Runtime.getProperties', { objectId: 'x' }]
  ]) assert.equal(cdpCommandRunsScript(method, params), false, method);
});

test('blocked CDP methods without usable userScripts return PERMISSION_REQUIRED and touch nothing', async () => {
  for (const userScripts of ['missing', 'off']) {
    for (const [method, params] of REQUIRED_BLOCKS) {
      const state = setup({ userScripts });
      const out = await cdp({ tabId: 70, method, params });
      assert.equal(out.ok, false, `${userScripts} ${method}`);
      assert.equal(out.code, 'PERMISSION_REQUIRED', `${userScripts} ${method}`);
      assert.equal(out.permission, 'userScripts');
      assert.equal(out.method, method);
      assert.deepEqual(state.attaches, [], 'refused before attach: no debugging banner');
      assert.deepEqual(state.sent, []);
    }
  }
});

test('the same methods are allowed once userScripts is granted and usable', async () => {
  for (const [method, params] of REQUIRED_BLOCKS) {
    const state = setup({ userScripts: 'on' });
    const out = await cdp({ tabId: 71, method, params });
    assert.equal(out.ok, true, method);
    assert.deepEqual(state.sent.map(c => c.method), [method]);
    assert.deepEqual(state.detaches, [71], 'released at execution end');
  }
});

test('non-script CDP methods work without userScripts', async () => {
  for (const [method, params] of [
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }],
    ['Page.getLayoutMetrics', {}],
    ['Page.navigate', { url: 'https://example.com/next' }],
    ['DOM.setFileInputFiles', { files: ['/tmp/a.png'], nodeId: 5 }],
    ['Network.enable', {}]
  ]) {
    const state = setup({ userScripts: 'missing' });
    const out = await cdp({ tabId: 72, method, params });
    assert.equal(out.ok, true, method);
    assert.deepEqual(state.sent.map(c => c.method), [method]);
  }
  const state = setup({ userScripts: 'missing' });
  for (const action of ['attach', 'events', 'detach']) {
    assert.equal((await cdp({ tabId: 73, action })).ok, true, action);
  }
  assert.ok(state.attaches.includes(73));
});

test('the host attach-reclaim probe (Runtime.evaluate void 0) is not gated', async () => {
  const state = setup({ userScripts: 'missing', busy: true });
  const out = await cdp({ tabId: 74, method: 'Page.getLayoutMetrics', params: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(state.sent.map(c => c.method), ['Runtime.evaluate', 'Page.getLayoutMetrics']);
  assert.equal(state.sent[0].params.expression, 'void 0');
});

test('host CDP upload does not pass through the guest gate', async () => {
  setup({ userScripts: 'missing' });
  const calls = [];
  const fake = {
    debugger: {
      attach: async () => calls.push('attach'),
      sendCommand: async (_t, method) => { calls.push(method); return {}; },
      detach: async () => calls.push('detach')
    }
  };
  const spec = { tabId: 75, method: 'cdp', bytes: new Uint8Array([1, 2, 3]), filename: 'a.bin', mimeType: 'application/octet-stream' };
  const out = await uploadViaCdpOnce(fake, spec, 75);
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ['attach', 'Input.dispatchDragEvent', 'Input.dispatchDragEvent', 'Input.dispatchDragEvent', 'detach']);
});
