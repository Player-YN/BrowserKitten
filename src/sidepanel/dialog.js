/**
 * Native <dialog> open/close with return-focus + light overlay helpers.
 * Chrome side panel supports <dialog showModal>; prefer over div.modal-overlay.
 */

/**
 * @param {HTMLDialogElement|null|undefined} dialog
 * @param {{ focus?: HTMLElement|null, returnFocus?: HTMLElement|null }} [opts]
 * @returns {boolean}
 */
export function openDialog(dialog, opts = {}) {
  if (!dialog) return false;
  const returnFocus =
    opts.returnFocus ||
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  /** @type {any} */
  const d = dialog;
  d._pwReturnFocus = returnFocus;
  d._pwFallbackOpen = false;

  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch (e) {
        console.warn('[BrowserBot] showModal failed — using fallback overlay', e);
        dialog.classList.add('pw-dialog-fallback', 'is-fallback-open');
        dialog.setAttribute('open', '');
        d._pwFallbackOpen = true;
      }
    } else {
      dialog.classList.add('pw-dialog-fallback', 'is-fallback-open');
      dialog.setAttribute('open', '');
      d._pwFallbackOpen = true;
    }
  }
  const focusEl = opts.focus;
  if (focusEl && typeof focusEl.focus === 'function') {
    requestAnimationFrame(() => {
      try {
        focusEl.focus({ preventScroll: true });
      } catch (_) {
        try {
          focusEl.focus();
        } catch (_) {}
      }
    });
  }
  return true;
}

/**
 * Close dialog and restore focus to opener (if stored).
 * @param {HTMLDialogElement|null|undefined} dialog
 */
export function closeDialog(dialog) {
  if (!dialog) return;
  try {
    if (dialog.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  } catch (_) {}
  /** @type {any} */
  const d = dialog;
  if (d._pwFallbackOpen || dialog.classList.contains('is-fallback-open')) {
    dialog.classList.remove('is-fallback-open', 'pw-dialog-fallback');
    dialog.removeAttribute('open');
    d._pwFallbackOpen = false;
  } else if (dialog.open) {
    try {
      dialog.close();
    } catch (_) {
      dialog.removeAttribute('open');
    }
  }
  restoreDialogFocus(dialog);
}

/**
 * @param {HTMLDialogElement|null|undefined} dialog
 */
export function restoreDialogFocus(dialog) {
  if (!dialog) return;
  /** @type {any} */
  const d = dialog;
  const returnFocus = d._pwReturnFocus;
  d._pwReturnFocus = null;
  if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
    requestAnimationFrame(() => {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch (_) {
        try {
          returnFocus.focus();
        } catch (_) {}
      }
    });
  }
}

/**
 * Accept one CSS selector or a list. A comma-joined string is one query, not characters.
 * @param {string|string[]|null|undefined} input
 * @returns {string[]}
 */
export function normalizeDialogCloseSelectors(input) {
  if (Array.isArray(input)) {
    return input.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  }
  if (typeof input === 'string' && input.trim()) return [input.trim()];
  return [];
}

function querySelectorAllSafe(root, sel) {
  try {
    return [...root.querySelectorAll(sel)];
  } catch {
    return [];
  }
}

/**
 * Wire once: Esc (native cancel), backdrop click, optional close buttons, focus restore on close.
 * @param {HTMLDialogElement|null|undefined} dialog
 * @param {{
 *   closeSelectors?: string|string[],
 *   closeOnBackdrop?: boolean,
 *   onClose?: () => void
 * }} [opts]
 */
export function wireDialogChrome(dialog, opts = {}) {
  if (!dialog || dialog.dataset.pwDialogWired === '1') return;
  dialog.dataset.pwDialogWired = '1';
  const closeOnBackdrop = opts.closeOnBackdrop !== false;
  const closeSelectors = normalizeDialogCloseSelectors(opts.closeSelectors);

  dialog.addEventListener('close', () => {
    restoreDialogFocus(dialog);
    if (typeof opts.onClose === 'function') opts.onClose();
  });

  // Esc fires cancel then closes; keep default unless form validation needs otherwise
  dialog.addEventListener('cancel', () => {
    // allow native close; focus restored on 'close'
  });

  if (closeOnBackdrop) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) closeDialog(dialog);
    });
  }

  for (const sel of closeSelectors) {
    for (const el of querySelectorAllSafe(dialog, sel)) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        closeDialog(dialog);
      });
    }
  }
}

/**
 * Improve non-dialog overlay modals: store/restore focus + Esc.
 * @param {HTMLElement} overlay
 * @param {{
 *   isOpen: () => boolean,
 *   close: () => void,
 *   openFocus?: HTMLElement|null
 * }} api
 */
export function enhanceOverlayFocus(overlay, api) {
  if (!overlay || overlay.dataset.pwOverlayFocus === '1') return;
  overlay.dataset.pwOverlayFocus = '1';
  /** @type {HTMLElement|null} */
  let returnFocus = null;

  const markOpen = () => {
    returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const restore = () => {
    const el = returnFocus;
    returnFocus = null;
    if (el && document.contains(el) && typeof el.focus === 'function') {
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
        } catch (_) {}
      });
    }
  };

  // Public hooks used by callers via dataset symbols
  /** @type {any} */
  const o = overlay;
  o._pwMarkOpenFocus = markOpen;
  o._pwRestoreFocus = restore;

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!api.isOpen()) return;
    e.preventDefault();
    api.close();
  });
}

/**
 * Call before showing a legacy overlay (after enhanceOverlayFocus).
 * @param {HTMLElement|null|undefined} overlay
 */
export function markOverlayOpenFocus(overlay) {
  /** @type {any} */
  const o = overlay;
  if (o && typeof o._pwMarkOpenFocus === 'function') o._pwMarkOpenFocus();
}

/**
 * Call after hiding a legacy overlay.
 * @param {HTMLElement|null|undefined} overlay
 */
export function restoreOverlayFocus(overlay) {
  /** @type {any} */
  const o = overlay;
  if (o && typeof o._pwRestoreFocus === 'function') o._pwRestoreFocus();
}
