import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsResponse, cacheModelsForBase, loadCachedModelsForBase } from '../src/agent/modelCatalog.js';
import { resolveChatMediaCapabilities, mediaModelKey, canSendChatMedia, MAX_CHAT_MEDIA_BYTES } from '../src/agent/chatMedia.js';
import { normalizeProvider, loadLlmSettings, upsertProvider } from '../src/agent/llm.js';
import { routeMediaInput, pcmToWav } from '../src/agent/vnext/sessionWorkspace/mediaInput.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { executeListenAction } from '../src/agent/vnext/sessionWorkspace/listenAction.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createBrowserBotLanguageModel, stripUnsupportedFieldsFromRequestInit } from '../src/agent/provider.js';

const base = 'https://openrouter.ai/api/v1';
const model = 'test/media';
const settings = { apiBase: base, model };
const catalog = parseModelsResponse({ data: [{ id: model, architecture: { input_modalities: ['text', 'image', 'audio', 'video'], output_modalities: ['text'] } }] });
const caps = resolveChatMediaCapabilities(settings, catalog);
function env(extra = {}) {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  fs.mkdirp('/scratch/sources');
  return { store, fs, sessionId: 's', settings, mediaCapabilities: caps, execution: { executionId: 'e' }, ...extra };
}
function fakeStorage(bag = {}) {
  return { storage: { local: { get(keys, cb) { const value = Object.fromEntries(keys.map(k => [k, bag[k]])); if (cb) cb(value); else return Promise.resolve(value); }, set(value, cb) { Object.assign(bag, value); cb?.(); } } } };
}

test('catalog inputs survive cache; output modalities never imply inputs', async () => {
  const prev = globalThis.chrome;
  globalThis.chrome = fakeStorage();
  try {
    await cacheModelsForBase(base, catalog);
    assert.deepEqual((await loadCachedModelsForBase(base)).models, catalog);
    assert.equal(catalog[0].image, undefined);
    const onlyOutput = parseModelsResponse({ data: [{ id: model, architecture: { output_modalities: ['audio'] } }] });
    assert.equal(resolveChatMediaCapabilities(settings, onlyOutput).inputs.audio.state, 'unknown');
  } finally { globalThis.chrome = prev; }
});

test('exact current model, tri-state, scoped overrides and transport are independent', () => {
  assert.equal(caps.inputs.video.source, 'catalog');
  assert.equal(canSendChatMedia(caps, 'video/mp4'), true);
  for (const id of ['deepseek-chat', 'gpt-4o', 'gpt-4o-mini', 'other/media', 'media', 'new-model']) {
    assert.equal(canSendChatMedia(resolveChatMediaCapabilities({ ...settings, model: id }, catalog), 'audio/wav'), false);
  }
  const unknown = resolveChatMediaCapabilities({ model: 'new', apiBase: base });
  assert.equal(unknown.inputs.audio.state, 'unknown');
  assert.equal(canSendChatMedia(unknown, 'image/jpeg'), true);
  const custom = { apiBase: 'https://gateway.test/v1', model: 'alias' };
  const key = mediaModelKey(custom.apiBase, custom.model);
  const configured = { ...custom, chatMediaOverrides: { [key]: { audio: true, video: true, transport: 'openrouter' } } };
  assert.equal(canSendChatMedia(resolveChatMediaCapabilities(configured), 'video/mp4'), true);
  assert.equal(canSendChatMedia(resolveChatMediaCapabilities({ ...configured, model: 'another' }), 'video/mp4'), false);
  assert.equal(canSendChatMedia(resolveChatMediaCapabilities({ ...configured, apiBase: 'https://other.test/v1' }), 'video/mp4'), false);
  assert.equal(canSendChatMedia(resolveChatMediaCapabilities(custom, [{ id: 'alias', inputModalities: ['audio'] }]), 'audio/wav'), false);
  const denied = resolveChatMediaCapabilities({ ...settings, chatMediaOverrides: { [mediaModelKey(base, model)]: { audio: false } } }, catalog);
  assert.equal(denied.inputs.audio.source, 'user');
  assert.equal(canSendChatMedia(denied, 'audio/wav'), false);
  assert.equal(canSendChatMedia(resolveChatMediaCapabilities({ apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-audio-preview' }), 'audio/wav'), true);
});

test('override normalization and partial provider updates preserve model scoping and STT independence', async () => {
  const key = mediaModelKey(base, model);
  const p = normalizeProvider({ id: 'chat', baseURL: base, model, apiKey: 'chat-key', chatMediaOverrides: { [key]: { audio: true, transport: 'openrouter', extra: 'drop' } } });
  assert.deepEqual(p.chatMediaOverrides[key], { audio: true, transport: 'openrouter' });
  const prev = globalThis.chrome;
  globalThis.chrome = fakeStorage({ browserbot_providers: [p, { id: 'stt', purpose: 'stt', apiKey: 'stt-key', model: 'whisper-1', baseURL: 'https://stt.test/v1' }], browserbot_active_provider_id: 'chat', browserbot_active_stt_provider_id: 'stt' });
  try {
    await upsertProvider({ id: 'chat', baseURL: base, model: 'new' });
    let loaded = await loadLlmSettings();
    assert.equal(loaded.stt.apiKey, 'stt-key');
    assert.deepEqual(loaded.chatMediaOverrides, p.chatMediaOverrides);
    assert.equal(resolveChatMediaCapabilities(loaded).inputs.audio.state, 'unknown');
    await upsertProvider({ id: 'chat', baseURL: base, model, chatMediaOverrides: {} });
    loaded = await loadLlmSettings();
    assert.equal(loaded.chatMediaOverrides, undefined);
  } finally { globalThis.chrome = prev; }
});

test('listen stop sends native audio without STT and preserves facts through action output', async () => {
  let conversions = 0;
  const e = env({
    hostPageAction: async () => ({ ok: true, tabId: 7, audible: true }),
    listenRuntime: { isListening: () => true, stop: async () => ({ ok: true, mimeType: 'audio/webm;codecs=opus', bytes: new Uint8Array([1, 2, 3]) }) },
    audioToWav: async () => { conversions++; return pcmToWav([new Float32Array([0, 0.5])], 16000); },
    fetchImpl: async () => { throw new Error('STT must not run'); }
  });
  const out = await executeListenAction(e, { listen: 'stop' }, 7);
  assert.equal(conversions, 1);
  assert.equal(out.media.route, 'native');
  assert.equal(out.modelParts[0].mediaType, 'audio/wav');
  assert.ok(e.fs.exists(out.path));
  const result = createSessionTools(e).action.toModelOutput({ output: out });
  assert.equal(result.type, 'content');
  const facts = JSON.parse(result.value[0].text);
  assert.equal(facts.listen, 'stop');
  assert.equal(facts.path, out.path);
  assert.equal(facts.modelParts, undefined);
  assert.equal(result.value[1].type, 'file');
});

test('unknown audio uses STT, text survives action output; no STT returns NEED_STT', async () => {
  let calls = 0;
  const e = env({ mediaCapabilities: resolveChatMediaCapabilities({ model: 'unknown' }), settings: { model: 'unknown', stt: { apiKey: 'stt', apiBase: 'https://stt.test/v1', model: 'whisper-1' } },
    fetchImpl: async (url) => { calls++; assert.equal(url, 'https://stt.test/v1/audio/transcriptions'); return new Response('{"text":"heard words"}'); } });
  const path = '/scratch/sources/speech.webm'; e.fs.writeFile(path, new Uint8Array([1]));
  const out = await routeMediaInput(e, { ok: true, listen: 'clip', path, mediaType: 'audio/webm' });
  assert.equal(calls, 1); assert.equal(out.modelParts, undefined);
  assert.equal(createSessionTools(e).action.toModelOutput({ output: out }).value.text, 'heard words');
  const missing = await routeMediaInput({ ...e, settings: {} }, { ok: true, path, mediaType: 'audio/webm' });
  assert.equal(missing.stt.code, 'NEED_STT');
  assert.equal(missing.path, path);
});

test('public mp4 fetch attaches video to own model; saved path works without listen', async () => {
  const e = env({ fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }) });
  const tools = createSessionTools(e);
  const out = await tools.acquire.execute({ action: 'fetch', url: 'https://example.com/movie.mp4' });
  assert.equal(out.media.route, 'native'); assert.equal(out.media.kind, 'video');
  assert.ok(e.fs.exists(out.path)); assert.equal(out.modelParts[0].mediaType, 'video/mp4');
  const replay = await tools.acquire.execute({ action: 'fetch', path: out.path });
  assert.equal(replay.media.route, 'native');
  const result = tools.acquire.toModelOutput({ output: out });
  assert.equal(JSON.parse(result.value[0].text).path, out.path);
});

test('video fallback reports speech-only; conversion failure and size cap never attach bytes', async () => {
  const e = env({ mediaCapabilities: resolveChatMediaCapabilities({ model: 'gpt-4o', apiBase: base }) });
  const path = '/scratch/sources/movie.mp4'; e.fs.writeFile(path, new Uint8Array([1]));
  const out = await routeMediaInput(e, { ok: true, path, mediaType: 'video/mp4' });
  assert.equal(out.stt.code, 'NEED_STT'); assert.match(out.media.scope, /frames were not delivered/);
  const failed = await routeMediaInput({ ...e, mediaCapabilities: caps, audioToWav: async () => { throw new Error('bad codec'); } }, { ok: true, path, mediaType: 'audio/webm' });
  assert.equal(failed.media.reason, 'MEDIA_CONVERSION_FAILED'); assert.equal(failed.modelParts, undefined);
  e.fs.writeFile(path, new Uint8Array(MAX_CHAT_MEDIA_BYTES + 1));
  const large = await routeMediaInput({ ...e, mediaCapabilities: caps }, { ok: true, path, mediaType: 'video/mp4' });
  assert.equal(large.media.reason, 'MEDIA_TOO_LARGE'); assert.equal(large.modelParts, undefined);
});

test('wire lift preserves tool batches and mixed modalities; mismatched/unknown model strips media base64', () => {
  const file = (mime) => ({ type: 'file', mediaType: mime, data: { type: 'data', data: 'QUJD'.repeat(20) } });
  const messages = [{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: JSON.stringify([{ type: 'text', text: '{"path":"a"}' }, file('audio/wav')]) },
    { role: 'tool', tool_call_id: 'b', content: JSON.stringify([{ type: 'text', text: '{"path":"b"}' }, file('video/mp4'), file('image/jpeg')]) }];
  const init = { body: JSON.stringify({ model, messages }) };
  const body = JSON.parse(stripUnsupportedFieldsFromRequestInit(init, null, { mediaCapabilities: caps }).body);
  assert.deepEqual(body.messages.map(m => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(body.messages[1].content, '{"path":"a"}');
  assert.deepEqual(body.messages[3].content.map(p => p.type), ['text', 'input_audio', 'video_url', 'image_url']);
  const unknown = JSON.parse(stripUnsupportedFieldsFromRequestInit({ body: JSON.stringify({ model: 'new', messages: messages.slice(0, 2) }) }, null, { mediaCapabilities: caps }).body);
  assert.doesNotMatch(JSON.stringify(unknown), /QUJD/);
  assert.match(unknown.messages[1].content, /omitted/);
});

test('real bundled AI SDK serializes media tool output into native request parts before fetch', async () => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const built = await createBrowserBotLanguageModel({ settings: { ...settings, apiKey: 'fake' }, mediaCapabilities: caps });
    const output = createSessionTools(env()).acquire.toModelOutput({ output: { ok: true, path: '/scratch/movie.mp4', modelParts: [{ type: 'file', mediaType: 'video/mp4', data: 'QUJD'.repeat(20) }] } });
    await built.model.doGenerate({ prompt: [
      { role: 'user', content: [{ type: 'text', text: 'understand media' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'acquire', input: { action: 'fetch' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'acquire', output }] }
    ] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, model);
    const msgs = requests[0].body.messages;
    assert.equal(msgs.at(-1).content[1].type, 'video_url');
    assert.doesNotMatch(msgs.find(m => m.role === 'tool').content, /QUJD/);
  } finally { globalThis.fetch = previous; }
});

test('product send freezes settings for the turn and re-resolves a changed model next turn', async () => {
  const { SessionWorkspaceService } = await import('../src/agent/vnext/service/sessionWorkspaceService.js');
  const previous = globalThis.chrome;
  const bag = { browserbot_providers: [{ id: 'chat', baseURL: base, model, apiKey: 'fake' }], browserbot_active_provider_id: 'chat' };
  globalThis.chrome = fakeStorage(bag);
  try {
    await cacheModelsForBase(base, catalog);
    const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), memoryJournal: true });
    const turns = [];
    service.resolveLanguageModel = async (opts) => {
      // Simulate the settings changing after the send's snapshot was taken.
      bag.browserbot_providers[0] = { ...bag.browserbot_providers[0], model: 'deepseek-chat' };
      return { modelId: opts.settings.model };
    };
    service.runtime.sendMessage = async (input) => { turns.push(input); return { finalText: 'ok' }; };
    await service.sendMessage({ sessionId: 's', content: 'first' });
    await service.sendMessage({ sessionId: 's', content: 'second' });
    assert.equal(turns[0].model.modelId, model);
    assert.equal(turns[0].settings.model, model);
    assert.equal(turns[0].mediaCapabilities.inputs.video.state, 'supported');
    assert.equal(turns[1].model.modelId, 'deepseek-chat');
    assert.equal(turns[1].mediaCapabilities.inputs.video.state, 'unsupported');
  } finally { globalThis.chrome = previous; }
});

test('saved live WebM keeps audio MIME; PCM WAV header and sample bytes are genuine', async () => {
  const wav = pcmToWav([new Float32Array([-1, 0, 1])], 16000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), 'WAVE');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual([44, 46, 48].map(i => view.getInt16(i, true)), [-32768, 0, 32767]);
  const e = env({ audioToWav: async () => wav });
  const path = '/scratch/sources/listen.webm';
  e.fs.writeFile(path, new Uint8Array([1]), { mimeType: 'audio/webm;codecs=opus' });
  const result = await createSessionTools(e).acquire.execute({ action: 'fetch', path });
  assert.equal(result.media.kind, 'audio');
  assert.equal(result.media.sentMediaType, 'audio/wav');
});
