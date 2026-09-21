/**
 * Access mode chip + one-time Full Access risk dialog.
 * Host copy only. Never says Full Access is a hard safety guarantee.
 */

import { closeDialog, openDialog, wireDialogChrome } from './dialog.js';

export function accessChipLabel(policy, t) {
  const mode = policy?.mode === 'full' ? 'full' : 'guarded';
  const base = mode === 'full' ? t('accessChipFull') : t('accessChipGuarded');
  if (mode === 'full' && policy?.source === 'session') return `${base} · ${t('accessChipSession')}`;
  return base;
}

export function accessChipTitle(policy, t) {
  return policy?.mode === 'full' ? t('accessFullHint') : t('accessGuardedHint');
}

export function createAccessPolicyUi(deps) {
  let policy = {
    mode: 'guarded',
    source: 'default',
    profileMode: 'guarded',
    sessionOverride: null,
    rawEscapeDefault: 'deny'
  };

  function t(key) {
    return deps.t(key);
  }

  function chipEl() {
    return deps.getChip?.() || document.getElementById('accessPolicyChip');
  }

  function renderChip() {
    const el = chipEl();
    if (!el) return policy;
    el.hidden = false;
    el.dataset.mode = policy.mode === 'full' ? 'full' : 'guarded';
    el.dataset.source = policy.source || 'default';
    const label = el.querySelector('.access-policy-label') || el;
    label.textContent = accessChipLabel(policy, t);
    el.title = `${accessChipLabel(policy, t)} — ${accessChipTitle(policy, t)}`;
    el.setAttribute('aria-label', el.title);
    return policy;
  }

  function setPolicy(next) {
    if (next && typeof next === 'object') policy = next;
    renderChip();
    return policy;
  }

  function current() {
    return policy;
  }

  function confirmFullAccess() {
    const dialog = deps.getDialog?.() || document.getElementById('accessFullDialog');
    if (!dialog) return Promise.resolve({ confirmed: false, rememberProfile: false });
    const remember = dialog.querySelector('#accessRememberProfile');
    if (remember) remember.checked = false;
    wireDialogChrome(dialog, { closeSelectors: ['[data-access-cancel]', '.modal-close-btn'] });
    openDialog(dialog);
    return new Promise((resolve) => {
      const finish = (confirmed) => {
        const rememberProfile = !!dialog.querySelector('#accessRememberProfile')?.checked;
        closeDialog(dialog);
        resolve({ confirmed, rememberProfile });
      };
      dialog.querySelector('[data-access-confirm]')?.addEventListener('click', () => finish(true), { once: true });
      dialog.querySelector('[data-access-cancel]')?.addEventListener('click', () => finish(false), { once: true });
      dialog.addEventListener(
        'cancel',
        (ev) => {
          ev.preventDefault();
          finish(false);
        },
        { once: true }
      );
    });
  }

  async function requestMode(nextMode) {
    const mode = nextMode === 'full' ? 'full' : 'guarded';
    if (mode === 'full' && policy.mode !== 'full') {
      const ans = await confirmFullAccess();
      if (!ans.confirmed) return policy;
      return deps.setAccessPolicy({ mode: 'full', rememberProfile: ans.rememberProfile === true });
    }
    if (mode === 'guarded' && policy.mode !== 'guarded') {
      return deps.setAccessPolicy({ mode: 'guarded' });
    }
    return policy;
  }

  function bind() {
    const el = chipEl();
    el?.addEventListener('click', (ev) => {
      ev.preventDefault();
      void (async () => {
        const next = policy.mode === 'full' ? 'guarded' : 'full';
        const result = await requestMode(next);
        if (result && result.mode) setPolicy(result);
      })();
    });
    renderChip();
  }

  return { setPolicy, current, renderChip, bind, requestMode, confirmFullAccess };
}
