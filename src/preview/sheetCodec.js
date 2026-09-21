/**
 * Host-only sheet codec: CSV/TSV and workbook JSON.
 * xlsx bytes go through the vendored SheetJS runtime, not this file.
 */

import { csvEscape, parseCsv } from '../agent/dataTools/structuredData.js';
import { classifyOpenArtifact, SHEET_OPEN_KINDS } from '../agent/vnext/sessionWorkspace/openClassify.js';

const SHEET_MAX_ROWS = 20_000;
const SHEET_MAX_COLS = 256;

/** Excel 2007+ hard cap. Not allocated up front — see gridExtentFromUsed / growGridExtent. */
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
/** First paint: used range + slack, like Excel's used-range scrollbar. */
export const GRID_MIN_ROWS = 200;
export const GRID_MIN_COLS = 40;
export const GRID_PAD_ROWS = 80;
export const GRID_PAD_COLS = 16;
export const GRID_CHUNK_ROWS = 200;
export const GRID_CHUNK_COLS = 26;
export const GRID_GROW_MARGIN_ROWS = 40;
export const GRID_GROW_MARGIN_COLS = 8;

/**
 * Initial visible extent from used cells. Does not jump to Excel max.
 * @param {number} usedRows
 * @param {number} usedCols
 */
export function gridExtentFromUsed(usedRows, usedCols) {
  const rows = Math.max(0, Number(usedRows) || 0);
  const cols = Math.max(0, Number(usedCols) || 0);
  return {
    rowCount: Math.min(EXCEL_MAX_ROWS, Math.max(GRID_MIN_ROWS, rows + GRID_PAD_ROWS)),
    columnCount: Math.min(EXCEL_MAX_COLS, Math.max(GRID_MIN_COLS, cols + GRID_PAD_COLS))
  };
}

/**
 * Grow extent when the viewport / write target nears the current edge.
 * @param {{ rowCount?: number, columnCount?: number }} current
 * @param {{ endRow?: number, endCol?: number }} viewed 0-based inclusive
 */
export function growGridExtent(current, viewed = {}) {
  let rowCount = Math.max(1, Number(current?.rowCount) || 1);
  let columnCount = Math.max(1, Number(current?.columnCount) || 1);
  const endRow = Number(viewed.endRow);
  const endCol = Number(viewed.endCol);
  if (Number.isFinite(endRow)) {
    if (endRow >= rowCount - 1 - GRID_GROW_MARGIN_ROWS) {
      rowCount = Math.min(EXCEL_MAX_ROWS, Math.max(rowCount + GRID_CHUNK_ROWS, endRow + 1 + GRID_PAD_ROWS));
    }
  }
  if (Number.isFinite(endCol)) {
    if (endCol >= columnCount - 1 - GRID_GROW_MARGIN_COLS) {
      columnCount = Math.min(EXCEL_MAX_COLS, Math.max(columnCount + GRID_CHUNK_COLS, endCol + 1 + GRID_PAD_COLS));
    }
  }
  return { rowCount, columnCount };
}

export function isSheetArtifact(item = {}) {
  const bytes = item.bytes;
  if (bytes && bytes.byteLength) {
    return SHEET_OPEN_KINDS.has(classifyOpenArtifact(item).kind);
  }
  const name = String(item.name || item.artifact?.name || '').toLowerCase();
  const mime = String(item.mimeType || item.mime || item.artifact?.mimeType || '').toLowerCase();
  if (/\.(csv|tsv|xlsx)$/i.test(name)) return true;
  if (mime.includes('csv') || mime.includes('tab-separated') || mime.includes('tsv')) return true;
  if (mime.includes('spreadsheetml') || mime.includes('excel')) return true;
  return false;
}

export function sheetKindFromArtifact(item = {}) {
  const bytes = item.bytes;
  if (bytes && bytes.byteLength) {
    const k = classifyOpenArtifact(item).kind;
    if (k === 'xlsx' || k === 'json-workbook') return 'xlsx';
    if (k === 'tsv') return 'tsv';
    if (k === 'csv') return 'csv';
  }
  const name = String(item.name || item.artifact?.name || '').toLowerCase();
  const mime = String(item.mimeType || item.mime || '').toLowerCase();
  if (/\.xlsx$/i.test(name) || mime.includes('spreadsheetml') || mime.includes('excel')) return 'xlsx';
  if (/\.tsv$/i.test(name) || mime.includes('tab-separated') || mime.includes('tsv')) return 'tsv';
  return 'csv';
}

export function parseDelimited(text, kind = 'csv') {
  const delimiter = kind === 'tsv' ? '\t' : ',';
  return parseCsv(text, { delimiter, maxRows: SHEET_MAX_ROWS, maxCols: SHEET_MAX_COLS });
}

export function aoaToCsv(rows, delimiter = ',') {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const sep = delimiter === '\t' ? '\t' : ',';
  return list
    .map((row) => {
      const cells = Array.isArray(row) ? row : [];
      return cells.map((c) => csvEscape(c == null ? '' : c)).join(sep);
    })
    .join('\n');
}

/** UTF-8 with BOM so Excel / WPS on Windows does not open Chinese as GBK. */
export function encodeUtf8Csv(text) {
  const body = new TextEncoder().encode(String(text || ''));
  const out = new Uint8Array(3 + body.length);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}

export function cellToAoaValue(cell) {
  if (cell == null) return '';
  if (typeof cell !== 'object') return cell;
  const f = cell.f != null ? String(cell.f) : '';
  if (f) return f.startsWith('=') ? f : `=${f}`;
  if (cell.v == null) return '';
  return cell.v;
}

export function aoaValueToCell(raw) {
  if (raw == null || raw === '') return null;
  const str = String(raw);
  if (str.startsWith('=')) return { f: str };
  const trimmed = str.trim();
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed) && !/^0\d/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { v: n };
  }
  return { v: str };
}

function newWorkbookId() {
  return `paw-wb-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Array<{ name?: string, rows: any[][] }>} sheets
 * @param {string} [name]
 * @param {{ id?: string }} [opts]
 */
export function sheetsToWorkbookData(sheets, name = 'Workbook', opts = {}) {
  const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  /** @type {Record<string, object>} */
  const sheetMap = {};
  const sheetOrder = [];
  list.forEach((s, i) => {
    const id = `sheet-${i}`;
    sheetOrder.push(id);
    const rows = Array.isArray(s.rows) ? s.rows : [];
    /** @type {Record<string, Record<string, object>>} */
    const cellData = {};
    let maxC = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = Array.isArray(rows[r]) ? rows[r] : [];
      maxC = Math.max(maxC, row.length);
      /** @type {Record<string, object>} */
      const rowObj = {};
      for (let c = 0; c < row.length; c++) {
        const cell = aoaValueToCell(row[c]);
        if (cell) rowObj[c] = cell;
      }
      if (Object.keys(rowObj).length) cellData[r] = rowObj;
    }
    sheetMap[id] = {
      id,
      name: String(s.name || `Sheet${i + 1}`).slice(0, 31) || `Sheet${i + 1}`,
      cellData,
      ...gridExtentFromUsed(rows.length, maxC)
    };
  });
  const id = String(opts.id || '').trim();
  return {
    id: id || newWorkbookId(),
    name: String(name || 'Workbook'),
    sheetOrder,
    sheets: sheetMap
  };
}

/**
 * @param {object|null|undefined} data
 * @returns {Array<{ name: string, rows: string[][] }>}
 */
export function workbookDataToSheets(data) {
  const sheets = data?.sheets && typeof data.sheets === 'object' ? data.sheets : {};
  const order = Array.isArray(data?.sheetOrder) && data.sheetOrder.length
    ? data.sheetOrder
    : Object.keys(sheets);
  return order.map((id, i) => {
    const sh = sheets[id] || {};
    const cellData = sh.cellData && typeof sh.cellData === 'object' ? sh.cellData : {};
    let maxR = -1;
    let maxC = -1;
    for (const rk of Object.keys(cellData)) {
      const r = Number(rk);
      if (!Number.isFinite(r)) continue;
      maxR = Math.max(maxR, r);
      const row = cellData[rk] || {};
      for (const ck of Object.keys(row)) {
        const c = Number(ck);
        if (Number.isFinite(c)) maxC = Math.max(maxC, c);
      }
    }
    /** @type {string[][]} */
    const rows = [];
    for (let r = 0; r <= maxR; r++) {
      const rd = cellData[r] || cellData[String(r)] || {};
      const row = [];
      for (let c = 0; c <= maxC; c++) {
        row.push(cellToAoaValue(rd[c] ?? rd[String(c)]));
      }
      rows.push(row);
    }
    return {
      name: String(sh.name || `Sheet${i + 1}`),
      rows
    };
  });
}

export function bytesToUtf8(bytes) {
  if (!bytes || !bytes.byteLength) return '';
  return new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
}
