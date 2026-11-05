/**
 * Session-scoped append-only audit ring. Not a call journal, not exactly-once.
 * Host facts only: task / lease / abort / deadline / STALE / action / sys dispatch.
 * Never stores guest sys code or large bodies.
 */

import { SESSION_AUDIT_SCHEMA } from '../../../brand.js';

export { SESSION_AUDIT_SCHEMA };
export const SESSION_AUDIT_CAP = 200;

const KEEP = new Set([
  'task-lifecycle',
  'lease',
  'abort',
  'deadline',
  'stale-ref',
  'action-outcome',
  'execution-start',
  'execution-end',
  'journal',
  'policy',
  'host'
]);

export function sessionAuditKey(sessionId) {
  return `audit:${String(sessionId || '')}`;
}

export function normalizeAuditEvent(ev = {}) {
  const type = String(ev.type || '');
  if (KEEP.has(type)) return { ...ev, type };
  if (type === 'task-updated' || type === 'task-schedule-changed') {
    return {
      ...ev,
      type: 'task-lifecycle',
      op: ev.op || type,
      taskId: ev.taskId || ev.task?.taskId,
      status: ev.status || ev.task?.status,
      nextAction: ev.nextAction || ev.task?.nextAction,
      dueAt: ev.dueAt || ev.task?.dueAt
    };
  }
  if (type === 'tool-result') {
    const code = String(ev.code || ev.result?.code || '');
    const name = String(ev.name || ev.tool || '');
    if (code === 'STALE_REF') return { ...ev, type: 'stale-ref', recovered: ev.recovered === true };
    if (code === 'TAB_LEASED') return { ...ev, type: 'lease', op: 'conflict', code };
    if (code === 'SYS_TIMEOUT') return { ...ev, type: 'deadline', code };
    if (name === 'action') return { ...ev, type: 'action-outcome', ok: ev.ok !== false, code };
    return null;
  }
  if (type === 'error' && String(ev.code || '') === 'SYS_TIMEOUT') {
    return { ...ev, type: 'deadline' };
  }
  return null;
}

export function slimAuditEvent(ev = {}) {
  const normalized = normalizeAuditEvent(ev);
  if (!normalized) return null;
  const type = String(normalized.type || '');
  if (!KEEP.has(type)) return null;
  ev = normalized;
  const row = { type, ts: Number(ev.ts) || Date.now() };
  if (ev.op) row.op = String(ev.op).slice(0, 40);
  if (ev.status) row.status = String(ev.status).slice(0, 40);
  if (ev.ok != null) row.ok = ev.ok === true;
  if (ev.quiet != null) row.quiet = ev.quiet === true;
  if (ev.scheduledRun != null) row.scheduledRun = ev.scheduledRun === true;
  if (ev.code) row.code = String(ev.code).slice(0, 64);
  if (ev.taskId) row.taskId = String(ev.taskId).slice(0, 160);
  if (ev.executionId) row.executionId = String(ev.executionId).slice(0, 80);
  if (ev.sessionId) row.sessionId = String(ev.sessionId).slice(0, 80);
  if (ev.tabId != null && ev.tabId !== '') row.tabId = ev.tabId;
  if (ev.url) row.url = String(ev.url).slice(0, 2000);
  if (ev.title) row.title = String(ev.title).slice(0, 120);
  if (ev.holderSessionId) row.holderSessionId = String(ev.holderSessionId).slice(0, 80);
  if (ev.name) row.name = String(ev.name).slice(0, 80);
  if (ev.recovered === true) row.recovered = true;
  if (ev.reason) row.reason = String(ev.reason).slice(0, 40);
  if (ev.subgoal) row.subgoal = String(ev.subgoal).slice(0, 80);
  if (ev.ref) row.ref = String(ev.ref).slice(0, 32);
  if (ev.via) row.via = String(ev.via).slice(0, 80);
  if (ev.verified === true || ev.verified === false) row.verified = ev.verified === true;
  if (ev.kind) row.kind = String(ev.kind).slice(0, 24);
  if (ev.matched === false) row.matched = false;
  if (ev.dueAt) row.dueAt = String(ev.dueAt).slice(0, 80);
  if (ev.nextAction) row.nextAction = String(ev.nextAction).slice(0, 200);
  if (ev.operationId) row.operationId = String(ev.operationId).slice(0, 80);
  if (ev.state) row.state = String(ev.state).slice(0, 40);
  if (ev.risk) row.risk = String(ev.risk).slice(0, 32);
  if (ev.confidence) row.confidence = String(ev.confidence).slice(0, 16);
  if (ev.accessMode) row.accessMode = String(ev.accessMode).slice(0, 16);
  if (ev.rawEscape) row.rawEscape = String(ev.rawEscape).slice(0, 16);
  return row;
}

export function appendSessionAudit(store, sessionId, ev) {
  const sid = String(sessionId || ev?.sessionId || '');
  if (!store || !sid) return null;
  const row = slimAuditEvent({ ...ev, sessionId: sid });
  if (!row) return null;
  const key = sessionAuditKey(sid);
  const prev = store.get('meta', key);
  const events = Array.isArray(prev?.events) ? prev.events.slice() : [];
  events.push(row);
  store.put('meta', key, {
    schema: SESSION_AUDIT_SCHEMA,
    sessionId: sid,
    events: events.length > SESSION_AUDIT_CAP ? events.slice(events.length - SESSION_AUDIT_CAP) : events,
    updatedAt: Date.now()
  });
  return row;
}

export function readSessionAudit(store, sessionId) {
  const sid = String(sessionId || '');
  if (!store || !sid) return { schema: SESSION_AUDIT_SCHEMA, sessionId: sid, events: [] };
  const rec = store.get('meta', sessionAuditKey(sid));
  const events = Array.isArray(rec?.events) ? rec.events : [];
  return {
    schema: SESSION_AUDIT_SCHEMA,
    sessionId: sid,
    events,
    updatedAt: rec?.updatedAt || 0
  };
}

export const TRAJECTORY_THOUGHT_WARNING =
  'Trajectory includes model thought text and may contain sensitive information.';
