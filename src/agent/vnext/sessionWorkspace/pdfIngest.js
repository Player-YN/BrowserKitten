/**
 * Best-effort PDF → marked HTML lookalike.
 * Visual reconstruction only — never original PDF bytes, never "cannot edit PDF".
 */

import { serializeMarkedHtml, escapeHtml, formatBox } from './htmlApply.js';

export const PDF_RECONSTRUCTION_WARNING =
  'Visual reconstruction from PDF text; not original PDF bytes. Layout is approximate.';
export const PDF_RECONSTRUCT_WARNING = PDF_RECONSTRUCTION_WARNING;
export const PDF_VISUAL_WARNING =
  'Full-page bitmap from PDF; not layered components. Edit as a poster cover slot.';

export function looksLikePdf(bytes) {
  const u8 = coerceBytes(bytes);
  if (u8.length >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return true;
  return bytesToLatin1(u8.slice(0, 8)).startsWith('%PDF');
}

function latin1StringToBytes(s) {
  const str = String(s || '');
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/\s+/g, '');
  if (!s) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Bytes the preview tab must feed reconstruct. Prefer base64; latin1 `content`
 * of a PDF must not go through UTF-8 TextEncoder.
 */
export function bytesForPdfPreview({ base64, content, bytes, text } = {}) {
  if (bytes instanceof Uint8Array && bytes.byteLength) return bytes;
  if (ArrayBuffer.isView(bytes) && bytes.byteLength) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const fromB64 = base64ToBytes(base64);
  if (fromB64.byteLength) return fromB64;
  const raw = content != null && String(content).length ? String(content) : String(text || '');
  if (!raw) return new Uint8Array(0);
  if (raw.startsWith('%PDF') || raw.includes('%PDF-') || /[\u0080-\u00ff]/.test(raw)) {
    return latin1StringToBytes(raw);
  }
  return new TextEncoder().encode(raw);
}

const PAGE_W = 612;
const PAGE_H = 792;

function coerceBytes(bytes) {
  if (bytes == null) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  if (typeof bytes === 'string') {
    if (bytes.startsWith('%PDF') || bytes.includes('%PDF-')) return latin1StringToBytes(bytes);
    return new TextEncoder().encode(bytes);
  }
  return new Uint8Array(0);
}

function bytesToLatin1(u8) {
  const parts = [];
  for (let i = 0; i < u8.length; i += 0x8000) {
    parts.push(String.fromCharCode(...u8.subarray(i, i + 0x8000)));
  }
  return parts.join('');
}

function inflateFlateZlib(u8) {
  try {
    const getBuiltin = globalThis.process?.getBuiltinModule;
    if (typeof getBuiltin === 'function') {
      const zlib = getBuiltin('zlib');
      if (zlib) {
        try {
          return new Uint8Array(zlib.inflateSync(u8));
        } catch {
          /* try raw */
        }
        try {
          return new Uint8Array(zlib.inflateRawSync(u8));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* extension host: no zlib */
  }
  return null;
}

async function inflateFlate(u8) {
  if (typeof DecompressionStream === 'function') {
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format));
        const buf = await new Response(stream).arrayBuffer();
        if (buf.byteLength) return new Uint8Array(buf);
      } catch {
        /* try next format / zlib */
      }
    }
  }
  return inflateFlateZlib(u8);
}

function decodePdfLiteral(raw) {
  return String(raw || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function decodePdfHex(hex) {
  const h = String(hex || '').replace(/\s/g, '');
  const padded = h.length % 2 ? `${h}0` : h;
  const bytes = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(parseInt(padded.slice(i, i + 2), 16) || 0);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }
  return String.fromCharCode(...bytes);
}

function tokenizeContent(s) {
  const tokens = [];
  let i = 0;
  const str = String(s || '');
  while (i < str.length) {
    const c = str[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\0') {
      i += 1;
      continue;
    }
    if (c === '%') {
      while (i < str.length && str[i] !== '\n') i += 1;
      continue;
    }
    if (c === '(') {
      let j = i + 1;
      let out = '';
      let depth = 1;
      while (j < str.length && depth > 0) {
        if (str[j] === '\\') {
          out += str[j] + (str[j + 1] || '');
          j += 2;
          continue;
        }
        if (str[j] === '(') depth += 1;
        else if (str[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
        out += str[j];
        j += 1;
      }
      tokens.push({ type: 'string', value: decodePdfLiteral(out) });
      i = j + 1;
      continue;
    }
    if (c === '<' && str[i + 1] === '<') {
      tokens.push({ type: 'dictStart' });
      i += 2;
      continue;
    }
    if (c === '>' && str[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (c === '<') {
      const k = str.indexOf('>', i + 1);
      if (k < 0) break;
      tokens.push({ type: 'hex', value: decodePdfHex(str.slice(i + 1, k)) });
      i = k + 1;
      continue;
    }
    if (c === '[') {
      tokens.push({ type: 'arrStart' });
      i += 1;
      continue;
    }
    if (c === ']') {
      tokens.push({ type: 'arrEnd' });
      i += 1;
      continue;
    }
    if (c === '/') {
      let j = i + 1;
      while (j < str.length && /[^\s()<>[\]{}/%]/.test(str[j])) j += 1;
      tokens.push({ type: 'name', value: str.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-+0-9.]/.test(c)) {
      let j = i + 1;
      while (j < str.length && /[-+0-9.eE]/.test(str[j])) j += 1;
      tokens.push({ type: 'num', value: parseFloat(str.slice(i, j)) });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < str.length && /[A-Za-z*]/.test(str[j])) j += 1;
    tokens.push({ type: 'op', value: str.slice(i, j) });
    i = j;
  }
  return tokens;
}

function runsFromContent(content, pageH = PAGE_H) {
  const tokens = tokenizeContent(content);
  const runs = [];
  let x = 72;
  let y = 720;
  let fontSize = 12;
  let leading = fontSize * 1.2;
  const nums = [];
  let lastString = '';
  let lastArr = [];
  const arrStack = [];
  let arr = null;

  const emit = (text) => {
    const t = String(text || '');
    if (!t) return;
    const top = Math.max(0, pageH - y - fontSize);
    const w = Math.max(8, Math.round(t.length * fontSize * 0.5));
    const h = Math.max(8, Math.round(fontSize * 1.2));
    runs.push({
      text: t,
      fontSize,
      box: { x: Math.round(x), y: Math.round(top), w, h }
    });
  };

  for (const t of tokens) {
    if (t.type === 'arrStart') {
      arrStack.push(arr);
      arr = [];
      continue;
    }
    if (t.type === 'arrEnd') {
      const done = arr || [];
      arr = arrStack.pop() || null;
      if (arr) arr.push(done);
      else lastArr = done;
      continue;
    }
    if (arr) {
      if (t.type === 'string' || t.type === 'hex' || t.type === 'num') arr.push(t);
      continue;
    }
    if (t.type === 'num') {
      nums.push(t.value);
      continue;
    }
    if (t.type === 'string' || t.type === 'hex') {
      lastString = t.value;
      continue;
    }
    if (t.type !== 'op') continue;
    const op = t.value;
    if (op === 'Td' || op === 'TD') {
      const dy = nums.length ? nums.pop() : 0;
      const dx = nums.length ? nums.pop() : 0;
      x += dx;
      y += dy;
      if (op === 'TD') leading = Math.abs(dy) || leading;
      nums.length = 0;
    } else if (op === 'Tm') {
      const fy = nums.length ? nums.pop() : y;
      const fx = nums.length ? nums.pop() : x;
      nums.length = 0;
      x = fx;
      y = fy;
    } else if (op === 'Tf') {
      const size = nums.length ? nums.pop() : fontSize;
      nums.length = 0;
      if (Number.isFinite(size) && size > 0) {
        fontSize = size;
        leading = fontSize * 1.2;
      }
    } else if (op === 'TL') {
      const v = nums.length ? nums.pop() : leading;
      nums.length = 0;
      if (Number.isFinite(v)) leading = Math.abs(v) || leading;
    } else if (op === 'Tj' || op === "'") {
      if (op === "'") y -= leading;
      emit(lastString);
      lastString = '';
      nums.length = 0;
    } else if (op === 'TJ') {
      const text = (lastArr || [])
        .filter((item) => item && (item.type === 'string' || item.type === 'hex'))
        .map((item) => item.value)
        .join('');
      emit(text);
      lastArr = [];
      nums.length = 0;
    } else if (op === 'T*') {
      y -= leading;
      nums.length = 0;
    } else {
      nums.length = 0;
    }
  }
  return runs;
}

function extractStreamBytes(objBody) {
  const s = String(objBody || '');
  const m = /stream(?:\r\n|\n|\r)/.exec(s);
  if (!m) return null;
  const start = m.index + m[0].length;
  const dict = s.slice(0, m.index);
  const indirectLen = /\/Length\s+\d+\s+\d+\s+R/.test(dict);
  const lenMatch = !indirectLen && /\/Length\s+(\d+)\b/.exec(dict);
  let end;
  if (lenMatch) {
    end = Math.min(s.length, start + Number(lenMatch[1]));
  } else {
    const marker = s.indexOf('endstream', start);
    if (marker < 0) return null;
    end = marker;
    if (s[end - 1] === '\n') end -= 1;
    if (s[end - 1] === '\r') end -= 1;
  }
  if (end <= start) return null;
  let payload = s.slice(start, end);
  const es = payload.indexOf('endstream');
  if (es >= 0) payload = payload.slice(0, es);
  return latin1StringToBytes(payload);
}

function isJpegBytes(u8) {
  return u8 && u8.length > 24 && u8[0] === 0xff && u8[1] === 0xd8;
}

function isPngBytes(u8) {
  return u8 && u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
}

function bitmapDataUrl(im) {
  const buf = im.bytes;
  const mime = im.mime || (isPngBytes(buf) ? 'image/png' : 'image/jpeg');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * Embedded page bitmaps (posters, scans). CID text in these PDFs is not readable.
 */
export function extractPdfBitmaps(latin1OrObjects) {
  const objects =
    latin1OrObjects instanceof Map ? latin1OrObjects : parsePdfObjects(String(latin1OrObjects || ''));
  const out = [];
  for (const [, body] of objects) {
    if (!/\/Image/.test(body) || !/\/Width/.test(body)) continue;
    const w = Number((/\/Width\s+(\d+)/.exec(body) || [])[1] || 0);
    const h = Number((/\/Height\s+(\d+)/.exec(body) || [])[1] || 0);
    const filter = ((/\/Filter\s*\/(\w+)/.exec(body) || [])[1] || '').toLowerCase();
    const raw = extractStreamBytes(body);
    if (!raw?.length) continue;
    if (filter === 'dctdecode' || isJpegBytes(raw)) {
      out.push({ bytes: raw, w, h, mime: 'image/jpeg' });
    } else if (isPngBytes(raw)) {
      out.push({ bytes: raw, w, h, mime: 'image/png' });
    }
  }
  return out;
}

async function extractStreamBodies(objBody) {
  const bodies = [];
  const s = String(objBody || '');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const dict = s.slice(0, m.index);
    const start = m.index + m[0].length;
    const lenMatch = /\/Length\s+(\d+)/.exec(dict);
    let payload;
    if (lenMatch) {
      payload = s.slice(start, start + Number(lenMatch[1]));
    } else {
      const end = s.indexOf('endstream', start);
      if (end < 0) break;
      payload = s.slice(start, end);
      if (payload.endsWith('\r')) payload = payload.slice(0, -1);
    }
    const isFlate = /\/Filter\s*\/FlateDecode/i.test(dict);
    if (isFlate) {
      const bytes = latin1StringToBytes(payload);
      const inflated = await inflateFlate(bytes);
      bodies.push(inflated ? bytesToLatin1(inflated) : '');
    } else {
      bodies.push(payload);
    }
  }
  return bodies;
}

function parsePdfObjects(latin1) {
  const objects = new Map();
  const s = String(latin1 || '');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const id = Number(m[1]);
    const start = m.index + m[0].length;
    const streamKw = s.indexOf('stream', start);
    const endobjKw = s.indexOf('endobj', start);
    if (streamKw >= 0 && (endobjKw < 0 || streamKw < endobjKw)) {
      const dict = s.slice(start, streamKw);
      let payloadStart = streamKw + 6;
      if (s[payloadStart] === '\r') payloadStart += 1;
      if (s[payloadStart] === '\n') payloadStart += 1;
      const indirect = /\/Length\s+\d+\s+\d+\s+R/.test(dict);
      const lenMatch = !indirect && /\/Length\s+(\d+)\b/.exec(dict);
      let afterPayload;
      if (lenMatch) afterPayload = payloadStart + Number(lenMatch[1]);
      else {
        const es = s.indexOf('endstream', payloadStart);
        afterPayload = es < 0 ? payloadStart : es;
      }
      const endobj = s.indexOf('endobj', afterPayload);
      if (endobj < 0) continue;
      objects.set(id, s.slice(start, endobj));
      re.lastIndex = endobj + 6;
    } else if (endobjKw >= 0) {
      objects.set(id, s.slice(start, endobjKw));
      re.lastIndex = endobjKw + 6;
    }
  }
  return objects;
}

function contentIdsFromPage(body) {
  const ids = [];
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(body);
  if (single) ids.push(Number(single[1]));
  const bracket = /\/Contents\s*\[([^\]]*)\]/.exec(body);
  if (bracket) {
    const inner = bracket[1];
    const re = /(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = re.exec(inner))) ids.push(Number(m[1]));
  }
  return [...new Set(ids)];
}

function mediaBox(body) {
  const m = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(body);
  if (!m) return { w: PAGE_W, h: PAGE_H };
  return { w: Number(m[3]) - Number(m[1]) || PAGE_W, h: Number(m[4]) - Number(m[2]) || PAGE_H };
}

function isPageObject(body) {
  return /\/Type\s*\/Page\b/.test(body) && !/\/Type\s*\/Pages\b/.test(body);
}

function extractTjFromRaw(raw) {
  const runs = [];
  const tj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let m;
  while ((m = tj.exec(raw))) {
    const text = decodePdfLiteral(m[1]);
    if (text.trim()) runs.push({ text, fontSize: 14, box: { x: 48, y: 48 + runs.length * 22, w: 500, h: 20 } });
  }
  const tjArr = /\[([\s\S]*?)\]\s*TJ/g;
  while ((m = tjArr.exec(raw))) {
    const parts = [];
    const inner = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let p;
    while ((p = inner.exec(m[1]))) {
      parts.push(p[1] != null ? decodePdfLiteral(p[1]) : decodePdfHex(p[2]));
    }
    const text = parts.join('');
    if (text.trim()) runs.push({ text, fontSize: 14, box: { x: 48, y: 48 + runs.length * 22, w: 500, h: 20 } });
  }
  return runs;
}

function printableFallback(raw) {
  const skip = /^(obj|endobj|stream|endstream|xref|trailer|startxref|%%EOF|<<|>>)/i;
  const re = /[\x20-\x7E]{4,}/g;
  const out = [];
  let m;
  while ((m = re.exec(raw))) {
    const s = m[0].replace(/^\/+/, '').trim();
    if (!s || skip.test(s)) continue;
    if (/^(Type|Page|Pages|Font|Catalog|Helvetica|Length|Filter|Parent|MediaBox|Resources|Contents|Kids|Count|Subtype|BaseFont|Size|Root)$/i.test(s)) {
      continue;
    }
    if (/^[0-9.\s]+$/.test(s)) continue;
    out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

function runToSlot(run, i) {
  const box = formatBox(run.box);
  const style = `position:absolute;left:${run.box.x}px;top:${run.box.y}px;font-size:${run.fontSize || 14}px;margin:0;line-height:1.2`;
  return `<p data-paw-slot="t${i}" data-box="${box}" style="${style}">${escapeHtml(run.text)}</p>`;
}

function pagePlate(pageIndex, runs, size, extraText) {
  const list = runs.length ? runs : extraText ? [{ text: extraText, fontSize: 14, box: { x: 48, y: 48, w: 500, h: 24 } }] : [];
  const slots = list.map((run, i) => runToSlot(run, i)).join('\n  ');
  const inner = slots
    ? slots
    : `<p data-paw-slot="t0" data-box="48,48,500,24">PDF page ${pageIndex}</p>`;
  return {
    id: `page-${pageIndex}`,
    html: `\n  ${inner}\n`,
    pdf: true,
    width: size.w,
    height: size.h
  };
}

function buildHtml(pages, opts, warning) {
  const visual = pages.some((p) => p.visual);
  const w = pages[0]?.width || PAGE_W;
  const h = pages[0]?.height || PAGE_H;
  const kind = opts.kind || (visual ? 'poster' : 'poster');
  const styles = visual
    ? `:root{--paw-poster-w:${Math.min(720, w)}px;--paw-poster-h:${h}px}
body{margin:0;background:#e7e5e4}
section[data-browserbot-block]{position:relative;width:var(--paw-poster-w);height:var(--paw-poster-h);margin:16px auto;background:#fff;overflow:hidden}
section[data-browserbot-block] img{width:100%;height:100%;object-fit:cover;display:block}`
    : kind === 'deck'
      ? `:root{--paw-slide-w:${w}px;--paw-slide-h:${h}px}
body{margin:0;background:#e7e5e4;font-family:Helvetica,Arial,sans-serif;color:#1c1917}
section[data-browserbot-block]{position:relative;width:var(--paw-slide-w);height:var(--paw-slide-h);margin:16px auto;background:#fff;overflow:hidden}
section[data-browserbot-block] p{white-space:pre-wrap;margin:0}`
      : `:root{--paw-poster-w:${w}px;--paw-poster-h:${h}px}
body{margin:0;background:#e7e5e4;font-family:Helvetica,Arial,sans-serif;color:#1c1917}
section[data-browserbot-block]{position:relative;width:var(--paw-poster-w);height:var(--paw-poster-h);margin:16px auto;background:#fff;overflow:hidden}
section[data-browserbot-block] p{white-space:pre-wrap;margin:0}`;
  const plates = pages.map((p) => ({
    id: p.id,
    html: p.html,
    pdf: true
  }));
  const html = serializeMarkedHtml({
    title: opts.title || 'PDF',
    lang: opts.lang || 'zh-CN',
    styles,
    kind,
    pdf: true,
    plates
  });
  const withComment = html.replace(
    '<body>',
    `<!-- ${warning} -->\n<body>`
  );
  return withComment;
}

function fallbackDocument(text, opts, warning) {
  const body = String(text || '').trim() || '(unreadable PDF)';
  const plate = {
    id: 'page-1',
    html: `<p data-paw-slot="t0">${escapeHtml(body)}</p>`,
    pdf: true
  };
  return {
    ok: true,
    html: buildHtml([plate], opts, warning),
    warning,
    reconstructed: true,
    pages: 1,
    text: body
  };
}

/**
 * Convert PDF bytes to marked lookalike HTML. Always ok:true; never throws
 * "cannot edit PDF".
 * @param {Uint8Array|ArrayBuffer|number[]|string} bytes
 * @param {{ title?: string, lang?: string }} [opts]
 */
export async function pdfBytesToHtml(bytes, opts = {}) {
  const warning = PDF_RECONSTRUCTION_WARNING;
  try {
    const u8 = coerceBytes(bytes);
    const latin1 = bytesToLatin1(u8);
    const objects = parsePdfObjects(latin1);
    const bitmaps = extractPdfBitmaps(objects);
    const visual = bitmaps.filter((im) => (im.w || 0) >= 400 || im.bytes.length > 20_000);
    if (visual.length) {
      const pages = visual.map((im, i) => {
        const cssW = Math.min(720, im.w || 720);
        const cssH = im.w ? Math.round(cssW * ((im.h || cssW) / im.w)) : 1080;
        return {
          id: `page-${i + 1}`,
          html: `\n  <img data-paw-slot="cover" data-box="0,0,${cssW},${cssH}" alt="${escapeHtml(opts.title || 'PDF')}" src="${bitmapDataUrl(im)}" />\n`,
          pdf: true,
          visual: true,
          width: cssW,
          height: cssH
        };
      });
      return {
        ok: true,
        html: buildHtml(pages, { ...opts, kind: 'poster' }, PDF_VISUAL_WARNING),
        warning: PDF_VISUAL_WARNING,
        reconstructed: true,
        pages: pages.length,
        text: '',
        visual: true
      };
    }
    const pageObjs = [];
    for (const [id, body] of objects) {
      if (isPageObject(body)) pageObjs.push({ id, body });
    }
    const pages = [];
    const allText = [];
    for (let i = 0; i < pageObjs.length; i++) {
      const page = pageObjs[i];
      const size = mediaBox(page.body);
      const ids = contentIdsFromPage(page.body);
      const chunks = [];
      for (const cid of ids) {
        chunks.push((await extractStreamBodies(objects.get(cid) || '')).join('\n'));
      }
      let content = chunks.join('\n');
      if (!content) content = (await extractStreamBodies(page.body)).join('\n');
      let runs = runsFromContent(content, size.h);
      if (!runs.length) runs = extractTjFromRaw(content || latin1);
      for (const r of runs) allText.push(r.text);
      pages.push(pagePlate(i + 1, runs, size, runs.length ? '' : allText.join('\n')));
    }

    if (!pages.length) {
      let runs = extractTjFromRaw(latin1);
      if (!runs.length) {
        const loose = printableFallback(latin1);
        if (loose.length) {
          runs = loose.map((text, i) => ({
            text,
            fontSize: 14,
            box: { x: 48, y: 48 + i * 22, w: 500, h: 20 }
          }));
        }
      }
      const joined = runs.map((r) => r.text).join('\n');
      if (!runs.length) return fallbackDocument(joined, opts, warning);
      pages.push(pagePlate(1, runs, { w: PAGE_W, h: PAGE_H }, joined));
      allText.push(...runs.map((r) => r.text));
    }

    const text = allText.filter(Boolean).join('\n');
    return {
      ok: true,
      html: buildHtml(pages, { ...opts, kind: pages.length > 1 ? 'deck' : 'poster' }, warning),
      warning,
      reconstructed: true,
      pages: pages.length,
      text,
      visual: false
    };
  } catch {
    return fallbackDocument('', opts, warning);
  }
}
