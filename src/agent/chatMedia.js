/** Input declarations and cached checks are evidence. Unknown audio/video fail closed.
 * A model declaration and a supported wire transport are both required.
 */
import { normalizeModelsBaseURL, classifyChatVisionCapability } from './modelCatalog.js';
import { mergeMediaEvidence } from './mediaCapabilityStore.js';

export const MAX_CHAT_MEDIA_BYTES = 16 * 1024 * 1024;
export const INPUT_MODALITIES = ['text', 'image', 'audio', 'video'];
export const MEDIA_TRANSPORTS = ['auto', 'openai-audio', 'openrouter'];

export function mediaModelKey(base, model) {
  return `${normalizeModelsBaseURL(base)}\n${String(model || '').trim()}`;
}

export function normalizeMediaOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.includes('\n') || !value || typeof value !== 'object') continue;
    const entry = {};
    for (const kind of INPUT_MODALITIES) {
      if (typeof value[kind] === 'boolean') entry[kind] = value[kind];
    }
    if (MEDIA_TRANSPORTS.includes(value.transport)) entry.transport = value.transport;
    if (Object.keys(entry).length) out[key] = entry;
  }
  return out;
}

// Deliberately small, versioned defaults. Catalog/user declarations supersede these.
const GEMINI_AV = /^(?:google\/)?gemini-(?:2\.0-flash(?:-001)?|2\.5-(?:flash|pro)(?:-preview-\d\d-\d\d)?)$/;
const OPENAI_AUDIO = /^(?:openai\/)?(?:gpt-4o(?:-mini)?-audio-preview(?:-\d{4}-\d{2}-\d{2})?|gpt-audio(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?)$/;

export function resolveChatMediaCapabilities(settings = {}, models = [], evidence = null, now = Date.now()) {
  const model = String(settings.model || '').trim();
  const base = normalizeModelsBaseURL(settings.apiBase || '');
  // No suffix matching: vendor-a/foo must not inherit vendor-b/foo's capabilities.
  const entry = models.find((m) => m?.id === model);
  const override = settings.chatMediaOverrides?.[mediaModelKey(base, model)] || {};
  const declared = Array.isArray(entry?.inputModalities) ? entry.inputModalities : null;
  let hostname = '';
  try { hostname = new URL(base).hostname; } catch { /* unknown endpoint */ }
  const official = ['api.openai.com', 'api.deepseek.com', 'generativelanguage.googleapis.com', 'openrouter.ai'].includes(hostname);
  const knownAV = ['generativelanguage.googleapis.com', 'openrouter.ai'].includes(hostname) && GEMINI_AV.test(model);
  const vision = official ? classifyChatVisionCapability(model) : 'unknown';
  const inputs = {};
  for (const kind of INPUT_MODALITIES) {
    let state = 'unknown', source = 'unknown';
    if (kind === 'text') { state = 'supported'; source = 'chat'; }
    if (kind === 'image' && vision !== 'unknown') {
      state = vision === 'vision' ? 'supported' : 'unsupported'; source = 'builtin';
    }
    if (kind === 'audio' || kind === 'video') {
      if (knownAV || (kind === 'audio' && ['api.openai.com', 'openrouter.ai'].includes(hostname) && OPENAI_AUDIO.test(model))) {
        state = 'supported'; source = 'builtin';
      } else if (
        vision === 'text-only' ||
        hostname === 'api.deepseek.com' ||
        (official && /^(?:openai\/)?gpt-4o(?:-mini)?$/.test(model))
      ) {
        // Official DeepSeek documents image input on Flash; it has no audio/video SKU.
        state = 'unsupported'; source = 'builtin';
      }
    }
    if (declared) { state = declared.includes(kind) ? 'supported' : 'unsupported'; source = 'catalog'; }
    if (typeof override[kind] === 'boolean') {
      state = override[kind] ? 'supported' : 'unsupported'; source = 'user';
    }
    inputs[kind] = { state, source };
  }
  let transport = MEDIA_TRANSPORTS.includes(override.transport) ? override.transport : 'auto';
  if (transport === 'auto') {
    transport = 'none';
    try {
      const u = new URL(base);
      if (u.hostname === 'openrouter.ai' && u.pathname.replace(/\/$/, '') === '/api/v1') transport = 'openrouter';
      if ((u.hostname === 'api.openai.com' && u.pathname === '/v1') ||
          (u.hostname === 'generativelanguage.googleapis.com' && /^\/v1(?:beta)?\/openai$/.test(u.pathname))) transport = 'openai-audio';
    } catch { /* custom gateways require an explicit transport declaration */ }
  }
  const caps = mergeMediaEvidence({ model, base, inputs, transport, maxBytes: MAX_CHAT_MEDIA_BYTES }, evidence, now);
  caps.routes = {
    nativeAudio: canSendChatMedia(caps, 'audio/wav'),
    nativeVideo: canSendChatMedia(caps, 'video/webm'),
    videoAudio: caps.videoAudio,
    file: 'acquire action=fetch url or path',
    liveVideo: 'action op=record seconds=8 (tab picture + audio; max 30s; video grant)',
    liveAudio: 'action op=listen (audio only)',
    still: 'action op=snapshot',
    sttConfigured: Boolean(settings.stt?.apiKey)
  };
  return caps;
}

export function canSendChatMedia(caps, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const kind = mime.split('/')[0];
  if (caps?.inputs?.[kind]?.rejectedFormats?.includes(mime)) return false;
  if (caps?.inputs?.[kind]?.source === 'verified' && !caps.inputs[kind].formats?.includes(mime)) return false;
  if (kind === 'image') return caps?.inputs?.image?.state !== 'unsupported';
  if (caps?.inputs?.[kind]?.state !== 'supported') return false;
  if (kind === 'audio') return ['openai-audio', 'openrouter'].includes(caps.transport) && ['audio/wav', 'audio/mpeg'].includes(mime);
  return kind === 'video' && caps.transport === 'openrouter' && ['video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/webm'].includes(mime);
}
