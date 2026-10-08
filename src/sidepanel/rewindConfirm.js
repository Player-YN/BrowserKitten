/**
 * Rewind confirm anchored under one user bubble, not inside it.
 * One open at a time. Dismiss drops the card, the open class, and focus
 * so the pencil is hover-only again.
 */

const OPEN_CLASS = 'is-rewind-confirm';

/** @type {null | {
 *   host: HTMLElement,
 *   doc: Document,
 *   panel: HTMLElement,
 *   hint: HTMLElement,
 *   ok: HTMLButtonElement,
 *   cancel: HTMLButtonElement,
 *   unbind: () => void
 * }} */
let current = null;

export function dismissRewindConfirm() {
  const cur = current;
  if (!cur) return;
  current = null;
  cur.unbind();
  const blur = (el) => {
    if (el && typeof el.blur === 'function') el.blur();
  };
  const active = cur.doc.activeElement;
  if (active && (cur.host.contains(active) || cur.panel.contains(active))) blur(active);
  blur(cur.host.querySelector('.msg-user-edit'));
  cur.host.classList.remove(OPEN_CLASS);
  cur.panel.remove();
}

/**
 * @param {(key: string) => string} t
 */
export function syncRewindConfirmCopy(t) {
  if (!current || typeof t !== 'function') return;
  const hint = t('rewindInlineHint');
  const ok = t('rewindInlineOk');
  const cancel = t('rewindInlineCancel');
  current.hint.textContent = hint;
  current.ok.textContent = ok;
  current.cancel.textContent = cancel;
  current.panel.setAttribute('aria-label', hint);
}

/**
 * Mouse press must not focus the pencil; a leftover focus kept it visible.
 * @param {HTMLButtonElement} button
 * @param {() => void} open
 */
export function bindRewindEditButton(button, open) {
  button.addEventListener('mousedown', (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof button.blur === 'function') button.blur();
    open();
  });
}

/**
 * @param {HTMLElement} host user bubble
 * @param {{
 *   t: (key: string) => string,
 *   onConfirm: () => void,
 *   document?: Document
 * }} opts
 */
export function openRewindInlineConfirm(host, opts) {
  const t = opts?.t;
  const onConfirm = opts?.onConfirm;
  if (!host || typeof t !== 'function' || typeof onConfirm !== 'function') return;
  const doc = opts.document || host.ownerDocument;
  if (!doc) return;
  if (current?.host === host) return;
  dismissRewindConfirm();

  const panel = doc.createElement('div');
  panel.className = 'msg-rewind-confirm';
  panel.setAttribute('role', 'group');

  const hint = doc.createElement('p');
  hint.className = 'msg-rewind-confirm-text';

  const actions = doc.createElement('div');
  actions.className = 'msg-rewind-confirm-actions';

  const ok = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
  ok.type = 'button';
  ok.className = 'msg-rewind-confirm-ok';

  const cancel = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
  cancel.type = 'button';
  cancel.className = 'msg-rewind-confirm-cancel';

  actions.appendChild(ok);
  actions.appendChild(cancel);
  panel.appendChild(hint);
  panel.appendChild(actions);
  const parent = host.parentNode;
  if (parent && typeof parent.insertBefore === 'function') {
    parent.insertBefore(panel, host.nextSibling || null);
  } else {
    host.appendChild(panel);
  }
  host.classList.add(OPEN_CLASS);

  const edit = host.querySelector('.msg-user-edit');
  if (edit && typeof edit.blur === 'function') edit.blur();

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    dismissRewindConfirm();
    if (commit) onConfirm();
  };

  ok.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finish(true);
  });
  cancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  });

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (!host.isConnected) {
      finish(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  const onPointer = (e) => {
    if (!host.isConnected || !panel.contains(e.target)) finish(false);
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);

  current = {
    host,
    doc,
    panel,
    hint,
    ok,
    cancel,
    unbind() {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('pointerdown', onPointer, true);
    }
  };
  syncRewindConfirmCopy(t);

  try {
    cancel.focus({ preventScroll: true });
  } catch {
    try { cancel.focus(); } catch { /* focus is optional */ }
  }
}
