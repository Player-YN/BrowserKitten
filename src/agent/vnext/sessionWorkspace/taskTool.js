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

const OPS = ['inspect', 'plan', 'checkpoint', 'observe', 'wait', 'pause', 'complete', 'schedule', 'unschedule', 'start', 'amend'];
const TERMINAL_OPS = new Set(['wait', 'pause', 'complete', 'schedule']);
const TERMINAL_STATUSES = new Set(['waiting', 'paused', 'cancelled', 'failed', 'completed', 'complete']);

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
      'Manage durable work within the user-authorized goal. start/amend use a contract card. Autonomously schedule, adjust and remove wakeups when waiting, revisiting or following up is needed; the user need not explicitly request a timer. Bound schedule updates this same task and yields; goal optional and unchanged. Unbound schedule creates future work with a goal. Default new target discover; page binds a URL. unschedule removes automatic wakeups while preserving progress and continuing the current turn; optional taskId targets another task in this session. inspect reads the current/specified task or lists this session\'s tasks when unbound. observe compares stable keys/fingerprints before acting; acknowledge verified handling with checkpoint/wait handledKeys. wait ends a round, pause yields for attention, complete permanently ends the goal. quiet only for no meaningful change. Stop unneeded wakeups; never expand the user\'s goal through scheduling.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: OPS },
        taskId: { type: 'string', description: 'Optional inspect/unschedule target; must belong to this session' },
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
        goal: { type: 'string', description: 'Goal for start/amend or an unbound schedule; bound schedule inherits the current goal' },
        scope: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'string' } },
        sources: { type: 'array', items: { type: 'string' } },
        intervalMinutes: { type: 'number', description: 'Positive recurrence interval for schedule; minutes, minimum 1' },
        target: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['discover', 'page'] },
            url: { type: 'string', description: 'HTTP(S) URL for page mode; defaults to the current page' },
            tabId: { type: 'integer' }
          },
          required: ['mode']
        },
        reportPolicy: { type: 'string', enum: ['changes', 'always'], description: 'schedule report policy; default changes' },
        stopAt: { type: 'string', description: 'Optional future ISO deadline; host cancels the responsibility at this time' },
        stopWhen: { type: 'string', description: 'Optional semantic stop condition; evaluate against observations and complete when verified' },
        maxRoundMinutes: { type: 'number', description: 'Scheduled round execution budget, default 5, clamped to 1..30 minutes' },
        observations: {
          type: 'array', maxItems: 512,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', maxLength: 256, description: 'Stable source+item ID, never a list position' },
              fingerprint: { type: 'string', maxLength: 1024, description: 'Stable relevant content/version digest, not a check timestamp' },
              summary: { type: 'string' }
            },
            required: ['key', 'fingerprint']
          }
        },
        baseline: { type: 'boolean', description: 'Only before first observe: acknowledge existing items when user wants future changes only' },
        handledKeys: { type: 'array', items: { type: 'string' }, description: 'checkpoint/wait only: stable keys whose handling was verified' },
        report: { type: 'string', enum: ['quiet', 'changed', 'action', 'needs_attention'], description: 'Report kind for this round; quiet rejected while pending entries remain' }
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
        const intervalMinutes = Number(input.intervalMinutes ?? currentTask(env)?.intervalMinutes);
        const wakeAt = String(input.wakeAt || '').trim();
        if ((!goal && !currentTask(env)?.taskId) || (!wakeAt && !(intervalMinutes > 0))) {
          return {
            ok: false,
            code: 'BAD_INPUT',
            error: 'schedule requires wakeAt or positive intervalMinutes; an unbound schedule also requires goal'
          };
        }
      }
      if (op === 'wait' && !String(input.wakeAt || '').trim()) {
        return { ok: false, code: 'BAD_INPUT', error: 'wait requires wakeAt' };
      }
      if (['wait', 'pause'].includes(op) && (!String(input.summary || '').trim() || !String(input.nextAction || '').trim())) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          error: `${op} requires summary and nextAction so a later execution can resume safely`
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
        'taskId',
        'summary',
        'evidence',
        'nextAction',
        'wakeAt',
        'goal',
        'intervalMinutes',
        'target',
        'reportPolicy',
        'stopAt',
        'stopWhen',
        'maxRoundMinutes',
        'observations',
        'baseline',
        'handledKeys',
        'report'
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
