/**
 * Top-right account control. Signed out: a Sign in button (the ⋯ settings sheet stays
 * next to it). Signed in: an avatar chip with the credit balance that opens a menu with
 * plan, credits, the weekly meter, add credits / manage plan, settings and sign out.
 *
 * Pure helpers are exported for tests; mountAccountMenu() wires the DOM.
 */
import { wirePopoverMenu } from './popoverMenu.js';

/** 61240 → "61k", 1200 → "1.2k", 950 → "950". */
export function compactCredits(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return `${(Math.floor(v / 100) / 10).toString().replace(/\.0$/, '')}k`;
  if (v < 1000000) return `${Math.floor(v / 1000)}k`;
  return `${(Math.floor(v / 100000) / 10).toString().replace(/\.0$/, '')}M`;
}

/** First letter of the email's local part, uppercase; "?" when unknown. */
export function accountInitial(email) {
  const ch = String(email || '').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

/** A typical task uses 150–300 credits; quote the high end so the estimate is safe. */
export const CREDITS_PER_TASK = 300;
export function tasksFor(credits) {
  const n = Math.max(0, Number(credits) || 0) / CREDITS_PER_TASK;
  return n >= 100 ? Math.floor(n / 10) * 10 : Math.floor(n);
}

/**
 * What the chip and menu show for an account state from fetchCloudAccount().
 * @param {object|null} acct
 * @returns {{ state: 'signed-out'|'expired'|'unavailable'|'signed-in', email: string, plan: string,
 *   credits: number, weekly: { used: number, limit: number, share: number } | null }}
 */
export function accountView(acct) {
  if (!acct) return { state: 'unavailable', email: '', plan: '', credits: 0, weekly: null };
  if (!acct.signedIn) return { state: 'signed-out', email: '', plan: '', credits: 0, weekly: null };
  if (acct.expired) return { state: 'expired', email: acct.email || '', plan: '', credits: 0, weekly: null };
  const limit = Number(acct.limits?.weekly);
  const used = Number(acct.usage?.weekly) || 0;
  const weekly = Number.isFinite(limit) && limit > 0 ? { used, limit, share: Math.min(1, used / limit) } : null;
  return {
    state: 'signed-in',
    email: acct.email || '',
    plan: acct.planLabel || acct.plan || '',
    credits: Number(acct.credits) || 0,
    weekly
  };
}

/**
 * @param {{
 *   t: (key: string) => string,
 *   locale: () => string,
 *   load: () => Promise<object>,          // fetchCloudAccount
 *   signIn: () => Promise<void>,
 *   signOut: () => Promise<void>,
 *   openAccount: (path?: string) => void, // opens browserkitten.com/account.html[?buy=…]
 *   openSettings: () => void              // the ⋯ settings sheet
 * }} deps
 */
export function mountAccountMenu(deps) {
  const signInBtn = document.getElementById('accountSignInBtn');
  const chip = document.getElementById('accountChip');
  const menu = document.getElementById('accountMenu');
  const moreBtn = document.getElementById('moreBtn');
  if (!signInBtn || !chip || !menu) return { refresh: async () => null };

  const popover = wirePopoverMenu({ trigger: chip, menu });
  const $m = (sel) => menu.querySelector(sel);
  const num = (n) => Number(n || 0).toLocaleString(deps.locale());
  let lastView = null;

  function paint(view) {
    lastView = view;
    const signedIn = view.state === 'signed-in' || view.state === 'expired';
    signInBtn.hidden = signedIn;
    chip.hidden = !signedIn;
    // Signed in, settings live in the account menu; signed out, the ⋯ button keeps them reachable.
    if (moreBtn) moreBtn.hidden = signedIn;
    if (!signedIn) {
      popover.close();
      return;
    }
    const initial = accountInitial(view.email);
    chip.querySelector('.account-avatar').textContent = initial;
    const creditsEl = chip.querySelector('.account-chip-credits');
    creditsEl.textContent = view.state === 'expired' ? '!' : compactCredits(view.credits);
    chip.classList.toggle('is-low', view.state === 'signed-in' && view.credits < 1000);
    chip.classList.toggle('is-expired', view.state === 'expired');
    chip.title = view.email || deps.t('cloudTitle');

    $m('.account-menu-avatar').textContent = initial;
    $m('.account-menu-email').textContent = view.email || deps.t('cloudTitle');
    $m('.account-menu-plan').textContent = view.state === 'expired' ? deps.t('cloudExpired') : view.plan;
    const creditsBlock = $m('.account-menu-credits');
    creditsBlock.hidden = view.state !== 'signed-in';
    if (view.state === 'signed-in') {
      $m('.account-menu-credits-num').textContent = num(view.credits);
      $m('.account-menu-credits-tasks').textContent = deps.t('accountTasksLeft').replace('{n}', num(tasksFor(view.credits)));
      const meter = $m('.account-menu-meter');
      meter.hidden = !view.weekly;
      if (view.weekly) {
        const bar = meter.querySelector('i');
        bar.style.width = `${(view.weekly.share * 100).toFixed(1)}%`;
        bar.classList.toggle('is-high', view.weekly.share >= 0.8);
        meter.querySelector('small').textContent = deps.t('accountWeekly')
          .replace('{used}', num(view.weekly.used))
          .replace('{limit}', num(view.weekly.limit));
      }
    }
    $m('[data-account-action="reconnect"]').hidden = view.state !== 'expired';
    $m('[data-account-action="add-credits"]').hidden = view.state !== 'signed-in';
  }

  async function refresh() {
    let acct = null;
    try {
      acct = await deps.load();
    } catch {
      acct = null;
    }
    const view = accountView(acct);
    // A network blip keeps the last known state instead of flashing "signed out".
    if (view.state === 'unavailable') {
      if (!lastView) paint({ state: 'signed-out', email: '', plan: '', credits: 0, weekly: null });
      return lastView;
    }
    paint(view);
    return view;
  }

  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    const label = signInBtn.textContent;
    signInBtn.textContent = deps.t('cloudSigningIn');
    try {
      await deps.signIn();
    } finally {
      signInBtn.disabled = false;
      signInBtn.textContent = label;
      await refresh();
    }
  });

  chip.addEventListener('click', () => {
    // Fresh numbers each time the menu opens; the paint is cheap.
    if (popover.isOpen()) void refresh();
  });

  menu.addEventListener('click', async (event) => {
    const item = event.target.closest('[data-account-action]');
    if (!item) return;
    const action = item.dataset.accountAction;
    popover.close();
    if (action === 'add-credits') deps.openAccount('/account.html#plans');
    else if (action === 'manage') deps.openAccount('/account.html');
    else if (action === 'settings') deps.openSettings();
    else if (action === 'reconnect') {
      await deps.signIn();
      await refresh();
    } else if (action === 'sign-out') {
      await deps.signOut();
      await refresh();
    }
  });

  return { refresh, view: () => lastView };
}
