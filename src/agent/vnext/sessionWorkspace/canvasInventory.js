/**
 * Session office-canvas inventory. Tool schedule reads this, not Chrome tab focus.
 */

import { listArtifacts } from './artifacts.js';
import { bytesToUtf8, isSheetArtifact } from '../../../preview/sheetCodec.js';
import { classifyOpenArtifact, isUtf8OpenKind } from './openClassify.js';

export const KERNEL_TOOL_NAMES = ['inspect', 'acquire', 'run', 'clarify', 'action', 'task'];
export const OFFICE_TOOL_NAMES = ['doc', 'web'];
/** Always-on model surface. Inventory aims tools; it does not hide them. */
export const SESSION_TOOL_NAMES = [...KERNEL_TOOL_NAMES, ...OFFICE_TOOL_NAMES];

/**
 * @param {object} rec
 * @param {string|Uint8Array|null|undefined} content
 * @returns {'sheet'|'doc'|'web'|null}
 */
export function classifyCanvasKind(rec = {}, content) {
  if (isSheetArtifact(rec)) return null;
  const bytes =
    content instanceof Uint8Array
      ? content
      : ArrayBuffer.isView(content)
        ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
        : null;
  const opened = classifyOpenArtifact({
    name: rec.name || rec.artifact?.name,
    mimeType: rec.mimeType || rec.mime,
    bytes: bytes || undefined,
    text: typeof content === 'string' ? content : ''
  });
  if (opened.canvas === 'sheet') return null;
  if (opened.canvas === 'docs') return 'doc';
  if (opened.kind === 'json-canvas') return null;
  const text = contentToText(content);
  if (opened.kind === 'html-plates') {
    return 'doc';
  }
  if (opened.kind === 'html-site' || htmlKindAttr(text) === 'site' || htmlKindAttr(text) === 'web') {
    return 'web';
  }
  if (opened.kind === 'html' || opened.kind === 'html-document') {
    const attr = htmlKindAttr(text);
    if (attr === 'site' || attr === 'web') return 'web';
    if (attr === 'document' || attr === 'doc' || opened.kind === 'html-document') return 'doc';
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        if (obj.body && typeof obj.body === 'object' && obj.body.dataStream != null) return 'doc';
        if (Array.isArray(obj.blocks) && !Array.isArray(obj.plates) && !obj.pages) return 'doc';
      }
    } catch {
      /* not JSON */
    }
  }
  const kindAttr = htmlKindAttr(text);
  if (kindAttr === 'document' || kindAttr === 'doc') return 'doc';
  if (/data-paw-doc\s*=/i.test(text) || /data-browserbot-block-type\s*=/i.test(text)) return 'doc';
  return null;
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 * @param {{ readFileBytes?: Function }|null} [fs]
 * @returns {{ sheet: string[], doc: string[], web: string[] }}
 */
export function inventoryFromSession(store, sessionId, fs = null) {
  const out = emptyInventory();
  const arts = listArtifacts(store, sessionId) || [];
  for (const rec of arts) {
    let content = '';
    if (fs && rec?.primaryPath && typeof fs.readFileBytes === 'function') {
      try {
        content = fs.readFileBytes(rec.primaryPath);
      } catch {
        content = '';
      }
    }
    const kind = classifyCanvasKind(rec, content);
    if (kind && out[kind]) out[kind].push(String(rec.artifactId));
  }
  return out;
}

export function emptyInventory() {
  return { sheet: [], doc: [], web: [] };
}

export function inventoryHasVisual() {
  return false;
}

function htmlKindAttr(html) {
  const m = /data-browserbot-kind\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? String(m[1]).trim().toLowerCase() : '';
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') {
    const cls = classifyOpenArtifact({ text: content });
    if (!isUtf8OpenKind(cls.kind)) return '';
    return content.slice(0, 12000);
  }
  const cls = classifyOpenArtifact({ bytes: content });
  if (!isUtf8OpenKind(cls.kind)) return '';
  try {
    return bytesToUtf8(content).slice(0, 12000);
  } catch {
    return '';
  }
}
