/**
 * Artboard geometry + marked-HTML upsert. Node-safe, no DOM.
 */

import { readHtmlPreviewKind } from './htmlPreviewMarker.js';
import { listArtifacts } from './artifacts.js';

function parseBox(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const w = raw.w ?? raw.width;
    const h = raw.h ?? raw.height;
    if ([raw.x, raw.y, w, h].every((n) => n != null && Number.isFinite(Number(n)))) {
      return { x: Number(raw.x), y: Number(raw.y), w: Number(w), h: Number(h) };
    }
    return null;
  }
  const parts = String(raw)
    .split(/[,\s]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (parts.length < 4) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

export const ARTBOARD_KINDS = new Set(['poster', 'deck']);

export function isArtboardKind(kind) {
  return ARTBOARD_KINDS.has(String(kind || '').toLowerCase());
}

export function htmlKindFromMarkup(html = '') {
  const m = /data-browserbot-kind\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  if (m) return String(m[1]).trim().toLowerCase();
  if (/--paw-poster-w\s*:/i.test(html)) return 'poster';
  if (/--paw-slide-w\s*:/i.test(html)) return 'deck';
  return '';
}

export function normalizeArtifactFileName(name) {
  return String(name || '')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const GENERIC_HTML = /^(result|poster|deck|draft|document|preview|untitled)(\.html?)?$/i;

/**
 * If this marked HTML should update an existing canvas instead of creating one.
 * @returns {object|null} artifact record
 */
export function resolveHtmlUpsertTarget(store, sessionId, { name, content, activeId } = {}) {
  const arts = listArtifacts(store, sessionId) || [];
  const want = normalizeArtifactFileName(name);
  const kind = htmlKindFromMarkup(content);
  // Website SoT: after the first site exists, rewrite the same file — never a second .html.
  if (kind === 'site' || kind === 'web') {
    if (activeId) {
      const rec = arts.find((a) => a.artifactId === activeId);
      if (rec) return rec;
    }
    const htmls = arts.filter((a) => /\.html?$/i.test(a.name || '') || /html/i.test(a.mimeType || ''));
    if (want) {
      const byName = htmls.find((a) => normalizeArtifactFileName(a.name) === want);
      if (byName) return byName;
    }
    if (htmls.length === 1) return htmls[0];
    return htmls.length ? htmls[htmls.length - 1] : null;
  }
  if (readHtmlPreviewKind(content) !== 'blocks') return null;
  if (want) {
    const byName = arts.find((a) => normalizeArtifactFileName(a.name) === want);
    if (byName) return byName;
  }
  if (activeId) {
    const rec = arts.find((a) => a.artifactId === activeId);
    if (rec && (!want || GENERIC_HTML.test(want) || GENERIC_HTML.test(rec.name))) {
      return rec;
    }
  }
  if (kind === 'poster') {
    const posters = arts.filter((a) => /\.html?$/i.test(a.name || ''));
    if (posters.length === 1 && (!want || GENERIC_HTML.test(want))) return posters[0];
  }
  return null;
}

export function alignBoxes(items, mode) {
  const list = (Array.isArray(items) ? items : []).map(boxItem).filter(Boolean);
  if (list.length < 2) return list;
  const minX = Math.min(...list.map((b) => b.x));
  const minY = Math.min(...list.map((b) => b.y));
  const maxR = Math.max(...list.map((b) => b.x + b.w));
  const maxB = Math.max(...list.map((b) => b.y + b.h));
  const midX = (minX + maxR) / 2;
  const midY = (minY + maxB) / 2;
  return list.map((b) => {
    const n = { ...b };
    if (mode === 'left') n.x = minX;
    else if (mode === 'right') n.x = maxR - n.w;
    else if (mode === 'center') n.x = midX - n.w / 2;
    else if (mode === 'top') n.y = minY;
    else if (mode === 'bottom') n.y = maxB - n.h;
    else if (mode === 'middle') n.y = midY - n.h / 2;
    return roundBox(n);
  });
}

export function distributeBoxes(items, axis = 'x') {
  const list = (Array.isArray(items) ? items : []).map(boxItem).filter(Boolean);
  if (list.length < 3) return list;
  const dim = axis === 'y' ? 'y' : 'x';
  const size = axis === 'y' ? 'h' : 'w';
  const sorted = [...list].sort((a, b) => a[dim] - b[dim]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[dim] + last[size] - first[dim];
  const total = sorted.reduce((s, b) => s + b[size], 0);
  const gap = (span - total) / (sorted.length - 1);
  let cursor = first[dim];
  return sorted.map((b) => {
    const n = { ...b, [dim]: cursor };
    cursor += b[size] + gap;
    return roundBox(n);
  });
}

export function guidesFromBoxes(artW, artH, others = []) {
  /** @type {Array<{x?: number, y?: number}>} */
  const g = [
    { x: 0 },
    { x: artW / 2 },
    { x: artW },
    { y: 0 },
    { y: artH / 2 },
    { y: artH }
  ];
  for (const o of others) {
    const b = boxItem(o);
    if (!b) continue;
    g.push({ x: b.x }, { x: b.x + b.w / 2 }, { x: b.x + b.w }, { y: b.y }, { y: b.y + b.h / 2 }, { y: b.y + b.h });
  }
  return g;
}

export function snapBox(box, guides, threshold = 6) {
  const b = boxItem(box);
  if (!b) return { box: null, x: null, y: null };
  let x = b.x;
  let y = b.y;
  let gx = null;
  let gy = null;
  const t = Number(threshold) || 6;
  for (const g of guides || []) {
    if (g.x != null) {
      const edges = [x, x + b.w / 2, x + b.w];
      const targets = [g.x, g.x, g.x];
      const which = [0, b.w / 2, b.w];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(edges[i] - targets[i]) <= t) {
          x = g.x - which[i];
          gx = g.x;
        }
      }
    }
    if (g.y != null) {
      const edges = [y, y + b.h / 2, y + b.h];
      const which = [0, b.h / 2, b.h];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(edges[i] - g.y) <= t) {
          y = g.y - which[i];
          gy = g.y;
        }
      }
    }
  }
  return { box: roundBox({ ...b, x, y }), x: gx, y: gy };
}

export function unionBoxes(items) {
  const list = (Array.isArray(items) ? items : []).map(boxItem).filter(Boolean);
  if (!list.length) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  const r = Math.max(...list.map((b) => b.x + b.w));
  const btm = Math.max(...list.map((b) => b.y + b.h));
  return roundBox({ id: '', x, y, w: r - x, h: btm - y });
}

export function offsetBoxes(items, dx, dy) {
  return (Array.isArray(items) ? items : [])
    .map(boxItem)
    .filter(Boolean)
    .map((b) => roundBox({ ...b, x: b.x + dx, y: b.y + dy }));
}

function boxItem(raw) {
  if (!raw) return null;
  const parsed = parseBox(raw.box || raw);
  if (!parsed) return null;
  return { id: raw.id || raw.slotId || '', ...parsed };
}

function roundBox(b) {
  return {
    id: b.id || '',
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.max(8, Math.round(b.w)),
    h: Math.max(8, Math.round(b.h))
  };
}
