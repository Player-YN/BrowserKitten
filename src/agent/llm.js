/**
 * Provider settings for BYOK OpenAI-compatible HTTPS.
 * Inference goes through AI SDK (`createPageWandLanguageModel`), not this file.
 *
 *   pagewand_providers: [{ id, name, baseURL, apiKey, model, createdAt, image?, lastProbe? }]
 *   pagewand_active_provider_id: string
 * Legacy keys (pagewand_api_key / pagewand_api_base / selected_model) migrate once.
 *
 * Chat baseURL + model are chat-only. Image APIs are a separate active id
 * (`pagewand_active_image_provider_id`): either purpose:'image' vendors or
 * a leftover nested `image` on a chat record. Never overwrite chat base
 * with an image path. Speech-to-text is purpose:'stt' +
 * `pagewand_active_stt_provider_id` (OpenAI-compatible POST /audio/transcriptions).
 */

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

/** chrome.storage.local keys */
export const PROVIDERS_STORAGE_KEY = 'pagewand_providers';
export const ACTIVE_PROVIDER_ID_KEY = 'pagewand_active_provider_id';
export const ACTIVE_IMAGE_PROVIDER_ID_KEY = 'pagewand_active_image_provider_id';
export const ACTIVE_STT_PROVIDER_ID_KEY = 'pagewand_active_stt_provider_id';
export const DEFAULT_STT_MODEL = 'whisper-1';
export const DEFAULT_STT_BASE = 'https://api.openai.com/v1';

/**
 * UI presets — fill form templates; user still edits before save.
 * Protocol is OpenAI-compatible only (chat completions shape).
 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    baseURL: '',
    model: '',
    apiKeyPlaceholder: 'sk-... / any key'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: OPENROUTER_API_BASE,
    model: 'openai/gpt-4o',
    apiKeyPlaceholder: 'sk-or-...',
    // Image shares this origin; path is /images. Prefill so 生图 is not a scavenger hunt.
    image: {
      enabled: false,
      protocol: DEFAULT_OPENROUTER_IMAGE_PROTOCOL,
      path: DEFAULT_OPENROUTER_IMAGE_PATH,
      model: DEFAULT_OPENROUTER_IMAGE_MODEL,
      baseURL: OPENROUTER_API_BASE
    }
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-Text-01',
    apiKeyPlaceholder: 'eyJ... / API key',
    // Suggested image defaults when user enables image gen (chat base stays chat-only)
    image: {
      enabled: false,
      protocol: DEFAULT_IMAGE_PROTOCOL,
      path: DEFAULT_IMAGE_PATH,
      model: DEFAULT_IMAGE_MODEL
    }
  }
];

/**
 * @typedef {{
 *   enabled: boolean,
 *   protocol: string,
 *   baseURL?: string,
 *   apiKey?: string,
 *   path?: string,
 *   model?: string
 * }} PageWandProviderImage
 *
 * @typedef {{
 *   ok: boolean,
 *   at: number,
 *   count: number,
 *   error?: string
 * }} PageWandProviderProbe
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   baseURL: string,
 *   apiKey: string,
 *   model: string,
 *   createdAt: number,
 *   purpose?: 'chat'|'image'|'stt',
 *   image?: PageWandProviderImage,
 *   lastProbe?: PageWandProviderProbe
 * }} PageWandProvider
 */

/** Dedicated 生图 vendor (not a chat API). */
export function isImageOnlyProvider(provider) {
  if (!provider || typeof provider !== 'object') return false;
  if (provider.purpose === 'image') return true;
  if (provider.purpose === 'stt') return false;
  if (provider.purpose === 'chat') return false;
  const hasChat =
    !!String(provider.model || '').trim() || !!String(provider.apiKey || '').trim();
  return !!(provider.image && provider.image.enabled && !hasChat);
}

/** Dedicated speech-to-text vendor (OpenAI-compatible /audio/transcriptions). */
export function isSttOnlyProvider(provider) {
  return !!(provider && provider.purpose === 'stt');
}

/** Appears in the inference settings list / chat picker. */
export function isChatProvider(provider) {
  return !!provider && !isImageOnlyProvider(provider) && !isSttOnlyProvider(provider);
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

function normalizeLastProbe(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const at = Number(raw.at);
  const count = Number(raw.count);
  /** @type {PageWandProviderProbe} */
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
 * @param {Partial<PageWandProviderImage>} [overrides]
 * @returns {PageWandProviderImage}
 */
export function defaultImageConfig(overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  /** @type {PageWandProviderImage} */
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
  return cfg;
}

/**
 * Normalize optional provider.image. Returns undefined when input is absent/invalid
 * so providers without image config stay lean.
 * @param {unknown} image
 * @returns {PageWandProviderImage|undefined}
 */
export function normalizeImageConfig(image) {
  if (image == null || typeof image !== 'object') return undefined;
  return defaultImageConfig(/** @type {Partial<PageWandProviderImage>} */ (image));
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
      target: 'pawwork-background',
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
      target: 'pawwork-background',
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
 * Chat fields (baseURL, model) stay chat-only. Optional `image` is preserved/normalized.
 * @param {Partial<PageWandProvider>} p
 * @returns {PageWandProvider|null}
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
  /** @type {PageWandProvider} */
  const out = { id, name, baseURL, apiKey, model, createdAt };
  const purpose = /** @type {any} */ (p).purpose;
  if (purpose === 'image' || purpose === 'chat' || purpose === 'stt') out.purpose = purpose;
  const image = normalizeImageConfig(/** @type {any} */ (p).image);
  if (image) out.image = image;
  const lastProbe = normalizeLastProbe(/** @type {any} */ (p).lastProbe);
  if (lastProbe) out.lastProbe = lastProbe;
  return out;
}

/**
 * Migrate legacy single-key settings → pagewand_providers once.
 * Also ensures active id is valid when providers exist.
 * @returns {Promise<{
 *   providers: PageWandProvider[],
 *   activeProviderId: string|null,
 *   active: PageWandProvider|null,
 *   activeImageProviderId: string|null,
 *   activeImage: PageWandProvider|null,
 *   activeSttProviderId: string|null,
 *   activeStt: PageWandProvider|null,
 *   migrated: boolean
 * }>}
 */
export async function loadProvidersState() {
  const res = await storageGet([
    PROVIDERS_STORAGE_KEY,
    ACTIVE_PROVIDER_ID_KEY,
    ACTIVE_IMAGE_PROVIDER_ID_KEY,
    ACTIVE_STT_PROVIDER_ID_KEY,
    'pagewand_api_key',
    'pagewand_api_base',
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
    const oldKey = res.pagewand_api_key || res.DEEPSEEK_API_KEY || '';
    const hasLegacy =
      !!oldKey ||
      !!res.pagewand_api_base ||
      !!res.selected_model ||
      !!res.DEEPSEEK_API_KEY;

    if (hasLegacy) {
      const id = generateProviderId();
      const legacy = normalizeProvider({
        id,
        name: 'DeepSeek',
        baseURL: res.pagewand_api_base || DEFAULT_BASE,
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

  const active = providers.find((p) => p.id === activeProviderId) || null;
  return {
    providers,
    activeProviderId,
    active,
    activeImageProviderId: imageResolved.activeImageProviderId,
    activeImage: imageResolved.activeImage,
    activeSttProviderId: sttResolved.activeSttProviderId,
    activeStt: sttResolved.activeStt,
    migrated
  };
}

/**
 * Persist providers list + optional active id. Also mirrors legacy keys from active provider
 * so older readers / status badges stay consistent.
 * @param {PageWandProvider[]} providers
 * @param {string|null} [activeProviderId]
 * @param {string|null} [activeImageProviderId]
 * @param {string|null} [activeSttProviderId]
 */
export async function saveProvidersState(
  providers,
  activeProviderId,
  activeImageProviderId,
  activeSttProviderId
) {
  const list = (Array.isArray(providers) ? providers : []).map(normalizeProvider).filter(Boolean);
  const prev = await storageGet([
    ACTIVE_PROVIDER_ID_KEY,
    ACTIVE_IMAGE_PROVIDER_ID_KEY,
    ACTIVE_STT_PROVIDER_ID_KEY
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

  const active = list.find((p) => p.id === activeId) || null;
  /** @type {Record<string, unknown>} */
  const toStore = {
    [PROVIDERS_STORAGE_KEY]: list,
    [ACTIVE_PROVIDER_ID_KEY]: activeId,
    [ACTIVE_IMAGE_PROVIDER_ID_KEY]: imageResolved.activeImageProviderId,
    [ACTIVE_STT_PROVIDER_ID_KEY]: sttResolved.activeSttProviderId
  };

  // Mirror active provider → legacy keys (backward compatible)
  if (active) {
    if (active.apiKey) {
      toStore.pagewand_api_key = active.apiKey;
      toStore.DEEPSEEK_API_KEY = active.apiKey;
    }
    if (active.baseURL) {
      toStore.pagewand_api_base = active.baseURL.replace(/\/$/, '');
    }
    if (active.model) {
      toStore.selected_model = active.model;
    }
  }

  if (sttResolved.activeStt) {
    toStore.pagewand_stt_key = sttResolved.activeStt.apiKey || '';
    toStore.pagewand_stt_base = String(sttResolved.activeStt.baseURL || '').replace(/\/$/, '');
    toStore.pagewand_stt_model = sttResolved.activeStt.model || DEFAULT_STT_MODEL;
  }

  await storageSet(toStore);
  return {
    providers: list,
    activeProviderId: activeId,
    active,
    activeImageProviderId: imageResolved.activeImageProviderId,
    activeImage: imageResolved.activeImage,
    activeSttProviderId: sttResolved.activeSttProviderId,
    activeStt: sttResolved.activeStt
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
 * @param {PageWandProvider|null|undefined} provider
 * @param {string} modelId
 * @returns {PageWandProvider|null}
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
 * @param {Partial<PageWandProvider>} provider
 * @param {{ makeActive?: boolean }} [opts]
 */
export async function upsertProvider(provider, opts = {}) {
  const { providers, activeProviderId } = await loadProvidersState();
  const next = normalizeProvider(provider);
  if (!next) throw new Error('INVALID_PROVIDER');
  const idx = providers.findIndex((p) => p.id === next.id);
  // Preserve existing API key when UI sends empty (user left field blank = keep)
  if (idx >= 0) {
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
    if (!next.createdAt) next.createdAt = providers[idx].createdAt;
    providers[idx] = next;
  } else {
    providers.push(next);
  }
  const makeActive =
    opts.makeActive !== false && !isImageOnlyProvider(next) && !isSttOnlyProvider(next);
  const newActive = makeActive ? next.id : activeProviderId;
  const imageId = isImageProvider(next)
    ? (opts.makeImageActive === false ? undefined : next.id)
    : undefined;
  const sttId = isSttOnlyProvider(next)
    ? (opts.makeSttActive === false ? undefined : next.id)
    : undefined;
  return saveProvidersState(providers, newActive, imageId, sttId);
}

/**
 * Delete a provider. If it was active, activate the first remaining.
 * @param {string} providerId
 */
export async function deleteProvider(providerId) {
  const { providers, activeProviderId, activeImageProviderId, activeSttProviderId } =
    await loadProvidersState();
  const list = providers.filter((p) => p.id !== providerId);
  let newActive = activeProviderId;
  if (activeProviderId === providerId) {
    newActive = listChatProviders(list)[0]?.id || null;
  }
  const imageId = activeImageProviderId === providerId ? null : activeImageProviderId;
  const sttId = activeSttProviderId === providerId ? null : activeSttProviderId;
  return saveProvidersState(list, newActive, imageId, sttId);
}

/**
 * Load LLM settings from chrome.storage.local (active OpenAI-compatible provider).
 * @returns {Promise<{
 *   apiKey: string,
 *   apiBase: string,
 *   model: string,
 *   providerId: string|null,
 *   providerName: string,
 *   providers: PageWandProvider[],
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

export async function loadLlmSettings() {
  const {
    providers,
    activeProviderId,
    active,
    activeImageProviderId,
    activeImage,
    activeStt
  } = await loadProvidersState();
  const sttFields = sttSettingsFields(activeStt);

  if (active) {
    return {
      apiKey: active.apiKey || '',
      apiBase: (active.baseURL || DEFAULT_BASE).replace(/\/$/, ''),
      model: active.model || 'deepseek-v4-flash',
      providerId: active.id,
      providerName: active.name || 'Provider',
      providers,
      activeProviderId,
      activeImageProviderId,
      image: activeImage?.image || undefined,
      imageProviderId: activeImage?.id || null,
      imageProviderName: activeImage ? imageVendorLabel(activeImage) : '',
      ...sttFields
    };
  }

  // No chat provider yet: fall back to legacy keys if any. Image / STT still attach.
  const res = await storageGet([
    'pagewand_api_key',
    'pagewand_api_base',
    'selected_model',
    'DEEPSEEK_API_KEY'
  ]);
  return {
    apiKey: res.pagewand_api_key || res.DEEPSEEK_API_KEY || '',
    apiBase: (res.pagewand_api_base || DEFAULT_BASE).replace(/\/$/, ''),
    model: res.selected_model || 'deepseek-v4-flash',
    providerId: null,
    providerName: '',
    providers,
    activeProviderId: null,
    activeImageProviderId: activeImageProviderId || null,
    image: activeImage?.image || undefined,
    imageProviderId: activeImage?.id || null,
    imageProviderName: activeImage ? imageVendorLabel(activeImage) : '',
    ...sttFields
  };
}
