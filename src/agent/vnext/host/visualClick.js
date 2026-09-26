/** DOM-miss → model pointer, then one CDP click and a coarse settle check. */

import { normalizeObserveUrl } from '../sessionWorkspace/actionObserve.js';

export const POINTER_SETTLE_MS = 300;
export const VIEWPORT_ASPECT_TOLERANCE = 0.08;

export const FALLBACK_VISUAL_HINT =
  'Call action op=pointer on this same tabId. x and y are 0–1 viewport units and method=cdp. The host does not choose the point.';

const VISUAL_OPS = new Set(['click', 'fill', 'fill_form']);
const BLOCKED_CODES = new Set([
  'PAYMENT_DENIED',
  'TAB_LEASED',
  'BAD_INPUT',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_DENIED',
  'APPROVAL_MISMATCH',
  'ACTION_OUTCOME_UNKNOWN',
  'FILE_CHOOSER',
  'NEED_EXPLICIT_TAB',
  'TARGET_CHANGED',
  'CDP_BUSY',
  'SYS_DENIED'
]);

const replayBlocked = new Set();

/**
 * @param {object|null|undefined} result
 * @param {string} op
 */
export function visualFallbackCause(result, op) {
  if (!VISUAL_OPS.has(String(op || '').toLowerCase())) return '';
  if (!result || result.ok !== false) return '';
  const code = String(result.code || '');
  if (BLOCKED_CODES.has(code)) return '';
  if (code === 'NO_TARGET') return 'NO_TARGET';
  if (code === 'STALE_REF' && result.refreshed === true) return 'STALE_REF';
  if (result.hit === 'canvas') return 'canvas';
  if (result.occluded === true) return 'occluded';
  if (code === 'NEED_PAGE' && result.frameUnreachable === true) return 'frame';
  return '';
}

/**
 * @param {object} result
 * @param {string} op
 */
export function withVisualFallback(result, op) {
  const cause = visualFallbackCause(result, op);
  if (!cause || !result || typeof result !== 'object') return result;
  return {
    ...result,
    ok: false,
    code: 'FALLBACK_VISUAL',
    cause,
    hint: FALLBACK_VISUAL_HINT
  };
}

/**
 * CSS viewport pixels. devicePixelRatio is not a factor; scroll offsets are not added.
 * @param {number} x
 * @param {number} y
 * @param {{ clientWidth?: number, clientHeight?: number }} viewport
 */
export function cssViewportPoint(x, y, viewport) {
  const w = Number(viewport?.clientWidth);
  const h = Number(viewport?.clientHeight);
  if (!(w > 0) || !(h > 0)) return null;
  return { x: Number(x) * w, y: Number(y) * h };
}

/**
 * @param {number} shotW
 * @param {number} shotH
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} [tolerance]
 */
export function viewportAspectMismatch(shotW, shotH, cssW, cssH, tolerance = VIEWPORT_ASPECT_TOLERANCE) {
  if (!(shotW > 0) || !(shotH > 0) || !(cssW > 0) || !(cssH > 0)) return false;
  const shot = shotW / shotH;
  const css = cssW / cssH;
  if (!(css > 0)) return false;
  return Math.abs(shot - css) / css > tolerance;
}

/**
 * Read a JPEG SOF size. Returns null when the marker is absent.
 * @param {string} base64
 */
export function jpegPixelSize(base64) {
  const bytes = decodeBase64(base64);
  if (!bytes || bytes.length < 10) return null;
  for (let i = 0; i < bytes.length - 9; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    if (marker < 0xc0 || marker > 0xc3 || marker === 0xc4) continue;
    const height = (bytes[i + 5] << 8) | bytes[i + 6];
    const width = (bytes[i + 7] << 8) | bytes[i + 8];
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

/**
 * 8×8 quantized RGB hash. Identical samples hash the same.
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba
 */
export function coarseSampleHash(rgba) {
  const data = rgba || [];
  let hash = 5381;
  for (let i = 0; i + 2 < data.length; i += 4) {
    const q = ((data[i] >> 5) << 8) | ((data[i + 1] >> 5) << 4) | (data[i + 2] >> 5);
    hash = ((Math.imul(hash, 33) ^ q) >>> 0);
  }
  return hash.toString(16);
}

/**
 * @param {string} base64
 */
export async function coarseScreenshotHash(base64) {
  const data = String(base64 || '').trim();
  if (!data) return '';
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return coarseSampleHash(decodeBase64(data) || []);
  }
  try {
    const bytes = decodeBase64(data);
    if (!bytes) return '';
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(8, 8);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return coarseSampleHash(bytes);
    ctx.drawImage(bitmap, 0, 0, 8, 8);
    const pixels = ctx.getImageData(0, 0, 8, 8).data;
    if (typeof bitmap.close === 'function') bitmap.close();
    return coarseSampleHash(pixels);
  } catch {
    return coarseSampleHash(decodeBase64(data) || []);
  }
}

/**
 * @param {{ url?: string, documentId?: string, hash?: string }} before
 * @param {{ url?: string, documentId?: string, hash?: string }} after
 */
export function visualSceneChanged(before, after) {
  const prev = before && typeof before === 'object' ? before : {};
  const next = after && typeof after === 'object' ? after : {};
  if (normalizeObserveUrl(prev.url) !== normalizeObserveUrl(next.url)) return true;
  if (String(prev.documentId || '') !== String(next.documentId || '')) return true;
  if (prev.hash && next.hash && prev.hash !== next.hash) return true;
  return false;
}

export function visualReplayKey(executionId, x, y) {
  const id = String(executionId || '').trim();
  if (!id) return '';
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return '';
  return `${id}:${nx.toFixed(4)}:${ny.toFixed(4)}`;
}

export function blockVisualReplay(executionId, x, y) {
  const key = visualReplayKey(executionId, x, y);
  if (key) replayBlocked.add(key);
}

export function visualReplayBlocked(executionId, x, y) {
  const key = visualReplayKey(executionId, x, y);
  return Boolean(key && replayBlocked.has(key));
}

/**
 * Same point in one execution is not sent again after an unchanged settle.
 * @param {{ executionId?: string, x?: number, y?: number, before?: object, after?: object }} input
 */
export function settleVisualPointer(input = {}) {
  const executionId = input.executionId;
  const x = input.x;
  const y = input.y;
  if (visualReplayBlocked(executionId, x, y)) {
    return { code: 'VISUAL_UNCHANGED', replayed: true };
  }
  if (!visualSceneChanged(input.before, input.after)) {
    blockVisualReplay(executionId, x, y);
    return { code: 'VISUAL_UNCHANGED', replayed: false };
  }
  return { code: 'changed', replayed: false };
}

export function clearVisualReplay(executionId) {
  const prefix = `${String(executionId || '').trim()}:`;
  if (prefix === ':') return;
  for (const key of replayBlocked) {
    if (key.startsWith(prefix)) replayBlocked.delete(key);
  }
}

/**
 * @param {string} base64
 */
function decodeBase64(base64) {
  const raw = String(base64 || '').replace(/\s/g, '');
  if (!raw) return null;
  try {
    if (typeof atob === 'function') {
      const bin = atob(raw);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {
    return null;
  }
  return null;
}
