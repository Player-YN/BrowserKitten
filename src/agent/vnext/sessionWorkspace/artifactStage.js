/**
 * Host-only artifact stage: classify a 交付物 selection and seed plates.
 * No model, no I/O, no save. Preview UI decides gallery vs plates from `mode`.
 */

import { parseCsv } from '../../dataTools/structuredData.js';
import { parseOfficeMarkdown } from '../../../markdown/officeMarkdown.js';
import { classifyOpenArtifact, isUtf8OpenKind } from './openClassify.js';
import {
  parseBox,
  serializePlateSection,
  decodePlateNotes
} from './htmlApply.js';

export function isImageArtifact(item = {}) {
  const cls = classifyOpenArtifact(item);
  if (cls.canvas === 'gallery') return true;
  if (item.bytes?.byteLength && ['zip', 'pdf', 'xlsx', 'docx', 'pptx', 'binary'].includes(cls.kind)) {
    return false;
  }
  const mime = String(item.mimeType || item.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = String(item.name || item.artifact?.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name);
}

export function isMarkedPreviewHtml(html) {
  const s = String(html || '');
  return (
    /data-browserbot-preview\s*=\s*["']blocks["']/i.test(s) ||
    /name=["']browserbot-preview["'][^>]*content=["']blocks["']/i.test(s) ||
    /content=["']blocks["'][^>]*name=["']browserbot-preview["']/i.test(s)
  );
}

export function extractMarkedHtmlMeta(html) {
  const s = String(html || '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || ['', ''])[1]
    .replace(/<[^>]+>/g, '')
    .trim();
  const styles = [...s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n');
  const langMatch = /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(s);
  const kindMatch = /data-browserbot-kind\s*=\s*["']([^"']+)["']/i.exec(s);
  let kind = kindMatch?.[1] || '';
  if (!kind && /--paw-slide-w\s*:/i.test(styles)) kind = 'deck';
  if (!kind && /--paw-poster-w\s*:/i.test(styles)) kind = 'poster';
  return { title, styles, lang: langMatch?.[1] || 'zh-CN', kind };
}

/**
 * @param {Array<object>} items
 * @returns {{ mode: 'gallery'|'plates', count: number }}
 */
export function classifyArtifactSelection(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length > 0 && list.every(isImageArtifact)) {
    return { mode: 'gallery', count: list.length };
  }
  return { mode: 'plates', count: list.length };
}

function decodeText(item) {
  const cls = classifyOpenArtifact(item);
  if (!isUtf8OpenKind(cls.kind)) return '';
  let raw = '';
  if (item?.text != null && String(item.text).length) raw = String(item.text);
  else {
    const bytes = item?.bytes;
    if (bytes && bytes.byteLength) {
      try {
        raw = new TextDecoder().decode(bytes);
      } catch {
        raw = '';
      }
    }
  }
  return raw.replace(/^\uFEFF/, '');
}

function nextPlateId(i) {
  return `plt_${i}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripDangerousHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '');
}

export function splitMarkedHtmlPlates(html) {
  const s = String(html || '');
  const plates = [];
  const re = /<section\b[^>]*\bdata-browserbot-block\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m;
  let i = 0;
  while ((m = re.exec(s))) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    const idMatch = /data-browserbot-block-id=["']([^"']+)["']/i.exec(open);
    const inner = m[1] || '';
    const frameMatch = /data-paw-frame=["']([^"']+)["']/i.exec(open);
    const boxMatch = /data-frame-box=["']([^"']+)["']/i.exec(open);
    const nameMatch = /data-frame-name=["']([^"']+)["']/i.exec(open);
    const notesMatch = /data-paw-notes=["']([^"']*)["']/i.exec(open);
    plates.push({
      id: idMatch?.[1] || nextPlateId(i++),
      kind: 'html',
      html: inner.trim(),
      title: headingFromHtml(inner),
      text: textFromHtml(inner),
      frame: frameMatch?.[1] || idMatch?.[1] || '',
      frameBox: parseBox(boxMatch?.[1]),
      frameName: nameMatch?.[1] || '',
      notes: decodePlateNotes(notesMatch?.[1] || '')
    });
  }
  return plates;
}

function headingFromHtml(html) {
  const m = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return m ? textFromHtml(m[1]).trim() : '';
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function csvToTable(text) {
  return parseCsv(text, { maxRows: 2000, maxCols: 80 });
}

function tableToHtml(rows) {
  if (!rows.length) return '<p class="pw-table-empty">(empty table)</p>';
  const header = rows[0] || [];
  const bodyRows = rows.slice(1);
  const th = header
    .map((c) => `<th title="${escapeHtml(c)}">${escapeHtml(c)}</th>`)
    .join('');
  const body = bodyRows
    .map((r) => {
      const cells = header.map((_, i) => {
        const c = r[i] == null ? '' : String(r[i]);
        return `<td title="${escapeHtml(c)}">${escapeHtml(c)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<div class="pw-table-wrap"><table class="pw-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function mdToHtml(text) {
  return parseOfficeMarkdown(text) || '<p></p>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bytesToDataUrl(bytes, mime) {
  if (!bytes || !bytes.byteLength) return '';
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return `data:${mime || 'application/octet-stream'};base64,${b64}`;
}

function imageMimeOf(item) {
  const name = String(item.name || item.artifact?.name || '').toLowerCase();
  const mime = String(item.mimeType || item.mime || '').split(';')[0].trim().toLowerCase();
  const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(0);
  if (name.endsWith('.svg') || mime.includes('svg')) return 'image/svg+xml';
  if (mime.startsWith('image/')) return mime;
  if (bytes.byteLength) {
    const head = new TextDecoder().decode(bytes.slice(0, 240)).trim();
    if (/^\s*(<\?xml[\s\S]{0,200})?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  }
  return mime || 'image/png';
}

function imagePlate(item, i) {
  const name = String(item.name || item.artifact?.name || `image-${i}`);
  const mime = imageMimeOf(item);
  const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(0);
  const src = bytesToDataUrl(bytes, mime);
  return {
    id: nextPlateId(i),
    kind: 'image',
    html: `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" /><figcaption>${escapeHtml(name)}</figcaption></figure>`,
    title: name,
    imageBytes: bytes,
    imageMime: mime,
    sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
  };
}

function fileCardPlate(item, i) {
  const name = String(item.name || item.artifact?.name || 'file');
  const mime = String(item.mimeType || 'application/octet-stream');
  const size = Number(item.bytes?.byteLength || item.size || 0);
  return {
    id: nextPlateId(i),
    kind: 'file',
    html: `<section class="pw-file-card"><h2>${escapeHtml(name)}</h2><p>${escapeHtml(mime)} · ${size} bytes</p></section>`,
    title: name,
    text: `${name}\n${mime}\n${size} bytes`,
    fileName: name,
    fileMime: mime,
    sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
  };
}

/**
 * Seed sibling plates from artifact records + bytes. Pure: does not save.
 * @param {Array<object>} items
 * @returns {{ mode: 'gallery'|'plates', plates: Array<object> }}
 */
export function seedPlatesFromArtifacts(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const classified = classifyArtifactSelection(list);
  if (classified.mode === 'gallery') {
    return {
      mode: 'gallery',
      plates: list.map((it, i) => imagePlate(it, i)),
      styles: '',
      title: '',
      lang: 'zh-CN'
    };
  }
  /** @type {Array<object>} */
  const plates = [];
  let styles = '';
  let title = '';
  let lang = 'zh-CN';
  let kind = '';
  list.forEach((item, i) => {
    const name = String(item.name || item.artifact?.name || '');
    const mime = String(item.mimeType || '').toLowerCase();
    if (isImageArtifact(item)) {
      plates.push(imagePlate(item, i));
      return;
    }
    const cls = classifyOpenArtifact(item);
    if (!isUtf8OpenKind(cls.kind)) {
      plates.push(fileCardPlate(item, i));
      return;
    }
    const text = decodeText(item);
    if (/\.html?$/i.test(name) || mime.includes('html')) {
      if (isMarkedPreviewHtml(text)) {
        const meta = extractMarkedHtmlMeta(text);
        if (meta.styles) styles = styles ? `${styles}\n${meta.styles}` : meta.styles;
        if (meta.title && !title) title = meta.title;
        if (meta.lang) lang = meta.lang;
        if (meta.kind && !kind) kind = meta.kind;
        const split = splitMarkedHtmlPlates(text);
        if (split.length) {
          for (const p of split) {
            p.sourceArtifactId = item.artifactId || item.artifact?.artifactId || '';
            plates.push(p);
          }
          return;
        }
      }
      plates.push({
        id: nextPlateId(i),
        kind: 'html',
        html: stripDangerousHtml(text) || '<p></p>',
        title: headingFromHtml(text) || name,
        text: textFromHtml(text),
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    if (/\.(txt|log)$/i.test(name)) {
      plates.push({
        id: nextPlateId(i),
        kind: 'html',
        html: `<pre class="md-pre">${escapeHtml(text)}</pre>`,
        title: name,
        text,
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    if (/\.json$/i.test(name) || mime.includes('json')) {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
      plates.push({
        id: nextPlateId(i),
        kind: 'html',
        html: `<pre class="md-json"><code>${escapeHtml(pretty)}</code></pre>`,
        title: name,
        text: pretty,
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    if (/\.md$/i.test(name) || mime.includes('markdown')) {
      const html = mdToHtml(text);
      plates.push({
        id: nextPlateId(i),
        kind: 'html',
        html,
        title: headingFromHtml(html) || name,
        text: textFromHtml(html),
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    if (/\.tsv$/i.test(name) || mime.includes('tab-separated') || mime.includes('tsv')) {
      const table = parseCsv(text, { delimiter: '\t', maxRows: 2000, maxCols: 80 });
      plates.push({
        id: nextPlateId(i),
        kind: 'table',
        html: tableToHtml(table),
        title: name,
        table,
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    if (/\.csv$/i.test(name) || mime.includes('csv')) {
      const table = csvToTable(text);
      plates.push({
        id: nextPlateId(i),
        kind: 'table',
        html: tableToHtml(table),
        title: name,
        table,
        sourceArtifactId: item.artifactId || item.artifact?.artifactId || ''
      });
      return;
    }
    plates.push(fileCardPlate(item, i));
  });
  return { mode: 'plates', plates, styles, title, lang, kind };
}

/**
 * @param {Array<{id?: string, html?: string}>} plates
 * @param {{ title?: string, lang?: string }} [meta]
 */
export function platesToMarkedHtml(plates, meta = {}) {
  const title = escapeHtml(meta.title || 'Preview');
  const lang = escapeHtml(meta.lang || 'zh-CN');
  const kind = String(meta.kind || '').trim();
  const parts = (plates || [])
    .map((b) =>
      serializePlateSection(
        {
          id: b.id || nextPlateId(0),
          html: b.html || '',
          frame: b.frame || b.id,
          frameBox: b.frameBox,
          frameName: b.frameName || b.name || b.title,
          notes: b.notes || ''
        },
        { kind }
      )
    )
    .join('\n');
  const styleInner = String(meta.styles || '').trim()
    || 'body{font-family:system-ui,sans-serif;line-height:1.55;color:#1c1915}@page{size:auto;margin:12mm}';
  const kindAttr = kind ? ` data-browserbot-kind="${escapeHtml(kind)}"` : '';
  return `<!DOCTYPE html>
<html lang="${lang}" data-browserbot-preview="blocks"${kindAttr}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="browserbot-preview" content="blocks" />
  <title>${title}</title>
  <style>${styleInner}</style>
</head>
<body>
${parts}
</body>
</html>
`;
}
