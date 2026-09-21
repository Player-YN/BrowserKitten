/**
 * Host law: HTML files are websites or documents.
 * Model-origin generic writes cannot land leftover visual-canvas snapshots.
 */

const NEED_HTML_KIND = {
  ok: false,
  code: 'NEED_HTML_KIND',
  error:
    'HTML files must be a website (data-browserbot-kind="site") or a document (data-browserbot-kind="document").',
  hint: 'add data-browserbot-kind=site, or register a document with run op=doc (createDocument)'
};

export function htmlWritePolicy(content, name = '') {
  const decoded = decodeWritePayload(content);
  const text = typeof decoded === 'string' ? decoded : '';
  const n = String(name || '');
  const trimmed = text.trim();
  if (!trimmed && (decoded == null || decoded === '')) return { allow: true };
  if (decoded && typeof decoded === 'object') {
    return { allow: true, kind: 'json' };
  }
  if (!trimmed) return { allow: true };
  const looksSvg = /^\s*(<\?xml[\s\S]{0,240})?<svg[\s>]/i.test(trimmed) || /\.svg$/i.test(n);
  if (looksSvg) return { allow: true, kind: 'svg' };
  const looksHtml =
    /html/i.test(n) ||
    /text\/html/i.test(n) ||
    (/^\s*</.test(trimmed) && /<[a-z!/]/i.test(trimmed) && !looksSvg);
  if (!looksHtml) return { allow: true };
  if (/data-browserbot-kind\s*=\s*["'](site|web)["']/i.test(text)) return { allow: true, kind: 'site' };
  if (/data-browserbot-kind\s*=\s*["']document["']/i.test(text) || /id=["']paw-document["']/i.test(text)) {
    return { allow: true, kind: 'doc' };
  }
  return { ...NEED_HTML_KIND, allow: false };
}

export function looksLikeVisualCanvasPayload() {
  return false;
}

export function decodeWritePayload(content) {
  if (content == null) return '';
  if (typeof content === 'object' && !isBinaryLike(content)) return content;
  const text = asUtf8(content);
  if (!text) return text;
  const unwrapped = unwrapEncodedText(text);
  return unwrapped;
}

function asUtf8(content) {
  if (typeof content === 'string') return content;
  if (isBinaryLike(content)) {
    try {
      const bytes =
        content instanceof Uint8Array
          ? content
          : ArrayBuffer.isView(content)
            ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
            : new Uint8Array(content);
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  }
  return String(content || '');
}

function isBinaryLike(value) {
  return (
    value instanceof Uint8Array ||
    (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))
  );
}

function unwrapEncodedText(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  const dataUrl = t.match(/^data:[^;]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrl) {
    const dec = tryDecodeBase64(dataUrl[1]);
    if (dec) return dec;
  }
  if (looksLikeBase64(t)) {
    const dec = tryDecodeBase64(t);
    if (dec && looksLikeJsonText(dec)) return dec;
  }
  return t;
}

function looksLikeBase64(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (t.length < 16 || t.length % 4 !== 0) return false;
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('<')) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

function tryDecodeBase64(s) {
  try {
    const compact = String(s || '').replace(/\s+/g, '');
    if (typeof Buffer !== 'undefined') return Buffer.from(compact, 'base64').toString('utf8');
    return atob(compact);
  } catch {
    return '';
  }
}

function looksLikeJsonText(s) {
  const x = String(s || '').trim();
  return x.startsWith('{') || x.startsWith('[');
}
