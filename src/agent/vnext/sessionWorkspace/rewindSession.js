/**
 * Drop a user turn and everything after it so the text can be edited and sent again.
 * Does not delete artifacts, files, or task contracts — those already happened.
 */

import { messagePlainText } from './contextCompact.js';

function findRewindCut(messages, { messageId, userIndex } = {}) {
  const id = String(messageId || '').trim();
  if (id) {
    const at = messages.findIndex((m) => m?.role === 'user' && String(m.messageId || '') === id);
    if (at >= 0) return at;
  }
  if (userIndex == null || userIndex === '') return -1;
  const want = Number(userIndex);
  if (!Number.isInteger(want) || want < 0) return -1;
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'user') continue;
    if (seen === want) return i;
    seen += 1;
  }
  return -1;
}

/**
 * @param {object} session
 * @param {{ messageId?: string, userIndex?: number }} locator
 * @returns {{ session: object, restored: { messageId: string, content: string } }}
 */
export function rewindSessionRecord(session, locator = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const cut = findRewindCut(messages, locator);
  if (cut < 0) {
    const err = new Error('rewindSession: message not found');
    err.code = 'REWIND_NOT_FOUND';
    throw err;
  }
  const removed = messages[cut];
  const kept = messages.slice(0, cut);
  const through = session?.compact?.throughMessageId;
  const compactValid = !!(through && kept.some((m) => m && m.messageId === through));
  const next = {
    ...session,
    messages: kept,
    updatedAt: Date.now()
  };
  delete next.turnProgress;
  if (!compactValid) delete next.compact;
  return {
    session: next,
    restored: {
      messageId: removed?.messageId ? String(removed.messageId) : '',
      content: messagePlainText(removed)
    }
  };
}
