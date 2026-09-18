/**
 * Office tool result → model output. Frame-pixel attach is leftover from
 * Design/Slides and unused by sheet / doc / web.
 *
 * HARD: preview JPEGs are ephemeral model-vision only — never createArtifact,
 * never list in 交付物, never download.
 */

import { attachToolFailureHint } from './toolReceipt.js';

export const PREVIEW_MAX_FRAMES = 8;
/** Live tldraw toImage must not block the tool loop (headless / watermark / busy tab). */
export const PREVIEW_TIMEOUT_MS = 12000;

function previewTimeout(ms = PREVIEW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ skipped: 'PREVIEW_TIMEOUT', code: 'NEED_TAB' }), ms);
  });
}

/**
 * @param {object} raw
 * @returns {Array<{id?:string,name?:string,w?:number,h?:number,mime?:string,base64?:string,data?:string}>}
 */
export function normalizePreviewFrames(raw = {}) {
  const list = Array.isArray(raw.frames)
    ? raw.frames
    : Array.isArray(raw.preview?.frames)
      ? raw.preview.frames
      : [];
  return list
    .filter((f) => f && typeof f === 'object' && (f.base64 || f.data))
    .slice(0, PREVIEW_MAX_FRAMES);
}

/**
 * @param {object} result
 * @param {object} hostPreview
 */
export function attachCanvasPreview(result, hostPreview = {}) {
  if (!result || typeof result !== 'object') return result;
  if (hostPreview.skipped || hostPreview.code === 'NEED_TAB') {
    const next = { ...result };
    next.preview = {
      skipped: hostPreview.skipped || hostPreview.code || 'NEED_TAB',
      code: hostPreview.code || 'NEED_TAB'
    };
    return next;
  }
  const frames = normalizePreviewFrames(hostPreview);
  if (!frames.length) {
    const next = { ...result };
    if (!next.preview) {
      next.preview = { skipped: 'NEED_TAB', code: 'NEED_TAB' };
    }
    return next;
  }
  return {
    ...result,
    preview: {
      ephemeral: true,
      persist: false,
      frames: frames.map((f) => ({
        id: f.id || '',
        name: f.name || 'Frame',
        w: Number(f.w) || 0,
        h: Number(f.h) || 0,
        mime: f.mime || 'image/jpeg'
      })),
      truncated: Boolean(hostPreview.truncated) || (hostPreview.frames || []).length > PREVIEW_MAX_FRAMES
    },
    modelParts: previewFramesToModelParts(frames)
  };
}

export function previewFramesToModelParts(frames = []) {
  const parts = [];
  for (const fr of frames) {
    const data = String(fr.base64 || fr.data || '').trim();
    if (!data) continue;
    const label = String(fr.name || fr.id || 'Frame');
    parts.push({ type: 'text', text: `Frame preview: ${label}` });
    parts.push({
      type: 'file',
      data,
      mediaType: fr.mime || 'image/jpeg'
    });
  }
  return parts;
}

/**
 * @param {Function|null} hostCanvas
 * @param {{ artifactId: string, ids?: string[] }} opts
 */
export async function requestCanvasPreview(hostCanvas, opts = {}) {
  const artifactId = String(opts.artifactId || '').trim();
  if (typeof hostCanvas !== 'function' || !artifactId) {
    return { skipped: 'NEED_TAB', code: 'NEED_TAB' };
  }
  try {
    const live = await Promise.race([
      hostCanvas({
        method: 'preview',
        artifactId,
        maxFrames: PREVIEW_MAX_FRAMES,
        ids: Array.isArray(opts.ids) ? opts.ids : undefined
      }),
      previewTimeout(opts.timeoutMs || PREVIEW_TIMEOUT_MS)
    ]);
    if (live?.skipped === 'PREVIEW_TIMEOUT' || live?.code === 'PREVIEW_TIMEOUT') {
      return { skipped: 'PREVIEW_TIMEOUT', code: 'NEED_TAB' };
    }
    const body = live?.result || live || {};
    if (live?.ok === false || body?.ok === false) {
      return {
        skipped: body.code || live?.code || 'NEED_TAB',
        code: body.code || live?.code || 'NEED_TAB'
      };
    }
    if (Array.isArray(body.frames) && body.frames.length) return body;
    return { skipped: 'NEED_TAB', code: 'NEED_TAB' };
  } catch {
    return { skipped: 'NEED_TAB', code: 'NEED_TAB' };
  }
}

function factsJsonForModel(output = {}) {
  const json = attachToolFailureHint({ ...output });
  delete json.modelParts;
  delete json.imageBase64;
  delete json.base64;
  delete json.dataUrl;
  delete json.image;
  return json;
}

function collectModelFileParts(parts = []) {
  const value = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) {
      value.push({ type: 'text', text: String(p.text) });
      continue;
    }
    if ((p.type === 'file' || p.type === 'file-data' || p.type === 'image') && (p.data || p.image)) {
      const raw = typeof p.data === 'object' && p.data?.data != null ? p.data.data : p.data ?? p.image;
      const data = typeof raw === 'string' ? raw : '';
      if (data) {
        value.push({
          type: 'file',
          data: { type: 'data', data },
          mediaType: p.mediaType || 'image/jpeg'
        });
      }
    }
  }
  return value;
}

/**
 * AI SDK tool output: pixels via content parts, metadata via JSON.
 * When a screenshot/file is attached, facts always ride in a leading text part.
 * Never vision-only. Never put raw image bytes in the JSON text.
 * @param {{ output?: any }} opts
 */
export function sessionToolToModelOutput(opts = {}) {
  const o = opts.output || {};
  const json = factsJsonForModel(o);
  const parts = Array.isArray(o.modelParts) ? o.modelParts : [];
  const media = collectModelFileParts(parts);
  const hasFile = media.some((p) => p.type === 'file');
  if (hasFile) {
    let facts = '{}';
    try {
      facts = JSON.stringify(json);
    } catch {
      facts = '{"ok":false}';
    }
    return { type: 'content', value: [{ type: 'text', text: facts }, ...media] };
  }
  return { type: 'json', value: json };
}
