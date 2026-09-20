/**
 * Durable call journal. Not task progress, not sessionAudit, not SW memory.
 * Write-ahead: prepared+authorized must succeed before SW dispatch.
 * Exactly-once for arbitrary web pages does not exist; never blind-replay.
 */

import { JOURNAL_DB_NAME, JOURNAL_SCHEMA } from '../../../brand.js';

export { JOURNAL_SCHEMA };
export const JOURNAL_DB = JOURNAL_DB_NAME;
export const JOURNAL_DB_VERSION = 1;
export const JOURNAL_STORE = 'operations';
export const JOURNAL_APPROVALS_STORE = 'approvals';
export const JOURNAL_SESSION_CAP = 200;
export const JOURNAL_ANOMALY_CAP = 50;

function journalUnavailable(message) {
  return Object.assign(new Error(message), { code: 'JOURNAL_UNAVAILABLE' });
}

function hasJournalStores(db) {
  const names = db?.objectStoreNames;
  return !!(names && names.contains(JOURNAL_STORE) && names.contains(JOURNAL_APPROVALS_STORE));
}

function ensureJournalSchema(db) {
  if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
    const store = db.createObjectStore(JOURNAL_STORE, { keyPath: 'operationId' });
    store.createIndex('sessionId', 'sessionId', { unique: false });
    store.createIndex('state', 'state', { unique: false });
  }
  if (!db.objectStoreNames.contains(JOURNAL_APPROVALS_STORE)) {
    const store = db.createObjectStore(JOURNAL_APPROVALS_STORE, { keyPath: 'approvalId' });
    store.createIndex('sessionId', 'sessionId', { unique: false });
  }
}

/**
 * Attach IDBRequest handlers only when `req` is a real request.
 * Undefined/closed/aborted requests must be JOURNAL_UNAVAILABLE, never TypeError.
 */
export function requestValue(req, transaction) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (message = 'journal idb request failed') => {
      if (settled) return;
      settled = true;
      reject(journalUnavailable(message));
    };

    if (!req || typeof req !== 'object') {
      fail();
      return;
    }

    try {
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail();
    } catch {
      fail();
      return;
    }

    if (!transaction) return;
    const prevAbort = transaction.onabort;
    transaction.onabort = (event) => {
      try {
        if (typeof prevAbort === 'function') prevAbort.call(transaction, event);
      } finally {
        fail('journal idb write failed');
      }
    };
  });
}

export const JOURNAL_STATES = Object.freeze([
  'prepared',
  'awaiting_approval',
  'authorized',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'verified',
  'needs_human'
]);

const ALLOWED = {
  prepared: new Set(['awaiting_approval', 'authorized', 'failed']),
  awaiting_approval: new Set(['authorized', 'failed']),
  authorized: new Set(['dispatched', 'failed']),
  dispatched: new Set(['succeeded', 'failed', 'unknown']),
  succeeded: new Set(['verified', 'needs_human']),
  failed: new Set(['verified', 'needs_human']),
  unknown: new Set(['verified', 'needs_human']),
  verified: new Set(),
  needs_human: new Set()
};

function nowTs() {
  return Date.now();
}

function clone(row) {
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function transitionError(from, to) {
  const err = new Error(`illegal journal transition ${from} → ${to}`);
  err.code = 'JOURNAL_ILLEGAL';
  return err;
}

export function assertJournalTransition(from, to) {
  if (from === to) return true;
  if (!ALLOWED[from] || !ALLOWED[from].has(to)) throw transitionError(from, to);
  return true;
}

function applyStateTimes(row, state, ts) {
  row.ts = row.ts && typeof row.ts === 'object' ? { ...row.ts } : {};
  if (state === 'prepared') row.ts.prepared = ts;
  if (state === 'awaiting_approval') row.ts.awaitingApproval = ts;
  if (state === 'authorized') row.ts.authorized = ts;
  if (state === 'dispatched') row.ts.dispatched = ts;
  if (state === 'succeeded' || state === 'failed' || state === 'unknown') row.ts.result = ts;
  if (state === 'verified' || state === 'needs_human') row.ts.verified = ts;
}

export function createMemoryCallJournal() {
  const operations = new Map();
  const approvals = new Map();
  let revision = 0;
  let failWrites = false;

  function pruneSession(sessionId) {
    const sid = String(sessionId || '');
    const rows = [...operations.values()].filter((row) => row.sessionId === sid);
    if (rows.length <= JOURNAL_SESSION_CAP) return;
    rows.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const drop = rows.length - JOURNAL_SESSION_CAP;
    for (let i = 0; i < drop; i += 1) operations.delete(rows[i].operationId);
  }

  return {
    kind: 'memory',
    _operations: operations,
    _approvals: approvals,
    failNextWrite() {
      failWrites = true;
    },
    async put(row) {
      if (failWrites) {
        failWrites = false;
        const err = new Error('journal write failed');
        err.code = 'JOURNAL_UNAVAILABLE';
        throw err;
      }
      const next = clone(row);
      next.revision = ++revision;
      next.updatedAt = nowTs();
      operations.set(next.operationId, next);
      pruneSession(next.sessionId);
      return clone(next);
    },
    async get(operationId) {
      return clone(operations.get(String(operationId || '')));
    },
    async listBySession(sessionId) {
      const sid = String(sessionId || '');
      return [...operations.values()]
        .filter((row) => row.sessionId === sid)
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        .map(clone);
    },
    async deleteSession(sessionId) {
      const sid = String(sessionId || '');
      for (const [id, row] of [...operations.entries()]) {
        if (row.sessionId === sid) operations.delete(id);
      }
      for (const [id, rec] of [...approvals.entries()]) {
        if (rec.sessionId === sid) approvals.delete(id);
      }
    },
    async putApproval(rec) {
      if (failWrites) {
        failWrites = false;
        const err = new Error('journal write failed');
        err.code = 'JOURNAL_UNAVAILABLE';
        throw err;
      }
      approvals.set(rec.approvalId, clone(rec));
      return clone(rec);
    },
    async getApproval(approvalId) {
      return clone(approvals.get(String(approvalId || '')));
    },
    async listApprovals(sessionId) {
      const sid = String(sessionId || '');
      return [...approvals.values()].filter((rec) => !sid || rec.sessionId === sid).map(clone);
    },
    async scan(predicate) {
      return [...operations.values()].filter((row) => predicate(row)).map(clone);
    }
  };
}

function openJournalDatabase(idb, version) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(JOURNAL_DB, version);
    } catch {
      reject(journalUnavailable('journal idb open failed'));
      return;
    }
    if (!req) {
      reject(journalUnavailable('journal idb open failed'));
      return;
    }
    req.onupgradeneeded = () => {
      try {
        ensureJournalSchema(req.result);
      } catch {
        reject(journalUnavailable('journal idb open failed'));
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(journalUnavailable('journal idb open failed'));
  });
}

export async function openIndexedDbCallJournal(indexedDBImpl) {
  const idb = indexedDBImpl || globalThis.indexedDB;
  if (!idb) {
    throw journalUnavailable('indexedDB unavailable');
  }

  let db = await openJournalDatabase(idb, JOURNAL_DB_VERSION);
  if (!hasJournalStores(db)) {
    const nextVersion = Math.max(Number(db.version) || JOURNAL_DB_VERSION, JOURNAL_DB_VERSION) + 1;
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = await openJournalDatabase(idb, nextVersion);
  }
  if (!hasJournalStores(db)) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw journalUnavailable('journal idb open failed');
  }

  function tx(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishOk = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishErr = (error) => {
        if (settled) return;
        settled = true;
        reject(
          error?.code === 'JOURNAL_UNAVAILABLE'
            ? error
            : journalUnavailable(error?.message || 'journal idb write failed')
        );
      };

      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch {
        finishErr(journalUnavailable('journal idb write failed'));
        return;
      }
      if (!transaction) {
        finishErr(journalUnavailable('journal idb write failed'));
        return;
      }

      let store;
      try {
        store = transaction.objectStore(storeName);
      } catch {
        finishErr(journalUnavailable('journal idb write failed'));
        return;
      }

      let pending;
      try {
        pending = fn(store);
      } catch (error) {
        finishErr(error);
        return;
      }

      const prevAbort = transaction.onabort;
      transaction.onabort = (event) => {
        try {
          if (typeof prevAbort === 'function') prevAbort.call(transaction, event);
        } finally {
          finishErr(journalUnavailable('journal idb write failed'));
        }
      };
      transaction.onerror = () => finishErr(journalUnavailable('journal idb write failed'));

      if (pending && typeof pending.then === 'function') {
        pending.then(undefined, finishErr);
        transaction.oncomplete = () => pending.then(finishOk, finishErr);
        return;
      }

      const value = requestValue(pending);
      // Handle reject in this turn so Chrome does not report uncaught TypeError / JOURNAL_UNAVAILABLE.
      value.then(undefined, finishErr);
      transaction.oncomplete = () => value.then(finishOk, finishErr);
    });
  }

  return {
    kind: 'idb',
    async put(row) {
      await tx(JOURNAL_STORE, 'readwrite', (store) => store.put(row));
      return row;
    },
    async get(operationId) {
      return tx(JOURNAL_STORE, 'readonly', (store) => store.get(String(operationId || '')));
    },
    async listBySession(sessionId) {
      return tx(JOURNAL_STORE, 'readonly', (store) => {
        const index = store.index('sessionId');
        return index.getAll(String(sessionId || ''));
      });
    },
    async deleteSession(sessionId) {
      const rows = await this.listBySession(sessionId);
      if (rows?.length) {
        await tx(JOURNAL_STORE, 'readwrite', (store) => {
          let last = null;
          for (const row of rows) last = store.delete(row.operationId);
          return last;
        });
      }
      const approvals = await this.listApprovals(sessionId);
      if (approvals?.length) {
        await tx(JOURNAL_APPROVALS_STORE, 'readwrite', (store) => {
          let last = null;
          for (const rec of approvals) last = store.delete(rec.approvalId);
          return last;
        });
      }
    },
    async putApproval(rec) {
      await tx(JOURNAL_APPROVALS_STORE, 'readwrite', (store) => store.put(rec));
      return rec;
    },
    async getApproval(approvalId) {
      return tx(JOURNAL_APPROVALS_STORE, 'readonly', (store) => store.get(String(approvalId || '')));
    },
    async listApprovals(sessionId) {
      const sid = String(sessionId || '');
      const all = await tx(JOURNAL_APPROVALS_STORE, 'readonly', (store) => store.getAll());
      return (all || []).filter((rec) => !sid || rec.sessionId === sid);
    },
    async scan(predicate) {
      const all = await tx(JOURNAL_STORE, 'readonly', (store) => store.getAll());
      return (all || []).filter((row) => predicate(row));
    }
  };
}

export function createUnavailableCallJournal() {
  const fail = async () => {
    const err = new Error('Call journal is unavailable');
    err.code = 'JOURNAL_UNAVAILABLE';
    throw err;
  };
  return {
    kind: 'unavailable',
    commit: fail,
    update: fail,
    get: async () => null,
    listBySession: async () => [],
    deleteSession: async () => {},
    putApproval: fail,
    getApproval: async () => null,
    listApprovals: async () => [],
    findDuplicate: async () => null,
    recoverOnStartup: async () => [],
    listAnomalies: async () => [],
    exportSession: fail
  };
}

export function createCallJournal(backend) {
  const store = backend || createMemoryCallJournal();

  async function commit(partial) {
    try {
      const ts = nowTs();
      const row = {
        schema: JOURNAL_SCHEMA,
        operationId: String(partial.operationId || ''),
        requestId: String(partial.requestId || ''),
        sessionId: String(partial.sessionId || ''),
        executionId: String(partial.executionId || ''),
        taskId: partial.taskId || null,
        intent: partial.intent || { channel: 'action', op: '' },
        risk: partial.risk,
        confidence: partial.confidence,
        accessMode: partial.accessMode,
        rawEscape: partial.rawEscape || 'n/a',
        reason: partial.reason || '',
        target: partial.target || {},
        payloadHash: String(partial.payloadHash || ''),
        payloadRef: partial.payloadRef,
        preconditions: Array.isArray(partial.preconditions) ? partial.preconditions : [],
        postconditions: Array.isArray(partial.postconditions) ? partial.postconditions : [],
        approvalId: partial.approvalId,
        approvalReceipt: partial.approvalReceipt,
        policySnapshot: partial.policySnapshot || null,
        state: partial.state || 'prepared',
        ts: {},
        receipt: partial.receipt,
        error: partial.error,
        outcome: partial.outcome,
        revision: 0,
        updatedAt: ts
      };
      applyStateTimes(row, row.state, ts);
      if (!row.operationId) {
        const err = new Error('operationId required');
        err.code = 'JOURNAL_UNAVAILABLE';
        throw err;
      }
      return await store.put(row);
    } catch (error) {
      if (error?.code === 'JOURNAL_UNAVAILABLE') throw error;
      throw journalUnavailable(error?.message || 'journal write failed');
    }
  }

  async function update(operationId, patch = {}) {
    const current = await store.get(operationId);
    if (!current) {
      const err = new Error('journal row missing');
      err.code = 'JOURNAL_UNAVAILABLE';
      throw err;
    }
    const nextState = patch.state || current.state;
    if (patch.state) assertJournalTransition(current.state, patch.state);
    const ts = nowTs();
    const next = {
      ...current,
      ...patch,
      state: nextState,
      ts: { ...current.ts, ...(patch.ts || {}) },
      error: patch.error !== undefined ? patch.error : current.error,
      receipt: patch.receipt !== undefined ? patch.receipt : current.receipt,
      outcome: patch.outcome !== undefined ? patch.outcome : current.outcome
    };
    applyStateTimes(next, nextState, ts);
    try {
      return await store.put(next);
    } catch (error) {
      if (error?.code === 'JOURNAL_UNAVAILABLE') throw error;
      throw journalUnavailable(error?.message || 'journal write failed');
    }
  }

  async function findDuplicate(sessionId, payloadHash, documentId) {
    if (!payloadHash) return null;
    const rows = await store.listBySession(sessionId);
    return (
      rows.find(
        (row) =>
          row.payloadHash === payloadHash &&
          String(row.target?.documentId || '') === String(documentId || '') &&
          (row.state === 'succeeded' || row.state === 'verified')
      ) || null
    );
  }

  async function recoverOnStartup({ isExecutionActive, dropTicket, listTickets } = {}) {
    const changed = [];
    const liveOf = (row) =>
      typeof isExecutionActive === 'function' ? isExecutionActive(row.sessionId, row.executionId) : false;

    const dispatched = await store.scan((row) => row.state === 'dispatched' && !row.ts?.result);
    for (const row of dispatched) {
      changed.push(await update(row.operationId, { state: 'unknown', outcome: 'unknown', error: { code: 'SYS_OUTCOME_UNKNOWN', message: 'Crash between dispatch and result.' } }));
      if (typeof dropTicket === 'function') await dropTicket(row.operationId);
    }

    const authorized = await store.scan((row) => row.state === 'authorized');
    for (const row of authorized) {
      if (liveOf(row)) continue;
      changed.push(
        await update(row.operationId, {
          state: 'failed',
          outcome: 'unknown',
          error: { code: 'SYS_OUTCOME_UNKNOWN', message: 'Crash after authorize before confirmed dispatch.' }
        })
      );
      if (typeof dropTicket === 'function') await dropTicket(row.operationId);
    }

    const pending = await store.scan((row) => row.state === 'awaiting_approval');
    for (const row of pending) {
      if (liveOf(row)) continue;
      changed.push(
        await update(row.operationId, {
          state: 'failed',
          outcome: 'denied',
          error: { code: 'APPROVAL_EXPIRED', message: 'Execution ended before approval.' }
        })
      );
      if (typeof dropTicket === 'function') await dropTicket(row.operationId);
    }

    if (typeof listTickets === 'function') {
      const leftovers = await listTickets();
      for (const ticket of leftovers || []) {
        const live = typeof isExecutionActive === 'function'
          ? isExecutionActive(ticket.sessionId, ticket.executionId)
          : false;
        if (!live && typeof dropTicket === 'function') await dropTicket(ticket.operationId);
      }
    }
    return changed;
  }

  async function listAnomalies(sessionId, limit = JOURNAL_ANOMALY_CAP) {
    const rows = await store.listBySession(sessionId);
    return rows
      .filter((row) => ['unknown', 'needs_human', 'awaiting_approval'].includes(row.state) || /PAYMENT_DENIED|APPROVAL_|POLICY_DENIED|RAW_ESCAPE/.test(row.error?.code || ''))
      .slice(-Math.max(1, Number(limit) || JOURNAL_ANOMALY_CAP));
  }

  async function exportSession(sessionId) {
    const rows = await store.listBySession(sessionId);
    return {
      schema: JOURNAL_SCHEMA,
      sessionId: String(sessionId || ''),
      exportedAt: nowTs(),
      operations: rows.map((row) => ({
        ...row,
        payload: undefined
      }))
    };
  }

  return {
    kind: store.kind || 'memory',
    backend: store,
    commit,
    update,
    get: (id) => store.get(id),
    listBySession: (sid) => store.listBySession(sid),
    deleteSession: (sid) => store.deleteSession(sid),
    putApproval: (rec) => store.putApproval(rec),
    getApproval: (id) => store.getApproval(id),
    listApprovals: (sid) => store.listApprovals(sid),
    findDuplicate,
    recoverOnStartup,
    listAnomalies,
    exportSession
  };
}

export async function openCallJournal(opts = {}) {
  if (opts.backend) return createCallJournal(opts.backend);
  if (opts.memory === true) return createCallJournal(createMemoryCallJournal());
  const backend = await openIndexedDbCallJournal(opts.indexedDB);
  if (backend.kind !== 'idb') {
    const err = new Error('product journal must be IndexedDB');
    err.code = 'JOURNAL_UNAVAILABLE';
    throw err;
  }
  return createCallJournal(backend);
}

export function slimJournalAudit(row, extra = {}) {
  if (!row) return null;
  return {
    type: extra.type || 'journal',
    operationId: row.operationId,
    state: row.state,
    risk: row.risk,
    confidence: row.confidence,
    accessMode: row.accessMode,
    rawEscape: row.rawEscape,
    code: row.error?.code || extra.code || '',
    sessionId: row.sessionId,
    executionId: row.executionId,
    ts: Date.now()
  };
}
