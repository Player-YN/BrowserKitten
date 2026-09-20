/**
 * BrowserBot document compiler — single atomic renderer used by render_document.
 * Product profile **A′**: extension-only; no end-user Pandoc/npm.
 * PDF = print-ready HTML → system print → Save as PDF.
 */

import {
  createTextArtifact,
  createTableArtifact,
  createBinaryArtifact,
  packZipArtifact
} from './artifacts.js';
import {
  RENDER_FORMATS,
  PRODUCT_FORMATS,
  FORMAT_ENGINE_MATRIX,
  resolveEngine,
  getRenderCapabilities
} from './render/engine.js';

/** @typedef {import('./draftStore.js').DraftBlock} DraftBlock */
/** @typedef {import('./draftStore.js').BrowserBotDraft} BrowserBotDraft */

export {
  RENDER_FORMATS,
  PRODUCT_FORMATS,
  FORMAT_ENGINE_MATRIX,
  resolveEngine,
  getRenderCapabilities
};

/** @deprecated A′ does not use pandoc in product path */
export function isPandocReady() {
  return false;
}
export function onPandocProgress() {
  return () => {};
}
export async function ensurePandoc() {
  return {
    ok: false,
    code: 'ENGINE_NOT_IN_PRODUCT',
    message: 'Pandoc is not shipped in extension-only product A′'
  };
}
export function getPandocLoadState() {
  return { status: 'disabled_a_prime' };
}
export function setPandocConvertForTests() {}
export function resetPandocLoaderForTests() {}

/**
 * @param {DraftBlock[]} blocks
 * @returns {string}
 */
export function draftBlocksToMarkdown(blocks) {
  const lines = [];
  for (const b of blocks || []) {
    if (!b || b.type === 'slot') continue;
    if (b.type === 'heading') {
      lines.push(`## ${b.text || ''}`);
      lines.push('');
    } else if (b.type === 'paragraph') {
      lines.push(b.text || '');
      if (b.href) lines.push(`[link](${b.href})`);
      lines.push('');
    } else if (b.type === 'image') {
      const alt = b.alt || b.text || 'image';
      if (b.src) lines.push(`![${alt}](${b.src})`);
      else lines.push(`*[image: ${alt}]*`);
      lines.push('');
    } else if (b.type === 'record' && b.fields) {
      for (const [k, v] of Object.entries(b.fields)) {
        lines.push(`- **${k}**: ${v}`);
      }
      lines.push('');
    } else if (b.type === 'table' && b.columns && b.rows) {
      lines.push(`| ${b.columns.join(' | ')} |`);
      lines.push(`| ${b.columns.map(() => '---').join(' | ')} |`);
      for (const row of b.rows) {
        lines.push(`| ${b.columns.map((c) => String(row[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
      }
      lines.push('');
    } else if (b.type === 'divider') {
      lines.push('---');
      lines.push('');
    }
  }
  return lines.join('\n').trim() + '\n';
}

/**
 * @param {DraftBlock[]} blocks
 * @returns {string}
 */
export function draftBlocksToPlainText(blocks) {
  return draftBlocksToMarkdown(blocks)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

/**
 * Extract first table from blocks for CSV.
 * @param {DraftBlock[]} blocks
 * @returns {{ columns: string[], rows: Array<Record<string, string>> }|null}
 */
export function extractTableFromBlocks(blocks) {
  for (const b of blocks || []) {
    if (b?.type === 'table' && Array.isArray(b.columns) && b.columns.length && Array.isArray(b.rows)) {
      return { columns: b.columns, rows: b.rows };
    }
  }
  // Synthesize from records
  const records = (blocks || []).filter((b) => b?.type === 'record' && b.fields);
  if (records.length) {
    const colSet = new Set();
    for (const r of records) {
      Object.keys(r.fields || {}).forEach((k) => colSet.add(k));
    }
    const columns = [...colSet];
    const rows = records.map((r) => {
      /** @type {Record<string, string>} */
      const o = {};
      for (const c of columns) o[c] = String(r.fields?.[c] ?? '');
      return o;
    });
    return { columns, rows };
  }
  // heading+image pairs → simple table
  const pairs = [];
  let pendingTitle = '';
  for (const b of blocks || []) {
    if (b?.type === 'heading' || (b?.type === 'paragraph' && (b.text || '').length < 80)) {
      pendingTitle = b.text || '';
    } else if (b?.type === 'image') {
      pairs.push({
        title: pendingTitle || b.alt || '',
        image: b.src || '',
        link: b.href || ''
      });
      pendingTitle = '';
    }
  }
  if (pairs.length) {
    return {
      columns: ['title', 'image', 'link'],
      rows: pairs
    };
  }
  return null;
}

/**
 * Preview HTML for draft tab (includes insert slots).
 * @param {BrowserBotDraft|object} draft
 * @returns {string}
 */
export function draftToPreviewHtml(draft) {
  const title = escapeHtml(draft?.title || 'Browser Kitten Draft');
  const version = draft?.version ?? 1;
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks : [];
  const body = blocks
    .map((b) => {
      if (!b) return '';
      const id = escapeHtml(b.id || '');
      if (b.type === 'slot') {
        return `<div class="pw-block pw-slot browserbot-draft-slot" data-block-id="${id}" data-slot="1" tabindex="0">
          <span class="pw-slot-plus">+</span>
          <span>${escapeHtml(b.text || '添加内容 / Insert')}</span>
        </div>`;
      }
      if (b.type === 'heading') {
        return `<h2 class="pw-block" data-block-id="${id}">${escapeHtml(b.text || '')}</h2>`;
      }
      if (b.type === 'paragraph') {
        return `<p class="pw-block" data-block-id="${id}">${escapeHtml(b.text || '')}</p>`;
      }
      if (b.type === 'image') {
        const src = b.src ? escapeAttr(b.src) : '';
        const img = src
          ? `<img src="${src}" alt="${escapeAttr(b.alt || '')}" />`
          : `<div class="pw-img-missing">${escapeHtml(b.alt || 'image')}</div>`;
        return `<figure class="pw-block pw-figure" data-block-id="${id}">${img}<figcaption>${escapeHtml(b.alt || b.text || '')}</figcaption></figure>`;
      }
      if (b.type === 'table' && b.columns) {
        const head = b.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
        const rows = (b.rows || [])
          .slice(0, 100)
          .map(
            (r) =>
              `<tr>${b.columns.map((c) => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`
          )
          .join('');
        return `<div class="pw-block pw-table-wrap" data-block-id="${id}"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      if (b.type === 'record' && b.fields) {
        const lis = Object.entries(b.fields)
          .map(([k, v]) => `<li><strong>${escapeHtml(k)}</strong>: ${escapeHtml(v)}</li>`)
          .join('');
        return `<ul class="pw-block pw-record" data-block-id="${id}">${lis}</ul>`;
      }
      if (b.type === 'divider') return `<hr class="pw-block" data-block-id="${id}" />`;
      return '';
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-browserbot-role="draft-preview" data-draft-id="${escapeAttr(draft?.draftId || '')}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · v${version}</title>
  <style>
    :root { font-family: system-ui, "Segoe UI", "PingFang SC", sans-serif; color: #0f172a; }
    body { margin: 0; background: #f1f5f9; }
    .pw-chrome { position: sticky; top: 0; z-index: 10; background: #0f172a; color: #e2e8f0;
      padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; }
    .pw-chrome strong { color: #a5b4fc; }
    .pw-main { max-width: 720px; margin: 20px auto; padding: 24px; background: #fff;
      border-radius: 12px; box-shadow: 0 4px 24px rgba(15,23,42,.08); }
    h2 { margin: 1.2em 0 .4em; font-size: 1.25rem; }
    p { line-height: 1.6; color: #334155; }
    figure { margin: 1em 0; }
    img { max-width: 100%; border-radius: 8px; display: block; }
    figcaption { font-size: 12px; color: #64748b; margin-top: 6px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
    th { background: #f8fafc; }
    .pw-slot { border: 2px dashed #6366f1; border-radius: 10px; padding: 16px; margin: 16px 0;
      color: #4f46e5; display: flex; align-items: center; gap: 10px; cursor: pointer;
      background: #eef2ff; user-select: none; }
    .pw-slot:hover { background: #e0e7ff; }
    .pw-slot-plus { font-size: 22px; font-weight: 700; }
    .pw-block.browserbot-selected, .pw-block.browserbot-scope-preview {
      outline: 3px solid #8b5cf6; outline-offset: 2px;
    }
    .pw-hint { font-size: 11px; color: #94a3b8; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="pw-chrome">
    <div><strong>Browser Kitten 草稿预览</strong> · ${title} · v${version} · 独立标签页 · 自动保存 · 刷新不丢</div>
    <div data-draft-id="${escapeAttr(draft?.draftId || '')}">${escapeHtml(draft?.draftId || '')}</div>
  </div>
  <main class="pw-main" data-browserbot-role="draft-preview">
    ${body}
    <p class="pw-hint">点已有块 → 工具栏编辑/删除/后面插入；点紫色「+」新增。确认下载请在侧栏操作。</p>
  </main>
</body>
</html>`;
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

/**
 * Minimal multi-line text PDF (no external deps).
 * @param {string} text
 * @param {string} [docTitle]
 * @returns {Uint8Array}
 */
export function textToSimplePdf(text, docTitle = 'Browser Kitten') {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(0, 90));
  const maxLinesPerPage = 48;
  const pages = [];
  for (let i = 0; i < lines.length || pages.length === 0; i += maxLinesPerPage) {
    pages.push(lines.slice(i, i + maxLinesPerPage));
    if (i >= lines.length) break;
  }

  /** @type {string[]} */
  const objects = [];
  const add = (s) => {
    objects.push(s);
    return objects.length;
  };

  // 1 catalog placeholder filled later
  add('<< /Type /Catalog /Pages 2 0 R >>');
  // 2 pages tree
  const pageObjIds = [];
  const fontId = 3;
  add(''); // placeholder for pages — index 1 (object 2)

  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  /** @type {number[]} */
  const contentIds = [];
  for (let p = 0; p < pages.length; p++) {
    const contentLines = [
      'BT',
      '/F1 11 Tf',
      '50 780 Td',
      '14 TL',
      `(${pdfEscape(docTitle.slice(0, 60))}) Tj`,
      'T*',
      'T*',
      ...pages[p].map((line) => `(${pdfEscape(line)}) Tj T*`),
      'ET'
    ];
    const stream = contentLines.join('\n');
    const contentId = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
    contentIds.push(contentId);
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    pageObjIds.push(pageId);
  }

  // Fix pages object (index 1)
  objects[1] =
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>`;

  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [enc.encode('%PDF-1.4\n')];
  /** @type {number[]} */
  const offsets = [0];
  let pos = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pos);
    const chunk = enc.encode(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    parts.push(chunk);
    pos += chunk.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function pdfEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // PDF basic fonts: strip non-latin-1 for Helvetica safety
    .replace(/[^\x20-\x7E]/g, '?');
}

/**
 * Minimal PPTX-like HTML deck (downloadable .html slides; real pptx later).
 * @param {DraftBlock[]} blocks
 * @param {string} title
 * @returns {string}
 */
export function draftToSlideHtml(blocks, title) {
  /** @type {string[]} */
  const slides = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    slides.push(buf.join('\n'));
    buf = [];
  };
  for (const b of blocks || []) {
    if (!b || b.type === 'slot') continue;
    if (b.type === 'heading') {
      flush();
      buf.push(`<h1>${escapeHtml(b.text || '')}</h1>`);
    } else if (b.type === 'paragraph') {
      buf.push(`<p>${escapeHtml(b.text || '')}</p>`);
    } else if (b.type === 'image' && b.src) {
      buf.push(`<img src="${escapeAttr(b.src)}" alt="${escapeAttr(b.alt || '')}" style="max-height:50vh"/>`);
    } else if (b.type === 'divider') {
      flush();
    }
  }
  flush();
  if (!slides.length) slides.push(`<h1>${escapeHtml(title || 'Slides')}</h1>`);
  const sections = slides
    .map(
      (s, i) =>
        `<section class="slide" id="s${i}"><div class="inner">${s}</div><div class="num">${i + 1}/${slides.length}</div></section>`
    )
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc}
.slide{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px;box-sizing:border-box;border-bottom:1px solid #334155}
.inner{max-width:900px;width:100%}
h1{font-size:2.2rem;margin:0 0 1rem}
p{font-size:1.2rem;line-height:1.5;color:#cbd5e1}
img{max-width:100%;border-radius:8px}
.num{position:fixed;right:16px;bottom:12px;opacity:.5;font-size:12px}
</style></head><body>${sections}</body></html>`;
}

/**
 * Compile draft to an in-memory artifact (A′ extension-only).
 * Single tool surface: format enum → builtin or builtin_print (pdf). Never new tool names.
 *
 * @param {BrowserBotDraft|object} draft
 * @param {{
 *   format?: string,
 *   runId?: string,
 *   name?: string,
 *   markdown?: string,
 *   engine?: 'auto'|'builtin'|'builtin_print'|'pandoc',
 *   forceBuiltin?: boolean,
 *   forcePandoc?: boolean,
 *   onEngineProgress?: (e: { phase: string, message?: string, error?: string }) => void
 * }} opts
 */
export async function renderDocumentFromDraft(draft, opts = {}) {
  const format = String(opts.format || draft?.targetFormat || 'md').toLowerCase();
  if (!RENDER_FORMATS.includes(format)) {
    return {
      status: 'error',
      code: 'UNSUPPORTED_FORMAT',
      message: `Unsupported format: ${format}. Product A′ formats: ${RENDER_FORMATS.join(', ')}`
    };
  }

  const runId = opts.runId || draft?.runId || 'draft_render';
  const title = draft?.title || opts.name || 'browserbot-document';
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks : [];
  const md =
    typeof opts.markdown === 'string' && opts.markdown.trim()
      ? opts.markdown
      : draftBlocksToMarkdown(blocks);
  /** @type {string[]} */
  const warnings = [];

  const route = resolveEngine(format, {
    engine: opts.engine,
    forceBuiltin: opts.forceBuiltin,
    forcePandoc: opts.forcePandoc
  });

  if (!route.engine) {
    return {
      status: 'error',
      code: route.errorCode || route.code || 'UNSUPPORTED_FORMAT',
      message:
        route.message ||
        route.reason ||
        `Unsupported format: ${format}`,
      format,
      engine: null,
      warnings
    };
  }

  // A′ PDF: print-ready HTML (browser print → Save as PDF)
  if (route.engine === 'builtin_print' || format === 'pdf') {
    const printHtml = draftToPrintHtml({ ...draft, title, blocks });
    const ref = createTextArtifact({
      runId,
      name: `${safeFile(title)}.print.html`,
      content: printHtml,
      mime: 'text/html'
    });
    warnings.push(
      'PDF (A′): open print HTML → system print dialog → Save as PDF. Extension-only, no extra install.'
    );
    return {
      status: 'ok',
      format: 'pdf',
      engine: 'builtin_print',
      delivery: 'browser_print',
      printHtml,
      ...ref,
      warnings
    };
  }

  const builtin = await renderWithBuiltin({
    format,
    draft,
    title,
    blocks,
    md,
    runId,
    warnings
  });
  if (builtin.status === 'ok') {
    return {
      ...builtin,
      engine: 'builtin',
      delivery: route.delivery || 'download'
    };
  }
  return builtin;
}

/**
 * Print-optimized HTML (no preview chrome). Used for PDF via window.print().
 * @param {BrowserBotDraft|object} draft
 * @returns {string}
 */
export function draftToPrintHtml(draft) {
  const title = escapeHtml(draft?.title || 'BrowserBot');
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks : [];
  const body = blocks
    .map((b) => {
      if (!b || b.type === 'slot') return '';
      if (b.type === 'heading') return `<h1>${escapeHtml(b.text || '')}</h1>`;
      if (b.type === 'paragraph') {
        let p = `<p>${escapeHtml(b.text || '')}</p>`;
        if (b.href) p += `<p class="link"><a href="${escapeAttr(b.href)}">${escapeHtml(b.href)}</a></p>`;
        return p;
      }
      if (b.type === 'image') {
        const src = b.src ? escapeAttr(b.src) : '';
        if (!src) return '';
        return `<figure><img src="${src}" alt="${escapeAttr(b.alt || '')}"/><figcaption>${escapeHtml(b.alt || b.text || '')}</figcaption></figure>`;
      }
      if (b.type === 'table' && b.columns) {
        const head = b.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
        const rows = (b.rows || [])
          .map(
            (r) =>
              `<tr>${b.columns.map((c) => `<td>${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`
          )
          .join('');
        return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
      }
      if (b.type === 'record' && b.fields) {
        const lis = Object.entries(b.fields)
          .map(([k, v]) => `<li><strong>${escapeHtml(k)}</strong>: ${escapeHtml(v)}</li>`)
          .join('');
        return `<ul>${lis}</ul>`;
      }
      if (b.type === 'divider') return '<hr/>';
      return '';
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    @page { margin: 16mm; }
    body { font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #0f172a; line-height: 1.5; max-width: 800px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.4rem; margin: 1.2em 0 0.4em; page-break-after: avoid; }
    p { margin: 0.5em 0; }
    img { max-width: 100%; height: auto; }
    figure { margin: 1em 0; page-break-inside: avoid; }
    figcaption { font-size: 0.85rem; color: #64748b; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; page-break-inside: avoid; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
    th { background: #f1f5f9; }
    .no-print { display: none !important; }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <header><h1 style="margin-top:0">${title}</h1></header>
  ${body}
</body>
</html>`;
}

/**
 * Builtin format backends (extension-only A′).
 * @param {{
 *   format: string,
 *   draft: object,
 *   title: string,
 *   blocks: DraftBlock[],
 *   md: string,
 *   runId: string,
 *   warnings: string[]
 * }} ctx
 */
async function renderWithBuiltin(ctx) {
  const { format, draft, title, blocks, md, runId, warnings } = ctx;

  if (format === 'docx') {
    return {
      status: 'error',
      code: 'ENGINE_NOT_IN_PRODUCT',
      message:
        'DOCX is not in product profile A′ (extension-only). Use md/html or pdf via print.',
      format,
      warnings
    };
  }

  if (format === 'md') {
    const ref = createTextArtifact({
      runId,
      name: `${safeFile(title)}.md`,
      content: md,
      mime: 'text/markdown'
    });
    return { status: 'ok', format, ...ref, warnings };
  }

  if (format === 'txt') {
    const ref = createTextArtifact({
      runId,
      name: `${safeFile(title)}.txt`,
      content: draftBlocksToPlainText(blocks),
      mime: 'text/plain'
    });
    return { status: 'ok', format, ...ref, warnings };
  }

  if (format === 'csv') {
    const table = extractTableFromBlocks(blocks);
    if (!table) {
      return {
        status: 'error',
        code: 'NO_TABLE',
        message:
          'CSV requires table/record blocks. Use materialize_draft with records or a table, or format md/txt/pdf.',
        warnings
      };
    }
    const ref = createTableArtifact({
      runId,
      name: `${safeFile(title)}.csv`,
      columns: table.columns,
      rows: table.rows
    });
    return { status: 'ok', format, ...ref, warnings };
  }

  if (format === 'html') {
    const html = draftToPreviewHtml({ ...draft, title });
    const exportHtml = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const ref = createTextArtifact({
      runId,
      name: `${safeFile(title)}.html`,
      content: exportHtml,
      mime: 'text/html'
    });
    return { status: 'ok', format, ...ref, warnings };
  }

  if (format === 'pdf') {
    // Should normally be handled by builtin_print in renderDocumentFromDraft
    const printHtml = draftToPrintHtml({ ...draft, title, blocks });
    const ref = createTextArtifact({
      runId,
      name: `${safeFile(title)}.print.html`,
      content: printHtml,
      mime: 'text/html'
    });
    return {
      status: 'ok',
      format: 'pdf',
      delivery: 'browser_print',
      printHtml,
      ...ref,
      warnings: [...warnings, 'PDF via print HTML (A′)']
    };
  }

  if (format === 'pptx') {
    const { platesToPptxBytes } = await import('./vnext/sessionWorkspace/pptxExport.js');
    const plates = (blocks || [])
      .filter((b) => b && b.type !== 'slot')
      .map((b) => {
        if (b.type === 'image' && (b.bytes || b.src)) {
          return {
            kind: 'image',
            title: b.alt || title,
            imageBytes: b.bytes instanceof Uint8Array ? b.bytes : undefined,
            html: b.src ? `<img src="${b.src}"/>` : ''
          };
        }
        if (b.type === 'heading') {
          return { kind: 'html', title: b.text || '', html: `<h1>${b.text || ''}</h1>`, text: '' };
        }
        return {
          kind: 'html',
          title: '',
          html: `<p>${b.text || ''}</p>`,
          text: b.text || ''
        };
      });
    const bytes = platesToPptxBytes(plates.length ? plates : [{ html: `<h1>${title}</h1>` }], {
      title
    });
    const ref = createBinaryArtifact({
      runId,
      name: `${safeFile(title)}.pptx`,
      bytes,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    return { status: 'ok', format: 'pptx', ...ref, warnings };
  }

  if (format === 'zip') {
    const files = [];
    files.push({ name: `${safeFile(title)}.md`, content: md });
    const table = extractTableFromBlocks(blocks);
    if (table) {
      const { rowsToCsv } = await import('./dataTools/structuredData.js');
      const csv = rowsToCsv(table.rows, { fieldNames: table.columns });
      files.push({ name: `${safeFile(title)}.csv`, content: csv });
    }
    let imgN = 0;
    for (const b of blocks) {
      if (b?.type === 'image' && b.src && String(b.src).startsWith('data:')) {
        imgN += 1;
        files.push({
          name: `image_${imgN}.png`,
          dataUrl: b.src
        });
      }
    }
    const ref = packZipArtifact({
      runId,
      name: `${safeFile(title)}.zip`,
      files
    });
    return { status: 'ok', format, ...ref, warnings };
  }

  return { status: 'error', code: 'UNSUPPORTED_FORMAT', message: 'unhandled format', warnings };
}

function safeFile(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .slice(0, 80) || 'document';
}

/**
 * @param {Uint8Array} bytes
 * @param {string} mime
 */
function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      /** @type {number[]} */ (Array.from(bytes.subarray(i, i + chunk)))
    );
  }
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}
