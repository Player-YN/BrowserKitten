import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionWorkspaceRuntime } from '../src/agent/vnext/sessionWorkspace/index.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { runPersonalLibraryTool } from '../src/agent/vnext/service/personalLibraryRunner.js';
import { validatePersonalLibraryInput, validatePersonalLibrarySchema } from '../src/agent/vnext/service/personalLibraryContract.js';

function fixture() {
  const store = new SessionWorkspaceStore();
  const runtime = createSessionWorkspaceRuntime(store);
  const { sessionId } = runtime.createSession({ title: 'Run' });
  const execution = runtime.beginExecution(sessionId);
  return { store, sessionId, fs: createSessionGuestFs(store, { sessionId, executionId: execution.executionId }) };
}

test('a saved script runs in real QuickJS with data parameters, isolated globals and registered output', async () => {
  const opts = fixture();
  const input = { value: '\"); throw new Error("injected"); // 中文' };
  const entry = { kind: 'tool', parameters: { properties: { value: { type: 'string' } }, required: ['value'] }, code: `
    await fs.writeFile('/artifacts/output.txt', input.value);
    console.log(input.value);
    let blocked = 0;
    try { void chrome; } catch { blocked++; }
    try { void document; } catch { blocked++; }
    return {value:input.value, frozen:Object.isFrozen(input), blocked};
  ` };
  const result = await runPersonalLibraryTool(entry, { ...opts, input });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, { value: input.value, frozen: true, blocked: 2 });
  assert.equal(opts.fs.readFile('/artifacts/output.txt'), input.value);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].path, '/artifacts/output.txt');
  const second = await runPersonalLibraryTool(entry, { ...opts, input });
  assert.equal(second.ok, true);
  assert.equal(opts.store.keys('artifacts').length, 1, 'rerunning does not duplicate the same output artifact');
});

test('a script uses the host ABI and preserves policy errors without gaining extension globals', async () => {
  const calls = [];
  const result = await runPersonalLibraryTool({ kind: 'tool', parameters: {}, code: `return await sys.eval({world:'USER', code:'return document.title'});` }, {
    ...fixture(), activeTab: { tabId: 12 }, hostSys: async (op, params) => {
      calls.push({ op, params });
      return { ok: false, code: 'POLICY_DENIED', error: 'Guarded denies raw eval' };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'eval');
  assert.equal(calls[0].params.tabId ?? calls[0].params.defaultTabId, 12);
  assert.equal(result.ok, false);
  assert.match(result.error, /Guarded denies raw eval|POLICY_DENIED/);
});

test('script cancellation and malformed output stay visible as failed runs', async () => {
  const controller = new AbortController();
  const pending = runPersonalLibraryTool({ kind: 'tool', parameters: {}, code: 'await sleep(10000); return 42;' }, { ...fixture(), controller });
  setTimeout(() => controller.abort(), 60);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  const malformed = await runPersonalLibraryTool({ kind: 'tool', parameters: {}, code: `await fs.writeFile('/artifacts/fake.png','not a PNG');` }, fixture());
  assert.equal(malformed.ok, false);
  assert.ok(malformed.registrationErrors.length);
});

test('supported parameter schemas reject unsupported constraints, bad defaults and wrong input types', () => {
  for (const schema of [{ properties: { x: { type: 'object' } } }, { oneOf: [] }, { properties: { x: { type: 'boolean', default: 'yes' } } }, { required: ['missing'] }]) {
    assert.throws(() => validatePersonalLibrarySchema(schema), { code: 'LIBRARY_BAD_SCHEMA' });
  }
  assert.throws(() => validatePersonalLibraryInput({}, []), { code: 'LIBRARY_BAD_INPUT' });
  assert.throws(() => validatePersonalLibraryInput({ properties: { n: { type: 'integer' } } }, { n: 1.2 }), { code: 'LIBRARY_BAD_INPUT' });
  assert.deepEqual(validatePersonalLibraryInput({ properties: { enabled: { type: 'boolean', default: true } } }), { enabled: true });
});

test('a reopened library executes the saved code through the real service with no model key or maker files', async () => {
  const { SessionWorkspaceService } = await import('../src/agent/vnext/service/sessionWorkspaceService.js');
  const { openPersonalLibraryStore, createMemoryPersonalLibraryAdapter } = await import('../src/agent/vnext/sessionWorkspace/personalLibraryStore.js');
  const adapter = createMemoryPersonalLibraryAdapter();
  const library = await openPersonalLibraryStore({ adapter });
  const draft = await library.createDraft({ kind: 'tool', name: 'Saved echo', code: 'return input.value + 1;', parameters: { properties: { value: { type: 'integer' } }, required: ['value'] } });
  const entry = await library.publishDraft({ draftId: draft.draftId, expectedRevision: draft.revision });
  const reopened = await openPersonalLibraryStore({ adapter });
  const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), personalLibraryStore: reopened, memoryJournal: true });
  let modelCalls = 0;
  service.resolveLanguageModel = async () => { modelCalls++; throw new Error('NO_API_KEY'); };
  const result = await service.runPersonalLibraryTool({ entryId: entry.entryId, sessionId: 'fresh', input: { value: 41 } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result, 42);
  assert.equal(modelCalls, 0);
});

test('workflow guidance survives subsequent normal model turns and is a snapshot of the selected version', async () => {
  const { SessionWorkspaceService } = await import('../src/agent/vnext/service/sessionWorkspaceService.js');
  const { openPersonalLibraryStore, createMemoryPersonalLibraryAdapter } = await import('../src/agent/vnext/sessionWorkspace/personalLibraryStore.js');
  const library = await openPersonalLibraryStore({ adapter: createMemoryPersonalLibraryAdapter() });
  const draft = await library.createDraft({ kind: 'workflow', name: 'Review', instructions: 'Use the purple review checklist.', parameters: { properties: { topic: { type: 'string' } } } });
  const entry = await library.publishDraft({ draftId: draft.draftId, expectedRevision: draft.revision });
  const seen = [];
  const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), personalLibraryStore: library, memoryJournal: true,
    callModel: async request => { seen.push(JSON.stringify(request)); return { text: 'done' }; }
  });
  const started = await service.startLibraryWorkflow({ entryId: entry.entryId, input: { topic: 'cats' } });
  const edit = await library.createDraft({ baseEntryId: entry.entryId, instructions: 'A completely different checklist.' });
  await library.publishDraft({ draftId: edit.draftId, expectedRevision: edit.revision });
  await service.sendMessage({ sessionId: started.sessionId, content: started.content });
  await service.sendMessage({ sessionId: started.sessionId, content: 'Continue with the same steps.' });
  assert.equal(seen.length, 2);
  for (const prompt of seen) {
    assert.match(prompt, /purple review checklist/);
    assert.match(prompt, /cats/);
    assert.doesNotMatch(prompt, /completely different checklist/);
  }
});
