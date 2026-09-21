/**
 * ExecutionContext + leases — bookkeeping only, not Task domain.
 */

import { createSessionGuestFs } from './fs.js';
import { createExecutionId } from './ids.js';
import {
  ensureSessionWorkspaceFiles,
  refreshAgentsMdPointers
} from './sessionAgentsMd.js';
import { clearVisualCreationLedger } from './visualCreationLedger.js';
import { emptyWorkspaceTrash } from './workspaceTrash.js';

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 * @param {{ abortSignal?: AbortSignal }} [opts]
 */
export function beginExecution(store, sessionId, opts = {}) {
  if (!store.has('sessions', sessionId)) throw new Error(`unknown session ${sessionId}`);
  const executionId = createExecutionId();
  const controller = opts.abortSignal ? null : new AbortController();
  const signal = opts.abortSignal || controller.signal;
  const ctx = {
    executionId,
    sessionId,
    abortSignal: signal,
    scratchRoot: `/tmp/${sessionId}/${executionId}`,
    leases: new Set(),
    startedAt: Date.now(),
    status: 'running',
    visualCreation: { byKind: Object.create(null), explicitNew: Object.create(null) },
    _controller: controller
  };
  store.put('executions', executionId, {
    executionId,
    sessionId,
    startedAt: ctx.startedAt,
    status: 'running',
    leases: []
  });
  store.leases.set(executionId, ctx.leases);
  return ctx;
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {object} ctx
 * @param {string|string[]} webItemIds
 */
export function acquireLease(store, ctx, webItemIds) {
  const ids = Array.isArray(webItemIds) ? webItemIds : [webItemIds];
  const set = store.leases.get(ctx.executionId) || ctx.leases;
  for (const id of ids) {
    if (id) set.add(String(id));
  }
  store.leases.set(ctx.executionId, set);
  const rec = store.get('executions', ctx.executionId);
  if (rec) {
    store.put('executions', ctx.executionId, { ...rec, leases: [...set] });
  }
  return [...set];
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {object} ctx
 * @param {'settled'|'aborted'|'failed'} [status]
 */
export function settleExecution(store, ctx, status = 'settled') {
  const executionId = ctx.executionId;
  const sessionId = ctx.sessionId;
  // Release leases
  store.leases.delete(executionId);
  const rec = store.get('executions', executionId);
  if (rec) {
    store.put('executions', executionId, {
      ...rec,
      status,
      settledAt: Date.now(),
      leases: []
    });
  }
  clearVisualCreationLedger(ctx);
  try {
    const fs = createSessionGuestFs(store, { sessionId });
    ensureSessionWorkspaceFiles(store, sessionId);
    refreshAgentsMdPointers(store, sessionId);
    emptyWorkspaceTrash(store, fs, sessionId);
  } catch {
    /* workspace maintenance must not fail settle */
  }
  // Delete scratch FS nodes + blobs for this execution
  const scratchPrefix = `/tmp/${sessionId}/${executionId}`;
  for (const hp of [...store.keys('fsNodes')]) {
    if (String(hp).startsWith(scratchPrefix)) {
      store.delete('fsNodes', hp);
      store.deleteBlob(`fs:${hp}`);
    }
  }
  for (const bk of [...store.blobs.keys()]) {
    if (String(bk).startsWith(`fs:${scratchPrefix}`)) store.deleteBlob(bk);
  }
  return { executionId, status, scratchCleared: true };
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} webItemId
 */
export function isWebItemLeased(store, webItemId) {
  for (const set of store.leases.values()) {
    if (set.has(webItemId)) return true;
  }
  return false;
}
