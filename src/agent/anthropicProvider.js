/**
 * Fetch-based Anthropic Messages API LanguageModel (AI SDK v2 shape).
 * Speaks POST {base}/messages with x-api-key + anthropic-version.
 * ToolLoopAgent-compatible: maps tools, tool_use, and tool_result.
 */

import { anthropicMessagesUrl, CHAT_PROTOCOL_ANTHROPIC } from './llm.js';
import { isAbortLike, toAbortError } from './vnext/host/userStop.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function anthropicRequestHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': String(apiKey || ''),
    'anthropic-version': ANTHROPIC_VERSION
  };
}

/**
 * Extract a JSON Schema object from an AI SDK tool definition.
 * @param {any} tool
 */
export function anthropicToolInputSchema(tool) {
  const raw =
    tool?.inputSchema?.jsonSchema ||
    tool?.inputSchema ||
    tool?.parameters?.jsonSchema ||
    tool?.parameters ||
    null;
  if (raw && typeof raw === 'object' && !raw._def && (raw.type || raw.properties)) {
    return {
      type: raw.type || 'object',
      properties: raw.properties && typeof raw.properties === 'object' ? raw.properties : {},
      ...(Array.isArray(raw.required) ? { required: raw.required } : {}),
      ...(raw.additionalProperties !== undefined
        ? { additionalProperties: raw.additionalProperties }
        : {})
    };
  }
  return { type: 'object', properties: {} };
}

/**
 * Map AI SDK tools → Anthropic tools[].
 * @param {any[]|null|undefined} tools
 */
export function convertToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'provider-defined') continue;
    const name = String(t.name || t.toolName || '').trim();
    if (!name) continue;
    out.push({
      name,
      description: String(t.description || ''),
      input_schema: anthropicToolInputSchema(t)
    });
  }
  return out.length ? out : undefined;
}

/**
 * @param {any} toolChoice
 * @param {any[]|undefined} anthropicTools
 */
export function convertToolChoiceToAnthropic(toolChoice, anthropicTools) {
  if (!anthropicTools?.length) return undefined;
  if (toolChoice == null || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice === 'none' ? { type: 'auto' } : { type: 'any' };
  }
  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'none') return { type: 'auto' };
    if (toolChoice.type === 'required' || toolChoice.type === 'any') return { type: 'any' };
    if (toolChoice.type === 'tool' && toolChoice.toolName) {
      return { type: 'tool', name: String(toolChoice.toolName) };
    }
    if (toolChoice.type === 'auto') return { type: 'auto' };
  }
  return { type: 'auto' };
}

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      return '';
    })
    .join('');
}

function parseToolInput(input) {
  if (input == null) return {};
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input || '{}');
    } catch {
      return { _raw: input };
    }
  }
  return {};
}

function toolResultContent(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    // AI SDK often wraps as { type: 'json'|'text'|'error-…', value|text|… }
    if (output.type === 'text' && typeof output.text === 'string') return output.text;
    if (output.type === 'json') {
      try {
        return JSON.stringify(output.value ?? output);
      } catch {
        return String(output.value ?? '');
      }
    }
    if (typeof output.value === 'string') return output.value;
    try {
      return JSON.stringify(output.value ?? output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

function userContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return extractText(content);
  /** @type {any[]} */
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text) {
      parts.push({ type: 'text', text: String(part.text) });
      continue;
    }
    if (part.type === 'image' || part.type === 'file') {
      const mediaType = String(part.mediaType || part.mimeType || 'image/jpeg')
        .split(';')[0]
        .trim();
      if (!mediaType.startsWith('image/')) continue;
      let data = part.data ?? part.image;
      if (typeof data === 'object' && data?.data != null) data = data.data;
      if (typeof data === 'string' && data.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.+)$/i.exec(data);
        if (m) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: m[1] || mediaType, data: m[2] }
          });
          continue;
        }
      }
      if (typeof data === 'string' && data.length > 32) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: data.replace(/^data:[^,]+,/, '') }
        });
      }
    }
  }
  if (!parts.length) return extractText(content) || '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * Convert AI SDK LanguageModel prompt → Anthropic Messages body fields.
 * @param {any} prompt
 * @returns {{ system?: string, messages: object[] }}
 */
export function convertPromptToAnthropicMessages(prompt) {
  /** @type {object[]} */
  const messages = [];
  /** @type {string[]} */
  const systemParts = [];

  const pushUser = (content) => {
    if (content == null || content === '') return;
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content) && Array.isArray(content)) {
      last.content.push(...content);
      return;
    }
    messages.push({ role: 'user', content });
  };

  const list = Array.isArray(prompt) ? prompt : [{ role: 'user', content: String(prompt ?? '') }];
  for (const part of list) {
    if (!part || typeof part !== 'object') continue;
    if (part.role === 'system') {
      const text = typeof part.content === 'string' ? part.content : extractText(part.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (part.role === 'user') {
      pushUser(userContentParts(part.content));
      continue;
    }
    if (part.role === 'assistant') {
      /** @type {any[]} */
      const blocks = [];
      const content = part.content;
      if (typeof content === 'string') {
        if (content) blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' && c.text) {
            blocks.push({ type: 'text', text: String(c.text) });
          } else if (c.type === 'tool-call' || c.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: String(c.toolCallId || c.id || ''),
              name: String(c.toolName || c.name || ''),
              input: parseToolInput(c.input ?? c.args)
            });
          } else if (c.type === 'reasoning' && c.text) {
            // Anthropic extended thinking is separate; skip plaintext reasoning in replay.
          }
        }
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (part.role === 'tool') {
      /** @type {any[]} */
      const results = [];
      const content = part.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'tool-result' || c.type === 'tool_result') {
            results.push({
              type: 'tool_result',
              tool_use_id: String(c.toolCallId || c.tool_use_id || ''),
              content: toolResultContent(c.output ?? c.content ?? c.result)
            });
          }
        }
      }
      if (results.length) pushUser(results);
    }
  }

  // Anthropic requires the first message to be user.
  if (messages.length && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(continue)' });
  }

  /** @type {{ system?: string, messages: object[] }} */
  const out = { messages };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  return out;
}

/**
 * Build a full Anthropic Messages request body from LanguageModel doGenerate options.
 * @param {{
 *   modelId: string,
 *   prompt: any,
 *   tools?: any[],
 *   toolChoice?: any,
 *   maxOutputTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   stopSequences?: string[]
 * }} opts
 */
export function buildAnthropicMessagesRequest(opts) {
  const { system, messages } = convertPromptToAnthropicMessages(opts.prompt);
  const tools = convertToolsToAnthropic(opts.tools);
  const maxTokens =
    typeof opts.maxOutputTokens === 'number' && opts.maxOutputTokens > 0
      ? Math.round(opts.maxOutputTokens)
      : ANTHROPIC_DEFAULT_MAX_TOKENS;
  /** @type {Record<string, unknown>} */
  const body = {
    model: opts.modelId,
    max_tokens: maxTokens,
    messages
  };
  if (system) body.system = system;
  if (tools) {
    body.tools = tools;
    const choice = convertToolChoiceToAnthropic(opts.toolChoice, tools);
    if (choice) body.tool_choice = choice;
  }
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.topP === 'number') body.top_p = opts.topP;
  if (Array.isArray(opts.stopSequences) && opts.stopSequences.length) {
    body.stop_sequences = opts.stopSequences;
  }
  return body;
}

/**
 * Map Anthropic stop_reason → AI SDK finishReason.
 * @param {string|null|undefined} reason
 */
export function mapAnthropicStopReason(reason) {
  const r = String(reason || '');
  if (r === 'tool_use') return { unified: 'tool-calls', raw: r };
  if (r === 'max_tokens') return { unified: 'length', raw: r };
  if (r === 'stop_sequence') return { unified: 'stop', raw: r };
  if (r === 'end_turn' || r === 'stop') return { unified: 'stop', raw: r || 'end_turn' };
  return { unified: r ? 'other' : 'stop', raw: r || undefined };
}

/**
 * Convert Anthropic message response → LanguageModelV2 doGenerate content.
 * @param {any} body
 */
export function convertAnthropicResponseToDoGenerate(body) {
  /** @type {any[]} */
  const content = [];
  const blocks = Array.isArray(body?.content) ? body.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) {
      content.push({ type: 'text', text: String(block.text) });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool-call',
        toolCallId: String(block.id || ''),
        toolName: String(block.name || ''),
        input: JSON.stringify(block.input ?? {})
      });
    } else if (block.type === 'thinking' && block.thinking) {
      content.push({ type: 'reasoning', text: String(block.thinking) });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const usageIn = Number(body?.usage?.input_tokens);
  const usageOut = Number(body?.usage?.output_tokens);
  const inputTokens = Number.isFinite(usageIn) ? usageIn : 0;
  const outputTokens = Number.isFinite(usageOut) ? usageOut : 0;
  return {
    content,
    finishReason: mapAnthropicStopReason(body?.stop_reason),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    },
    warnings: []
  };
}

function synthesizeStreamFromGenerate(generated) {
  const content = Array.isArray(generated.content) ? generated.content : [];
  const warnings = generated.warnings || [];
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings });
        let textId = 0;
        for (const part of content) {
          if (part?.type === 'text') {
            const id = String(textId++);
            controller.enqueue({ type: 'text-start', id });
            if (part.text) {
              controller.enqueue({ type: 'text-delta', id, delta: String(part.text) });
            }
            controller.enqueue({ type: 'text-end', id });
          } else if (part?.type === 'tool-call') {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input
            });
          } else if (part?.type === 'reasoning' && part.text) {
            const id = `reasoning-${textId++}`;
            controller.enqueue({ type: 'reasoning-start', id });
            controller.enqueue({ type: 'reasoning-delta', id, delta: String(part.text) });
            controller.enqueue({ type: 'reasoning-end', id });
          }
        }
        controller.enqueue({
          type: 'finish',
          finishReason: generated.finishReason || { unified: 'stop' },
          usage: generated.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        });
        controller.close();
      }
    })
  };
}

/**
 * Create an Anthropic Messages LanguageModel for ToolLoopAgent / generateText.
 * @param {{
 *   modelId: string,
 *   apiKey: string,
 *   baseURL: string,
 *   fetch?: typeof fetch,
 *   providerName?: string
 * }} config
 */
export function createAnthropicLanguageModel(config) {
  const modelId = String(config.modelId || '').trim();
  const apiKey = String(config.apiKey || '');
  const baseURL = String(config.baseURL || '').replace(/\/$/, '');
  const fetchImpl = typeof config.fetch === 'function' ? config.fetch : fetch;
  const providerName = (config.providerName && String(config.providerName).trim()) || 'anthropic';
  const url = anthropicMessagesUrl(baseURL);

  return {
    specificationVersion: 'v2',
    provider: providerName,
    modelId,
    protocol: CHAT_PROTOCOL_ANTHROPIC,
    supportedUrls: Promise.resolve({}),
    async doGenerate(options) {
      if (options?.abortSignal?.aborted) {
        throw toAbortError(options.abortSignal.reason);
      }
      const body = buildAnthropicMessagesRequest({
        modelId,
        prompt: options.prompt,
        tools: options.tools,
        toolChoice: options.toolChoice,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        stopSequences: options.stopSequences
      });
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: anthropicRequestHeaders(apiKey),
          body: JSON.stringify(body),
          signal: options.abortSignal
        });
      } catch (e) {
        if (isAbortLike(e, options?.abortSignal)) throw toAbortError(e);
        throw e;
      }
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!response.ok) {
        const err = new Error(
          (json && (json.error?.message || json.message)) ||
            `Anthropic HTTP ${response.status}: ${text.slice(0, 400)}`
        );
        err.statusCode = response.status;
        err.data = json;
        throw err;
      }
      const generated = convertAnthropicResponseToDoGenerate(json);
      return {
        ...generated,
        request: { body: JSON.stringify(body) },
        response: { body: json, statusCode: response.status }
      };
    },
    async doStream(options) {
      // Non-stream request + synthetic stream keeps tool_use mapping correct for ToolLoopAgent.
      const generated = await this.doGenerate(options);
      return synthesizeStreamFromGenerate(generated);
    }
  };
}
