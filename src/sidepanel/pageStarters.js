/**
 * Page-aware starter prompts for the empty home screen: up to three tasks that fit the
 * tab in front of the user ("Export this table to Excel" on a page with a table).
 *
 * probePage runs inside the page (chrome.scripting.executeScript) and only counts
 * things; nothing from the page leaves the browser. pickStarters is pure.
 */

/** Injected into the page. Must be self-contained. */
export function probePage() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tables = [...document.querySelectorAll('table')].filter((t) => t.rows.length >= 3 && visible(t)).length;
  const grids = document.querySelectorAll('[role="grid"],[role="table"]').length;
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]),select,textarea')].filter(visible).length;
  const main = document.querySelector('article, main, [role="main"]') || document.body;
  const textLength = (main?.innerText || '').length;
  const listItems = document.querySelectorAll('li, [role="listitem"], [data-testid*="result"], .g, .result').length;
  const pdf = document.contentType === 'application/pdf';
  return { tables: tables + grids, inputs, textLength, listItems, pdf };
}

/** Pages where scripts cannot run or starters make no sense. */
export function isProbeableUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && !/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

const SEARCH_HOST = /(^|\.)(google|bing|duckduckgo|baidu|yahoo|yandex|sogou)\.[a-z.]+$/i;
const SEARCH_PATH = /[?&](q|query|wd|p|text)=/i;

/**
 * @param {{ tables?: number, inputs?: number, textLength?: number, listItems?: number, pdf?: boolean } | null} probe
 * @param {string} url
 * @param {(key: string) => string} t
 * @returns {{ id: string, label: string, prompt: string }[]}
 */
export function pickStarters(probe, url, t) {
  if (!isProbeableUrl(url)) return [];
  const p = probe || {};
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  const ids = [];
  const add = (id) => {
    if (!ids.includes(id)) ids.push(id);
  };
  if (host && SEARCH_HOST.test(host) && SEARCH_PATH.test(url)) add('compare-results');
  if ((p.tables || 0) > 0) add('table-to-sheet');
  if ((p.inputs || 0) >= 3) add('fill-form');
  if (p.pdf || (p.textLength || 0) > 2500) add('summarize');
  if ((p.listItems || 0) >= 30 && !(p.tables > 0) && !ids.includes('compare-results')) add('extract-list');
  // Always offer something on a real page.
  if (host) {
    add('summarize');
    add('extract-key-facts');
  }
  return ids.slice(0, 3).map((id) => ({
    id,
    label: t(`starter_${id.replace(/-/g, '_')}_label`),
    prompt: t(`starter_${id.replace(/-/g, '_')}_prompt`)
  }));
}

export const STARTER_IDS = Object.freeze([
  'compare-results',
  'table-to-sheet',
  'fill-form',
  'summarize',
  'extract-list',
  'extract-key-facts'
]);
