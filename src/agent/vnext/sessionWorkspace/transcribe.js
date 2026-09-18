/**
 * Host speech-to-text — OpenAI-compatible POST /audio/transcriptions.
 * Session uses acquire({ action: 'transcribe' }). Settings purpose is `stt`.
 */

import { loadLlmSettings, DEFAULT_STT_MODEL, DEFAULT_STT_BASE } from '../../llm.js';
import { listArtifacts } from './artifacts.js';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * @param {object} [settings]
 */
export function resolveSttRuntimeConfig(settings) {
  const stt = settings?.stt && typeof settings.stt === 'object' ? settings.stt : null;
  const apiKey = String(stt?.apiKey || '').trim();
  const apiBase = String(stt?.apiBase || DEFAULT_STT_BASE)
    .trim()
    .replace(/\/$/, '');
  const model = String(stt?.model || DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;
  return { apiKey, apiBase, model, enabled: !!(apiKey && apiBase) };
}

function guessAudioMime(name, fallback = '') {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.aac')) return 'audio/aac';
  if (n.endsWith('.ogg') || n.endsWith('.oga')) return 'audio/ogg';
  if (n.endsWith('.webm')) return 'audio/webm';
  if (n.endsWith('.flac')) return 'audio/flac';
  if (n.endsWith('.mp4')) return 'video/mp4';
  if (n.endsWith('.mpeg') || n.endsWith('.mpga')) return 'audio/mpeg';
  const fb = String(fallback || '').split(';')[0].trim();
  return fb || 'application/octet-stream';
}

function fail(error, code = 'TRANSCRIBE_FAILED', extra = {}) {
  return { ok: false, action: 'transcribe', code, error, ...extra };
}

async function loadAudioSource(env, input) {
  const path = String(input.path || '').trim();
  const artifactId = String(input.artifactId || '').trim();
  const url = String(input.url || '').trim();
  const fs = env.fs;

  if (path) {
    if (!fs?.exists?.(path)) {
      return fail(`no file: ${path}`, 'ENOENT', {
        hint: 'write audio under /scratch or /artifacts, then pass that path'
      });
    }
    const bytes = fs.readFileBytes(path);
    const filename = path.split('/').pop() || 'audio.bin';
    return { ok: true, bytes, filename, mimeType: guessAudioMime(filename) };
  }

  if (artifactId) {
    const rec = listArtifacts(env.store, env.sessionId).find((a) => a.artifactId === artifactId);
    if (!rec) {
      return fail(`no artifact: ${artifactId}`, 'NO_ARTIFACT', {
        hint: 'inspect view=artifacts then pass artifactId'
      });
    }
    const guestPath = String(rec.primaryPath || '');
    if (!guestPath || !fs?.exists?.(guestPath)) {
      return fail(`artifact file missing: ${artifactId}`, 'ENOENT');
    }
    const bytes = fs.readFileBytes(guestPath);
    const filename = rec.name || guestPath.split('/').pop() || 'audio.bin';
    return { ok: true, bytes, filename, mimeType: rec.mimeType || guessAudioMime(filename) };
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      return fail('url must be http(s)', 'BAD_URL');
    }
    const fetchImpl = env.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return fail('fetch unavailable', 'NO_FETCH');
    }
    const res = await fetchImpl(url, { signal: env.signal });
    if (!res.ok) {
      return fail(`fetch ${res.status}`, 'FETCH_FAILED');
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const filename = url.split('?')[0].split('/').pop() || 'audio.bin';
    const mimeType = guessAudioMime(filename, res.headers?.get?.('content-type') || '');
    return { ok: true, bytes: buf, filename, mimeType };
  }

  return fail('transcribe needs path, artifactId, or url', 'NEED_SOURCE', {
    hint: 'pass a guest path, artifactId, or a public audio URL'
  });
}

/**
 * @param {{
 *   store: import('./store.js').SessionWorkspaceStore,
 *   fs: ReturnType<import('./fs.js').createSessionGuestFs>,
 *   sessionId: string,
 *   path?: string,
 *   artifactId?: string,
 *   url?: string,
 *   model?: string,
 *   language?: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   settings?: object
 * }} env
 */
export async function transcribeSessionAudio(env) {
  const sessionId = String(env.sessionId || '');
  if (!sessionId) return fail('sessionId required', 'NEED_SESSION');
  if (env.signal?.aborted) return fail('aborted', 'ABORTED');

  const settings = env.settings || (await loadLlmSettings());
  const cfg = resolveSttRuntimeConfig(settings);
  if (env.model) cfg.model = String(env.model).trim() || cfg.model;
  if (!cfg.enabled) {
    return fail('no speech-to-text API configured', 'NEED_STT', {
      hint: 'add a transcription API in Settings'
    });
  }

  const source = await loadAudioSource(env, env);
  if (!source.ok) return source;
  if (!(source.bytes instanceof Uint8Array) || !source.bytes.byteLength) {
    return fail('empty audio', 'EMPTY_AUDIO');
  }
  if (source.bytes.byteLength > MAX_BYTES) {
    return fail(`audio exceeds ${MAX_BYTES} bytes`, 'AUDIO_TOO_LARGE');
  }

  const fetchImpl = env.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail('fetch unavailable', 'NO_FETCH');

  const endpoint = `${cfg.apiBase}/audio/transcriptions`;
  const form = new FormData();
  form.append(
    'file',
    new Blob([source.bytes], { type: source.mimeType || 'application/octet-stream' }),
    source.filename || 'audio.bin'
  );
  form.append('model', cfg.model);
  const language = String(env.language || '').trim();
  if (language) form.append('language', language);

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: env.signal
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 'STT_NETWORK');
  }

  let payload = null;
  const rawText = await res.text();
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === 'object' && (payload.error?.message || payload.error || payload.message)) ||
      rawText ||
      `HTTP ${res.status}`;
    return fail(String(msg), 'STT_HTTP');
  }

  const text =
    typeof payload?.text === 'string'
      ? payload.text
      : typeof payload === 'string'
        ? payload
        : rawText;
  const transcript = String(text || '').trim();
  if (!transcript) return fail('empty transcript', 'EMPTY_TRANSCRIPT');

  const outPath = `/scratch/sources/transcript_${Date.now().toString(36)}.txt`;
  env.fs.mkdirp('/scratch/sources');
  env.fs.writeFile(outPath, transcript, { mimeType: 'text/plain' });
  return {
    ok: true,
    action: 'transcribe',
    path: outPath,
    text: transcript,
    model: cfg.model,
    bytes: source.bytes.byteLength,
    source: source.filename
  };
}
