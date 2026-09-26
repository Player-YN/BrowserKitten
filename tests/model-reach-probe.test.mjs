import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelReachProbeRequest,
  interpretModelReachProbeResponse,
  probeModelReach,
  MODEL_REACH_PROBE_PROMPT,
  MODEL_REACH_PROBE_MAX_TOKENS
} from '../src/agent/modelReachProbe.js';
import {
  CHAT_PROTOCOL_ANTHROPIC,
  CHAT_PROTOCOL_OPENAI,
  CHAT_PROTOCOL_RESPONSES,
  CHAT_PROTOCOL_AUTO
} from '../src/agent/llm.js';
import { ANTHROPIC_VERSION } from '../src/agent/anthropicProvider.js';

const EXAMPLE = 'https://llm.example.com/v1';

test('openai-compatible probe posts chat/completions with model and short ping', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'sk-test-key',
    model: 'acme-chat-7b',
    protocol: CHAT_PROTOCOL_OPENAI
  });
  assert.equal(req.ok, true);
  assert.equal(req.url, `${EXAMPLE}/chat/completions`);
  assert.equal(req.method, 'POST');
  assert.equal(req.wire, CHAT_PROTOCOL_OPENAI);
  assert.equal(req.body.model, 'acme-chat-7b');
  assert.equal(req.body.stream, false);
  assert.equal(req.body.max_tokens, MODEL_REACH_PROBE_MAX_TOKENS);
  assert.deepEqual(req.body.messages, [{ role: 'user', content: MODEL_REACH_PROBE_PROMPT }]);
  assert.equal(req.headers.Authorization, 'Bearer sk-test-key');
  assert.match(req.url, /chat\/completions$/);
  assert.doesNotMatch(req.url, /\/models$/);
  assert.equal(JSON.parse(req.bodyJson).model, 'acme-chat-7b');
});

test('anthropic probe posts messages with model and max_tokens 1', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-5',
    protocol: CHAT_PROTOCOL_ANTHROPIC
  });
  assert.equal(req.ok, true);
  assert.equal(req.url, `${EXAMPLE}/messages`);
  assert.equal(req.body.model, 'claude-sonnet-4-5');
  assert.equal(req.body.max_tokens, 1);
  assert.deepEqual(req.body.messages, [
    { role: 'user', content: [{ type: 'text', text: MODEL_REACH_PROBE_PROMPT }] }
  ]);
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.doesNotMatch(req.url, /chat\/completions/);
});

test('non-Zen non-OpenRouter host is used as given', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'm1',
    protocol: 'openai-compatible'
  });
  assert.equal(req.ok, true);
  assert.equal(req.url.startsWith(EXAMPLE), true);
  assert.equal(req.url.includes('opencode.ai'), false);
  assert.equal(req.url.includes('openrouter.ai'), false);
});

test('empty model does not substitute jev-1.13 or any default', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: '',
    protocol: CHAT_PROTOCOL_OPENAI
  });
  assert.equal(req.ok, false);
  assert.equal(req.code, 'NEED_MODEL');
  assert.equal(req.missing, 'model');
  assert.equal(JSON.stringify(req).includes('jev-1.13'), false);
});

test('openai-responses is not rewritten into chat completions', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'gpt-5.2',
    protocol: CHAT_PROTOCOL_RESPONSES
  });
  assert.equal(req.ok, false);
  assert.equal(req.code, 'CHAT_WIRE_RESPONSES_UNSUPPORTED');
  assert.equal(req.url, `${EXAMPLE}/responses`);
  assert.doesNotMatch(String(req.url || ''), /chat\/completions/);
});

test('auto protocol that resolves to responses stays unsupported', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'gpt-5-mini',
    protocol: CHAT_PROTOCOL_AUTO
  });
  assert.equal(req.ok, false);
  assert.equal(req.code, 'CHAT_WIRE_RESPONSES_UNSUPPORTED');
});

test('auto protocol can resolve to anthropic for claude model ids', () => {
  const req = buildModelReachProbeRequest({
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'claude-opus-4',
    protocol: CHAT_PROTOCOL_AUTO
  });
  assert.equal(req.ok, true);
  assert.equal(req.wire, CHAT_PROTOCOL_ANTHROPIC);
  assert.equal(req.url, `${EXAMPLE}/messages`);
});

test('interpret accepts openai choices and anthropic message envelopes', () => {
  assert.equal(
    interpretModelReachProbeResponse({
      wire: CHAT_PROTOCOL_OPENAI,
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: '' } }] }
    }).ok,
    true
  );
  assert.equal(
    interpretModelReachProbeResponse({
      wire: CHAT_PROTOCOL_ANTHROPIC,
      status: 200,
      body: { type: 'message', content: [{ type: 'text', text: '' }], role: 'assistant' }
    }).ok,
    true
  );
  assert.equal(
    interpretModelReachProbeResponse({
      wire: CHAT_PROTOCOL_OPENAI,
      status: 401,
      body: { error: { message: 'bad key' } }
    }).ok,
    false
  );
});

test('probeModelReach does not send when model empty and never invents jev-1.13', async () => {
  let called = 0;
  const result = await probeModelReach(
    { baseURL: EXAMPLE, apiKey: 'k', model: '' },
    async () => {
      called += 1;
      throw new Error('should not fetch');
    }
  );
  assert.equal(called, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NEED_MODEL');
  assert.equal(JSON.stringify(result).includes('jev-1.13'), false);
});

test('probeModelReach posts built request and reports success', async () => {
  /** @type {any} */
  let seen = null;
  const result = await probeModelReach(
    {
      baseURL: EXAMPLE,
      apiKey: 'sk-live',
      model: 'acme-1',
      protocol: CHAT_PROTOCOL_OPENAI
    },
    async (url, init) => {
      seen = { url, init };
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
      };
    }
  );
  assert.equal(result.ok, true);
  assert.equal(seen.url, `${EXAMPLE}/chat/completions`);
  assert.equal(seen.init.method, 'POST');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'acme-1');
  assert.equal(body.messages[0].content, 'ping');
  assert.equal(String(JSON.stringify(seen)).includes('sk-live'), true); // header only
  assert.equal(String(result.error || '').includes('sk-live'), false);
});
