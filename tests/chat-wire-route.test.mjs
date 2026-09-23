import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChatWire,
  buildChatEndpointUrl,
  inferChatWireFromModelId,
  isAnthropicApiBase
} from '../src/agent/chatWireRoute.js';
import {
  normalizeProvider,
  normalizeChatProtocol,
  isChatProvider,
  isJevProvider,
  anthropicMessagesUrl,
  openaiChatCompletionsUrl,
  openaiResponsesUrl,
  systemOneUrl,
  CHAT_PROTOCOL_ANTHROPIC,
  CHAT_PROTOCOL_OPENAI,
  CHAT_PROTOCOL_RESPONSES,
  CHAT_PROTOCOL_AUTO,
  DEFAULT_CHAT_PROTOCOL
} from '../src/agent/llm.js';
import {
  buildAnthropicMessagesRequest,
  convertAnthropicResponseToDoGenerate,
  anthropicRequestHeaders,
  ANTHROPIC_VERSION
} from '../src/agent/anthropicProvider.js';

const EXAMPLE = 'https://llm.example.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';
const ZEN = 'https://opencode.ai/zen/v1';

test('omitted protocol on a generic host defaults to openai-compatible', () => {
  const route = resolveChatWire({
    baseURL: EXAMPLE,
    model: 'claude-sonnet-4-5'
  });
  assert.equal(route.supported, true);
  assert.equal(route.protocol, CHAT_PROTOCOL_OPENAI);
  assert.equal(route.source, 'default');
  assert.equal(route.url, `${EXAMPLE}/chat/completions`);
});

test('explicit anthropic wins on any base URL including example.com', () => {
  const route = resolveChatWire({
    baseURL: EXAMPLE,
    model: 'anything',
    protocol: 'anthropic'
  });
  assert.equal(route.source, 'explicit');
  assert.equal(route.protocol, CHAT_PROTOCOL_ANTHROPIC);
  assert.equal(route.url, `${EXAMPLE}/messages`);
});

test('explicit openai-compatible wins even on api.anthropic.com', () => {
  const route = resolveChatWire({
    baseURL: ANTHROPIC,
    model: 'claude-sonnet-4-20250514',
    protocol: CHAT_PROTOCOL_OPENAI
  });
  assert.equal(route.source, 'explicit');
  assert.equal(route.protocol, CHAT_PROTOCOL_OPENAI);
  assert.equal(route.url, `${ANTHROPIC}/chat/completions`);
});

test('omitted protocol on api.anthropic.com defaults to anthropic messages', () => {
  assert.equal(isAnthropicApiBase(ANTHROPIC), true);
  assert.equal(isAnthropicApiBase(EXAMPLE), false);
  const route = resolveChatWire({
    baseURL: ANTHROPIC,
    model: 'claude-sonnet-4-20250514'
  });
  assert.equal(route.source, 'host');
  assert.equal(route.protocol, CHAT_PROTOCOL_ANTHROPIC);
  assert.equal(route.url, `${ANTHROPIC}/messages`);
});

test('openai-responses is unsupported and not remapped to chat completions', () => {
  const route = resolveChatWire({
    baseURL: EXAMPLE,
    model: 'gpt-5.5',
    protocol: CHAT_PROTOCOL_RESPONSES
  });
  assert.equal(route.supported, false);
  assert.equal(route.code, 'CHAT_WIRE_RESPONSES_UNSUPPORTED');
  assert.equal(route.protocol, CHAT_PROTOCOL_RESPONSES);
  assert.equal(route.url, `${EXAMPLE}/responses`);
  assert.notEqual(route.url, `${EXAMPLE}/chat/completions`);
});

test('auto mode on a generic multiplex base routes by model id', () => {
  assert.equal(
    resolveChatWire({ baseURL: EXAMPLE, model: 'claude-opus-4-6', protocol: 'auto' }).url,
    `${EXAMPLE}/messages`
  );
  assert.equal(
    resolveChatWire({ baseURL: EXAMPLE, model: 'qwen3.7-max', protocol: 'auto' }).url,
    `${EXAMPLE}/messages`
  );
  assert.equal(
    resolveChatWire({ baseURL: EXAMPLE, model: 'deepseek-v4-flash', protocol: 'auto' }).url,
    `${EXAMPLE}/chat/completions`
  );
  const responses = resolveChatWire({
    baseURL: EXAMPLE,
    model: 'gpt-5.5',
    protocol: 'auto'
  });
  assert.equal(responses.supported, false);
  assert.equal(responses.code, 'CHAT_WIRE_RESPONSES_UNSUPPORTED');
});

test('auto mode never sends jev models through chat completions', () => {
  const route = resolveChatWire({
    baseURL: EXAMPLE,
    model: 'jev-1.13',
    protocol: 'auto'
  });
  assert.equal(route.supported, false);
  assert.equal(route.wire, 'systemone');
  assert.equal(route.code, 'CHAT_WIRE_JEV');
  assert.equal(route.url, `${EXAMPLE}/systemone`);
});

test('Zen fixture: auto protocol (not hostname allowlist) multiplexes like the catalog', () => {
  assert.equal(
    resolveChatWire({ baseURL: ZEN, model: 'claude-sonnet-4-5', protocol: 'auto' }).url,
    `${ZEN}/messages`
  );
  assert.equal(
    resolveChatWire({ baseURL: ZEN, model: 'deepseek-v4-flash', protocol: 'auto' }).url,
    `${ZEN}/chat/completions`
  );
  // Without auto, Zen is a normal unknown host → chat completions even for Claude.
  assert.equal(
    resolveChatWire({ baseURL: ZEN, model: 'claude-sonnet-4-5' }).url,
    `${ZEN}/chat/completions`
  );
});

test('URL builders are generic and do not double-append /v1', () => {
  assert.equal(openaiChatCompletionsUrl(EXAMPLE), `${EXAMPLE}/chat/completions`);
  assert.equal(anthropicMessagesUrl(EXAMPLE), `${EXAMPLE}/messages`);
  assert.equal(openaiResponsesUrl(EXAMPLE), `${EXAMPLE}/responses`);
  assert.equal(systemOneUrl(EXAMPLE), `${EXAMPLE}/systemone`);
  assert.equal(systemOneUrl('https://gateway.example.com'), 'https://gateway.example.com/v1/systemone');
  assert.equal(systemOneUrl(`${EXAMPLE}/systemone`), `${EXAMPLE}/systemone`);
  assert.equal(buildChatEndpointUrl(EXAMPLE, { protocol: 'anthropic' }), `${EXAMPLE}/messages`);
  assert.equal(buildChatEndpointUrl(EXAMPLE, {}), `${EXAMPLE}/chat/completions`);
});

test('protocol field round-trips on chat providers; jev ignores chat protocol', () => {
  assert.equal(normalizeChatProtocol(''), null);
  assert.equal(normalizeChatProtocol('auto'), CHAT_PROTOCOL_AUTO);
  assert.equal(normalizeChatProtocol('openai-responses'), CHAT_PROTOCOL_RESPONSES);
  assert.equal(DEFAULT_CHAT_PROTOCOL, CHAT_PROTOCOL_OPENAI);

  const chat = normalizeProvider({
    id: 'c1',
    name: 'Custom',
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'm1',
    protocol: 'auto'
  });
  assert.equal(chat.protocol, CHAT_PROTOCOL_AUTO);
  assert.equal(isChatProvider(chat), true);

  const omitted = normalizeProvider({
    id: 'c2',
    name: 'Custom',
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'm1'
  });
  assert.equal(omitted.protocol, undefined);

  const jev = normalizeProvider({
    id: 'j1',
    purpose: 'jev',
    name: 'Jev',
    baseURL: EXAMPLE,
    apiKey: 'k',
    model: 'jev-1.13',
    protocol: 'anthropic'
  });
  assert.equal(isJevProvider(jev), true);
  assert.equal(isChatProvider(jev), false);
  assert.equal(jev.protocol, undefined);
});

test('Anthropic request maps tools and tool_result for ToolLoopAgent', () => {
  const body = buildAnthropicMessagesRequest({
    modelId: 'claude-sonnet-4-5',
    maxOutputTokens: 1024,
    tools: [
      {
        name: 'action',
        description: 'Live page',
        inputSchema: {
          type: 'object',
          properties: { op: { type: 'string' } },
          required: ['op']
        }
      }
    ],
    prompt: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Click submit' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'action',
            input: { op: 'click' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'action',
            output: { type: 'json', value: { ok: true } }
          }
        ]
      }
    ]
  });
  assert.equal(body.tools[0].name, 'action');
  assert.equal(body.messages[1].content[1].type, 'tool_use');
  assert.equal(body.messages[2].content[0].type, 'tool_result');

  const headers = anthropicRequestHeaders('sk-ant-test');
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);

  const generated = convertAnthropicResponseToDoGenerate({
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'call_2', name: 'action', input: { op: 'snapshot' } }
    ],
    usage: { input_tokens: 10, output_tokens: 5 }
  });
  assert.equal(generated.finishReason.unified, 'tool-calls');
  assert.equal(JSON.parse(generated.content[0].input).op, 'snapshot');
});

test('inferChatWireFromModelId families used only by auto mode', () => {
  assert.equal(inferChatWireFromModelId('claude-opus-4-6'), CHAT_PROTOCOL_ANTHROPIC);
  assert.equal(inferChatWireFromModelId('deepseek-v4-flash'), CHAT_PROTOCOL_OPENAI);
  assert.equal(inferChatWireFromModelId('gpt-5.5'), CHAT_PROTOCOL_RESPONSES);
  assert.equal(inferChatWireFromModelId('jev-1.13-free'), 'systemone');
});
