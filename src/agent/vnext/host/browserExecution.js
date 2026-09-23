/** Browser resources are scoped to an execution, not to a sidepanel or a model call. */
import { listTabLeases, revokeTabLeaseOwner, releaseOwnedTabLeases } from './tabLease.js';
import { releaseBrowserSysResources } from './browserSysHost.js';
import { clearVisualReplay } from './visualClick.js';
const releases = new Map();

export function releaseBrowserExecution(sessionId, executionId) {
  if (!sessionId || !executionId) return Promise.resolve([]);
  const key = JSON.stringify([sessionId, executionId]);
  if (releases.has(key)) return releases.get(key);
  const pending = (async () => {
    // Block queued / late calls BEFORE detaching, and keep other owners out until cleanup is done.
    await revokeTabLeaseOwner(sessionId, executionId);
    const owned = (await listTabLeases()).filter(row => row.sessionId === sessionId && row.executionId === executionId);
    await releaseBrowserSysResources(sessionId, executionId, owned);
    clearVisualReplay(executionId);
    return releaseOwnedTabLeases(sessionId, executionId);
  })();
  releases.set(key, pending);
  void pending.finally(() => { if (releases.get(key) === pending) releases.delete(key); }).catch(() => {});
  return pending;
}

/** Compare only pre-read lease candidates with the authoritative offscreen runtime. */
export async function reconcileBrowserExecutions(rpc) {
  const candidates = await listTabLeases();
  if (!candidates.length) return [];
  const response = await rpc({ method: 'getBrowserRuntimeState', params: {} });
  if (!response?.ok || !Array.isArray(response.result?.activeExecutions)) {
    throw Object.assign(new Error('Cannot confirm browser execution owners; leases retained.'), { code: 'LEASE_RECONCILE_FAILED' });
  }
  const active = response.result.activeExecutions;
  const owners = new Map();
  for (const row of candidates) {
    if (!active.some(slot => slot.sessionId === row.sessionId && (!slot.executionId || slot.executionId === row.executionId))) {
      owners.set(JSON.stringify([row.sessionId, row.executionId]), row);
    }
  }
  const released = [];
  for (const row of owners.values()) released.push(...await releaseBrowserExecution(row.sessionId, row.executionId));
  return released;
}
