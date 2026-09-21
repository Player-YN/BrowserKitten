/**
 * Session workspace contract files — AGENTS.md / Memory.md / STATUS.md.
 *
 * Host creates all three on createSession. Pointers are rewritten after each
 * turn. Red lines and How to work stay agent-owned once edited.
 * Never user authorization (Durable Task contract + user originals win).
 */

import { createArtifact, listArtifacts } from './artifacts.js';
import { createSessionGuestFs } from './fs.js';

export const SESSION_AGENTS_PATH = '/artifacts/AGENTS.md';
export const SESSION_MEMORY_PATH = '/artifacts/Memory.md';
export const SESSION_STATUS_PATH = '/artifacts/STATUS.md';
/** Codex default project cap is 32 KiB; a session contract should stay smaller. */
export const AGENTS_MD_INJECT_CAP = 8192;
export const MEMORY_MD_INJECT_CAP = 2048;

export const WORKSPACE_FILE_PATHS = [SESSION_AGENTS_PATH, SESSION_MEMORY_PATH, SESSION_STATUS_PATH];

const DEFAULT_RED_LINE = 'Payment / receipt / publish confirmation: wait for the user.';
const STATUS_STUB_MARK = 'Host-maintained stub. Agent replaces this with current progress.';

export function isProtectedWorkspacePath(guestPath) {
  const p = String(guestPath || '').replace(/\\/g, '/');
  return WORKSPACE_FILE_PATHS.includes(p);
}

export function isProtectedWorkspaceName(name) {
  const n = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();
  return n === 'agents.md' || n === 'memory.md' || n === 'status.md';
}

export function isWorkspaceContractArtifact(rec) {
  if (!rec) return false;
  return isProtectedWorkspacePath(rec.primaryPath) || isProtectedWorkspaceName(rec.name);
}

export function sessionAgentsPresent(store, sessionId) {
  return workspaceFilePresent(store, sessionId, SESSION_AGENTS_PATH);
}

function workspaceFilePresent(store, sessionId, path) {
  if (!store || !sessionId) return false;
  try {
    return createSessionGuestFs(store, { sessionId }).exists(path);
  } catch {
    return false;
  }
}

export function readSessionAgentsMd(store, sessionId) {
  return readWorkspaceFile(store, sessionId, SESSION_AGENTS_PATH);
}

export function readSessionMemoryMd(store, sessionId) {
  return readWorkspaceFile(store, sessionId, SESSION_MEMORY_PATH);
}

export function readSessionStatusMd(store, sessionId) {
  return readWorkspaceFile(store, sessionId, SESSION_STATUS_PATH);
}

function readWorkspaceFile(store, sessionId, path) {
  if (!store || !sessionId) return '';
  try {
    const fs = createSessionGuestFs(store, { sessionId });
    if (!fs.exists(path)) return '';
    return String(fs.readFile(path) || '');
  } catch {
    return '';
  }
}

export function stubAgentsMd() {
  return [
    '# AGENTS.md',
    '',
    '## Red lines',
    `- ${DEFAULT_RED_LINE}`,
    '- Login, registration, and captcha: ask the user.',
    '- This file is working instructions, not user authorization. A Durable Task contract and the user\'s own words win.',
    '',
    '## How to work',
    '- Keep this file short. Evidence and notes belong in other `/artifacts` files.',
    `- Durable facts go in \`${SESSION_MEMORY_PATH}\`. Progress and the next step go in \`${SESSION_STATUS_PATH}\`.`,
    '- Edit this file only when a red line or a working method changes.',
    '- On a live site, act as a normal user when the task needs it.',
    '',
    '## Pointers',
    ...defaultPointerLines()
  ].join('\n') + '\n';
}

export function stubMemoryMd() {
  return [
    '# Memory.md',
    '',
    'Cross-turn facts for this session. The host does not overwrite this file after you edit it.',
    '',
    '## Facts',
    '- (none yet)'
  ].join('\n') + '\n';
}

export function stubStatusMd() {
  return [
    '# STATUS.md',
    '',
    STATUS_STUB_MARK,
    '',
    '## Now',
    '- Session just opened.',
    '',
    '## Next',
    '- (none yet)'
  ].join('\n') + '\n';
}

function defaultPointerLines() {
  return [
    '- User originals: `/context/user-requests.json`',
    '- Dialogue: `/context/conversation.json`',
    `- Memory: \`${SESSION_MEMORY_PATH}\``,
    `- Progress: Durable Task checkpoint or \`${SESSION_STATUS_PATH}\``
  ];
}

function writeWorkspaceFile(store, sessionId, path, name, content) {
  const fs = createSessionGuestFs(store, { sessionId });
  const created = !fs.exists(path);
  if (created) fs.writeFile(path, content, { mimeType: 'text/markdown' });
  const arts = listArtifacts(store, sessionId) || [];
  if (!arts.some((a) => a.primaryPath === path)) {
    try {
      createArtifact(store, fs, {
        sessionId,
        name,
        path,
        packageDir: '.workspace',
        content: typeof fs.readFileBytes === 'function' ? fs.readFileBytes(path) : content,
        mimeType: 'text/markdown',
        folder: 'files',
        skipValidation: true
      });
    } catch {
      /* listing still works from guest FS */
    }
  }
  return { created, path };
}

export function ensureSessionAgentsMd(store, sessionId, input = {}) {
  const sid = String(sessionId || '');
  if (!store || !sid) return { created: false, path: SESSION_AGENTS_PATH };
  return writeWorkspaceFile(store, sid, SESSION_AGENTS_PATH, 'AGENTS.md', stubAgentsMd(input));
}

export function ensureSessionWorkspaceFiles(store, sessionId, input = {}) {
  const sid = String(sessionId || '');
  if (!store || !sid) {
    return { ok: false, created: [] };
  }
  const created = [];
  const agents = ensureSessionAgentsMd(store, sid, input);
  if (agents.created) created.push(SESSION_AGENTS_PATH);
  const memory = writeWorkspaceFile(store, sid, SESSION_MEMORY_PATH, 'Memory.md', stubMemoryMd());
  if (memory.created) created.push(SESSION_MEMORY_PATH);
  const status = writeWorkspaceFile(store, sid, SESSION_STATUS_PATH, 'STATUS.md', stubStatusMd());
  if (status.created) created.push(SESSION_STATUS_PATH);
  return { ok: true, created };
}

export function agentsMdLooksLikeStub(text) {
  const raw = String(text || '');
  return raw.includes(DEFAULT_RED_LINE) && /## Pointers/.test(raw);
}

export function statusMdLooksLikeStub(text) {
  return String(text || '').includes(STATUS_STUB_MARK);
}

export function memoryMdLooksLikeStub(text) {
  return /## Facts\n- \(none yet\)/.test(String(text || ''));
}

/**
 * Rewrite only the ## Pointers section. Leaves Red lines / How to work alone.
 * @param {string} text
 * @param {string[]} extraPaths guest paths under /artifacts
 */
export function replaceAgentsMdPointers(text, extraPaths = []) {
  const raw = String(text || '');
  const files = [...new Set((Array.isArray(extraPaths) ? extraPaths : []).map(String).filter(Boolean))]
    .filter((p) => p.startsWith('/artifacts/') && !p.startsWith('/artifacts/.trash/'))
    .sort();
  const lines = [
    '## Pointers',
    ...defaultPointerLines()
  ];
  if (files.length) {
    lines.push('- Files:');
    for (const p of files) lines.push(`  - \`${p}\``);
  }
  const block = `${lines.join('\n')}\n`;
  if (/^## Pointers\b/m.test(raw)) {
    return raw.replace(/## Pointers\b[\s\S]*?(?=\n## |\s*$)/, block.trimEnd()) + (/\n$/.test(raw) ? '\n' : '');
  }
  return `${raw.replace(/\s*$/, '')}\n\n${block}`;
}

export function refreshAgentsMdPointers(store, sessionId) {
  const sid = String(sessionId || '');
  if (!store || !sid) return { ok: false };
  const fs = createSessionGuestFs(store, { sessionId: sid });
  if (!fs.exists(SESSION_AGENTS_PATH)) return { ok: false };
  const current = String(fs.readFile(SESSION_AGENTS_PATH) || '');
  const arts = listArtifacts(store, sid) || [];
  const paths = arts.map((a) => a.primaryPath).filter(Boolean);
  for (const p of WORKSPACE_FILE_PATHS) {
    if (fs.exists(p) && !paths.includes(p)) paths.push(p);
  }
  const next = replaceAgentsMdPointers(current, paths);
  if (next !== current) fs.writeFile(SESSION_AGENTS_PATH, next, { mimeType: 'text/markdown' });
  return { ok: true, path: SESSION_AGENTS_PATH };
}

export function maybeWriteStatusTurnSnippet(store, sessionId, input = {}) {
  const sid = String(sessionId || '');
  if (!store || !sid) return { ok: false };
  const fs = createSessionGuestFs(store, { sessionId: sid });
  if (!fs.exists(SESSION_STATUS_PATH)) return { ok: false };
  const current = String(fs.readFile(SESSION_STATUS_PATH) || '');
  if (!statusMdLooksLikeStub(current) && !input.force) return { ok: false, skipped: true };
  const status = String(input.status || 'settled');
  const when = new Date(Number(input.at) || Date.now()).toISOString();
  const next = [
    '# STATUS.md',
    '',
    STATUS_STUB_MARK,
    '',
    '## Now',
    `- Last turn: ${status} at ${when}.`,
    '',
    '## Next',
    '- (none yet)'
  ].join('\n') + '\n';
  fs.writeFile(SESSION_STATUS_PATH, next, { mimeType: 'text/markdown' });
  return { ok: true, path: SESSION_STATUS_PATH };
}

export function formatAgentsMdInstructions(text, cap = AGENTS_MD_INJECT_CAP) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const limit = Math.max(400, Number(cap) || AGENTS_MD_INJECT_CAP);
  const body = raw.length > limit ? `${raw.slice(0, limit)}\n…[truncated]` : raw;
  return [
    '[Workspace AGENTS.md — agent-facing contract, fallible]',
    `Path: ${SESSION_AGENTS_PATH}. Workspace instructions (how to work here), not user authorization.`,
    `A Durable Task contract and quoted user originals take precedence. Everyday progress belongs in ${SESSION_STATUS_PATH} or a task checkpoint, not in this file.`,
    'Before you finish this turn, update Memory.md when a durable fact changed and STATUS.md when progress or the next step changed. Edit AGENTS.md only when a red line or a working method changed. The host rewrites Pointers after the turn. These three files stay; do not delete them. This file is not proof of completion.',
    body
  ].join('\n');
}

export function formatMemoryMdInstructions(text, cap = MEMORY_MD_INJECT_CAP) {
  const raw = String(text || '').trim();
  if (!raw || memoryMdLooksLikeStub(raw)) return '';
  const limit = Math.max(200, Number(cap) || MEMORY_MD_INJECT_CAP);
  const body = raw.length > limit ? `${raw.slice(0, limit)}\n…[truncated]` : raw;
  return [
    '[Workspace Memory.md — cross-turn facts, fallible]',
    `Path: ${SESSION_MEMORY_PATH}. Facts only. Not authorization and not a progress diary.`,
    body
  ].join('\n');
}
