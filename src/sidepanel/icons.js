/**
 * Inline SVG icons (consistent chrome; no emoji dependency for primary actions).
 */

/** @param {string} pathD @param {{ size?: number, stroke?: number }} [o] */
function svg(pathD, o = {}) {
  const size = o.size ?? 16;
  const sw = o.stroke ?? 2;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathD}</svg>`;
}

/** Official eared-tab mark (A · r4 ear8 gap4 · Q · flush). Body = currentColor, right ear = signal. */
const MARK_BODY =
  'M6 14 L9.5 5.5 Q10.5 2.5 11.5 5.5 L15 14 H17 L20.5 5.5 Q21.5 2.5 22.5 5.5 L26 14 A4 4 0 0 1 30 18 V26 A4 4 0 0 1 26 30 H6 A4 4 0 0 1 2 26 V18 A4 4 0 0 1 6 14 Z';
const MARK_EAR = 'M17 14 L20.5 5.5 Q21.5 2.5 22.5 5.5 L26 14 Z';

/**
 * Brand mark — topbar + 点选 + empty home.
 * @param {number} [size]
 * @param {{ className?: string }} [o]
 */
export function brandMarkSvg(size = 16, o = {}) {
  const cls = o.className ? ` class="${o.className}"` : ' class="brand-mark-svg"';
  return `<svg${cls} viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" fill="none">
    <path class="logo-body" fill="currentColor" d="${MARK_BODY}"/>
    <path class="logo-ear" d="${MARK_EAR}"/>
  </svg>`;
}

export const ICONS = {
  send: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', { size: 18 }),
  stop: `<span class="stop-icon-box" aria-hidden="true"></span>`,
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'
  ),
  moon: svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  system: svg(
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'
  ),
  paperclip: svg(
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'
  ),
  wand: svg(
    '<path d="m15 4-1 3-3 1 3 1 1 3 1-3 3-1-3-1z"/><path d="M4 20 14 10"/><path d="m18 8 2 2"/>'
  ),
  /** Brand / 点选 */
  mark: brandMarkSvg(16),
  markLg: brandMarkSvg(22),
  /** Subtle pushpin / nail for selection → clipboard */
  pin: svg(
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11-2.36l1-4A2 2 0 0 1 10.76 2h2.48a2 2 0 0 1 1.87 2.4l-1 4A2 2 0 0 1 13 10.76V17"/><path d="M8 17h8"/>',
    { size: 14, stroke: 1.75 }
  ),
  gear: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  ),
  more: svg(
    '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
  ),
  /** Lucide pencil — session / group rename */
  pencil: svg(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    { size: 13 }
  ),
  /** Lucide book — inspect / read */
  book: svg(
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    { size: 14, stroke: 1.75 }
  ),
  /** Lucide wrench — run / guest code */
  wrench: svg(
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    { size: 14, stroke: 1.75 }
  ),
  /** Lucide lightbulb — think */
  lightbulb: svg(
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    { size: 14, stroke: 1.75 }
  ),
  /** Lucide clock — wait / approval */
  clock: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    { size: 14, stroke: 1.75 }
  ),
  /** Lucide triangle-alert — error */
  alert: svg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    { size: 14, stroke: 1.75 }
  )
};

const ACTIVITY_MARK = { size: 14, stroke: 1.75 };

/** Turn-summary row marks. Same helper / weight as ICONS; currentColor → --ink. */
export const ACTIVITY_ICONS = {
  think: ICONS.lightbulb,
  read: ICONS.book,
  run: ICONS.wrench,
  browser: svg(
    '<path d="m15 4-1 3-3 1 3 1 1 3 1-3 3-1-3-1z"/><path d="M4 20 14 10"/><path d="m18 8 2 2"/>',
    ACTIVITY_MARK
  ),
  write: svg(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    ACTIVITY_MARK
  ),
  wait: ICONS.clock,
  error: ICONS.alert
};

/**
 * Optional topbar SVG icons (keeps accessible names on the button).
 * Emoji fallback remains if this is not called.
 */
export function enhanceTopbarIcons() {
  const gear = document.getElementById('gearBtn');
  if (gear && !gear.querySelector('svg')) {
    gear.innerHTML = ICONS.gear;
  }
  const more = document.getElementById('moreBtn');
  if (more && !more.querySelector('svg')) {
    more.innerHTML = ICONS.gear;
  }
  const logo = document.querySelector('.brand .logo, #brandLogo');
  if (logo) {
    logo.innerHTML = brandMarkSvg(20);
    logo.classList.add('logo-mark');
  }
  const pickIcon = document.querySelector('#pickBtn .pick-icon');
  if (pickIcon) {
    pickIcon.innerHTML = brandMarkSvg(16);
    pickIcon.classList.add('pick-icon-mark');
  }
  const edgeFab = document.getElementById('sessionEdgeFab');
  const edgeIcon = edgeFab?.querySelector('.session-edge-fab-icon');
  if (edgeIcon && !edgeIcon.querySelector('svg')) {
    edgeIcon.innerHTML = brandMarkSvg(14, { className: 'brand-mark-svg session-edge-mark' });
  }
  const pinIcon = document.querySelector('#pinSelBtn .sel-pin-icon');
  if (pinIcon && !pinIcon.querySelector('svg')) {
    pinIcon.innerHTML = ICONS.pin;
  }
  document.querySelectorAll('.home-mark').forEach((el) => {
    el.innerHTML = brandMarkSvg(72, { className: 'brand-mark-svg mark-svg-hero' });
    el.classList.add('home-mark-hero');
    el.setAttribute('title', el.tagName === 'A' ? 'BrowserKitten.com' : '');
  });
}

/**
 * Ensure composer send/stop use vector icons on their own buttons.
 * Visibility swap is owned by sendStop.applySendStopUi — boot seeds idle via setAgentRunningUi(false).
 */
export function enhanceComposerIcons() {
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) {
    const sendIcon = sendBtn.querySelector('.send-icon');
    if (sendIcon) {
      sendIcon.innerHTML = `<svg class="send-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
    }
  }
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    const stopIcon = stopBtn.querySelector('.stop-icon');
    if (stopIcon) {
      stopIcon.innerHTML = `<svg class="stop-svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>`;
    }
  }
}
