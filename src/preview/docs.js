import { workspaceRpc } from '../agent/vnext/host/workspaceClient.js';
/**
 * Live Univer Docs canvas for HTML / text artifacts.
 * Durable bytes are docsApply snapshots serialized as marked HTML.
 */

import {
  applyDocCommands,
  cloneDocSnapshot,
  DOC_MIME,
  overviewFromDocSnapshot,
  parseDocSnapshot,
  snapshotToUniverData,
  univerDataToSnapshot
} from '../agent/vnext/sessionWorkspace/docsApply.js';
import { serializeUniverDoc } from '../agent/vnext/sessionWorkspace/docsModel.js';
import {
  cloneDocumentData,
  extractDocumentSnapshot,
  htmlForDocumentExport,
  isDocumentData,
  normalizeUniverDoc
} from './docExport.js';
import { collectImageSources, rewriteEphemeralImageSrcs } from './durableImage.js';
import { docxBytesToUniverData } from './docxIngest.js';
import {
  classifyOpenArtifact,
  isUtf8OpenKind,
  previewEntryForKind
} from '../agent/vnext/sessionWorkspace/openClassify.js';
import { applyOfficeDocumentLang, officeUiLang, persistOfficeUiLang } from './officeLocale.js';
import { installOfficeShortcuts, isTypingTarget, univerDocsZoom } from './officeShortcuts.js';
import { closeOfficeHelp, mountOfficeHelp } from './officeHelp.js';
import { handleWorkTabPickerMessage, reportPickerState } from './workTabPicker.js';
import {
  ARTIFACT_TRUNCATED,
  fetchCompleteArtifact
} from '../agent/vnext/sessionWorkspace/artifactDownload.js';

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
let fileName = 'document.html';
let mimeType = DOC_MIME;
let saveTimer = 0;
let saving = false;
let savePromise = null;
let saveRequested = false;
let editRevision = 0;
let artifactRevision = 0;
let applying = false;
let dirty = false;
/** @type {{ title: string, blocks: object[] }} */
let durableSnapshot = { title: '', blocks: [] };
/** @type {object|null} Univer IDocumentData SoT */
let durableData = null;
let pickActive = false;


function boot(msg, isError = false) {
  const el = document.getElementById('boot');
  if (!el) return;
  el.hidden = false;
  el.className = isError ? 'error' : '';
  el.textContent = msg;
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setSaveState(_cls, label) {
  if (label) setStatus(label);
}

function b64ToBytes(b64) {
  const s = String(b64 || '');
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToUtf8(bytes) {
  try {
    return new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
  } catch {
    return '';
  }
}

function unitId() {
  return `paw-doc-${artifactId || 'document'}`;
}

function parseLoadedDoc(text, title) {
  const extracted = extractDocumentSnapshot(text);
  if (extracted) {
    return normalizeUniverDoc(extracted, { id: unitId(), title });
  }
  return normalizeUniverDoc(snapshotToUniverData(parseDocSnapshot(text, { title }), { id: unitId() }), {
    id: unitId(),
    title
  });
}

function liveDocumentData() {
  try {
    const doc = univerAPI?.getActiveDocument?.();
    const snap = doc?.getSnapshot?.() || (typeof doc?.save === 'function' ? doc.save() : null);
    if (isDocumentData(snap)) return snap;
  } catch {
    /* facade variance */
  }
  if (isDocumentData(durableData)) return durableData;
  return snapshotToUniverData(durableSnapshot, { id: unitId() });
}

function liveSnapshot() {
  return univerDataToSnapshot(liveDocumentData(), {
    title: durableSnapshot.title || fileName
  });
}

function currentHtml() {
  const data = liveDocumentData();
  return htmlForDocumentExport(data, { title: data.title || durableSnapshot.title || fileName });
}

async function fetchSrcBytes(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  try {
    if (/^data:image\//i.test(s)) return null;
    const res = await fetch(s);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return null;
    const mime = String(res.headers.get('content-type') || '').split(';')[0] || 'image/png';
    return { src: s, bytes: buf, mime };
  } catch {
    return null;
  }
}

async function durableLiveDocument() {
  const data = cloneDocumentData(liveDocumentData());
  const srcs = [...new Set(collectImageSources(data))];
  const images = [];
  for (const src of srcs) {
    const got = await fetchSrcBytes(src);
    if (got?.bytes?.length) images.push(got);
  }
  if (images.length) rewriteEphemeralImageSrcs(data, images);
  return data;
}

function currentOverview() {
  return overviewFromDocSnapshot(liveSnapshot(), {
    artifactId,
    name: fileName
  });
}

async function saveNow(reason = 'save') {
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
      const data = normalizeUniverDoc(await durableLiveDocument(), { id: unitId(), title: fileName });
      if (!data.id) data.id = unitId();
      durableData = data;
      durableSnapshot = univerDataToSnapshot(data, { title: data.title || fileName });
      const saved = await workspaceRpc('updateArtifact', {
        sessionId,
        artifactId,
        expectedRevision: artifactRevision,
        mimeType: 'application/json',
        content: serializeUniverDoc(data)
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

function reportState() {
  const overview = currentOverview();
  try {
    chrome.runtime.sendMessage({
      action: 'docs_tab_state',
      sessionId,
      artifactId,
      overview
    });
  } catch {
    /* ignore */
  }
  return overview;
}

function paintSnapshot(snapshot) {
  const raw = isDocumentData(snapshot)
    ? cloneDocumentData(snapshot)
    : snapshotToUniverData(cloneDocSnapshot(snapshot), { id: unitId() });
  const data = normalizeUniverDoc(raw, { id: unitId(), title: fileName });
  durableData = data;
  durableSnapshot = univerDataToSnapshot(data, { title: data.title || fileName });
  createDocUnit(data);
}

function createDocUnit(data) {
  if (!univerAPI?.createUniverDoc) return;
  const existing = univerAPI.getActiveDocument?.();
  if (existing?.dispose) {
    try {
      existing.dispose();
    } catch {
      /* optional */
    }
  }
  try {
    univerAPI.createUniverDoc(data);
  } catch {
    const fallback = normalizeUniverDoc(
      snapshotToUniverData(univerDataToSnapshot(data), { id: data.id || unitId() }),
      { id: data.id || unitId(), title: data.title }
    );
    univerAPI.createUniverDoc(fallback);
  }
}

async function executeDocsRpc(msg) {
  const method = String(msg.method || '');
  if (method === 'overview') {
    return { ok: true, overview: reportState() };
  }
  if (method === 'apply') {
    applying = true;
    try {
      const commands = Array.isArray(msg.commands) ? msg.commands : [];
      const snap = applyDocCommands(durableSnapshot, commands);
      if (snap.ok === false) {
        return { ok: false, error: snap.error || 'apply failed', overview: reportState() };
      }
      paintSnapshot(snap.snapshot);
      const saved = await saveNow('autosave');
      if (!saved?.ok) return { ok: false, error: saved?.error || 'document save failed', overview: reportState() };
      const overview = reportState();
      return {
        ok: true,
        applied: (snap.applied || []).length,
        snapshot: snap.snapshot,
        overview
      };
    } finally {
      applying = false;
    }
  }
  return { ok: false, error: `unknown docs method ${method}` };
}

async function downloadNow() {
  const data = await durableLiveDocument();
  durableData = data;
  durableSnapshot = univerDataToSnapshot(data, { title: data.title || fileName });
  const html = htmlForDocumentExport(data, { title: data.title || fileName });
  const name = String(fileName || 'document').replace(/\.[^.]+$/, '') + '.html';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`已开始下载 · ${name}`);
}

function ribbonLocales(lang) {
  if (lang === 'en') {
    return {
      browserbot: {
        save: 'Save to workspace',
        download: 'Download',
        langMenu: 'Language',
        langZh: '中文',
        langEn: 'English'
      }
    };
  }
  return {
    browserbot: {
      save: '保存到工作区',
      download: '下载',
      langMenu: '语言',
      langZh: '中文',
      langEn: 'English'
    }
  };
}

function ribbonCommandService() {
  if (univerAPI?._commandService?.registerCommand) return univerAPI._commandService;
  try {
    const svc = univerAPI?._injector?.get?.('univer.core.command-service');
    if (svc?.registerCommand) return svc;
  } catch {
    /* */
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
  } catch {
    return false;
  }
}

let ribbonInstalled = false;

function installRibbonMenus() {
  if (ribbonInstalled) return true;
  if (!univerAPI?.createMenu) return false;
  try {
    registerRibbonCommand('browserbot.doc.save', () => void saveNow('save'));
    registerRibbonCommand('browserbot.doc.download', () => void downloadNow());
    univerAPI
      .createMenu({
        id: 'browserbot.doc.save',
        title: 'browserbot.save',
        tooltip: 'browserbot.save',
        icon: 'ExportIcon',
        order: 10,
        action: () => void saveNow('save')
      })
      .appendTo('ribbon.start.others');
    univerAPI
      .createMenu({
        id: 'browserbot.doc.download',
        title: 'browserbot.download',
        tooltip: 'browserbot.download',
        order: 11,
        action: () => void downloadNow()
      })
      .appendTo('ribbon.start.others');
    univerAPI
      .createSubmenu({
        id: 'browserbot.doc.lang',
        title: 'browserbot.langMenu',
        tooltip: 'browserbot.langMenu',
        order: 12
      })
      .appendTo('ribbon.start.others');
    registerRibbonCommand('browserbot.doc.lang.zh', () => applyUniverLocale('zh'));
    registerRibbonCommand('browserbot.doc.lang.en', () => applyUniverLocale('en'));
    univerAPI
      .createMenu({
        id: 'browserbot.doc.lang.zh',
        title: 'browserbot.langZh',
        action: 'browserbot.doc.lang.zh'
      })
      .appendTo('browserbot.doc.lang');
    univerAPI
      .createMenu({
        id: 'browserbot.doc.lang.en',
        title: 'browserbot.langEn',
        action: 'browserbot.doc.lang.en'
      })
      .appendTo('browserbot.doc.lang');
    ribbonInstalled = true;
    return true;
  } catch (err) {
    console.warn('[docs] Univer createMenu failed', err);
    return false;
  }
}

function wireBar() {
  mountOfficeHelp('docs');
  installOfficeShortcuts({
    surface: 'docs',
    isTyping: (e) => isTypingTarget(e.target),
    actions: {
      zoomIn: () => univerDocsZoom(univerAPI, 1, document.getElementById('app')),
      zoomOut: () => univerDocsZoom(univerAPI, -1, document.getElementById('app')),
      zoomFit: () => univerDocsZoom(univerAPI, 0, document.getElementById('app')),
      save: () => {
        void saveNow('save');
      },
      escape: () => closeOfficeHelp()
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

async function loadDocsRuntime() {
  if (window.__pawDocsRuntime) return window.__pawDocsRuntime;
  try {
    const runtime = await import('./vendor/docs-runtime.js');
    window.__pawDocsRuntime = runtime;
    return runtime;
  } catch (e) {
    const msg = String(e?.message || e || '');
    throw new Error(
      /Failed to fetch dynamically imported module|404|Not Found/i.test(msg)
        ? '文档引擎未打包。请在仓库运行 npm run build:docs，然后 Reload 扩展并刷新本页。'
        : `无法加载文档引擎：${msg}`
    );
  }
}

function applyUniverLocale(lang) {
  persistOfficeUiLang(lang);
  applyOfficeDocumentLang(lang);
  const runtime = window.__pawDocsRuntime;
  if (!univerAPI || !runtime) return;
  const loc = lang === 'en' ? runtime.LocaleType.EN_US : runtime.LocaleType.ZH_CN;
  try {
    univerAPI.setLocale?.(loc);
  } catch {
    /* */
  }
}

async function mountUniver(snapshot) {
  const runtime = await loadDocsRuntime();
  const lang = officeUiLang();
  applyOfficeDocumentLang(lang);
  const { univerAPI: api, univer: inst } = runtime.createUniver({
    theme: runtime.defaultTheme,
    locale: lang === 'en' ? runtime.LocaleType.EN_US : runtime.LocaleType.ZH_CN,
    locales: {
      [runtime.LocaleType.ZH_CN]: runtime.mergeLocales(runtime.locales.zhCN, ribbonLocales('zh')),
      [runtime.LocaleType.EN_US]: runtime.mergeLocales(runtime.locales.enUS, ribbonLocales('en'))
    },
    presets: [
      runtime.UniverDocsCorePreset({
        container: 'app',
        header: true,
        toolbar: true,
        footer: true,
        ribbonType: 'classic'
      }),
      runtime.UniverDocsDrawingPreset(),
      runtime.UniverDocsHyperLinkPreset(),
      runtime.UniverDocsThreadCommentPreset()
    ]
  });
  univerAPI = api;
  univer = inst;
  let booted = false;
  const bootDoc = () => {
    if (booted) return;
    try {
      paintSnapshot(snapshot);
      installRibbonMenus();
      booted = true;
    } catch {
      booted = false;
    }
  };
  try {
    univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, (params) => {
      const Stages = univerAPI.Enum?.LifecycleStages;
      const stage = params?.stage;
      if (Stages && stage !== Stages.Steady && stage !== Stages.Rendered) return;
      bootDoc();
    });
  } catch {
    bootDoc();
  }
  window.setTimeout(bootDoc, 400);
  try {
    univerAPI.addEvent(univerAPI.Event.CommandExecuted, (ev) => {
      const id = String(ev?.id || ev?.commandId || ev?.command?.id || '');
      if (!id) return;
      if (/scroll|hover|lifecycle|selection|focus/i.test(id)) {
        reportState();
        return;
      }
      scheduleSave();
      reportState();
    });
  } catch {
    /* older facade */
  }
  return { univerAPI, univer };
}

function disposeUniverRuntime() {
  try {
    univerAPI?.getActiveDocument?.()?.dispose?.();
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
    fileName = String(rec?.artifact?.name || rec?.name || artifactId);
    mimeType = rec?.mimeType || rec?.artifact?.mimeType || DOC_MIME;
    document.title = `${fileName} · 文档`;

    const bytes = rec.bytes;
    const text =
      rec?.content != null && String(rec.content).trim() ? String(rec.content) : '';
    const title = fileName.replace(/\.[^.]+$/, '');
    const cls = classifyOpenArtifact({ name: fileName, mimeType, bytes, text });
    const dest = previewEntryForKind(cls.kind);
    if (dest !== 'docs.html') {
      const q = new URLSearchParams();
      q.set('sessionId', sessionId);
      q.set('artifactId', artifactId);
      const loc = qs('lang');
      if (loc === 'en' || loc === 'zh') q.set('lang', loc);
      location.replace(`./${dest}?${q.toString()}`);
      return;
    }
    let loaded;
    if (cls.kind === 'docx') {
      loaded = docxBytesToUniverData(bytes, { title, id: unitId() });
    } else {
      const src = text.trim() || (isUtf8OpenKind(cls.kind) ? bytesToUtf8(bytes) : '');
      if (!src) {
        boot('这份文件不是可打开的文档', true);
        return;
      }
      loaded = parseLoadedDoc(src, title);
    }
    await mountUniver(loaded);
    document.body.classList.add('is-ready');
    const bootEl = document.getElementById('boot');
    if (bootEl) bootEl.hidden = true;
    setStatus('已打开 · 改正文即写入同一工作区文件');
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
      if (msg?.action !== 'browserbot_docs_rpc') return false;
      executeDocsRpc(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true;
    });
    try {
      chrome.runtime.sendMessage({ action: 'docs_tab_ready', sessionId, artifactId });
    } catch {
      /* ignore */
    }
    reportState();
    window.addEventListener('pagehide', disposeUniverRuntime);
    window.addEventListener('beforeunload', disposeUniverRuntime);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/build:docs|文档引擎未打包/i.test(msg)) {
      boot('运行 npm run build:docs', true);
      return;
    }
    boot(msg, true);
  }
}

void main();
