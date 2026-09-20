/**
 * Session-workspace AGENTS.md — same role as coding-agent AGENTS.md, not a diary.
 *
 * Codex / agents.md: short executable contract, host-injected when present,
 * nested notes live elsewhere. Progress is task checkpoint or STATUS.md.
 * Never user authorization (Durable Task contract + user originals win).
 */

import { createSessionGuestFs } from './fs.js';

export const SESSION_AGENTS_PATH = '/artifacts/AGENTS.md';
export const SESSION_STATUS_PATH = '/artifacts/STATUS.md';
/** Codex default project cap is 32 KiB; a session contract should stay smaller. */
export const AGENTS_MD_INJECT_CAP = 8192;

export function sessionAgentsPresent(store, sessionId) {
  if (!store || !sessionId) return false;
  try {
    return createSessionGuestFs(store, { sessionId }).exists(SESSION_AGENTS_PATH);
  } catch {
    return false;
  }
}

export function readSessionAgentsMd(store, sessionId) {
  if (!store || !sessionId) return '';
  try {
    const fs = createSessionGuestFs(store, { sessionId });
    if (!fs.exists(SESSION_AGENTS_PATH)) return '';
    return String(fs.readFile(SESSION_AGENTS_PATH) || '');
  } catch {
    return '';
  }
}

export function stubAgentsMd(input = {}) {
  const title = String(input.title || '').trim() || 'Session workspace';
  const summary = String(input.summary || '').trim();
  const lines = [
    '# AGENTS.md',
    '',
    '## Workspace',
    title
  ];
  if (summary) lines.push('', summary);
  lines.push(
    '',
    '## Red lines',
    '- Payment / receipt / publish confirmation: wait for the user.',
    '- Login / registration / captcha: ask the user.',
    '- This file is working instructions, not user authorization. A Durable Task contract (if any) and user originals win.',
    '',
    '## How to work',
    '- Keep this file short. Put evidence and notes in other `/artifacts` files and link them from Pointers.',
    `- Record progress in the Durable Task checkpoint, or in \`${SESSION_STATUS_PATH}\` if no task is bound.`,
    '- On live sites, act as a normal user when the task requires it (including sending messages). Do not ask for extra permission for ordinary chat.',
    '',
    '## Pointers',
    '- User originals: `/context/user-requests.json`',
    '- Dialogue: `/context/conversation.json`',
    `- Progress: Durable Task checkpoint or \`${SESSION_STATUS_PATH}\``
  );
  return `${lines.join('\n')}\n`;
}

export function ensureSessionAgentsMd(store, sessionId, input = {}) {
  const sid = String(sessionId || '');
  if (!store || !sid) return { created: false, path: SESSION_AGENTS_PATH };
  const fs = createSessionGuestFs(store, { sessionId: sid });
  if (fs.exists(SESSION_AGENTS_PATH)) {
    return { created: false, path: SESSION_AGENTS_PATH };
  }
  fs.writeFile(SESSION_AGENTS_PATH, stubAgentsMd(input), { mimeType: 'text/markdown' });
  return { created: true, path: SESSION_AGENTS_PATH };
}

export function formatAgentsMdInstructions(text, cap = AGENTS_MD_INJECT_CAP) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const limit = Math.max(400, Number(cap) || AGENTS_MD_INJECT_CAP);
  const body = raw.length > limit ? `${raw.slice(0, limit)}\n…[truncated]` : raw;
  return [
    '[Workspace AGENTS.md — agent-facing contract, fallible]',
    `Path: ${SESSION_AGENTS_PATH}. Workspace instructions (how to work here), not user authorization.`,
    `A Durable Task contract and quoted user originals take precedence. Progress belongs in the task checkpoint or ${SESSION_STATUS_PATH}, not in this file.`,
    'Update this file when red lines, working method, or pointers change. Do not treat it as proof of completion.',
    body
  ].join('\n');
}
