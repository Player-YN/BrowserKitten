/**
 * Host doc export from Univer IDocumentData — not p/h1/img block flattening.
 * HTML download is human-openable; sidecar JSON is the document source of truth (lists, drawings, styles).
 */

export const DOC_SNAP_SCRIPT_ID = 'paw-document';

const TITLE = 2;
const HEADING_1 = 4;
const HEADING_2 = 5;
const HEADING_3 = 6;
const HEADING_4 = 7;
const HEADING_5 = 8;
const HYPERLINK = 0;
const TRUE = 1;

export function isDocumentData(data) {
  return !!(
    data &&
    typeof data === 'object' &&
    data.body &&
    typeof data.body.dataStream === 'string' &&
    !data.sheets
  );
}

export function cloneDocumentData(data) {
  if (!data || typeof data !== 'object') return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
}

const TABLE_START = '\u001A';
const TABLE_END = '\u000F';
const TABLE_TOKEN_RE = /[\u001A\u001B\u001C\u001D\u000E\u000F]/g;

function tableStreamBalanced(stream) {
  let open = 0;
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    if (ch === TABLE_START) open += 1;
    else if (ch === TABLE_END) {
      open -= 1;
      if (open < 0) return false;
    }
  }
  return open === 0;
}

/**
 * Make IDocumentData safe for Univer Docs createUniverDoc.
 * Unbalanced table tokens crash engine-render (`isFinished` on undefined).
 */
export function normalizeUniverDoc(data, opts = {}) {
  const raw = data && typeof data === 'object' ? cloneDocumentData(data) : {};
  const id = String(raw.id || opts.id || `paw-doc-${Date.now().toString(36)}`);
  let stream = String(raw.body?.dataStream ?? '\r\n');
  if (!tableStreamBalanced(stream)) stream = stream.replace(TABLE_TOKEN_RE, '');
  if (!stream.includes('\r')) stream = `${stream.replace(/\n+$/, '')}\r\n`;
  if (!/\n$/.test(stream) && !/\0$/.test(stream)) stream += '\n';
  const paragraphs = Array.isArray(raw.body?.paragraphs) ? raw.body.paragraphs : [];
  const sectionBreaks = Array.isArray(raw.body?.sectionBreaks) ? raw.body.sectionBreaks : [];
  if (!paragraphs.length) {
    const paraAt = Math.max(0, stream.lastIndexOf('\r'));
    paragraphs.push({ startIndex: paraAt >= 0 ? paraAt : 0 });
  }
  if (!sectionBreaks.length) {
    sectionBreaks.push({ startIndex: Math.max(0, stream.length - 1) });
  }
  const style = raw.documentStyle && typeof raw.documentStyle === 'object' ? raw.documentStyle : {};
  const pageSize = style.pageSize && typeof style.pageSize === 'object' ? style.pageSize : {};
  return {
    ...raw,
    id,
    title: raw.title || opts.title || '',
    body: {
      dataStream: stream,
      paragraphs,
      sectionBreaks,
      textRuns: Array.isArray(raw.body?.textRuns) ? raw.body.textRuns : [],
      customBlocks: Array.isArray(raw.body?.customBlocks) ? raw.body.customBlocks : [],
      customRanges: Array.isArray(raw.body?.customRanges) ? raw.body.customRanges : [],
      tables: Array.isArray(raw.body?.tables) ? raw.body.tables : []
    },
    drawings: raw.drawings && typeof raw.drawings === 'object' ? raw.drawings : {},
    drawingsOrder: Array.isArray(raw.drawingsOrder) ? raw.drawingsOrder : [],
    documentStyle: {
      ...style,
      pageSize: {
        width: Number(pageSize.width) > 0 ? Number(pageSize.width) : 595.3,
        height: Number(pageSize.height) > 0 ? Number(pageSize.height) : 841.9
      },
      marginTop: style.marginTop ?? 50,
      marginBottom: style.marginBottom ?? 50,
      marginLeft: style.marginLeft ?? 72,
      marginRight: style.marginRight ?? 72
    }
  };
}

export function extractDocumentSnapshot(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      return isDocumentData(obj) ? obj : null;
    } catch {
      return null;
    }
  }
  const script = new RegExp(
    `<script[^>]*\\bid=["']${DOC_SNAP_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)</script>`,
    'i'
  ).exec(text);
  const blob = script?.[1] || commentSidecar(text);
  if (!blob) return null;
  try {
    const obj = JSON.parse(blob.trim());
    return isDocumentData(obj) ? obj : null;
  } catch {
    return null;
  }
}

function commentSidecar(html) {
  const m = /<!--\s*paw-document\s*([\s\S]*?)-->/i.exec(String(html || ''));
  return m?.[1] || '';
}

export function injectDocumentSnapshot(html, data) {
  if (!isDocumentData(data)) return String(html || '');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="${DOC_SNAP_SCRIPT_ID}">${json}</script>`;
  const src = String(html || '');
  if (new RegExp(`id=["']${DOC_SNAP_SCRIPT_ID}["']`, 'i').test(src)) {
    return src.replace(
      new RegExp(`<script[^>]*\\bid=["']${DOC_SNAP_SCRIPT_ID}["'][^>]*>[\\s\\S]*?</script>`, 'i'),
      tag
    );
  }
  if (/<\/body>/i.test(src)) return src.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${src}\n${tag}\n`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function drawingSource(d) {
  if (!d || typeof d !== 'object') return '';
  return String(d.source || d.src || d.url || d.imageUrl || '').trim();
}

function headingTag(named) {
  const n = Number(named);
  if (n === TITLE || n === HEADING_1) return 'h1';
  if (n === HEADING_2) return 'h2';
  if (n === HEADING_3) return 'h3';
  if (n === HEADING_4) return 'h4';
  if (n === HEADING_5) return 'h5';
  return 'p';
}

function isOn(v) {
  return v === TRUE || v === true || v === 1;
}

function applyRuns(text, start, runs, ranges) {
  const chars = String(text);
  if (!chars.length) return '';
  const marks = Array.from({ length: chars.length }, () => ({ bl: false, it: false, href: '' }));
  for (const run of runs) {
    const st = Number(run.st);
    const ed = Number(run.ed);
    if (!Number.isFinite(st) || !Number.isFinite(ed)) continue;
    const ts = run.ts || {};
    for (let i = st; i < ed; i++) {
      const local = i - start;
      if (local < 0 || local >= marks.length) continue;
      if (isOn(ts.bl)) marks[local].bl = true;
      if (isOn(ts.it)) marks[local].it = true;
    }
  }
  for (const rg of ranges) {
    if (Number(rg.rangeType) !== HYPERLINK && rg.rangeType !== 'HYPERLINK') continue;
    const href = String(rg.properties?.url || rg.url || '').trim();
    if (!href || /^\s*javascript:/i.test(href)) continue;
    const st = Number(rg.startIndex ?? rg.st);
    const ed = Number(rg.endIndex ?? rg.ed);
    for (let i = st; i < ed; i++) {
      const local = i - start;
      if (local < 0 || local >= marks.length) continue;
      marks[local].href = href;
    }
  }
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const m = marks[i];
    let j = i + 1;
    while (j < chars.length && marks[j].bl === m.bl && marks[j].it === m.it && marks[j].href === m.href) j += 1;
    let piece = escapeHtml(chars.slice(i, j));
    if (m.bl) piece = `<strong>${piece}</strong>`;
    if (m.it) piece = `<em>${piece}</em>`;
    if (m.href) piece = `<a href="${escapeAttr(m.href)}">${piece}</a>`;
    out += piece;
    i = j;
  }
  return out;
}

/**
 * Browser-openable HTML from IDocumentData. Lists / headings / http images stay as structure.
 */
export function univerDataToExportHtml(data, extra = {}) {
  const stream = String(data?.body?.dataStream || '');
  const paras = Array.isArray(data?.body?.paragraphs) ? data.body.paragraphs : [];
  const custom = Array.isArray(data?.body?.customBlocks) ? data.body.customBlocks : [];
  const runs = Array.isArray(data?.body?.textRuns) ? data.body.textRuns : [];
  const ranges = Array.isArray(data?.body?.customRanges) ? data.body.customRanges : [];
  const drawings = data?.drawings && typeof data.drawings === 'object' ? data.drawings : {};
  const customAt = new Map(custom.map((c) => [Number(c.startIndex), c]));
  const title = escapeHtml(extra.title || data?.title || 'Document');
  const parts = [];
  let listKind = '';
  const closeList = () => {
    if (listKind) {
      parts.push(listKind === 'ol' ? '</ol>' : '</ul>');
      listKind = '';
    }
  };
  let prev = 0;
  for (let i = 0; i < paras.length; i++) {
    const end = Number(paras[i].startIndex);
    if (!Number.isFinite(end) || end < prev) continue;
    const cb = customAt.get(prev);
    if (cb && drawings[cb.blockId]) {
      closeList();
      const src = drawingSource(drawings[cb.blockId]);
      const alt = escapeAttr(drawings[cb.blockId].title || '');
      if (src) {
        parts.push(
          `<p data-browserbot-block-type="img"><img src="${escapeAttr(src)}" alt="${alt}" /></p>`
        );
      }
      prev = end + 1;
      continue;
    }
    const raw = stream.slice(prev, end);
    prev = end + 1;
    if (raw === '' && !parts.length) continue;
    const bullet = paras[i]?.bullet;
    const tag = headingTag(paras[i]?.paragraphStyle?.namedStyleType);
    const inner = applyRuns(raw, end - raw.length, runs, ranges) || escapeHtml(raw);
    if (bullet) {
      const kind = bullet.listType === 'ol' ? 'ol' : 'ul';
      if (listKind !== kind) {
        closeList();
        parts.push(kind === 'ol' ? '<ol>' : '<ul>');
        listKind = kind;
      }
      parts.push(`<li>${inner}</li>`);
    } else {
      closeList();
      parts.push(`<${tag}>${inner}</${tag}>`);
    }
  }
  closeList();
  const body = parts.join('\n') || '<p></p>';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-browserbot-preview="univer-doc">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;line-height:1.55;color:#1c1915;max-width:42rem;margin:24px auto;padding:0 16px}h1{font-size:1.6rem}img{max-width:100%;height:auto}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function htmlForDocumentExport(data, extra = {}) {
  return injectDocumentSnapshot(univerDataToExportHtml(data, extra), data);
}
