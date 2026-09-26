/**
 * One-shot dispatch tickets in chrome.storage.session.
 * SW consumes; offscreen issues. Not a journal.
 * SW recomputes payload hash from the resolved operation and never trusts the message hash.
 */

import { classifyRisk, needsDispatchTicket, ticketBindingFields, RISK_PAYMENT, CONF_KNOWN, RISK_DELETE } from './riskClassify.js';

export const DISPATCH_TICKETS_KEY = 'browserbot_dispatch_tickets_v1';

let installed = null;
let mapQueue = Promise.resolve();

function withTicketMap(fn) {
  const work = mapQueue.then(fn, fn);
  mapQueue = work.catch(() => {});
  return work;
}

export function installDispatchTicketStorage(area) {
  installed = area || null;
}

export function dispatchTicketStorageInstalled() {
  return !!installed;
}

export function resetDispatchTicketStorage() {
  installed = null;
}

function sessionArea() {
  if (installed) return installed;
  try {
    return typeof chrome !== 'undefined' ? chrome.storage?.session : null;
  } catch {
    return null;
  }
}

async function readMap() {
  const area = sessionArea();
  if (!area || typeof area.get !== 'function') {
    const err = new Error('dispatch ticket storage unavailable');
    err.code = 'TICKET_REQUIRED';
    throw err;
  }
  const bag = await area.get(DISPATCH_TICKETS_KEY);
  const raw = bag?.[DISPATCH_TICKETS_KEY] ?? bag;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

async function writeMap(map) {
  const area = sessionArea();
  if (!area || typeof area.set !== 'function') {
    const err = new Error('dispatch ticket storage unavailable');
    err.code = 'TICKET_REQUIRED';
    throw err;
  }
  await area.set({ [DISPATCH_TICKETS_KEY]: map });
}

export function createMemoryTicketStorage(seed = {}) {
  const data = { [DISPATCH_TICKETS_KEY]: { ...seed } };
  return {
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => {
      Object.assign(data, values);
    },
    remove: async (key) => {
      delete data[key];
    },
    _data: data
  };
}

function requireTicketFields(ticket) {
  const missing = [];
  if (!String(ticket?.operationId || '')) missing.push('operationId');
  if (!String(ticket?.sessionId || '')) missing.push('sessionId');
  if (!String(ticket?.executionId || '')) missing.push('executionId');
  if (!String(ticket?.payloadHash || '')) missing.push('payloadHash');
  if (!String(ticket?.nonce || '')) missing.push('nonce');
  if (missing.length) {
    const err = new Error(`ticket missing ${missing.join(', ')}`);
    err.code = 'TICKET_REQUIRED';
    throw err;
  }
}

export async function putDispatchTicket(ticket) {
  requireTicketFields(ticket);
  const operationId = String(ticket.operationId);
  return withTicketMap(async () => {
    const map = await readMap();
    const row = {
      operationId,
      nonce: String(ticket.nonce),
      sessionId: String(ticket.sessionId),
      executionId: String(ticket.executionId),
      risk: String(ticket.risk || ''),
      payloadHash: String(ticket.payloadHash),
      exp: Number(ticket.exp) || 0
    };
    if (ticket.tabId != null && ticket.tabId !== '') row.tabId = Number(ticket.tabId);
    if (ticket.documentId) row.documentId = String(ticket.documentId);
    map[operationId] = row;
    await writeMap(map);
    return map[operationId];
  });
}

export async function dropDispatchTicket(operationId) {
  const id = String(operationId || '');
  if (!id) return false;
  try {
    return await withTicketMap(async () => {
      const map = await readMap();
      if (!map[id]) return false;
      delete map[id];
      await writeMap(map);
      return true;
    });
  } catch {
    return false;
  }
}

export async function dropTicketsForExecution(sessionId, executionId) {
  const sid = String(sessionId || '');
  const eid = String(executionId || '');
  if (!sid || !eid) return 0;
  try {
    return await withTicketMap(async () => {
      const map = await readMap();
      let n = 0;
      for (const [id, ticket] of Object.entries(map)) {
        if (String(ticket?.sessionId || '') === sid && String(ticket?.executionId || '') === eid) {
          delete map[id];
          n += 1;
        }
      }
      if (n) await writeMap(map);
      return n;
    });
  } catch {
    return 0;
  }
}

export async function listDispatchTickets() {
  try {
    const map = await readMap();
    return Object.values(map);
  } catch {
    return [];
  }
}

export async function expireDispatchTickets(now = Date.now()) {
  try {
    await withTicketMap(async () => {
      const map = await readMap();
      let changed = false;
      for (const [id, ticket] of Object.entries(map)) {
        if (!ticket || Number(ticket.exp) <= now) {
          delete map[id];
          changed = true;
        }
      }
      if (changed) await writeMap(map);
    });
  } catch {
    /* ignore */
  }
}

function mismatch(code, message) {
  return { ok: false, code, error: message };
}

function requiredPresent(value) {
  if (value == null) return false;
  if (typeof value === 'string' && !value.trim()) return false;
  return true;
}

/**
 * SW last door. Reclassifies. Known payment always denied.
 * Hash is always the host-computed hash of the resolved operation.
 */
export async function consumeDispatchTicket(request, classifyInput, now = Date.now()) {
  const classified = classifyRisk(classifyInput || request || {});
  if (classified.risk === RISK_PAYMENT && classified.confidence === CONF_KNOWN) {
    if (request?.operationId) await dropDispatchTicket(request.operationId);
    return mismatch('PAYMENT_DENIED', 'Known payment is never dispatched.');
  }
  if (!needsDispatchTicket(classified)) {
    return { ok: true, classified, ticket: null, skipped: true };
  }
  const operationId = String(request?.operationId || '');
  if (!operationId) {
    return mismatch('TICKET_REQUIRED', 'Mutating dispatch requires a one-shot ticket.');
  }
  const computedHash = String(request?.payloadHash || '');
  if (!computedHash) {
    return mismatch('TICKET_REQUIRED', 'Host must recompute the payload hash before consume.');
  }
  let ticket;
  try {
    ticket = await withTicketMap(async () => {
      const map = await readMap();
      const found = map[operationId];
      if (!found) return null;
      delete map[operationId];
      await writeMap(map);
      return found;
    });
  } catch (error) {
    return mismatch(error?.code || 'TICKET_REQUIRED', error?.message || 'ticket storage unavailable');
  }
  if (!ticket) return mismatch('TICKET_REQUIRED', 'Dispatch ticket is missing or already used.');
  if (Number(ticket.exp) <= now) return mismatch('APPROVAL_EXPIRED', 'Dispatch ticket expired.');

  const bind = ticketBindingFields(classifyInput || request || {});
  if (bind.sessionId && String(ticket.sessionId || '') !== String(request.sessionId || '')) {
    return mismatch('APPROVAL_MISMATCH', 'Ticket session does not match.');
  }
  if (bind.executionId && String(ticket.executionId || '') !== String(request.executionId || '')) {
    return mismatch('APPROVAL_MISMATCH', 'Ticket execution does not match.');
  }
  if (bind.payloadHash) {
    if (!requiredPresent(ticket.payloadHash) || ticket.payloadHash !== computedHash) {
      return mismatch('APPROVAL_MISMATCH', 'Ticket payload hash does not match.');
    }
  }
  if (bind.nonce) {
    if (!requiredPresent(ticket.nonce) || !requiredPresent(request.ticketNonce) || String(ticket.nonce) !== String(request.ticketNonce)) {
      return mismatch('APPROVAL_MISMATCH', 'Ticket nonce does not match.');
    }
  }
  if (bind.tabId) {
    if (!requiredPresent(ticket.tabId) || request.tabId == null || Number(ticket.tabId) !== Number(request.tabId)) {
      return mismatch('APPROVAL_MISMATCH', 'Ticket tab does not match.');
    }
  }
  if (bind.documentId) {
    if (!requiredPresent(ticket.documentId) || !requiredPresent(request.documentId) || String(ticket.documentId) !== String(request.documentId)) {
      return mismatch('APPROVAL_MISMATCH', 'Ticket document does not match.');
    }
  }
  if (ticket.risk && classified.risk && String(ticket.risk) !== String(classified.risk)) {
    return mismatch('APPROVAL_MISMATCH', 'Ticket risk does not match host classification.');
  }
  if (classified.risk === RISK_DELETE && classified.confidence === CONF_KNOWN && ticket.risk !== RISK_DELETE) {
    return mismatch('APPROVAL_MISMATCH', 'Known delete requires a delete approval ticket.');
  }
  return { ok: true, classified, ticket, consumed: true };
}

export async function peekDispatchTicket(operationId) {
  const map = await readMap();
  return map[String(operationId || '')] || null;
}
