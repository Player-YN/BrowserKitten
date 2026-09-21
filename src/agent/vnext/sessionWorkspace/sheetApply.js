/**
 * Workbook command apply on CSV/TSV rows.
 * Selection is never a permission gate.
 */

import {
  aoaValueToCell,
  cellToAoaValue,
  sheetsToWorkbookData,
  workbookDataToSheets
} from '../../../preview/sheetCodec.js';
import {
  evaluateBeforeCommand,
  inspectWorkbookRange,
  patchWorkbookFromSheets
} from '../../../preview/sheetModel.js';

export const SHEET_OPS = [
  'createWorkbook',
  'setRange',
  'setFormula',
  'setValues2d',
  'applyGrid',
  'reshapeSplit',
  'insertRow',
  'insertCol',
  'deleteRow',
  'deleteCol',
  'sort',
  'numberFormat',
  'createSheet',
  'renameSheet',
  'insertImage',
  'insertCellImage',
  'insertFloatImage'
];

export const XLSX_DRAWING_EXPORT_WARNING =
  'xlsx export does not include cell images.';

export const DRAFT_SUFFIX = '（草稿）';

export const SHEET_INSPECT = {
  maxRows: 30,
  maxCols: 16,
  maxCellChars: 160
};

/** Full used-range dump for run(); silent inspect-style truncate is forbidden. */
export const SHEET_SNAPSHOT_MAX_ROWS = 5000;

const COL_A = 'A'.charCodeAt(0);

export function colToIndex(col) {
  const s = String(col || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - COL_A + 1);
  return n - 1;
}

export function indexToCol(index) {
  let n = Math.max(0, Number(index) | 0) + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(COL_A + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

/**
 * @returns {{ sheet?: string, sr: number, sc: number, er: number, ec: number, wholeCol: boolean, wholeRow: boolean, a1: string }}
 */
export function parseA1(ref) {
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
  const c1 = m[2] ? colToIndex(m[2]) : 0;
  const r1 = m[3] ? Number(m[3]) - 1 : 0;
  const hasC2 = !!m[5];
  const hasR2 = m[6] != null && m[6] !== '';
  const c2 = hasC2 ? colToIndex(m[5]) : c1;
  const r2 = hasR2 ? Number(m[6]) - 1 : r1;
  const wholeCol = !m[3] && !hasR2 && !!m[2];
  const wholeRow = !m[2] && !!m[3];
  return {
    sheet,
    sr: Math.min(r1, r2),
    sc: Math.min(c1, c2),
    er: Math.max(r1, r2),
    ec: Math.max(c1, c2),
    wholeCol,
    wholeRow,
    a1: body
  };
}

export function a1FromBounds(sr, sc, er, ec) {
  if (sr === er && sc === ec) return `${indexToCol(sc)}${sr + 1}`;
  return `${indexToCol(sc)}${sr + 1}:${indexToCol(ec)}${er + 1}`;
}

function usedBounds(rows) {
  let er = -1;
  let ec = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] != null && row[c] !== '') {
        er = Math.max(er, r);
        ec = Math.max(ec, c);
      }
    }
  }
  return { sr: 0, sc: 0, er: Math.max(er, 0), ec: Math.max(ec, 0) };
}

export function normalizeA1(ref) {
  const parsed = parseA1(ref);
  if (parsed.wholeCol && parsed.sc === parsed.ec) return `${indexToCol(parsed.sc)}:${indexToCol(parsed.ec)}`;
  if (parsed.wholeCol) return `${indexToCol(parsed.sc)}:${indexToCol(parsed.ec)}`;
  if (parsed.wholeRow && parsed.sr === parsed.er) return `${parsed.sr + 1}:${parsed.er + 1}`;
  if (parsed.wholeRow) return `${parsed.sr + 1}:${parsed.er + 1}`;
  return a1FromBounds(parsed.sr, parsed.sc, parsed.er, parsed.ec);
}

export function selectionKey(sel) {
  const sheet = String(sel?.sheet || 'Sheet1');
  const a1 = normalizeA1(sel?.a1 || 'A1');
  return `${sheet}!${a1}`;
}

/**
 * @param {unknown} raw
 * @returns {{ sheet: string, a1: string } | null}
 */
export function normalizeSelection(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parsed = parseA1(raw);
    const sheet = parsed.sheet || 'Sheet1';
    const a1 = normalizeA1(raw);
    if (!a1) return null;
    return { sheet, a1 };
  }
  if (typeof raw !== 'object') return null;
  const sheet = String(raw.sheet || parseA1(raw.a1 || '').sheet || 'Sheet1');
  const a1 = normalizeA1(raw.a1 || raw.range || 'A1');
  if (!a1) return null;
  return { sheet, a1 };
}

export function normalizeSelections(list, cap = 24) {
  const max = Math.max(1, Number(cap) || 24);
  const out = [];
  const seen = new Set();
  const src = Array.isArray(list) ? list : list ? [list] : [];
  for (const raw of src) {
    const sel = normalizeSelection(raw);
    if (!sel) continue;
    const key = selectionKey(sel);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sel);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Union incoming onto existing. Incoming keys already present are kept (no dup).
 * @param {unknown} existing
 * @param {unknown} incoming
 */
export function unionSelections(existing, incoming) {
  return normalizeSelections([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
}

/**
 * Replace ranges on `sheetName` with incoming; keep every other sheet.
 * @param {unknown} existing
 * @param {unknown} incoming
 * @param {string} sheetName
 */
export function replaceSheetSelections(existing, incoming, sheetName) {
  const sheet = String(sheetName || '');
  const keep = normalizeSelections(existing).filter((s) => s.sheet !== sheet);
  const next = normalizeSelections(incoming).map((s) => ({ ...s, sheet: s.sheet || sheet }));
  return normalizeSelections([...keep, ...next]);
}

export function dropSelection(existing, target) {
  const key = selectionKey(normalizeSelection(target) || {});
  return normalizeSelections(existing).filter((s) => selectionKey(s) !== key);
}

export function overviewFromSheets(sheets, extra = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const selections = normalizeSelections(extra.selections || extra.selection);
  const selection = selections[0] || extra.selection || null;
  return {
    sheets: list.map((s) => {
      const rows = Array.isArray(s.rows) ? s.rows : [];
      const used = usedBounds(rows);
      const headers = (rows[0] || []).slice(0, 24).map((h) => String(h == null ? '' : h).slice(0, 48));
      return {
        name: String(s.name || 'Sheet1'),
        rowCount: used.er + 1,
        columnCount: used.ec + 1,
        headers,
        usedRange: a1FromBounds(0, 0, used.er, used.ec),
        draft: isDraftSheetName(s.name)
      };
    }),
    ...extra,
    selections,
    selection: selection || null
  };
}

export function overviewFromWorkbookData(data, extra = {}) {
  return overviewFromSheets(workbookDataToSheets(data), extra);
}

/**
 * Compact sheet index for tool results — name + used rowCount only.
 * @param {unknown} source overview object, { sheets }, or AOA sheets[]
 * @returns {Array<{ name: string, rowCount: number }>}
 */
export function compactSheetList(source) {
  const list = Array.isArray(source)
    ? source
    : Array.isArray(source?.sheets)
      ? source.sheets
      : [];
  return list.map((s) => {
    const rows = Array.isArray(s?.rows) ? s.rows : null;
    const used = rows ? usedBounds(rows) : null;
    const named = Number(s?.rowCount);
    return {
      name: String(s?.name || 'Sheet1'),
      rowCount: Number.isFinite(named) && named > 0 ? named : used ? used.er + 1 : 0
    };
  });
}

/**
 * Full range for guest compute. Hard-fails when rows exceed cap — never silent truncate.
 * Omit a1 to dump the used range of the named (or first) sheet.
 */
export function snapshotSheetRange(data, a1, sheetName, cap = {}) {
  const maxRows = Math.max(1, Number(cap.maxRows) || SHEET_SNAPSHOT_MAX_ROWS);
  const sheets = workbookDataToSheets(data);
  const parsed = parseA1(a1 || '');
  const sheet = pickSheet(sheets, sheetName || parsed.sheet);
  const used = usedBounds(sheet.rows || []);
  const fallback = a1FromBounds(0, 0, used.er, used.ec);
  const ref = String(a1 || '').trim() || fallback;
  const full = readRangeFromSheets(sheets, ref, sheet.name);
  const rowCount = full.values.length;
  const columnCount = (full.values[0] || []).length;
  const headers = (full.values[0] || []).map((h) => (h == null ? '' : h));
  if (rowCount > maxRows) {
    return {
      ok: false,
      code: 'SNAPSHOT_TOO_LARGE',
      error: `snapshot exceeds ${maxRows} rows (${rowCount}); pass a smaller a1`,
      sheet: full.sheet,
      a1: full.a1,
      requested: full.a1,
      headers,
      rowCount,
      columnCount,
      sheetRowCount: used.er + 1
    };
  }
  return {
    ok: true,
    sheet: full.sheet,
    a1: full.a1,
    requested: full.a1,
    headers,
    values: full.values,
    rowCount,
    columnCount,
    sheetRowCount: used.er + 1
  };
}

/**
 * Capped inspect against full workbook model (values + v/f + validation/numfmt).
 */
export function inspectSheetSelection(data, a1, sheetName, cap = SHEET_INSPECT) {
  return inspectWorkbookRange(data, a1, sheetName, cap);
}

/**
 * Live-tab policy: cancel user mutations while an agent apply is in flight,
 * then (only if allowed) run the shipped apply path. Tests must call this,
 * not a reimplemented guard.
 */
export function interceptThenApply(data, commands, ev, runtime = {}, opts = {}) {
  if (evaluateBeforeCommand(ev, runtime).cancel) {
    return {
      ok: true,
      cancelled: true,
      data,
      applied: [],
      sheets: workbookDataToSheets(data),
      readback: null
    };
  }
  const applied = applyCommandsToWorkbookData(data, commands, opts);
  return { ...applied, cancelled: false };
}

/**
 * Named targets must exist. Unnamed targets keep the first/active sheet.
 * @returns {object|null}
 */
function pickSheet(sheets, name) {
  const list = Array.isArray(sheets) ? sheets : [];
  if (name) {
    return list.find((s) => String(s.name) === String(name)) || null;
  }
  return list[0] || { name: 'Sheet1', rows: [] };
}

function sheetNamesOf(sheets) {
  return (Array.isArray(sheets) ? sheets : []).map((s) => s.name);
}

export function noSuchSheetError(sheets, name) {
  const wanted = String(name);
  const available = sheetNamesOf(sheets);
  return {
    ok: false,
    code: 'NO_SUCH_SHEET',
    error: `sheet "${wanted}" does not exist`,
    available,
    hint: 'create it first via createSheet, or omit sheet to target the active one'
  };
}

function isEmptyGrid(values) {
  if (!Array.isArray(values) || !values.length) return true;
  return values.every((row) => {
    if (!Array.isArray(row)) return row == null || row === '';
    return row.length === 0;
  });
}

export function emptyGridError(field = 'values') {
  return {
    ok: false,
    code: 'BAD_INPUT',
    error: `${field} is required and must be a non-empty 2d array`,
    hint: `pass ${field} as a non-empty values[][] grid`
  };
}

const GRID_WRITE_OPS = new Set(['setValues2d', 'applyGrid']);

/** Guest JSON aliases — same `path` key as deck/web image src; valuesPath/from are explicit. */
export function gridPathFromCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return '';
  return String(cmd.path || cmd.valuesPath || cmd.from || cmd.scratchPath || '').trim();
}

function sheetCommandOp(cmd) {
  if (!cmd || typeof cmd !== 'object') return '';
  return String(cmd.op || cmd.type || cmd.command || '').trim();
}

function guestReadError(path, err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT/i.test(msg)) {
    return {
      ok: false,
      code: 'ENOENT',
      error: `grid file not found: ${path}`,
      hint: 'write JSON to /scratch or /artifacts via run, then pass that path'
    };
  }
  if (/FS_DENIED/i.test(msg)) {
    return {
      ok: false,
      code: 'FS_DENIED',
      error: msg,
      hint: 'path must be a session guest file under /scratch or /artifacts'
    };
  }
  return { ok: false, code: 'BAD_INPUT', error: msg, hint: 'pass path to a /scratch or /artifacts JSON grid' };
}

function parseGuestGridJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'grid JSON is invalid',
      hint: 'write a JSON array (values[][]) or {values:[][]} — do not retype cells'
    };
  }
  const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? parsed.values : null;
  if (isEmptyGrid(values)) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'grid JSON is empty or not a 2d array',
      hint: 'write a non-empty values[][] JSON file, then pass path — do not retype cells'
    };
  }
  return { ok: true, values };
}

export function loadGridFromGuestFs(fs, rawPath) {
  const p = String(rawPath || '').trim();
  if (!p) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'grid path is empty',
      hint: 'pass path / valuesPath / from to a /scratch or /artifacts JSON grid'
    };
  }
  if (!fs || (typeof fs.readFileBytes !== 'function' && typeof fs.readFile !== 'function')) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'guest FS unavailable for grid path',
      hint: 'sheet write resolves path on the host before apply'
    };
  }
  let text;
  try {
    if (typeof fs.readFileBytes === 'function') {
      const bytes = fs.readFileBytes(p);
      text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    } else {
      text = String(fs.readFile(p) ?? '');
    }
  } catch (err) {
    return guestReadError(p, err);
  }
  return parseGuestGridJson(text);
}

/**
 * Bind setValues2d / applyGrid to a guest JSON grid. Inline values win.
 * Fail-closed: missing file ENOENT, invalid/empty JSON BAD_INPUT.
 */
export function hydrateSheetGridCommands(fs, commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') {
      out.push(cmd);
      continue;
    }
    const op = sheetCommandOp(cmd);
    if (!GRID_WRITE_OPS.has(op) || !isEmptyGrid(cmd.values)) {
      out.push(cmd);
      continue;
    }
    const p = gridPathFromCommand(cmd);
    if (!p) {
      out.push(cmd);
      continue;
    }
    const loaded = loadGridFromGuestFs(fs, p);
    if (!loaded.ok) return loaded;
    out.push({ ...cmd, values: loaded.values });
  }
  return { ok: true, commands: out };
}

export function missingGridSourceError(op = 'setValues2d') {
  return {
    ok: false,
    code: 'BAD_INPUT',
    error: `${op} needs values[][] or a guest path`,
    hint: 'pass values, or path / valuesPath / from to /scratch or /artifacts JSON — do not retype cells'
  };
}

export function missingSheetOpError(op = '') {
  return {
    ok: false,
    code: 'BAD_INPUT',
    error: op ? `unknown sheet op "${op}"` : 'sheet command is missing op',
    hint: 'each commands[] item needs op (setRange / setFormula / setValues2d / applyGrid / …)'
  };
}

/** Fail-closed: missing/unknown op, or grid write with neither values nor path. */
export function malformedSheetWriteError(commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') return missingSheetOpError();
    const op = sheetCommandOp(cmd);
    if (!SHEET_OPS.includes(op)) return missingSheetOpError(op);
    if (GRID_WRITE_OPS.has(op) && isEmptyGrid(cmd.values) && !gridPathFromCommand(cmd)) {
      return missingGridSourceError(op);
    }
  }
  return null;
}

/**
 * Persist / live-unit snapshot: merge durable AOA into the Univer save()
 * so created sheets survive even if the raw unit lagged one paint.
 */
export function mergeWorkbookSnapshot(liveSnap, durableSheets) {
  const live = workbookDataToSheets(liveSnap);
  const merged = mergeSheetsForRead(durableSheets, live.length ? live : []);
  const base = liveSnap && typeof liveSnap === 'object' ? liveSnap : {};
  return patchWorkbookFromSheets(base, merged.length ? merged : live);
}

function applyFail(workbookData, sheets, applied, readback, draftInfo, fail) {
  const name = workbookData?.name || 'Workbook';
  const unitId = workbookData?.id;
  const data = patchWorkbookFromSheets(
    workbookData && typeof workbookData === 'object'
      ? workbookData
      : sheetsToWorkbookData(sheets, name, { id: unitId }),
    sheets
  );
  return { data, applied, readback, sheets, draft: draftInfo, ...fail, ok: false };
}

function ensureGrid(sheet, er, ec) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  while (rows.length <= er) rows.push([]);
  for (const row of rows) {
    while (row.length <= ec) row.push('');
  }
  sheet.rows = rows;
  return sheet;
}

export function cloneSheetRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r.slice() : []));
}

function lastUsedRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let r = list.length - 1; r >= 0; r--) {
    const row = list[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] != null && row[c] !== '') return r;
    }
  }
  return -1;
}

/**
 * File/AOA snapshot wins for rows Univer save() dropped; live non-empty prefix overlays edits.
 * @param {Array<{name:string, rows:any[][]}>} durable
 * @param {Array<{name:string, rows:any[][]}>} live
 */
export function mergeSheetsForRead(durable, live) {
  const base = Array.isArray(durable) ? durable : [];
  const over = Array.isArray(live) ? live : [];
  if (!base.length) return over.map((s) => ({ name: s.name, rows: cloneSheetRows(s.rows) }));
  const byLive = new Map(over.map((s) => [String(s.name), s]));
  const names = [];
  const seen = new Set();
  for (const s of over) {
    const n = String(s.name);
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  for (const s of base) {
    const n = String(s.name);
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  const byDur = new Map(base.map((s) => [String(s.name), s]));
  return names.map((name) => {
    const d = byDur.get(name);
    const l = byLive.get(name);
    if (!d) return { name, rows: cloneSheetRows(l?.rows) };
    if (!l) return { name, rows: cloneSheetRows(d.rows) };
    const rows = cloneSheetRows(d.rows);
    const liveLast = lastUsedRow(l.rows);
    for (let r = 0; r <= liveLast; r++) {
      rows[r] = Array.isArray(l.rows[r]) ? l.rows[r].slice() : [];
    }
    return { name, rows };
  });
}

export function isDraftSheetName(name) {
  return String(name || '').endsWith(DRAFT_SUFFIX);
}

export function sourceNameFromDraft(name) {
  const n = String(name || '');
  return isDraftSheetName(n) ? n.slice(0, -DRAFT_SUFFIX.length) : n;
}

export function draftNameFor(sourceName) {
  const base = String(sourceName || 'Sheet1');
  if (isDraftSheetName(base)) return base.slice(0, 31);
  const maxBase = Math.max(1, 31 - DRAFT_SUFFIX.length);
  return `${base.slice(0, maxBase)}${DRAFT_SUFFIX}`.slice(0, 31);
}

const DRAWING_OPS = new Set(['insertImage', 'insertCellImage', 'insertFloatImage']);

/** Point live Univer insertImage at the draft sheet the snapshot already used. */
export function retargetDrawingCommands(commands, draftSheet) {
  const draft = String(draftSheet || '').trim();
  return (Array.isArray(commands) ? commands : []).map((cmd) => {
    if (!cmd || typeof cmd !== 'object') return cmd;
    if (!DRAWING_OPS.has(String(cmd.op || ''))) return cmd;
    const sheet = draft || draftNameFor(cmd.sheet || '');
    return sheet ? { ...cmd, sheet } : cmd;
  });
}

export function ensureDraftSheet(sheets, sourceName) {
  const list = Array.isArray(sheets) && sheets.length
    ? sheets.map((s) => ({ name: s.name, rows: cloneSheetRows(s.rows) }))
    : [{ name: 'Sheet1', rows: [] }];
  const srcName = isDraftSheetName(sourceName) ? sourceNameFromDraft(sourceName) : String(sourceName || list[0]?.name || 'Sheet1');
  const draftName = draftNameFor(srcName);
  const original = pickSheet(list, srcName);
  const existing = list.find((s) => s.name === draftName);
  if (existing) {
    return { sheets: list, draftName, sourceName: original.name, created: false };
  }
  list.push({
    name: draftName,
    rows: cloneSheetRows(original.rows)
  });
  return { sheets: list, draftName, sourceName: original.name, created: true };
}

const STRUCTURAL_OPS = new Set([
  'reshapeSplit',
  'applyGrid',
  'insertRow',
  'insertCol',
  'deleteRow',
  'deleteCol',
  'sort',
  'ensureDraft'
]);

const TARGETED_WRITE_OPS = new Set([
  'setRange',
  'setFormula',
  'setValues2d',
  'applyGrid',
  'numberFormat',
  'insertImage',
  'insertCellImage',
  'insertFloatImage'
]);

/**
 * Commands with no a1 inherit the primary selection (hint, not a lock).
 * @param {object[]} commands
 * @param {unknown} selections
 */
export function fillMissingWriteTargets(commands, selections) {
  const primary = normalizeSelections(selections)[0];
  const list = normalizeCommands(commands);
  if (!primary) return list;
  return list.map((cmd) => {
    if (!TARGETED_WRITE_OPS.has(cmd.op)) return cmd;
    const raw = String(cmd.a1 || cmd.range || '').trim();
    if (raw) return cmd;
    return { ...cmd, a1: primary.a1, sheet: cmd.sheet || primary.sheet };
  });
}

/**
 * "添加到这里" often lands as a new row past used range. If the user has a
 * selection inside the table, retarget that write onto the selection.
 * @param {object[]} commands
 * @param {Array<{name:string, rows:any[][]}>} sheets
 * @param {unknown} selections
 */
export function retargetAppendWrites(commands, sheets, selections) {
  const primary = normalizeSelections(selections)[0];
  const list = normalizeCommands(commands);
  if (!primary) return list;
  const sel = parseA1(primary.a1);
  return list.map((cmd) => {
    if (!TARGETED_WRITE_OPS.has(cmd.op)) return cmd;
    const raw = String(cmd.a1 || cmd.range || '').trim();
    if (!raw) {
      return { ...cmd, a1: primary.a1, sheet: cmd.sheet || primary.sheet };
    }
    const parsed = parseA1(raw);
    if (parsed.wholeCol || parsed.wholeRow) return cmd;
    const sheet = pickSheet(sheets, cmd.sheet || parsed.sheet || primary.sheet);
    if (!sheet) return cmd;
    const used = usedBounds(sheet.rows || []);
    if (parsed.sr >= used.er + 1 && sel.sr <= used.er) {
      return {
        ...cmd,
        a1: primary.a1,
        sheet: primary.sheet,
        retargetedFrom: raw.includes('!') ? raw : `${sheet.name}!${raw}`
      };
    }
    return cmd;
  });
}

/**
 * @param {object[]} applied
 * @param {string} [draftName]
 * @returns {{ mode: 'full'|'ranges', marks: Array<{ op: string, a1: string, sheet: string }> }}
 */
export function dirtyRangesFromApplied(applied, draftName) {
  const list = (Array.isArray(applied) ? applied : []).filter((a) => {
    if (!a || !a.op) return false;
    if (!draftName) return true;
    return !a.sheet || a.sheet === draftName;
  });
  if (list.some((a) => STRUCTURAL_OPS.has(a.op) || !a.a1)) {
    return { mode: 'full', marks: [] };
  }
  const marks = list
    .filter((a) => a.a1)
    .map((a) => ({ op: a.op, a1: String(a.a1), sheet: draftName || a.sheet }));
  return marks.length ? { mode: 'ranges', marks } : { mode: 'full', marks: [] };
}

export function rewriteCommandsToDraft(commands, draftName) {
  const out = [];
  for (const cmd of normalizeCommands(commands)) {
    if (cmd.op === 'createWorkbook' || cmd.op === 'createSheet') continue;
    const next = { ...cmd, sheet: draftName };
    if (next.a1 && String(next.a1).includes('!')) {
      next.a1 = String(next.a1).slice(String(next.a1).lastIndexOf('!') + 1);
    }
    out.push(next);
  }
  return out;
}

function resolveSourceName(sheets, commands) {
  const list = Array.isArray(sheets) ? sheets : [];
  const existing = new Set(list.map((s) => String(s.name)));
  const liveOriginal = list.find((s) => !isDraftSheetName(s.name));
  for (const cmd of commands || []) {
    if (cmd.op === 'createSheet' || cmd.op === 'createWorkbook') continue;
    const n = cmd.sheet || parseA1(cmd.a1 || cmd.range || '').sheet;
    if (!n) continue;
    if (isDraftSheetName(n)) return sourceNameFromDraft(n);
    if (existing.has(String(n))) return String(n);
  }
  return liveOriginal?.name || list[0]?.name || 'Sheet1';
}

export function routeAgentWrites(sheets, commands) {
  const cmds = normalizeCommands(commands);
  const sourceName = resolveSourceName(sheets, cmds);
  const ensured = ensureDraftSheet(sheets, sourceName);
  const rewritten = rewriteCommandsToDraft(cmds, ensured.draftName);
  return {
    sheets: ensured.sheets,
    commands: rewritten,
    draftName: ensured.draftName,
    sourceName: ensured.sourceName,
    created: ensured.created
  };
}

export function mergeDraftIntoOriginal(sheets, sourceName) {
  const list = Array.isArray(sheets) ? sheets.map((s) => ({ name: s.name, rows: cloneSheetRows(s.rows) })) : [];
  const src = isDraftSheetName(sourceName) ? sourceNameFromDraft(sourceName) : String(sourceName || '');
  const draftName = draftNameFor(src || list.find((s) => !isDraftSheetName(s.name))?.name || 'Sheet1');
  const origName = src || sourceNameFromDraft(draftName);
  const draft = list.find((s) => s.name === draftName);
  const orig = list.find((s) => s.name === origName);
  if (!draft) return { sheets: list, merged: false, sourceName: origName, draftName };
  if (orig) orig.rows = cloneSheetRows(draft.rows);
  const next = list.filter((s) => s.name !== draftName);
  if (!orig) next.unshift({ name: origName, rows: cloneSheetRows(draft.rows) });
  return { sheets: next, merged: true, sourceName: origName, draftName };
}

export function discardDraftSheet(sheets, sourceName) {
  const list = Array.isArray(sheets) ? sheets.map((s) => ({ name: s.name, rows: cloneSheetRows(s.rows) })) : [];
  const src = isDraftSheetName(sourceName) ? sourceNameFromDraft(sourceName) : String(sourceName || '');
  const origName = src || list.find((s) => !isDraftSheetName(s.name))?.name || 'Sheet1';
  const draftName = draftNameFor(origName);
  return {
    sheets: list.filter((s) => s.name !== draftName),
    discarded: list.some((s) => s.name === draftName),
    sourceName: origName,
    draftName
  };
}

export function findDraftPair(sheets) {
  const list = Array.isArray(sheets) ? sheets : [];
  const draft = list.find((s) => isDraftSheetName(s.name));
  if (!draft) return null;
  const origName = sourceNameFromDraft(draft.name);
  const original = list.find((s) => s.name === origName) || list.find((s) => !isDraftSheetName(s.name));
  return { original, draft, sourceName: origName, draftName: draft.name };
}

export function readRangeFromSheets(sheets, a1, sheetName) {
  const parsed = parseA1(a1);
  const sheet = pickSheet(sheets, sheetName || parsed.sheet);
  const used = usedBounds(sheet.rows || []);
  const sr = parsed.wholeCol ? 0 : parsed.sr;
  const sc = parsed.wholeRow ? 0 : parsed.sc;
  const er = parsed.wholeCol ? used.er : parsed.er;
  const ec = parsed.wholeRow ? used.ec : parsed.ec;
  const values = [];
  for (let r = sr; r <= er; r++) {
    const row = [];
    for (let c = sc; c <= ec; c++) {
      row.push((sheet.rows[r] && sheet.rows[r][c]) ?? '');
    }
    values.push(row);
  }
  return {
    sheet: sheet.name,
    a1: a1FromBounds(sr, sc, er, ec),
    values
  };
}

function clipCell(v, maxCellChars) {
  if (v == null) return '';
  const str = typeof v === 'string' ? v : String(v);
  if (str.length <= maxCellChars) return v;
  return `${str.slice(0, maxCellChars)}…`;
}

export function capRangeRead(sheets, a1, sheetName, cap = SHEET_INSPECT) {
  const full = readRangeFromSheets(sheets, a1, sheetName);
  const maxRows = Math.max(1, Number(cap.maxRows) || SHEET_INSPECT.maxRows);
  const maxCols = Math.max(1, Number(cap.maxCols) || SHEET_INSPECT.maxCols);
  const maxCellChars = Math.max(8, Number(cap.maxCellChars) || SHEET_INSPECT.maxCellChars);
  const truncatedRows = full.values.length > maxRows;
  const truncatedCols = (full.values[0] || []).length > maxCols;
  const values = full.values.slice(0, maxRows).map((row) =>
    (row || []).slice(0, maxCols).map((v) => clipCell(v, maxCellChars))
  );
  const parsed = parseA1(full.a1);
  const shownR = Math.max(full.values.length ? 1 : 0, Math.min(full.values.length, maxRows));
  const shownC = Math.max((full.values[0] || []).length ? 1 : 0, Math.min((full.values[0] || []).length, maxCols));
  const er = parsed.sr + Math.max(shownR, 1) - 1;
  const ec = parsed.sc + Math.max(shownC, 1) - 1;
  let next;
  if (truncatedRows) next = a1FromBounds(parsed.sr + maxRows, parsed.sc, parsed.er, parsed.ec);
  else if (truncatedCols) next = a1FromBounds(parsed.sr, parsed.sc + maxCols, parsed.er, parsed.ec);
  const truncated = truncatedRows || truncatedCols;
  const sheetObj = pickSheet(sheets, full.sheet);
  const used = usedBounds(sheetObj.rows || []);
  return {
    sheet: full.sheet,
    a1: a1FromBounds(parsed.sr, parsed.sc, Math.max(parsed.sr, er), Math.max(parsed.sc, ec)),
    requested: full.a1,
    values,
    rowCount: full.values.length,
    sheetRowCount: used.er + 1,
    truncated,
    next: truncated ? next : undefined,
    note: truncated ? `truncated to ${maxRows} rows × ${maxCols} cols; pass next or a smaller a1` : undefined
  };
}

export function sampleReadback(readback, cap = { maxRows: 8, maxCols: 16, maxCellChars: 160 }) {
  if (!readback) return null;
  const rows = Array.isArray(readback.values) ? readback.values : [];
  const maxRows = Math.max(1, Number(cap.maxRows) || 8);
  const maxCols = Math.max(1, Number(cap.maxCols) || 16);
  const maxCellChars = Math.max(8, Number(cap.maxCellChars) || 160);
  const truncated = rows.length > maxRows || (rows[0] || []).length > maxCols;
  const values = rows.slice(0, maxRows).map((row) =>
    (row || []).slice(0, maxCols).map((v) => clipCell(v, maxCellChars))
  );
  return {
    sheet: readback.sheet,
    a1: readback.a1,
    values,
    sample: values,
    rowCount: rows.length,
    truncated: truncated || undefined
  };
}

function setCell(sheet, r, c, value) {
  ensureGrid(sheet, r, c);
  sheet.rows[r][c] = value == null ? '' : value;
}

export function normalizeCommands(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') continue;
    const op = String(cmd.op || cmd.type || cmd.command || '').trim();
    if (!SHEET_OPS.includes(op)) continue;
    out.push({ ...cmd, op });
  }
  return out;
}

/** Classify insertImage src: data URL, http(s), webItem id, 图片N handle, or unknown. */
export function classifySheetImageSrc(src) {
  const s = String(src || '').trim();
  if (!s) return { kind: 'empty', src: '' };
  if (/^data:image\//i.test(s)) return { kind: 'dataUrl', src: s };
  if (/^https?:\/\//i.test(s) || s.startsWith('blob:')) return { kind: 'url', src: s };
  if (/^artifact:\/\/bound\//i.test(s)) {
    const ref = s.replace(/^artifact:\/\/bound\//i, '').trim();
    return { kind: 'handle', src: s, ref };
  }
  if (/^wi_/i.test(s)) return { kind: 'webItem', src: s, ref: s };
  if (/^(图片|image|img|screenshot|截图)\s*\d+$/i.test(s)) return { kind: 'handle', src: s, ref: s };
  return { kind: 'unknown', src: s, ref: s };
}

function alignFields(parts, n, joinDelim) {
  const count = Math.max(1, n | 0);
  const out = Array(count).fill('');
  if (!parts.length) return out;
  if (parts.length === count) return parts.slice();
  if (parts.length > count) {
    for (let i = 0; i < count - 1; i++) out[i] = parts[i];
    out[count - 1] = parts.slice(count - 1).join(joinDelim || '');
    return out;
  }
  out[0] = parts[0];
  if (parts.length >= 2 && count >= 2) out[count - 1] = parts[parts.length - 1];
  for (let i = 1; i < parts.length - 1 && i < count - 1; i++) out[i] = parts[i];
  return out;
}

function reshapeSplitOnSheet(sheet, cmd) {
  const itemDelim = cmd.itemDelim;
  if (itemDelim == null || String(itemDelim) === '') {
    return { error: 'reshapeSplit requires itemDelim' };
  }
  const delim = String(itemDelim);
  const fieldDelim = cmd.fieldDelim != null && String(cmd.fieldDelim) !== '' ? String(cmd.fieldDelim) : null;
  const mode = String(cmd.mode || 'expand') === 'wrap' ? 'wrap' : 'expand';
  const colRef = String(cmd.column || cmd.a1 || 'A');
  const parsed = parseA1(colRef.includes('!') ? colRef : colRef);
  const sc = parsed.sc;
  const headers = Array.isArray(cmd.headers) ? cmd.headers.map((h) => String(h)) : null;
  const fieldCount = headers && headers.length ? headers.length : fieldDelim ? 2 : 1;
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const head = rows[0] ? rows[0].slice() : [];
  const newHead = head.slice(0, sc);
  if (headers && headers.length) newHead.push(...headers);
  else newHead.push(head[sc] == null ? '' : head[sc]);
  newHead.push(...head.slice(sc + 1));

  function fieldsOf(item) {
    const raw = item == null ? '' : String(item).trim();
    if (!fieldDelim) return alignFields([raw], fieldCount, '');
    return alignFields(
      raw.split(fieldDelim).map((p) => String(p).trim()),
      fieldCount,
      fieldDelim
    );
  }

  const out = [newHead];
  const dataRows = rows.slice(1);
  for (const row of dataRows) {
    const src = Array.isArray(row) ? row : [];
    const cell = src[sc] == null ? '' : String(src[sc]);
    const items =
      cell.trim() === ''
        ? ['']
        : cell
            .split(delim)
            .map((part) => String(part).trim())
            .filter((part, i, arr) => part !== '' || arr.length === 1);
    const left = src.slice(0, sc);
    const right = src.slice(sc + 1);
    if (mode === 'wrap') {
      const buckets = Array.from({ length: fieldCount }, () => []);
      for (const item of items) {
        const fields = fieldsOf(item);
        for (let i = 0; i < fieldCount; i++) buckets[i].push(fields[i] == null ? '' : String(fields[i]));
      }
      out.push([...left, ...buckets.map((b) => b.join('\n')), ...right]);
    } else {
      const use = items.length ? items : [''];
      for (const item of use) {
        out.push([...left, ...fieldsOf(item), ...right]);
      }
    }
  }
  sheet.rows = out;
  const used = usedBounds(out);
  return {
    a1: a1FromBounds(0, 0, used.er, used.ec),
    rowCount: out.length
  };
}

function paintGrid(sheet, sr, sc, grid) {
  const rows = Array.isArray(grid) ? grid : [];
  for (let r = 0; r < rows.length; r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [rows[r]];
    for (let c = 0; c < row.length; c++) setCell(sheet, sr + r, sc + c, row[c]);
  }
  return a1FromBounds(
    sr,
    sc,
    sr + Math.max(rows.length - 1, 0),
    sc + Math.max((rows[0] || []).length - 1, 0)
  );
}

/**
 * @param {object} workbookData
 * @param {object[]} commands
 * @param {{ agentWrite?: boolean, selections?: unknown, inPlace?: boolean, fs?: object }} [opts]
 * @returns {{ data: object, applied: object[], readback: object|null, sheets: object[], error?: string }}
 */
export function applyCommandsToWorkbookData(workbookData, commands, opts = {}) {
  let sheets = workbookDataToSheets(workbookData);
  if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
  const applied = [];
  let readback = null;
  const name = workbookData?.name || 'Workbook';
  const unitId = workbookData?.id;
  const agentWrite = opts.agentWrite !== false;
  const inPlace = opts.inPlace === true;
  let draftInfo = null;
  const malformed = malformedSheetWriteError(commands);
  if (malformed) {
    return applyFail(workbookData, sheets, applied, readback, draftInfo, malformed);
  }
  let rawList = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  if (opts.fs) {
    const hydrated = hydrateSheetGridCommands(opts.fs, rawList);
    if (!hydrated.ok) {
      return applyFail(workbookData, sheets, applied, readback, draftInfo, hydrated);
    }
    rawList = hydrated.commands;
  }
  let list = normalizeCommands(rawList);

  if (agentWrite) {
    list = fillMissingWriteTargets(list, opts.selections);
    list = retargetAppendWrites(list, sheets, opts.selections);
    if (inPlace) {
      const src = resolveSourceName(sheets, list);
      draftInfo = { sheet: src, source: src, inPlace: true };
    } else {
      const routed = routeAgentWrites(sheets, list);
      sheets = routed.sheets;
      list = routed.commands;
      draftInfo = { sheet: routed.draftName, source: routed.sourceName };
      if (routed.created) applied.push({ op: 'ensureDraft', sheet: routed.draftName, from: routed.sourceName });
      if (!list.length) {
        const draft = pickSheet(sheets, routed.draftName);
        const used = usedBounds(draft.rows || []);
        readback = {
          sheet: routed.draftName,
          a1: a1FromBounds(0, 0, Math.min(used.er, 8), used.ec),
          values: cloneSheetRows((draft.rows || []).slice(0, 9))
        };
      }
    }
  }

  for (const cmd of list) {
    if (cmd.op === 'createWorkbook') {
      if (agentWrite) {
        applied.push({ op: cmd.op, skipped: true, reason: 'unit-exists' });
        continue;
      }
      const seeded = Array.isArray(cmd.sheets) && cmd.sheets.length
        ? cmd.sheets.map((s) => ({
            name: String(s.name || 'Sheet1'),
            rows: Array.isArray(s.rows) ? s.rows : []
          }))
        : [{ name: 'Sheet1', rows: [] }];
      sheets = seeded;
      applied.push({ op: cmd.op, sheets: seeded.length });
      continue;
    }
    if (cmd.op === 'createSheet') {
      const n = String(cmd.name || `Sheet${sheets.length + 1}`);
      if (!sheets.some((s) => s.name === n)) sheets.push({ name: n, rows: [] });
      applied.push({ op: cmd.op, name: n, sheet: n });
      const created = pickSheet(sheets, n);
      readback = { sheet: n, a1: 'A1', values: cloneSheetRows((created.rows || []).slice(0, 8)) };
      continue;
    }
    if (cmd.op === 'renameSheet') {
      const fromName = cmd.sheet || cmd.from;
      const sh = pickSheet(sheets, fromName);
      if (!sh) {
        return applyFail(workbookData, sheets, applied, readback, draftInfo, noSuchSheetError(sheets, fromName));
      }
      const prev = sh.name;
      sh.name = String(cmd.name || cmd.to || sh.name);
      applied.push({ op: cmd.op, from: prev, name: sh.name, sheet: sh.name });
      continue;
    }

    if (cmd.op === 'setValues2d' || cmd.op === 'applyGrid') {
      if (isEmptyGrid(cmd.values)) {
        const unresolved = gridPathFromCommand(cmd);
        return applyFail(
          workbookData,
          sheets,
          applied,
          readback,
          draftInfo,
          unresolved
            ? {
                ok: false,
                code: 'BAD_INPUT',
                error: `${cmd.op} path was not resolved to a grid`,
                hint: 'host loads path/valuesPath/from from /scratch or /artifacts before apply'
              }
            : emptyGridError('values')
        );
      }
    }

    const parsed = parseA1(cmd.a1 || cmd.range || cmd.column || 'A1');
    const wanted = cmd.sheet || parsed.sheet;
    const sheet = pickSheet(sheets, wanted);
    if (!sheet) {
      return applyFail(workbookData, sheets, applied, readback, draftInfo, noSuchSheetError(sheets, wanted));
    }
    const used = usedBounds(sheet.rows || []);
    let sr = parsed.wholeCol ? 0 : parsed.sr;
    let sc = parsed.wholeRow ? 0 : parsed.sc;
    let er = parsed.wholeCol ? used.er : parsed.er;
    let ec = parsed.wholeRow ? used.ec : parsed.ec;
    if (parsed.wholeCol && used.er < 0) er = Math.max((sheet.rows || []).length - 1, 0);
    if (parsed.wholeCol && used.er >= 1) sr = Math.max(sr, 1);

    if (cmd.op === 'reshapeSplit') {
      const result = reshapeSplitOnSheet(sheet, cmd);
      if (result.error) {
        return {
          data: patchWorkbookFromSheets(
            workbookData && typeof workbookData === 'object' ? workbookData : sheetsToWorkbookData(sheets, name, { id: unitId }),
            sheets
          ),
          applied,
          readback,
          sheets,
          error: result.error,
          ok: false
        };
      }
      applied.push({ op: cmd.op, sheet: sheet.name, a1: result.a1, rowCount: result.rowCount });
      readback = readRangeFromSheets(sheets, result.a1, sheet.name);
      continue;
    }

    if (cmd.op === 'setRange' || cmd.op === 'setFormula') {
      const value = cmd.op === 'setFormula'
        ? (String(cmd.formula || cmd.value || '').startsWith('=')
            ? String(cmd.formula || cmd.value)
            : `=${cmd.formula || cmd.value || ''}`)
        : cmd.value;
      for (let r = sr; r <= er; r++) {
        for (let c = sc; c <= ec; c++) setCell(sheet, r, c, value);
      }
      applied.push({ op: cmd.op, sheet: sheet.name, a1: a1FromBounds(sr, sc, er, ec) });
      readback = readRangeFromSheets(sheets, a1FromBounds(sr, sc, er, ec), sheet.name);
      continue;
    }
    if (cmd.op === 'setValues2d' || cmd.op === 'applyGrid') {
      const grid = Array.isArray(cmd.values) ? cmd.values : [];
      const a1 = paintGrid(sheet, sr, sc, grid);
      applied.push({ op: cmd.op, sheet: sheet.name, a1 });
      readback = readRangeFromSheets(sheets, a1, sheet.name);
      continue;
    }
    if (cmd.op === 'insertRow') {
      const at = Number.isFinite(Number(cmd.index)) ? Number(cmd.index) : sr;
      const n = Math.max(1, Number(cmd.count) || 1);
      ensureGrid(sheet, at, 0);
      for (let i = 0; i < n; i++) sheet.rows.splice(at, 0, []);
      applied.push({ op: cmd.op, sheet: sheet.name, index: at, count: n });
      continue;
    }
    if (cmd.op === 'insertCol') {
      const at = Number.isFinite(Number(cmd.index)) ? Number(cmd.index) : sc;
      const n = Math.max(1, Number(cmd.count) || 1);
      for (const row of sheet.rows || []) {
        for (let i = 0; i < n; i++) row.splice(at, 0, '');
      }
      applied.push({ op: cmd.op, sheet: sheet.name, index: at, count: n });
      continue;
    }
    if (cmd.op === 'deleteRow') {
      const at = Number.isFinite(Number(cmd.index)) ? Number(cmd.index) : sr;
      const n = Math.max(1, Number(cmd.count) || 1);
      (sheet.rows || []).splice(at, n);
      applied.push({ op: cmd.op, sheet: sheet.name, index: at, count: n });
      continue;
    }
    if (cmd.op === 'deleteCol') {
      const at = Number.isFinite(Number(cmd.index)) ? Number(cmd.index) : sc;
      const n = Math.max(1, Number(cmd.count) || 1);
      for (const row of sheet.rows || []) row.splice(at, n);
      applied.push({ op: cmd.op, sheet: sheet.name, index: at, count: n });
      continue;
    }
    if (cmd.op === 'sort') {
      const col = Number.isFinite(Number(cmd.column)) ? Number(cmd.column) : sc;
      const header = cmd.hasHeader !== false;
      const dir = String(cmd.direction || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      const rows = sheet.rows || [];
      const head = header && rows.length ? rows[0] : null;
      const body = header ? rows.slice(1) : rows.slice();
      body.sort((a, b) => {
        const av = a[col] == null ? '' : a[col];
        const bv = b[col] == null ? '' : b[col];
        const an = Number(av);
        const bn = Number(bv);
        if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
        return String(av).localeCompare(String(bv), 'zh') * dir;
      });
      sheet.rows = head ? [head, ...body] : body;
      applied.push({ op: cmd.op, sheet: sheet.name, column: col });
      continue;
    }
    if (cmd.op === 'numberFormat') {
      applied.push({
        op: cmd.op,
        sheet: sheet.name,
        a1: a1FromBounds(sr, sc, er, ec),
        pattern: String(cmd.pattern || cmd.format || '0%')
      });
      continue;
    }
    if (cmd.op === 'insertImage' || cmd.op === 'insertCellImage' || cmd.op === 'insertFloatImage') {
      const src = String(cmd.src || cmd.url || cmd.value || '').trim();
      const a1 = a1FromBounds(sr, sc, er, ec);
      const drawing = cmd.op === 'insertFloatImage' ? 'float' : 'cell';
      const classified = classifySheetImageSrc(src);
      const marker =
        classified.kind === 'dataUrl' || classified.kind === 'url'
          ? '🖼'
          : '';
      if (marker) setCell(sheet, sr, sc, marker);
      applied.push({
        op: cmd.op,
        sheet: sheet.name,
        a1,
        src: classified.kind === 'dataUrl' ? 'data:image' : src,
        srcKind: classified.kind,
        drawing,
        warning: XLSX_DRAWING_EXPORT_WARNING
      });
      readback = readRangeFromSheets(sheets, a1, sheet.name);
      continue;
    }
  }

  const data = patchWorkbookFromSheets(
    workbookData && typeof workbookData === 'object'
      ? { ...workbookData, id: unitId || workbookData.id, name }
      : sheetsToWorkbookData(sheets, name, { id: unitId }),
    sheets
  );
  if (!readback && sheets[0]) {
    const target = sheets.find((s) => isDraftSheetName(s.name)) || sheets[0];
    const used = usedBounds(target.rows || []);
    readback = readRangeFromSheets(sheets, a1FromBounds(0, 0, Math.min(used.er, 8), used.ec), target.name);
  }
  if (readback) readback = sampleReadback(readback);
  return { data, applied, readback, sheets, ok: true, draft: draftInfo };
}

export function workbookDataCell(data, r, c, sheetIndex = 0) {
  const sheets = workbookDataToSheets(data);
  const sh = sheets[sheetIndex];
  if (!sh) return '';
  return cellToAoaValue({ v: (sh.rows[r] || [])[c] });
}

export { aoaValueToCell, sheetsToWorkbookData, workbookDataToSheets };
