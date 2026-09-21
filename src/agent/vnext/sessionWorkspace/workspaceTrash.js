/**
 * Session trash. The agent may only move files in. The host empties it
 * when an execution settles. Workspace contract files cannot be trashed.
 */

import { deleteArtifact, listArtifacts } from './artifacts.js';
import { isProtectedWorkspaceName, isProtectedWorkspacePath } from './sessionAgentsMd.js';

export const TRASH_GUEST_PREFIX = '/artifacts/.trash/';

export function isTrashPath(guestPath) {
  return String(guestPath || '').replace(/\\/g, '/').startsWith(TRASH_GUEST_PREFIX);
}

export function isTrashArtifact(rec) {
  if (!rec) return false;
  return rec.folder === 'trash' || isTrashPath(rec.primaryPath);
}

export function trashMoveDenied(rec) {
  if (!rec) return { ok: false, code: 'AUTH_DENIED', error: 'artifact not found' };
  if (isProtectedWorkspacePath(rec.primaryPath) || isProtectedWorkspaceName(rec.name)) {
    return {
      ok: false,
      code: 'WORKSPACE_FILE',
      error: 'AGENTS.md, Memory.md, and STATUS.md cannot go in the trash'
    };
  }
  return null;
}

/**
 * Move an owned artifact under /artifacts/.trash/. Does not delete bytes.
 */
export function moveArtifactToTrash(store, fs, sessionId, artifactId) {
  const rec = store.get('artifacts', artifactId);
  if (!rec || rec.sessionId !== sessionId) {
    return { ok: false, code: 'AUTH_DENIED', error: 'artifact not owned by session' };
  }
  const denied = trashMoveDenied(rec);
  if (denied) return denied;
  if (isTrashArtifact(rec)) return { ok: true, artifact: rec, already: true };
  let bytes;
  try {
    bytes = fs.readFileBytes(rec.primaryPath);
  } catch (e) {
    return { ok: false, code: 'ENOENT', error: e instanceof Error ? e.message : String(e) };
  }
  const base = String(rec.name || artifactId).replace(/[^\w.\u4e00-\u9fff-]+/g, '_') || artifactId;
  const dest = `${TRASH_GUEST_PREFIX}${artifactId}/${base}`;
  fs.mkdirp(`${TRASH_GUEST_PREFIX}${artifactId}`);
  fs.writeFile(dest, bytes, { mimeType: rec.mimeType || 'application/octet-stream' });
  const old = rec.primaryPath;
  const next = {
    ...rec,
    primaryPath: dest,
    folder: 'trash',
    updatedAt: Date.now()
  };
  store.put('artifacts', artifactId, next);
  if (old && old !== dest) {
    try {
      const hp = fs._hostPath(old);
      store.delete('fsNodes', hp);
      store.deleteBlob(fs._nodeKey(hp));
    } catch {
      /* leftover bytes are unreferenced; settle still drops the record */
    }
  }
  return { ok: true, artifact: next };
}

export function emptyWorkspaceTrash(store, fs, sessionId) {
  const sid = String(sessionId || '');
  if (!store || !sid || !fs) return { deleted: 0 };
  const arts = listArtifacts(store, sid) || [];
  let deleted = 0;
  for (const rec of arts) {
    if (!isTrashArtifact(rec)) continue;
    const out = deleteArtifact(store, fs, sid, rec.artifactId);
    if (out.deleted) deleted += 1;
  }
  return { deleted };
}
