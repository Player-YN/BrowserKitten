/**
 * Product Session agent runner — Vercel AI SDK 7 ToolLoopAgent only.
 * No handwritten multi-step tool loop.
 */

import {
  ToolLoopAgent,
  tool,
  jsonSchema,
  generateText,
  InvalidToolInputError,
  NoSuchToolError
} from '../adapters/vendor/ai-sdk-loader.mjs';
import { createWireRecorder } from './wireTranscript.js';
import { createProgressNoteEmitter, progressNotesFromSteps } from './progressNotes.js';
import { isAbortLike, toAbortError } from '../host/userStop.js';
import { formatRpcError } from '../host/rpcError.js';

/**
 * AI SDK onError default is console.error(error) — objects print as
 * "[object Object]". Serialize for onEvent / trajectory / liveProgress.
 * @param {unknown} error
 */
export function serializeAgentError(error) {
  if (error == null) return { name: 'Error', message: 'unknown error' };
  if (typeof error === 'string') {
    return { name: 'Error', message: error === '[object Object]' ? 'unknown error' : error };
  }
  const e = typeof error === 'object' ? error : {};
  const name = e.name != null && String(e.name) ? String(e.name) : 'Error';
  const message = formatRpcError(e);
  const out = { name, message };
  if (e.code != null && e.code !== '') out.code = String(e.code);
  if (e.statusCode != null) out.statusCode = Number(e.statusCode);
  else if (e.status != null) out.statusCode = Number(e.status);
  if (typeof e.stack === 'string' && e.stack) out.stack = e.stack;
  return out;
}

function successfulTerminalTaskCall(steps) {
  for (const step of steps || []) {
    const results = Array.isArray(step?.toolResults) ? step.toolResults : [];
    for (const call of step?.toolCalls || []) {
      if (call?.toolName !== 'task') continue;
      const input = call.input ?? call.args ?? {};
      if (input?.op !== 'wait' && input?.op !== 'complete') continue;
      const result = findStepToolResult(results, call);
      const output = result?.output ?? result?.result;
      if (output?.ok === true && output?.yield !== false) return true;
    }
  }
  return false;
}

/**
 * Task turns stop on wait / complete / host yield only. Hop count is not a
 * stop condition — ordinary chat and running tasks stay unlimited.
 */
export function createTaskStopState(args = {}) {
  const state = {
    taskYielded: false,
    taskStepLimitReached: false
  };
  state.stopWhen = ({ steps }) => {
    let hostYield = false;
    try {
      hostYield = typeof args.taskShouldYield === 'function' && args.taskShouldYield() === true;
    } catch {
      hostYield = false;
    }
    if (hostYield || successfulTerminalTaskCall(steps)) {
      state.taskYielded = true;
      return true;
    }
    return false;
  };
  return state;
}

/**
 * One re-ask: feed InvalidToolInputError / NoSuchToolError + tool schema back
 * to the same model. No extra provider config; inner generateText does not repair.
 */
export async function repairSessionToolCall(model, opts = {}) {
  const error = opts.error;
  const isInvalid = InvalidToolInputError.isInstance?.(error) || error?.name === 'AI_InvalidToolInputError';
  const isMissing = NoSuchToolError.isInstance?.(error) || error?.name === 'AI_NoSuchToolError';
  if (!isInvalid && !isMissing) return null;

  const toolCall = opts.toolCall || {};
  let schema = null;
  try {
    schema = typeof opts.inputSchema === 'function' ? await opts.inputSchema({ toolName: toolCall.toolName }) : null;
  } catch {
    schema = null;
  }
  const tools = schemasOnly(opts.tools);
  const result = await generateText({
    model,
    system: [
      opts.system || opts.instructions || '',
      'Repair the failed tool call. Use the error and JSON schema. Return exactly one corrected tool call. Do not explain.'
    ]
      .filter(Boolean)
      .join('\n'),
    messages: [
      ...(opts.messages || []),
      {
        role: 'user',
        content: [
          `Tool call failed.`,
          `error: ${error?.message || String(error)}`,
          `toolName: ${toolCall.toolName || ''}`,
          `input: ${typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input ?? {})}`,
          schema ? `schema: ${JSON.stringify(schema)}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    tools,
    abortSignal: opts.abortSignal
  });
  const repaired = Array.isArray(result?.toolCalls) ? result.toolCalls[0] : null;
  if (!repaired) return null;
  const input =
    typeof repaired.input === 'string'
      ? repaired.input
      : JSON.stringify(repaired.input ?? repaired.args ?? {});
  return {
    toolCallId: toolCall.toolCallId,
    toolName: repaired.toolName || toolCall.toolName,
    input
  };
}

function schemasOnly(tools) {
  const out = {};
  for (const [name, t] of Object.entries(tools || {})) {
    if (!t || typeof t !== 'object') continue;
    out[name] = { ...t, execute: undefined };
  }
  return out;
}

/**
 * Run the general Session agent. Kernel tools are always-on; prepareStep may
 * re-inject instructions and return shortened `messages` when occupancy is high.
 *
 * @param {{
 *   model: any,
 *   system: string,
 *   messages: Array<{role:string,content:any}>,
 *   tools: Record<string, {name?:string,description:string,parameters?:object,execute:Function,toModelOutput?:Function}>,
 *   prepareStep?: Function,
 *   taskContext?: object|null,
 *   taskRun?: boolean,
 *   taskShouldYield?: Function,
 *   signal?: AbortSignal,
 *   onEvent?: (ev: { type: string, [k: string]: any }) => void
 * }} args
 */
export async function runSessionToolLoopAgent(args) {
  const model = args.model;
  if (!model) {
    throw new Error('runSessionToolLoopAgent: model required (LanguageModel)');
  }
  if (typeof ToolLoopAgent !== 'function') {
    throw new Error('ToolLoopAgent unavailable from AI SDK vendor loader');
  }

  const sdkTools = wrapSessionToolsForSdk(args.tools || {});
  const onEvent = typeof args.onEvent === 'function' ? args.onEvent : null;
  const recorder = createWireRecorder();
  const taskStop = createTaskStopState(args);

  const emitSerializedError = (error) => {
    if (isAbortLike(error, args.signal)) return;
    const serialized = serializeAgentError(error);
    if (onEvent) {
      try {
        onEvent({ type: 'error', ...serialized });
      } catch {
        /* UI emitter must not fail the turn */
      }
    }
  };

  const agent = new ToolLoopAgent({
    model,
    instructions: args.system || '',
    tools: sdkTools,
    // Chat and durable-task turns are both hop-unlimited. Task turns yield
    // on wait / complete / host yield; abort/deadline stop via abortSignal.
    stopWhen: taskStop.stopWhen,
    repairToolCall: (opts) => repairSessionToolCall(model, { ...opts, abortSignal: args.signal }),
    onError: ({ error }) => {
      emitSerializedError(error);
    },
    ...(typeof args.prepareStep === 'function' ? { prepareStep: args.prepareStep } : {})
  });

  const messages = Array.isArray(args.messages) ? args.messages : [];
  const callArgs = {
    messages: messages.length ? messages : undefined,
    prompt: messages.length ? undefined : '',
    abortSignal: args.signal
  };

  // Product: stream so Sidepanel can show thinking + tokens. Tests use callModel
  // adapter doStream (one-shot chunks). generate() is fallback only.
  try {
    let result;
    if (typeof agent.stream === 'function') {
      result = await agent.stream(callArgs);
      await consumeAgentStream(result, onEvent, recorder, args.signal);
    } else {
      result = await agent.generate(callArgs);
      // No stream: same tool-call-step rule over the finished steps.
      for (const note of progressNotesFromSteps(await maybePromise(result.steps))) {
        if (!onEvent) break;
        try {
          onEvent(note);
        } catch {
          /* UI emitter must not fail the turn */
        }
      }
    }

    const steps = await maybePromise(result.steps);
    const finalTextRaw = await maybePromise(result.text);
    const finalText = finalTextRaw != null ? String(finalTextRaw) : '';
    const toolCalls = collectToolCallsFromSteps(steps);
    let reasoning = recorder.reasoningText();
    if (!reasoning) {
      reasoning = asStreamText(await maybePromise(result.reasoning));
      if (!reasoning) reasoning = collectReasoningFromSteps(steps);
      if (reasoning) {
        recorder.ingest({ type: 'reasoning-delta', text: reasoning });
        if (onEvent) {
          try {
            onEvent({ type: 'thought', text: reasoning });
          } catch {
            /* UI emitter must not fail the turn */
          }
        }
      }
    }
    const wire = recorder.finish({ finalText });
    const usageRaw = await maybePromise(result.usage);

    return {
      mode: 'ToolLoopAgent',
      finalText,
      steps: steps || [],
      toolCalls,
      wire,
      reasoning,
      usage: usageRaw || null,
      taskYielded: taskStop.taskYielded,
      taskStepLimitReached: taskStop.taskStepLimitReached,
      taskStepCount: Array.isArray(steps) ? steps.length : 0
    };
  } catch (err) {
    if (isAbortLike(err, args.signal)) throw toAbortError(err);
    emitSerializedError(err);
    throw err;
  }
}

function extractReasoningDetailsText(details) {
  if (!Array.isArray(details)) return '';
  return details
    .map((d) => {
      if (!d || typeof d !== 'object') return '';
      if (typeof d.text === 'string') return d.text;
      if (typeof d.summary === 'string') return d.summary;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function collectReasoningFromSteps(steps) {
  let out = '';
  for (const step of steps || []) {
    const direct = asStreamText(step.reasoning) || asStreamText(step.reasoningText);
    if (direct) out += direct;
    for (const part of step.content || step.reasoningDetails || []) {
      if (part?.type === 'reasoning') out += asStreamText(part.text);
      out += extractReasoningDetailsText(part?.reasoning_details);
    }
  }
  return out;
}

function findStepToolResult(results, tc) {
  const list = Array.isArray(results) ? results : [];
  const id = tc?.toolCallId || tc?.id;
  if (id) {
    const byId = list.find((r) => r && r.toolCallId === id);
    if (byId) return byId;
  }
  const name = tc?.toolName;
  if (!name) return null;
  const sameName = list.filter((r) => r && r.toolName === name);
  return sameName.length === 1 ? sameName[0] : null;
}

function collectToolCallsFromSteps(steps) {
  const toolCalls = [];
  for (const step of steps || []) {
    for (const tc of step.toolCalls || []) {
      const tr = findStepToolResult(step.toolResults, tc);
      toolCalls.push({
        toolName: tc.toolName,
        args: tc.input ?? tc.args,
        toolCallId: tc.toolCallId,
        result: tr?.output ?? tr?.result
      });
    }
  }
  return toolCalls;
}

async function maybePromise(value) {
  if (value != null && typeof value.then === 'function') return value;
  return value;
}

/**
 * Drain ToolLoopAgent/streamText fullStream and forward UI-safe events.
 * @param {any} result
 * @param {null|((ev: object) => void)} onEvent
 */
async function consumeAgentStream(result, onEvent, recorder, signal) {
  const stream = result?.fullStream || result?.stream;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return;
  const progress = createProgressNoteEmitter();
  try {
    for await (const part of stream) {
      if (!part || typeof part !== 'object') continue;
      if (recorder && typeof recorder.ingest === 'function') {
        try {
          recorder.ingest(part);
        } catch {
          /* wire recorder must not fail the turn */
        }
      }
      // Commentary of a tool-call step goes out before that step's tool row.
      const note = progress.ingest(part);
      for (const ev of [note, mapStreamPartToUiEvent(part)]) {
        if (!ev || !onEvent) continue;
        try {
          onEvent(ev);
        } catch {
          /* UI emitter must not fail the turn */
        }
      }
      if (part.type === 'abort' || (part.type === 'error' && isAbortLike(part.error, signal))) {
        throw toAbortError(part.error || part.reason);
      }
      if (part.type === 'error' && part.error) {
        if (isAbortLike(part.error, signal)) throw toAbortError(part.error);
        if (part.error instanceof Error) throw part.error;
        const serialized = serializeAgentError(part.error);
        const err = new Error(serialized.message);
        err.name = serialized.name || 'Error';
        if (serialized.code) err.code = serialized.code;
        if (serialized.statusCode != null) err.statusCode = serialized.statusCode;
        throw err;
      }
    }
  } catch (err) {
    if (isAbortLike(err, signal)) throw toAbortError(err);
    throw err;
  }
}

/**
 * Stream deltas must be primitive text. Objects become "[object Object]" in the UI.
 * @param {unknown} value
 * @returns {string}
 */
export function asStreamText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value === '[object Object]' ? '' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.delta === 'string') return value.delta;
    if (typeof value.content === 'string') return value.content;
    return '';
  }
  return '';
}

function mapStreamPartToUiEvent(part) {
  const type = String(part.type || '');
  if (type === 'text-delta') {
    const chunk = asStreamText(part.text ?? part.delta ?? part.textDelta);
    return chunk ? { type: 'text', chunk } : null;
  }
  if (type === 'reasoning-delta' || type === 'reasoning') {
    const text =
      asStreamText(part.text ?? part.delta) || extractReasoningDetailsText(part.reasoning_details);
    return text ? { type: 'thought', text } : { type: 'thought-open' };
  }
  if (type === 'reasoning-start') {
    return { type: 'thought-open' };
  }
  if (type === 'tool-call') {
    return {
      type: 'tool-call',
      name: part.toolName || part.name || 'tool',
      toolCallId: part.toolCallId || part.id || '',
      args: part.input ?? part.args
    };
  }
  if (type === 'tool-result') {
    const output = part.output ?? part.result;
    return {
      type: 'tool-result',
      name: part.toolName || part.name || 'tool',
      toolCallId: part.toolCallId || part.id || '',
      ok: output?.ok !== false,
      result: output
    };
  }
  if (type === 'start-step' || type === 'step-start') {
    return {
      type: 'model-start',
      index: part.stepNumber ?? part.index,
      modelId: part.request?.modelId || part.modelId
    };
  }
  if (type === 'finish-step') {
    const fr = part.finishReason;
    return {
      type: 'model-end',
      usage: part.usage,
      finishReason:
        typeof fr === 'string'
          ? fr
          : fr && typeof fr === 'object'
            ? fr.unified || fr.reason || ''
            : '',
      performance: part.performance,
      response: part.response,
      modelId: part.response?.modelId || part.modelId
    };
  }
  if (type === 'tool-execution-end') {
    return {
      type: 'tool-execution-end',
      toolCallId: part.toolCallId || part.id || '',
      latencyMs: part.toolExecutionMs ?? part.latencyMs
    };
  }
  if (type === 'model-call-response-metadata') {
    return { type: 'model-meta', modelId: part.modelId, id: part.id };
  }
  if (type === 'error') {
    return { type: 'error', ...serializeAgentError(part.error) };
  }
  return null;
}

/**
 * Wrap Session tools with AI SDK `tool()` so execute + toModelOutput are first-class.
 * @param {Record<string, any>} tools
 */
export function wrapSessionToolsForSdk(tools) {
  /** @type {Record<string, any>} */
  const sdkTools = {};
  for (const [name, t] of Object.entries(tools || {})) {
    if (!t || typeof t.execute !== 'function') continue;
    const parameters = t.parameters || { type: 'object', properties: {} };
    sdkTools[name] = tool({
      description: t.description || name,
      inputSchema: jsonSchema(parameters),
      execute: async (input, opts) => {
        try {
          return await t.execute(input ?? {}, opts);
        } catch (e) {
          if (isAbortLike(e, opts?.abortSignal)) throw toAbortError(e);
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e)
          };
        }
      },
      ...(typeof t.toModelOutput === 'function'
        ? {
            toModelOutput: (o) => t.toModelOutput(o)
          }
        : {})
    });
  }
  return sdkTools;
}

/**
 * Test/offline adapter: present callModel as a LanguageModelV2 so ToolLoopAgent
 * still owns the multi-step loop (not a product handwritten loop).
 *
 * @param {(args: object) => Promise<any>} callModel
 * @returns {object} LanguageModel-like
 */
export function createCallModelLanguageModel(callModel) {
  if (typeof callModel !== 'function') {
    throw new Error('createCallModelLanguageModel: callModel function required');
  }

  return {
    specificationVersion: 'v2',
    provider: 'browserbot-callModel',
    modelId: 'callModel-adapter',
    supportedUrls: Promise.resolve({}),
    async doGenerate(options) {
      if (options?.abortSignal?.aborted) {
        throw toAbortError(options.abortSignal.reason);
      }

      const { messages, system } = promptToChatMessages(options.prompt);
      const openAiTools = sdkToolsToOpenAi(options.tools);

      try {
        const out = await callModel({
          system,
          messages,
          tools: openAiTools,
          toolChoice: 'auto',
          signal: options.abortSignal
        });
        return modelOutToDoGenerate(out);
      } catch (e) {
        if (isAbortLike(e, options?.abortSignal)) throw toAbortError(e);
        throw e;
      }
    },
    async doStream(options) {
      const generated = await this.doGenerate(options);
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
                  controller.enqueue({
                    type: 'text-delta',
                    id,
                    delta: String(part.text)
                  });
                }
                controller.enqueue({ type: 'text-end', id });
              } else if (part?.type === 'tool-call') {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input
                });
              }
            }
            controller.enqueue({
              type: 'finish',
              finishReason: generated.finishReason || { unified: 'stop' },
              usage: generated.usage || {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0
              }
            });
            controller.close();
          }
        })
      };
    }
  };
}

/**
 * @param {any} prompt
 */
function promptToChatMessages(prompt) {
  /** @type {Array<{role:string,content:any}>} */
  const messages = [];
  let system = '';
  if (!Array.isArray(prompt)) {
    return { messages: [{ role: 'user', content: String(prompt ?? '') }], system };
  }
  for (const part of prompt) {
    if (!part || typeof part !== 'object') continue;
    if (part.role === 'system') {
      const c = part.content;
      system += typeof c === 'string' ? c : extractText(c);
      continue;
    }
    if (part.role === 'user' || part.role === 'assistant') {
      messages.push({
        role: part.role,
        content: typeof part.content === 'string' ? part.content : extractText(part.content)
      });
      continue;
    }
    if (part.role === 'tool') {
      // Flatten tool results into a user-visible JSON blob for callModel stubs
      const content = Array.isArray(part.content)
        ? part.content
            .map((c) => {
              if (c?.type === 'tool-result') {
                return JSON.stringify({
                  toolCallId: c.toolCallId,
                  toolName: c.toolName,
                  output: c.output
                });
              }
              return JSON.stringify(c);
            })
            .join('\n')
        : String(part.content ?? '');
      messages.push({ role: 'tool', content, tool_call_id: part.content?.[0]?.toolCallId });
    }
  }
  return { messages, system };
}

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        return '';
      })
      .join('');
  }
  return String(content);
}

function sdkToolsToOpenAi(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map((t) => {
    const name = t.name || t.toolName || 'tool';
    const description = t.description || '';
    // AI SDK may attach schema differently; best-effort
    const parameters =
      t.inputSchema ||
      t.parameters ||
      (t.inputSchema?.jsonSchema ? t.inputSchema.jsonSchema : null) || {
        type: 'object',
        properties: {}
      };
    // jsonSchema wrapper sometimes stores under .jsonSchema
    const schema =
      parameters && typeof parameters === 'object' && parameters.jsonSchema
        ? parameters.jsonSchema
        : parameters && parameters._def
          ? { type: 'object', properties: {} }
          : parameters;
    return {
      type: 'function',
      function: {
        name,
        description,
        parameters: schema && schema.type ? schema : { type: 'object', properties: {} }
      }
    };
  });
}

/**
 * @param {any} out
 */
function modelOutToDoGenerate(out) {
  const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (out == null) {
    return {
      content: [{ type: 'text', text: '' }],
      finishReason: { unified: 'stop' },
      usage: emptyUsage,
      warnings: []
    };
  }
  if (typeof out === 'string') {
    return {
      content: [{ type: 'text', text: out }],
      finishReason: { unified: 'stop' },
      usage: emptyUsage,
      warnings: []
    };
  }

  const text = out.text || out.content || out.message?.content || '';
  let toolCalls = out.toolCalls || out.tool_calls || out.message?.tool_calls || [];
  if (!Array.isArray(toolCalls)) toolCalls = [];

  /** @type {any[]} */
  const content = [];
  if (toolCalls.length) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const name = tc.toolName || tc.name || tc.function?.name;
      let args = tc.args ?? tc.input ?? tc.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args || '{}');
        } catch {
          args = {};
        }
      }
      content.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId || tc.id || `call_${i}_${name}`,
        toolName: name,
        input: JSON.stringify(args || {})
      });
    }
    if (text) content.unshift({ type: 'text', text: String(text) });
    return {
      content,
      finishReason: { unified: 'tool-calls' },
      usage: emptyUsage,
      warnings: []
    };
  }

  return {
    content: [{ type: 'text', text: text == null ? '' : String(text) }],
    finishReason: { unified: 'stop' },
    usage: emptyUsage,
    warnings: []
  };
}
