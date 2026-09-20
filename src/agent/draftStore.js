/**
 * BrowserBot Draft Store — durable draft for preview/refine (refresh-safe).
 *
 * Source of truth = serialized draft JSON in chrome.storage.local (or memory in tests).
 * Large image blobs stay as dataUrl strings on image blocks (capped); optional IDB later.
 *
 * Lifecycle: create/save while editing → purge after successful download (or explicit discard).
 */

/** @typedef {'heading'|'paragraph'|'image'|'record'|'table'|'slot'|'divider'} DraftBlockType */
/**
 * @typedef {Object} DraftBlock
 * @property {string} id
 * @property {DraftBlockType} type
 * @property {string} [text]
 * @property {string} [src]
 * @property {string} [alt]
 * @property {string} [href]
 * @property {string[]} [columns]
 * @property {Array<Record<string, string>>} [rows]
 * @property {Record<string, string>} [fields]
 * @property {string} [slotType]
 * @property {string} [sourceRef]
 */

/**
 * @typedef {Object} BrowserBotDraft
 * @property {string} draftId
 * @property {'editing'|'ready_for_export'|'delivered'|'purged'} status
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} [title]
 * @property {string} [template]
 * @property {string} [targetFormat]
 * @property {DraftBlock[]} blocks
 * @property {{ pageUrl?: string, title?: string, domain?: string }} [source]
 * @property {string} [runId]
 * @property {string} [sessionId]
 */

export const DRAFTS_STORAGE_KEY = 'browserbot_drafts_v1';
export const MAX_DRAFTS = 20;
export const MAX_BLOCKS = 200;
export const MAX_IMAGE_DATAURL_CHARS = 400_000;

/** @type {Map<string, BrowserBotDraft>|null} */
let memoryFallback = null;

function storageAvailable() {
  return typeof chrome !== 'undefined' && chrome?.storage?.local;
}

function storageGet(keys) {
  if (!storageAvailable()) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (res) => resolve(res || {}));
  });
}

function storageSet(obj) {
  if (!storageAvailable()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

/** @returns {string} */
export function generateDraftId() {
  return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {string} */
export function generateBlockId() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * @param {Partial<DraftBlock>} b
 * @returns {DraftBlock|null}
 */
export function normalizeBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const type = String(b.type || 'paragraph');
  const allowed = new Set([
    'heading',
    'paragraph',
    'image',
    'record',
    'table',
    'slot',
    'divider'
  ]);
  if (!allowed.has(type)) return null;
  /** @type {DraftBlock} */
  const out = {
    id: typeof b.id === 'string' && b.id ? b.id : generateBlockId(),
    type: /** @type {DraftBlockType} */ (type)
  };
  if (b.text != null) out.text = String(b.text).slice(0, 8000);
  if (b.src != null) {
    let src = String(b.src);
    if (src.length > MAX_IMAGE_DATAURL_CHARS) {
      src = src.slice(0, MAX_IMAGE_DATAURL_CHARS);
    }
    out.src = src;
  }
  if (b.alt != null) out.alt = String(b.alt).slice(0, 500);
  if (b.href != null) out.href = String(b.href).slice(0, 2000);
  if (Array.isArray(b.columns)) {
    out.columns = b.columns.map((c) => String(c).slice(0, 80)).slice(0, 40);
  }
  if (Array.isArray(b.rows)) {
    out.rows = b.rows.slice(0, 500).map((row) => {
      if (!row || typeof row !== 'object') return {};
      /** @type {Record<string, string>} */
      const o = {};
      for (const [k, v] of Object.entries(row)) {
        o[String(k).slice(0, 80)] = String(v ?? '').slice(0, 2000);
      }
      return o;
    });
  }
  if (b.fields && typeof b.fields === 'object') {
    /** @type {Record<string, string>} */
    const f = {};
    for (const [k, v] of Object.entries(b.fields)) {
      f[String(k).slice(0, 80)] = String(v ?? '').slice(0, 2000);
    }
    out.fields = f;
  }
  if (b.slotType != null) out.slotType = String(b.slotType).slice(0, 40);
  if (b.sourceRef != null) out.sourceRef = String(b.sourceRef).slice(0, 120);
  return out;
}

/**
 * @param {Partial<BrowserBotDraft>} input
 * @returns {BrowserBotDraft|null}
 */
export function normalizeDraft(input) {
  if (!input || typeof input !== 'object') return null;
  const now = Date.now();
  const blocks = (Array.isArray(input.blocks) ? input.blocks : [])
    .map(normalizeBlock)
    .filter(Boolean)
    .slice(0, MAX_BLOCKS);
  // Ensure at least one trailing insert slot for "add component"
  const hasSlot = blocks.some((b) => b.type === 'slot');
  if (!hasSlot) {
    blocks.push({
      id: generateBlockId(),
      type: 'slot',
      slotType: 'append',
      text: '点击此处添加内容 / Click to insert'
    });
  }
  const statusRaw = String(input.status || 'editing');
  const status = ['editing', 'ready_for_export', 'delivered', 'purged'].includes(statusRaw)
    ? /** @type {BrowserBotDraft['status']} */ (statusRaw)
    : 'editing';
  return {
    draftId:
      typeof input.draftId === 'string' && input.draftId
        ? input.draftId
        : generateDraftId(),
    status,
    version:
      typeof input.version === 'number' && Number.isFinite(input.version)
        ? Math.max(1, Math.floor(input.version))
        : 1,
    createdAt:
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : now,
    updatedAt: now,
    title: input.title != null ? String(input.title).slice(0, 200) : '',
    template: input.template != null ? String(input.template).slice(0, 64) : 'scrapbook',
    targetFormat:
      input.targetFormat != null ? String(input.targetFormat).slice(0, 16) : 'md',
    blocks,
    source:
      input.source && typeof input.source === 'object'
        ? {
            pageUrl: input.source.pageUrl
              ? String(input.source.pageUrl).slice(0, 2000)
              : undefined,
            title: input.source.title
              ? String(input.source.title).slice(0, 300)
              : undefined,
            domain: input.source.domain
              ? String(input.source.domain).slice(0, 200)
              : undefined
          }
        : undefined,
    runId: input.runId != null ? String(input.runId).slice(0, 80) : undefined,
    sessionId:
      input.sessionId != null ? String(input.sessionId).slice(0, 80) : undefined
  };
}

/**
 * @returns {Promise<Record<string, BrowserBotDraft>>}
 */
async function loadAllMap() {
  if (!storageAvailable()) {
    if (!memoryFallback) memoryFallback = new Map();
    /** @type {Record<string, BrowserBotDraft>} */
    const o = {};
    for (const [k, v] of memoryFallback) o[k] = v;
    return o;
  }
  const res = await storageGet([DRAFTS_STORAGE_KEY]);
  const raw = res[DRAFTS_STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, BrowserBotDraft>} */
  const out = {};
  for (const [id, d] of Object.entries(raw)) {
    const n = normalizeDraft(d);
    if (n && n.status !== 'purged') out[id] = n;
  }
  return out;
}

/**
 * @param {Record<string, BrowserBotDraft>} map
 */
async function saveAllMap(map) {
  // Cap count by updatedAt
  const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = entries.slice(0, MAX_DRAFTS);
  /** @type {Record<string, BrowserBotDraft>} */
  const next = {};
  for (const d of kept) next[d.draftId] = d;

  if (!storageAvailable()) {
    memoryFallback = new Map(Object.entries(next));
    return;
  }
  await storageSet({ [DRAFTS_STORAGE_KEY]: next });
}

/**
 * @param {Partial<BrowserBotDraft>} input
 * @returns {Promise<BrowserBotDraft>}
 */
export async function createDraft(input = {}) {
  const draft = normalizeDraft({
    ...input,
    draftId: input.draftId || generateDraftId(),
    version: 1,
    status: input.status || 'editing'
  });
  if (!draft) throw new Error('invalid draft');
  const map = await loadAllMap();
  map[draft.draftId] = draft;
  await saveAllMap(map);
  return draft;
}

/**
 * @param {string} draftId
 * @returns {Promise<BrowserBotDraft|null>}
 */
export async function loadDraft(draftId) {
  if (!draftId) return null;
  const map = await loadAllMap();
  return map[draftId] || null;
}

/**
 * @param {string} draftId
 * @param {Partial<BrowserBotDraft> & { blocks?: DraftBlock[], bumpVersion?: boolean }} patch
 * @returns {Promise<BrowserBotDraft|null>}
 */
export async function saveDraft(draftId, patch = {}) {
  const map = await loadAllMap();
  const prev = map[draftId];
  if (!prev) return null;
  const bump = patch.bumpVersion !== false;
  const merged = normalizeDraft({
    ...prev,
    ...patch,
    draftId,
    version: bump ? (prev.version || 1) + 1 : prev.version,
    createdAt: prev.createdAt,
    blocks: patch.blocks != null ? patch.blocks : prev.blocks
  });
  if (!merged) return null;
  map[draftId] = merged;
  await saveAllMap(map);
  return merged;
}

/**
 * @param {string} draftId
 * @returns {Promise<boolean>}
 */
export async function purgeDraft(draftId) {
  if (!draftId) return false;
  const map = await loadAllMap();
  if (!map[draftId]) return false;
  delete map[draftId];
  await saveAllMap(map);
  return true;
}

/**
 * @returns {Promise<BrowserBotDraft[]>}
 */
export async function listDrafts() {
  const map = await loadAllMap();
  return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Build draft blocks from selection-like items + optional table rows.
 * @param {{
 *   elements?: Array<{ text?: string, tag?: string, src?: string, href?: string, kind?: string }>,
 *   records?: Array<Record<string, string>>,
 *   columns?: string[],
 *   title?: string
 * }} opts
 * @returns {DraftBlock[]}
 */
export function blocksFromSelectionMaterial(opts = {}) {
  /** @type {DraftBlock[]} */
  const blocks = [];
  if (opts.title) {
    blocks.push({
      id: generateBlockId(),
      type: 'heading',
      text: String(opts.title).slice(0, 200)
    });
  }
  const els = Array.isArray(opts.elements) ? opts.elements : [];
  els.slice(0, 80).forEach((el, i) => {
    const kind = String(el.kind || '').toLowerCase();
    const tag = String(el.tag || '').toLowerCase();
    const text = String(el.text || '').trim();
    const src = el.src ? String(el.src) : '';
    if (kind === 'image' || tag === 'img' || src) {
      blocks.push({
        id: generateBlockId(),
        type: 'image',
        src: src || undefined,
        alt: text.slice(0, 200) || `image_${i + 1}`,
        href: el.href ? String(el.href) : undefined,
        sourceRef: `sel:${i}`
      });
      if (text) {
        blocks.push({
          id: generateBlockId(),
          type: 'paragraph',
          text: text.slice(0, 500),
          sourceRef: `sel:${i}:cap`
        });
      }
      return;
    }
    if (/^h[1-6]$/.test(tag) || (text && text.length < 80 && !text.includes('\n'))) {
      blocks.push({
        id: generateBlockId(),
        type: text.length < 80 ? 'heading' : 'paragraph',
        text: text || `(${tag || 'el'})`,
        href: el.href ? String(el.href) : undefined,
        sourceRef: `sel:${i}`
      });
      return;
    }
    if (text) {
      blocks.push({
        id: generateBlockId(),
        type: 'paragraph',
        text,
        href: el.href ? String(el.href) : undefined,
        sourceRef: `sel:${i}`
      });
    }
  });

  const records = Array.isArray(opts.records) ? opts.records : [];
  if (records.length) {
    const cols =
      Array.isArray(opts.columns) && opts.columns.length
        ? opts.columns.map(String)
        : Object.keys(records[0] || {});
    blocks.push({
      id: generateBlockId(),
      type: 'table',
      columns: cols,
      rows: records.map((r) => {
        /** @type {Record<string, string>} */
        const o = {};
        for (const c of cols) o[c] = String(r[c] ?? '');
        return o;
      })
    });
  }

  blocks.push({
    id: generateBlockId(),
    type: 'slot',
    slotType: 'append',
    text: '点击此处添加内容 / Click to insert'
  });
  return blocks;
}

/** Layout / multi-block content → must open draft preview (not chat code walls). */
export const PREVIEW_HTML_CHAR_THRESHOLD = 1200;
export const PREVIEW_MD_CHAR_THRESHOLD = 800;
export const PREVIEW_MULTI_HEADING_MIN = 2;
export const PREVIEW_MULTI_BLOCK_MIN = 3;
/** User-facing finish/summary cap after HTML strip. */
export const USER_FACING_HTML_STRIP_THRESHOLD = 600;

/**
 * Detect full / layout-hard HTML that must not be dumped into chat.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeFullHtmlDocument(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/<!DOCTYPE\s+html/i.test(s)) return true;
  if (/<html[\s>]/i.test(s) && /<\/html>/i.test(s)) return true;
  if (s.length >= PREVIEW_HTML_CHAR_THRESHOLD) {
    if (/<\/?(?:body|head|style|section|article|main|table|div)[\s>]/i.test(s)) return true;
    const tagCount = (s.match(/<\/?[a-zA-Z][^>]*>/g) || []).length;
    if (tagCount >= 12) return true;
  }
  return false;
}

/** Reasons that force HARD tier (host auto-open preview on materialize). */
const HARD_PREVIEW_REASONS = new Set([
  'forcePreview',
  'full_html_document',
  'large_layout_markup',
  'html_mime_or_name',
  'layout_format_hint',
  'media_or_table_blocks'
]);

/**
 * @param {string} reason
 * @returns {boolean}
 */
export function isHardPreviewReason(reason) {
  const r = String(reason || '');
  if (HARD_PREVIEW_REASONS.has(r)) return true;
  if (r.startsWith('template:')) {
    const t = r.slice('template:'.length);
    return (
      t === 'report' ||
      t === 'product_cards' ||
      t === 'title_image_pairs' ||
      t === 'slides' ||
      t === 'pptx'
    );
  }
  return false;
}

/**
 * Collect preview-need reasons (no tier). forcePreview short-circuits as sole hard signal
 * when no other content signals exist, but is still listed.
 * @param {{
 *   markdown?: string,
 *   html?: string,
 *   content?: string,
 *   text?: string,
 *   mime?: string,
 *   name?: string,
 *   template?: string,
 *   blocks?: Array<Partial<DraftBlock>|DraftBlock>,
 *   records?: unknown[],
 *   forcePreview?: boolean
 * }} input
 * @returns {string[]}
 */
export function collectPreviewReasons(input = {}) {
  /** @type {string[]} */
  const reasons = [];
  if (input?.forcePreview) {
    reasons.push('forcePreview');
  }
  const template = String(input?.template || '').toLowerCase();
  if (
    template === 'report' ||
    template === 'product_cards' ||
    template === 'title_image_pairs' ||
    template === 'slides' ||
    template === 'pptx'
  ) {
    reasons.push(`template:${template || 'layout'}`);
  }

  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];
  const contentBlocks = blocks.filter((b) => b && b.type !== 'slot');
  if (contentBlocks.length >= PREVIEW_MULTI_BLOCK_MIN) {
    reasons.push(`blocks:${contentBlocks.length}`);
  }
  if (contentBlocks.some((b) => b.type === 'image' || b.type === 'table')) {
    reasons.push('media_or_table_blocks');
  }

  const records = Array.isArray(input?.records) ? input.records : [];
  if (records.length >= 3) reasons.push(`records:${records.length}`);

  const mime = String(input?.mime || '').toLowerCase();
  const name = String(input?.name || '').toLowerCase();
  if (mime.includes('html') || /\.html?$/i.test(name)) {
    reasons.push('html_mime_or_name');
  }
  if (/\.(pptx?|pdf)$/i.test(name) || mime.includes('presentation')) {
    reasons.push('layout_format_hint');
  }

  const text = String(
    input?.html || input?.markdown || input?.content || input?.text || ''
  );
  if (looksLikeFullHtmlDocument(text)) {
    reasons.push('full_html_document');
  } else if (text.length >= PREVIEW_HTML_CHAR_THRESHOLD) {
    if (/<\/?(?:div|section|article|table|style|h[1-6]|img)[\s>]/i.test(text)) {
      reasons.push('large_layout_markup');
    }
  }
  if (text) {
    const headings = (text.match(/^#{1,6}\s.+/gm) || []).length;
    // Multi-heading docs need preview even when under the long-form char threshold
    if (headings >= PREVIEW_MULTI_HEADING_MIN && text.length >= 200) {
      reasons.push(`md_headings:${headings}`);
    } else if (
      text.length >= PREVIEW_MD_CHAR_THRESHOLD &&
      headings >= PREVIEW_MULTI_HEADING_MIN
    ) {
      reasons.push(`md_headings:${headings}`);
    }
    // multi-section report-ish plain/md
    const sections = (text.match(/\n#{1,3}\s|\n---+\n/g) || []).length;
    if (sections >= 2 && text.length >= Math.min(PREVIEW_MD_CHAR_THRESHOLD, 400)) {
      reasons.push('multi_section');
    }
  }

  return reasons;
}

/**
 * Classify draft-preview need into product tiers.
 * - hard: host auto-opens preview on materialize (layout / full HTML / media packs)
 * - default: persist draft; do NOT auto-open — agent may open_draft_preview or ask user
 * - chat: short deliverable; preview not recommended
 *
 * @param {{
 *   markdown?: string,
 *   html?: string,
 *   content?: string,
 *   text?: string,
 *   mime?: string,
 *   name?: string,
 *   template?: string,
 *   blocks?: Array<Partial<DraftBlock>|DraftBlock>,
 *   records?: unknown[],
 *   forcePreview?: boolean
 * }} input
 * @returns {{
 *   tier: 'hard'|'default'|'chat',
 *   needed: boolean,
 *   previewRecommended: boolean,
 *   autoOpen: boolean,
 *   reasons: string[]
 * }}
 */
export function classifyPreviewNeed(input = {}) {
  const reasons = collectPreviewReasons(input);
  if (!reasons.length) {
    return {
      tier: 'chat',
      needed: false,
      previewRecommended: false,
      autoOpen: false,
      reasons: []
    };
  }
  const hard = reasons.some((r) => isHardPreviewReason(r));
  if (hard) {
    return {
      tier: 'hard',
      needed: true,
      previewRecommended: true,
      autoOpen: true,
      reasons
    };
  }
  return {
    tier: 'default',
    needed: true,
    previewRecommended: true,
    autoOpen: false,
    reasons
  };
}

/**
 * Heuristic: authored content / task payload benefits from draft preview refine.
 * Thin wrapper over classifyPreviewNeed for backward compatibility.
 * @param {{
 *   markdown?: string,
 *   html?: string,
 *   content?: string,
 *   text?: string,
 *   mime?: string,
 *   name?: string,
 *   template?: string,
 *   blocks?: Array<Partial<DraftBlock>|DraftBlock>,
 *   records?: unknown[],
 *   forcePreview?: boolean
 * }} input
 * @returns {{
 *   needed: boolean,
 *   reasons: string[],
 *   tier: 'hard'|'default'|'chat',
 *   previewRecommended: boolean,
 *   autoOpen: boolean
 * }}
 */
export function contentNeedsDraftPreview(input = {}) {
  const c = classifyPreviewNeed(input);
  return {
    needed: c.needed,
    reasons: c.reasons,
    tier: c.tier,
    previewRecommended: c.previewRecommended,
    autoOpen: c.autoOpen
  };
}

/**
 * Strip oversized HTML / full documents from user-visible text (finish summary).
 * @param {string} text
 * @returns {{ text: string, stripped: boolean, extractedHtml?: string }}
 */
export function stripOversizedHtmlFromUserFacing(text) {
  const s = String(text || '');
  if (!s) return { text: s, stripped: false };

  // Fenced html / full document
  const fenceRe = /```(?:html|htm)?\s*([\s\S]*?)```/gi;
  let stripped = false;
  /** @type {string|undefined} */
  let extractedHtml;
  let out = s.replace(fenceRe, (full, body) => {
    const bodyStr = String(body || '');
    if (looksLikeFullHtmlDocument(bodyStr) || bodyStr.length >= USER_FACING_HTML_STRIP_THRESHOLD) {
      stripped = true;
      if (!extractedHtml || bodyStr.length > extractedHtml.length) extractedHtml = bodyStr;
      return '\n[HTML 文档已转入草稿预览，未在对话中完整展示 / HTML moved to draft preview]\n';
    }
    return full;
  });

  if (looksLikeFullHtmlDocument(out) || (out.length >= PREVIEW_HTML_CHAR_THRESHOLD && /<html[\s>]/i.test(out))) {
    stripped = true;
    extractedHtml = extractedHtml || out;
    out =
      '已生成可预览文档（完整 HTML 未粘贴到对话）。请在预览标签页微调后选择导出格式。\n' +
      'Document ready in draft preview — full HTML not dumped into chat. Open preview to refine, then export.';
  } else if (out.length > 4000 && /<\/?[a-zA-Z][^>]*>/.test(out) && (out.match(/</g) || []).length > 20) {
    stripped = true;
    extractedHtml = extractedHtml || out;
    out =
      out.slice(0, 280).replace(/<[^>]+>/g, ' ').trim() +
      '\n…\n[长 HTML/布局内容已省略 — 请使用草稿预览 / layout content omitted — use draft preview]';
  }

  return { text: out, stripped, extractedHtml };
}

/**
 * Decode minimal HTML entities.
 * @param {string} s
 */
function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

/**
 * Strip tags for plain text.
 * @param {string} html
 */
function stripTags(html) {
  return decodeBasicEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build draft blocks from simple markdown (headings, paragraphs, images, hr, pipe tables).
 * @param {string} md
 * @param {{ title?: string, ensureSlot?: boolean }} [opts]
 * @returns {DraftBlock[]}
 */
export function blocksFromMarkdown(md, opts = {}) {
  /** @type {DraftBlock[]} */
  const blocks = [];
  const raw = String(md || '').replace(/\r\n/g, '\n');
  if (opts.title) {
    blocks.push({
      id: generateBlockId(),
      type: 'heading',
      text: String(opts.title).slice(0, 200)
    });
  }
  if (!raw.trim()) {
    if (opts.ensureSlot !== false) {
      blocks.push({
        id: generateBlockId(),
        type: 'slot',
        slotType: 'append',
        text: '点击此处添加内容 / Click to insert'
      });
    }
    return blocks;
  }

  const lines = raw.split('\n');
  /** @type {string[]} */
  let paraBuf = [];
  /** @type {string[]} */
  let tableBuf = [];

  const flushPara = () => {
    const t = paraBuf.join('\n').trim();
    paraBuf = [];
    if (!t) return;
    // image-only line(s)
    const imgOnly = t.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgOnly) {
      blocks.push({
        id: generateBlockId(),
        type: 'image',
        alt: imgOnly[1].slice(0, 200) || 'image',
        src: imgOnly[2].slice(0, 2000)
      });
      return;
    }
    blocks.push({
      id: generateBlockId(),
      type: 'paragraph',
      text: t.slice(0, 8000)
    });
  };

  const flushTable = () => {
    if (tableBuf.length < 2) {
      paraBuf.push(...tableBuf);
      tableBuf = [];
      return;
    }
    const splitRow = (line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
    const header = splitRow(tableBuf[0]);
    const sep = tableBuf[1];
    if (!/^\|?[\s:-]+\|/.test(sep) && !/^[\s|:-]+$/.test(sep)) {
      paraBuf.push(...tableBuf);
      tableBuf = [];
      return;
    }
    const rows = tableBuf.slice(2).map((line) => {
      const cells = splitRow(line);
      /** @type {Record<string, string>} */
      const o = {};
      header.forEach((h, i) => {
        o[h || `col${i + 1}`] = cells[i] || '';
      });
      return o;
    });
    blocks.push({
      id: generateBlockId(),
      type: 'table',
      columns: header.map((h, i) => h || `col${i + 1}`),
      rows
    });
    tableBuf = [];
  };

  for (const line of lines) {
    if (/^\s*\|/.test(line) && line.includes('|')) {
      if (paraBuf.length) flushPara();
      tableBuf.push(line);
      continue;
    }
    if (tableBuf.length) flushTable();

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushPara();
      blocks.push({
        id: generateBlockId(),
        type: 'heading',
        text: h[2].trim().slice(0, 500)
      });
      continue;
    }
    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      flushPara();
      blocks.push({ id: generateBlockId(), type: 'divider' });
      continue;
    }
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      flushPara();
      blocks.push({
        id: generateBlockId(),
        type: 'image',
        alt: img[1].slice(0, 200) || 'image',
        src: img[2].slice(0, 2000)
      });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    paraBuf.push(line);
  }
  if (tableBuf.length) flushTable();
  flushPara();

  if (opts.ensureSlot !== false) {
    blocks.push({
      id: generateBlockId(),
      type: 'slot',
      slotType: 'append',
      text: '点击此处添加内容 / Click to insert'
    });
  }
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * Build draft blocks from HTML-ish markup (no DOM; regex best-effort).
 * @param {string} html
 * @param {{ title?: string, ensureSlot?: boolean }} [opts]
 * @returns {DraftBlock[]}
 */
export function blocksFromHtml(html, opts = {}) {
  /** @type {DraftBlock[]} */
  const blocks = [];
  if (opts.title) {
    blocks.push({
      id: generateBlockId(),
      type: 'heading',
      text: String(opts.title).slice(0, 200)
    });
  }
  let s = String(html || '');
  // drop scripts/styles
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Prefer body content
  const bodyM = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyM) s = bodyM[1];

  // Tables first (extract and replace with placeholders)
  /** @type {DraftBlock[]} */
  const deferred = [];
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rowsHtml = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    if (!rowsHtml.length) return ' ';
    const parseCells = (tr, tag) =>
      [...tr.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) =>
        stripTags(m[1]).slice(0, 2000)
      );
    let columns = parseCells(rowsHtml[0], 'th');
    let dataRows = rowsHtml.slice(columns.length ? 1 : 0);
    if (!columns.length) {
      columns = parseCells(rowsHtml[0], 'td');
      dataRows = rowsHtml.slice(1);
    }
    if (!columns.length) return ' ';
    columns = columns.map((c, i) => c || `col${i + 1}`);
    const rows = dataRows.map((tr) => {
      const cells = parseCells(tr, 'td');
      /** @type {Record<string, string>} */
      const o = {};
      columns.forEach((c, i) => {
        o[c] = cells[i] || '';
      });
      return o;
    });
    const id = generateBlockId();
    deferred.push({ id, type: 'table', columns, rows });
    return `\n%%PW_BLOCK_${id}%%\n`;
  });

  // Block-level tags
  const re =
    /<(h[1-6]|p|div|section|article|li|blockquote|hr|img)(\s[^>]*)?>([\s\S]*?)<\/\1>|<img\s([^>]*?)\/?>|<(hr)\s*\/?>/gi;
  let last = 0;
  let m;
  const pushTextChunk = (chunk) => {
    const t = stripTags(chunk);
    if (!t) return;
    // placeholder for deferred table
    const ph = t.match(/^%%PW_BLOCK_([a-z0-9_]+)%%$/i);
    if (ph) {
      const blk = deferred.find((b) => b.id === ph[1]);
      if (blk) blocks.push(blk);
      return;
    }
    if (t.includes('%%PW_BLOCK_')) {
      const parts = t.split(/(%%PW_BLOCK_[a-z0-9_]+%%)/i);
      for (const part of parts) {
        const p = part.match(/^%%PW_BLOCK_([a-z0-9_]+)%%$/i);
        if (p) {
          const blk = deferred.find((b) => b.id === p[1]);
          if (blk) blocks.push(blk);
        } else if (part.trim()) {
          blocks.push({
            id: generateBlockId(),
            type: 'paragraph',
            text: part.trim().slice(0, 8000)
          });
        }
      }
      return;
    }
    blocks.push({
      id: generateBlockId(),
      type: 'paragraph',
      text: t.slice(0, 8000)
    });
  };

  while ((m = re.exec(s)) !== null) {
    if (m.index > last) pushTextChunk(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[5] === 'hr' || m[1] === 'hr') {
      blocks.push({ id: generateBlockId(), type: 'divider' });
      continue;
    }
    // self-closing img
    const imgAttrs = m[4];
    if (imgAttrs != null || (m[1] && m[1].toLowerCase() === 'img')) {
      const attrs = imgAttrs || m[2] || '';
      const srcM = String(attrs).match(/\bsrc=["']([^"']+)["']/i);
      const altM = String(attrs).match(/\balt=["']([^"']*)["']/i);
      if (srcM) {
        blocks.push({
          id: generateBlockId(),
          type: 'image',
          src: srcM[1].slice(0, 2000),
          alt: (altM?.[1] || 'image').slice(0, 200)
        });
      }
      continue;
    }
    const tag = String(m[1] || '').toLowerCase();
    const inner = m[3] || '';
    if (/^h[1-6]$/.test(tag)) {
      const t = stripTags(inner);
      if (t) {
        blocks.push({
          id: generateBlockId(),
          type: 'heading',
          text: t.slice(0, 500)
        });
      }
      continue;
    }
    // nested img in block
    const innerImg = inner.match(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/i);
    if (innerImg) {
      const altM = inner.match(/\balt=["']([^"']*)["']/i);
      blocks.push({
        id: generateBlockId(),
        type: 'image',
        src: innerImg[1].slice(0, 2000),
        alt: (altM?.[1] || stripTags(inner) || 'image').slice(0, 200)
      });
      const rest = stripTags(inner.replace(/<img[\s\S]*?>/gi, ' '));
      if (rest) {
        blocks.push({
          id: generateBlockId(),
          type: 'paragraph',
          text: rest.slice(0, 8000)
        });
      }
      continue;
    }
    const t = stripTags(inner);
    if (t) {
      blocks.push({
        id: generateBlockId(),
        type: 'paragraph',
        text: t.slice(0, 8000)
      });
    }
  }
  if (last < s.length) pushTextChunk(s.slice(last));

  // Any deferred tables not yet pushed
  for (const blk of deferred) {
    if (!blocks.some((b) => b.id === blk.id)) blocks.push(blk);
  }

  if (!blocks.filter((b) => b.type !== 'slot').length) {
    const plain = stripTags(s);
    if (plain) {
      // split into paragraphs by blank-ish
      plain.split(/\n{2,}/).forEach((p) => {
        const t = p.trim();
        if (t) {
          blocks.push({
            id: generateBlockId(),
            type: 'paragraph',
            text: t.slice(0, 8000)
          });
        }
      });
    }
  }

  if (opts.ensureSlot !== false) {
    blocks.push({
      id: generateBlockId(),
      type: 'slot',
      slotType: 'append',
      text: '点击此处添加内容 / Click to insert'
    });
  }
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * Normalize agent-authored material into draft blocks.
 * Priority: blocks[] → html → markdown → content (auto) → selection material fields.
 * @param {{
 *   blocks?: Array<Partial<DraftBlock>>,
 *   html?: string,
 *   markdown?: string,
 *   content?: string,
 *   title?: string,
 *   elements?: Array<{ text?: string, tag?: string, src?: string, href?: string, kind?: string }>,
 *   records?: Array<Record<string, string>>,
 *   columns?: string[]
 * }} opts
 * @returns {DraftBlock[]}
 */
export function blocksFromAuthoredContent(opts = {}) {
  if (Array.isArray(opts.blocks) && opts.blocks.length) {
    const normalized = opts.blocks.map(normalizeBlock).filter(Boolean);
    if (normalized.length) {
      const hasSlot = normalized.some((b) => b.type === 'slot');
      if (!hasSlot) {
        normalized.push({
          id: generateBlockId(),
          type: 'slot',
          slotType: 'append',
          text: '点击此处添加内容 / Click to insert'
        });
      }
      return normalized.slice(0, MAX_BLOCKS);
    }
  }
  if (opts.html && String(opts.html).trim()) {
    return blocksFromHtml(String(opts.html), { title: opts.title });
  }
  if (opts.markdown && String(opts.markdown).trim()) {
    return blocksFromMarkdown(String(opts.markdown), { title: opts.title });
  }
  if (opts.content && String(opts.content).trim()) {
    const c = String(opts.content);
    if (looksLikeFullHtmlDocument(c) || /<\/[a-z]+>/i.test(c)) {
      return blocksFromHtml(c, { title: opts.title });
    }
    return blocksFromMarkdown(c, { title: opts.title });
  }
  return blocksFromSelectionMaterial({
    elements: opts.elements,
    records: opts.records,
    columns: opts.columns,
    title: opts.title
  });
}

/**
 * Apply structural ops to blocks (deterministic revise without LLM).
 * @param {DraftBlock[]} blocks
 * @param {Array<{
 *   op: 'remove'|'insert'|'replace_text'|'set_field'|'move',
 *   blockId?: string,
 *   afterId?: string,
 *   beforeId?: string,
 *   block?: Partial<DraftBlock>,
 *   text?: string,
 *   field?: string,
 *   value?: string
 * }>} ops
 * @returns {DraftBlock[]}
 */
export function applyDraftOps(blocks, ops) {
  let list = (Array.isArray(blocks) ? blocks : []).map((b) => ({ ...b }));
  const opsList = Array.isArray(ops) ? ops : [];
  for (const op of opsList) {
    if (!op || typeof op !== 'object') continue;
    const kind = String(op.op || '');
    if (kind === 'remove' && op.blockId) {
      list = list.filter((b) => b.id !== op.blockId);
      continue;
    }
    if (kind === 'replace_text' && op.blockId && op.text != null) {
      list = list.map((b) =>
        b.id === op.blockId ? { ...b, text: String(op.text).slice(0, 8000) } : b
      );
      continue;
    }
    if (kind === 'set_field' && op.blockId && op.field) {
      list = list.map((b) => {
        if (b.id !== op.blockId) return b;
        const fields = { ...(b.fields || {}) };
        fields[String(op.field)] = String(op.value ?? '');
        return { ...b, fields };
      });
      continue;
    }
    if (kind === 'insert' && op.block) {
      const nb = normalizeBlock(op.block);
      if (!nb) continue;
      let idx = list.length;
      if (op.afterId) {
        const i = list.findIndex((b) => b.id === op.afterId);
        if (i >= 0) idx = i + 1;
      } else if (op.beforeId) {
        const i = list.findIndex((b) => b.id === op.beforeId);
        if (i >= 0) idx = i;
      }
      // Insert before trailing slot if appending
      if (!op.afterId && !op.beforeId) {
        const slotIdx = list.map((b) => b.type).lastIndexOf('slot');
        if (slotIdx >= 0) idx = slotIdx;
      }
      list.splice(idx, 0, nb);
      continue;
    }
    if (kind === 'move' && op.blockId && (op.afterId || op.beforeId)) {
      const i = list.findIndex((b) => b.id === op.blockId);
      if (i < 0) continue;
      const [item] = list.splice(i, 1);
      let idx = list.length;
      if (op.afterId) {
        const j = list.findIndex((b) => b.id === op.afterId);
        if (j >= 0) idx = j + 1;
      } else if (op.beforeId) {
        const j = list.findIndex((b) => b.id === op.beforeId);
        if (j >= 0) idx = j;
      }
      list.splice(idx, 0, item);
    }
  }
  // Keep one trailing slot
  const nonSlots = list.filter((b) => b.type !== 'slot');
  nonSlots.push({
    id: generateBlockId(),
    type: 'slot',
    slotType: 'append',
    text: '点击此处添加内容 / Click to insert'
  });
  return nonSlots.slice(0, MAX_BLOCKS);
}

/** Test-only: clear memory fallback */
export function _resetDraftStoreForTests() {
  memoryFallback = new Map();
}
