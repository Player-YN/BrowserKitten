/**
 * Selection pierce + Context snap.
 * User-facing harvest types — not DOM containers.
 * DOM helpers take a live Element; descriptor classify is DOM-free for tests.
 */

export const CONTEXT_KINDS = ['image', 'screenshot', 'text', 'table', 'video', 'link', 'vector'];

const OVERLAY_NAME_RE =
  /overlay|backdrop|mask|shade|dimmer|scrim|loading|spinner|play-btn|playbutton|vjs-|ytp-gradient|ytp-pause|bpx-player-gap|xgmask|xgcover/i;

const STRONG_KINDS = new Set(['video', 'image', 'table', 'vector', 'link']);

export function srcLooksVideo(src) {
  const s = String(src || '');
  if (!s) return false;
  if (/^data:video\//i.test(s)) return true;
  if (/\.(mp4|webm|ogv|m4v|mov|m3u8|mpd)(\?|#|$)/i.test(s)) return true;
  if (/(youtube\.com|youtu\.be|vimeo\.com|bilibili\.com|tiktok\.com)\/.+/i.test(s)) return true;
  return false;
}

export function srcLooksAudio(src) {
  const s = String(src || '');
  if (!s) return false;
  if (/^data:audio\//i.test(s)) return true;
  return /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i.test(s);
}

export function srcLooksImage(src) {
  const s = String(src || '');
  if (!s) return false;
  if (srcLooksVideo(s) || srcLooksAudio(s)) return false;
  if (/^data:image\//i.test(s)) return true;
  if (/\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(s)) return true;
  // Twitter/X CDN: /media/ID?format=jpg — no file extension
  if (/[?&]format=(jpe?g|png|gif|webp|avif|bmp)\b/i.test(s)) return true;
  if (/(?:^https?:\/\/)?(?:[\w-]+\.)?pbs\.twimg\.com\/(?:media|profile_images|ext_tw_video_thumb|semantic_core_img)\//i.test(s)) {
    return true;
  }
  return false;
}

export function hrefLooksResource(href) {
  const h = String(href || '').trim();
  if (!h || h === '#' || /^javascript:/i.test(h)) return false;
  return /^(https?:|blob:|data:|file:|\/)/i.test(h);
}

export function hrefLooksDownloadable(href) {
  const h = String(href || '').trim();
  if (!hrefLooksResource(h)) return false;
  return /\.(pdf|zip|rar|7z|gz|tgz|xlsx?|docx?|pptx?|csv|json|xml|txt|md|rtf|epub)(\?|#|$)/i.test(h);
}

export function csvCell(value) {
  const t = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

export function matrixToCsv(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? row : [row]).map(csvCell).join(','))
    .join('\n');
}

/** MV3 structured-clone / IDB of an unbounded string can OOM the service worker; 8MiB is past any article. */
export const CLIPBOARD_TEXT_HOST_MAX = 8 * 1024 * 1024;

export function clipClipboardText(value) {
  const text = String(value ?? '');
  if (text.length <= CLIPBOARD_TEXT_HOST_MAX) return text;
  return text.slice(0, CLIPBOARD_TEXT_HOST_MAX);
}

/**
 * Live-page text clicks go to the Clipboard group, not the capture Group.
 * Explicit non-text kinds (image / table / container / screenshot / page / …) stay as Group items.
 */
export function isClipboardTextPick(desc = {}, opts = {}) {
  const hint = String(desc.kindHint || desc.kind || desc.labelKind || '')
    .toLowerCase()
    .trim();
  if (hint && hint !== 'text' && hint !== 'txt' && hint !== '文字' && hint !== '文本') return false;
  return classifyContextKind(desc, opts) === 'text';
}

/**
 * @param {{
 *   tag?: string,
 *   src?: string,
 *   href?: string,
 *   role?: string,
 *   text?: string,
 *   kindHint?: string,
 *   source?: string
 * }} desc
 */
export function classifyContextKind(desc = {}, opts = {}) {
  const sourceHint = String(opts.source || desc.source || '').toLowerCase();
  const hint = String(desc.kindHint || desc.kind || '').toLowerCase();
  if (hint === 'screenshot' || sourceHint === 'screenshot') return 'screenshot';
  if (hint === 'page' || hint === 'webpage') return 'page';
  if (hint === 'video' || hint === 'audio') return 'video';
  if (hint === 'vector' || hint === 'svg') return 'vector';
  if (hint === 'link' || hint === 'file' || hint === 'url') return 'link';
  if (hint === 'table') return 'table';
  if (hint === 'container' || hint === 'card' || hint === 'button') return 'container';
  if (hint === 'image' || hint === 'img' || hint === 'picture') {
    if (srcLooksVideo(desc.src) || srcLooksAudio(desc.src)) return 'video';
    return 'image';
  }
  if (hint === 'text') return 'text';

  const tag = String(desc.tag || desc.tagName || '')
    .toLowerCase()
    .replace(/[<>]/g, '');
  const src = String(desc.src || desc.preview?.src || '');
  const href = String(desc.href || '');
  const role = String(desc.role || '').toLowerCase();

  if (tag === 'video' || tag === 'audio' || srcLooksVideo(src) || srcLooksAudio(src)) return 'video';
  if (tag === 'svg') return 'vector';
  if (tag === 'img' || tag === 'picture') return srcLooksVideo(src) ? 'video' : 'image';
  if (srcLooksImage(src)) return tag === 'svg' || /\.svg(\?|#|$)/i.test(src) ? 'vector' : 'image';
  if (['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'].includes(tag)) return 'table';
  if (tag === 'a' && hrefLooksResource(href)) return 'link';
  if (role === 'link' && hrefLooksResource(href)) return 'link';
  const text = String(desc.text || desc.preview?.textSnippet || '').trim();
  if (text) return 'text';
  if (hrefLooksResource(href)) return 'link';
  return 'text';
}

export function isPierceSkipDescriptor(d = {}) {
  const tag = String(d.tag || '').toLowerCase();
  if (tag === 'html' || tag === 'body') return true;
  if (d.hostUi) return true;
  if (d.pointerEvents === 'none') return true;
  if (d.opacity === 0 || d.visibility === 'hidden') return true;
  const name = `${d.id || ''} ${d.className || ''}`;
  if (OVERLAY_NAME_RE.test(name)) return true;
  if (d.coversViewport && !d.hasMediaChild && (d.ownTextLen || 0) < 24) return true;
  if (d.tinyChrome && OVERLAY_NAME_RE.test(name)) return true;
  return false;
}

function tagOf(el) {
  return String(el?.tagName || '').toLowerCase();
}

function isHostUi(el) {
  if (!el || el.nodeType !== 1) return true;
  const cls = el.classList;
  if (cls?.contains('browserbot-exit-float-btn') || cls?.contains('browserbot-element-badge')) return true;
  if (cls?.contains('browserbot-link-opt-bubble')) return true;
  if (el.id === 'browserbot-region-root' || el.id === 'browserbot-confirm-bar') return true;
  if (el.closest?.('.browserbot-toast-container, .browserbot-exit-float-btn, .browserbot-link-opt-bubble, #browserbot-confirm-bar, #browserbot-region-root')) {
    return true;
  }
  return false;
}

function descriptorFromElement(el) {
  if (!el || el.nodeType !== 1) {
    return { tag: '', hostUi: true };
  }
  const win = el.ownerDocument?.defaultView;
  let pointerEvents = '';
  let opacity = 1;
  let visibility = '';
  let position = '';
  try {
    const st = win?.getComputedStyle?.(el);
    if (st) {
      pointerEvents = st.pointerEvents || '';
      opacity = Number.parseFloat(st.opacity);
      if (!Number.isFinite(opacity)) opacity = 1;
      visibility = st.visibility || '';
      position = st.position || '';
    }
  } catch {
    /* ignore */
  }
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { width: 0, height: 0 };
  const docEl = el.ownerDocument?.documentElement;
  const vw = docEl?.clientWidth || 0;
  const vh = docEl?.clientHeight || 0;
  const coversViewport = vw > 0 && vh > 0 && rect.width >= vw * 0.8 && rect.height >= vh * 0.35;
  const ownText = String(el.innerText || el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  let hasMediaChild = false;
  try {
    hasMediaChild = !!el.querySelector?.('img, picture, video, audio, svg, table, a[href]');
  } catch {
    hasMediaChild = false;
  }
  const tinyChrome =
    (position === 'absolute' || position === 'fixed') &&
    rect.width > 0 &&
    rect.width <= 140 &&
    rect.height <= 140 &&
    ownText.length < 8;
  return {
    tag: tagOf(el),
    id: el.id || '',
    className: typeof el.className === 'string' ? el.className : String(el.className || ''),
    pointerEvents,
    opacity,
    visibility,
    coversViewport,
    hasMediaChild,
    ownTextLen: ownText.length,
    tinyChrome,
    hostUi: isHostUi(el)
  };
}

export function isPierceSkipElement(el) {
  return isPierceSkipDescriptor(descriptorFromElement(el));
}

function srcOf(el) {
  if (!el) return '';
  const direct = String(el.currentSrc || el.src || el.getAttribute?.('src') || '');
  if (direct) return direct;
  return String(pickBestSrcsetUrl(el.getAttribute?.('srcset') || '') || '');
}

function hrefOf(el) {
  if (!el) return '';
  return String(el.href || el.getAttribute?.('href') || '');
}

function kindFromElement(el) {
  if (!el || el.nodeType !== 1) return 'text';
  return classifyContextKind({
    tag: tagOf(el),
    src: srcOf(el),
    href: hrefOf(el),
    role: el.getAttribute?.('role') || '',
    text: String(el.innerText || el.textContent || '').trim().slice(0, 500)
  });
}

function promoteTable(el) {
  const table = el.closest?.('table');
  return table || el;
}

function promoteForKind(el, kind) {
  if (kind === 'table') return promoteTable(el);
  if (kind === 'link') {
    const inner = uniquePrimaryMedia(el);
    if (inner && ['img', 'picture', 'video', 'audio', 'svg'].includes(tagOf(inner))) return inner;
  }
  if (kind === 'image' && tagOf(el) !== 'img') {
    const img = el.tagName?.toLowerCase() === 'picture' ? el.querySelector?.('img') : null;
    if (img) return img;
  }
  return el;
}

const MEDIA_SEL = 'img, picture, video, audio, svg, table, a[href]';

function uniquePrimaryMedia(el) {
  if (!el?.querySelectorAll) return null;
  let nodes = [];
  try {
    nodes = [...el.querySelectorAll('img, picture, video, audio, svg, table')];
  } catch {
    return null;
  }
  const visible = nodes.filter((n) => n !== el);
  if (visible.length === 1) return visible[0];
  return null;
}

function nodeRect(el) {
  try {
    return el.getBoundingClientRect?.() || null;
  } catch {
    return null;
  }
}

function nodeContainsPoint(el, x, y) {
  const r = nodeRect(el);
  if (!r || r.width <= 0 || r.height <= 0) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function nodeArea(el) {
  const r = nodeRect(el);
  return r ? r.width * r.height : 0;
}

/** Smallest node whose box contains (x, y). */
export function pickNodeAtPoint(nodes, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best = null;
  let bestArea = Infinity;
  for (const el of nodes || []) {
    if (!nodeContainsPoint(el, x, y)) continue;
    const area = nodeArea(el);
    if (area < bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Media under the pointer. Prefer poster <img> over a recycled <video>
 * (YouTube-style singleton player) so each tile is a distinct selection.
 */
export function pickPreferredMediaAtPoint(nodes, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hits = [...(nodes || [])].filter((el) => nodeContainsPoint(el, x, y));
  if (!hits.length) return null;
  const posters = hits.filter((el) => {
    const t = String(el.tagName || '').toLowerCase();
    return t === 'img' || t === 'picture';
  });
  const pool = posters.length ? posters : hits;
  pool.sort((a, b) => nodeArea(a) - nodeArea(b));
  return pool[0];
}

/** Default: jpeg/png/webp over avif (下图). `{ preferAvif: true }` for cover harvest. */
export function pickBestSrcsetUrl(srcset, opts = {}) {
  const entries = [];
  for (const part of String(srcset || '').split(',')) {
    const bits = part.trim().split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    const wMatch = /(\d+)w/i.exec(bits[1] || '');
    const w = wMatch ? Number(wMatch[1]) : 0;
    const ext = (/\.([a-z0-9]+)(?:\?|#|$)/i.exec(url) || [])[1] || '';
    entries.push({ url, w, ext: ext.toLowerCase() });
  }
  if (!entries.length) return null;
  if (opts.preferAvif) {
    const avif = entries.filter((e) => e.ext === 'avif');
    const pool = avif.length ? avif : entries;
    pool.sort((a, b) => b.w - a.w);
    return pool[0].url;
  }
  const raster = entries.filter((e) => /^(jpe?g|png|webp|gif)$/.test(e.ext));
  const rest = entries.filter((e) => e.ext !== 'avif');
  const pool = raster.length ? raster : rest.length ? rest : entries;
  pool.sort((a, b) => b.w - a.w);
  return pool[0].url;
}

function mediaUnderPoint(el, x, y) {
  if (!el?.querySelectorAll) return null;
  let nodes = [];
  try {
    nodes = [...el.querySelectorAll(MEDIA_SEL)];
  } catch {
    return null;
  }
  return pickPreferredMediaAtPoint(nodes.filter((n) => n !== el), x, y);
}

export function snapFromElement(el, x, y) {
  if (!el || el.nodeType !== 1) return null;
  const selfKind = kindFromElement(el);
  if (STRONG_KINDS.has(selfKind) && tagOf(el) !== 'html' && tagOf(el) !== 'body') {
    const node = promoteForKind(el, selfKind);
    return { element: node, kind: kindFromElement(node) };
  }
  const atPoint = mediaUnderPoint(el, x, y);
  if (atPoint) {
    const k = kindFromElement(atPoint);
    const node = promoteForKind(atPoint, k);
    return { element: node, kind: kindFromElement(node) };
  }
  const primary = uniquePrimaryMedia(el);
  if (primary) {
    const k = kindFromElement(primary);
    if (STRONG_KINDS.has(k)) {
      const node = promoteForKind(primary, k);
      return { element: node, kind: kindFromElement(node) };
    }
  }
  if (tagOf(el) === 'html' || tagOf(el) === 'body') return null;
  return { element: el, kind: selfKind === 'text' ? 'text' : kindFromElement(el) };
}

export function collectHitStack(doc, x, y) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.elementsFromPoint !== 'function') return [];
  /** @type {Element[]} */
  const stack = [];
  const seen = new Set();
  const pushList = (list) => {
    for (const el of list || []) {
      if (!el || el.nodeType !== 1 || seen.has(el)) continue;
      seen.add(el);
      stack.push(el);
      const shadow = el.shadowRoot;
      if (shadow && typeof shadow.elementsFromPoint === 'function') {
        try {
          pushList(shadow.elementsFromPoint(x, y));
        } catch {
          /* closed or unsupported */
        }
      }
    }
  };
  try {
    pushList(root.elementsFromPoint(x, y));
  } catch {
    const top = root.elementFromPoint?.(x, y);
    if (top) stack.push(top);
  }
  return stack;
}

function asStrongSnap(el) {
  if (!el || tagOf(el) === 'html' || tagOf(el) === 'body') return null;
  const kind = kindFromElement(el);
  if (!STRONG_KINDS.has(kind)) return null;
  const node = promoteForKind(el, kind);
  return { element: node, kind: kindFromElement(node) };
}

function documentMediaAtPoint(doc, x, y) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root?.querySelectorAll) return null;
  let nodes = [];
  try {
    nodes = [...root.querySelectorAll('video, audio, img, picture, svg, table')];
  } catch {
    return null;
  }
  return pickPreferredMediaAtPoint(nodes, x, y);
}

/**
 * @param {Document} doc
 * @param {number} x
 * @param {number} y
 * @returns {{ element: Element, kind: string } | null}
 */
export function pierceAndSnap(doc, x, y) {
  const stack = collectHitStack(doc, x, y);
  const strongOnStack = [];
  for (const el of stack) {
    if (isHostUi(el) || isPierceSkipElement(el)) continue;
    const snap = asStrongSnap(el);
    if (snap) strongOnStack.push(snap.element);
  }
  const stackHit = pickPreferredMediaAtPoint(strongOnStack, x, y) || strongOnStack[0];
  if (stackHit) return asStrongSnap(stackHit);

  for (const el of stack) {
    if (isHostUi(el) || isPierceSkipElement(el)) continue;
    const snapped = snapFromElement(el, x, y);
    if (snapped?.element && STRONG_KINDS.has(snapped.kind)) return snapped;
  }
  for (const el of stack) {
    if (isHostUi(el)) continue;
    const snapped = snapFromElement(el, x, y);
    if (snapped?.element && tagOf(snapped.element) !== 'html' && tagOf(snapped.element) !== 'body') {
      return snapped;
    }
  }
  return null;
}

function usableHitStack(doc, x, y) {
  return collectHitStack(doc, x, y).filter((el) => !isHostUi(el) && !isPierceSkipElement(el));
}

function closestUsable(el, selector) {
  const hit = el?.closest?.(selector);
  return hit && !isHostUi(hit) ? hit : null;
}

function cardAncestor(el) {
  let node = el?.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (isHostUi(node) || tagOf(node) === 'body') break;
    const rect = nodeRect(node);
    if (!rect || rect.width < 80 || rect.height < 36) continue;
    const docEl = node.ownerDocument?.documentElement;
    if (docEl?.clientWidth && docEl?.clientHeight && rect.width >= docEl.clientWidth * 0.9 && rect.height >= docEl.clientHeight * 0.5) continue;
    const text = String(node.innerText || node.textContent || '').trim();
    let links = 0;
    let media = 0;
    try {
      links = node.querySelectorAll?.('a[href]').length || 0;
      media = node.querySelectorAll?.('img, picture, video, svg').length || 0;
    } catch {
      /* no candidate */
    }
    if (['a', 'img', 'picture', 'svg', 'p', 'blockquote', 'li', 'dt', 'dd', 'figcaption'].includes(tagOf(node))) continue;
    if ((media >= 1 && links >= 1 && text.length >= 12) || links >= 2 || (media >= 2 && text.length >= 12)) return node;
  }
  return null;
}

function addCandidate(out, seen, element, kind, scope, label) {
  if (!element || seen.has(element) || isHostUi(element)) return;
  const rect = nodeRect(element);
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  seen.add(element);
  out.push({ element, kind, scope, label });
}

/**
 * Small, related choices for one pointer location. This deliberately starts
 * from the browser hit stack: media elsewhere on the page must not win a
 * click just because its rectangle happens to include the point.
 */
export function selectionCandidatesAtPoint(doc, x, y) {
  const stack = usableHitStack(doc, x, y);
  const seed = stack[0];
  if (!seed) return [];
  const out = [];
  const seen = new Set();
  const relatedMedia = stack.find((el) => {
    if (!['image', 'video', 'vector'].includes(kindFromElement(el))) return false;
    return el === seed || seed.contains?.(el) || el.contains?.(seed);
  });
  const media = relatedMedia || mediaUnderPoint(seed, x, y) || closestUsable(seed, 'img, picture, video, audio, svg');
  const link = closestUsable(seed, 'a[href], [role="link"]');
  const cell = closestUsable(seed, 'td, th');
  const table = closestUsable(seed, 'table');
  const button = closestUsable(seed, 'button, [role="button"], input[type="button"], input[type="submit"]');
  const paragraph = closestUsable(seed, 'p, blockquote, li, dt, dd, figcaption, h1, h2, h3, h4, h5, h6');
  const card = cardAncestor(seed);

  if (cell) {
    if (media) addCandidate(out, seen, media, kindFromElement(media), 'media', kindFromElement(media) === 'vector' ? '图标' : '图片');
    if (link) addCandidate(out, seen, link, 'link', 'link', '链接');
    addCandidate(out, seen, cell, 'table', 'cell', '单元格');
    const row = closestUsable(cell, 'tr');
    addCandidate(out, seen, row, 'table', 'row', '这一行');
    addCandidate(out, seen, table, 'table', 'table', '整张表');
  } else if (button) {
    const buttonMedia = media && (button.contains?.(media) || media === button) ? media : mediaUnderPoint(button, x, y);
    if (buttonMedia) addCandidate(out, seen, buttonMedia, kindFromElement(buttonMedia), 'media', kindFromElement(buttonMedia) === 'vector' ? '图标' : '图片');
    addCandidate(out, seen, button, 'container', 'button', '按钮');
    addCandidate(out, seen, card, 'container', 'card', '整张卡片');
  } else {
    if (media) addCandidate(out, seen, media, kindFromElement(media), 'media', kindFromElement(media) === 'vector' ? '图标' : '图片');
    if (link) addCandidate(out, seen, link, 'link', 'link', '链接');
    addCandidate(out, seen, paragraph, 'text', 'paragraph', '这一段');
    addCandidate(out, seen, card, 'container', 'card', '整张卡片');
    if (!out.length) addCandidate(out, seen, seed, kindFromElement(seed), 'element', '文字');
  }
  const limit = cell ? 5 : 4;
  return out.slice(0, limit).map((row, index) => ({ ...row, id: `${row.scope}:${index}` }));
}

/** Default is still a one-click pick; UI may select another returned candidate. */
export function pierceAndSnapWithCandidates(doc, x, y) {
  const candidates = selectionCandidatesAtPoint(doc, x, y);
  const selected = candidates[0] || pierceAndSnap(doc, x, y);
  return selected ? { ...selected, candidates } : null;
}

export function contextSrcOf(el) {
  if (!el) return '';
  if (tagOf(el) === 'picture') {
    const img = el.querySelector?.('img');
    if (img) return srcOf(img);
  }
  if (tagOf(el) === 'video') {
    return String(el.currentSrc || el.src || el.getAttribute?.('src') || el.poster || '');
  }
  return srcOf(el);
}

export function contextHrefOf(el) {
  if (!el) return '';
  if (tagOf(el) === 'a') return hrefOf(el);
  const a = el.closest?.('a[href]');
  return a ? hrefOf(a) : hrefOf(el);
}

export function contextDirectHrefOf(el) {
  const a = tagOf(el) === 'a' ? el : el?.closest?.('a[href]');
  return a ? hrefOf(a) : '';
}

export function contextAltOf(el) {
  const media = tagOf(el) === 'img' ? el : el?.querySelector?.('img[alt]');
  return String(media?.getAttribute?.('alt') || '').trim();
}

/** Preserve authored paragraph boundaries for captures; action matching keeps its own normalizer. */
export function contextTextPreservingBlocks(el) {
  return String(el?.innerText || el?.textContent || '').replace(/\r\n?/g, '\n');
}
