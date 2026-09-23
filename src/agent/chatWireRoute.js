/**
 * Chat wire routing for arbitrary BYOK gateways.
 *
 * Stored provider.protocol (explicit always wins):
 *   openai-compatible — POST {base}/chat/completions (default)
 *   anthropic         — POST {base}/messages
 *   openai-responses  — unsupported adapter (clear error; never remapped)
 *   auto              — optional model-id heuristic on ANY base (multiplex gateways)
 *
 * When protocol is omitted: openai-compatible, except host api.anthropic.com → anthropic.
 * No product special-case for opencode.ai / openrouter.ai.
 * Jev stays purpose:'jev' + /systemone; jev-* models are rejected on the chat path.
 */

import {
  CHAT_PROTOCOL_ANTHROPIC,
  CHAT_PROTOCOL_OPENAI,
  CHAT_PROTOCOL_RESPONSES,
  CHAT_PROTOCOL_AUTO,
  DEFAULT_CHAT_PROTOCOL,
  anthropicMessagesUrl,
  openaiChatCompletionsUrl,
  openaiResponsesUrl,
  systemOneUrl,
  normalizeChatProtocol
} from './llm.js';

/** @typedef {'openai-compatible'|'anthropic'|'openai-responses'|'auto'|'systemone'|'google'} ChatWireKind */

/**
 * Strip provider prefixes: `opencode/claude-…`, `anthropic/claude-…`.
 * @param {string} modelId
 */
export function bareChatModelId(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return (slash >= 0 ? raw.slice(slash + 1) : raw).trim();
}

/**
 * Only the well-known direct Anthropic host gets an omitted-protocol default.
 * @param {string} baseURL
 */
export function isAnthropicApiBase(baseURL) {
  try {
    const host = new URL(String(baseURL || '')).hostname.toLowerCase();
    return host === 'api.anthropic.com';
  } catch {
    return /(?:^|\/\/)api\.anthropic\.com(?:[:/]|$)/i.test(String(baseURL || ''));
  }
}

/**
 * Model-id heuristic used only when protocol === 'auto'.
 * @param {string} modelId
 * @returns {ChatWireKind}
 */
export function inferChatWireFromModelId(modelId) {
  const id = bareChatModelId(modelId).toLowerCase();
  if (!id) return CHAT_PROTOCOL_OPENAI;

  if (/^jev([-_.]|$)/i.test(id)) return 'systemone';

  if (
    /^gpt-5/.test(id) ||
    /^gpt-6/.test(id) ||
    /^o[1-9]/.test(id) ||
    /^grok-/.test(id) ||
    /^muse-spark/.test(id)
  ) {
    return CHAT_PROTOCOL_RESPONSES;
  }

  if (/^gemini-/.test(id)) return 'google';

  if (/^claude[-_]/.test(id) || id.startsWith('claude')) return CHAT_PROTOCOL_ANTHROPIC;
  if (/^qwen3\.(5|6|7|8)([-_.]|$)/.test(id)) return CHAT_PROTOCOL_ANTHROPIC;

  return CHAT_PROTOCOL_OPENAI;
}

/**
 * @param {ChatWireKind} wire
 * @param {string} baseURL
 * @param {string} source
 */
function supportedRoute(wire, baseURL, source) {
  if (wire === CHAT_PROTOCOL_ANTHROPIC) {
    return {
      wire,
      protocol: CHAT_PROTOCOL_ANTHROPIC,
      url: anthropicMessagesUrl(baseURL),
      supported: true,
      source
    };
  }
  return {
    wire: CHAT_PROTOCOL_OPENAI,
    protocol: CHAT_PROTOCOL_OPENAI,
    url: openaiChatCompletionsUrl(baseURL),
    supported: true,
    source
  };
}

/**
 * Resolve chat wire for a BYOK provider.
 * @param {{
 *   baseURL?: string,
 *   model?: string,
 *   protocol?: string|null,
 *   purpose?: string
 * }} input
 */
export function resolveChatWire(input = {}) {
  const baseURL = String(input.baseURL || '').trim().replace(/\/$/, '');
  const model = String(input.model || '').trim();
  const purpose = input.purpose || 'chat';

  if (purpose === 'jev') {
    return {
      wire: 'systemone',
      protocol: null,
      url: systemOneUrl(baseURL),
      supported: true,
      source: 'purpose'
    };
  }

  const stored = normalizeChatProtocol(input.protocol);

  if (stored === CHAT_PROTOCOL_RESPONSES) {
    return unsupportedWire(CHAT_PROTOCOL_RESPONSES, baseURL, model, 'explicit');
  }
  if (stored === CHAT_PROTOCOL_ANTHROPIC) {
    return supportedRoute(CHAT_PROTOCOL_ANTHROPIC, baseURL, 'explicit');
  }
  if (stored === CHAT_PROTOCOL_OPENAI) {
    return supportedRoute(CHAT_PROTOCOL_OPENAI, baseURL, 'explicit');
  }

  if (stored === CHAT_PROTOCOL_AUTO) {
    const wire = inferChatWireFromModelId(model);
    if (wire === CHAT_PROTOCOL_ANTHROPIC || wire === CHAT_PROTOCOL_OPENAI) {
      return supportedRoute(wire, baseURL, 'auto');
    }
    return unsupportedWire(wire, baseURL, model, 'auto');
  }

  // Omitted protocol: only api.anthropic.com defaults to Messages.
  if (isAnthropicApiBase(baseURL)) {
    return supportedRoute(CHAT_PROTOCOL_ANTHROPIC, baseURL, 'host');
  }

  return supportedRoute(DEFAULT_CHAT_PROTOCOL, baseURL, 'default');
}

/**
 * @param {ChatWireKind} wire
 * @param {string} baseURL
 * @param {string} model
 * @param {string} source
 */
function unsupportedWire(wire, baseURL, model, source) {
  const id = bareChatModelId(model) || model || '(no model)';
  if (wire === 'systemone') {
    return {
      wire,
      protocol: null,
      url: systemOneUrl(baseURL),
      supported: false,
      source,
      code: 'CHAT_WIRE_JEV',
      error:
        `Model "${id}" uses System One (/systemone). Add it under the selection (Jev) API, not chat inference.`
    };
  }
  if (wire === CHAT_PROTOCOL_RESPONSES || wire === 'responses') {
    return {
      wire: CHAT_PROTOCOL_RESPONSES,
      protocol: CHAT_PROTOCOL_RESPONSES,
      url: openaiResponsesUrl(baseURL),
      supported: false,
      source,
      code: 'CHAT_WIRE_RESPONSES_UNSUPPORTED',
      error:
        `Protocol openai-responses (POST …/responses) is not implemented yet. Choose OpenAI Compatible or Anthropic Messages, or pick a model that those wires support.`
    };
  }
  if (wire === 'google') {
    return {
      wire,
      protocol: null,
      url: '',
      supported: false,
      source,
      code: 'CHAT_WIRE_GOOGLE_UNSUPPORTED',
      error:
        `Model "${id}" requires Google Generative AI paths. Browser Kitten does not implement that wire yet.`
    };
  }
  return {
    wire,
    protocol: null,
    url: '',
    supported: false,
    source,
    code: 'CHAT_WIRE_UNSUPPORTED',
    error: `Unsupported chat wire "${wire}" for model "${id}".`
  };
}

/**
 * @param {string} baseURL
 * @param {{ model?: string, protocol?: string|null, purpose?: string }} [opts]
 */
export function buildChatEndpointUrl(baseURL, opts = {}) {
  return resolveChatWire({ baseURL, ...opts }).url;
}

/**
 * @param {{ baseURL?: string, model?: string, protocol?: string|null }} settings
 */
export function resolveChatProtocol(settings = {}) {
  return resolveChatWire(settings);
}
