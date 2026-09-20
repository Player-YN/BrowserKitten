/**
 * Chrome-free print / PDF serialization for HTML plates.
 * Editor chrome (#bar, handles, data-act) never appears in this HTML.
 */

export function detectHtmlKind(html = '', styles = '') {
  const s = `${html || ''}\n${styles || ''}`;
  if (
    /data-browserbot-kind\s*=\s*["']deck["']/i.test(s) ||
    /data-paw-slide\b/i.test(s) ||
    /--paw-slide-w\s*:/i.test(s)
  ) {
    return 'deck';
  }
  if (/data-browserbot-kind\s*=\s*["']poster["']/i.test(s) || /--paw-poster-w\s*:/i.test(s)) {
    return 'poster';
  }
  return 'document';
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PRINT_BASE = `
html, body { margin: 0; padding: 0; }
body.paw-print { background: #0b0b0d; color: #111; font-family: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.paw-print-hint { display: none; }
section.print-plate { box-sizing: border-box; }
body.paw-kind-document section.print-plate img,
body.paw-kind-deck section.print-plate img { max-width: 100%; height: auto; display: block; }
@media print {
  .paw-print-hint, .no-print, #bar, .pw-handle, .pw-add, [data-act], .host-file-strip, .pw-handles, #layers, .artboard-tools { display: none !important; }
  body.paw-print.paw-kind-document { background: #fff; }
}
`;

function deckCss(styles = '', { artboardSlots = false } = {}) {
  const w = cssPx(styles, '--paw-slide-w') || 1280;
  const h = cssPx(styles, '--paw-slide-h') || 720;
  const wIn = (w / 96).toFixed(4);
  const hIn = (h / 96).toFixed(4);
  const pageSize = w >= h ? `${wIn}in ${hIn}in landscape` : `${wIn}in ${hIn}in`;
  const pad = artboardSlots ? '0' : '48px 56px';
  const slotLock = artboardSlots
    ? `
body.paw-kind-deck [data-paw-slot][data-box] {
  position: absolute !important;
  box-sizing: border-box;
}
body.paw-kind-deck img[data-paw-slot][data-box] {
  max-width: none !important;
  height: auto;
}`
    : '';
  return `
@page { size: ${pageSize}; margin: 0; }
body.paw-kind-deck { background: #111; }
body.paw-kind-deck section.print-plate {
  width: ${w}px;
  height: ${h}px;
  max-width: none;
  max-height: none;
  margin: 0 auto 16px;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
  position: relative;
  background: #0f172a;
  color: #f8fafc;
  padding: ${pad};
  box-sizing: border-box;
}
body.paw-kind-deck section.print-plate:last-child { page-break-after: auto; }
${slotLock}
@media print {
  body.paw-kind-deck section.print-plate {
    margin: 0;
    width: ${w}px !important;
    height: ${h}px !important;
  }
}
`;
}

function posterCss(styles = '') {
  const w = cssPx(styles, '--paw-poster-w') || 720;
  const h = cssPx(styles, '--paw-poster-h') || 1080;
  const wIn = (w / 96).toFixed(4);
  const hIn = (h / 96).toFixed(4);
  return `
@page { size: ${wIn}in ${hIn}in; margin: 0; }
html, body.paw-kind-poster {
  width: ${w}px;
  height: ${h}px;
  margin: 0;
  padding: 0;
  display: block;
  background: transparent;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body.paw-kind-poster .print-artboard,
body.paw-kind-poster section.print-plate {
  position: relative;
  width: ${w}px !important;
  height: ${h}px !important;
  min-height: 0 !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  display: block !important;
  box-shadow: none !important;
}
body.paw-kind-poster [data-paw-slot][data-box] {
  position: absolute !important;
  box-sizing: border-box;
}
body.paw-kind-poster img {
  max-width: none !important;
  object-fit: cover;
  display: block;
}
body.paw-kind-poster,
body.paw-kind-poster .print-artboard,
body.paw-kind-poster section.print-plate {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
@media print {
  html, body.paw-kind-poster,
  body.paw-kind-poster .print-artboard,
  body.paw-kind-poster section.print-plate {
    width: ${w}px !important;
    height: ${h}px !important;
  }
}
`;
}

function cssPx(styles, name) {
  const m = new RegExp(`${name}\\s*:\\s*([\\d.]+)px`, 'i').exec(String(styles || ''));
  return m ? Number(m[1]) : 0;
}

function sanitizePrintHtml(html) {
  let s = String(html || '')
    .replace(/\bis-slot-selected\b/g, '')
    .replace(/\s+draggable="false"/gi, '')
    .replace(/\s+class="\s*"/g, '');
  s = s.replace(
    /(<[^>]*\bdata-box="([^"]+)"[^>]*)(\/?>)/gi,
    (full, open, box, end) => {
      if (/\bstyle=/i.test(open)) return full;
      const parts = String(box)
        .split(/[,\s]+/)
        .map((n) => Number(n));
      if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return full;
      const [x, y, w, h] = parts;
      return `${open} style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px"${end}`;
    }
  );
  return s;
}

const DOC_CSS = `
@page { size: A4; margin: 16mm; }
body.paw-kind-document { max-width: 720px; margin: 0 auto; padding: 24px; background: #fff; color: #1c1915; }
body.paw-kind-document section.print-plate { margin: 0 0 1.25rem; }
`;

/**
 * Print-ready HTML for poster / deck / document plates.
 * Must not include host editor chrome.
 * @param {Array<{ id?: string, html?: string }>} plates
 * @param {{ title?: string, styles?: string, kind?: string, lang?: string }} [opts]
 */
export function platesToPrintHtml(plates, opts = {}) {
  const list = Array.isArray(plates) ? plates : [];
  const title = opts.title || 'Browser Kitten';
  const lang = opts.lang || 'zh-CN';
  const kind = opts.kind || detectHtmlKind('', opts.styles || '');
  const userStyles = String(opts.styles || '').trim();
  const htmlBlob = list.map((p) => String(p?.html || '')).join('\n');
  const artboardSlots = /data-box\s*=/.test(htmlBlob);
  const skin =
    kind === 'deck' ? deckCss(userStyles, { artboardSlots }) : kind === 'poster' ? '' : DOC_CSS;
  const posterLock = kind === 'poster' ? posterCss(userStyles) : '';
  const sections = list
    .map((p, i) => {
      const id = xmlEscape(p.id || `plate-${i + 1}`);
      return `<section data-browserbot-block data-browserbot-block-id="${id}" class="print-plate">${sanitizePrintHtml(p.html || '')}</section>`;
    })
    .join('\n');
  const bodyInner =
    kind === 'poster' ? `<div class="print-artboard">${sections}</div>` : sections;
  return `<!DOCTYPE html>
<html lang="${xmlEscape(lang)}" data-browserbot-preview="blocks" data-browserbot-kind="${xmlEscape(kind)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="browserbot-preview" content="blocks" />
  <title>${xmlEscape(title)}</title>
  <style>
${PRINT_BASE}
${skin}
${userStyles}
${posterLock}
  </style>
</head>
<body class="paw-print paw-kind-${xmlEscape(kind)}">
${bodyInner}
</body>
</html>
`;
}
