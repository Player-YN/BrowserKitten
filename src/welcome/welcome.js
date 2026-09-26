// First-install welcome tab (background.js opens it on onInstalled reason "install").
// Pin the icon, open the side panel, sign in for trial credits, and optionally turn on
// page scripts. Every step can be skipped; nothing here is required to use the panel.
import { fetchCloudAccount, getCloudAccount, signInWithBrowserKitten } from '../agent/cloudAccount.js';
import { translate } from '../sidepanel/i18n.js';
import { tasksFor } from '../sidepanel/accountMenu.js';
import { openExtensionDetails, pageScriptsState, requestPageScripts } from '../sidepanel/pageScripts.js';
import { THEME_MODE_KEY, hydrateThemeFromStorage } from '../sidepanel/theme.js';

const $ = (id) => document.getElementById(id);
let lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
const t = (key) => translate(lang, key);
const num = (n) => Number(n || 0).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN');
let windowId = null;

function applyI18n() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
}

function say(el, text) {
  el.hidden = !text;
  el.textContent = text || '';
}

function markDone(stepId, done = true) {
  $(stepId)?.classList.toggle('is-done', done);
}

async function renderAccount() {
  const acct = await getCloudAccount();
  if (!acct) return;
  let info = null;
  try {
    info = await fetchCloudAccount();
  } catch {
    info = null;
  }
  markDone('stepSignIn');
  $('signInBtn').hidden = true;
  say(
    $('signInStatus'),
    info?.signedIn && !info.expired
      ? t('welcomeSignedIn').replace('{email}', info.email || '').replace('{credits}', num(info.credits)).replace('{n}', num(tasksFor(info.credits)))
      : t('welcomeSignedInShort')
  );
}

async function renderScripts() {
  const state = await pageScriptsState();
  $('scriptsBtn').hidden = state !== 'off';
  $('detailsBtn').hidden = state !== 'needs-toggle';
  $('toggleHelp').hidden = state !== 'needs-toggle';
  $('skipScriptsBtn').hidden = state === 'on';
  say($('scriptsStatus'), state === 'on' ? t('welcomeScriptsOn') : '');
  markDone('stepScripts', state === 'on');
}

async function boot() {
  const stored = await chrome.storage.local.get(['app_lang', THEME_MODE_KEY]).catch(() => ({}));
  if (stored.app_lang === 'en' || stored.app_lang === 'zh') lang = stored.app_lang;
  hydrateThemeFromStorage(stored);
  applyI18n();
  windowId = (await chrome.windows.getCurrent().catch(() => null))?.id ?? null;
  void renderAccount();
  void renderScripts();

  $('openPanelBtn').addEventListener('click', () => {
    // Must stay synchronous in the click: sidePanel.open needs the user gesture.
    if (windowId == null) return;
    chrome.sidePanel.open({ windowId }).then(() => markDone('stepOpen'), () => {});
  });

  $('signInBtn').addEventListener('click', async () => {
    const btn = $('signInBtn');
    btn.disabled = true;
    say($('signInStatus'), '');
    try {
      await signInWithBrowserKitten();
      await renderAccount();
    } catch (error) {
      const msg = String(error?.message || error);
      if (!/did not approve|closed|canceled|cancelled/i.test(msg)) say($('signInStatus'), t('cloudSignInFailed').replace('{error}', msg));
    } finally {
      btn.disabled = false;
    }
  });

  $('scriptsBtn').addEventListener('click', () => {
    // Synchronous in the click for the permission prompt.
    requestPageScripts().then(renderScripts);
  });
  $('detailsBtn').addEventListener('click', () => void openExtensionDetails());
  $('skipScriptsBtn').addEventListener('click', () => $('stepScripts').classList.add('is-skipped'));
  // Coming back from the details page: pick up the toggle.
  window.addEventListener('focus', () => void renderScripts());

  $('doneBtn').addEventListener('click', () => {
    if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {});
    chrome.tabs.getCurrent().then((tab) => tab?.id != null && chrome.tabs.remove(tab.id)).catch(() => window.close());
  });
}

void boot();
