import { workspaceRpc } from '../agent/vnext/host/workspaceClient.js';
/**
 * Live Univer workbook for csv / tsv / xlsx artifacts.
 * Selection is ambient hint only; the open workbook is fully writable.
 */

import {
  aoaToCsv,
  bytesToUtf8,
  parseDelimited,
  sheetKindFromArtifact,
  sheetsToWorkbookData,
  workbookDataToSheets,
  gridExtentFromUsed,
  growGridExtent,
  encodeUtf8Csv
} from './sheetCodec.js';
import { classifyOpenArtifact, isUtf8OpenKind, previewEntryForKind } from '../agent/vnext/sessionWorkspace/openClassify.js';
import {
  ARTIFACT_TRUNCATED,
  fetchCompleteArtifact
} from '../agent/vnext/sessionWorkspace/artifactDownload.js';
import { pushPromptCheckpoint, undoPrompt, redoPrompt } from './sheetPromptUndo.js';
import {
  applyCommandsToWorkbookData,
  classifySheetImageSrc,
  capRangeRead,
  cloneSheetRows,
  discardDraftSheet,
  dirtyRangesFromApplied,
  dropSelection,
  findDraftPair,
  indexToCol,
  mergeDraftIntoOriginal,
  mergeWorkbookSnapshot,
  normalizeA1,
  normalizeSelections,
  overviewFromSheets,
  inspectSheetSelection,
  parseA1,
  readRangeFromSheets,
  snapshotSheetRange,
  mergeSheetsForRead,
  replaceSheetSelections,
  retargetDrawingCommands,
  sampleReadback,
  selectionKey,
  sourceNameFromDraft,
  unionSelections
} from '../agent/vnext/sessionWorkspace/sheetApply.js';
import { decodeDataUrl } from '../agent/vnext/sessionWorkspace/itemPixels.js';
import {
  appendCommandLog,
  cloneWorkbookData,
  evaluateBeforeCommand,
  extractWorkbookSnapshot,
  injectWorkbookSnapshot,
  pastePayloadAllowed,
  shouldReinsertXlsxImages,
  FROM_AGENT
} from './sheetModel.js';
import { rewriteWorkbookImages } from './durableImage.js';
import { applyOfficeDocumentLang, officeUiLang, persistOfficeUiLang } from './officeLocale.js';
import { installOfficeShortcuts, isTypingTarget, univerSheetZoom } from './officeShortcuts.js';
import { closeOfficeHelp, mountOfficeHelp } from './officeHelp.js';
import { handleWorkTabPickerMessage, reportPickerState } from './workTabPicker.js';
import { mountOfficeSelBubble, officeSelCopyLabel } from './officeSelBubble.js';

function qs(name) {
  try {
    return new URL(location.href).searchParams.get(name) || '';
  } catch {
    return '';
  }
}

const sessionId = qs('sessionId');
const artifactId = qs('artifactId') || (qs('ids') || '').split(',')[0];

let univerAPI = null;
let univer = null;
let kind = 'csv';
let fileName = 'sheet.csv';
let mimeType = 'text/csv';
let saveTimer = 0;
let saving = false;
let savePromise = null;
let saveRequested = false;
let editRevision = 0;
let artifactRevision = 0;
let applying = false;
let dirty = false;
/** @type {Array<{ id: string, params?: unknown, at: number }>} */
let commandLog = [];
let sheetHostPlugin = null;
/** @type {Array<{ promptId?: string, sheets: object[] }>} */
let undoStack = [];
/** @type {Array<{ promptId?: string, sheets: object[] }>} */
let redoStack = [];
let lastSelection = null;
/** Cross-sheet accumulated ranges. Native Univer selection is per-sheet. */
let pinnedSelections = [];
let addSelectHeld = false;
let addSelectUntil = 0;
/** AOA from the file / last host apply. Univer save() can drop trailing rows. */
let durableSheets = null;
let pickActive = false;
/** @type {ReturnType<typeof mountOfficeSelBubble>|null} */
let selBubble = null;


function boot(msg, isError = false) {
  const el = document.getElementById('boot');
  if (!el) return;
  el.hidden = false;
  el.className = isError ? 'error' : '';
  el.textContent = msg;
}

function setStatus(msg) {
  const el = document.getElementById('sheetToast') || document.getElementById('status');
  if (!el) return;
  const text = String(msg || '').trim();
  el.hidden = !text;
  el.textContent = text;
  window.clearTimeout(setStatus._t);
  if (text) {
    setStatus._t = window.setTimeout(() => {
      if (el.id === 'sheetToast') el.hidden = true;
    }, 2800);
  }
}

function setSaveState(cls, label) {
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  btn.classList.remove('is-busy', 'is-done');
  if (cls) btn.classList.add(cls);
  if (label) btn.textContent = label;
}

function sheetUiLang() {
  return officeUiLang();
}

function persistSheetUiLang(lang) {
  persistOfficeUiLang(lang);
}

let ribbonInstalled = false;

function ribbonLocales(lang) {
  if (lang === 'en') {
    return {
      browserbot: {
        export: 'Export',
        excel: 'Excel (.xlsx)',
        csv: 'CSV',
        tsv: 'TSV',
        langMenu: 'Language',
        langZh: '中文',
        langEn: 'English',
        undo: 'Undo this prompt',
        redo: 'Redo this prompt',
        undoToast: 'Agent updated the sheet for this prompt',
        undoToastMany: 'Agent updated the sheet for this prompt · {0} can be undone',
        undoDone: 'Undid this prompt',
        redoDone: 'Redid this prompt'
      }
    };
  }
  return {
    browserbot: {
      export: '导出',
      excel: 'Excel (.xlsx)',
      csv: 'CSV',
      tsv: 'TSV',
      langMenu: '语言',
      langZh: '中文',
      langEn: 'English',
      undo: '撤销这次提问',
      redo: '重做这次提问',
      undoToast: 'Agent 已按这次提问改了表格',
      undoToastMany: 'Agent 已按这次提问改了表格 · 还可撤销 {0} 次',
      undoDone: '已撤销这次提问',
      redoDone: '已重做这次提问'
    }
  };
}

function applyUniverLocale(lang) {
  persistSheetUiLang(lang);
  applyOfficeDocumentLang(lang);
  const runtime = window.__browserBotSheetRuntime;
  if (!univerAPI || !runtime) return;
  const loc = lang === 'en' ? runtime.LocaleType.EN_US : runtime.LocaleType.ZH_CN;
  try {
    univerAPI.setLocale?.(loc);
  } catch {
    /* */
  }
}

function ribbonCommandService() {
  if (univerAPI?._commandService?.registerCommand) return univerAPI._commandService;
  try {
    const svc = univerAPI?._injector?.get?.('univer.core.command-service');
    if (svc?.registerCommand) return svc;
  } catch {
    /* facade variance */
  }
  return null;
}

function registerRibbonCommand(id, handler) {
  const svc = ribbonCommandService();
  if (!svc) return false;
  try {
    if (svc.hasCommand?.(id)) return true;
    svc.registerCommand({
      id,
      type: 0,
      handler: () => {
        handler();
        return true;
      }
    });
    return true;
  } catch (err) {
    console.warn('[sheet] registerCommand failed', id, err);
    return false;
  }
}

function appendRibbonDropdown(parent) {
  univerAPI
    .createSubmenu({
      id: parent.id,
      title: parent.title,
      tooltip: parent.tooltip || parent.title,
      icon: parent.icon,
      order: parent.order
    })
    .appendTo('ribbon.start.others');
  for (const child of parent.children) {
    registerRibbonCommand(child.id, child.action);
    univerAPI
      .createMenu({
        id: child.id,
        title: child.title,
        action: child.id
      })
      .appendTo(parent.id);
  }
}

function installRibbonMenus() {
  if (ribbonInstalled) return true;
  if (!univerAPI?.createMenu || !univerAPI?.createSubmenu) return false;
  try {
    appendRibbonDropdown({
      id: 'browserbot.export',
      title: 'browserbot.export',
      tooltip: 'browserbot.export',
      icon: 'ExportIcon',
      order: 10,
      children: [
        { id: 'browserbot.export.xlsx', title: 'browserbot.excel', action: () => downloadNow('xlsx') },
        { id: 'browserbot.export.csv', title: 'browserbot.csv', action: () => downloadNow('csv') },
        { id: 'browserbot.export.tsv', title: 'browserbot.tsv', action: () => downloadNow('tsv') }
      ]
    });
    appendRibbonDropdown({
      id: 'browserbot.lang',
      title: 'browserbot.langMenu',
      tooltip: 'browserbot.langMenu',
      order: 11,
      children: [
        { id: 'browserbot.lang.zh', title: 'browserbot.langZh', action: () => applyUniverLocale('zh') },
        { id: 'browserbot.lang.en', title: 'browserbot.langEn', action: () => applyUniverLocale('en') }
      ]
    });
    univerAPI
      .createMenu({
        id: 'browserbot.undo-agent',
        title: 'browserbot.undo',
        tooltip: 'browserbot.undo',
        icon: 'UndoIcon',
        order: 12,
        action: () => void undoLastAgentEdit()
      })
      .appendTo('ribbon.start.others');
    univerAPI
      .createMenu({
        id: 'browserbot.redo-agent',
        title: 'browserbot.redo',
        tooltip: 'browserbot.redo',
        icon: 'RedoIcon',
        order: 13,
        action: () => void redoLastAgentEdit()
      })
      .appendTo('ribbon.start.others');
    ribbonInstalled = true;
    return true;
  } catch (err) {
    console.warn('[sheet] Univer createMenu failed', err);
    return false;
  }
}

function scheduleRibbonMenus() {
  if (installRibbonMenus()) return;
  try {
    univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, (params) => {
      const stage = params?.stage;
      const Stages = univerAPI.Enum?.LifecycleStages;
      if (!Stages || stage === Stages.Rendered || stage === Stages.Steady) {
        installRibbonMenus();
      }
    });
  } catch {
    window.setTimeout(() => installRibbonMenus(), 0);
  }
}

function bindPastePolicy() {
  const ev = univerAPI?.Event?.BeforeClipboardPaste || univerAPI?.Event?.ClipboardPasteBefore;
  if (!ev) return { dispose() {} };
  try {
    const sub = univerAPI.addEvent(ev, (params) => {
      const html = String(params?.html || params?.text || params?.clipboardText || '');
      if (!pastePayloadAllowed(html)) {
        if (params) params.cancel = true;
        return false;
      }
      return true;
    });
    return { dispose: () => sub?.dispose?.() };
  } catch {
    return { dispose() {} };
  }
}

function bindCommandPolicy() {
  const before =
    univerAPI?.Event?.BeforeCommandExecute ||
    univerAPI?.Event?.CommandExecuting ||
    univerAPI?.Event?.BeforeCommand;
  const disposers = [];
  if (before) {
    try {
      const sub = univerAPI.addEvent(before, (ev) => {
        const decision = evaluateBeforeCommand(ev, { applying });
        if (decision.cancel) {
          if (ev) ev.cancel = true;
          return false;
        }
        return true;
      });
      disposers.push(() => sub?.dispose?.());
    } catch {
      /* older facade */
    }
  }
  return {
    dispose() {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* */
        }
      }
    }
  };
}

function installSheetPlugin() {
  try {
    sheetHostPlugin?.dispose?.();
  } catch {
    /* previous instance */
  }
  sheetHostPlugin = null;
  const paste = bindPastePolicy();
  const cmds = bindCommandPolicy();
  installRibbonMenus();
  sheetHostPlugin = {
    name: 'SheetHost',
    dispose() {
      paste.dispose();
      cmds.dispose();
    }
  };
  return sheetHostPlugin;
}

function disposeUniverRuntime() {
  try {
    sheetHostPlugin?.dispose?.();
  } catch {
    /* */
  }
  sheetHostPlugin = null;
  try {
    univerAPI?.getActiveWorkbook?.()?.dispose?.();
  } catch {
    /* */
  }
  try {
    univerAPI?.dispose?.();
  } catch {
    /* */
  }
  try {
    univer?.dispose?.();
  } catch {
    /* */
  }
  univerAPI = null;
  univer = null;
}

function b64ToBytes(b64) {
  const s = String(b64 || '');
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function currentSheets() {
  const snap = univerAPI?.getActiveWorkbook?.()?.save?.() || null;
  const live = workbookDataToSheets(snap);
  const liveList = live.length ? live : [{ name: 'Sheet1', rows: [] }];
  if (!durableSheets?.length) return liveList;
  return mergeSheetsForRead(durableSheets, liveList);
}

function currentBytes() {
  const sheets = currentSheets();
  if (kind === 'xlsx') {
    return window.__browserBotSheetRuntime.writeXlsxBytes(sheets);
  }
  const delim = kind === 'tsv' ? '\t' : ',';
  const text = aoaToCsv(sheets[0]?.rows || [], delim);
  return new TextEncoder().encode(text);
}

function promoteToXlsx() {
  if (kind === 'xlsx') return;
  kind = 'xlsx';
  fileName = String(fileName || 'sheet').replace(/\.(csv|tsv)$/i, '') + '.xlsx';
  mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

async function bytesForXlsxExport(prefetched = {}) {
  const runtime = window.__browserBotSheetRuntime;
  let snap =
    prefetched.snap || univerAPI?.getActiveWorkbook?.()?.save?.() || snapshotData();
  const images = prefetched.images || (await collectLiveSheetImages());
  if (snap && images.length) {
    snap = rewriteWorkbookImages(cloneWorkbookData(snap), images);
  }
  let bytes;
  if (runtime?.writeWorkbookXlsxBytes && snap) {
    bytes = runtime.writeWorkbookXlsxBytes(snap, images);
  } else if (runtime?.writeXlsxBytes) {
    bytes = runtime.writeXlsxBytes(currentSheets(), images);
  } else {
    bytes = currentBytes();
  }
  if (snap) bytes = injectWorkbookSnapshot(bytes, snap);
  return bytes;
}

function persistSnapshot() {
  const saved = univerAPI?.getActiveWorkbook?.()?.save?.() || snapshotData();
  return mergeWorkbookSnapshot(saved, durableSheets);
}

async function bytesForPersist() {
  const runtime = window.__browserBotSheetRuntime;
  const images = await collectLiveSheetImages();
  const snap = persistSnapshot();
  if (images.length || snap) promoteToXlsx();
  if (kind === 'xlsx' && (runtime?.writeWorkbookXlsxBytes || runtime?.writeXlsxBytes)) {
    return bytesForXlsxExport({ snap, images });
  }
  const delim = kind === 'tsv' ? '\t' : ',';
  const text = aoaToCsv(currentSheets()[0]?.rows || [], delim);
  return new TextEncoder().encode(text);
}

async function saveNow(reason = 'save') {
  if (!univerAPI) return { ok: false, error: 'spreadsheet is not ready' };
  saveRequested = true;
  if (saving) return savePromise;
  saving = true;
  savePromise = drainSaves(reason);
  return savePromise;
}

async function drainSaves(reason) {
  setSaveState('is-busy', '写入中…');
  setStatus('写入中…');
  try {
    while (saveRequested) {
      saveRequested = false;
      const revision = editRevision;
      const bytes = await bytesForPersist();
      const saved = await workspaceRpc('updateArtifact', {
        sessionId,
        artifactId,
        expectedRevision: artifactRevision,
        mimeType,
        name: fileName,
        base64: bytesToBase64(bytes)
      });
      artifactRevision = Number(saved?.artifact?.revision) || artifactRevision;
      dirty = editRevision !== revision;
      if (dirty) saveRequested = true;
    }
    setStatus(reason === 'autosave' ? '已自动保存' : `已写入工作区 · ${fileName}`);
    setSaveState('is-done', '已写入');
    try {
      chrome.runtime.sendMessage({
        action: 'artifact_written',
        sessionId,
        artifactId,
        name: fileName
      });
    } catch {
      /* sidepanel may be closed */
    }
    window.setTimeout(() => setSaveState('', '保存'), 1400);
    return { ok: true };
  } catch (e) {
    dirty = true;
    setSaveState('', '保存');
    setStatus(e instanceof Error ? e.message : '写入失败');
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' };
  } finally {
    saving = false;
  }
}

function scheduleSave() {
  if (applying) return;
  editRevision += 1;
  dirty = true;
  if (saving) saveRequested = true;
  setStatus('未保存');
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow('autosave'), 900);
}

function liveSheets() {
  return currentSheets();
}

function rememberDurable(sheets) {
  durableSheets = (sheets || []).map((s) => ({
    name: s.name,
    rows: (s.rows || []).map((r) => (Array.isArray(r) ? r.slice() : []))
  }));
}

function currentOverview() {
  const selections = normalizeSelections(pinnedSelections);
  return overviewFromSheets(liveSheets(), {
    artifactId,
    name: fileName,
    kind,
    selections,
    selection: selections[0] || lastSelection
  });
}

function unitId() {
  return `paw-${artifactId || 'workbook'}`;
}

function sheetSelAnchorRect() {
  const app = document.getElementById('app');
  const hit =
    app?.querySelector('.univer-selection-main') ||
    app?.querySelector('[class*="selection-main"]') ||
    app?.querySelector('[class*="SelectionMain"]');
  return hit?.getBoundingClientRect?.() || null;
}

function paintOfficeSelBubble() {
  if (!selBubble) return;
  const list = normalizeSelections(pinnedSelections);
  const hit = list[list.length - 1] || lastSelection;
  const label = officeSelCopyLabel(hit);
  if (!label) {
    selBubble.hide();
    return;
  }
  selBubble.show(label, sheetSelAnchorRect());
}

function paintSel() {
  const el = document.getElementById('sel');
  const list = normalizeSelections(pinnedSelections);
  if (el) {
    if (!list.length) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = list.map((s) => `${s.sheet}!${s.a1}`).join(' · ');
    }
  }
  paintOfficeSelBubble();
}

function markAddSelect(ev) {
  if (!ev) return;
  if (ev.ctrlKey || ev.metaKey) {
    addSelectHeld = true;
    addSelectUntil = Date.now() + 1500;
  }
}

function isAddSelect() {
  return addSelectHeld || Date.now() < addSelectUntil;
}

function consumeAddSelect() {
  const on = isAddSelect();
  addSelectHeld = false;
  addSelectUntil = on ? Date.now() + 400 : 0;
  return on;
}

function rangeToA1(range) {
  if (!range) return '';
  if (typeof range === 'string') return String(range);
  const fns = ['getA1Notation', 'getA1', 'getRangeId', 'getRange'];
  for (const fn of fns) {
    try {
      const v = range[fn]?.();
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      /* next */
    }
  }
  const sr = range.startRow ?? range.startRowIndex ?? range._startRow;
  const sc = range.startColumn ?? range.startColumnIndex ?? range._startColumn;
  const er = range.endRow ?? range.endRowIndex ?? range._endRow ?? sr;
  const ec = range.endColumn ?? range.endColumnIndex ?? range._endColumn ?? sc;
  if (Number.isFinite(sr) && Number.isFinite(sc)) {
    return `${indexToCol(sc)}${Number(sr) + 1}:${indexToCol(ec)}${Number(er) + 1}`;
  }
  return '';
}

function asRangeList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw.toArray === 'function') {
    try {
      const arr = raw.toArray();
      if (Array.isArray(arr)) return arr;
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(raw.ranges)) return raw.ranges;
  if (Array.isArray(raw._ranges)) return raw._ranges;
  return [raw];
}

function readNativeRanges() {
  const wb = univerAPI?.getActiveWorkbook?.();
  const sh = wb?.getActiveSheet?.();
  const sheetName = sh?.getSheetName?.() || sh?.getName?.() || liveSheets()[0]?.name || 'Sheet1';
  const bags = [];
  const tryGet = (obj, name) => {
    try {
      const v = obj?.[name]?.();
      if (v) bags.push(v);
    } catch {
      /* facade variance */
    }
  };
  tryGet(sh, 'getActiveRangeList');
  tryGet(sh, 'getSelection');
  tryGet(wb, 'getActiveRangeList');
  tryGet(wb, 'getSelection');
  tryGet(wb, 'getActiveRanges');
  tryGet(sh, 'getActiveRange');
  tryGet(wb, 'getActiveRange');
  const out = [];
  const seen = new Set();
  for (const bag of bags) {
    for (const range of asRangeList(bag)) {
      let a1 = rangeToA1(range);
      if (!a1 && range?.range) a1 = rangeToA1(range.range);
      if (!a1) continue;
      const parsed = parseA1(a1);
      const sheet = parsed.sheet || sheetName;
      const norm = { sheet, a1: normalizeA1(a1) };
      const key = selectionKey(norm);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
    }
    if (out.length) break;
  }
  return { sheetName, ranges: normalizeSelections(out) };
}

function cloneSheets(sheets) {
  return (sheets || []).map((s) => ({
    name: s.name,
    rows: (s.rows || []).map((r) => (Array.isArray(r) ? r.slice() : []))
  }));
}

function tHost(key, fallback) {
  const pack = ribbonLocales(sheetUiLang())?.browserbot || {};
  const v = pack[key];
  return v != null ? String(v) : fallback;
}

function paintDraftChrome() {
  const undo = document.getElementById('undoBtn');
  if (undo) undo.hidden = undoStack.length === 0;
  const accept = document.getElementById('acceptBtn');
  const discard = document.getElementById('discardBtn');
  if (accept) accept.hidden = true;
  if (discard) discard.hidden = true;
}

function hideAgentUndoToast() {
  const el = document.getElementById('agentUndoToast');
  if (el) el.hidden = true;
  window.clearTimeout(hideAgentUndoToast._t);
}

function showAgentUndoToast(kind = 'applied') {
  const el = document.getElementById('agentUndoToast');
  if (!el) return;
  const nUndo = undoStack.length;
  const nRedo = redoStack.length;
  const msgEl = el.querySelector('[data-role="msg"]');
  const undoBtn = el.querySelector('[data-act="undo"]');
  const redoBtn = el.querySelector('[data-act="redo"]');
  if (kind === 'undone') {
    if (msgEl) msgEl.textContent = tHost('undoDone', '已撤销这次提问');
  } else if (kind === 'redone') {
    if (msgEl) msgEl.textContent = tHost('redoDone', '已重做这次提问');
  } else if (msgEl) {
    const many = tHost('undoToastMany', 'Agent 已按这次提问改了表格 · 还可撤销 {0} 次');
    msgEl.textContent =
      nUndo > 1 ? many.replace('{0}', String(nUndo)) : tHost('undoToast', 'Agent 已按这次提问改了表格');
  }
  if (undoBtn) {
    undoBtn.textContent = `← ${tHost('undo', '撤销这次提问')}`;
    undoBtn.hidden = nUndo === 0;
    undoBtn.disabled = nUndo === 0;
  }
  if (redoBtn) {
    redoBtn.textContent = `${tHost('redo', '重做这次提问')} →`;
    redoBtn.hidden = nRedo === 0;
    redoBtn.disabled = nRedo === 0;
  }
  el.hidden = nUndo === 0 && nRedo === 0;
  window.clearTimeout(hideAgentUndoToast._t);
  if (!el.hidden) {
    hideAgentUndoToast._t = window.setTimeout(() => hideAgentUndoToast(), 12000);
  }
}

function liveWorkbookSnapshot() {
  try {
    const saved = univerAPI?.getActiveWorkbook?.()?.save?.();
    if (saved && saved.sheets) return mergeWorkbookSnapshot(saved, durableSheets);
  } catch {
    /* facade */
  }
  return snapshotData();
}

function ensurePromptCheckpoint(promptId) {
  const next = pushPromptCheckpoint(undoStack, promptId, cloneSheets(liveSheets()), {
    snapshot: liveWorkbookSnapshot()
  });
  if (next !== undoStack) redoStack = [];
  undoStack = next;
  paintDraftChrome();
}

async function applyPromptSnapshot(sheets, snapshot) {
  if (snapshot && snapshot.sheets) {
    const existing = univerAPI?.getActiveWorkbook?.();
    if (existing?.dispose) existing.dispose();
    univerAPI.createWorkbook({ ...snapshot, id: snapshot.id || unitId() });
    rememberDurable(workbookDataToSheets(snapshot));
    return saveNow('autosave');
  }
  if (!sheets?.length) return;
  rememberDurable(sheets);
  paintSheetsOntoLiveUnit(sheets);
  const keep = new Set(sheets.map((s) => s.name));
  for (const name of liveSheetNames()) {
    if (!keep.has(name)) deleteSheetByName(name);
  }
  return saveNow('autosave');
}

async function undoLastAgentEdit() {
  if (!undoStack.length) {
    setStatus(sheetUiLang() === 'en' ? 'Nothing to undo' : '没有可撤销的提问');
    return;
  }
  applying = true;
  try {
    await withFromAgent(async () => {
      const moved = undoPrompt(undoStack, redoStack, cloneSheets(liveSheets()), {
        snapshot: liveWorkbookSnapshot()
      });
      undoStack = moved.undoStack;
      redoStack = moved.redoStack;
      paintDraftChrome();
      if (!moved.restore?.sheets?.length && !moved.restore?.snapshot) {
        hideAgentUndoToast();
        setStatus(sheetUiLang() === 'en' ? 'Nothing to undo' : '没有可撤销的提问');
        return;
      }
      const saved = await applyPromptSnapshot(moved.restore.sheets, moved.restore.snapshot);
      if (!saved?.ok) return;
      showAgentUndoToast('undone');
      setStatus(tHost('undoDone', '已撤销这次提问'));
    });
  } finally {
    applying = false;
  }
}

async function redoLastAgentEdit() {
  if (!redoStack.length) {
    setStatus(sheetUiLang() === 'en' ? 'Nothing to redo' : '没有可重做的提问');
    return;
  }
  applying = true;
  try {
    await withFromAgent(async () => {
      const moved = redoPrompt(undoStack, redoStack, cloneSheets(liveSheets()), {
        snapshot: liveWorkbookSnapshot()
      });
      undoStack = moved.undoStack;
      redoStack = moved.redoStack;
      paintDraftChrome();
      if (!moved.restore?.sheets?.length && !moved.restore?.snapshot) {
        hideAgentUndoToast();
        setStatus(sheetUiLang() === 'en' ? 'Nothing to redo' : '没有可重做的提问');
        return;
      }
      const saved = await applyPromptSnapshot(moved.restore.sheets, moved.restore.snapshot);
      if (!saved?.ok) return;
      showAgentUndoToast('redone');
      setStatus(tHost('redoDone', '已重做这次提问'));
    });
  } finally {
    applying = false;
  }
}

function captureSelection(opts = {}) {
  const fromPoll = opts.fromPoll === true;
  const sheetOnly = opts.sheetOnly === true;
  const forceAdd = opts.add === true;
  try {
    const native = readNativeRanges();
    const sheetName = native.sheetName;
    const ranges = native.ranges;
    if (fromPoll || sheetOnly) {
      lastSelection = ranges[0] || lastSelection;
      paintSel();
      return lastSelection;
    }
    if (!ranges.length) {
      paintSel();
      return lastSelection;
    }
    const add = forceAdd || consumeAddSelect();
    if (add) {
      pinnedSelections = unionSelections(pinnedSelections, ranges);
    } else {
      pinnedSelections = replaceSheetSelections(pinnedSelections, ranges, sheetName);
    }
    lastSelection = ranges[0] || pinnedSelections[0] || lastSelection;
  } catch {
    /* facade variance */
  }
  paintSel();
  return lastSelection;
}

function reportState(opts = {}) {
  if (!sessionId) return currentOverview();
  if (opts.capture !== false) {
    const cap = opts.capture === true ? {} : opts.capture || { fromPoll: true };
    captureSelection(cap);
  } else {
    paintSel();
  }
  paintDraftChrome();
  const overview = currentOverview();
  try {
    chrome.runtime.sendMessage({
      action: 'sheet_tab_state',
      sessionId,
      artifactId,
      overview
    });
  } catch {
    /* ignore */
  }
  return overview;
}

function sheetByName(name, opts = {}) {
  const wb = univerAPI.getActiveWorkbook();
  const sheets = wb.getSheets?.() || [];
  if (name) {
    for (const s of sheets) {
      const n = s.getSheetName?.() || s.getName?.();
      if (n === name) return s;
    }
    try {
      const hit = wb.getSheetByName?.(name);
      if (hit) return hit;
    } catch {
      /* facade variance */
    }
  }
  if (opts.strict) return null;
  return wb.getActiveSheet();
}

function highlightA1(sheetName, a1) {
  try {
    growLiveGridToA1(sheetName, a1);
    const wb = univerAPI.getActiveWorkbook();
    const sh = sheetByName(sheetName);
    try {
      wb.setActiveSheet?.(sh);
    } catch {
      /* optional */
    }
    const range = sh.getRange(a1 || 'A1');
    range.activate?.();
    range.scrollToCell?.();
  } catch {
    /* optional */
  }
}

function liveSheetNames() {
  const wb = univerAPI.getActiveWorkbook();
  const sheets = wb?.getSheets?.() || [];
  const names = [];
  for (const s of sheets) {
    const n = s.getSheetName?.() || s.getName?.();
    if (n) names.push(String(n));
  }
  return names;
}

function ensureLiveSheet(name, sheets) {
  const wb = univerAPI.getActiveWorkbook();
  if (!wb || !name) return null;
  if (!liveSheetNames().includes(name)) {
    try {
      const snap = (sheets || []).find((s) => s.name === name);
      const usedRows = Array.isArray(snap?.rows) ? snap.rows.length : 0;
      const usedCols = Math.max(0, ...((snap?.rows || []).map((r) => (Array.isArray(r) ? r.length : 0))));
      const ext = gridExtentFromUsed(usedRows, usedCols);
      wb.create(name, ext.rowCount, ext.columnCount);
    } catch {
      /* already exists */
    }
  }
  return sheetByName(name);
}

function paintSheetRows(name, rows, a1 = 'A1') {
  const sh = sheetByName(name);
  if (!sh?.getRange || !Array.isArray(rows) || !rows.length) return;
  growLiveGridToA1(name, a1);
  const parsed = parseA1(a1);
  const endRow = (Number.isFinite(parsed?.sr) ? parsed.sr : 0) + rows.length - 1;
  const endCol =
    (Number.isFinite(parsed?.sc) ? parsed.sc : 0) + Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0))) - 1;
  growLiveGrid({ endRow, endCol }, name);
  try {
    sh.getRange(a1).setValues(rows);
  } catch {
    /* facade variance */
  }
}

/** Merge/discard only: may write original. Agent apply must not call this. */
function paintSheetsOntoLiveUnit(sheets) {
  const wb = univerAPI.getActiveWorkbook();
  if (!wb) return;
  for (const snap of sheets || []) {
    const name = String(snap.name || 'Sheet1');
    ensureLiveSheet(name, sheets);
    paintSheetRows(name, snap.rows || [], 'A1');
  }
}

/**
 * After apply, every sheet in the applied state must exist as a Univer
 * worksheet (createSheet used to stay in the transient AOA only).
 */
function materializeAppliedSheets(snap) {
  const sheets = snap?.sheets || [];
  const existed = new Set(liveSheetNames());
  for (const s of sheets) {
    const name = String(s.name || 'Sheet1');
    ensureLiveSheet(name, sheets);
    if (!existed.has(name)) paintSheetRows(name, s.rows || [], 'A1');
  }
  paintDraftDirty(snap);
  const live = workbookDataToSheets(univerAPI?.getActiveWorkbook?.()?.save?.() || {});
  const liveBy = new Map(live.map((s) => [String(s.name), s]));
  rememberDurable(
    sheets.map((s) => {
      const name = String(s.name);
      const l = liveBy.get(name);
      return {
        name,
        rows: cloneSheetRows(l?.rows || s.rows)
      };
    })
  );
}

function paintDraftDirty(snap) {
  const targetName =
    snap.draft?.sheet || findDraftPair(snap.sheets)?.draftName || snap.readback?.sheet;
  if (!targetName) return;
  const target = (snap.sheets || []).find((s) => s.name === targetName);
  const existed = liveSheetNames().includes(targetName);
  ensureLiveSheet(targetName, snap.sheets);
  const dirty = dirtyRangesFromApplied(snap.applied, targetName);
  const full = snap.draft?.inPlace
    ? dirty.mode === 'full' || !dirty.marks.length
    : !existed || dirty.mode === 'full' || !dirty.marks.length;
  if (full) {
    paintSheetRows(targetName, target?.rows || [], 'A1');
  } else {
    for (const m of dirty.marks) {
      const read = readRangeFromSheets(snap.sheets, m.a1, targetName);
      paintSheetRows(targetName, read.values || [], m.a1);
    }
  }
  pulseAgentRanges(targetName, dirty.marks);
}

function pulseAgentRanges(sheetName, marks) {
  for (const m of marks || []) {
    if (m?.a1) growLiveGridToA1(sheetName, m.a1);
  }
  const app = document.getElementById('app');
  if (app) {
    app.classList.remove('is-agent-pulse');
    void app.offsetWidth;
    app.classList.add('is-agent-pulse');
    window.clearTimeout(pulseAgentRanges._t);
    pulseAgentRanges._t = window.setTimeout(() => app.classList.remove('is-agent-pulse'), 3800);
  }
  const first = (marks && marks[0]?.a1) || '';
  if (sheetName && first) highlightA1(sheetName, first);
}

function deleteSheetByName(name) {
  const wb = univerAPI.getActiveWorkbook();
  if (!wb || !name) return false;
  const sh = sheetByName(name);
  const id = sh?.getSheetId?.() || sh?.getId?.() || sh?.getSheet?.()?.getSheetId?.();
  const attempts = [
    () => wb.deleteSheet?.(sh),
    () => wb.deleteSheet?.(id),
    () => wb.deleteSheet?.(name),
    () => wb.removeSheet?.(id),
    () => sh.delete?.()
  ];
  for (const fn of attempts) {
    try {
      fn();
      if (!liveSheetNames().includes(name)) return true;
    } catch {
      /* try next */
    }
  }
  return !liveSheetNames().includes(name);
}

function snapshotData() {
  const saved = univerAPI.getActiveWorkbook()?.save?.() || null;
  if (saved && saved.sheets) return saved;
  return sheetsToWorkbookData(liveSheets(), fileName, { id: saved?.id || unitId() });
}

function sheetExtent(sh) {
  return {
    rowCount: Number(sh?.getMaxRows?.() || sh?.getRowCount?.() || 0) || 0,
    columnCount: Number(sh?.getMaxColumns?.() || sh?.getColumnCount?.() || 0) || 0
  };
}

function applyGridExtent(sh, next) {
  if (!sh || !next) return;
  const wb = univerAPI?.getActiveWorkbook?.();
  const unitId = wb?.getId?.() || wb?.getUnitId?.();
  const subUnitId = sh.getSheetId?.() || sh.getId?.();
  const cur = sheetExtent(sh);
  const exec = (id, params) => {
    const options = { [FROM_AGENT]: true, fromAgent: true };
    try {
      if (univerAPI._commandService?.syncExecuteCommand) {
        univerAPI._commandService.syncExecuteCommand(id, params, options);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      univerAPI.executeCommand?.(id, params, options);
    } catch {
      /* facade variance */
    }
  };
  if (next.rowCount > cur.rowCount && unitId && subUnitId) {
    exec('sheet.mutation.set-worksheet-row-count', { unitId, subUnitId, rowCount: next.rowCount });
  } else if (next.rowCount > cur.rowCount && typeof sh.setRowCount === 'function') {
    try {
      sh.setRowCount(next.rowCount);
    } catch {
      /* */
    }
  }
  if (next.columnCount > cur.columnCount && unitId && subUnitId) {
    exec('sheet.mutation.set-worksheet-column-count', { unitId, subUnitId, columnCount: next.columnCount });
  } else if (next.columnCount > cur.columnCount && typeof sh.setColumnCount === 'function') {
    try {
      sh.setColumnCount(next.columnCount);
    } catch {
      /* */
    }
  }
}

function growLiveGrid(viewed = {}, sheetName) {
  const sh = sheetName ? sheetByName(sheetName) : univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.();
  if (!sh) return;
  const next = growGridExtent(sheetExtent(sh), viewed);
  applyGridExtent(sh, next);
}

function growLiveGridFromScroll(params) {
  const startRow = Number(params?.sheetViewStartRow);
  const startCol = Number(params?.sheetViewStartColumn);
  growLiveGrid({
    endRow: Number.isFinite(startRow) ? startRow + 50 : undefined,
    endCol: Number.isFinite(startCol) ? startCol + 20 : undefined
  });
}

function growLiveGridToA1(sheetName, a1) {
  const parsed = parseA1(a1 || '');
  if (!Number.isFinite(parsed?.er) && !Number.isFinite(parsed?.ec)) return;
  growLiveGrid({ endRow: parsed.er, endCol: parsed.ec }, sheetName);
}

async function withFromAgent(fn) {
  const svc = ribbonCommandService();
  const origSync = svc?.syncExecuteCommand ? svc.syncExecuteCommand.bind(svc) : null;
  const origExec = svc?.executeCommand ? svc.executeCommand.bind(svc) : null;
  const origApi = univerAPI?.executeCommand ? univerAPI.executeCommand.bind(univerAPI) : null;
  const stamp = (_id, _params, options) => ({ ...(options || {}), [FROM_AGENT]: true, fromAgent: true });
  if (svc && origSync) {
    svc.syncExecuteCommand = (id, params, options) => origSync(id, params, stamp(id, params, options));
  }
  if (svc && origExec) {
    svc.executeCommand = (id, params, options) => origExec(id, params, stamp(id, params, options));
  }
  if (origApi) {
    univerAPI.executeCommand = (id, params, options) => origApi(id, params, stamp(id, params, options));
  }
  try {
    return await fn();
  } finally {
    if (svc && origSync) svc.syncExecuteCommand = origSync;
    if (svc && origExec) svc.executeCommand = origExec;
    if (origApi) univerAPI.executeCommand = origApi;
  }
}

function applySnapshotAndPaint(commands, statusText, promptId) {
  setStatus(statusText || '正在写入表格…');
  ensurePromptCheckpoint(promptId);
  const snap = applyCommandsToWorkbookData(snapshotData(), commands, {
    agentWrite: true,
    inPlace: true,
    selections: pinnedSelections
  });
  if (snap.ok === false) return snap;
  rememberDurable(snap.sheets);
  materializeAppliedSheets(snap);
  return snap;
}

function univerImageSrc(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) {
    try {
      const decoded = decodeDataUrl(s);
      return URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mimeType || 'image/png' }));
    } catch {
      return s;
    }
  }
  return s;
}

async function insertSheetImage(sh, src, col, row, mode) {
  const url = univerImageSrc(src);
  if (!url || !sh) return false;
  const a1 = `${indexToCol(col)}${row + 1}`;
  if (mode !== 'float') {
    try {
      const range = sh.getRange(a1);
      range?.activate?.();
      if (range?.insertCellImageAsync) {
        await range.insertCellImageAsync(url);
        return true;
      }
      if (range?.insertCellImage) {
        await range.insertCellImage(url);
        return true;
      }
    } catch {
      /* fall through to over-grid */
    }
  }
  const attempts = [
    () => sh.insertImage(url, col, row),
    () => sh.insertImage?.(url, row, col),
    () => sh.insertFloatImage?.(url, col, row)
  ];
  for (const fn of attempts) {
    try {
      const out = await Promise.resolve(fn());
      if (out === false || out === null) continue;
      return true;
    } catch {
      /* try next signature */
    }
  }
  return false;
}

async function applyLiveDrawings(commands, draftSheet) {
  const wb = univerAPI?.getActiveWorkbook?.();
  if (!wb) return { count: 0, failed: (commands || []).length };
  let count = 0;
  let failed = 0;
  const list = retargetDrawingCommands(commands, draftSheet);
  for (const cmd of list) {
    const op = String(cmd.op || '');
    if (op !== 'insertImage' && op !== 'insertCellImage' && op !== 'insertFloatImage') continue;
    const src = String(cmd.src || cmd.url || cmd.value || '').trim();
    if (!src || cmd.srcError || /^wi_/i.test(src) || classifySheetImageSrc(src).kind === 'handle') {
      failed += 1;
      continue;
    }
    const parsed = parseA1(cmd.a1 || 'A1');
    const name = cmd.sheet || parsed.sheet;
    const sh = sheetByName(name, { strict: true });
    if (!sh) {
      failed += 1;
      continue;
    }
    const mode = op === 'insertFloatImage' ? 'float' : 'cell';
    const ok = await insertSheetImage(sh, src, parsed.sc, parsed.sr, mode);
    if (ok) count += 1;
    else failed += 1;
  }
  return { count, failed };
}

async function executeSheetRpc(msg) {
  const method = String(msg.method || '');
  if (method === 'overview') {
    return { ok: true, overview: reportState() };
  }
  if (method === 'range') {
    const data = liveWorkbookSnapshot();
    const read = inspectSheetSelection(data, msg.a1 || 'A1:Z20', msg.sheet);
    return { ok: true, ...read, overview: currentOverview(), source: 'artifact' };
  }
  if (method === 'snapshot') {
    const data = liveWorkbookSnapshot();
    const snap = snapshotSheetRange(data, msg.a1, msg.sheet);
    return { ...snap, overview: currentOverview(), source: 'live' };
  }
  if (method === 'focusRange') {
    const sheet = String(msg.sheet || lastSelection?.sheet || liveSheets()[0]?.name || 'Sheet1');
    const a1 = String(msg.a1 || 'A1');
    highlightA1(sheet, a1);
    lastSelection = { sheet, a1: normalizeA1(a1) };
    return { ok: true, overview: reportState({ capture: false }) };
  }
  if (method === 'dropSelection') {
    pinnedSelections = dropSelection(pinnedSelections, { sheet: msg.sheet, a1: msg.a1 });
    lastSelection = pinnedSelections[0] || null;
    return { ok: true, overview: reportState({ capture: false }) };
  }
  if (method === 'clearSelections') {
    pinnedSelections = [];
    lastSelection = null;
    return { ok: true, overview: reportState({ capture: false }) };
  }
  if (method === 'apply') {
    applying = true;
    try {
      return await withFromAgent(async () => {
      const commands = Array.isArray(msg.commands) ? msg.commands : [];
      const snap = applySnapshotAndPaint(commands, msg.statusText, msg.promptId);
      if (snap.ok === false) {
        return {
          ok: false,
          error: snap.error || 'apply failed',
          code: snap.code,
          hint: snap.hint,
          available: snap.available || currentSheets().map((s) => s.name),
          overview: reportState()
        };
      }
      const drawn = await applyLiveDrawings(commands, snap.draft?.sheet || snap.readback?.sheet);
      const saved = await saveNow('autosave');
      if (!saved?.ok) return { ok: false, error: saved?.error || 'spreadsheet save failed', overview: reportState() };
      const mark = snap.readback;
      if (mark?.sheet) highlightA1(mark.sheet, mark.a1 || 'A1');
      paintDraftChrome();
      showAgentUndoToast('applied');
      if ((snap.applied || []).some((a) => a?.drawing)) {
        setStatus(
          drawn.count
            ? `已在格子里插入 ${drawn.count} 张图 · 已写入工作区`
            : '图片未插入格子 · 请确认已绑定图片'
        );
      }
      const overview = reportState();
      return {
        ok: true,
        applied: (snap.applied || []).length,
        drawings: drawn,
        readback: mark || sampleReadback(readRangeFromSheets(liveSheets(), 'A1:Z12', liveSheets()[0]?.name)),
        overview,
        draft: snap.draft || null
      };
      });
    } finally {
      applying = false;
    }
  }
  if (method === 'mergeDraft' || method === 'discardDraft') {
    applying = true;
    try {
      return await withFromAgent(async () => {
      const sheets = liveSheets();
      const pair = findDraftPair(sheets);
      const sourceName = msg.sourceName || pair?.sourceName || sheets.find((s) => !String(s.name).endsWith('（草稿）'))?.name;
      const next =
        method === 'mergeDraft'
          ? mergeDraftIntoOriginal(sheets, sourceName)
          : discardDraftSheet(sheets, sourceName);
      rememberDurable(next.sheets);
      paintSheetsOntoLiveUnit(next.sheets);
      const leftover = (liveSheetNames() || []).filter((n) => !next.sheets.some((s) => s.name === n));
      for (const name of leftover) deleteSheetByName(name);
      if (method === 'discardDraft' && pair?.draftName) deleteSheetByName(pair.draftName);
      if (method === 'mergeDraft' && pair?.draftName) deleteSheetByName(pair.draftName);
      const saved = await saveNow('autosave');
      if (!saved?.ok) return { ok: false, error: saved?.error || 'spreadsheet save failed', overview: reportState() };
      paintDraftChrome();
      if (method === 'mergeDraft') setStatus('已用草稿覆盖原表');
      else setStatus('已丢弃草稿');
      if (sourceName) highlightA1(sourceName, 'A1');
      return { ok: true, method, overview: reportState() };
      });
    } finally {
      applying = false;
    }
  }
  void parseA1;
  void sourceNameFromDraft;
  return { ok: false, error: `unknown sheet method ${method}` };
}

function applyImageUrlsToRows(rows, images) {
  const map = new Map();
  for (const im of images || []) {
    const url = String(im.url || im.src || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    map.set(`${Number(im.row) || 0},${Number(im.col) || 0}`, url);
  }
  return (rows || []).map((row, r) =>
    (Array.isArray(row) ? row : []).map((v, c) => {
      const url = map.get(`${r},${c}`);
      if (url) return url;
      const s = String(v ?? '');
      if (s === '🖼' || /^\[image:/i.test(s)) return '';
      return v;
    })
  );
}

async function srcToImageBytes(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  try {
    if (/^data:image\//i.test(s)) {
      const decoded = decodeDataUrl(s);
      return { bytes: decoded.bytes, mime: decoded.mimeType || 'image/png' };
    }
    const res = await fetch(s);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return null;
    const mime = String(res.headers.get('content-type') || '').split(';')[0] || 'image/png';
    return { bytes: buf, mime };
  } catch {
    return null;
  }
}

function drawingSource(d) {
  if (!d || typeof d !== 'object') return '';
  return String(d.source || d.src || d.url || d.imageUrl || '').trim();
}

function collectSnapshotCellImages(snap) {
  const out = [];
  const sheets = snap?.sheets && typeof snap.sheets === 'object' ? snap.sheets : {};
  const order = Array.isArray(snap?.sheetOrder) && snap.sheetOrder.length ? snap.sheetOrder : Object.keys(sheets);
  for (const id of order) {
    const sh = sheets[id] || {};
    const name = String(sh.name || 'Sheet1');
    const cellData = sh.cellData && typeof sh.cellData === 'object' ? sh.cellData : {};
    for (const rk of Object.keys(cellData)) {
      const row = Number(rk);
      if (!Number.isFinite(row)) continue;
      const rd = cellData[rk] || {};
      for (const ck of Object.keys(rd)) {
        const col = Number(ck);
        if (!Number.isFinite(col)) continue;
        const cell = rd[ck];
        const drawings = cell?.p?.drawings;
        if (!drawings || typeof drawings !== 'object') continue;
        for (const d of Object.values(drawings)) {
          const src = drawingSource(d);
          if (src) out.push({ sheet: name, row, col, src });
        }
      }
    }
  }
  return out;
}

function collectOverGridImages() {
  const out = [];
  const wb = univerAPI?.getActiveWorkbook?.();
  const sheets = wb?.getSheets?.() || [];
  for (const sh of sheets) {
    const name = sh.getSheetName?.() || sh.getName?.() || 'Sheet1';
    let imgs = [];
    try {
      imgs = sh.getImages?.() || [];
    } catch {
      imgs = [];
    }
    for (const img of imgs) {
      const raw = img?._image || {};
      const from = raw.sheetTransform?.from || raw.from || {};
      const row = Number(from.row ?? raw.row ?? 0);
      const col = Number(from.column ?? from.col ?? raw.column ?? 0);
      let src = drawingSource(raw);
      try {
        src = src || img.toBuilder?.()?.getSource?.() || '';
      } catch {
        /* */
      }
      if (src) {
        const rr = Number.isFinite(row) ? row : 0;
        const cc = Number.isFinite(col) ? col : 0;
        let width = raw.width || raw.transform?.width;
        let height = raw.height || raw.transform?.height;
        try {
          width = width || sh.getColumnWidth?.(cc);
          height = height || sh.getRowHeight?.(rr);
        } catch {
          /* */
        }
        out.push({ sheet: name, row: rr, col: cc, src, width, height });
      }
    }
  }
  return out;
}

async function collectLiveSheetImages() {
  const seen = new Set();
  const pending = [...collectOverGridImages(), ...collectSnapshotCellImages(univerAPI?.getActiveWorkbook?.()?.save?.())];
  const out = [];
  for (const im of pending) {
    const key = `${im.sheet}:${im.row}:${im.col}:${im.src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = String(im.src || '').trim();
    const got = await srcToImageBytes(src);
    if (!got?.bytes?.length) {
      if (/^https?:\/\//i.test(src)) {
        out.push({
          sheet: im.sheet,
          row: im.row,
          col: im.col,
          src,
          width: im.width,
          height: im.height
        });
      }
      continue;
    }
    out.push({
      sheet: im.sheet,
      row: im.row,
      col: im.col,
      src,
      bytes: got.bytes,
      mime: got.mime,
      width: im.width,
      height: im.height
    });
  }
  return out;
}

async function downloadNow(fmt) {
  const format = String(fmt || '').toLowerCase();
  let bytes;
  let name = fileName;
  let type = mimeType;
  if (format === 'csv' || format === 'tsv' || (!format && kind !== 'xlsx')) {
    const delim = format === 'tsv' || (!format && kind === 'tsv') ? '\t' : ',';
    const ext = delim === '\t' ? '.tsv' : '.csv';
    const refs = [...collectOverGridImages(), ...collectSnapshotCellImages(univerAPI?.getActiveWorkbook?.()?.save?.())];
    const rows = applyImageUrlsToRows((currentSheets()[0]?.rows) || [], refs);
    const text = aoaToCsv(rows, delim);
    bytes = encodeUtf8Csv(text);
    name = String(fileName || 'sheet').replace(/\.[^.]+$/, '') + ext;
    type = delim === '\t' ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8';
  } else {
    const images = await collectLiveSheetImages();
    bytes = await bytesForXlsxExport({ images });
    name = String(fileName || 'sheet').replace(/\.[^.]+$/, '') + '.xlsx';
    type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      images.length ? `已开始下载 · ${name} · ${images.length} 张图` : `已开始下载 · ${name}`
    );
    return;
  }
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`已开始下载 · ${name}`);
}

function wireBar() {
  selBubble = mountOfficeSelBubble(document.body, {
    kind: 'sheet',
    copiedLabel: sheetUiLang() === 'en' ? 'Copied' : '已复制'
  });
  mountOfficeHelp('sheet');
  installOfficeShortcuts({
    surface: 'sheet',
    isTyping: (e) => isTypingTarget(e.target),
    actions: {
      zoomIn: () => univerSheetZoom(univerAPI, 1, document.getElementById('app')),
      zoomOut: () => univerSheetZoom(univerAPI, -1, document.getElementById('app')),
      zoomFit: () => univerSheetZoom(univerAPI, 0, document.getElementById('app')),
      save: () => {
        void saveNow('save');
      },
      escape: () => closeOfficeHelp()
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) markAddSelect(e);
  });
  window.addEventListener('keyup', (e) => {
    if (!e.ctrlKey && !e.metaKey) addSelectHeld = false;
  });
  document.getElementById('app')?.addEventListener(
    'pointerdown',
    (e) => {
      markAddSelect(e);
    },
    true
  );
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
  document.getElementById('agentUndoToast')?.addEventListener('click', (e) => {
    const act = e.target?.closest?.('[data-act]')?.getAttribute('data-act');
    if (act === 'undo') void undoLastAgentEdit();
    if (act === 'redo') void redoLastAgentEdit();
    if (act === 'dismiss') hideAgentUndoToast();
  });
}

async function loadSheetRuntime() {
  if (window.__browserBotSheetRuntime) return window.__browserBotSheetRuntime;
  try {
    const runtime = await import('./vendor/sheet-runtime.js');
    window.__browserBotSheetRuntime = runtime;
    return runtime;
  } catch (e) {
    const msg = String(e?.message || e || '');
    throw new Error(
      /Failed to fetch dynamically imported module|404|Not Found/i.test(msg)
        ? '表格引擎未打包。请在仓库运行 npm run build:sheet，然后 Reload 扩展并刷新本页。'
        : `无法加载表格引擎：${msg}`
    );
  }
}

async function mountUniver(workbookData) {
  const runtime = await loadSheetRuntime();
  const lang = sheetUiLang();
  try {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  } catch {
    /* */
  }
  const { univerAPI: api, univer: inst } = runtime.createUniver({
    theme: runtime.defaultTheme,
    locale: lang === 'en' ? runtime.LocaleType.EN_US : runtime.LocaleType.ZH_CN,
    locales: {
      [runtime.LocaleType.ZH_CN]: runtime.mergeLocales(
        runtime.mergeSheetLocalesZhCN ? runtime.mergeSheetLocalesZhCN() : runtime.sheetsZhCN,
        ribbonLocales('zh')
      ),
      [runtime.LocaleType.EN_US]: runtime.mergeLocales(
        runtime.mergeSheetLocalesEnUS ? runtime.mergeSheetLocalesEnUS() : runtime.sheetsEnUS,
        ribbonLocales('en')
      )
    },
    presets: runtime.createSheetPresets
      ? runtime.createSheetPresets({
          container: 'app',
          header: true,
          toolbar: true,
          formulaBar: true,
          ribbonType: 'classic',
          footer: true
        })
      : [
          runtime.UniverSheetsCorePreset({
            container: 'app',
            header: true,
            toolbar: true,
            formulaBar: true,
            ribbonType: 'classic',
            footer: true
          })
        ]
  });
  univerAPI = api;
  univer = inst;
  const data = workbookData && typeof workbookData === 'object'
    ? { ...workbookData, id: workbookData.id || unitId() }
    : sheetsToWorkbookData([{ name: 'Sheet1', rows: [] }], fileName, { id: unitId() });
  const existing = univerAPI.getActiveWorkbook?.();
  if (existing?.dispose) existing.dispose();
  const bootWorkbook = () => {
    if (!univerAPI.getActiveWorkbook?.()) univerAPI.createWorkbook(data);
  };
  try {
    univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, (params) => {
      const Stages = univerAPI.Enum?.LifecycleStages;
      const stage = params?.stage;
      if (Stages && stage !== Stages.Steady) return;
      bootWorkbook();
      installSheetPlugin();
    });
  } catch {
    bootWorkbook();
    installSheetPlugin();
  }
  univerAPI.createWorkbook(data);
  try {
    univerAPI.addEvent(univerAPI.Event.Scroll, (params) => growLiveGridFromScroll(params));
  } catch {
    /* older facade */
  }
  try {
    univerAPI.addEvent(univerAPI.Event.SelectionChanged, (params) => {
      const ranges = params?.selections || [];
      let endRow;
      let endCol;
      for (const r of ranges) {
        const er = Number(r?.endRow ?? r?.endRowIndex);
        const ec = Number(r?.endColumn ?? r?.endColumnIndex);
        if (Number.isFinite(er)) endRow = Math.max(endRow ?? er, er);
        if (Number.isFinite(ec)) endCol = Math.max(endCol ?? ec, ec);
      }
      if (endRow != null || endCol != null) growLiveGrid({ endRow, endCol });
    });
  } catch {
    /* older facade */
  }
  try {
    univerAPI.addEvent(univerAPI.Event.SheetValueChanged, () => scheduleSave());
  } catch {
    /* older facade */
  }
  try {
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (ev) => {
      const id = String(ev?.id || ev?.commandId || ev?.command?.id || '');
      commandLog = appendCommandLog(commandLog, ev);
      if (!id) return;
      if (/set-worksheet-active|set-active-sheet|activate-sheet|change-sheet|active-worksheet/i.test(id)) {
        reportState({ capture: { sheetOnly: true } });
        return;
      }
      if (/set-worksheet-row-count|set-worksheet-column-count/i.test(id)) {
        return;
      }
      if (/selection|set-range|active-range|scroll|hover|focus|lifecycle/i.test(id)) {
        if (/scroll|hover|lifecycle/i.test(id) && !/selection|set-range|active-range/i.test(id)) {
          reportState();
          return;
        }
        reportState({ capture: true });
        return;
      }
      scheduleSave();
      reportState({ capture: false });
    });
  } catch {
    /* ignore */
  }
  return { univerAPI, univer };
}

async function main() {
  if (!sessionId || !artifactId) {
    boot('缺少 sessionId 或文件 id', true);
    return;
  }
  wireBar();
  try {
    const rec = await fetchCompleteArtifact(
      (method, params) => workspaceRpc(method, params),
      { sessionId, artifactId }
    );
    artifactRevision = Number(rec?.artifact?.revision) || 0;
    const item = {
      artifactId,
      name: rec?.artifact?.name || rec?.name || artifactId,
      mimeType: rec?.mimeType || rec?.artifact?.mimeType || '',
      bytes: rec.bytes,
      text: rec?.content != null ? String(rec.content) : ''
    };
    const cls = classifyOpenArtifact(item);
    const dest = previewEntryForKind(cls.kind);
    if (dest !== 'sheet.html') {
      const q = new URLSearchParams();
      q.set('sessionId', sessionId);
      q.set('artifactId', artifactId);
      const loc = qs('lang');
      if (loc === 'en' || loc === 'zh') q.set('lang', loc);
      location.replace(`./${dest}?${q.toString()}`);
      return;
    }
    kind = sheetKindFromArtifact(item);
    fileName = String(item.name || `sheet.${kind}`);
    mimeType =
      rec?.mimeType ||
      rec?.artifact?.mimeType ||
      (kind === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : kind === 'tsv'
          ? 'text/tab-separated-values'
          : 'text/csv');
    const titleEl = document.getElementById('title');
    if (titleEl) titleEl.textContent = fileName;
    document.title = `${fileName} · 表格`;

    let sheets;
    let snapshot = null;
    if (cls.kind === 'json-workbook') {
      const raw = String(item.text || '').trim() || bytesToUtf8(item.bytes);
      snapshot = JSON.parse(raw);
      sheets = workbookDataToSheets(snapshot);
    } else if (kind === 'xlsx') {
      if (!item.bytes?.byteLength) {
        boot('xlsx 缺少二进制字节，未当文本打开', true);
        return;
      }
      const runtime = await loadSheetRuntime();
      sheets = runtime.readXlsxBytes(item.bytes);
      snapshot = extractWorkbookSnapshot(item.bytes);
      if (!snapshot && runtime.readWorkbookFromXlsxBytes) {
        snapshot = runtime.readWorkbookFromXlsxBytes(item.bytes, {
          id: unitId(),
          name: fileName.replace(/\.[^.]+$/, '') || 'Workbook'
        });
      }
    } else {
      const text = isUtf8OpenKind(cls.kind) ? item.text || bytesToUtf8(item.bytes) : '';
      sheets = [{ name: 'Sheet1', rows: parseDelimited(text, kind) }];
    }
    rememberDurable(sheets);
    let embedded = [];
    if (kind === 'xlsx') {
      const runtime = window.__browserBotSheetRuntime;
      embedded = runtime?.extractXlsxImages?.(item.bytes) || [];
      if (snapshot && embedded.length) {
        snapshot = rewriteWorkbookImages(cloneWorkbookData(snapshot), embedded);
      }
    }
    const data =
      snapshot ||
      sheetsToWorkbookData(sheets, fileName.replace(/\.[^.]+$/, '') || 'Workbook', {
        id: unitId()
      });
    await mountUniver(data);
    if (kind === 'xlsx' && shouldReinsertXlsxImages(snapshot) && embedded.length) {
      applying = true;
      try {
        await withFromAgent(async () => {
          for (const im of embedded) {
            const sh = sheetByName(im.sheet, { strict: true }) || sheetByName(im.sheet);
            if (!sh) continue;
            const url = URL.createObjectURL(new Blob([im.bytes], { type: im.mime || 'image/png' }));
            await insertSheetImage(sh, url, im.col, im.row, 'cell');
          }
        });
      } finally {
        applying = false;
      }
    }
    document.body.classList.add('is-ready');
    const bootEl = document.getElementById('boot');
    if (bootEl) bootEl.hidden = true;
    const hint = document.getElementById('hint');
    if (kind === 'xlsx' && hint) {
      hint.textContent =
        '格子可直接改 · 选区只是提示 · 保存写回同一工作区文件（含格式/校验/合并）';
    }
    setStatus('已打开 · 改格子即写入同一工作区文件');
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (
        handleWorkTabPickerMessage(msg, sendResponse, {
          getActive: () => pickActive,
          setActive: (on) => {
            pickActive = !!on;
            reportPickerState(pickActive);
          }
        })
      ) {
        return false;
      }
      if (msg?.action !== 'browserbot_sheet_rpc') return false;
      executeSheetRpc(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true;
    });
    try {
      chrome.runtime.sendMessage({ action: 'sheet_tab_ready', sessionId, artifactId });
    } catch {
      /* ignore */
    }
    reportState();
    window.setInterval(() => reportState(), 1500);
    window.addEventListener('pagehide', disposeUniverRuntime);
    window.addEventListener('beforeunload', disposeUniverRuntime);
  } catch (e) {
    boot(e instanceof Error ? e.message : String(e), true);
  }
}

void main();
