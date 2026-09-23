import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChatProvider,
  isImageOnlyProvider,
  isImageProvider,
  isSttOnlyProvider,
  isJevProvider,
  listChatProviders,
  listImageProviders,
  listSttProviders,
  listJevProviders,
  resolveActiveImageProvider,
  resolveActiveSttProvider,
  resolveActiveJevProvider,
  imageVendorLabel,
  sttVendorLabel,
  normalizeProvider,
  applyProviderImageModel
} from '../src/agent/llm.js';
import { isLikelySttModel, sttModelsFromList } from '../src/agent/modelCatalog.js';

test('image-only purpose is not a chat provider', () => {
  const image = normalizeProvider({
    id: 'img1',
    purpose: 'image',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    model: '',
    image: { enabled: true, protocol: 'openrouter-image', model: 'google/gemini-2.5-flash-image' }
  });
  assert.equal(isImageOnlyProvider(image), true);
  assert.equal(isChatProvider(image), false);
  assert.equal(isImageProvider(image), true);
  assert.equal(imageVendorLabel(image), 'OpenRouter');
});

test('chat provider with nested image appears in both lists', () => {
  const chat = normalizeProvider({
    id: 'c1',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    model: 'deepseek-v4-flash',
    image: {
      enabled: true,
      protocol: 'openrouter-image',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-2.5-flash-image'
    }
  });
  assert.equal(isChatProvider(chat), true);
  assert.equal(isImageOnlyProvider(chat), false);
  assert.equal(isImageProvider(chat), true);
  const providers = [chat, normalizeProvider({ id: 'c2', name: 'OR', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' })];
  assert.deepEqual(listChatProviders(providers).map((p) => p.id), ['c1', 'c2']);
  assert.deepEqual(listImageProviders(providers).map((p) => p.id), ['c1']);
  assert.equal(imageVendorLabel(chat), 'OpenRouter');
});

test('active image id stays independent of the chat vendor', () => {
  const chat = normalizeProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  });
  const image = normalizeProvider({
    id: 'or-img',
    purpose: 'image',
    name: 'OpenRouter',
    image: { enabled: true, protocol: 'openrouter-image', model: 'flux' }
  });
  const none = resolveActiveImageProvider([chat], 'or-img');
  assert.equal(none.activeImageProviderId, null);
  const hit = resolveActiveImageProvider([chat, image], 'or-img');
  assert.equal(hit.activeImageProviderId, 'or-img');
  const fallback = resolveActiveImageProvider([chat, image], 'missing');
  assert.equal(fallback.activeImageProviderId, 'or-img');
});

test('applyProviderImageModel does not change the chat model', () => {
  const next = applyProviderImageModel(
    { id: 'p', model: 'deepseek-v4-flash', image: { enabled: true, model: 'old' } },
    'google/gemini-2.5-flash-image'
  );
  assert.equal(next.model, 'deepseek-v4-flash');
  assert.equal(next.image.model, 'google/gemini-2.5-flash-image');
  assert.equal(next.image.enabled, true);
});

test('stt-only purpose is not a chat or image provider', () => {
  const stt = normalizeProvider({
    id: 'stt1',
    purpose: 'stt',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-stt',
    model: 'whisper-1'
  });
  assert.equal(stt.purpose, 'stt');
  assert.equal(isSttOnlyProvider(stt), true);
  assert.equal(isChatProvider(stt), false);
  assert.equal(isImageOnlyProvider(stt), false);
  assert.equal(isImageProvider(stt), false);
  assert.equal(sttVendorLabel(stt), 'OpenAI');
  const chat = normalizeProvider({
    id: 'c1',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  });
  const providers = [chat, stt];
  assert.deepEqual(listChatProviders(providers).map((p) => p.id), ['c1']);
  assert.deepEqual(listSttProviders(providers).map((p) => p.id), ['stt1']);
  const none = resolveActiveSttProvider([chat], 'stt1');
  assert.equal(none.activeSttProviderId, null);
  const hit = resolveActiveSttProvider(providers, 'stt1');
  assert.equal(hit.activeSttProviderId, 'stt1');
  const fallback = resolveActiveSttProvider(providers, 'missing');
  assert.equal(fallback.activeSttProviderId, 'stt1');
});

test('jev-only purpose is not a chat provider', () => {
  const jev = normalizeProvider({
    id: 'jev1',
    purpose: 'jev',
    name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: 'sk-jev',
    model: 'jev-1.13'
  });
  assert.equal(jev.purpose, 'jev');
  assert.equal(isJevProvider(jev), true);
  assert.equal(isChatProvider(jev), false);
  assert.equal(isImageOnlyProvider(jev), false);
  assert.equal(isSttOnlyProvider(jev), false);
  const chat = normalizeProvider({
    id: 'c1',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  });
  const providers = [chat, jev];
  assert.deepEqual(listChatProviders(providers).map((p) => p.id), ['c1']);
  assert.deepEqual(listJevProviders(providers).map((p) => p.id), ['jev1']);
  const none = resolveActiveJevProvider([chat], 'jev1');
  assert.equal(none.activeJevProviderId, null);
  const hit = resolveActiveJevProvider(providers, 'jev1');
  assert.equal(hit.activeJevProviderId, 'jev1');
});

test('isLikelySttModel keeps whisper and drops chat ids', () => {
  assert.equal(isLikelySttModel('whisper-1'), true);
  assert.equal(isLikelySttModel('gpt-4o-mini-transcribe'), true);
  assert.equal(isLikelySttModel('gpt-4o'), false);
  assert.deepEqual(
    sttModelsFromList([{ id: 'whisper-1' }, { id: 'gpt-4o' }, { id: 'tts-1' }]).map((m) => m.id),
    ['whisper-1']
  );
});
