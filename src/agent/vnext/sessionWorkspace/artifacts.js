/**
 * Durable Session artifacts — never auto-GC'd.
 * Format truth + session ownership enforced at create/update/delete.
 */

import { createArtifactId } from './ids.js';
import { assertArtifactOwned } from './auth.js';
import { validateArtifactBytes, guessMimeFromName } from './artifactValidate.js';
import { htmlWritePolicy } from './htmlWritePolicy.js';
import { persistableCapabilityHint } from './artifactCapability.js';

export const READ_ARTIFACT_HARD_CAP = 8 * 1024 * 1024;
export const READ_ARTIFACT_PREVIEW_DEFAULT = 64 * 1024;
export const READ_ARTIFACT_PREVIEW_HARD_CAP = READ_ARTIFACT_HARD_CAP;
export const READ_ARTIFACT_DEFAULT_MAX = READ_ARTIFACT_PREVIEW_HARD_CAP;

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} fs
 * @param {{
 *   sessionId: string,
 *   name: string,
 *   path?: string,
 *   content?: string|Uint8Array|number[],
 *   mimeType?: string,
 *   packageDir?: string,
 *   skipValidation?: boolean
 * }} input
 */
export function createArtifact(store, fs, input) {
  if (input?.ephemeral || input?.persist === false) {
    const err = new Error('ephemeral preview cannot become an artifact');
    err.code = 'EPHEMERAL_PREVIEW';
    throw err;
  }
  const sessionId = String(input.sessionId || '');
  if (!sessionId) throw new Error('createArtifact: sessionId required');
  if (fs.sessionId && String(fs.sessionId) !== sessionId) {
    throw new Error('createArtifact: fs session mismatch');
  }

  const artifactId = createArtifactId();
  const bytes = coerceBytes(input.content);
  let name = safeArtifactFileName(input.name || artifactId) || String(artifactId);
  name = applyHtmlExtensionIfNeeded(name, bytes, input.mimeType);
  const packageDir = input.packageDir || name.replace(/\.[^.]+$/, '') || name;
  let guestPath =
    input.path || `/artifacts/${packageDir}/${name.includes('.') ? name : name + '.md'}`;
  if (looksLikeHtmlBytes(bytes, input.mimeType) && /\.md$/i.test(guestPath)) {
    guestPath = guestPath.replace(/\.md$/i, '.html');
    name = name.replace(/\.md$/i, '.html');
  }
  const declared = input.mimeType || guessMimeFromName(name.toLowerCase());
  if (!input.skipValidation) {
    const check = validateArtifactBytes(name, bytes, declared);
    if (!check.valid) {
      const err = new Error(`ARTIFACT_TRUTH: ${check.error}`);
      err.code = 'ARTIFACT_TRUTH';
      throw err;
    }
  }
  const mimeType = input.mimeType || declared;

  fs.mkdirp(`/artifacts/${packageDir}`);
  fs.writeFile(guestPath, bytes, { mimeType });

  const record = {
    artifactId,
    sessionId,
    name,
    packageDir,
    primaryPath: guestPath,
    mimeType,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    size: bytes.byteLength,
    ...capabilityFields(name, mimeType, bytes)
  };
  const displayLabel = String(input.displayLabel || '').trim();
  if (displayLabel) record.displayLabel = displayLabel;
  const folder = String(input.folder || '').trim();
  if (folder) record.folder = folder;
  store.put('artifacts', artifactId, record);
  reindexArtifacts(store, sessionId);
  return record;
}

/**
 * Write an extra package file under the same packageDir (validated).
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} fs
 * @param {{ sessionId: string, artifactId: string, path: string, content: string|Uint8Array, mimeType?: string }} input
 */
export function writePackageFile(store, fs, input) {
  const gate = assertArtifactOwned(store, input.sessionId, input.artifactId);
  if (!gate.ok) {
    const err = new Error(gate.error);
    err.code = gate.code;
    throw err;
  }
  const rec = gate.record;
  const guestPath = String(input.path || '');
  if (!guestPath.startsWith(`/artifacts/${rec.packageDir}/`)) {
    throw new Error('package file must live under artifact packageDir');
  }
  const bytes = coerceBytes(input.content);
  const name = guestPath.split('/').pop() || 'file';
  const check = validateArtifactBytes(name, bytes, input.mimeType || '');
  if (!check.valid) {
    const err = new Error(`ARTIFACT_TRUTH: ${check.error}`);
    err.code = 'ARTIFACT_TRUTH';
    throw err;
  }
  fs.mkdirp(`/artifacts/${rec.packageDir}`);
  fs.writeFile(guestPath, bytes, { mimeType: check.mimeType });
  return { ok: true, path: guestPath, bytes: bytes.byteLength };
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} fs
 * @param {string} sessionId
 * @param {string} artifactId
 * @param {string|Uint8Array|number[]} content
 * @param {{ mimeType?: string, name?: string, expectedRevision?: number }} [opts]
 */
export function updateArtifactContent(store, fs, sessionId, artifactId, content, opts = {}) {
  const gate = assertArtifactOwned(store, sessionId, artifactId);
  if (!gate.ok) {
    const err = new Error(gate.error);
    err.code = gate.code;
    throw err;
  }
  const rec = gate.record;
  const bytes = coerceBytes(content);
  const name = String(opts.name || rec.name || artifactId);
  const mimeType = opts.mimeType || rec.mimeType;
  const revision = Number(rec.revision) || 0;
  if (opts.expectedRevision != null && Number(opts.expectedRevision) !== revision) {
    // A previous write may have committed but lost its response. Identical
    // retries are safe, including retrying persistence after a disk failure.
    const current = fs.readFileBytes(rec.primaryPath);
    if (name === rec.name && mimeType === rec.mimeType && current.length === bytes.length &&
      current.every((value, i) => value === bytes[i])) return rec;
    throw Object.assign(new Error(`ARTIFACT_CONFLICT: expected revision ${opts.expectedRevision}, current ${revision}. Local edits were not written; reopen or save a copy before resolving.`), {
      code: 'ARTIFACT_CONFLICT', expectedRevision: opts.expectedRevision, actualRevision: revision
    });
  }
  const check = validateArtifactBytes(name, bytes, mimeType);
  if (!check.valid) {
    const err = new Error(`ARTIFACT_TRUTH: ${check.error}`);
    err.code = 'ARTIFACT_TRUTH';
    throw err;
  }
  let primaryPath = rec.primaryPath;
  if (name !== rec.name) {
    primaryPath = String(rec.primaryPath || '').replace(/[^/]+$/, name) || rec.primaryPath;
  }
  rememberArtifactUndo(store, fs, rec);
  fs.writeFile(primaryPath, bytes, { mimeType: check.mimeType });
  const next = {
    ...rec,
    name,
    primaryPath,
    mimeType: check.mimeType,
    updatedAt: Date.now(),
    size: bytes.byteLength,
    canUndo: true,
    revision: revision + 1,
    ...capabilityFields(name, check.mimeType, bytes)
  };
  store.put('artifacts', artifactId, next);
  reindexArtifacts(store, rec.sessionId);
  return next;
}

export function artifactUndoBlobKey(artifactId) {
  return `artifactUndo:${String(artifactId || '')}`;
}

function rememberArtifactUndo(store, fs, rec) {
  if (!store || !fs || !rec?.artifactId) return;
  try {
    const prev = fs.readFileBytes(rec.primaryPath);
    if (prev?.byteLength) {
      store.putBlob(artifactUndoBlobKey(rec.artifactId), prev, { mimeType: rec.mimeType });
    }
  } catch {
    /* first write has no previous bytes */
  }
}

/**
 * One-step durable revert for in-place site/doc/sheet overwrites.
 * Swaps current bytes with the last update's previous bytes.
 */
export function revertArtifactContent(store, fs, sessionId, artifactId) {
  const gate = assertArtifactOwned(store, sessionId, artifactId);
  if (!gate.ok) {
    return { ok: false, error: gate.error, code: gate.code };
  }
  const rec = gate.record;
  const blob = store.getBlob(artifactUndoBlobKey(artifactId));
  if (!blob?.bytes?.byteLength) {
    return { ok: false, code: 'NO_UNDO', error: 'nothing to revert' };
  }
  let current = null;
  try {
    current = fs.readFileBytes(rec.primaryPath);
  } catch {
    current = null;
  }
  fs.writeFile(rec.primaryPath, blob.bytes, { mimeType: blob.mimeType || rec.mimeType });
  if (current?.byteLength) {
    store.putBlob(artifactUndoBlobKey(artifactId), current, { mimeType: rec.mimeType });
  } else {
    store.deleteBlob(artifactUndoBlobKey(artifactId));
  }
  const next = {
    ...rec,
    updatedAt: Date.now(),
    size: blob.bytes.byteLength,
    canUndo: !!(current && current.byteLength),
    revision: (Number(rec.revision) || 0) + 1
  };
  store.put('artifacts', artifactId, next);
  reindexArtifacts(store, rec.sessionId);
  return { ok: true, artifact: next, reverted: true };
}

/** Keep CJK + ascii stems so shelf titles like 「帅哥头像」survive create. */
export function safeArtifactFileName(name) {
  return String(name || '')
    .replace(/[/\\]+/g, '')
    .replace(/[^\w.\u4e00-\u9fff\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^\.+/, '');
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 */
export function listArtifacts(store, sessionId) {
  return store
    .keys('artifacts')
    .map((id) => store.get('artifacts', id))
    .filter((a) => a && a.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((rec) => withListCapabilityHint(rec));
}

function withListCapabilityHint(rec) {
  if (rec.capability?.proven && rec.contentKind) return rec;
  const hint = persistableCapabilityHint({
    name: rec.name,
    mimeType: rec.mimeType,
    contentKind: rec.contentKind,
    capability: rec.capability
  });
  return {
    ...rec,
    contentKind: rec.contentKind || hint.contentKind,
    capability: rec.capability || hint
  };
}

/**
 * Compact index for model context — counts only by default.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 * @param {{ includeNames?: boolean, limit?: number }} [opts]
 */
export function getArtifactIndexCompact(store, sessionId, opts = {}) {
  const all = listArtifacts(store, sessionId);
  const limit = opts.limit ?? 20;
  return {
    artifactCount: all.length,
    samples: opts.includeNames
      ? all.slice(0, limit).map((a) => ({ id: a.artifactId, name: a.name, path: a.primaryPath }))
      : undefined
  };
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 */
export function reindexArtifacts(store, sessionId) {
  const list = listArtifacts(store, sessionId);
  store.put('meta', `artifactIndex:${sessionId}`, {
    sessionId,
    count: list.length,
    ids: list.map((a) => a.artifactId),
    updatedAt: Date.now()
  });
}

/**
 * Delete artifact record + entire package directory tree under /artifacts/{packageDir}/.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} fs
 * @param {string} sessionId
 * @param {string} artifactId
 */
function isWorkspaceContractRecord(rec) {
  const path = String(rec?.primaryPath || '');
  const name = String(rec?.name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return path === '/artifacts/AGENTS.md' || path === '/artifacts/Memory.md' || path === '/artifacts/STATUS.md'
    || name === 'agents.md' || name === 'memory.md' || name === 'status.md';
}

export function deleteArtifact(store, fs, sessionId, artifactId) {
  const gate = assertArtifactOwned(store, sessionId, artifactId);
  if (!gate.ok) {
    return { deleted: false, error: gate.error, code: gate.code };
  }
  const rec = gate.record;
  if (isWorkspaceContractRecord(rec)) {
    return {
      deleted: false,
      code: 'WORKSPACE_FILE',
      error: 'AGENTS.md, Memory.md, and STATUS.md can be edited and cannot be deleted'
    };
  }
  const packagePrefix = `/artifacts/${rec.packageDir}`;
  // Remove all package files (primary + siblings)
  for (const guest of [...fs.list(packagePrefix)]) {
    try {
      const hp = fs._hostPath(guest);
      store.delete('fsNodes', hp);
      store.deleteBlob(fs._nodeKey(hp));
    } catch {
      /* ignore */
    }
  }
  // Also remove package dir node if present
  try {
    const hp = fs._hostPath(packagePrefix);
    store.delete('fsNodes', hp);
    store.deleteBlob(fs._nodeKey(hp));
  } catch {
    /* ignore */
  }
  // Primary path fallback
  try {
    const hp = fs._hostPath(rec.primaryPath);
    store.delete('fsNodes', hp);
    store.deleteBlob(fs._nodeKey(hp));
  } catch {
    /* ignore */
  }
  store.delete('artifacts', artifactId);
  reindexArtifacts(store, rec.sessionId);
  return { deleted: true, artifactId, packageDir: rec.packageDir };
}

/**
 * After code run: register new /artifacts files as durable artifact records.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {ReturnType<import('./fs.js').createSessionGuestFs>} fs
 * @param {string} sessionId
 * @param {string[]} writtenGuestPaths
 */
export function registerWrittenArtifacts(store, fs, sessionId, writtenGuestPaths = []) {
  /** @type {object[]} */
  const created = [];
  /** @type {Array<{ path: string, error: string }>} */
  const rejected = [];
  const paths = [...new Set(writtenGuestPaths.map(normalizeArtPath).filter(Boolean))];
  for (const guestPath of paths) {
    if (!guestPath.startsWith('/artifacts/')) continue;
    const existing = listArtifacts(store, sessionId).find((a) => a.primaryPath === guestPath);
    if (existing) continue;
    let bytes;
    try {
      bytes = fs.readFileBytes(guestPath);
    } catch (e) {
      rejected.push({
        path: guestPath,
        error: e instanceof Error ? e.message : String(e)
      });
      continue;
    }
    const name = guestPath.split('/').pop() || 'artifact.bin';
    const parts = guestPath.split('/').filter(Boolean);
    const packageDir = parts[1] || name;
    try {
      let text = '';
      try {
        text = new TextDecoder().decode(bytes);
      } catch {
        text = '';
      }
      const policy = htmlWritePolicy(text, name);
      if (policy.allow === false) {
        rejected.push({ path: guestPath, error: policy.error || policy.code || 'NEED_HTML_KIND' });
        continue;
      }
      const rec = createArtifact(store, fs, {
        sessionId,
        name,
        path: guestPath,
        content: bytes,
        packageDir,
        mimeType: guessMimeFromName(name.toLowerCase())
      });
      created.push(rec);
    } catch (e) {
      rejected.push({
        path: guestPath,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }
  return { created, rejected };
}

function normalizeArtPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.startsWith('/output/')) s = '/artifacts/' + s.slice('/output/'.length);
  if (s.startsWith('output/')) s = '/artifacts/' + s.slice('output/'.length);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

/**
 * If bytes are an HTML document but the name/path says .md (or has no extension),
 * keep the real format. Models often write report.html content via write_artifact
 * with the default name result.md.
 */
export function looksLikeHtmlBytes(bytes, mimeType) {
  if (mimeType && /html/i.test(String(mimeType))) return true;
  const head = new TextDecoder().decode((bytes || new Uint8Array()).slice(0, 800)).trim();
  if (!head) return false;
  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head)) return true;
  return /^<[a-z][\s\S]{20,}$/i.test(head) && /<\/(html|body|div|section|article)>/i.test(head);
}

export function applyHtmlExtensionIfNeeded(name, bytes, mimeType) {
  const raw = String(name || 'result');
  if (!looksLikeHtmlBytes(bytes, mimeType)) {
    return raw.includes('.') ? raw : `${raw}.md`;
  }
  if (!/\.[a-z0-9]+$/i.test(raw)) return `${raw}.html`;
  if (/\.md$/i.test(raw)) return raw.replace(/\.md$/i, '.html');
  return raw;
}

export function bytesFromBase64(b64) {
  const s = String(b64 || '').replace(/\s+/g, '');
  if (!s) return new Uint8Array();
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function capabilityFields(name, mimeType, bytes) {
  const hint = persistableCapabilityHint({ name, mimeType, bytes });
  return { contentKind: hint.contentKind, capability: hint };
}

export function bytesFromRpcContent({ content, base64 } = {}) {
  if (base64 != null && String(base64).trim()) return bytesFromBase64(base64);
  return coerceBytes(content);
}

function coerceBytes(content) {
  if (content == null) return new Uint8Array();
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  if (Array.isArray(content)) return new Uint8Array(content);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return new TextEncoder().encode(String(content));
}
