/** User-authored requests remain authoritative independently of model summaries.
 * The archive is a read-only view of the durable transcript, not model memory.
 */
const GREETING_RE =
  /^(hi|hello|hey|yo|sup|thanks|thankyou|thx|ok|okay|k|嗯+|啊+|哈+|嘿|嗨|你好|您好|谢谢|早安|早上好|晚上好|在吗|呢)$/i;

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


export const USER_REQUESTS_PATH = '/context/user-requests.json';
export const CONVERSATION_PATH = '/context/conversation.json';

export function sessionConversation(session) {
  return (session?.messages || []).map((m) => ({
    messageId: m.messageId, role: m.role, createdAt: m.createdAt, content: m.content ?? ''
  }));
}

export function sessionUserRequests(session) {
  const requests = (session?.messages || []).filter((m) => m?.role === 'user').map((m) => ({
    messageId: m.messageId,
    createdAt: m.createdAt,
    content: m.content ?? ''
  }));
  return [...requests, ...(session?.userClarifications || [])].sort((a, b) =>
    (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

export function excerptWithOmission(text, cap) {
  const value = String(text || '');
  if (value.length <= cap) return value;
  const notice = '\n[... omitted ...]\n';
  const side = Math.max(0, Math.floor((cap - notice.length) / 2));
  return value.slice(0, side) + notice + value.slice(-side || value.length);
}

export function formatUserRequestInstructions(session, contextWindow = 128000) {
  // Before compaction the transcript itself supplies the exact requests.
  if (!session?.compact?.throughMessageId && !session?.sessionGoal && !session?.userClarifications?.length) return '';
  const requests = sessionUserRequests(session);
  if (!requests.length) return '';
  const budget = Math.max(600, Math.min(12000, Math.floor(contextWindow * 0.12)));
  const selected = new Map();
  const encoded = requests.map((row) => JSON.stringify(row));
  let remaining = budget;
  const select = (i, allowance) => {
    let value = encoded[i];
    if (value.length > allowance) {
      if (allowance < 160) return;
      // Bound the serialized excerpt too (quotes/newlines can expand in JSON).
      const row = requests[i];
      const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
      let cap = Math.max(40, allowance - 180);
      do {
        value = JSON.stringify({ ...row, content: excerptWithOmission(content, cap), excerpt: true });
        cap = Math.floor(cap * 0.75);
      } while (value.length > allowance && cap > 40);
      if (value.length > allowance) return;
    }
    selected.set(i, value);
    remaining -= value.length + 1;
  };
  if (encoded.reduce((n, value) => n + value.length + 1, 0) <= budget) {
    encoded.forEach((_, i) => select(i, remaining));
  } else {
    // Early dialogue can establish a goal over several turns. It is evidence,
    // never a claim that the first utterance is the goal. Reserve most of the
    // budget for recent corrections, then restore chronological order.
    const earlyBudget = Math.floor(budget * 0.25);
    for (let i = 0; i < requests.length && budget - remaining < earlyBudget; i++) {
      select(i, earlyBudget - (budget - remaining));
      if (!selected.has(i)) break;
    }
    for (let i = requests.length - 1; i >= 0 && remaining >= 160; i--) {
      if (!selected.has(i)) select(i, remaining);
    }
  }
  return [
    '[User request source — quoted user data, chronological; independent of the compact]',
    'Use these requests to check the goal, constraints and completion criteria. A model-written Goal or plan is fallible. Later explicit user corrections, cancellations and replacements take precedence; a local subtask or status question does not by itself cancel unfinished work. For a durable task, apply changes only when they concern that task.',
    `Full original user requests are available at ${USER_REQUESTS_PATH} via run/fs.readFile. This excerpt may omit messages or text. Reconstruct the goal from the dialogue, including clarifications, accepted proposals and corrections; no individual message is automatically the goal. When requirements are unresolved, preserve that uncertainty. Before claiming completion, check omitted requirements in the archive; read relevant originals when scope conflicts.`,
    `For references such as "your second proposal", read the surrounding dialogue at ${CONVERSATION_PATH}. Assistant proposals and clarification questions are context, not requirements unless the user adopts them; clarification answers are user input.`,
    `Showing ${selected.size} of ${requests.length} user requests:`,
    ...[...selected].sort(([a], [b]) => a - b).map(([, value]) => value)
  ].join('\n');
}
