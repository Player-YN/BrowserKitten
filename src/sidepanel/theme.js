/**
 * Theme: system | light | dark → resolved light|dark on body[data-theme]
 * Storage: browserbot_theme_mode.
 */

export const THEME_MODE_KEY = 'browserbot_theme_mode';

/** @typedef {'system'|'light'|'dark'} ThemeMode */
/** @typedef {'light'|'dark'} ResolvedTheme */

/** @type {ThemeMode} */
let themeMode = 'system';
/** @type {ResolvedTheme} */
let resolvedTheme = 'dark';
/** @type {((m: MediaQueryListEvent) => void)|null} */
let mediaListener = null;

/** @returns {ThemeMode} */
export function getThemeMode() {
  return themeMode;
}

/** @returns {ResolvedTheme} */
export function getResolvedTheme() {
  return resolvedTheme;
}

/** @returns {ResolvedTheme} */
export function resolveSystemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/**
 * @param {ThemeMode} mode
 * @param {{ skipStorage?: boolean }} [opts]
 * @returns {ResolvedTheme}
 */
export function applyThemeMode(mode, opts = {}) {
  const m = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system';
  themeMode = m;
  resolvedTheme = m === 'system' ? resolveSystemTheme() : m;
  // data-theme + color-scheme so native form controls / scrollbars match
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  document.documentElement.style.colorScheme = resolvedTheme;
  document.body.setAttribute('data-theme', resolvedTheme);
  document.body.style.colorScheme = resolvedTheme;
  document.body.dataset.themeMode = themeMode;
  syncThemeToggleUi();
  wireSystemListener();
  if (!opts.skipStorage) {
    try {
      chrome.storage.local.set({
        [THEME_MODE_KEY]: themeMode
      });
    } catch (_) {}
  }
  return resolvedTheme;
}

/** Cycle system → light → dark → system */
export function cycleThemeMode() {
  const order = /** @type {ThemeMode[]} */ (['system', 'light', 'dark']);
  const i = order.indexOf(themeMode);
  const next = order[(i + 1) % order.length];
  return applyThemeMode(next);
}

/**
 * @param {string} theme
 */
export function applyTheme(theme) {
  return applyThemeMode(theme === 'light' ? 'light' : 'dark');
}

function syncThemeToggleUi() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  const labels = {
    system: { icon: '◐', title: '主题：跟随系统（点按切换）' },
    light: { icon: '☀️', title: '主题：浅色（点按切换）' },
    dark: { icon: '🌙', title: '主题：深色（点按切换）' }
  };
  const L = labels[themeMode] || labels.system;
  btn.textContent = L.icon;
  btn.title = L.title;
  btn.setAttribute('aria-label', L.title);
  btn.dataset.themeMode = themeMode;
}

function wireSystemListener() {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mediaListener) {
      mq.removeEventListener('change', mediaListener);
      mediaListener = null;
    }
    if (themeMode === 'system') {
      mediaListener = () => {
        if (themeMode === 'system') applyThemeMode('system', { skipStorage: true });
      };
      mq.addEventListener('change', mediaListener);
    }
  } catch (_) {}
}

/**
 * Load from storage (call early in boot).
 * @param {Record<string, unknown>} stored chrome.storage.local result slice
 */
export function hydrateThemeFromStorage(stored = {}) {
  let mode = stored[THEME_MODE_KEY];
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
    mode = 'system';
  }
  applyThemeMode(/** @type {ThemeMode} */ (mode), { skipStorage: true });
}
