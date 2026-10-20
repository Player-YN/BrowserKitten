/**
 * acquire primitive — import external read-only information.
 * Writes `/work/sources/...` (legacy path). Session guest remaps `/work` → `/scratch`.
 * search: Parallel for fresh settings, or saved BYOK providers.
 * fetch: site-read scrape when configured, else anonymous public GET.
 * map / crawl: site-read API only (host-capped).
 */

import { assertPublicHttpUrl } from './netGuard.js';
import { runConfiguredSearch } from './webSearch.js';
import {
  scrapeFirecrawl,
  shouldTryFirecrawl,
  mapFirecrawl,
  crawlFirecrawl,
  CRAWL_MAX_PAGES
} from './webFetch.js';

export async function acquire(ctx, input = {}) {
  const action = String(input.action || (input.url ? 'fetch' : input.query ? 'search' : '')).toLowerCase();
  if (!ctx?.fs || typeof ctx.fs.writeFile !== 'function') return { ok: false, error: 'fs required' };
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch unavailable' };
  if (ctx.signal?.aborted) return { ok: false, error: 'aborted' };

  try {
    if (action === 'search') return await searchWeb(ctx, input, fetchImpl);
    if (action === 'fetch') return await fetchSource(ctx, input, fetchImpl);
    if (action === 'map') return await mapSite(ctx, input, fetchImpl);
    if (action === 'crawl') return await crawlSite(ctx, input, fetchImpl);
    return { ok: false, error: 'action must be search, fetch, map, or crawl' };
  } catch (error) {
    return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
  }
}

async function searchWeb(ctx, input, fetchImpl) {
  const query = String(input.query || '').trim();
  if (!query) {
    return { ok: false, action: 'search', code: 'MISSING_QUERY', error: 'search needs query' };
  }
  const limit = Math.max(1, Math.min(Number(input.limit) || 8, 20));
  const found = await runConfiguredSearch(ctx.webAcquire, {
    query,
    limit,
    fetchImpl,
    signal: ctx.signal,
    searchSessionId: ctx.searchSessionId
  });
  if (!found.ok) return found;
  if (!found.results?.length) {
    return { ok: false, action: 'search', error: 'search backend returned no results', provider: found.provider };
  }
  await ensureSourcesDir(ctx.fs);
  const path = `/work/sources/search_${Date.now().toString(36)}.json`;
  await ctx.fs.writeFile(path, JSON.stringify({ query, provider: found.provider, results: found.results }, null, 2));
  return {
    ok: true,
    action: 'search',
    query,
    provider: found.provider,
    path,
    results: found.results
  };
}

async function fetchSource(ctx, input, fetchImpl) {
  const url = String(input.url || '').trim();
  if (!url) {
    return { ok: false, action: 'fetch', code: 'MISSING_URL', error: 'fetch needs url' };
  }
  const gate = assertPublicHttpUrl(url);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, action: 'fetch' };
  const parsed = gate.url;
  const web = ctx.webAcquire || {};

  if (web.firecrawlKey && shouldTryFirecrawl(parsed.href)) {
    try {
      const scraped = await scrapeFirecrawl({
        url: parsed.href,
        apiKey: web.firecrawlKey,
        baseURL: web.firecrawlBaseURL,
        fetchImpl,
        signal: ctx.signal
      });
      await ensureSourcesDir(ctx.fs);
      const fileName = sanitizeName(input.filename || `${deriveName(parsed, 'text/markdown').replace(/\.html?$/i, '')}.md`);
      const path = `/work/sources/${Date.now().toString(36)}_${fileName}`;
      const bytes = new TextEncoder().encode(scraped.markdown);
      await ctx.fs.writeFile(path, bytes);
      return {
        ok: true,
        action: 'fetch',
        url: parsed.href,
        path,
        mediaType: 'text/markdown',
        bytes: bytes.byteLength,
        preview: scraped.preview,
        source: 'firecrawl'
      };
    } catch {
      /* fall through to anonymous GET */
    }
  }

  const response = await fetchImpl(parsed.href, { credentials: 'omit', signal: ctx.signal });
  if (!response.ok) return { ok: false, action: 'fetch', error: `HTTP ${response.status}`, url: parsed.href };
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const bytes = new Uint8Array(await response.arrayBuffer());
  const fileName = sanitizeName(input.filename || deriveName(parsed, contentType));
  await ensureSourcesDir(ctx.fs);
  const path = `/work/sources/${Date.now().toString(36)}_${fileName}`;
  await ctx.fs.writeFile(path, bytes);
  const textLike = /^text\/|json|xml|javascript|markdown/i.test(contentType);
  const preview = textLike ? new TextDecoder().decode(bytes.slice(0, 6000)) : null;
  return {
    ok: true,
    action: 'fetch',
    url: parsed.href,
    path,
    mediaType: contentType,
    bytes: bytes.byteLength,
    preview,
    source: 'http'
  };
}

function siteReadKey(ctx) {
  const web = ctx.webAcquire || {};
  return web.firecrawlKey ? web : null;
}

async function mapSite(ctx, input, fetchImpl) {
  const url = String(input.url || '').trim();
  if (!url) {
    return { ok: false, action: 'map', code: 'MISSING_URL', error: 'map needs url' };
  }
  const gate = assertPublicHttpUrl(url);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, action: 'map' };
  const web = siteReadKey(ctx);
  if (!web) {
    return {
      ok: false,
      action: 'map',
      code: 'SITE_READ_NOT_CONFIGURED',
      error: 'Site-read API not set in Settings'
    };
  }
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 100));
  const links = await mapFirecrawl({
    url: gate.url.href,
    limit,
    query: String(input.query || '').trim() || undefined,
    apiKey: web.firecrawlKey,
    baseURL: web.firecrawlBaseURL,
    fetchImpl,
    signal: ctx.signal
  });
  await ensureSourcesDir(ctx.fs);
  const path = `/work/sources/map_${Date.now().toString(36)}.json`;
  await ctx.fs.writeFile(path, JSON.stringify({ url: gate.url.href, links }, null, 2));
  return {
    ok: true,
    action: 'map',
    url: gate.url.href,
    path,
    links,
    count: links.length
  };
}

async function crawlSite(ctx, input, fetchImpl) {
  const url = String(input.url || '').trim();
  if (!url) {
    return { ok: false, action: 'crawl', code: 'MISSING_URL', error: 'crawl needs url' };
  }
  const gate = assertPublicHttpUrl(url);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, action: 'crawl' };
  const web = siteReadKey(ctx);
  if (!web) {
    return {
      ok: false,
      action: 'crawl',
      code: 'SITE_READ_NOT_CONFIGURED',
      error: 'Site-read API not set in Settings'
    };
  }
  const crawled = await crawlFirecrawl({
    url: gate.url.href,
    limit: input.limit,
    apiKey: web.firecrawlKey,
    baseURL: web.firecrawlBaseURL,
    fetchImpl,
    signal: ctx.signal
  });
  await ensureSourcesDir(ctx.fs);
  const path = `/work/sources/crawl_${Date.now().toString(36)}.json`;
  const slim = (crawled.pages || []).map((p) => ({
    url: p.url,
    title: p.title,
    preview: p.preview,
    markdown: p.markdown
  }));
  await ctx.fs.writeFile(path, JSON.stringify({ url: gate.url.href, pages: slim }, null, 2));
  return {
    ok: true,
    action: 'crawl',
    url: gate.url.href,
    path,
    pages: slim.map((p) => ({ url: p.url, title: p.title, preview: p.preview })),
    count: slim.length,
    cap: CRAWL_MAX_PAGES
  };
}

export function createAcquireTool(ctx) {
  return {
    name: 'acquire',
    description:
      'Bring unknown public web into the guest (search / fetch / map / crawl). Anonymous — no user cookies. Session guest sees /scratch/sources; this primitive writes /work/sources and the host remaps. Not for an already-open tab or a login/cookie/captcha/IP-bound URL: that is sys.fetch as:"page". Never mutates Selection Groups.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'fetch', 'map', 'crawl'] },
        query: {
          type: 'string',
          description: 'Required for search. Optional for map (in-site filter). Do not use for fetch or crawl.'
        },
        url: {
          type: 'string',
          description: 'Required for fetch, map, and crawl. One public http(s) URL. Do not pass for search.'
        },
        filename: { type: 'string' },
        limit: { type: 'number', description: 'Optional search/map cap. Crawl is host-capped to a few pages.' }
      },
      required: ['action']
    },
    execute: (input) => acquire(ctx, input),
    toModelOutput({ output } = {}) {
      const o = output || {};
      return { type: 'json', value: { ...o, preview: clip(o.preview, 4000), results: Array.isArray(o.results) ? o.results.slice(0, 20) : o.results } };
    }
  };
}

function deriveName(url, contentType) {
  const base = url.pathname.split('/').filter(Boolean).at(-1);
  if (base && /\.[a-z0-9]{1,8}$/i.test(base)) return base;
  if (/html/i.test(contentType)) return 'source.html';
  if (/json/i.test(contentType)) return 'source.json';
  if (/text/i.test(contentType)) return 'source.txt';
  return 'source.bin';
}
function sanitizeName(name) { return String(name || 'source.bin').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120); }
async function ensureSourcesDir(fs) { try { await fs.mkdir('/work/sources'); } catch {} }
function clip(value, length) { const text = value == null ? null : String(value); return text && text.length > length ? text.slice(0, length) + '…' : text; }
