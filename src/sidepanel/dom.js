/**
 * DOM / HTML helpers for the side panel (pure-ish).
 */

/** @param {string} id */
export function $(id) {
  return document.getElementById(id);
}

/** @param {unknown} text */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Allowlist HTML tags for model markdown (no scripts / event handlers). */
export const SAFE_MD_TAGS = new Set([
  'A',
  'P',
  'BR',
  'STRONG',
  'EM',
  'B',
  'I',
  'U',
  'DEL',
  'IMG',
  'CODE',
  'PRE',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'DETAILS',
  'SUMMARY',
  'DIV',
  'SPAN'
]);

/**
 * Sanitize HTML produced by marked before innerHTML.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeModelHtml(html) {
  const raw = String(html || '');
  if (!raw.trim()) return '';
  try {
    const doc = new DOMParser().parseFromString(`<div id="pw-root">${raw}</div>`, 'text/html');
    const root = doc.getElementById('pw-root');
    if (!root) return escapeHtml(raw).replace(/\n/g, '<br>');
    const walk = (node) => {
      const children = [...node.childNodes];
      for (const child of children) {
        if (child.nodeType === 1) {
          const el = /** @type {Element} */ (child);
          const tag = el.tagName.toUpperCase();
          if (
            tag === 'SCRIPT' ||
            tag === 'IFRAME' ||
            tag === 'OBJECT' ||
            tag === 'EMBED' ||
            tag === 'FORM' ||
            tag === 'LINK' ||
            tag === 'META' ||
            tag === 'STYLE' ||
            tag === 'SVG'
          ) {
            el.remove();
            continue;
          }
          if (!SAFE_MD_TAGS.has(tag)) {
            while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el);
            el.remove();
            continue;
          }
          for (const attr of [...el.attributes]) {
            const n = attr.name.toLowerCase();
            if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') {
              el.removeAttribute(attr.name);
              continue;
            }
            if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value)) {
              el.removeAttribute(attr.name);
              continue;
            }
            if (n === 'href') {
              el.setAttribute('rel', 'noopener noreferrer');
              el.setAttribute('target', '_blank');
            }
          }
          walk(el);
        }
      }
    };
    walk(root);
    return root.innerHTML;
  } catch {
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }
}

/**
 * Editor chrome + one-click copy on fenced blocks already in the sanitized tree.
 * Adds a bar via DOM (BUTTON is not in the markdown allowlist).
 * @param {ParentNode} container
 * @param {{ copyLabel?: string, copiedLabel?: string, writeText?: (text: string) => Promise<void>|void }} [opts]
 */
export function mountMarkdownCodeCopy(container, opts = {}) {
  if (!container || typeof container.querySelectorAll !== 'function') return 0;
  const copyLabel = opts.copyLabel || 'Copy';
  const copiedLabel = opts.copiedLabel || 'Copied';
  const writeText =
    typeof opts.writeText === 'function'
      ? opts.writeText
      : (text) => {
          if (globalThis.navigator?.clipboard?.writeText) {
            return globalThis.navigator.clipboard.writeText(text);
          }
          throw new Error('CLIPBOARD_UNAVAILABLE');
        };
  const codes = container.querySelectorAll('pre > code');
  let n = 0;
  for (const code of codes) {
    const pre = code.parentElement;
    if (!pre) continue;
    let wrap = pre.parentElement;
    if (!wrap || !wrap.classList?.contains?.('md-code')) {
      const host = pre.parentNode;
      wrap = globalThis.document?.createElement?.('div') || null;
      if (!wrap || !host) continue;
      wrap.className = 'md-code';
      const lang = String(code.className || '').replace(/^language-/, '').trim();
      if (lang && lang !== 'text') wrap.setAttribute('data-lang', lang);
      host.insertBefore(wrap, pre);
      wrap.appendChild(pre);
    }
    if (wrap.querySelector('.md-code-bar')) continue;
    const bar = globalThis.document.createElement('div');
    bar.className = 'md-code-bar';
    const langLabel = String(wrap.getAttribute('data-lang') || '').trim();
    if (langLabel && langLabel !== 'text') {
      const langEl = globalThis.document.createElement('span');
      langEl.className = 'md-code-lang';
      langEl.textContent = langLabel;
      bar.appendChild(langEl);
    } else {
      const spacer = globalThis.document.createElement('span');
      spacer.className = 'md-code-lang';
      spacer.setAttribute('aria-hidden', 'true');
      bar.appendChild(spacer);
    }
    const btn = globalThis.document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-code-copy';
    btn.textContent = copyLabel;
    btn.setAttribute('aria-label', copyLabel);
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = String(code.textContent || '');
      try {
        await writeText(text);
        btn.textContent = copiedLabel;
        btn.classList.add('is-copied');
        globalThis.setTimeout?.(() => {
          btn.textContent = copyLabel;
          btn.classList.remove('is-copied');
        }, 1400);
      } catch {
        btn.textContent = copyLabel;
      }
    });
    bar.appendChild(btn);
    wrap.insertBefore(bar, pre);
    n += 1;
  }
  return n;
}

/** @param {string} s @param {number} n */
export function truncateUi(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
