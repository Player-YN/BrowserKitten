/**
 * One-shot suggestion chips from a compact selection summary.
 * Not sendMessage / ToolLoopAgent — generateText, no tools.
 */

import { generateText } from '../adapters/vendor/ai-sdk-loader.mjs';

const MAX_CHIPS = 4;
const LABEL_MAX = 24;
const PROMPT_MAX = 400;

export function selectionSuggestSystem(lang = 'zh') {
  const zh = String(lang || '').toLowerCase().startsWith('zh');
  return [
    'Browser Kitten is a Chrome selection-first agent. The user already captured items on a live page.',
    'Suggest 2–4 next actions as chips. Clicking a chip sends that prompt as the user message.',
    'This product can deliver: a live spreadsheet, a real website, a document, image compose/generate, download of selected files, or cleaned extracted text.',
    'Do not suggest roaming other sites, mutating Selection Groups, or inventing facts not in the summary.',
    'Do not start a second file when one open canvas already matches the ask.',
    zh
      ? 'Reply in Chinese. JSON only: {"chips":[{"label":"按钮短句","prompt":"完整用户指令"}]}'
      : 'Reply in English. JSON only: {"chips":[{"label":"short button","prompt":"full user instruction"}]}',
    'label is a button (≤16 chars). prompt is one complete instruction the user would type.'
  ].join('\n');
}

export function parseSelectionSuggestChips(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.chips)
    ? parsed.chips
    : Array.isArray(parsed)
      ? parsed
      : [];
  const out = [];
  for (const row of list) {
    const label = String(row?.label || '')
      .replace(/\s+/g, ' ')
      .trim();
    const prompt = String(row?.prompt || '').trim();
    if (!label || !prompt) continue;
    out.push({ label: label.slice(0, LABEL_MAX), prompt: prompt.slice(0, PROMPT_MAX) });
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
}

/**
 * @param {{ model: any, selection?: object, generate?: typeof generateText, timeoutMs?: number }} opts
 * @returns {Promise<{label:string,prompt:string}[]>}
 */
export async function runSelectionSuggest(opts = {}) {
  const model = opts.model;
  if (!model) return [];
  const selection = opts.selection && typeof opts.selection === 'object' ? opts.selection : {};
  const lang = selection.lang || 'zh';
  const generate = opts.generate || generateText;
  const result = await generate({
    model,
    system: selectionSuggestSystem(lang),
    prompt: `Selection summary:\n${JSON.stringify(selection)}`,
    timeout: opts.timeoutMs || 8000,
    maxOutputTokens: 400
  });
  return parseSelectionSuggestChips(result?.text || '');
}
