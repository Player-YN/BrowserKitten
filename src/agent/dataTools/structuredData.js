/**
 * Structured table/card parsing + CSV/JSON export helpers (pure JS, no deps).
 */

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_COLS = 40;

/**
 * Collect stable column order from list of row objects.
 * @param {Array<Record<string, any>>} rows
 * @returns {string[]}
 */
export function collectFieldNames(rows) {
  const names = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

/**
 * Escape one CSV cell (RFC-style quotes).
 * @param {any} value
 * @returns {string}
 */
export function csvEscape(value) {
  if (value == null) return '';
  const s = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\t\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * RFC 4180-ish CSV parse. Quoted commas/newlines stay in one cell; BOM stripped.
 * @param {string} text
 * @param {{ maxRows?: number, maxCols?: number }} [opts]
 * @returns {string[][]}
 */
export function parseCsv(text, opts = {}) {
  const maxRows = Math.max(1, Number(opts.maxRows) || DEFAULT_MAX_ROWS);
  const maxCols = Math.max(1, Number(opts.maxCols) || DEFAULT_MAX_COLS);
  const delim = opts.delimiter === '\t' ? '\t' : ',';
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.trim()) return [];
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delim) {
      if (row.length < maxCols) row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      if (row.length < maxCols) row.push(cell);
      if (rows.length < maxRows) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) break;
      continue;
    }
    cell += ch;
  }
  if (quoted || cell.length || row.length) {
    if (row.length < maxCols) row.push(cell);
    if (rows.length < maxRows) rows.push(row);
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => {
    const out = r.slice(0, maxCols);
    while (out.length < width && out.length < maxCols) out.push('');
    return out;
  });
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {{ fieldNames?: string[], bom?: boolean }} [opts]
 * @returns {string}
 */
export function rowsToCsv(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return opts.bom ? '\uFEFF' : '';
  const fields = opts.fieldNames && opts.fieldNames.length ? opts.fieldNames : collectFieldNames(list);
  const lines = [fields.map(csvEscape).join(',')];
  for (const row of list) {
    lines.push(fields.map((f) => csvEscape(row?.[f])).join(','));
  }
  const body = lines.join('\n');
  return opts.bom === false ? body : `\uFEFF${body}`;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {{ pretty?: boolean }} [opts]
 * @returns {string}
 */
export function rowsToJson(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return JSON.stringify(list, null, opts.pretty === false ? 0 : 2);
}

/**
 * Parse HTML tables into row objects (pure string parser).
 * @param {string} html
 * @param {{ maxRows?: number, maxCols?: number }} [opts]
 * @returns {Array<{ source: string, headers: string[], rows: Array<Record<string, string>>, tableIndex: number }>}
 */
export function parseHtmlTables(html, opts = {}) {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCols = opts.maxCols ?? DEFAULT_MAX_COLS;
  if (!html) return [];

  const tables = [];
  const tableRe = /<table(\s[^>]*)?>([\s\S]*?)<\/table>/gi;
  let tm;
  let tableIndex = 0;
  while ((tm = tableRe.exec(html)) !== null) {
    const tableHtml = tm[2];
    const headers = [];
    const thRe = /<th(\s[^>]*)?>([\s\S]*?)<\/th>/gi;
    let th;
    while ((th = thRe.exec(tableHtml)) !== null && headers.length < maxCols) {
      headers.push(plainCell(th[2]) || `Column_${headers.length + 1}`);
    }

    const rows = [];
    const trRe = /<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(tableHtml)) !== null && rows.length < maxRows) {
      const cells = [];
      const tdRe = /<t[dh](\s[^>]*)?>([\s\S]*?)<\/t[dh]>/gi;
      let td;
      while ((td = tdRe.exec(tr[2])) !== null && cells.length < maxCols) {
        cells.push(plainCell(td[2]));
      }
      // Skip pure header rows (all th already captured, no td)
      const onlyTh = /<td[\s>]/i.test(tr[2]) === false && /<th[\s>]/i.test(tr[2]);
      if (onlyTh && headers.length > 0) continue;
      if (cells.length === 0) continue;
      // Skip if identical to headers
      if (headers.length && cells.every((c, i) => c === headers[i])) continue;

      const row = {};
      for (let i = 0; i < cells.length; i++) {
        const key = headers[i] || `Column_${i + 1}`;
        row[key] = cells[i];
      }
      if (Object.keys(row).length) rows.push(row);
    }

    if (rows.length > 0) {
      tables.push({
        source: 'table',
        headers: headers.length ? headers : collectFieldNames(rows),
        rows,
        tableIndex
      });
    }
    tableIndex++;
  }
  return tables;
}

/**
 * Heuristic card/list extraction from class*=card|item|product|row.
 * @param {string} html
 * @param {{ maxRows?: number, maxFields?: number }} [opts]
 * @returns {Array<Record<string, string>>}
 */
export function parseHtmlCards(html, opts = {}) {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxFields = opts.maxFields ?? 12;
  if (!html) return [];

  const cardRe =
    /<(div|li|article|section)(\s[^>]*class=["'][^"']*(?:card|item|product|result|listing|row)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  const results = [];
  const seen = new Set();
  let m;
  while ((m = cardRe.exec(html)) !== null && results.length < maxRows) {
    const inner = m[3];
    // Skip nested tiny wrappers
    if (inner.length < 20) continue;
    const texts = extractStrippedStrings(inner, maxFields + 4);
    if (texts.length < 1) continue;
    const row = {};
    texts.slice(0, maxFields).forEach((t, i) => {
      row[`Field_${i + 1}`] = t;
    });
    // Prefer named fields from common sub-nodes
    const title =
      matchFirstText(inner, /<(h[1-6]|a)(\s[^>]*)?>([\s\S]*?)<\/\1>/i) ||
      matchFirstText(inner, /class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)</i);
    const price = matchFirstText(inner, /class=["'][^"']*price[^"']*["'][^>]*>([\s\S]*?)</i);
    const link = (inner.match(/<a\s+[^>]*href=["']([^"']+)["']/i) || [])[1];
    if (title) row.Title = title.slice(0, 200);
    if (price) row.Price = price.slice(0, 80);
    if (link && !link.startsWith('javascript:')) row.Link = link.slice(0, 500);

    const sig = JSON.stringify(row);
    if (seen.has(sig)) continue;
    seen.add(sig);
    results.push(row);
  }
  return results;
}

/**
 * Flatten best data source from tables + cards.
 * Preference: largest table → cards → empty.
 * @param {string} html
 * @param {{ prefer?: 'auto'|'table'|'cards', maxRows?: number }} [opts]
 * @returns {{ rows: Array<Record<string, string>>, source: string, tableCount: number, cardCount: number, meta: object }}
 */
export function parseStructuredDataFromHtml(html, opts = {}) {
  const prefer = opts.prefer || 'auto';
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const tables = parseHtmlTables(html, { maxRows });
  const cards = prefer === 'table' ? [] : parseHtmlCards(html, { maxRows });

  let bestTable = null;
  for (const t of tables) {
    if (!bestTable || t.rows.length > bestTable.rows.length) bestTable = t;
  }

  if (prefer === 'cards') {
    return {
      rows: cards.slice(0, maxRows),
      source: cards.length ? 'cards' : 'none',
      tableCount: tables.length,
      cardCount: cards.length,
      meta: { preferred: prefer }
    };
  }

  if (prefer === 'table' || (prefer === 'auto' && bestTable && bestTable.rows.length >= 2)) {
    if (bestTable) {
      return {
        rows: bestTable.rows.slice(0, maxRows),
        source: 'table',
        tableCount: tables.length,
        cardCount: cards.length,
        meta: { tableIndex: bestTable.tableIndex, headers: bestTable.headers }
      };
    }
  }

  if (cards.length > 0) {
    return {
      rows: cards.slice(0, maxRows),
      source: 'cards',
      tableCount: tables.length,
      cardCount: cards.length,
      meta: {}
    };
  }

  if (bestTable) {
    return {
      rows: bestTable.rows.slice(0, maxRows),
      source: 'table',
      tableCount: tables.length,
      cardCount: cards.length,
      meta: { tableIndex: bestTable.tableIndex, headers: bestTable.headers }
    };
  }

  return {
    rows: [],
    source: 'none',
    tableCount: tables.length,
    cardCount: 0,
    meta: {}
  };
}

/**
 * Convert selected elements summary → rows (selection export path).
 * @param {Array<{ tag?: string, selector?: string, text?: string, src?: string }>} elements
 * @returns {Array<Record<string, string>>}
 */
export function selectionToRows(elements) {
  return (elements || []).map((el, i) => ({
    Index: String(i + 1),
    Tag: el.tag || '',
    Selector: el.selector || '',
    Text: (el.text || '').slice(0, 500),
    Src: (el.src || '').slice(0, 500)
  }));
}

/**
 * Build a downloadable data URL for text content.
 * @param {string} content
 * @param {string} mime
 * @returns {string}
 */
export function toDataUrl(content, mime = 'text/plain;charset=utf-8') {
  // Prefer percent-encoding for large unicode-safe CSV/JSON in content scripts
  return `data:${mime},${encodeURIComponent(content)}`;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {'csv'|'json'} format
 * @returns {{ content: string, mime: string, extension: string, filenameHint: string }}
 */
export function formatRowsForDownload(rows, format = 'csv') {
  const fmt = String(format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  if (fmt === 'json') {
    const content = rowsToJson(rows, { pretty: true });
    return {
      content,
      mime: 'application/json;charset=utf-8',
      extension: 'json',
      filenameHint: `browserbot_data_${Date.now()}.json`
    };
  }
  const content = rowsToCsv(rows, { bom: true });
  return {
    content,
    mime: 'text/csv;charset=utf-8',
    extension: 'csv',
    filenameHint: `browserbot_data_${Date.now()}.csv`
  };
}

// ── internals ──────────────────────────────────────────────

function plainCell(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function extractStrippedStrings(html, max = 12) {
  const texts = [];
  const re = />([^<]{2,})</g;
  let m;
  while ((m = re.exec(html)) !== null && texts.length < max) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.length < 2) continue;
    if (/^[\d\s.,¥$€£%]+$/.test(t) && t.length < 2) continue;
    texts.push(t.slice(0, 300));
  }
  return texts;
}

function matchFirstText(html, re) {
  const m = html.match(re);
  if (!m) return '';
  const raw = m[3] != null ? m[3] : m[1];
  return plainCell(raw);
}

export const STRUCTURED_MAX_ROWS = DEFAULT_MAX_ROWS;
