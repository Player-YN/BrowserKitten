import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createMemoryPersonalLibraryAdapter, openPersonalLibraryStore, PERSONAL_LIBRARY_RUNTIME } from '../src/agent/vnext/sessionWorkspace/personalLibraryStore.js';
import { assertWorkspaceRpc } from '../src/agent/vnext/host/workspaceRpcContract.js';
import { PERSONAL_LIBRARY_DRAFT_PATH } from '../src/agent/vnext/service/personalLibraryCreationInstructions.js';

function fixture(opts = {}) {
  const store = new SessionWorkspaceStore();
  const adapter = createMemoryPersonalLibraryAdapter();
  return openPersonalLibraryStore({ adapter }).then((personalLibraryStore) => ({
    store,
    service: new SessionWorkspaceService({
      store, memoryJournal: true, personalLibraryStore,
      ...(opts.personalLibraryRunner ? { personalLibraryRunner: opts.personalLibraryRunner } : {})
    }),
    personalLibraryStore
  }));
}

function toolDraft(draftId, patch = {}) {
  return {
    draftId, kind: 'tool', name: 'Echo', description: 'Returns a fixed value',
    code: 'console.log("library tool"); return 7;', parameters: { type: 'object', properties: {} },
    runtimeVersion: PERSONAL_LIBRARY_RUNTIME, ...patch
  };
}

function workflowDraft(draftId, patch = {}) {
  return {
    draftId, kind: 'workflow', name: 'Checklist', description: 'Works through a topic',
    instructions: 'Read the page and summarize the requested topic.', parameters: { type: 'object', properties: {} },
    runtimeVersion: PERSONAL_LIBRARY_RUNTIME, ...patch
  };
}

test('creation is a unique durable session; artifact draft remains invisible until UI refresh and publish', async () => {
  const { store, service } = await fixture();
  const made = await service.startLibraryCreation({ kind: 'tool' });
  assert.ok(made.sessionId);
  assert.equal(store.has('sessions', made.sessionId), true);
  const draft = await service.getPersonalLibraryDraft({ draftId: made.draftId });
  assert.equal(draft.sessionId, made.sessionId);
  assert.equal((await service.listPersonalLibrary()).length, 0);

  const fs = createSessionGuestFs(store, { sessionId: made.sessionId });
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(toolDraft(made.draftId)), { mimeType: 'application/json' });
  const refreshed = await service.refreshLibraryDraft({ draftId: made.draftId });
  assert.equal(refreshed.draft.code, 'console.log("library tool"); return 7;');
  assert.equal((await service.listPersonalLibrary()).length, 0, 'refreshing a draft never publishes it');
  await assert.rejects(
    () => service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: 0 }),
    { code: 'LIBRARY_CONFLICT' },
    'a publish must name the revision which the user reviewed'
  );
  assert.equal((await service.listPersonalLibrary()).length, 0);
  const entry = await service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision });
  assert.equal((await service.listPersonalLibrary()).length, 1);
  store.delete('sessions', made.sessionId);
  assert.equal((await service.getPersonalLibraryEntry({ entryId: entry.entryId })).code, entry.code, 'chat deletion cannot delete a formal entry');
});

test('missing or foreign artifact manifests cannot overwrite a reviewed draft', async () => {
  const { store, service } = await fixture();
  const made = await service.startLibraryCreation({ kind: 'tool' });
  await assert.rejects(() => service.refreshLibraryDraft({ draftId: made.draftId }), { code: 'LIBRARY_DRAFT_NOT_READY' });
  const fs = createSessionGuestFs(store, { sessionId: made.sessionId });
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(toolDraft(made.draftId)), { mimeType: 'application/json' });
  const reviewed = await service.refreshLibraryDraft({ draftId: made.draftId });
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(toolDraft('different-draft', { code: 'return 999;' })), { mimeType: 'application/json' });
  await assert.rejects(() => service.refreshLibraryDraft({ draftId: made.draftId }), { code: 'LIBRARY_BAD_DRAFT' });
  const afterForeign = await service.getPersonalLibraryDraft({ draftId: made.draftId });
  assert.equal(afterForeign.draft.revision, reviewed.draft.revision);
  assert.equal(afterForeign.draft.code, reviewed.draft.code);
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, '{ not json', { mimeType: 'application/json' });
  await assert.rejects(() => service.refreshLibraryDraft({ draftId: made.draftId }), { code: 'LIBRARY_BAD_DRAFT' });
  assert.equal((await service.getPersonalLibraryDraft({ draftId: made.draftId })).draft.code, reviewed.draft.code);
});

test('deleting a making session blocks its draft publish and trial run for tools and workflows', async () => {
  const { store, service } = await fixture();
  for (const kind of ['tool', 'workflow']) {
    const made = await service.startLibraryCreation({ kind });
    const fs = createSessionGuestFs(store, { sessionId: made.sessionId });
    const manifest = kind === 'tool' ? toolDraft(made.draftId) : workflowDraft(made.draftId);
    fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(manifest), { mimeType: 'application/json' });
    const refreshed = await service.refreshLibraryDraft({ draftId: made.draftId });
    store.delete('sessions', made.sessionId);
    await assert.rejects(
      () => service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision }),
      { code: 'LIBRARY_NOT_FOUND' },
      `${kind} cannot be published after its making session is deleted`
    );
    await assert.rejects(
      () => service.runLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision }),
      { code: 'LIBRARY_NOT_FOUND' },
      `${kind} cannot be run after its making session is deleted`
    );
  }
});

test('editing uses a full published base, preserves old revision, and workflow preparation has no model call', async () => {
  const { service } = await fixture();
  const first = await service.startLibraryCreation({ kind: 'tool' });
  const firstDraft = await service.getPersonalLibraryDraft({ draftId: first.draftId });
  await service._library().then((library) => library.updateDraft({ draftId: first.draftId, expectedRevision: firstDraft.draft.revision, patch: toolDraft(first.draftId) }));
  const entry = await service.publishLibraryDraft({ draftId: first.draftId, expectedRevision: 1 });
  const edit = await service.startLibraryCreation({ entryId: entry.entryId });
  const editDraft = await service.getPersonalLibraryDraft({ draftId: edit.draftId });
  assert.equal(editDraft.draft.code, entry.code);
  const library = await service._library();
  const changed = await library.updateDraft({ draftId: edit.draftId, expectedRevision: editDraft.draft.revision, patch: { description: 'new description' } });
  const revised = await service.publishLibraryDraft({ draftId: edit.draftId, expectedRevision: changed.revision });
  assert.equal((await service.getPersonalLibraryEntry({ entryId: entry.entryId, revision: 1 })).description, entry.description);
  assert.equal(revised.revision, 2);

  let modelCalls = 0;
  service.callModel = async () => { modelCalls++; throw Object.assign(new Error('no key'), { code: 'NO_API_KEY' }); };
  const workflow = await service.startLibraryCreation({ kind: 'workflow' });
  const workflowDraft = await service.getPersonalLibraryDraft({ draftId: workflow.draftId });
  await library.updateDraft({ draftId: workflow.draftId, expectedRevision: workflowDraft.draft.revision, patch: {
    kind: 'workflow', name: 'Checklist', description: 'Do steps', instructions: 'Read the page then summarize.', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] }
  } });
  const published = await service.publishLibraryDraft({ draftId: workflow.draftId, expectedRevision: 1 });
  const started = await service.startLibraryWorkflow({ entryId: published.entryId, input: { topic: 'cats' } });
  assert.ok(started.sessionId);
  assert.match(service.runtime.store.get('sessions', started.sessionId).personalLibraryInstructions, /cats/);
  assert.equal(modelCalls, 0, 'workflow start only prepares a normal future chat');
  await assert.rejects(() => service.startLibraryWorkflow({ entryId: published.entryId, input: {} }), { code: 'LIBRARY_BAD_INPUT' });
});

test('personal-library RPC methods are UI-only and preview/untrusted callers cannot publish', () => {
  for (const method of ['startLibraryCreation', 'refreshLibraryDraft', 'runLibraryDraft', 'publishLibraryDraft', 'runPersonalLibraryTool', 'startLibraryWorkflow', 'deletePersonalLibraryEntry', 'revertPersonalLibraryRevision', 'exportPersonalLibrary', 'importPersonalLibrary']) {
    assert.doesNotThrow(() => assertWorkspaceRpc(method, {}, 'ui'), method);
    assert.throws(() => assertWorkspaceRpc(method, {}, 'preview'), { code: 'RPC_DENIED' }, method);
    assert.throws(() => assertWorkspaceRpc(method, {}, 'untrusted'), { code: 'RPC_DENIED' }, method);
  }
});

test('published and draft tools use the injected runner without resolving a model; busy, abort, and failures settle truthfully', async () => {
  let runnerStarted;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  let runnerContext;
  const blockingRunner = async (entry, context) => {
    runnerContext = { entry, context };
    runnerStarted();
    await new Promise((resolve, reject) => context.controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped by user'), { code: 'SYS_ABORTED' })), { once: true }));
    return { ok: true };
  };
  const { store, service } = await fixture({ personalLibraryRunner: blockingRunner });
  let modelResolves = 0;
  service.resolveLanguageModel = async () => { modelResolves++; throw Object.assign(new Error('no API key'), { code: 'NO_API_KEY' }); };
  const made = await service.startLibraryCreation({ kind: 'tool' });
  const fs = createSessionGuestFs(store, { sessionId: made.sessionId });
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(toolDraft(made.draftId)), { mimeType: 'application/json' });
  const refreshed = await service.refreshLibraryDraft({ draftId: made.draftId });

  const draftRun = service.runLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision });
  await started;
  assert.equal((await service.listPersonalLibrary()).length, 0, 'trying a draft never publishes it');
  await assert.rejects(
    () => service.runLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision }),
    { code: 'SESSION_BUSY' }
  );
  assert.equal((await service.abortCurrentExecution({ sessionId: made.sessionId })).aborted, true);
  await assert.rejects(() => draftRun, { code: 'SYS_ABORTED' });
  assert.equal(runnerContext.entry.draftId, made.draftId);
  assert.equal(modelResolves, 0, 'deterministic tools do not use the chat model');

  const entry = await service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: refreshed.draft.revision });
  store.delete('sessions', made.sessionId);
  const succeedingRunner = async (tool, context) => ({ ok: true, result: tool.code, stdout: '', artifacts: [], input: context.input });
  service._personalLibraryRunner = succeedingRunner;
  const run = await service.runPersonalLibraryTool({ entryId: entry.entryId, sessionId: 'after-chat-delete' });
  assert.equal(run.ok, true);
  assert.equal(run.result, entry.code, 'formal tool remains executable after its making chat is deleted');

  const events = [];
  const originalBroadcast = service._broadcastUiEvent.bind(service);
  service._broadcastUiEvent = (event) => { events.push(event); return originalBroadcast(event); };
  service._personalLibraryRunner = async () => { throw new Error('runner exploded'); };
  await assert.rejects(() => service.runPersonalLibraryTool({ entryId: entry.entryId, sessionId: 'runner-failure' }), /runner exploded/);
  assert.equal(events.findLast((event) => event.type === 'execution-end')?.status, 'failed');
  assert.equal(service._activeBySession.has('runner-failure'), false, 'a failed run releases the session slot');
  assert.equal(modelResolves, 0);
});

test('a successful runner whose durable flush fails rejects and records a failed, released execution', async () => {
  const { store, service } = await fixture({
    personalLibraryRunner: async () => ({ ok: true, result: 'ran', stdout: '', artifacts: [] })
  });
  const made = await service.startLibraryCreation({ kind: 'tool' });
  const fs = createSessionGuestFs(store, { sessionId: made.sessionId });
  fs.writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(toolDraft(made.draftId)), { mimeType: 'application/json' });
  const reviewed = await service.refreshLibraryDraft({ draftId: made.draftId });
  const entry = await service.publishLibraryDraft({ draftId: made.draftId, expectedRevision: reviewed.draft.revision });
  const events = [];
  const broadcast = service._broadcastUiEvent.bind(service);
  service._broadcastUiEvent = (event) => { events.push(event); return broadcast(event); };
  store.flush = async () => { throw Object.assign(new Error('durable flush failed'), { code: 'STORE_WRITE_FAILED' }); };
  await assert.rejects(
    () => service.runPersonalLibraryTool({ entryId: entry.entryId, sessionId: 'flush-failure' }),
    { code: 'STORE_WRITE_FAILED' }
  );
  assert.equal(events.findLast((event) => event.type === 'execution-end')?.status, 'failed');
  assert.equal(service._activeBySession.has('flush-failure'), false);
});
