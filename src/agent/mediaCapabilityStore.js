import { MSG_TARGET_BACKGROUND } from '../brand.js';

/** Configuration-scoped evidence. No credentials or provider response bodies are stored. */
export const MEDIA_CACHE_KEY = 'browserbot_chat_media_evidence_v1';
export const MEDIA_AUTO_KEY = 'browserbot_chat_media_auto_check';
export const MEDIA_CHECK_VERSION = 1;
export const DAY = 86400000;

export async function mediaStorageGet(keys) {
  if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(keys)) || {};
  if (!globalThis.chrome?.runtime?.sendMessage) return {};
  const res = await chrome.runtime.sendMessage({ target: MSG_TARGET_BACKGROUND, action: 'storage_local_get', keys });
  if (!res?.ok) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
  return res.result || {};
}

export async function mediaStorageSet(values) {
  if (globalThis.chrome?.storage?.local) return chrome.storage.local.set(values);
  const res = await chrome.runtime.sendMessage({ target: MSG_TARGET_BACKGROUND, action: 'storage_local_set', values });
  if (!res?.ok) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
}

export async function mediaConnectionKey(settings, caps) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    MEDIA_CHECK_VERSION, settings.providerId || 'legacy', caps.base, caps.model,
    settings.apiKey || '', caps.transport, settings.routing || null
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function evidenceDue(record, now = Date.now()) {
  if (!record) return true;
  const ttl = record.state === 'supported' ? 30 * DAY : record.state === 'unsupported' ? 7 * DAY : DAY;
  return now - record.checkedAt >= ttl;
}

export function mergeMediaEvidence(caps, entry, now = Date.now()) {
  const out = structuredClone(caps);
  for (const kind of ['image', 'audio', 'video']) {
    const record = entry?.[kind];
    if (!record) continue;
    out.inputs[kind].lastCheck = { ...record, stale: evidenceDue(record, now) };
    if (out.inputs[kind].source === 'user') continue;
    // A failed refresh preserves the last positive evidence; transient failures never deny input.
    const proof = record.state === 'supported' ? record : record.previous;
    if (proof?.state === 'supported') out.inputs[kind] = { ...out.inputs[kind], state: 'supported',
      source: 'verified', formats: proof.formats, checkedAt: proof.checkedAt, stale: evidenceDue(proof, now) };
    const rejections = record.rejections || (record.state === 'unsupported'
      ? Object.fromEntries((record.formats || []).map(format => [format, record.checkedAt])) : {});
    out.inputs[kind].rejectedFormats = Object.entries(rejections)
      .filter(([, checkedAt]) => now - checkedAt < 7 * DAY).map(([format]) => format);
  }
  out.videoAudio = entry?.video?.videoAudio || entry?.video?.previous?.videoAudio || 'unknown';
  return out;
}
