/**
 * Public-web search adapters. Host maps settings → one provider.
 * Output is always { results: [{ title, url, snippet, content }] }.
 */

import { normalizeWebAcquireSettings } from '../../webAcquireSettings.js';
import { searchParallel } from './parallelSearch.js';

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function normalizeHits(list, limit) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    if (out.length >= limit) break;
    const url = String(raw?.url || raw?.link || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: clip(raw.title || raw.name || url, 200),
      url,
      snippet: clip(raw.snippet || raw.description || raw.content || '', 500),
      content: raw.content ? clip(raw.content, 4000) : undefined
    });
  }
  return out;
}

export async function searchTavily({ query, limit, apiKey, baseURL, fetchImpl, signal }) {
  const root = String(baseURL || 'https://api.tavily.com').replace(/\/$/, '');
  const res = await fetchImpl(`${root}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: limit,
      include_answer: false
    }),
    signal
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
  }
  const json = await res.json();
  return normalizeHits(json?.results, limit);
}

export async function searchBrave({ query, limit, apiKey, fetchImpl, signal }) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    },
    signal
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brave HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
  }
  const json = await res.json();
  return normalizeHits(json?.web?.results, limit);
}

export async function searchFirecrawl({ query, limit, apiKey, baseURL, fetchImpl, signal }) {
  const root = String(baseURL || 'https://api.firecrawl.dev').replace(/\/$/, '');
  const attempts = [`${root}/v2/search`, `${root}/v1/search`];
  let lastErr = 'Search backend failed';
  for (const endpoint of attempts) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, limit }),
      signal
    });
    if (res.status === 404) {
      lastErr = `Search HTTP 404 at ${endpoint}`;
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Search HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    }
    const json = await res.json();
    const web = Array.isArray(json?.data?.web)
      ? json.data.web
      : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.web)
          ? json.web
          : [];
    return normalizeHits(web, limit);
  }
  throw new Error(lastErr);
}

export async function runConfiguredSearch(settings, { query, limit, fetchImpl, signal, searchSessionId }) {
  settings = normalizeWebAcquireSettings(settings);
  if (settings.searchProvider === 'disabled') {
    return { ok: false, action: 'search', code: 'SEARCH_DISABLED', error: 'Public-web search is disabled' };
  }
  if (settings.searchProvider === 'parallel') {
    const hits = await searchParallel({ query, fetchImpl, signal, sessionId: searchSessionId });
    return { ok: true, provider: 'parallel', results: normalizeHits(hits, limit) };
  }
  const wantBrave = settings?.searchProvider === 'brave';
  if (wantBrave && settings?.braveKey) {
    const results = await searchBrave({
      query,
      limit,
      apiKey: settings.braveKey,
      fetchImpl,
      signal
    });
    return { ok: true, provider: 'brave', results };
  }
  if (settings?.tavilyKey) {
    const results = await searchTavily({
      query,
      limit,
      apiKey: settings.tavilyKey,
      baseURL: settings.tavilyBaseURL,
      fetchImpl,
      signal
    });
    return { ok: true, provider: 'tavily', results };
  }
  if (settings?.firecrawlKey) {
    const results = await searchFirecrawl({
      query,
      limit,
      apiKey: settings.firecrawlKey,
      baseURL: settings.firecrawlBaseURL,
      fetchImpl,
      signal
    });
    return { ok: true, provider: 'firecrawl', results };
  }
  return {
    ok: false,
    action: 'search',
    code: 'SEARCH_NOT_CONFIGURED',
    error: 'Search API key not set'
  };
}
