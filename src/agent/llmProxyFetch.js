/**
 * Shared LLM HTTPS proxy helpers for offscreen/sidepanel → SW `llm_proxy_fetch`.
 * No chrome.* / AI SDK imports — SW can static-import this file.
 */

const STRIP_HEADER = /^(user-agent|origin|referer|referrer|host|content-length|connection|keep-alive|accept-encoding|cookie|cookie2|sec-.*|proxy-.*)$/i;

export function resolveLlmFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.url === 'string' && input.url) return input.url;
    if (typeof input.href === 'string' && input.href) return input.href;
  }
  return String(input || '');
}

export function headerEntries(raw) {
  if (!raw) return [];
  if (typeof Headers !== 'undefined' && raw instanceof Headers) return [...raw.entries()];
  if (Array.isArray(raw)) return raw.map(([k, v]) => [k, v]);
  if (typeof raw === 'object') return Object.entries(raw);
  return [];
}

/** Drop headers that Chrome fetch (SW or document) may reject as unsafe. */
export function sanitizeLlmProxyHeaders(raw) {
  const out = {};
  for (const [key, value] of headerEntries(raw)) {
    const name = String(key || '');
    if (!name || STRIP_HEADER.test(name)) continue;
    if (name.toLowerCase() === 'x-paw-internal-no-retry') continue;
    if (value == null) continue;
    out[name] = String(value);
  }
  return out;
}

export async function serializeLlmProxyBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  try {
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  } catch {
    /* fall through */
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
  if (typeof body === 'object' && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(out);
  }
  if (typeof body === 'object' && typeof body.text === 'function') return body.text();
  return String(body);
}

export function isAllowedLlmProxyUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'Missing url' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Invalid url' };
  }
  const allowed =
    parsed.protocol === 'https:' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost';
  if (!allowed) return { ok: false, error: 'Blocked non-HTTPS LLM endpoint' };
  return { ok: true, url: parsed.href };
}

export function reconstructLlmProxyResponse(res) {
  const text =
    res?.text != null
      ? res.text
      : res?.json != null
        ? JSON.stringify(res.json)
        : '';
  const contentType =
    res?.contentType ||
    res?.headers?.['content-type'] ||
    res?.headers?.['Content-Type'] ||
    'application/json';
  return new Response(text, {
    status: res?.status || (res?.ok ? 200 : 500),
    statusText: res?.statusText || '',
    headers: { 'Content-Type': contentType }
  });
}

export function llmProxyFailure(directErr, proxyErr) {
  const proxyMsg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr || 'proxy failed');
  const err = new Error(`Background LLM proxy failed: ${proxyMsg}`);
  err.code = 'LLM_PROXY_FAILED';
  if (proxyErr != null) err.cause = proxyErr;
  if (directErr != null) err.directError = directErr;
  return err;
}

/**
 * Privileged SW/document fetch. Caller supplies fetchImpl in tests.
 * @param {{ url?: string, method?: string, headers?: object, body?: string|null }} request
 * @param {typeof fetch} [fetchImpl]
 */
export async function executeLlmProxyFetch(request, fetchImpl = fetch) {
  const allowed = isAllowedLlmProxyUrl(request?.url);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  const methodUpper = String(request?.method || 'POST').toUpperCase();
  const init = {
    method: methodUpper,
    headers: sanitizeLlmProxyHeaders(request?.headers || {}),
    credentials: 'omit'
  };
  if (request?.body != null && methodUpper !== 'GET' && methodUpper !== 'HEAD') {
    init.body = request.body;
  }
  const res = await fetchImpl(allowed.url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE / non-json */
  }
  const contentType =
    (typeof res.headers?.get === 'function' && res.headers.get('content-type')) ||
    (json != null ? 'application/json' : 'text/plain');
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText || '',
    text,
    json,
    contentType,
    headers: { 'content-type': contentType }
  };
}
