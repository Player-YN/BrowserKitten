import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowHost, sanitizeWorkflowRecordingEvent, WORKFLOW_RECORDING_STORAGE_KEY } from '../src/agent/vnext/host/workflowHost.js';

function fixture(saved = null) {
  const bag = saved ? { [WORKFLOW_RECORDING_STORAGE_KEY]: structuredClone(saved) } : {};
  const messages = []; const rpc = [];
  const listeners = {};
  const chromeLike = {
    runtime: { id: 'extension-id' },
    storage: { session: {
      get: async () => structuredClone(bag),
      set: async patch => Object.assign(bag, structuredClone(patch))
    } },
    tabs: {
      query: async () => [],
      sendMessage: async (...args) => { messages.push(args); return { ok: true, controls: [] }; }
    },
    downloads: { search: async () => [] },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    _listeners: listeners
  };
  const host = createWorkflowHost({ chromeLike, rpc: async value => rpc.push(value), now: () => 1234 });
  return { host, chromeLike, bag, messages, rpc };
}

test('recording events retain only allowlisted fields and never a sensitive value', () => {
  assert.deepEqual(sanitizeWorkflowRecordingEvent({ type: 'sensitive', value: 'secret', target: { name: 'Password' }, injected: true }), { type: 'sensitive' });
  assert.deepEqual(sanitizeWorkflowRecordingEvent({ type: 'fill', sensitive: true, value: 'secret', target: { name: 'Account' } }), { type: 'sensitive' });
  assert.deepEqual(sanitizeWorkflowRecordingEvent({ type: 'click', target: { type: 'password', name: 'Reveal' } }), { type: 'sensitive' });
  assert.equal(sanitizeWorkflowRecordingEvent({ type: 'made-up', value: 'x' }), null);
});

test('worker recovery pauses persisted active recording and does not accept late events', async () => {
  const saved = { recording: { id: 'rec', status: 'recording', sequence: 4, tabAliases: { 7: 'tab1' } }, enrolled: { 7: true } };
  const { host, bag, rpc } = fixture(saved);
  await host.load();
  assert.equal(bag[WORKFLOW_RECORDING_STORAGE_KEY].recording.status, 'paused');
  const result = await host.recordMessage({ recordingId: 'rec', event: { type: 'fill', value: 'late', target: { name: 'Field' } } }, { id: 'extension-id', tab: { id: 7, url: 'https://example.test' }, frameId: 0 });
  assert.deepEqual(result, { ignored: true });
  assert.deepEqual(rpc, [{ method: 'interruptWorkflowRecording', params: { recordingId: 'rec', reason: 'WORKFLOW_RESTARTED' } }]);
});

test('only enrolled native content senders produce sequenced sanitized events', async () => {
  const { host, rpc } = fixture();
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 9, tabAliases: { 7: 'tab1' } } });
  assert.deepEqual(await host.recordMessage({ recordingId: 'rec', event: { type: 'click', target: { name: 'Save' }, junk: 'drop' } }, { id: 'wrong', tab: { id: 7 } }), { ignored: true });
  const result = await host.recordMessage({ recordingId: 'rec', event: { type: 'click', target: { name: 'Save' }, junk: 'drop' } }, { id: 'extension-id', tab: { id: 7, url: 'https://example.test/?token=nope&ok=1' }, url: 'https://example.test/?token=nope&ok=1', frameId: 2, documentId: 'doc' });
  assert.deepEqual(result, { ok: true, sequence: 10 });
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].params.event, { type: 'click', target: { name: 'Save' }, tabId: 7, frameId: 2, documentId: 'doc', url: 'https://example.test/?ok=1', frameUrl: 'https://example.test/?ok=1', at: 1234, sequence: 10 });
});

test('new tabs enroll only from an enrolled opener', async () => {
  const { host, rpc } = fixture();
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 0, tabAliases: { 7: 'tab1' } } });
  await host.tabCreated({ id: 8, openerTabId: 99, url: 'https://ignored.test/' });
  await host.tabCreated({ id: 9, openerTabId: 7, url: 'https://child.test/', title: 'Child' });
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].params.event, { type: 'newTab', tabId: 7, newTabId: 9, url: 'https://child.test/', title: 'Child', at: 1234, sequence: 1 });
});

test('reconfiguration disables tabs removed from enrollment', async () => {
  const { host, messages } = fixture();
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 0, tabAliases: { 7: 'tab1' } } });
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'paused', sequence: 0, tabAliases: { 8: 'tab2' } } });
  const disabled = messages.findLast(([id, message]) => id === 7 && message.action === 'workflow_recording_config');
  assert.equal(disabled[1].recording, null);
});

test('storage failure pauses capture without advancing the in-memory sequence', async () => {
  const { host, chromeLike } = fixture();
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 3, tabAliases: { 7: 'tab1' } } });
  chromeLike.storage.session.set = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(host.recordMessage({ recordingId: 'rec', event: { type: 'click', target: { name: 'Save' } } }, { id: 'extension-id', tab: { id: 7, url: 'https://example.test/' }, url: 'https://example.test/', frameId: 0, documentId: 'doc' }), /storage unavailable/);
  assert.deepEqual(await host.status({ id: 'extension-id', tab: { id: 7 } }), { recording: { id: 'rec', status: 'paused', sequence: 3 } });
});

test('flush addresses every frame with the frozen content message', async () => {
  const { host, chromeLike, messages } = fixture();
  chromeLike.webNavigation.getAllFrames = async () => [
    { frameId: 0, documentId: 'main', url: 'https://example.test/' },
    { frameId: 2, documentId: 'child', url: 'https://frame.test/' }
  ];
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 0, tabAliases: { 7: 'tab1' } } });
  await host.handle('recording.flush', { recordingId: 'rec' });
  const flushes = messages.filter(([, message]) => message.action === 'workflow_record_flush');
  assert.deepEqual(flushes.map(([, , options]) => options), [
    { frameId: 0, documentId: 'main' },
    { frameId: 2, documentId: 'child' }
  ]);
});

test('legacy enrollment cache cannot expand the authoritative aliases after worker restart', async () => {
  const saved = { recording: { id: 'rec', status: 'paused', sequence: 4, tabAliases: { 7: 'tab1' } }, enrolled: { 7: true, 99: true } };
  const { host, bag } = fixture(saved);
  await host.load();
  assert.deepEqual(await host.status({ id: 'extension-id', tab: { id: 99 } }), { recording: null });
  assert.equal((await host.status({ id: 'extension-id', tab: { id: 7 } })).recording.id, 'rec');
  await host.handle('recording.configure', { recording: saved.recording });
  assert.equal(Object.hasOwn(bag[WORKFLOW_RECORDING_STORAGE_KEY], 'enrolled'), false);
});

test('opener enrollment and flush derive their targets solely from aliases', async () => {
  const { host, bag, messages } = fixture();
  await host.handle('recording.configure', { recording: { id: 'rec', status: 'recording', sequence: 0, tabAliases: { 7: 'tab1' } } });
  await host.tabCreated({ id: 8, openerTabId: 7, url: 'https://child.test/' });
  assert.equal((await host.status({ id: 'extension-id', tab: { id: 8 } })).recording.status, 'recording');
  await host.handle('recording.flush', { recordingId: 'rec' });
  assert.deepEqual(messages.filter(([, msg]) => msg.action === 'workflow_record_flush').map(([id]) => id), [7, 8]);
  assert.equal(Object.hasOwn(bag[WORKFLOW_RECORDING_STORAGE_KEY], 'enrolled'), false);
});
