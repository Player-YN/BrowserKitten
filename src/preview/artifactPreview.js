import { workspaceRpc } from '../agent/vnext/host/workspaceClient.js';
/**
 * Generic artifact viewer. Editors live on sheet/docs/site.
 * Unknown HTML/JS is escaped text — never executed on the extension origin.
 */
import {
  capabilityForItem,
  inspectorMeta,
  previewTextPayload
} from '../agent/vnext/sessionWorkspace/artifactCapability.js';
import { classifyOpenArtifact, previewEntryForKind, previewEntryForItem, previewViewForItem } from '../agent/vnext/sessionWorkspace/openClassify.js';
import { pdfBytesToHtml, bytesForPdfPreview } from '../agent/vnext/sessionWorkspace/pdfIngest.js';
import { handleWorkTabPickerMessage, reportPickerState } from './workTabPicker.js';
import { resolvePreviewLang } from './previewLang.js';
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

function qsIds() {
  const raw = qs('ids') || qs('artifactId') || '';
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

function hasChrome() {
  return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
}

function previewLang() {
  return resolvePreviewLang({
    query: qs('lang'),
    documentLang: document.documentElement.lang,
    navigatorLang: typeof navigator !== 'undefined' ? navigator.language : ''
  });
}

const PREVIEW_I18N = {
  zh: {
    trunc: '已截断显示，省略 {n} 字符。完整内容请下载。',
    inspectorHint: '通用检查器 · 不执行此文件 · 可下载原字节',
    name: '名称',
    mime: 'MIME',
    size: '大小',
    kind: 'kind',
    family: '家族',
    magic: '魔数',
    view: '打开面',
    prefix: '已截前缀',
    download: '已开始下载',
    image: '图像',
    audio: '音频',
    video: '视频',
    pdf: 'PDF 预览 · 下载得到原始 PDF',
    safeText: '安全文本 · 未执行 HTML/JS',
    text: '只读文本',
    inspector: '检查器 · 仅元数据与下载',
    missing: '缺少 sessionId 或文件 id',
    title: '预览',
    syncFail: '同步失败',
    downloadRefused: '下载已拒绝：文件被截断，未保存损坏副本'
  },
  en: {
    trunc: 'Truncated; omitted {n} characters. Download for the full file.',
    inspectorHint: 'Generic inspector · this file is not executed · original bytes can be downloaded',
    name: 'Name',
    mime: 'MIME',
    size: 'Size',
    kind: 'kind',
    family: 'Family',
    magic: 'Magic',
    view: 'View',
    prefix: 'Prefix only',
    download: 'Download started',
    image: 'Image',
    audio: 'Audio',
    video: 'Video',
    pdf: 'PDF preview · download for the original PDF',
    safeText: 'Safe text · HTML/JS was not executed',
    text: 'Read-only text',
    inspector: 'Inspector · metadata and download only',
    missing: 'Missing sessionId or artifact id',
    title: 'Preview',
    syncFail: 'Sync failed',
    downloadRefused: 'Download refused: bytes were truncated; no damaged copy was saved'
  }
};

function pt(key) {
  const pack = PREVIEW_I18N[previewLang()] || PREVIEW_I18N.zh;
  return pack[key] || PREVIEW_I18N.zh[key] || key;
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg || '';
}

function b64ToBytes(b64) {
  const s = String(b64 || '');
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sessionId = qs('sessionId');
const artifactIds = qsIds();
let artifactId = artifactIds[0] || qs('artifactId') || '';
let lastHtml = '';
let lastText = '';
let fileName = 'preview.html';
let ignorePatchUntil = 0;
let viewPlan = { view: 'inspector', kind: 'unknown', canSave: false, mimeType: 'application/octet-stream', downloadName: '' };
let rawBytes = new Uint8Array(0);
let imageUrl = '';
let mediaUrl = '';
let pickActive = false;

function pageFrame() {
  return document.getElementById('page');
}

function showPane(id) {
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
  document.body.classList.add('is-ready');
  for (const paneId of ['page', 'imageWrap', 'fileCard', 'textWrap', 'mediaWrap', 'inspector']) {
    const el = document.getElementById(paneId);
    if (el) el.hidden = paneId !== id;
  }
}

function renderRebuiltHtml(html) {
  const frame = pageFrame();
  if (!frame) return;
  lastHtml = String(html || '');
  showPane('page');
  frame.removeAttribute('srcdoc');
  frame.srcdoc = lastHtml;
}

function renderImage(bytes, mimeType) {
  const img = document.getElementById('image');
  if (!img) return;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
  img.src = imageUrl;
  img.alt = fileName;
  showPane('imageWrap');
}

function renderText(raw) {
  lastText = String(raw || '');
  const payload = previewTextPayload(lastText);
  const trunc = document.getElementById('textTrunc');
  const body = document.getElementById('textBody');
  if (trunc) {
    trunc.hidden = !payload.truncated;
    trunc.textContent = payload.truncated
      ? pt('trunc').replace('{n}', String(payload.omitted))
      : '';
  }
  if (body) body.textContent = payload.text;
  showPane('textWrap');
}

function renderMedia(bytes, mimeType, kind) {
  const wrap = document.getElementById('mediaWrap');
  if (!wrap) return;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
  wrap.replaceChildren();
  const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
  el.controls = true;
  el.src = mediaUrl;
  el.setAttribute('controlslist', 'nodownload');
  wrap.appendChild(el);
  showPane('mediaWrap');
}

function renderInspector(item) {
  const card = document.getElementById('inspector') || document.getElementById('fileCard');
  if (!card) return;
  const meta = inspectorMeta(item, rawBytes);
  card.textContent = '';
  const nameEl = document.createElement('div');
  nameEl.className = 'file-card-name';
  nameEl.textContent = meta.name || fileName;
  const hint = document.createElement('div');
  hint.className = 'file-card-meta';
  hint.textContent = pt('inspectorHint');
  const dl = document.createElement('dl');
  const rows = [
    [pt('name'), meta.name],
    [pt('mime'), meta.mimeType],
    [pt('size'), formatBytes(meta.byteLength)],
    [pt('kind'), meta.kind],
    [pt('family'), meta.family],
    [pt('magic'), meta.magic],
    [pt('view'), meta.view]
  ];
  if (meta.truncated) rows.push([pt('prefix'), formatBytes(meta.prefixBytes)]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v || '—');
    dl.append(dt, dd);
  }
  card.append(nameEl, hint, dl);
  showPane(card.id);
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

async function persistNow() {
  return false;
}

async function downloadCurrent() {
  try {
    const rec = await fetchCompleteArtifact(
      (method, params) => workspaceRpc(method, params),
      { sessionId, artifactId }
    );
    const blob = new Blob([rec.bytes], { type: rec.mimeType || viewPlan.mimeType || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rec.artifact?.name || viewPlan.downloadName || fileName || 'download';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(pt('download'));
    return true;
  } catch (err) {
    setStatus(err?.code === ARTIFACT_TRUNCATED ? pt('downloadRefused') : err instanceof Error ? err.message : pt('syncFail'));
    return false;
  }
}

async function readItem() {
  const rec = await workspaceRpc('readArtifactPreview', {
    sessionId,
    artifactId,
    maxBytes: 8 * 1024 * 1024
  });
  fileName = rec?.artifact?.name || rec?.name || artifactId;
  return {
    artifactId,
    name: fileName,
    mimeType: rec?.mimeType || rec?.artifact?.mimeType || '',
    bytes: bytesForPdfPreview({
      base64: rec?.base64,
      content: rec?.content,
      bytes: b64ToBytes(rec?.base64)
    }),
    text: rec?.content != null ? String(rec.content) : '',
    artifact: rec?.artifact,
    truncated: rec?.truncated === true,
    byteLength: rec?.byteLength
  };
}

function applyViewChrome() {
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) saveBtn.hidden = true;
}

async function renderByPlan(item) {
  rawBytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(0);
  const cap = capabilityForItem(item);
  if (viewPlan.view === 'image') {
    renderImage(rawBytes, viewPlan.mimeType);
    setStatus(`${pt('image')} · ${(viewPlan.kind || '').toUpperCase()} · ${formatBytes(rawBytes.byteLength)}`);
    return;
  }
  if (viewPlan.view === 'pdf') {
    const converted = await pdfBytesToHtml(item.bytes, { title: fileName || 'PDF' });
    renderRebuiltHtml(converted.html);
    setStatus(converted.warning || pt('pdf'));
    return;
  }
  if (viewPlan.view === 'media') {
    renderMedia(rawBytes, viewPlan.mimeType, cap.kind);
    setStatus(`${cap.kind === 'audio' ? pt('audio') : pt('video')} · ${formatBytes(rawBytes.byteLength)}`);
    return;
  }
  if (viewPlan.view === 'text') {
    const raw =
      item.text ||
      (rawBytes.byteLength ? new TextDecoder().decode(rawBytes.slice(0, 400_000)) : '');
    renderText(raw);
    setStatus(cap.kind === 'html' ? pt('safeText') : pt('text'));
    return;
  }
  renderInspector(item);
  setStatus(pt('inspector'));
}

async function applyPatchFromStore() {
  if (!sessionId || !artifactId) return false;
  if (Date.now() < ignorePatchUntil) return true;
  try {
    const item = await readItem();
    await renderByPlan(item);
    return true;
  } catch (e) {
    setStatus(e instanceof Error ? e.message : pt('syncFail'));
    return false;
  }
}

async function refreshFromStore() {
  return applyPatchFromStore();
}

function wire() {
  document.getElementById('saveBtn')?.addEventListener('click', () => {
    void persistNow();
  });
  document.getElementById('downloadBtn')?.addEventListener('click', () => {
    void downloadCurrent();
  });
  if (!hasChrome()) return;
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
    if (msg?.action !== 'browserbot_html_preview_patch') return false;
    const aid = String(msg.artifactId || '');
    if (aid && artifactId && aid !== artifactId) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    void refreshFromStore().then((ok) => {
      sendResponse({ ok: true, patched: ok !== false });
    });
    return true;
  });
}

async function boot() {
  const loc = previewLang();
  document.documentElement.lang = loc === 'zh' ? 'zh-CN' : 'en';
  if (!sessionId || !artifactIds.length) {
    const bootEl = document.getElementById('boot');
    if (bootEl) {
      bootEl.textContent = pt('missing');
      bootEl.classList.add('error');
    }
    return;
  }
  wire();
  try {
    const item = await readItem();
    const titleEl = document.getElementById('title');
    if (titleEl) titleEl.textContent = fileName;
    document.title = `${fileName} · ${pt('title')}`;
    const routed = previewEntryForItem(item);
    let dest = routed.entry || previewEntryForKind(classifyOpenArtifact(item).kind);
    if (dest === 'design.html') dest = 'artifactPreview.html';
    if (dest !== 'artifactPreview.html') {
      const q = new URLSearchParams();
      q.set('sessionId', sessionId);
      q.set('artifactId', artifactId);
      q.set('lang', loc);
      location.replace(`./${dest}?${q.toString()}`);
      return;
    }
    viewPlan = previewViewForItem(item);
    applyViewChrome();
    await renderByPlan(item);
    if (hasChrome()) {
      chrome.runtime
        .sendMessage({ action: 'html_tab_ready', sessionId, artifactId })
        .catch(() => {});
    }
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
