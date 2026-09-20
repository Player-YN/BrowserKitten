/**
 * BrowserBot — run-scoped in-memory artifacts (meta materialize API).
 *
 * Atomic helpers only: text, table (CSV), zip pack.
 * No scenario-named tools (report/taobao/etc). Download wiring is C2.
 */

import { rowsToCsv, csvEscape } from './dataTools/structuredData.js';

/**
 * @typedef {'text'|'table'|'zip'|'binary'} ArtifactKind
 *
 * @typedef {Object} ArtifactRecord
 * @property {string} artifactId
 * @property {ArtifactKind} kind
 * @property {string} name
 * @property {string} mime
 * @property {string|null} content  UTF-8 text when applicable; null for pure binary
 * @property {Uint8Array} bytes
 * @property {number} size
 * @property {number} createdAt
 * @property {object} [meta]
 *
 * @typedef {Object} ArtifactRef
 * @property {string} artifactId
 * @property {string} name
 * @property {string} mime
 * @property {ArtifactKind} kind
 * @property {number} size
 */

/** @type {Map<string, Map<string, ArtifactRecord>>} */
const runStores = new Map();

/**
 * @param {string} [runId]
 * @returns {string}
 */
function resolveRunId(runId) {
  if (runId && typeof runId === 'string') return runId;
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} [name]
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeName(name, fallback) {
  const raw = (name == null || name === '' ? fallback : String(name)).trim() || fallback;
  // Strip path separators / control chars; keep unicode letters & common name chars
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || fallback;
}

/**
 * @param {string} [runId]
 * @returns {string}
 */
function nextArtifactId(runId) {
  const r = (runId || 'local').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'local';
  return `art_${r}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get or create the artifact Map for a run.
 * @param {string} runId
 * @returns {Map<string, ArtifactRecord>}
 */
export function getRunArtifactMap(runId) {
  const id = resolveRunId(runId);
  let map = runStores.get(id);
  if (!map) {
    map = new Map();
    runStores.set(id, map);
  }
  return map;
}

/**
 * Drop all artifacts for a run (or entire registry when runId omitted and wipeAll).
 * @param {string} [runId]
 * @param {{ wipeAll?: boolean }} [opts]
 */
export function clearRunArtifacts(runId, opts = {}) {
  if (opts.wipeAll) {
    runStores.clear();
    return;
  }
  if (runId) runStores.delete(runId);
}

/**
 * @param {ArtifactRecord} rec
 * @returns {ArtifactRef}
 */
function toRef(rec) {
  return {
    artifactId: rec.artifactId,
    name: rec.name,
    mime: rec.mime,
    kind: rec.kind,
    size: rec.size
  };
}

/**
 * Store a record in the run map.
 * @param {string} runId
 * @param {ArtifactRecord} rec
 * @returns {ArtifactRef}
 */
function putArtifact(runId, rec) {
  const map = getRunArtifactMap(runId);
  map.set(rec.artifactId, rec);
  return toRef(rec);
}

/**
 * @param {string} artifactId
 * @param {string} [runId]  When omitted, search all run maps
 * @returns {ArtifactRecord|null}
 */
export function getArtifact(artifactId, runId) {
  if (!artifactId) return null;
  if (runId) {
    const map = runStores.get(runId);
    return map?.get(artifactId) || null;
  }
  for (const map of runStores.values()) {
    if (map.has(artifactId)) return map.get(artifactId) || null;
  }
  return null;
}

/**
 * @param {string} runId
 * @returns {ArtifactRef[]}
 */
export function listArtifacts(runId) {
  const map = runStores.get(runId);
  if (!map) return [];
  return [...map.values()].map(toRef);
}

/**
 * True when a table cell is null/undefined/blank string.
 * @param {any} v
 * @returns {boolean}
 */
function isEmptyCell(v) {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

/**
 * Validate table-shaped data (pure; no chrome).
 * @param {{
 *   columns?: string[],
 *   rows?: Array<Record<string, any>|any[]>,
 *   minRows?: number,
 *   requiredColumns?: string[]
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   rowCount: number,
 *   columnCount: number,
 *   emptyRequired: string[],
 *   issues: string[],
 *   nonEmptyRate: number
 * }}
 */
export function validateTableArtifact(opts = {}) {
  const { columns, objects } = normalizeTable(opts.columns, opts.rows || []);
  const rowCount = objects.length;
  const columnCount = columns.length;
  /** @type {string[]} */
  const issues = [];
  /** @type {string[]} */
  const emptyRequired = [];

  // Default minRows=1: empty tables cannot pass validation (finish gate false-success fix)
  const minRows =
    opts.minRows != null && Number.isFinite(Number(opts.minRows))
      ? Number(opts.minRows)
      : 1;
  if (rowCount < minRows) {
    issues.push(
      rowCount === 0
        ? 'empty table (0 rows)'
        : `rowCount ${rowCount} < minRows ${minRows}`
    );
  }

  const required = Array.isArray(opts.requiredColumns)
    ? opts.requiredColumns.map((c) => String(c))
    : [];
  for (const col of required) {
    if (!columns.includes(col)) {
      emptyRequired.push(col);
      issues.push(`required column missing: ${col}`);
      continue;
    }
    let hasEmpty = rowCount === 0;
    if (!hasEmpty) {
      for (const row of objects) {
        if (isEmptyCell(row[col])) {
          hasEmpty = true;
          break;
        }
      }
    }
    if (hasEmpty) {
      if (!emptyRequired.includes(col)) emptyRequired.push(col);
      issues.push(`required column has empty values: ${col}`);
    }
  }

  let total = 0;
  let nonEmpty = 0;
  if (columnCount > 0 && rowCount > 0) {
    for (const row of objects) {
      for (let i = 0; i < columns.length; i++) {
        total++;
        if (!isEmptyCell(row[columns[i]])) nonEmpty++;
      }
    }
  }
  const nonEmptyRate = total === 0 ? 0 : nonEmpty / total;

  return {
    ok: issues.length === 0,
    rowCount,
    columnCount,
    emptyRequired,
    issues,
    nonEmptyRate
  };
}

/**
 * Validate text artifact payload (pure; no chrome).
 * @param {{ content?: string, minChars?: number }} opts
 * @returns {{ ok: boolean, charCount: number, issues: string[] }}
 */
export function validateTextArtifact(opts = {}) {
  const content = opts.content == null ? '' : String(opts.content);
  const charCount = content.length;
  /** @type {string[]} */
  const issues = [];
  // Default minChars=1: empty text cannot pass validation (finish gate false-success fix)
  const minChars =
    opts.minChars != null && Number.isFinite(Number(opts.minChars))
      ? Number(opts.minChars)
      : 1;
  if (charCount < minChars) {
    issues.push(
      charCount === 0
        ? 'empty text content'
        : `charCount ${charCount} < minChars ${minChars}`
    );
  }
  return { ok: issues.length === 0, charCount, issues };
}

/**
 * Short human preview of an artifact record. Never dumps multi-MB payloads.
 * @param {ArtifactRecord|null|undefined} rec
 * @param {{ maxChars?: number, maxRows?: number }} [opts]
 * @returns {string}
 */
export function previewArtifactContent(rec, opts = {}) {
  const maxCharsRaw = opts.maxChars != null ? Number(opts.maxChars) : 800;
  const maxRowsRaw = opts.maxRows != null ? Number(opts.maxRows) : 5;
  const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(0, Math.floor(maxCharsRaw)) : 800;
  const maxRows = Number.isFinite(maxRowsRaw) ? Math.max(0, Math.floor(maxRowsRaw)) : 5;

  if (!rec || typeof rec !== 'object') return '';

  /**
   * @param {string} s
   * @returns {string}
   */
  const cap = (s) => {
    const str = s == null ? '' : String(s);
    if (str.length <= maxChars) return str;
    return maxChars === 0 ? '' : str.slice(0, maxChars) + '…';
  };

  if (rec.kind === 'text') {
    return cap(rec.content == null ? '' : String(rec.content));
  }

  if (rec.kind === 'table') {
    const columns = Array.isArray(rec.meta?.columns) ? rec.meta.columns.map(String) : [];
    const header = columns.length ? columns.join('\t') : '(no columns)';
    const content = rec.content == null ? '' : String(rec.content);
    // Scan only a bounded prefix so huge CSVs do not force full-line splits.
    const bomOffset = content.charCodeAt(0) === 0xfeff ? 1 : 0;
    const scanLimit = Math.min(content.length - bomOffset, Math.max(maxChars * 8, 4096));
    const slice = content.slice(bomOffset, bomOffset + Math.max(0, scanLimit));
    const rawLines = slice.split(/\r?\n/).filter((l) => l.length > 0);

    let dataStart = 0;
    if (columns.length && rawLines.length) {
      const first = rawLines[0];
      // Header row when first cell matches first column name (CSV-escaped or plain).
      if (first === columns.join(',') || first.startsWith(columns[0] + ',') || first === columns[0]) {
        dataStart = 1;
      }
    }
    const picked = rawLines.slice(dataStart, dataStart + maxRows);
    let out = header;
    for (const line of picked) {
      out += '\n' + line;
      if (out.length >= maxChars) break;
    }
    const totalRows = typeof rec.meta?.rowCount === 'number' ? rec.meta.rowCount : null;
    if (totalRows != null && totalRows > maxRows && out.length < maxChars) {
      const more = `\n… +${totalRows - maxRows} more rows`;
      if (out.length + more.length <= maxChars) out += more;
      else out = cap(out + more);
    }
    return cap(out);
  }

  if (rec.kind === 'zip') {
    const n = rec.meta?.fileCount != null ? rec.meta.fileCount : '?';
    const names = Array.isArray(rec.meta?.fileNames)
      ? rec.meta.fileNames.slice(0, maxRows).map(String).join(', ')
      : '';
    const base = `[zip] ${rec.name || 'pack.zip'} (${n} files)`;
    return cap(names ? `${base}: ${names}` : base);
  }

  if (rec.content != null) {
    return cap(String(rec.content));
  }
  return cap(`[${rec.kind || 'artifact'}] ${rec.name || ''} size=${rec.size ?? 0}`);
}

/**
 * Attach a validation result onto rec.meta.validation (mutates rec).
 * @param {ArtifactRecord} rec
 * @param {object} validation
 * @returns {ArtifactRecord}
 */
export function attachValidation(rec, validation) {
  if (!rec || typeof rec !== 'object') return rec;
  if (!rec.meta || typeof rec.meta !== 'object') {
    rec.meta = {};
  }
  rec.meta.validation = validation;
  return rec;
}

/**
 * Create a plain text (or other text/*) artifact.
 * @param {{ name: string, mime?: string, content?: string, runId?: string }} opts
 * @returns {ArtifactRef}
 */
export function createTextArtifact(opts = {}) {
  const runId = resolveRunId(opts.runId);
  const name = sanitizeName(opts.name, 'artifact.txt');
  const mime = (opts.mime && String(opts.mime)) || 'text/plain';
  const content = opts.content == null ? '' : String(opts.content);
  const bytes = new TextEncoder().encode(content);
  const artifactId = nextArtifactId(runId);
  /** @type {ArtifactRecord} */
  const rec = {
    artifactId,
    kind: 'text',
    name,
    mime,
    content,
    bytes,
    size: bytes.length,
    createdAt: Date.now(),
    meta: { runId }
  };
  attachValidation(rec, validateTextArtifact({ content }));
  return putArtifact(runId, rec);
}

/**
 * Store a binary artifact (PDF, etc.).
 * @param {{ runId?: string, name?: string, mime?: string, bytes: Uint8Array }} opts
 * @returns {ArtifactRef}
 */
export function createBinaryArtifact(opts = {}) {
  const runId = resolveRunId(opts.runId);
  const name = sanitizeName(opts.name, 'artifact.bin');
  const mime = (opts.mime && String(opts.mime)) || 'application/octet-stream';
  const bytes =
    opts.bytes instanceof Uint8Array
      ? opts.bytes
      : new Uint8Array(0);
  const artifactId = nextArtifactId(runId);
  /** @type {ArtifactRecord} */
  const rec = {
    artifactId,
    kind: 'binary',
    name,
    mime,
    content: null,
    bytes,
    size: bytes.length,
    createdAt: Date.now(),
    meta: { runId }
  };
  const ok = bytes.length > 0;
  attachValidation(rec, {
    ok,
    issues: ok ? [] : ['empty binary'],
    byteCount: bytes.length
  });
  return putArtifact(runId, rec);
}

/**
 * Normalize table rows to objects keyed by columns.
 * Accepts rows as objects or arrays; columns optional for objects.
 * @param {string[]|undefined} columns
 * @param {Array<Record<string, any>|any[]>} rows
 * @returns {{ columns: string[], objects: Array<Record<string, any>> }}
 */
function normalizeTable(columns, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return { columns: Array.isArray(columns) ? columns.map(String) : [], objects: [] };
  }

  const first = list[0];
  if (Array.isArray(first)) {
    const cols =
      Array.isArray(columns) && columns.length
        ? columns.map(String)
        : first.map((_, i) => `col_${i + 1}`);
    const objects = list.map((row) => {
      const arr = Array.isArray(row) ? row : [];
      /** @type {Record<string, any>} */
      const obj = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = arr[i] ?? '';
      return obj;
    });
    return { columns: cols, objects };
  }

  // Object rows
  const objects = list.map((row) =>
    row && typeof row === 'object' && !Array.isArray(row) ? /** @type {Record<string, any>} */ (row) : {}
  );
  let cols = Array.isArray(columns) && columns.length ? columns.map(String) : null;
  if (!cols) {
    const seen = new Set();
    cols = [];
    for (const row of objects) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
      }
    }
  }
  return { columns: cols, objects };
}

/**
 * Build CSV string (Excel-friendly BOM). Empty table still emits header if columns given.
 * @param {string[]} columns
 * @param {Array<Record<string, any>>} objects
 * @returns {string}
 */
function tableToCsv(columns, objects) {
  if (objects.length === 0) {
    if (!columns.length) return '\uFEFF';
    return `\uFEFF${columns.map(csvEscape).join(',')}`;
  }
  return rowsToCsv(objects, { fieldNames: columns, bom: true });
}

/**
 * Create a table artifact as CSV (xlsx-compatible via Excel open).
 * @param {{ name?: string, columns?: string[], rows?: Array<Record<string, any>|any[]>, runId?: string }} opts
 * @returns {ArtifactRef}
 */
export function createTableArtifact(opts = {}) {
  const runId = resolveRunId(opts.runId);
  let name = sanitizeName(opts.name, 'table.csv');
  if (!/\.csv$/i.test(name)) name = `${name}.csv`;
  const { columns, objects } = normalizeTable(opts.columns, opts.rows || []);
  const content = tableToCsv(columns, objects);
  const bytes = new TextEncoder().encode(content);
  const artifactId = nextArtifactId(runId);
  /** @type {ArtifactRecord} */
  const rec = {
    artifactId,
    kind: 'table',
    name,
    mime: 'text/csv',
    content,
    bytes,
    size: bytes.length,
    createdAt: Date.now(),
    meta: { runId, columns, rowCount: objects.length }
  };
  attachValidation(rec, validateTableArtifact({ columns, rows: objects }));
  return putArtifact(runId, rec);
}

// ── Minimal ZIP (store method, no compression) ─────────────────────────────
// Ported from background.js createZipBlob for pure Uint8Array (Node + browser).

/** @type {Uint32Array|null} */
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  crcTable = table;
  return table;
}

/**
 * @param {Uint8Array} buf
 * @returns {number}
 */
function crc32(buf) {
  const table = getCrcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decode data URL or treat as raw string / bytes.
 * @param {{ name: string, content?: string|Uint8Array, dataUrl?: string }} file
 * @returns {Uint8Array}
 */
function fileToBytes(file) {
  if (file.dataUrl != null && file.dataUrl !== '') {
    return decodeDataUrl(String(file.dataUrl));
  }
  const c = file.content;
  if (c == null) return new Uint8Array(0);
  if (c instanceof Uint8Array) return c;
  if (typeof ArrayBuffer !== 'undefined' && c instanceof ArrayBuffer) {
    return new Uint8Array(c);
  }
  return new TextEncoder().encode(String(c));
}

/**
 * @param {string} dataUrl
 * @returns {Uint8Array}
 */
export function decodeDataUrl(dataUrl) {
  const s = String(dataUrl);
  const comma = s.indexOf(',');
  if (!s.startsWith('data:') || comma < 0) {
    throw new Error('Invalid dataUrl');
  }
  const meta = s.slice(5, comma);
  const data = s.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  if (isBase64) {
    const bin = typeof atob === 'function' ? atob(data) : Buffer.from(data, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(data));
  } catch {
    return new TextEncoder().encode(data);
  }
}

/**
 * Build an uncompressed ZIP archive.
 * @param {Array<{ name: string, data: Uint8Array }>} files
 * @returns {Uint8Array}
 */
export function buildZipBytes(files) {
  const parts = [];
  const centralDirectory = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(0);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 10, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true); // store
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    parts.push(header);
    parts.push(dataBytes);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cdHeader.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 10, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    cdView.setUint32(16, crc, true);
    cdView.setUint32(20, size, true);
    cdView.setUint32(24, size, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint16(32, 0, true);
    cdView.setUint16(34, 0, true);
    cdView.setUint16(36, 0, true);
    cdView.setUint32(38, 0, true);
    cdView.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    centralDirectory.push(cdHeader);
    offset += header.length + dataBytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDirectory) {
    parts.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);
  parts.push(eocd);

  return concatBytes(parts);
}

/**
 * Pack multiple files into a zip artifact.
 * Each file: { name, content } and/or { name, dataUrl }.
 * @param {{ name?: string, files?: Array<{ name: string, content?: string|Uint8Array, dataUrl?: string }>, runId?: string }} opts
 * @returns {ArtifactRef}
 */
export function packZipArtifact(opts = {}) {
  const runId = resolveRunId(opts.runId);
  let name = sanitizeName(opts.name, 'pack.zip');
  if (!/\.zip$/i.test(name)) name = `${name}.zip`;

  const input = Array.isArray(opts.files) ? opts.files : [];
  const zipFiles = input.map((f, i) => {
    const entryName = sanitizeName(f?.name, `file_${i + 1}`);
    return { name: entryName, data: fileToBytes(f || {}) };
  });

  const bytes = buildZipBytes(zipFiles);
  const artifactId = nextArtifactId(runId);
  return putArtifact(runId, {
    artifactId,
    kind: 'zip',
    name,
    mime: 'application/zip',
    content: null,
    bytes,
    size: bytes.length,
    createdAt: Date.now(),
    meta: { runId, fileCount: zipFiles.length, fileNames: zipFiles.map((f) => f.name) }
  });
}

/**
 * Encode bytes as a data: URL (base64). Safe for binary zip and text.
 * @param {Uint8Array} bytes
 * @param {string} [mime]
 * @returns {string}
 */
export function bytesToDataUrl(bytes, mime = 'application/octet-stream') {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const type = (mime && String(mime)) || 'application/octet-stream';
  let b64;
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    b64 = Buffer.from(buf).toString('base64');
  } else if (typeof btoa === 'function') {
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    b64 = btoa(binary);
  } else {
    throw new Error('No base64 encoder available');
  }
  return `data:${type};base64,${b64}`;
}

/**
 * Build a downloadable data URL from an artifact record.
 * @param {ArtifactRecord} rec
 * @returns {string}
 */
export function artifactToDataUrl(rec) {
  if (!rec) throw new Error('artifact record required');
  if (rec.bytes instanceof Uint8Array) {
    return bytesToDataUrl(rec.bytes, rec.mime || 'application/octet-stream');
  }
  if (rec.content != null) {
    return bytesToDataUrl(new TextEncoder().encode(String(rec.content)), rec.mime || 'text/plain');
  }
  return bytesToDataUrl(new Uint8Array(0), rec.mime || 'application/octet-stream');
}

/**
 * Convenience: create a dedicated store handle bound to one runId.
 * Methods match the meta API names for ergonomic use in runtime/tools.
 * @param {string} [runId]
 */
export function createArtifactStore(runId) {
  const id = resolveRunId(runId);
  // Ensure map exists
  getRunArtifactMap(id);
  return {
    runId: id,
    createTextArtifact: (opts = {}) => createTextArtifact({ ...opts, runId: id }),
    createTableArtifact: (opts = {}) => createTableArtifact({ ...opts, runId: id }),
    packZipArtifact: (opts = {}) => packZipArtifact({ ...opts, runId: id }),
    getArtifact: (artifactId) => getArtifact(artifactId, id),
    listArtifacts: () => listArtifacts(id),
    clear: () => clearRunArtifacts(id),
    get size() {
      return getRunArtifactMap(id).size;
    }
  };
}
