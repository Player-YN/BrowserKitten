import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createMemoryPersonalLibraryAdapter, openPersonalLibraryStore } from '../src/agent/vnext/sessionWorkspace/personalLibraryStore.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { assertWorkspaceRpc } from '../src/agent/vnext/host/workspaceRpcContract.js';

async function fixture() {
  const adapter = createMemoryPersonalLibraryAdapter();
  const library = await openPersonalLibraryStore({ adapter });
  const store = new SessionWorkspaceStore();
  const calls = []; let modelCalls = 0;
  const workflowHost = async (op, params) => { calls.push({ op, params }); return op === 'tabs' ? [{ id: 7, url: 'https://example.test/', title: 'Page' }] : { ok: true }; };
  const service = new SessionWorkspaceService({ store, personalLibraryStore: library, memoryJournal: true, workflowHost, callModel: () => { modelCalls++; throw Error('MODEL MUST NOT RUN'); } });
  service._releaseTabLeases = async () => {};
  service._cleanupExecutionPolicy = async () => {};
  return { service, library, store, adapter, calls, workflowHost, modelCalls: () => modelCalls };
}
const target = { name: 'Save', role: 'button' };
const wf = steps => ({ version: 2, tabs: [{ id: 'main', title: 'Main', url: 'https://example.test/' }], steps });
async function publish(service, workflow) {
  const made = await service.createWorkflowDraft({ name: 'Automation' });
  const { draft } = await service.updateWorkflowDraft({ draftId: made.draftId, expectedRevision: made.draft.revision, patch: { workflow } });
  return service.publishLibraryDraft({ draftId: draft.draftId, expectedRevision: draft.revision });
}
async function settled(service, id) {
  await service._workflows.active.get(id)?.finished;
  return service.getWorkflowRun({ runId: id });
}

test('structured definition survives backup with pinned tool after tool deletion; runs without a model', async () => {
  const f = await fixture();
  const made = await f.service.startLibraryCreation({ kind: 'tool' });
  const draft = await f.library.updateDraft({ draftId: made.draftId, expectedRevision: made.draft.revision, patch: { name: 'Writer', code: 'return 7;' } });
  const tool = await f.service.publishLibraryDraft({ draftId: draft.draftId, expectedRevision: draft.revision });
  const entry = await publish(f.service, wf([{ id: 'call', title: 'Run pinned tool', op: 'tool', tool, check: { type: 'result', equals: 7 } }]));
  await f.library.deleteEntry({ entryId: tool.entryId });
  const bundle = await f.library.exportBundle();
  assert.ok(!JSON.stringify(bundle).includes('workflowRecords'));
  const restored = await openPersonalLibraryStore({ adapter: createMemoryPersonalLibraryAdapter() });
  await restored.importBundle(bundle);
  const saved = (await restored.list()).find(row => row.kind === 'workflow');
  assert.equal(saved.workflow.steps[0].tool.code, tool.code);
  f.service._personalLibraryRunner = async snapshot => ({ ok: true, result: snapshot.revision === tool.revision ? 7 : -1 });
  const { run } = await f.service.startWorkflowRun({ entryId: entry.entryId });
  const done = await settled(f.service, run.id);
  assert.equal(done.status, 'completed'); assert.equal(done.nextStep, 1);
  assert.equal(f.modelCalls(), 0);
  f.store.delete('sessions', done.sessionId);
  assert.ok(await f.library.get({ entryId: entry.entryId }));
});

test('failed check keeps uncertain attempt; explicit verify resumes without redispatching', async () => {
  const { service } = await fixture(); let writes = 0; let value = 'old';
  const entry = await publish(service, wf([{ id: 'click', title: 'Save', op: 'click', tab: 'main', target, timeoutMs: 100, check: { type: 'value', equals: 'saved' } }]));
  service._gatedPageAction = async payload => payload.op === 'snapshot'
    ? { ok: true, rev: 'fresh', controls: [{ ...target, value, ref: 'f0.a1' }] }
    : (writes++, { ok: true });
  const { run } = await service.startWorkflowRun({ entryId: entry.entryId });
  const blocked = await settled(service, run.id);
  assert.equal(blocked.status, 'needs_human'); assert.equal(blocked.attempt.phase, 'checking');
  value = 'saved';
  await service.resumeWorkflowRun({ runId: run.id, expectedRevision: blocked.revision, decision: 'verify' });
  const done = await settled(service, run.id);
  assert.equal(done.status, 'completed'); assert.equal(writes, 1);
});

test('restart never auto-runs: uncertain tool requires verification, confirmation or explicit retry', async () => {
  const f = await fixture();
  const entry = await publish(f.service, wf([{ id: 'one', op: 'click', title: 'Save', tab: 'main', target, check: { type: 'visible' } }]));
  const session = f.service.runtime.createSession({ title: 'Interrupted' });
  await f.library.putWorkflowRecord({ expectedRevision: 0, record: { id: 'interrupted', type: 'run', status: 'running', sessionId: session.sessionId, definition: entry, bindings: { main: 7 }, input: {}, outputs: {}, nextStep: 0, attempts: [], attempt: { id: 'op-before-crash', writes: true, phase: 'dispatching', stepId: 'one' } } });
  const restarted = new SessionWorkspaceService({ store: f.store, personalLibraryStore: f.library, memoryJournal: true, workflowHost: f.workflowHost });
  restarted._releaseTabLeases = async () => {}; restarted._cleanupExecutionPolicy = async () => {};
  let writes = 0; restarted._gatedPageAction = async () => { writes++; throw Error('Should not dispatch'); };
  const run = await restarted.getWorkflowRun({ runId: 'interrupted' });
  assert.equal(run.status, 'paused'); assert.equal(run.recovering, true); assert.equal(writes, 0);
  await restarted.resumeWorkflowRun({ runId: run.id, expectedRevision: run.revision, decision: 'complete', bindings: { main: 7 } });
  const done = await settled(restarted, run.id);
  assert.equal(done.status, 'completed'); assert.equal(writes, 0);
  assert.equal(done.attempts[0].evidence.type, 'user');
});

test('recording activates only after durable creation, redacts sensitive inputs and stops into editable draft', async () => {
  const f = await fixture();
  const made = await f.service.startWorkflowRecording({ tabId: 7, lang: 'en' });
  const config = f.calls.find(call => call.op === 'recording.configure');
  assert.equal(config.params.recording.status, 'recording');
  await f.service.ingestWorkflowRecordingEvent({ recordingId: made.recording.id, event: { type: 'sensitive', tabId: 7, frameId: 0, value: 'do-not-store' } });
  const result = await f.service.controlWorkflowRecording({ recordingId: made.recording.id, action: 'stop' });
  assert.equal(result.recording.status, 'stopped');
  assert.equal(result.draft.workflow.steps[0].op, 'manual');
  assert.ok(!JSON.stringify(result).includes('do-not-store'));
  assert.ok(f.calls.findIndex(call => call.op === 'recording.flush') < f.calls.findLastIndex(call => call.op === 'recording.configure'));
  await assert.rejects(() => f.service.controlWorkflowRecording({ recordingId: made.recording.id, action: 'resume' }), { code: 'WORKFLOW_INVALID' });
  assert.equal(f.modelCalls(), 0);
});

test('Agent edits are drafts only and partial structured drafts cannot be published', async () => {
  const f = await fixture(); const made = await f.service.createWorkflowDraft({ name: 'Draft' });
  const fs = createSessionGuestFs(f.store, { sessionId: made.sessionId });
  const manifest = JSON.parse(fs.readFile('/artifacts/library-draft.json'));
  manifest.workflow = wf([{ id: 'one', title: 'Unresolved', op: 'click', tab: 'main', unresolved: true }]);
  fs.writeFile('/artifacts/library-draft.json', JSON.stringify(manifest));
  const result = await f.service.refreshLibraryDraft({ draftId: made.draftId });
  assert.equal(result.draft.workflow.steps.length, 1);
  assert.equal((await f.library.list()).length, 0);
  await assert.rejects(() => f.service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: result.draft.revision }), { code: 'WORKFLOW_INVALID' });
});

test('workflow UI methods are not exposed to page/preview; ingestion is background only', () => {
  for (const method of ['startWorkflowRun','resumeWorkflowRun','updateWorkflowDraft','validateWorkflowTarget','startWorkflowRecording']) {
    assert.doesNotThrow(() => assertWorkspaceRpc(method, {}, 'ui'));
    for (const role of ['preview','untrusted']) assert.throws(() => assertWorkspaceRpc(method, {}, role), { code: 'RPC_DENIED' });
  }
  for (const method of ['ingestWorkflowRecordingEvent','interruptWorkflowRecording']) {
    assert.throws(() => assertWorkspaceRpc(method, {}, 'ui'), { code: 'RPC_DENIED' });
    assert.doesNotThrow(() => assertWorkspaceRpc(method, {}, 'background'));
  }
});

test('busy session, rejected approval and tab lease conflicts stop the same workflow path', async () => {
  for (const code of ['APPROVAL_DENIED', 'TAB_BUSY']) {
    const { service } = await fixture();
    const entry = await publish(service, wf([{ id: 'click', title: 'Save', op: 'click', tab: 'main', target, check: { type: 'visible' } }]));
    let mutations = 0;
    service._gatedPageAction = async p => p.op === 'snapshot' ? { ok: true, rev: 'r', controls: [{ ...target, ref: 'f0.a1' }] } : (mutations++, { ok: false, code, error: code });
    const { run } = await service.startWorkflowRun({ entryId: entry.entryId });
    await assert.rejects(() => service.sendMessage({ sessionId: run.sessionId, content: 'race' }), /busy|active|already/i);
    const done = await settled(service, run.id);
    assert.equal(done.status, 'needs_human'); assert.equal(done.error.code, code); assert.equal(done.nextStep, 0); assert.equal(mutations, 1);
  }
});

test('pausing an active workflow retains uncertainty; cancellation is terminal', async () => {
  const { service } = await fixture();
  const entry = await publish(service, wf([{ id: 'click', title: 'Save', op: 'click', tab: 'main', target, check: { type: 'visible' } }]));
  let started;
  const waiting = new Promise(resolve => started = resolve);
  service._gatedPageAction = async (p, sid, signal) => {
    if (p.op === 'snapshot') return { ok: true, rev: 'r', controls: [{ ...target, ref: 'f0.a1' }] };
    started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const { run } = await service.startWorkflowRun({ entryId: entry.entryId }); await waiting;
  const paused = await service.pauseWorkflowRun({ runId: run.id });
  assert.equal(paused.status, 'paused'); assert.equal(paused.attempt.phase, 'dispatching'); assert.equal(service._activeBySession.has(run.sessionId), false);
  const cancelled = await service.pauseWorkflowRun({ runId: run.id, cancel: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await service.pauseWorkflowRun({ runId: run.id })).status, 'cancelled');
  await assert.rejects(() => service.resumeWorkflowRun({ runId: run.id, expectedRevision: cancelled.revision }), { code: 'WORKFLOW_BUSY' });
});

test('multi-tab sequence reads detail, returns to list and passes data to a pinned file tool without a model', async () => {
  const f = await fixture(); let tabs = [{ id: 7, url: 'https://example.test/', active: true }];
  f.service._workflowHost = async op => op === 'tabs' ? structuredClone(tabs) : { ok: true };
  f.service._gatedPageAction = async p => {
    if (p.op === 'click') { tabs.push({ id: 8, url: 'https://example.test/detail', openerTabId: 7, active: true }); tabs[0].active = false; return { ok: true }; }
    return { ok: true, rev: `fresh-${p.tabId}`, page: { url: tabs.find(t => t.id === p.tabId).url }, controls: p.tabId === 7 ? [{ ...target, ref: 'f0.a1' }] : [{ id: 'detail', text: 'Order 42', ref: 'f0.a1' }] };
  };
  f.service._gatedSys = async (op, params) => { assert.equal(op, 'tabs.focus'); tabs.forEach(t => t.active = t.id === params.tabId); return { ok: true }; };
  f.service._personalLibraryRunner = async (entry, context) => { context.fs.writeFile('/artifacts/report.txt', context.input.text); return { ok: true, result: context.input.text }; };
  const tool = { entryId: 'saved-tool', revision: 1, kind: 'tool', name: 'Report', code: "fs.writeFile('/artifacts/report.txt', input.text);", runtimeVersion: 'browserbot-library-v1', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
  const definition = wf([
    { id: 'openDetail', title: 'Open detail', op: 'click', tab: 'main', target, opensTab: 'detail', check: { type: 'url', tab: 'detail', equals: 'https://example.test/detail' } },
    { id: 'readDetail', title: 'Read detail', op: 'read', tab: 'detail', target: { id: 'detail' } },
    { id: 'back', title: 'Return to list', op: 'focus', tab: 'main' },
    { id: 'report', title: 'Write report', op: 'tool', tool, args: { text: { $ref: 'steps.readDetail.text' } }, check: { type: 'file', path: '/artifacts/report.txt' } }
  ]);
  definition.tabs.push({ id: 'detail', title: 'Detail', url: 'https://example.test/detail', opener: 'main' });
  const entry = await publish(f.service, definition);
  const started = await f.service.startWorkflowRun({ entryId: entry.entryId });
  const done = await settled(f.service, started.run.id);
  assert.equal(done.status, 'completed'); assert.equal(done.nextStep, 4); assert.equal(done.bindings.detail, 8);
  assert.equal(createSessionGuestFs(f.store, { sessionId: done.sessionId }).readFile('/artifacts/report.txt'), 'Order 42');
  assert.equal(f.modelCalls(), 0); assert.equal(tabs.length, 2);
});

test('recording controls and idle cancellation publish their committed revisions', async () => {
  const { service } = await fixture(); const events = [];
  service._broadcastUiEvent = event => events.push(structuredClone(event));
  const made = await service.startWorkflowRecording({ tabId: 7 });
  assert.equal(events.findLast(e => e.type === 'workflow-recording').recording.revision, made.recording.revision);
  for (const action of ['pause', 'resume', 'stop']) {
    const result = await service.controlWorkflowRecording({ recordingId: made.recording.id, action });
    const event = events.findLast(e => e.type === 'workflow-recording');
    assert.deepEqual(event.recording, result.recording);
  }
  const entry = await publish(service, wf([{ id: 'manual', title: 'Review', op: 'manual' }]));
  const { run } = await service.startWorkflowRun({ entryId: entry.entryId });
  await settled(service, run.id);
  const cancelled = await service.pauseWorkflowRun({ runId: run.id, cancel: true });
  assert.deepEqual(events.findLast(e => e.type === 'workflow-run').run, cancelled);
});
