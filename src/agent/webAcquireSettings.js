/**
 * Public web acquire: keyless Parallel search + saved BYOK providers / Firecrawl fetch.
 * Storage key pagewand_web_acquire. Model still only sees acquire search|fetch.
 */

export const WEB_ACQUIRE_STORAGE_KEY = 'pagewand_web_acquire';

export const SEARCH_PROVIDERS = [
  {
    id: 'parallel',
    name: 'Parallel (no key)',
    baseURL: 'https://search.parallel.ai/mcp',
    keyPlaceholder: ''
  },
  {
    id: 'tavily',
    name: 'Tavily',
    baseURL: 'https://api.tavily.com',
    keyPlaceholder: 'tvly-...'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    baseURL: 'https://api.search.brave.com',
    keyPlaceholder: 'BSA...'
  }
];

export function defaultWebAcquireSettings() {
  return {
    searchProvider: 'parallel',
    tavilyKey: '',
    tavilyBaseURL: 'https://api.tavily.com',
    braveKey: '',
    firecrawlKey: '',
    firecrawlBaseURL: 'https://api.firecrawl.dev'
  };
}

function trimStr(v, fallback = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function normalizeWebAcquireSettings(raw = {}) {
  const d = defaultWebAcquireSettings();
  const o = raw && typeof raw === 'object' ? raw : {};
  // Old stored settings without a provider can still contain intentional keys.
  const legacy = o.tavilyKey || o.firecrawlKey ? 'tavily' : o.braveKey ? 'brave' : d.searchProvider;
  const provider = String(o.searchProvider || legacy).toLowerCase();
  return {
    searchProvider: ['parallel', 'tavily', 'brave', 'disabled'].includes(provider) ? provider : 'disabled',
    tavilyKey: trimStr(o.tavilyKey),
    tavilyBaseURL: trimStr(o.tavilyBaseURL, d.tavilyBaseURL).replace(/\/$/, ''),
    braveKey: trimStr(o.braveKey),
    firecrawlKey: trimStr(o.firecrawlKey),
    firecrawlBaseURL: trimStr(o.firecrawlBaseURL, d.firecrawlBaseURL).replace(/\/$/, '')
  };
}

export function searchApiConfigured(settings) {
  const s = normalizeWebAcquireSettings(settings);
  if (s.searchProvider === 'disabled') return false;
  if (s.searchProvider === 'parallel') return true;
  if (s.searchProvider === 'brave' && s.braveKey) return true;
  if (s.tavilyKey) return true;
  return Boolean(s.firecrawlKey);
}

export function firecrawlConfigured(settings) {
  return Boolean(normalizeWebAcquireSettings(settings).firecrawlKey);
}

async function readWebAcquireSettings() {
  if (typeof chrome === 'undefined') return defaultWebAcquireSettings();
  let bag;
  if (chrome.storage?.local?.get) {
    bag = await chrome.storage.local.get(WEB_ACQUIRE_STORAGE_KEY);
  } else if (chrome.runtime?.sendMessage) {
    // Offscreen has chrome.runtime, but no chrome.storage. Use the existing SW bridge.
    const response = await chrome.runtime.sendMessage({
      target: 'pawwork-background', action: 'storage_local_get', keys: [WEB_ACQUIRE_STORAGE_KEY]
    });
    if (!response?.ok) throw new Error(response?.error || 'Web search settings unavailable');
    bag = response.result;
  }
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) throw new Error('Web search settings unavailable');
  return normalizeWebAcquireSettings(bag[WEB_ACQUIRE_STORAGE_KEY]);
}

export async function loadWebAcquireSettings() {
  try {
    return await readWebAcquireSettings();
  } catch {
    // Unreadable settings might contain Search off or an intentional provider.
    return normalizeWebAcquireSettings({ searchProvider: 'disabled' });
  }
}

export async function saveWebAcquireSettings(patch = {}) {
  const prev = await readWebAcquireSettings();
  const take = (key) =>
    Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : prev[key];
  const next = normalizeWebAcquireSettings({
    ...prev,
    ...patch,
    tavilyKey: take('tavilyKey'),
    braveKey: take('braveKey'),
    firecrawlKey: take('firecrawlKey')
  });
  if (typeof chrome !== 'undefined' && chrome?.storage?.local?.set) {
    await chrome.storage.local.set({ [WEB_ACQUIRE_STORAGE_KEY]: next });
  } else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const response = await chrome.runtime.sendMessage({
      target: 'pawwork-background', action: 'storage_local_set', values: { [WEB_ACQUIRE_STORAGE_KEY]: next }
    });
    if (!response?.ok) throw new Error(response?.error || 'Web search settings could not be saved');
  }
  return next;
}
