/**
 * Optional Firecrawl scrape for acquire fetch (public pages → markdown).
 * Binary URLs and missing keys fall through to the caller’s raw GET.
 */

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|zip|pdf|woff2?|ttf|mp3|wav|m4a|aac|ogg|oga|flac|mp4|mpeg|mpga|webm|mov|gz|tar|xlsx|pptx|docx)(\?|$)/i;

export function shouldTryFirecrawl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !BINARY_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function markdownFromFirecrawl(json) {
  const data = json?.data || json;
  const md = data?.markdown || data?.content || '';
  return String(md || '').trim();
}

export const CRAWL_MAX_PAGES = 8;
const CRAWL_POLL_MS = 250;
const CRAWL_TIMEOUT_MS = 90_000;

function firecrawlRoot(baseURL) {
  return String(baseURL || 'https://api.firecrawl.dev').replace(/\/$/, '');
}

function firecrawlHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw new Error('aborted');
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function scrapeFirecrawl({ url, apiKey, baseURL, fetchImpl, signal }) {
  const root = firecrawlRoot(baseURL);
  const attempts = [`${root}/v2/scrape`, `${root}/v1/scrape`];
  let lastErr = 'Firecrawl scrape failed';
  for (const endpoint of attempts) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: firecrawlHeaders(apiKey),
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal
    });
    if (res.status === 404) {
      lastErr = `Firecrawl HTTP 404 at ${endpoint}`;
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firecrawl HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    }
    const json = await res.json();
    const markdown = markdownFromFirecrawl(json);
    if (!markdown) throw new Error('Firecrawl returned empty markdown');
    return {
      markdown,
      preview: clip(markdown, 6000),
      mediaType: 'text/markdown'
    };
  }
  throw new Error(lastErr);
}

function normalizeMapLinks(json, limit) {
  const raw = Array.isArray(json?.links)
    ? json.links
    : Array.isArray(json?.data)
      ? json.data
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= limit) break;
    const url = String(typeof item === 'string' ? item : item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: clip(item?.title || url, 200),
      snippet: clip(item?.description || item?.snippet || '', 400)
    });
  }
  return out;
}

export async function mapFirecrawl({ url, limit, query, apiKey, baseURL, fetchImpl, signal }) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 100));
  const root = firecrawlRoot(baseURL);
  const attempts = [`${root}/v2/map`, `${root}/v1/map`];
  let lastErr = 'Site map failed';
  const body = { url, limit: cap };
  if (query) body.search = String(query);
  for (const endpoint of attempts) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: firecrawlHeaders(apiKey),
      body: JSON.stringify(body),
      signal
    });
    if (res.status === 404) {
      lastErr = `Site map HTTP 404 at ${endpoint}`;
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Site map HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    }
    const json = await res.json();
    return normalizeMapLinks(json, cap);
  }
  throw new Error(lastErr);
}

function crawlPagesFromStatus(json, cap) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const pages = [];
  for (const row of rows) {
    if (pages.length >= cap) break;
    const markdown = String(row?.markdown || row?.content || '').trim();
    const sourceURL = String(row?.metadata?.sourceURL || row?.url || '').trim();
    if (!markdown && !sourceURL) continue;
    pages.push({
      url: sourceURL,
      title: clip(row?.metadata?.title || sourceURL, 200),
      markdown,
      preview: clip(markdown, 2000)
    });
  }
  return pages;
}

export async function crawlFirecrawl({ url, limit, apiKey, baseURL, fetchImpl, signal }) {
  const cap = Math.max(1, Math.min(Number(limit) || CRAWL_MAX_PAGES, CRAWL_MAX_PAGES));
  const root = firecrawlRoot(baseURL);
  const startAttempts = [`${root}/v2/crawl`, `${root}/v1/crawl`];
  let started = null;
  let lastErr = 'Site crawl failed';
  for (const endpoint of startAttempts) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: firecrawlHeaders(apiKey),
      body: JSON.stringify({
        url,
        limit: cap,
        scrapeOptions: { formats: ['markdown'] },
        scrape_options: { formats: ['markdown'] }
      }),
      signal
    });
    if (res.status === 404) {
      lastErr = `Site crawl HTTP 404 at ${endpoint}`;
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Site crawl HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    }
    started = { json: await res.json(), endpoint };
    break;
  }
  if (!started) throw new Error(lastErr);
  const jobId = started.json?.id || started.json?.jobId || started.json?.job_id;
  if (!jobId) {
    const immediate = crawlPagesFromStatus(started.json, cap);
    if (immediate.length) return { pages: immediate, status: 'completed' };
    throw new Error('Site crawl returned no job id');
  }
  const statusUrls = [`${root}/v2/crawl/${jobId}`, `${root}/v1/crawl/${jobId}`];
  const t0 = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    if (Date.now() - t0 > CRAWL_TIMEOUT_MS) throw new Error('Site crawl timed out');
    let json = null;
    for (const statusUrl of statusUrls) {
      const res = await fetchImpl(statusUrl, {
        method: 'GET',
        headers: firecrawlHeaders(apiKey),
        signal
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Site crawl status HTTP ${res.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
      }
      json = await res.json();
      break;
    }
    if (!json) throw new Error('Site crawl status not found');
    const status = String(json.status || json.data?.status || '').toLowerCase();
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      throw new Error('Site crawl failed');
    }
    if (status === 'completed' || status === 'done') {
      return { pages: crawlPagesFromStatus(json, cap), status: 'completed' };
    }
    await sleep(CRAWL_POLL_MS, signal);
  }
}
