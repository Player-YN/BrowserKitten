/**
 * Turn-local host instrument. Lives under the think block of one assistant
 * turn. Never invents thought chrome. Never writes Runtime / next.
 */

import {
  PULSE_COMPLETE_MS,
  TURN_MEMORY_CAP,
  disclosureMode,
  foldStubFromState,
  formatActivityRow,
  formatDisclosureDuration,
  latestActivityShine,
  liveActivityVisual,
  persistLiveActionBrief,
  rememberEndedProjection,
  shouldFoldDisclosureImmediately,
  visibleSummaryRows
} from './executionStatus.js';

const HYDRATED_DOM_CAP = 3;

/** Shine the glyphs only — never the full-width row chrome. */
export const LIVE_ACTION_SHINE = {
  glyphClass: 'turn-disclosure-current-text',
  rowClass: 'turn-disclosure-current',
  clip: 'text'
};

export function planLiveDisclosurePaint(state, lastText = '', fallback = '', extra = {}) {
  const mode = extra.mode || disclosureMode(state);
  const live = mode === 'live' || mode === 'sticky';
  const persisted = persistLiveActionBrief(state, lastText);
  const text = persisted || (live ? String(fallback || '').trim() : '');
  const shine = latestActivityShine(state);
  return {
    hidden: !text && !live,
    text,
    keepMounted: live || !!text,
    shineTarget: LIVE_ACTION_SHINE.glyphClass,
    shineClip: LIVE_ACTION_SHINE.clip,
    shineOn: shine.shineOn,
    shineRowId: shine.rowId,
    thinkHeaderShimmer: false
  };
}

function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content != null) el.textContent = String(content);
  return el;
}

export function prefersReducedMotion(matchMediaFn) {
  const mm = matchMediaFn || (typeof matchMedia === 'function' ? matchMedia : null);
  try {
    return mm?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

export function exclusiveHistoricalOpen(root, opened) {
  if (!root || !opened) return 0;
  const list =
    typeof root.querySelectorAll === 'function'
      ? [...root.querySelectorAll('.turn-disclosure.is-folded')]
      : [];
  let closed = 0;
  for (const el of list) {
    if (el === opened) continue;
    if (el.open === true || el.classList?.contains?.('is-open')) {
      if ('open' in el) el.open = false;
      el.classList?.remove?.('is-open');
      unloadDisclosureBody(el);
      closed += 1;
    }
  }
  return closed;
}

export function unloadDisclosureBody(el) {
  const body = typeof el?.querySelector === 'function' ? el.querySelector('.turn-disclosure-body') : null;
  body?.replaceChildren?.();
  if (el?.dataset) el.dataset.hydrated = '0';
}

export function insertTurnDisclosure(wrap, el) {
  if (!wrap || !el) return el;
  const think = wrap.querySelector?.(':scope > .think-block');
  const interrupt = wrap.querySelector?.(':scope > .approval-live, :scope > .clarify-live');
  const answer = wrap.querySelector?.(':scope > .msg');
  if (think) wrap.insertBefore(el, think.nextSibling);
  else if (interrupt) wrap.insertBefore(el, interrupt);
  else if (answer) wrap.insertBefore(el, answer);
  else wrap.appendChild(el);
  return el;
}

export function placeInterruptAfterDisclosure(wrap, el) {
  if (!wrap || !el) return el;
  const disclosure = wrap.querySelector?.(':scope > .turn-disclosure');
  const answer = wrap.querySelector?.(':scope > .msg.assistant, :scope > .msg');
  if (disclosure) wrap.insertBefore(el, disclosure.nextSibling);
  else if (answer) wrap.insertBefore(el, answer);
  else wrap.appendChild(el);
  return el;
}

function existingLiveBrief(el) {
  const glyphs = el?.querySelector?.(`.${LIVE_ACTION_SHINE.glyphClass}`);
  return String(glyphs?.textContent || '').trim();
}

function fillRows(list, rows, t, { shineRowId, labelId } = {}) {
  list.replaceChildren();
  const lastId = shineRowId != null && shineRowId !== '' ? String(shineRowId) : '';
  const markLatest = lastId !== '';
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const visual = formatActivityRow(row, t);
    const isLatest = markLatest && String(row.id || '') === lastId;
    const li = node('li', isLatest ? `turn-disclosure-row ${LIVE_ACTION_SHINE.rowClass}` : 'turn-disclosure-row');
    li.dataset.status = row.status || '';
    li.dataset.icon = visual.iconKind;
    if (row.count > 1) li.dataset.count = String(row.count);
    const icon = node('span', 'turn-disclosure-row-icon', visual.icon);
    icon.setAttribute('aria-hidden', 'true');
    const textClass = isLatest ? LIVE_ACTION_SHINE.glyphClass : 'turn-disclosure-row-text';
    const label = node('span', textClass, visual.label);
    if (isLatest && labelId) li.id = labelId;
    li.append(icon, label);
    list.append(li);
  }
}

/**
 * @param {{
 *   t: (key: string) => string,
 *   getLang?: () => string,
 *   prefersReducedMotion?: () => boolean,
 *   getNow?: () => number
 * }} deps
 */
export function createTurnDisclosureUi(deps) {
  const full = new Map();
  const stubs = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pulseTimers = new Map();
  const holdOpen = new Set();
  let lastPolite = '';
  let politeTimer = 0;

  function t(key) {
    return deps.t(key);
  }

  function reduced() {
    return deps.prefersReducedMotion ? deps.prefersReducedMotion() : prefersReducedMotion();
  }

  function now() {
    return typeof deps.getNow === 'function' ? deps.getNow() : Date.now();
  }

  function disclosureOf(wrap) {
    return wrap?.querySelector?.(':scope > .turn-disclosure') || null;
  }

  function remember(state, extra = {}) {
    const id = String(state?.executionId || extra.executionId || '');
    if (!id) return;
    const stub = foldStubFromState(state, t, extra);
    rememberEndedProjection(full, stubs, id, {
      ...stub,
      summary: Array.isArray(state.summary) ? state.summary.slice() : [],
      phase: state.phase
    });
  }

  function evictHydratedDom(root) {
    const live = root?.querySelectorAll?.('.turn-disclosure.is-live, .turn-disclosure.is-sticky') || [];
    const hydrated = [...(root?.querySelectorAll?.('.turn-disclosure[data-hydrated="1"]') || [])];
    const extras = hydrated.filter((el) => !el.classList.contains('is-live') && !el.classList.contains('is-sticky'));
    const keep = Math.max(0, HYDRATED_DOM_CAP - live.length);
    while (extras.length > keep) {
      const el = extras.shift();
      if (el.open) continue;
      unloadDisclosureBody(el);
    }
  }

  function ensure(wrap, { executionId } = {}) {
    if (!wrap) return null;
    let el = disclosureOf(wrap);
    if (el) {
      if (executionId) el.dataset.executionId = String(executionId);
      return el;
    }
    el = node('section', 'turn-disclosure is-live is-empty');
    el.hidden = true;
    el.dataset.mode = 'live';
    if (executionId) el.dataset.executionId = String(executionId);
    insertTurnDisclosure(wrap, el);
    return el;
  }

  function stripInstrumentExtras(el) {
    el.querySelector('.turn-disclosure-next')?.remove();
    el.querySelector('.turn-disclosure-meta')?.remove();
  }

  function paintLiveRows(el, state, extra = {}) {
    const rows = visibleSummaryRows(state?.summary, 8);
    let list = el.querySelector('.turn-disclosure-rows');
    if (!rows.length) {
      list?.remove();
      return;
    }
    if (!list) {
      list = node('ol', 'turn-disclosure-rows');
      list.setAttribute('role', 'list');
      el.append(list);
    }
    fillRows(list, rows, t, extra);
  }

  function paintFallbackCurrent(el, state, displayText, labelId) {
    const visual = liveActivityVisual(state, displayText, t);
    let head = el.querySelector('.turn-disclosure-head');
    if (!head) {
      head = node('div', 'turn-disclosure-head');
      el.prepend(head);
    }
    let current = head.querySelector(`.${LIVE_ACTION_SHINE.rowClass}`);
    let glyphs = current?.querySelector?.(`.${LIVE_ACTION_SHINE.glyphClass}`);
    let icon = current?.querySelector?.('.turn-disclosure-row-icon');
    if (!current) {
      current = node('span', LIVE_ACTION_SHINE.rowClass);
      icon = node('span', 'turn-disclosure-row-icon', visual.icon);
      icon.setAttribute('aria-hidden', 'true');
      glyphs = node('span', LIVE_ACTION_SHINE.glyphClass, visual.label);
      current.append(icon, glyphs);
      head.replaceChildren(current);
    } else {
      if (!icon) {
        icon = node('span', 'turn-disclosure-row-icon', visual.icon);
        icon.setAttribute('aria-hidden', 'true');
        current.prepend(icon);
      } else if (icon.textContent !== visual.icon) {
        icon.textContent = visual.icon;
      }
      if (!glyphs) {
        glyphs = node('span', LIVE_ACTION_SHINE.glyphClass, visual.label);
        current.append(glyphs);
      } else if (visual.label && glyphs.textContent !== visual.label) {
        glyphs.textContent = visual.label;
      }
    }
    current.id = labelId;
    current.dataset.icon = visual.iconKind;
    if (state.current?.status) current.dataset.status = state.current.status;
    else if (current.dataset) delete current.dataset.status;
  }

  function paintLive(el, state, { mode } = {}) {
    const id = String(state.executionId || el.dataset.executionId || 'live');
    el.dataset.executionId = id;
    el.dataset.mode = mode;
    el.className = `turn-disclosure is-${mode === 'sticky' ? 'sticky' : 'live'}`;
    if (el.tagName === 'DETAILS') {
      const section = node('section', el.className);
      section.dataset.executionId = id;
      section.dataset.mode = mode;
      el.replaceWith(section);
      el = section;
    }
    const lastText = existingLiveBrief(el);
    const plan = planLiveDisclosurePaint(state, lastText, t('liveProgress'), { mode });
    stripInstrumentExtras(el);
    const displayText = plan.text || lastText;
    if (plan.hidden && !plan.keepMounted) {
      el.classList.add('is-empty');
      el.hidden = true;
      if (!lastText) el.replaceChildren();
      return el;
    }
    el.hidden = false;
    el.classList.remove('is-empty');
    const labelId = `td-${id}-label`;
    el.setAttribute('aria-labelledby', labelId);
    if (plan.shineOn === 'latest-row') {
      el.querySelector('.turn-disclosure-head')?.remove();
      paintLiveRows(el, state, { shineRowId: plan.shineRowId, labelId });
    } else {
      el.querySelector('.turn-disclosure-rows')?.remove();
      paintFallbackCurrent(el, state, displayText, labelId);
    }
    return el;
  }

  function fold(wrap, state, extra = {}) {
    const stub = extra.stub || foldStubFromState(state, t, extra);
    let el = disclosureOf(wrap);
    const details = node('details', 'turn-disclosure is-folded');
    details.dataset.mode = 'folded';
    details.dataset.executionId = stub.executionId || state?.executionId || '';
    if (stub.messageId) details.dataset.messageId = stub.messageId;
    details.setAttribute('name', 'turn-disclosure');
    const summary = node('summary', 'turn-disclosure-line', stub.line);
    summary.setAttribute('aria-label', t('tdExpandAria'));
    const body = node('div', 'turn-disclosure-body');
    details.append(summary, body);
    if (el) el.replaceWith(details);
    else insertTurnDisclosure(wrap, details);
    bindDetails(details, wrap);
    remember(state, { ...extra, ...stub });
    return details;
  }

  function hydrate(el, state) {
    if (!el) return false;
    const body = el.querySelector('.turn-disclosure-body') || el;
    const rows = visibleSummaryRows(state?.summary, 8);
    const list = node('ol', 'turn-disclosure-rows');
    list.setAttribute('role', 'list');
    if (!rows.length) {
      body.replaceChildren(node('p', 'turn-disclosure-empty', t('tdNoSummary')));
    } else {
      fillRows(list, rows, t);
      body.replaceChildren(list);
    }
    el.dataset.hydrated = '1';
    return true;
  }

  function bindDetails(el, root) {
    if (!el || el.dataset.tdBound === '1') return el;
    el.dataset.tdBound = '1';
    el.addEventListener('toggle', () => {
      if (el.classList.contains('is-live') || el.classList.contains('is-sticky')) return;
      if (el.open) {
        exclusiveHistoricalOpen(root || el.parentNode, el);
        const id = el.dataset.executionId || '';
        const slice = full.get(id);
        if (slice) hydrate(el, slice);
        else if (el.dataset.hydrated !== '1') {
          const body = el.querySelector('.turn-disclosure-body');
          body?.replaceChildren(node('p', 'turn-disclosure-empty', t('tdNoSummary')));
        }
        evictHydratedDom(root || el.closest?.('.task-body') || el.parentNode);
      } else {
        unloadDisclosureBody(el);
      }
    });
    return el;
  }

  function rebind(root) {
    if (!root) return 0;
    let n = 0;
    root.querySelectorAll?.('.turn-disclosure.is-folded').forEach((el) => {
      if (el.dataset) delete el.dataset.tdBound;
      bindDetails(el, root);
      n += 1;
    });
    return n;
  }

  function dehydrate(root) {
    root?.querySelectorAll?.('.turn-disclosure').forEach((el) => {
      unloadDisclosureBody(el);
      el.classList.remove('is-live', 'is-sticky', 'is-pulse');
      if (!el.classList.contains('is-folded')) el.classList.add('is-folded');
      if ('open' in el) el.open = false;
    });
  }

  function cancelPulse(id) {
    const key = String(id || '');
    const timer = pulseTimers.get(key);
    if (timer) clearTimeout(timer);
    pulseTimers.delete(key);
  }

  function scheduleFold(wrap, state, extra = {}) {
    const id = String(state?.executionId || extra.executionId || '');
    cancelPulse(id);
    if (disclosureMode(state) === 'sticky') {
      ensure(wrap, { executionId: id });
      return paintLive(disclosureOf(wrap), state, { mode: 'sticky' });
    }
    if (holdOpen.has(id) || extra.keepOpen) {
      const el = fold(wrap, state, extra);
      el.open = true;
      hydrate(el, state);
      return el;
    }
    if (
      reduced() ||
      shouldFoldDisclosureImmediately(state, extra) ||
      !persistLiveActionBrief(state, existingLiveBrief(disclosureOf(wrap)))
    ) {
      return fold(wrap, state, extra);
    }
    const el = ensure(wrap, { executionId: id });
    paintLive(el, state, { mode: 'live' });
    el.classList.add('is-pulse');
    el.dataset.mode = 'pulse_complete';
    const onInteract = () => {
      holdOpen.add(id);
      cancelPulse(id);
      const open = fold(wrap, state, extra);
      open.open = true;
      hydrate(open, state);
    };
    el.addEventListener('click', onInteract, { once: true });
    pulseTimers.set(
      id,
      setTimeout(() => {
        pulseTimers.delete(id);
        if (holdOpen.has(id)) return;
        fold(wrap, state, extra);
      }, extra.pulseMs ?? PULSE_COMPLETE_MS)
    );
    return el;
  }

  function paint(wrap, state, extra = {}) {
    if (!wrap) return null;
    const mode = extra.mode || disclosureMode(state);
    if (mode === 'hidden') {
      disclosureOf(wrap)?.remove();
      return null;
    }
    if (mode === 'folded') {
      if (extra.justSettled) return scheduleFold(wrap, state, extra);
      return fold(wrap, state, extra);
    }
    if (mode === 'pulse_complete') return scheduleFold(wrap, state, extra);
    const el = ensure(wrap, { executionId: state.executionId });
    return paintLive(el, state, { mode });
  }

  function foldPreviousPulse(root) {
    root?.querySelectorAll?.('.turn-disclosure[data-mode="pulse_complete"]').forEach((el) => {
      const id = el.dataset.executionId || '';
      cancelPulse(id);
      el.classList.remove('is-pulse');
      const slice = full.get(id);
      const wrap = el.parentNode;
      if (wrap) {
        fold(wrap, slice || { executionId: id, phase: 'completed', startedAt: 0, endedAt: now() }, slice || {});
      }
    });
  }

  function exportMemory() {
    return {
      full: [...full.entries()],
      stubs: [...stubs.entries()]
    };
  }

  function importMemory(snap) {
    full.clear();
    stubs.clear();
    for (const [id, row] of snap?.full || []) full.set(id, row);
    for (const [id, row] of snap?.stubs || []) stubs.set(id, row);
    while (full.size > TURN_MEMORY_CAP) {
      const drop = full.keys().next().value;
      full.delete(drop);
      const stub = stubs.get(drop);
      if (stub) stub.hydrated = false;
    }
  }

  return {
    ensure,
    paint,
    fold,
    hydrate,
    bindDetails,
    rebind,
    dehydrate,
    remember,
    scheduleFold,
    foldPreviousPulse,
    exclusiveOpen: exclusiveHistoricalOpen,
    placeInterrupt: placeInterruptAfterDisclosure,
    exportMemory,
    importMemory,
    memoryFull: () => full,
    memoryStubs: () => stubs,
    formatDisclosureDuration
  };
}
