/**
 * Workbook JSON persist, inspect, and command policy.
 * AOA remains export-only (csv/tsv). XLSX carries paw/workbook.json sidecar.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from './vendor/fflate.js';
import { aoaValueToCell, cellToAoaValue } from './sheetCodec.js';
import { snapshotNeedsImageReinsert } from './durableImage.js';

const COL_A = 'A'.charCodeAt(0);

function indexToCol(index) {
  let n = Math.max(0, Number(index) | 0) + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(COL_A + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

function colToIndex(col) {
  const s = String(col || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - COL_A + 1);
  return n - 1;
}

function parseA1(ref) {
  const raw = String(ref || '').trim();
  let sheet;
  let body = raw;
  const bang = raw.lastIndexOf('!');
  if (bang > 0) {
    sheet = raw.slice(0, bang).replace(/^'|'$/g, '');
    body = raw.slice(bang + 1);
  }
  const m = /^(\$?([A-Z]+)\$?(\d+)?)(?::(\$?([A-Z]+)\$?(\d+)?))?$/i.exec(body.replace(/\$/g, ''));
  if (!m) {
    return { sheet, sr: 0, sc: 0, er: 0, ec: 0, wholeCol: false, wholeRow: false, a1: body || 'A1' };
  }
  const sc = m[2] ? colToIndex(m[2]) : 0;
  const sr = m[3] ? Number(m[3]) - 1 : 0;
  const wholeCol = !m[3];
  const wholeRow = !m[2];
  const ec = m[5] ? colToIndex(m[5]) : sc;
  const er = m[6] ? Number(m[6]) - 1 : sr;
  const wholeColEnd = m[4] && !m[6];
  return {
    sheet,
    sr: wholeRow ? 0 : sr,
    sc: wholeCol ? sc : sc,
    er: wholeCol || wholeColEnd ? sr : er,
    ec: wholeRow ? sc : ec,
    wholeCol: wholeCol || wholeColEnd,
    wholeRow,
    a1: body || 'A1'
  };
}

export const WORKBOOK_SNAP_PATH = 'paw/workbook.json';

export const COMMAND_NOISE_RE =
  /scroll|hover|lifecycle|selection|set-selections|active-range|focus|activate-sheet|set-worksheet-active|change-sheet|active-worksheet/i;

export function isWorkbookData(data) {
  return !!(data && typeof data === 'object' && data.sheets && typeof data.sheets === 'object');
}

export function cloneWorkbookData(data) {
  if (!isWorkbookData(data)) return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
}

function sheetByNameFromData(data, name) {
  const sheets = data?.sheets || {};
  const order = Array.isArray(data?.sheetOrder) && data.sheetOrder.length ? data.sheetOrder : Object.keys(sheets);
  if (name) {
    for (const id of order) {
      const sh = sheets[id];
      if (sh && String(sh.name) === String(name)) return { id, sheet: sh };
    }
  }
  const first = order[0];
  return first ? { id: first, sheet: sheets[first] } : { id: '', sheet: null };
}

/**
 * Write AOA values back into an existing workbook without dropping
 * merge / freeze / styles / validation / CF / drawings.
 */
export function patchWorkbookFromSheets(base, aoaSheets) {
  const list = Array.isArray(aoaSheets) && aoaSheets.length ? aoaSheets : [{ name: 'Sheet1', rows: [] }];
  const data = cloneWorkbookData(isWorkbookData(base) ? base : { id: 'paw-wb', name: 'Workbook', sheetOrder: [], sheets: {} });
  if (!data.sheets || typeof data.sheets !== 'object') data.sheets = {};
  const nameToId = new Map();
  for (const id of Object.keys(data.sheets)) {
    nameToId.set(String(data.sheets[id]?.name || ''), id);
  }
  const nextSheets = {};
  const nextOrder = [];
  list.forEach((aoa, i) => {
    const name = String(aoa.name || `Sheet${i + 1}`).slice(0, 31) || `Sheet${i + 1}`;
    let id = nameToId.get(name);
    if (!id || nextSheets[id]) id = `sheet-${i}-${Math.random().toString(36).slice(2, 7)}`;
    const prev = data.sheets[nameToId.get(name)] || data.sheets[id] || {};
    const sh = {
      ...prev,
      id: prev.id || id,
      name,
      cellData: prev.cellData && typeof prev.cellData === 'object' ? { ...prev.cellData } : {}
    };
    const rows = Array.isArray(aoa.rows) ? aoa.rows : [];
    for (let r = 0; r < rows.length; r++) {
      const row = Array.isArray(rows[r]) ? rows[r] : [];
      const prevRow = sh.cellData[r] || sh.cellData[String(r)] || {};
      const nextRow = { ...prevRow };
      const maxC = Math.max(row.length, Object.keys(prevRow).reduce((m, k) => Math.max(m, Number(k) || 0), -1) + 1);
      for (let c = 0; c < maxC; c++) {
        const raw = c < row.length ? row[c] : undefined;
        if (raw === undefined) continue;
        if (raw == null || raw === '') {
          delete nextRow[c];
          delete nextRow[String(c)];
          continue;
        }
        const cell = aoaValueToCell(raw);
        const prevCell = prevRow[c] || prevRow[String(c)] || {};
        const merged = { ...prevCell, ...cell };
        if (cell?.f) delete merged.v;
        else if (cell && Object.prototype.hasOwnProperty.call(cell, 'v')) delete merged.f;
        nextRow[c] = merged;
      }
      if (Object.keys(nextRow).length) sh.cellData[r] = nextRow;
      else delete sh.cellData[r];
    }
    nextSheets[id] = sh;
    nextOrder.push(id);
  });
  data.sheets = nextSheets;
  data.sheetOrder = nextOrder;
  return data;
}

function parseJsonBytes(u8) {
  try {
    return JSON.parse(strFromU8(u8));
  } catch {
    return null;
  }
}

export function injectWorkbookSnapshot(xlsxBytes, workbookData) {
  if (!xlsxBytes || !xlsxBytes.byteLength || !isWorkbookData(workbookData)) return xlsxBytes;
  let files;
  try {
    files = unzipSync(xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes));
  } catch {
    return xlsxBytes;
  }
  files[WORKBOOK_SNAP_PATH] = strToU8(JSON.stringify(workbookData));
  const ctPath = '[Content_Types].xml';
  if (files[ctPath]) {
    let ct = strFromU8(files[ctPath]);
    if (!ct.includes(WORKBOOK_SNAP_PATH)) {
      ct = ct.replace(
        '</Types>',
        `<Override PartName="/${WORKBOOK_SNAP_PATH}" ContentType="application/json"/></Types>`
      );
      files[ctPath] = strToU8(ct);
    }
  }
  return zipSync(files, { level: 6 });
}

export function extractWorkbookSnapshot(xlsxBytes) {
  if (!xlsxBytes || !xlsxBytes.byteLength) return null;
  try {
    const files = unzipSync(xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes));
    const raw = files[WORKBOOK_SNAP_PATH];
    if (!raw) return null;
    const data = parseJsonBytes(raw);
    return isWorkbookData(data) ? data : null;
  } catch {
    return null;
  }
}

function cellAt(sheet, r, c) {
  const cellData = sheet?.cellData || {};
  const row = cellData[r] || cellData[String(r)] || {};
  return row[c] || row[String(c)] || null;
}

function a1Bounds(sr, sc, er, ec) {
  if (sr === er && sc === ec) return `${indexToCol(sc)}${sr + 1}`;
  return `${indexToCol(sc)}${sr + 1}:${indexToCol(ec)}${er + 1}`;
}

/** Last non-empty cell in Univer cellData — not sheet.rowCount (often the grid size). */
function usedExtentFromSheet(sheet) {
  const cellData = sheet?.cellData || {};
  let er = -1;
  let ec = -1;
  for (const rk of Object.keys(cellData)) {
    const r = Number(rk);
    if (!Number.isFinite(r)) continue;
    const row = cellData[rk];
    if (!row || typeof row !== 'object') continue;
    let rowHas = false;
    for (const ck of Object.keys(row)) {
      const c = Number(ck);
      if (!Number.isFinite(c)) continue;
      if (row[ck] == null) continue;
      rowHas = true;
      if (c > ec) ec = c;
    }
    if (rowHas && r > er) er = r;
  }
  return { er: Math.max(er, 0), ec: Math.max(ec, 0), rowCount: er + 1, columnCount: ec + 1 };
}

function validationForCell(sheet, r, c) {
  const raw = sheet?.dataValidation || sheet?.dataValidations || [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.dataValidations) ? raw.dataValidations : [];
  for (const rule of list) {
    const ranges = rule.ranges || rule.range || [];
    const arr = Array.isArray(ranges) ? ranges : [ranges];
    for (const rg of arr) {
      const sr = Number(rg.startRow ?? rg.sr ?? 0);
      const sc = Number(rg.startColumn ?? rg.startCol ?? rg.sc ?? 0);
      const er = Number(rg.endRow ?? rg.er ?? sr);
      const ec = Number(rg.endColumn ?? rg.endCol ?? rg.ec ?? sc);
      if (r >= sr && r <= er && c >= sc && c <= ec) {
        return {
          type: rule.type || rule.validationType || null,
          operator: rule.operator || null,
          formula1: rule.formula1 || rule.value1 || null,
          formula2: rule.formula2 || rule.value2 || null
        };
      }
    }
  }
  return null;
}

function numfmtOf(cell) {
  if (!cell || typeof cell !== 'object') return null;
  return cell.s?.n || cell.s?.pattern || cell.n || cell.numfmt || null;
}

/**
 * Capped inspect of one A1 on a full workbook. Never returns other sheets' grids.
 * Payload is a sample: truncated + next + requested vs shown a1 + sheetRowCount.
 */
export function inspectWorkbookRange(data, a1, sheetName, cap = {}) {
  const maxRows = Math.max(1, Number(cap.maxRows) || 30);
  const maxCols = Math.max(1, Number(cap.maxCols) || 16);
  const maxCellChars = Math.max(8, Number(cap.maxCellChars) || 160);
  const parsed = parseA1(a1 || 'A1');
  const { sheet } = sheetByNameFromData(data, sheetName || parsed.sheet);
  const name = sheet?.name || sheetName || 'Sheet1';
  const used = usedExtentFromSheet(sheet);
  const sr = parsed.wholeCol ? 0 : parsed.sr;
  const sc = parsed.wholeRow ? 0 : parsed.sc;
  const requestedEr = parsed.wholeCol ? used.er : parsed.er;
  const requestedEc = parsed.wholeRow ? used.ec : parsed.ec;
  const wantRows = Math.max(1, requestedEr - sr + 1);
  const wantCols = Math.max(1, requestedEc - sc + 1);
  const truncated = wantRows > maxRows || wantCols > maxCols;
  const showR = Math.min(wantRows, maxRows);
  const showC = Math.min(wantCols, maxCols);
  const values = [];
  const cells = [];
  for (let r = sr; r < sr + showR; r++) {
    const row = [];
    for (let c = sc; c < sc + showC; c++) {
      const cell = cellAt(sheet, r, c);
      let v = cellToAoaValue(cell);
      if (typeof v === 'string' && v.length > maxCellChars) v = `${v.slice(0, maxCellChars)}…`;
      row.push(v);
      cells.push({
        a1: `${indexToCol(c)}${r + 1}`,
        v: cell?.v ?? (typeof v === 'string' && v.startsWith('=') ? undefined : v),
        f: cell?.f || (typeof v === 'string' && v.startsWith('=') ? v : undefined),
        numfmt: numfmtOf(cell),
        validation: validationForCell(sheet, r, c)
      });
    }
    values.push(row);
  }
  const headerRow = [];
  for (let c = sc; c < sc + showC; c++) {
    headerRow.push(cellToAoaValue(cellAt(sheet, 0, c)));
  }
  const shownA1 = a1Bounds(sr, sc, sr + Math.max(showR, 1) - 1, sc + Math.max(showC, 1) - 1);
  const requestedA1 = a1Bounds(sr, sc, requestedEr, requestedEc);
  let next;
  if (wantRows > maxRows) next = a1Bounds(sr + maxRows, sc, requestedEr, requestedEc);
  else if (wantCols > maxCols) next = a1Bounds(sr, sc + maxCols, requestedEr, requestedEc);
  return {
    sheet: name,
    a1: shownA1,
    requested: parsed.wholeCol || parsed.wholeRow ? requestedA1 : parsed.a1 || a1 || requestedA1,
    headers: headerRow,
    values,
    cells,
    truncated,
    next: truncated ? next : undefined,
    rowCount: wantRows,
    columnCount: wantCols,
    sheetRowCount: used.rowCount,
    note: truncated
      ? `truncated to ${maxRows} rows × ${maxCols} cols; pass next`
      : undefined
  };
}

/** Univer ICommandEvent is { id, type, params, options } — stamp agent writes here. */
export const FROM_AGENT = 'fromAgent';

export function isAgentCommandEvent(ev = {}) {
  const opt = ev?.options && typeof ev.options === 'object' ? ev.options : {};
  const params = ev?.params && typeof ev.params === 'object' ? ev.params : {};
  return !!(
    ev.fromAgent ||
    opt[FROM_AGENT] ||
    opt.fromAgent ||
    opt.from === 'agent' ||
    params.fromAgent ||
    params[FROM_AGENT]
  );
}

/**
 * Agent identity is event-only (`options.fromAgent`). Host and tests
 * must pass the same runtime keys: applying / sessionMismatch / readOnly.
 */
export function sheetCommandGuardContext(ev = {}, runtime = {}) {
  return {
    applying: !!runtime.applying,
    userOrigin: !isAgentCommandEvent(ev),
    sessionMismatch: !!runtime.sessionMismatch,
    readOnly: !!runtime.readOnly
  };
}

export function beforeCommandShouldCancel(ev = {}, ctx = {}) {
  const id = String(ev.id || ev.commandId || ev.command?.id || '');
  if (ctx.sessionMismatch) return { cancel: true, reason: 'session-mismatch' };
  if (ctx.readOnly && !COMMAND_NOISE_RE.test(id)) return { cancel: true, reason: 'read-only' };
  if (ctx.applying && ctx.userOrigin && !COMMAND_NOISE_RE.test(id)) {
    return { cancel: true, reason: 'agent-applying' };
  }
  return { cancel: false };
}

/** Production composition: one call for live BeforeCommand and Node interceptThenApply. */
export function evaluateBeforeCommand(ev, runtime = {}) {
  return beforeCommandShouldCancel(ev, sheetCommandGuardContext(ev, runtime));
}

/** Reinsert zip pictures when sidecar has no pixels or only dead blob: URLs. */
export function shouldReinsertXlsxImages(snapshot) {
  return snapshotNeedsImageReinsert(snapshot);
}

export function shouldLogCommand(id) {
  const s = String(id || '');
  if (!s) return false;
  if (COMMAND_NOISE_RE.test(s)) return false;
  return true;
}

export function appendCommandLog(log, ev, max = 200) {
  const id = String(ev?.id || ev?.commandId || ev?.command?.id || '');
  if (!shouldLogCommand(id)) return Array.isArray(log) ? log : [];
  const prev = Array.isArray(log) ? log : [];
  const next = [...prev, { id, params: ev?.params || ev?.command?.params || null, at: Date.now() }];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function pastePayloadAllowed(htmlOrText) {
  const s = String(htmlOrText || '');
  if (!s) return true;
  if (/<script\b/i.test(s) || /javascript\s*:/i.test(s) || /\son\w+\s*=/i.test(s)) return false;
  return true;
}

export function formulaValueFromCell(cell) {
  if (!cell || typeof cell !== 'object') return { v: cellToAoaValue(cell), f: undefined };
  return { v: cell.v ?? null, f: cell.f ? (String(cell.f).startsWith('=') ? cell.f : `=${cell.f}`) : null };
}
