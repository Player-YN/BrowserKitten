/**
 * Office-habit shortcuts for preview work surfaces.
 * Viewport zoom is ours (Chrome page zoom is blocked). Engine-owned
 * Spreadsheet shortcut handlers are opt-in.
 */

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function isMod(e) {
  return !!(e && (e.ctrlKey || e.metaKey));
}

export function stepZoom(current, dir) {
  if (dir === 0) return 1;
  let z = Number(current);
  if (!Number.isFinite(z) || z <= 0) z = 1;
  if (z > 4) z = z / 100;
  if (dir > 0) {
    const next = ZOOM_STEPS.find((s) => s > z + 0.001);
    return next != null ? next : ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  const next = [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  return next != null ? next : ZOOM_STEPS[0];
}

export function isTypingTarget(el) {
  if (!el || el === (typeof document !== 'undefined' ? document.body : null)) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'file' || type === 'range' || type === 'submit') {
      return false;
    }
    return true;
  }
  if (tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  try {
    if (el.closest?.('textarea, select, [contenteditable="true"], [contenteditable=""]')) return true;
    if (el.closest?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="file"])')) {
      return true;
    }
  } catch {
    /* */
  }
  const cls = `${el.className || ''} ${el.parentElement?.className || ''}`;
  if (/cell-editor|formula-editor|univer-editor|docs-editor|tl-text-label|univer-sheet-cell-editor/i.test(String(cls))) {
    return true;
  }
  return false;
}

/**
 * @param {KeyboardEvent} e
 * @param {{ typing?: boolean, surface?: string, present?: boolean }} [opts]
 * @returns {string|null}
 */
export function classifyOfficeKey(e, opts = {}) {
  if (!e || e.altKey) return null;
  const typing = !!opts.typing;
  const surface = String(opts.surface || '');
  const mod = isMod(e);
  const key = String(e.key || '');
  const code = String(e.code || '');
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if (key === 'Escape') return 'escape';

  if (mod && lower === 's') return 'save';
  if (mod && lower === 'z' && e.shiftKey) return 'redo';
  if (mod && lower === 'y') return 'redo';
  if (mod && lower === 'z') return 'undo';

  if (mod && (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd')) return 'zoomIn';
  if (mod && (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract')) return 'zoomOut';
  if (mod && !e.shiftKey && (key === '0' || code === 'Digit0' || code === 'Numpad0')) return 'zoomFit';
  if (surface === 'slides' && !mod && (key === 'F5' || code === 'F5')) return 'present';

  if (typing) return null;

  if (mod && lower === 'a') return 'selectAll';
  if (mod && lower === 'd') return 'duplicate';
  if (key === 'Delete' || key === 'Backspace') return 'delete';

  if (surface === 'slides' && !mod) {
    if (key === 'PageDown') return 'pageNext';
    if (key === 'PageUp') return 'pagePrev';
    // Arrows nudge in the engine while editing. Only steal them in present mode.
    if (opts.present && key === 'ArrowRight') return 'pageNext';
    if (opts.present && key === 'ArrowLeft') return 'pagePrev';
  }
  if (surface === 'site' && !mod && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
    return 'nudge';
  }
  return null;
}

export function nudgeDelta(e) {
  const step = e?.shiftKey ? 10 : 1;
  const key = String(e?.key || '');
  if (key === 'ArrowLeft') return { x: -step, y: 0 };
  if (key === 'ArrowRight') return { x: step, y: 0 };
  if (key === 'ArrowUp') return { x: 0, y: -step };
  if (key === 'ArrowDown') return { x: 0, y: step };
  return { x: 0, y: 0 };
}

const ALWAYS_PREVENT = new Set(['zoomIn', 'zoomOut', 'zoomFit', 'save', 'present']);

/**
 * @param {object} opts
 * @param {string} opts.surface
 * @param {(e: KeyboardEvent) => boolean} [opts.isTyping]
 * @param {() => boolean} [opts.isPresent]
 * @param {Record<string, Function>} opts.actions
 */
export function installOfficeShortcuts(opts) {
  const surface = String(opts?.surface || '');
  const actions = opts?.actions && typeof opts.actions === 'object' ? opts.actions : {};

  function onKey(e) {
    if (!e) return;
    const typing = typeof opts.isTyping === 'function' ? !!opts.isTyping(e) : isTypingTarget(e.target);
    const present = typeof opts.isPresent === 'function' ? !!opts.isPresent() : !!opts.present;
    const action = classifyOfficeKey(e, { typing, surface, present });
    if (!action) return;

    if (ALWAYS_PREVENT.has(action)) {
      e.preventDefault();
      if (typing && action !== 'save' && action !== 'present') return;
      if (action === 'save') {
        actions.save?.(e);
        return;
      }
      actions[action]?.(e);
      return;
    }

    if (action === 'undo' || action === 'redo') {
      if (typeof actions[action] !== 'function') return;
      e.preventDefault();
      actions[action](e);
      return;
    }

    if (action === 'escape') {
      const closed = typeof actions.escape === 'function' ? actions.escape(e) : false;
      if (closed) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (typing) return;
    if (typeof actions[action] !== 'function') return;

    e.preventDefault();
    if (action === 'nudge') actions.nudge(e, nudgeDelta(e));
    else actions[action](e);
  }

  const target = typeof window !== 'undefined' ? window : null;
  if (target) target.addEventListener('keydown', onKey, true);

  return {
    onKey,
    bindDocument(doc) {
      if (!doc?.addEventListener) return () => {};
      doc.addEventListener('keydown', onKey, true);
      return () => doc.removeEventListener('keydown', onKey, true);
    },
    dispose() {
      if (target) target.removeEventListener('keydown', onKey, true);
    }
  };
}

