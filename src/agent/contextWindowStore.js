import { normalizeModelsBaseURL } from './modelCatalog.js';

/** Configuration-scoped evidence. No credentials or provider response bodies are stored. */
export const CONTEXT_WINDOW_CACHE_KEY = 'pagewand_context_window_evidence_v1';
export const CONTEXT_WINDOW_AUTO_KEY = 'pagewand_context_window_auto_check';
export const MAX_CONTEXT_WINDOW_EVIDENCE = 100;
export const DAY = 86400000;

/**
 * Same grain as mediaModelKey: exact normalized base + exact model id.
 * @param {string} [base]
 * @param {string} [model]
 */
export function contextWindowCacheKey(base, model) {
  return `${normalizeModelsBaseURL(base)}\n${String(model || '').trim()}`;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
export function normalizeContextWindowOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!String(key).includes('\n')) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 2048 && n < 10_000_000) out[key] = Math.round(n);
  }
  return out;
}

export async function contextWindowStorageGet(keys) {
  if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(keys)) || {};
  if (!globalThis.chrome?.runtime?.sendMessage) return {};
  const res = await chrome.runtime.sendMessage({ target: 'pawwork-background', action: 'storage_local_get', keys });
  if (!res?.ok) throw new Error('CONTEXT_WINDOW_STORAGE_UNAVAILABLE');
  return res.result || {};
}

export async function contextWindowStorageSet(values) {
  if (globalThis.chrome?.storage?.local) return chrome.storage.local.set(values);
  const res = await chrome.runtime.sendMessage({ target: 'pawwork-background', action: 'storage_local_set', values });
  if (!res?.ok) throw new Error('CONTEXT_WINDOW_STORAGE_UNAVAILABLE');
}

/**
 * Measured windows live 30d. Unknown / 401 / 429 / 5xx cool down for 24h.
 * @param {{ window?: number|null, checkedAt?: number }|null|undefined} record
 * @param {number} [now]
 */
export function contextWindowEvidenceDue(record, now = Date.now()) {
  if (!record || !Number.isFinite(record.checkedAt)) return true;
  const ttl = Number(record.window) >= 2048 ? 30 * DAY : DAY;
  return now - record.checkedAt >= ttl;
}

/**
 * @param {unknown} raw
 * @returns {{ window: number|null, source: string, kind: string, checkedAt: number }|null}
 */
export function normalizeContextWindowEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const checkedAt = Number(/** @type {any} */ (raw).checkedAt);
  if (!Number.isFinite(checkedAt)) return null;
  const n = Number(/** @type {any} */ (raw).window);
  const window = Number.isFinite(n) && n >= 2048 && n < 10_000_000 ? Math.round(n) : null;
  return {
    window,
    source: window ? 'measured' : String(/** @type {any} */ (raw).source || 'unknown'),
    kind: String(/** @type {any} */ (raw).kind || (window ? 'measure_chat' : 'unknown')),
    checkedAt
  };
}
