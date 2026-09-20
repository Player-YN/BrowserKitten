/** Durable task tool and execution gate. The service owns persistence. */

import { classifyPlanDecision } from './planContract.js';
import { newClarifyId, waitForClarifyAnswer } from './clarifyGate.js';
import {
  contractFingerprint,
  contractToPlan,
  finalizeTaskCard,
  normalizeContractDraft,
  putTaskCard
} from './taskContract.js';

const OPS = ['inspect', 'plan', 'checkpoint', 'wait', 'complete', 'schedule', 'start', 'amend'];
const TERMINAL_OPS = new Set(['wait', 'complete']);
const TERMINAL_STATUSES = new Set(['waiting', 'completed', 'complete']);

function terminalTask(task) {
  return !!(task && TERMINAL_STATUSES.has(String(task.status || '').toLowerCase()));
}

function currentTask(env) {
  try {
    if (typeof env.getTaskContext === 'function') return env.getTaskContext() || null;
  } catch {
    return env.taskContext || null;
  }
  return env.taskContext || null;
}

function taskUnavailable() {
  return {
    ok: false,
    code: 'TASK_UNAVAILABLE',
    error: 'durable task host is unavailable for this execution'
  };
}

function yieldedResult() {
  return {
    ok: false,
    code: 'TASK_YIELDED',
    error: 'task execution already yielded; no more tools may run'
  };
}

/**
 * Gate tool executions for a task-backed turn. FIFO order lets an earlier
 * side effect settle before wait/complete persists; once it does, later calls
 * (including siblings from the same model step) are suppressed.
 */
export function createTaskExecutionGate(env = {}) {
  let yielded = false;
  let draining = false;
  let scheduled = false;
  /** @type {Array<{name:string,input:any,run:Function,resolve:Function,reject:Function,terminal:boolean}>} */
  const queue = [];

  const shouldYield = () => {
    if (yielded) return true;
    try {
      if (typeof env.taskShouldYield === 'function' && env.taskShouldYield()) return true;
    } catch {
      /* host read failure should not invent a terminal state */
    }
    return terminalTask(currentTask(env));
  };

  async function drain() {
    if (draining) return;
    draining = true;
    scheduled = false;
    try {
      while (queue.length) {
        if (shouldYield()) {
          yielded = true;
          while (queue.length) queue.shift().resolve(yieldedResult());
          break;
        }
        const item = queue.shift();
        try {
          const output = await item.run();
          if (item.terminal && output?.ok === true && output?.yield !== false) yielded = true;
          item.resolve(output);
        } catch (error) {
          item.reject(error);
        }
        if (yielded || shouldYield()) {
          yielded = true;
          while (queue.length) queue.shift().resolve(yieldedResult());
          break;
        }
      }
    } finally {
      draining = false;
      if (queue.length && !scheduled) {
        scheduled = true;
        queueMicrotask(drain);
      }
    }
  }

  return {
    shouldYield,
    didYield: () => yielded || shouldYield(),
    execute(name, input, run) {
      if (shouldYield()) return Promise.resolve(yieldedResult());
      return new Promise((resolve, reject) => {
        queue.push({
          name,
          input,
          run,
          resolve,
          reject,
          terminal: name === 'task' && TERMINAL_OPS.has(String(input?.op || ''))
        });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(drain);
        }
      });
    }
  };
}

async function presentContractCard(env, kind, draft, steps) {
  const store = env.store;
  const sessionId = String(env.sessionId || '');
  const waitClarify =
    typeof env.waitForClarify === 'function' ? env.waitForClarify : waitForClarifyAnswer;
  if (!store || !sessionId || typeof waitClarify !== 'function') {
    return { ok: false, code: 'TASK_CARD_REQUIRED', error: 'Task start/amend requires a host confirmation card.' };
  }
  const fingerprint = contractFingerprint(draft);
  const cardId = newClarifyId();
  putTaskCard(store, sessionId, {
    cardId,
    kind,
    draft,
    draftSteps: Array.isArray(steps) ? steps : [],
    fingerprint,
    status: 'pending',
    createdAt: Date.now()
  });
  const plan = contractToPlan(draft, steps);
  if (typeof env.onEvent === 'function') {
    try {
      env.onEvent({
        type: 'clarify',
        sessionId,
        clarifyId: cardId,
        kind,
        contract: draft,
        plan,
        questions: []
      });
    } catch {
      /* UI listener must not fail the yield */
    }
  }
  let answers = {};
  try {
    answers = await waitClarify({
      clarifyId: cardId,
      sessionId,
      signal: env.signal,
      questions: []
    });
  } catch (error) {
    finalizeTaskCard(store, sessionId, cardId, 'cancelled');
    if (error?.name === 'AbortError') throw error;
    return { ok: false, created: false, code: 'TASK_CARD_CANCELLED', error: String(error?.message || error) };
  }
  const decision = classifyPlanDecision(answers);
  if (decision.kind !== 'approved') {
    finalizeTaskCard(
      store,
      sessionId,
      cardId,
      decision.kind === 'revise' ? 'revised' : 'declined'
    );
    if (typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'clarify-done',
          sessionId,
          clarifyId: cardId,
          kind,
          approved: false,
          decision: decision.kind,
          answers
        });
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      created: false,
      decision: decision.kind,
      notes: decision.notes,
      code: decision.kind === 'revise' ? 'TASK_CARD_REVISE' : 'TASK_CARD_DECLINED'
    };
  }
  try {
    const out = await env.hostTask({ op: kind === 'task-amend' ? 'amend' : 'start', cardId, fingerprint });
    if (typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'clarify-done',
          sessionId,
          clarifyId: cardId,
          kind,
          approved: true,
          decision: 'approved',
          taskId: out?.task?.taskId || '',
          answers
        });
      } catch {
        /* ignore */
      }
    }
    return { ...out, created: out?.created === true, decision: 'approved' };
  } catch (error) {
    return {
      ok: false,
      created: false,
      code: String(error?.code || 'TASK_FAILED'),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** @param {object} env */
export function createTaskTool(env = {}) {
  return {
    name: 'task',
    description:
      'Durable work after the user confirms a contract. start opens a task-start card (goal, scope, constraints, acceptance, first steps) — only a UI receipt creates the task and binds this turn. Ordinary clarify plan cards do not create tasks. amend opens a change card when goal/scope/acceptance must change; plan/checkpoint update progress only. wait/complete persist and yield. schedule is future/recurring work the user explicitly asked for. Propose start for resume/wait/multi-stage delivery; do not pop a card every turn or after a fixed message count.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: OPS },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] }
            },
            required: ['title', 'status']
          }
        },
        summary: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        nextAction: { type: 'string' },
        wakeAt: { type: 'string', description: 'ISO-8601 timestamp for wait or schedule' },
        goal: { type: 'string', description: 'Goal for start, amend, or a separately scheduled future task' },
        scope: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'string' } },
        sources: { type: 'array', items: { type: 'string' } },
        intervalMinutes: { type: 'number', description: 'Positive recurrence interval for schedule' }
      },
      required: ['op']
    },
    async execute(input = {}) {
      const op = String(input.op || '');
      if (!OPS.includes(op)) {
        return { ok: false, code: 'BAD_INPUT', error: `unknown task op ${op || '(empty)'}` };
      }
      if (typeof env.hostTask !== 'function') return taskUnavailable();
      if (op === 'start' || op === 'amend') {
        const draft = normalizeContractDraft(input);
        if (!draft) {
          return { ok: false, code: 'BAD_INPUT', error: `${op} requires a goal` };
        }
        if (op === 'amend' && !currentTask(env)?.taskId) {
          return { ok: false, code: 'TASK_NOT_BOUND', error: 'amend requires a bound durable task' };
        }
        return presentContractCard(env, op === 'amend' ? 'task-amend' : 'task-start', draft, input.steps);
      }
      if (op === 'schedule') {
        const goal = String(input.goal || '').trim();
        const intervalMinutes = Number(input.intervalMinutes);
        const wakeAt = String(input.wakeAt || '').trim();
        if (!goal || (!wakeAt && !(intervalMinutes > 0))) {
          return {
            ok: false,
            code: 'BAD_INPUT',
            error: 'schedule requires goal and wakeAt or a positive intervalMinutes'
          };
        }
      }
      if (op === 'wait' && !String(input.wakeAt || '').trim()) {
        return { ok: false, code: 'BAD_INPUT', error: 'wait requires wakeAt' };
      }
      if (op === 'wait' && (!String(input.summary || '').trim() || !String(input.nextAction || '').trim())) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          error: 'wait requires summary and nextAction so a later execution can resume safely'
        };
      }
      if (
        op === 'complete' &&
        (!String(input.summary || '').trim() ||
          !Array.isArray(input.evidence) ||
          !input.evidence.some((item) => String(item || '').trim()))
      ) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          error: 'complete requires summary and at least one concrete evidence entry'
        };
      }
      const payload = { op };
      for (const key of [
        'steps',
        'summary',
        'evidence',
        'nextAction',
        'wakeAt',
        'goal',
        'intervalMinutes'
      ]) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      try {
        return await env.hostTask(payload);
      } catch (error) {
        return {
          ok: false,
          code: String(error?.code || 'TASK_FAILED'),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

/**
 * @param {Record<string, any>} tools
 * @param {object} env
 */
export function guardTaskToolExecutions(tools, env = {}) {
  if (typeof env.hostTask !== 'function' && !env.taskContext && typeof env.getTaskContext !== 'function') {
    return { tools, gate: null };
  }
  const gate = createTaskExecutionGate(env);
  const guarded = {};
  for (const [name, value] of Object.entries(tools || {})) {
    if (!value || typeof value.execute !== 'function') {
      guarded[name] = value;
      continue;
    }
    guarded[name] = {
      ...value,
      execute(input, opts) {
        return gate.execute(name, input, () => value.execute(input, opts));
      }
    };
  }
  return { tools: guarded, gate };
}
