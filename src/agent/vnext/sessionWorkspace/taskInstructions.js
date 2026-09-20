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
  return {
    taskId: text(task.taskId, 160),
    originalGoal: text(task.originalGoal, 100000),
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
  if (!current || !current.originalGoal) return '';
  return [
    '[Durable task — current host state; re-read this contract every step]',
    `task=${JSON.stringify(current)}`,
    'originalGoal is an immutable historical record. Preserve unfinished work and its constraints, but later explicit user corrections, cancellations or replacements concerning this task take precedence over that record and over a model summary. Unrelated questions or local subtasks do not cancel the task.',
    'Use task inspect when fresh state is needed. Use task plan/checkpoint as work advances; ordinary autonomous planning does not require user approval. A simple reply does not need an elaborate plan.',
    'Checkpoint only durable resume facts. Put files needed after this execution in /artifacts, never /scratch, and do not save opaque ref handles as resume state.',
    'Evidence entries are assertions unless a tool result or direct readback actually verified them. Say what was checked; never upgrade an inference to verification.',
    'Use task wait only after persisting summary, evidence, nextAction and a future wakeAt. Include applicable user corrections and source message IDs in the checkpoint. Use task complete only when the goal with applicable user changes is satisfied. Either operation yields immediately and no more tools may run.',
    'Use task schedule only when the user explicitly authorized future or recurring work. Scheduling creates separate future work; it is not a substitute for finishing the current task.'
  ].join('\n');
}

export function hasTaskContext(task) {
  return !!(task && typeof task === 'object' && text(task.originalGoal));
}
