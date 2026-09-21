/**
 * Office Markdown subset shared by chat bubbles and artifact preview.
 * Headings, emphasis, strike, links, images, quotes, hr, ul/ol, task lists, GFM tables, code.
 */

export function escapeMdHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(href) {
  const h = String(href || '').trim();
  if (!h || /^\s*javascript:/i.test(h) || /^\s*data:text\/html/i.test(h)) return '';
  return h;
}

function safeImgSrc(src) {
  const s = String(src || '').trim();
  if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  return '';
}

export function parseInlineMarkdown(raw) {
  let text = escapeMdHtml(raw);
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    const id = `%%IC${codes.length}%%`;
    codes.push(`<code>${c}</code>`);
    return id;
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const url = safeImgSrc(src.replace(/&amp;/g, '&'));
    if (!url) return escapeMdHtml(alt || '');
    return `<img class="md-img" src="${escapeMdHtml(url)}" alt="${alt}" />`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const url = safeHref(href.replace(/&amp;/g, '&'));
    if (!url) return label;
    return `<a href="${escapeMdHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  codes.forEach((html, i) => {
    text = text.replace(`%%IC${i}%%`, html);
  });
  return text;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSepRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(String(c).replace(/\s/g, '')));
}

function parseTable(lines, start) {
  if (!/^\s*\|/.test(lines[start] || '')) return null;
  const rows = [];
  let i = start;
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  if (rows.length < 2 || !isSepRow(rows[1])) return null;
  const header = rows[0];
  const aligns = rows[1].map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const th = header
    .map((h, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${parseInlineMarkdown(h)}</th>`)
    .join('');
  const body = rows
    .slice(2)
    .map((r) => {
      const tds = header
        .map((_, idx) => `<td style="text-align:${aligns[idx] || 'left'}">${parseInlineMarkdown(r[idx] || '')}</td>`)
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return {
    html: `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: i
  };
}

function listKind(line) {
  const t = String(line || '');
  const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(t);
  if (task) return { kind: 'task', checked: /x/i.test(task[1]), text: task[2] };
  const ul = /^\s*[-*+]\s+(.*)$/.exec(t);
  if (ul) return { kind: 'ul', text: ul[1] };
  const ol = /^\s*\d+[.)]\s+(.*)$/.exec(t);
  if (ol) return { kind: 'ol', text: ol[1] };
  return null;
}

function flushList(buf) {
  if (!buf.length) return '';
  const kind = buf[0].kind === 'ol' ? 'ol' : 'ul';
  const cls = buf[0].kind === 'task' ? ' class="md-task"' : '';
  const items = buf
    .map((it) => {
      if (it.kind === 'task') {
        const on = it.checked ? ' is-checked' : '';
        const mark = it.checked ? '✓' : '';
        return `<li class="md-task-item${on}"><span class="md-check" aria-hidden="true">${mark}</span><span>${parseInlineMarkdown(it.text)}</span></li>`;
      }
      return `<li>${parseInlineMarkdown(it.text)}</li>`;
    })
    .join('');
  buf.length = 0;
  return `<${kind}${cls}>${items}</${kind}>`;
}

/**
 * @param {string} md
 * @returns {string}
 */
export function parseOfficeMarkdown(md) {
  if (md == null || md === '') return '';
  let text = String(md).replace(/\r\n|\r/g, '\n');

  const fences = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const id = `%%CB${fences.length}%%`;
    const safeLang = escapeMdHtml(lang || 'text');
    const langAttr = lang ? ` data-lang="${escapeMdHtml(lang)}"` : '';
    fences.push(
      `<div class="md-code"${langAttr}><pre><code class="language-${safeLang}">${escapeMdHtml(code.trim())}</code></pre></div>`
    );
    return id;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  /** @type {Array<{kind:string,text:string,checked?:boolean}>} */
  const listBuf = [];

  const dumpList = () => {
    const html = flushList(listBuf);
    if (html) out.push(html);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^%%CB\d+%%$/.test(trimmed)) {
      dumpList();
      out.push(trimmed);
      i += 1;
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      dumpList();
      out.push(table.html);
      i = table.next;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      dumpList();
      const n = heading[1].length;
      out.push(`<h${n}>${parseInlineMarkdown(heading[2])}</h${n}>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      dumpList();
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed) || trimmed === '>') {
      dumpList();
      const quotes = [];
      while (i < lines.length && (/^>\s?/.test(lines[i].trim()) || lines[i].trim() === '>')) {
        quotes.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${parseInlineMarkdown(quotes.join(' '))}</blockquote>`);
      continue;
    }

    const li = listKind(line);
    if (li) {
      if (listBuf.length && listBuf[0].kind !== li.kind) dumpList();
      listBuf.push(li);
      i += 1;
      continue;
    }

    if (!trimmed) {
      dumpList();
      i += 1;
      continue;
    }

    dumpList();
    out.push(`<p>${parseInlineMarkdown(trimmed)}</p>`);
    i += 1;
  }
  dumpList();

  let html = out.join('\n');
  fences.forEach((block, idx) => {
    html = html.replace(`%%CB${idx}%%`, block);
  });
  return html;
}
