import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionFetch } from '../src/agent/provider.js';
import {
  executeLlmProxyFetch,
  isAllowedLlmProxyUrl,
  llmProxyFailure,
  reconstructLlmProxyResponse,
  sanitizeLlmProxyHeaders,
  serializeLlmProxyBody
} from '../src/agent/llmProxyFetch.js';

const url = 'https://openrouter.ai/api/v1/chat/completions';
const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';

function withFetchChrome({ fetchImpl, sendMessage }) {
  const previous = { fetch: globalThis.fetch, chrome: globalThis.chrome };
  globalThis.fetch = fetchImpl;
  globalThis.chrome = sendMessage
    ? { runtime: { sendMessage } }
    : previous.chrome;
  return () => {
    globalThis.fetch = previous.fetch;
    globalThis.chrome = previous.chrome;
  };
}

test('unsafe headers are stripped; authorization and content-type stay', () => {
  const out = sanitizeLlmProxyHeaders({
    Authorization: 'Bearer secret',
    'Content-Type': 'application/json',
    'User-Agent': 'ai-sdk/provider-utils/5.0.20',
    Origin: 'chrome-extension://abc',
    Host: 'openrouter.ai',
    'x-paw-internal-no-retry': '1'
  });
  assert.equal(out.Authorization, 'Bearer secret');
  assert.equal(out['Content-Type'], 'application/json');
  assert.equal(out['User-Agent'], undefined);
  assert.equal(out.Origin, undefined);
  assert.equal(out['x-paw-internal-no-retry'], undefined);
});

test('stream and byte bodies serialize to the JSON text the SW can sendMessage', async () => {
  const json = '{"model":"test"}';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json));
      controller.close();
    }
  });
  assert.equal(await serializeLlmProxyBody(stream), json);
  assert.equal(await serializeLlmProxyBody(new TextEncoder().encode(json)), json);
  assert.equal(await serializeLlmProxyBody(json), json);
});

test('proxy allowlist stays https plus loopback http', () => {
  assert.equal(isAllowedLlmProxyUrl('https://api.deepseek.com/v1/chat/completions').ok, true);
  assert.equal(isAllowedLlmProxyUrl('http://127.0.0.1:11434/v1/chat/completions').ok, true);
  assert.equal(isAllowedLlmProxyUrl('http://localhost:11434/v1').ok, true);
  assert.equal(isAllowedLlmProxyUrl('http://192.168.1.10:11434/v1').error, 'Blocked non-HTTPS LLM endpoint');
  assert.equal(isAllowedLlmProxyUrl('').error, 'Missing url');
});

test('SW proxy fetch drops unsafe headers and preserves SSE content-type', async () => {
  let seen;
  const res = await executeLlmProxyFetch({
    url,
    method: 'POST',
    headers: {
      authorization: 'Bearer k',
      'user-agent': 'ai-sdk/openai-compatible',
      'content-type': 'application/json'
    },
    body: '{"stream":true}'
  }, async (_url, init) => {
    seen = init;
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.equal(seen.headers.authorization, 'Bearer k');
  assert.equal(seen.headers['user-agent'], undefined);
  assert.equal(seen.body, '{"stream":true}');
  assert.equal(res.ok, true);
  assert.equal(res.contentType, 'text/event-stream');
  assert.equal(res.text, sse);
  assert.equal(res.json, null);
  const rebuilt = reconstructLlmProxyResponse(res);
  assert.equal(rebuilt.headers.get('content-type'), 'text/event-stream');
  assert.equal(await rebuilt.text(), sse);
});

test('direct success never calls the background proxy', async () => {
  let proxies = 0;
  const restore = withFetchChrome({
    fetchImpl: async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }),
    sendMessage: async () => { proxies++; return { ok: false, error: 'unused' }; }
  });
  try {
    const res = await createExtensionFetch()(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'User-Agent': 'ai-sdk' },
      body: JSON.stringify({ model: 'x', messages: [] })
    });
    assert.equal(res.status, 200);
    assert.equal(proxies, 0);
  } finally { restore(); }
});

test('direct Failed to fetch completes via SW proxy and does not rethrow TypeError', async () => {
  let sent;
  const restore = withFetchChrome({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async (msg) => {
      sent = msg;
      return { ok: true, status: 200, text: sse, contentType: 'text/event-stream' };
    }
  });
  try {
    const res = await createExtensionFetch()(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'User-Agent': 'ai-sdk/provider-utils' },
      body: JSON.stringify({ model: 'x', stream: true, messages: [] })
    });
    assert.equal(sent.target, 'browserbot-background');
    assert.equal(sent.action, 'llm_proxy_fetch');
    assert.equal(sent.url, url);
    assert.equal(sent.headers.authorization, 'Bearer k');
    assert.equal(sent.headers['user-agent'], undefined);
    assert.match(sent.body, /"stream":true/);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), sse);
  } finally { restore(); }
});

test('ReadableStream request body is buffered then proxied instead of throwing Failed to fetch', async () => {
  let sent;
  const restore = withFetchChrome({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async (msg) => {
      sent = msg;
      return { ok: true, status: 200, json: { choices: [] }, contentType: 'application/json' };
    }
  });
  try {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"stream-body"}'));
        controller.close();
      }
    });
    const res = await createExtensionFetch()(url, { method: 'POST', body });
    assert.equal(sent.body, '{"model":"stream-body"}');
    assert.equal(res.status, 200);
  } finally { restore(); }
});

test('proxy transport failure is LLM_PROXY_FAILED, not the original TypeError', async () => {
  const restore = withFetchChrome({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async () => { throw new Error('The message port closed before a response was received'); }
  });
  try {
    await assert.rejects(
      () => createExtensionFetch()(url, { method: 'POST', body: '{}' }),
      (err) => {
        assert.notEqual(err.name, 'TypeError');
        assert.equal(err.code, 'LLM_PROXY_FAILED');
        assert.match(err.message, /message port closed/);
        assert.equal(err.directError instanceof TypeError, true);
        return true;
      }
    );
  } finally { restore(); }
});

test('SW fetch failure is a proxy error, not a recycled TypeError', async () => {
  const restore = withFetchChrome({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async () => ({ ok: false, error: 'Failed to fetch' })
  });
  try {
    await assert.rejects(
      () => createExtensionFetch()(url, { method: 'POST', body: '{}' }),
      (err) => {
        assert.equal(err.code, 'LLM_PROXY_FAILED');
        assert.match(err.message, /Background LLM proxy failed: Failed to fetch/);
        return true;
      }
    );
  } finally { restore(); }
});

test('noRetry and abort skip the background proxy', async () => {
  let proxies = 0;
  const restore = withFetchChrome({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async () => { proxies++; return { ok: true, status: 200, text: '{}' }; }
  });
  try {
    await assert.rejects(() => createExtensionFetch({ noRetry: true })(url, { body: '{}' }), /Failed to fetch/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => createExtensionFetch()(url, { body: '{}', signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );
    assert.equal(proxies, 0);
  } finally { restore(); }
});

test('llmProxyFailure keeps both direct and proxy causes', () => {
  const err = llmProxyFailure(new TypeError('Failed to fetch'), new Error('empty'));
  assert.equal(err.code, 'LLM_PROXY_FAILED');
  assert.equal(err.directError.message, 'Failed to fetch');
  assert.equal(err.cause.message, 'empty');
});

test('the purpose tag reaches only the Browser Kitten API, never the user\'s own provider', async () => {
  const seen = [];
  const restore = withFetchChrome({
    fetchImpl: async (target, init) => {
      seen.push({ target: String(target), purpose: new Headers(init.headers).get('x-bk-purpose') });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
  });
  try {
    const doFetch = createExtensionFetch();
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-bk-purpose': 'compact' }, body: '{"model":"m","messages":[]}' };
    await doFetch('https://browserkitten.com/api/v1/chat/completions', init);
    await doFetch('https://api.deepseek.com/v1/chat/completions', init);
    await doFetch('https://browserkitten.com.evil.test/api/v1/chat/completions', init);
  } finally {
    restore();
  }
  assert.deepEqual(seen.map((s) => s.purpose), ['compact', null, null]);
});

test('the client version tag reaches only the Browser Kitten API, with the manifest version', async () => {
  const seen = [];
  const previous = { fetch: globalThis.fetch, chrome: globalThis.chrome };
  globalThis.fetch = async (target, init) => {
    seen.push({ target: String(target), client: new Headers(init.headers).get('x-bk-client') });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '1.2.3' }) } };
  try {
    const doFetch = createExtensionFetch();
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-bk-client': 'spoofed/9' }, body: '{"model":"m","messages":[]}' };
    await doFetch('https://browserkitten.com/api/v1/chat/completions', init);
    await doFetch('https://api.deepseek.com/v1/chat/completions', init);
    await doFetch('https://browserkitten.com.evil.test/api/v1/chat/completions', init);
    globalThis.chrome = undefined;
    await doFetch('https://browserkitten.com/api/v1/chat/completions', init);
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.chrome = previous.chrome;
  }
  assert.deepEqual(seen.map((s) => s.client), ['browser-kitten/1.2.3', null, null, null]);
});
