/**
 * Durable Session Workspace store — IndexedDB metadata (+ OPFS blobs when available).
 *
 * Product path MUST use this (or an equivalent durable backend). Pure in-memory
 * SessionWorkspaceStore is for unit tests only.
 *
 * Node / environments without IndexedDB use a process-wide memory backend keyed
 * by dbName so a NEW store instance still recovers prior flushes (restart sim).
 */

import { WORKSPACE_DB_NAME } from '../../../brand.js';
import { SessionWorkspaceStore } from './store.js';
import { sweepOrphanScratch } from './gc.js';

const DEFAULT_DB_NAME = WORKSPACE_DB_NAME;
const IDB_STORE = 'state';
const STATE_KEY = 'session-workspace';
const META_KEY = 'workspace-meta';
const BLOBS_KEY = 'workspace-inline-blobs';
const COLLECTION_NAMES = [
  'sessions',
  'groups',
  'groupMembers',
  'items',
  'sessionBindings',
  'artifacts',
  'fsNodes',
  'meta'
];

function collectionKey(name) {
  return `col:${name}`;
}

/** @type {Map<string, object>} */
const memoryBackends = new Map();

export class DurableSessionWorkspaceStore extends SessionWorkspaceStore {
  /**
   * @param {{ dbName?: string }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.kind = 'durable';
    this.dbName = opts.dbName || DEFAULT_DB_NAME;
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._opfs = null;
    this._opened = false;
    this._flushTimer = null;
    this._flushPromise = Promise.resolve();
    this._suspendPersist = 0;
    this._dirty = false;
    /** @type {Set<string>} */
    this._dirtyCollections = new Set();
    /** @type {Record<string, { path: string, mimeType?: string, size?: number }>} */
    this._blobManifest = {};
    this._dirtyBlobs = new Set();
    this._deletedBlobs = new Set();
  }

  async open() {
    if (this._opened) return this;

    if (typeof indexedDB !== 'undefined') {
      this._db = await openIdb(this.dbName);
      this._opfs = await openOpfs().catch(() => null);
      const loaded = await loadIdbWorkspace(this._db);
      if (loaded?.snapshot) {
        this.importSnapshot(loaded.snapshot);
        this._blobManifest = loaded.blobManifest || {};
        if (loaded.legacy) for (const name of COLLECTION_NAMES) this._dirtyCollections.add(name);
      }
    } else {
      const snap = memoryBackends.get(this.dbName);
      if (snap) {
        this.importSnapshot(structuredCloneSafe(snap));
      }
    }

    this._opened = true;
    // Crash recovery: executions are ephemeral; any /tmp scratch left behind is orphan.
    const swept = sweepOrphanScratch(this);
    if (swept.removedPaths.length || swept.removedBlobs) {
      this._dirty = true;
      this._scheduleFlush();
    }
    return this;
  }

  /**
   * Lazy OPFS hydrate for a single blob key.
   * @param {string} key
   */
  /**
   * Sync getBlob: memory only. OPFS-backed blobs require getBlobAsync (audit H-11 lazy).
   * Callers that need durable bytes on cold open should use getBlobAsync.
   */
  getBlob(key) {
    return super.getBlob(key);
  }

  async getBlobAsync(key) {
    const id = String(key);
    const loaded = super.getBlob(id);
    if (loaded) return loaded;
    const meta = this._blobManifest[id];
    if (!meta || !this._opfs) return null;
    try {
      const bytes = await readOpfsFile(this._opfs, meta.path);
      // Cache in memory after lazy load (not whole-manifest hydrate)
      super.putBlob(id, bytes, { mimeType: meta.mimeType });
      return super.getBlob(id);
    } catch {
      return null;
    }
  }

  async _hydrateAllBlobsFromOpfs() {
    for (const key of Object.keys(this._blobManifest)) {
      await this.getBlobAsync(key);
    }
  }

  /**
   * Ensure artifact/session blobs needed for a session are hydrated (lazy batch).
   * @param {string} sessionId
   */
  async hydrateSessionBlobs(sessionId) {
    const sid = String(sessionId || '');
    if (!sid || !this._opfs) return { hydrated: 0 };
    let n = 0;
    for (const key of Object.keys(this._blobManifest)) {
      const k = String(key);
      const sessionFs = k.includes(`/${sid}/`);
      let sessionItemBlob = false;
      if (k.startsWith('blob:')) {
        const itemId = k.slice('blob:'.length);
        sessionItemBlob = this.has('items', itemId);
      }
      if (!sessionFs && !sessionItemBlob) continue;
      const got = await this.getBlobAsync(key);
      if (got) n += 1;
    }
    return { hydrated: n };
  }

  put(collection, key, value) {
    super.put(collection, key, value);
    this._dirtyCollections.add(String(collection));
    this._scheduleFlush();
    return value;
  }

  delete(collection, key) {
    const ok = super.delete(collection, key);
    this._dirtyCollections.add(String(collection));
    this._scheduleFlush();
    return ok;
  }

  putBlob(key, bytes, meta = {}) {
    const id = String(key);
    super.putBlob(id, bytes, meta);
    this._deletedBlobs.delete(id);
    this._dirtyBlobs.add(id);
    this._scheduleFlush();
  }

  deleteBlob(key) {
    const id = String(key);
    const ok = super.deleteBlob(id);
    this._dirtyBlobs.delete(id);
    this._deletedBlobs.add(id);
    this._scheduleFlush();
    return ok;
  }

  importSnapshot(snap) {
    super.importSnapshot(snap);
    // import is restore, not a user mutation — do not flush unless opened dirty later
  }

  _scheduleFlush() {
    if (!this._opened || this._suspendPersist > 0) return;
    this._dirty = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush().catch((error) => {
        // Keep pending mutations for an explicit retry or the next edit.
        console.error('[workspace] background persistence failed', error);
      });
    }, 40);
  }

  /**
   * Persist durable state. Safe to call after agent turns / deletes.
   */
  async flush() {
    if (!this._opened) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushPromise = this._flushPromise.catch(() => {}).then(async () => {
      const snapshot = this.exportSnapshot();
      for (const name of COLLECTION_NAMES) snapshot[name] = structuredCloneSafe(snapshot[name]);
      const snapshotBlobs = new Map(snapshot.blobs);
      const dirtyCols = takeSet(this._dirtyCollections);
      const dirty = takeSet(this._dirtyBlobs);
      const deleted = takeSet(this._deletedBlobs);
      const createdPaths = [];
      const retiredPaths = [];
      try {
        if (this._db) {
          /** @type {Record<string, any>} */
          let blobManifest = { ...this._blobManifest };
          if (this._opfs) {
            // Migrate inline/legacy bytes too; never discard them when OPFS returns.
            for (const [key] of snapshot.blobs) {
              if (!blobManifest[key] && !dirty.includes(key)) dirty.push(key);
            }
            for (const key of dirty) {
              const saved = snapshotBlobs.get(key);
              const rec = saved && { ...saved, bytes: new Uint8Array(saved.bytes) };
              if (!rec) {
                delete blobManifest[key];
                continue;
              }
              const previous = blobManifest[key]?.path;
              const path = `session-blobs/${encodeKey(key)}-${crypto.randomUUID()}.bin`;
              createdPaths.push(path);
              await writeOpfsFile(this._opfs, path, rec.bytes);
              if (previous) retiredPaths.push(previous);
              blobManifest[key] = {
                path,
                mimeType: rec.mimeType,
                size: rec.bytes.byteLength
              };
            }
            for (const key of deleted) {
              const old = this._blobManifest[key];
              if (old?.path) retiredPaths.push(old.path);
              delete blobManifest[key];
            }
            snapshot.blobs = [];
          } else {
            // Preserve unavailable OPFS references instead of silently erasing them.
            // New/changed bytes are saved inline until OPFS becomes available again.
            for (const key of [...dirty, ...deleted]) delete blobManifest[key];
          }
          const records = [];
          const names = dirtyCols.length ? dirtyCols : COLLECTION_NAMES;
          for (const name of names) {
            if (!COLLECTION_NAMES.includes(name)) continue;
            records.push([collectionKey(name), snapshot[name] || []]);
          }
          records.push([BLOBS_KEY, snapshot.blobs]);
          records.push([META_KEY, {
            format: 2,
            version: 2,
            savedAt: Date.now(),
            blobManifest
          }]);
          await idbCommit(this._db, records, [STATE_KEY]);
          this._blobManifest = blobManifest;
        } else {
          // Node / test memory backend — full snapshot including blob bytes
          memoryBackends.set(this.dbName, structuredCloneSafe(snapshot));
        }

        this._dirty = Boolean(this._dirtyCollections.size || this._dirtyBlobs.size || this._deletedBlobs.size);
      } catch (error) {
        for (const name of dirtyCols) this._dirtyCollections.add(name);
        for (const key of dirty) if (!this._deletedBlobs.has(key)) this._dirtyBlobs.add(key);
        for (const key of deleted) if (!this._dirtyBlobs.has(key)) this._deletedBlobs.add(key);
        this._dirty = true;
        if (this._opfs) {
          await Promise.all(createdPaths.map((path) => removeOpfsFile(this._opfs, path).catch(() => {})));
        }
        throw error;
      }
      // Old bytes remain valid until the metadata transaction has committed.
      if (this._opfs) {
        await Promise.all(retiredPaths.map((path) => removeOpfsFile(this._opfs, path).catch(() => {})));
      }
    });
    return this._flushPromise;
  }

  async clearDurable() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    await this._flushPromise.catch(() => {});
    super.importSnapshot({
      sessions: [],
      groups: [],
      groupMembers: [],
      items: [],
      sessionBindings: [],
      artifacts: [],
      blobs: [],
      fsNodes: [],
      meta: []
    });
    this._blobManifest = {};
    this._dirtyBlobs.clear();
    this._deletedBlobs.clear();
    this._dirtyCollections.clear();
    if (this._db) {
      await idbCommit(this._db, [], [STATE_KEY, META_KEY, BLOBS_KEY, ...COLLECTION_NAMES.map(collectionKey)]);
    }
    memoryBackends.delete(this.dbName);
    if (this._opfs) await removeOpfsTree(this._opfs, 'session-blobs').catch(() => {});
  }
}

/**
 * Product factory — always open before use.
 * @param {{ dbName?: string }} [opts]
 */
export async function createDurableSessionWorkspaceStore(opts = {}) {
  const store = new DurableSessionWorkspaceStore(opts);
  await store.open();
  return store;
}

/** Test helper: wipe process memory backends */
export function __resetDurableMemoryBackends() {
  memoryBackends.clear();
}

async function loadIdbWorkspace(db) {
  const meta = await idbGet(db, META_KEY);
  if (meta?.format === 2) {
    const snapshot = {
      sessions: [],
      groups: [],
      groupMembers: [],
      items: [],
      sessionBindings: [],
      artifacts: [],
      blobs: [],
      fsNodes: [],
      meta: []
    };
    for (const name of COLLECTION_NAMES) {
      const rows = await idbGet(db, collectionKey(name));
      if (Array.isArray(rows)) snapshot[name] = rows;
    }
    snapshot.blobs = (await idbGet(db, BLOBS_KEY)) || [];
    return { snapshot, blobManifest: meta.blobManifest || {} };
  }
  const legacy = await idbGet(db, STATE_KEY);
  if (legacy?.snapshot) {
    return { snapshot: legacy.snapshot, blobManifest: legacy.blobManifest || {}, legacy: true };
  }
  return null;
}

function takeSet(set) {
  const v = [...set];
  set.clear();
  return v;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function openIdb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
  });
}

function idbCommit(db, records, deletedKeys = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB put aborted'));
    try {
      const target = tx.objectStore(IDB_STORE);
      for (const [key, value] of records) target.put(value, key);
      for (const key of deletedKeys) target.delete(key);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

async function openOpfs() {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  return navigator.storage.getDirectory();
}

async function getDir(root, path, create = true) {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function writeOpfsFile(root, path, bytes) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await getDir(root, parts.join('/'), true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readOpfsFile(root, path) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await getDir(root, parts.join('/'), false);
  const handle = await dir.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function removeOpfsFile(root, path) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await getDir(root, parts.join('/'), false);
  await dir.removeEntry(name);
}

async function removeOpfsTree(root, name) {
  await root.removeEntry(name, { recursive: true });
}

function encodeKey(key) {
  const bytes = new TextEncoder().encode(String(key));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
