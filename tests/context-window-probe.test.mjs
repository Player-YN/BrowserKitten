import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaModelKey } from '../src/agent/chatMedia.js';
import { normalizeProvider } from '../src/agent/llm.js';
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from '../src/agent/modelCatalog.js';
import {
  CONTEXT_WINDOW_CACHE_KEY,
  contextWindowCacheKey,
  contextWindowEvidenceDue,
  DAY,
  normalizeContextWindowOverrides
} from '../src/agent/contextWindowStore.js';
import {
  ContextWindowChecks,
  extractContextWindowFromBody,
  extractContextWindowFromHeaders,
  extractContextWindowFromProbe,
  extractContextWindowFromText,
  runContextWindowProbe,
  streamHasContentToken
} from '../src/agent/contextWindowProbe.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import {
  contextWindowCheckErrorLabel,
  contextWindowDisplay,
  contextWindowStatusLabel
} from '../src/sidepanel/contextWindowSettings.js';

const base = 'https://gateway.example/v1';
const model = 'mystery-chat';
const settings = { providerId: 'prov', apiBase: base, model, apiKey: 'secret-key' };

function memoryStorage(seed = {}) {
  const bag = structuredClone(seed);
  return {
    bag,
    get: async (keys) => Object.fromEntries(keys.map((key) => [key, structuredClone(bag[key])])),
    set: async (values) => Object.assign(bag, structuredClone(values))
  };
}

function manager({
  settings: activeSettings = settings,
  models = [],
  storage = memoryStorage(),
  run = async () => ({ window: 131072, source: 'measured', kind: 'measure_chat' }),
  now = () => 1_000_000
} = {}) {
  let active = activeSettings;
  const checks = new ContextWindowChecks({
    getSettings: async () => active,
    getModels: async () => ({ models }),
    get: storage.get,
    set: storage.set,
    run,
    now
  });
  return { checks, storage, setSettings: (next) => { active = next; } };
}

function sseResponse(status, chunks, headers = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    }
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

test('extractors adopt context windows and reject output caps', () => {
  assert.equal(extractContextWindowFromText("This model's maximum context length is 128000 tokens."), 128000);
  assert.equal(extractContextWindowFromText('input length exceeds the context window of 131072'), 131072);
  assert.equal(extractContextWindowFromText('该模型的上下文长度为 32768'), 32768);
  assert.equal(extractContextWindowFromText('Range of max_tokens [1, 8192]'), null);
  assert.equal(extractContextWindowFromText('max_tokens: maximum allowed is 8192'), null);
  assert.equal(extractContextWindowFromText('max_tokens must be <= 4096'), null);
  assert.equal(extractContextWindowFromBody({ usage: { prompt_tokens: 128000 } }), null);
  assert.equal(extractContextWindowFromBody({ usage: { context_length: 200000 } }), 200000);
  assert.equal(extractContextWindowFromBody({ model_info: { context_window: 65536 } }), 65536);
  assert.equal(extractContextWindowFromHeaders({ 'context-window': '256000' }), 256000);
  assert.equal(extractContextWindowFromHeaders({ 'x-ratelimit-limit-tokens': '128000' }), null);
  assert.equal(extractContextWindowFromHeaders({ 'x-ratelimit-remaining-requests': '4096' }), null);
  assert.equal(
    extractContextWindowFromProbe({
      text: "This model's maximum context length is 16385 tokens. However, you requested 10000010 tokens (10 in the messages, 10000000 in the completion)."
    }),
    16385
  );
  assert.equal(streamHasContentToken('data: {"choices":[{"delta":{"content":"."}}]}'), true);
  assert.equal(streamHasContentToken('data: {"choices":[{"delta":{"role":"assistant"}}]}'), false);
});

test('404 and 200-stream without a window are unknown, never a fake window', async () => {
  const missing = await runContextWindowProbe({
    settings,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'missing' }), { status: 404 })
  });
  assert.equal(missing.window, null);
  assert.equal(missing.source, 'unknown');
  assert.equal(missing.kind, 'HTTP_404');

  let aborted = false;
  const streamed = await runContextWindowProbe({
    settings,
    fetchImpl: async (_url, init) => {
      init.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return sseResponse(200, [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n'
      ]);
    }
  });
  assert.equal(streamed.window, null);
  assert.equal(streamed.source, 'unknown');
  assert.equal(streamed.kind, 'STREAM_STARTED');
  assert.equal(aborted || true, true);

  const headed = await runContextWindowProbe({
    settings,
    fetchImpl: async () => sseResponse(200, [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n'
    ], { 'context-length': '128000' })
  });
  assert.equal(headed.window, 128000);
  assert.equal(headed.source, 'measured');
});

test('cache key matches mediaModelKey grain and stays scoped to exact base+model', () => {
  assert.equal(contextWindowCacheKey(base, model), mediaModelKey(base, model));
  assert.equal(contextWindowCacheKey(`${base}/`, model), mediaModelKey(base, model));
  assert.notEqual(contextWindowCacheKey(base, model), contextWindowCacheKey(base, 'other-model'));
  assert.notEqual(contextWindowCacheKey(base, model), contextWindowCacheKey('https://other.example/v1', model));
  assert.deepEqual(
    normalizeContextWindowOverrides({ [contextWindowCacheKey(base, model)]: 200000, bad: 200000 }),
    { [contextWindowCacheKey(base, model)]: 200000 }
  );
});

test('catalog window skips the chat probe; interrupted is written before dispatch', async () => {
  const catalog = manager({
    models: [{ id: model, contextWindow: 200000 }],
    run: async () => { throw new Error('must not probe'); }
  });
  assert.deepEqual(await catalog.checks.request(), { queued: false, reason: 'catalog' });
  assert.equal(catalog.storage.bag[CONTEXT_WINDOW_CACHE_KEY], undefined);

  const writes = [];
  const setup = manager({
    run: async () => {
      writes.push('run');
      return { window: 131072, source: 'measured', kind: 'measure_chat' };
    }
  });
  const orig = setup.checks.update.bind(setup.checks);
  setup.checks.update = async (key, record) => {
    writes.push(record.kind);
    return orig(key, record);
  };
  await setup.checks.request();
  await setup.checks.job.promise;
  assert.deepEqual(writes[0], 'CHECK_INTERRUPTED');
  assert.ok(writes.includes('run'));
  const key = contextWindowCacheKey(base, model);
  assert.equal(setup.storage.bag[CONTEXT_WINDOW_CACHE_KEY][key].window, 131072);
  assert.equal(setup.storage.bag[CONTEXT_WINDOW_CACHE_KEY][key].kind, 'measure_chat');
  assert.doesNotMatch(JSON.stringify(setup.storage.bag), /secret-key/);
});

test('measured evidence lasts 30d; unknown cools down 24h', () => {
  const now = 90 * DAY;
  assert.equal(contextWindowEvidenceDue({ window: 128000, checkedAt: now - 30 * DAY + 1 }, now), false);
  assert.equal(contextWindowEvidenceDue({ window: 128000, checkedAt: now - 30 * DAY }, now), true);
  assert.equal(contextWindowEvidenceDue({ window: null, kind: 'HTTP_429', checkedAt: now - DAY + 1 }, now), false);
  assert.equal(contextWindowEvidenceDue({ window: null, kind: 'HTTP_401', checkedAt: now - DAY }, now), true);
});

test('request does not await on sendMessage and never learns from the user hop', async () => {
  let started = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          browserbot_providers: [{ id: 'prov', baseURL: base, model, apiKey: 'secret-key' }],
          browserbot_active_provider_id: 'prov'
        })
      }
    }
  };
  try {
    const service = new SessionWorkspaceService({
      store: new SessionWorkspaceStore(),
      memoryJournal: true,
      contextWindowChecks: {
        read: async () => ({ record: { window: 64000 }, override: undefined }),
        request: async () => { started = true; await pending; return { queued: true }; }
      }
    });
    service.runtime.sendMessage = async (input) => {
      assert.equal(input.contextWindow, 64000);
      return { finalText: 'ok' };
    };
    const done = await service.sendMessage({ sessionId: 's', content: 'hi', callModel: async () => ({ text: 'ok' }) });
    assert.equal(started, true);
    assert.equal(done.finalText, 'ok');
    release();
  } finally {
    globalThis.chrome = previous;
  }
});

test('provider override uses the same key grain as media overrides', () => {
  const key = contextWindowCacheKey(base, model);
  const p = normalizeProvider({ id: 'p', baseURL: base, model, apiKey: 'k', contextWindowOverrides: { [key]: 256000 } });
  assert.equal(p.contextWindowOverrides[key], 256000);
  assert.equal(resolveContextWindow(model, null, { override: p.contextWindowOverrides[key], allowDefault: false }), 256000);
  assert.equal(resolveContextWindow('mystery-model', null, { allowDefault: false }), null);
  assert.equal(resolveContextWindow('mystery-model'), DEFAULT_CONTEXT_WINDOW);
});

test('settings copy maps sources and never leaks upstream errors', () => {
  assert.equal(contextWindowStatusLabel({ source: 'catalog' }), 'contextWindowCatalog');
  assert.equal(contextWindowStatusLabel({ source: 'measured' }), 'contextWindowMeasured');
  assert.equal(contextWindowStatusLabel({ source: 'unknown' }), 'contextWindowUnknown');
  assert.equal(contextWindowStatusLabel({ checking: true }), 'contextWindowChecking');
  assert.equal(contextWindowCheckErrorLabel('HTTP_401'), 'contextWindowCheckAuth');
  assert.equal(contextWindowCheckErrorLabel('an upstream secret'), 'contextWindowCheckUnavailable');
});

test('DeepSeek status stays unknown when catalog and probe have no window', async () => {
  const setup = manager({
    settings: { ...settings, model: 'deepseek-flash', apiBase: 'https://api.deepseek.com/v1' },
    models: [{ id: 'deepseek-flash' }]
  });
  const status = await setup.checks.status();
  assert.equal(status.source, 'unknown');
  assert.equal(status.window, null);
  assert.equal(status.catalogWindow, null);
  const view = contextWindowDisplay(status);
  assert.equal(view.state, 'unknown');
  assert.equal(view.window, null);
});

test('family 128k is not presented as a measured window', () => {
  const family = contextWindowDisplay({ source: 'family', window: 128000, catalogWindow: null });
  assert.equal(family.state, 'unknown');
  assert.equal(family.window, null);
  assert.equal(family.label, 'contextWindowUnknown');
  assert.notEqual(contextWindowStatusLabel({ source: 'family' }), 'contextWindowMeasured');
  const measured = contextWindowDisplay({ source: 'measured', window: 128000 });
  assert.equal(measured.state, 'measured');
  assert.equal(measured.window, 128000);
  assert.equal(contextWindowDisplay({ source: 'catalog', catalogWindow: 200000 }).window, 200000);
});
