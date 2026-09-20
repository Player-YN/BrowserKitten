/**
 * Token-window compact for the model wire (not the UI transcript).
 *
 * Industry shape: occupancy trigger, model-written handoff, pinned high-level
 * goal (not the first greeting), tool bodies truncated before summarize,
 * recent tail kept on a user boundary.
 */

import { DEFAULT_CONTEXT_WINDOW } from '../../modelCatalog.js';

export const COMPACT_RATIO = 0.8;
export const COMPACT_KEEP_USER_TURNS = 2;
export const COMPACT_TAIL_WINDOW_FRACTION = 0.2;
export const COMPACT_TAIL_TOKEN_CAP = 20000;
export const COMPACT_TOOL_PACK_TOKENS = 20000;
export const COMPACT_OUTPUT_CAP = 4000;

const GREETING_RE =
  /^(hi|hello|hey|yo|sup|thanks|thankyou|thx|ok|okay|k|嗯+|啊+|哈+|嘿|嗨|你好|您好|谢谢|早安|早上好|晚上好|在吗|呢)$/i;

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
        return String(p.text || p.content || '');
      })
      .filter(Boolean)
      .join('\n');
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
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
  if (message?.wire) n += estimateTextTokens(JSON.stringify(message.wire).slice(0, 8000));
  else if (message?.toolCalls) n += estimateTextTokens(JSON.stringify(message.toolCalls).slice(0, 4000));
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

export function isGreetingOrFiller(text) {
  const raw = String(text || '')
    .replace(/boundGroups=\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return true;
  const compact = raw.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!compact) return true;
  if (GREETING_RE.test(compact)) return true;
  if (raw.length <= 24 && /^(hi|hello|hey|你好|您好|谢谢|thanks|ok|okay)([\s!！。.~～]*)$/i.test(raw)) {
    return true;
  }
  return false;
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
  if (String(next.sessionGoal || '').trim()) {
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
    return next;
  }
  const fromLlm = parseHandoffGoal(compactText);
  if (fromLlm) {
    next.sessionGoal = fromLlm;
    return next;
  }
  const fallback = firstRequestLikeUserText(folded);
  if (fallback) next.sessionGoal = fallback;
  return next;
}

export function formatSessionGoalInstructions(session, task) {
  if (task && typeof task === 'object' && String(task.originalGoal || '').trim()) {
    return '';
  }
  const goal = String(session?.sessionGoal || '').trim();
  if (!goal) return '';
  const lines = ['[Session goal — immutable]', goal];
  const amendments = Array.isArray(session?.sessionAmendments)
    ? session.sessionAmendments.map((a) => String(a || '').trim()).filter(Boolean)
    : [];
  if (amendments.length) {
    lines.push('Amendments (do not replace the goal):', ...amendments.map((a) => `- ${a}`));
  }
  return lines.join('\n');
}

function toolNameOf(message) {
  return (
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
 * Pack folded turns for the summarizer: recent tool bodies up to 20k tokens,
 * older tools as name + short conclusion + path. No media bytes.
 */
export function packFoldedTurnsForSummary(messages, prevText = '') {
  const arr = Array.isArray(messages) ? messages : [];
  const packed = new Array(arr.length);
  let toolBudget = COMPACT_TOOL_PACK_TOKENS;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const role = m?.role;
    const raw = stripHeavyMedia(messagePlainText(m))
      .replace(/boundGroups=\[[^\]]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (role === 'user') {
      packed[i] = `- user: ${raw.slice(0, 400)}`;
      continue;
    }
    if (role === 'assistant') {
      const names = (m?.toolCalls || []).map((tc) => tc?.toolName || tc?.name).filter(Boolean);
      packed[i] = `- assistant: ${raw.slice(0, 400)}${names.length ? ` (tools: ${names.join(', ')})` : ''}`;
      continue;
    }
    if (role === 'tool' || m?.wire || role === 'function') {
      const name = toolNameOf(m) || 'tool';
      const path = guestPathHint(raw);
      const tokens = estimateTextTokens(raw);
      if (toolBudget > 0 && tokens) {
        const take = raw.slice(0, Math.min(raw.length, toolBudget * 4));
        toolBudget -= estimateTextTokens(take);
        packed[i] = `- tool ${name}: ${take}${path ? ` path=${path}` : ''}`;
      } else {
        packed[i] = `- tool ${name}: ${raw.slice(0, 180)}${path ? ` path=${path}` : ''}`;
      }
    }
  }
  const lines = [];
  if (prevText) {
    lines.push('Previous compact:', String(prevText).slice(0, 2000), '');
  }
  lines.push('Folded turns:');
  for (const item of packed) {
    if (item) lines.push(item);
  }
  return lines.join('\n').slice(0, 12000);
}

export function extractiveCompactText(messages, prevText = '') {
  return packFoldedTurnsForSummary(messages, prevText).slice(0, COMPACT_OUTPUT_CAP);
}

/**
 * Model-written handoff. Extractive pack is input and fallback, not the product path.
 */
export async function generateCompactText(opts = {}) {
  const frozen = String(opts.sessionGoal || '').trim();
  const pack = packFoldedTurnsForSummary(opts.messages, opts.prevText);
  const fallback = pack.slice(0, COMPACT_OUTPUT_CAP);
  if (typeof opts.callModel === 'function' || opts.model?.modelId === 'callModel-adapter') {
    return fallback;
  }
  const model = opts.model;
  if (!model || typeof model.doGenerate !== 'function') return fallback;
  const sys =
    'You write a handoff snapshot for a browser-office agent. Ignore greetings, thanks, ok, and emoji-only turns. ' +
    'If a Frozen Goal is provided, copy it into Goal — do not replace it with a later local subtask. ' +
    'Reply with ONLY these headings:\nGoal:\nConstraints:\nDecisions:\nFiles/artifacts:\nErrors:\nRemaining:\nNext:\n' +
    'No quotes. No raw bytes or base64. Paths only for files.';
  const body = [frozen ? `Frozen Goal:\n${frozen}` : '', pack].filter(Boolean).join('\n\n').slice(0, 8000);
  try {
    const out = await model.doGenerate({
      prompt: [
        { role: 'system', content: [{ type: 'text', text: sys }] },
        { role: 'user', content: [{ type: 'text', text: body }] }
      ],
      maxOutputTokens: 1500
    });
    const parts = Array.isArray(out?.content) ? out.content : [];
    const joined = parts.map((p) => (p?.type === 'text' ? p.text : '')).join('').trim();
    const text = joined || String(out?.text || '').trim();
    if (!text || text.length < 20) return fallback;
    return ensureFrozenGoalInHandoff(text, frozen).slice(0, COMPACT_OUTPUT_CAP);
  } catch {
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

export function spliceCompactIntoSdkMessages(sdkMessages, compact, throughMessageId) {
  const arr = Array.isArray(sdkMessages) ? sdkMessages : [];
  if (!throughMessageId) return pruneSdkToolResults(arr);
  const idx = arr.findIndex(
    (m) => m && (m.messageId === throughMessageId || m.id === throughMessageId)
  );
  if (idx < 0) return pruneSdkToolResults(arr);
  return pruneSdkToolResults([...compactPrefixMessages(compact), ...arr.slice(idx + 1)]);
}

export function pruneSdkToolResults(messages, keepTokens = COMPACT_TOOL_PACK_TOKENS) {
  const arr = Array.isArray(messages) ? messages : [];
  let budget = keepTokens;
  let keptRecent = false;
  let changed = false;
  const out = arr.map((m) => m);
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const role = m?.role;
    if (role !== 'tool' && role !== 'function') continue;
    const raw = stripHeavyMedia(messagePlainText(m));
    const tokens = estimateTextTokens(raw);
    if (!keptRecent || tokens <= budget) {
      keptRecent = true;
      budget = Math.max(0, budget - tokens);
      continue;
    }
    const name = toolNameOf(m) || 'tool';
    const path = guestPathHint(raw);
    const stub = `[compacted tool result: ${name}${path ? ` path=${path}` : ''}; inspect files if details are needed]`;
    out[i] = {
      ...m,
      content: typeof m.content === 'string' || m.content == null ? stub : [{ type: 'text', text: stub }]
    };
    changed = true;
  }
  return changed ? out : arr;
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
  const throughMessageId = folded[folded.length - 1]?.messageId || `cut:${cut}`;
  let text = '';
  try {
    text = await generateCompactText({
      model: opts.model,
      callModel: opts.callModel,
      messages: folded,
      prevText: compact?.text,
      sessionGoal: sessNow?.sessionGoal
    });
  } catch {
    text = '';
  }
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
