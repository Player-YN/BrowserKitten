import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCallJournal,
  createMemoryCallJournal,
  assertJournalTransition,
  JOURNAL_SESSION_CAP,
  JOURNAL_STORE,
  JOURNAL_APPROVALS_STORE,
  requestValue,
  openIndexedDbCallJournal
} from '../src/agent/vnext/host/callJournal.js';
import { gatedDispatch } from '../src/agent/vnext/host/operationGate.js';
import { installTestPolicy, resetTestPolicy } from './helpers/policyTestKit.mjs';

function createNameList(initial = []) {
  const names = [...initial];
  return {
    contains(name) {
      return names.includes(name);
    },
    add(name) {
      if (!names.includes(name)) names.push(name);
    }
  };
}

function createFakeIndexedDB(options = {}) {
  let existingVersion = options.existingVersion ?? 0;
  const persistNames = createNameList(options.storeNames ?? []);
  const tables = {
    [JOURNAL_STORE]: new Map(),
    [JOURNAL_APPROVALS_STORE]: new Map()
  };

  function createRequest(result) {
    if (options.undefinedRequests) return undefined;
    const req = { result, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (options.abortTransactions) return;
      req.onsuccess?.();
    });
    return req;
  }

  function makeStore(storeName) {
    const table = tables[storeName] || new Map();
    const keyPath = storeName === JOURNAL_APPROVALS_STORE ? 'approvalId' : 'operationId';
    return {
      put(row) {
        table.set(row[keyPath], row);
        return createRequest(row[keyPath]);
      },
      get(key) {
        return createRequest(table.get(key));
      },
      getAll() {
        return createRequest([...table.values()]);
      },
      delete(key) {
        table.delete(key);
        return createRequest(undefined);
      },
      index() {
        return {
          getAll(sessionId) {
            return createRequest([...table.values()].filter((row) => row.sessionId === sessionId));
          }
        };
      },
      createIndex() {}
    };
  }

  return {
    open(_name, version = 1) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        const names = persistNames;
        const db = {
          version,
          objectStoreNames: names,
          createObjectStore(storeName) {
            if (options.refuseSchema) throw new Error('cannot create store');
            names.add(storeName);
            return makeStore(storeName);
          },
          close() {},
          transaction(storeName) {
            if (options.transactionThrows || !names.contains(storeName)) {
              throw new Error('NotFoundError');
            }
            const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: () => makeStore(storeName) };
            queueMicrotask(() => {
              if (options.abortTransactions) tx.onabort?.();
              else tx.oncomplete?.();
            });
            return tx;
          }
        };
        req.result = db;
        if (version > existingVersion) {
          existingVersion = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return options.undefinedOpen ? undefined : req;
    }
  };
}

test('illegal transitions throw; session delete GCs rows', async () => {
  assert.throws(() => assertJournalTransition('verified', 'dispatched'), { code: 'JOURNAL_ILLEGAL' });
  assert.throws(() => assertJournalTransition('needs_human', 'authorized'), { code: 'JOURNAL_ILLEGAL' });
  const journal = createCallJournal(createMemoryCallJournal());
  await journal.commit({ operationId: 'a', sessionId: 's', state: 'prepared' });
  await journal.deleteSession('s');
  assert.equal(await journal.get('a'), null);
});

test('write-ahead failure never calls send; crash after dispatched becomes unknown and is not replayed', async () => {
  installTestPolicy();
  const backend = createMemoryCallJournal();
  const journal = createCallJournal(backend);
  backend.failNextWrite();
  let sent = 0;
  const failed = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e' },
    { journal, readPolicy: async () => ({ mode: 'guarded' }), send: async () => { sent += 1; return { ok: true }; } }
  );
  assert.equal(failed.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(sent, 0);

  const row = await journal.commit({
    operationId: 'crash-1',
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'same',
    target: { documentId: 'doc' },
    state: 'prepared'
  });
  await journal.update(row.operationId, { state: 'authorized' });
  await journal.update(row.operationId, { state: 'dispatched' });
  const recovered = await journal.recoverOnStartup({ isExecutionActive: () => false, dropTicket: async () => {} });
  assert.equal(recovered[0].state, 'unknown');
  const after = await journal.get('crash-1');
  assert.equal(after.state, 'unknown');

  await journal.update('crash-1', { state: 'needs_human' });
  const verified = await journal.commit({
    operationId: 'done-1',
    sessionId: 's',
    payloadHash: 'dup',
    target: { documentId: 'doc' },
    state: 'prepared'
  });
  await journal.update(verified.operationId, { state: 'authorized' });
  await journal.update(verified.operationId, { state: 'dispatched' });
  await journal.update(verified.operationId, { state: 'succeeded' });
  await journal.update(verified.operationId, { state: 'verified' });
  assert.equal((await journal.findDuplicate('s', 'dup', 'doc')).operationId, verified.operationId);
  resetTestPolicy();
});

test('session cap drops oldest rows; anomalies list unknown and needs_human', async () => {
  const journal = createCallJournal(createMemoryCallJournal());
  for (let i = 0; i < JOURNAL_SESSION_CAP + 3; i += 1) {
    await journal.commit({ operationId: `n${i}`, sessionId: 'cap', state: 'prepared' });
  }
  const rows = await journal.listBySession('cap');
  assert.equal(rows.length, JOURNAL_SESSION_CAP);
  assert.equal(rows.some((row) => row.operationId === 'n0'), false);
  await journal.update(rows.at(-1).operationId, { state: 'authorized' });
  await journal.update(rows.at(-1).operationId, { state: 'dispatched' });
  await journal.update(rows.at(-1).operationId, { state: 'unknown', outcome: 'unknown' });
  const anomalies = await journal.listAnomalies('cap');
  assert.ok(anomalies.some((row) => row.state === 'unknown'));
});

test('undefined IDB request is JOURNAL_UNAVAILABLE; abort does not hang; external write does not dispatch', async () => {
  await assert.rejects(() => requestValue(undefined), { code: 'JOURNAL_UNAVAILABLE' });
  await assert.rejects(() => requestValue(null), { code: 'JOURNAL_UNAVAILABLE' });

  const tx = { onabort: null };
  const hung = { result: undefined, onsuccess: null, onerror: null };
  const pending = requestValue(hung, tx);
  tx.onabort();
  await assert.rejects(() => pending, { code: 'JOURNAL_UNAVAILABLE' });

  installTestPolicy();
  const backend = await openIndexedDbCallJournal(createFakeIndexedDB({ undefinedRequests: true }));
  const journal = createCallJournal(backend);
  let sent = 0;
  const out = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e', tabId: 1, documentId: 'd' },
    {
      journal,
      readPolicy: async () => ({ mode: 'guarded' }),
      send: async () => {
        sent += 1;
        return { ok: true };
      }
    }
  );
  assert.equal(out.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(sent, 0);
  resetTestPolicy();
});

test('IDB journal deleteSession returns a real request; aborting tx is JOURNAL_UNAVAILABLE', async () => {
  const journal = createCallJournal(await openIndexedDbCallJournal(createFakeIndexedDB()));
  await journal.commit({ operationId: 'a', sessionId: 's', state: 'prepared' });
  await journal.putApproval({ approvalId: 'ap1', sessionId: 's' });
  await journal.deleteSession('s');
  assert.equal(await journal.get('a'), undefined);
  assert.equal(await journal.getApproval('ap1'), undefined);

  const aborted = await openIndexedDbCallJournal(createFakeIndexedDB({ abortTransactions: true }));
  await assert.rejects(() => aborted.get('missing'), { code: 'JOURNAL_UNAVAILABLE' });
});

test('stale journal DB without stores upgrades; missing store after open is fail-closed', async () => {
  const upgraded = await openIndexedDbCallJournal(
    createFakeIndexedDB({ existingVersion: 1, storeNames: [] })
  );
  assert.equal(upgraded.kind, 'idb');
  const journal = createCallJournal(upgraded);
  const row = await journal.commit({ operationId: 'o1', sessionId: 's', state: 'prepared' });
  assert.equal(row.operationId, 'o1');
  assert.equal((await journal.get('o1')).operationId, 'o1');

  await assert.rejects(
    () => openIndexedDbCallJournal(createFakeIndexedDB({ existingVersion: 1, storeNames: [], refuseSchema: true })),
    { code: 'JOURNAL_UNAVAILABLE' }
  );
  await assert.rejects(() => openIndexedDbCallJournal({ open: () => undefined }), { code: 'JOURNAL_UNAVAILABLE' });
});
