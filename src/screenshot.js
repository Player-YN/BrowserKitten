/**
 * BrowserBot user screenshot helpers (CAPTURE_WP)
 * Pure helpers + message contracts. Capture is user-operated only (hotkey / button).
 */

import {
  isVisionCapableModel,
  isKnownTextOnlyChatModel,
  classifyChatVisionCapability
} from './agent/modelCatalog.js';

export { isVisionCapableModel, isKnownTextOnlyChatModel, classifyChatVisionCapability };

/** Default Chrome command suggested key (also storage default). */
export const DEFAULT_CAPTURE_SHORTCUT = 'Alt+Shift+C';

/** chrome.commands command name */
export const CAPTURE_COMMAND = 'capture-screenshot';

/** storage keys */
export const STORAGE_CAPTURE_SHORTCUT = 'browserbot_capture_shortcut';
export const STORAGE_PENDING_SCREENSHOT = 'browserbot_pending_screenshot';

/** runtime message actions */
export const MSG = {
  CAPTURE_REQUEST: 'browserbot_capture_screenshot',
  CAPTURE_RESULT: 'browserbot_capture_result',
  SCREENSHOT_CAPTURED: 'screenshot_captured',
  COPY_IMAGE_CLIPBOARD: 'browserbot_copy_image_clipboard',
  /** Start Win+Shift+S style region picker on the page */
  START_REGION_CAPTURE: 'browserbot_start_region_capture',
  CANCEL_REGION_CAPTURE: 'browserbot_cancel_region_capture',
  REGION_SELECTED: 'browserbot_region_selected',
  REGION_CANCELLED: 'browserbot_region_cancelled'
};

/**
 * Bilingual informational note when the user sends images on a known text-only model.
 * Non-blocking: attachments still go out; a provider reject surfaces as a real error.
 * @param {string} [lang] 'zh' | 'en'
 * @param {string} [modelId]
 */
export function notMultimodalMessage(lang = 'zh', modelId = '') {
  const modelHint = modelId ? ` (${modelId})` : '';
  if (lang === 'en') {
    return (
      `This model is typically text-only${modelHint}. Images will still be sent; ` +
      `if the provider rejects them, the real error will show.`
    );
  }
  return (
    `该模型通常不支持视觉${modelHint}。图片仍会发送；若接口拒绝会显示真实错误。`
  );
}

/**
 * Build a pending chat attachment object from a capture dataURL.
 * @param {string} dataUrl
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {string} [opts.source] 'hotkey' | 'button' | 'pending'
 */
export function attachmentFromDataUrl(dataUrl, opts = {}) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    throw new Error('Invalid screenshot dataURL');
  }
  const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);/.exec(dataUrl);
  const type = mimeMatch ? mimeMatch[1] : 'image/png';
  const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
  const name = opts.name || `screenshot_${Date.now()}.${ext}`;
  return {
    name,
    type,
    isImage: true,
    dataUrl,
    source: opts.source || 'screenshot'
  };
}

/**
 * dataURL → Blob (for ClipboardItem).
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Malformed dataURL');
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(header);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Copy image dataURL to system clipboard (must run in a document context with focus).
 * @param {string} dataUrl
 * @returns {Promise<boolean>}
 */
export async function copyDataUrlToClipboard(dataUrl) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    return false;
  }
  const blob = dataUrlToBlob(dataUrl);
  const type = blob.type || 'image/png';
  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
  return true;
}

/**
 * Parse a shortcut string like "Alt+Shift+C" into parts.
 * @param {string} shortcutStr
 * @returns {{ alt: boolean, ctrl: boolean, shift: boolean, meta: boolean, key: string }}
 */
export function parseShortcut(shortcutStr) {
  const parts = String(shortcutStr || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const lower = parts.map((p) => p.toLowerCase());
  const key = parts.find((p) => !['alt', 'ctrl', 'control', 'shift', 'meta', 'cmd', 'command'].includes(p.toLowerCase())) || '';
  return {
    alt: lower.includes('alt'),
    ctrl: lower.includes('ctrl') || lower.includes('control'),
    shift: lower.includes('shift'),
    meta: lower.includes('meta') || lower.includes('cmd') || lower.includes('command'),
    key: key.toUpperCase()
  };
}

/**
 * Match KeyboardEvent against stored shortcut string.
 * @param {KeyboardEvent} e
 * @param {string} shortcutStr
 */
export function matchShortcutEvent(e, shortcutStr) {
  const p = parseShortcut(shortcutStr);
  if (!p.key) return false;
  if (p.alt !== e.altKey || p.ctrl !== e.ctrlKey || p.shift !== e.shiftKey) return false;
  // meta optional strictness: only require if specified
  if (p.meta && !e.metaKey) return false;
  const keyName = (e.key || '').toUpperCase();
  const codeKey = (e.code || '').replace(/^Key/i, '').toUpperCase();
  return keyName === p.key || codeKey === p.key || (e.key === ' ' && p.key === 'SPACE');
}

/**
 * Load capture shortcut from storage (falls back to default).
 * @returns {Promise<string>}
 */
export function loadCaptureShortcut() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_CAPTURE_SHORTCUT], (res) => {
        resolve(res?.[STORAGE_CAPTURE_SHORTCUT] || DEFAULT_CAPTURE_SHORTCUT);
      });
    } catch {
      resolve(DEFAULT_CAPTURE_SHORTCUT);
    }
  });
}

/**
 * Persist capture shortcut label (display + optional in-page match).
 * @param {string} shortcutStr
 * @returns {Promise<void>}
 */
export function saveCaptureShortcut(shortcutStr) {
  const value = shortcutStr || DEFAULT_CAPTURE_SHORTCUT;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_CAPTURE_SHORTCUT]: value }, () => resolve());
  });
}

/**
 * Whether attachment list contains any image.
 * @param {Array<{isImage?: boolean}>} attachments
 */
export function hasImageAttachments(attachments) {
  return Array.isArray(attachments) && attachments.some((a) => a && a.isImage);
}
