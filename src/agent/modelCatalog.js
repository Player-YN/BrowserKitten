/**
 * PageWand model catalog (IG-6) — OpenAI-compatible GET /models + shrink UI helpers.
 *
 * Purpose: aggregators (e.g. OpenRouter) may return 200+ models. Never dump the full
 * list as the default settings view — use Recommended / Recent / Favorites + search
 * with a display cap.
 *
 * chrome.storage.local keys (documented):
 *   pagewand_model_catalog_cache  — { [hostKey]: { baseURL, models: ModelEntry[], fetchedAt } }
 *   pagewand_model_recent         — string[] of chat model ids (most-recent first)
 *   pagewand_model_favorites      — string[] of favorited chat model ids
 *
 * Image models: static MiniMax list only + always-available manual entry (not fetched).
 *
 * Never log or export API keys.
 */

/**
 * @typedef {{
 *   supported: boolean,
 *   efforts: string[]|null,
 *   defaultEffort: string|null,
 *   defaultEnabled: boolean,
 *   mandatory: boolean
 * }} ModelReasoningInfo
 *
 * @typedef {{ id: string, name?: string, image?: boolean, inputModalities?: string[], inputModalitiesSource?: 'architecture.input_modalities'|'input_modalities'|'inference_metadata.request_modality', reasoning?: ModelReasoningInfo, contextWindow?: number }} ModelEntry
 */

/** Gateway effort order (highest first), matching OpenRouter reasoning.effort. */
export const GATEWAY_REASONING_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];

const EFFORT_SET = new Set(GATEWAY_REASONING_EFFORTS);

/** Low → high rank for slider layout. */
export const REASONING_EFFORT_RANK = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5
};

/**
 * Collapse a model's advertised efforts into a 3- or 5-stop slider (low → high).
 * 6-stop gateway lists drop to 5 (keep min/low/mid/high/max).
 * @param {string[]|null|undefined} levels
 * @returns {string[]|null}
 */
export function normalizeEffortSteps(levels) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const uniq = [...new Set(levels.map((e) => String(e || '').toLowerCase()))].filter((e) =>
    EFFORT_SET.has(e)
  );
  uniq.sort((a, b) => REASONING_EFFORT_RANK[a] - REASONING_EFFORT_RANK[b]);
  if (!uniq.length) return null;
  if (uniq.length <= 5) return uniq;
  const prefer = ['minimal', 'low', 'medium', 'high', 'max'];
  const picked = prefer.filter((e) => uniq.includes(e));
  if (picked.length >= 3) return picked.slice(0, 5);
  const last = uniq.length - 1;
  return [...new Set([0, Math.round(last * 0.25), Math.round(last * 0.5), Math.round(last * 0.75), last].map((i) => uniq[i]))];
}

/**
 * Parse OpenRouter (or compatible) per-model reasoning metadata.
 * @param {object} [raw]
 * @returns {ModelReasoningInfo|null}
 */
export function parseModelReasoning(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {any} */ (raw).reasoning;
  const params = Array.isArray(/** @type {any} */ (raw).supported_parameters)
    ? /** @type {any} */ (raw).supported_parameters
    : [];
  const paramHint = params.some((p) => String(p).toLowerCase() === 'reasoning');
  if (!r || typeof r !== 'object') {
    if (!paramHint) return null;
    return {
      supported: true,
      efforts: null,
      defaultEffort: null,
      defaultEnabled: false,
      mandatory: false
    };
  }
  let efforts = null;
  if (Array.isArray(r.supported_efforts)) {
    efforts = r.supported_efforts
      .map((e) => String(e || '').toLowerCase())
      .filter((e) => EFFORT_SET.has(e));
  } else if (r.supported_efforts === null) {
    efforts = GATEWAY_REASONING_EFFORTS.slice();
  }
  const def = String(r.default_effort || '').toLowerCase();
  return {
    supported: true,
    efforts,
    defaultEffort: EFFORT_SET.has(def) ? def : null,
    defaultEnabled: r.default_enabled === true,
    mandatory: r.mandatory === true
  };
}

/**
 * @param {ModelEntry[]} models
 * @param {string} modelId
 * @returns {ModelEntry|null}
 */
export function findCatalogModel(models, modelId) {
  const want = String(modelId || '').trim();
  if (!want || !Array.isArray(models)) return null;
  const exact = models.find((m) => m.id === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  const ci = models.find((m) => String(m.id || '').toLowerCase() === lower);
  if (ci) return ci;
  const tail = models.find((m) => {
    const id = String(m.id || '').toLowerCase();
    return id.endsWith(`/${lower}`) || lower.endsWith(`/${id}`);
  });
  return tail || null;
}

/**
 * Effort chips for a model. null = do not show a selector (unknown or unsupported).
 * @param {ModelReasoningInfo|null|undefined} info
 * @returns {string[]|null}
 */
/** Conservative default when /models does not advertise a window. */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Read advertised context window from OpenRouter / OpenAI-compatible /models rows.
 * @param {object} [raw]
 * @returns {number|null}
 */
export function parseContextWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {any} */ (raw);
  const top = o.top_provider && typeof o.top_provider === 'object' ? o.top_provider : {};
  const modelInfo = o.model_info && typeof o.model_info === 'object' ? o.model_info : {};
  const candidates = [
    o.context_length,
    o.contextLength,
    o.context_window,
    o.max_context_length,
    o.max_input_tokens,
    top.context_length,
    top.max_input_tokens,
    // Alibaba Cloud Model Studio / DashScope GET /api/v1/models.
    modelInfo.context_window,
    modelInfo.max_input_tokens
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 2048) return Math.round(n);
  }
  return null;
}

function familyContextWindow(modelId) {
  const s = String(modelId || '').toLowerCase();
  if (!s) return null;
  if (s.includes('gemini')) return 1_000_000;
  if (s.includes('claude')) return 200_000;
  if (s.includes('grok')) return 131_072;
  if (/gpt-4\.1|o3|o4-mini/.test(s)) return 1_000_000;
  if (s.includes('deepseek')) return 128_000;
  if (s.includes('gpt-4o') || s.includes('gpt-4')) return 128_000;
  return null;
}

/**
 * Last-resort guess from model id when the catalog has no window.
 * Unknown ids use the compacting default; UI should call resolveContextWindow(..., { allowDefault: false }).
 * @param {string} [modelId]
 * @returns {number}
 */
export function guessContextWindow(modelId) {
  return familyContextWindow(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Adaptive window: catalog row → known family → optional 128k compacting default.
 * @param {string} [modelId]
 * @param {ModelEntry|null|undefined} [entry]
 * @param {{ allowDefault?: boolean }} [opts]
 * @returns {number|null}
 */
export function resolveContextWindow(modelId, entry, opts = {}) {
  const advertised = Number(entry?.contextWindow);
  if (Number.isFinite(advertised) && advertised >= 2048) return Math.round(advertised);
  const family = familyContextWindow(modelId || entry?.id);
  if (family) return family;
  return opts.allowDefault === false ? null : DEFAULT_CONTEXT_WINDOW;
}

/** GET /models 404/405: vendor has no catalog. Not an auth or server failure. */
export function isMissingModelsCatalogError(error) {
  const status = Number(error?.status);
  if (status === 404 || status === 405) return true;
  return /\bHTTP\s*40[45]\b/.test(String(error?.message || error || ''));
}

/**
 * Strip aggregator/provider prefix (`x-ai/`, `openai/`, `anthropic/`, …) and lowercase.
 * @param {string} [modelId]
 * @returns {string}
 */
export function normalizeChatModelId(modelId) {
  const raw = String(modelId || '').toLowerCase().trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * Explicit vision tokens on the *leaf* id (after prefix strip).
 * `revision` / `television` must not count.
 * @param {string} id
 */
function hasExplicitVisionHint(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (/(?:^|[-_.:])vl\d*(?:[-_.:]|$)/.test(s)) return true;
  return /(?:^|[-_./:])vision(?:[-_./:]|$)/.test(s);
}

/**
 * Known text-only chat families (leaf id). Vision exceptions (`vl` / `vision`) win.
 * Unknown ids are NOT listed — BYOK defaults permissive.
 */
const TEXT_ONLY_CHAT_PATTERNS = [
  /^deepseek(?:[-_.]|$)/,
  /^o1-mini(?:[-_.]|$)/,
  /^o3-mini(?:[-_.]|$)/,
  /^gpt-3\.5/,
  /^text-davinci/,
  /^claude-instant/,
  /^claude-2(?:[-_.]|$)/
];

/**
 * Known multimodal / vision chat families (leaf id). Informational — unknown is still capable.
 */
const VISION_CHAT_PATTERNS = [
  /^grok-[34](?:[.\-]|$)/,
  /^grok-2-vision/,
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-4-turbo/,
  /^gpt-4-vision/,
  /^gpt-5/,
  /^claude-3/,
  /^claude-(?:sonnet|opus|haiku)/,
  /^gemini/,
  /^qwen(?:\d+(?:\.\d+)?)?-?vl/,
  /^qwen-vl/,
  /^glm-4v/,
  /^doubao(?:[-_].*)?(?:vision|vl)/,
  /llava/,
  /(?:^|[-_.:])vl\d*(?:[-_.:]|$)/,
  /(?:^|[-_./:])vision(?:[-_./:]|$)/
];

/**
 * @param {string} [modelId]
 * @returns {boolean}
 */
export function isKnownTextOnlyChatModel(modelId) {
  const id = normalizeChatModelId(modelId);
  if (!id) return false;
  if (hasExplicitVisionHint(id)) return false;
  return TEXT_ONLY_CHAT_PATTERNS.some((re) => re.test(id));
}

/**
 * @param {string} [modelId]
 * @returns {boolean}
 */
export function isKnownVisionChatModel(modelId) {
  const id = normalizeChatModelId(modelId);
  if (!id) return false;
  if (isKnownTextOnlyChatModel(id)) return false;
  if (hasExplicitVisionHint(id)) return true;
  return VISION_CHAT_PATTERNS.some((re) => re.test(id));
}

/**
 * `'vision' | 'text-only' | 'unknown'`
 * Empty / unset id is `unknown` (BYOK: do not block).
 * @param {string} [modelId]
 * @returns {'vision'|'text-only'|'unknown'}
 */
export function classifyChatVisionCapability(modelId) {
  const id = normalizeChatModelId(modelId);
  if (!id) return 'unknown';
  if (isKnownTextOnlyChatModel(id)) return 'text-only';
  if (isKnownVisionChatModel(id)) return 'vision';
  return 'unknown';
}

/**
 * Whether the host should treat this chat model as able to receive image parts.
 * Known text-only families → false. Known vision *and unknown* → true (permissive).
 * A stale allow-list must not block a BYOK send; provider errors surface at runtime.
 * @param {string} [modelId]
 * @returns {boolean}
 */
export function isVisionCapableModel(modelId) {
  return classifyChatVisionCapability(modelId) !== 'text-only';
}

export function effortLevelsForReasoning(info) {
  const core =
    info && info.supported
      ? normalizeEffortSteps(info.efforts)
      : ['low', 'medium', 'high'];
  const steps = core && core.length ? core : ['low', 'medium', 'high'];
  const gears = steps.filter((e) => e !== 'none');
  if (info?.mandatory) return gears.length ? gears : ['medium'];
  return ['none', ...gears];
}

/** chrome.storage.local keys */
export const MODEL_CATALOG_CACHE_KEY = 'pagewand_model_catalog_cache';
export const MODEL_RECENT_KEY = 'pagewand_model_recent';
export const MODEL_FAVORITES_KEY = 'pagewand_model_favorites';

/** Initial list display cap (search can narrow; still capped for DOM). */
export const DEFAULT_DISPLAY_CAP = 30;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RECENT = 12;
export const MAX_FAVORITES = 40;
export const MAX_CACHE_HOSTS = 12;
/** Soft cap on models kept in cache per host (search still works offline on cache). */
export const MAX_CACHED_MODELS_PER_HOST = 500;

/**
 * Hardcoded recommended chat models (small; shown before any fetch).
 * Not vendor-locked — free-text model always wins.
 * @type {ModelEntry[]}
 */
export const RECOMMENDED_CHAT_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-4.1', name: 'GPT-4.1' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  { id: 'openai/gpt-4o', name: 'OpenRouter · GPT-4o' },
  { id: 'anthropic/claude-sonnet-4', name: 'OpenRouter · Claude Sonnet' },
  { id: 'MiniMax-Text-01', name: 'MiniMax Text-01' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
];

/**
 * Static image models for protocol minimax-image (manual entry always available).
 * @type {ModelEntry[]}
 */
export const STATIC_IMAGE_MODELS_MINIMAX = [
  { id: 'image-01', name: 'image-01 (MiniMax t2i/i2i)' }
];

export const DEFAULT_IMAGE_MODEL_ID = 'image-01';

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * @param {string} baseURL
 * @returns {string}
 */
export function normalizeModelsBaseURL(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') return '';
  return baseURL.trim().replace(/\/+$/, '');
}

/**
 * Host key for cache map (no secrets).
 * @param {string} baseURL
 * @returns {string}
 */
export function catalogHostKey(baseURL) {
  const base = normalizeModelsBaseURL(baseURL);
  if (!base) return '';
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`);
    return (u.host + u.pathname).replace(/\/+$/, '') || u.host;
  } catch {
    return base.replace(/^https?:\/\//i, '').slice(0, 120);
  }
}

/**
 * Build GET /models URL from chat base.
 * @param {string} baseURL
 * @returns {string}
 */
export function modelsEndpointURL(baseURL) {
  const base = normalizeModelsBaseURL(baseURL);
  if (!base) throw new Error('baseURL required');
  // DashScope exposes OpenAI-compatible chat at /compatible-mode/v1, but its
  // documented rich model catalog lives at /api/v1/models on the same regional
  // host.  This is an endpoint adapter only: authentication stays Bearer and
  // no vendor-specific request stack is introduced.
  try {
    const url = new URL(base);
    const isDashScopeHost = /(?:^|\.)(?:dashscope(?:-intl)?|[a-z0-9-]+\.(?:cn-[a-z-]+|eu-central-1|ap-northeast-1|us-east-1)\.maas)\.aliyuncs\.com$/i.test(url.hostname);
    if (isDashScopeHost && /\/compatible-mode\/v1\/?$/i.test(url.pathname)) {
      return `${url.origin}/api/v1/models`;
    }
  } catch { /* retain generic OpenAI-compatible behavior for custom bases */ }
  return `${base}/models`;
}

/**
 * Detect embedding-only (or non-chat) model ids when possible.
 * Conservative: only exclude clear embedding / moderation / audio-transcribe noise.
 * @param {string} id
 * @param {object} [raw]
 * @returns {boolean} true if should be excluded from chat picker
 */
/**
 * True/false when the row declares output image modality; null when unknown.
 * VLMs that only *input* images must not count as generators.
 * @param {object} [raw]
 * @returns {boolean|null}
 */
export function hasImageOutputModality(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {any} */ (raw);
  const arch = o.architecture && typeof o.architecture === 'object' ? o.architecture : {};
  const outs = arch.output_modalities ?? o.output_modalities;
  if (Array.isArray(outs) || typeof outs === 'string') {
    const list = Array.isArray(outs) ? outs : [outs];
    return list.some((m) => String(m || '').toLowerCase().includes('image'));
  }
  const modality = String(arch.modality || o.modality || '').toLowerCase();
  if (modality.includes('->')) return /->\s*.*\bimage\b/.test(modality);
  return null;
}

/**
 * Image-generation models: OUTPUT image modality wins.
 * Name heuristics only when the catalog row does not declare modalities.
 * @param {string} id
 * @param {object} [raw]
 */
export function isLikelyImageGenModel(id, raw) {
  const declared = hasImageOutputModality(raw);
  if (declared === true) return true;
  if (declared === false) return false;
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (
    /(flux|dall-e|dalle|gpt-image|imagen|ideogram|recraft|stable-diffusion|\bsdxl\b|image-01|flash-image|grok-2-image|seedream|nano-banana)/i.test(
      s
    )
  ) {
    return true;
  }
  if (s.endsWith('-image') || s.includes('-image-') || s.includes('/image-')) return true;
  return false;
}

export function isLikelySttModel(id, raw) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (/(whisper|speech-to-text|audio-transcri|transcribe)/i.test(s)) return true;
  if (raw && typeof raw === 'object') {
    const arch = String(
      /** @type {any} */ (raw).architecture?.modality ||
        /** @type {any} */ (raw).architecture?.output_modalities ||
        ''
    ).toLowerCase();
    if (arch.includes('audio') && (arch.includes('text') || arch.includes('transcri'))) return true;
  }
  return false;
}

export function sttModelsFromList(models) {
  return (Array.isArray(models) ? models : []).filter((m) => m && m.id && isLikelySttModel(m.id, m));
}

export function isLikelyNonChatModel(id, raw) {
  const s = String(id || '').toLowerCase();
  if (!s) return true;
  if (/(^|\/|-)embed(ding)?s?($|\/|-|\.)/.test(s)) return true;
  if (s.includes('text-embedding') || s.includes('embedding-')) return true;
  if (s.includes('moderation')) return true;
  if (/(whisper|tts-|speech-to-text|audio-transcri)/.test(s)) return true;
  if (raw && typeof raw === 'object') {
    const obj = String(/** @type {any} */ (raw).object || '').toLowerCase();
    if (obj === 'embedding' || obj.includes('embedding')) return true;
    const arch = String(
      /** @type {any} */ (raw).architecture?.modality ||
        /** @type {any} */ (raw).architecture?.output_modalities ||
        ''
    ).toLowerCase();
    // OpenRouter sometimes tags embedding-only
    if (arch === 'text->embedding' || arch.includes('embedding')) return true;
  }
  return false;
}

/**
 * Canonical input modalities understood by the chat-media layer.
 *
 * Keep this deliberately narrow.  A catalog may contain output modalities,
 * model-family labels, or broad claims such as "vision"; none establishes an
 * input wire capability.  Only the documented per-model input arrays below
 * enter this normalizer.
 *
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function normalizeCatalogInputModalities(raw) {
  if (!Array.isArray(raw)) return null;
  const aliases = {
    text: 'text',
    image: 'image',
    images: 'image',
    audio: 'audio',
    video: 'video',
    file: 'file',
    files: 'file'
  };
  const values = raw
    .map((value) => aliases[String(value || '').trim().toLowerCase()])
    .filter(Boolean);
  return values.length ? [...new Set(values)] : null;
}

/**
 * Extract a documented per-model input-modality declaration.
 *
 * Supported catalog contracts:
 * - OpenRouter: architecture.input_modalities
 * - OpenAI-compatible extensions: input_modalities
 * - Alibaba Cloud Model Studio / DashScope: inference_metadata.request_modality
 *
 * Do not add `output_modalities`, DashScope `capabilities`, descriptions, or
 * model-name rules here.  They cannot prove that this chat endpoint accepts a
 * particular input media type.
 *
 * @param {unknown} raw
 * @returns {{ modalities: string[], source: NonNullable<ModelEntry['inputModalitiesSource']> }|null}
 */
export function parseCatalogInputModalities(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = /** @type {any} */ (raw);
  const candidates = [
    [item.architecture?.input_modalities, 'architecture.input_modalities'],
    [item.input_modalities, 'input_modalities'],
    [item.inference_metadata?.request_modality, 'inference_metadata.request_modality']
  ];
  for (const [value, source] of candidates) {
    const modalities = normalizeCatalogInputModalities(value);
    if (modalities) return { modalities, source: /** @type {any} */ (source) };
  }
  return null;
}

/**
 * Normalize OpenAI-compatible /models JSON → ModelEntry[].
 * @param {unknown} payload
 * @param {{ filterEmbeddings?: boolean }} [opts]
 * @returns {ModelEntry[]}
 */
export function parseModelsResponse(payload, opts = {}) {
  const filterEmbeddings = opts.filterEmbeddings !== false;
  let list = [];
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === 'object') {
    const d = /** @type {any} */ (payload).data;
    if (Array.isArray(d)) list = d;
    else if (Array.isArray(/** @type {any} */ (payload).models)) {
      list = /** @type {any} */ (payload).models;
    } else if (Array.isArray(/** @type {any} */ (payload).output?.models)) {
      // Alibaba Cloud Model Studio / DashScope GET /api/v1/models.
      list = /** @type {any} */ (payload).output.models;
    }
  }

  /** @type {ModelEntry[]} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    let id = '';
    let name;
    if (typeof item === 'string') {
      id = item.trim();
    } else if (typeof item === 'object') {
      id = String(
        /** @type {any} */ (item).id ||
          /** @type {any} */ (item).model ||
          /** @type {any} */ (item).name ||
          ''
      ).trim();
      const n = /** @type {any} */ (item).name || /** @type {any} */ (item).display_name;
      if (typeof n === 'string' && n.trim() && n.trim() !== id) name = n.trim();
    }
    if (!id || seen.has(id)) continue;
    const rawObj = typeof item === 'object' ? item : undefined;
    const image = isLikelyImageGenModel(id, rawObj);
    if (filterEmbeddings && !image && isLikelyNonChatModel(id, rawObj)) {
      continue;
    }
    seen.add(id);
    /** @type {ModelEntry} */
    const entry = { id };
    const declaredInputs = parseCatalogInputModalities(rawObj);
    if (declaredInputs) {
      entry.inputModalities = declaredInputs.modalities;
      entry.inputModalitiesSource = declaredInputs.source;
    }
    if (image) entry.image = true;
    if (name) entry.name = name;
    const reasoning = parseModelReasoning(typeof item === 'object' ? item : undefined);
    if (reasoning) entry.reasoning = reasoning;
    const contextWindow = parseContextWindow(typeof item === 'object' ? item : undefined);
    if (contextWindow) entry.contextWindow = contextWindow;
    out.push(entry);
  }
  // Stable-ish: alphabetical by id for predictable search
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Filter + cap for UI display (never dump 200+ rows).
 * @param {ModelEntry[]} models
 * @param {{ query?: string, limit?: number, preferIds?: string[] }} [opts]
 * @returns {{ items: ModelEntry[], total: number, truncated: boolean, query: string }}
 */
export function shrinkModelList(models, opts = {}) {
  const all = Array.isArray(models) ? models : [];
  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const limit = Math.max(
    1,
    Math.min(
      typeof opts.limit === 'number' && Number.isFinite(opts.limit)
        ? opts.limit
        : DEFAULT_DISPLAY_CAP,
      MAX_SEARCH_RESULTS
    )
  );
  const prefer = Array.isArray(opts.preferIds) ? opts.preferIds.filter(Boolean) : [];

  let filtered = all;
  if (query) {
    filtered = all.filter((m) => {
      const id = (m.id || '').toLowerCase();
      const name = (m.name || '').toLowerCase();
      return id.includes(query) || name.includes(query);
    });
  }

  // Prefer current / recent ids near top when no query
  if (!query && prefer.length) {
    const preferSet = new Set(prefer);
    const head = [];
    const rest = [];
    for (const m of filtered) {
      if (preferSet.has(m.id)) head.push(m);
      else rest.push(m);
    }
    // keep prefer order
    head.sort((a, b) => prefer.indexOf(a.id) - prefer.indexOf(b.id));
    filtered = head.concat(rest);
  }

  const truncated = filtered.length > limit;
  return {
    items: filtered.slice(0, limit),
    total: filtered.length,
    truncated,
    query
  };
}

/**
 * Filter one picker modality (推理 or 生图). Query never searches the other list.
 * @param {ModelEntry[]} models
 * @param {string} [query]
 * @param {{ limit?: number, preferIds?: string[] }} [opts]
 * @returns {{ items: ModelEntry[], total: number, truncated: boolean, query: string }}
 */
export function filterPickerGroup(models, query, opts = {}) {
  return shrinkModelList(Array.isArray(models) ? models : [], {
    query: typeof query === 'string' ? query : '',
    limit: opts.limit,
    preferIds: opts.preferIds
  });
}

/**
 * Recommended slice: hardcoded small list, optionally filtered by baseURL hint.
 * @param {string} [baseURL]
 * @returns {ModelEntry[]}
 */
export function getRecommendedChatModels(baseURL = '') {
  const host = catalogHostKey(baseURL).toLowerCase();
  if (!host) return RECOMMENDED_CHAT_MODELS.slice(0, 8);
  if (host.includes('deepseek')) {
    return RECOMMENDED_CHAT_MODELS.filter((m) => m.id.includes('deepseek')).concat(
      RECOMMENDED_CHAT_MODELS.filter((m) => !m.id.includes('deepseek')).slice(0, 3)
    );
  }
  if (host.includes('openrouter')) {
    return RECOMMENDED_CHAT_MODELS.filter(
      (m) => m.id.includes('/') || m.id.startsWith('gpt') || m.id.includes('claude')
    ).slice(0, 8);
  }
  if (host.includes('minimax') || host.includes('minimaxi')) {
    return RECOMMENDED_CHAT_MODELS.filter((m) => /minimax/i.test(m.id)).concat(
      RECOMMENDED_CHAT_MODELS.slice(0, 4)
    );
  }
  if (host.includes('openai.com')) {
    return RECOMMENDED_CHAT_MODELS.filter((m) => m.id.startsWith('gpt')).concat(
      RECOMMENDED_CHAT_MODELS.filter((m) => !m.id.startsWith('gpt')).slice(0, 2)
    );
  }
  return RECOMMENDED_CHAT_MODELS.slice(0, 8);
}

/**
 * Static image model suggestions (minimax-image protocol).
 * @param {string} [protocol]
 * @returns {ModelEntry[]}
 */
/**
 * @param {ModelEntry[]} models
 * @returns {ModelEntry[]}
 */
export function chatModelsFromList(models) {
  return (Array.isArray(models) ? models : []).filter(
    (m) => m && m.id && !m.image && !isLikelyImageGenModel(m.id)
  );
}

/**
 * @param {ModelEntry[]} models
 * @returns {ModelEntry[]}
 */
export function imageModelsFromList(models) {
  return (Array.isArray(models) ? models : []).filter(
    (m) => m && m.id && (m.image === true || isLikelyImageGenModel(m.id))
  );
}

/**
 * Last path segment for compact chip / picker labels (`x-ai/grok-4` → `grok-4`).
 * @param {string} [modelId]
 * @returns {string}
 */
export function shortModelId(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * Composer chip: chat only, or `chat · image` once an image model is active.
 * @param {string} [chatModel]
 * @param {string} [imageModel]
 * @returns {string}
 */
export function formatModelChipLabel(chatModel, imageModel) {
  const chat = shortModelId(chatModel);
  const image = shortModelId(imageModel);
  if (chat && image) return `${chat} · ${image}`;
  return chat || image || '';
}

/**
 * Split one provider's catalog into picker groups.
 * Image group is empty unless image API is enabled and at least one image model id exists.
 * @param {{ model?: string, image?: { enabled?: boolean, model?: string } }|null|undefined} provider
 * @param {{ chat?: ModelEntry[], image?: ModelEntry[] }} [catalog]
 * @returns {{ chat: ModelEntry[], image: ModelEntry[] }}
 */
export function buildProviderPickerGroups(provider, catalog = {}) {
  /** @type {ModelEntry[]} */
  const chat = [];
  /** @type {ModelEntry[]} */
  const image = [];
  const seenChat = new Set();
  const seenImage = new Set();
  const push = (list, seen, id, name) => {
    const mid = String(id || '').trim();
    if (!mid || seen.has(mid)) return;
    seen.add(mid);
    list.push({ id: mid, name: name || mid });
  };

  const imageOn = !!(provider?.image && provider.image.enabled);
  if (imageOn) {
    push(image, seenImage, provider.image.model);
    for (const m of catalog.image || []) {
      if (!m?.id) continue;
      if (m.image === false) continue;
      if (m.image !== true && !isLikelyImageGenModel(m.id)) continue;
      push(image, seenImage, m.id, m.name);
    }
  }

  const chatId = String(provider?.model || '').trim();
  if (chatId) push(chat, seenChat, chatId);
  for (const m of catalog.chat || []) {
    if (!m?.id) continue;
    if (m.image || seenImage.has(m.id)) continue;
    if (m.id !== chatId && isLikelyImageGenModel(m.id)) continue;
    push(chat, seenChat, m.id, m.name);
  }
  return { chat, image };
}

/**
 * Apply a GET /models probe onto a provider record + split catalogs.
 * Same lastProbe shape Settings writes on pagewand_providers. Does not
 * change the current chat / image model ids.
 *
 * @param {object|null|undefined} provider
 * @param {{ ok?: boolean, models?: ModelEntry[], count?: number, error?: string }} probe
 * @param {number} [now]
 * @returns {{ provider: object, catalog: { chat: ModelEntry[], image: ModelEntry[] }, lastProbe: { ok: boolean, at: number, count: number, error?: string } }}
 */
export function applyProviderProbeResult(provider, probe, now = Date.now()) {
  const models = Array.isArray(probe?.models) ? probe.models : [];
  const chatRaw = chatModelsFromList(models);
  const catalog = {
    chat: chatRaw.length ? chatRaw : models.filter((m) => m && m.id && !m.image),
    image: imageModelsFromList(models)
  };
  /** @type {{ ok: boolean, at: number, count: number, error?: string }} */
  const lastProbe = {
    ok: probe?.ok === true,
    at: Number.isFinite(now) ? now : Date.now(),
    count: Number(probe?.count) || (probe?.ok ? catalog.chat.length : 0)
  };
  if (!lastProbe.ok) lastProbe.error = String(probe?.error || 'error');
  return {
    provider: provider && typeof provider === 'object' ? { ...provider, lastProbe } : { lastProbe },
    catalog,
    lastProbe
  };
}

/**
 * Picker refresh after a probe: lastProbe + 推理 / 生图 groups.
 * Current selections stay first in each group when still present.
 *
 * @param {object|null|undefined} provider
 * @param {{ ok?: boolean, models?: ModelEntry[], count?: number, error?: string }} probe
 * @param {number} [now]
 */
export function refreshPickerCatalogFromProbe(provider, probe, now = Date.now()) {
  const applied = applyProviderProbeResult(provider, probe, now);
  return {
    lastProbe: applied.lastProbe,
    groups: buildProviderPickerGroups(applied.provider, applied.catalog)
  };
}

export function getStaticImageModels(protocol = 'minimax-image') {
  if (!protocol || protocol === 'minimax-image') {
    return STATIC_IMAGE_MODELS_MINIMAX.slice();
  }
  // Unknown protocol: still offer manual default id as a chip
  return [{ id: DEFAULT_IMAGE_MODEL_ID, name: DEFAULT_IMAGE_MODEL_ID }];
}

// ── network ─────────────────────────────────────────────────────────────────

/**
 * Fetch models via background llm_proxy_fetch when available, else direct fetch.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<any>}
 */
/**
 * @param {any} json
 * @param {number} [status]
 * @returns {string}
 */
function modelsErrorMessage(json, status) {
  const msg =
    json?.error?.message || json?.error || json?.message || (status ? `HTTP ${status}` : 'Models request failed');
  return typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200);
}

async function proxyOrDirectGetJson(url, headers) {
  // Background proxy (avoids CORS quirks in side panel)
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    let proxyTransportFailed = false;
    try {
      // Omit body on GET (fetch rejects GET+body in some runtimes)
      const res = await chrome.runtime.sendMessage({
        action: 'llm_proxy_fetch',
        url,
        method: 'GET',
        headers: headers || {}
      });
      if (res && res.ok && res.json != null) return res.json;
      if (res && res.ok && res.text) {
        try {
          return JSON.parse(res.text);
        } catch {
          throw new Error(res.text.slice(0, 400));
        }
      }
      // HTTP error from vendor via proxy — surface message
      if (res && res.ok === false) {
        let json = res.json;
        if (json == null && res.text) {
          try {
            json = JSON.parse(res.text);
          } catch {
            throw new Error(String(res.text).slice(0, 400));
          }
        }
        const err = new Error(modelsErrorMessage(json, res.status));
        err.status = Number(res.status) || 0;
        throw err;
      }
      if (res && res.error) {
        // Extension-level proxy failure → try direct
        console.warn('[PageWand modelCatalog] proxy:', res.error);
        proxyTransportFailed = true;
      }
    } catch (e) {
      if (e?.message && String(e.message).includes('Receiving end')) {
        proxyTransportFailed = true;
      } else if (proxyTransportFailed) {
        // fall through
      } else if (e && e.message) {
        // Vendor/API or parse error from proxy path — do not hide
        throw e;
      }
    }
  }

  const r = await fetch(url, { method: 'GET', headers });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Models bad JSON (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
  if (!r.ok) {
    const err = new Error(modelsErrorMessage(json, r.status));
    err.status = r.status;
    throw err;
  }
  return json;
}

/**
 * GET {baseURL}/models — OpenAI-compatible.
 * Filters embedding-only when detectable. Returns list of { id, name? }.
 *
 * @param {string} baseURL - chat base (e.g. https://openrouter.ai/api/v1)
 * @param {string} apiKey
 * @param {{ signal?: AbortSignal, filterEmbeddings?: boolean }} [opts]
 * @returns {Promise<ModelEntry[]>}
 */
/**
 * Probe whether an OpenAI-compatible chat API answers GET /models.
 * Does not throw — UI can show ok/count/error.
 * @param {string} baseURL
 * @param {string} apiKey
 * @param {{ filterEmbeddings?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, endpoint: string, count: number, models: ModelEntry[], error?: string }>}
 */
export async function probeOpenAICompatibleApi(baseURL, apiKey, opts = {}) {
  let endpoint = '';
  try {
    endpoint = modelsEndpointURL(baseURL);
    const models = await fetchOpenAICompatibleModels(baseURL, apiKey, opts);
    return { ok: true, endpoint, count: models.length, models };
  } catch (e) {
    return {
      ok: false,
      endpoint,
      count: 0,
      models: [],
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Image-generation catalog. OpenRouter: GET /images/models, then
 * /models?output_modalities=image, then filtered GET /models.
 * Other hosts: filtered GET /models (output modality / known generator ids).
 * @param {string} baseURL
 * @param {string} apiKey
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<ModelEntry[]>}
 */
export async function fetchImageGenModels(baseURL, apiKey, opts = {}) {
  const base = normalizeModelsBaseURL(baseURL);
  if (!base) throw new Error('baseURL required');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('API Key required to refresh models');

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json'
  };
  if (base.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://pagewand.local';
    headers['X-Title'] = 'PageWand';
    const dedicated = [`${base}/images/models`, `${base}/models?output_modalities=image`];
    for (const url of dedicated) {
      try {
        const payload = await proxyOrDirectGetJson(url, headers);
        if (opts.signal?.aborted) {
          const err = new Error('ABORTED');
          err.code = 'ABORTED';
          throw err;
        }
        let models = parseModelsResponse(payload, { filterEmbeddings: true });
        if (url.includes('/images/models')) {
          models = models.map((m) => ({ ...m, image: true }));
        }
        const images = imageModelsFromList(models);
        if (images.length) {
          return images.length > MAX_CACHED_MODELS_PER_HOST
            ? images.slice(0, MAX_CACHED_MODELS_PER_HOST)
            : images;
        }
      } catch (e) {
        if (e?.code === 'ABORTED') throw e;
      }
    }
  }

  const all = await fetchOpenAICompatibleModels(base, key, opts);
  return imageModelsFromList(all);
}

/**
 * Speech-to-text catalog from GET /models (keep whisper / transcribe ids).
 * @param {string} baseURL
 * @param {string} apiKey
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<ModelEntry[]>}
 */
export async function fetchSttModels(baseURL, apiKey, opts = {}) {
  const all = await fetchOpenAICompatibleModels(baseURL, apiKey, {
    ...opts,
    filterEmbeddings: false
  });
  return sttModelsFromList(all);
}

export async function fetchOpenAICompatibleModels(baseURL, apiKey, opts = {}) {
  const base = normalizeModelsBaseURL(baseURL);
  if (!base) throw new Error('baseURL required');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('API Key required to refresh models');

  const url = modelsEndpointURL(base);
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json'
  };
  // OpenRouter optional attribution headers (harmless elsewhere)
  if (base.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://pagewand.local';
    headers['X-Title'] = 'PageWand';
  }

  const payload = await proxyOrDirectGetJson(url, headers);
  if (opts.signal?.aborted) {
    const err = new Error('ABORTED');
    err.code = 'ABORTED';
    throw err;
  }
  let models = parseModelsResponse(payload, {
    filterEmbeddings: opts.filterEmbeddings !== false
  });
  if (models.length > MAX_CACHED_MODELS_PER_HOST) {
    models = models.slice(0, MAX_CACHED_MODELS_PER_HOST);
  }
  return models;
}

// ── chrome.storage helpers ──────────────────────────────────────────────────

function storageGet(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    // Keep callback compatibility for existing mocks and older Chrome while
    // accepting the Promise form supplied by current MV3 contexts.
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message || 'storage_local_get failed'));
        else resolve(value || {});
      };
      try {
        const pending = chrome.storage.local.get(list, done);
        if (pending && typeof pending.then === 'function') pending.then(done, reject);
      } catch (error) { reject(error); }
    });
  }
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    return chrome.runtime.sendMessage({ target: 'pawwork-background', action: 'storage_local_get', keys: list })
      .then((res) => {
        if (!res?.ok) throw new Error(res?.error || 'storage_local_get failed');
        return res.result || {};
      });
  }
  // Node-only callers use no extension storage. In an extension context a
  // missing bridge is an error above, rather than a fabricated empty cache.
  return Promise.resolve({});
}

function storageSet(obj) {
  if (!obj || typeof obj !== 'object') return Promise.reject(new Error('storage_local_set requires an object'));
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message || 'storage_local_set failed'));
        else resolve();
      };
      try {
        const pending = chrome.storage.local.set(obj, done);
        if (pending && typeof pending.then === 'function') pending.then(done, reject);
      } catch (error) { reject(error); }
    });
  }
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    return chrome.runtime.sendMessage({ target: 'pawwork-background', action: 'storage_local_set', values: obj })
      .then((res) => {
        if (!res?.ok) throw new Error(res?.error || 'storage_local_set failed');
      });
  }
  return Promise.resolve();
}

/**
 * @param {string} baseURL
 * @param {ModelEntry[]} models
 */
export async function cacheModelsForBase(baseURL, models) {
  const key = catalogHostKey(baseURL);
  if (!key) return;
  const res = await storageGet([MODEL_CATALOG_CACHE_KEY]);
  /** @type {Record<string, any>} */
  const cache =
    res[MODEL_CATALOG_CACHE_KEY] && typeof res[MODEL_CATALOG_CACHE_KEY] === 'object'
      ? { ...res[MODEL_CATALOG_CACHE_KEY] }
      : {};
  cache[key] = {
    baseURL: normalizeModelsBaseURL(baseURL),
    models: Array.isArray(models) ? models : [],
    fetchedAt: Date.now()
  };
  // Evict oldest hosts if map grows
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_HOSTS) {
    keys
      .map((k) => ({ k, t: cache[k]?.fetchedAt || 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_CACHE_HOSTS)
      .forEach(({ k }) => {
        delete cache[k];
      });
  }
  await storageSet({ [MODEL_CATALOG_CACHE_KEY]: cache });
}

/**
 * @param {string} baseURL
 * @returns {Promise<{ models: ModelEntry[], fetchedAt: number|null }>}
 */
export async function loadCachedModelsForBase(baseURL) {
  const key = catalogHostKey(baseURL);
  if (!key) return { models: [], fetchedAt: null };
  const res = await storageGet([MODEL_CATALOG_CACHE_KEY]);
  const cache = res[MODEL_CATALOG_CACHE_KEY];
  const entry = cache && typeof cache === 'object' ? cache[key] : null;
  if (!entry || !Array.isArray(entry.models)) return { models: [], fetchedAt: null };
  // A host key keeps cache cardinality bounded, but catalog declarations are
  // evidence for one exact configured API base. Never apply a same-host route's
  // modal metadata to this route.
  if (normalizeModelsBaseURL(entry.baseURL) !== normalizeModelsBaseURL(baseURL)) {
    return { models: [], fetchedAt: null };
  }
  return {
    models: entry.models.filter((m) => m && typeof m.id === 'string'),
    fetchedAt: typeof entry.fetchedAt === 'number' ? entry.fetchedAt : null
  };
}

/** @returns {Promise<string[]>} */
export async function loadRecentModels() {
  const res = await storageGet([MODEL_RECENT_KEY]);
  const arr = res[MODEL_RECENT_KEY];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, MAX_RECENT);
}

/**
 * Push model id to recent (most-recent first). Dedupes.
 * @param {string} modelId
 */
export async function pushRecentModel(modelId) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return;
  const prev = await loadRecentModels();
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
  await storageSet({ [MODEL_RECENT_KEY]: next });
}

/** @returns {Promise<string[]>} */
export async function loadFavoriteModels() {
  const res = await storageGet([MODEL_FAVORITES_KEY]);
  const arr = res[MODEL_FAVORITES_KEY];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, MAX_FAVORITES);
}

/**
 * @param {string} modelId
 * @param {boolean} [force]
 * @returns {Promise<{ favorites: string[], isFavorite: boolean }>}
 */
export async function toggleFavoriteModel(modelId, force) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) {
    const favorites = await loadFavoriteModels();
    return { favorites, isFavorite: false };
  }
  const prev = await loadFavoriteModels();
  const has = prev.includes(id);
  const want = typeof force === 'boolean' ? force : !has;
  let next;
  if (want) {
    next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_FAVORITES);
  } else {
    next = prev.filter((x) => x !== id);
  }
  await storageSet({ [MODEL_FAVORITES_KEY]: next });
  return { favorites: next, isFavorite: want };
}

/**
 * Fetch + cache convenience for settings UI.
 * @param {string} baseURL
 * @param {string} apiKey
 * @returns {Promise<ModelEntry[]>}
 */
export async function refreshAndCacheModels(baseURL, apiKey) {
  try {
    const models = await fetchOpenAICompatibleModels(baseURL, apiKey);
    await cacheModelsForBase(baseURL, models);
    return models;
  } catch (error) {
    if (isMissingModelsCatalogError(error)) {
      const cached = await loadCachedModelsForBase(baseURL);
      return Array.isArray(cached.models) ? cached.models : [];
    }
    throw error;
  }
}
