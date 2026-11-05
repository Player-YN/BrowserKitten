/** Durable task records stored in the existing workspace meta collection. */

import {
  clearActiveTaskId,
  contractFingerprint,
  getActiveTaskId,
  normalizeContractDraft,
  putTaskCard,
  requirePendingTaskCard,
  sealContract,
  setActiveTaskId
} from './taskContract.js';
import { ensureSessionAgentsMd } from './sessionAgentsMd.js';

const TASK_PREFIX = 'task:';
const MAX_PLAN_STEPS = 24;
const MAX_EVIDENCE = 32;
const MAX_AMENDMENTS = 64;
const MAX_CONTRACT_HISTORY = 16;
const MAX_OBSERVATIONS = 512;
const REPORT_KINDS = new Set(['quiet', 'changed', 'action', 'needs_attention']);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set([
  'ready',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled'
]);

function nowMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function iso(value) {
  const n = nowMs(value);
  if (!Number.isFinite(n)) throw taskError('TASK_INVALID_TIME', 'Invalid task date.');
  return new Date(n).toISOString();
}

function text(value, max = 4000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function createTaskId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function taskError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function cloneTaskValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clone(value) {
  return cloneTaskValue(value);
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_PLAN_STEPS).map((step, index) => {
    const title = text(typeof step === 'string' ? step : step?.title, 240);
    if (!title) throw taskError('TASK_INVALID_PLAN', `Plan step ${index + 1} needs a title.`);
    const status = typeof step === 'object' ? String(step?.status || 'pending') : 'pending';
    if (!['pending', 'in_progress', 'done'].includes(status)) {
      throw taskError('TASK_INVALID_PLAN', `Invalid plan step status: ${status}`);
    }
    return { title, status };
  });
}

function normalizeEvidence(value, previous = []) {
  if (value == null) return previous.slice(0, MAX_EVIDENCE);
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => text(row, 2000)).filter(Boolean).slice(-MAX_EVIDENCE);
}

function normalizeTargetPage(page) {
  if (!page || typeof page !== 'object') return null;
  const url = text(page.url, 4000);
  const rawId = page.tabId ?? page.id;
  const tabId = rawId != null && Number.isInteger(Number(rawId)) ? Number(rawId) : null;
  if (!url && tabId == null) return null;
  return { tabId, url, title: text(page.title, 500) };
}

function observationToken(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw taskError('TASK_INVALID_OBSERVATION', `${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}

function normalizeObservations(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_OBSERVATIONS) {
    throw taskError('TASK_OBSERVATION_LIMIT', `At most ${MAX_OBSERVATIONS} observations can be retained; narrow the task or start a new task.`);
  }
  const keys = new Set();
  return rows.map((row) => {
    const key = observationToken(row?.key, 'key', 256);
    const fingerprint = observationToken(row?.fingerprint, 'fingerprint', 1024);
    if (keys.has(key)) throw taskError('TASK_INVALID_OBSERVATION', `Duplicate observation key: ${key}`);
    keys.add(key);
    return { key, fingerprint, summary: text(row?.summary, 1000), handled: row?.handled === true };
  });
}

function scheduleTarget(input, activePage) {
  if (input.target != null && (typeof input.target !== 'object' || Array.isArray(input.target))) {
    throw taskError('TASK_INVALID_TARGET', 'target must be an object with mode discover or page.');
  }
  const mode = input.target?.mode || 'discover';
  if (!['discover', 'page'].includes(mode)) throw taskError('TASK_INVALID_TARGET', 'target.mode must be discover or page.');
  if (mode === 'discover') return { targetMode: mode, targetPage: null };
  const page = normalizeTargetPage({
    ...activePage,
    ...input.target,
    url: input.target?.url || activePage?.url,
    tabId: input.target?.tabId ?? activePage?.tabId ?? activePage?.id
  });
  if (!page?.url || !/^https?:\/\//i.test(page.url)) {
    throw taskError('TASK_INVALID_TARGET', 'A page target requires an HTTP(S) URL, explicitly supplied or from the current page.');
  }
  try { new URL(page.url); } catch { throw taskError('TASK_INVALID_TARGET', 'Invalid target URL.'); }
  return { targetMode: mode, targetPage: page };
}

function scheduleConfig(input, activePage, previous, now) {
  const rawInterval = input.intervalMinutes === undefined ? previous?.intervalMinutes : input.intervalMinutes;
  const intervalMinutes = Number(rawInterval) > 0 ? Math.max(1, Math.round(Number(rawInterval))) : null;
  const dueAt = input.wakeAt ? iso(input.wakeAt)
    : intervalMinutes ? new Date(nowMs(now) + intervalMinutes * 60_000).toISOString() : null;
  if (!dueAt || Date.parse(dueAt) <= nowMs(now)) {
    throw taskError('TASK_SCHEDULE_INVALID', 'schedule needs a future wakeAt or positive intervalMinutes.');
  }
  const reportPolicy = input.reportPolicy ?? (previous?.scheduled ? previous.reportPolicy : 'changes');
  if (!['changes', 'always'].includes(reportPolicy)) throw taskError('TASK_INVALID_REPORT', 'reportPolicy must be changes or always.');
  const stopAt = input.stopAt === undefined ? previous?.stopAt || null : input.stopAt ? iso(input.stopAt) : null;
  if (stopAt && Date.parse(stopAt) <= nowMs(now)) throw taskError('TASK_EXPIRED', 'stopAt must be in the future.');
  const target = previous && input.target === undefined
    ? { targetMode: previous.targetMode, targetPage: previous.targetPage }
    : scheduleTarget(input, activePage);
  return {
    ...target, dueAt, intervalMinutes, reportPolicy, stopAt,
    stopWhen: input.stopWhen ?? previous?.stopWhen ?? '',
    maxRoundMinutes: input.maxRoundMinutes ?? previous?.maxRoundMinutes ?? 5,
    scheduled: true, status: 'waiting', ownership: { executionId: null }
  };
}

function removeTaskSchedule(store, task, now) {
  return putTask(store, bump(task, {
    scheduled: false, dueAt: null, intervalMinutes: null, stopAt: null,
    status: task.status === 'running' ? 'running' : 'paused'
  }, now));
}

function normalizeStoredContract(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const draft = normalizeContractDraft(raw);
  if (!draft) return null;
  return {
    ...draft,
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    cardId: text(raw.cardId, 160),
    fingerprint: text(raw.fingerprint, 80) || contractFingerprint(draft),
    confirmedAt: Number(raw.confirmedAt) || 0
  };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = STATUSES.has(raw.status) ? raw.status : 'paused';
  const contract = normalizeStoredContract(raw.contract);
  return {
    ...raw,
    taskId: String(raw.taskId || ''),
    sessionId: String(raw.sessionId || ''),
    originalGoal: text(contract?.goal || raw.originalGoal, 100000),
    contract,
    contractHistory: Array.isArray(raw.contractHistory)
      ? raw.contractHistory.map(normalizeStoredContract).filter(Boolean).slice(-MAX_CONTRACT_HISTORY)
      : [],
    amendments: Array.isArray(raw.amendments) ? raw.amendments.slice(-MAX_AMENDMENTS) : [],
    plan: { steps: normalizeSteps(raw.plan?.steps || []) },
    summary: text(raw.summary, 12000),
    evidence: normalizeEvidence(raw.evidence),
    nextAction: text(raw.nextAction, 4000),
    dueAt: raw.dueAt ? iso(raw.dueAt) : null,
    intervalMinutes:
      Number.isFinite(Number(raw.intervalMinutes)) && Number(raw.intervalMinutes) > 0
        ? Math.max(1, Math.round(Number(raw.intervalMinutes)))
        : null,
    status,
    ownership: {
      executionId: raw.ownership?.executionId ? String(raw.ownership.executionId) : null,
      revision: Math.max(0, Math.floor(Number(raw.ownership?.revision) || 0))
    },
    continuationCount: Math.max(0, Math.floor(Number(raw.continuationCount) || 0)),
    scheduled: raw.scheduled === true,
    targetMode: raw.targetMode === 'discover' ? 'discover' : raw.targetMode === 'page' || raw.targetPage ? 'page' : 'discover',
    targetPage: raw.targetMode === 'discover' ? null : normalizeTargetPage(raw.targetPage),
    reportPolicy: raw.reportPolicy === 'changes' ? 'changes' : 'always',
    stopAt: raw.stopAt ? iso(raw.stopAt) : null,
    stopWhen: text(raw.stopWhen, 4000),
    maxRoundMinutes: Math.min(30, Math.max(1, Number(raw.maxRoundMinutes) || 5)),
    observationState: {
      initialized: raw.observationState?.initialized === true,
      entries: normalizeObservations(raw.observationState?.entries || [])
    },
    roundReport: raw.roundReport && REPORT_KINDS.has(raw.roundReport.kind)
      ? { executionId: text(raw.roundReport.executionId, 500), kind: raw.roundReport.kind } : null,
    roundCount: Math.max(0, Math.floor(Number(raw.roundCount) || 0)),
    lastCheckedAt: raw.lastCheckedAt ? iso(raw.lastCheckedAt) : null,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function putTask(store, task) {
  const clean = normalizeTask(task);
  store.put('meta', `${TASK_PREFIX}${clean.taskId}`, clean);
  return clone(clean);
}

function bump(task, patch, now = Date.now()) {
  return {
    ...task,
    ...patch,
    ownership: {
      executionId:
        patch.ownership && Object.prototype.hasOwnProperty.call(patch.ownership, 'executionId')
          ? patch.ownership.executionId
          : task.ownership?.executionId || null,
      revision: Math.max(0, Number(task.ownership?.revision) || 0) + 1
    },
    updatedAt: nowMs(now)
  };
}

export function listTasks(store, opts = {}) {
  const sessionId = opts.sessionId == null ? '' : String(opts.sessionId);
  return store.keys('meta')
    .filter((key) => String(key).startsWith(TASK_PREFIX))
    .map((key) => normalizeTask(store.get('meta', key)))
    .filter((task) => task && (!sessionId || task.sessionId === sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .map(clone);
}

export function getTask(store, taskId) {
  const task = normalizeTask(store.get('meta', `${TASK_PREFIX}${String(taskId || '')}`));
  return task ? clone(task) : null;
}

export function createTask(store, input = {}) {
  const goal = text(input.originalGoal ?? input.goal, 100000);
  const sessionId = text(input.sessionId, 500);
  if (!goal) throw taskError('TASK_GOAL_REQUIRED', 'Task goal is required.');
  if (!sessionId) throw taskError('TASK_SESSION_REQUIRED', 'Task sessionId is required.');
  const now = nowMs(input.now);
  const dueAt = input.dueAt || input.wakeAt ? iso(input.dueAt || input.wakeAt) : null;
  const stopAt = input.stopAt ? iso(input.stopAt) : null;
  if (stopAt && Date.parse(stopAt) <= now) throw taskError('TASK_EXPIRED', 'Task stopAt must be in the future.');
  const sealed = input.contract
    ? sealContract(input.contract, {
        version: 1,
        cardId: input.cardId,
        fingerprint: input.fingerprint || input.contract.fingerprint,
        confirmedAt: now
      })
    : null;
  return putTask(store, {
    taskId: input.taskId || createTaskId(),
    sessionId,
    originalGoal: sealed?.goal || goal,
    contract: sealed,
    contractHistory: [],
    amendments: [],
    plan: { steps: normalizeSteps(input.steps || []) },
    summary: text(input.summary, 12000),
    evidence: normalizeEvidence(input.evidence),
    nextAction: text(input.nextAction, 4000),
    dueAt,
    intervalMinutes:
      Number(input.intervalMinutes) > 0 ? Math.max(1, Math.round(Number(input.intervalMinutes))) : null,
    status: input.status || (dueAt ? 'waiting' : 'ready'),
    ownership: { executionId: null, revision: 1 },
    continuationCount: 0,
    scheduled: input.scheduled === true,
    targetPage: normalizeTargetPage(input.targetPage),
    targetMode: input.targetMode,
    reportPolicy: input.reportPolicy || (input.scheduled ? 'changes' : 'always'),
    stopAt,
    stopWhen: input.stopWhen,
    maxRoundMinutes: input.maxRoundMinutes,
    createdAt: now,
    updatedAt: now
  });
}

export function ensureTaskForMessage(store, input = {}) {
  const sessionId = String(input.sessionId || '');
  const goal = text(input.goal, 12000);
  const candidates = listTasks(store, { sessionId }).filter(
    (task) => !task.scheduled && !TERMINAL.has(task.status) && task.status !== 'running'
  );
  let task = input.taskId ? getTask(store, input.taskId) : candidates[0] || null;
  if (task && task.sessionId !== sessionId) {
    throw taskError('TASK_SESSION_MISMATCH', 'Task does not belong to this session.');
  }
  if (!task) return { task: createTask(store, { ...input, originalGoal: goal }), created: true };
  // waiting / paused / running are owned states. Ordinary ensure must not
  // steal them to ready, amend the goal, or clear dueAt.
  if (task.status === 'waiting' || task.status === 'paused' || task.status === 'running') {
    return { task, created: false };
  }
  if (goal && goal !== task.originalGoal) {
    const amendment = { content: goal, at: nowMs(input.now) };
    task = bump(task, {
      amendments: [...task.amendments, amendment].slice(-MAX_AMENDMENTS),
      status: 'ready',
      dueAt: null,
      targetPage: normalizeTargetPage(input.targetPage) || task.targetPage
    }, input.now);
    task = putTask(store, task);
  } else if (task.status !== 'ready') {
    task = putTask(store, bump(task, { status: 'ready', dueAt: null }, input.now));
  }
  return { task, created: false };
}

export function claimTask(store, taskId, executionId, now = Date.now()) {
  const task = requireUnexpiredTask(store, taskId, now);
  if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
  if (task.status === 'running' && task.ownership.executionId !== String(executionId || '')) {
    throw taskError('TASK_BUSY', 'Task is owned by another execution.');
  }
  return putTask(store, bump(task, {
    status: 'running',
    dueAt: null,
    roundReport: null,
    ownership: { executionId: String(executionId || '') }
  }, now));
}

export function recoverInterruptedTasks(store, now = Date.now()) {
  const recovered = [];
  for (const task of listTasks(store)) {
    if (task.status !== 'running') continue;
    const next = bump(task, {
      status: 'paused',
      ownership: { executionId: null },
      summary: task.summary || 'Previous execution ended before its outcome was recorded.',
      nextAction: task.nextAction || 'Inspect the current state before resuming; the previous outcome is unknown.'
    }, now);
    putTask(store, next);
    recovered.push(clone(next));
  }
  return recovered;
}

export function updateTaskControl(store, taskId, op, now = Date.now()) {
  const task = requireUnexpiredTask(store, taskId, now);
  if (!['pause', 'resume', 'cancel', 'detach', 'unschedule'].includes(op)) {
    throw taskError('TASK_INVALID_OP', `Unknown task update: ${op}`);
  }
  if (op === 'unschedule') {
    if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
    return removeTaskSchedule(store, task, now);
  }
  if (op === 'detach') {
    clearActiveTaskId(store, task.sessionId, task.taskId);
    if (TERMINAL.has(task.status)) return putTask(store, task);
    return putTask(store, bump(task, {
      status: task.status === 'waiting' ? 'waiting' : 'paused',
      ownership: { executionId: null }
    }, now));
  }
  if (op === 'cancel') {
    if (task.status === 'completed') throw taskError('TASK_TERMINAL', 'Completed task cannot be cancelled.');
    clearActiveTaskId(store, task.sessionId, task.taskId);
    return putTask(store, bump(task, {
      status: 'cancelled', dueAt: null, ownership: { executionId: null }
    }, now));
  }
  if (op === 'pause') {
    if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
    return putTask(store, bump(task, {
      status: 'paused', dueAt: null, ownership: { executionId: null }
    }, now));
  }
  if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
  setActiveTaskId(store, task.sessionId, task.taskId);
  return putTask(store, bump(task, {
    status: 'ready', dueAt: null, ownership: { executionId: null }
  }, now));
}

function consumeStartCard(store, args) {
  const sessionId = String(args.sessionId || '');
  const input = args.input || {};
  const { rec, reused } = requirePendingTaskCard(
    store,
    sessionId,
    input.cardId,
    input.fingerprint,
    'task-start'
  );
  if (reused) {
    const existing = getTask(store, rec.taskId);
    if (!existing) throw taskError('TASK_NOT_FOUND', 'Consumed card is missing its task.');
    try {
      ensureSessionAgentsMd(store, sessionId, {
        title: existing.originalGoal || existing.contract?.goal,
        summary: existing.summary
      });
    } catch {
      /* workspace notes must not fail the task receipt */
    }
    return { ok: true, task: existing, yield: false, created: false, reused: true };
  }
  const activeId = getActiveTaskId(store, sessionId);
  if (activeId) {
    const active = getTask(store, activeId);
    if (active && !TERMINAL.has(active.status)) {
      throw taskError('TASK_ALREADY_ACTIVE', 'This session already has a bound task.');
    }
  }
  const sealed = sealContract(rec.draft, {
    version: 1,
    cardId: rec.cardId,
    fingerprint: rec.fingerprint,
    confirmedAt: nowMs(args.now)
  });
  if (!sealed) throw taskError('TASK_CARD_STALE', 'Task card draft is invalid.');
  let task = createTask(store, {
    sessionId,
    goal: sealed.goal,
    contract: sealed,
    cardId: rec.cardId,
    fingerprint: rec.fingerprint,
    steps: rec.draftSteps || input.steps || [],
    targetPage: args.targetPage,
    status: 'ready',
    now: args.now
  });
  if (args.executionId) {
    task = claimTask(store, task.taskId, args.executionId, args.now);
  }
  setActiveTaskId(store, sessionId, task.taskId);
  putTaskCard(store, sessionId, { ...rec, status: 'consumed', taskId: task.taskId, finalizedAt: Date.now() });
  try {
    ensureSessionAgentsMd(store, sessionId, {
      title: sealed.goal || task.originalGoal,
      summary: task.summary
    });
  } catch {
    /* workspace notes must not fail the task receipt */
  }
  return { ok: true, task: getTask(store, task.taskId), yield: false, created: true };
}

function consumeAmendCard(store, args) {
  const task = requireOwnedTask(store, args.taskId, args.executionId);
  const input = args.input || {};
  const { rec, reused } = requirePendingTaskCard(
    store,
    task.sessionId,
    input.cardId,
    input.fingerprint,
    'task-amend'
  );
  if (reused) return { ok: true, task: getTask(store, rec.taskId) || task, yield: false, created: false, reused: true };
  const sealed = sealContract(rec.draft, {
    version: (Number(task.contract?.version) || 0) + 1,
    cardId: rec.cardId,
    fingerprint: rec.fingerprint,
    confirmedAt: nowMs(args.now)
  });
  if (!sealed) throw taskError('TASK_CARD_STALE', 'Amend card draft is invalid.');
  const history = [...(task.contractHistory || [])];
  if (task.contract) history.push(task.contract);
  const updated = putTask(store, bump(task, {
    originalGoal: sealed.goal,
    contract: sealed,
    contractHistory: history.slice(-MAX_CONTRACT_HISTORY),
    status: 'running'
  }, args.now));
  putTaskCard(store, task.sessionId, {
    ...rec,
    status: 'consumed',
    taskId: task.taskId,
    finalizedAt: Date.now()
  });
  return { ok: true, task: updated, yield: false, created: false };
}

/**
 * One-click path: an approved ordinary plan card may also consume a host-written
 * task-start receipt. Does not throw when a non-terminal task is already bound.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {{ sessionId: string, executionId?: string, plan?: object, cardId?: string, now?: number, targetPage?: object }} args
 */
export function startTaskFromPlanApproval(store, args = {}) {
  const sessionId = String(args.sessionId || '');
  const plan = args.plan && typeof args.plan === 'object' ? args.plan : null;
  const goal = String(plan?.title || '').trim();
  if (!sessionId || !goal) return { ok: false, created: false, skipped: 'no-plan' };
  const activeId = getActiveTaskId(store, sessionId);
  if (activeId) {
    const active = getTask(store, activeId);
    if (active && !TERMINAL.has(active.status)) {
      return { ok: true, created: false, skipped: 'already-active', task: active };
    }
  }
  const draft = normalizeContractDraft({
    goal,
    scope: plan.summary || '',
    constraints: plan.constraints,
    acceptance: plan.acceptance
  });
  if (!draft) return { ok: false, created: false, skipped: 'invalid-draft' };
  const cardId = String(args.cardId || '').trim() || `plan-task_${Date.now().toString(36)}`;
  const fingerprint = contractFingerprint(draft);
  const draftSteps = Array.isArray(plan.steps)
    ? plan.steps.map((step) => ({
        title: String(step?.title || step || '').trim(),
        status: 'pending'
      })).filter((step) => step.title)
    : [];
  putTaskCard(store, sessionId, {
    cardId,
    kind: 'task-start',
    status: 'pending',
    draft,
    draftSteps,
    fingerprint,
    createdAt: Date.now(),
    source: 'plan-approval'
  });
  return hostTaskMutation(store, {
    sessionId,
    executionId: args.executionId,
    now: args.now,
    targetPage: args.targetPage,
    input: { op: 'start', cardId, fingerprint, steps: draftSteps }
  });
}

export function hostTaskMutation(store, args = {}) {
  const input = args.input || {};
  const op = String(input.op || 'inspect');
  if (op === 'schedule') {
    if (args.taskId) {
      requireUnexpiredTask(store, args.taskId, args.now);
      const current = requireOwnedTask(store, args.taskId, args.executionId);
      if (current.sessionId !== args.sessionId) throw taskError('TASK_SESSION_MISMATCH', 'Task does not belong to this session.');
      if (input.goal != null && text(input.goal, 100000) !== current.originalGoal) {
        throw taskError('TASK_SCOPE_CHANGE_REQUIRED', 'schedule only changes timing; use task amend to change the authorized goal.');
      }
      const task = putTask(store, bump(current, scheduleConfig(input, args.targetPage, current, args.now), args.now));
      return { ok: true, task, yield: true, scheduled: true, created: false };
    }
    const goal = text(input.goal, 100000);
    if (!goal) throw taskError('TASK_SCHEDULE_INVALID', 'An unbound schedule requires a goal.');
    const scheduled = createTask(store, {
      sessionId: args.sessionId,
      goal,
      ...scheduleConfig(input, args.targetPage, null, args.now),
      now: args.now
    });
    return { ok: true, task: scheduled, yield: false, scheduled: true, created: true };
  }
  if (op === 'unschedule' || op === 'inspect') {
    const id = input.taskId || args.taskId;
    if (!id && op === 'inspect') return { ok: true, tasks: listTasks(store, { sessionId: args.sessionId }), yield: false };
    const task = requireTask(store, id);
    if (task.sessionId !== args.sessionId) throw taskError('TASK_SESSION_MISMATCH', 'Task does not belong to this session.');
    if (op === 'inspect') return { ok: true, task, yield: false };
    if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
    if (task.status === 'running' && task.ownership.executionId !== String(args.executionId || '')) {
      throw taskError('TASK_NOT_OWNER', 'Another execution owns this task.');
    }
    return { ok: true, task: removeTaskSchedule(store, task, args.now), yield: false, unscheduled: true };
  }
  if (op === 'start') return consumeStartCard(store, args);
  if (op === 'amend') return consumeAmendCard(store, args);
  // Host-only (not in the task tool enum): a checked /plan approval. Going
  // through hostTask lets the service bind and settle the claimed task.
  if (op === 'plan-start') {
    return startTaskFromPlanApproval(store, {
      sessionId: args.sessionId,
      executionId: args.executionId,
      plan: input.plan,
      cardId: input.cardId,
      now: args.now,
      targetPage: args.targetPage
    });
  }
  requireUnexpiredTask(store, args.taskId, args.now);
  const task = requireOwnedTask(store, args.taskId, args.executionId);
  if (op === 'inspect') return { ok: true, task, yield: false };
  if (op === 'observe') return observeTask(store, task, input, args.now);
  if (!['plan', 'checkpoint', 'wait', 'pause', 'complete'].includes(op)) {
    throw taskError('TASK_INVALID_OP', `Unknown hostTask op: ${op}`);
  }
  const patch = {};
  if (input.steps != null) patch.plan = { steps: normalizeSteps(input.steps) };
  if (input.summary != null) patch.summary = text(input.summary, 12000);
  if (input.evidence != null) patch.evidence = normalizeEvidence(input.evidence, task.evidence);
  if (input.nextAction != null) patch.nextAction = text(input.nextAction, 4000);
  if (input.report != null) {
    if (!REPORT_KINDS.has(input.report)) throw taskError('TASK_INVALID_REPORT', 'Unknown round report kind.');
    patch.roundReport = { executionId: String(args.executionId || ''), kind: input.report };
  }
  if (input.handledKeys != null) {
    if (!['checkpoint', 'wait'].includes(op) || !Array.isArray(input.handledKeys)) {
      throw taskError('TASK_INVALID_OBSERVATION', 'handledKeys is an array allowed only on checkpoint/wait.');
    }
    const keys = new Set(input.handledKeys.map((key) => observationToken(key, 'handled key', 256)));
    const known = new Set(task.observationState.entries.map((row) => row.key));
    if ([...keys].some((key) => !known.has(key))) throw taskError('TASK_INVALID_OBSERVATION', 'handledKeys contains an unobserved key.');
    patch.observationState = {
      ...task.observationState,
      entries: task.observationState.entries.map((row) => ({ ...row, handled: keys.has(row.key) || row.handled }))
    };
  }
  if (input.report === 'quiet' && (patch.observationState || task.observationState).entries.some((entry) => !entry.handled)) {
    throw taskError('TASK_PENDING_OBSERVATIONS', 'Cannot report quiet while observations still need handling.');
  }
  if (op === 'checkpoint') {
    patch._lastCheckpointExecutionId = String(args.executionId || '');
    patch._lastCheckpointAt = nowMs(args.now);
  }
  let shouldYield = false;
  if (op === 'wait') {
    if (input.wakeAt && Date.parse(iso(input.wakeAt)) <= nowMs(args.now)) {
      throw taskError('TASK_INVALID_TIME', 'wait wakeAt must be in the future.');
    }
    patch.status = input.wakeAt ? 'waiting' : 'paused';
    patch.dueAt = input.wakeAt ? iso(input.wakeAt) : null;
    patch.ownership = { executionId: null };
    shouldYield = true;
  } else if (op === 'pause') {
    patch.status = 'paused';
    patch.dueAt = null;
    patch.ownership = { executionId: null };
    patch.roundReport = { executionId: String(args.executionId || ''), kind: 'needs_attention' };
    shouldYield = true;
  } else if (op === 'complete') {
    patch.status = 'completed';
    patch.dueAt = null;
    patch.ownership = { executionId: null };
    shouldYield = true;
    clearActiveTaskId(store, task.sessionId, task.taskId);
  } else {
    patch.status = 'running';
  }
  const updated = putTask(store, bump(task, patch, args.now));
  return { ok: true, task: updated, yield: shouldYield };
}

function observeTask(store, task, input, now) {
  const observations = normalizeObservations(input.observations);
  const state = task.observationState;
  if (input.baseline === true && state.initialized) {
    throw taskError('TASK_BASELINE_INITIALIZED', 'Baseline is only allowed before the first observation.');
  }
  const entries = new Map(state.entries.map((row) => [row.key, { ...row }]));
  const newCount = observations.filter((row) => !entries.has(row.key)).length;
  if (entries.size + newCount > MAX_OBSERVATIONS) {
    throw taskError('TASK_OBSERVATION_LIMIT', `Task observation ledger is full (${MAX_OBSERVATIONS}); narrow the task or start a new task.`);
  }
  const changes = [];
  for (const observation of observations) {
    const previous = entries.get(observation.key);
    const changed = previous && previous.fingerprint !== observation.fingerprint;
    const handled = input.baseline === true && !previous ? true : previous && !changed ? previous.handled : false;
    const entry = { ...observation, handled: handled === true };
    entries.set(entry.key, entry);
    if (!entry.handled) {
      changes.push({ key: entry.key, fingerprint: entry.fingerprint, summary: entry.summary, kind: !previous ? 'new' : changed ? 'changed' : 'pending' });
    }
  }
  const supplied = new Set(observations.map((row) => row.key));
  for (const entry of entries.values()) {
    if (!entry.handled && !supplied.has(entry.key)) {
      changes.push({ key: entry.key, fingerprint: entry.fingerprint, summary: entry.summary, kind: 'pending' });
    }
  }
  const updated = putTask(store, bump(task, {
    observationState: { initialized: true, entries: [...entries.values()] },
    // A later observation must invalidate an earlier "quiet" checkpoint.
    roundReport: changes.length ? null : task.roundReport
  }, now));
  return { ok: true, task: updated, yield: false, changes, initialized: true, total: entries.size };
}

export function settleTaskAfterTurn(store, args = {}) {
  const task = requireTask(store, args.taskId);
  const executionId = String(args.executionId || '');
  if (task.ownership.executionId && task.ownership.executionId !== executionId) return task;
  const now = nowMs(args.now);
  const checked = args.scheduledRun && !args.error && task._lastSettledExecutionId !== executionId
    ? { roundCount: task.roundCount + 1, lastCheckedAt: iso(now), _lastSettledExecutionId: executionId } : {};
  if (task.status === 'cancelled' || task.status === 'failed') return task;
  if (task.status === 'completed' || task.status === 'paused') {
    return Object.keys(checked).length ? putTask(store, bump(task, checked, now)) : task;
  }
  if (task.stopAt && Date.parse(task.stopAt) <= now) return expireTask(store, task, now);
  if (args.error) {
    const unknown = args.aborted === true || args.deadline === true;
    return putTask(store, bump(task, {
      status: unknown ? 'paused' : 'failed',
      dueAt: null,
      summary: text(
        args.summary ||
          task.summary ||
          (unknown ? 'Previous execution ended before its outcome was recorded.' : 'Execution failed.'),
        12000
      ),
      nextAction: text(
        args.nextAction ||
          task.nextAction ||
          (unknown ? 'Outcome unknown; inspect the current state before resuming.' : ''),
        4000
      ),
      ownership: { executionId: null }
    }, now));
  }
  if (task.status === 'waiting') return putTask(store, bump(task, checked, now));
  const recurring = task.intervalMinutes && args.scheduledRun;
  if (recurring) {
    return putTask(store, bump(task, {
      ...checked,
      status: 'waiting',
      dueAt: nextIntervalAt(args.previousDueAt || task.dueAt || now, task.intervalMinutes, now),
      summary: text(args.summary || task.summary, 12000),
      ownership: { executionId: null }
    }, now));
  }
  const steps = Array.isArray(task.plan?.steps) ? task.plan.steps : [];
  const hasOpenPlan = steps.some((step) => step.status !== 'done');
  // completed is only written by a successful `task complete`. An empty
  // plan or a turn that never completed must stay ready/paused.
  return putTask(store, bump(task, {
    ...checked,
    status: steps.length ? 'paused' : 'ready',
    dueAt: null,
    summary: text(args.summary || task.summary, 12000),
    nextAction: hasOpenPlan ? task.nextAction || 'Review remaining plan steps.' : task.nextAction,
    ownership: { executionId: null }
  }, now));
}

export function dueTasks(store, now = Date.now()) {
  const at = nowMs(now);
  return listTasks(store).filter(
    (task) => task.status === 'waiting' && task.dueAt && Date.parse(task.dueAt) <= at && (!task.stopAt || Date.parse(task.stopAt) > at)
  );
}

export function nextTaskWakeAt(store) {
  const times = listTasks(store)
    .filter((task) => !TERMINAL.has(task.status))
    .flatMap((task) => [task.status === 'waiting' ? task.dueAt : null, task.stopAt])
    .filter(Boolean)
    .map((at) => Date.parse(at))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function expireTask(store, task, now) {
  clearActiveTaskId(store, task.sessionId, task.taskId);
  return putTask(store, bump(task, {
    status: 'cancelled', dueAt: null, ownership: { executionId: null },
    summary: 'Task expired at its configured end time; goal completion was not asserted.',
    nextAction: '',
    roundReport: { executionId: task.ownership.executionId || '', kind: 'needs_attention' }
  }, now));
}

export function expireTasks(store, now = Date.now()) {
  return listTasks(store).filter((task) => !TERMINAL.has(task.status) && task.stopAt && Date.parse(task.stopAt) <= nowMs(now))
    .map((task) => expireTask(store, task, now));
}

function requireUnexpiredTask(store, taskId, now = Date.now()) {
  const task = requireTask(store, taskId);
  if (!TERMINAL.has(task.status) && task.stopAt && Date.parse(task.stopAt) <= nowMs(now)) {
    throw taskError('TASK_EXPIRED', 'Task reached its stopAt deadline and cannot resume.');
  }
  return task;
}

export function deleteTasksForSession(store, sessionId) {
  const deleted = [];
  for (const task of listTasks(store, { sessionId })) {
    store.delete('meta', `${TASK_PREFIX}${task.taskId}`);
    deleted.push(task.taskId);
  }
  return deleted;
}

export function nextIntervalAt(anchor, intervalMinutes, now = Date.now()) {
  const base = nowMs(anchor);
  const at = nowMs(now);
  const interval = Math.max(1, Math.round(Number(intervalMinutes) || 1)) * 60_000;
  const jumps = Math.max(1, Math.floor((at - base) / interval) + 1);
  return new Date(base + jumps * interval).toISOString();
}

function requireTask(store, taskId) {
  const task = getTask(store, taskId);
  if (!task) throw taskError('TASK_NOT_FOUND', `Unknown task ${taskId || ''}.`);
  return task;
}

function requireOwnedTask(store, taskId, executionId) {
  const task = requireTask(store, taskId);
  const owner = String(executionId || '');
  if (task.status !== 'running' || !owner || task.ownership.executionId !== owner) {
    throw taskError('TASK_NOT_OWNER', 'This execution no longer owns the task.');
  }
  return task;
}
