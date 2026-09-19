import { findCatalogModel, loadCachedModelsForBase, normalizeModelsBaseURL, parseContextWindow, resolveContextWindow } from './modelCatalog.js';
import { loadLlmSettings } from './llm.js';
import {
  CONTEXT_WINDOW_AUTO_KEY,
  CONTEXT_WINDOW_CACHE_KEY,
  MAX_CONTEXT_WINDOW_EVIDENCE,
  contextWindowCacheKey,
  contextWindowEvidenceDue,
  contextWindowStorageGet,
  contextWindowStorageSet,
  normalizeContextWindowEvidence,
  normalizeContextWindowOverrides
} from './contextWindowStore.js';

export const PROBE_MAX_TOKENS = 10_000_000;
export const PROBE_FIRST_BYTE_MS = 2000;
export const PROBE_TOTAL_MS = 8000;

const CONTEXT_PHRASES = [
  /maximum context length is\s+(\d{4,})/i,
  /(?:this model's\s+)?maximum context length(?:\s+is|\s+of)?\s*[:=]?\s*(\d{4,})/i,
  /context window(?:\s+is|\s+of)?\s*[:=]?\s*(\d{4,})/i,
  /context length(?:\s+is|\s+of)?\s*[:=]?\s*(\d{4,})/i,
  /context[_\s-]?length["'\s:=]+(\d{4,})/i,
  /context[_\s-]?window["'\s:=]+(\d{4,})/i,
  /(?:exceeds?|over)\s+the\s+context\s+window\s+of\s+(\d{4,})/i,
  /上下文长度[为是:：\s]*(\d{4,})/
];

const MAX_TOKENS_RANGE = /range of(?:\s+input)?\s+max[_\s-]?tokens\s*\[\s*\d+\s*,\s*\d+\s*\]/i;
const MAX_TOKENS_ALLOWED = /max[_\s-]?tokens\b[^.\n]{0,64}(?:max(?:imum)?(?:\s+allowed)?|allowed|must be|<=|less than)\s*\d+/i;
const HEADER_ADOPT = /^(?:x-)?context(?:-(?:length|window))?$/i;

function adoptWindow(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 2048 || value >= PROBE_MAX_TOKENS) return null;
  return Math.round(value);
}

function nearbyIsMaxTokensCap(source, index, matched) {
  const start = Math.max(0, index - 72);
  const end = Math.min(source.length, index + matched.length + 48);
  const around = source.slice(start, end);
  if (MAX_TOKENS_RANGE.test(around) || MAX_TOKENS_ALLOWED.test(around)) return true;
  return /max[_\s-]?tokens/i.test(around) && !/context/i.test(around) && !/上下文/.test(around);
}

/** Parse ONLY a context window. Never an output cap. */
export function extractContextWindowFromText(text) {
  const s = String(text || '');
  if (!s) return null;
  if (/\busage\.?prompt_tokens\b|\bprompt_tokens\b\s*[:=]\s*\d+/i.test(s) && !/context/i.test(s) && !/上下文/.test(s)) {
    return null;
  }
  for (const re of CONTEXT_PHRASES) {
    re.lastIndex = 0;
    const match = re.exec(s);
    if (!match) continue;
    if (nearbyIsMaxTokensCap(s, match.index, match[0])) continue;
    const n = adoptWindow(match[1]);
    if (n) return n;
  }
  return null;
}

export function extractContextWindowFromHeaders(headers) {
  if (!headers) return null;
  const pairs = [];
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, name) => pairs.push([name, value]));
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) pairs.push([name, value]);
  }
  for (const [name, value] of pairs) {
    const key = String(name || '').toLowerCase();
    if (key.startsWith('x-ratelimit')) continue;
    if (!HEADER_ADOPT.test(key)) continue;
    const n = adoptWindow(String(value ?? '').replace(/[^\d.]/g, ''));
    if (n) return n;
  }
  return null;
}

export function extractContextWindowFromBody(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {any} */ (raw);
  const objects = [o, o.error, o.usage, o.model_info, o.top_provider, o.metadata, o.error?.metadata];
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    const n = parseContextWindow(obj);
    if (n) return n;
  }
  const texts = [o.error?.message, o.message, typeof o.error === 'string' ? o.error : ''];
  for (const text of texts) {
    const n = extractContextWindowFromText(text);
    if (n) return n;
  }
  return null;
}

export function extractContextWindowFromProbe({ headers, body, text } = {}) {
  const fromHeaders = extractContextWindowFromHeaders(headers);
  if (fromHeaders) return fromHeaders;
  if (body && typeof body === 'object') {
    const fromBody = extractContextWindowFromBody(body);
    if (fromBody) return fromBody;
  }
  const raw = String(text || '');
  if (raw) {
    const fromText = extractContextWindowFromText(raw);
    if (fromText) return fromText;
    try {
      const parsed = JSON.parse(raw);
      const fromParsed = extractContextWindowFromBody(parsed);
      if (fromParsed) return fromParsed;
    } catch { /* SSE or HTML */ }
  }
  return null;
}

export function streamHasContentToken(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const json = JSON.parse(raw);
      const delta = json.choices?.[0]?.delta || json.choices?.[0]?.message || {};
      const content = delta.content;
      if (typeof content === 'string' && content.length) return true;
      if (Array.isArray(content) && content.some((part) => part?.text || part?.content)) return true;
    } catch { /* keep scanning */ }
  }
  return false;
}

function extractFromSse(text) {
  const fromText = extractContextWindowFromText(text);
  if (fromText) return fromText;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const n = extractContextWindowFromBody(JSON.parse(raw));
      if (n) return n;
    } catch { /* ignore */ }
  }
  return null;
}

export function contextWindowChatCompletionsUrl(baseURL) {
  return `${normalizeModelsBaseURL(baseURL)}/chat/completions`;
}

export function contextWindowProbeBody(model) {
  return {
    model: String(model || '').trim(),
    messages: [{ role: 'user', content: '.' }],
    max_tokens: PROBE_MAX_TOKENS,
    stream: true
  };
}

export function contextWindowProbeHeaders(settings = {}) {
  const headers = {
    Authorization: `Bearer ${String(settings.apiKey || '').trim()}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  };
  const base = normalizeModelsBaseURL(settings.apiBase || '');
  if (base.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://pagewand.local';
    headers['X-Title'] = 'PageWand';
  }
  return headers;
}

function kindFromStatus(status, firstToken) {
  if (status === 401 || status === 403 || status === 404 || status === 405 || status === 429) return `HTTP_${status}`;
  if (status >= 500) return 'HTTP_5xx';
  if (status === 200) return 'STREAM_STARTED';
  if (status) return `HTTP_${status}`;
  return firstToken ? 'STREAM_STARTED' : 'CHECK_UNAVAILABLE';
}

async function defaultProbeFetch(input, init) {
  if (typeof globalThis.chrome?.runtime?.id !== 'string') {
    throw Object.assign(new Error('CHECK_UNAVAILABLE'), { code: 'CHECK_UNAVAILABLE' });
  }
  return fetch(input, init);
}

async function readProbeResponse(res, signal) {
  const headers = res.headers;
  const headerWindow = extractContextWindowFromHeaders(headers);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-json */ }
    return {
      status: res.status,
      window: headerWindow || extractContextWindowFromProbe({ headers, body, text }),
      firstToken: false
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstToken = false;
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const found = headerWindow || extractFromSse(buf);
      firstToken = streamHasContentToken(buf);
      if (found || firstToken) {
        return { status: res.status, window: found || null, firstToken };
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  let body = null;
  try { body = JSON.parse(buf); } catch { /* SSE */ }
  return {
    status: res.status,
    window: headerWindow || extractContextWindowFromProbe({ headers, body, text: buf }),
    firstToken
  };
}

/**
 * Dedicated offscreen POST {base}/chat/completions. Not ToolLoopAgent / sendMessage.
 * Abort on first token, ~2s first-byte, or ~8s total. A 200 stream is unknown.
 */
export async function runContextWindowProbe({
  settings,
  signal,
  fetchImpl,
  firstByteMs = PROBE_FIRST_BYTE_MS,
  totalMs = PROBE_TOTAL_MS
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : defaultProbeFetch;
  const url = contextWindowChatCompletionsUrl(settings?.apiBase);
  const ac = new AbortController();
  const abort = (reason) => {
    try { ac.abort(reason); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) abort(signal.reason);
    else signal.addEventListener('abort', () => abort(signal.reason), { once: true });
  }
  let firstByteTimer = setTimeout(() => abort('FIRST_BYTE_TIMEOUT'), firstByteMs);
  const totalTimer = setTimeout(() => abort('CHECK_TIMEOUT'), totalMs);
  let parsed = null;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: contextWindowProbeHeaders(settings),
      body: JSON.stringify(contextWindowProbeBody(settings?.model)),
      signal: ac.signal
    });
    clearTimeout(firstByteTimer);
    firstByteTimer = null;
    parsed = await readProbeResponse(res, ac.signal);
  } catch (error) {
    if (parsed?.window) {
      return { window: parsed.window, source: 'measured', kind: 'measure_chat' };
    }
    if (parsed) {
      return { window: null, source: 'unknown', kind: kindFromStatus(parsed.status, parsed.firstToken) };
    }
    const aborted = ac.signal.aborted || signal?.aborted;
    const reason = String(ac.signal.reason || error?.message || '');
    if (aborted && /FIRST_BYTE/i.test(reason)) {
      return { window: null, source: 'unknown', kind: 'FIRST_BYTE_TIMEOUT' };
    }
    if (aborted) return { window: null, source: 'unknown', kind: 'CHECK_TIMEOUT' };
    const status = Number(error?.status || error?.statusCode) || 0;
    return { window: null, source: 'unknown', kind: status ? kindFromStatus(status, false) : (error?.code || 'CHECK_UNAVAILABLE') };
  } finally {
    clearTimeout(firstByteTimer);
    clearTimeout(totalTimer);
  }

  if (parsed?.window) return { window: parsed.window, source: 'measured', kind: 'measure_chat' };
  return {
    window: null,
    source: 'unknown',
    kind: kindFromStatus(parsed?.status, parsed?.firstToken)
  };
}

export function contextWindowSource(modelId, entry, record, override) {
  if (Number(override) >= 2048) return 'user';
  if (Number(record?.window) >= 2048) return 'measured';
  if (Number(entry?.contextWindow) >= 2048) return 'catalog';
  if (resolveContextWindow(modelId, entry, { allowDefault: false, evidence: record, override })) return 'family';
  return 'unknown';
}

/** One manager per offscreen runtime. Ordinary sends only kick request(); they never await it. */
export class ContextWindowChecks {
  constructor({
    getSettings = loadLlmSettings,
    getModels = loadCachedModelsForBase,
    get = contextWindowStorageGet,
    set = contextWindowStorageSet,
    run = runContextWindowProbe,
    now = Date.now,
    firstByteMs = PROBE_FIRST_BYTE_MS,
    totalMs = PROBE_TOTAL_MS
  } = {}) {
    Object.assign(this, { getSettings, getModels, get, set, run, now, firstByteMs, totalMs });
    this.tail = Promise.resolve();
    this.writes = Promise.resolve();
    this.job = null;
    this.sequence = 0;
  }

  identify(settings) {
    return { key: contextWindowCacheKey(settings.apiBase, settings.model), settings };
  }

  overrideFor(settings) {
    const map = normalizeContextWindowOverrides(settings?.contextWindowOverrides);
    return map[contextWindowCacheKey(settings.apiBase, settings.model)];
  }

  async read(settings, models) {
    const { key } = this.identify(settings);
    const saved = await this.get([CONTEXT_WINDOW_CACHE_KEY]);
    const record = normalizeContextWindowEvidence(saved[CONTEXT_WINDOW_CACHE_KEY]?.[key]);
    const entry = findCatalogModel(models || [], settings.model);
    const override = this.overrideFor(settings);
    return {
      key,
      record,
      entry,
      override,
      window: resolveContextWindow(settings.model, entry, { evidence: record, override, allowDefault: false })
    };
  }

  async update(key, record) {
    const write = this.writes.then(async () => {
      const data = await this.get([CONTEXT_WINDOW_CACHE_KEY]);
      const cache = { ...(data[CONTEXT_WINDOW_CACHE_KEY] || {}) };
      cache[key] = normalizeContextWindowEvidence(record) || {
        window: null,
        source: 'unknown',
        kind: String(record?.kind || 'unknown'),
        checkedAt: this.now()
      };
      const entries = Object.entries(cache).sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0));
      await this.set({ [CONTEXT_WINDOW_CACHE_KEY]: Object.fromEntries(entries.slice(0, MAX_CONTEXT_WINDOW_EVIDENCE)) });
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async status() {
    const settings = await this.getSettings();
    const models = (await this.getModels(settings.apiBase)).models || [];
    const result = await this.read(settings, models);
    const prefs = await this.get([CONTEXT_WINDOW_AUTO_KEY]);
    return {
      providerId: settings.providerId,
      model: settings.model,
      base: settings.apiBase,
      window: result.window,
      catalogWindow: Number(result.entry?.contextWindow) >= 2048 ? Math.round(Number(result.entry.contextWindow)) : null,
      evidence: result.record,
      source: contextWindowSource(settings.model, result.entry, result.record, result.override),
      autoCheck: prefs[CONTEXT_WINDOW_AUTO_KEY] !== false,
      checking: this.job?.key === result.key && !this.job.done
    };
  }

  async request({ force = false } = {}) {
    const seq = ++this.sequence;
    const settings = await this.getSettings();
    const models = (await this.getModels(settings.apiBase)).models || [];
    const { key, entry } = await this.read(settings, models);
    const prefs = await this.get([CONTEXT_WINDOW_AUTO_KEY]);
    if (seq !== this.sequence) return { queued: false };
    if (!settings.apiKey || (!force && prefs[CONTEXT_WINDOW_AUTO_KEY] === false)) {
      this.job?.controller.abort();
      return { queued: false };
    }
    if (Number(entry?.contextWindow) >= 2048) return { queued: false, reason: 'catalog' };
    if (this.overrideFor(settings)) return { queued: false, reason: 'user' };
    if (this.job?.key === key && !this.job.done && !this.job.controller.signal.aborted) return { queued: true };
    this.job?.controller.abort();
    const job = { key, controller: new AbortController(), done: false };
    this.job = job;
    job.promise = this.tail
      .then(() => this.perform(job, settings, models, force))
      .catch(() => {})
      .finally(() => { job.done = true; });
    this.tail = job.promise;
    return { queued: true };
  }

  async stillCurrent(job) {
    if (job.controller.signal.aborted) return false;
    const settings = await this.getSettings();
    return this.identify(settings).key === job.key;
  }

  async perform(job, settings, models, force) {
    if (!(await this.stillCurrent(job))) return;
    const latestModels = (await this.getModels(settings.apiBase)).models || models;
    const { key, record, entry } = await this.read(settings, latestModels);
    if (Number(entry?.contextWindow) >= 2048) return;
    if (this.overrideFor(settings)) return;
    if (!force && !contextWindowEvidenceDue(record, this.now())) return;
    await this.update(key, { window: null, source: 'unknown', kind: 'CHECK_INTERRUPTED', checkedAt: this.now() });
    const controller = new AbortController();
    const abort = () => controller.abort(job.controller.signal.reason);
    job.controller.signal.addEventListener('abort', abort, { once: true });
    if (job.controller.signal.aborted) abort();
    let result;
    try {
      controller.signal.throwIfAborted?.();
      result = await this.run({
        settings,
        signal: controller.signal,
        firstByteMs: this.firstByteMs,
        totalMs: this.totalMs
      });
    } catch (error) {
      const status = Number(error?.status || error?.statusCode) || 0;
      result = {
        window: null,
        source: 'unknown',
        kind: status ? kindFromStatus(status, false) : (controller.signal.aborted ? 'CHECK_TIMEOUT' : 'CHECK_UNAVAILABLE')
      };
    } finally {
      job.controller.signal.removeEventListener('abort', abort);
    }
    if (!(await this.stillCurrent(job))) return;
    await this.update(key, { ...result, checkedAt: this.now() });
  }
}
