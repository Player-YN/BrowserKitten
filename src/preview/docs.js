import { workspaceRpc } from '../agent/vnext/host/workspaceClient.js';
/**
 * Document tab. Durable bytes are marked HTML from docsApply.
 * The page renders those blocks. It does not load a document engine.
 */

import {
  applyDocCommands,
  overviewFromDocSnapshot,
  parseDocSnapshot,
  serializeDocHtml
} from '../agent/vnext/sessionWorkspace/docsApply.js';
import { docxBytesToSnapshot } from './docxIngest.js';
import {
  classifyOpenArtifact,
  isUtf8OpenKind,
  previewEntryForKind
} from '../agent/vnext/sessionWorkspace/openClassify.js';
import { handleWorkTabPickerMessage, reportPickerState } from './workTabPicker.js';
import { fetchCompleteArtifact } from '../agent/vnext/sessionWorkspace/artifactDownload.js';

const params = new URLSearchParams(location.search);
const sessionId = params.get('sessionId') || '';
const artifactId = params.get('artifactId') || '';

let fileName = artifactId || 'document';
let artifactRevision = 0;
let durableSnapshot = parseDocSnapshot('', { title: 'Document' });
let pickActive = false;

function qs(name) {
  return params.get(name) || '';
}

function boot(msg, isError = false) {
  const el = document.getElementById('boot');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  document.body.classList.remove('is-ready');
}

function bytesToUtf8(bytes) {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function renderSnapshot(snapshot) {
  const app = document.getElementById('app');
  if (!app) return;
  app.replaceChildren();
  const title = String(snapshot?.title || '').trim();
  if (title) {
    const h = document.createElement('h1');
    h.textContent = title;
    app.append(h);
  }
  for (const block of snapshot?.blocks || []) {
    if (block?.type === 'img') {
      if (!block.src) continue;
      const img = document.createElement('img');
      img.src = String(block.src);
      img.alt = block.text ? String(block.text) : '';
      app.append(img);
      continue;
    }
    const el = document.createElement(block?.type === 'h1' ? 'h1' : block?.type === 'li' ? 'li' : 'p');
    el.textContent = block?.text == null ? '' : String(block.text);
    app.append(el);
  }
}

function reportState() {
  const overview = overviewFromDocSnapshot(durableSnapshot, { artifactId, name: fileName });
  try {
    chrome.runtime.sendMessage({
      action: 'docs_tab_state',
      sessionId,
      artifactId,
      overview
    });
  } catch {
    /* side panel may be closed */
  }
  return overview;
}

async function saveNow() {
  try {
    const saved = await workspaceRpc('updateArtifact', {
      sessionId,
      artifactId,
      expectedRevision: artifactRevision,
      mimeType: 'text/html',
      content: serializeDocHtml(durableSnapshot)
    });
    artifactRevision = Number(saved?.artifact?.revision) || artifactRevision;
    try {
      chrome.runtime.sendMessage({
        action: 'artifact_written',
        sessionId,
        artifactId,
        name: fileName
      });
    } catch {
      /* ignore */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function executeDocsRpc(msg) {
  const method = String(msg.method || '');
  if (method === 'overview') return { ok: true, overview: reportState() };
  if (method === 'apply') {
    try {
      const commands = Array.isArray(msg.commands) ? msg.commands : [];
      const snap = applyDocCommands(durableSnapshot, commands);
      if (snap.ok === false) {
        return { ok: false, error: snap.error || 'apply failed', overview: reportState() };
      }
      durableSnapshot = snap.snapshot;
      renderSnapshot(durableSnapshot);
      const saved = await saveNow();
      if (!saved?.ok) return { ok: false, error: saved?.error || 'document save failed', overview: reportState() };
      return { ok: true, applied: (snap.applied || []).length, snapshot: snap.snapshot, overview: reportState() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), overview: reportState() };
    }
  }
  return { ok: false, error: `unknown docs method ${method}` };
}

function snapshotFromLoaded(kind, bytes, text, title) {
  if (kind === 'docx') return docxBytesToSnapshot(bytes, { title });
  const src = text.trim() || (isUtf8OpenKind(kind) ? bytesToUtf8(bytes) : '');
  return parseDocSnapshot(src, { title });
}

async function main() {
  if (!sessionId || !artifactId) {
    boot('缺少 sessionId 或文件 id', true);
    return;
  }
  try {
    const rec = await fetchCompleteArtifact(
      (method, rpcParams) => workspaceRpc(method, rpcParams),
      { sessionId, artifactId }
    );
    artifactRevision = Number(rec?.artifact?.revision) || 0;
    fileName = String(rec?.artifact?.name || rec?.name || artifactId);
    const mimeType = rec?.mimeType || rec?.artifact?.mimeType || 'text/html';
    document.title = `${fileName} · 文档`;
    const bytes = rec.bytes;
    const text = rec?.content != null && String(rec.content).trim() ? String(rec.content) : '';
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
    durableSnapshot = snapshotFromLoaded(cls.kind, bytes, text, title);
    renderSnapshot(durableSnapshot);
    document.body.classList.add('is-ready');
    const bootEl = document.getElementById('boot');
    if (bootEl) bootEl.hidden = true;
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
  } catch (e) {
    boot(e instanceof Error ? e.message : String(e), true);
  }
}

void main();
