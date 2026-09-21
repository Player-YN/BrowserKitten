/**
 * Current-session conversation Markdown (not agent trajectory / tool path).
 */

export function sessionRecordPlainText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return c == null ? '' : String(c);
}

export function sessionRecordTurns(messages) {
  return (Array.isArray(messages) ? messages : []).filter((msg) => {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return false;
    return !!sessionRecordPlainText(msg).trim();
  }).length;
}

export function buildSessionRecordMarkdown({ title, messages, exportedAt, labels } = {}) {
  const L = labels || {};
  const heading = L.heading || 'Conversation';
  const lines = [`# ${heading}: ${title || L.untitled || ''}`, ''];
  if (exportedAt) {
    lines.push(`${L.exportedAt || 'Exported'}: ${exportedAt}`, '');
  }
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = sessionRecordPlainText(msg).trim();
    if (!text) continue;
    const who = msg.role === 'user' ? L.user || 'User' : L.assistant || 'Assistant';
    lines.push(`## ${who}`, '', text, '');
  }
  return lines.join('\n');
}

export function sessionRecordFilename(name, lang, now = new Date()) {
  const safe =
    String(name || '')
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || (lang === 'en' ? 'session' : '会话');
  const prefix = lang === 'en' ? 'conversation' : '会话记录';
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${prefix}_${safe}_${y}-${m}-${d}.md`;
}
