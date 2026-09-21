/**
 * Work-tab policy — pure helpers (silent open + one Chrome tab group per session).
 * Chrome I/O stays in background.js.
 */

export const WORK_PAGE_FILES = Object.freeze([
  'docs.html',
  'site.html',
  'artifactPreview.html',
  'preview.html'
]);

/** Live office canvases the agent may lock. Never live web / picker / artifactPreview. */
export const LOCKABLE_PAGE_FILES = Object.freeze([
  'docs.html',
  'site.html'
]);

export const TAB_GROUP_COLORS = Object.freeze([
  'blue',
  'cyan',
  'green',
  'purple',
  'orange',
  'pink',
  'yellow',
  'red'
]);

const GROUP_TITLE_MAX = 50;

export function workPageFile(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  let pathname = raw.split('#')[0].split('?')[0];
  try {
    pathname = new URL(raw).pathname;
  } catch {
    /* keep stripped path */
  }
  const file = pathname.split('/').pop() || '';
  return WORK_PAGE_FILES.includes(file) ? file : '';
}

export function isBrowserBotPageUrl(url) {
  if (!workPageFile(url)) return false;
  const raw = String(url || '');
  return /^chrome-extension:/i.test(raw) || /\/src\/preview\//.test(raw);
}

export function isLockableWorkPageUrl(url) {
  const file = workPageFile(url);
  if (!LOCKABLE_PAGE_FILES.includes(file)) return false;
  return isBrowserBotPageUrl(url);
}

/**
 * Session-scoped work-tab lock. Live web / huaban / picker / preview.html never lock.
 * Empty sessionId or a mismatched lockedSessionId stays unlocked.
 */
export function shouldLockWorkTab(opts = {}) {
  const lockedSid = String(opts.lockedSessionId || '').trim();
  if (!lockedSid) return false;
  const url = String(opts.url || '');
  if (!isLockableWorkPageUrl(url)) return false;
  const sid = String(opts.sessionId || sessionIdFromBrowserBotUrl(url) || '').trim();
  return sid === lockedSid;
}

export function sessionIdFromBrowserBotUrl(url) {
  const raw = String(url || '');
  try {
    return String(new URL(raw).searchParams.get('sessionId') || '').trim();
  } catch {
    const m = raw.match(/[?&]sessionId=([^&#]*)/);
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return String(m[1] || '').trim();
    }
  }
}

/**
 * Agent / preview / canvas writes default to silent.
 * User sidepanel open and reveal-on-page stay focused.
 * Explicit `focus` always wins.
 */
export function shouldFocusBrowserBotTab(opts = {}) {
  if (opts.focus === true) return true;
  if (opts.focus === false) return false;
  const reason = String(opts.reason || opts.source || '').toLowerCase();
  return reason === 'user' || reason === 'reveal';
}

/**
 * Capture-page reveal never joins. Empty sessionId never groups.
 * Live-web URLs stay out of the session group.
 */
export function shouldJoinSessionGroup(opts = {}) {
  const reason = String(opts.reason || opts.source || '').toLowerCase();
  if (reason === 'reveal') return false;
  const sid = String(opts.sessionId || sessionIdFromBrowserBotUrl(opts.url) || '').trim();
  if (!sid) return false;
  const url = String(opts.url || '');
  if (url && !isBrowserBotPageUrl(url)) return false;
  return true;
}

export function tabCreateProps({ url, focus } = {}) {
  return { url: String(url || ''), active: focus === true };
}

/** Agent/preview/canvas writes must never call chrome.windows.update({ focused: true }). */
export function shouldFocusChromeWindow() {
  return false;
}

export function sessionTaskIndex(opts = {}) {
  const n = Number(opts.index);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const fromTitle = String(opts.title || opts.name || '').match(/(?:任务|Task|会话|Session)\s*(\d+)/i);
  if (fromTitle) return Number(fromTitle[1]);
  const fromSid = String(opts.sessionId || '').match(/(\d+)\s*$/);
  if (fromSid) return Number(fromSid[1]);
  return 1;
}

export function sessionGroupTitle(opts = {}) {
  const sid = String(opts.sessionId || '').trim();
  const explicit = String(opts.title || opts.name || '')
    .replace(/^💬\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (explicit && explicit !== sid) return clipGroupTitle(explicit);
  const n = sessionTaskIndex(opts);
  return opts.lang === 'en' ? `Task ${n}` : `任务 ${n}`;
}

export function sessionGroupColor(sessionId) {
  const s = String(sessionId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  return TAB_GROUP_COLORS[h % TAB_GROUP_COLORS.length];
}

export function sessionGroupUpdate(opts = {}) {
  return {
    title: sessionGroupTitle(opts),
    color: sessionGroupColor(opts.sessionId),
    collapsed: opts.collapsed !== false
  };
}

function clipGroupTitle(title) {
  const t = String(title || '').trim();
  if (t.length <= GROUP_TITLE_MAX) return t;
  return `${t.slice(0, GROUP_TITLE_MAX - 1)}…`;
}
