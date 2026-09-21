import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAL_LIBRARY_RUNTIME,
  createMemoryPersonalLibraryAdapter,
  openPersonalLibraryStore
} from '../src/agent/vnext/sessionWorkspace/personalLibraryStore.js';

const tool = (extra = {}) => ({
  kind: 'tool', name: 'Trim text', description: 'Trims a string', code: 'return input.trim()',
  parameters: { type: 'object', properties: { input: { type: 'string' } } },
  runtimeVersion: PERSONAL_LIBRARY_RUNTIME,
  ...extra
});

test('drafts stay unpublished until an explicit publish and revisions can revert', async () => {
  const adapter = createMemoryPersonalLibraryAdapter();
  const library = await openPersonalLibraryStore({ adapter, idFactory: (prefix) => `${prefix}-1` });
  const draft = await library.createDraft({ kind: 'tool', sessionId: 'making-1' });
  assert.equal((await library.list()).length, 0);
  assert.equal((await library.listDrafts({ sessionId: 'making-1' })).length, 1);
  const ready = await library.updateDraft({ draftId: draft.draftId, expectedRevision: 0, patch: tool() });
  const first = await library.publishDraft({ draftId: ready.draftId, expectedRevision: ready.revision });
  assert.equal(first.revision, 1);
  const edit = await library.createDraft({ baseEntryId: first.entryId, baseRevision: first.revision, sessionId: 'making-2' });
  const changed = await library.updateDraft({ draftId: edit.draftId, expectedRevision: 0, patch: { code: 'return input.trim().toLowerCase()' } });
  const second = await library.publishDraft({ draftId: changed.draftId, expectedRevision: changed.revision });
  assert.equal(second.revision, 2);
  assert.equal((await library.listRevisions({ entryId: first.entryId })).length, 2);
  const reverted = await library.revertRevision({ entryId: first.entryId, revision: 1, expectedRevision: 2 });
  assert.equal(reverted.revision, 3);
  assert.equal(reverted.code, first.code);
});

test('atomic expectedRevision protects two store instances and failed commits retain old data', async () => {
  const adapter = createMemoryPersonalLibraryAdapter();
  const one = await openPersonalLibraryStore({ adapter, idFactory: (prefix) => `${prefix}-one` });
  const two = await openPersonalLibraryStore({ adapter, idFactory: (prefix) => `${prefix}-two` });
  const draft = await one.createDraft(tool());
  const entry = await one.publishDraft({ draftId: draft.draftId, expectedRevision: 0 });
  const [a, b] = await Promise.allSettled([
    one.revertRevision({ entryId: entry.entryId, revision: 1, expectedRevision: 1 }),
    two.revertRevision({ entryId: entry.entryId, revision: 1, expectedRevision: 1 })
  ]);
  assert.equal([a, b].filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal([a, b].find((result) => result.status === 'rejected').reason.code, 'LIBRARY_CONFLICT');
  await assert.rejects(
    () => one.createDraft({ kind: 'workflow', name: 'bad', instructions: '  ' }).then((d) => one.publishDraft({ draftId: d.draftId, expectedRevision: d.revision })),
    { code: 'LIBRARY_BAD_INPUT' }
  );
  assert.equal((await two.get({ entryId: entry.entryId })).revision, 2);
});

test('a storage commit failure keeps the published entry and its draft unchanged', async () => {
  let state = null;
  let failCommit = false;
  const adapter = {
    async read() { return structuredClone(state || { schema: 1, entries: {}, drafts: {}, revisions: {} }); },
    async write() {},
    async mutate(operation) {
      const staged = structuredClone(state || { schema: 1, entries: {}, drafts: {}, revisions: {} });
      const result = operation(staged);
      if (failCommit) throw Object.assign(new Error('disk full'), { code: 'LIBRARY_UNAVAILABLE' });
      state = staged;
      return structuredClone(result);
    }
  };
  const library = await openPersonalLibraryStore({ adapter, idFactory: (prefix) => `${prefix}-failure` });
  const seed = await library.createDraft(tool());
  const entry = await library.publishDraft({ draftId: seed.draftId, expectedRevision: 0 });
  const edit = await library.createDraft({ baseEntryId: entry.entryId, baseRevision: 1 });
  const ready = await library.updateDraft({ draftId: edit.draftId, expectedRevision: 0, patch: { description: 'unsaved' } });
  failCommit = true;
  await assert.rejects(() => library.publishDraft({ draftId: ready.draftId, expectedRevision: 1 }), /disk full/);
  failCommit = false;
  assert.equal((await library.get({ entryId: entry.entryId })).revision, 1);
  assert.equal((await library.getDraft({ draftId: ready.draftId })).description, 'unsaved');
  assert.equal((await library.listRevisions({ entryId: entry.entryId })).length, 1);
});

test('a reopened store recovers drafts, entries, and immutable revisions; stale parallel draft cannot publish', async () => {
  const adapter = createMemoryPersonalLibraryAdapter();
  let serial = 0;
  const one = await openPersonalLibraryStore({ adapter, idFactory: (prefix) => `${prefix}-reopen-${++serial}` });
  const seed = await one.createDraft(tool());
  const entry = await one.publishDraft({ draftId: seed.draftId, expectedRevision: 0 });
  const firstDraft = await one.createDraft({ baseEntryId: entry.entryId, baseRevision: 1 });
  const secondDraft = await one.createDraft({ baseEntryId: entry.entryId, baseRevision: 1 });
  const firstReady = await one.updateDraft({ draftId: firstDraft.draftId, expectedRevision: 0, patch: { description: 'first editor' } });
  const secondReady = await one.updateDraft({ draftId: secondDraft.draftId, expectedRevision: 0, patch: { description: 'second editor' } });
  await one.publishDraft({ draftId: firstReady.draftId, expectedRevision: 1 });
  await assert.rejects(() => one.publishDraft({ draftId: secondReady.draftId, expectedRevision: 1 }), { code: 'LIBRARY_CONFLICT' });
  const reopened = await openPersonalLibraryStore({ adapter });
  assert.equal((await reopened.get({ entryId: entry.entryId })).description, 'first editor');
  assert.equal((await reopened.getDraft({ draftId: secondReady.draftId })).description, 'second editor');
  assert.equal((await reopened.listRevisions({ entryId: entry.entryId })).length, 2);
});

test('export/import round trips immutable revisions and never overwrites an existing entry', async () => {
  const sourceAdapter = createMemoryPersonalLibraryAdapter();
  const source = await openPersonalLibraryStore({ adapter: sourceAdapter, idFactory: (prefix) => `${prefix}-source` });
  const draft = await source.createDraft(tool());
  const entry = await source.publishDraft({ draftId: draft.draftId, expectedRevision: 0 });
  const edit = await source.createDraft({ baseEntryId: entry.entryId, baseRevision: 1 });
  const edited = await source.updateDraft({ draftId: edit.draftId, expectedRevision: 0, patch: { description: 'Second revision' } });
  await source.publishDraft({ draftId: edited.draftId, expectedRevision: 1 });
  const bundle = await source.exportBundle();
  const destination = await openPersonalLibraryStore({ adapter: createMemoryPersonalLibraryAdapter() });
  assert.deepEqual(await destination.importBundle(bundle), { imported: [entry.entryId], skipped: [] });
  assert.equal((await destination.get({ entryId: entry.entryId })).revision, 2);
  assert.equal((await destination.listRevisions({ entryId: entry.entryId })).length, 2);
  assert.deepEqual(await destination.importBundle(bundle), { imported: [], skipped: [entry.entryId] });
  const malformed = structuredClone(bundle);
  malformed.entries[0].unknownFutureField = true;
  await assert.rejects(() => destination.importBundle(malformed), { code: 'LIBRARY_BAD_SCHEMA' });
  assert.equal((await destination.get({ entryId: entry.entryId })).revision, 2, 'rejected import leaves data intact');
});

test('import validates the entire bundle before any valid earlier entry is committed', async () => {
  let serial = 0;
  const source = await openPersonalLibraryStore({ adapter: createMemoryPersonalLibraryAdapter(), idFactory: (prefix) => `${prefix}-atomic-import-${++serial}` });
  const firstDraft = await source.createDraft(tool({ name: 'One' }));
  const first = await source.publishDraft({ draftId: firstDraft.draftId, expectedRevision: 0 });
  const secondDraft = await source.createDraft(tool({ name: 'Two' }));
  await source.publishDraft({ draftId: secondDraft.draftId, expectedRevision: 0 });
  const broken = await source.exportBundle();
  broken.revisions[broken.entries[1].entryId][0].runtimeVersion = 'future-runtime';
  const destination = await openPersonalLibraryStore({ adapter: createMemoryPersonalLibraryAdapter() });
  await assert.rejects(() => destination.importBundle(broken), { code: 'LIBRARY_BAD_RUNTIME' });
  assert.equal((await destination.list()).length, 0, 'first valid entry was not partially imported');
  const unknownSchema = structuredClone(broken);
  unknownSchema.schema = 99;
  await assert.rejects(() => destination.importBundle(unknownSchema), { code: 'LIBRARY_BAD_SCHEMA' });
  assert.equal((await destination.list()).length, 0, 'unknown schema preserves the original library');
  assert.ok(first.entryId);
});

test('production refuses a silent memory fallback', async () => {
  await assert.rejects(() => openPersonalLibraryStore({ indexedDB: null }), { code: 'LIBRARY_UNAVAILABLE' });
});

test('invalid parameter schemas and generated entry-id collisions cannot replace a formal tool', async () => {
  let draftNumber = 0;
  const library = await openPersonalLibraryStore({
    adapter: createMemoryPersonalLibraryAdapter(),
    idFactory: (prefix) => prefix === 'lib' ? 'same-entry' : `draft-${++draftNumber}`
  });
  await assert.rejects(
    () => library.createDraft(tool({ parameters: { type: 'array' } })),
    { code: 'LIBRARY_BAD_SCHEMA' }
  );
  const firstDraft = await library.createDraft(tool({ name: 'First' }));
  const first = await library.publishDraft({ draftId: firstDraft.draftId, expectedRevision: 0 });
  const secondDraft = await library.createDraft(tool({ name: 'Second' }));
  await assert.rejects(
    () => library.publishDraft({ draftId: secondDraft.draftId, expectedRevision: 0 }),
    { code: 'LIBRARY_CONFLICT' }
  );
  assert.equal((await library.get({ entryId: first.entryId })).name, 'First');
  assert.equal((await library.getDraft({ draftId: secondDraft.draftId })).name, 'Second');
});
