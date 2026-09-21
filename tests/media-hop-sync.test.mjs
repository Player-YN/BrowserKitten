import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCapabilityChecks, runMediaCheck, checkTransport } from '../src/agent/mediaCapabilityChecks.js';
import { resolveChatMediaCapabilities, canSendChatMedia } from '../src/agent/chatMedia.js';
import { createExtensionFetch } from '../src/agent/provider.js';
import { makeOfficePrepareStep } from '../src/agent/vnext/sessionWorkspace/toolSchedule.js';
import { routeMediaInput } from '../src/agent/vnext/sessionWorkspace/mediaInput.js';
import { mediaStorageGet, mediaStorageSet } from '../src/agent/mediaCapabilityStore.js';

const settings = { providerId: 'p', apiBase: 'https://openrouter.ai/api/v1', model: 'alias', apiKey: 'secret' };
function harness() {
  const bag = {};
  const checks = new MediaCapabilityChecks({ getSettings: async () => settings, getModels: async () => ({ models: [] }),
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(bag[key])])),
    set: async values => Object.assign(bag, structuredClone(values)) });
  return { checks, bag };
}

test('next hop synchronizes instructions, tool routing and provider while old snapshots remain fixed', async () => {
  const { checks } = harness();
  const context = await checks.context(settings, []);
  const before = context.current;
  const { key } = await checks.identify(settings, []);
  await checks.update(key, 'audio', { state: 'supported', formats: ['audio/wav'], checkedAt: Date.now() });
  assert.equal(before.routes.nativeAudio, false);
  const step = await makeOfficePrepareStep({ instructions: 'base', mediaContext: context })();
  assert.match(step.instructions, /"nativeAudio":true/);
  assert.equal(before.routes.nativeAudio, false);
  const receipt = await routeMediaInput({ mediaContext: context, settings,
    fs: { readFileBytes: () => new Uint8Array(48), readFileMimeType: () => 'audio/wav' } },
  { path: '/scratch/audio.wav' });
  assert.equal(receipt.media.route, 'native');
  const previous = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response('{}'); };
  try {
    await createExtensionFetch({ mediaContext: context })(settings.apiBase + '/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: settings.model, messages: [
        { role: 'tool', tool_call_id: 'test', content: JSON.stringify(receipt.modelParts) }
      ] })
    });
    assert.ok(body.messages.at(-1).content.some(p => p.type === 'input_audio'));
  } finally { globalThis.fetch = previous; }
});

test('format rejection preserves other proven formats and never marks the entire modality unsupported', async () => {
  const { checks } = harness();
  const { key } = await checks.identify(settings, []);
  await checks.update(key, 'audio', { state: 'supported', formats: ['audio/wav'], checkedAt: Date.now() });
  const context = await checks.context(settings, []);
  await context.reject('audio/mpeg');
  await context.refresh();
  assert.equal(canSendChatMedia(context.current, 'audio/wav'), true);
  assert.equal(canSendChatMedia(context.current, 'audio/mpeg'), false);
});

test('business media rejection is learned once without request replay', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const learned = [];
  globalThis.fetch = async () => { calls++; return new Response('{"error":"video/webm is unsupported"}', { status: 415 }); };
  const caps = resolveChatMediaCapabilities(settings, [{ id: 'alias', inputModalities: ['video'] }]);
  try {
    const response = await createExtensionFetch({ mediaContext: { current: caps, reject: async mime => learned.push(mime) } })(
      settings.apiBase + '/chat/completions', { body: JSON.stringify({ model: 'alias', messages: [
        { role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/webm;base64,QUJD' } }] }
      ] }) });
    assert.equal(response.status, 415); assert.equal(calls, 1);
    assert.deepEqual(learned, ['video/webm']);
  } finally { globalThis.fetch = previous; }
});

test('check network failure never falls back to a proxy or retries and does not leak expected answers', async () => {
  const oldFetch = globalThis.fetch, oldChrome = globalThis.chrome;
  let requests = 0, proxy = 0;
  globalThis.chrome = { runtime: { sendMessage: async () => { proxy++; } } };
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.doesNotMatch(init.body, /PRIVATE_EXPECTED/);
    throw new TypeError('network failure');
  };
  try {
    await assert.rejects(runMediaCheck({ settings, caps: resolveChatMediaCapabilities(settings), kind: 'audio',
      signal: new AbortController().signal, sampleFactory: async () => ({
        part: { type: 'file', mediaType: 'audio/wav', data: 'QUJD'.repeat(16) },
        expected: { audio: 'PRIVATE_EXPECTED' }, prompt: 'Listen to the audio.'
      }) }));
    assert.equal(requests, 1); assert.equal(proxy, 0);
  } finally { globalThis.fetch = oldFetch; globalThis.chrome = oldChrome; }
});

test('offscreen storage bridge uses the worker result/values contract', async () => {
  const previous = globalThis.chrome, calls = [];
  globalThis.chrome = { runtime: { sendMessage: async msg => { calls.push(msg); return { ok: true, result: { example: true } }; } } };
  try {
    assert.deepEqual(await mediaStorageGet(['example']), { example: true });
    await mediaStorageSet({ example: false });
    assert.deepEqual(calls[1].values, { example: false });
    assert.equal(calls[1].action, 'storage_local_set');
  } finally { globalThis.chrome = previous; }
});

test('unknown gateway protocols never receive calibration samples, including images', async () => {
  for (const kind of ['image', 'audio', 'video']) assert.equal(checkTransport({ transport: 'none' }, kind), false);
  assert.equal(checkTransport({ transport: 'none', base: 'https://api.deepseek.com/v1' }, 'image'), true);
  assert.equal(checkTransport({ transport: 'none', base: 'https://api.deepseek.com/v1' }, 'audio'), false);
  assert.equal(checkTransport({ transport: 'none', base: 'https://api.deepseek.com/v1' }, 'video'), false);
});

test('catalog arriving during an image check prevents unnecessary audio/video checks', async () => {
  const bag = {}, calls = [];
  let models = [];
  const checks = new MediaCapabilityChecks({ getSettings: async () => settings, getModels: async () => ({ models }),
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(bag[key])])),
    set: async values => Object.assign(bag, structuredClone(values)),
    run: async ({ kind }) => { calls.push(kind); models = [{ id: settings.model, inputModalities: ['image', 'audio', 'video'] }]; return { state: 'supported' }; }
  });
  await checks.request(); await checks.job.promise;
  assert.deepEqual(calls, ['image']);
});

test('network failures cool down all remaining checks across offscreen restart', async () => {
  const bag = {}, calls = [];
  const options = { getSettings: async () => settings, getModels: async () => ({ models: [] }),
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(bag[key])])),
    set: async values => Object.assign(bag, structuredClone(values)),
    run: async ({ kind }) => { calls.push(kind); throw new TypeError('network unavailable'); }
  };
  const first = new MediaCapabilityChecks(options);
  await first.request(); await first.job.promise;
  const second = new MediaCapabilityChecks(options);
  await second.request(); await second.job.promise;
  assert.deepEqual(calls, ['image']);
});
