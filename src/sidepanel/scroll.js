/**
 * Whole sidepanel scroll helpers.
 * Home / no-thread: #panelScroll is the document scrollport.
 * Conversation open: .task-body is the message scrollport (paper, no well).
 * Think block: .think-body-wrap is its own starlight scrollport.
 * Starlight overlay appears only on the scrollport that is actually moving.
 */

export const TASK_BODY_SCROLL_REVEAL_MS = 720;
export const STARLIGHT_REVEAL_MS = TASK_BODY_SCROLL_REVEAL_MS;

const revealTimers = new WeakMap();

function getScrollRoot() {
  return (
    document.querySelector('#taskStream .session-thread:not([hidden]) .task-body') ||
    document.getElementById('panelScroll') ||
    document.getElementById('taskStream') ||
    null
  );
}

export function isStarlightScrollport(el) {
  return !!el?.classList?.contains('think-body-wrap') || !!el?.classList?.contains('task-body');
}

/**
 * Innermost starlight scroller. Think wrap wins over `.task-body`.
 * Think-block chrome (toggle / padding) is not the conversation scroller
 * and never promotes to the outer chat bar.
 * @param {Element|null|undefined} node
 */
export function resolveStarlightScrollport(node) {
  if (!node) return null;
  let el = node;
  if (el && typeof el.closest !== 'function' && el.parentElement) el = el.parentElement;
  if (typeof el.closest !== 'function') {
    return isStarlightScrollport(el) ? el : null;
  }
  const think = el.closest('.think-body-wrap');
  if (think) return think;
  if (el.closest('.think-block, .think-body')) return null;
  return el.closest('.task-body') || null;
}

function isThinkChrome(node) {
  return !!node?.closest?.('.think-body-wrap, .think-block, .think-body');
}

/**
 * Event → the bar that may light. Nested think motion never returns `.task-body`.
 * @param {{ target?: EventTarget|null, type?: string }} e
 */
export function starlightPortFromEvent(e) {
  const node = e?.target;
  if (!node) return null;
  if (e?.type === 'scroll' && node.classList?.contains('task-body')) {
    if (node.querySelector?.('.think-body-wrap.is-scrolling')) return null;
  }
  if (isThinkChrome(node) && !node.closest?.('.think-body-wrap')) return null;
  const port = resolveStarlightScrollport(node);
  if (port?.classList.contains('task-body') && isThinkChrome(node)) return null;
  return port;
}

function wheelDeltaY(e) {
  const dy = Number(e?.deltaY) || 0;
  if (e?.deltaMode === 1) return dy * 16;
  if (e?.deltaMode === 2) return dy * 400;
  return dy;
}

/**
 * @param {{ scrollHeight: number, clientHeight: number, scrollTop: number }} box
 */
export function starlightThumbMetrics(box) {
  const scrollHeight = Number(box?.scrollHeight) || 0;
  const clientHeight = Number(box?.clientHeight) || 0;
  const scrollTop = Number(box?.scrollTop) || 0;
  const track = Math.max(0, clientHeight);
  const thumbH = scrollHeight > 0 ? Math.max(32, (clientHeight / scrollHeight) * track) : 32;
  const max = Math.max(0, scrollHeight - clientHeight);
  const thumbTop = max > 0 ? (scrollTop / max) * (track - thumbH) : 0;
  return { thumbH, thumbTop, track };
}

function starlightHost(el) {
  if (el.classList.contains('think-body-wrap')) {
    return el.closest?.('.think-block') || el;
  }
  return el.closest?.('.session-thread, .task-card') || el;
}

function starlightTrackTop(el, host) {
  if (el.classList.contains('think-body-wrap')) {
    const toggle = host.querySelector?.('.think-toggle');
    return toggle?.getBoundingClientRect?.().height || 0;
  }
  const header = host.querySelector?.('.task-header');
  return header?.getBoundingClientRect?.().height || 46;
}

/**
 * @param {Element|null} el
 */
export function syncStarlight(el) {
  if (!isStarlightScrollport(el)) return;
  const host = starlightHost(el);
  const { thumbH, thumbTop } = starlightThumbMetrics(el);
  host.style?.setProperty?.('--starlight-track-top', `${Math.round(starlightTrackTop(el, host))}px`);
  host.style?.setProperty?.('--starlight-thumb-h', `${Math.round(thumbH)}px`);
  host.style?.setProperty?.('--starlight-thumb-top', `${Math.round(thumbTop)}px`);
}

export function syncTaskBodyStarlight(el) {
  syncStarlight(el);
}

function clearStarlight(el) {
  if (!el) return;
  el.classList.remove('is-scrolling');
  const prev = revealTimers.get(el);
  if (prev) clearTimeout(prev);
  revealTimers.delete(el);
}

/**
 * @param {Element|null} el
 * @param {number} [holdMs]
 */
export function markStarlightScrolling(el, holdMs = STARLIGHT_REVEAL_MS) {
  if (!isStarlightScrollport(el)) return false;
  if (el.classList.contains('think-body-wrap')) {
    const outer = el.closest?.('.task-body');
    if (outer && outer !== el) clearStarlight(outer);
  }
  el.classList.add('is-scrolling');
  syncStarlight(el);
  const prev = revealTimers.get(el);
  if (prev) clearTimeout(prev);
  const tid = setTimeout(() => {
    el.classList.remove('is-scrolling');
    revealTimers.delete(el);
  }, holdMs);
  revealTimers.set(el, tid);
  return true;
}

/**
 * @param {Element|null} el
 * @param {number} [holdMs]
 */
export function markTaskBodyScrolling(el, holdMs = TASK_BODY_SCROLL_REVEAL_MS) {
  if (!el?.classList?.contains('task-body')) return false;
  return markStarlightScrolling(el, holdMs);
}

/**
 * @param {Element|null} el
 * @param {number} deltaY
 */
function canScrollY(el, deltaY) {
  if (!el || !(el instanceof HTMLElement)) return false;
  let node = el;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const oy = style.overflowY;
    const scrollable =
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      node.scrollHeight > node.clientHeight + 1;
    if (scrollable) {
      const top = node.scrollTop;
      const max = node.scrollHeight - node.clientHeight;
      if (deltaY < 0 && top > 0) return true;
      if (deltaY > 0 && top < max - 0.5) return true;
    }
    node = node.parentElement;
  }
  return false;
}

function starlightFromEvent(e) {
  return starlightPortFromEvent(e);
}

/**
 * Relay wheel from sticky chrome (topbar/composer) onto the conversation body.
 * @returns {() => void}
 */
export function setupSidepanelWheelRelay() {
  const panel = document.getElementById('panel');
  if (!panel) return () => {};

  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    if (e.defaultPrevented || e.ctrlKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest(
        '.modal-overlay, .more-sheet, .settings-modal, .sheet-backdrop, .pw-dialog, dialog, [role="dialog"], .think-body-wrap, .think-block, .think-body'
      )
    ) {
      return;
    }
    const root = getScrollRoot();
    if (!root) return;
    // Already scrolling the main root
    if (root.contains(target) && canScrollY(target, e.deltaY)) return;
    if (canScrollY(target, e.deltaY)) return;
    if (root.scrollHeight <= root.clientHeight + 1) return;

    const top = root.scrollTop;
    const max = root.scrollHeight - root.clientHeight;
    if (e.deltaY < 0 && top <= 0) return;
    if (e.deltaY > 0 && top >= max - 0.5) return;

    root.scrollTop = Math.min(max, Math.max(0, top + e.deltaY));
    if (root.classList.contains('task-body')) markStarlightScrolling(root);
    e.preventDefault();
  };

  panel.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => panel.removeEventListener('wheel', onWheel, { capture: true });
}

/**
 * Edge fades + per-scrollport starlight reveal.
 * @returns {() => void}
 */
export function setupTaskStreamScrollAffordances() {
  let raf = 0;
  let lastRoot = null;
  const update = () => {
    raf = 0;
    const root = getScrollRoot();
    if (!root) return;
    if (lastRoot && lastRoot !== root) {
      lastRoot.classList.remove('is-scroll-up', 'is-scroll-down', 'is-scrolling');
    }
    lastRoot = root;
    const max = root.scrollHeight - root.clientHeight;
    const canScroll = max > 2;
    const top = root.scrollTop;
    root.classList.toggle('is-scroll-up', canScroll && top > 2);
    root.classList.toggle('is-scroll-down', canScroll && top < max - 2);
    if (root.classList.contains('is-scrolling')) syncStarlight(root);
    document.querySelectorAll('.think-body-wrap.is-scrolling').forEach((wrap) => syncStarlight(wrap));
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(update);
  };

  const onReveal = (e) => {
    const port = starlightFromEvent(e);
    if (port) markStarlightScrolling(port);
    schedule();
  };

  const onThinkWheel = (e) => {
    if (e.defaultPrevented || e.ctrlKey) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const wrap = target.closest('.think-body-wrap');
    if (!wrap) return;
    const dy = wheelDeltaY(e);
    if (canScrollY(wrap, dy)) wrap.scrollTop += dy;
    e.preventDefault();
    e.stopPropagation();
    markStarlightScrolling(wrap);
    schedule();
  };

  document.addEventListener('scroll', onReveal, { passive: true, capture: true });
  document.addEventListener('wheel', onThinkWheel, { passive: false, capture: true });
  document.addEventListener('wheel', onReveal, { passive: true, capture: true });
  document.addEventListener('touchmove', onReveal, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(schedule);
    const panelScroll = document.getElementById('panelScroll');
    if (panelScroll) ro.observe(panelScroll);
  }
  let mo = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(schedule);
    const observe = document.getElementById('panelScroll') || document.body;
    mo.observe(observe, { childList: true, subtree: true, characterData: true });
  }
  schedule();

  return () => {
    document.removeEventListener('scroll', onReveal, { capture: true });
    document.removeEventListener('wheel', onThinkWheel, { capture: true });
    document.removeEventListener('wheel', onReveal, { capture: true });
    document.removeEventListener('touchmove', onReveal, { capture: true });
    window.removeEventListener('resize', schedule);
    if (ro) ro.disconnect();
    if (mo) mo.disconnect();
    if (raf) cancelAnimationFrame(raf);
    lastRoot?.classList.remove('is-scroll-up', 'is-scroll-down', 'is-scrolling');
  };
}

export function taskStreamScrollMetrics() {
  const root = getScrollRoot();
  if (!root) return null;
  return {
    clientHeight: root.clientHeight,
    scrollHeight: root.scrollHeight,
    scrollTop: root.scrollTop,
    canScroll: root.scrollHeight > root.clientHeight + 1,
    isScrollUp: root.classList.contains('is-scroll-up'),
    isScrollDown: root.classList.contains('is-scroll-down'),
    isScrolling: root.classList.contains('is-scrolling')
  };
}
