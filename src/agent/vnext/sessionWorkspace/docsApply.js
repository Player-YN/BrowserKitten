/**
 * Host doc commands on a simple block snapshot (no Univer).
 * Durable save format is marked HTML so the HTML preview tab can also open it.
 */

export const DOC_OPS = ['createDocument', 'insertParagraph', 'setText', 'insertImage', 'insertList'];

export const DOC_MIME = 'text/html';

const HEADING_1 = 4;
const TITLE_STYLE = 2;
const IMG_MD = /^!\[(?:image)?\]\((.+)\)$/i;

/**
 * @param {string} [title]
 * @returns {{ title: string, blocks: Array<{id: string, type: 'p'|'h1'|'img', text?: string, src?: string}> }}
 */
export function emptyDocSnapshot(title = '') {
  return { title: String(title || ''), blocks: [] };
}

export function cloneDocSnapshot(snapshot) {
  const title = String(snapshot?.title || '');
  const blocks = (Array.isArray(snapshot?.blocks) ? snapshot.blocks : [])
    .map((b) => normalizeBlock(b))
    .filter(Boolean);
  return { title, blocks };
}

function normalizeBlock(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const type =
    raw.type === 'h1' || raw.type === 'img' || raw.type === 'li' ? raw.type : 'p';
  const id = String(raw.id || fallbackId || '').trim() || 'b1';
  if (type === 'img') {
    const src = sanitizeSrc(raw.src || raw.url || raw.path || raw.item || '');
    return { id, type, src, text: raw.text != null ? String(raw.text) : undefined };
  }
  return {
    id,
    type,
    list: raw.list === 'ol' ? 'ol' : raw.list ? 'ul' : undefined,
    text: raw.text == null ? '' : String(raw.text)
  };
}

function sanitizeSrc(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^\s*javascript:/i.test(s)) return '';
  return s;
}

function nextBlockId(snapshot) {
  const used = new Set((snapshot.blocks || []).map((b) => String(b.id)));
  let i = 1;
  while (used.has(`b${i}`)) i += 1;
  return `b${i}`;
}

export function normalizeDocCommands(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') continue;
    const op = String(cmd.op || cmd.type || '').trim();
    if (!DOC_OPS.includes(op)) continue;
    out.push({ ...cmd, op });
  }
  return out;
}

function findBlock(snapshot, id) {
  if (!id) return null;
  return snapshot.blocks.find((b) => b.id === String(id)) || null;
}

function lastTextBlock(snapshot) {
  for (let i = snapshot.blocks.length - 1; i >= 0; i--) {
    if (snapshot.blocks[i].type === 'p' || snapshot.blocks[i].type === 'h1') return snapshot.blocks[i];
  }
  return null;
}

function insertAfter(snapshot, afterId, block) {
  const idx = afterId ? snapshot.blocks.findIndex((b) => b.id === String(afterId)) : -1;
  if (idx >= 0) snapshot.blocks.splice(idx + 1, 0, block);
  else snapshot.blocks.push(block);
}

/**
 * @param {object} snapshot
 * @param {object[]} commands
 * @returns {{ snapshot: object, applied: object[], ok: boolean, error?: string }}
 */
export function applyDocCommands(snapshot, commands) {
  let next = cloneDocSnapshot(snapshot);
  const applied = [];
  const list = normalizeDocCommands(commands);

  for (const cmd of list) {
    if (cmd.op === 'createDocument') {
      next = emptyDocSnapshot(cmd.title || cmd.name || '');
      if (Array.isArray(cmd.blocks) && cmd.blocks.length) {
        for (const raw of cmd.blocks) {
          const block = normalizeBlock(raw, nextBlockId(next));
          if (block) {
            if (next.blocks.some((b) => b.id === block.id)) block.id = nextBlockId(next);
            next.blocks.push(block);
          }
        }
      }
      if (cmd.text != null && String(cmd.text) !== '') {
        next.blocks.push({ id: nextBlockId(next), type: 'p', text: String(cmd.text) });
      }
      applied.push({ op: cmd.op, title: next.title, blocks: next.blocks.length });
      continue;
    }

    if (cmd.op === 'insertParagraph' || cmd.op === 'insertList') {
      const list = cmd.list || (cmd.op === 'insertList' ? cmd.list || 'ul' : '');
      const type = list ? 'li' : cmd.heading || cmd.blockType === 'h1' ? 'h1' : 'p';
      const block = {
        id: String(cmd.id || nextBlockId(next)),
        type,
        list: list || undefined,
        text: cmd.text == null ? '' : String(cmd.text)
      };
      if (next.blocks.some((b) => b.id === block.id)) block.id = nextBlockId(next);
      insertAfter(next, cmd.afterId || cmd.after, block);
      applied.push({ op: cmd.op, id: block.id, type: block.type });
      continue;
    }

    if (cmd.op === 'setText') {
      const text = cmd.text == null ? '' : String(cmd.text);
      let block = findBlock(next, cmd.id);
      if (!block) block = lastTextBlock(next);
      if (!block) {
        block = { id: nextBlockId(next), type: 'p', text };
        next.blocks.push(block);
      } else {
        block.text = text;
      }
      applied.push({ op: cmd.op, id: block.id });
      continue;
    }

    if (cmd.op === 'insertImage') {
      const src = sanitizeSrc(cmd.src || cmd.url || '');
      if (!src) {
        return { snapshot: next, applied, ok: false, error: 'insertImage requires url/src' };
      }
      const block = {
        id: String(cmd.id || nextBlockId(next)),
        type: 'img',
        src
      };
      if (next.blocks.some((b) => b.id === block.id)) block.id = nextBlockId(next);
      insertAfter(next, cmd.afterId || cmd.after, block);
      applied.push({ op: cmd.op, id: block.id, src });
    }
  }

  return { snapshot: next, applied, ok: true, html: serializeDocHtml(next) };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).trim();
}

function blockToInnerHtml(block) {
  if (block.type === 'img') {
    const src = escapeAttr(block.src || '');
    const alt = escapeAttr(block.text || '');
    return `<img src="${src}" alt="${alt}" />`;
  }
  const text = escapeHtml(block.text || '');
  if (block.type === 'h1') return `<h1>${text}</h1>`;
  return `<p>${text}</p>`;
}

/**
 * Marked HTML: data-browserbot-preview=blocks so the host HTML preview can open it.
 * @param {object} snapshot
 */
export function serializeDocHtml(snapshot) {
  const snap = cloneDocSnapshot(snapshot);
  const title = escapeHtml(snap.title || 'Document');
  const parts = snap.blocks
    .map((b) => {
      const id = escapeAttr(b.id);
      const type = escapeAttr(b.type);
      return `<section data-browserbot-block data-browserbot-block-id="${id}" data-browserbot-block-type="${type}">${blockToInnerHtml(b)}</section>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN" data-browserbot-preview="blocks">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="browserbot-preview" content="blocks" />
  <title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;line-height:1.55;color:#1c1915;max-width:42rem;margin:24px auto;padding:0 16px}h1{font-size:1.6rem}img{max-width:100%;height:auto}</style>
</head>
<body>
${parts}
</body>
</html>
`;
}

function parseMarkedSections(html) {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = stripTags(titleM ? titleM[1] : '');
  const blocks = [];
  const re = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (!/data-browserbot-block\b/i.test(attrs)) continue;
    const id = (/data-browserbot-block-id=["']([^"']+)["']/i.exec(attrs) || [])[1] || nextBlockId({ blocks });
    const typeAttr = (/data-browserbot-block-type=["']([^"']+)["']/i.exec(attrs) || [])[1];
    const inner = m[2] || '';
    const img = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(inner);
    if (typeAttr === 'img' || img) {
      const alt = /alt=["']([^"']*)["']/i.exec(img?.[0] || inner);
      blocks.push({
        id,
        type: 'img',
        src: sanitizeSrc(decodeEntities(img?.[1] || '')),
        text: alt ? decodeEntities(alt[1]) : undefined
      });
      continue;
    }
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(inner);
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(inner);
    const type = typeAttr === 'h1' || h1 ? 'h1' : 'p';
    blocks.push({ id, type, text: stripTags(h1 ? h1[1] : p ? p[1] : inner) });
  }
  return { title, blocks };
}

function parseLooseHtml(html) {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = stripTags(titleM ? titleM[1] : '');
  const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyM ? bodyM[1] : html;
  const blocks = [];
  const re = /<(h1|p|img)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (tag === 'img') {
      const src = (/src=["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
      blocks.push({ id: nextBlockId({ blocks }), type: 'img', src: sanitizeSrc(decodeEntities(src)) });
    } else {
      blocks.push({
        id: nextBlockId({ blocks }),
        type: tag === 'h1' ? 'h1' : 'p',
        text: stripTags(m[3] || '')
      });
    }
  }
  return { title, blocks };
}

function parsePlainText(text, title) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (const line of lines) {
    if (line.trim() === '' && !blocks.length) continue;
    const img = IMG_MD.exec(line.trim());
    if (img) {
      blocks.push({ id: nextBlockId({ blocks }), type: 'img', src: sanitizeSrc(img[1]) });
    } else {
      blocks.push({ id: nextBlockId({ blocks }), type: 'p', text: line });
    }
  }
  return { title: title || '', blocks };
}

/**
 * @param {string} raw
 * @param {{ title?: string }} [extra]
 */
export function parseDocSnapshot(raw, extra = {}) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return emptyDocSnapshot(extra.title || '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && Array.isArray(obj.blocks)) {
        return cloneDocSnapshot({ title: obj.title || extra.title || '', blocks: obj.blocks });
      }
    } catch {
      /* not JSON snapshot */
    }
  }
  if (/data-browserbot-preview\s*=\s*["']blocks["']/i.test(text) || /data-browserbot-block\b/i.test(text)) {
    const marked = parseMarkedSections(text);
    if (marked.blocks.length) {
      if (!marked.title && extra.title) marked.title = extra.title;
      return cloneDocSnapshot(marked);
    }
  }
  if (/<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed) || /<(p|h1|img)\b/i.test(trimmed)) {
    const loose = parseLooseHtml(text);
    if (loose.blocks.length) {
      if (!loose.title && extra.title) loose.title = extra.title;
      return cloneDocSnapshot(loose);
    }
  }
  return parsePlainText(text, extra.title);
}

/**
 * Univer IDocumentData seed. Images are drawings + customBlocks, never markdown paragraphs.
 */
export function snapshotToUniverData(snapshot, opts = {}) {
  const snap = cloneDocSnapshot(snapshot);
  const paragraphs = [];
  const customBlocks = [];
  const drawings = {};
  const drawingsOrder = [];
  let stream = '';
  for (const block of snap.blocks) {
    if (block.type === 'img') {
      const drawingId = String(block.id || `draw${drawingsOrder.length + 1}`);
      drawings[drawingId] = {
        drawingId,
        title: block.text || 'image',
        source: sanitizeSrc(block.src || ''),
        imageSourceType: 'URL'
      };
      drawingsOrder.push(drawingId);
      customBlocks.push({ startIndex: stream.length, blockId: drawingId });
      stream += '\r';
      paragraphs.push({ startIndex: stream.length - 1 });
      continue;
    }
    const text = String(block.text || '').replace(/[\r\n]/g, ' ');
    stream += text + '\r';
    const para = { startIndex: stream.length - 1 };
    if (block.type === 'h1') para.paragraphStyle = { namedStyleType: HEADING_1 };
    if (block.type === 'li' || block.list) {
      para.bullet = { listType: block.list === 'ol' ? 'ol' : 'ul', nestingLevel: 0 };
    }
    paragraphs.push(para);
  }
  if (!stream) {
    stream = '\r';
    paragraphs.push({ startIndex: 0 });
  }
  stream += '\n';
  return {
    id: String(opts.id || `paw-doc-${Date.now().toString(36)}`),
    title: snap.title || '',
    body: {
      dataStream: stream,
      paragraphs,
      sectionBreaks: [{ startIndex: stream.length - 1 }],
      textRuns: [],
      customBlocks,
      tables: []
    },
    drawings,
    drawingsOrder,
    documentStyle: {
      pageSize: { width: 595.3, height: 841.9 },
      marginTop: 50,
      marginBottom: 50,
      marginLeft: 72,
      marginRight: 72
    }
  };
}

export function univerDataToSnapshot(data, extra = {}) {
  const stream = String(data?.body?.dataStream || '');
  const paras = Array.isArray(data?.body?.paragraphs) ? data.body.paragraphs : [];
  const custom = Array.isArray(data?.body?.customBlocks) ? data.body.customBlocks : [];
  const drawings = data?.drawings && typeof data.drawings === 'object' ? data.drawings : {};
  const customAt = new Map(custom.map((c) => [Number(c.startIndex), c]));
  const blocks = [];
  let prev = 0;
  for (let i = 0; i < paras.length; i++) {
    const end = Number(paras[i].startIndex);
    if (!Number.isFinite(end) || end < prev) continue;
    const cb = customAt.get(prev);
    if (cb && drawings[cb.blockId]) {
      const d = drawings[cb.blockId];
      blocks.push({
        id: String(cb.blockId),
        type: 'img',
        src: sanitizeSrc(d.source || d.src || '')
      });
      prev = end + 1;
      continue;
    }
    const text = stream.slice(prev, end);
    prev = end + 1;
    if (IMG_MD.test(String(text).trim())) continue;
    const named = paras[i]?.paragraphStyle?.namedStyleType;
    const bullet = paras[i]?.bullet;
    if (bullet) {
      blocks.push({
        id: nextBlockId({ blocks }),
        type: 'li',
        list: bullet.listType === 'ol' ? 'ol' : 'ul',
        text
      });
    } else if (named === HEADING_1 || named === TITLE_STYLE) {
      blocks.push({ id: nextBlockId({ blocks }), type: 'h1', text });
    } else if (text !== '' || blocks.length) {
      blocks.push({ id: nextBlockId({ blocks }), type: 'p', text });
    }
  }
  return cloneDocSnapshot({
    title: extra.title || data?.title || '',
    blocks
  });
}

export function overviewFromDocSnapshot(snapshot, extra = {}) {
  const snap = cloneDocSnapshot(snapshot);
  return {
    title: snap.title,
    blockCount: snap.blocks.length,
    blocks: snap.blocks.map((b) => ({
      id: b.id,
      type: b.type,
      text: b.type === 'img' ? undefined : String(b.text || '').slice(0, 160),
      src: b.type === 'img' ? b.src : undefined
    })),
    ...extra
  };
}
