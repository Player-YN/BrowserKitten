/**
 * Host image generation — not a fourth model tool.
 * Session uses acquire({ action: 'image' }) so inspect + acquire + run stay the surface.
 * Default vendor path: OpenRouter POST /images (reference images via input_references).
 */

import { BRAND_NAME } from '../../../brand.js';
import { loadLlmSettings } from '../../llm.js';
import { byokAllowedForProvider, byokPlanFailure } from '../../byokGate.js';
import { createArtifact, listArtifacts, safeArtifactFileName } from './artifacts.js';
import { assertItemReadable, isItemBoundToSession } from './auth.js';
import { ensureItemPixels, looksLikeImageItem } from './itemPixels.js';
import { resolveBoundItemRef } from './itemLabel.js';

export const OPENROUTER_IMAGE_MODELS = [
  { id: 'google/gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image' },
  { id: 'openai/gpt-image-1', name: 'GPT Image 1' },
  { id: 'black-forest-labs/flux.2-pro', name: 'FLUX.2 Pro' }
];

export const DEFAULT_OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
export const DEFAULT_OPENROUTER_IMAGE_PATH = '/images';

/**
 * Host law (HANDOFF Q3=B): captions/dialogue live in text nodes, so image
 * prompts are stamped no-text by default. `allowText === true` is the explicit
 * exemption for user-requested fused finished images.
 */
export const NO_TEXT_PROMPT_CLAUSE =
  'Strictly no text in the image: no words, no letters, no numbers, no captions, no speech-bubble lettering, no watermarks, no UI chrome. 图中不要出现任何文字。';

const NO_TEXT_ALREADY = /(no text|no words|no letters|without text|无文字|不要文字|不含文字|不出现文字|禁止文字)/i;

export function stampNoTextPrompt(prompt, allowText = false) {
  const p = String(prompt || '').trim();
  if (!p || allowText === true) return p;
  if (NO_TEXT_ALREADY.test(p)) return p;
  return `${p}\n\n${NO_TEXT_PROMPT_CLAUSE}`;
}

/**
 * @param {object} [settings]
 */
export function resolveImageRuntimeConfig(settings) {
  const image = settings?.image && typeof settings.image === 'object' ? settings.image : null;
  const chatBase = String(settings?.apiBase || '').replace(/\/$/, '');
  const imageBaseExplicit =
    typeof image?.baseURL === 'string' && image.baseURL.trim()
      ? image.baseURL.trim().replace(/\/$/, '')
      : '';
  const imageBase = imageBaseExplicit || chatBase;
  const looksOpenRouter = /openrouter\.ai/i.test(imageBaseExplicit || chatBase);
  const enabled = !!image?.enabled;
  const protocol =
    (image?.protocol && String(image.protocol).trim()) ||
    (looksOpenRouter ? 'openrouter-image' : 'minimax-image');
  const pathDefault =
    protocol === 'openrouter-image' ? DEFAULT_OPENROUTER_IMAGE_PATH : '/image_generation';
  const modelDefault =
    protocol === 'openrouter-image' ? DEFAULT_OPENROUTER_IMAGE_MODEL : 'image-01';
  const imageKey =
    typeof image?.apiKey === 'string' && image.apiKey.trim() ? image.apiKey.trim() : '';
  return {
    enabled,
    protocol,
    apiKey: imageKey || String(settings?.apiKey || ''),
    baseURL: imageBase,
    path: (typeof image?.path === 'string' && image.path.trim()) || pathDefault,
    model: (typeof image?.model === 'string' && image.model.trim()) || modelDefault
  };
}

/**
 * @param {{
 *   store: import('./store.js').SessionWorkspaceStore,
 *   fs: ReturnType<import('./fs.js').createSessionGuestFs>,
 *   sessionId: string,
 *   prompt?: string,
 *   itemIds?: string[],
 *   aspectRatio?: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   onEvent?: (ev: object) => void,
 *   settings?: object
 * }} env
 */
export async function generateSessionImage(env) {
  const store = env.store;
  const fs = env.fs;
  const sessionId = String(env.sessionId || '');
  const rawPrompt = String(env.prompt || '').trim();
  if (!sessionId) return fail('sessionId required');
  if (!rawPrompt) return fail('prompt required', 'PROMPT_REQUIRED');
  if (env.signal?.aborted) return fail('aborted', 'ABORTED');
  const allowText = env.allowText === true;
  const prompt = stampNoTextPrompt(rawPrompt, allowText);
  const noTextStamped = prompt !== rawPrompt;

  const settings = env.settings || (await loadLlmSettings());
  const cfg = resolveImageRuntimeConfig(settings);
  if (env.model) cfg.model = String(env.model).trim();
  if (!cfg.enabled) {
    return fail(
      'NO_IMAGE_CONFIG: 请在设置 → 配置图像生成模型中启用生图（推荐 OpenRouter）。',
      'NO_IMAGE_CONFIG'
    );
  }
  if (!cfg.apiKey) return fail('NO_API_KEY: 生图需要 API Key。', 'NO_API_KEY');
  if (!cfg.baseURL) return fail('生图 Base URL 未配置', 'NO_IMAGE_BASE');
  if (!(await byokAllowedForProvider('image', settings.imageProviderId))) {
    return byokPlanFailure('image', { action: 'image' });
  }

  const sources = await collectBoundImageSources(store, sessionId, env.itemIds, {
    fetchImpl: env.fetchImpl,
    signal: env.signal,
    onEvent: env.onEvent
  });
  const denied = sources.filter((s) => s.error);
  if (denied.length && !sources.some((s) => s.dataUrl || s.url)) {
    return {
      ok: false,
      code: denied[0].code || 'AUTH_DENIED',
      error: denied[0].error,
      sources: sources.map((s) => ({ itemId: s.itemId, error: s.error }))
    };
  }
  // Host cap: send every resolved reference we have. Vendors differ (some 4, some 16+);
  // OpenRouter accepts the array and the provider drops or rejects extras.
  const refs = sources.filter((s) => s.dataUrl || s.url).slice(0, 16);
  const mode = refs.length ? 'i2i' : 't2i';

  const fetchImpl = env.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail('fetch unavailable');

  let generated;
  const imageStartedAt = Date.now();
  try {
    if (typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'image_request',
          model: cfg.model,
          protocol: cfg.protocol,
          host: imageApiHost(cfg.baseURL),
          path: cfg.path,
          mode,
          refCount: refs.length,
          ts: imageStartedAt
        });
      } catch {
        /* path recorder must not fail image HTTP */
      }
    }
    generated = await callImageEndpoint(cfg, {
      prompt,
      aspectRatio: env.aspectRatio,
      references: refs,
      fetchImpl,
      signal: env.signal
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = Number(e?.status) || Number((/\bHTTP\s+(\d{3})\b/i.exec(msg) || [])[1]) || undefined;
    const named = status ? `IMAGE_HTTP ${status}: ${msg}` : `IMAGE_HTTP: ${msg}`;
    if (typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'image_error',
          model: cfg.model,
          host: imageApiHost(cfg.baseURL),
          path: cfg.path,
          status,
          code: e?.code || 'IMAGE_HTTP',
          error: named.slice(0, 400),
          latencyMs: Date.now() - imageStartedAt,
          ts: Date.now()
        });
      } catch {
        /* path recorder must not fail image HTTP */
      }
    }
    return fail(named, e?.code || 'IMAGE_HTTP', { status });
  }
  const imageLatencyMs = Date.now() - imageStartedAt;
  if (!generated?.bytes?.byteLength) {
    const code = generated?.code || 'EMPTY_IMAGE';
    const errText = generated?.error || 'image provider returned empty bytes';
    if (typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'image_error',
          model: cfg.model,
          host: imageApiHost(cfg.baseURL),
          path: cfg.path,
          code,
          error: errText,
          latencyMs: imageLatencyMs,
          ts: Date.now()
        });
      } catch {
        /* ignore */
      }
    }
    return fail(errText, code, { status: generated?.status });
  }

  const title = titleFromImagePrompt(rawPrompt);
  const name = uniquifyArtifactFileName(
    store,
    sessionId,
    artifactImageName(env.filename, rawPrompt)
  );
  let rec;
  try {
    rec = createArtifact(store, fs, {
      sessionId,
      name,
      displayLabel: title || name.replace(/\.(png|jpe?g|webp|gif)$/i, ''),
      content: generated.bytes,
      mimeType: generated.mediaType || 'image/png'
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), e?.code || 'ARTIFACT_TRUTH');
  }

  const dataUrl = `data:${rec.mimeType || 'image/png'};base64,${bytesToBase64(generated.bytes)}`;
  const ev = {
    type: 'image_generated',
    status: 'success',
    mode,
    model: cfg.model,
    artifactId: rec.artifactId,
    path: rec.primaryPath,
    downloadName: rec.displayLabel || rec.name,
    displayLabel: rec.displayLabel || rec.name,
    mimeType: rec.mimeType,
    byteLength: generated.bytes.byteLength,
    latencyMs: imageLatencyMs,
    dataUrl
  };
  if (typeof env.onEvent === 'function') {
    try {
      env.onEvent(ev);
    } catch {
      /* UI emitter must not fail the turn */
    }
  }

  return {
    ok: true,
    action: 'image',
    mode,
    model: cfg.model,
    protocol: cfg.protocol,
    artifactId: rec.artifactId,
    path: rec.primaryPath,
    name: rec.displayLabel || rec.name,
    downloadName: rec.name,
    mimeType: rec.mimeType,
    bytes: generated.bytes.byteLength,
    sourceCount: refs.length,
    noText: !allowText,
    noTextStamped
  };
}

const IMAGE_PROMPT_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'onto',
  'over',
  'under',
  'close',
  'closeup',
  'up',
  'in',
  'on',
  'of',
  'a',
  'an',
  'to',
  'as',
  'by',
  'at',
  'or',
  'is',
  'are',
  'high',
  'resolution',
  'photography',
  'photo',
  'image',
  'picture',
  'style',
  'wearing',
  'modern',
  'casual',
  'minimalist',
  'shirt',
  'warm',
  'studio',
  'lighting',
  'professional',
  'creator',
  'young',
  'east',
  'asian',
  'man',
  'woman',
  'his',
  'her',
  '20s',
  'strictly',
  'text',
  'words',
  'letters',
  'numbers',
  'captions',
  'no',
  'any',
  'clean',
  'friendly',
  'smile'
]);

/**
 * Short shelf title from the image prompt. Keeps CJK. Maps common
 * handsome-portrait prompts to 「帅哥头像」so the rail is human, not compose_xxx.
 */
export function titleFromImagePrompt(prompt) {
  const raw = String(prompt || '')
    .replace(NO_TEXT_PROMPT_CLAUSE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const cjk = (raw.match(/[\u4e00-\u9fff]+/g) || []).join('');
  const avatarish = /头像|portrait|headshot|avatar/i.test(raw);
  const handsome = /帅|handsome/i.test(raw);
  if (avatarish && handsome) {
    if (/^[\u4e00-\u9fff]{1,6}头像$/.test(cjk)) return cjk;
    return '帅哥头像';
  }
  if (cjk.length >= 2) {
    const head = /([\u4e00-\u9fff]{0,6}头像)/.exec(cjk);
    if (head) return head[1];
    return cjk.slice(0, 12);
  }
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !IMAGE_PROMPT_STOP.has(w));
  return words.slice(0, 3).join('_');
}

export function artifactImageName(filename, prompt) {
  const raw = String(filename || '').trim().replace(/[/\\]+/g, '');
  const stem = safeArtifactFileName(raw);
  if (stem) return /\.(png|jpe?g|webp|gif)$/i.test(stem) ? stem : `${stem}.png`;
  const fromPrompt = safeArtifactFileName(titleFromImagePrompt(prompt));
  if (fromPrompt) return /\.(png|jpe?g|webp|gif)$/i.test(fromPrompt) ? fromPrompt : `${fromPrompt}.png`;
  return `compose_${Date.now().toString(36)}.png`;
}

export function uniquifyArtifactFileName(store, sessionId, name) {
  const want = String(name || 'image.png');
  const taken = new Set(
    listArtifacts(store, sessionId).map((a) => String(a.name || '').toLowerCase())
  );
  if (!taken.has(want.toLowerCase())) return want;
  const m = /^(.*?)(\.[^.]+)$/.exec(want);
  const stem = m ? m[1] : want;
  const ext = m ? m[2] : '';
  for (let i = 2; i < 50; i += 1) {
    const next = `${stem}_${i}${ext}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${stem}_${Date.now().toString(36).slice(-4)}${ext}`;
}

function fail(error, code = 'IMAGE_FAILED', extra = {}) {
  const out = { ok: false, action: 'image', code, error };
  if (extra && typeof extra === 'object') {
    if (extra.status != null && Number.isFinite(Number(extra.status))) {
      out.status = Number(extra.status);
    }
  }
  return out;
}

function imageApiHost(baseURL) {
  try {
    return new URL(String(baseURL || '')).host || '';
  } catch {
    return String(baseURL || '')
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .slice(0, 200);
  }
}

async function collectBoundImageSources(store, sessionId, itemIds, opts = {}) {
  /** @type {Array<{ itemId?: string, dataUrl?: string, url?: string, error?: string, code?: string }>} */
  const out = [];
  const requested = Array.isArray(itemIds)
    ? itemIds
        .map((id) => resolveBoundItemRef(store, sessionId, id) || String(id || ''))
        .filter(Boolean)
    : [];
  const ids = requested.length ? requested : listBoundImageItemIds(store, sessionId);
  for (const id of ids.slice(0, 16)) {
    const gate = assertItemReadable(store, sessionId, id);
    if (!gate.ok) {
      out.push({ itemId: id, error: gate.error, code: gate.code });
      continue;
    }
    const item = store.get('items', id);
    await ensureItemPixels(store, item, opts);
    const resolved = materializeItemImage(store, item);
    if (!resolved) {
      out.push({ itemId: id, error: 'image bytes unavailable' });
      continue;
    }
    out.push({ itemId: id, ...resolved });
  }
  return out;
}

function listBoundImageItemIds(store, sessionId) {
  const ids = [];
  const bindings = store.get('sessionBindings', sessionId) || [];
  for (const gid of bindings) {
    const members = store.get('groupMembers', gid) || [];
    for (const mid of members) {
      const item = store.get('items', mid);
      if (!item) continue;
      if (!isItemBoundToSession(store, sessionId, mid)) continue;
      if (looksLikeImageItem(item)) ids.push(String(mid));
    }
  }
  return ids;
}

function materializeItemImage(store, item) {
  if (!item) return null;
  const blob = store.getBlob(`blob:${item.webItemId}`);
  if (blob?.bytes?.byteLength) {
    const mime = blob.mimeType || 'image/png';
    return { dataUrl: `data:${mime};base64,${bytesToBase64(blob.bytes)}` };
  }
  const src = item.capture?.src || item.capture?.preview?.src || '';
  if (typeof src === 'string' && src.startsWith('data:image')) return { dataUrl: src };
  if (typeof src === 'string' && /^https?:\/\//i.test(src)) return { url: src };
  return null;
}

const OPTIONAL_PARAM_RE =
  /aspect_ratio|output_format|resolution|\bsize\b|unsupported (param|field)|unknown (field|parameter)/i;
const CHAT_FALLBACK_RE =
  /not found|unknown endpoint|use chat|modalities|chat.?complet|does not support (the )?image/i;

function isOpenRouterImageProtocol(cfg) {
  return (
    cfg.protocol === 'openrouter-image' ||
    /openrouter\.ai/i.test(String(cfg.baseURL || '')) ||
    cfg.path === '/images'
  );
}

function isOpenAiImageProtocol(cfg) {
  return cfg.protocol === 'openai-image' || /\/images\/generations$/i.test(String(cfg.path || ''));
}

function providerHttpError(res, json, text) {
  const raw =
    json?.error?.message ||
    json?.error ||
    json?.message ||
    text.slice(0, 240) ||
    `HTTP ${res.status}`;
  const msg = typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 240);
  const err = new Error(msg);
  err.status = res.status;
  err.code = 'IMAGE_HTTP';
  err.providerMessage = msg;
  return err;
}

async function postJson(fetchImpl, url, headers, body, signal) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { res, text, json };
}

async function materializeExtracted(extracted, fetchImpl, signal) {
  if (extracted?.bytes?.byteLength) return extracted;
  if (extracted?.url) {
    const imgRes = await fetchImpl(extracted.url, { signal });
    if (!imgRes.ok) {
      const err = new Error(`image URL fetch HTTP ${imgRes.status}`);
      err.status = imgRes.status;
      err.code = 'IMAGE_HTTP';
      throw err;
    }
    const buf = new Uint8Array(await imgRes.arrayBuffer());
    return { bytes: buf, mediaType: imgRes.headers.get('content-type') || 'image/png' };
  }
  return extracted;
}

async function callImageEndpoint(cfg, { prompt, aspectRatio, references, fetchImpl, signal }) {
  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (/openrouter\.ai/i.test(cfg.baseURL) || cfg.protocol === 'openrouter-image') {
    headers['HTTP-Referer'] = 'https://browserbot.local';
    headers['X-Title'] = BRAND_NAME;
  }

  if (isOpenRouterImageProtocol(cfg)) {
    return callOpenRouterImage(cfg, { prompt, aspectRatio, references, fetchImpl, signal, headers });
  }

  const url = joinUrl(cfg.baseURL, cfg.path);
  let body;
  if (isOpenAiImageProtocol(cfg)) {
    body = buildOpenAiImageBody(cfg.model, prompt, references, aspectRatio);
  } else {
    body = buildMinimaxImageBody(cfg.model, prompt, aspectRatio, references);
  }
  let { res, text, json } = await postJson(fetchImpl, url, headers, body, signal);
  if (
    !res.ok &&
    res.status === 400 &&
    OPTIONAL_PARAM_RE.test(text) &&
    (body.aspect_ratio || body.size || body.output_format)
  ) {
    const retry = { ...body };
    delete retry.aspect_ratio;
    delete retry.size;
    delete retry.output_format;
    ({ res, text, json } = await postJson(fetchImpl, url, headers, retry, signal));
  }
  if (!res.ok) throw providerHttpError(res, json, text);
  return materializeExtracted(extractImageBytes(json), fetchImpl, signal);
}

async function callOpenRouterImage(cfg, { prompt, aspectRatio, references, fetchImpl, signal, headers }) {
  const imagesUrl = joinUrl(cfg.baseURL, cfg.path || DEFAULT_OPENROUTER_IMAGE_PATH);
  let body = buildOpenRouterImageBody(cfg.model, prompt, aspectRatio, references);
  let { res, text, json } = await postJson(fetchImpl, imagesUrl, headers, body, signal);
  if (!res.ok && res.status === 400 && OPTIONAL_PARAM_RE.test(text) && (body.aspect_ratio || body.output_format)) {
    body = buildOpenRouterImageBody(cfg.model, prompt, undefined, references);
    ({ res, text, json } = await postJson(fetchImpl, imagesUrl, headers, body, signal));
  }

  if (res.ok) {
    const extracted = await materializeExtracted(extractImageBytes(json), fetchImpl, signal);
    if (extracted?.bytes?.byteLength) return extracted;
  }

  const shouldChat =
    String(cfg.path || '') !== '/chat/completions' &&
    (!res.ok
      ? res.status === 404 || res.status === 405 || CHAT_FALLBACK_RE.test(text)
      : true);

  if (shouldChat) {
    const chatUrl = joinUrl(cfg.baseURL, '/chat/completions');
    const chatBody = buildOpenRouterChatImageBody(cfg.model, prompt, aspectRatio, references);
    const chat = await postJson(fetchImpl, chatUrl, headers, chatBody, signal);
    if (chat.res.ok) {
      const extracted = await materializeExtracted(extractImageBytes(chat.json), fetchImpl, signal);
      if (extracted?.bytes?.byteLength) return extracted;
      if (extracted?.code === 'NOT_IMAGE_OUTPUT') return extracted;
      return {
        bytes: null,
        code: extracted?.code || 'EMPTY_IMAGE',
        error: extracted?.error || 'no image payload in provider response',
        status: chat.res.status
      };
    }
    if (!res.ok) throw providerHttpError(res, json, text);
    throw providerHttpError(chat.res, chat.json, chat.text);
  }

  if (!res.ok) throw providerHttpError(res, json, text);
  return extractImageBytes(json);
}

export function buildOpenRouterImageBody(model, prompt, aspectRatio, references) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    prompt
  };
  if (aspectRatio) body.aspect_ratio = String(aspectRatio);
  if (references?.length) {
    body.input_references = references.map((r) => ({
      type: 'image_url',
      image_url: { url: r.dataUrl || r.url }
    }));
  }
  return body;
}

export function buildOpenRouterChatImageBody(model, prompt, aspectRatio, references) {
  /** @type {Array<Record<string, unknown>>} */
  const parts = [{ type: 'text', text: prompt }];
  for (const r of references || []) {
    const url = r.dataUrl || r.url;
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages: [{ role: 'user', content: parts.length === 1 ? prompt : parts }],
    modalities: ['image', 'text']
  };
  if (aspectRatio) body.image_config = { aspect_ratio: String(aspectRatio) };
  return body;
}

export function buildOpenAiImageBody(model, prompt, references, aspectRatio) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    prompt,
    n: 1,
    response_format: 'b64_json'
  };
  const size = String(aspectRatio || '').trim();
  if (/^\d{2,5}x\d{2,5}$/i.test(size)) body.size = size;
  if (references?.length) {
    body.image = references[0].dataUrl || references[0].url;
  }
  return body;
}

function buildMinimaxImageBody(model, prompt, aspectRatio, references) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    prompt,
    response_format: 'base64',
    n: 1
  };
  if (aspectRatio) body.aspect_ratio = String(aspectRatio);
  if (references?.length) {
    body.subject_reference = references.map((r) => ({
      type: 'character',
      image_file: r.dataUrl || r.url
    }));
  }
  return body;
}

function decodeB64Image(b64, mediaType) {
  if (typeof b64 !== 'string' || b64.length < 32) return null;
  const raw = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bytes = base64ToBytes(raw);
  if (!bytes?.byteLength) return null;
  return { bytes, mediaType: mediaType || guessDataUrlMediaType(b64) || 'image/png' };
}

function guessDataUrlMediaType(s) {
  const m = /^data:([^;,]+)/i.exec(String(s || ''));
  return m ? m[1] : '';
}

function urlFromUnknown(v) {
  if (typeof v === 'string' && v.length > 8) return v;
  if (v && typeof v === 'object') {
    if (typeof v.url === 'string') return v.url;
    if (typeof v.image_url === 'string') return v.image_url;
    if (v.image_url && typeof v.image_url.url === 'string') return v.image_url.url;
  }
  return '';
}

function collectCandidateUrls(json) {
  /** @type {string[]} */
  const out = [];
  const push = (v) => {
    const u = urlFromUnknown(v);
    if (u) out.push(u);
  };
  if (!json || typeof json !== 'object') return out;
  const rows = Array.isArray(json.data) ? json.data : [];
  for (const row of rows) {
    push(row);
    push(row?.url);
    push(row?.image_url);
    push(row?.b64_json);
    push(row?.image_base64);
  }
  if (Array.isArray(json.images)) {
    for (const img of json.images) push(img);
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const ch of choices) {
    const msg = ch?.message || {};
    if (Array.isArray(msg.images)) {
      for (const img of msg.images) push(img);
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const t = String(part.type || '').toLowerCase();
        if (t === 'image_url' || t === 'image' || t === 'output_image') push(part);
        if (typeof part.image_url === 'string' || part.image_url) push(part);
        if (typeof part.b64_json === 'string') push(part.b64_json);
        if (typeof part.image_base64 === 'string') push(part.image_base64);
      }
    }
    if (typeof content === 'string' && content.startsWith('data:image')) out.push(content);
  }
  push(json.url);
  push(json.image_url);
  if (Array.isArray(json.data?.image_urls)) {
    for (const u of json.data.image_urls) push(u);
  }
  return out;
}

/**
 * Parse provider image bytes from /images, /images/generations, or chat completions.
 * @param {object} json
 */
export function extractImageBytes(json) {
  if (!json || typeof json !== 'object') return { bytes: null, error: 'empty image response' };
  const rows = Array.isArray(json.data) ? json.data : [];
  const first = rows[0] || {};
  const directB64 =
    first.b64_json ||
    first.image_base64 ||
    (Array.isArray(json.data?.image_base64) ? json.data.image_base64[0] : json.data?.image_base64) ||
    json.image_base64 ||
    json.b64_json;
  const fromDirect = decodeB64Image(directB64, first.media_type || first.mime_type);
  if (fromDirect) return fromDirect;

  for (const cand of collectCandidateUrls(json)) {
    if (/^data:image\//i.test(cand) || (cand.length > 32 && !/^https?:/i.test(cand) && !cand.includes('://'))) {
      const decoded = decodeB64Image(cand, guessDataUrlMediaType(cand));
      if (decoded) return decoded;
    }
    if (/^https?:\/\//i.test(cand)) {
      return { bytes: null, url: cand };
    }
  }

  const choices = Array.isArray(json.choices) ? json.choices : [];
  const textOnly = choices.some((c) => {
    const msg = c?.message;
    if (!msg) return false;
    const hasImages = Array.isArray(msg.images) && msg.images.length;
    const content = msg.content;
    const hasImagePart =
      Array.isArray(content) &&
      content.some((p) => {
        const t = String(p?.type || '').toLowerCase();
        return t === 'image_url' || t === 'image' || t === 'output_image';
      });
    const text =
      typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
          ? content
              .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
              .map((p) => p.text || '')
              .join('')
              .trim()
          : '';
    return !hasImages && !hasImagePart && !!text;
  });
  if (textOnly) {
    return {
      bytes: null,
      code: 'NOT_IMAGE_OUTPUT',
      error:
        'NOT_IMAGE_OUTPUT: model returned text only (no image). Pick a model whose output_modalities include image.'
    };
  }

  return { bytes: null, error: 'no image payload in provider response' };
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/$/, '');
  let p = String(path || '');
  if (!p.startsWith('/')) p = '/' + p;
  return b + p;
}

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/\s/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
