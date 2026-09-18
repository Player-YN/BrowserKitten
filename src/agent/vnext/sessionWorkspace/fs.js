/**
 * Guest FS for Session Workspace.
 * Visible roots: /context, /artifacts, /scratch
 * Host maps to session-owned paths; cross-session denied.
 */

const GUEST_ROOTS = new Set(['/context', '/artifacts', '/scratch']);

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {{ sessionId: string, executionId?: string|null }} opts
 */
export function createSessionGuestFs(store, opts) {
  const sessionId = String(opts.sessionId || '');
  if (!sessionId) throw new Error('createSessionGuestFs: sessionId required');
  const executionId = opts.executionId ? String(opts.executionId) : null;

  function hostPath(guestPath) {
    const norm = normalizeGuest(guestPath);
    if (norm.startsWith('/sessions/') || norm.includes('..')) {
      throw deny(norm);
    }
    if (norm === '/context' || norm.startsWith('/context/')) {
      return `/session/${sessionId}/context${norm.slice('/context'.length)}`;
    }
    if (norm === '/artifacts' || norm.startsWith('/artifacts/')) {
      return `/session/${sessionId}/artifacts${norm.slice('/artifacts'.length)}`;
    }
    if (norm === '/scratch' || norm.startsWith('/scratch/')) {
      if (!executionId) throw new Error('scratch requires active execution');
      return `/tmp/${sessionId}/${executionId}${norm.slice('/scratch'.length) || ''}`;
    }
    // Absolute escape attempts
    if (norm.startsWith('/tmp/') && !norm.startsWith(`/tmp/${sessionId}/`)) {
      throw deny(norm);
    }
    if (norm.startsWith('/session/') && !norm.startsWith(`/session/${sessionId}/`)) {
      throw deny(norm);
    }
    throw deny(norm);
  }

  function deny(p) {
    return new Error(`FS_DENIED: path not allowed for guest session: ${p}`);
  }

  function nodeKey(hp) {
    return `fs:${hp}`;
  }

  return {
    sessionId,
    executionId,

    /**
     * @param {string} guestPath
     * @param {string|Uint8Array|ArrayBuffer|number[]|object} data
     * @param {{ mimeType?: string }} [meta]
     */
    writeFile(guestPath, data, meta = {}) {
      const hp = hostPath(guestPath);
      if (hp.includes('/context/') || hp.endsWith('/context')) {
        throw new Error('FS_DENIED: /context is read-only');
      }
      // Accept string, Uint8Array, ArrayBuffer, number[], and QuickJS dump shapes
      // (plain objects with numeric keys) — never silently write empty bytes.
      const bytes = coerceToUint8Array(data);
      store.putBlob(nodeKey(hp), bytes, { mimeType: meta.mimeType || 'text/plain' });
      store.put('fsNodes', hp, {
        path: hp,
        guestPath: normalizeGuest(guestPath),
        kind: 'file',
        sessionId,
        executionId: hp.startsWith('/tmp/') ? executionId : null,
        durable: hp.startsWith(`/session/${sessionId}/artifacts`),
        updatedAt: Date.now(),
        size: bytes.byteLength
      });
      // Raw guest writes must also invalidate a preview's editing baseline.
      const normalized = normalizeGuest(guestPath);
      for (const id of store.keys('artifacts')) {
        const rec = store.get('artifacts', id);
        if (rec.sessionId !== sessionId || rec.primaryPath !== normalized) continue;
        store.put('artifacts', id, { ...rec, revision: (Number(rec.revision) || 0) + 1,
          updatedAt: Date.now(), size: bytes.byteLength });
      }
      return { ok: true, path: normalizeGuest(guestPath), bytes: bytes.byteLength };
    },

    /**
     * @param {string} guestPath
     * @returns {string}
     */
    readFile(guestPath) {
      const hp = hostPath(guestPath);
      const blob = store.getBlob(nodeKey(hp));
      if (!blob) throw new Error(`ENOENT: ${normalizeGuest(guestPath)}`);
      return new TextDecoder().decode(blob.bytes);
    },

    /**
     * @param {string} guestPath
     * @returns {Uint8Array}
     */
    readFileBytes(guestPath) {
      const hp = hostPath(guestPath);
      const blob = store.getBlob(nodeKey(hp));
      if (!blob) throw new Error(`ENOENT: ${normalizeGuest(guestPath)}`);
      return blob.bytes;
    },

    readFileMimeType(guestPath) {
      return store.getBlob(nodeKey(hostPath(guestPath)))?.mimeType || '';
    },

    exists(guestPath) {
      try {
        const hp = hostPath(guestPath);
        return store.has('fsNodes', hp) || !!store.getBlob(nodeKey(hp));
      } catch {
        return false;
      }
    },

    /**
     * @param {string} [prefix]
     * @returns {string[]}
     */
    list(prefix = '/artifacts') {
      const g = normalizeGuest(prefix);
      // Validate access
      hostPath(g === '/' ? '/artifacts' : g);
      const out = [];
      for (const hp of store.keys('fsNodes')) {
        const node = store.get('fsNodes', hp);
        if (!node || node.sessionId !== sessionId) continue;
        const guest = node.guestPath;
        if (!guest) continue;
        if (guest === g || guest.startsWith(g.endsWith('/') ? g : g + '/')) {
          out.push(guest);
        }
      }
      return out.sort();
    },

    mkdirp(guestPath) {
      const hp = hostPath(guestPath);
      if (hp.includes('/context')) throw new Error('FS_DENIED: /context is read-only');
      store.put('fsNodes', hp, {
        path: hp,
        guestPath: normalizeGuest(guestPath),
        kind: 'dir',
        sessionId,
        durable: hp.startsWith(`/session/${sessionId}/artifacts`),
        updatedAt: Date.now()
      });
      return { ok: true };
    },

    /** Host-only path resolution (for GC). */
    _hostPath: hostPath,
    _nodeKey: nodeKey
  };
}

/**
 * @param {string} p
 */
export function normalizeGuest(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

/**
 * Coerce guest/host write payloads to Uint8Array.
 * QuickJS `vm.dump(Uint8Array)` often yields a plain object with numeric keys
 * (and optional `.length`), not a real host Uint8Array — must rehydrate.
 *
 * @param {unknown} data
 * @returns {Uint8Array}
 */
export function coerceToUint8Array(data) {
  if (data == null) return new Uint8Array();
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data.map((n) => Number(n) & 0xff));
  }
  if (typeof data === 'object') {
    const o = /** @type {Record<string, unknown>} */ (data);
    // Node Buffer JSON: { type: 'Buffer', data: number[] }
    if (o.type === 'Buffer' && Array.isArray(o.data)) {
      return new Uint8Array(o.data.map((n) => Number(n) & 0xff));
    }
    // Nested { bytes: ... }
    if (o.bytes != null && o.bytes !== data) {
      return coerceToUint8Array(o.bytes);
    }
    // Typed-array dump: { 0: n, 1: n, ..., length: N } or only numeric keys
    if (typeof o.length === 'number' && o.length >= 0 && Number.isFinite(o.length)) {
      const len = Math.min(Math.floor(o.length), 64 * 1024 * 1024);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = Number(o[i] ?? 0) & 0xff;
      }
      return out;
    }
    const keys = Object.keys(o).filter((k) => /^\d+$/.test(k));
    if (keys.length > 0) {
      let max = -1;
      for (const k of keys) {
        const i = Number(k);
        if (i > max) max = i;
      }
      if (max >= 0 && max < 64 * 1024 * 1024) {
        const out = new Uint8Array(max + 1);
        for (const k of keys) {
          out[Number(k)] = Number(o[k]) & 0xff;
        }
        return out;
      }
    }
  }
  // Last resort: string form (avoid empty silent corruption of non-empty input)
  if (typeof data === 'number' || typeof data === 'boolean') {
    return new TextEncoder().encode(String(data));
  }
  throw new Error(
    `writeFile: cannot coerce payload to bytes (got ${Object.prototype.toString.call(data)})`
  );
}

export { GUEST_ROOTS };
