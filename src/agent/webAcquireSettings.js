/**
 * BYOK web acquire: search (Tavily default, Brave optional) + Firecrawl fetch.
 * Storage key browserbot_web_acquire. Model still only sees acquire search|fetch.
 */

export const WEB_ACQUIRE_STORAGE_KEY = 'browserbot_web_acquire';

export const SEARCH_PROVIDERS = [
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
    searchProvider: 'tavily',
    tavilyKey: '',
    tavilyNickname: '',
    tavilyBaseURL: 'https://api.tavily.com',
    braveKey: '',
    braveNickname: '',
    firecrawlKey: '',
    firecrawlNickname: '',
    firecrawlBaseURL: 'https://api.firecrawl.dev'
  };
}

export function webAcquireNicknameKey(kind) {
  if (kind === 'brave') return 'braveNickname';
  if (kind === 'firecrawl') return 'firecrawlNickname';
  return 'tavilyNickname';
}

export function webAcquireCardTitle(kind, settings, fallback) {
  const key = webAcquireNicknameKey(kind);
  const nick = typeof settings?.[key] === 'string' ? settings[key].trim() : '';
  return nick || fallback || kind;
}

function trimStr(v, fallback = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function normalizeWebAcquireSettings(raw = {}) {
  const d = defaultWebAcquireSettings();
  const o = raw && typeof raw === 'object' ? raw : {};
  const provider = String(o.searchProvider || d.searchProvider).toLowerCase();
  return {
    searchProvider: provider === 'brave' ? 'brave' : 'tavily',
    tavilyKey: trimStr(o.tavilyKey),
    tavilyNickname: trimStr(o.tavilyNickname),
    tavilyBaseURL: trimStr(o.tavilyBaseURL, d.tavilyBaseURL).replace(/\/$/, ''),
    braveKey: trimStr(o.braveKey),
    braveNickname: trimStr(o.braveNickname),
    firecrawlKey: trimStr(o.firecrawlKey),
    firecrawlNickname: trimStr(o.firecrawlNickname),
    firecrawlBaseURL: trimStr(o.firecrawlBaseURL, d.firecrawlBaseURL).replace(/\/$/, '')
  };
}

export function searchApiConfigured(settings) {
  const s = normalizeWebAcquireSettings(settings);
  if (s.searchProvider === 'brave' && s.braveKey) return true;
  if (s.tavilyKey) return true;
  return Boolean(s.firecrawlKey);
}

export function firecrawlConfigured(settings) {
  return Boolean(normalizeWebAcquireSettings(settings).firecrawlKey);
}

export async function loadWebAcquireSettings() {
  const empty = defaultWebAcquireSettings();
  try {
    if (typeof chrome === 'undefined' || !chrome?.storage?.local?.get) return empty;
    const bag = await chrome.storage.local.get(WEB_ACQUIRE_STORAGE_KEY);
    return normalizeWebAcquireSettings(bag?.[WEB_ACQUIRE_STORAGE_KEY]);
  } catch {
    return empty;
  }
}

/** GET credit-usage: v2 first, then v1. */
export function firecrawlCreditUsageUrls(baseURL) {
  const root = String(baseURL || 'https://api.firecrawl.dev').replace(/\/$/, '');
  return [`${root}/v2/team/credit-usage`, `${root}/v1/team/credit-usage`];
}

export function firecrawlAuthHeaders(apiKey) {
  return {
    Authorization: `Bearer ${String(apiKey || '').trim()}`,
    Accept: 'application/json'
  };
}

/**
 * Parse Firecrawl team credit-usage JSON.
 * @returns {{ ok: boolean, remaining: number|null, plan: number|null }}
 */
export function summarizeFirecrawlCreditUsage(json) {
  const data =
    json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
  if (!data || typeof data !== 'object') return { ok: false, remaining: null, plan: null };
  const remainingRaw = data.remainingCredits ?? data.remaining_credits;
  const planRaw = data.planCredits ?? data.plan_credits;
  const remaining = Number(remainingRaw);
  const plan = Number(planRaw);
  const hasRemaining = Number.isFinite(remaining);
  const failed = json && json.success === false;
  return {
    ok: !failed && hasRemaining,
    remaining: hasRemaining ? remaining : null,
    plan: Number.isFinite(plan) ? plan : null
  };
}

export function tavilySearchProbeUrl(baseURL) {
  const root = String(baseURL || 'https://api.tavily.com').replace(/\/$/, '');
  return `${root}/search`;
}

export function tavilySearchProbeBody(apiKey) {
  return {
    api_key: String(apiKey || '').trim(),
    query: 'ping',
    max_results: 1,
    search_depth: 'basic'
  };
}

export function braveSearchProbeUrl(baseURL) {
  const root = String(baseURL || 'https://api.search.brave.com').replace(/\/$/, '');
  return `${root}/res/v1/web/search?q=ping&count=1`;
}

export function braveSearchProbeHeaders(apiKey) {
  return {
    Accept: 'application/json',
    'X-Subscription-Token': String(apiKey || '').trim()
  };
}

export async function saveWebAcquireSettings(patch = {}) {
  const prev = await loadWebAcquireSettings();
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
  }
  return next;
}
