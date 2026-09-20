/**
 * BrowserBot user Skills — local persistence (chrome.storage.local)
 * Product persistence model: solidify successful workflows → re-run via Agent Runtime.
 */

export const SKILLS_STORAGE_KEY = 'browserbot_user_skills';
export const MAX_USER_SKILLS = 80;
export const MAX_SCRIPT_HINTS = 5;
export const MAX_SCRIPT_HINT_CHARS = 8000;

/**
 * @typedef {Object} UserSkill
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string|null} urlPattern
 * @property {string} promptTemplate
 * @property {string[]} preferredTools
 * @property {string[]} scriptHints
 * @property {string} lastTraceSummary
 * @property {string|null} sourceSessionId
 */

/** @returns {string} */
export function generateSkillId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `skill_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize / validate skill input into a UserSkill record.
 * Pure — no storage side effects.
 * @param {object} input
 * @param {UserSkill|null} [existing]
 * @returns {UserSkill}
 */
export function normalizeSkill(input = {}, existing = null) {
  const now = Date.now();
  const name = String(input.name || existing?.name || 'Untitled Skill').trim().slice(0, 80);
  const description = String(input.description || existing?.description || '').trim().slice(0, 500);
  const promptTemplate = String(
    input.promptTemplate || input.prompt_template || existing?.promptTemplate || ''
  )
    .trim()
    .slice(0, 4000);

  let preferredTools = input.preferredTools || input.preferred_tools || existing?.preferredTools || [];
  if (!Array.isArray(preferredTools)) preferredTools = [];
  preferredTools = preferredTools.map((t) => String(t).slice(0, 64)).filter(Boolean).slice(0, 20);

  let scriptHints = input.scriptHints || input.script_hints || existing?.scriptHints || [];
  if (!Array.isArray(scriptHints)) scriptHints = [];
  scriptHints = scriptHints
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => (s.length > MAX_SCRIPT_HINT_CHARS ? s.slice(0, MAX_SCRIPT_HINT_CHARS) + '…' : s))
    .slice(0, MAX_SCRIPT_HINTS);

  let urlPattern = input.urlPattern ?? input.url_pattern ?? existing?.urlPattern ?? null;
  if (urlPattern != null) {
    urlPattern = String(urlPattern).trim().slice(0, 300) || null;
  }

  const lastTraceSummary = String(
    input.lastTraceSummary || input.last_trace_summary || input.notes || existing?.lastTraceSummary || ''
  )
    .trim()
    .slice(0, 2000);

  return {
    id: existing?.id || input.id || generateSkillId(),
    name: name || 'Untitled Skill',
    description,
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
    urlPattern,
    promptTemplate: promptTemplate || name,
    preferredTools,
    scriptHints,
    lastTraceSummary,
    sourceSessionId: input.sourceSessionId ?? existing?.sourceSessionId ?? null
  };
}

/**
 * Build skill from a completed agent run snapshot (UI or save_skill tool).
 * @param {object} opts
 */
export function skillFromRunSnapshot({
  name,
  description,
  prompt,
  pageMeta = null,
  extractedCode = '',
  traces = [],
  sessionId = null,
  notes = ''
} = {}) {
  const preferredTools = [];
  const seen = new Set();
  for (const step of traces || []) {
    for (const tc of step.toolCalls || []) {
      if (tc?.name && !seen.has(tc.name) && tc.name !== 'finish' && tc.name !== 'save_skill') {
        seen.add(tc.name);
        preferredTools.push(tc.name);
      }
    }
  }

  const scriptHints = [];
  if (extractedCode && extractedCode.trim()) {
    scriptHints.push(extractedCode.trim());
  }

  const urlPattern = pageMeta?.domain
    ? pageMeta.domain
    : pageMeta?.url
      ? safeOrigin(pageMeta.url)
      : null;

  const lastTraceSummary =
    notes ||
    summarizeTraces(traces) ||
    (description || '').slice(0, 500);

  return normalizeSkill({
    name: name || deriveNameFromPrompt(prompt),
    description: description || deriveDescription(prompt, preferredTools),
    promptTemplate: prompt || '',
    preferredTools,
    scriptHints,
    urlPattern,
    lastTraceSummary,
    sourceSessionId: sessionId
  });
}

export function deriveNameFromPrompt(prompt) {
  const p = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!p) return 'Saved Skill';
  return p.length > 36 ? p.slice(0, 36) + '…' : p;
}

function deriveDescription(prompt, tools) {
  const p = String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const t = (tools || []).slice(0, 5).join(', ');
  if (p && t) return `${p} · tools: ${t}`;
  return p || (t ? `Tools: ${t}` : '');
}

export function summarizeTraces(traces) {
  if (!Array.isArray(traces) || !traces.length) return '';
  const parts = [];
  for (const step of traces.slice(0, 12)) {
    const names = (step.toolCalls || []).map((c) => c.name).filter(Boolean);
    if (names.length) parts.push(`step${step.step}: ${names.join(', ')}`);
  }
  return parts.join(' → ').slice(0, 500);
}

export function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Compact list for list_skills / UI cards.
 * @param {UserSkill[]} skills
 * @param {{ host?: string|null, limit?: number }} [opts]
 */
export function listSkillsCompact(skills, opts = {}) {
  const limit = opts.limit || 50;
  let list = Array.isArray(skills) ? [...skills] : [];
  if (opts.host) {
    const host = opts.host.toLowerCase();
    list.sort((a, b) => {
      const as = skillMatchesHost(a, host) ? 0 : 1;
      const bs = skillMatchesHost(b, host) ? 0 : 1;
      if (as !== bs) return as - bs;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return list.slice(0, limit).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    urlPattern: s.urlPattern,
    updatedAt: s.updatedAt,
    hasScriptHint: !!(s.scriptHints && s.scriptHints.length)
  }));
}

export function skillMatchesHost(skill, host) {
  if (!skill?.urlPattern || !host) return false;
  const p = String(skill.urlPattern).toLowerCase();
  const h = String(host).toLowerCase();
  return p === h || p.includes(h) || h.includes(p.replace(/^https?:\/\//, '').split('/')[0]);
}

/**
 * Find by id or name (case-insensitive name).
 * @param {UserSkill[]} skills
 * @param {string} idOrName
 * @returns {UserSkill|null}
 */
export function findSkill(skills, idOrName) {
  if (!idOrName || !Array.isArray(skills)) return null;
  const q = String(idOrName).trim();
  const byId = skills.find((s) => s.id === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  return skills.find((s) => (s.name || '').toLowerCase() === lower) || null;
}

/**
 * Build prompt + **user-side** skill context for re-running a skill.
 * Skill recipes are dynamic context (not system constitution) so system stays cache-stable.
 *
 * Skill `description` should be outcome-oriented (what / where), 1–2 sentences, no secrets.
 *
 * @param {UserSkill} skill
 * @returns {{ prompt: string, skillContext: string, skillSystemAppendix: string }}
 *   skillSystemAppendix is always '' (legacy alias); use skillContext on the user turn.
 */
export function buildSkillRunPrompt(skill) {
  if (!skill) {
    return { prompt: '', skillContext: '', skillSystemAppendix: '' };
  }

  const prompt =
    skill.promptTemplate ||
    skill.name ||
    'Execute the saved Browser Kitten skill on the current page.';

  // User-turn recipe: compact, actionable; no permission expansion claims
  const lines = [
    'Reusable procedure for this run only. Does not expand tools or permissions.',
    `name: ${skill.name}`,
    skill.description ? `outcome: ${skill.description}` : '',
    skill.urlPattern ? `site_hint: ${skill.urlPattern}` : '',
    skill.preferredTools?.length
      ? `preferred_tools: ${skill.preferredTools.join(', ')} (use when still relevant)`
      : '',
    skill.lastTraceSummary ? `prior_notes: ${skill.lastTraceSummary}` : '',
    skill.scriptHints?.length
      ? `script_hints (reference only; prefer structured tools; adapt if DOM changed):\n${skill.scriptHints
          .map((h, i) => `  --- hint ${i + 1} ---\n${h}`)
          .join('\n')}`
      : '',
    'Execute end-to-end on the LIVE page with registered tools. Adapt selectors if the DOM changed. Call finish when done.'
  ].filter(Boolean);

  const skillContext = lines.join('\n');

  return {
    prompt,
    skillContext,
    /** @deprecated always empty — skill is injected on user turn */
    skillSystemAppendix: ''
  };
}

// ── chrome.storage.local I/O ──

function storageGet(keys) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve({});
      return;
    }
    chrome.storage.local.get(keys, (res) => resolve(res || {}));
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      reject(new Error('chrome.storage.local unavailable'));
      return;
    }
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/** @returns {Promise<UserSkill[]>} */
export async function loadUserSkills() {
  const res = await storageGet([SKILLS_STORAGE_KEY]);
  const arr = res[SKILLS_STORAGE_KEY];
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => normalizeSkill(s, s)).filter((s) => s.id && s.name);
}

/** @param {UserSkill[]} skills */
export async function saveUserSkills(skills) {
  const capped = (Array.isArray(skills) ? skills : []).slice(-MAX_USER_SKILLS);
  await storageSet({ [SKILLS_STORAGE_KEY]: capped });
  return capped;
}

/**
 * Upsert a skill (by id).
 * @param {object|UserSkill} input
 * @returns {Promise<UserSkill>}
 */
export async function upsertUserSkill(input) {
  const skills = await loadUserSkills();
  const existing = input.id ? skills.find((s) => s.id === input.id) : null;
  const skill = normalizeSkill(input, existing || null);
  const next = existing
    ? skills.map((s) => (s.id === skill.id ? skill : s))
    : [...skills, skill];
  await saveUserSkills(next);
  return skill;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteUserSkill(id) {
  const skills = await loadUserSkills();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  await saveUserSkills(next);
  return true;
}
