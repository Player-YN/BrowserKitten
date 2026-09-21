import { validateWorkflow } from '../workflow/definition.js';
import { validatePersonalLibrarySchema } from '../service/personalLibraryContract.js';

/**
 * Personal tools and workflows are deliberately outside SessionWorkspace.
 * This one-record IDB database gives draft/publish changes an atomic commit
 * without letting chat deletion, workspace GC, or snapshots reach them.
 */

export const PERSONAL_LIBRARY_DB = 'browserbot-personal-library-v1';
export const PERSONAL_LIBRARY_RUNTIME = 'browserbot-library-v1';
const STORE = 'library';
const KEY = 'state';
const SCHEMA = 2;
const BUNDLE = 'browserbot-personal-library-bundle-v1';
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;

function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

function clone(value) { return structuredClone(value); }
function now() { return Date.now(); }
function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function text(value, name, { required = false, max = 4000 } = {}) {
  if (value == null || value === '') {
    if (required) fail('LIBRARY_BAD_INPUT', `${name} is required`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('LIBRARY_BAD_INPUT', `${name} is invalid`);
  return value;
}
function optionalFields(source = {}) {
  const out = {};
  if (source.scope != null) out.scope = text(source.scope, 'scope', { max: 200 });
  if (source.allowedHosts != null) {
    if (!Array.isArray(source.allowedHosts) || source.allowedHosts.length > 80 || source.allowedHosts.some((v) => typeof v !== 'string' || v.length > 255)) {
      fail('LIBRARY_BAD_INPUT', 'allowedHosts is invalid');
    }
    out.allowedHosts = [...new Set(source.allowedHosts)];
  }
  return out;
}

function validatePayload(source = {}, { partial = false } = {}) {
  if (!plainObject(source)) fail('LIBRARY_BAD_INPUT', 'entry must be an object');
  const kind = source.kind == null && partial ? undefined : text(source.kind, 'kind', { required: true, max: 20 });
  if (kind != null && kind !== 'tool' && kind !== 'workflow') fail('LIBRARY_BAD_INPUT', 'kind must be tool or workflow');
  const out = {};
  if (kind != null) out.kind = kind;
  for (const key of ['name', 'description']) {
    if (source[key] != null || !partial) out[key] = text(source[key], key, { required: key === 'name' && !partial, max: key === 'name' ? 160 : 4000 });
  }
  if (source.parameters != null || !partial) {
    const parameters = source.parameters == null ? {} : source.parameters;
    if (!plainObject(parameters) || JSON.stringify(parameters).length > 20_000) fail('LIBRARY_BAD_INPUT', 'parameters must be a compact JSON object');
    validatePersonalLibrarySchema(parameters);
    out.parameters = clone(parameters);
  }
  if (source.runtimeVersion != null && source.runtimeVersion !== PERSONAL_LIBRARY_RUNTIME) {
    fail('LIBRARY_BAD_RUNTIME', 'unknown library runtime');
  }
  out.runtimeVersion = PERSONAL_LIBRARY_RUNTIME;
  const effectiveKind = kind || source.kind;
  if (source.code != null) out.code = text(source.code, 'code', { max: MAX_TEXT });
  if (source.instructions != null) out.instructions = text(source.instructions, 'instructions', { max: MAX_TEXT });
  if (source.workflow != null) {
    out.workflow = validateWorkflow(source.workflow, { partial, parameters: source.parameters || {} });
    for (const step of out.workflow.steps) if (step.tool) validatePersonalLibrarySchema(step.tool.parameters || {});
  }
  if (!partial) {
    if (effectiveKind === 'tool' && !out.code?.trim()) fail('LIBRARY_BAD_INPUT', 'tool code is required');
    if (effectiveKind === 'workflow' && !out.workflow && !out.instructions?.trim()) fail('LIBRARY_BAD_INPUT', 'workflow instructions are required');
    if (effectiveKind === 'tool') { delete out.instructions; delete out.workflow; }
    if (effectiveKind === 'workflow') { delete out.code; if (out.workflow) delete out.instructions; }
  }
  return { ...out, ...optionalFields(source) };
}

function rejectUnknown(object, allowed, label) {
  for (const key of Object.keys(object || {})) {
    if (!allowed.has(key)) fail('LIBRARY_BAD_SCHEMA', `unknown ${label} field: ${key}`);
  }
}

function emptyState() { return { schema: SCHEMA, entries: {}, drafts: {}, revisions: {}, workflowRecords: {} }; }
function validateState(state) {
  if (plainObject(state) && state.schema === 1) { state.schema = SCHEMA; state.workflowRecords ||= {}; }
  if (!plainObject(state) || state.schema !== SCHEMA || !plainObject(state.entries) || !plainObject(state.drafts) || !plainObject(state.revisions)) {
    fail('LIBRARY_CORRUPT', 'personal library data is invalid');
  }
  if (!plainObject(state.workflowRecords)) fail('LIBRARY_CORRUPT', 'workflow records are invalid');
  return state;
}
function makeId(factory, prefix) { return String(factory(prefix)); }
function id(value, name) {
  const out = text(value, name, { required: true, max: 180 });
  if (/^(?:__proto__|prototype|constructor)$/.test(out)) fail('LIBRARY_BAD_INPUT', `${name} is reserved`);
  return out;
}
function conflict(expected, actual) {
  fail('LIBRARY_CONFLICT', `expected revision ${expected}, current ${actual}`, { expectedRevision: expected, actualRevision: actual });
}
function expectRevision(expected, actual) {
  if (expected != null && Number(expected) !== Number(actual)) conflict(expected, actual);
}
function revisionCopy(entry) { return clone(entry); }
function sourceEntry(state, draft) {
  if (!draft.baseEntryId) return {};
  const baseEntryId = id(draft.baseEntryId, 'baseEntryId');
  const entry = state.entries[baseEntryId];
  if (!entry) fail('LIBRARY_NOT_FOUND', 'base entry was deleted');
  if (draft.baseRevision != null && entry.revision !== draft.baseRevision) conflict(draft.baseRevision, entry.revision);
  return entry;
}

/** Explicit test-only adapter; production must open IndexedDB. */
export function createMemoryPersonalLibraryAdapter(initial = null) {
  let state = initial ? clone(initial) : emptyState();
  let queue = Promise.resolve();
  return {
    async read() { return clone(state); },
    async write(next) { state = clone(next); },
    mutate(operation) {
      const run = queue.catch(() => {}).then(() => {
        const staged = clone(state);
        const result = operation(staged);
        state = staged;
        return clone(result);
      });
      queue = run.catch(() => {});
      return run;
    },
    snapshot() { return clone(state); }
  };
}

function openIdbAdapter(indexedDBRef, dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDBRef.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onblocked = () => reject(Object.assign(new Error('personal library upgrade is blocked by an older extension connection'), { code: 'LIBRARY_UNAVAILABLE' }));
    request.onerror = () => reject(Object.assign(request.error || new Error('IndexedDB open failed'), { code: 'LIBRARY_UNAVAILABLE' }));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve({
        read: () => new Promise((done, bad) => {
          const tx = db.transaction(STORE, 'readonly');
          const get = tx.objectStore(STORE).get(KEY);
          get.onsuccess = () => done(get.result ? clone(get.result) : emptyState());
          get.onerror = () => bad(get.error || new Error('IndexedDB read failed'));
        }),
        write: (next) => new Promise((done, bad) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(clone(next), KEY);
          tx.oncomplete = () => done();
          tx.onerror = () => bad(tx.error || new Error('IndexedDB write failed'));
          tx.onabort = () => bad(tx.error || new Error('IndexedDB write aborted'));
        }),
        mutate: (operation) => new Promise((done, bad) => {
          const tx = db.transaction(STORE, 'readwrite');
          const objectStore = tx.objectStore(STORE);
          const get = objectStore.get(KEY);
          let result;
          get.onsuccess = () => {
            try {
              const staged = validateState(get.result ? clone(get.result) : emptyState());
              result = operation(staged);
              objectStore.put(clone(staged), KEY);
            } catch (error) {
              try { tx.abort(); } catch { /* no partial commit */ }
              bad(error);
            }
          };
          get.onerror = () => bad(get.error || new Error('IndexedDB read failed'));
          tx.oncomplete = () => done(clone(result));
          tx.onerror = () => bad(tx.error || new Error('IndexedDB write failed'));
          tx.onabort = () => bad(tx.error || new Error('IndexedDB write aborted'));
        })
      });
    };
  });
}

export async function openPersonalLibraryStore(opts = {}) {
  const indexedDBRef = Object.hasOwn(opts, 'indexedDB') ? opts.indexedDB : globalThis.indexedDB;
  const adapter = opts.adapter || (indexedDBRef ? await openIdbAdapter(indexedDBRef, opts.dbName || PERSONAL_LIBRARY_DB) : null);
  if (!adapter) fail('LIBRARY_UNAVAILABLE', 'IndexedDB is required for the personal library');
  if (typeof adapter.read !== 'function' || typeof adapter.write !== 'function' || typeof adapter.mutate !== 'function') fail('LIBRARY_UNAVAILABLE', 'invalid personal library adapter');
  const idFactory = opts.idFactory || ((prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  let queue = Promise.resolve();
  const read = async () => validateState(await adapter.read());
  const mutate = (operation) => {
    const run = queue.catch(() => {}).then(() => adapter.mutate((state) => operation(validateState(state))));
    queue = run.catch(() => {});
    return run;
  };
  const publicEntry = (entry) => entry ? clone(entry) : null;

  return {
    async getWorkflowRecord({ id: recordId }) { return publicEntry((await read()).workflowRecords[id(recordId, 'recordId')] || null); },
    async listWorkflowRecords({ type } = {}) { return Object.values((await read()).workflowRecords).filter(row => !type || row.type === type).map(publicEntry); },
    putWorkflowRecord({ record, expectedRevision }) {
      return mutate(state => {
        const recordId = id(record?.id, 'recordId');
        const old = state.workflowRecords[recordId];
        expectRevision(expectedRevision, old?.revision || 0);
        const next = { ...clone(record), id: recordId, revision: (old?.revision || 0) + 1, updatedAt: now() };
        state.workflowRecords[recordId] = next;
        return next;
      });
    },
    async list({ kind } = {}) {
      if (kind != null && kind !== 'tool' && kind !== 'workflow') fail('LIBRARY_BAD_INPUT', 'invalid kind');
      const state = await read();
      return Object.values(state.entries).filter((entry) => !kind || entry.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt).map(publicEntry);
    },
    async get({ entryId, revision } = {}) {
      const state = await read();
      entryId = id(entryId, 'entryId');
      if (revision != null) return publicEntry((state.revisions[entryId] || []).find((row) => row.revision === Number(revision)) || null);
      return publicEntry(state.entries[entryId] || null);
    },
    async listRevisions({ entryId } = {}) {
      entryId = id(entryId, 'entryId');
      const state = await read();
      return clone(state.revisions[entryId] || []).sort((a, b) => b.revision - a.revision);
    },
    async getDraft({ draftId } = {}) {
      draftId = id(draftId, 'draftId');
      const state = await read();
      return publicEntry(state.drafts[draftId] || null);
    },
    async listDrafts({ sessionId } = {}) {
      const state = await read();
      return Object.values(state.drafts).filter((draft) => sessionId == null || draft.sessionId === String(sessionId)).sort((a, b) => b.updatedAt - a.updatedAt).map(publicEntry);
    },
    createDraft(input = {}) {
      return mutate((state) => {
        let base = {};
        if (input.baseEntryId) {
          base = sourceEntry(state, input);
        }
        const draftKind = input.kind || base.kind;
        if (draftKind !== 'tool' && draftKind !== 'workflow') fail('LIBRARY_BAD_INPUT', 'draft kind must be tool or workflow');
        if (base.kind && input.kind && input.kind !== base.kind) fail('LIBRARY_BAD_INPUT', 'entry kind cannot change');
        const patch = validatePayload(input, { partial: true });
        const draftId = id(makeId(idFactory, 'draft'), 'draftId');
        if (state.drafts[draftId]) fail('LIBRARY_CONFLICT', 'draft id already exists');
        const draft = {
          ...base, ...patch, kind: draftKind, draftId, revision: 0, createdAt: now(), updatedAt: now(),
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(input.baseEntryId ? { baseEntryId: String(input.baseEntryId), baseRevision: Number(input.baseRevision ?? base.revision) } : {})
        };
        delete draft.entryId;
        state.drafts[draftId] = draft;
        return draft;
      });
    },
    updateDraft({ draftId, patch, expectedRevision } = {}) {
      return mutate((state) => {
        draftId = id(draftId, 'draftId');
        const draft = state.drafts[draftId];
        if (!draft) fail('LIBRARY_NOT_FOUND', 'draft not found');
        expectRevision(expectedRevision, draft.revision);
        const checked = validatePayload({ ...draft, ...(patch || {}) }, { partial: true });
        if (checked.kind && checked.kind !== draft.kind) fail('LIBRARY_BAD_INPUT', 'draft kind cannot change');
        const next = { ...draft, ...checked, revision: draft.revision + 1, updatedAt: now() };
        // Save-as-rename: mirror workflow draft name onto the published entry so the
        // library list and a later Edit reopen see the typed name without orphan drafts.
        if (next.kind === 'workflow' && next.baseEntryId && checked.name != null) {
          const entryId = id(next.baseEntryId, 'entryId');
          const entry = state.entries[entryId];
          if (entry && entry.name !== next.name) {
            const updated = { ...entry, name: next.name, revision: entry.revision + 1, updatedAt: now() };
            state.entries[entryId] = updated;
            state.revisions[entryId] ||= [];
            state.revisions[entryId].push(revisionCopy(updated));
            next.baseRevision = updated.revision;
          }
        }
        state.drafts[draftId] = next;
        return next;
      });
    },
    publishDraft({ draftId, expectedRevision } = {}) {
      return mutate((state) => {
        draftId = id(draftId, 'draftId');
        const draft = state.drafts[draftId];
        if (!draft) fail('LIBRARY_NOT_FOUND', 'draft not found');
        expectRevision(expectedRevision, draft.revision);
        const base = sourceEntry(state, draft);
        const entryId = draft.baseEntryId || id(makeId(idFactory, 'lib'), 'entryId');
        const revision = (base.revision || 0) + 1;
        const payload = validatePayload({ ...base, ...draft }, { partial: false });
        if (!draft.baseEntryId && state.entries[entryId]) fail('LIBRARY_CONFLICT', 'entry id already exists');
        const entry = { ...payload, entryId, revision, createdAt: base.createdAt || now(), updatedAt: now() };
        state.entries[entryId] = entry;
        state.revisions[entryId] ||= [];
        state.revisions[entryId].push(revisionCopy(entry));
        delete state.drafts[draftId];
        return entry;
      });
    },
    deleteEntry({ entryId, expectedRevision } = {}) {
      return mutate((state) => {
        entryId = id(entryId, 'entryId');
        const entry = state.entries[entryId];
        if (!entry) fail('LIBRARY_NOT_FOUND', 'entry not found');
        expectRevision(expectedRevision, entry.revision);
        delete state.entries[entryId];
        delete state.revisions[entryId];
        return { deleted: true, entryId };
      });
    },
    revertRevision({ entryId, revision, expectedRevision } = {}) {
      return mutate((state) => {
        entryId = id(entryId, 'entryId');
        const current = state.entries[entryId];
        if (!current) fail('LIBRARY_NOT_FOUND', 'entry not found');
        expectRevision(expectedRevision, current.revision);
        const historical = (state.revisions[entryId] || []).find((row) => row.revision === Number(revision));
        if (!historical) fail('LIBRARY_NOT_FOUND', 'revision not found');
        if (historical.kind !== current.kind) fail('LIBRARY_CORRUPT', 'revision kind differs from entry kind');
        const next = { ...revisionCopy(historical), entryId, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: now() };
        state.entries[entryId] = next;
        state.revisions[entryId].push(revisionCopy(next));
        return next;
      });
    },
    async exportBundle() {
      const state = await read();
      const bundle = { format: BUNDLE, schema: SCHEMA, runtimeVersion: PERSONAL_LIBRARY_RUNTIME, entries: clone(Object.values(state.entries)), revisions: clone(state.revisions) };
      if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_BUNDLE_BYTES) fail('LIBRARY_TOO_LARGE', 'library bundle is too large to export');
      return bundle;
    },
    importBundle(bundle, { conflict: strategy = 'skip' } = {}) {
      return mutate((state) => {
        if (strategy !== 'skip' && strategy !== 'reject') fail('LIBRARY_BAD_INPUT', 'invalid import conflict strategy');
        const raw = typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
        if (new TextEncoder().encode(raw).byteLength > MAX_BUNDLE_BYTES) fail('LIBRARY_TOO_LARGE', 'library bundle is too large');
        let parsed;
        try { parsed = typeof bundle === 'string' ? JSON.parse(bundle) : clone(bundle); } catch { fail('LIBRARY_BAD_INPUT', 'invalid JSON bundle'); }
        if (!plainObject(parsed) || parsed.format !== BUNDLE || ![1, SCHEMA].includes(parsed.schema) || parsed.runtimeVersion !== PERSONAL_LIBRARY_RUNTIME || !Array.isArray(parsed.entries) || !plainObject(parsed.revisions || {})) {
          fail('LIBRARY_BAD_SCHEMA', 'unknown library bundle schema');
        }
        rejectUnknown(parsed, new Set(['format', 'schema', 'runtimeVersion', 'entries', 'revisions']), 'bundle');
        const imported = [], skipped = [];
        for (const rawEntry of parsed.entries) {
          if (!plainObject(rawEntry) || !rawEntry.entryId || !Number.isInteger(rawEntry.revision) || rawEntry.revision < 1) fail('LIBRARY_BAD_SCHEMA', 'invalid library entry');
          rejectUnknown(rawEntry, new Set(['entryId', 'revision', 'kind', 'name', 'description', 'code', 'instructions', 'parameters', 'runtimeVersion', 'scope', 'allowedHosts', 'workflow', 'createdAt', 'updatedAt']), 'entry');
          const entry = { ...validatePayload(rawEntry, { partial: false }), entryId: id(rawEntry.entryId, 'entryId'), revision: rawEntry.revision, createdAt: Number(rawEntry.createdAt) || now(), updatedAt: Number(rawEntry.updatedAt) || now() };
          if (state.entries[entry.entryId]) {
            if (strategy === 'reject') fail('LIBRARY_IMPORT_CONFLICT', `entry already exists: ${entry.entryId}`);
            skipped.push(entry.entryId); continue;
          }
          const revisions = parsed.revisions[entry.entryId];
          if (!Array.isArray(revisions) || !revisions.length) fail('LIBRARY_BAD_SCHEMA', 'missing immutable revisions');
          const seenRevisions = new Set();
          const importedRevisions = revisions.map((row) => {
            if (!plainObject(row) || !Number.isInteger(row.revision) || row.revision < 1) fail('LIBRARY_BAD_SCHEMA', 'invalid immutable revision');
            rejectUnknown(row, new Set(['entryId', 'revision', 'kind', 'name', 'description', 'code', 'instructions', 'parameters', 'runtimeVersion', 'scope', 'allowedHosts', 'workflow', 'createdAt', 'updatedAt']), 'revision');
            if (seenRevisions.has(row.revision)) fail('LIBRARY_BAD_SCHEMA', 'duplicate immutable revision');
            seenRevisions.add(row.revision);
            if (row.entryId != null && String(row.entryId) !== entry.entryId) fail('LIBRARY_BAD_SCHEMA', 'revision entry id mismatch');
            if (row.revision > entry.revision) fail('LIBRARY_BAD_SCHEMA', 'revision exceeds current entry');
            if (row.kind !== entry.kind) fail('LIBRARY_BAD_SCHEMA', 'revision kind mismatch');
            const normalized = { ...validatePayload(row, { partial: false }), entryId: entry.entryId, revision: Number(row.revision), createdAt: Number(row.createdAt) || now(), updatedAt: Number(row.updatedAt) || now() };
            return normalized;
          });
          if (!seenRevisions.has(entry.revision)) fail('LIBRARY_BAD_SCHEMA', 'current entry revision is missing');
          const currentRevision = importedRevisions.find((row) => row.revision === entry.revision);
          if (JSON.stringify(currentRevision) !== JSON.stringify(entry)) fail('LIBRARY_BAD_SCHEMA', 'current entry differs from immutable revision');
          state.entries[entry.entryId] = entry;
          state.revisions[entry.entryId] = importedRevisions;
          imported.push(entry.entryId);
        }
        return { imported, skipped };
      });
    }
  };
}
