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
    status: text(task.status, 80),
    scheduled: task.scheduled === true,
    targetMode: task.targetMode || (task.targetPage ? 'page' : 'discover'),
    targetPage: task.targetPage || null,
    reportPolicy: task.reportPolicy || 'always',
    stopAt: task.stopAt || null,
    stopWhen: text(task.stopWhen, 4000),
    maxRoundMinutes: task.maxRoundMinutes || 5,
    roundCount: task.roundCount || 0,
    lastCheckedAt: task.lastCheckedAt || null,
    observationState: {
      initialized: task.observationState?.initialized === true,
      retainedCount: task.observationState?.entries?.length || 0,
      pendingCount: (task.observationState?.entries || []).filter((entry) => !entry.handled).length,
      pending: (task.observationState?.entries || []).filter((entry) => !entry.handled)
        .slice(0, 32)
        .map((entry) => ({ key: entry.key, fingerprint: entry.fingerprint, summary: text(entry.summary, 400) }))
    }
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
    'Scheduled tasks run locally while Chrome is available. targetMode=discover means autonomously find/open the authorized sources; do not use a coincidentally focused tab. targetMode=page binds the saved URL.',
    'For ongoing observation, read the source then call task observe with stable source+item keys and content/version fingerprints before taking action. Avoid timestamps, list positions and volatile fields in fingerprints. The ledger holds 512 keys and rejects overflow rather than forgetting previously handled entries.',
    'observe returns new/changed/pending candidates. Previously handled identical fingerprints are omitted; unhandled candidates remain pending across rounds. baseline=true is allowed only on the first observation and only when the user wants future changes, not existing backlog.',
    'The instruction block shows at most 32 pending entries; use task inspect/observe to read the full ledger when pendingCount is larger.',
    'Only pass handledKeys to checkpoint/wait after direct readback verifies successful handling (including delivering a change report). Evidence prose is not verification. For uncertain external writes, inspect the postcondition or task pause with summary/nextAction; never blindly retry or acknowledge unknown outcomes.',
    'Autonomously set, revise and remove wakeups when the authorized goal needs waiting, revisiting or follow-up. Do not wait for the user to explicitly say schedule or specify a frequency. Choose a sensible interval from the observed situation; stop unnecessary checks.',
    'Bound task schedule updates this same task and yields; omit goal to inherit the contract. Use it to configure/change intervalMinutes and the next wakeAt without creating duplicate tasks. Use task wait for a one-off continuation after persisting summary, evidence and nextAction. Persist the checkpoint before schedule. Both yield immediately.',
    'Use task unschedule to remove future automatic wakeups without losing the goal, progress or observation ledger; the current execution can continue. inspect lists this session\'s tasks when unbound; inspect/unschedule may specify a same-session taskId. Use task complete to permanently end the responsibility only when the goal/stopWhen condition is verified; pause yields for human attention.',
    'For reportPolicy=changes, set report=quiet and wait only when there are no pending meaningful changes, actions, failures or requests for user attention; otherwise changed/action/needs_attention with a concrete report. Do not use quiet to conceal an uncertain result. reportPolicy=always keeps each round visible.',
    'stopAt is a host-enforced expiry (cancelled, not goal completion). stopWhen is a semantic condition you evaluate against evidence; the host does not evaluate it. Respect maxRoundMinutes; checkpoint before the round budget runs out.',
    'Scheduling is an execution decision within the user-authorized goal, not authorization to invent a new goal or widen scope. A completed or cancelled task is no longer injected.'
  ].join('\n');
}

export function hasTaskContext(task) {
  return !!(task && typeof task === 'object' && (task.contract?.goal || text(task.originalGoal)));
}
