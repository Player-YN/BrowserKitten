import { workspaceRpc } from '../agent/vnext/host/workspaceClient.js';
/**
 * Website host: render session HTML as a page (iframe-as-browser).
 * Click pins data-paw-node via html_tab_state. SoT is the HTML artifact.
 */
import {
  stampSiteHtml,
  listSiteNodes,
  nextSitePinIds,
  siteSelectionsFromIds,
  formatSiteSelLabel,
  applySiteCommands
} from '../agent/vnext/sessionWorkspace/siteApply.js';
import { sanitizeSiteHtml } from '../agent/vnext/sessionWorkspace/siteSanitize.js';
import {
  isTrustedSiteChildEvent,
  SITE_FRAME_CHANNEL,
  siteFrameUrl
} from './siteFrameBridge.js';
import { ARTIFACT_TRUNCATED, fetchCompleteArtifact } from '../agent/vnext/sessionWorkspace/artifactDownload.js';
import { installOfficeShortcuts, isTypingTarget, stepZoom } from './officeShortcuts.js';
import { closeOfficeHelp, mountOfficeHelp } from './officeHelp.js';
import { handleWorkTabPickerMessage, reportPickerState } from './workTabPicker.js';
import { mountOfficeSelBubble, officeSelCopyLabel } from './officeSelBubble.js';
import { mountSiteMotion, unmountSiteMotion, stripSiteMotionChrome } from './siteMotion.js';

function qs(name) {
  try {
    return new URL(location.href).searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function hasChrome() {
  return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
}


function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg || '';
}

function setSel(msg) {
  const el = document.getElementById('sel');
  if (el) el.textContent = msg || '';
}

function stripScripts(html) {
  return sanitizeSiteHtml(html);
}

const sessionId = qs('sessionId');
const artifactId = qs('artifactId') || (qs('ids') || '').split(',')[0] || '';

let lastHtml = '';
let savedHtml = '';
let artifactRevision = 0;
let saveQueue = Promise.resolve();
let selectedIds = [];
let fileName = 'site.html';
let ignorePatchUntil = 0;
let canUndo = false;
let siteZoom = 1;
let siteKeys = null;
let frameKeysUnbind = null;
let nudgeTimer = 0;
let pickActive = false;
let motionHandle = null;
/** @type {ReturnType<typeof mountOfficeSelBubble>|null} */
let selBubble = null;
/** @type {Record<string, {left:number,top:number,width:number,height:number}>} */
let lastRects = {};
let frameReady = false;
let pendingSerialize = new Map();
let pendingPaint = '';
let loadComplete = false;

function pageFrame() {
  return document.getElementById('page');
}

function pageDoc() {
  try {
    return pageFrame()?.contentDocument || null;
  } catch {
    return null;
  }
}

function frameWin() {
  return pageFrame()?.contentWindow || null;
}

function postToFrame(msg) {
  const win = frameWin();
  if (!win) return false;
  try {
    win.postMessage({ channel: SITE_FRAME_CHANNEL, ...msg }, '*');
    return true;
  } catch {
    return false;
  }
}

function requestFrameSerialize(timeout = 500) {
  return new Promise((resolve) => {
    const req = `${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      pendingSerialize.delete(req);
      resolve(null);
    }, timeout);
    pendingSerialize.set(req, (html) => {
      clearTimeout(timer);
      resolve(html || null);
    });
    if (!postToFrame({ op: 'serialize', req })) {
      clearTimeout(timer);
      pendingSerialize.delete(req);
      resolve(null);
    }
  });
}

function liveNodeIds() {
  const doc = pageDoc();
  if (doc) {
    return [...doc.querySelectorAll('[data-paw-node]')]
      .map((el) => el.getAttribute('data-paw-node') || '')
      .filter(Boolean);
  }
  return listSiteNodes(lastHtml).map((n) => n.nodeId);
}

function prunePins() {
  const live = new Set(liveNodeIds());
  selectedIds = selectedIds.filter((id) => live.has(id));
}

function siteSelAnchorRect(nodeId) {
  const id = String(nodeId || '').trim();
  if (!id) return null;
  const inner = lastRects[id];
  const frame = pageFrame()?.getBoundingClientRect?.();
  if (!inner || !frame) return inner || null;
  return {
    left: frame.left + inner.left,
    top: frame.top + inner.top,
    width: inner.width,
    height: inner.height
  };
}

function paintOfficeSelBubble() {
  if (!selBubble) return;
  const id = selectedIds[selectedIds.length - 1] || '';
  const selections = siteSelectionsFromIds(lastHtml, id ? [id] : []);
  const label = officeSelCopyLabel(selections[0], formatSiteSelLabel(selections));
  if (!label) {
    selBubble.hide();
    return;
  }
  selBubble.show(label, siteSelAnchorRect(id));
}

function reportState() {
  prunePins();
  const nodes = listSiteNodes(lastHtml);
  const selections = siteSelectionsFromIds(lastHtml, selectedIds);
  paintOfficeSelBubble();
  if (!hasChrome() || !sessionId || !artifactId) {
    setSel(formatSiteSelLabel(selections));
    return;
  }
  chrome.runtime
    .sendMessage({
      action: 'html_tab_state',
      sessionId,
      artifactId,
      kind: 'site',
      overview: {
        kind: 'site',
        name: fileName,
        nodeCount: nodes.length,
        selections
      },
      selections
    })
    .catch(() => {});
  setSel(formatSiteSelLabel(selections));
}

function paintPick() {
  postToFrame({ op: 'set-pick', pickActive, selectedIds: selectedIds.slice() });
  if (selectedIds.length) postToFrame({ op: 'rects', ids: selectedIds.slice(), req: 'paint' });
}

function bindPageClicks() {
  paintPick();
}

function ensureSiteFrame() {
  const frame = pageFrame();
  if (!frame) return;
  const want = siteFrameUrl(typeof chrome !== 'undefined' ? chrome.runtime?.getURL?.bind(chrome.runtime) : null);
  if (!frame.getAttribute('src') || !/siteFrame\.html/i.test(frame.getAttribute('src') || '')) {
    frame.src = want;
  }
}

function onSiteFrameMessage(ev) {
  if (!isTrustedSiteChildEvent(ev, frameWin())) return;
  const d = ev.data || {};
  if (d.type === 'ready' || d.type === 'rendered') {
    frameReady = true;
    if (d.type === 'ready' && pendingPaint) postToFrame({ op: 'render', html: pendingPaint });
    paintPick();
    reportState();
    return;
  }
  if (d.type === 'click') {
    if (!pickActive) return;
    selectedIds = nextSitePinIds(
      selectedIds,
      String(d.nodeId || ''),
      { ctrlKey: !!d.ctrlKey, metaKey: !!d.metaKey, shiftKey: !!d.shiftKey },
      liveNodeIds()
    );
    paintPick();
    reportState();
    if (selectedIds.length) setStatus('已点选 · 在侧栏描述要改的内容');
    return;
  }
  if (d.type === 'rects' && d.rects && typeof d.rects === 'object') {
    lastRects = { ...lastRects, ...d.rects };
    paintOfficeSelBubble();
    return;
  }
  if (d.type === 'serialized' && d.req && pendingSerialize.has(d.req)) {
    const done = pendingSerialize.get(d.req);
    pendingSerialize.delete(d.req);
    done(String(d.html || ''));
  }
}

function pickStyleText() {
  return pickActive
    ? '[data-paw-node].paw-picked{outline:2px solid #0d99ff;outline-offset:2px;} [data-paw-node]{cursor:pointer;}'
    : '[data-paw-node].paw-picked{outline:2px solid #0d99ff;outline-offset:2px;}';
}

function setPickActive(on) {
  pickActive = !!on;
  document.body.dataset.pawPick = pickActive ? '1' : '';
  paintPick();
  setStatus(pickActive ? '点选中 · 点击以点选' : '浏览中 · 链接可跳转');
  reportPickerState(pickActive);
}

function applySiteZoom(next) {
  siteZoom = Math.max(0.25, Math.min(4, Number(next) || 1));
  const frame = pageFrame();
  if (frame) frame.style.zoom = String(siteZoom);
  paintOfficeSelBubble();
}

function serializeLiveHtml() {
  return lastHtml;
}

function parseTranslate(transform) {
  const m = /translate\(\s*([-0-9.]+)px\s*,\s*([-0-9.]+)px\s*\)/.exec(String(transform || ''));
  return m ? { x: Number(m[1]) || 0, y: Number(m[2]) || 0 } : { x: 0, y: 0 };
}

function applySiteCommandsLocal(commands) {
  const out = applySiteCommands(lastHtml, commands, { selections: selectedIds.map((nodeId) => ({ nodeId })) });
  if (out.ok === false) {
    setStatus(out.error || '需要先点选节点');
    return false;
  }
  lastHtml = out.html;
  selectedIds = Array.isArray(out.selected) ? out.selected.slice() : [];
  if (Array.isArray(out.nodeIds) && out.nodeIds.length && commands.some((c) => c.op === 'duplicate')) {
    selectedIds = out.nodeIds.slice();
  }
  void rewriteForPreview(lastHtml).then((painted) => {
    renderHtml(lastHtml, painted);
  });
  void persistNow();
  return true;
}

function setUndoChrome() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.hidden = !canUndo;
}

async function rewriteForPreview(html) {
  const src = String(html || '');
  if (!sessionId || !/\/artifacts\//i.test(src)) return src;
  try {
    const out = await workspaceRpc('rewriteGuestMedia', { sessionId, html: src });
    return out?.html || src;
  } catch {
    return src;
  }
}

function renderHtml(sotHtml, previewHtml) {
  const frame = pageFrame();
  if (!frame) return;
  lastHtml = String(sotHtml || '');
  frame.hidden = false;
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
  document.body.classList.add('is-ready');
  teardownMotion(pageDoc());
  pendingPaint = stripScripts(previewHtml != null ? previewHtml : lastHtml);
  ensureSiteFrame();
  frame.onload = () => {
    frameReady = false;
    bindPageClicks();
    applySiteZoom(siteZoom);
  };
  if (frameReady) postToFrame({ op: 'render', html: pendingPaint });
}

function teardownMotion(doc) {
  if (motionHandle) {
    try {
      motionHandle.destroy();
    } catch {
      /* isolate */
    }
    motionHandle = null;
  }
  if (doc) unmountSiteMotion(doc);
}

function bootMotion(doc) {
  if (!doc) return;
  try {
    motionHandle = mountSiteMotion(doc, { pickActive: () => pickActive });
  } catch {
    motionHandle = null;
  }
}

function persistNow() {
  const html = lastHtml;
  saveQueue = saveQueue.catch(() => false).then(() => persistHtml(html));
  return saveQueue;
}

async function persistHtml(html) {
  if (!sessionId || !artifactId) return false;
  ignorePatchUntil = Date.now() + 2500;
  try {
    const saved = await workspaceRpc('updateArtifact', { sessionId, artifactId, content: html, expectedRevision: artifactRevision });
    artifactRevision = Number(saved?.artifact?.revision) || artifactRevision;
    savedHtml = html;
    canUndo = saved?.artifact?.canUndo !== false;
    setUndoChrome();
    setStatus('已保存');
    return true;
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '保存失败');
    return false;
  }
}

function downloadHtml() {
  if (!loadComplete) {
    setStatus('下载已拒绝：文件未完整载入');
    return;
  }
  const blob = new Blob([lastHtml], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName || 'site.html';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('已开始下载 HTML');
}

async function loadFromStore() {
  if (!sessionId || !artifactId) throw new Error('缺少 sessionId 或交付物 id');
  const rec = await fetchCompleteArtifact(
    (method, params) => workspaceRpc(method, params),
    { sessionId, artifactId }
  );
  const bytes = rec.bytes;
  loadComplete = true;
  artifactRevision = Number(rec?.artifact?.revision) || 0;
  fileName = rec?.artifact?.name || rec?.name || 'site.html';
  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.textContent = fileName;
  document.title = `${fileName} · 网页`;
  const raw = rec?.content != null ? String(rec.content) : new TextDecoder().decode(bytes);
  savedHtml = raw;
  canUndo = rec?.artifact?.canUndo === true;
  setUndoChrome();
  const stamped = stampSiteHtml(raw);
  const painted = await rewriteForPreview(stamped);
  renderHtml(stamped, painted);
  if (stamped !== raw) await persistNow();
}

async function applyPatchFromStore() {
  if (!sessionId || !artifactId) return false;
  if (Date.now() < ignorePatchUntil) return true;
  if (lastHtml !== savedHtml) {
    setStatus('有未保存的本地修改；请先下载副本，再重新载入。');
    return false;
  }
  try {
    const rec = await fetchCompleteArtifact(
      (method, params) => workspaceRpc(method, params),
      { sessionId, artifactId }
    );
    const bytes = rec.bytes;
    const raw = rec?.content != null ? String(rec.content) : new TextDecoder().decode(bytes);
    if (!raw) return false;
    canUndo = rec?.artifact?.canUndo === true;
    setUndoChrome();
    const stamped = stampSiteHtml(raw);
    if (stamped === lastHtml) {
      artifactRevision = Number(rec?.artifact?.revision) || 0;
      savedHtml = stamped;
      return true;
    }
    const painted = await rewriteForPreview(stamped);
    renderHtml(stamped, painted);
    artifactRevision = Number(rec?.artifact?.revision) || 0;
    savedHtml = stamped;
    return true;
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '同步失败');
    return false;
  }
}

async function revertNow() {
  if (!sessionId || !artifactId) return false;
  ignorePatchUntil = Date.now() + 2500;
  try {
    await workspaceRpc('revertArtifact', { sessionId, artifactId });
    await loadFromStore();
    setStatus('已撤销');
    return true;
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '无法撤销');
    return false;
  }
}

function wire() {
  window.addEventListener('message', onSiteFrameMessage);
  mountOfficeHelp('site');
  selBubble = mountOfficeSelBubble(document.body, { kind: 'canvas', copiedLabel: '已复制' });
  siteKeys = installOfficeShortcuts({
    surface: 'site',
    isTyping: (e) => isTypingTarget(e.target),
    actions: {
      zoomIn: () => applySiteZoom(stepZoom(siteZoom, 1)),
      zoomOut: () => applySiteZoom(stepZoom(siteZoom, -1)),
      zoomFit: () => applySiteZoom(1),
      save: () => {
        void persistNow();
      },
      undo: () => {
        void revertNow();
      },
      escape: () => {
        const closedHelp = closeOfficeHelp();
        if (selectedIds.length) {
          selectedIds = [];
          paintPick();
          reportState();
          return true;
        }
        return closedHelp;
      },
      selectAll: () => {
        selectedIds = liveNodeIds();
        paintPick();
        reportState();
      },
      delete: () => {
        if (!selectedIds.length) return;
        applySiteCommandsLocal([{ op: 'remove' }]);
      },
      duplicate: () => {
        if (!selectedIds.length) return;
        applySiteCommandsLocal([{ op: 'duplicate' }]);
      },
      nudge: (_e, delta) => {
        if (!selectedIds.length || !delta) return;
        postToFrame({ op: 'nudge', ids: selectedIds.slice(), dx: delta.x, dy: delta.y });
        window.clearTimeout(nudgeTimer);
        nudgeTimer = window.setTimeout(() => {
          void requestFrameSerialize().then((html) => {
            if (html) lastHtml = html;
            void persistNow();
          });
        }, 280);
      }
    }
  });
  document.getElementById('saveBtn')?.addEventListener('click', () => {
    void persistNow();
  });
  document.getElementById('undoBtn')?.addEventListener('click', () => {
    void revertNow();
  });
  document.getElementById('downloadBtn')?.addEventListener('click', () => {
    downloadHtml();
  });
  if (!hasChrome()) return;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      handleWorkTabPickerMessage(msg, sendResponse, {
        getActive: () => pickActive,
        setActive: setPickActive
      })
    ) {
      return false;
    }
    if (msg?.action !== 'browserbot_html_preview_patch') return false;
    const aid = String(msg.artifactId || '');
    if (aid && artifactId && aid !== artifactId) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    void applyPatchFromStore().then((ok) => {
      sendResponse({ ok: true, patched: ok !== false });
    });
    return true;
  });
}

async function boot() {
  if (!sessionId || !artifactId) {
    const bootEl = document.getElementById('boot');
    if (bootEl) {
      bootEl.textContent = '缺少 sessionId 或交付物 id';
      bootEl.classList.add('error');
    }
    return;
  }
  wire();
  try {
    await loadFromStore();
    if (hasChrome()) {
      chrome.runtime
        .sendMessage({
          action: 'html_tab_ready',
          sessionId,
          artifactId
        })
        .catch(() => {});
    }
    setStatus('浏览中 · 点侧栏「点选」后再点选');
  } catch (e) {
    const bootEl = document.getElementById('boot');
    if (bootEl) {
      bootEl.hidden = false;
      bootEl.textContent = e instanceof Error ? e.message : String(e);
      bootEl.classList.add('error');
    }
  }
}

boot().catch((err) => {
  setStatus(err instanceof Error ? err.message : String(err));
});
