/**
 * Composer Context chip + usage popover.
 * Projects numbers the UI already has. Never invents a provider-exact percent.
 */

import {
  estimateMessagesTokens,
  estimateTextTokens
} from '../agent/vnext/sessionWorkspace/contextCompact.js';
import {
  buildSessionAgentInstructions,
  WORLD_BLOCK_CHAR_CAP
} from '../agent/vnext/sessionWorkspace/prompt.js';

export const SESSION_TOOL_COUNT = 9;
const HOVER_OPEN_MS = 140;
const HOVER_CLOSE_MS = 220;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function estimateContextParts(input = {}) {
  const prefixText = input.prefixText != null ? String(input.prefixText) : buildSessionAgentInstructions();
  const prefix = estimateTextTokens(prefixText);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const conversation = estimateMessagesTokens(messages);
  const skills = Array.isArray(input.skills) ? input.skills : [];
  const skillText = skills
    .map((s) => `${s?.id || ''} ${s?.name || ''} ${s?.description || ''}`)
    .join('\n');
  const skillsTokens = estimateTextTokens(skillText);
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  return {
    prefix,
    conversation,
    skillsTokens,
    skillCount: skills.length,
    toolCount: num(input.toolCount) > 0 ? Math.round(num(input.toolCount)) : SESSION_TOOL_COUNT,
    artifactCount: artifacts.length,
    tabCount: Math.max(0, Math.round(num(input.tabCount))),
    aimedCount: Math.max(0, Math.round(num(input.aimedCount))),
    groupCount: Math.max(0, Math.round(num(input.groupCount))),
    worldCap: WORLD_BLOCK_CHAR_CAP,
    messageCount: messages.length,
    totalEstimate: prefix + conversation + skillsTokens
  };
}

function displayPct(ratio) {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 0) return null;
  const p = Math.round(ratio * 100);
  if (p === 0 && ratio > 0) return 1;
  return Math.max(0, Math.min(100, p));
}

/**
 * @param {{
 *   lastUsage?: { promptTokens?: number, contextWindow?: number, source?: string, type?: string, compacting?: boolean },
 *   contextWindow?: number,
 *   messages?: object[],
 *   skills?: object[],
 *   artifacts?: object[],
 *   toolCount?: number,
 *   tabCount?: number,
 *   aimedCount?: number,
 *   groupCount?: number,
 *   prefixText?: string
 * }} [input]
 */
export function projectContextUsage(input = {}) {
  const parts = estimateContextParts(input);
  const last = input.lastUsage && typeof input.lastUsage === 'object' ? input.lastUsage : {};
  const windowN = Math.max(0, Math.round(num(input.contextWindow) || 0));
  const lastTokens = Math.max(0, Math.round(num(last.promptTokens)));
  const lastSource = String(last.source || '');
  let source = 'unknown';
  let used = 0;
  if (lastSource === 'api' && lastTokens > 0) {
    source = 'api';
    used = lastTokens;
  } else if (lastSource === 'estimate' && lastTokens > 0) {
    source = 'estimate';
    used = lastTokens;
  } else if (lastTokens > 0 && lastSource !== 'none') {
    source = 'estimate';
    used = lastTokens;
  } else if (parts.totalEstimate > 0) {
    source = 'estimate';
    used = parts.totalEstimate;
  }
  const ratio = windowN > 0 && used > 0 ? used / windowN : null;
  return {
    source,
    used,
    window: windowN,
    ratio,
    pct: displayPct(ratio),
    showPercent: source !== 'unknown' && windowN > 0 && used > 0,
    estimated: source !== 'api',
    parts,
    compacting: last.compacting === true || last.type === 'compacting'
  };
}

export function formatContextChip(projection, t) {
  if (projection?.compacting) return t('compacting');
  if (projection?.showPercent && projection.pct != null) {
    return projection.source === 'api'
      ? t('contextUsage').replace('{pct}', String(projection.pct))
      : t('contextUsageEstimateChip').replace('{pct}', String(projection.pct));
  }
  return t('contextChip');
}

export function formatContextHeadline(projection, t) {
  if (!projection) return t('contextUsageUnknown');
  if (projection.source === 'unknown' || !projection.used) return t('contextUsageUnknown');
  const used = Number(projection.used).toLocaleString();
  const windowN = projection.window > 0 ? Number(projection.window).toLocaleString() : '—';
  const pct = projection.pct != null ? String(projection.pct) : '—';
  if (projection.source === 'api' && projection.window > 0) {
    return t('contextUsageDetail').replace('{used}', used).replace('{window}', windowN).replace('{pct}', pct);
  }
  if (projection.window > 0) {
    return t('contextUsageEstimate').replace('{used}', used).replace('{window}', windowN).replace('{pct}', pct);
  }
  return t('contextUsageEstimateUsed').replace('{used}', used);
}

export function formatContextPartMeta(key, parts, t) {
  if (key === 'prefix') return t('contextPartTokensEst').replace('{n}', String(parts.prefix || 0));
  if (key === 'tools') return t('contextPartCount').replace('{n}', String(parts.toolCount || 0));
  if (key === 'skills') return t('contextPartCount').replace('{n}', String(parts.skillCount || 0));
  if (key === 'world') {
    const bits = [
      t('contextPartWorldCap').replace('{n}', String(parts.worldCap || WORLD_BLOCK_CHAR_CAP)),
      t('contextPartCount').replace('{n}', String((parts.tabCount || 0) + (parts.aimedCount || 0)))
    ];
    if (parts.artifactCount) bits.push(t('contextPartArtifacts').replace('{n}', String(parts.artifactCount)));
    return bits.join(' · ');
  }
  if (key === 'conversation') {
    return t('contextPartTokensEst').replace('{n}', String(parts.conversation || 0));
  }
  return '';
}

export function contextPartRows(projection, t) {
  const parts = projection?.parts || estimateContextParts();
  return [
    { key: 'prefix', label: t('contextPartPrefix'), meta: formatContextPartMeta('prefix', parts, t) },
    { key: 'tools', label: t('contextPartTools'), meta: formatContextPartMeta('tools', parts, t) },
    { key: 'skills', label: t('contextPartSkills'), meta: formatContextPartMeta('skills', parts, t) },
    { key: 'world', label: t('contextPartWorld'), meta: formatContextPartMeta('world', parts, t) },
    { key: 'conversation', label: t('contextPartConversation'), meta: formatContextPartMeta('conversation', parts, t) }
  ];
}

function positionAboveTrigger(trigger, menu) {
  const r = trigger.getBoundingClientRect();
  const gap = 8;
  menu.style.position = 'fixed';
  menu.style.inset = 'auto';
  menu.style.margin = '0';
  menu.style.top = 'auto';
  menu.style.left = 'auto';
  menu.style.bottom = `${Math.round(Math.max(8, window.innerHeight - r.top + gap))}px`;
  menu.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`;
  menu.style.zIndex = '10050';
}

function canHover() {
  try {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return true;
  }
}

export function paintContextUsage(els, projection, t, extras = {}) {
  const compacting = extras.compacting === true || projection?.compacting === true;
  const chipText = formatContextChip({ ...projection, compacting }, t);
  const tip = compacting ? t('compacting') : formatContextHeadline(projection, t);
  if (els.chip) els.chip.textContent = chipText;
  if (els.button) {
    els.button.setAttribute('aria-label', tip);
    els.button.removeAttribute('title');
    els.button.classList.toggle('is-compacting', compacting);
    els.button.classList.toggle('is-warm', !compacting && (projection?.ratio || 0) >= 0.8);
    els.button.dataset.source = projection?.source || 'unknown';
  }
  if (els.ring) {
    const ratio = projection?.showPercent ? Math.max(0, Math.min(1, projection.ratio || 0)) : 0;
    els.ring.style.setProperty('--context-ratio', String(ratio));
    els.ring.dataset.ratio = projection?.showPercent ? String(projection.pct || 0) : '0';
    els.ring.classList.toggle('is-compacting', compacting);
    els.ring.classList.toggle('is-warm', !compacting && (projection?.ratio || 0) >= 0.8);
    if (projection?.showPercent && projection.pct != null) els.ring.setAttribute('aria-valuenow', String(projection.pct));
    else els.ring.removeAttribute('aria-valuenow');
  }
  if (els.ringLabel) {
    els.ringLabel.hidden = !compacting;
    els.ringLabel.textContent = t('compacting');
  }
  if (els.headline) els.headline.textContent = tip;
  if (els.bar) {
    els.bar.hidden = !projection?.showPercent;
    if (els.barFill && projection?.showPercent) {
      els.bar.style.setProperty('--context-ratio', String(Math.max(0, Math.min(1, projection.ratio || 0))));
    }
  }
  if (els.parts) {
    els.parts.replaceChildren();
    for (const row of contextPartRows(projection, t)) {
      const li = document.createElement('li');
      li.className = 'context-usage-part';
      li.dataset.k = row.key;
      const name = document.createElement('span');
      name.className = 'context-usage-part-name';
      name.textContent = row.label;
      const meta = document.createElement('span');
      meta.className = 'context-usage-part-meta';
      meta.textContent = row.meta;
      li.append(name, meta);
      els.parts.append(li);
    }
  }
  if (els.note) {
    const showNote = projection?.estimated === true && projection?.source !== 'unknown';
    els.note.hidden = !showNote;
    els.note.textContent = showNote ? t('contextEstimateNote') : '';
  }
  document.querySelector('footer.composer')?.classList.toggle('is-compacting-context', compacting);
}

/**
 * @param {{
 *   t: (key: string) => string,
 *   getButton: () => HTMLElement|null,
 *   getPopover: () => HTMLElement|null,
 *   getEls?: () => object,
 *   gather: () => object,
 *   prefersReducedMotion?: () => boolean
 * }} deps
 */
export function createContextUsageUi(deps) {
  let openTimer = 0;
  let closeTimer = 0;
  let open = false;
  let homeParent = null;

  function els() {
    if (typeof deps.getEls === 'function') return deps.getEls() || {};
    return {
      button: deps.getButton?.(),
      popover: deps.getPopover?.(),
      chip: document.getElementById('contextUsageChip'),
      ring: document.getElementById('contextRing'),
      ringLabel: document.getElementById('contextRingLabel'),
      headline: document.getElementById('contextUsageHeadline'),
      bar: document.getElementById('contextUsageBar'),
      barFill: document.getElementById('contextUsageBarFill'),
      parts: document.getElementById('contextUsageParts'),
      note: document.getElementById('contextUsageNote')
    };
  }

  function snapshot() {
    return projectContextUsage(deps.gather?.() || {});
  }

  function render(projection, extras = {}) {
    const proj = projection || snapshot();
    paintContextUsage(els(), proj, deps.t, extras);
    return proj;
  }

  function setOpen(next) {
    const nodes = els();
    const btn = nodes.button;
    const pop = nodes.popover;
    open = next === true;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!pop) return;
    const home = homeParent || document.getElementById('composerContext') || pop.parentElement;
    if (open) {
      render();
      // Composer uses overflow:hidden + backdrop-filter, which clips position:fixed
      // descendants and loses to #panelScroll. Same escape as group/model menus.
      if (!homeParent && pop.parentElement && pop.parentElement !== document.body) {
        homeParent = pop.parentElement;
      }
      if (document.body && pop.parentElement !== document.body) {
        document.body.appendChild(pop);
      }
      pop.hidden = false;
      pop.classList.add('is-open');
      if (btn) positionAboveTrigger(btn, pop);
    } else {
      pop.hidden = true;
      pop.classList.remove('is-open');
      if (home && pop.parentElement === document.body && home !== document.body) {
        home.appendChild(pop);
      }
    }
  }

  function clearTimers() {
    if (openTimer) clearTimeout(openTimer);
    if (closeTimer) clearTimeout(closeTimer);
    openTimer = 0;
    closeTimer = 0;
  }

  function scheduleOpen() {
    clearTimers();
    const delay = deps.prefersReducedMotion?.() ? 0 : HOVER_OPEN_MS;
    openTimer = setTimeout(() => setOpen(true), delay);
  }

  function scheduleClose() {
    clearTimers();
    const delay = deps.prefersReducedMotion?.() ? 0 : HOVER_CLOSE_MS;
    closeTimer = setTimeout(() => setOpen(false), delay);
  }

  function bind() {
    const btn = deps.getButton?.();
    const pop = deps.getPopover?.();
    if (!btn || !pop || btn.dataset.contextBound === '1') return;
    btn.dataset.contextBound = '1';
    if (!pop.id) pop.id = 'contextUsagePopover';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', pop.id);
    btn.setAttribute('aria-expanded', 'false');
    pop.hidden = true;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!open);
    });
    if (canHover()) {
      btn.addEventListener('pointerenter', scheduleOpen);
      btn.addEventListener('pointerleave', scheduleClose);
      pop.addEventListener('pointerenter', () => {
        clearTimers();
        setOpen(true);
      });
      pop.addEventListener('pointerleave', scheduleClose);
    }
    document.addEventListener('click', (e) => {
      if (!open) return;
      const target = /** @type {Node|null} */ (e.target);
      if (btn.contains(target) || pop.contains(target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        btn.focus?.();
      }
    });
    window.addEventListener('resize', () => {
      if (open) positionAboveTrigger(btn, pop);
    });
  }

  bind();
  render();

  return {
    render,
    snapshot,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    bind
  };
}
