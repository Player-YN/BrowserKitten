/**
 * OpenRouter-oriented wire transcript: persist tool + reasoning for API replay.
 * UI projection stays thought + final content only.
 *
 * HARD: tool outputs entering the wire are PROJECTED, never raw.
 * Raw outputs may carry image bytes / base64 (inspect view=item) — persisting
 * or replaying them (a) violates the ModelMessage schema on the next turn,
 * (b) bloats IDB by tens of MB per turn, (c) re-sends megabytes to the API
 * every turn. The model sees full outputs in-turn via ToolLoopAgent; the wire
 * is a bounded replay index — re-inspect on demand is the recovery path.
 */

const WIRE_MAX_STRING = 2000;
const WIRE_MAX_ARRAY = 50;
const WIRE_MAX_DEPTH = 6;
const WIRE_MAX_OUTPUT_CHARS = 16000;
/** Heavy/duplicated media keys never useful on replay (bytes live in blobs). */
const WIRE_DROP_KEYS = new Set(['modelParts', 'imageBase64', 'dataUrl', 'base64', 'bytes']);

function isBinaryLike(value) {
  return (
    value instanceof Uint8Array ||
    (typeof ArrayBuffer !== 'undefined' &&
      (value instanceof ArrayBuffer || ArrayBuffer.isView?.(value)))
  );
}

function truncateWireString(s) {
  const str = String(s);
  if (str.length <= WIRE_MAX_STRING) return str;
  return `${str.slice(0, WIRE_MAX_STRING)}…[+${str.length - WIRE_MAX_STRING} chars]`;
}

/**
 * Bounded, JSON-plain projection of arbitrary tool payloads for the wire.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {any}
 */
export function projectJsonForWire(value, depth = 0) {
  if (value == null) return null;
  const t = typeof value;
  if (t === 'string') return truncateWireString(value);
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'bigint' || t === 'function' || t === 'symbol') return String(value);
  if (isBinaryLike(value)) {
    const byteLength = value.byteLength ?? value.length ?? 0;
    return { omitted: 'binary', byteLength };
  }
  if (depth >= WIRE_MAX_DEPTH) return '[depth-capped]';
  if (Array.isArray(value)) {
    const out = value.slice(0, WIRE_MAX_ARRAY).map((v) => projectJsonForWire(v, depth + 1));
    if (value.length > WIRE_MAX_ARRAY) out.push(`[+${value.length - WIRE_MAX_ARRAY} more]`);
    return out;
  }
  if (t === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (WIRE_DROP_KEYS.has(k)) {
        if (isBinaryLike(v)) {
          out[k] = { omitted: 'binary', byteLength: v.byteLength ?? 0 };
        } else if (typeof v === 'number' && Number.isFinite(v)) {
          // acquire result.bytes is a size, not a payload
          out.byteLength = v;
        } else if (typeof v === 'string' && v.length < 80 && /^\d+$/.test(v)) {
          out.byteLength = Number(v);
        } else if (typeof v === 'string') {
          out[k] = `[omitted ${k}: ${v.length} chars]`;
        } else if (v != null) {
          out[k] = `[omitted ${k}]`;
        }
        continue;
      }
      out[k] = projectJsonForWire(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Project a tool output (raw execute() return or already-typed output) into a
 * bounded, ModelMessage-valid tool-result output for wire storage and replay.
 * @param {unknown} raw
 * @returns {{type:string, value:any}}
 */
export function projectToolOutputForWire(raw) {
  if (raw && typeof raw === 'object' && typeof raw.type === 'string' && 'value' in raw) {
    const type = raw.type;
    if (type === 'text' || type === 'error-text') {
      return { type, value: truncateWireString(raw.value ?? '') };
    }
    if (type === 'content' && Array.isArray(raw.value)) {
      const value = raw.value.slice(0, WIRE_MAX_ARRAY).map((p) => {
        if (p && typeof p === 'object' && p.type === 'text') {
          return { type: 'text', text: truncateWireString(p.text ?? '') };
        }
        const mediaType = p?.mediaType || p?.mimeType || 'media';
        const size =
          (typeof p?.data === 'string' && p.data.length) ||
          (isBinaryLike(p?.image) && p.image.byteLength) ||
          0;
        return { type: 'text', text: `[media omitted (${mediaType}${size ? `, ~${size}` : ''})]` };
      });
      return { type: 'content', value };
    }
    return capWireOutput({ type: 'json', value: projectJsonForWire(raw.value) });
  }
  return capWireOutput({ type: 'json', value: projectJsonForWire(raw ?? null) });
}

function capWireOutput(output) {
  let json = '';
  try {
    json = JSON.stringify(output.value);
  } catch {
    return { type: 'json', value: { omitted: 'unserializable-tool-output' } };
  }
  if (json != null && json.length > WIRE_MAX_OUTPUT_CHARS) {
    return {
      type: 'json',
      value: {
        omitted: 'oversized-tool-output',
        chars: json.length,
        preview: json.slice(0, WIRE_MAX_STRING)
      }
    };
  }
  return output;
}

/**
 * @param {{
 *   thought?: string,
 *   toolCalls?: Array<{toolName?:string,args?:any,toolCallId?:string,result?:any}>,
 *   finalText?: string
 * }} turn
 * @returns {Array<object>}
 */
export function buildWireFromTurn(turn = {}) {
  const thought = String(turn.thought || '').trim();
  const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
  const finalText = turn.finalText == null ? '' : String(turn.finalText);
  /** @type {Array<object>} */
  const wire = [];

  if (toolCalls.length) {
    /** @type {Array<object>} */
    const parts = [];
    if (thought) parts.push({ type: 'reasoning', text: thought });
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const toolCallId = String(tc.toolCallId || `call_${tc.toolName || 'tool'}_${i}`);
      parts.push({
        type: 'tool-call',
        toolCallId,
        toolName: tc.toolName || 'tool',
        input: projectJsonForWire(tc.args ?? {})
      });
    }
    wire.push({ role: 'assistant', content: parts });
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const toolCallId = String(tc.toolCallId || `call_${tc.toolName || 'tool'}_${i}`);
      wire.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: tc.toolName || 'tool',
            output: projectToolOutputForWire(tc.result ?? null)
          }
        ]
      });
    }
  }

  if (finalText || !wire.length) {
    if (thought && !toolCalls.length) {
      wire.push({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: thought },
          { type: 'text', text: finalText }
        ]
      });
    } else {
      wire.push({ role: 'assistant', content: finalText });
    }
  }
  return wire;
}

/**
 * Expand stored session messages into API/AI-SDK messages (tools + reasoning).
 * @param {Array<object>} sessionMessages
 * @returns {Array<object>}
 */
export function replayWireMessages(sessionMessages) {
  /** @type {Array<object>} */
  const out = [];
  for (const m of sessionMessages || []) {
    if (!m || typeof m !== 'object') continue;
    const start = out.length;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content == null ? '' : m.content, messageId: m.messageId });
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (Array.isArray(m.wire) && m.wire.length) {
      for (const part of m.wire) {
        if (part && part.role) out.push({ ...reprojectWireMessage(part), messageId: m.messageId });
      }
      continue;
    }
    const thought = String(m.thought || '').trim();
    if (thought) {
      out.push({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: thought },
          { type: 'text', text: String(m.content || '') }
        ]
      });
    } else {
      out.push({ role: 'assistant', content: m.content || '' });
    }
    for (let i = start; i < out.length; i++) out[i].messageId = m.messageId;
  }
  return out;
}

/**
 * Defense on replay: sessions persisted before output projection may hold raw
 * tool outputs (binary parts, megabyte base64). Re-project so old sessions
 * replay valid and bounded instead of failing schema validation forever.
 * @param {object} part
 */
function reprojectWireMessage(part) {
  if (part.role === 'tool' && Array.isArray(part.content)) {
    return {
      ...part,
      content: part.content.map((c) => {
        if (c && typeof c === 'object' && c.type === 'tool-result') {
          return { ...c, output: projectToolOutputForWire(c.output) };
        }
        return c;
      })
    };
  }
  if (part.role === 'assistant' && Array.isArray(part.content)) {
    return {
      ...part,
      content: part.content.map((c) => {
        if (c && typeof c === 'object' && c.type === 'tool-call') {
          return { ...c, input: projectJsonForWire(c.input ?? {}) };
        }
        return c;
      })
    };
  }
  return part;
}

/**
 * Append current world snapshot onto the latest user message (API-only, not stored).
 * @param {Array<object>} apiMessages
 * @param {string} worldBlock
 */
export function attachWorldToLastUser(apiMessages, worldBlock) {
  const block = String(worldBlock || '').trim();
  if (!block) return Array.isArray(apiMessages) ? apiMessages.slice() : [];
  const out = Array.isArray(apiMessages) ? apiMessages.slice() : [];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role !== 'user') continue;
    const prev = out[i].content;
    const text = typeof prev === 'string' ? prev : '';
    out[i] = { ...out[i], content: text ? `${text}\n\n${block}` : block };
    return out;
  }
  out.push({ role: 'user', content: block });
  return out;
}

function asWireText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value === '[object Object]' ? '' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.delta === 'string') return value.delta;
  }
  return '';
}

function normalizeToolOutput(output) {
  return projectToolOutputForWire(output);
}

function collectReasoningDetails(part) {
  if (!part || typeof part !== 'object') return [];
  const meta = part.providerMetadata || part.provider_metadata || {};
  const bags = [
    part.reasoning_details,
    part.reasoningDetails,
    meta.reasoning_details,
    meta.reasoningDetails,
    meta.openrouter?.reasoning_details,
    meta.openrouter?.reasoningDetails
  ];
  /** @type {Array<object>} */
  const out = [];
  for (const bag of bags) {
    if (Array.isArray(bag)) {
      for (const item of bag) {
        if (item && typeof item === 'object') out.push(item);
      }
    }
  }
  return out;
}

/**
 * Record the live model/tool stream as an unmodified API wire (not UI chrome).
 */
export function createWireRecorder() {
  /** @type {Array<object>} */
  const out = [];
  /** @type {Array<object>} */
  let assistantParts = [];
  let reasoning = '';
  let text = '';
  /** @type {Array<object>} */
  let pendingDetails = [];
  let reasoningAll = '';

  function flushReasoning() {
    if (!reasoning) return;
    assistantParts.push({ type: 'reasoning', text: reasoning });
    reasoningAll += reasoning;
    reasoning = '';
  }

  function flushText() {
    if (!text) return;
    assistantParts.push({ type: 'text', text });
    text = '';
  }

  function hasAssistantText() {
    if (text) return true;
    if (assistantParts.some((p) => p.type === 'text')) return true;
    return out.some((m) => {
      if (m.role !== 'assistant') return false;
      if (typeof m.content === 'string' && m.content) return true;
      return Array.isArray(m.content) && m.content.some((p) => p.type === 'text' && p.text);
    });
  }

  function flushAssistant() {
    flushReasoning();
    flushText();
    if (!assistantParts.length && !pendingDetails.length) return;
    /** @type {object} */
    const msg = {
      role: 'assistant',
      content:
        assistantParts.length === 1 && assistantParts[0].type === 'text'
          ? assistantParts[0].text
          : assistantParts.slice()
    };
    if (pendingDetails.length) msg.reasoning_details = pendingDetails.slice();
    out.push(msg);
    assistantParts = [];
    pendingDetails = [];
  }

  return {
    ingest(part) {
      if (!part || typeof part !== 'object') return;
      const extra = collectReasoningDetails(part);
      if (extra.length) pendingDetails.push(...extra);
      const type = String(part.type || '');
      if (type === 'reasoning-delta' || type === 'reasoning') {
        const piece = asWireText(part.text ?? part.delta);
        if (piece) reasoning += piece;
        return;
      }
      if (type === 'tool-call') {
        flushReasoning();
        assistantParts.push({
          type: 'tool-call',
          toolCallId: String(part.toolCallId || part.id || `call_${part.toolName || 'tool'}`),
          toolName: part.toolName || part.name || 'tool',
          input: projectJsonForWire(part.input ?? part.args ?? {})
        });
        return;
      }
      if (type === 'tool-result') {
        flushAssistant();
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: String(part.toolCallId || ''),
              toolName: part.toolName || part.name || 'tool',
              output: normalizeToolOutput(part.output ?? part.result)
            }
          ]
        });
        return;
      }
      if (type === 'text-delta' || type === 'text') {
        flushReasoning();
        const piece = asWireText(part.text ?? part.delta ?? part.textDelta);
        if (piece) text += piece;
      }
    },
    finish(opts = {}) {
      const finalText = opts.finalText == null ? '' : String(opts.finalText);
      if (finalText && !hasAssistantText()) text = finalText;
      flushAssistant();
      return out;
    },
    messages() {
      return out;
    },
    reasoningText() {
      return `${reasoningAll}${reasoning}`;
    }
  };
}
