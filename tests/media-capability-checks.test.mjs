import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCapabilityChecks, runMediaCheck } from '../src/agent/mediaCapabilityChecks.js';
import { MEDIA_CACHE_KEY, DAY, evidenceDue } from '../src/agent/mediaCapabilityStore.js';
import { classifyMediaRejection } from '../src/agent/mediaRejection.js';
import { resolveChatMediaCapabilities, mediaModelKey } from '../src/agent/chatMedia.js';
import { scoreMediaCheck } from '../src/agent/mediaCheckSamples.js';

const base = 'https://openrouter.ai/api/v1';
// No catalog declaration: these checks exercise the unknown-capability path.
const models = [];
const baseSettings = { providerId: 'provider-a', apiBase: base, model: 'test/media', apiKey: 'secret-key' };

function memoryStorage(seed = {}) {
  const bag = structuredClone(seed);
  return {
    bag,
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(bag[key])])),
    set: async values => Object.assign(bag, structuredClone(values))
  };
}

function manager({ settings = baseSettings, modelsForBase = models, storage = memoryStorage(), run = async () => ({ state: 'supported' }), now = () => 1_000_000 } = {}) {
  let active = settings;
  const checks = new MediaCapabilityChecks({
    getSettings: async () => active,
    getModels: async () => ({ models: modelsForBase }),
    get: storage.get,
    set: storage.set,
    run,
    now,
    timeoutMs: 50
  });
  return { checks, storage, setSettings: next => { active = next; } };
}

test('context is a cache-only cross-session read and never starts a check', async () => {
  const storage = memoryStorage();
  const calls = [];
  const first = manager({ storage, run: async ({ kind }) => { calls.push(kind); return { state: 'supported' }; } });
  assert.deepEqual(await first.checks.request(), { queued: true });
  await first.checks.job.promise;
  assert.deepEqual(calls, ['image', 'audio', 'video']);

  const second = manager({ storage, run: async () => { throw new Error('context must not probe'); } });
  const context = await second.checks.context(baseSettings, models);
  assert.equal(context.current.inputs.audio.source, 'verified');
  assert.equal(context.current.inputs.video.source, 'verified');
  assert.equal(second.checks.job, null);
});

test('request coalesces a connection and discards a result after a model switch', async () => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const setup = manager({ run: async ({ kind }) => { started(kind); await pending; return { state: 'supported' }; } });

  assert.deepEqual(await setup.checks.request(), { queued: true });
  assert.deepEqual(await setup.checks.request(), { queued: true });
  await startedPromise;
  setup.setSettings({ ...baseSettings, model: 'other-model' });
  release();
  await setup.checks.job.promise;

  const fresh = manager({ storage: setup.storage });
  const context = await fresh.checks.context({ ...baseSettings, model: 'other-model' }, models);
  assert.equal(context.current.inputs.audio.source, 'unknown');
  assert.equal(context.current.inputs.video.source, 'unknown');
});

test('evidence TTLs prevent charges until each state is due again', async () => {
  const now = 90 * DAY;
  assert.equal(evidenceDue({ state: 'supported', checkedAt: now - 30 * DAY + 1 }, now), false);
  assert.equal(evidenceDue({ state: 'supported', checkedAt: now - 30 * DAY }, now), true);
  assert.equal(evidenceDue({ state: 'unsupported', checkedAt: now - 7 * DAY + 1 }, now), false);
  assert.equal(evidenceDue({ state: 'unsupported', checkedAt: now - 7 * DAY }, now), true);
  assert.equal(evidenceDue({ state: 'unknown', checkedAt: now - DAY + 1 }, now), false);
  assert.equal(evidenceDue({ state: 'unknown', checkedAt: now - DAY }, now), true);

  const storage = memoryStorage();
  let calls = 0;
  const setup = manager({ storage, now: () => now, run: async () => { calls++; return { state: 'supported' }; } });
  const { key } = await setup.checks.identify(baseSettings, models);
  storage.bag[MEDIA_CACHE_KEY] = { [key]: {
    image: { state: 'supported', checkedAt: now - 1, formats: ['image/jpeg'] },
    audio: { state: 'unsupported', checkedAt: now - 1, formats: ['audio/wav'] },
    video: { state: 'unknown', checkedAt: now - 1, formats: ['video/webm'] }
  } };
  await setup.checks.request();
  await setup.checks.job.promise;
  assert.equal(calls, 0);
});

test('only explicit media-format errors become negative evidence', () => {
  assert.equal(classifyMediaRejection(415, 'video/webm is not supported', ['video/webm']), 'video/webm');
  assert.equal(classifyMediaRejection(400, 'input_audio is not allowed', ['audio/wav']), 'audio/wav');
  assert.equal(classifyMediaRejection(400, 'video/webm too large', ['video/webm']), null);
  assert.equal(classifyMediaRejection(429, 'video/webm is unsupported', ['video/webm']), null);
  assert.equal(classifyMediaRejection(400, 'unsupported media', ['audio/wav', 'video/webm']), null);
});

test('a context refresh observes same-connection evidence and storage contains no plaintext key', async () => {
  const storage = memoryStorage();
  const setup = manager({ storage, run: async ({ kind }) => ({ state: kind === 'audio' ? 'supported' : 'unknown' }) });
  const context = await setup.checks.context(baseSettings, models);
  assert.equal(context.current.inputs.audio.state, 'unknown');
  await setup.checks.request();
  await setup.checks.job.promise;
  const refreshed = await context.refresh();
  assert.equal(refreshed.inputs.audio.state, 'supported');
  assert.equal(refreshed.inputs.audio.source, 'verified');
  assert.doesNotMatch(JSON.stringify(storage.bag), /secret-key/);
  assert.match(JSON.stringify(storage.bag), /FORMAT_REJECTED|supported|CHECK_UNAVAILABLE/);
});

test('a user override wins over cache evidence and suppresses that modality check', async () => {
  const overrideKey = mediaModelKey(base, 'test/media');
  const settings = { ...baseSettings, chatMediaOverrides: { [overrideKey]: { audio: false, transport: 'openrouter' } } };
  const calls = [];
  const setup = manager({ settings, run: async ({ kind }) => { calls.push(kind); return { state: 'supported' }; } });
  await setup.checks.request();
  await setup.checks.job.promise;
  assert.deepEqual(calls, ['image', 'video']);
  const context = await setup.checks.context(settings, models);
  assert.equal(context.current.inputs.audio.state, 'unsupported');
  assert.equal(context.current.inputs.audio.source, 'user');
});

test('synthetic answer scoring has separate video-frame and soundtrack evidence', () => {
  const sample = { expected: { video: 'CAB', audio: 'LHLHLH' } };
  assert.deepEqual(scoreMediaCheck('video', sample, '{"video":"CAB","audio":"LHLHLH"}'), {
    state: 'supported', videoAudio: 'verified'
  });
  assert.deepEqual(scoreMediaCheck('video', sample, '{"video":"CAB","audio":"wrong"}'), {
    state: 'supported', videoAudio: 'unknown'
  });
  assert.deepEqual(scoreMediaCheck('audio', sample, '{"audio":"wrong"}'), {
    state: 'unknown', error: 'ANSWER_MISMATCH'
  });
});

test('runMediaCheck uses one bundled SDK request and lifts its injected audio part', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: 'check', object: 'chat.completion', created: 1, model: 'test/media',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"audio":"LHLHLH"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const settings = { ...baseSettings, model: 'test/media' };
    const caps = resolveChatMediaCapabilities(settings, [{ id: 'test/media', inputModalities: ['audio'] }]);
    const result = await runMediaCheck({
      settings, caps, kind: 'audio', signal: new AbortController().signal,
      sampleFactory: async () => ({
        part: { type: 'file', mediaType: 'audio/wav', data: 'QUJD'.repeat(16) },
        expected: { audio: 'LHLHLH' }, prompt: 'Return JSON only.'
      })
    });
    assert.deepEqual(result, { state: 'supported' });
    assert.equal(requests.length, 1);
    const lifted = requests[0].body.messages.find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'input_audio'));
    assert.ok(lifted);
    assert.equal(lifted.content.find(part => part.type === 'input_audio').input_audio.format, 'wav');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
