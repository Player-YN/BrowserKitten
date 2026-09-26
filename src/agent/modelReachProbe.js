/**
 * Settings form: probe whether the configured model answers a tiny chat turn.
 * Uses resolveChatWire (same protocol-first routing as real send). Not GET /models.
 * Jev / purpose:jev stays on systemone (see jevSelect.probeJevSystemOne).
 */

import { resolveChatWire } from './chatWireRoute.js';
import { anthropicRequestHeaders } from './anthropicProvider.js';
import {
  CHAT_PROTOCOL_ANTHROPIC,
  CHAT_PROTOCOL_OPENAI
} from './llm.js';

export const MODEL_REACH_PROBE_PROMPT = 'ping';
export const MODEL_REACH_PROBE_TIMEOUT_MS = 18000;
export const MODEL_REACH_PROBE_MAX_TOKENS = 1;

/**
 * @param {string} msg
 * @param {string} [apiKey]
 */
export function sanitizeProbeErrorMessage(msg, apiKey = '') {
  let s = String(msg || '').trim() || 'probe failed';
  const key = String(apiKey || '').trim();
  if (key && key.length >= 8) {
    s = s.split(key).join('[redacted]');
  }
  s = s.replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, '[redacted]');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  if (s.length > 220) s = `${s.slice(0, 217)}…`;
  return s;
}

/**
 * @param {unknown} body
 * @param {string} [text]
 */
function shortVendorError(body, text) {
  if (body && typeof body === 'object') {
    const err = /** @type {any} */ (body).error;
    if (typeof err === 'string' && err.trim()) return err.trim();
    if (err && typeof err === 'object') {
      const m = err.message || err.msg || err.type;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
    const top =
      /** @type {any} */ (body).message ||
      /** @type {any} */ (body).detail ||
      /** @type {any} */ (body).error_description;
    if (typeof top === 'string' && top.trim()) return top.trim();
  }
  const t = String(text || '').trim();
  if (t && t.length < 180 && !t.startsWith('{') && !t.startsWith('<')) return t;
  return '';
}

/**
 * Build POST request for a one-token model reachability check.
 * Does not send; never invents a default model id.
 *
 * @param {{
 *   baseURL?: string,
 *   apiKey?: string,
 *   model?: string,
 *   protocol?: string|null,
 *   purpose?: string
 * }} input
 * @returns {{
 *   ok: true,
 *   wire: string,
 *   protocol: string|null,
 *   url: string,
 *   method: 'POST',
 *   headers: Record<string, string>,
 *   body: Record<string, unknown>,
 *   bodyJson: string
 * } | {
 *   ok: false,
 *   code: string,
 *   error: string,
 *   missing?: 'baseURL'|'apiKey'|'model',
 *   wire?: string,
 *   url?: string
 * }}
 */
export function buildModelReachProbeRequest(input = {}) {
  const baseURL = String(input.baseURL || '').trim().replace(/\/$/, '');
  const apiKey = String(input.apiKey || '').trim();
  const model = String(input.model || '').trim();

  if (!baseURL) {
    return { ok: false, code: 'NEED_BASE', error: 'Base URL is required.', missing: 'baseURL' };
  }
  if (!apiKey) {
    return { ok: false, code: 'NEED_KEY', error: 'API key is required.', missing: 'apiKey' };
  }
  if (!model) {
    return {
      ok: false,
      code: 'NEED_MODEL',
      error: 'Model id is required.',
      missing: 'model'
    };
  }

  if (input.purpose === 'jev') {
    return {
      ok: false,
      code: 'CHAT_WIRE_JEV',
      error: 'System1 providers use System One probe, not chat completions.'
    };
  }

  const route = resolveChatWire({
    baseURL,
    model,
    protocol: input.protocol,
    purpose: input.purpose
  });

  if (!route.supported) {
    return {
      ok: false,
      code: route.code || 'CHAT_WIRE_UNSUPPORTED',
      error: String(route.error || 'Unsupported chat wire'),
      wire: route.wire,
      url: route.url || ''
    };
  }

  if (route.wire === CHAT_PROTOCOL_ANTHROPIC) {
    const body = {
      model,
      max_tokens: MODEL_REACH_PROBE_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: MODEL_REACH_PROBE_PROMPT }]
        }
      ]
    };
    return {
      ok: true,
      wire: CHAT_PROTOCOL_ANTHROPIC,
      protocol: CHAT_PROTOCOL_ANTHROPIC,
      url: route.url,
      method: 'POST',
      headers: anthropicRequestHeaders(apiKey),
      body,
      bodyJson: JSON.stringify(body)
    };
  }

  // openai-compatible (explicit, auto, host-default)
  const body = {
    model,
    messages: [{ role: 'user', content: MODEL_REACH_PROBE_PROMPT }],
    max_tokens: MODEL_REACH_PROBE_MAX_TOKENS,
    stream: false
  };
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (baseURL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://browserbot.local';
    headers['X-Title'] = 'Browser Kitten';
  }
  return {
    ok: true,
    wire: CHAT_PROTOCOL_OPENAI,
    protocol: CHAT_PROTOCOL_OPENAI,
    url: route.url,
    method: 'POST',
    headers,
    body,
    bodyJson: JSON.stringify(body)
  };
}

/**
 * HTTP 2xx + a parseable assistant/message envelope (content may be empty).
 * @param {{ wire?: string, status?: number, body?: unknown, text?: string }} input
 */
export function interpretModelReachProbeResponse(input = {}) {
  const status = Number(input.status) || 0;
  if (status < 200 || status >= 300) {
    const detail = shortVendorError(input.body, input.text);
    return {
      ok: false,
      code: status ? `HTTP_${status}` : 'HTTP_ERROR',
      error: sanitizeProbeErrorMessage(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status || 0}`)
    };
  }

  let body = input.body;
  if (body == null && typeof input.text === 'string' && input.text.trim()) {
    try {
      body = JSON.parse(input.text);
    } catch {
      return {
        ok: false,
        code: 'BAD_RESPONSE',
        error: 'Response was not JSON.'
      };
    }
  }
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      code: 'BAD_RESPONSE',
      error: 'Empty or non-object response.'
    };
  }

  const wire = String(input.wire || '');
  if (wire === CHAT_PROTOCOL_ANTHROPIC || /** @type {any} */ (body).type === 'message') {
    if (/** @type {any} */ (body).type === 'message' || Array.isArray(/** @type {any} */ (body).content)) {
      return { ok: true };
    }
  }

  const choices = /** @type {any} */ (body).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (
      first &&
      typeof first === 'object' &&
      (first.message != null || first.delta != null || first.text != null || first.finish_reason != null)
    ) {
      return { ok: true };
    }
    // Some gateways return choices:[{}] with only index — still a completions envelope.
    if (first && typeof first === 'object') return { ok: true };
  }

  // OpenAI-ish root fields without choices (rare) — require message-like shape.
  if (/** @type {any} */ (body).message && typeof /** @type {any} */ (body).message === 'object') {
    return { ok: true };
  }

  return {
    ok: false,
    code: 'BAD_RESPONSE',
    error: 'HTTP ok but no assistant/message payload.'
  };
}

/**
 * @param {{
 *   baseURL?: string,
 *   apiKey?: string,
 *   model?: string,
 *   protocol?: string|null,
 *   purpose?: string
 * }} config
 * @param {typeof fetch} [fetchImpl]
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function probeModelReach(config, fetchImpl = fetch, opts = {}) {
  const built = buildModelReachProbeRequest(config);
  if (!built.ok) {
    return {
      ok: false,
      code: built.code,
      error: built.error,
      missing: built.missing,
      wire: built.wire,
      url: built.url || ''
    };
  }

  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : MODEL_REACH_PROBE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.bodyJson,
      signal: ac.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted =
      err?.name === 'AbortError' ||
      /aborted|timeout/i.test(String(err?.message || err || ''));
    if (aborted) {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `Probe timed out after ${Math.round(timeoutMs / 1000)}s.`,
        wire: built.wire,
        url: built.url
      };
    }
    return {
      ok: false,
      code: 'NETWORK',
      error: sanitizeProbeErrorMessage(
        err instanceof Error ? err.message : String(err),
        config?.apiKey
      ),
      wire: built.wire,
      url: built.url
    };
  }
  clearTimeout(timer);

  let text = '';
  let body = null;
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  const interpreted = interpretModelReachProbeResponse({
    wire: built.wire,
    status: response.status,
    body,
    text
  });
  if (!interpreted.ok) {
    return {
      ...interpreted,
      error: sanitizeProbeErrorMessage(interpreted.error, config?.apiKey),
      wire: built.wire,
      url: built.url,
      status: response.status
    };
  }
  return {
    ok: true,
    wire: built.wire,
    url: built.url,
    status: response.status
  };
}
