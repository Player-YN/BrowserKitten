/**
 * Frozen-plan contract — host pin + prepareStep inject.
 * The model judges when to plan; the host does not classify "structural" ops.
 */

const TITLE_CAP = 80;
const SUMMARY_CAP = 400;
const STEP_CAP = 160;
const DETAIL_CAP = 400;
const STEP_MAX = 12;
const NOTES_CAP = 2000;

function explicitRevise(answers) {
  if (!answers || typeof answers !== 'object') return false;
  if (answers.revise === true || answers.requiredToChange === true) return true;
  const decision = String(answers.decision || answers.kind || '').trim().toLowerCase();
  return decision === 'revise' || decision === 'required_to_change' || decision === 'required-to-change';
}

/**
 * Compact notes for the revise path. Empty string is fail-closed at the host.
 * @param {unknown} answers
 */
export function planRevisionNotes(answers) {
  if (!answers || typeof answers !== 'object') return '';
  return String(answers.notes || answers.feedback || answers.revision || '')
    .trim()
    .slice(0, NOTES_CAP);
}

/**
 * @param {unknown} raw
 * @returns {{ title: string, detail: string } | null}
 */
export function normalizePlanStep(raw) {
  if (typeof raw === 'string') {
    const title = raw.trim().slice(0, STEP_CAP);
    return title ? { title, detail: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.text || raw.step || '').trim().slice(0, STEP_CAP);
  const detail = String(raw.detail || raw.why || raw.description || '').trim().slice(0, DETAIL_CAP);
  if (!title) return null;
  return { title, detail };
}

/**
 * @param {unknown} raw
 * @returns {{ title: string, summary: string, steps: Array<{ title: string, detail: string }> } | null}
 */
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.goal || raw.question || '').trim().slice(0, TITLE_CAP);
  const summary = String(raw.summary || raw.why || '').trim().slice(0, SUMMARY_CAP);
  const list = Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.plan) ? raw.plan : [];
  const steps = [];
  for (const s of list.slice(0, STEP_MAX)) {
    const step = normalizePlanStep(s);
    if (step) steps.push(step);
  }
  if (!title || !steps.length) return null;
  return { title, summary, steps };
}

/**
 * @param {unknown} answers
 * @returns {boolean}
 */
export function isPlanApproved(answers) {
  if (!answers || typeof answers !== 'object') return false;
  if (explicitRevise(answers)) return false;
  if (answers.approved === true || answers.approved === 'true') return true;
  if (answers.approved === false || answers.approved === 'false') return false;
  const decision = String(answers.decision || '').trim().toLowerCase();
  if (decision === 'approve' || decision === 'approved') return true;
  if (decision === 'decline' || decision === 'reject' || decision === 'refuse') return false;
  const values = Object.values(answers)
    .filter((v) => typeof v === 'string' || typeof v === 'boolean')
    .map((v) => String(v).trim().toLowerCase());
  const blob = values.join(' ');
  if (!blob) return false;
  if (/(不批准|先不要|拒绝|decline|reject|refuse|需要修改|要求修改)/.test(blob)) return false;
  return /(批准|开始|approve|approved|start)/.test(blob);
}

/**
 * Ordinary plan cards create a Durable Task only when the UI sends this flag.
 * Missing field stays false so older receipts still only pin this turn.
 * @param {unknown} answers
 */
export function wantsDurableTaskFromPlan(answers) {
  if (!isPlanApproved(answers)) return false;
  const v = answers && typeof answers === 'object' ? answers.startDurableTask : undefined;
  return v === true || v === 'true';
}

/**
 * Host decision for a yielded plan. Unknown / empty revise notes fail closed.
 * @param {unknown} answers
 * @returns {{ kind: 'approved'|'declined'|'revise'|'unknown', notes: string }}
 */
export function classifyPlanDecision(answers) {
  if (!answers || typeof answers !== 'object') return { kind: 'unknown', notes: '' };
  const notes = planRevisionNotes(answers);
  if (explicitRevise(answers)) return { kind: 'revise', notes };
  if (isPlanApproved(answers)) return { kind: 'approved', notes: '' };
  if (answers.approved === false || answers.approved === 'false') return { kind: 'declined', notes: '' };
  const decision = String(answers.decision || '').trim().toLowerCase();
  if (decision === 'decline' || decision === 'reject' || decision === 'refuse') {
    return { kind: 'declined', notes: '' };
  }
  const values = Object.values(answers)
    .filter((v) => typeof v === 'string' || typeof v === 'boolean')
    .map((v) => String(v).trim().toLowerCase());
  const blob = values.join(' ');
  if (/(不批准|先不要|拒绝|decline|reject|refuse)/.test(blob)) return { kind: 'declined', notes: '' };
  return { kind: 'unknown', notes };
}

/**
 * User invoked /plan via slash chip or typed token. Not a skill.
 * @param {{ content?: string, mentions?: Array<{ kind?: string, id?: string, label?: string, handle?: string }> }} input
 */
export function userRequestedPlan(input = {}) {
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];
  for (const m of mentions) {
    const id = String(m?.id || m?.handle || '').trim().toLowerCase();
    const label = String(m?.label || '').trim().toLowerCase();
    if (m?.kind === 'command' && (id === 'plan' || label === 'plan')) return true;
    if (id === 'plan' && (m?.kind === 'command' || m?.kind === 'skill')) return true;
  }
  return /(^|[\s\u00a0])\/plan\b/i.test(String(input.content || ''));
}

/**
 * Re-injected every ToolLoop step after the user approves.
 * @param {{ title: string, summary?: string, steps: Array<{ title: string, detail?: string }|string> }} plan
 */
export function formatFrozenPlanInstructions(plan) {
  const p = normalizePlan(plan);
  if (!p) return '';
  const lines = [
    '[Pinned plan — host contract for this turn]',
    'The user approved this plan. Serve this destination. Local repair must not replace it.',
    `title: ${p.title}`
  ];
  if (p.summary) lines.push(`summary: ${p.summary}`);
  lines.push('steps:');
  p.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`);
    if (s.detail) lines.push(`   ${s.detail}`);
  });
  return lines.join('\n');
}

/**
 * @param {object|null|undefined} execution
 * @param {unknown} plan
 * @returns {object|null}
 */
export function pinFrozenPlan(execution, plan) {
  const p = normalizePlan(plan);
  if (!execution || !p) return null;
  execution.frozenPlan = p;
  return p;
}

/**
 * Revise / decline must not leave a pinned contract for prepareStep.
 * @param {object|null|undefined} execution
 */
export function unpinFrozenPlan(execution) {
  if (!execution || !execution.frozenPlan) return null;
  const prev = execution.frozenPlan;
  delete execution.frozenPlan;
  return prev;
}
