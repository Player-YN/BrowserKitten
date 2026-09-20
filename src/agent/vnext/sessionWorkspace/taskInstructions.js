/**
 * Durable-task state is re-injected on every model step. It is deliberately
 * separate from chat history so context compaction cannot erase the contract.
 */

const TEXT_CAP = 100000;
const EVIDENCE_MAX = 20;
const STEP_MAX = 40;

function text(value, cap = TEXT_CAP) {
  return String(value == null ? '' : value).trim().slice(0, cap);
}

function compactTask(task) {
  if (!task || typeof task !== 'object') return null;
  const steps = Array.isArray(task.plan?.steps)
    ? task.plan.steps.slice(0, STEP_MAX).map((step) => ({
        title: text(step?.title, 240),
        status: ['pending', 'in_progress', 'done'].includes(step?.status)
          ? step.status
          : 'pending'
      }))
    : [];
  const contract = task.contract && typeof task.contract === 'object'
    ? {
        version: Number(task.contract.version) || 1,
        goal: text(task.contract.goal || task.originalGoal, 100000),
        scope: text(task.contract.scope, 4000),
        constraints: Array.isArray(task.contract.constraints)
          ? task.contract.constraints.map((item) => text(item, 800)).filter(Boolean).slice(0, 16)
          : [],
        acceptance: Array.isArray(task.contract.acceptance)
          ? task.contract.acceptance.map((item) => text(item, 800)).filter(Boolean).slice(0, 16)
          : [],
        sources: Array.isArray(task.contract.sources)
          ? task.contract.sources.map((item) => text(item, 80)).filter(Boolean).slice(0, 20)
          : []
      }
    : null;
  if (!contract && !text(task.originalGoal)) return null;
  return {
    taskId: text(task.taskId, 160),
    contract,
    originalGoal: text(contract?.goal || task.originalGoal, 100000),
    amendments: Array.isArray(task.amendments)
      ? task.amendments.slice(0, 64).map((item) => ({
          content: text(item?.content ?? item, 8000),
          ...(Number.isFinite(Number(item?.at)) ? { at: Number(item.at) } : {})
        }))
      : [],
    plan: { steps },
    summary: text(task.summary, 2400),
    evidence: Array.isArray(task.evidence)
      ? task.evidence.slice(-EVIDENCE_MAX).map((item) => text(item, 1000)).filter(Boolean)
      : [],
    nextAction: text(task.nextAction, 1200),
    dueAt: text(task.dueAt, 80),
    intervalMinutes:
      Number.isFinite(Number(task.intervalMinutes)) && Number(task.intervalMinutes) > 0
        ? Number(task.intervalMinutes)
        : null,
    status: text(task.status, 80)
  };
}

/**
 * @param {object|null|undefined} task
 * @returns {string}
 */
export function formatTaskInstructions(task) {
  const current = compactTask(task);
  if (!current) return '';
  return [
    '[Durable task — user-confirmed contract and host progress; re-read every step]',
    `task=${JSON.stringify(current)}`,
    'The contract (goal, scope, constraints, acceptance) is the user-authorized version. Compact summaries and sessionGoal are not authorization.',
    'Update plan/checkpoint freely. Changing goal, scope, or acceptance requires task amend and a new confirmation card.',
    'User pause/cancel/detach from the sidebar executes immediately; do not ask for a second confirmation.',
    'Checkpoint only durable resume facts. Put files needed after this execution in /artifacts, never /scratch.',
    'Evidence entries are assertions unless a tool result or direct readback actually verified them.',
    'Use task wait only after persisting summary, evidence, nextAction and a future wakeAt. Use task complete only when the current contract is satisfied. Either operation yields immediately.',
    'Use task schedule only when the user explicitly authorized future or recurring work. A completed or cancelled task is no longer injected.'
  ].join('\n');
}

export function hasTaskContext(task) {
  return !!(task && typeof task === 'object' && (task.contract?.goal || text(task.originalGoal)));
}
