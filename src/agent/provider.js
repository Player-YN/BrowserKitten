/**
 * BrowserBot — OpenAI-compatible or Anthropic Messages language model via Vercel AI SDK
 * BYOK from active provider in chrome.storage; HTTPS inference only (no cloud agent orchestrator).
 */

import { BK_PURPOSE_HEADER, isCloudApiUrl } from './cloudModels.js';
import { createOpenAICompatible } from './vnext/adapters/vendor/ai-sdk-loader.mjs';
import {
  loadLlmSettings,
  DEFAULT_BASE,
  CHAT_PROTOCOL_ANTHROPIC,
  CHAT_PROTOCOL_OPENAI
} from './llm.js';
import { resolveChatWire } from './chatWireRoute.js';
import { createAnthropicLanguageModel } from './anthropicProvider.js';
import { loadCachedModelsForBase } from './modelCatalog.js';
import { resolveChatMediaCapabilities, canSendChatMedia, MAX_CHAT_MEDIA_BYTES } from './chatMedia.js';
import { isAbortLike, toAbortError } from './vnext/host/userStop.js';
import { classifyMediaRejection, requestMediaFormats } from './mediaRejection.js';
import {
  llmProxyFailure,
  reconstructLlmProxyResponse,
  resolveLlmFetchUrl,
  sanitizeLlmProxyHeaders,
  serializeLlmProxyBody
} from './llmProxyFetch.js';

const DEFAULT_MODEL_ID = 'deepseek-v4-flash';

function resolveModelName(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\s+/g, '-');
  return s || DEFAULT_MODEL_ID;
}

/**
 * Fields many OpenAI-compatible proxies (Groq, etc.) reject on re-sent history.
 * AI SDK may re-inject reasoning as reasoning_content during multi-step tool loops.
 */
const STRIP_MESSAGE_KEYS = new Set([
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'providerMetadata',
  'provider_metadata',
  'providerOptions',
  'provider_options'
]);

/**
 * Strip non-standard / rejected fields from an OpenAI-style chat message.
 * Keeps role, content, name, tool_calls, tool_call_id, function_call.
 * @param {object} msg
 * @returns {object}
 */
export function sanitizeOpenAiMessage(msg, opts = {}) {
  if (!msg || typeof msg !== 'object') return msg;
  const keepReasoning = opts.keepReasoning === true;
  const out = {};
  for (const [k, v] of Object.entries(msg)) {
    if (!keepReasoning && STRIP_MESSAGE_KEYS.has(k)) continue;
    if (keepReasoning && (k === 'providerMetadata' || k === 'provider_metadata' || k === 'providerOptions' || k === 'provider_options')) {
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(out.content)) {
    out.content = out.content
      .filter((part) => {
        if (!part || typeof part !== 'object') return true;
        const t = part.type;
        if (keepReasoning) return t !== 'reasoning-delta';
        return t !== 'reasoning' && t !== 'reasoning-delta';
      })
      .map((part) => {
        if (!part || typeof part !== 'object') return part;
        const cleaned = { ...part };
        delete cleaned.providerMetadata;
        delete cleaned.providerOptions;
        delete cleaned.provider_metadata;
        delete cleaned.provider_options;
        return cleaned;
      });
  }
  return out;
}

function filePartToDataUrl(part) {
  if (!part || typeof part !== 'object') return null;
  const mediaType = String(part.mediaType || part.mimeType || 'image/jpeg').split(';')[0].trim();
  if (!mediaType.startsWith('image/')) return null;
  const raw =
    (typeof part.data === 'object' && part.data && part.data.data != null
      ? part.data.data
      : null) ??
    part.data ??
    part.image;
  if (typeof raw !== 'string' || raw.length < 32) return null;
  if (raw.startsWith('data:image/')) return raw;
  return `data:${mediaType};base64,${raw}`;
}

function extractImagesFromToolContent(content, capabilities) {
  const images = [];
  const texts = [];
  if (typeof content !== 'string') {
    return { content, images };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { content, images };
  }
  if (!Array.isArray(parsed)) {
    return { content, images };
  }
  let lifted = false;
  for (const p of parsed) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) {
      texts.push(String(p.text));
      continue;
    }
    if (p.type === 'file' || p.type === 'file-data' || p.type === 'image') {
      const mime = String(p.mediaType || p.mimeType || '').split(';')[0].trim().toLowerCase();
      if (/^(audio|video)\//.test(mime)) {
        lifted = true; // Never leave rejected media base64 in tool text.
        const raw = (typeof p.data === 'object' ? p.data?.data : p.data) || '';
        const data = typeof raw === 'string' ? raw.replace(/^data:[^,]+,/, '') : '';
        if (data && data.length <= Math.ceil(MAX_CHAT_MEDIA_BYTES / 3) * 4 && canSendChatMedia(capabilities, mime)) {
          images.push(mime.startsWith('audio/')
            ? { type: 'input_audio', input_audio: { data, format: mime === 'audio/wav' ? 'wav' : 'mp3' } }
            : { type: 'video_url', video_url: { url: `data:${mime};base64,${data}` } });
        } else texts.push('[Media omitted: current chat model/transport/size does not permit this input. Use the saved file with STT; no media was perceived.]');
        continue;
      }
      const url = filePartToDataUrl(p);
      if (url) {
        if (canSendChatMedia(capabilities, mime || 'image/jpeg')) images.push({ type: 'image_url', image_url: { url } });
        else texts.push('[Image omitted: current model declares image input unsupported.]');
        lifted = true;
      }
    }
  }
  if (!lifted) return { content, images: [] };
  return {
    content: texts.join('\n') || '{"ok":true,"hasMedia":true}',
    images,
    changed: lifted
  };
}

/**
 * OpenAI-compatible chat maps tool `content` file parts to JSON.stringify(value).
 * Gemini/OpenRouter then treat that base64 as *text*, not pixels (~350k tokens/photo
 * and the model hallucinates). Lift images onto a user message after the tool batch.
 * @param {object[]} messages
 * @returns {object[]}
 */
export function liftToolResultImages(messages, capabilities) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const out = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Media from the preceding tool results. Analyze the attached content; follow each result’s source and scope.'
        },
        ...pending
      ]
    });
    pending = [];
  };
  for (const msg of messages) {
    if (msg && msg.role === 'tool') {
      const extracted = extractImagesFromToolContent(msg.content, capabilities);
      out.push(extracted.changed ? { ...msg, content: extracted.content } : msg);
      if (extracted.images.length) pending.push(...extracted.images);
      continue;
    }
    flush();
    out.push(msg);
  }
  flush();
  return out;
}

/**
 * Parse JSON chat body and strip unsupported message fields before HTTPS send.
 * Safe no-op for non-JSON / non-chat bodies.
 * @param {RequestInit} [init]
 * @returns {RequestInit}
 */
function decodeRequestBody(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  try {
    if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
    if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
    if (ArrayBuffer.isView(raw)) {
      return new TextDecoder().decode(raw);
    }
  } catch {
    return null;
  }
  return null;
}

export function stripUnsupportedFieldsFromRequestInit(init = {}, reasoning = null, opts = {}) {
  if (!init || init.body == null) return init;

  const raw = decodeRequestBody(init.body);
  if (raw == null) return init;

  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      return init;
    }
    const keepReasoning = opts.keepReasoning === true;
    body.messages = liftToolResultImages(
      body.messages.map((m) => sanitizeOpenAiMessage(m, { keepReasoning })),
      opts.mediaCapabilities?.model === body.model ? opts.mediaCapabilities : undefined
    );
    const cfg = openRouterReasoningBody(reasoning);
    if (cfg) body.reasoning = cfg;
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']);

/**
 * OpenRouter unified thinking body. Switch off → omit (do not send effort:none;
 * some models reject disable). Switch on → reasoning.effort (default medium).
 * @param {{ enabled?: boolean, effort?: string }|null|undefined} reasoning
 * @returns {{ effort: string }|null}
 */
export function openRouterReasoningBody(reasoning) {
  if (!reasoning || reasoning.enabled !== true) return null;
  const effort = String(reasoning.effort || '').toLowerCase();
  if (effort && REASONING_EFFORTS.has(effort) && effort !== 'none') return { effort };
  return { enabled: true };
}

/**
 * Inject OpenRouter `reasoning` onto a chat/completions JSON body.
 * @param {RequestInit} [init]
 * @param {{ enabled?: boolean, effort?: string }|null} [reasoning]
 * @returns {RequestInit}
 */
export function applyChatReasoningToInit(init = {}, reasoning) {
  return stripUnsupportedFieldsFromRequestInit(init, reasoning);
}

/**
 * Build a LanguageModel for streamText / ToolLoopAgent.
 * Uses the **active** chat provider. Wire path comes from provider.protocol
 * (openai-compatible | anthropic | openai-responses | auto) for any base URL.
 * @param {{ model?: string, reasoning?: { enabled?: boolean, effort?: string } }} [opts]
 * @returns {Promise<{ model: import('ai').LanguageModel, settings: object, modelId: string }>}
 */
export async function createBrowserBotLanguageModel(opts = {}) {
  const settings = opts.settings || await loadLlmSettings();
  if (!settings.apiKey) {
    const err = new Error('NO_API_KEY');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const modelId = resolveModelName(opts.model || settings.model);
  const baseURL = settings.apiBase || DEFAULT_BASE;
  const providerName =
    (settings.providerName && String(settings.providerName).trim()) || 'browserbot';

  const route = resolveChatWire({
    baseURL,
    model: modelId,
    protocol: settings.protocol
  });
  if (!route.supported) {
    const err = new Error(route.error || 'CHAT_WIRE_UNSUPPORTED');
    err.code = route.code || 'CHAT_WIRE_UNSUPPORTED';
    throw err;
  }
  const protocol = route.protocol || CHAT_PROTOCOL_OPENAI;

  const mediaCapabilities = opts.mediaCapabilities || resolveChatMediaCapabilities(
    { ...settings, model: modelId }, (await loadCachedModelsForBase(baseURL)).models
  );

  if (protocol === CHAT_PROTOCOL_ANTHROPIC) {
    const model = createAnthropicLanguageModel({
      modelId,
      apiKey: settings.apiKey,
      baseURL,
      providerName,
      fetch: createExtensionFetch({
        reasoning: null,
        mediaCapabilities,
        mediaContext: opts.mediaContext,
        noRetry: opts.noRetry === true,
        anthropic: true
      })
    });
    return { model, settings: { ...settings, protocol }, modelId };
  }

  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: settings.apiKey,
    baseURL,
    includeUsage: true,
    fetch: createExtensionFetch({ reasoning: opts.reasoning || null, mediaCapabilities,
      mediaContext: opts.mediaContext, noRetry: opts.noRetry === true })
  });

  return {
    model: provider(modelId),
    settings: { ...settings, protocol },
    modelId
  };
}

export const BK_CLIENT_HEADER = 'x-bk-client';

/**
 * `browser-kitten/<manifest version>` for the Browser Kitten API's version gate,
 * or '' outside an extension (no manifest → no header). Never sent to BYOK hosts.
 */
export function browserKittenClientTag() {
  try {
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    return version ? `browser-kitten/${version}` : '';
  } catch {
    return '';
  }
}

/**
 * Fetch for AI SDK. Extension pages with host_permissions usually succeed
 * directly (and must, for live SSE). Offscreen can still throw TypeError
 * Failed to fetch (CORS / unsafe headers / PNA). Then SW `llm_proxy_fetch`
 * buffers the full HTTPS response — including SSE — so the turn can finish.
 * OpenRouter keeps reasoning / reasoning_details; Groq-class hosts strip them.
 * Anthropic Messages bodies must not go through OpenAI message sanitizers.
 * @param {{ reasoning?: { enabled?: boolean, effort?: string }|null, anthropic?: boolean }} [opts]
 * @returns {typeof fetch}
 */
export function createExtensionFetch(opts = {}) {
  return async function browserBotFetch(input, init = {}) {
    const headers = new Headers(init.headers || input?.headers);
    const requestNoRetry = headers.get('x-paw-internal-no-retry') === '1';
    headers.delete('x-paw-internal-no-retry');
    const url = resolveLlmFetchUrl(input);
    if (isCloudApiUrl(url)) {
      const client = browserKittenClientTag();
      if (client) headers.set(BK_CLIENT_HEADER, client);
      else headers.delete(BK_CLIENT_HEADER);
    } else {
      headers.delete(BK_PURPOSE_HEADER);
      headers.delete(BK_CLIENT_HEADER);
    }
    const keepReasoning = /openrouter\.ai/i.test(String(url));
    const cleanedInit = opts.anthropic
      ? { ...init, headers: sanitizeLlmProxyHeaders(headers) }
      : stripUnsupportedFieldsFromRequestInit({
          ...init,
          headers: sanitizeLlmProxyHeaders(headers)
        }, opts.reasoning || null, {
          keepReasoning,
          mediaCapabilities: opts.mediaContext?.current || opts.mediaCapabilities
        });
    const body = await serializeLlmProxyBody(cleanedInit.body);
    const fetchInit = {
      ...cleanedInit,
      headers: sanitizeLlmProxyHeaders(cleanedInit.headers),
      body
    };
    if (body == null) delete fetchInit.body;
    try {
      const res = await fetch(url || input, fetchInit);
      if (opts.mediaContext && [400, 415, 422].includes(res.status)) {
        try {
          const mime = classifyMediaRejection(res.status, (await res.clone().text()).slice(0, 16000), requestMediaFormats(fetchInit));
          if (mime) await opts.mediaContext.reject(mime);
        } catch { /* evidence persistence must not replace the actual request error */ }
      }
      return keepReasoning ? liftOpenRouterReasoningResponse(res) : res;
    } catch (directErr) {
      if (opts.noRetry || requestNoRetry) throw directErr;
      if (isAbortLike(directErr, fetchInit?.signal)) throw toAbortError(directErr);
      console.warn('[BrowserBot] direct fetch failed, trying background proxy:', directErr?.message);
      return proxyFetchAsResponse(url || input, fetchInit, directErr, { keepReasoning });
    }
  };
}

function detailsPlainText(details) {
  if (!Array.isArray(details)) return '';
  return details
    .map((d) => {
      if (!d || typeof d !== 'object') return '';
      if (typeof d.text === 'string') return d.text;
      if (typeof d.summary === 'string') return d.summary;
      return '';
    })
    .filter(Boolean)
    .join('');
}

/**
 * Gemini/OpenRouter often put plaintext in reasoning_details[].text and leave
 * delta.reasoning empty. AI SDK only maps reasoning / reasoning_content strings.
 */
export function liftOpenRouterReasoningPayload(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.choices)) return body;
  return {
    ...body,
    choices: body.choices.map((choice) => {
      if (!choice || typeof choice !== 'object') return choice;
      const next = { ...choice };
      if (next.delta && typeof next.delta === 'object') {
        const d = { ...next.delta };
        const fromDetails = detailsPlainText(d.reasoning_details);
        if (fromDetails && typeof d.reasoning !== 'string' && typeof d.reasoning_content !== 'string') {
          d.reasoning = fromDetails;
        }
        next.delta = d;
      }
      if (next.message && typeof next.message === 'object') {
        const m = { ...next.message };
        const fromDetails = detailsPlainText(m.reasoning_details);
        if (fromDetails && typeof m.reasoning !== 'string' && typeof m.reasoning_content !== 'string') {
          m.reasoning = fromDetails;
        }
        next.message = m;
      }
      return next;
    })
  };
}

function liftOpenRouterReasoningResponse(res) {
  if (!res || typeof res !== 'object') return res;
  const ct = String(res.headers?.get?.('content-type') || '');
  if (ct.includes('text/event-stream') && res.body) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    const stream = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          for (const line of lines) {
            controller.enqueue(encoder.encode(`${liftSseLine(line)}\n`));
          }
        },
        flush(controller) {
          if (pending) controller.enqueue(encoder.encode(liftSseLine(pending)));
        }
      })
    );
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
}

function liftSseLine(line) {
  if (!line.startsWith('data:')) return line;
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') return line;
  try {
    const parsed = JSON.parse(raw);
    return `data: ${JSON.stringify(liftOpenRouterReasoningPayload(parsed))}`;
  } catch {
    return line;
  }
}

/**
 * Reconstruct a Response via background `llm_proxy_fetch`.
 * SW fetch is privileged (host_permissions, no document CORS). The reply is
 * one-shot: the worker buffers the vendor body (JSON or SSE) then returns it.
 */
async function proxyFetchAsResponse(input, init, directErr, opts = {}) {
  const url = resolveLlmFetchUrl(input);
  const method = init?.method || 'POST';
  const headers = sanitizeLlmProxyHeaders(init?.headers);
  const body = await serializeLlmProxyBody(init?.body);

  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    throw llmProxyFailure(directErr, new Error('Background proxy unavailable'));
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      target: 'browserbot-background',
      action: 'llm_proxy_fetch',
      url,
      method,
      headers,
      body
    });
  } catch (proxyErr) {
    throw llmProxyFailure(directErr, proxyErr);
  }
  if (!res) throw llmProxyFailure(directErr, new Error('Background proxy returned empty'));
  if (res.error && res.text == null && res.json == null) {
    throw llmProxyFailure(directErr, new Error(res.error));
  }
  const response = reconstructLlmProxyResponse(res);
  return opts.keepReasoning ? liftOpenRouterReasoningResponse(response) : response;
}
