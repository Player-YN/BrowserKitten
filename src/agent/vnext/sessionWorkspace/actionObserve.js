/**
 * Action observation for the model: compact control lists, smart screenshot attach.
 * Host policy / document bind stay elsewhere.
 */
import { sessionToolToModelOutput } from './canvasPreview.js';

export const ACTION_MODEL_CONTROL_CAP = 40;
export const ACTION_MODEL_NAME_CHARS = 120;
export const SCREENSHOT_SPARSE_CONTROL_MAX = 8;

/**
 * @param {unknown} url
 */
export function normalizeObserveUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return raw.split('#')[0].split('?')[0];
  }
}

/**
 * Stable key for "already dual-observed this execution".
 * @param {number|string} tabId
 * @param {{ documentId?: string, url?: string }|null} page
 */
export function observeDocumentKey(tabId, page) {
  const id = Number(tabId);
  if (!Number.isFinite(id) || id <= 0) return '';
  const doc = page && typeof page === 'object' ? String(page.documentId || '').trim() : '';
  const url = page && typeof page === 'object' ? normalizeObserveUrl(page.url) : '';
  if (!doc && !url) return '';
  return `${id}:${doc || url}`;
}

/**
 * New page: unobserved this execution, or top-frame documentId / URL changed.
 * @param {object} [input]
 */
export function isNewPageObservation(input = {}) {
  if (input.unobservedThisExecution === true) return true;
  const page = input.page && typeof input.page === 'object' ? input.page : null;
  const previous = input.previousPage && typeof input.previousPage === 'object' ? input.previousPage : null;
  if (!page || !previous) return false;
  if (page.documentId && previous.documentId && page.documentId !== previous.documentId) return true;
  const now = normalizeObserveUrl(page.url);
  const was = normalizeObserveUrl(previous.url);
  return Boolean(now && was && now !== was);
}

/**
 * @param {object} [input]
 */
export function shouldAttachPageScreenshot(input = {}) {
  const mode = String(input.observe || '').trim().toLowerCase();
  if (mode === 'screenshot' || mode === 'both') return true;
  if (mode === 'none') return false;
  if (isNewPageObservation(input)) return true;
  const count = Number(input.controlCount);
  if (Number.isFinite(count) && count <= 0) return true;
  const canvas = Number(input.canvasCount) || 0;
  if (canvas > 0 && Number.isFinite(count) && count <= SCREENSHOT_SPARSE_CONTROL_MAX) return true;
  return false;
}

/**
 * @param {Array<object>|undefined} controls
 * @param {number} [cap]
 */
export function compactActionControls(controls, cap = ACTION_MODEL_CONTROL_CAP) {
  const list = Array.isArray(controls) ? controls : [];
  return list.slice(0, Math.max(1, cap)).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const name = String(row.name || '').slice(0, ACTION_MODEL_NAME_CHARS);
    const role = String(row.role || '');
    const keepOptions = role === 'combobox' || role === 'listbox' || String(row.type || '') === 'select-one';
    const next = {
      ref: row.ref,
      role: row.role,
      name,
      type: row.type,
      value: row.value,
      visible: row.visible,
      frameId: row.frameId,
      documentId: row.documentId
    };
    if (keepOptions && Array.isArray(row.options)) next.options = row.options.slice(0, 12);
    return next;
  });
}

/**
 * @param {object} result
 */
export function compactActionResult(result) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  delete next.modelParts;
  delete next.imageBase64;
  delete next.base64;
  delete next.dataUrl;
  if (Array.isArray(next.controls)) {
    next.controls = compactActionControls(next.controls);
    if (next.count == null) next.count = next.controls.length;
  }
  if (Array.isArray(next.frames)) {
    next.frames = next.frames.map((frame) => {
      if (!frame || typeof frame !== 'object') return frame;
      return {
        frameId: frame.frameId,
        url: frame.url,
        documentId: frame.documentId,
        count: frame.count,
        title: frame.title
      };
    });
  }
  return next;
}

/**
 * Short facts the next hop must keep even when a JPEG is attached.
 * Never includes raw image bytes.
 * @param {object} result
 */
export function actionResultToModelFacts(result) {
  const compact = compactActionResult(result);
  if (!compact || typeof compact !== 'object') return {};
  const pageIn = compact.page && typeof compact.page === 'object' ? compact.page : null;
  const page = pageIn
    ? {
        url: pageIn.url || '',
        title: pageIn.title || '',
        documentId: pageIn.documentId || compact.documentId || ''
      }
    : undefined;
  /** @type {Record<string, unknown>} */
  const facts = {};
  if (compact.ok != null) facts.ok = compact.ok;
  if (compact.op) facts.op = compact.op;
  if (compact.rev) facts.rev = compact.rev;
  if (compact.tabId != null) facts.tabId = compact.tabId;
  if (page) facts.page = page;
  if (compact.count != null) facts.count = compact.count;
  if (Array.isArray(compact.controls)) facts.controls = compact.controls;
  if (compact.canvasCount != null) facts.canvasCount = compact.canvasCount;
  if (compact.after != null) facts.after = compact.after;
  if (compact.methodUsed) facts.methodUsed = compact.methodUsed;
  if (compact.hint) facts.hint = compact.hint;
  if (compact.cause) facts.cause = compact.cause;
  if (compact.code) facts.code = compact.code;
  if (compact.error) facts.error = compact.error;
  if (compact.observationError) facts.observationError = compact.observationError;
  if (compact.screenshotError) facts.screenshotError = compact.screenshotError;
  if (compact.screenshot && compact.screenshot.attached) facts.screenshot = { attached: true };
  if (Array.isArray(compact.results)) facts.results = compact.results;
  if (compact.partial) facts.partial = compact.partial;
  for (const key of ['listen', 'listening', 'path', 'mediaType', 'bytes', 'audible', 'text', 'transcriptPath', 'model', 'media', 'mediaElements', 'stt', 'captureKind', 'scope', 'durationMs', 'truncated']) {
    if (result[key] != null) facts[key] = result[key];
  }
  return facts;
}

/**
 * @param {{ base64?: string, mediaType?: string, label?: string }} shot
 */
export function screenshotToModelParts(shot = {}) {
  const data = String(shot.base64 || shot.data || '').trim();
  if (!data) return [];
  return [
    { type: 'text', text: String(shot.label || 'Page screenshot') },
    { type: 'file', data, mediaType: shot.mediaType || 'image/jpeg' }
  ];
}

/**
 * Dual model hop: compact facts JSON + JPEG file parts. Never vision-only.
 * @param {{ output?: object }} opts
 */
export function actionToModelOutput(opts = {}) {
  const raw = opts.output && typeof opts.output === 'object' ? opts.output : {};
  const modelParts = Array.isArray(raw.modelParts) ? raw.modelParts : [];
  const facts = actionResultToModelFacts(raw);
  if (modelParts.length) facts.modelParts = modelParts;
  return sessionToolToModelOutput({ output: facts });
}
