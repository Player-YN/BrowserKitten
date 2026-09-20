/**
 * Artifact / scratch / context → live-page upload.
 * Default channel: MAIN-world File + DataTransfer + input.files setter +
 * dispatched input/change. Bytes travel via chrome.scripting.executeScript
 * args (chunked). auto never attaches CDP.
 */

import { normalizeGuest } from '../sessionWorkspace/fs.js';
import { sha256Bytes } from './payloadHash.js';

export const UPLOAD_BYTES_MAX = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE = 512 * 1024;
export const UPLOAD_METHODS = Object.freeze(['auto', 'input', 'drop', 'cdp']);

const GUEST_FILE_PREFIXES = ['/artifacts/', '/scratch/', '/context/'];

export function sanitizeUploadFilename(name) {
  const base = String(name || 'upload.bin').replace(/[/\\?%*:|"<>]/g, '_').replace(/^\.+/, '');
  const trimmed = base.slice(0, 180) || 'upload.bin';
  return trimmed;
}

export function guessUploadMime(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

export function assertUploadGuestPath(path) {
  const raw = String(path || '');
  if (!raw.trim()) return { ok: false, code: 'BAD_INPUT', error: 'upload path is required' };
  if (
    raw.includes('\\') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.startsWith('file:') ||
    raw.startsWith('blob:') ||
    raw.startsWith('chrome-extension:') ||
    raw.startsWith('chrome:')
  ) {
    return { ok: false, code: 'BAD_INPUT', error: 'upload path must be a guest /artifacts, /scratch, or /context file' };
  }
  const norm = normalizeGuest(raw);
  if (norm.includes('..')) {
    return { ok: false, code: 'FS_DENIED', error: `FS_DENIED: path not allowed for guest session: ${norm}` };
  }
  if (norm === '/artifacts' || norm === '/scratch' || norm === '/context') {
    return { ok: false, code: 'BAD_INPUT', error: 'upload path must be a file inside a guest mount' };
  }
  const allowed = GUEST_FILE_PREFIXES.some((prefix) => norm.startsWith(prefix));
  if (!allowed) {
    return { ok: false, code: 'FS_DENIED', error: `FS_DENIED: path not allowed for guest session: ${norm}` };
  }
  return { ok: true, path: norm };
}

export function mimeMatchesAccept(accept, mimeType, ext) {
  const raw = String(accept || '').trim();
  if (!raw) return true;
  const mime = String(mimeType || '').toLowerCase();
  const suffix = String(ext || '').toLowerCase();
  return raw.split(',').some((part) => {
    const token = part.trim().toLowerCase();
    if (!token) return false;
    if (token === '*/*') return true;
    if (token.endsWith('/*')) return mime.startsWith(token.slice(0, -1));
    if (token.startsWith('.')) return suffix === token;
    return mime === token;
  });
}

/**
 * @param {Array<{ accept?: string, hidden?: boolean }>} inputs
 * @param {{ accept?: string, mimeType?: string, filename?: string }} [spec]
 */
export function selectFileInput(inputs, spec = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) return -1;
  const mime = spec.mimeType || '';
  const name = spec.filename || '';
  const ext = name.includes('.') ? `.${name.split('.').pop().toLowerCase()}` : '';
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < list.length; i += 1) {
    const input = list[i] || {};
    let score = 0;
    const acc = String(input.accept || spec.accept || '');
    if (acc && mimeMatchesAccept(acc, mime, ext)) score += 10;
    if (input.hidden) score += 2;
    else score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Pure apply plan. auto never includes CDP.
 * @param {{ method?: string, hasFileInput?: boolean, inputAccepted?: boolean }} input
 */
export function planUploadApply(input = {}) {
  const method = String(input.method || 'auto').toLowerCase();
  if (method === 'cdp') {
    return { steps: ['cdp-drag', 'cdp-files'], autoCdp: false, explicitCdp: true };
  }
  if (method === 'input') {
    return { steps: ['input'], autoCdp: false, explicitCdp: false };
  }
  if (method === 'drop') {
    return { steps: ['drop'], autoCdp: false, explicitCdp: false, warning: input.hasFileInput ? undefined : 'used drop because no file input' };
  }
  if (method !== 'auto') {
    return { steps: [], autoCdp: false, explicitCdp: false, error: 'BAD_INPUT' };
  }
  if (input.hasFileInput && input.inputAccepted !== false) {
    return { steps: ['input', 'drop'], autoCdp: false, explicitCdp: false };
  }
  return {
    steps: ['drop'],
    autoCdp: false,
    explicitCdp: false,
    warning: 'used drop because no file input'
  };
}

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const s = String(b64 || '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  if (typeof atob !== 'function') return new Uint8Array();
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Chrome runtime messages stay well under the ~64MB IPC cap when file bytes are staged. */
export const UPLOAD_RUNTIME_MESSAGE_CHAR_MAX = 700_000;
const UPLOAD_STAGE_MAX = 8;
const UPLOAD_STAGE_TTL_MS = 120_000;

/** @type {Map<string, { owner: string, chunks: Array<string|undefined>, total: number, bytesHash: string, createdAt: number }>} */
const uploadStages = new Map();

export function createUploadStageId() {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 10);
  return `stg_${Date.now().toString(36)}_${rand}`;
}

function gcUploadStages(now = Date.now()) {
  for (const [id, row] of uploadStages) {
    if (!row || now - Number(row.createdAt || 0) > UPLOAD_STAGE_TTL_MS) uploadStages.delete(id);
  }
  while (uploadStages.size > UPLOAD_STAGE_MAX) {
    const oldest = uploadStages.keys().next().value;
    if (!oldest) break;
    uploadStages.delete(oldest);
  }
}

export function resetUploadStages() {
  uploadStages.clear();
}

export function dropUploadStagesForOwner(owner) {
  const key = String(owner || '');
  if (!key) return 0;
  let n = 0;
  for (const [id, row] of uploadStages) {
    if (row?.owner === key) {
      uploadStages.delete(id);
      n += 1;
    }
  }
  return n;
}

export function putUploadStageChunk(input = {}) {
  gcUploadStages();
  const stageId = String(input.stageId || '');
  const owner = String(input.owner || '');
  const index = Number(input.index);
  const total = Number(input.total);
  const b64 = String(input.b64 || '');
  if (!stageId || !owner) return { ok: false, code: 'BAD_INPUT', error: 'upload stage id and owner required' };
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total || total > 64) {
    return { ok: false, code: 'BAD_INPUT', error: 'invalid upload stage index' };
  }
  if (b64.length > UPLOAD_CHUNK_SIZE) {
    return { ok: false, code: 'TOO_LARGE', error: 'upload stage chunk exceeds transport cap' };
  }
  let row = uploadStages.get(stageId);
  if (!row) {
    if (uploadStages.size >= UPLOAD_STAGE_MAX) gcUploadStages();
    if (uploadStages.size >= UPLOAD_STAGE_MAX) {
      return { ok: false, code: 'SYS_BUSY', error: 'too many upload stages in flight' };
    }
    row = {
      owner,
      chunks: Array(total),
      total,
      bytesHash: String(input.bytesHash || ''),
      createdAt: Date.now()
    };
    uploadStages.set(stageId, row);
  } else if (row.owner !== owner) {
    return { ok: false, code: 'SYS_DENIED', error: 'upload stage owner mismatch' };
  } else if (row.total !== total) {
    return { ok: false, code: 'BAD_INPUT', error: 'upload stage total mismatch' };
  }
  if (input.bytesHash && row.bytesHash && String(input.bytesHash) !== row.bytesHash) {
    return { ok: false, code: 'APPROVAL_MISMATCH', error: 'upload stage hash mismatch' };
  }
  row.chunks[index] = b64;
  const stored = row.chunks.filter((part) => typeof part === 'string').length;
  return { ok: true, stageId, stored, total, injected: false };
}

export function takeUploadStage(stageId, owner) {
  const id = String(stageId || '');
  const key = String(owner || '');
  const row = uploadStages.get(id);
  if (!row) return { ok: false, code: 'BAD_INPUT', error: 'upload stage not found' };
  if (row.owner !== key) return { ok: false, code: 'SYS_DENIED', error: 'upload stage owner mismatch' };
  uploadStages.delete(id);
  if (row.chunks.some((part) => typeof part !== 'string')) {
    return { ok: false, code: 'BAD_INPUT', error: 'upload stage incomplete' };
  }
  const bytes = base64ToBytes(row.chunks.join(''));
  if (bytes.byteLength > UPLOAD_BYTES_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
  }
  if (!bytes.byteLength) return { ok: false, code: 'BAD_INPUT', error: 'upload stage assembled empty bytes' };
  return { ok: true, bytes, bytesHash: row.bytesHash };
}

/**
 * Strip file bytes from any pre-authorize page-action / sys envelope.
 * Intent resolution and snapshots must not carry the payload.
 */
export function omitUploadBytes(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const next = { ...payload };
  delete next.bytes;
  delete next.base64;
  delete next.chunks;
  if (next.params && typeof next.params === 'object' && !Array.isArray(next.params)) {
    next.params = { ...next.params };
    delete next.params.bytes;
    delete next.params.base64;
    delete next.params.chunks;
  }
  return next;
}

export function buildPageActionTransport(payload, patch = {}) {
  return omitUploadBytes({ ...(payload && typeof payload === 'object' ? payload : {}), ...patch });
}

/**
 * Product path: chunk file bytes for offscreen→SW, then apply with stageId only.
 */
export function buildStagedUploadEnvelope(params = {}) {
  const bytes = coerceUploadBytes(params.bytes);
  if (!bytes) return { ok: false, code: 'BAD_INPUT', error: 'upload bytes missing' };
  if (bytes.byteLength > UPLOAD_BYTES_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
  }
  const stageId = String(params.stageId || createUploadStageId());
  const chunks = splitBase64Chunks(bytesToBase64(bytes), UPLOAD_CHUNK_SIZE);
  const stageMessages = chunks.map((b64, index) => ({
    op: 'upload.stage',
    params: {
      stageId,
      index,
      total: chunks.length,
      b64,
      bytesHash: params.bytesHash || ''
    }
  }));
  const applyParams = omitUploadBytes({ ...params, stageId, bytesHash: params.bytesHash || '' });
  return { ok: true, stageId, stageMessages, applyParams };
}

export function uploadOwnerKey(sessionId, executionId) {
  return `${String(sessionId || '')}:${String(executionId || '')}`;
}

/**
 * After journal authorize: stage chunks, then apply without inline bytes.
 */
export async function dispatchStagedUpload(params, { sendStage, sendApply } = {}) {
  const envelope = buildStagedUploadEnvelope(params);
  if (!envelope.ok) return envelope;
  if (typeof sendStage !== 'function' || typeof sendApply !== 'function') {
    return { ok: false, code: 'SYS_DENIED', error: 'upload stage transport is unavailable' };
  }
  for (const msg of envelope.stageMessages) {
    const staged = await sendStage(msg);
    if (staged && staged.ok === false) return staged;
  }
  return sendApply(envelope.applyParams, envelope);
}

export function splitBase64Chunks(b64, size = UPLOAD_CHUNK_SIZE) {
  const s = String(b64 || '');
  const out = [];
  const step = Math.max(1024, Number(size) || UPLOAD_CHUNK_SIZE);
  for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + step));
  return out.length ? out : [''];
}

export function coerceUploadBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value.map((n) => Number(n) & 0xff));
  if (typeof value === 'object' && value.bytes != null && value.bytes !== value) {
    return coerceUploadBytes(value.bytes);
  }
  return null;
}

/**
 * MAIN-world apply. Must stay self-contained for chrome.scripting.executeScript.
 * @param {{
 *   phase?: 'chunk'|'apply',
 *   token?: string,
 *   index?: number,
 *   total?: number,
 *   b64?: string,
 *   filename?: string,
 *   mimeType?: string,
 *   method?: string,
 *   selector?: string,
 *   accept?: string,
 *   name?: string
 * }} args
 */
export function applyUploadInPage(args) {
  const spec = args && typeof args === 'object' ? args : {};
  const token = String(spec.token || 'paw-upload');
  const bag = (globalThis.__browserbotUploadChunks = globalThis.__browserbotUploadChunks || {});
  if (spec.phase === 'chunk') {
    if (!bag[token]) bag[token] = [];
    bag[token][Number(spec.index) || 0] = String(spec.b64 || '');
    return { ok: true, stored: Number(spec.index) || 0 };
  }

  function decodeB64(s) {
    const raw = String(s || '');
    if (typeof atob !== 'function') return new Uint8Array();
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function assemble() {
    const chunks = bag[token] || [];
    const joined = chunks.join('');
    delete bag[token];
    return decodeB64(joined);
  }

  function matchesAccept(accept, mimeType, filename) {
    const raw = String(accept || '').trim();
    if (!raw) return true;
    const mime = String(mimeType || '').toLowerCase();
    const ext = filename && filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : '';
    return raw.split(',').some((part) => {
      const tokenAcc = part.trim().toLowerCase();
      if (!tokenAcc) return false;
      if (tokenAcc === '*/*') return true;
      if (tokenAcc.endsWith('/*')) return mime.startsWith(tokenAcc.slice(0, -1));
      if (tokenAcc.startsWith('.')) return ext === tokenAcc;
      return mime === tokenAcc;
    });
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const style = globalThis.getComputedStyle ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return r.width > 0 && r.height > 0;
  }

  function findFileInput(selector, accept, mimeType, filename) {
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el && String(el.tagName || '').toLowerCase() === 'input' && String(el.type || '').toLowerCase() === 'file') {
          return el;
        }
      } catch {
        /* invalid selector */
      }
    }
    const all = Array.from(document.querySelectorAll('input[type=file]'));
    if (!all.length) return null;
    let best = all[0];
    let bestScore = -1;
    for (const el of all) {
      let score = 0;
      if (matchesAccept(el.accept || accept, mimeType, filename)) score += 10;
      if (!visible(el)) score += 2;
      else score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function findDropTarget(selector) {
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        /* invalid selector */
      }
    }
    const marked = document.querySelector('[data-paw-upload]');
    if (marked) return marked;
    const zone = document.querySelector('[data-drop], [data-dropzone], .dropzone');
    if (zone) return zone;
    return document.body;
  }

  function assignInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      filesCount: input.files ? input.files.length : 0,
      size: input.files && input.files[0] ? input.files[0].size : 0
    };
  }

  function dispatchDrop(target, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(ev);
    }
    return { filesCount: dt.files ? dt.files.length : 1 };
  }

  const bytes = assemble();
  const filename = String(spec.filename || 'upload.bin');
  const mimeType = String(spec.mimeType || 'application/octet-stream');
  const method = String(spec.method || 'auto').toLowerCase();
  const file = new File([bytes], filename, { type: mimeType });
  const methodTried = [];
  const selector = spec.selector ? String(spec.selector) : '';
  const inputEl = findFileInput(selector, spec.accept, mimeType, filename);
  let methodUsed = '';
  let filesCount = 0;
  let changeDispatched = false;
  let warning = '';
  let target = { selector: selector || undefined };

  if (method === 'input' || (method === 'auto' && inputEl)) {
    methodTried.push('input');
    if (!inputEl) {
      return { ok: false, code: 'NO_TARGET', error: 'no file input in this document', methodTried };
    }
    const assigned = assignInput(inputEl, file);
    filesCount = assigned.filesCount;
    changeDispatched = true;
    methodUsed = 'input';
    target = {
      selector: selector || 'input[type=file]',
      tag: 'input',
      hidden: !visible(inputEl)
    };
    if (filesCount > 0) {
      return {
        ok: true,
        methodUsed,
        filesCount,
        changeDispatched,
        trusted: false,
        siteAccepted: 'unknown',
        target,
        methodTried
      };
    }
    if (method === 'input') {
      return { ok: false, code: 'UPLOAD_REJECTED', error: 'file input rejected the assignment', methodTried, methodUsed, filesCount: 0, trusted: false, siteAccepted: 'unknown', target };
    }
  }

  if (method === 'drop' || method === 'auto') {
    methodTried.push('drop');
    const dropTarget = inputEl && method === 'auto' && filesCount === 0
      ? (inputEl.closest('[data-drop], [data-dropzone], .dropzone') || inputEl.parentElement || findDropTarget(selector))
      : findDropTarget(selector);
    if (!dropTarget) {
      return { ok: false, code: 'NO_TARGET', error: 'no drop target in this document', methodTried };
    }
    dispatchDrop(dropTarget, file);
    methodUsed = 'drop';
    warning = inputEl ? undefined : 'used drop because no file input';
    target = {
      selector: selector || undefined,
      tag: String(dropTarget.tagName || '').toLowerCase(),
      hidden: !visible(dropTarget)
    };
    return {
      ok: true,
      methodUsed,
      filesCount: filesCount || 1,
      changeDispatched: false,
      trusted: false,
      siteAccepted: 'unknown',
      target,
      warning,
      methodTried
    };
  }

  return { ok: false, code: 'NO_TARGET', error: 'no upload target', methodTried };
}

async function executeInDocument(chromeRef, spec, func, args) {
  const target = spec.documentId
    ? { tabId: spec.tabId, documentIds: [spec.documentId] }
    : { tabId: spec.tabId, frameIds: [spec.frameId ?? 0] };
  const injected = await chromeRef.scripting.executeScript({
    target,
    world: 'MAIN',
    func,
    args: [args]
  });
  const first = Array.isArray(injected) ? injected[0] : null;
  return first && typeof first === 'object' && 'result' in first ? first.result : first;
}

/**
 * Chunk bytes into the page, then apply File / DataTransfer.
 * @param {typeof chrome} chromeRef
 * @param {{
 *   tabId: number,
 *   documentId?: string,
 *   frameId?: number,
 *   bytes: Uint8Array,
 *   filename: string,
 *   mimeType: string,
 *   method?: string,
 *   selector?: string,
 *   accept?: string,
 *   name?: string
 * }} spec
 */
export async function applyUploadViaScripting(chromeRef, spec) {
  if (!chromeRef?.scripting?.executeScript) {
    return { ok: false, code: 'SYS_DENIED', error: 'chrome.scripting.executeScript is unavailable' };
  }
  const bytes = coerceUploadBytes(spec.bytes);
  if (!bytes) return { ok: false, code: 'BAD_INPUT', error: 'upload bytes missing' };
  if (bytes.byteLength > UPLOAD_BYTES_MAX) {
    return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
  }
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const chunks = splitBase64Chunks(bytesToBase64(bytes), UPLOAD_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i += 1) {
    const stored = await executeInDocument(chromeRef, spec, applyUploadInPage, {
      phase: 'chunk',
      token,
      index: i,
      total: chunks.length,
      b64: chunks[i]
    });
    if (stored && stored.ok === false) return stored;
  }
  const applied = await executeInDocument(chromeRef, spec, applyUploadInPage, {
    phase: 'apply',
    token,
    filename: spec.filename,
    mimeType: spec.mimeType,
    method: spec.method || 'auto',
    selector: spec.selector,
    accept: spec.accept,
    name: spec.name
  });
  if (!applied || typeof applied !== 'object') {
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', outcome: 'unknown', error: 'Missing upload receipt. Inspect before retrying.' };
  }
  return applied;
}

async function waitDownloadComplete(chromeRef, downloadId, timeoutMs = 30000) {
  const started = Date.now();
  const search = async () => {
    const [item] = await chromeRef.downloads.search({ id: downloadId });
    return item || null;
  };
  const immediate = await search();
  if (immediate?.state === 'complete' && !immediate.error) return immediate;
  if (immediate?.state === 'interrupted') {
    throw Object.assign(new Error('upload temp download interrupted'), { code: 'SYS_FAILED' });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('download prompt or timeout while materializing upload path'), { code: 'DOWNLOAD_PROMPT' }));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      if (chromeRef.downloads?.onChanged?.removeListener) {
        chromeRef.downloads.onChanged.removeListener(onChanged);
      }
    }
    function onChanged(delta) {
      if (!delta || delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        search().then((item) => {
          if (item?.error) reject(Object.assign(new Error(String(item.error)), { code: 'SYS_FAILED' }));
          else resolve(item);
        }, reject);
      } else if (delta.state?.current === 'interrupted') {
        cleanup();
        reject(Object.assign(new Error('upload temp download interrupted'), { code: 'SYS_FAILED' }));
      }
    }
    if (chromeRef.downloads?.onChanged?.addListener) {
      chromeRef.downloads.onChanged.addListener(onChanged);
    } else {
      const poll = async () => {
        if (Date.now() - started > timeoutMs) {
          cleanup();
          reject(Object.assign(new Error('download prompt or timeout while materializing upload path'), { code: 'DOWNLOAD_PROMPT' }));
          return;
        }
        try {
          const item = await search();
          if (item?.state === 'complete' && !item.error) {
            cleanup();
            resolve(item);
            return;
          }
          if (item?.state === 'interrupted') {
            cleanup();
            reject(Object.assign(new Error('upload temp download interrupted'), { code: 'SYS_FAILED' }));
            return;
          }
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
    }
  });
}

/**
 * Explicit method:'cdp' only. Never used by auto.
 * @param {typeof chrome} chromeRef
 * @param {object} spec
 * @param {{ ensureAttached: Function, send: Function }} cdp
 */
export async function applyUploadViaCdp(chromeRef, spec, cdp) {
  const bytes = coerceUploadBytes(spec.bytes);
  if (!bytes) return { ok: false, code: 'BAD_INPUT', error: 'upload bytes missing' };
  const mimeType = spec.mimeType || 'application/octet-stream';
  const filename = spec.filename || 'upload.bin';
  const methodTried = [];
  await cdp.ensureAttached(spec.tabId);
  try {
    methodTried.push('cdp-drag');
    const data = bytesToBase64(bytes);
    const point = { x: Number(spec.x) || 400, y: Number(spec.y) || 300 };
    const dragData = {
      items: [{ mimeType, data }],
      dragOperationsMask: 1
    };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, ...point, data: dragData });
    }
    return {
      ok: true,
      methodUsed: 'cdp-drag',
      filesCount: 1,
      changeDispatched: false,
      trusted: true,
      siteAccepted: 'unknown',
      target: spec.selector ? { selector: spec.selector } : {},
      methodTried
    };
  } catch (dragError) {
    methodTried.push('cdp-files');
    if (!chromeRef.downloads?.download) {
      return {
        ok: false,
        code: 'CDP_FAILED',
        error: dragError instanceof Error ? dragError.message : String(dragError),
        methodTried
      };
    }
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
    const downloadId = await chromeRef.downloads.download({
      url: dataUrl,
      filename: `browserbot-upload/${crypto.randomUUID ? crypto.randomUUID() : Date.now()}-${sanitizeUploadFilename(filename)}`,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    let item;
    try {
      item = await waitDownloadComplete(chromeRef, downloadId);
    } catch (error) {
      return { ok: false, code: error?.code || 'DOWNLOAD_PROMPT', error: error?.message || String(error), methodTried };
    }
    const absPath = item?.filename;
    if (!absPath) {
      return { ok: false, code: 'SYS_FAILED', error: 'download completed without an absolute path', methodTried };
    }
    try {
      const doc = await cdp.send('DOM.getDocument', { depth: 0 });
      const nodeId = doc?.root?.nodeId;
      const selector = spec.selector || 'input[type=file]';
      const queried = await cdp.send('DOM.querySelector', { nodeId, selector });
      const targetId = queried?.nodeId;
      if (!targetId) {
        return { ok: false, code: 'NO_TARGET', error: 'CDP found no file input', methodTried };
      }
      await cdp.send('DOM.setFileInputFiles', { files: [absPath], nodeId: targetId });
      return {
        ok: true,
        methodUsed: 'cdp-files',
        filesCount: 1,
        changeDispatched: false,
        trusted: true,
        siteAccepted: 'unknown',
        target: { selector, tag: 'input' },
        methodTried
      };
    } finally {
      try {
        if (chromeRef.downloads.removeFile) await chromeRef.downloads.removeFile(downloadId);
      } catch {
        /* temp file cleanup is best-effort */
      }
    }
  }
}

export async function applyUploadToTab(chromeRef, spec, cdp) {
  const method = String(spec.method || 'auto').toLowerCase();
  if (method === 'cdp') {
    if (!cdp || typeof cdp.ensureAttached !== 'function') {
      return { ok: false, code: 'SYS_DENIED', error: 'CDP upload host is unavailable' };
    }
    return applyUploadViaCdp(chromeRef, spec, cdp);
  }
  return applyUploadViaScripting(chromeRef, spec);
}

export async function hashUploadPayloadBytes(bytes) {
  const raw = coerceUploadBytes(bytes);
  if (!raw) return '';
  return sha256Bytes(raw);
}
