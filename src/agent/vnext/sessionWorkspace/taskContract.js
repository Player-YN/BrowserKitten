/**
 * User-confirmed durable-task contract. Compact / sessionGoal / intentState
 * are not authorization. Only a host card receipt may create or amend this.
 */

const GOAL_CAP = 100000;
const SCOPE_CAP = 8000;
const ITEM_CAP = 2000;
const ITEM_MAX = 16;
const SOURCE_MAX = 20;
const CARD_TTL_MS = 2 * 60 * 60 * 1000;

function text(value, cap) {
  return String(value == null ? '' : value).trim().slice(0, cap);
}

function list(value, cap = ITEM_CAP, max = ITEM_MAX) {
  const rows = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return rows.map((item) => text(item, cap)).filter(Boolean).slice(0, max);
}

function ids(value) {
  const rows = Array.isArray(value) ? value : [];
  return [...new Set(rows.map((id) => text(id, 160)).filter(Boolean))].slice(0, SOURCE_MAX);
}

export function normalizeContractDraft(raw = {}) {
  const goal = text(raw.goal || raw.originalGoal || raw.title, GOAL_CAP);
  if (!goal) return null;
  return {
    goal,
    scope: text(raw.scope || raw.summary, SCOPE_CAP),
    constraints: list(raw.constraints),
    acceptance: list(raw.acceptance || raw.completion),
    sources: ids(raw.sources || raw.sourceMessageIds)
  };
}

export function contractFingerprint(draft) {
  const body = JSON.stringify({
    goal: draft?.goal || '',
    scope: draft?.scope || '',
    constraints: Array.isArray(draft?.constraints) ? draft.constraints : [],
    acceptance: Array.isArray(draft?.acceptance) ? draft.acceptance : []
  });
  let hash = 2166136261;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cfn_${(hash >>> 0).toString(36)}`;
}

export function contractToPlan(draft, steps = []) {
  const d = normalizeContractDraft(draft);
  if (!d) return null;
  const extra = [];
  if (d.constraints.length) extra.push(`Constraints: ${d.constraints.join('; ')}`);
  if (d.acceptance.length) extra.push(`Acceptance: ${d.acceptance.join('; ')}`);
  const planSteps = Array.isArray(steps) && steps.length
    ? steps
    : [{ title: d.goal, detail: d.scope }];
  return {
    title: d.goal,
    summary: [d.scope, ...extra].filter(Boolean).join('\n'),
    steps: planSteps
  };
}

export function sealContract(draft, extras = {}) {
  const d = normalizeContractDraft(draft);
  if (!d) return null;
  const fingerprint = extras.fingerprint || contractFingerprint(d);
  if (fingerprint !== contractFingerprint(d)) return null;
  return {
    ...d,
    version: Math.max(1, Math.floor(Number(extras.version) || 1)),
    cardId: text(extras.cardId, 160),
    fingerprint,
    confirmedAt: Number(extras.confirmedAt) || Date.now()
  };
}

export function contractsEquivalent(a, b) {
  return !!(a && b && contractFingerprint(a) === contractFingerprint(b));
}

export function putTaskCard(store, sessionId, card) {
  const sid = String(sessionId || '');
  const session = store.get('sessions', sid);
  if (!session) throw Object.assign(new Error('Unknown session'), { code: 'TASK_SESSION_REQUIRED' });
  const cardId = text(card?.cardId, 160);
  if (!cardId) throw Object.assign(new Error('cardId required'), { code: 'TASK_CARD_INVALID' });
  const next = {
    ...(session.taskCards && typeof session.taskCards === 'object' ? session.taskCards : {}),
    [cardId]: { ...card, cardId }
  };
  store.put('sessions', sid, { ...session, taskCards: next, updatedAt: Date.now() });
  return next[cardId];
}

export function getTaskCard(store, sessionId, cardId) {
  const cards = store.get('sessions', sessionId)?.taskCards;
  const rec = cards && typeof cards === 'object' ? cards[String(cardId || '')] : null;
  return rec && typeof rec === 'object' ? rec : null;
}

export function finalizeTaskCard(store, sessionId, cardId, status, extra = {}) {
  const rec = getTaskCard(store, sessionId, cardId);
  if (!rec) return null;
  return putTaskCard(store, sessionId, { ...rec, ...extra, status, finalizedAt: Date.now() });
}

export function requirePendingTaskCard(store, sessionId, cardId, fingerprint, kind) {
  const rec = getTaskCard(store, sessionId, cardId);
  if (!rec) {
    throw Object.assign(new Error('Task card is not pending.'), { code: 'TASK_CARD_INVALID' });
  }
  if (kind && rec.kind !== kind) {
    throw Object.assign(new Error('Task card kind mismatch.'), { code: 'TASK_CARD_INVALID' });
  }
  if (rec.status === 'consumed' && rec.taskId) {
    return { rec, reused: true };
  }
  if (rec.status !== 'pending') {
    throw Object.assign(new Error(`Task card is ${rec.status}.`), { code: 'TASK_CARD_CONSUMED' });
  }
  const age = Date.now() - Number(rec.createdAt || 0);
  if (Number.isFinite(age) && age > CARD_TTL_MS) {
    finalizeTaskCard(store, sessionId, cardId, 'expired');
    throw Object.assign(new Error('Task card expired.'), { code: 'TASK_CARD_EXPIRED' });
  }
  const draftPrint = contractFingerprint(rec.draft);
  if (!rec.fingerprint || rec.fingerprint !== draftPrint || rec.fingerprint !== String(fingerprint || '')) {
    throw Object.assign(new Error('Task card was modified.'), { code: 'TASK_CARD_STALE' });
  }
  return { rec, reused: false };
}

export function getActiveTaskId(store, sessionId) {
  const id = String(store.get('sessions', sessionId)?.activeTaskId || '').trim();
  return id || null;
}

export function setActiveTaskId(store, sessionId, taskId) {
  const session = store.get('sessions', sessionId);
  if (!session) return null;
  const next = String(taskId || '').trim() || null;
  if ((session.activeTaskId || null) === next) return next;
  store.put('sessions', sessionId, { ...session, activeTaskId: next, updatedAt: Date.now() });
  return next;
}

export function clearActiveTaskId(store, sessionId, taskId = null) {
  const session = store.get('sessions', sessionId);
  if (!session) return;
  if (taskId && session.activeTaskId && session.activeTaskId !== taskId) return;
  if (!session.activeTaskId) return;
  store.put('sessions', sessionId, { ...session, activeTaskId: null, updatedAt: Date.now() });
}

export const TASK_CARD_TTL_MS = CARD_TTL_MS;
