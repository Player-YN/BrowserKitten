/**
 * Single open-ingest classifier. Magic bytes first; name/MIME are hints.
 * Never UTF-8-decode ZIP (PK) or PDF (%PDF) as document text.
 */

export const SHEET_OPEN_KINDS = new Set(['xlsx', 'csv', 'tsv', 'json-workbook']);
export const DOCS_OPEN_KINDS = new Set(['docx', 'json-document', 'html-document']);
export const UTF8_OPEN_KINDS = new Set([
  'json-workbook',
  'json-document',
  'json-canvas',
  'html-document',
  'html-plates',
  'html',
  'csv',
  'tsv',
  'markdown',
  'text',
  'json',
  'yaml',
  'javascript',
  'typescript',
  'css'
]);
export const BINARY_OPEN_KINDS = new Set(['pdf', 'xlsx', 'docx', 'pptx', 'zip', 'png', 'jpeg', 'gif', 'webp', 'binary']);

export function asOpenBytes(bytes) {
  if (bytes == null) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  return new Uint8Array(0);
}

export function looksLikeZipBytes(bytes) {
  const b = asOpenBytes(bytes);
  return (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    ((b[2] === 0x03 && b[3] === 0x04) ||
      (b[2] === 0x05 && b[3] === 0x06) ||
      (b[2] === 0x07 && b[3] === 0x08))
  );
}

export function looksLikePdfBytes(bytes) {
  const b = asOpenBytes(bytes);
  return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

export function isUtf8OpenKind(kind) {
  return UTF8_OPEN_KINDS.has(String(kind || ''));
}

export const RASTER_OPEN_KINDS = new Set(['png', 'jpeg', 'gif', 'webp']);

export function isRasterOpenKind(kind) {
  return RASTER_OPEN_KINDS.has(String(kind || ''));
}

export function previewEntryForKind(kind) {
  const k = String(kind || '');
  if (SHEET_OPEN_KINDS.has(k)) return 'sheet.html';
  if (DOCS_OPEN_KINDS.has(k)) return 'docs.html';
  if (k === 'json-canvas') return 'artifactPreview.html';
  if (k === 'html-site') return 'site.html';
  return 'artifactPreview.html';
}

/**
 * @param {{ name?: string, mimeType?: string, mime?: string, bytes?: Uint8Array, text?: string, content?: string, artifact?: object }} item
 * @returns {{ kind: string, canvas: string, reason: string }}
 */
export function classifyOpenArtifact(item = {}) {
  const name = String(item.name || item.artifact?.name || '');
  const mime = String(item.mimeType || item.mime || item.artifact?.mimeType || '');
  const bytes = asOpenBytes(item.bytes);
  const text =
    item.text != null && String(item.text).length
      ? String(item.text)
      : item.content != null
        ? String(item.content)
        : '';

  if (bytes.byteLength) {
    const mag = kindFromMagic(bytes);
    if (mag) return finish(mag, 'magic');
  } else if (textLooksBinary(text)) {
    if (/^\s*%PDF/.test(text) || text.includes('%PDF-')) return finish('pdf', 'text-magic');
    return finish('binary', 'text-magic');
  }

  const fromUtf8 = kindFromUtf8(bytes, text);
  if (fromUtf8) return finish(fromUtf8, 'utf8');

  const hint = kindFromNameMime(name, mime);
  if (hint) return finish(hint, 'name');

  if (bytes.byteLength) return finish('binary', 'opaque');
  if (String(text).trim()) return finish('text', 'text');
  return finish('empty', 'empty');
}

function finish(kind, reason) {
  return { kind, canvas: canvasForKind(kind), reason };
}

/**
 * Leftover tldraw Design/Slides JSON. Not a product surface — generic preview only.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isRemovedCanvasDoc(raw) {
  const obj = coerceJsonObject(raw);
  if (!obj) return false;
  if (Number(obj.pawCanvas) === 1) return true;
  const shell = String(obj.shell || obj.kind || '').toLowerCase();
  if (shell === 'slides' || shell === 'design' || shell === 'deck' || shell === 'poster') return true;
  return looksLikeTldrawStore(obj);
}

function coerceJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text.startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function looksLikeTldrawStore(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const store =
    doc.tldraw?.document?.store ||
    doc.document?.store ||
    (doc.store && typeof doc.store === 'object' && !Array.isArray(doc.store) ? doc.store : null);
  if (!store || typeof store !== 'object' || Array.isArray(store)) return false;
  return Object.keys(store).some(
    (k) =>
      k.startsWith('shape:') ||
      k.startsWith('asset:') ||
      k.startsWith('page:') ||
      k === 'document:document'
  );
}

function canvasForKind(kind) {
  if (SHEET_OPEN_KINDS.has(kind)) return 'sheet';
  if (DOCS_OPEN_KINDS.has(kind)) return 'docs';
  if (kind === 'json-canvas') return 'none';
  if (kind === 'html-site') return 'web';
  if (kind === 'html' || kind === 'json' || kind === 'yaml' || kind === 'javascript' || kind === 'typescript' || kind === 'css') {
    return 'none';
  }
  if (kind === 'png' || kind === 'jpeg' || kind === 'gif' || kind === 'webp' || kind === 'svg' || kind === 'audio' || kind === 'video') {
    return 'gallery';
  }
  if (kind === 'empty' || kind === 'binary' || kind === 'zip' || kind === 'pptx') return 'none';
  return 'html-plates';
}

function kindFromMagic(bytes) {
  if (looksLikePdfBytes(bytes)) return 'pdf';
  if (looksLikeZipBytes(bytes)) return zipOfficeKind(bytes);
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (isGif(bytes)) return 'gif';
  if (isWebp(bytes)) return 'webp';
  return '';
}

function zipOfficeKind(bytes) {
  const names = [...zipEntryNames(bytes)].map((n) => n.replace(/\\/g, '/').toLowerCase());
  if (names.some((n) => n === 'xl/workbook.xml' || n.endsWith('/xl/workbook.xml'))) return 'xlsx';
  if (names.some((n) => n === 'word/document.xml' || n.endsWith('/word/document.xml'))) return 'docx';
  if (names.some((n) => n === 'ppt/presentation.xml' || n.endsWith('/ppt/presentation.xml'))) return 'pptx';
  return 'zip';
}

function zipEntryNames(bytes) {
  const names = new Set();
  const b = asOpenBytes(bytes);
  if (b.byteLength < 30) return names;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i + 30 <= b.byteLength; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    if (i + 30 + nameLen > b.byteLength) break;
    names.add(new TextDecoder().decode(b.slice(i + 30, i + 30 + nameLen)));
    const compressedSize = view.getUint32(i + 18, true);
    const next = i + 30 + nameLen + extraLen + compressedSize;
    if (next > i) i = next - 1;
  }
  return names;
}

function kindFromUtf8(bytes, text) {
  let src = String(text || '').replace(/^\uFEFF/, '');
  if (!src && bytes.byteLength && !kindFromMagic(bytes) && looksTextish(bytes)) {
    try {
      src = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      src = '';
    }
  }
  const trimmed = src.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        if (
          obj.body &&
          typeof obj.body === 'object' &&
          typeof obj.body.dataStream === 'string' &&
          !obj.sheets
        ) {
          return 'json-document';
        }
        if (obj.sheets && typeof obj.sheets === 'object' && Array.isArray(obj.sheetOrder)) {
          return 'json-workbook';
        }
        if (Number(obj.pawCanvas) === 1 && obj.tldraw && typeof obj.tldraw === 'object') {
          return 'json-canvas';
        }
      }
    } catch {
      /* not JSON */
    }
  }
  if (hasDocumentSidecar(src)) return 'html-document';
  if (/data-browserbot-kind\s*=\s*["'](site|web)["']/i.test(src)) return 'html-site';
  if (/data-browserbot-preview\s*=\s*["']blocks["']/i.test(src)) return 'html-plates';
  if (/^\s*(<\?xml[\s\S]{0,240})?<svg[\s>]/i.test(trimmed)) return 'svg';
  if (/^\s*</.test(trimmed) && /<[a-z!/]/i.test(trimmed)) return 'html';
  return '';
}

function kindFromNameMime(name, mime) {
  const n = String(name || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (m.includes('spreadsheetml') || m.includes('excel') || /\.xlsx$/i.test(n)) return 'xlsx';
  if (m.includes('wordprocessingml') || /\.docx$/i.test(n)) return 'docx';
  if (m.includes('presentationml') || /\.pptx$/i.test(n)) return 'pptx';
  if (m === 'application/pdf' || m.includes('application/pdf') || /\.pdf$/i.test(n)) return 'pdf';
  if (m.includes('image/jpeg') || /\.jpe?g$/i.test(n)) return 'jpeg';
  if (m.includes('image/png') || n.endsWith('.png')) return 'png';
  if (m.includes('image/gif') || n.endsWith('.gif')) return 'gif';
  if (m.includes('image/webp') || n.endsWith('.webp')) return 'webp';
  if (m.includes('svg') || n.endsWith('.svg')) return 'svg';
  if (m.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus|oga)$/i.test(n)) return 'audio';
  if (m.startsWith('video/') || /\.(mp4|webm|mov|mkv|ogv|m4v)$/i.test(n)) return 'video';
  if (m.includes('tab-separated') || m.includes('tsv') || /\.tsv$/i.test(n)) return 'tsv';
  if (m.includes('csv') || /\.csv$/i.test(n)) return 'csv';
  if (m.includes('markdown') || /\.md$/i.test(n)) return 'markdown';
  if (m.includes('html') || /\.html?$/i.test(n)) return 'html';
  if (m.includes('json') || /\.json$/i.test(n)) return 'json';
  if (m.includes('yaml') || /\.ya?ml$/i.test(n)) return 'yaml';
  if (m.includes('javascript') || /\.(js|mjs|cjs)$/i.test(n)) return 'javascript';
  if (/\.(ts|tsx)$/i.test(n)) return 'typescript';
  if (m === 'text/css' || /\.css$/i.test(n)) return 'css';
  if (m.startsWith('text/') || /\.(txt|log)$/i.test(n)) return 'text';
  return '';
}

function textLooksBinary(text) {
  const s = String(text || '');
  if (!s) return false;
  if (s.startsWith('%PDF') || s.includes('%PDF-')) return true;
  if (s.startsWith('PK') && s.length >= 3 && s.charCodeAt(2) < 32) return true;
  if (s.includes('\u0000') || /\uFFFD/.test(s.slice(0, 200))) return true;
  return false;
}

function looksTextish(bytes) {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  const b0 = bytes[0];
  return b0 === 0x09 || b0 === 0x0a || b0 === 0x0d || (b0 >= 0x20 && b0 < 0x7f) || b0 >= 0xc0;
}

function hasDocumentSidecar(src) {
  return (
    /data-browserbot-kind\s*=\s*["'](document|doc)["']/i.test(src) ||
    /id=["']paw-document["']/i.test(src) ||
    /<!--\s*paw-document\b/i.test(src)
  );
}

function isPng(b) {
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(b) {
  return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
}

function isWebp(b) {
  return (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  );
}

export { previewEntryForItem, previewViewForItem } from './artifactCapability.js';
