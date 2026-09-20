/**
 * /learn first wave: methodology playbook from the agent's own successful turn.
 * Sanitize before the drafting model. Persist only after a plan-card confirm.
 * Learned skills stay on browserbot_durable_skills via skillStore.
 */

import { newClarifyId, waitForClarifyAnswer } from './clarifyGate.js';
import { classifyPlanDecision, normalizePlan } from './planContract.js';
import { pathFromToolCalls } from './behaviorPath.js';
import {
  getDurableSkillStore,
  normalizeDurableSkill,
  sanitizeSkillId
} from './skillStore.js';
import { isAbortLike } from '../host/userStop.js';

export const LEARN_NO_TRAJECTORY_ZH = '没有可学习的成功回合。先完成一轮真正做成的事，再 /learn。';
export const LEARN_NO_TRAJECTORY_EN =
  'No learnable successful turn. Finish a real successful turn, then /learn.';
export const LEARN_REUSE_DENIED = 'LEARN_REUSE_DENIED';

const ACTION_TOOLS = new Set(['action', 'run', 'sheet', 'doc', 'web']);
const DROP_KEYS = new Set([
  'value',
  'fields',
  'thought',
  'ref',
  'rev',
  'selector',
  'css',
  'xpath',
  'clientx',
  'clienty',
  'pagex',
  'pagey',
  'offsetx',
  'offsety',
  'password',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'secret',
  'bytes',
  'base64',
  'chunks',
  'code'
]);
const FORBIDDEN_SKILL_KEYS = [
  'antipatterns',
  'anti_patterns',
  'antipattern',
  'pitfalls',
  'pitfall',
  'knownissues',
  'known_issues',
  'knownproblems',
  'mistakes',
  'donts',
  'warnings',
  'cavesats',
  'caveats'
];
const SECRET_RE = /(sk-[a-zA-Z0-9]{8,}|AKIA[0-9A-Z]{8,}|bearer\s+[a-z0-9._-]+|password\s*[:=])/i;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/;
const UNSTABLE_SELECTOR_RE = /nth-child|nth-of-type|\/html\/body|#\S{12,}|css-[a-z0-9]{6,}/i;

export function userRequestedLearn(input = {}) {
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];
  for (const m of mentions) {
    const id = String(m?.id || m?.handle || '').trim().toLowerCase();
    const label = String(m?.label || '').trim().toLowerCase();
    if (m?.kind === 'command' && (id === 'learn' || label === 'learn')) return true;
    if (id === 'learn' && (m?.kind === 'command' || m?.kind === 'skill')) return true;
  }
  return /(^|[\s\u00a0])\/learn\b/i.test(String(input.content || ''));
}

export function isLearnedSkill(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return rec.origin === 'learned' || rec.learned === true;
}

export function learnedReuseBlocked(rec) {
  return isLearnedSkill(rec) && rec.reuseConfirmed !== true;
}

export function extractLearnableTurn(session, opts = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const skipId = String(opts.skipMessageId || '');
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || row.role !== 'assistant') continue;
    if (skipId && String(row.messageId || '') === skipId) continue;
    if (row.status && row.status !== 'completed') continue;
    const path = Array.isArray(row.path) && row.path.length
      ? row.path
      : pathFromToolCalls(row.toolCalls);
    if (!turnHasSuccessfulAction(path)) continue;
    let user = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j]?.role === 'user') {
        user = messages[j];
        break;
      }
    }
    return { message: row, path, user };
  }
  return null;
}

function turnHasSuccessfulAction(path) {
  return (Array.isArray(path) ? path : []).some((ev) => {
    if (ev?.type !== 'tool-result') return false;
    if (ev.ok === false) return false;
    return ACTION_TOOLS.has(String(ev.tool || ev.name || ''));
  });
}

export function sanitizeLearnTrajectory(turn) {
  const path = Array.isArray(turn?.path) ? turn.path : [];
  const steps = [];
  for (const ev of path) {
    const type = String(ev?.type || '');
    if (type === 'thought') continue;
    if (type !== 'tool-call' && type !== 'tool-result') continue;
    const tool = String(ev.tool || ev.name || '');
    const cleaned = {
      type,
      tool,
      ok: ev.ok
    };
    if (type === 'tool-call') {
      cleaned.args = sanitizeValue(ev.args || ev.input || {});
    } else {
      cleaned.result = sanitizeValue(ev.result || ev.output || {});
    }
    steps.push(cleaned);
  }
  return {
    userGoal: sanitizeText(turn?.user?.content || ''),
    steps
  };
}

function sanitizeText(raw) {
  let s = String(raw || '');
  if (SECRET_RE.test(s)) s = s.replace(SECRET_RE, '[redacted]');
  if (CARD_RE.test(s)) s = s.replace(CARD_RE, '[redacted]');
  return s.slice(0, 2000);
}

function sanitizeValue(value, key = '') {
  if (value == null) return value;
  const k = String(key || '').toLowerCase();
  if (DROP_KEYS.has(k)) return undefined;
  if (k === 'x' || k === 'y') return undefined;
  if (typeof value === 'string') {
    if (SECRET_RE.test(value)) return '[redacted]';
    if (UNSTABLE_SELECTOR_RE.test(value)) return undefined;
    return value.slice(0, 240);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (k === 'x' || k === 'y') return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      const next = sanitizeValue(child, childKey);
      if (next !== undefined) out[childKey] = next;
    }
    return out;
  }
  return undefined;
}

export function stripForbiddenLearnFields(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return {};
  const out = { ...draft };
  for (const key of Object.keys(out)) {
    const compact = key.toLowerCase().replace(/[\s_-]/g, '');
    if (FORBIDDEN_SKILL_KEYS.some((bad) => compact === bad.replace(/_/g, '') || compact.includes(bad.replace(/_/g, '')))) {
      delete out[key];
    }
  }
  delete out.antiPatterns;
  delete out.pitfalls;
  delete out.knownIssues;
  return out;
}

export function normalizeLearnedDraft(raw) {
  const draft = stripForbiddenLearnFields(raw && typeof raw === 'object' ? raw : {});
  const taskClass = String(draft.taskClass || draft.task_class || draft.id || '')
    .trim()
    .slice(0, 80);
  const name = String(draft.name || taskClass || 'learned method').trim().slice(0, 80);
  const description = String(draft.description || draft.applicability || '').trim().slice(0, 500);
  const applicability = String(draft.applicability || description).trim().slice(0, 800);
  const routes = normalizeRoutes(draft.routes || draft.capabilityRoutes);
  const criteria = asStringList(draft.criteria || draft.successCriteria);
  const steps = normalizeLearnSteps(draft.steps);
  const discovery = String(draft.discovery || draft.discoveryProcedure || '').trim().slice(0, 2000);
  const parameterization = String(draft.parameterization || '').trim().slice(0, 1200);
  if (!taskClass || !description || !routes.length || !discovery) return null;
  return {
    taskClass,
    name,
    description,
    applicability,
    routes,
    criteria,
    steps,
    discovery,
    parameterization
  };
}

function normalizeRoutes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const capability = String(row.capability || row.tool || row.route || '').trim().slice(0, 80);
    if (!capability) continue;
    const key = capability.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = String(row.kind || row.role || 'fallback').toLowerCase() === 'preferred'
      ? 'preferred'
      : 'fallback';
    out.push({
      kind,
      capability,
      why: String(row.why || row.reason || '').trim().slice(0, 240)
    });
  }
  return out;
}

function normalizeLearnSteps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list.slice(0, 12)) {
    if (!row || typeof row !== 'object') continue;
    const intent = String(row.intent || row.title || '').trim().slice(0, 160);
    if (!intent) continue;
    out.push({
      intent,
      locate: String(row.locate || row.locateStrategy || '').trim().slice(0, 200),
      postcondition: String(row.postcondition || row.after || '').trim().slice(0, 200)
    });
  }
  return out;
}

function asStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 8);
}

export function learnedPlaybookMarkdown(draft) {
  const d = normalizeLearnedDraft(draft);
  if (!d) return '';
  const lines = [
    `# Task class`,
    d.taskClass,
    '',
    `# When this applies`,
    d.applicability,
    '',
    `# Capability routes`,
    ...d.routes.map((r) => `- ${r.kind}: ${r.capability}${r.why ? ` — ${r.why}` : ''}`),
    '',
    `# Success criteria`,
    ...(d.criteria.length ? d.criteria.map((c) => `- ${c}`) : ['- Visible page or artifact change, not merely tool ok']),
    '',
    `# Steps`,
    ...d.steps.map((s, i) => `${i + 1}. ${s.intent}${s.locate ? ` / locate: ${s.locate}` : ''}${s.postcondition ? ` / after: ${s.postcondition}` : ''}`),
    '',
    `# Discovery`,
    d.discovery,
    '',
    `# Parameterize`,
    d.parameterization || 'Keep intents and locate strategies. Do not persist ref, rev, coordinates, or fragile CSS.'
  ];
  return lines.join('\n');
}

export function parseCapabilityRoutes(markdown) {
  const text = String(markdown || '');
  const out = [];
  const re = /^-\s*(preferred|fallback):\s*([^—\n]+)(?:—\s*(.*))?$/gim;
  let match;
  while ((match = re.exec(text))) {
    out.push({
      kind: match[1].toLowerCase(),
      capability: match[2].trim(),
      why: String(match[3] || '').trim()
    });
  }
  return normalizeRoutes(out);
}

export function mergeSameClassLearnedSkill(existing, incoming) {
  const next = normalizeLearnedDraft(incoming);
  if (!next) return null;
  const prevRoutes = isLearnedSkill(existing)
    ? parseCapabilityRoutes(existing.instructions)
    : [];
  const mergedRoutes = normalizeRoutes([
    ...prevRoutes.filter((r) => r.capability),
    ...next.routes
  ]);
  const discovery = [existing && parseDiscovery(existing.instructions), next.discovery]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000) || next.discovery;
  return normalizeLearnedDraft({
    ...next,
    name: existing?.name || next.name,
    description: next.description || existing?.description,
    routes: mergedRoutes,
    discovery
  });
}

function parseDiscovery(markdown) {
  const text = String(markdown || '');
  const idx = text.search(/^#\s*Discovery\b/im);
  if (idx < 0) return '';
  const rest = text.slice(idx).split(/\n#\s+/)[0];
  return rest.replace(/^#\s*Discovery\b\s*/i, '').trim();
}

export function sameTaskClass(a, b) {
  return String(a || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '') ===
    String(b || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
}

export function learnedSkillId(taskClass) {
  return sanitizeSkillId(`learn-${taskClass}`) || 'learn-method';
}

export async function findSameClassLearnedSkill(taskClass) {
  const list = await getDurableSkillStore().list();
  return list.find((rec) => isLearnedSkill(rec) && sameTaskClass(rec.taskClass, taskClass)) || null;
}

export function coerceLearnDraft(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return parseJsonObject(raw);
  if (typeof raw !== 'object') return null;
  if (raw.draft && typeof raw.draft === 'object') return stripForbiddenLearnFields(raw.draft);
  if (raw.text) return parseJsonObject(raw.text);
  if (Array.isArray(raw.content)) {
    const text = raw.content.map((p) => (p?.type === 'text' ? p.text : '')).join('');
    return parseJsonObject(text);
  }
  return stripForbiddenLearnFields(raw);
}

function parseJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function draftLearnedPlaybook(sanitized, opts = {}) {
  const payload = {
    purpose: 'learn-draft',
    sanitizedTrajectory: sanitized
  };
  let raw = null;
  if (typeof opts.callModel === 'function') {
    raw = await opts.callModel({
      ...payload,
      messages: [{ role: 'user', content: learnDraftPrompt(sanitized) }]
    });
  } else if (opts.model && typeof opts.model.doGenerate === 'function') {
    const out = await opts.model.doGenerate({
      prompt: [
        { role: 'system', content: [{ type: 'text', text: LEARN_DRAFT_SYS }] },
        { role: 'user', content: [{ type: 'text', text: learnDraftPrompt(sanitized) }] }
      ]
    });
    raw = out;
  } else {
    const err = new Error('NO_MODEL: /learn needs a model to draft the playbook.');
    err.code = 'NO_MODEL';
    throw err;
  }
  return normalizeLearnedDraft(coerceLearnDraft(raw));
}

const LEARN_DRAFT_SYS =
  'Draft a methodology playbook as JSON only. No anti-patterns, pitfalls, known issues, secrets, fill values, ref, rev, coordinates, or fragile CSS.';

function learnDraftPrompt(sanitized) {
  return [
    'Draft JSON with keys: taskClass, name, description, applicability, routes (kind preferred|fallback, capability, why), criteria, steps (intent, locate, postcondition), discovery, parameterization.',
    'Preferred-route failure must still allow discovery.',
    'Sanitized trajectory follows. It is already redacted — do not restore dropped fields.',
    JSON.stringify(sanitized)
  ].join('\n');
}

export async function persistLearnedSkill(draft, existing = null) {
  const merged = existing ? mergeSameClassLearnedSkill(existing, draft) : normalizeLearnedDraft(draft);
  if (!merged) return { ok: false, code: 'BAD_INPUT', error: 'learn draft is not persistable' };
  const id = existing?.id || learnedSkillId(merged.taskClass);
  const rec = normalizeDurableSkill({
    id,
    name: merged.name,
    description: merged.description,
    instructions: learnedPlaybookMarkdown(merged),
    origin: 'learned',
    taskClass: merged.taskClass,
    reuseConfirmed: false,
    learned: true
  });
  rec.taskClass = merged.taskClass;
  rec.reuseConfirmed = false;
  rec.learned = true;
  const saved = await getDurableSkillStore().upsert(rec);
  return { ok: true, skill: saved, merged: !!existing };
}

export async function markLearnedReuseConfirmed(skillId) {
  const store = getDurableSkillStore();
  const rec = await store.get(skillId);
  if (!rec || !isLearnedSkill(rec)) return { ok: false, code: 'NOT_FOUND', error: 'learned skill not found' };
  const saved = await store.upsert({
    ...rec,
    origin: 'learned',
    learned: true,
    taskClass: rec.taskClass,
    reuseConfirmed: true
  });
  saved.reuseConfirmed = true;
  saved.learned = true;
  saved.taskClass = rec.taskClass;
  return { ok: true, skill: saved };
}

export async function yieldLearnPlanConfirm({
  sessionId,
  plan,
  onEvent,
  signal,
  waitForClarify = waitForClarifyAnswer
} = {}) {
  const normalized = normalizePlan(plan);
  if (!normalized) return { kind: 'unknown', notes: '' };
  const clarifyId = newClarifyId();
  const waiting = waitForClarify({ clarifyId, sessionId, questions: [], signal });
  if (typeof onEvent === 'function') {
    onEvent({
      type: 'clarify',
      sessionId,
      clarifyId,
      kind: 'plan',
      plan: normalized,
      questions: []
    });
  }
  try {
    const answers = await waiting;
    const classified = classifyPlanDecision(answers);
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'clarify-done',
        sessionId,
        clarifyId,
        kind: 'plan',
        approved: classified.kind === 'approved',
        decision: classified.kind,
        answers
      });
    }
    return classified;
  } catch (error) {
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'clarify-done',
        sessionId,
        clarifyId,
        kind: 'plan',
        aborted: true
      });
    }
    throw error;
  }
}

export function learnConfirmPlan(draft, { reuse = false } = {}) {
  const d = normalizeLearnedDraft(draft) || draft;
  const title = reuse
    ? `复用「${d.taskClass || d.name || 'learned'}」`
    : `学会「${d.taskClass || d.name || 'learned'}」`;
  const steps = [
    ...(Array.isArray(d.routes) ? d.routes.map((r) => ({
      title: `${r.kind === 'preferred' ? '首选' : '备选'} ${r.capability}`,
      detail: r.why || ''
    })) : []),
    {
      title: '发现程序仍可用',
      detail: String(d.discovery || '').slice(0, 200)
    }
  ].filter((s) => s.title);
  return {
    title: String(title).slice(0, 80),
    summary: String(d.description || d.applicability || '').slice(0, 400),
    steps: steps.length ? steps : [{ title: '保存方法论 skill', detail: '' }]
  };
}

export async function runLearnTurn({
  store,
  sessionId,
  execution,
  signal,
  callModel,
  model,
  onEvent,
  lang = 'zh',
  waitForClarify = waitForClarifyAnswer
} = {}) {
  const session = store.get('sessions', sessionId);
  const turn = extractLearnableTurn(session, { skipMessageId: execution?.messageId });
  if (!turn) {
    const text = String(lang).toLowerCase().startsWith('en')
      ? LEARN_NO_TRAJECTORY_EN
      : LEARN_NO_TRAJECTORY_ZH;
    return { ok: false, code: 'LEARN_NO_TRAJECTORY', finalText: text, wrote: false };
  }
  const sanitized = sanitizeLearnTrajectory(turn);
  const draft = await draftLearnedPlaybook(sanitized, { callModel, model });
  if (!draft) {
    return {
      ok: false,
      code: 'LEARN_DRAFT_INVALID',
      finalText: '模型起草的方法论不可用，未写入 skill。',
      wrote: false
    };
  }
  const existing = await findSameClassLearnedSkill(draft.taskClass);
  let classified;
  try {
    classified = await yieldLearnPlanConfirm({
      sessionId,
      plan: learnConfirmPlan(draft, { reuse: false }),
      onEvent,
      signal,
      waitForClarify
    });
  } catch (error) {
    if (isAbortLike(error, signal)) {
      return {
        ok: true,
        wrote: false,
        code: 'LEARN_CANCELLED',
        finalText: '未确认，未写入 skill。',
        decision: 'cancelled'
      };
    }
    throw error;
  }
  if (classified.kind !== 'approved') {
    return {
      ok: true,
      code: classified.kind === 'declined' ? 'LEARN_REJECTED' : 'LEARN_CANCELLED',
      finalText: classified.kind === 'declined' ? '已取消，未写入 skill。' : '未确认，未写入 skill。',
      wrote: false,
      decision: classified.kind
    };
  }
  const saved = await persistLearnedSkill(draft, existing);
  return {
    ok: true,
    wrote: saved.ok === true,
    merged: saved.merged === true,
    skill: saved.skill,
    finalText: saved.merged
      ? `已并入已有「${draft.taskClass}」方法论。第一次复用仍会先出计划卡。`
      : `已保存方法论 skill「${saved.skill?.name || draft.taskClass}」。第一次复用会先出计划卡。`
  };
}

export function learnNoWrite(result) {
  return !result || result.wrote !== true;
}
