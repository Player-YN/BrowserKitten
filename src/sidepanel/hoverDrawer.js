/**
 * Hover expand/collapse for selection + clip drawers.
 *
 * Key UX rules (product):
 * - Open almost instantly (no half-second lag)
 * - Close only after a longer grace period so the pointer can travel to
 *   nested controls (下图 / 剪贴板 / 导出) without the panel collapsing
 * - Listen on the ROOT only (not separate trigger leave) so moving from
 *   toolbar → expand body never crosses a “dead gap”
 * - relatedTarget still inside root ⇒ cancel close
 */

const OPEN_DELAY = 40;
const CLOSE_DELAY = 480;

/** @type {string|null} */
let activeId = null;
/**
 * @typedef {{
 *   openTimer?: number,
 *   closeTimer?: number,
 *   holdTimer?: number,
 *   holdUntil?: number,
 *   hovering?: boolean,
 *   pinned: boolean,
 *   el: HTMLElement,
 *   body?: HTMLElement|null,
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   exclusive: boolean,
 *   group: string,
 *   canOpen?: () => boolean,
 *   hasInteraction?: () => boolean,
 *   openNow?: () => void
 * }} DrawerHost
 */
/** @type {Map<string, DrawerHost>} */
const hosts = new Map();

function canHover() {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return true;
  }
}

/**
 * @param {Element|null|undefined} node
 * @param {HTMLElement} root
 */
function isInsideRoot(node, root) {
  if (!node || !root) return false;
  if (node === root) return true;
  if (node instanceof Node && root.contains(node)) return true;
  // Shadow / text nodes
  try {
    const el = /** @type {Element} */ (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && root.contains(el));
  } catch {
    return false;
  }
}

/**
 * @param {string} id
 * @param {{
 *   root: HTMLElement,
 *   trigger?: HTMLElement|null,
 *   body?: HTMLElement|null,
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   exclusive?: boolean,
 *   group?: string,
 *   canOpen?: () => boolean,
 *   interactionRoots?: Array<HTMLElement|null>
 * }} opts
 */
export function registerHoverDrawer(id, opts) {
  const el = opts.root;
  if (!el) return () => {};
  const trigger = opts.trigger || el;
  const body = opts.body || el.querySelector('[data-drawer-body]') || el;
  const exclusive = opts.exclusive !== false;
  const group = opts.group || 'default';
  // Menus may be portaled to document.body; they still belong to this drawer.
  const extraRoots = (opts.interactionRoots || []).filter(Boolean);
  const focusAware = Array.isArray(opts.interactionRoots);
  const roots = () => [el, ...extraRoots.filter((root) => !root.hidden)];
  const containsInteraction = (node) => roots().some((root) => isInsideRoot(node, root));
  const hasKeyboardFocus = () => containsInteraction(document.activeElement) &&
    document.activeElement?.matches?.(':focus-visible');
  const hasInteraction = () => focusAware && (
    extraRoots.some((root) => !root.hidden) || hasKeyboardFocus()
  );

  const state = {
    pinned: false,
    hovering: false,
    holdUntil: 0,
    el,
    body,
    onOpen: opts.onOpen,
    onClose: opts.onClose,
    exclusive,
    group,
    canOpen: opts.canOpen,
    hasInteraction
  };
  hosts.set(id, state);
  wireHoverResync();

  const openNow = () => {
    const st0 = hosts.get(id);
    if (st0?.canOpen && !st0.canOpen()) return;
    for (const [otherId, st] of hosts) {
      if (otherId === id) continue;
      if (st.group !== group) {
        if (exclusive && st.exclusive) {
          if (st.pinned) st.pinned = false;
          closeDrawer(otherId, { force: true });
        }
        continue;
      }
      if (!exclusive || !st.exclusive) continue;
      if (st.pinned) st.pinned = false;
      closeDrawer(otherId, { force: true });
    }
    activeId = id;
    el.classList.add('is-drawer-open');
    el.setAttribute('aria-expanded', 'true');
    if (body && body !== el) body.classList.add('is-drawer-body-open');
    opts.onOpen?.();
  };
  state.openNow = openNow;

  const isVisuallyOpen = () => {
    if (!el.classList.contains('is-drawer-open')) return false;
    if (body && body !== el) return body.classList.contains('is-drawer-body-open');
    return true;
  };

  const scheduleOpen = () => {
    clearTimers(id);
    const st = hosts.get(id);
    if (!st) return;
    if (st.canOpen && !st.canOpen()) return;
    // Class leftover after hide/show or tuck cycles: still wake the body.
    if (isVisuallyOpen()) return;
    st.openTimer = window.setTimeout(openNow, OPEN_DELAY);
  };

  const isHeldOpen = (st) =>
    !!st && (st.pinned || st.hasInteraction?.() || (st.holdUntil != null && Date.now() < st.holdUntil));

  const scheduleClose = () => {
    const st = hosts.get(id);
    if (!st || isHeldOpen(st)) return;
    clearTimers(id);
    st.closeTimer = window.setTimeout(() => closeDrawer(id), CLOSE_DELAY);
  };

  /** @param {PointerEvent} e */
  const onEnter = (e) => {
    if (!canHover()) return;
    const st = hosts.get(id);
    if (st) st.hovering = true;
    clearTimers(id);
    scheduleOpen();
  };

  /** @param {PointerEvent} e */
  const onLeave = (e) => {
    if (!canHover()) return;
    const next = /** @type {Node|null} */ (e.relatedTarget);
    // Still inside this drawer root (incl. nested clip / tools) → keep open
    if (containsInteraction(next)) {
      clearTimers(id);
      return;
    }
    // Moving into a nested registered drawer that is a descendant (clipboard)
    for (const [otherId, st] of hosts) {
      if (otherId === id) continue;
      if (el.contains(st.el) && isInsideRoot(next, st.el)) {
        clearTimers(id);
        return;
      }
    }
    const st = hosts.get(id);
    if (st) st.hovering = false;
    scheduleClose();
  };

  // Side panel hide/show often leaves the pointer already inside the bar, so
  // pointerenter never fires. pointermove recovers hover-open without
  // retriggering the open delay on every pixel.
  const onMove = () => {
    if (!canHover()) return;
    const st = hosts.get(id);
    if (!st) return;
    st.hovering = true;
    if (isVisuallyOpen() || st.openTimer) return;
    scheduleOpen();
  };

  // ROOT-ONLY hover — do not attach leave on trigger separately (causes collapse
  // when moving from toolbar into expand body).
  const eventRoots = [el, ...extraRoots];
  for (const root of eventRoots) {
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointermove', onMove);
  }
  const onFocusIn = () => {
    if (!hasKeyboardFocus()) return;
    clearTimers(id);
    openNow();
  };
  // Run after click handlers have closed/reparented a menu; restart the usual
  // close grace period without changing the user's persistent pin preference.
  const onInteractionClick = () => queueMicrotask(() => {
    const st = hosts.get(id);
    if (!st) return;
    st.hovering = roots().some((root) => root.matches(':hover'));
    if (!st.hovering) scheduleClose();
  });
  const onFocusOut = onInteractionClick;
  if (focusAware) {
    for (const root of eventRoots) {
      root.addEventListener('focusin', onFocusIn);
      root.addEventListener('focusout', onFocusOut);
    }
    document.addEventListener('click', onInteractionClick, true);
  }

  // Touch: tap trigger toggles
  const onClick = (e) => {
    if (canHover() && e.pointerType === 'mouse') return;
    const t = /** @type {HTMLElement|null} */ (e.target);
    if (t?.closest?.('#pickBtn, #clearSelBtn, #pinSelBtn, #sendBtn, #stopBtn, #clipExportBtn, [data-drawer-pin]')) return;
    if (t?.closest?.('button, a, input, select, textarea, [role="menuitem"]') && !trigger.contains(t)) {
      return;
    }
    if (!trigger.contains(t) && t !== trigger) return;
    e.preventDefault();
    if (el.classList.contains('is-drawer-open')) closeDrawer(id, { force: true });
    else openNow();
  };
  trigger.addEventListener('click', onClick);

  const pinBtn = el.querySelector('[data-drawer-pin]');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const st = hosts.get(id);
      if (!st) return;
      st.pinned = !st.pinned;
      pinBtn.classList.toggle('is-pinned', st.pinned);
      pinBtn.setAttribute('aria-pressed', st.pinned ? 'true' : 'false');
      // Optional title refresh via data attributes set by host i18n
      const titleOn = pinBtn.getAttribute('data-title-pinned') || pinBtn.getAttribute('title');
      const titleOff = pinBtn.getAttribute('data-title-unpinned') || pinBtn.getAttribute('title');
      if (st.pinned) {
        if (titleOn) pinBtn.title = titleOn;
        pinBtn.setAttribute('aria-label', titleOn || 'pinned');
        openNow();
      } else {
        if (titleOff) pinBtn.title = titleOff;
        pinBtn.setAttribute('aria-label', titleOff || 'unpinned');
        // Stay open until pointer leaves; scheduleClose only on leave when unpinned
      }
    });
  }

  el.classList.remove('is-drawer-open');
  el.setAttribute('aria-expanded', 'false');

  return () => {
    clearTimers(id);
    if (state.holdTimer) window.clearTimeout(state.holdTimer);
    for (const root of eventRoots) {
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    }
    document.removeEventListener('click', onInteractionClick, true);
    trigger.removeEventListener('click', onClick);
    hosts.delete(id);
  };
}

/** @param {string} id */
function clearTimers(id) {
  const st = hosts.get(id);
  if (!st) return;
  if (st.openTimer) window.clearTimeout(st.openTimer);
  if (st.closeTimer) window.clearTimeout(st.closeTimer);
  st.openTimer = undefined;
  st.closeTimer = undefined;
  // holdTimer is managed separately by holdDrawerOpen
}

/**
 * Force-open a drawer and keep it open until `ms` after this call (resets on each call).
 * Used after page-pick: wake full selection panel for 2s past last click.
 * @param {string} id
 * @param {number} [ms]
 */
export function holdDrawerOpen(id, ms = 2000) {
  const st = hosts.get(id);
  if (!st) return;
  if (st.canOpen && !st.canOpen()) return;
  st.holdUntil = Date.now() + Math.max(0, ms);
  if (st.holdTimer) {
    window.clearTimeout(st.holdTimer);
    st.holdTimer = undefined;
  }
  // Cancel any pending close; open immediately
  if (st.closeTimer) {
    window.clearTimeout(st.closeTimer);
    st.closeTimer = undefined;
  }
  if (st.openTimer) {
    window.clearTimeout(st.openTimer);
    st.openTimer = undefined;
  }
  st.openNow?.();
  const holdMs = Math.max(0, ms);
  st.holdTimer = window.setTimeout(() => {
    const cur = hosts.get(id);
    if (!cur) return;
    cur.holdTimer = undefined;
    cur.holdUntil = 0;
    // After hold: close only if not pinned and pointer not inside
    if (!cur.pinned && !cur.hovering) {
      closeDrawer(id, { force: false });
    }
  }, holdMs);
}

/**
 * @param {string} id
 * @param {{ force?: boolean }} [opts]
 */
export function closeDrawer(id, opts = {}) {
  const st = hosts.get(id);
  if (!st) return;
  if (st.pinned && !opts.force) return;
  if (!opts.force && st.hasInteraction?.()) return;
  if (!opts.force && st.holdUntil && Date.now() < st.holdUntil) return;
  const wasOpen = st.el.classList.contains('is-drawer-open') || activeId === id;
  clearTimers(id);
  if (st.holdTimer) {
    window.clearTimeout(st.holdTimer);
    st.holdTimer = undefined;
  }
  st.holdUntil = 0;
  st.pinned = false;
  st.el.classList.remove('is-drawer-open');
  st.el.setAttribute('aria-expanded', 'false');
  st.el.querySelector('[data-drawer-pin]')?.classList.remove('is-pinned');
  const body = st.el.querySelector('[data-drawer-body]');
  body?.classList.remove('is-drawer-body-open');
  if (wasOpen) st.onClose?.();
  if (activeId === id) activeId = null;
}

export function closeAllDrawers() {
  for (const id of [...hosts.keys()]) closeDrawer(id, { force: true });
}

/**
 * Set / clear pin on a registered drawer (e.g. selection after clear-all).
 * @param {string} id
 * @param {boolean} pinned
 */
export function setDrawerPinned(id, pinned) {
  const st = hosts.get(id);
  if (!st) return;
  st.pinned = !!pinned;
  const pinBtn = st.el.querySelector('[data-drawer-pin]');
  if (pinBtn) {
    pinBtn.classList.toggle('is-pinned', st.pinned);
    pinBtn.setAttribute('aria-pressed', st.pinned ? 'true' : 'false');
    const titleOn = pinBtn.getAttribute('data-title-pinned');
    const titleOff = pinBtn.getAttribute('data-title-unpinned');
    if (st.pinned && titleOn) {
      pinBtn.title = titleOn;
      pinBtn.setAttribute('aria-label', titleOn);
    } else if (!st.pinned && titleOff) {
      pinBtn.title = titleOff;
      pinBtn.setAttribute('aria-label', titleOff);
    }
  }
  if (st.pinned) {
    st.openNow?.();
  }
}

/**
 * Re-read pointer vs visibility after the side panel is hidden/shown.
 * Chrome often restores the panel with the pointer already over the bar,
 * so pointerenter never fires and hover-open looks dead until the next pick.
 */
export function resyncHoverDrawers() {
  const hidden = document.visibilityState === 'hidden';
  for (const [id, st] of hosts) {
    if (hidden) {
      st.hovering = false;
      continue;
    }
    let over = false;
    try {
      over = canHover() && st.el.matches(':hover');
    } catch {
      over = false;
    }
    st.hovering = over;
    if (over) st.openNow?.();
  }
}

function wireHoverResync() {
  if (wireHoverResync.done) return;
  wireHoverResync.done = true;
  document.addEventListener('visibilitychange', resyncHoverDrawers);
  window.addEventListener('focus', resyncHoverDrawers);
  window.addEventListener('pageshow', resyncHoverDrawers);
}

export function wireDrawerEscape() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeId) closeDrawer(activeId, { force: true });
  });
}
