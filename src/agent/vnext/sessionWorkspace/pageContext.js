/**
 * Current-tab document identity for the session world.
 * Not a SelectionGroup: URL/title/origin only. Host injects each turn.
 */

export const PAGES_MENTION_ID = '__pages__';
export const VISITED_PAGES_MAX = 20;

export function isHttpPageUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isInjectableTabUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (/^(chrome|edge|about|chrome-error|chrome-extension|devtools|moz-extension):/i.test(s)) {
    return false;
  }
  return isHttpPageUrl(s);
}

/** Same injectability gate as action NEED_PAGE (skip Web Store + view-source). */
export function isMentionablePageUrl(url) {
  const s = String(url || '').trim();
  if (!s || /^view-source:/i.test(s)) return false;
  if (!isInjectableTabUrl(s)) return false;
  try {
    const parsed = new URL(s);
    const host = parsed.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com') return false;
    if (host === 'chrome.google.com' && /\/webstore\b/.test(parsed.pathname)) return false;
  } catch {
    return false;
  }
  return true;
}

const WORK_TAB_RE = /\/src\/preview\/(design|site|sheet|docs|artifactPreview)\.html/i;

/**
 * Extension preview tabs. Not live-web inject targets.
 * @returns {'design'|'slides'|'site'|'sheet'|'docs'|'preview'|null}
 */
export function classifyWorkTab(url) {
  const s = String(url || '');
  const m = WORK_TAB_RE.exec(s);
  if (!m) return null;
  const file = String(m[1] || '').toLowerCase();
  if (file === 'design') return /(?:\?|&)shell=slides\b/i.test(s) ? 'slides' : 'design';
  if (file === 'artifactpreview') return 'preview';
  return file;
}

export function isBrowserBotTabUrl(url) {
  return classifyWorkTab(url) != null;
}

export function workTabListenLabel(kind, lang) {
  const en = lang === 'en';
  const k = String(kind || '');
  if (k === 'slides') return en ? 'Slides' : '幻灯';
  if (k === 'design') return en ? 'Design' : '画板';
  if (k === 'site') return en ? 'Site' : '网页';
  if (k === 'sheet') return en ? 'Sheet' : '表格';
  if (k === 'docs') return en ? 'Docs' : '文档';
  if (k === 'preview') return en ? 'Preview' : '预览';
  return en ? 'Editor' : '编辑器';
}

/**
 * @param {{ url?: string, href?: string, title?: string, origin?: string }} [raw]
 * @returns {{ url: string, title: string, origin: string, host: string }|null}
 */
export function normalizePageRef(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || raw.href || '').trim();
  if (!isHttpPageUrl(url)) return null;
  let origin = String(raw.origin || '');
  let host = '';
  try {
    const u = new URL(url);
    origin = origin || u.origin;
    host = u.hostname;
  } catch {
    return null;
  }
  const title = String(raw.title || host || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    url: url.slice(0, 2000),
    title: title || host,
    origin,
    host
  };
}

export function pageRefId(page) {
  const tabId = Number(page?.tabId);
  if (Number.isFinite(tabId) && tabId > 0) return `page:tab:${tabId}`;
  const ref = normalizePageRef(page);
  if (!ref) return '';
  return (`page:${ref.url}`).slice(0, 96);
}

export function compactPageRef(page) {
  const ref = normalizePageRef(page);
  if (!ref) return null;
  return { url: ref.url, title: ref.title, origin: ref.origin, host: ref.host };
}

function pageFromMention(m) {
  if (!m || typeof m !== 'object') return null;
  const kind = String(m.kind || '');
  const id = String(m.id || '');
  if (kind !== 'page' && !id.startsWith('page:')) return null;
  const url = String(m.url || '').trim() || (id.startsWith('page:tab:') ? '' : id.replace(/^page:/, ''));
  return normalizePageRef({ url, title: m.label || m.title, origin: m.origin });
}

/**
 * Default focus is the live tab. An @ page mention overrides for this turn.
 * @returns {{ activeTab: object|null, focusPage: object|null, overridden: boolean }}
 */
export function resolveFocusPage({ activeTab, mentions } = {}) {
  const active = normalizePageRef(activeTab);
  const list = Array.isArray(mentions) ? mentions : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const hit = pageFromMention(list[i]);
    if (hit) return { activeTab: active, focusPage: hit, overridden: true };
  }
  return { activeTab: active, focusPage: active, overridden: false };
}

export function rememberVisitedPage(store, sessionId, page) {
  const ref = compactPageRef(page);
  if (!ref || !store || typeof store.get !== 'function') return [];
  const sess = store.get('sessions', sessionId);
  if (!sess) return [];
  const prev = Array.isArray(sess.visitedPages) ? sess.visitedPages : [];
  const next = [ref, ...prev.filter((p) => p && p.url !== ref.url)].slice(0, VISITED_PAGES_MAX);
  store.put('sessions', sessionId, { ...sess, visitedPages: next, updatedAt: Date.now() });
  return next;
}

export function listVisitedPages(store, sessionId) {
  const sess = store && typeof store.get === 'function' ? store.get('sessions', sessionId) : null;
  const raw = Array.isArray(sess?.visitedPages) ? sess.visitedPages : [];
  return raw.map((p) => compactPageRef(p)).filter(Boolean);
}
