// Static import only — dynamic import() is disallowed on ServiceWorkerGlobalScope
// (https://github.com/w3c/ServiceWorker/issues/1356) and surfaces as Workspace RPC errors.
import { loadLlmSettings } from './agent/llm.js';
import { sheetTabMatches, htmlTabMatches } from './sidepanel/sessionIsolation.js';
import { previewEntryForItem } from './agent/vnext/sessionWorkspace/openClassify.js';
import { handleWorkspaceSys } from './agent/vnext/host/browserSysHost.js';
import { ensureParallelSearchHeaders } from './agent/vnext/host/parallelSearchHeaders.js';
import {
  peekTabLease,
  preparePageActionTarget,
  releaseTabLease,
  releaseTabLeasesByExecution
} from './agent/vnext/host/tabLease.js';
import { createTaskScheduler, resolveTaskPage } from './agent/vnext/host/taskScheduler.js';
import {
  isPawWorkPageUrl,
  isPawLockableWorkPageUrl,
  sessionIdFromPawWorkUrl,
  sessionGroupTitle,
  sessionGroupUpdate,
  shouldFocusPawWorkTab,
  shouldJoinSessionGroup,
  shouldLockWorkTab,
  tabCreateProps
} from './agent/vnext/host/pawTabGroups.js';
import { isMentionablePageUrl, normalizePageRef } from './agent/vnext/sessionWorkspace/pageContext.js';

const PAWWORK_OFFSCREEN_URL = 'src/offscreen/runtime.html';
let pawworkOffscreenCreating = null;

function isPawWorkOffscreenSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const expected = chrome.runtime.getURL(PAWWORK_OFFSCREEN_URL);
  const actual = String(sender.url || '');
  if (actual === expected) return true;
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.origin === e.origin && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

async function ensurePawWorkOffscreen() {
  if (!chrome.offscreen) throw new Error('chrome.offscreen unavailable');
  const offscreenUrl = chrome.runtime.getURL(PAWWORK_OFFSCREEN_URL);
  if (typeof chrome.offscreen.hasDocument === 'function') {
    if (await chrome.offscreen.hasDocument()) return;
  } else if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  } else {
    const clients = await self.clients.matchAll();
    if (clients.some((client) => client.url === offscreenUrl)) return;
  }
  if (pawworkOffscreenCreating) return pawworkOffscreenCreating;
  pawworkOffscreenCreating = chrome.offscreen.createDocument({
    url: PAWWORK_OFFSCREEN_URL,
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run the browser-resident Web Workspace agent and materialize selected content independently of the side panel.'
  }).finally(() => { pawworkOffscreenCreating = null; });
  return pawworkOffscreenCreating;
}
function isTransientOffscreenRpcError(err, response) {
  if (!err) return false;
  const msg = String(err?.message || err || response?.error || '');
  return (
    /Receiving end does not exist/i.test(msg) ||
    /Could not establish connection/i.test(msg) ||
    /The message port closed/i.test(msg)
  );
}

/** Empty sendMessage replies may be a dead offscreen. Replay only idempotent reads. */
const RPC_RETRY_EMPTY_METHODS = new Set([
  'getWorkspaceState',
  'getSession',
  'listArtifacts',
  'listSkills',
  'listTasks',
  'getTask',
  'getTaskSchedule'
]);

async function forwardWorkspaceRpc(request) {
  const payload = {
    target: 'pawwork-offscreen',
    action: 'workspace_rpc_execute',
    method: request.method,
    params: request.params || {}
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await ensurePawWorkOffscreen();
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (response && typeof response === 'object') return response;
      // A missing result is not proof that a write or agent turn never ran.
      const unknown = Object.assign(
        new Error('Workspace RPC result is unknown; inspect state before retrying.'),
        { code: 'RPC_OUTCOME_UNKNOWN' }
      );
      if (!RPC_RETRY_EMPTY_METHODS.has(String(request.method || ''))) throw unknown;
      lastErr = unknown;
    } catch (err) {
      lastErr = err;
      if (!isTransientOffscreenRpcError(err, null)) throw err;
    }
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
  }
  throw lastErr || new Error('workspace offscreen unavailable');
}

// PageWand Service Worker - Native Downloads & Smart Auto-Zip Engine

chrome.runtime.onInstalled.addListener(() => {
  console.log("[PageWand] Background Service Worker Initialized.");
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Handle custom keyboard command
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-picker") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: "toggle_picker_shortcut" });
    }
    return;
  }
  // CAPTURE_WP: user hotkey → region select (Win+Shift+S style) → crop → attach
  if (command === "capture-screenshot") {
    try {
      const result = await captureVisibleTabForUser("hotkey");
      if (result?.cancelled) {
        await toastOnActiveTab("截图已取消");
      }
    } catch (err) {
      console.error("[PageWand] capture-screenshot command failed:", err);
      await toastOnActiveTab(`❌ 截图失败: ${err?.message || err}`);
    }
  }
});

// ── CAPTURE_WP: user-operated region screenshot (like Windows Snip) ────────
const CAPTURE_DEDUP_MS = 800;
const REGION_SELECT_TIMEOUT_MS = 120000;
let lastCaptureAt = 0;
/** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
const pendingRegionSelectByTab = new Map();

/**
 * User-operated capture: show crosshair region picker on the page, then
 * captureVisibleTab + crop to the selected rectangle (not full-page dump).
 * @param {'hotkey'|'button'|'message'} source
 * @returns {Promise<{ok:boolean, dataUrl?:string, name?:string, clipboardOk?:boolean, error?:string, cancelled?:boolean, deduped?:boolean}>}
 */
async function captureVisibleTabForUser(source = "message") {
  const now = Date.now();
  if (now - lastCaptureAt < CAPTURE_DEDUP_MS) {
    return { ok: false, error: "deduped", deduped: true };
  }
  lastCaptureAt = now;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.windowId == null || tab.id == null) {
    lastCaptureAt = 0;
    throw new Error("No active tab");
  }
  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://")
  ) {
    lastCaptureAt = 0;
    throw new Error("Cannot capture browser internal pages (chrome:// / edge://)");
  }

  // 1) Interactive region select on the page (crosshair + drag)
  let region;
  try {
    region = await promptRegionSelect(tab.id);
  } catch (e) {
    lastCaptureAt = 0;
    throw e;
  }
  if (!region) {
    lastCaptureAt = 0;
    return { ok: false, cancelled: true, error: "cancelled" };
  }

  // 2) Overlay is already removed; wait 2 frames so it is not in the bitmap
  await delayMs(50);

  let fullDataUrl;
  try {
    fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    lastCaptureAt = 0;
    throw new Error(e?.message || "captureVisibleTab failed");
  }
  if (!fullDataUrl || typeof fullDataUrl !== "string") {
    lastCaptureAt = 0;
    throw new Error("Empty capture result");
  }

  // 3) Crop to CSS-pixel rect scaled to actual capture pixels
  let dataUrl;
  try {
    dataUrl = await cropDataUrlToRegion(fullDataUrl, region);
  } catch (cropErr) {
    lastCaptureAt = 0;
    throw new Error(cropErr?.message || "Crop failed");
  }

  const name = `screenshot_${Date.now()}.png`;
  let clipboardOk = false;

  // Best-effort image clipboard write in the page (SW has no ClipboardItem UI focus)
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (pngDataUrl) => {
        try {
          if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
          const res = await fetch(pngDataUrl);
          const blob = await res.blob();
          const type = blob.type || "image/png";
          await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
          return true;
        } catch {
          return false;
        }
      },
      args: [dataUrl]
    });
    clipboardOk = !!(injected && injected[0] && injected[0].result === true);
  } catch (clipErr) {
    console.warn("[PageWand] clipboard inject failed:", clipErr);
  }

  const payload = {
    action: "screenshot_captured",
    dataUrl,
    name,
    type: "image/png",
    clipboardOk,
    source,
    region: true,
    tabId: tab.id,
    tabTitle: tab.title || "",
    ts: Date.now()
  };

  // Button/message: the requester attaches from the return value.
  // Hotkey: no waiting caller — broadcast + stash so an open (or later) sidepanel can attach once.
  if (source === "hotkey") {
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (_) {}
    try {
      await chrome.storage.local.set({
        pagewand_pending_screenshot: {
          dataUrl,
          name,
          type: "image/png",
          clipboardOk,
          source,
          ts: Date.now()
        }
      });
    } catch (storeErr) {
      console.warn("[PageWand] pending screenshot store failed:", storeErr);
    }
  }

  const toastMsg = clipboardOk
    ? "📸 区域截图已复制到剪贴板，并附到对话（打开侧栏查看）"
    : "📸 区域截图已捕获并附到对话（打开侧栏查看）";
  await toastOnActiveTab(toastMsg, tab.id);

  return { ok: true, dataUrl, name, clipboardOk, source };
}

function delayMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask content script to show snipping overlay; resolve with region or null if cancelled.
 * @param {number} tabId
 * @returns {Promise<object|null>}
 */
function promptRegionSelect(tabId) {
  return new Promise(async (resolve, reject) => {
    // Cancel any prior waiter on this tab
    const prior = pendingRegionSelectByTab.get(tabId);
    if (prior) {
      clearTimeout(prior.timer);
      prior.resolve(null);
      pendingRegionSelectByTab.delete(tabId);
    }

    const timer = setTimeout(() => {
      pendingRegionSelectByTab.delete(tabId);
      try {
        chrome.tabs.sendMessage(tabId, { action: "pagewand_cancel_region_capture" }).catch(() => {});
      } catch (_) {}
      reject(new Error("截图选择超时"));
    }, REGION_SELECT_TIMEOUT_MS);

    pendingRegionSelectByTab.set(tabId, { resolve, reject, timer });

    try {
      await ensureRegionCaptureUi(tabId);
      await chrome.tabs.sendMessage(tabId, { action: "pagewand_start_region_capture" });
    } catch (e) {
      clearTimeout(timer);
      pendingRegionSelectByTab.delete(tabId);
      reject(new Error(e?.message || "无法在页面上打开截图选择（请刷新页面后重试）"));
    }
  });
}

/**
 * Ensure content script is ready to show the region overlay.
 * @param {number} tabId
 */
async function ensureRegionCaptureUi(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (pong?.status === "pong") return;
  } catch (_) {
    // not injected yet
  }
  // Root manifest loads src/content_script.js; also try bare path for src/ manifest loads
  const candidates = ["src/content_script.js", "content_script.js"];
  let lastErr;
  for (const file of candidates) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
}

/**
 * Crop a full-viewport PNG dataURL to a CSS-pixel region.
 * @param {string} dataUrl
 * @param {{ x:number, y:number, width:number, height:number, viewportWidth?:number, viewportHeight?:number, dpr?:number }} region
 * @returns {Promise<string>} cropped PNG dataURL
 */
async function cropDataUrlToRegion(dataUrl, region) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const vw = region.viewportWidth > 0 ? region.viewportWidth : bitmap.width / (region.dpr || 1);
  const vh = region.viewportHeight > 0 ? region.viewportHeight : bitmap.height / (region.dpr || 1);
  const scaleX = bitmap.width / vw;
  const scaleY = bitmap.height / vh;

  let sx = Math.round(region.x * scaleX);
  let sy = Math.round(region.y * scaleY);
  let sw = Math.round(region.width * scaleX);
  let sh = Math.round(region.height * scaleY);

  sx = Math.max(0, Math.min(sx, bitmap.width - 1));
  sy = Math.max(0, Math.min(sy, bitmap.height - 1));
  sw = Math.max(1, Math.min(sw, bitmap.width - sx));
  sh = Math.max(1, Math.min(sh, bitmap.height - sy));

  if (typeof OffscreenCanvas === "undefined") {
    bitmap.close?.();
    throw new Error("OffscreenCanvas not available for crop");
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("2d context unavailable");
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close?.();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(outBlob);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("FileReader failed"));
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/** Resolve pending region-select waiters from content script messages. */
function handleRegionSelectMessage(request, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return false;
  const waiter = pendingRegionSelectByTab.get(tabId);
  if (!waiter) return false;

  if (request.action === "pagewand_region_selected") {
    clearTimeout(waiter.timer);
    pendingRegionSelectByTab.delete(tabId);
    const r = request.region || {};
    waiter.resolve({
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      viewportWidth: Number(r.viewportWidth) || 0,
      viewportHeight: Number(r.viewportHeight) || 0,
      dpr: Number(r.dpr) || 1
    });
    return true;
  }
  if (request.action === "pagewand_region_cancelled") {
    clearTimeout(waiter.timer);
    pendingRegionSelectByTab.delete(tabId);
    waiter.resolve(null);
    return true;
  }
  return false;
}

async function toastOnActiveTab(msg, tabId) {
  try {
    let id = tabId;
    if (id == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      id = tab?.id;
    }
    if (id == null) return;
    chrome.tabs.sendMessage(id, { action: "show_custom_toast", msg }).catch(() => {});
  } catch (_) {}
}

// Pure JavaScript ZIP Packer (STORE Method - Zero Dependencies)
function createZipBlob(files) {
  const parts = [];
  const centralDirectory = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = new Uint8Array(file.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes)
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 10, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    parts.push(header);
    parts.push(dataBytes);

    // Central directory header (46 bytes)
    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cdHeader.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 10, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    cdView.setUint32(16, crc, true);
    cdView.setUint32(20, size, true);
    cdView.setUint32(24, size, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint16(32, 0, true);
    cdView.setUint16(34, 0, true);
    cdView.setUint16(36, 0, true);
    cdView.setUint32(38, 0, true);
    cdView.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    centralDirectory.push(cdHeader);
    offset += header.length + dataBytes.length;
  });

  const cdOffset = offset;
  let cdSize = 0;
  centralDirectory.forEach(cd => {
    parts.push(cd);
    cdSize += cd.length;
  });

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

// Convert Blob to Data URL helper for Service Worker
function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function getExtensionFromDataUrlOrPath(urlStr) {
  if (!urlStr) return 'bin';
  const lower = String(urlStr).toLowerCase();
  if (lower.includes('text/csv')) return 'csv';
  if (lower.includes('image/svg') || lower.includes('svg+xml')) return 'svg';
  if (lower.includes('image/png')) return 'png';
  if (lower.includes('image/webp')) return 'webp';
  if (lower.includes('image/gif')) return 'gif';
  if (lower.includes('image/jpeg')) return 'jpg';
  try {
    const path = new URL(urlStr, 'https://local.invalid').pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (m) return m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.webp')) return 'webp';
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.svg')) return 'svg';
  return 'bin';
}

// Smart Batch Downloads Handler (Data URL & Cross-Domain Protected)
/** One auto-preview tab per artifact for a short window (host, not model). */
const htmlPreviewOpened = new Map();

function artifactPreviewUrl(sessionId, artifactIds, entry = 'artifactPreview.html') {
  const sid = String(sessionId || '');
  const ids = [...new Set((artifactIds || []).map(String).filter(Boolean))];
  const q = new URLSearchParams();
  if (sid) q.set('sessionId', sid);
  if (ids.length) q.set('ids', ids.join(','));
  if (ids.length === 1) q.set('artifactId', ids[0]);
  const page = String(entry || 'artifactPreview.html').replace(/^\.\//, '');
  return chrome.runtime.getURL(`src/preview/${page}?${q.toString()}`);
}

/** sessionId|artifactId → tabId for the live Univer sheet. */
const sheetTabByKey = new Map();
const sheetReadyWaiters = new Map();

function sheetKey(sessionId, artifactId) {
  return `${sessionId || ''}::${artifactId || ''}`;
}

function sheetUrl(sessionId, artifactId) {
  const q = new URLSearchParams();
  q.set('sessionId', String(sessionId || ''));
  q.set('artifactId', String(artifactId || ''));
  return chrome.runtime.getURL(`src/preview/sheet.html?${q.toString()}`);
}

async function findSheetTab(sessionId, artifactId) {
  const key = sheetKey(sessionId, artifactId);
  const cached = sheetTabByKey.get(key);
  if (cached != null) {
    try {
      const t = await chrome.tabs.get(cached);
      if (t?.id != null) return t.id;
    } catch {
      sheetTabByKey.delete(key);
    }
  }
  const url = sheetUrl(sessionId, artifactId);
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find(
    (t) => (t.url || '') === url || sheetTabMatches(t.url || '', sessionId, artifactId)
  );
  if (hit?.id != null) {
    sheetTabByKey.set(key, hit.id);
    return hit.id;
  }
  return null;
}

const sheetReadyKeys = new Set();

/** sessionId → chrome.tabGroups id. One collapsed group per task. */
const pawSessionGroupById = new Map();

async function resolveSessionGroupTitle(sessionId, fallbackTitle) {
  const sid = String(sessionId || '').trim();
  const explicit = String(fallbackTitle || '').trim();
  if (explicit) return sessionGroupTitle({ title: explicit, sessionId: sid });
  try {
    const rec = await forwardWorkspaceRpc({
      method: 'getSession',
      params: { sessionId: sid }
    });
    const payload = rec?.ok ? rec.result || rec : rec;
    return sessionGroupTitle({
      title: payload?.title || payload?.name || '',
      sessionId: sid
    });
  } catch {
    return sessionGroupTitle({ sessionId: sid });
  }
}

function isTabInGroup(tab) {
  const gid = tab?.groupId;
  if (gid == null || gid < 0) return false;
  if (typeof chrome.tabGroups?.TAB_GROUP_ID_NONE === 'number' && gid === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return false;
  }
  return true;
}

async function attachTabToSessionGroup(tabId, sessionId, opts = {}) {
  if (tabId == null) return null;
  const sid = String(sessionId || '').trim();
  if (!sid || !chrome.tabs?.group || !chrome.tabGroups?.update) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const live = tab?.url || '';
    const intended = opts.url || '';
    const url = isPawWorkPageUrl(live) ? live : intended || live;
    if (!shouldJoinSessionGroup({ url, sessionId: sid, reason: opts.reason })) return null;

    let groupId = pawSessionGroupById.get(sid);
    if (groupId != null) {
      try {
        await chrome.tabGroups.get(groupId);
      } catch {
        pawSessionGroupById.delete(sid);
        groupId = undefined;
      }
    }
    if (groupId == null) {
      const tabs = await chrome.tabs.query({});
      const sibling = tabs.find((t) => {
        if (t.id === tabId || !isTabInGroup(t)) return false;
        const u = t.url || '';
        return isPawWorkPageUrl(u) && sessionIdFromPawWorkUrl(u) === sid;
      });
      if (sibling && isTabInGroup(sibling)) groupId = sibling.groupId;
    }

    const nextId = await chrome.tabs.group(
      groupId != null ? { tabIds: [tabId], groupId } : { tabIds: [tabId] }
    );
    pawSessionGroupById.set(sid, nextId);
    const title = await resolveSessionGroupTitle(sid, opts.title);
    await chrome.tabGroups.update(nextId, sessionGroupUpdate({ title, sessionId: sid, collapsed: true }));
    return nextId;
  } catch {
    return null;
  }
}

/** sessionId → in-flight sendMessage. Work tabs lock; live web never does. */
const lockedWorkSessions = new Set();

async function listLockableWorkTabs(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return [];
  }
  return tabs.filter((tab) => shouldLockWorkTab({ url: tab.url || '', lockedSessionId: sid }));
}

function sendWorkLockToTab(tabId, sessionId, locked) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { action: 'paw_work_lock', sessionId, locked: !!locked })
    .catch(() => {});
}

async function broadcastSessionWorkLock(sessionId, locked) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const tabs = await listLockableWorkTabs(sid);
  for (const tab of tabs) {
    if (tab.id == null) continue;
    sendWorkLockToTab(tab.id, sid, locked);
  }
}

function setSessionWorkLock(sessionId, locked) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  if (locked) lockedWorkSessions.add(sid);
  else lockedWorkSessions.delete(sid);
  void broadcastSessionWorkLock(sid, locked);
}

function pushWorkLockIfActive(sender, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || !lockedWorkSessions.has(sid)) return;
  const url = sender?.tab?.url || '';
  if (!isPawLockableWorkPageUrl(url)) return;
  if (sessionIdFromPawWorkUrl(url) !== sid) return;
  sendWorkLockToTab(sender.tab.id, sid, true);
}

async function openPawWorkTab({ url, sessionId, focus = false, title, reason } = {}) {
  const wantFocus = shouldFocusPawWorkTab({ focus, reason });
  const tab = await chrome.tabs.create(tabCreateProps({ url, focus: wantFocus }));
  if (tab?.id != null) {
    await attachTabToSessionGroup(tab.id, sessionId, {
      title,
      url,
      reason: reason || (wantFocus ? 'user' : 'agent')
    });
    if (wantFocus) {
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch {
        /* tab may have closed */
      }
    }
  }
  return tab;
}

async function activatePawWorkTab(tabId, opts = {}) {
  if (tabId == null) return;
  await attachTabToSessionGroup(tabId, opts.sessionId, opts);
  if (shouldFocusPawWorkTab(opts)) {
    await chrome.tabs.update(tabId, { active: true });
  }
}

async function openSheetTab(sessionId, artifactId, opts = {}) {
  const focus = shouldFocusPawWorkTab(opts);
  const reason = opts.reason || (focus ? 'user' : 'agent');
  const existing = await findSheetTab(sessionId, artifactId);
  if (existing != null) {
    await activatePawWorkTab(existing, {
      focus,
      sessionId,
      title: opts.title,
      reason,
      url: sheetUrl(sessionId, artifactId)
    });
    return existing;
  }
  const key = sheetKey(sessionId, artifactId);
  const tab = await openPawWorkTab({
    url: sheetUrl(sessionId, artifactId),
    sessionId,
    focus,
    title: opts.title,
    reason
  });
  if (tab?.id != null) sheetTabByKey.set(key, tab.id);
  return tab?.id;
}

function waitSheetReady(sessionId, artifactId, timeoutMs = 20000) {
  const key = sheetKey(sessionId, artifactId);
  if (sheetReadyKeys.has(key) && sheetTabByKey.has(key)) {
    return Promise.resolve(sheetTabByKey.get(key));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sheetReadyWaiters.delete(key);
      reject(new Error('sheet tab timeout'));
    }, timeoutMs);
    const prev = sheetReadyWaiters.get(key) || [];
    prev.push({
      resolve: (id) => {
        clearTimeout(timer);
        resolve(id);
      },
      reject
    });
    sheetReadyWaiters.set(key, prev);
  });
}

async function sendSheetRpc(sessionId, artifactId, payload) {
  let tabId = await findSheetTab(sessionId, artifactId);
  if (tabId == null) {
    await openSheetTab(sessionId, artifactId, { focus: false, reason: 'agent' });
    try {
      tabId = await waitSheetReady(sessionId, artifactId);
    } catch {
      tabId = await findSheetTab(sessionId, artifactId);
    }
  }
  if (tabId == null) throw new Error('sheet tab unavailable');
  const res = await chrome.tabs.sendMessage(tabId, {
    action: 'pawwork_sheet_rpc',
    sessionId,
    artifactId,
    ...payload
  });
  return res;
}

async function handleSheetHost(request) {
  const sessionId = String(request.sessionId || '');
  let artifactId = String(request.artifactId || '');
  const method = String(request.method || 'overview');
  if (method === 'create') {
    const created = await forwardWorkspaceRpc({
      method: 'createSheetArtifact',
      params: {
        sessionId,
        name: request.name,
        sheets: request.sheets,
        kind: request.kind || 'csv'
      }
    });
    if (!created?.ok) return created;
    artifactId = created.result?.artifact?.artifactId || created.result?.artifactId || artifactId;
    await openSheetTab(sessionId, artifactId, { focus: false, reason: 'agent' });
    try {
      await waitSheetReady(sessionId, artifactId);
    } catch {
      /* still return create */
    }
    return created;
  }
  const res = await sendSheetRpc(sessionId, artifactId, {
    method,
    commands: request.commands,
    a1: request.a1,
    sheet: request.sheet,
    statusText: request.statusText,
    promptId: request.promptId
  });
  return { ok: res?.ok !== false, result: res, error: res?.error };
}

const htmlTabByKey = new Map();
const htmlReadyKeys = new Set();
const htmlReadyWaiters = new Map();

function htmlPreviewKey(sessionId, artifactId) {
  return `${sessionId || ''}::${artifactId || ''}`;
}

function waitHtmlReady(sessionId, artifactId, timeoutMs = 20000) {
  const key = htmlPreviewKey(sessionId, artifactId);
  if (htmlReadyKeys.has(key) && htmlTabByKey.has(key)) {
    return Promise.resolve(htmlTabByKey.get(key));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      htmlReadyWaiters.delete(key);
      reject(new Error('preview tab timeout'));
    }, timeoutMs);
    const prev = htmlReadyWaiters.get(key) || [];
    prev.push({
      resolve: (id) => {
        clearTimeout(timer);
        resolve(id);
      },
      reject
    });
    htmlReadyWaiters.set(key, prev);
  });
}

async function handleCanvasHost(_request) {
  return {
    ok: false,
    code: 'NO_CANVAS',
    error: 'Design/Slides (tldraw) is removed. Leftover json-canvas opens as generic preview.'
  };
}

async function patchHtmlPreviewTab(sessionId, artifactId) {
  const sid = String(sessionId || '');
  const aid = String(artifactId || '');
  if (!aid) return { ok: false, missing: true };
  let tabId = htmlTabByKey.get(htmlPreviewKey(sid, aid));
  if (tabId == null) {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => {
      const u = t.url || '';
      return (
        (/artifactPreview\.html/.test(u) || /site\.html/.test(u)) &&
        htmlTabMatches(u, sid, aid)
      );
    });
    if (hit?.id != null) tabId = hit.id;
  }
  if (tabId == null) return { ok: false, missing: true };
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      action: 'pawwork_html_preview_patch',
      sessionId: sid,
      artifactId: aid
    });
    return { ok: res?.ok !== false, result: res };
  } catch {
    return { ok: false, missing: true };
  }
}

async function resolvePreviewRoute(sessionId, artifactId, opts = {}) {
  if (opts.kind === 'design' || opts.kind === 'slides' || opts.shell === 'design' || opts.shell === 'slides') {
    return { entry: 'artifactPreview.html', shell: '' };
  }
  if (opts.kind === 'site' || opts.kind === 'web' || opts.kind === 'html-site' || opts.entry === 'site.html') {
    return { entry: 'site.html', shell: '' };
  }
  if (opts.entry === 'design.html') {
    return { entry: 'artifactPreview.html', shell: '' };
  }
  if (opts.entry === 'sheet.html' || opts.entry === 'docs.html') {
    return { entry: opts.entry, shell: '' };
  }
  if (!artifactId) return { entry: 'artifactPreview.html', shell: '' };
  try {
    const rec = await forwardWorkspaceRpc({
      method: 'readArtifact',
      params: { sessionId, artifactId }
    });
    const payload = rec?.ok ? rec.result || rec : rec;
    const routed = previewEntryForItem({
      text: payload?.content,
      content: payload?.content,
      name: payload?.artifact?.name || payload?.name,
      mimeType: payload?.mimeType || payload?.artifact?.mimeType
    });
    return { entry: routed.entry || 'artifactPreview.html', shell: routed.shell || '' };
  } catch {
    return { entry: 'artifactPreview.html', shell: '' };
  }
}

async function openArtifactPreviewTab(sessionId, artifactIds, opts = {}) {
  const ids = [...new Set((artifactIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { ok: false, message: 'no artifact ids' };
  const focus = shouldFocusPawWorkTab(opts);
  const reason = opts.reason || (focus ? 'user' : 'preview');
  const routed = await resolvePreviewRoute(sessionId, ids[0], opts);
  const url =
    routed.entry === 'sheet.html'
      ? sheetUrl(sessionId, ids[0])
      : routed.entry === 'docs.html'
        ? chrome.runtime.getURL(
            `src/preview/docs.html?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(ids[0])}`
          )
        : routed.entry === 'site.html'
          ? artifactPreviewUrl(sessionId, ids, 'site.html')
          : artifactPreviewUrl(sessionId, ids);
  try {
    const tabs = await chrome.tabs.query({});
    const sid = String(sessionId || '');
    const existing = tabs.find((t) => {
      const u = t.url || '';
      if (
        !u.includes('artifactPreview.html') &&
        !u.includes('docs.html') &&
        !u.includes('site.html')
      ) {
        return false;
      }
      return ids.some((id) => htmlTabMatches(u, sid, id));
    });
    if (existing?.id != null) {
      const have = existing.url || '';
      const wantSite = url.includes('site.html');
      const haveSite = have.includes('site.html');
      if (wantSite !== haveSite) {
        await chrome.tabs.update(existing.id, focus ? { url, active: true } : { url });
      } else {
        if (focus) await chrome.tabs.update(existing.id, { active: true });
        await patchHtmlPreviewTab(sid, ids[0]);
      }
      await attachTabToSessionGroup(existing.id, sid, { title: opts.title, url, reason });
      if (focus) {
        try {
          await chrome.tabs.update(existing.id, { active: true });
        } catch {
          /* tab may have closed */
        }
      }
      return { ok: true, tabId: existing.id, reused: true, entry: routed.entry };
    }
    const tab = await openPawWorkTab({
      url,
      sessionId: sid,
      focus,
      title: opts.title,
      reason
    });
    return { ok: true, tabId: tab?.id, reused: false, entry: routed.entry };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
}

function openMarkedHtmlPreviewTab(ev) {
  if (!ev || !ev.artifactId) return;
  const site = ev.kind === 'site' || ev.kind === 'web' || ev.kind === 'html-site';
  if (ev.kind !== 'blocks' && !site) return;
  const sid = String(ev.sessionId || '');
  const aid = String(ev.artifactId);
  const key = `${sid}:${aid}`;
  const now = Date.now();
  const prev = htmlPreviewOpened.get(key) || 0;
  if (now - prev < 60_000) return;
  htmlPreviewOpened.set(key, now);
  void openArtifactPreviewTab(sid, [aid], {
    kind: ev.kind,
    shell: ev.shell,
    entry: site ? 'site.html' : undefined,
    focus: false,
    reason: 'preview'
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'session_workspace_event' && isPawWorkOffscreenSender(sender) &&
      ['task-schedule-changed', 'task-updated', 'execution-end'].includes(request.event?.type)) {
    void taskScheduler.reconcile();
  }
  if (request?.action === 'session_workspace_event') {
    const ev = request.event || {};
    const sid = String(ev.sessionId || '').trim();
    if (sid && ev.type === 'execution-start') setSessionWorkLock(sid, true);
    if (sid && ev.type === 'execution-end') {
      setSessionWorkLock(sid, false);
      releaseTabLeasesByExecution(sid, ev.executionId);
    }
  }
  if (request?.action === 'session_workspace_event' && request.event?.type === 'artifact_preview') {
    openMarkedHtmlPreviewTab(request.event);
  }
  if (request?.action === 'session_workspace_event' && request.event?.type === 'html_canvas_updated') {
    if (request.event.liveApplied) {
      /* live editor already applied; do not loadSnapshot */
    } else {
      const sid = request.event.sessionId;
      const aid = request.event.artifactId;
      void patchHtmlPreviewTab(sid, aid);
      setTimeout(() => {
        void patchHtmlPreviewTab(sid, aid);
      }, 3500);
    }
  }

  if (request?.action === 'html_tab_ready') {
    const key = htmlPreviewKey(request.sessionId, request.artifactId);
    if (sender?.tab?.id != null) htmlTabByKey.set(key, sender.tab.id);
    htmlReadyKeys.add(key);
    const waiters = htmlReadyWaiters.get(key) || [];
    htmlReadyWaiters.delete(key);
    for (const w of waiters) w.resolve(sender?.tab?.id);
    pushWorkLockIfActive(sender, request.sessionId);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === 'sheet_tab_ready') {
    const key = sheetKey(request.sessionId, request.artifactId);
    if (sender?.tab?.id != null) {
      sheetTabByKey.set(key, sender.tab.id);
      sheetReadyKeys.add(key);
    }
    const waiters = sheetReadyWaiters.get(key) || [];
    sheetReadyWaiters.delete(key);
    for (const w of waiters) w.resolve(sender?.tab?.id);
    pushWorkLockIfActive(sender, request.sessionId);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === 'docs_tab_ready') {
    pushWorkLockIfActive(sender, request.sessionId);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === 'paw_work_lock_query') {
    const sid = String(request.sessionId || sessionIdFromPawWorkUrl(sender?.tab?.url) || '').trim();
    const url = sender?.tab?.url || '';
    sendResponse({
      ok: true,
      sessionId: sid,
      locked: !!(sid && lockedWorkSessions.has(sid) && isPawLockableWorkPageUrl(url))
    });
    return false;
  }

  if (request?.action === 'html_tab_state') {
    if (!String(request.sessionId || '').trim()) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    forwardWorkspaceRpc({
      method: 'setActiveHtml',
      params: {
        sessionId: request.sessionId,
        artifactId: request.artifactId,
        overview: {
          ...(request.overview && typeof request.overview === 'object' ? request.overview : {}),
          selections: request.selections || request.overview?.selections || [],
          kind: request.kind || request.overview?.kind,
          artifactId: request.artifactId
        }
      }
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === 'sheet_tab_state') {
    if (!String(request.sessionId || '').trim()) {
      sendResponse({ ok: true, ignored: true });
      return false;
    }
    forwardWorkspaceRpc({
      method: 'setActiveWorkbook',
      params: {
        sessionId: request.sessionId,
        artifactId: request.artifactId,
        overview: request.overview
      }
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'sheet_host') {
    handleSheetHost(request)
      .then((r) => sendResponse(r))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'canvas_host') {
    handleCanvasHost(request)
      .then((r) => sendResponse(r))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.action === 'open_artifact_preview') {
    const ids = Array.isArray(request.artifactIds) ? request.artifactIds : [];
    if (request.artifactId) ids.unshift(request.artifactId);
    openArtifactPreviewTab(request.sessionId, ids, {
      focus: request.focus !== false,
      reason: request.reason || 'user',
      title: request.title,
      kind: request.kind,
      shell: request.shell,
      entry: request.entry
    }).then((r) => sendResponse(r));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_list_open_tabs') {
    listMentionableOpenTabs()
      .then((pages) => sendResponse({ ok: true, pages }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), pages: [] }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_get_active_page') {
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        const url = String(tab?.url || '');
        if (!tab?.id || !/^https?:/i.test(url)) {
          sendResponse({ ok: false, error: 'No inspectable active HTTP(S) page' });
          return;
        }
        let origin = '';
        try { origin = new URL(url).origin; } catch {}
        sendResponse({
          ok: true,
          page: { tabId: tab.id, frameId: 0, url, origin, title: String(tab.title || '') }
        });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_get_llm_settings') {
    loadLlmSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // Offscreen has chrome.runtime but not chrome.storage — proxy BYOK keys
  if (request?.target === 'pawwork-background' && request?.action === 'storage_local_get') {
    handleStorageLocalGet(request.keys)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (request?.target === 'pawwork-background' && request?.action === 'storage_local_set') {
    handleStorageLocalSet(request.values)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_capture_page_blueprint') {
    handleWorkspaceCapturePageBlueprint(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_page_action') {
    handleWorkspacePageAction(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), code: 'NEED_PAGE' }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_find_tab') {
    handleWorkspaceFindTab(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_capture_fragile') {
    chrome.tabs.sendMessage(Number(request.tabId), {
      action: 'workspace_capture_item',
      selector: request.selector || null,
      src: request.src || null,
      captureBytes: request.captureBytes === true
    }).then((result) => sendResponse(result || { ok: false, error: 'empty capture result' }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_parallel_search_headers') {
    ensureParallelSearchHeaders(sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_fetch') {
    handleWorkspaceFetch(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_sys') {
    if (!isPawWorkOffscreenSender(sender)) {
      sendResponse({ ok: false, code: 'SYS_DENIED', error: 'browser sys requires the offscreen runtime' });
      return false;
    }
    handleWorkspaceSys(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: typeof error?.code === 'string' ? error.code : 'SYS_FAILED'
      }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_tab_lease_peek') {
    if (!isPawWorkOffscreenSender(sender)) {
      sendResponse({ ok: false, code: 'SYS_DENIED', error: 'tab lease peek requires the offscreen runtime' });
      return false;
    }
    sendResponse({ ok: true, lease: peekTabLease(request.tabId) });
    return false;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_tab_lease_release') {
    if (!isPawWorkOffscreenSender(sender)) {
      sendResponse({ ok: false, code: 'SYS_DENIED', error: 'tab lease release requires the offscreen runtime' });
      return false;
    }
    sendResponse({
      ok: true,
      released: releaseTabLeasesByExecution(request.sessionId, request.executionId)
    });
    return false;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_task_resolve_page') {
    if (!isPawWorkOffscreenSender(sender)) {
      sendResponse({ ok: false, code: 'SYS_DENIED', error: 'Task target resolution requires the offscreen runtime.' });
      return false;
    }
    resolveTaskPage(chrome.tabs, request.page)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, code: 'TASK_TARGET_MISSING', error: error?.message || String(error) }));
    return true;
  }

  if (request?.target === 'pawwork-background' && request?.action === 'workspace_rpc') {
    forwardWorkspaceRpc(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), code: error?.code || 'WORKSPACE_FAILED' }));
    return true;
  }

  // CAPTURE_WP: region picker results from content script
  if (
    request?.action === 'pagewand_region_selected' ||
    request?.action === 'pagewand_region_cancelled'
  ) {
    handleRegionSelectMessage(request, sender);
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'trigger_native_downloads' && request.urls) {
    handleNativeDownloads(request.urls)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('Zip creation error:', err);
        sendResponse({ status: 'error', message: err.message });
      });
    return true; // async sendResponse
  }

  // CAPTURE_WP: Side Panel / content script request region capture
  if (
    request.action === 'pagewand_capture_screenshot' ||
    request.action === 'capture_visible_tab'
  ) {
    captureVisibleTabForUser(request.source || 'message')
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  // Non-streaming LLM proxy (JSON body in / JSON out)
  if (request.action === 'llm_proxy_fetch') {
    handleLlmProxyFetch(request)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  // Health ping for browser agent runtime status
  if (request.action === 'agent_runtime_ping') {
    sendResponse({
      status: 'ok',
      runtime: 'browser',
      kernel: 'vercel-ai-sdk',
      version: '2.0.0'
    });
    return false;
  }

  // Open draft preview as a dedicated HTML tab (reuse if already open for this draft)
  if (request.action === 'open_draft_preview' && request.draftId) {
    const draftId = String(request.draftId);
    const sessionId = String(request.sessionId || '').trim();
    const focus = shouldFocusPawWorkTab({
      focus: request.focus,
      reason: request.reason || 'preview'
    });
    const reason = request.reason || (focus ? 'user' : 'preview');
    const q = new URLSearchParams();
    q.set('draftId', draftId);
    if (sessionId) q.set('sessionId', sessionId);
    const url = chrome.runtime.getURL(`src/preview/preview.html?${q.toString()}`);
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find((t) => {
          const u = t.url || '';
          return (
            u.includes('preview/preview.html') &&
            (u.includes(`draftId=${encodeURIComponent(draftId)}`) ||
              u.includes(`draftId=${draftId}`))
          );
        });
        if (existing?.id != null) {
          await chrome.tabs.update(existing.id, focus ? { active: true, url } : { url });
          await attachTabToSessionGroup(existing.id, sessionId, {
            title: request.title,
            url,
            reason
          });
          if (focus) {
            try {
              await chrome.tabs.update(existing.id, { active: true });
            } catch {
              /* tab may have closed */
            }
          }
          try {
            await chrome.tabs.reload(existing.id);
          } catch (_) {}
          sendResponse({ ok: true, tabId: existing.id, reused: true });
          return;
        }
        const tab = await openPawWorkTab({
          url,
          sessionId,
          focus,
          title: request.title,
          reason
        });
        sendResponse({ ok: true, tabId: tab?.id, reused: false });
      } catch (err) {
        sendResponse({ ok: false, message: err?.message || String(err) });
      }
    })();
    return true;
  }

  // Broadcast draft update to preview tabs
  if (request.action === 'broadcast_draft_updated' && request.draftId) {
    chrome.runtime.sendMessage({
      action: 'draft_updated',
      draftId: request.draftId,
      version: request.version
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'broadcast_draft_purged' && request.draftId) {
    chrome.runtime.sendMessage({
      action: 'draft_purged',
      draftId: request.draftId
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleNativeDownloads(urls) {
  // Threshold: < 5 images → individual; >= 5 → Auto Zip
  if (urls.length < 5) {
    urls.forEach((imgUrl, index) => {
      const ext = getExtensionFromDataUrlOrPath(imgUrl);
      const prefix = /^(png|jpe?g|gif|webp|svg)$/i.test(ext) ? 'image' : 'file';
      chrome.downloads.download({
        url: imgUrl,
        filename: `pagewand_downloads/${prefix}_${Date.now()}_${index + 1}.${ext}`,
        conflictAction: 'uniquify'
      });
    });
    return { status: 'started_individual', count: urls.length };
  }

  const fetchedFiles = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i]);
      const arrayBuffer = await res.arrayBuffer();
      const ext = getExtensionFromDataUrlOrPath(urls[i]);
      fetchedFiles.push({
        name: `pagewand_image_${i + 1}.${ext}`,
        data: new Uint8Array(arrayBuffer)
      });
    } catch (fetchErr) {
      console.warn('Failed to fetch image for zip:', urls[i], fetchErr);
    }
  }

  if (fetchedFiles.length > 0) {
    const zipBlob = createZipBlob(fetchedFiles);
    const dataUrl = await blobToDataURL(zipBlob);
    chrome.downloads.download({
      url: dataUrl,
      filename: `pagewand_images_pack_${Date.now()}.zip`,
      conflictAction: 'uniquify'
    });
    return { status: 'zipped', count: fetchedFiles.length };
  }

  urls.forEach((imgUrl, index) => {
    const ext = getExtensionFromDataUrlOrPath(imgUrl);
    chrome.downloads.download({
      url: imgUrl,
      filename: `pagewand_downloads/image_${Date.now()}_${index + 1}.${ext}`
    });
  });
  return { status: 'started_fallback', count: urls.length };
}

/** Keys offscreen may read/write via SW (BYOK + legacy mirrors). */
const STORAGE_BRIDGE_KEY =
  /^(pagewand_|DEEPSEEK_|selected_model$)/;

function assertStorageBridgeKeys(keys) {
  const list = Array.isArray(keys) ? keys : keys != null ? [keys] : [];
  for (const key of list) {
    if (!STORAGE_BRIDGE_KEY.test(String(key))) {
      throw new Error(`storage bridge denied key: ${key}`);
    }
  }
  return list.map(String);
}

async function handleStorageLocalGet(keys) {
  const list = assertStorageBridgeKeys(keys);
  if (!list.length) return {};
  return chrome.storage.local.get(list);
}

async function handleStorageLocalSet(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('storage_local_set requires an object');
  }
  assertStorageBridgeKeys(Object.keys(values));
  await chrome.storage.local.set(values);
}

/**
 * Background fetch proxy for OpenAI-compatible LLM APIs (no CORS from SW).
 */
async function handleLlmProxyFetch(request) {
  const { url, method, headers, body } = request;
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'Missing url' };
  }
  // Safety: only allow https LLM endpoints (and localhost for dev proxies)
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Invalid url' };
  }
  const allowed =
    parsed.protocol === 'https:' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost';
  if (!allowed) {
    return { ok: false, error: 'Blocked non-HTTPS LLM endpoint' };
  }

  const methodUpper = String(method || 'POST').toUpperCase();
  /** @type {RequestInit} */
  const init = {
    method: methodUpper,
    headers: headers || {}
  };
  // GET/HEAD must not carry a body (invalid Request; breaks /models list fetch)
  if (body != null && methodUpper !== 'GET' && methodUpper !== 'HEAD') {
    init.body = body;
  }
  const res = await fetch(url, init);

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }

  return {
    ok: res.ok,
    status: res.status,
    text,
    json
  };
}

/**
 * Ask the live tab's content script for a page blueprint (site-clone capture).
 */
function normalizeFindTabUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
  } catch {
    return '';
  }
}

async function handleWorkspaceFindTab(request) {
  const want = normalizeFindTabUrl(request?.url);
  if (!want) return { ok: false, error: 'bad url' };
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const got = normalizeFindTabUrl(tab?.url || tab?.pendingUrl || '');
    if (got && got === want) {
      return { ok: true, tabId: tab.id, url: tab.url || want, title: tab.title || '' };
    }
  }
  return { ok: false };
}

async function handleWorkspaceCapturePageBlueprint(request) {
  let tabId = Number(request?.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = Number(tab?.id);
  }
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'no active tab', code: 'NEED_PAGE' };
  }
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'workspace_capture_page_blueprint'
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: 'NEED_PAGE' };
  }
}

/**
 * Live @ page set. Source of truth for the composer picker.
 * Scope: http(s) tabs in normal windows, NEED_PAGE / injectability filter.
 * Discarded tabs stay listed. chrome:// / extension / Web Store / DevTools are out.
 */
async function listMentionableOpenTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const pages = [];
  const seenTab = new Set();
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      const tabId = Number(tab?.id);
      if (!Number.isFinite(tabId) || tabId <= 0 || seenTab.has(tabId)) continue;
      const url = String(tab.url || tab.pendingUrl || '');
      if (!isMentionablePageUrl(url)) continue;
      const ref = normalizePageRef({ url, title: tab.title || '' });
      if (!ref) continue;
      seenTab.add(tabId);
      pages.push({
        tabId,
        windowId: tab.windowId,
        url: ref.url,
        title: ref.title,
        origin: ref.origin,
        host: ref.host,
        discarded: tab.discarded === true,
        current: tab.active === true && win.focused === true
      });
    }
  }
  return pages;
}

let openTabsBroadcastTimer = 0;
function scheduleOpenTabsBroadcast() {
  if (openTabsBroadcastTimer) return;
  openTabsBroadcastTimer = setTimeout(() => {
    openTabsBroadcastTimer = 0;
    void broadcastOpenTabsChanged();
  }, 80);
}

async function broadcastOpenTabsChanged() {
  try {
    const pages = await listMentionableOpenTabs();
    await chrome.runtime.sendMessage({
      target: 'pawwork-sidepanel',
      action: 'workspace_open_tabs_changed',
      pages
    });
  } catch {
    /* sidepanel may be closed */
  }
}

function watchMentionableOpenTabs() {
  const tabsApi = chrome.tabs;
  if (!tabsApi) return;
  tabsApi.onCreated?.addListener(() => scheduleOpenTabsBroadcast());
  tabsApi.onRemoved?.addListener((tabId) => {
    releaseTabLease(tabId);
    scheduleOpenTabsBroadcast();
  });
  tabsApi.onReplaced?.addListener(() => scheduleOpenTabsBroadcast());
  tabsApi.onAttached?.addListener(() => scheduleOpenTabsBroadcast());
  tabsApi.onDetached?.addListener(() => scheduleOpenTabsBroadcast());
  tabsApi.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status || changeInfo.discarded != null) {
      scheduleOpenTabsBroadcast();
    }
  });
  chrome.windows?.onFocusChanged?.addListener(() => scheduleOpenTabsBroadcast());
}

watchMentionableOpenTabs();

function isRestrictedPageActionUrl(url) {
  const raw = String(url || '');
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('view-source:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com') return true;
    if (host === 'chrome.google.com' && /\/webstore\b/.test(parsed.pathname)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function resolvePageActionTab(request) {
  const tabId = Number(request?.tabId ?? request?.defaultTabId);
  let url = String(request?.url || '');
  let title = '';
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { tabId: NaN, url: '', title: '' };
  }
  if (!url) {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || tab?.pendingUrl || '';
      title = String(tab?.title || '');
    } catch {
      /* tab may still accept sendMessage */
    }
  } else {
    try {
      const tab = await chrome.tabs.get(tabId);
      title = String(tab?.title || '');
    } catch {
      /* title is optional on the receipt */
    }
  }
  return { tabId, url, title };
}

async function decorateTabLeaseDenied(denied) {
  if (!denied || denied.code !== 'TAB_LEASED') return denied;
  let title = denied.title || '';
  if (!title && denied.tabId) {
    try {
      title = String((await chrome.tabs.get(denied.tabId))?.title || '');
    } catch {
      /* holder tab may already be gone */
    }
  }
  return title ? { ...denied, title } : denied;
}

function withPageActionTab(result, tabId, title) {
  if (!result || typeof result !== 'object') return result;
  const id = Number(tabId);
  if (!Number.isFinite(id) || id <= 0 || result.tabId != null) return result;
  return title ? { ...result, tabId: id, title } : { ...result, tabId: id };
}

const pageActionRevByTab = new Map();

function parseActionRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const framed = s.match(/^f(\d+)\.(a\d+)$/i);
  if (framed) return { frameId: Number(framed[1]), local: framed[2].toLowerCase() };
  const local = s.match(/^(a\d+)$/i);
  if (local) return { frameId: null, local: local[1].toLowerCase() };
  return null;
}

function stampPageActionRev(tabId) {
  const n = (pageActionRevByTab.get(tabId) || 0) + 1;
  pageActionRevByTab.set(tabId, n);
  return 't' + n;
}

function currentPageActionRev(tabId) {
  const n = pageActionRevByTab.get(tabId);
  return n ? 't' + n : null;
}

function stalePageActionRev(tabId, rev) {
  const have = currentPageActionRev(tabId);
  const want = rev == null ? '' : String(rev).trim();
  if (!have) {
    return { ok: false, error: 'snapshot first — no rev yet', code: 'STALE_REF' };
  }
  if (!want || want !== have) {
    return {
      ok: false,
      error: 'snapshot rev is stale — snapshot again',
      code: 'STALE_REF',
      rev: have
    };
  }
  return null;
}

async function listPageActionFrames(tabId) {
  if (chrome.webNavigation && typeof chrome.webNavigation.getAllFrames === 'function') {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames || []).filter((f) => {
        if (!f || !Number.isFinite(f.frameId)) return false;
        const lower = String(f.url || '').toLowerCase();
        if (
          lower.startsWith('chrome://') ||
          lower.startsWith('chrome-extension://') ||
          lower.startsWith('edge://') ||
          lower.startsWith('devtools://') ||
          lower.startsWith('view-source:')
        ) {
          return false;
        }
        return true;
      });
    } catch {
      /* permission or tab gone */
    }
  }
  return [{ frameId: 0 }];
}

async function sendPageActionToFrame(tabId, frameId, payload) {
  return chrome.tabs.sendMessage(
    tabId,
    { action: 'workspace_page_action', ...payload },
    Number.isFinite(frameId) ? { frameId } : {}
  );
}

async function ensurePageActionScripts(tabId) {
  const frames = await listPageActionFrames(tabId);
  const missing = [];
  for (const fr of frames) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId: fr.frameId });
      if (pong && pong.status === 'pong') continue;
    } catch {
      /* not injected */
    }
    missing.push(fr.frameId);
  }
  if (!missing.length) return;
  const candidates = ['src/content_script.js', 'content_script.js'];
  for (const frameId of missing) {
    let injected = false;
    for (const file of candidates) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: [file]
        });
        injected = true;
        break;
      } catch {
        /* try next path */
      }
    }
    if (!injected) {
      for (const file of candidates) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: [file]
          });
          break;
        } catch {
          /* last resort */
        }
      }
    }
  }
}

function prefixFrameRefs(controls, frameId) {
  return (Array.isArray(controls) ? controls : []).map((c) => {
    if (!c || typeof c !== 'object') return c;
    const local = String(c.ref || '').replace(/^f\d+\./i, '');
    return { ...c, ref: 'f' + frameId + '.' + local };
  });
}

async function snapshotAllPageActionFrames(tabId) {
  await ensurePageActionScripts(tabId);
  const frames = await listPageActionFrames(tabId);
  const controls = [];
  const framesOut = [];
  for (const fr of frames) {
    try {
      const raw = await sendPageActionToFrame(tabId, fr.frameId, { op: 'snapshot' });
      if (!raw || raw.ok === false) continue;
      const list = prefixFrameRefs(raw.controls, fr.frameId);
      for (const row of list) controls.push(row);
      framesOut.push({
        frameId: fr.frameId,
        url: raw.frameUrl || fr.url || '',
        title: raw.title || '',
        count: list.length
      });
    } catch {
      /* isolated / about:blank / CSP */
    }
  }
  const rev = stampPageActionRev(tabId);
  const capped = controls.slice(0, 80);
  return {
    ok: true,
    op: 'snapshot',
    rev,
    count: capped.length,
    controls: capped,
    frames: framesOut,
    after: { url: framesOut[0]?.url, count: capped.length }
  };
}

function attachFreshSnapshot(result, snap) {
  if (!result || typeof result !== 'object' || !snap) return result;
  return {
    ...result,
    rev: snap.rev,
    controls: snap.controls,
    count: snap.count,
    frames: snap.frames
  };
}

async function resolveNameAcrossFrames(tabId, name) {
  const frames = await listPageActionFrames(tabId);
  const hits = [];
  for (const fr of frames) {
    try {
      const raw = await sendPageActionToFrame(tabId, fr.frameId, { op: 'resolve_name', name });
      const matches = raw && Array.isArray(raw.matches) ? raw.matches : [];
      for (const m of matches) {
        if (!m || !m.ref) continue;
        hits.push({
          frameId: fr.frameId,
          local: String(m.ref).replace(/^f\d+\./i, ''),
          name: m.name || name,
          ref: 'f' + fr.frameId + '.' + String(m.ref).replace(/^f\d+\./i, '')
        });
      }
    } catch {
      /* skip frame */
    }
  }
  if (!hits.length) {
    return { ok: false, error: 'no control matches name', code: 'NO_TARGET' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: 'name matches multiple controls',
      code: 'AMBIGUOUS',
      matches: hits.map((h) => ({ ref: h.ref, name: h.name }))
    };
  }
  return hits[0];
}

async function waitTextAnyFrame(tabId, request) {
  const frames = await listPageActionFrames(tabId);
  const started = Date.now();
  if (!frames.length) {
    return { ok: false, error: 'no frames', code: 'NEED_PAGE' };
  }
  const pending = frames.map((fr) =>
    sendPageActionToFrame(tabId, fr.frameId, {
      op: 'wait',
      text: request.text,
      ms: request.ms
    }).catch(() => null)
  );
  const hit = await new Promise((resolve) => {
    let left = pending.length;
    for (const p of pending) {
      p.then((r) => {
        if (r && r.ok) resolve(r);
        else if (--left === 0) resolve(null);
      });
    }
  });
  const snap = await snapshotAllPageActionFrames(tabId);
  if (hit) return attachFreshSnapshot({ ...hit, waited: hit.waited ?? Date.now() - started }, snap);
  return attachFreshSnapshot(
    { ok: false, error: 'wait timed out', code: 'NO_TARGET', waited: Date.now() - started },
    snap
  );
}

async function handleWorkspacePageAction(request) {
  const result = await executeWorkspacePageAction(request);
  const tabId = Number(request?.tabId ?? request?.defaultTabId ?? result?.tabId);
  let title = result?.title;
  if ((!title || result?.tabId == null) && Number.isFinite(tabId) && tabId > 0) {
    try {
      title = title || String((await chrome.tabs.get(tabId))?.title || '');
    } catch {
      /* receipt title is optional */
    }
  }
  return withPageActionTab(result, tabId, title);
}

async function executeWorkspacePageAction(request) {
  const gated = preparePageActionTarget(request);
  if (!gated.ok) return decorateTabLeaseDenied(gated);
  const resolved = await resolvePageActionTab(request);
  const tabId = resolved.tabId;
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'page action requires an explicit tabId', code: 'NEED_EXPLICIT_TAB' };
  }
  if (isRestrictedPageActionUrl(resolved.url)) {
    return {
      ok: false,
      error: 'cannot act on chrome://, Web Store, or extension pages',
      code: 'NEED_PAGE'
    };
  }
  const op = String(request?.op || '').trim().toLowerCase();
  try {
    await ensurePageActionScripts(tabId);
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: 'NEED_PAGE' };
  }

  if (op === 'snapshot') {
    return snapshotAllPageActionFrames(tabId);
  }

  const usesRef =
    (request?.ref != null && String(request.ref).trim() !== '') ||
    (Array.isArray(request?.fields) && request.fields.some((f) => f && f.ref));
  const stale = usesRef ? stalePageActionRev(tabId, request?.rev) : null;
  if (stale) return stale;

  if (op === 'wait' && request?.text && !request?.ref) {
    return waitTextAnyFrame(tabId, request);
  }

  if (op === 'fill_form') {
    const fields = Array.isArray(request.fields) ? request.fields : [];
    if (!fields.length) {
      return { ok: false, error: 'fields is required', code: 'BAD_INPUT' };
    }
    const byFrame = new Map();
    for (const field of fields) {
      if (!field || typeof field !== 'object') {
        return { ok: false, error: 'invalid field', code: 'BAD_INPUT' };
      }
      const parsed = parseActionRef(field.ref);
      if (parsed && parsed.frameId != null) {
        const list = byFrame.get(parsed.frameId) || [];
        list.push({ ...field, ref: parsed.local });
        byFrame.set(parsed.frameId, list);
        continue;
      }
      const name = field.name || field.label;
      if (name) {
        const hit = await resolveNameAcrossFrames(tabId, name);
        if (hit.code) return hit;
        const list = byFrame.get(hit.frameId) || [];
        list.push({ ...field, ref: hit.local });
        byFrame.set(hit.frameId, list);
        continue;
      }
      return { ok: false, error: 'each field needs ref or name', code: 'BAD_INPUT' };
    }
    const results = [];
    let allOk = true;
    for (const [frameId, frameFields] of byFrame) {
      let raw;
      try {
        raw = await sendPageActionToFrame(tabId, frameId, { op: 'fill_form', fields: frameFields });
      } catch (error) {
        allOk = false;
        results.push({
          ok: false,
          error: error?.message || String(error),
          code: 'NEED_PAGE'
        });
        continue;
      }
      const rows = raw && Array.isArray(raw.results) ? raw.results : [];
      if (!raw || raw.ok === false) allOk = false;
      for (const row of rows) {
        const local = row && row.ref ? String(row.ref).replace(/^f\d+\./i, '') : '';
        results.push({
          ...row,
          ref: local ? 'f' + frameId + '.' + local : row?.ref
        });
      }
      if (!rows.length && raw && raw.ok === false) {
        results.push({ ok: false, error: raw.error, code: raw.code || 'NEED_PAGE' });
      }
    }
    const snap = await snapshotAllPageActionFrames(tabId);
    return attachFreshSnapshot({ ok: allOk, op: 'fill_form', results }, snap);
  }

  let frameId = null;
  let localRef = '';
  const parsed = parseActionRef(request?.ref);
  if (parsed) {
    frameId = parsed.frameId != null ? parsed.frameId : 0;
    localRef = parsed.local;
  } else if (request?.name || request?.label) {
    const hit = await resolveNameAcrossFrames(tabId, request.name || request.label);
    if (hit.code) return hit;
    frameId = hit.frameId;
    localRef = hit.local;
  } else if (op === 'press' || (op === 'wait' && request?.ms != null && !request?.text && !request?.ref)) {
    frameId = 0;
  } else {
    return { ok: false, error: 'need ref or name', code: 'NO_TARGET' };
  }

  const payload = {
    op,
    ref: localRef || undefined,
    name: request?.name || request?.label,
    value: request?.value,
    key: request?.key,
    text: request?.text,
    ms: request?.ms
  };
  let raw;
  try {
    raw = await sendPageActionToFrame(tabId, frameId, payload);
  } catch (error) {
    return { ok: false, error: error?.message || String(error), code: 'NEED_PAGE' };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'empty page action result', code: 'NEED_PAGE' };
  }
  if (raw.after && raw.after.ref) {
    raw.after = {
      ...raw.after,
      ref: 'f' + frameId + '.' + String(raw.after.ref).replace(/^f\d+\./i, '')
    };
  }
  const snap = await snapshotAllPageActionFrames(tabId);
  return attachFreshSnapshot(raw, snap);
}

/**
 * Read-only fetch proxy for Web Workspace materialization/acquire. The proxy
 * deliberately excludes browser credentials/extension secrets from caller
 * control and caps response size before crossing runtime messaging.
 */
async function handleWorkspaceFetch(request) {
  const rawUrl = String(request?.url || '');
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid workspace fetch URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only HTTP(S) workspace fetch is allowed' };
  }
  const method = String(request?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return { ok: false, error: 'Workspace fetch is read-only (GET/HEAD only)' };
  }
  const safeHeaders = new Headers();
  for (const [key, value] of Object.entries(request?.headers || {})) {
    const lower = String(key).toLowerCase();
    if (['authorization', 'cookie', 'proxy-authorization', 'sec-fetch-site', 'origin'].includes(lower)) continue;
    safeHeaders.set(key, String(value));
  }
  const purpose = String(request?.purpose || 'public-acquire');
  if (purpose !== 'selected-materialization' && isPrivateNetworkTarget(parsed.hostname)) {
    return { ok: false, error: 'Public acquire blocks loopback/private-network targets' };
  }
  const res = await fetch(parsed.href, {
    method,
    headers: safeHeaders,
    credentials: purpose === 'selected-materialization' ? 'include' : 'omit',
    redirect: 'follow'
  });
  const maxBytes = 32 * 1024 * 1024;
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) return { ok: false, status: res.status, error: `Workspace fetch exceeds ${maxBytes} bytes` };
  const bytes = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { ok: false, status: res.status, error: `Workspace fetch exceeds ${maxBytes} bytes` };
  const headers = {};
  for (const name of ['content-type', 'content-length', 'last-modified', 'etag']) {
    const value = res.headers.get(name);
    if (value != null) headers[name] = value;
  }
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    headers,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    base64: bytesToBase64ForMessage(bytes)
  };
}

function isPrivateNetworkTarget(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  return false;
}

function bytesToBase64ForMessage(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Register wakeup listeners synchronously. The store, not alarms, is authoritative.
const taskScheduler = createTaskScheduler({
  alarms: chrome.alarms,
  rpc: async (method, params) => {
    const response = await forwardWorkspaceRpc({ method, params });
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'Task RPC failed'), { code: response?.code });
    return response.result;
  }
});
chrome.alarms?.onAlarm.addListener(alarm => { void taskScheduler.onAlarm(alarm); });
chrome.runtime.onStartup?.addListener(() => { void taskScheduler.reconcile({ runDue: true }); });
chrome.runtime.onInstalled.addListener(() => { void taskScheduler.reconcile({ runDue: true }); });
void taskScheduler.reconcile({ runDue: true });
