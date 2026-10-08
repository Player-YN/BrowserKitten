/**
 * Composer send / stop — two distinct buttons (show/hide swap, not color morph).
 */

/** Clear "arrow up" send — cannot be mistaken for media play */
const SEND_SVG = `<svg class="send-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;

/** Stop square */
const STOP_SVG = `<svg class="stop-svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>`;

function ensureSendIcon(sendBtn) {
  let sendIcon = sendBtn.querySelector('.send-icon');
  if (!sendIcon) {
    sendIcon = document.createElement('span');
    sendIcon.className = 'send-icon';
    sendIcon.setAttribute('aria-hidden', 'true');
    sendBtn.appendChild(sendIcon);
  }
  sendIcon.innerHTML = SEND_SVG;
  return sendIcon;
}

function ensureStopIcon(stopBtn) {
  let stopIcon = stopBtn.querySelector('.stop-icon');
  if (!stopIcon) {
    stopIcon = document.createElement('span');
    stopIcon.className = 'stop-icon';
    stopIcon.setAttribute('aria-hidden', 'true');
    stopBtn.appendChild(stopIcon);
  }
  stopIcon.innerHTML = STOP_SVG;
  return stopIcon;
}

/**
 * Send stays available while a turn runs so the next prompt can queue.
 * Stop shows beside it (with live pulse) and does not replace send.
 * @param {boolean} running
 * @param {{
 *   setStatus?: (mode: string) => void,
 *   lang?: string,
 *   onRunningChange?: (running: boolean) => void
 * }} [ctx]
 */
export function applySendStopUi(running, ctx = {}) {
  const isRun = !!running;
  ctx.onRunningChange?.(isRun);
  ctx.setStatus?.(isRun ? 'running' : 'ready');

  const lang = ctx.lang === 'en' ? 'en' : 'zh';
  const sendTitle = lang === 'en' ? 'Send' : '发送';
  const stopTitle = lang === 'en' ? 'Stop' : '停止';

  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) {
    ensureSendIcon(sendBtn);
    sendBtn.hidden = false;
    sendBtn.setAttribute('aria-hidden', 'false');
    sendBtn.style.display = '';
    sendBtn.disabled = false;
    // Preserve chat/run submit mode (set by applyComposerSubmitMode); only clear stop morph classes
    if (!sendBtn.dataset.submit) sendBtn.dataset.submit = 'chat';
    sendBtn.dataset.mode = sendBtn.dataset.submit || 'chat';
    sendBtn.classList.add('is-send');
    sendBtn.classList.remove('is-stop', 'is-morphing');
    // Title restored by applyComposerSubmitMode after idle; keep generic while stopping
    sendBtn.title = sendTitle;
    sendBtn.setAttribute('aria-label', sendTitle);
  }

  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    ensureStopIcon(stopBtn);
    stopBtn.hidden = !isRun;
    stopBtn.setAttribute('aria-hidden', isRun ? 'false' : 'true');
    if (isRun) {
      stopBtn.style.display = '';
    } else {
      stopBtn.style.display = 'none';
    }
    stopBtn.disabled = false;
    stopBtn.title = stopTitle;
    stopBtn.setAttribute('aria-label', stopTitle);
    stopBtn.classList.toggle('is-live', isRun);
  }
}
