/**
 * Mechanical plate → file export. Every format always produces bytes.
 * Images/tables flatten; never refuse. Media binaries ride in a zip when
 * the target format cannot hold pixels (md/csv).
 */

import { platesToMarkedHtml } from './artifactStage.js';
import { platesToPptxBytes, buildZipStore, PPTX_CONTENT_TYPE } from './pptxExport.js';
import { htmlRichFlow, imagePixelSize, listHtmlImages, themeFromCss } from './htmlMedia.js';
import { detectHtmlKind, platesToPrintHtml } from './printHtml.js';

export const EXPORT_FORMATS = [
  { id: 'pptx', label: 'PPTX' },
  { id: 'pdf', label: 'PDF' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'csv', label: 'CSV' },
  { id: 'html', label: 'HTML' },
  { id: 'docx', label: 'Document' }
];

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function enc(s) {
  return new TextEncoder().encode(String(s || ''));
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function headingFromHtml(html) {
  const m = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return m ? textFromHtml(m[1]).trim() : '';
}

function safeStem(title) {
  const s = String(title || 'export')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.slice(0, 60) || 'export';
}

function parseDataUrl(url) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(url || '').trim());
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2].replace(/\s/g, '');
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('svg')) return 'svg';
  return 'png';
}

function imageFromPlate(p) {
  if (p?.imageBytes && p.imageBytes.byteLength) {
    return { bytes: p.imageBytes, mime: p.imageMime || 'image/png', src: p.src || '' };
  }
  const src = /src="(data:image\/[^"]+)"/i.exec(String(p?.html || ''))?.[1];
  if (src) return parseDataUrl(src);
  return null;
}

function imagesForPlate(p) {
  const list = [];
  const push = (im) => {
    if (!im?.bytes?.byteLength) return;
    list.push(im);
  };
  const inline = Array.isArray(p?.inlineImages)
    ? p.inlineImages.filter((im) => im?.bytes?.byteLength)
    : [];
  if (inline.length) {
    for (const im of inline) push(im);
    return list;
  }
  for (const im of listHtmlImages(p?.html)) {
    const parsed = parseDataUrl(im.src);
    if (parsed) push({ ...parsed, src: im.src, alt: im.alt });
  }
  if (!list.length) push(imageFromPlate(p));
  return list;
}

function plateKind(p) {
  if (p?.kind) return p.kind;
  if (imageFromPlate(p)) return 'image';
  if (Array.isArray(p?.table) && p.table.length) return 'table';
  if (p?.fileName) return 'file';
  return 'html';
}

/**
 * Attach media/N.ext paths onto plates; collect binary files.
 * @param {Array<object>} plates
 */
export function collectPlateMedia(plates) {
  const media = [];
  const out = (plates || []).map((p, i) => {
    const imgs = imagesForPlate(p);
    if (!imgs.length) return { ...p, inlineImages: [], _file: '' };
    imgs.forEach((img, j) => {
      const ext = extForMime(img.mime);
      const name = `media/${i + 1}_${j + 1}.${ext}`;
      media.push({ name, data: img.bytes, mime: img.mime });
    });
    return {
      ...p,
      inlineImages: imgs,
      imageBytes: imgs[0].bytes,
      imageMime: imgs[0].mime,
      _file: media[media.length - imgs.length]?.name || ''
    };
  });
  return { plates: out, media };
}

function csvEscape(s) {
  const t = String(s ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function platesToCsv(plates) {
  const lines = ['order,kind,title,text,file'];
  (plates || []).forEach((p, i) => {
    const kind = plateKind(p);
    const title = p.title || headingFromHtml(p.html) || '';
    const text = p.text || textFromHtml(p.html) || '';
    lines.push(
      [i + 1, kind, title, text, p._file || ''].map(csvEscape).join(',')
    );
    if (kind === 'table' && Array.isArray(p.table)) {
      p.table.forEach((row, ri) => {
        lines.push(
          [i + 1, 'table_row', title, (row || []).join('|'), String(ri)].map(csvEscape).join(',')
        );
      });
    }
  });
  return lines.join('\n') + '\n';
}

function platesToMarkdown(plates, title) {
  const parts = [`# ${title || 'Export'}`, ''];
  for (const p of plates || []) {
    const kind = plateKind(p);
    const h = p.title || headingFromHtml(p.html);
    if (kind === 'image' && p._file) {
      parts.push(`![${h || p._file}](${p._file})`, '');
      continue;
    }
    if (kind === 'table' && Array.isArray(p.table) && p.table.length) {
      if (h) parts.push(`## ${h}`, '');
      const rows = p.table;
      const head = rows[0] || [];
      parts.push(`| ${head.join(' | ')} |`);
      parts.push(`| ${head.map(() => '---').join(' | ')} |`);
      for (const row of rows.slice(1)) parts.push(`| ${(row || []).join(' | ')} |`);
      parts.push('');
      continue;
    }
    if (h) parts.push(`## ${h}`, '');
    const body = (p.text || textFromHtml(String(p.html || '').replace(/<h[12][^>]*>[\s\S]*?<\/h[12]>/i, ''))).trim();
    if (body) parts.push(body, '');
    if (p._file) parts.push(`[${p.fileName || p._file}](${p._file})`, '');
  }
  return parts.join('\n');
}

function maybeZip(stem, textName, textBody, media) {
  if (!media.length) {
    return {
      filename: textName,
      mime: textName.endsWith('.csv') ? 'text/csv' : 'text/markdown',
      bytes: enc(textBody)
    };
  }
  const files = [{ name: textName, data: enc(textBody) }, ...media.map((m) => ({ name: m.name, data: m.data }))];
  return {
    filename: `${stem}.zip`,
    mime: 'application/zip',
    bytes: buildZipStore(files)
  };
}

function pngSize(bytes) {
  return imagePixelSize(bytes);
}

function wText(text, style) {
  const t = xmlEscape(text || ' ');
  const pr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pr}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
}

const URL_TOKEN = /https?:\/\/[^\s<>"'）)\]]+/g;

function wHyperlinkRun(relId, url) {
  return `<w:hyperlink r:id="${relId}" w:history="1"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${xmlEscape(url)}</w:t></w:r></w:hyperlink>`;
}

function wParaWithUrls(text, style, addHyperRel) {
  const s = String(text || '');
  const parts = [];
  let last = 0;
  URL_TOKEN.lastIndex = 0;
  let m;
  while ((m = URL_TOKEN.exec(s))) {
    if (m.index > last) parts.push({ type: 't', text: s.slice(last, m.index) });
    parts.push({ type: 'url', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ type: 't', text: s.slice(last) });
  if (!parts.some((p) => p.type === 'url')) return wText(s, style);
  const pr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  const runs = parts
    .map((p) => {
      if (p.type === 'url') return wHyperlinkRun(addHyperRel(p.text), p.text);
      return `<w:r><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r>`;
    })
    .join('');
  return `<w:p>${pr}${runs}</w:p>`;
}

function wTable(rows) {
  const table = Array.isArray(rows) && rows.length ? rows : [['']];
  const cols = Math.max(...table.map((r) => r.length), 1);
  const grid = Array.from(
    { length: cols },
    () => `<w:gridCol w="2400"/>`
  ).join('');
  const trs = table
    .map(
      (row) =>
        `<w:tr>${Array.from({ length: cols }, (_, c) => {
          const val = xmlEscape(row[c] == null ? '' : String(row[c]));
          return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${val}</w:t></w:r></w:p></w:tc>`;
        }).join('')}</w:tr>`
    )
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`;
}

function wImage(relId, cx, cy, name = 'Picture') {
  const docId = relId.replace(/\D/g, '') || '1';
  return `<w:p><w:r>
<w:drawing>
  <wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="${docId}" name="${xmlEscape(name)}"/>
    <wp:cNvGraphicFramePr>
      <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
    </wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr>
            <pic:cNvPr id="0" name="${xmlEscape(name)}"/>
            <pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr>
          </pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
</w:r></w:p>`;
}

function platesToDocxBytes(plates, opts = {}) {
  const title = opts.title || 'Browser Kitten';
  const { plates: enriched, media } = collectPlateMedia(plates);
  const body = [];
  const rels = [
    {
      id: 'rId1',
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      target: 'styles.xml'
    }
  ];
  let rid = 2;
  const mediaFiles = [];
  const addHyperRel = (url) => {
    const id = `rId${rid++}`;
    rels.push({
      id,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
      target: String(url || ''),
      mode: 'External'
    });
    return id;
  };
  body.push(wParaWithUrls(title, 'Title', addHyperRel));
  let imgSeq = 1;
  const emitImage = (img) => {
    if (!img?.bytes?.byteLength) return;
    const ext = extForMime(img.mime);
    const file = `word/media/image${imgSeq}.${ext}`;
    mediaFiles.push({ name: file, data: img.bytes });
    const id = `rId${rid++}`;
    rels.push({
      id,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      target: `media/image${imgSeq}.${ext}`
    });
    imgSeq += 1;
    const { w, h: ih } = pngSize(img.bytes);
    const max = 5486400;
    const ratio = Math.min(max / Math.max(w * 9525, 1), max / Math.max(ih * 9525, 1), 1);
    const cx = Math.max(914400, Math.floor(w * 9525 * ratio));
    const cy = Math.max(914400, Math.floor(ih * 9525 * ratio));
    body.push(wImage(id, cx, cy, img.alt || `image${imgSeq}`));
  };
  enriched.forEach((p) => {
    const kind = plateKind(p);
    const imgs = imagesForPlate(p);
    const bySrc = new Map(imgs.map((im) => [String(im.src || ''), im]));
    const unused = imgs.slice();
    const takeImg = (src) => {
      if (src && bySrc.has(src)) {
        const hit = bySrc.get(src);
        const idx = unused.indexOf(hit);
        if (idx >= 0) unused.splice(idx, 1);
        return hit;
      }
      return unused.shift() || null;
    };
    if (kind === 'table' && Array.isArray(p.table)) {
      const h = p.title || headingFromHtml(p.html);
      if (h) body.push(wParaWithUrls(h, 'Heading1', addHyperRel));
      body.push(wTable(p.table));
      return;
    }
    const flow = htmlRichFlow(p.html);
    if (!flow.length) {
      const h = p.title || headingFromHtml(p.html);
      if (h) body.push(wParaWithUrls(h, 'Heading1', addHyperRel));
      for (const img of imgs) emitImage(img);
      const rest = (p.text || textFromHtml(String(p.html || ''))).trim();
      if (rest) {
        for (const line of rest.split('\n')) {
          if (line.trim()) body.push(wParaWithUrls(line.trim(), '', addHyperRel));
        }
      }
      return;
    }
    for (const node of flow) {
      if (node.type === 'h' && node.text) {
        const style = node.level <= 1 ? 'Title' : node.level === 2 ? 'Heading1' : 'Heading2';
        body.push(wParaWithUrls(node.text, style, addHyperRel));
      } else if (node.type === 'li' && node.text) {
        body.push(wParaWithUrls(`• ${node.text}`, '', addHyperRel));
      } else if (node.type === 'p' && node.text) {
        body.push(wParaWithUrls(node.text, '', addHyperRel));
      } else if (node.type === 'img') {
        emitImage(takeImg(node.src));
      }
    }
    for (const img of unused) emitImage(img);
  });
  body.push(
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
  );

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels
  .map(
    (r) =>
      `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlEscape(r.target)}"${r.mode ? ` TargetMode="${r.mode}"` : ''}/>`
  )
  .join('')}
</Relationships>`;

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 wp14">
<w:body>
${body.join('\n')}
</w:body>
</w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Default Extension="webp" ContentType="image/webp"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const now = new Date().toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(title)}</dc:title><dc:creator>Browser Kitten</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
</cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Browser Kitten</Application>
</Properties>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: doc },
    { name: 'word/_rels/document.xml.rels', data: relsXml },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    ...mediaFiles
  ];
  void media;
  return buildZipStore(files);
}

/**
 * @param {Array<object>} plates
 * @param {string} format html|markdown|csv|pptx|docx
 * @param {{ title?: string }} [opts]
 * @returns {{ filename: string, mime: string, bytes: Uint8Array }}
 */
export function exportPlates(plates, format, opts = {}) {
  const title = opts.title || 'export';
  const stem = safeStem(title);
  const list = Array.isArray(plates) && plates.length ? plates : [{ html: '<p></p>', title }];
  const fmt = String(format || '').toLowerCase();
  const { plates: enriched, media } = collectPlateMedia(list);

  if (fmt === 'pptx') {
    return {
      filename: `${stem}.pptx`,
      mime: PPTX_CONTENT_TYPE,
      bytes: platesToPptxBytes(enriched, { title, theme: themeFromCss(opts.styles || '') })
    };
  }
  if (fmt === 'docx' || fmt === 'document') {
    return {
      filename: `${stem}.docx`,
      mime: DOCX_MIME,
      bytes: platesToDocxBytes(enriched, { title })
    };
  }
  if (fmt === 'html') {
    const html = platesToMarkedHtml(
      enriched.map((p) => ({ id: p.id, html: p.html })),
      { title, styles: opts.styles || '', kind: opts.kind || detectHtmlKind('', opts.styles || '') }
    );
    return { filename: `${stem}.html`, mime: 'text/html;charset=utf-8', bytes: enc(html) };
  }
  if (fmt === 'pdf' || fmt === 'print') {
    const kind = opts.kind || detectHtmlKind('', opts.styles || '');
    const html = platesToPrintHtml(enriched, {
      title,
      styles: opts.styles || '',
      kind,
      lang: opts.lang || 'zh-CN'
    });
    return {
      filename: `${stem}.print.html`,
      mime: 'text/html;charset=utf-8',
      bytes: enc(html)
    };
  }
  if (fmt === 'csv') {
    return maybeZip(stem, `${stem}.csv`, platesToCsv(enriched), media);
  }
  if (fmt === 'markdown' || fmt === 'md') {
    return maybeZip(stem, `${stem}.md`, platesToMarkdown(enriched, title), media);
  }
  throw new Error(`unknown export format: ${format}`);
}

export { platesToDocxBytes, DOCX_MIME };
