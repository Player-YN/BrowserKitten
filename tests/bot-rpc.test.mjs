import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_RPC_METHODS, assertWorkspaceRpc, dispatchWorkspaceRpc, workspaceSenderRole } from '../src/agent/vnext/host/workspaceRpcContract.js';
import { createWorkspaceRpcTransport } from '../src/agent/vnext/host/workspaceRpcTransport.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
const runtime = { id: 'test', getURL: path => `chrome-extension://test/${path}` };
const sender = (path, tab) => ({ id: 'test', url: runtime.getURL(path), ...(tab ? { tab: { id: 7 } } : {}) });

test('RPC allowlist names actual service methods, not reflection or prototype methods', () => {
  for (const method of Object.keys(WORKSPACE_RPC_METHODS)) assert.equal(typeof SessionWorkspaceService.prototype[method], 'function', method);
  for (const name of ['constructor', 'toString', '__proto__', 'ensureSession', 'resolveLanguageModel', '_persist']) {
    assert.throws(() => assertWorkspaceRpc(name, {}, 'background'), { code: 'RPC_METHOD_DENIED' });
  }
});
test('scheduler methods are internal, preview is artifact-only, malformed params rejected', () => {
  assert.equal(assertWorkspaceRpc('getChatMediaStatus', {}, 'ui').retrySafe, true);
  assert.equal(assertWorkspaceRpc('getContextWindowStatus', {}, 'ui').retrySafe, true);
  assert.equal(assertWorkspaceRpc('requestChatMediaCheck', {}, 'ui').retrySafe, false);
  assert.equal(assertWorkspaceRpc('requestContextWindowCheck', {}, 'ui').retrySafe, false);
  for (const method of ['getChatMediaStatus', 'getContextWindowStatus', 'requestChatMediaCheck', 'requestContextWindowCheck']) {
    assert.throws(() => assertWorkspaceRpc(method, {}, 'preview'), { code: 'RPC_DENIED' });
    assert.throws(() => assertWorkspaceRpc(method, {}, 'untrusted'), { code: 'RPC_DENIED' });
  }
  for (const name of ['runDueTasks', 'getTaskSchedule', 'getBrowserRuntimeState']) {
    assert.throws(() => assertWorkspaceRpc(name, {}, 'ui'), { code: 'RPC_DENIED' });
    assertWorkspaceRpc(name, {}, 'background');
  }
  assertWorkspaceRpc('updateArtifact', {}, 'preview');
  assert.throws(() => assertWorkspaceRpc('sendMessage', {}, 'preview'), { code: 'RPC_DENIED' });
  for (const params of [[], null, 'x', Object.create({ injected: true })]) {
    assert.throws(() => assertWorkspaceRpc('getSession', params), { code: 'RPC_BAD_PARAMS' });
  }
});
test('sender role uses Chrome metadata, not message claims or URL lookalikes', () => {
  assert.equal(workspaceSenderRole(sender('src/sidepanel.html'), runtime), 'ui');
  assert.equal(workspaceSenderRole(sender('src/preview/site.html?sessionId=s', true), runtime), 'preview');
  assert.equal(workspaceSenderRole(sender('src/offscreen/runtime.html'), runtime), 'offscreen');
  assert.equal(workspaceSenderRole({ id: 'test' }, runtime), 'background');
  for (const row of [
    { id: 'test', url: 'https://example.com/src/sidepanel.html', tab: { id: 1 } },
    { id: 'other', url: runtime.getURL('src/sidepanel.html') },
    { id: 'test', url: 'chrome-extension://test.evil/src/sidepanel.html' },
    { id: 'test', tab: { id: 1 } }
  ]) assert.equal(workspaceSenderRole(row, runtime), 'untrusted');
});
test('offscreen accepts only worker dispatch and rejects direct UI/content bypasses', async () => {
  let calls = 0;
  const service = { getSession: async () => ++calls };
  const message = { method: 'getSession', params: {} };
  for (const who of [sender('src/sidepanel.html'), { id: 'test', url: 'https://example.com', tab: { id: 1 } }]) {
    await assert.rejects(dispatchWorkspaceRpc(service, message, who, runtime), { code: 'RPC_DENIED' });
  }
  assert.equal(calls, 0);
  assert.equal(await dispatchWorkspaceRpc(service, message, { id: 'test' }, runtime), 1);
});
for (const failure of ['empty', 'closed', 'unavailable']) {
  test(`write ${failure} response is unknown, never automatically replayed`, async () => {
    let count = 0;
    const forward = createWorkspaceRpcTransport({ ensureRuntime: async () => {}, sleep: async () => {}, send: async () => {
      count++;
      if (failure === 'closed') throw new Error('The message port closed before a response was received.');
      if (failure === 'unavailable') throw new Error('Could not establish connection. Receiving end does not exist.');
    } });
    await assert.rejects(forward({ method: 'sendMessage', params: {} }), { code: 'RPC_OUTCOME_UNKNOWN' });
    assert.equal(count, 1);
  });
}
test('safe reads retry a closed port, an empty response, then return result', async () => {
  let count = 0;
  const forward = createWorkspaceRpcTransport({ ensureRuntime: async () => {}, sleep: async () => {}, send: async () => {
    count++;
    if (count === 1) throw new Error('The message port closed.');
    if (count === 2) return undefined;
    return { ok: true, result: { value: 1 } };
  } });
  assert.deepEqual(await forward({ method: 'getSession' }), { ok: true, result: { value: 1 } });
  assert.equal(count, 3);
});
test('structured error replies are not retried, unknown methods never boot runtime', async () => {
  let boots = 0;
  const forward = createWorkspaceRpcTransport({ ensureRuntime: async () => { boots++; }, send: async () => ({ ok: false, code: 'ARTIFACT_CONFLICT' }) });
  await assert.rejects(forward({ method: 'constructor' }), { code: 'RPC_METHOD_DENIED' });
  assert.equal(boots, 0);
  assert.equal((await forward({ method: 'updateArtifact' })).code, 'ARTIFACT_CONFLICT');
  assert.equal(boots, 1);
});

test('shared UI client marks port-lost and empty write receipts unknown without replay', async () => {
  const { workspaceRpc } = await import('../src/agent/vnext/host/workspaceClient.js');
  for (const loss of ['empty', 'throw']) {
    let count = 0;
    globalThis.chrome = { runtime: { sendMessage: async () => { count++; if (loss === 'throw') throw new Error('port closed'); } } };
    await assert.rejects(workspaceRpc('updateArtifact', {}), { code: 'RPC_OUTCOME_UNKNOWN' });
    assert.equal(count, 1);
  }
});
test('shared UI client preserves structured artifact conflicts and read unavailability', async () => {
  const { workspaceRpc } = await import('../src/agent/vnext/host/workspaceClient.js');
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, code: 'ARTIFACT_CONFLICT', actualRevision: 9 }) } };
  await assert.rejects(workspaceRpc('updateArtifact', {}), { code: 'ARTIFACT_CONFLICT', actualRevision: 9 });
  chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(workspaceRpc('readArtifact', {}), { code: 'RPC_UNAVAILABLE' });
});
test('shared UI client throws on a resolved ok:false artifact write, keeps ok:false data elsewhere', async () => {
  const { workspaceRpc } = await import('../src/agent/vnext/host/workspaceClient.js');
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: { ok: false, code: 'TICKET_REQUIRED', error: 'no ticket', operationId: 'op1' } }) } };
  await assert.rejects(workspaceRpc('updateArtifact', {}), (err) => err.code === 'TICKET_REQUIRED' && err.operationId === 'op1' && /no ticket/.test(err.message));
  globalThis.chrome.runtime.sendMessage = async () => ({ ok: true, result: { ok: false, code: 'ARTIFACT_CONFLICT', actualRevision: 4 } });
  await assert.rejects(workspaceRpc('updateArtifact', {}), { code: 'ARTIFACT_CONFLICT', actualRevision: 4 });
  globalThis.chrome.runtime.sendMessage = async () => ({ ok: true, result: { ok: false, code: 'NO_SESSION' } });
  assert.deepEqual(await workspaceRpc('abortCurrentExecution', {}), { ok: false, code: 'NO_SESSION' });
});
