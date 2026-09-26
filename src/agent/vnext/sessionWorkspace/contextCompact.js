/**
 * Token-window compact for the model wire (not the UI transcript).
 *
 * Industry shape: occupancy trigger, model-written handoff, pinned high-level
 * goal (not the first greeting), tool bodies truncated before summarize,
 * recent tail kept on a user boundary.
 */

import { BK_PURPOSE_HEADER } from '../../cloudModels.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../modelCatalog.js';
import { USER_REQUESTS_PATH, excerptWithOmission, isGreetingOrFiller } from './sessionIntent.js';

export { isGreetingOrFiller };

export const COMPACT_RATIO = 0.8;
export const COMPACT_KEEP_USER_TURNS = 2;
export const COMPACT_TAIL_WINDOW_FRACTION = 0.2;
export const COMPACT_TAIL_TOKEN_CAP = 20000;
export const COMPACT_TOOL_PACK_TOKENS = 20000;
export const COMPACT_OUTPUT_CAP = 4000;


export function contextUsageRatio(promptTokens, contextWindow) {
  const w = Math.max(2048, Number(contextWindow) || DEFAULT_CONTEXT_WINDOW);
  const p = Math.max(0, Number(promptTokens) || 0);
  return p / w;
}

export function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function messagePlainText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (p.type === 'tool-result') return toolOutputText(p.output);
        if (p.type === 'tool-call') return `${p.toolName || 'tool'} ${JSON.stringify(p.input ?? {})}`;
        return String(p.text || p.content || '');
      })
      .filter(Boolean)
      .join('\n');
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
}

function toolOutputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (output.type === 'content') return messagePlainText({ content: output.value });
  const value = output.value ?? output;
  return typeof value === 'string' ? value : JSON.stringify(value, (key, item) =>
    ['data', 'base64', 'imageBase64', 'dataUrl', 'bytes', 'modelParts'].includes(key) && typeof item !== 'number'
      ? '[media omitted]' : item);
}

function stripHeavyMedia(text) {
  return String(text || '')
    .replace(/data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[media omitted]')
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[base64 omitted]');
}

export function estimateOneMessageTokens(message) {
  let n = 8;
  n += estimateTextTokens(messagePlainText(message));
  if (message?.thought) n += estimateTextTokens(message.thought);
  if (Array.isArray(message?.wire)) return 8 + estimateMessagesTokens(message.wire);
  else if (message?.toolCalls) n += estimateTextTokens(JSON.stringify(message.toolCalls));
  return n;
}

export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages || []) n += estimateOneMessageTokens(m);
  return n;
}

export function compactTailBudget(contextWindow) {
  const w = Math.max(2048, Number(contextWindow) || DEFAULT_CONTEXT_WINDOW);
  return Math.max(1, Math.min(COMPACT_TAIL_TOKEN_CAP, Math.floor(w * COMPACT_TAIL_WINDOW_FRACTION)));
}

/**
 * Index of the first verbatim tail message. Compact region is messages[0..cut).
 * Keeps at least COMPACT_KEEP_USER_TURNS user turns, then grows older turns
 * while the tail stays under the token budget. Cuts only on a user boundary.
 */
export function findCompactCutByBudget(messages, contextWindow) {
  const arr = Array.isArray(messages) ? messages : [];
  const userAt = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.role === 'user') userAt.push(i);
  }
  const keep = COMPACT_KEEP_USER_TURNS;
  if (userAt.length <= keep) return -1;
  let cut = userAt[userAt.length - keep];
  let tailTokens = estimateMessagesTokens(arr.slice(cut));
  const budget = compactTailBudget(contextWindow);
  for (let u = userAt.length - keep - 1; u >= 0; u--) {
    const nextCut = userAt[u];
    const extra = estimateMessagesTokens(arr.slice(nextCut, cut));
    if (tailTokens + extra > budget) break;
    tailTokens += extra;
    cut = nextCut;
  }
  return cut;
}

/** @deprecated use findCompactCutByBudget */
export function findCompactCutIndex(messages, keepUserTurns = COMPACT_KEEP_USER_TURNS) {
  const arr = Array.isArray(messages) ? messages : [];
  const userAt = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.role === 'user') userAt.push(i);
  }
  const keep = Math.max(1, Number(keepUserTurns) || COMPACT_KEEP_USER_TURNS);
  if (userAt.length <= keep) return -1;
  return userAt[userAt.length - keep];
}

export function messagesAfterCompact(messages, compact) {
  const arr = Array.isArray(messages) ? messages : [];
  const through = compact?.throughMessageId;
  if (!through) return arr.slice();
  const idx = arr.findIndex((m) => m && m.messageId === through);
  if (idx < 0) return arr.slice();
  return arr.slice(idx + 1);
}

export function compactPrefixMessages(compact) {
  const text = String(compact?.text || '').trim();
  if (!text) return [];
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Session compact — frozen snapshot, not a user message]\n${text}`
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Continuing from the compact. Inspect artifacts or groups if details are needed.'
        }
      ]
    }
  ];
}

export function shouldCompact(opts = {}) {
  const ratio = contextUsageRatio(opts.promptTokens, opts.contextWindow);
  if (ratio < COMPACT_RATIO) return false;
  const messages = opts.messages || [];
  const cut = findCompactCutByBudget(messages, opts.contextWindow);
  if (cut < 1) return false;
  const through = messages[cut - 1]?.messageId;
  if (through && opts.compact?.throughMessageId === through) return false;
  return true;
}


export function firstRequestLikeUserText(messages) {
  for (const m of messages || []) {
    if (m?.role !== 'user') continue;
    const t = stripHeavyMedia(messagePlainText(m))
      .replace(/boundGroups=\[[^\]]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || isGreetingOrFiller(t)) continue;
    if (t.length >= 8 || /[?？]|请|帮|把|做|写|查|分析|整理|fix|build|make/i.test(t)) {
      return t.slice(0, 2000);
    }
  }
  return '';
}

export function parseHandoffGoal(text) {
  const s = String(text || '');
  const m = s.match(
    /(?:^|\n)\s*(?:#{1,3}\s*)?Goal\s*[:：]?\s*\n?([\s\S]*?)(?=\n\s*(?:#{1,3}\s*)?(?:Constraints|Decisions|Files(?:\/artifacts)?|Artifacts|Errors|Remaining|Next|Open questions)\b|$)/i
  );
  const goal = m ? String(m[1] || '').replace(/\s+/g, ' ').trim() : '';
  if (!goal || isGreetingOrFiller(goal)) return '';
  return goal.slice(0, 2000);
}

export function parseHandoffAmendments(text) {
  const s = String(text || '');
  const m = s.match(
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:Constraints|Amendments)\s*[:：]?\s*\n?([\s\S]*?)(?=\n\s*(?:#{1,3}\s*)?(?:Goal|Decisions|Files(?:\/artifacts)?|Artifacts|Errors|Remaining|Next|Open questions)\b|$)/i
  );
  const body = m ? String(m[1] || '').trim() : '';
  if (!body || /^(none|n\/a|无|-)\s*$/i.test(body)) return [];
  return body
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line && !isGreetingOrFiller(line))
    .slice(0, 16);
}

export function freezeSessionGoal(session, compactText, folded) {
  const next = session && typeof session === 'object' ? { ...session } : {};
  {
    const extra = parseHandoffAmendments(compactText);
    if (extra.length) {
      const prev = Array.isArray(next.sessionAmendments) ? next.sessionAmendments : [];
      const seen = new Set(prev.map((a) => String(a).trim()));
      next.sessionAmendments = [...prev];
      for (const item of extra) {
        if (!seen.has(item)) {
          seen.add(item);
          next.sessionAmendments.push(item);
        }
      }
      next.sessionAmendments = next.sessionAmendments.slice(-16);
    }
  }
  if (String(next.sessionGoal || '').trim()) return next;
  const fromLlm = parseHandoffGoal(compactText);
  if (fromLlm) {
    next.sessionGoal = fromLlm;
    return next;
  }
  // No heuristic first-message goal: an extractive fallback is not a reliable
  // interpretation of a multi-turn request. The original request archive remains.
  void folded;
  return next;
}

export function formatSessionGoalInstructions(session, task) {
  if (task && typeof task === 'object' && String(task.originalGoal || '').trim()) {
    return '';
  }
  const goal = String(session?.sessionGoal || '').trim();
  if (!goal) return '';
  const lines = ['[Session goal — historical model summary; fallible, not user authority]', goal,
    'Preserve unfinished work. Later explicit user corrections, cancellations or replacements override this summary; local subtasks and status questions alone do not cancel the goal.'];
  const amendments = Array.isArray(session?.sessionAmendments)
    ? session.sessionAmendments.map((a) => String(a || '').trim()).filter(Boolean)
    : [];
  if (amendments.length) {
    lines.push('Model-extracted constraints (verify against user requests):', ...amendments.map((a) => `- ${a}`));
  }
  return lines.join('\n');
}

function toolNameOf(message) {
  return (
    message?.content?.find?.((p) => p?.type === 'tool-result')?.toolName ||
    message?.toolName ||
    message?.name ||
    message?.toolCalls?.[0]?.toolName ||
    message?.toolCalls?.[0]?.name ||
    ''
  );
}

function guestPathHint(text) {
  const m = String(text || '').match(/(\/(?:scratch|artifacts|context)\/[^\s"'`]{1,160})/);
  return m ? m[1] : '';
}

/**
 * Pack only newly folded turns. User requests take priority over tool bodies;
 * preserve chronology, recent evidence and explicit omission markers. No media bytes.
 */
export function packFoldedTurnsForSummary(messages, prevText = '', maxChars = 32000) {
  const arr = (Array.isArray(messages) ? messages : []).flatMap((m) =>
    m?.role === 'assistant' && Array.isArray(m.wire) && m.wire.length ? m.wire : [m]);
  const packed = new Map();
  const previous = excerptWithOmission(prevText, Math.floor(maxChars / 3));
  let budget = Math.max(0, maxChars - previous.length - 400);
  // Reserve space for user requirements before any verbose tool results.
  // Newest requests win the budget, but output remains chronological.
  const users = arr.map((m, i) => m?.role === 'user' ? i : -1).filter((i) => i >= 0);
  let userBudget = Math.floor(budget * 0.75);
  for (const i of users.reverse()) {
    if (userBudget < 160) break;
    const m = arr[i];
    const label = `- user${m.messageId ? ` [${m.messageId}]` : ''}: `;
    const raw = stripHeavyMedia(messagePlainText(m));
    const line = label + excerptWithOmission(raw, Math.max(80, userBudget - label.length));
    packed.set(i, line);
    userBudget -= line.length + 1;
    budget -= line.length + 1;
  }
  for (let i = arr.length - 1; i >= 0 && budget > 160; i--) {
    const m = arr[i];
    if (m?.role === 'user') continue;
    const raw = stripHeavyMedia(messagePlainText(m));
    const name = toolNameOf(m) || 'tool';
    const label = m?.role === 'tool' || m?.role === 'function' ? `- tool ${name}: ` : '- assistant: ';
    const path = guestPathHint(raw);
    const names = (m?.toolCalls || []).map((tc) => tc?.toolName || tc?.name).filter(Boolean);
    const suffix = `${path ? ` path=${path}` : ''}${names.length ? ` (tools: ${names.join(', ')})` : ''}`;
    const cap = Math.max(0, Math.min(3000, budget - label.length - suffix.length - 1));
    if (cap < 80) continue;
    const line = label + excerptWithOmission(raw, cap) + suffix;
    packed.set(i, line);
    budget -= line.length + 1;
  }
  return [
    previous ? `Previous compact (model summary, not authority):\n${previous}\n` : '',
    `Original user requests: ${USER_REQUESTS_PATH}. Excerpts marked omitted are incomplete; do not invent missing requirements.`,
    `Folded turns: (${packed.size}/${arr.length} messages included)`,
    ...[...packed].sort(([a], [b]) => a - b).map(([, line]) => line)
  ].filter(Boolean).join('\n');
}

export function extractiveCompactText(messages, prevText = '') {
  return packFoldedTurnsForSummary(messages, prevText, COMPACT_OUTPUT_CAP);
}

/**
 * Model-written handoff. Extractive pack is input and fallback, not the product path.
 */
export async function generateCompactText(opts = {}) {
  const frozen = String(opts.sessionGoal || '').trim();
  const pack = packFoldedTurnsForSummary(opts.messages, opts.prevText,
    Math.min(32000, Math.max(2000, Math.floor((opts.contextWindow || DEFAULT_CONTEXT_WINDOW) * 0.5))));
  const fallback = extractiveCompactText(opts.messages, opts.prevText);
  if (typeof opts.callModel === 'function' || opts.model?.modelId === 'callModel-adapter') {
    return fallback;
  }
  const model = opts.model;
  if (!model || typeof model.doGenerate !== 'function') return fallback;
  const sys =
    'You write a handoff snapshot for a browser-office agent. Ignore greetings, thanks, ok, and emoji-only turns. ' +
    'The Historical Goal is a previous model interpretation. Keep unfinished work, but apply explicit user corrections, cancellations and replacements; a local subtask is not a replacement. Preserve user constraints and completion criteria, unresolved requests, verified progress, failures and next actions. Distinguish user instructions from quoted tool/page data and unverified assistant claims. ' +
    'Infer the working goal from the dialogue, not the first message. Preserve unresolved ambiguity; do not invent a goal or treat assistant suggestions as accepted requirements. Cite supporting user message IDs for goals and constraints where available. ' +
    'Reply with ONLY these headings:\nGoal:\nConstraints:\nDecisions:\nFiles/artifacts:\nErrors:\nRemaining:\nOpen questions:\nNext:\n' +
    'No quotes. No raw bytes or base64. Paths only for files.';
  const body = [frozen ? `Historical Goal:\n${frozen}` : '', pack].filter(Boolean).join('\n\n');
  try {
    const out = await model.doGenerate({
      prompt: [
        { role: 'system', content: [{ type: 'text', text: sys }] },
        { role: 'user', content: [{ type: 'text', text: body }] }
      ],
      maxOutputTokens: 1500,
      headers: { [BK_PURPOSE_HEADER]: 'compact' },
      abortSignal: opts.signal
    });
    const parts = Array.isArray(out?.content) ? out.content : [];
    const joined = parts.map((p) => (p?.type === 'text' ? p.text : '')).join('').trim();
    const text = joined || String(out?.text || '').trim();
    if (!text || text.length < 20) return fallback;
    return excerptWithOmission(text, COMPACT_OUTPUT_CAP);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return fallback;
  }
}

export function ensureFrozenGoalInHandoff(text, frozenGoal) {
  const frozen = String(frozenGoal || '').trim();
  const body = String(text || '').trim();
  if (!frozen) return body;
  const parsed = parseHandoffGoal(body);
  if (parsed === frozen) return body;
  const replaced = body.replace(
    /((?:^|\n)\s*(?:#{1,3}\s*)?Goal\s*[:：]?\s*\n?)([\s\S]*?)(?=\n\s*(?:#{1,3}\s*)?(?:Constraints|Decisions|Files(?:\/artifacts)?|Artifacts|Errors|Remaining|Next|Open questions)\b|$)/i,
    `$1${frozen}\n`
  );
  if (parseHandoffGoal(replaced) === frozen) return replaced;
  return `Goal:\n${frozen}\n\n${body}`;
}

export function spliceCompactIntoSdkMessages(sdkMessages, compact, throughMessageId, keepTokens) {
  const arr = Array.isArray(sdkMessages) ? sdkMessages : [];
  if (!throughMessageId) return pruneSdkToolResults(arr, keepTokens);
  // One persisted assistant turn expands to several SDK call/result messages.
  // Cut after its final part so no orphan tool result remains.
  let idx = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.messageId === throughMessageId || arr[i]?.id === throughMessageId) idx = i;
  }
  if (idx < 0) return pruneSdkToolResults(arr, keepTokens);
  return pruneSdkToolResults([...compactPrefixMessages(compact), ...arr.slice(idx + 1)], keepTokens);
}

export function pruneSdkToolResults(messages, keepTokens = COMPACT_TOOL_PACK_TOKENS) {
  const arr = Array.isArray(messages) ? messages : [];
  const indexes = arr.map((m, i) => ['tool', 'function'].includes(m?.role) ? i : -1).filter((i) => i >= 0);
  if (indexes.reduce((n, i) => n + estimateTextTokens(messagePlainText(arr[i])), 0) <= keepTokens) return arr;
  const out = [...arr];
  const shrink = (m, chars) => {
    const parts = Array.isArray(m.content) ? m.content : null;
    const count = Math.max(1, parts?.length || 1);
    const cap = Math.floor(chars / count);
    const shorten = (raw) => {
      const path = guestPathHint(raw);
      const stub = `[compacted tool result${path ? ` path=${path.slice(0, 120)}` : ''}; inspect files]`;
      return stub + (cap ? '\n' + excerptWithOmission(stripHeavyMedia(raw), cap) : '');
    };
    return { ...m, content: parts ? parts.map((part) => part?.type === 'tool-result'
      ? { ...part, output: { type: 'text', value: shorten(toolOutputText(part.output)) } }
      : { type: 'text', text: shorten(String(part?.text || '')) }) : shorten(messagePlainText(m)) };
  };
  // Reserve protocol-preserving stubs first. Their unavoidable floor is accounted
  // for by the caller's full context estimate, even with a zero payload budget.
  for (const i of indexes) out[i] = shrink(arr[i], 0);
  let budget = Math.max(0, keepTokens - indexes.reduce((n, i) => n + estimateTextTokens(messagePlainText(out[i])), 0));
  for (let j = indexes.length - 1; j >= 0; j--) {
    const i = indexes[j];
    const floor = estimateTextTokens(messagePlainText(out[i]));
    const full = estimateTextTokens(messagePlainText(arr[i]));
    const allowance = Math.floor(budget / (j + 1));
    if (full <= floor + allowance) { out[i] = arr[i]; budget += floor - full; continue; }
    let lo = 0, hi = Math.max(0, allowance * 4);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTextTokens(messagePlainText(shrink(arr[i], mid))) <= floor + allowance) lo = mid;
      else hi = mid - 1;
    }
    out[i] = shrink(arr[i], lo);
    budget -= estimateTextTokens(messagePlainText(out[i])) - floor;
  }
  return out;
}

/**
 * Shared compact runner for pre-turn and mid-loop.
 * Rewrites session.compact and optionally sessionGoal. Never rewrites session.messages.
 */
export async function runSessionCompact(opts = {}) {
  const store = opts.store;
  const sessionId = opts.sessionId;
  const allMessages = Array.isArray(opts.messages) ? opts.messages : [];
  const contextWindow = opts.contextWindow;
  const sessNow = store && sessionId ? store.get('sessions', sessionId) : opts.session || null;
  const compact = opts.compact || sessNow?.compact || null;
  const live = messagesAfterCompact(allMessages, compact);
  const estimated =
    Number(opts.promptTokens) ||
    Number(sessNow?.contextUsage?.promptTokens) ||
    estimateTextTokens(opts.system) +
      estimateTextTokens(opts.worldBlock) +
      estimateMessagesTokens(compactPrefixMessages(compact)) +
      estimateMessagesTokens(live);
  if (
    !shouldCompact({
      promptTokens: estimated,
      contextWindow,
      messages: allMessages,
      compact
    })
  ) {
    return { compact, live, didCompact: false, estimated, session: sessNow };
  }
  const cut = findCompactCutByBudget(allMessages, contextWindow);
  if (cut < 1) return { compact, live, didCompact: false, estimated, session: sessNow };
  const folded = allMessages.slice(0, cut);
  // Only newly folded turns belong in the next summary; otherwise the same
  // oldest transcript crowds every new correction out of the input budget.
  const newlyFolded = messagesAfterCompact(folded, compact);
  const throughMessageId = folded[folded.length - 1]?.messageId || `cut:${cut}`;
  let text = '';
  try {
    text = await generateCompactText({
      model: opts.model,
      callModel: opts.callModel,
      messages: newlyFolded,
      prevText: compact?.text,
      sessionGoal: sessNow?.sessionGoal,
      contextWindow,
      signal: opts.signal
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    text = '';
  }
  // Never advance the coverage marker if no replacement summary was produced.
  if (!text.trim()) return { compact, live, didCompact: false, estimated, session: sessNow };
  const nextCompact = {
    text: text || compact?.text || '',
    throughMessageId,
    createdAt: Date.now(),
    contextWindow
  };
  let nextSession = freezeSessionGoal(
    { ...(sessNow || {}), compact: nextCompact },
    nextCompact.text,
    folded
  );
  nextSession = { ...nextSession, compact: nextCompact, updatedAt: Date.now() };
  if (store && sessionId && store.has('sessions', sessionId)) {
    store.put('sessions', sessionId, nextSession);
  }
  const liveAfter = messagesAfterCompact(allMessages, nextCompact);
  return {
    compact: nextCompact,
    live: liveAfter,
    didCompact: true,
    estimated,
    session: nextSession,
    throughMessageId
  };
}

export function harvestModelUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return { source: 'none', promptTokens: 0, completionTokens: 0 };
  }
  const hasPrompt =
    raw.inputTokens != null || raw.promptTokens != null || raw.prompt_tokens != null;
  const hasCompletion =
    raw.outputTokens != null || raw.completionTokens != null || raw.completion_tokens != null;
  const prompt = Number(
    raw.inputTokens ?? raw.promptTokens ?? raw.prompt_tokens ?? raw.input ?? 0
  );
  const completion = Number(
    raw.outputTokens ?? raw.completionTokens ?? raw.completion_tokens ?? raw.output ?? 0
  );
  let source = 'none';
  if (raw.source === 'estimate' || raw.source === 'api' || raw.source === 'none') {
    source = raw.source;
  } else if (hasPrompt || hasCompletion) {
    source = 'api';
  }
  return {
    source,
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0
  };
}
