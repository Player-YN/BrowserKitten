/**
 * Task titles: default 任务 N / Task N, then a short name from the first user prompt.
 * A user rename (titleLocked) always wins over auto-naming.
 */
import { BK_PURPOSE_HEADER } from '../../cloudModels.js';

export const SESSION_TITLE_MAX = 60;

export function normalizeSessionTitle(title) {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SESSION_TITLE_MAX);
}

export function isPlaceholderTaskTitle(title) {
  const t = String(title || '')
    .replace(/^💬\s*/, '')
    .trim();
  if (!t) return true;
  return /^(Session|会话|Task|任务)(\s*\d+)?$/i.test(t);
}

export function nextTaskTitle(existingTitles, lang = 'zh') {
  let max = 0;
  for (const raw of existingTitles || []) {
    const m = String(raw || '').match(/(?:任务|Task|会话|Session)\s*(\d+)/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  return lang === 'en' ? `Task ${n}` : `任务 ${n}`;
}

export function shrinkPromptTitle(text, max = 24) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function sanitizeGeneratedTitle(raw, fallback) {
  let t = String(raw || '')
    .replace(/^["'`「『]+|[\"'`」』.。!！?？]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.split('\n')[0].trim();
  if (!t || t.length > 40) return fallback;
  if (/^(sorry|error|as an|i am|我是|无法)/i.test(t)) return fallback;
  return t;
}

/**
 * Prefer a one-shot LanguageModel title. Tests / callModel stubs just shrink the prompt.
 * @param {{ model?: any, callModel?: Function, text?: string }} opts
 */
export async function generateTaskTitle(opts = {}) {
  const fallback = shrinkPromptTitle(opts.text) || '任务';
  if (typeof opts.callModel === 'function' || opts.model?.modelId === 'callModel-adapter') {
    return fallback;
  }
  const model = opts.model;
  if (!model || typeof model.doGenerate !== 'function') return fallback;
  const sys =
    'You name short browser-office tasks. Reply with ONLY the title. Max 16 Chinese characters or 6 English words. No quotes, no punctuation, no explanation.';
  try {
    const out = await model.doGenerate({
      prompt: [
        { role: 'system', content: [{ type: 'text', text: sys }] },
        { role: 'user', content: [{ type: 'text', text: String(opts.text || '').slice(0, 500) }] }
      ],
      maxOutputTokens: 32,
      headers: { [BK_PURPOSE_HEADER]: 'title' }
    });
    const parts = Array.isArray(out?.content) ? out.content : [];
    const joined = parts.map((p) => (p?.type === 'text' ? p.text : '')).join('');
    return sanitizeGeneratedTitle(joined || out?.text, fallback);
  } catch {
    return fallback;
  }
}
