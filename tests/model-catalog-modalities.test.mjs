import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheModelsForBase,
  loadCachedModelsForBase,
  normalizeCatalogInputModalities,
  modelsEndpointURL,
  parseCatalogInputModalities,
  parseModelsResponse,
  resolveContextWindow,
  isMissingModelsCatalogError,
  refreshAndCacheModels,
  DEFAULT_CONTEXT_WINDOW
} from '../src/agent/modelCatalog.js';

test('normalizes only documented media names from explicit input arrays', () => {
  assert.deepEqual(normalizeCatalogInputModalities(['Text', 'Image', 'Audio', 'Video', 'File', 'image']), [
    'text', 'image', 'audio', 'video', 'file'
  ]);
  assert.equal(normalizeCatalogInputModalities('Text,Image'), null);
  assert.equal(normalizeCatalogInputModalities(['vision', 'omni', 'embedding']), null);
});

test('OpenRouter architecture input modalities survive catalog parsing', () => {
  const models = parseModelsResponse({
    data: [{
      id: 'qwen/qwen-omni',
      architecture: { input_modalities: ['text', 'image', 'audio', 'video'], output_modalities: ['text', 'audio'] }
    }]
  });
  assert.deepEqual(models, [{
    id: 'qwen/qwen-omni',
    inputModalities: ['text', 'image', 'audio', 'video'],
    inputModalitiesSource: 'architecture.input_modalities'
  }]);
});

test('DashScope model catalog reads request_modality and output never becomes input', () => {
  const models = parseModelsResponse({
    output: {
      models: [{
        model: 'qwen-omni-turbo',
        name: 'Qwen Omni Turbo',
        capabilities: ['TG', 'Multimodal-Omni'],
        inference_metadata: { request_modality: ['Text', 'Image', 'Audio', 'Video'], response_modality: ['Text', 'Audio'] },
        model_info: { context_window: 32768 }
      }, {
        model: 'qwen-text-only',
        capabilities: ['VU'],
        inference_metadata: { response_modality: ['Text'] }
      }]
    }
  });
  assert.deepEqual(models[0], {
    id: 'qwen-omni-turbo',
    name: 'Qwen Omni Turbo',
    inputModalities: ['text', 'image', 'audio', 'video'],
    inputModalitiesSource: 'inference_metadata.request_modality',
    contextWindow: 32768
  });
  assert.deepEqual(models[1], { id: 'qwen-text-only' });
});

test('DashScope compatible chat bases use its documented rich model catalog endpoint', () => {
  assert.equal(
    modelsEndpointURL('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/api/v1/models'
  );
  assert.equal(
    modelsEndpointURL('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'),
    'https://dashscope-intl.aliyuncs.com/api/v1/models'
  );
  assert.equal(
    modelsEndpointURL('https://gateway.example/v1'),
    'https://gateway.example/v1/models'
  );
});

test('compatible input_modalities are accepted but outputs and vague flags are ignored', () => {
  assert.deepEqual(parseCatalogInputModalities({ input_modalities: ['text', 'image'] }), {
    modalities: ['text', 'image'], source: 'input_modalities'
  });
  assert.equal(parseCatalogInputModalities({ architecture: { output_modalities: ['audio'] } }), null);
  assert.equal(parseCatalogInputModalities({ capabilities: ['VU', 'Multimodal-Omni'] }), null);
});

test('DeepSeek/OpenAI basic model rows remain unknown rather than being marked text-only', () => {
  assert.deepEqual(parseModelsResponse({
    object: 'list',
    data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }]
  }), [{ id: 'deepseek-chat' }]);
});

test('runtime-only offscreen bridge reads and writes catalog cache, while bridge errors reject', async () => {
  const previous = globalThis.chrome;
  const saved = {};
  const calls = [];
  globalThis.chrome = { runtime: { sendMessage: async message => {
    calls.push(message);
    if (message.action === 'storage_local_get') return { ok: true, result: structuredClone(saved) };
    if (message.action === 'storage_local_set') { Object.assign(saved, structuredClone(message.values)); return { ok: true }; }
    return { ok: false, error: 'unexpected' };
  } } };
  try {
    const base = 'https://gateway.example/v1';
    const rows = [{ id: 'model-a', inputModalities: ['text', 'audio'] }];
    await cacheModelsForBase(base, rows);
    assert.deepEqual((await loadCachedModelsForBase(base)).models, rows);
    assert.deepEqual(calls.map(call => call.action), ['storage_local_get', 'storage_local_set', 'storage_local_get']);
  } finally { globalThis.chrome = previous; }

  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: 'bridge unavailable' }) } };
  try {
    await assert.rejects(cacheModelsForBase('https://gateway.example/v1', []), /bridge unavailable/);
    await assert.rejects(loadCachedModelsForBase('https://gateway.example/v1'), /bridge unavailable/);
  } finally { globalThis.chrome = previous; }
});

test('catalog cache requires an exact normalized base URL before exposing media declarations', async () => {
  const previous = globalThis.chrome;
  const bag = {};
  globalThis.chrome = { storage: { local: {
    get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, bag[key]]))); },
    set(values, callback) { Object.assign(bag, structuredClone(values)); callback(); }
  } } };
  try {
    const source = 'https://gateway.example/v1';
    const rows = [{ id: 'alias', inputModalities: ['audio'] }];
    await cacheModelsForBase(source, rows);
    assert.deepEqual((await loadCachedModelsForBase(source)).models, rows);
    // Simulate a legacy/cache-key collision: exact base validation remains the
    // last guard even if a caller obtains the same host cache slot.
    const key = Object.keys(bag.browserbot_model_catalog_cache)[0];
    bag.browserbot_model_catalog_cache[key].baseURL = 'https://gateway.example/v2';
    assert.deepEqual(await loadCachedModelsForBase(source), { models: [], fetchedAt: null });
  } finally { globalThis.chrome = previous; }
});

test('context window: catalog then family; unknown is not displayed as 128k', () => {
  assert.equal(resolveContextWindow('alias', { contextWindow: 64000 }), 64000);
  assert.equal(resolveContextWindow('anthropic/claude-sonnet-4'), 200_000);
  assert.equal(resolveContextWindow('mystery-model'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow('mystery-model', null, { allowDefault: false }), null);
  assert.equal(isMissingModelsCatalogError({ status: 404, message: 'HTTP 404' }), true);
  assert.equal(isMissingModelsCatalogError({ message: 'HTTP404' }), true);
  assert.equal(isMissingModelsCatalogError({ status: 401, message: 'HTTP 401' }), false);
});

test('context window prefers user override, then measured, then catalog, then family', () => {
  const entry = { contextWindow: 64000 };
  const evidence = { window: 131072, source: 'measured', kind: 'measure_chat' };
  assert.equal(resolveContextWindow('mystery', entry, { override: 200000, evidence }), 200000);
  assert.equal(resolveContextWindow('mystery', entry, { evidence }), 131072);
  assert.equal(resolveContextWindow('mystery', entry, { evidence: { window: null } }), 64000);
  assert.equal(
    resolveContextWindow('alias', { contextWindow: 8000 }, {
      overrides: { 'https://gateway.example/v1\nalias': 256000 },
      baseURL: 'https://gateway.example/v1/'
    }),
    256000
  );
  assert.equal(resolveContextWindow('anthropic/claude-sonnet-4', null, { allowDefault: false }), 200_000);
  assert.equal(resolveContextWindow('mystery-model', null, { allowDefault: false, evidence: { window: 4096 } }), 4096);
});

test('refreshAndCacheModels keeps stale rows when GET /models is 404', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const bag = {};
  globalThis.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          callback(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, bag[key]])));
        },
        set(values, callback) {
          Object.assign(bag, structuredClone(values));
          callback();
        }
      }
    }
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
  try {
    const base = 'https://no-catalog.example/v1';
    await cacheModelsForBase(base, [{ id: 'kept-model' }]);
    const models = await refreshAndCacheModels(base, 'sk-test');
    assert.equal(models.some((m) => m.id === 'kept-model'), true);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
