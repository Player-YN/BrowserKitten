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
  const tabId = Number.isInteger(Number(rawId)) ? Number(rawId) : null;
  if (!url && tabId == null) return null;
  return { tabId, url, title: text(page.title, 500) };
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
    targetPage: normalizeTargetPage(raw.targetPage),
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
  const task = requireTask(store, taskId);
  if (TERMINAL.has(task.status)) throw taskError('TASK_TERMINAL', `Task is ${task.status}.`);
  if (task.status === 'running' && task.ownership.executionId !== String(executionId || '')) {
    throw taskError('TASK_BUSY', 'Task is owned by another execution.');
  }
  return putTask(store, bump(task, {
    status: 'running',
    dueAt: null,
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
  const task = requireTask(store, taskId);
  if (!['pause', 'resume', 'cancel', 'detach'].includes(op)) {
    throw taskError('TASK_INVALID_OP', `Unknown task update: ${op}`);
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
    const goal = text(input.goal, 100000);
    const intervalMinutes = Number(input.intervalMinutes) > 0
      ? Math.max(1, Math.round(Number(input.intervalMinutes)))
      : null;
    const wakeAt = input.wakeAt
      ? iso(input.wakeAt)
      : intervalMinutes
        ? new Date(nowMs(args.now) + intervalMinutes * 60_000).toISOString()
        : null;
    if (!goal || !wakeAt) throw taskError('TASK_SCHEDULE_INVALID', 'schedule needs goal and wakeAt or intervalMinutes.');
    const scheduled = createTask(store, {
      sessionId: args.sessionId,
      goal,
      dueAt: wakeAt,
      intervalMinutes,
      targetPage: args.targetPage,
      status: 'waiting',
      scheduled: true,
      now: args.now
    });
    return { ok: true, task: scheduled, yield: false, scheduled: true };
  }
  if (op === 'start') return consumeStartCard(store, args);
  if (op === 'amend') return consumeAmendCard(store, args);
  const task = requireOwnedTask(store, args.taskId, args.executionId);
  if (op === 'inspect') return { ok: true, task, yield: false };
  if (!['plan', 'checkpoint', 'wait', 'complete'].includes(op)) {
    throw taskError('TASK_INVALID_OP', `Unknown hostTask op: ${op}`);
  }
  const patch = {};
  if (input.steps != null) patch.plan = { steps: normalizeSteps(input.steps) };
  if (input.summary != null) patch.summary = text(input.summary, 12000);
  if (input.evidence != null) patch.evidence = normalizeEvidence(input.evidence, task.evidence);
  if (input.nextAction != null) patch.nextAction = text(input.nextAction, 4000);
  if (op === 'checkpoint') {
    patch._lastCheckpointExecutionId = String(args.executionId || '');
    patch._lastCheckpointAt = nowMs(args.now);
  }
  let shouldYield = false;
  if (op === 'wait') {
    patch.status = input.wakeAt ? 'waiting' : 'paused';
    patch.dueAt = input.wakeAt ? iso(input.wakeAt) : null;
    patch.ownership = { executionId: null };
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

export function settleTaskAfterTurn(store, args = {}) {
  const task = requireTask(store, args.taskId);
  const executionId = String(args.executionId || '');
  if (task.ownership.executionId && task.ownership.executionId !== executionId) return task;
  const now = nowMs(args.now);
  if (task.status === 'cancelled' || task.status === 'paused') return task;
  if (task.status === 'completed' && !(task.intervalMinutes && args.scheduledRun)) return task;
  if (task.status === 'waiting' && !args.scheduledRun) return task;
  if (args.error) {
    const unknown = args.aborted === true || args.deadline === true;
    return putTask(store, bump(task, {
      status: unknown ? 'paused' : 'failed',
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
  if (task.status === 'failed') return task;
  const recurring = task.intervalMinutes && args.scheduledRun;
  if (recurring) {
    return putTask(store, bump(task, {
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
    (task) => task.status === 'waiting' && task.dueAt && Date.parse(task.dueAt) <= at
  );
}

export function nextTaskWakeAt(store) {
  const times = listTasks(store)
    .filter((task) => task.status === 'waiting' && task.dueAt)
    .map((task) => Date.parse(task.dueAt))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
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
