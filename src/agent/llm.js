/**
 * Provider settings for BYOK HTTPS inference.
 * Inference goes through AI SDK (`createBrowserBotLanguageModel`), not this file.
 *
 *   browserbot_providers: [{ id, name, nickname?, baseURL, apiKey, model, protocol?, purpose?, createdAt, image?, lastProbe? }]
 *   browserbot_active_provider_id: string
 * Flat copies (browserbot_api_key / browserbot_api_base / selected_model) stay in sync with the active chat provider.
 *
 * Chat `protocol` is the wire for ANY user base URL:
 *   openai-compatible (default) | anthropic | openai-responses | auto
 * Explicit protocol always wins. Omitted → openai-compatible, except host
 * api.anthropic.com → anthropic. `auto` is optional model-id multiplexing.
 * Image keeps nested image.protocol. STT is purpose:'stt'. Jev is purpose:'jev'
 * + /systemone and must never share the chat LanguageModel path.
 */

import {
  STORAGE_ACTIVE_IMAGE_PROVIDER_ID,
  STORAGE_ACTIVE_PROVIDER_ID,
  STORAGE_ACTIVE_STT_PROVIDER_ID,
  STORAGE_ACTIVE_JEV_PROVIDER_ID,
  STORAGE_PROVIDERS
} from '../brand.js';
import { normalizeMediaOverrides } from './chatMedia.js';
import { normalizeContextWindowOverrides } from './contextWindowStore.js';

export const DEFAULT_BASE = 'https://api.deepseek.com/v1';

/** Canonical OpenRouter OpenAI-compatible origin (chat + dedicated POST /images). */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** MiniMax-oriented image-gen defaults (path is relative to image base / chat origin). */
export const DEFAULT_IMAGE_PROTOCOL = 'minimax-image';
export const DEFAULT_IMAGE_PATH = '/image_generation';
export const DEFAULT_IMAGE_MODEL = 'image-01';
export const DEFAULT_OPENROUTER_IMAGE_PROTOCOL = 'openrouter-image';
export const DEFAULT_OPENROUTER_IMAGE_PATH = '/images';
export const DEFAULT_OPENROUTER_IMAGE_MODEL = 'google/gemini-2.5-flash-image';

/**
 * Suggested OpenCode Zen origin (OpenAI-compatible; client appends /systemone as needed).
 * DEFAULT_JEV_MODEL is Zen's published id only — never a silent fallback for other gateways.
 */
export const DEFAULT_JEV_BASE = 'https://opencode.ai/zen/v1';
export const DEFAULT_JEV_MODEL = 'jev-1.13';

/** Chat wire on the provider record (applies to any base URL). */
export const CHAT_PROTOCOL_OPENAI = 'openai-compatible';
export const CHAT_PROTOCOL_ANTHROPIC = 'anthropic';
export const CHAT_PROTOCOL_RESPONSES = 'openai-responses';
export const CHAT_PROTOCOL_AUTO = 'auto';
export const DEFAULT_CHAT_PROTOCOL = CHAT_PROTOCOL_OPENAI;

/** chrome.storage.local keys */
export const PROVIDERS_STORAGE_KEY = STORAGE_PROVIDERS;
export const ACTIVE_PROVIDER_ID_KEY = STORAGE_ACTIVE_PROVIDER_ID;
export const ACTIVE_IMAGE_PROVIDER_ID_KEY = STORAGE_ACTIVE_IMAGE_PROVIDER_ID;
export const ACTIVE_STT_PROVIDER_ID_KEY = STORAGE_ACTIVE_STT_PROVIDER_ID;
export const ACTIVE_JEV_PROVIDER_ID_KEY = STORAGE_ACTIVE_JEV_PROVIDER_ID;
export const DEFAULT_STT_MODEL = 'whisper-1';
export const DEFAULT_STT_BASE = 'https://api.openai.com/v1';

/** UI presets — fill form templates; catalog lives in providerPresets.js. */
export { PROVIDER_PRESETS } from './providerPresets.js';

/**
 * Normalize a stored chat protocol. Empty → null (omitted; resolver applies defaults).
 * @param {unknown} raw
 * @returns {typeof CHAT_PROTOCOL_OPENAI | typeof CHAT_PROTOCOL_ANTHROPIC | typeof CHAT_PROTOCOL_RESPONSES | typeof CHAT_PROTOCOL_AUTO | null}
 */
export function normalizeChatProtocol(raw) {
  if (raw == null) return null;
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === CHAT_PROTOCOL_ANTHROPIC || s === 'claude' || s === 'messages') {
    return CHAT_PROTOCOL_ANTHROPIC;
  }
  if (s === CHAT_PROTOCOL_RESPONSES || s === 'responses' || s === 'openai-responses') {
    return CHAT_PROTOCOL_RESPONSES;
  }
  if (s === CHAT_PROTOCOL_AUTO || s === 'model-auto' || s === 'by-model') {
    return CHAT_PROTOCOL_AUTO;
  }
  if (
    s === CHAT_PROTOCOL_OPENAI ||
    s === 'openai' ||
    s === 'chat' ||
    s === 'openai-compatible'
  ) {
    return CHAT_PROTOCOL_OPENAI;
  }
  return null;
}

/**
 * OpenAI-compatible chat completions URL. Base already ending in /chat/completions stays.
 * @param {string} baseURL
 */
export function openaiChatCompletionsUrl(baseURL) {
  const base = String(baseURL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * Anthropic Messages API URL. Base ending in /v1 → {base}/messages (no double /v1).
 * Base already ending in /messages stays. Otherwise append /v1/messages.
 * @param {string} baseURL
 */
export function anthropicMessagesUrl(baseURL) {
  const base = String(baseURL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return '';
  if (/\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

/**
 * OpenAI Responses API URL (generic). Adapter may still be unsupported.
 * @param {string} baseURL
 */
export function openaiResponsesUrl(baseURL) {
  const base = String(baseURL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return '';
  if (/\/responses$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/responses`;
  return `${base}/v1/responses`;
}

/**
 * System One (Jev) URL — generic path rules, not a vendor allowlist.
 * @param {string} baseURL
 */
export function systemOneUrl(baseURL) {
  const base = String(baseURL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return '';
  if (/\/systemone$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

/**
 * Build HTTPS endpoint for chat/jev from purpose + protocol + model.
 * Prefer resolveChatWire from chatWireRoute.js for full routing.
 * @param {string} baseURL
 * @param {{ purpose?: string, protocol?: string, model?: string }} [opts]
 */
export function buildProviderEndpointUrl(baseURL, opts = {}) {
  const purpose = opts.purpose || 'chat';
  if (purpose === 'jev') return systemOneUrl(baseURL);
  if (purpose === 'stt') {
    const base = String(baseURL || '')
      .trim()
      .replace(/\/$/, '');
    if (!base) return '';
    if (/\/audio\/transcriptions$/i.test(base)) return base;
    return `${base}/audio/transcriptions`;
  }
  const proto = normalizeChatProtocol(opts.protocol) || DEFAULT_CHAT_PROTOCOL;
  if (proto === CHAT_PROTOCOL_ANTHROPIC) return anthropicMessagesUrl(baseURL);
  if (proto === CHAT_PROTOCOL_RESPONSES) return openaiResponsesUrl(baseURL);
  return openaiChatCompletionsUrl(baseURL);
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   protocol: string,
 *   baseURL?: string,
 *   apiKey?: string,
 *   path?: string,
 *   model?: string
 * }} BrowserBotProviderImage
 *
 * @typedef {{
 *   ok: boolean,
 *   at: number,
 *   count: number,
 *   error?: string
 * }} BrowserBotProviderProbe
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   baseURL: string,
 *   apiKey: string,
 *   model: string,
 *   createdAt: number,
 *   purpose?: 'chat'|'image'|'stt'|'jev',
 *   protocol?: string,
 *   image?: BrowserBotProviderImage,
 *   lastProbe?: BrowserBotProviderProbe
 * }} BrowserBotProvider
 */

/** Dedicated 生图 vendor (not a chat API). */
export function isImageOnlyProvider(provider) {
  if (!provider || typeof provider !== 'object') return false;
  if (provider.purpose === 'image') return true;
  if (provider.purpose === 'stt' || provider.purpose === 'jev') return false;
  if (provider.purpose === 'chat') return false;
  const hasChat =
    !!String(provider.model || '').trim() || !!String(provider.apiKey || '').trim();
  return !!(provider.image && provider.image.enabled && !hasChat);
}

/** Dedicated speech-to-text vendor (OpenAI-compatible /audio/transcriptions). */
export function isSttOnlyProvider(provider) {
  return !!(provider && provider.purpose === 'stt');
}

/** Selection-only vendor. Never a chat or image model. */
export function isJevProvider(provider) {
  return !!(provider && provider.purpose === 'jev');
}

/** Appears in the inference settings list / chat picker. */
export function isChatProvider(provider) {
  return !!provider && !isImageOnlyProvider(provider) && !isSttOnlyProvider(provider) && !isJevProvider(provider);
}

/** Appears in the image settings list / 生图 picker. */
export function isImageProvider(provider) {
  return !!(provider?.image && provider.image.enabled);
}

export function listChatProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter(isChatProvider);
}

export function listImageProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter(isImageProvider);
}

export function listSttProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter(isSttOnlyProvider);
}

export function resolveActiveSttProvider(providers, activeSttProviderId) {
  const list = listSttProviders(providers);
  if (!list.length) return { activeSttProviderId: null, activeStt: null };
  const want = String(activeSttProviderId || '');
  const hit = want && list.find((p) => p.id === want);
  const activeStt = hit || list[0];
  return { activeSttProviderId: activeStt.id, activeStt };
}

export function listJevProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter(isJevProvider);
}

export function resolveActiveJevProvider(providers, activeJevProviderId) {
  const list = listJevProviders(providers);
  if (!list.length) return { activeJevProviderId: null, activeJev: null };
  const want = String(activeJevProviderId || '');
  const hit = want && list.find((p) => p.id === want);
  const activeJev = hit || list[0];
  return { activeJevProviderId: activeJev.id, activeJev };
}

export function sttVendorLabel(provider) {
  const base = String(provider?.baseURL || '');
  if (/openai\.com/i.test(base) && !/openrouter/i.test(base)) return 'OpenAI';
  if (/openrouter/i.test(base)) return 'OpenRouter';
  return provider?.name || 'STT';
}

export function resolveActiveImageProvider(providers, activeImageProviderId) {
  const list = listImageProviders(providers);
  if (!list.length) return { activeImageProviderId: null, activeImage: null };
  const want = String(activeImageProviderId || '');
  const hit = want && list.find((p) => p.id === want);
  const activeImage = hit || list[0];
  return { activeImageProviderId: activeImage.id, activeImage };
}

export function imageVendorLabel(provider) {
  const img = provider?.image && typeof provider.image === 'object' ? provider.image : {};
  const proto = String(img.protocol || '');
  const base = String(img.baseURL || provider?.baseURL || '');
  if (/openrouter/i.test(proto) || /openrouter/i.test(base)) return 'OpenRouter';
  if (/minimax/i.test(proto) || /minimax/i.test(base) || /minimaxi/i.test(base)) return 'MiniMax';
  if (/openai/i.test(base) && !/openrouter/i.test(base)) return 'OpenAI';
  if (provider?.purpose === 'image' && provider?.name) return provider.name;
  return provider?.name || 'Image';
}

/** Card title: optional nickname, else vendor/name. Missing nickname stays compatible. */
export function providerDisplayName(provider, fallback) {
  const nick = typeof provider?.nickname === 'string' ? provider.nickname.trim() : '';
  if (nick) return nick;
  return String(fallback || provider?.name || '').trim() || 'Provider';
}

export function imageCardTitle(provider) {
  const img = provider?.image && typeof provider.image === 'object' ? provider.image : {};
  const imageNick = typeof img.nickname === 'string' ? img.nickname.trim() : '';
  if (imageNick) return imageNick;
  return providerDisplayName(provider, imageVendorLabel(provider));
}

export function sttCardTitle(provider) {
  return providerDisplayName(provider, sttVendorLabel(provider));
}

export function jevVendorLabel(provider) {
  const base = String(provider?.baseURL || '');
  if (/opencode\.ai/i.test(base)) return 'OpenCode Zen';
  if (/openrouter/i.test(base)) return 'OpenRouter';
  if (/typesafe/i.test(base)) return 'TypeSafe';
  if (/localhost:8000|127\.0\.0\.1:8000/i.test(base)) return 'Laya (local)';
  return provider?.name || 'System1';
}

export function jevCardTitle(provider) {
  return providerDisplayName(provider, jevVendorLabel(provider));
}

function normalizeLastProbe(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const at = Number(raw.at);
  const count = Number(raw.count);
  /** @type {BrowserBotProviderProbe} */
  const out = {
    ok: raw.ok === true,
    at: Number.isFinite(at) ? at : 0,
    count: Number.isFinite(count) && count >= 0 ? Math.round(count) : 0
  };
  if (typeof raw.error === 'string' && raw.error.trim()) out.error = raw.error.trim().slice(0, 240);
  return out;
}

/**
 * MiniMax-style image config defaults. enabled is always false unless overridden.
 * @param {Partial<BrowserBotProviderImage>} [overrides]
 * @returns {BrowserBotProviderImage}
 */
export function defaultImageConfig(overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  /** @type {BrowserBotProviderImage} */
  const cfg = {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    protocol:
      typeof o.protocol === 'string' && o.protocol.trim()
        ? o.protocol.trim()
        : DEFAULT_IMAGE_PROTOCOL,
    path:
      typeof o.path === 'string' && o.path.trim()
        ? o.path.trim()
        : DEFAULT_IMAGE_PATH,
    model:
      typeof o.model === 'string' && o.model.trim()
        ? o.model.trim()
        : DEFAULT_IMAGE_MODEL
  };
  if (typeof o.baseURL === 'string' && o.baseURL.trim()) {
    cfg.baseURL = o.baseURL.trim().replace(/\/$/, '');
  }
  if (typeof o.apiKey === 'string' && o.apiKey.trim()) {
    cfg.apiKey = o.apiKey.trim();
  }
  if (typeof o.nickname === 'string' && o.nickname.trim()) {
    cfg.nickname = o.nickname.trim();
  }
  return cfg;
}

/**
 * Normalize optional provider.image. Returns undefined when input is absent/invalid
 * so providers without image config stay lean.
 * @param {unknown} image
 * @returns {BrowserBotProviderImage|undefined}
 */
export function normalizeImageConfig(image) {
  if (image == null || typeof image !== 'object') return undefined;
  return defaultImageConfig(/** @type {Partial<BrowserBotProviderImage>} */ (image));
}

function hasChromeLocalStorage() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

function hasRuntimeBridge() {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
}

/**
 * chrome.storage.local is available in the SW / sidepanel, not in offscreen.
 * Offscreen (and any other chrome.runtime-only context) goes through the SW.
 */
async function storageGet(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (hasChromeLocalStorage()) {
    return (await chrome.storage.local.get(list)) || {};
  }
  if (hasRuntimeBridge()) {
    const res = await chrome.runtime.sendMessage({
      target: 'browserbot-background',
      action: 'storage_local_get',
      keys: list
    });
    if (!res?.ok) throw new Error(res?.error || 'storage_local_get failed');
    return res.result || {};
  }
  return {};
}

async function storageSet(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (hasChromeLocalStorage()) {
    await chrome.storage.local.set(obj);
    return;
  }
  if (hasRuntimeBridge()) {
    const res = await chrome.runtime.sendMessage({
      target: 'browserbot-background',
      action: 'storage_local_set',
      values: obj
    });
    if (!res?.ok) throw new Error(res?.error || 'storage_local_set failed');
  }
}

/** @returns {string} */
export function generateProviderId() {
  return `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize one provider record.
 * Chat fields (baseURL, model, protocol) stay chat-only. protocol is the wire for any base.
 * @param {Partial<BrowserBotProvider>} p
 * @returns {BrowserBotProvider|null}
 */
export function normalizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' && p.id ? p.id : generateProviderId();
  const name = (typeof p.name === 'string' && p.name.trim()) || 'Provider';
  const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim().replace(/\/$/, '') : '';
  const apiKey = typeof p.apiKey === 'string' ? p.apiKey : '';
  const model = typeof p.model === 'string' ? p.model.trim() : '';
  const createdAt =
    typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Date.now();
  /** @type {BrowserBotProvider} */
  const out = { id, name, baseURL, apiKey, model, createdAt };
  const purpose = /** @type {any} */ (p).purpose;
  if (purpose === 'image' || purpose === 'chat' || purpose === 'stt' || purpose === 'jev') out.purpose = purpose;
  const image = normalizeImageConfig(/** @type {any} */ (p).image);
  if (image) out.image = image;
  // Optional chat wire override only — never invent a default that would pin auto-route.
  if (out.purpose !== 'stt' && out.purpose !== 'jev' && out.purpose !== 'image') {
    const protocol = normalizeChatProtocol(/** @type {any} */ (p).protocol);
    if (protocol) out.protocol = protocol;
  }
  const overrides = normalizeMediaOverrides(p.chatMediaOverrides);
  if (Object.keys(overrides).length) out.chatMediaOverrides = overrides;
  const contextWindowOverrides = normalizeContextWindowOverrides(p.contextWindowOverrides);
  if (Object.keys(contextWindowOverrides).length) out.contextWindowOverrides = contextWindowOverrides;
  const lastProbe = normalizeLastProbe(/** @type {any} */ (p).lastProbe);
  if (lastProbe) out.lastProbe = lastProbe;
  if (typeof p.nickname === 'string' && p.nickname.trim()) out.nickname = p.nickname.trim();
  return out;
}

/**
 * If only flat copies exist, fold them into browserbot_providers once.
 * Also ensures active id is valid when providers exist.
 * @returns {Promise<{
 *   providers: BrowserBotProvider[],
 *   activeProviderId: string|null,
 *   active: BrowserBotProvider|null,
 *   activeImageProviderId: string|null,
 *   activeImage: BrowserBotProvider|null,
 *   activeSttProviderId: string|null,
 *   activeStt: BrowserBotProvider|null,
 *   migrated: boolean
 * }>}
 */
export async function loadProvidersState() {
  const res = await storageGet([
    PROVIDERS_STORAGE_KEY,
    ACTIVE_PROVIDER_ID_KEY,
    ACTIVE_IMAGE_PROVIDER_ID_KEY,
    ACTIVE_STT_PROVIDER_ID_KEY,
    ACTIVE_JEV_PROVIDER_ID_KEY,
    'browserbot_api_key',
    'browserbot_api_base',
    'selected_model',
    'DEEPSEEK_API_KEY'
  ]);

  let providers = Array.isArray(res[PROVIDERS_STORAGE_KEY])
    ? res[PROVIDERS_STORAGE_KEY].map(normalizeProvider).filter(Boolean)
    : [];
  let activeProviderId =
    typeof res[ACTIVE_PROVIDER_ID_KEY] === 'string' ? res[ACTIVE_PROVIDER_ID_KEY] : null;
  let migrated = false;

  // Migration: old single-key / base / model → one "DeepSeek" provider
  if (providers.length === 0) {
    const oldKey = res.browserbot_api_key || res.DEEPSEEK_API_KEY || '';
    const hasLegacy =
      !!oldKey ||
      !!res.browserbot_api_base ||
      !!res.selected_model ||
      !!res.DEEPSEEK_API_KEY;

    if (hasLegacy) {
      const id = generateProviderId();
      const legacy = normalizeProvider({
        id,
        name: 'DeepSeek',
        baseURL: res.browserbot_api_base || DEFAULT_BASE,
        apiKey: oldKey,
        model: res.selected_model || 'deepseek-v4-flash',
        createdAt: Date.now()
      });
      providers = [legacy];
      activeProviderId = id;
      migrated = true;
      await storageSet({
        [PROVIDERS_STORAGE_KEY]: providers,
        [ACTIVE_PROVIDER_ID_KEY]: activeProviderId
      });
    }
  }

  const chatList = listChatProviders(providers);
  if (activeProviderId && !chatList.some((p) => p.id === activeProviderId)) {
    activeProviderId = chatList[0]?.id || null;
    migrated = true;
    await storageSet({ [ACTIVE_PROVIDER_ID_KEY]: activeProviderId });
  }

  if (!activeProviderId && chatList.length > 0) {
    activeProviderId = chatList[0].id;
    migrated = true;
    await storageSet({ [ACTIVE_PROVIDER_ID_KEY]: activeProviderId });
  }

  const imageWant =
    typeof res[ACTIVE_IMAGE_PROVIDER_ID_KEY] === 'string' ? res[ACTIVE_IMAGE_PROVIDER_ID_KEY] : null;
  const imageResolved = resolveActiveImageProvider(providers, imageWant);
  if (imageResolved.activeImageProviderId !== imageWant) {
    await storageSet({ [ACTIVE_IMAGE_PROVIDER_ID_KEY]: imageResolved.activeImageProviderId });
  }

  const sttWant =
    typeof res[ACTIVE_STT_PROVIDER_ID_KEY] === 'string' ? res[ACTIVE_STT_PROVIDER_ID_KEY] : null;
  const sttResolved = resolveActiveSttProvider(providers, sttWant);
  if (sttResolved.activeSttProviderId !== sttWant) {
    await storageSet({ [ACTIVE_STT_PROVIDER_ID_KEY]: sttResolved.activeSttProviderId });
  }

  const jevWant =
    typeof res[ACTIVE_JEV_PROVIDER_ID_KEY] === 'string' ? res[ACTIVE_JEV_PROVIDER_ID_KEY] : null;
  const jevResolved = resolveActiveJevProvider(providers, jevWant);
  if (jevResolved.activeJevProviderId !== jevWant) {
    await storageSet({ [ACTIVE_JEV_PROVIDER_ID_KEY]: jevResolved.activeJevProviderId });
  }

  const active = providers.find((p) => p.id === activeProviderId) || null;
  return {
    providers,
    activeProviderId,
    active,
    activeImageProviderId: imageResolved.activeImageProviderId,
    activeImage: imageResolved.activeImage,
    activeSttProviderId: sttResolved.activeSttProviderId,
    activeStt: sttResolved.activeStt,
    activeJevProviderId: jevResolved.activeJevProviderId,
    activeJev: jevResolved.activeJev,
    migrated
  };
}

/**
 * Persist providers list + optional active id. Also mirrors flat copies from the active provider.
 * @param {BrowserBotProvider[]} providers
 * @param {string|null} [activeProviderId]
 * @param {string|null} [activeImageProviderId]
 * @param {string|null} [activeSttProviderId]
 */
export async function saveProvidersState(
  providers,
  activeProviderId,
  activeImageProviderId,
  activeSttProviderId,
  activeJevProviderId
) {
  const list = (Array.isArray(providers) ? providers : []).map(normalizeProvider).filter(Boolean);
  const prev = await storageGet([
    ACTIVE_PROVIDER_ID_KEY,
    ACTIVE_IMAGE_PROVIDER_ID_KEY,
    ACTIVE_STT_PROVIDER_ID_KEY,
    ACTIVE_JEV_PROVIDER_ID_KEY
  ]);
  const chatList = listChatProviders(list);
  let activeId =
    activeProviderId !== undefined ? activeProviderId : prev[ACTIVE_PROVIDER_ID_KEY] || null;

  if (activeId && !chatList.some((p) => p.id === activeId)) {
    activeId = chatList[0]?.id || null;
  }
  if (!activeId && chatList.length > 0) activeId = chatList[0].id;

  const imageWant =
    activeImageProviderId !== undefined
      ? activeImageProviderId
      : prev[ACTIVE_IMAGE_PROVIDER_ID_KEY] || null;
  const imageResolved = resolveActiveImageProvider(list, imageWant);

  const sttWant =
    activeSttProviderId !== undefined
      ? activeSttProviderId
      : prev[ACTIVE_STT_PROVIDER_ID_KEY] || null;
  const sttResolved = resolveActiveSttProvider(list, sttWant);

  const jevWant =
    activeJevProviderId !== undefined
      ? activeJevProviderId
      : prev[ACTIVE_JEV_PROVIDER_ID_KEY] || null;
  const jevResolved = resolveActiveJevProvider(list, jevWant);

  const active = list.find((p) => p.id === activeId) || null;
  /** @type {Record<string, unknown>} */
  const toStore = {
    [PROVIDERS_STORAGE_KEY]: list,
    [ACTIVE_PROVIDER_ID_KEY]: activeId,
    [ACTIVE_IMAGE_PROVIDER_ID_KEY]: imageResolved.activeImageProviderId,
    [ACTIVE_STT_PROVIDER_ID_KEY]: sttResolved.activeSttProviderId,
    [ACTIVE_JEV_PROVIDER_ID_KEY]: jevResolved.activeJevProviderId
  };

  // Mirror the active chat provider onto flat copies.
  if (active) {
    if (active.apiKey) {
      toStore.browserbot_api_key = active.apiKey;
      toStore.DEEPSEEK_API_KEY = active.apiKey;
    }
    if (active.baseURL) {
      toStore.browserbot_api_base = active.baseURL.replace(/\/$/, '');
    }
    if (active.model) {
      toStore.selected_model = active.model;
    }
  }

  if (sttResolved.activeStt) {
    toStore.browserbot_stt_key = sttResolved.activeStt.apiKey || '';
    toStore.browserbot_stt_base = String(sttResolved.activeStt.baseURL || '').replace(/\/$/, '');
    toStore.browserbot_stt_model = sttResolved.activeStt.model || DEFAULT_STT_MODEL;
  }

  await storageSet(toStore);
  return {
    providers: list,
    activeProviderId: activeId,
    active,
    activeImageProviderId: imageResolved.activeImageProviderId,
    activeImage: imageResolved.activeImage,
    activeSttProviderId: sttResolved.activeSttProviderId,
    activeStt: sttResolved.activeStt,
    activeJevProviderId: jevResolved.activeJevProviderId,
    activeJev: jevResolved.activeJev
  };
}

/**
 * Set active provider by id (must already exist).
 * @param {string} providerId
 */
export async function setActiveProviderId(providerId) {
  const { providers } = await loadProvidersState();
  if (!listChatProviders(providers).some((p) => p.id === providerId)) {
    throw new Error('PROVIDER_NOT_FOUND');
  }
  return saveProvidersState(providers, providerId);
}

export async function setActiveImageProviderId(providerId) {
  const { providers, activeProviderId } = await loadProvidersState();
  if (!listImageProviders(providers).some((p) => p.id === providerId)) {
    throw new Error('PROVIDER_NOT_FOUND');
  }
  return saveProvidersState(providers, activeProviderId, providerId);
}

export async function setActiveSttProviderId(providerId) {
  const { providers, activeProviderId, activeImageProviderId } = await loadProvidersState();
  if (!listSttProviders(providers).some((p) => p.id === providerId)) {
    throw new Error('PROVIDER_NOT_FOUND');
  }
  return saveProvidersState(providers, activeProviderId, activeImageProviderId, providerId);
}

export async function setActiveJevProviderId(providerId) {
  const { providers, activeProviderId, activeImageProviderId, activeSttProviderId } =
    await loadProvidersState();
  if (!listJevProviders(providers).some((p) => p.id === providerId)) {
    throw new Error('PROVIDER_NOT_FOUND');
  }
  return saveProvidersState(
    providers,
    activeProviderId,
    activeImageProviderId,
    activeSttProviderId,
    providerId
  );
}

/**
 * Switch chat model on an existing provider without re-entering Base URL / API key.
 * @param {string} modelId
 * @param {{ providerId?: string|null }} [opts]
 */
export async function setActiveProviderModel(modelId, opts = {}) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('MODEL_REQUIRED');
  const { providers, activeProviderId } = await loadProvidersState();
  const targetId = String(opts.providerId || activeProviderId || '').trim();
  const idx = providers.findIndex((p) => p.id === targetId);
  if (idx < 0) {
    await storageSet({ selected_model: id });
    return { providers, activeProviderId, active: null, model: id };
  }
  providers[idx] = { ...providers[idx], model: id };
  return saveProvidersState(providers, targetId);
}

/**
 * Apply an image-model id onto a provider record without touching chat model / key / base.
 * @param {BrowserBotProvider|null|undefined} provider
 * @param {string} modelId
 * @returns {BrowserBotProvider|null}
 */
export function applyProviderImageModel(provider, modelId) {
  const id = String(modelId || '').trim();
  if (!provider || typeof provider !== 'object' || !id) return provider || null;
  const prev = provider.image && typeof provider.image === 'object' ? provider.image : {};
  return {
    ...provider,
    image: defaultImageConfig({
      ...prev,
      enabled: true,
      model: id
    })
  };
}

/**
 * Switch image model on an existing provider without changing chat model or keys.
 * @param {string} modelId
 * @param {{ providerId?: string|null }} [opts]
 */
export async function setActiveProviderImageModel(modelId, opts = {}) {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('MODEL_REQUIRED');
  const { providers, activeProviderId, activeImageProviderId } = await loadProvidersState();
  const targetId = String(opts.providerId || activeImageProviderId || '').trim();
  const idx = providers.findIndex((p) => p.id === targetId);
  if (idx < 0) throw new Error('PROVIDER_NOT_FOUND');
  const next = applyProviderImageModel(providers[idx], id);
  if (!next) throw new Error('INVALID_PROVIDER');
  providers[idx] = next;
  return saveProvidersState(providers, activeProviderId, targetId);
}

/**
 * Insert or update a provider; optionally make it active.
 * @param {Partial<BrowserBotProvider>} provider
 * @param {{ makeActive?: boolean }} [opts]
 */
export async function upsertProvider(provider, opts = {}) {
  const { providers, activeProviderId } = await loadProvidersState();
  const next = normalizeProvider(provider);
  if (!next) throw new Error('INVALID_PROVIDER');
  const idx = providers.findIndex((p) => p.id === next.id);
  // Preserve existing API key when UI sends empty (user left field blank = keep)
  if (idx >= 0) {
    if (provider.chatMediaOverrides === undefined && providers[idx].chatMediaOverrides) {
      next.chatMediaOverrides = providers[idx].chatMediaOverrides;
    }
    if (provider.contextWindowOverrides === undefined && providers[idx].contextWindowOverrides) {
      next.contextWindowOverrides = providers[idx].contextWindowOverrides;
    }
    if (!next.apiKey && providers[idx].apiKey) {
      next.apiKey = providers[idx].apiKey;
    }
    // Preserve image config when caller omits `image` (partial chat-only updates)
    if (next.image === undefined && providers[idx].image) {
      next.image = providers[idx].image;
    } else if (next.image && providers[idx].image?.apiKey && !next.image.apiKey) {
      next.image = { ...next.image, apiKey: providers[idx].image.apiKey };
    }
    if (next.lastProbe === undefined && providers[idx].lastProbe) {
      next.lastProbe = providers[idx].lastProbe;
    }
    if (typeof provider.protocol !== 'string' && providers[idx].protocol) {
      next.protocol = providers[idx].protocol;
    } else if (typeof provider.protocol === 'string') {
      const protocol = normalizeChatProtocol(provider.protocol);
      if (protocol) next.protocol = protocol;
      else delete next.protocol;
    }
    if (typeof provider.nickname !== 'string' && providers[idx].nickname) {
      next.nickname = providers[idx].nickname;
    }
    if (!next.createdAt) next.createdAt = providers[idx].createdAt;
    providers[idx] = next;
  } else {
    providers.push(next);
  }
  const makeActive =
    opts.makeActive !== false && !isImageOnlyProvider(next) && !isSttOnlyProvider(next) && !isJevProvider(next);
  const newActive = makeActive ? next.id : activeProviderId;
  const imageId = isImageProvider(next)
    ? (opts.makeImageActive === false ? undefined : next.id)
    : undefined;
  const sttId = isSttOnlyProvider(next)
    ? (opts.makeSttActive === false ? undefined : next.id)
    : undefined;
  const jevId = isJevProvider(next)
    ? (opts.makeJevActive === false ? undefined : next.id)
    : undefined;
  return saveProvidersState(providers, newActive, imageId, sttId, jevId);
}

/**
 * Delete a provider. If it was active, activate the first remaining.
 * @param {string} providerId
 */
export async function deleteProvider(providerId) {
  const { providers, activeProviderId, activeImageProviderId, activeSttProviderId, activeJevProviderId } =
    await loadProvidersState();
  const list = providers.filter((p) => p.id !== providerId);
  let newActive = activeProviderId;
  if (activeProviderId === providerId) {
    newActive = listChatProviders(list)[0]?.id || null;
  }
  const imageId = activeImageProviderId === providerId ? null : activeImageProviderId;
  const sttId = activeSttProviderId === providerId ? null : activeSttProviderId;
  const jevId = activeJevProviderId === providerId ? null : activeJevProviderId;
  return saveProvidersState(list, newActive, imageId, sttId, jevId);
}

/**
 * Load LLM settings from chrome.storage.local (active OpenAI-compatible provider).
 * @returns {Promise<{
 *   apiKey: string,
 *   apiBase: string,
 *   model: string,
 *   providerId: string|null,
 *   providerName: string,
 *   providers: BrowserBotProvider[],
 *   activeProviderId: string|null
 * }>}
 */
function sttSettingsFields(activeStt) {
  if (!activeStt) {
    return { stt: undefined, sttProviderId: null, sttProviderName: '' };
  }
  return {
    stt: {
      apiKey: activeStt.apiKey || '',
      apiBase: (activeStt.baseURL || DEFAULT_STT_BASE).replace(/\/$/, ''),
      model: activeStt.model || DEFAULT_STT_MODEL
    },
    sttProviderId: activeStt.id,
    sttProviderName: sttVendorLabel(activeStt)
  };
}

function jevSettingsFields(activeJev) {
  if (!activeJev?.apiKey) {
    return { jev: undefined, jevProviderId: null, jevProviderName: '' };
  }
  return {
    jev: {
      apiKey: activeJev.apiKey,
      apiBase: String(activeJev.baseURL || '')
        .trim()
        .replace(/\/$/, ''),
      model: String(activeJev.model || '').trim()
    },
    jevProviderId: activeJev.id,
    jevProviderName: jevCardTitle(activeJev)
  };
}

export async function loadLlmSettings() {
  const {
    providers,
    activeProviderId,
    active,
    activeImageProviderId,
    activeImage,
    activeStt,
    activeJev
  } = await loadProvidersState();
  const sttFields = sttSettingsFields(activeStt);
  const jevFields = jevSettingsFields(activeJev);

  if (active) {
    return {
      apiKey: active.apiKey || '',
      apiBase: (active.baseURL || DEFAULT_BASE).replace(/\/$/, ''),
      model: active.model || 'deepseek-v4-flash',
      protocol: normalizeChatProtocol(active.protocol),
      chatMediaOverrides: active.chatMediaOverrides,
      contextWindowOverrides: active.contextWindowOverrides,
      providerId: active.id,
      providerName: active.name || 'Provider',
      providers,
      activeProviderId,
      activeImageProviderId,
      image: activeImage?.image || undefined,
      imageProviderId: activeImage?.id || null,
      imageProviderName: activeImage ? imageVendorLabel(activeImage) : '',
      ...sttFields,
      ...jevFields
    };
  }

  // No chat provider yet: fall back to flat copies if any. Image / STT still attach.
  const res = await storageGet([
    'browserbot_api_key',
    'browserbot_api_base',
    'selected_model',
    'DEEPSEEK_API_KEY'
  ]);
  return {
    apiKey: res.browserbot_api_key || res.DEEPSEEK_API_KEY || '',
    apiBase: (res.browserbot_api_base || DEFAULT_BASE).replace(/\/$/, ''),
    model: res.selected_model || 'deepseek-v4-flash',
    protocol: null,
    providerId: null,
    providerName: '',
    providers,
    activeProviderId: null,
    activeImageProviderId: activeImageProviderId || null,
    image: activeImage?.image || undefined,
    imageProviderId: activeImage?.id || null,
    imageProviderName: activeImage ? imageVendorLabel(activeImage) : '',
    ...sttFields,
    ...jevFields
  };
}
