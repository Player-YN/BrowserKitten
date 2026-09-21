/**
 * Website page mutate — node-safe. SoT is HTML with data-paw-node.
 */

import { htmlWritePolicy } from './htmlWritePolicy.js';

const TEXT_TAGS = 'h1|h2|h3|h4|h5|h6|p|a|button|li|label|span|figcaption|td|th|blockquote';

export function stampSiteHtml(html) {
  let n = 0;
  const src = String(html || '');
  const withKind = /data-browserbot-kind\s*=\s*["']site["']/i.test(src)
    ? src
    : src.replace(/<html\b([^>]*)>/i, '<html$1 data-browserbot-kind="site">');
  return withKind.replace(new RegExp(`<(${TEXT_TAGS}|img)(\\s[^>]*)?>`, 'gi'), (m) => {
    if (/data-paw-node=/i.test(m)) return m;
    n += 1;
    if (m.endsWith('/>')) return `${m.slice(0, -2)} data-paw-node="n${n}"/>`;
    return `${m.slice(0, -1)} data-paw-node="n${n}">`;
  });
}

export function listSiteNodes(html) {
  const src = String(html || '');
  const out = [];
  const re = /<([a-z0-9]+)([^>]*data-paw-node="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(src))) {
    out.push({
      nodeId: m[3],
      tag: String(m[1] || '').toLowerCase(),
      text: stripTags(m[4]).slice(0, 200),
      href: attr(m[2], 'href'),
      src: attr(m[2], 'src')
    });
  }
  const img = /<img\b([^>]*data-paw-node="([^"]+)"[^>]*)\/?>/gi;
  while ((m = img.exec(src))) {
    if (out.some((n) => n.nodeId === m[2])) continue;
    out.push({
      nodeId: m[2],
      tag: 'img',
      text: attr(m[1], 'alt'),
      src: attr(m[1], 'src'),
      href: ''
    });
  }
  return out;
}

export function pinnedSiteIds(selections) {
  const list = Array.isArray(selections) ? selections : selections ? [selections] : [];
  const ids = [];
  for (const s of list) {
    const id = String(typeof s === 'string' ? s : s?.nodeId || s?.slotId || s?.id || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function commandSiteIds(cmd) {
  if (!cmd || typeof cmd !== 'object') return [];
  const many = cmd.nodeIds || cmd.ids || cmd.slots;
  if (Array.isArray(many) && many.length) {
    return many.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const one = String(cmd.nodeId || cmd.slotId || cmd.slot || '').trim();
  return one ? [one] : [];
}

export function siteSelectionsFromIds(html, ids) {
  const nodes = listSiteNodes(html);
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const hit = nodes.find((n) => n.nodeId === id);
    if (!hit) continue;
    out.push({
      nodeId: hit.nodeId,
      slotId: hit.nodeId,
      tag: hit.tag,
      text: hit.text,
      kind: hit.tag === 'img' ? 'image' : 'text'
    });
  }
  return out;
}

/**
 * Click → next pin set. Ctrl/Meta toggles; Shift extends along orderedIds; bare click replaces.
 * Empty click (no node) clears.
 */
export function nextSitePinIds(currentIds, clickedId, mods = {}, orderedIds = []) {
  const current = [];
  for (const raw of Array.isArray(currentIds) ? currentIds : []) {
    const id = String(raw || '').trim();
    if (id && !current.includes(id)) current.push(id);
  }
  const id = String(clickedId || '').trim();
  if (!id) return [];
  const toggle = !!(mods.ctrlKey || mods.metaKey);
  const shift = !!mods.shiftKey && !toggle;
  if (toggle) {
    if (current.includes(id)) return current.filter((x) => x !== id);
    return current.concat(id);
  }
  if (shift && current.length) {
    const order = Array.isArray(orderedIds) ? orderedIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const anchor = current[current.length - 1];
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return order.slice(lo, hi + 1);
    }
    return current.includes(id) ? current.slice() : current.concat(id);
  }
  return [id];
}

export function formatSiteSelLabel(selections) {
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) return '';
  if (list.length === 1) {
    const hit = list[0];
    return `${hit.tag || ''}#${hit.nodeId || ''} ${hit.text || ''}`.trim();
  }
  return `已选 ${list.length} 项`;
}

const WRITE_OPS = new Set([
  'setText',
  'setSlotText',
  'updateText',
  'setHref',
  'setSrc',
  'setSlotSrc',
  'remove',
  'delete',
  'removeNode',
  'duplicate'
]);

export function applySiteCommands(html, commands, opts = {}) {
  const pinned = pinnedSiteIds(opts.selections);
  const list = Array.isArray(commands) ? commands : [];
  let next = stampSiteHtml(html);
  const applied = [];
  const written = [];
  let lastId = '';
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') continue;
    const op = String(cmd.op || cmd.type || '').trim();
    if (op === 'replaceHtml' || op === 'setHtml') {
      const raw = String(cmd.html || cmd.content || cmd.value || '').trim();
      if (!raw) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          error: 'replaceHtml needs html or a guest path',
          hint: 'pass html, or path / from to /scratch or /artifacts HTML — do not retype'
        };
      }
      const policy = htmlWritePolicy(raw);
      if (!policy.allow || policy.kind !== 'site') {
        return {
          ok: false,
          code: policy.code || 'NEED_HTML_KIND',
          error: policy.error || 'replaceHtml needs data-browserbot-kind=site',
          hint: 'in-place site replace stays on the same marked HTML file'
        };
      }
      next = stampSiteHtml(raw);
      applied.push(op);
      lastId = listSiteNodes(next)[0]?.nodeId || lastId;
      continue;
    }
    const ids = commandSiteIds(cmd);
    const targets = ids.length ? ids : pinned;
    if (WRITE_OPS.has(op) && !targets.length) {
      return {
        ok: false,
        code: 'NEED_SELECTION',
        error: 'click a node on the page (or pass nodeId)',
        available: listSiteNodes(next).map((n) => n.nodeId),
        selected: pinned
      };
    }
    for (const id of targets) {
      if (op === 'setText' || op === 'setSlotText' || op === 'updateText') {
        const text = cmd.text != null ? String(cmd.text) : String(cmd.value || '');
        next = replaceInner(next, id, escapeHtml(text));
        applied.push(op);
        lastId = id;
        if (!written.includes(id)) written.push(id);
      }
      if (op === 'setHref') {
        next = setAttr(next, id, 'href', String(cmd.href || cmd.value || cmd.text || ''));
        applied.push(op);
        lastId = id;
        if (!written.includes(id)) written.push(id);
      }
      if (op === 'setSrc' || op === 'setSlotSrc') {
        next = setAttr(next, id, 'src', String(cmd.src || cmd.value || cmd.path || cmd.item || ''));
        applied.push(op);
        lastId = id;
        if (!written.includes(id)) written.push(id);
      }
      if (op === 'remove' || op === 'delete' || op === 'removeNode') {
        next = removeSiteNodes(next, [id]);
        applied.push(op);
        lastId = id;
        if (!written.includes(id)) written.push(id);
      }
      if (op === 'duplicate') {
        const dup = duplicateSiteNodes(next, [id]);
        next = dup.html;
        applied.push(op);
        lastId = dup.created[0] || id;
        for (const nid of dup.created) {
          if (!written.includes(nid)) written.push(nid);
        }
      }
    }
  }
  const available = listSiteNodes(next).map((n) => n.nodeId);
  const live = new Set(available);
  const node = listSiteNodes(next).find((n) => n.nodeId === lastId);
  return {
    ok: true,
    html: next,
    applied,
    dirty: lastId,
    readback: node || { nodeId: lastId },
    available,
    selected: pinned.filter((id) => live.has(id)),
    nodeIds: written
  };
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(String(attrs || ''));
  return m ? m[1] : '';
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function replaceInner(html, nodeId, inner) {
  const re = new RegExp(
    `(<(?:${TEXT_TAGS})\\b[^>]*data-paw-node="${escRe(nodeId)}"[^>]*>)[\\s\\S]*?(</(?:${TEXT_TAGS})>)`,
    'i'
  );
  if (!re.test(html)) return html;
  return html.replace(re, `$1${inner}$2`);
}

function setAttr(html, nodeId, name, value) {
  const re = new RegExp(`(<[^>]*data-paw-node="${escRe(nodeId)}"[^>]*)(\\/?)>`, 'i');
  return html.replace(re, (m, pre, slash) => {
    const cleaned = pre.replace(new RegExp(`\\s${name}\\s*=\\s*["'][^"']*["']`, 'i'), '');
    return `${cleaned} ${name}="${String(value).replace(/"/g, '&quot;')}"${slash || ''}>`;
  });
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nextSiteNodeId(html) {
  let max = 0;
  const re = /data-paw-node="n(\d+)"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return `n${max + 1}`;
}

export function removeSiteNodes(html, nodeIds) {
  let next = String(html || '');
  for (const raw of Array.isArray(nodeIds) ? nodeIds : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const esc = escRe(id);
    next = next.replace(new RegExp(`<img\\b[^>]*data-paw-node="${esc}"[^>]*\\/?>`, 'i'), '');
    next = next.replace(new RegExp(`<([a-z0-9]+)\\b[^>]*data-paw-node="${esc}"[^>]*>[\\s\\S]*?</\\1>`, 'i'), '');
  }
  return next;
}

export function duplicateSiteNodes(html, nodeIds) {
  let next = String(html || '');
  const created = [];
  for (const raw of Array.isArray(nodeIds) ? nodeIds : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const esc = escRe(id);
    const imgRe = new RegExp(`<img\\b[^>]*data-paw-node="${esc}"[^>]*\\/?>`, 'i');
    const tagRe = new RegExp(`<([a-z0-9]+)\\b[^>]*data-paw-node="${esc}"[^>]*>[\\s\\S]*?</\\1>`, 'i');
    const m = imgRe.exec(next) || tagRe.exec(next);
    if (!m) continue;
    const nid = nextSiteNodeId(next);
    const clone = m[0].replace(new RegExp(`data-paw-node="${esc}"`, 'i'), `data-paw-node="${nid}"`);
    next = `${next.slice(0, m.index + m[0].length)}${clone}${next.slice(m.index + m[0].length)}`;
    created.push(nid);
  }
  return { html: next, created };
}
