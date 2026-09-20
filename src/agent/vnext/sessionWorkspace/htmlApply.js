/**
 * Host HTML object model: plates + slots, command apply, draft plates.
 * Node-safe — no window / DOMParser.
 */

import { alignBoxes, distributeBoxes } from './htmlArtboard.js';

export const HTML_OPS = [
  'createDocument',
  'setSlotText',
  'setSlotHtml',
  'setSlotSrc',
  'propagateSlotSrc',
  'replacePlate',
  'insertPlate',
  'deletePlate',
  'reorder',
  'setBox',
  'reorderSlots',
  'align',
  'group',
  'ungroup',
  'setHidden',
  'setLocked',
  'setRotate'
];

export const DRAFT_SUFFIX = '（草稿）';

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

const SLOT_OPS = new Set([
  'setSlotText',
  'setSlotHtml',
  'setSlotSrc',
  'propagateSlotSrc',
  'setBox',
  'setHidden',
  'setLocked',
  'setRotate'
]);
const PLATE_TARGET_OPS = new Set(['replacePlate', 'deletePlate']);

export function isDraftPlateId(id) {
  return String(id || '').endsWith(DRAFT_SUFFIX);
}

export function sourceIdFromDraft(id) {
  const n = String(id || '');
  return isDraftPlateId(n) ? n.slice(0, -DRAFT_SUFFIX.length) : n;
}

export function draftIdFor(sourceId) {
  const base = String(sourceId || 'plate');
  return isDraftPlateId(base) ? base : `${base}${DRAFT_SUFFIX}`;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function stripDangerousHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '');
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function parseBox(raw) {
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

export function formatBox(box) {
  if (box == null || box === '') return '';
  if (typeof box === 'string') return box;
  if (Array.isArray(box)) return box.slice(0, 4).join(',');
  const parsed = parseBox(box);
  if (!parsed) return '';
  return `${parsed.x},${parsed.y},${parsed.w},${parsed.h}`;
}

export function decodePlateNotes(raw) {
  const s = String(raw || '');
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function encodePlateNotes(raw) {
  return encodeURIComponent(String(raw || ''));
}

/** Pasteboard placement for a top-level Frame. Design: side-by-side; Slides: host strip. */
export function defaultPasteboardBox(index, size, kind) {
  const w = Number(size?.w) > 0 ? Number(size.w) : kind === 'deck' ? 1920 : 720;
  const h = Number(size?.h) > 0 ? Number(size.h) : kind === 'deck' ? 1080 : 1080;
  return { x: Math.round(Number(index || 0) * (w + 80)), y: 0, w, h };
}

/**
 * Persist a plate as an independent Frame (pasteboard box + name + notes).
 * @param {{ id?: string, html?: string, pdf?: boolean, frame?: string, frameBox?: object, frameName?: string, name?: string, notes?: string }} p
 * @param {{ kind?: string }} [opts]
 */
export function serializePlateSection(p, opts = {}) {
  const id = escapeAttr(p?.id || 'plate');
  const parts = [`data-browserbot-block`, `data-browserbot-block-id="${id}"`];
  if (p?.pdf) parts.push('data-paw-pdf="reconstructed"');
  const frame = escapeAttr(p?.frame || p?.id || id);
  parts.push(`data-paw-frame="${frame}"`);
  const box = p?.frameBox || parseBox(p?.['data-frame-box']);
  if (box) parts.push(`data-frame-box="${escapeAttr(formatBox(box))}"`);
  const name = p?.frameName || p?.name;
  if (name) parts.push(`data-frame-name="${escapeAttr(name)}"`);
  if (p?.notes) parts.push(`data-paw-notes="${escapeAttr(encodePlateNotes(p.notes))}"`);
  if (String(opts.kind || p?.kind || '') === 'deck') parts.push('data-paw-slide');
  return `<section ${parts.join(' ')}>${p?.html || ''}</section>`;
}

function parseAttrs(openTag) {
  const attrs = {};
  const s = String(openTag || '')
    .replace(/^<[^\s>/]+/, '')
    .replace(/\/?>$/, '');
  const re = /([:@]?[\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function skipComment(html, i) {
  if (html.startsWith('<!--', i)) {
    const end = html.indexOf('-->', i + 4);
    return end < 0 ? html.length : end + 3;
  }
  return i;
}

function parseOpenTag(html, i) {
  if (html[i] !== '<') return null;
  const next = html[i + 1];
  if (next === '/' || next === '!' || next === '?') return null;
  const gt = html.indexOf('>', i);
  if (gt < 0) return null;
  const raw = html.slice(i, gt + 1);
  const m = /^<([a-zA-Z][\w:-]*)/.exec(raw);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(tag);
  return { tag, attrs: parseAttrs(raw), start: i, openEnd: gt + 1, selfClosing, raw };
}

function parseElementAt(html, i) {
  const open = parseOpenTag(html, i);
  if (!open) return null;
  if (open.selfClosing) {
    return {
      ...open,
      innerStart: open.openEnd,
      innerEnd: open.openEnd,
      end: open.openEnd,
      innerHtml: '',
      outerHtml: html.slice(open.start, open.openEnd)
    };
  }
  const closeNeedle = `</${open.tag}`;
  let depth = 1;
  let j = open.openEnd;
  while (j < html.length && depth > 0) {
    const skipped = skipComment(html, j);
    if (skipped !== j) {
      j = skipped;
      continue;
    }
    if (html[j] !== '<') {
      j += 1;
      continue;
    }
    const slice = html.slice(j, j + closeNeedle.length);
    if (slice.toLowerCase() === closeNeedle) {
      const after = html[j + closeNeedle.length];
      if (after === '>' || (after && /\s/.test(after))) {
        const gt = html.indexOf('>', j);
        if (gt < 0) break;
        depth -= 1;
        if (depth === 0) {
          return {
            ...open,
            innerStart: open.openEnd,
            innerEnd: j,
            end: gt + 1,
            innerHtml: html.slice(open.openEnd, j),
            outerHtml: html.slice(open.start, gt + 1)
          };
        }
        j = gt + 1;
        continue;
      }
    }
    const nested = parseOpenTag(html, j);
    if (nested && nested.tag === open.tag && !nested.selfClosing) {
      depth += 1;
      j = nested.openEnd;
      continue;
    }
    const gt = html.indexOf('>', j);
    if (gt < 0) break;
    j = gt + 1;
  }
  return {
    ...open,
    innerStart: open.openEnd,
    innerEnd: html.length,
    end: html.length,
    innerHtml: html.slice(open.openEnd),
    outerHtml: html.slice(open.start)
  };
}

function hasAttrToken(openRaw, name) {
  const re = new RegExp(`\\s${name}(?:\\s|=|/|>)`, 'i');
  return re.test(` ${openRaw.slice(1)}`);
}

function slotFromEl(el) {
  const box = parseBox(el.attrs['data-box']);
  return {
    id: String(el.attrs['data-paw-slot'] || ''),
    tag: el.tag,
    html: el.innerHtml,
    text: textFromHtml(el.innerHtml) || String(el.attrs.alt || ''),
    src: el.attrs.src || '',
    box,
    hidden: el.attrs['data-paw-hidden'] === '1' || el.attrs.hidden === '' || el.attrs.hidden === 'hidden',
    lock: el.attrs['data-paw-lock'] === '1',
    rotate: Number(el.attrs['data-paw-rotate'] || 0) || 0,
    group: String(el.attrs['data-paw-group'] || ''),
    start: el.start,
    end: el.end,
    innerStart: el.innerStart,
    innerEnd: el.innerEnd,
    selfClosing: el.selfClosing,
    raw: el.raw
  };
}

function findSlots(inner) {
  const html = String(inner || '');
  const slots = [];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      i = skipComment(html, i);
      continue;
    }
    if (html[i] !== '<') {
      i += 1;
      continue;
    }
    const el = parseElementAt(html, i);
    if (!el) {
      i += 1;
      continue;
    }
    if (el.attrs['data-paw-slot'] != null && String(el.attrs['data-paw-slot']) !== '') {
      slots.push(slotFromEl(el));
      i = el.end;
      continue;
    }
    i = el.openEnd;
  }
  return slots;
}

function findTopLevelPlates(bodyInner) {
  const html = String(bodyInner || '');
  const plates = [];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      i = skipComment(html, i);
      continue;
    }
    if (html[i] !== '<') {
      i += 1;
      continue;
    }
    const el = parseElementAt(html, i);
    if (!el) {
      i += 1;
      continue;
    }
    if (hasAttrToken(el.raw, 'data-browserbot-block')) {
      const id = String(el.attrs['data-browserbot-block-id'] || '').trim() || `plate-${plates.length + 1}`;
      plates.push(makePlate(id, el.innerHtml, el.attrs));
      i = el.end;
      continue;
    }
    i = el.end;
  }
  return plates;
}

function makePlate(id, innerHtml, attrs = {}) {
  const html = String(innerHtml || '');
  return {
    id: String(id || ''),
    html,
    slots: findSlots(html),
    pdf: Object.prototype.hasOwnProperty.call(attrs, 'data-paw-pdf'),
    frame: String(attrs['data-paw-frame'] || id || ''),
    frameBox: parseBox(attrs['data-frame-box']),
    frameName: String(attrs['data-frame-name'] || ''),
    notes: decodePlateNotes(attrs['data-paw-notes'] || '')
  };
}

function clonePlate(plate, newId) {
  return {
    id: newId != null ? String(newId) : plate.id,
    html: String(plate.html || ''),
    slots: (plate.slots || []).map((s) => ({
      id: s.id,
      tag: s.tag,
      html: s.html,
      text: s.text,
      src: s.src,
      box: s.box ? { ...s.box } : s.box
    })),
    pdf: !!plate.pdf,
    frame: newId != null ? String(newId) : plate.frame || plate.id,
    frameBox: plate.frameBox ? { ...plate.frameBox } : plate.frameBox || null,
    frameName: plate.frameName || '',
    notes: plate.notes || ''
  };
}

function refreshPlate(plate) {
  plate.slots = findSlots(plate.html);
  return plate;
}

function extractTagInner(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(String(html || ''));
  return m ? m[1] : '';
}

function extractBodyInner(html) {
  const s = String(html || '');
  const m = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(s);
  return m ? m[1] : s;
}

function extractStyles(html) {
  const parts = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) parts.push(m[1]);
  return parts.join('\n').trim();
}

function extractLang(html) {
  const m = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? m[1] : 'zh-CN';
}

/**
 * @param {string} html
 * @returns {{ title: string, lang: string, styles: string, plates: Array<object>, pdf?: boolean }}
 */
export function parseMarkedHtml(html) {
  const s = String(html || '');
  const title = textFromHtml(extractTagInner(s, 'title'));
  const lang = extractLang(s);
  const styles = extractStyles(s);
  const pdf = /data-paw-pdf\s*=/i.test(s);
  let plates = findTopLevelPlates(extractBodyInner(s));
  if (!plates.length) {
    const body = extractBodyInner(s).trim();
    if (body) plates = [makePlate('page', body)];
  }
  const kindMatch = /data-browserbot-kind\s*=\s*["']([^"']+)["']/i.exec(s);
  return { title, lang, styles, plates, pdf, kind: kindMatch?.[1] || '' };
}

/**
 * @param {{ title?: string, lang?: string, styles?: string, plates?: Array<{id?: string, html?: string, pdf?: boolean}>, pdf?: boolean }} doc
 */
export function serializeMarkedHtml(doc) {
  const title = escapeHtml(doc?.title || 'Preview');
  const lang = escapeAttr(doc?.lang || 'zh-CN');
  const styleText = String(doc?.styles || '').trim();
  const style = styleText
    ? `<style>\n${styleText}\n</style>`
    : `<style>body{font-family:system-ui,sans-serif;line-height:1.55;color:#1c1915}</style>`;
  const pdf = !!(doc && doc.pdf);
  const pdfAttr = pdf ? ' data-paw-pdf="reconstructed"' : '';
  const kind = String(doc?.kind || '').trim();
  const kindAttr = kind ? ` data-browserbot-kind="${escapeAttr(kind)}"` : '';
  const pdfMeta = pdf ? `\n  <meta name="paw-pdf" content="reconstructed" />` : '';
  const parts = (doc?.plates || []).map((p) => serializePlateSection(p, { kind })).join('\n');
  return `<!DOCTYPE html>
<html lang="${lang}" data-browserbot-preview="blocks"${pdfAttr}${kindAttr}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="browserbot-preview" content="blocks" />${pdfMeta}
  <title>${title}</title>
  ${style}
</head>
<body>
${parts}
</body>
</html>
`;
}

function setAttrOnOpen(openRaw, name, value) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const assignment = ` ${name}="${escapeAttr(value)}"`;
  if (re.test(openRaw)) return openRaw.replace(re, assignment);
  if (/\/\s*>$/.test(openRaw)) return openRaw.replace(/\s*\/\s*>$/, `${assignment} />`);
  return openRaw.replace(/>$/, `${assignment}>`);
}

function removeAttrOnOpen(openRaw, name) {
  const re = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i');
  return String(openRaw || '').replace(re, '');
}

function replaceOpenTag(plateHtml, slot, newOpen) {
  return plateHtml.slice(0, slot.start) + newOpen + plateHtml.slice(slot.start + slot.raw.length);
}

function reorderSlotsHtml(inner, orderIds) {
  const slots = findSlots(inner);
  if (!slots.length) return inner;
  const byId = new Map(slots.map((s) => [s.id, s]));
  const used = new Set();
  const ordered = [];
  for (const id of Array.isArray(orderIds) ? orderIds.map(String) : []) {
    const s = byId.get(id);
    if (s && !used.has(s.id)) {
      ordered.push(s);
      used.add(s.id);
    }
  }
  for (const s of slots) {
    if (!used.has(s.id)) ordered.push(s);
  }
  const prefix = inner.slice(0, slots[0].start);
  const suffix = inner.slice(slots[slots.length - 1].end);
  return prefix + ordered.map((s) => inner.slice(s.start, s.end)).join('\n') + suffix;
}

function findPlate(plates, plateId) {
  const id = String(plateId || '');
  return (
    plates.find((p) => p.id === id) ||
    plates.find((p) => p.id === sourceIdFromDraft(id)) ||
    plates.find((p) => p.id === draftIdFor(id)) ||
    null
  );
}

function findSlotOnPlate(plate, slotId) {
  if (!plate) return null;
  const id = String(slotId || '');
  return (plate.slots || []).find((s) => s.id === id) || null;
}

export function ensureDraftPlate(plates, plateId) {
  const list = Array.isArray(plates) ? plates.map((p) => clonePlate(p)) : [];
  const srcId = sourceIdFromDraft(plateId) || list.find((p) => !isDraftPlateId(p.id))?.id || 'plate';
  const draftId = draftIdFor(srcId);
  const original = list.find((p) => p.id === srcId);
  const existing = list.find((p) => p.id === draftId);
  if (existing) {
    return { plates: list, draftId, sourceId: srcId, created: false };
  }
  const clone = original ? clonePlate(original, draftId) : makePlate(draftId, '');
  const idx = list.findIndex((p) => p.id === srcId);
  if (idx >= 0) list.splice(idx + 1, 0, clone);
  else list.push(clone);
  return { plates: list, draftId, sourceId: srcId, created: true };
}

function nextPlateId(plates, base = 'plate') {
  const used = new Set((plates || []).map((p) => p.id));
  let i = 1;
  while (used.has(`${base}-${i}`) || used.has(draftIdFor(`${base}-${i}`))) i += 1;
  return `${base}-${i}`;
}

export function normalizeHtmlSelection(raw) {
  const all = normalizeHtmlSelections(raw);
  return all[0] || null;
}

export function normalizeHtmlSelections(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const s of list) {
    if (!s) continue;
    if (typeof s === 'string') {
      const m = /^([^/#]+)[/#](.+)$/.exec(s.trim());
      if (m) out.push({ plateId: m[1], slotId: m[2] });
      else if (s.trim()) out.push({ plateId: s.trim(), slotId: '' });
      continue;
    }
    if (typeof s !== 'object') continue;
    const plateId = String(s.plateId || s.plate || s.blockId || '').trim();
    const slotId = String(s.slotId || s.slot || '').trim();
    if (plateId || slotId) out.push({ plateId, slotId });
  }
  return out;
}

export function normalizeHtmlCommands(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') continue;
    const op = String(cmd.op || cmd.type || '').trim();
    if (!HTML_OPS.includes(op)) continue;
    out.push({ ...cmd, op });
  }
  return out;
}

const FIELD_WRITE_OPS = new Set(['setSlotText', 'setSlotHtml', 'setSlotSrc']);

export const NEED_SELECTION = {
  ok: false,
  code: 'NEED_SELECTION',
  error: 'click a block on the canvas (or pass slotId) before a field edit'
};

function hasRealSlotId(sel) {
  return Boolean(String(sel?.slotId || sel?.slot || '').trim());
}

/**
 * Commands that omit plateId/slotId inherit selections[0] only when that
 * selection has a real slotId. Plate-only selection never invents a slot.
 * Plate-level ops (replacePlate/deletePlate/insertPlate) may still inherit plateId.
 * @param {object[]} commands
 * @param {unknown} selections
 */
export function fillMissingSlotFromSelection(commands, selections) {
  const primary = normalizeHtmlSelection(selections);
  const list = normalizeHtmlCommands(commands);
  if (!primary) return list;
  const slotId = String(primary.slotId || '').trim();
  return list.map((cmd) => {
    if (!SLOT_OPS.has(cmd.op) && !PLATE_TARGET_OPS.has(cmd.op) && cmd.op !== 'insertPlate') {
      return cmd;
    }
    const next = { ...cmd };
    if (SLOT_OPS.has(cmd.op)) {
      if (!slotId) return next;
      if (!String(next.plateId || next.plate || '').trim() && primary.plateId) {
        next.plateId = primary.plateId;
      }
      if (!String(next.slotId || next.slot || '').trim()) {
        next.slotId = slotId;
      }
      return next;
    }
    if (!String(next.plateId || next.plate || '').trim() && primary.plateId) {
      next.plateId = primary.plateId;
    }
    return next;
  });
}

/**
 * True when a field write still has no slotId after fill-from-selection.
 * Theme/layout/insertPlate/deletePlate/reorder are not field writes.
 * @param {object[]} commands
 * @param {unknown} [selections]
 */
export function fieldWriteNeedsSelection(commands, selections) {
  const list = Array.isArray(commands) ? commands : [];
  const orig = list.filter((c) => c && FIELD_WRITE_OPS.has(String(c.op || c.type || '').trim()));
  if (!orig.length) return false;
  const filled = selections === undefined ? list : fillMissingSlotFromSelection(list, selections);
  const after = filled.filter((c) => FIELD_WRITE_OPS.has(String(c.op || '').trim()));
  const check = after.length ? after : orig;
  return check.some((c) => !hasRealSlotId(c));
}

function commandPlateId(cmd) {
  return String(cmd.plateId || cmd.plate || cmd.id || '').trim();
}

function commandSlotId(cmd) {
  return String(cmd.slotId || cmd.slot || '').trim();
}

function resolveSlotPlate(plates, plateId, slotId) {
  if (plateId) {
    const hit = findPlate(plates, plateId);
    if (hit) return hit;
  }
  if (slotId) {
    const hit = plates.find((p) => (p.slots || []).some((s) => s.id === slotId));
    if (hit) return hit;
  }
  return plates.find((p) => !isDraftPlateId(p.id)) || plates[0] || null;
}

function mutateSlot(plate, slotId, mutator) {
  const live = findSlots(plate.html);
  const slot = live.find((s) => s.id === slotId);
  if (!slot) return { ok: false, error: `slot not found: ${slotId}` };
  const next = mutator(plate.html, slot);
  if (next && next.error) return next;
  plate.html = typeof next === 'string' ? next : next.html;
  refreshPlate(plate);
  return { ok: true, slot: findSlotOnPlate(plate, slotId) };
}

/**
 * Inspect a plate/slot without collapsing ids (requested slot stays that slot).
 * @param {string} html
 * @param {{ plateId?: string, slotId?: string }} [query]
 */
export function inspectHtml(html, query = {}) {
  const doc = typeof html === 'string' ? parseMarkedHtml(html) : html && html.plates ? html : parseMarkedHtml('');
  const plateId = String(query.plateId || query.plate || '').trim();
  const slotId = String(query.slotId || query.slot || '').trim();
  const overview = {
    title: doc.title,
    lang: doc.lang,
    plates: (doc.plates || []).map((p) => ({
      id: p.id,
      slotIds: (p.slots || []).map((s) => s.id),
      slots: (p.slots || []).map((s) => ({
        id: s.id,
        tag: s.tag,
        text: String(s.text || '').slice(0, 160),
        src: s.src || '',
        box: s.box || null
      }))
    }))
  };
  const nodes = (doc.plates || []).flatMap((p) =>
    (p.slots || []).map((s) => ({
      plateId: p.id,
      id: s.id,
      slotId: s.id,
      tag: s.tag,
      type: s.tag === 'img' ? 'image' : /^h1$/.test(s.tag) ? 'headline' : /^h[2-6]$/.test(s.tag) ? 'heading' : s.tag === 'button' || s.tag === 'a' ? 'control' : 'text',
      text: String(s.text || '').slice(0, 160),
      src: s.src || '',
      box: s.box || null
    }))
  );
  if (!plateId && !slotId) {
    return { ok: true, requested: { plateId, slotId }, nodes, ...overview };
  }
  const plate = resolveSlotPlate(doc.plates || [], plateId, slotId);
  if (!plate) {
    return {
      ok: false,
      error: 'plate not found',
      requested: { plateId, slotId },
      plateId: plateId || undefined,
      slotId: slotId || undefined,
      ...overview
    };
  }
  const slot = slotId ? findSlotOnPlate(plate, slotId) : null;
  if (slotId && !slot) {
    return {
      ok: false,
      error: `slot not found: ${slotId}`,
      requested: { plateId: plateId || plate.id, slotId },
      plateId: plate.id,
      slotId,
      plate: publicPlate(plate),
      ...overview
    };
  }
  return {
    ok: true,
    requested: { plateId: plateId || plate.id, slotId: slotId || undefined },
    plateId: plate.id,
    slotId: slot ? slot.id : undefined,
    plate: publicPlate(plate),
    slot: slot ? publicSlot(slot) : undefined,
    nodes,
    ...overview
  };
}

function publicPlate(plate) {
  return {
    id: plate.id,
    html: plate.html,
    slots: (plate.slots || []).map(publicSlot)
  };
}

function publicSlot(slot) {
  return {
    id: slot.id,
    tag: slot.tag,
    html: slot.html,
    text: slot.text,
    src: slot.src || '',
    box: slot.box || null,
    hidden: !!slot.hidden,
    lock: !!slot.lock,
    rotate: Number(slot.rotate || 0) || 0,
    group: slot.group || ''
  };
}

export function mergeDraftPlates(html, sourceId) {
  const doc = typeof html === 'string' ? parseMarkedHtml(html) : cloneDoc(html);
  const want = sourceId ? sourceIdFromDraft(sourceId) : null;
  const drafts = doc.plates.filter((p) => isDraftPlateId(p.id) && (!want || sourceIdFromDraft(p.id) === want));
  let merged = false;
  for (const draft of drafts) {
    const srcId = sourceIdFromDraft(draft.id);
    const orig = doc.plates.find((p) => p.id === srcId);
    if (orig) {
      orig.html = draft.html;
      orig.pdf = draft.pdf;
      refreshPlate(orig);
    } else {
      doc.plates.push(clonePlate(draft, srcId));
    }
    merged = true;
  }
  const drop = new Set(drafts.map((d) => d.id));
  doc.plates = doc.plates.filter((p) => !drop.has(p.id));
  return { html: serializeMarkedHtml(doc), doc, merged, plates: doc.plates };
}

export function applyHtmlDraftAction(html, action, sourceId) {
  const act = String(action || '');
  if (act === 'accept' || act === 'merge') {
    return { action: 'accept', ...mergeDraftPlates(html, sourceId) };
  }
  if (act === 'discard') {
    return { action: 'discard', ...discardDraftPlates(html, sourceId) };
  }
  return {
    action: act,
    html: typeof html === 'string' ? html : '',
    merged: false,
    discarded: false
  };
}

export function discardDraftPlates(html, sourceId) {
  const doc = typeof html === 'string' ? parseMarkedHtml(html) : cloneDoc(html);
  const want = sourceId ? sourceIdFromDraft(sourceId) : null;
  const before = doc.plates.length;
  doc.plates = doc.plates.filter((p) => {
    if (!isDraftPlateId(p.id)) return true;
    if (!want) return false;
    return sourceIdFromDraft(p.id) !== want;
  });
  return {
    html: serializeMarkedHtml(doc),
    doc,
    discarded: doc.plates.length !== before,
    plates: doc.plates
  };
}

function cloneDoc(doc) {
  return {
    title: doc?.title || '',
    lang: doc?.lang || 'zh-CN',
    styles: doc?.styles || '',
    pdf: !!doc?.pdf,
    plates: (doc?.plates || []).map((p) => clonePlate(p))
  };
}

function reorderPlates(plates, order) {
  const ids = Array.isArray(order) ? order.map(String) : [];
  const byId = new Map(plates.map((p) => [p.id, p]));
  const used = new Set();
  const out = [];
  const pushPair = (rawId) => {
    const src = sourceIdFromDraft(rawId);
    const orig = byId.get(src);
    const draft = byId.get(draftIdFor(src));
    if (orig && !used.has(orig.id)) {
      out.push(orig);
      used.add(orig.id);
    }
    if (draft && !used.has(draft.id)) {
      out.push(draft);
      used.add(draft.id);
    }
    const exact = byId.get(rawId);
    if (exact && !used.has(exact.id)) {
      out.push(exact);
      used.add(exact.id);
    }
  };
  for (const id of ids) pushPair(id);
  for (const p of plates) {
    if (!used.has(p.id)) out.push(p);
  }
  return out;
}

function slotTextValue(cmd) {
  if (cmd.text != null) return String(cmd.text);
  if (cmd.value != null) return String(cmd.value);
  if (cmd.content != null) return String(cmd.content);
  return '';
}

function slotHtmlValue(cmd) {
  if (cmd.html != null) return String(cmd.html);
  if (cmd.value != null) return String(cmd.value);
  if (cmd.content != null) return String(cmd.content);
  return '';
}

function slotSrcValue(cmd) {
  return String(cmd.src || cmd.url || cmd.value || '');
}

function applyCreateDocument(cmd) {
  if (typeof cmd.html === 'string' && cmd.html.trim()) {
    return parseMarkedHtml(cmd.html);
  }
  const plates = Array.isArray(cmd.plates)
    ? cmd.plates.map((p, i) => makePlate(p.id || p.plateId || `plate-${i + 1}`, p.html || ''))
    : [];
  return {
    title: cmd.title || 'Preview',
    lang: cmd.lang || 'zh-CN',
    styles: cmd.styles || '',
    pdf: !!cmd.pdf,
    kind: cmd.kind || '',
    plates
  };
}

function readbackFrom(doc, plateId, slotId) {
  const plate = findPlate(doc.plates, plateId);
  const slot = slotId && plate ? findSlotOnPlate(plate, slotId) : null;
  return {
    plateId: plate ? plate.id : plateId,
    slotId: slot ? slot.id : slotId || undefined,
    plate: plate ? publicPlate(plate) : undefined,
    slot: slot ? publicSlot(slot) : undefined
  };
}

/**
 * @param {string} html
 * @param {object[]|object} commands
 * @param {{ selections?: unknown, draft?: boolean }} [opts]
 */
export function applyHtmlCommands(html, commands, opts = {}) {
  try {
    return applyHtmlCommandsInner(html, commands, opts);
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      html: String(html || ''),
      applied: [],
      readback: null
    };
  }
}

function applyHtmlCommandsInner(html, commands, opts) {
  let doc = parseMarkedHtml(html);
  const draftMode = opts.draft !== false;
  let list = fillMissingSlotFromSelection(commands, opts.selections);
  const applied = [];
  let readback = null;

  for (const cmd of list) {
    if (cmd.op === 'createDocument') {
      if (draftMode && doc.plates.length) {
        applied.push({ op: cmd.op, skipped: true, reason: 'document-exists' });
        continue;
      }
      doc = applyCreateDocument(cmd);
      applied.push({ op: cmd.op, plates: doc.plates.length });
      readback = readbackFrom(doc, doc.plates[0]?.id, doc.plates[0]?.slots[0]?.id);
      continue;
    }

    if (cmd.op === 'reorder') {
      const order = cmd.order || cmd.plateIds || cmd.ids || [];
      doc.plates = reorderPlates(doc.plates, order);
      applied.push({ op: cmd.op, order: doc.plates.map((p) => p.id) });
      readback = { plateIds: doc.plates.map((p) => p.id) };
      continue;
    }

    if (cmd.op === 'insertPlate') {
      let newId = commandPlateId(cmd) || nextPlateId(doc.plates);
      if (draftMode && !isDraftPlateId(newId)) newId = draftIdFor(newId);
      const inner = stripDangerousHtml(cmd.html || cmd.content || '');
      const plate = makePlate(newId, inner);
      const afterId = String(cmd.after || cmd.before || '').trim();
      let idx = -1;
      if (afterId) {
        const src = sourceIdFromDraft(afterId);
        const draftIdx = doc.plates.findIndex((p) => p.id === draftIdFor(src));
        const origIdx = doc.plates.findIndex((p) => p.id === src || p.id === afterId);
        idx = cmd.before != null ? origIdx : draftIdx >= 0 ? draftIdx : origIdx;
      }
      if (cmd.before != null && idx >= 0) doc.plates.splice(idx, 0, plate);
      else if (idx >= 0) doc.plates.splice(idx + 1, 0, plate);
      else doc.plates.push(plate);
      applied.push({ op: cmd.op, plateId: plate.id });
      readback = readbackFrom(doc, plate.id, plate.slots[0]?.id);
      continue;
    }

    if (cmd.op === 'reorderSlots') {
      const plate = findPlate(doc.plates, commandPlateId(cmd) || doc.plates[0]?.id);
      if (!plate) {
        return { ok: false, error: 'plate not found', html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      const order = cmd.order || cmd.slotIds || cmd.ids || [];
      plate.html = reorderSlotsHtml(plate.html, order);
      refreshPlate(plate);
      applied.push({ op: cmd.op, plateId: plate.id, order: plate.slots.map((s) => s.id) });
      readback = { plateId: plate.id, slotIds: plate.slots.map((s) => s.id) };
      continue;
    }

    if (cmd.op === 'align') {
      const sels = normalizeHtmlSelections(opts.selections);
      const plate = findPlate(
        doc.plates,
        commandPlateId(cmd) || sels[0]?.plateId || doc.plates[0]?.id
      );
      if (!plate) {
        return { ok: false, error: 'plate not found', html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      const ids = (cmd.slotIds || cmd.ids || sels.map((s) => s.slotId)).filter(Boolean);
      const mode = String(cmd.align || cmd.mode || cmd.edge || 'left');
      const items = ids
        .map((id) => {
          const s = findSlotOnPlate(plate, id);
          return s?.box ? { id, ...s.box } : null;
        })
        .filter(Boolean);
      const next = mode.startsWith('distribute')
        ? distributeBoxes(items, /y$/i.test(mode) ? 'y' : 'x')
        : alignBoxes(items, mode);
      for (const b of next) {
        mutateSlot(plate, b.id, (src, slot) =>
          replaceOpenTag(src, slot, setAttrOnOpen(slot.raw, 'data-box', formatBox(b)))
        );
      }
      refreshPlate(plate);
      applied.push({ op: cmd.op, plateId: plate.id, align: mode, slotIds: next.map((b) => b.id) });
      readback = readbackFrom(doc, plate.id, next[0]?.id);
      continue;
    }

    if (cmd.op === 'group' || cmd.op === 'ungroup') {
      const sels = normalizeHtmlSelections(opts.selections);
      const plate = findPlate(
        doc.plates,
        commandPlateId(cmd) || sels[0]?.plateId || doc.plates[0]?.id
      );
      if (!plate) {
        return { ok: false, error: 'plate not found', html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      const ids = (cmd.slotIds || cmd.ids || sels.map((s) => s.slotId)).filter(Boolean);
      const gid =
        cmd.op === 'ungroup' ? '' : String(cmd.groupId || cmd.group || `g_${Math.random().toString(36).slice(2, 8)}`);
      for (const id of ids) {
        mutateSlot(plate, id, (src, slot) =>
          replaceOpenTag(
            src,
            slot,
            gid ? setAttrOnOpen(slot.raw, 'data-paw-group', gid) : removeAttrOnOpen(slot.raw, 'data-paw-group')
          )
        );
      }
      refreshPlate(plate);
      applied.push({ op: cmd.op, plateId: plate.id, groupId: gid || undefined, slotIds: ids });
      readback = readbackFrom(doc, plate.id, ids[0]);
      continue;
    }

    if (cmd.op === 'propagateSlotSrc') {
      const srcVal = slotSrcValue(cmd);
      const targetSlot = commandSlotId(cmd);
      if (!targetSlot) {
        return {
          ...NEED_SELECTION,
          html: serializeMarkedHtml(doc),
          doc,
          applied,
          readback
        };
      }
      const hits = [];
      for (const plate of doc.plates) {
        if (!(plate.slots || []).some((s) => s.id === targetSlot)) continue;
        const result = mutateSlot(plate, targetSlot, (src, slot) =>
          replaceOpenTag(src, slot, setAttrOnOpen(slot.raw, 'src', srcVal))
        );
        if (result.ok) hits.push(plate.id);
      }
      applied.push({ op: cmd.op, slotId: targetSlot, plates: hits, src: srcVal });
      readback = hits.length
        ? readbackFrom(doc, hits[hits.length - 1], targetSlot)
        : { slotId: targetSlot, plates: [] };
      continue;
    }

    if (cmd.op === 'deletePlate') {
      const targetId = commandPlateId(cmd);
      if (!targetId) {
        applied.push({ op: cmd.op, skipped: true, reason: 'no-plateId' });
        continue;
      }
      if (draftMode && !isDraftPlateId(targetId)) {
        const draftId = draftIdFor(targetId);
        const had = doc.plates.some((p) => p.id === draftId);
        doc.plates = doc.plates.filter((p) => p.id !== draftId);
        applied.push({
          op: cmd.op,
          plateId: draftId,
          skipped: !had,
          reason: had ? undefined : 'draft-keeps-original'
        });
        continue;
      }
      const before = doc.plates.length;
      doc.plates = doc.plates.filter((p) => p.id !== targetId);
      applied.push({ op: cmd.op, plateId: targetId, deleted: doc.plates.length !== before });
      continue;
    }

    let plateId = commandPlateId(cmd);
    let slotId = commandSlotId(cmd);
    if (SLOT_OPS.has(cmd.op) && !slotId) {
      return {
        ...NEED_SELECTION,
        html: serializeMarkedHtml(doc),
        doc,
        applied,
        readback
      };
    }
    if (!plateId && slotId) {
      const owner = doc.plates.find((p) => (p.slots || []).some((s) => s.id === slotId));
      if (owner) plateId = isDraftPlateId(owner.id) ? sourceIdFromDraft(owner.id) : owner.id;
    }

    if (draftMode && plateId) {
      const ensured = ensureDraftPlate(doc.plates, plateId);
      doc.plates = ensured.plates;
      plateId = ensured.draftId;
      if (ensured.created) {
        applied.push({ op: 'ensureDraft', plateId: ensured.draftId, from: ensured.sourceId });
      }
    }

    const plate = resolveSlotPlate(doc.plates, plateId, slotId);
    if (!plate) {
      return {
        ok: false,
        error: `plate not found: ${plateId || ''}`,
        html: serializeMarkedHtml(doc),
        doc,
        applied,
        readback
      };
    }

    if (cmd.op === 'replacePlate') {
      plate.html = stripDangerousHtml(cmd.html || cmd.content || '');
      refreshPlate(plate);
      applied.push({ op: cmd.op, plateId: plate.id });
      readback = readbackFrom(doc, plate.id, plate.slots[0]?.id);
      continue;
    }

    if (cmd.op === 'setSlotText') {
      const text = slotTextValue(cmd);
      const result = mutateSlot(plate, slotId, (src, slot) => {
        if (slot.selfClosing || slot.tag === 'img' || slot.tag === 'input') {
          return replaceOpenTag(src, slot, setAttrOnOpen(slot.raw, slot.tag === 'img' ? 'alt' : 'value', text));
        }
        return src.slice(0, slot.innerStart) + escapeHtml(text) + src.slice(slot.innerEnd);
      });
      if (!result.ok) {
        return { ok: false, error: result.error, html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      applied.push({ op: cmd.op, plateId: plate.id, slotId });
      readback = readbackFrom(doc, plate.id, slotId);
      continue;
    }

    if (cmd.op === 'setSlotHtml') {
      const inner = stripDangerousHtml(slotHtmlValue(cmd));
      const result = mutateSlot(plate, slotId, (src, slot) => {
        if (slot.selfClosing) return { error: `cannot set html on <${slot.tag}>` };
        return src.slice(0, slot.innerStart) + inner + src.slice(slot.innerEnd);
      });
      if (!result.ok) {
        return { ok: false, error: result.error, html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      applied.push({ op: cmd.op, plateId: plate.id, slotId });
      readback = readbackFrom(doc, plate.id, slotId);
      continue;
    }

    if (cmd.op === 'setSlotSrc') {
      const srcVal = slotSrcValue(cmd);
      const result = mutateSlot(plate, slotId, (src, slot) => replaceOpenTag(src, slot, setAttrOnOpen(slot.raw, 'src', srcVal)));
      if (!result.ok) {
        return { ok: false, error: result.error, html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      applied.push({ op: cmd.op, plateId: plate.id, slotId, src: srcVal });
      readback = readbackFrom(doc, plate.id, slotId);
      continue;
    }

    if (cmd.op === 'setBox') {
      const boxStr = formatBox(cmd.box || cmd.dataBox || { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h });
      const result = mutateSlot(plate, slotId, (src, slot) =>
        replaceOpenTag(src, slot, setAttrOnOpen(slot.raw, 'data-box', boxStr))
      );
      if (!result.ok) {
        return { ok: false, error: result.error, html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      applied.push({ op: cmd.op, plateId: plate.id, slotId, box: boxStr });
      readback = readbackFrom(doc, plate.id, slotId);
      continue;
    }

    if (cmd.op === 'setHidden' || cmd.op === 'setLocked' || cmd.op === 'setRotate') {
      const attr = cmd.op === 'setHidden' ? 'data-paw-hidden' : cmd.op === 'setLocked' ? 'data-paw-lock' : 'data-paw-rotate';
      const on =
        cmd.op === 'setRotate'
          ? String(cmd.rotate ?? cmd.value ?? 0)
          : cmd.value === false || cmd.hidden === false || cmd.lock === false || cmd.on === false
            ? ''
            : '1';
      const result = mutateSlot(plate, slotId, (src, slot) =>
        replaceOpenTag(src, slot, on === '' ? removeAttrOnOpen(slot.raw, attr) : setAttrOnOpen(slot.raw, attr, on))
      );
      if (!result.ok) {
        return { ok: false, error: result.error, html: serializeMarkedHtml(doc), doc, applied, readback };
      }
      applied.push({ op: cmd.op, plateId: plate.id, slotId, value: on });
      readback = readbackFrom(doc, plate.id, slotId);
    }
  }

  return {
    ok: true,
    html: serializeMarkedHtml(doc),
    doc,
    applied,
    readback,
    plates: doc.plates
  };
}
