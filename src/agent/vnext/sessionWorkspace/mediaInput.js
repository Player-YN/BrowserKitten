/** Shared routing for live audio and downloaded media, before the next chat hop. */
import { resolveChatMediaCapabilities, canSendChatMedia, MAX_CHAT_MEDIA_BYTES } from '../../chatMedia.js';
import { transcribeSessionAudio } from './transcribe.js';

export function pcmToWav(channels, sampleRate) {
  const length = channels[0]?.length || 0;
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, c) => sum + c[i], 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

// MediaRecorder WebM/Opus is NOT input_audio wav. Decode and encode real PCM WAV.
export async function audioToWav(bytes) {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) throw new Error('audio decoder unavailable');
  const ctx = new Context({ sampleRate: 16000 });
  try {
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    if (buffer.duration > 120) throw new Error('native audio exceeds 120 seconds; use a shorter clip');
    return pcmToWav(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
  } finally { await ctx.close(); }
}

export function mediaMime(type, path = '') {
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = String(path).split(/[?#]/)[0].split('.').pop().toLowerCase();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[ext] || mime;
}

function base64(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}

export async function routeMediaInput(env, receipt) {
  const storedMime = env.fs.readFileMimeType?.(receipt.path);
  const mime = mediaMime(receipt.mediaType || receipt.mimeType ||
    (/^(audio|video|image)\//.test(storedMime || '') ? storedMime : ''), receipt.path);
  const kind = mime.split('/')[0];
  if (!['audio', 'video', 'image'].includes(kind)) return receipt;
  const caps = env.mediaContext ? await env.mediaContext.wait(kind, env.signal) :
    env.mediaCapabilities || resolveChatMediaCapabilities(env.settings);
  const media = { kind, model: caps.model, capability: caps.inputs[kind], transport: caps.transport, route: 'unavailable' };
  if (kind === 'video') media.soundtrack = caps.videoAudio || 'unknown';
  const out = { ...receipt, mediaType: mime, media };
  if (env.signal?.aborted) return { ...out, ok: false, code: 'ABORTED' };
  let reason = caps.inputs[kind]?.state === 'supported' ? 'MEDIA_TRANSPORT_UNSUPPORTED' : 'MEDIA_CAPABILITY_UNKNOWN_OR_UNSUPPORTED';
  const bytes = env.fs.readFileBytes(receipt.path);
  if (bytes.length && bytes.length <= MAX_CHAT_MEDIA_BYTES) {
    let data = bytes, sendMime = mime;
    if (kind === 'audio' && canSendChatMedia(caps, 'audio/wav') && !canSendChatMedia(caps, mime)) {
      try {
        data = await (env.audioToWav || audioToWav)(bytes);
        sendMime = 'audio/wav';
      } catch (e) { reason = 'MEDIA_CONVERSION_FAILED'; media.detail = String(e?.message || e); }
    }
    if (env.signal?.aborted) return { ...out, ok: false, code: 'ABORTED' };
    if (data.length <= MAX_CHAT_MEDIA_BYTES && canSendChatMedia(caps, sendMime)) {
      media.route = 'native';
      media.sentMediaType = sendMime;
      return { ...out, modelParts: [{ type: 'file', mediaType: sendMime, data: base64(data) }] };
    }
    if (data.length > MAX_CHAT_MEDIA_BYTES) reason = 'MEDIA_TOO_LARGE';
  } else reason = bytes.length ? 'MEDIA_TOO_LARGE' : 'EMPTY_MEDIA';
  media.reason = reason;
  if (kind === 'image') return out;
  // Video fallback describes speech only. Never claim to have seen its frames.
  media.scope = kind === 'video' ? 'speech-only; video frames were not delivered' : 'speech-only';
  const tr = await transcribeSessionAudio({ ...env, path: receipt.path });
  if (!tr.ok) return { ...out, stt: { ok: false, code: tr.code, error: tr.error, hint: tr.hint } };
  media.route = 'stt';
  return { ...out, text: tr.text, transcriptPath: tr.path, model: tr.model };
}
