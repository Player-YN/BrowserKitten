/**
 * Live-page tab leases. Pure registry for tests; serialized storage.session adapter
 * for the SW. Survives worker suspension, NOT browser restart. Not a call journal.
 */

/** @type {Map<number, { sessionId: string, executionId: string, acquiredAt: number, kinds: string[] }>} */
const tabLeases = new Map();

export function resetTabLeases() {
  tabLeases.clear();
  revokedOwners.clear();
  leaseStorage = null;
  hydrated = false;
  leaseQueue = Promise.resolve();
}

export function explicitPageActionTabId(request = {}) {
  const tabId = Number(request?.tabId ?? request?.defaultTabId);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : 0;
}

export function peekTabLease(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return tabLeases.get(id) || null;
}

export function foreignTabLease(lease, sessionId) {
  const holder = String(lease?.sessionId || '');
  const sid = String(sessionId || '');
  return !!(lease && holder && holder !== sid);
}

function leaseRecord(sessionId, executionId, kind, acquiredAt = Date.now()) {
  return {
    sessionId: String(sessionId || ''),
    executionId: String(executionId || ''),
    acquiredAt,
    kinds: kind ? [String(kind)] : []
  };
}

function touchKind(lease, kind) {
  const name = kind ? String(kind) : '';
  if (name && !lease.kinds.includes(name)) lease.kinds.push(name);
  return lease;
}

export function tryAcquireTabLease(tabId, sessionId, executionId, kind) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      code: 'NEED_EXPLICIT_TAB',
      error: 'tabId required'
    };
  }
  const sid = String(sessionId || '');
  const eid = String(executionId || '');
  const existing = tabLeases.get(id);
  if (existing) {
    if (existing.sessionId === sid && existing.executionId === eid) {
      return { ok: true, reentrant: true, tabId: id, lease: touchKind(existing, kind) };
    }
    return {
      ok: false,
      code: 'TAB_LEASED',
      error: `Tab ${id} is leased by session ${existing.sessionId || '(unknown)'}`,
      holderSessionId: existing.sessionId,
      tabId: id
    };
  }
  const lease = leaseRecord(sid, eid, kind);
  tabLeases.set(id, lease);
  return { ok: true, tabId: id, lease };
}

export function grantTabLease(tabId, sessionId, executionId, kind = 'tabs.open') {
  // A newly opened tab is still acquired, never allowed to overwrite an owner.
  return tryAcquireTabLease(tabId, sessionId, executionId, kind);
}

export function releaseTabLease(tabId) {
  const id = Number(tabId);
  if (!tabLeases.has(id)) return false;
  tabLeases.delete(id);
  return true;
}

export function releaseTabLeasesByExecution(sessionId, executionId) {
  const sid = String(sessionId || '');
  const eid = executionId == null || executionId === '' ? '' : String(executionId);
  if (!sid && !eid) return [];
  const released = [];
  for (const [id, lease] of tabLeases) {
    if (sid && lease.sessionId !== sid) continue;
    if (eid && lease.executionId !== eid) continue;
    tabLeases.delete(id);
    released.push(id);
  }
  return released;
}

/**
 * Gate a live-page action. Never consults Chrome's focused tab.
 * Missing tabId → NEED_EXPLICIT_TAB and does not register a lease.
 */
export function preparePageActionTarget(request = {}) {
  const tabId = explicitPageActionTabId(request);
  if (!tabId) {
    return {
      ok: false,
      code: 'NEED_EXPLICIT_TAB',
      error: 'page action requires an explicit tabId'
    };
  }
  const op = String(request.op || '').trim().toLowerCase();
  return tryAcquireTabLease(
    tabId,
    request.sessionId,
    request.executionId,
    op ? `action:${op}` : 'action'
  );
}

// Only the SW configures this adapter. Offscreen remains the workspace owner.
export const TAB_LEASE_STORAGE_KEY = 'browserbot_browser_leases_v1';
let leaseStorage = null;
let hydrated = false;
let leaseQueue = Promise.resolve();
const revokedOwners = new Map();
const ownerKey = (sid, eid) => JSON.stringify([String(sid || ''), String(eid || '')]);

export function configureTabLeasePersistence(storage) {
  if (!storage?.get || !storage?.set) throw leaseError('LEASE_STORE_UNAVAILABLE', 'storage.session is required.');
  leaseStorage = storage;
  hydrated = false;
}

function leaseError(code, message) { return Object.assign(new Error(message), { code }); }
function leaseSnapshot() {
  return structuredClone({ version: 1, leases: [...tabLeases], revoked: [...revokedOwners] });
}
function restoreLeaseSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.leases) || !Array.isArray(snapshot.revoked)) {
    throw leaseError('LEASE_STORE_UNAVAILABLE', 'Invalid browser lease store; reload the extension to reset browser ownership.');
  }
  const entries = snapshot.leases.map(([id, lease]) => {
    if (!Number.isInteger(id) || id <= 0 || !lease || typeof lease.sessionId !== 'string' ||
        typeof lease.executionId !== 'string' || !Array.isArray(lease.kinds)) {
      throw leaseError('LEASE_STORE_UNAVAILABLE', 'Invalid browser lease record.');
    }
    return [id, structuredClone(lease)];
  });
  tabLeases.clear();
  for (const [id, lease] of entries) tabLeases.set(id, lease);
  revokedOwners.clear();
  for (const [key, value] of snapshot.revoked) revokedOwners.set(key, value);
}

function withPersistentLeases(fn, { write = true } = {}) {
  const work = leaseQueue.catch(() => {}).then(async () => {
    if (leaseStorage && !hydrated) {
      try {
        const saved = await leaseStorage.get(TAB_LEASE_STORAGE_KEY);
        restoreLeaseSnapshot(saved?.[TAB_LEASE_STORAGE_KEY] || { version: 1, leases: [], revoked: [] });
        hydrated = true;
      } catch (error) {
        throw leaseError('LEASE_STORE_UNAVAILABLE', `Cannot load browser ownership: ${error?.message || error}`);
      }
    }
    const before = leaseSnapshot();
    try {
      const result = fn();
      const after = leaseSnapshot();
      if (write && leaseStorage && JSON.stringify(before) !== JSON.stringify(after)) {
        await leaseStorage.set({ [TAB_LEASE_STORAGE_KEY]: after });
      }
      return structuredClone(result);
    } catch (error) {
      restoreLeaseSnapshot(before);
      if (leaseStorage) hydrated = false; // reload authority on next attempt; never fail open
      if (error?.code) throw error;
      throw leaseError('LEASE_STORE_UNAVAILABLE', `Cannot commit browser ownership: ${error?.message || error}`);
    }
  });
  leaseQueue = work.catch(() => {});
  return work;
}

function checkOwner(sessionId, executionId) {
  if (leaseStorage && (!sessionId || !executionId)) {
    throw leaseError('EXECUTION_REQUIRED', 'Browser operations require sessionId and executionId.');
  }
  if (revokedOwners.has(ownerKey(sessionId, executionId))) {
    throw leaseError('EXECUTION_ENDED', 'This execution has ended; queued browser calls will not be dispatched.');
  }
}

export function assertTabLeaseOwnerActive(sessionId, executionId) {
  return withPersistentLeases(() => { checkOwner(sessionId, executionId); return true; }, { write: false });
}

export function acquireTabLease(tabId, sessionId, executionId, kind) {
  return withPersistentLeases(() => {
    checkOwner(sessionId, executionId);
    return tryAcquireTabLease(tabId, sessionId, executionId, kind);
  });
}

export async function preparePersistentPageActionTarget(request = {}) {
  const tabId = explicitPageActionTabId(request);
  if (!tabId) return { ok: false, code: 'NEED_EXPLICIT_TAB', error: 'page action requires an explicit tabId' };
  return acquireTabLease(tabId, request.sessionId, request.executionId, `action:${request.op || ''}`);
}

export function readTabLease(tabId) {
  return withPersistentLeases(() => peekTabLease(tabId), { write: false });
}
export function listTabLeases() {
  return withPersistentLeases(() => [...tabLeases].map(([tabId, lease]) => ({ tabId, ...lease })), { write: false });
}
export function removeTabLease(tabId) {
  return withPersistentLeases(() => releaseTabLease(tabId));
}
export function revokeTabLeaseOwner(sessionId, executionId) {
  return withPersistentLeases(() => {
    if (!sessionId || !executionId) return false;
    revokedOwners.set(ownerKey(sessionId, executionId), Date.now());
    // Execution IDs are unique; this is a bounded late-delivery fence, not a journal.
    while (revokedOwners.size > 2048) revokedOwners.delete(revokedOwners.keys().next().value);
    return true;
  });
}
export function releaseOwnedTabLeases(sessionId, executionId) {
  return withPersistentLeases(() => {
    if (!sessionId || !executionId) return [];
    return releaseTabLeasesByExecution(sessionId, executionId);
  });
}
