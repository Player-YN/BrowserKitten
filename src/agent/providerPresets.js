/**
 * BYOK provider form templates (inference / image / stt / jev / web).
 * Base URLs are vendor-documented OpenAI-compatible or Anthropic Messages origins.
 * Inference `protocol` is always set: openai-compatible | anthropic | auto.
 */

/** @typedef {'openai-compatible'|'anthropic'|'auto'} InferencePresetProtocol */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   baseURL: string,
 *   model?: string,
 *   protocol: InferencePresetProtocol,
 *   apiKeyPlaceholder?: string,
 *   image?: object
 * }} InferenceProviderPreset
 */

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** @type {InferenceProviderPreset[]} */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    protocol: 'anthropic',
    apiKeyPlaceholder: 'sk-ant-...'
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'AIza...'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseURL: 'https://api.x.ai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'xai-...'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'gsk_...'
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseURL: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'moonshot-cn',
    name: 'Moonshot Kimi (中国)',
    baseURL: 'https://api.moonshot.cn/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'zai',
    name: 'Z.AI',
    baseURL: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'dashscope',
    name: '阿里云 DashScope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'volcengine-ark',
    name: '火山方舟 Ark',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-Text-01',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'eyJ... / API key',
    image: {
      enabled: false,
      protocol: 'minimax-image',
      path: '/image_generation',
      model: 'image-01'
    }
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    baseURL: 'https://api.stepfun.com/v1',
    model: 'step-3.7-flash',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseURL: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-plus-05-2026',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: OPENROUTER_API_BASE,
    model: 'openai/gpt-4o',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-or-...',
    image: {
      enabled: false,
      protocol: 'openrouter-image',
      path: '/images',
      model: 'google/gemini-2.5-flash-image',
      baseURL: OPENROUTER_API_BASE
    }
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    model: 'deepseek-v4-flash',
    protocol: 'auto',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.ai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'novita',
    name: 'Novita',
    baseURL: 'https://api.novita.ai/openai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-...'
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    baseURL: 'https://api.sambanova.ai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'nebius',
    name: 'Nebius Token Factory',
    baseURL: 'https://api.tokenfactory.nebius.com/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    baseURL: 'https://api.hyperbolic.xyz/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'featherless',
    name: 'Featherless',
    baseURL: 'https://api.featherless.ai/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: '...'
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'nvapi-...'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'ollama'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'lm-studio'
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    baseURL: '',
    model: '',
    protocol: 'openai-compatible',
    apiKeyPlaceholder: 'sk-... / any key'
  }
];

/** Image editor templates (not chat wire). */
export const IMAGE_PROVIDER_PRESETS = [
  { id: 'openrouter', name: 'OpenRouter', baseURL: OPENROUTER_API_BASE },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1' },
  { id: 'minimax', name: 'MiniMax', baseURL: 'https://api.minimaxi.com/v1' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', baseURL: '' }
];

/** STT editor templates. */
export const STT_PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'whisper-1' },
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', baseURL: '' }
];

/** Jev / System One templates. */
export const JEV_PROVIDER_PRESETS = [
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    model: 'jev-1.13'
  },
  { id: 'openrouter', name: 'OpenRouter', baseURL: OPENROUTER_API_BASE, model: 'jev-1.13' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', baseURL: '' }
];

/** Web search / extract templates. */
export const WEB_PROVIDER_PRESETS = [
  { id: 'tavily', name: 'Tavily', baseURL: '' },
  { id: 'brave', name: 'Brave', baseURL: '' },
  { id: 'firecrawl', name: 'Firecrawl', baseURL: '' }
];

const ALLOWED_PROTOCOLS = new Set(['openai-compatible', 'anthropic', 'auto']);

/**
 * Normalize base for uniqueness (strip trailing slash). Empty stays empty.
 * @param {string} baseURL
 */
export function normalizePresetBaseURL(baseURL) {
  return String(baseURL || '')
    .trim()
    .replace(/\/$/, '');
}

/**
 * Validate inference preset catalog shape (pure; for tests + boot asserts).
 * @param {InferenceProviderPreset[]} [presets]
 */
export function assertInferencePresetsValid(presets = PROVIDER_PRESETS) {
  const ids = new Set();
  const bases = new Set();
  for (const p of presets) {
    if (!p || typeof p !== 'object') throw new Error('preset must be an object');
    const id = String(p.id || '').trim();
    const name = String(p.name || '').trim();
    if (!id) throw new Error('preset missing id');
    if (!name) throw new Error(`preset ${id} missing name`);
    if (ids.has(id)) throw new Error(`duplicate preset id: ${id}`);
    ids.add(id);
    if (!ALLOWED_PROTOCOLS.has(p.protocol)) {
      throw new Error(`preset ${id} has invalid protocol: ${p.protocol}`);
    }
    const base = normalizePresetBaseURL(p.baseURL);
    if (id === 'openai-compatible') {
      if (base) throw new Error('openai-compatible preset must keep empty baseURL');
      continue;
    }
    if (!/^https?:\/\//i.test(base)) {
      throw new Error(`preset ${id} needs http(s) baseURL`);
    }
    const key = base.toLowerCase();
    if (bases.has(key)) throw new Error(`duplicate baseURL: ${base}`);
    bases.add(key);
  }
  return true;
}
