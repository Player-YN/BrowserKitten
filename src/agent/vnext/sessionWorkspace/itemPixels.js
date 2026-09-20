/**
 * On-demand pixels for a bound WebItem.
 * Bind stays an index; bytes are fetched only when inspect / acquire image needs them.
 */

import { assertPublicHttpUrl } from '../primitives/netGuard.js';
import { isVisualLabelKind } from './itemLabel.js';

const MAX_ITEM_BYTES = 12 * 1024 * 1024;

export function itemBlobKey(webItemId) {
  return `blob:${webItemId}`;
}

export function looksLikeImageItem(item) {
  if (!item) return false;
  const kind = String(item.kindHint || item.labelKind || '');
  if (kind === 'video' || kind === 'audio') return false;
  const src = item.capture?.src || item.capture?.preview?.src || '';
  const srcIsImage =
    /^data:image\//i.test(src) ||
    /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(src) ||
    /[?&]format=(jpe?g|png|gif|webp|avif)\b/i.test(src) ||
    /pbs\.twimg\.com\/(?:media|profile_images)\//i.test(src);
  if (kind === 'link' && !srcIsImage) return false;
  return (
    isVisualLabelKind(kind) ||
    kind === 'image' ||
    srcIsImage
  );
}

export function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (!s.startsWith('data:') || comma < 5) throw new Error('invalid data url');
  const header = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  const tokens = header.split(';').map((t) => t.trim()).filter(Boolean);
  let mimeType = 'application/octet-stream';
  let isBase64 = false;
  for (const t of tokens) {
    if (/^base64$/i.test(t)) isBase64 = true;
    else if (t.includes('/')) mimeType = t;
  }
  if (isBase64) {
    if (typeof Buffer !== 'undefined') {
      return { bytes: new Uint8Array(Buffer.from(payload, 'base64')), mimeType };
    }
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mimeType };
  }
  let text = payload;
  try {
    text = decodeURIComponent(payload);
  } catch {
    text = payload;
  }
  return { bytes: new TextEncoder().encode(text), mimeType };
}

function tryPersistDataUrl(store, key, dataUrl, source) {
  try {
    return persistDecoded(store, key, dataUrl, source);
  } catch {
    return null;
  }
}

function svgMarkupFromCapture(item) {
  const html = String(item?.capture?.html || item?.capture?.context?.html || '').trim();
  if (!html) return '';
  const m = /<svg\b[\s\S]*<\/svg>/i.exec(html);
  return m ? m[0] : /^<svg\b/i.test(html) ? html : '';
}

function dataUrlFromItemCapture(item) {
  const src = item?.capture?.src || item?.capture?.preview?.src || '';
  if (typeof src === 'string' && src.startsWith('data:')) return src;
  const svg = svgMarkupFromCapture(item);
  if (!svg) return '';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function emitPixels(opts, item, result, latencyMs) {
  if (typeof opts?.onEvent !== 'function') return;
  try {
    opts.onEvent({
      type: 'pixels',
      itemId: item?.webItemId || '',
      ok: result?.ok !== false,
      source: result?.source || '',
      byteLength: Number(result?.bytes?.byteLength) || 0,
      mimeType: result?.mimeType || '',
      code: result?.code || undefined,
      error: result?.error || undefined,
      latencyMs
    });
  } catch {
    /* path recorder must not fail pixel bind */
  }
}

/**
 * Prefer in-memory blob, then OPFS hydrate, then data: / page capture / fetch.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {object} item
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   captureFromPage?: (item: object) => Promise<object|null>,
 *   onEvent?: (ev: object) => void
 * }} [opts]
 */
export async function ensureItemPixels(store, item, opts = {}) {
  const t0 = Date.now();
  const result = await ensureItemPixelsInner(store, item, opts);
  emitPixels(opts, item, result, Date.now() - t0);
  return result;
}

async function ensureItemPixelsInner(store, item, opts = {}) {
  if (!item?.webItemId) return { ok: false, error: 'no item' };
  const key = itemBlobKey(item.webItemId);

  const existing = await readItemBlob(store, key);
  if (existing?.bytes?.byteLength) {
    return { ok: true, bytes: existing.bytes, mimeType: existing.mimeType || 'image/png', source: 'blob' };
  }

  const captured = dataUrlFromItemCapture(item);
  if (captured.startsWith('data:')) {
    const decoded = tryPersistDataUrl(store, key, captured, 'data-url');
    if (decoded?.ok) return decoded;
  }
  const src = item.capture?.src || item.capture?.preview?.src || '';

  // Bound identity is capture.src. Page CSS locators on masonry/SPA grids
  // often resolve to a *different* img after layout — fetch the stored URL first.
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof src === 'string' && /^https?:\/\//i.test(src) && typeof fetchImpl === 'function') {
    const gate = assertPublicHttpUrl(src);
    if (gate.ok) {
      try {
        const res = await fetchImpl(src, { credentials: 'omit', signal: opts.signal });
        if (res && res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          const mime = String(res.headers?.get?.('content-type') || 'image/png')
            .split(';')[0]
            .trim();
          if (buf.byteLength) return persistBytes(store, key, buf, mime || 'image/png', 'fetch');
        }
      } catch {
        /* page-context capture may still work (cookies / canvas) */
      }
    } else {
      return { ok: false, error: gate.error, code: gate.code };
    }
  }

  const capturer = typeof opts.captureFromPage === 'function' ? opts.captureFromPage : captureItemFromPage;
  try {
    const page = await capturer(item);
    const dataUrl = page?.dataUrl;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      const decoded = tryPersistDataUrl(store, key, dataUrl, 'page');
      if (decoded?.ok) return decoded;
    }
  } catch {
    /* no pixels */
  }

  return { ok: false, error: 'image bytes unavailable (only src metadata)', code: 'NO_PIXELS' };
}

async function readItemBlob(store, key) {
  if (store && typeof store.getBlobAsync === 'function') {
    try {
      const hydrated = await store.getBlobAsync(key);
      if (hydrated?.bytes?.byteLength) return hydrated;
    } catch {
      /* fall through */
    }
  }
  return store.getBlob(key);
}

function persistDecoded(store, key, dataUrl, source) {
  const decoded = decodeDataUrl(dataUrl);
  return persistBytes(store, key, decoded.bytes, decoded.mimeType, source);
}

function persistBytes(store, key, bytes, mimeType, source) {
  if (!bytes?.byteLength) return { ok: false, error: 'empty image bytes', code: 'NO_PIXELS' };
  if (bytes.byteLength > MAX_ITEM_BYTES) {
    return { ok: false, error: `image exceeds ${MAX_ITEM_BYTES} bytes`, code: 'TOO_LARGE' };
  }
  store.putBlob(key, bytes, { mimeType: mimeType || 'image/png' });
  return { ok: true, bytes, mimeType: mimeType || 'image/png', source };
}

/**
 * Offscreen → background → content_script captureWorkspaceItem (page cookies / canvas).
 */
export async function captureItemFromPage(item) {
  const tabId = item?.capture?.source?.tabId;
  const selector = item?.capture?.locator?.css || item?.capture?.selector;
  if (tabId == null || tabId === '' || !selector) return null;
  const chromeRef = globalThis.chrome;
  if (!chromeRef?.runtime?.sendMessage) return null;
  try {
    const src = item?.capture?.src || item?.capture?.preview?.src || '';
    const res = await chromeRef.runtime.sendMessage({
      target: 'browserbot-background',
      action: 'workspace_capture_fragile',
      tabId,
      selector,
      src,
      captureBytes: true
    });
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}
