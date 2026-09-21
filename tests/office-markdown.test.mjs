import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseOfficeMarkdown } from '../src/markdown/officeMarkdown.js';
import { mountMarkdownCodeCopy } from '../src/sidepanel/dom.js';

test('office markdown emits structured headings, lists, and fenced code chrome', () => {
  const html = parseOfficeMarkdown([
    '# 大标题',
    '',
    '## 小标题',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '```js',
    'const n = 1;',
    '```'
  ].join('\n'));
  assert.match(html, /<h1>大标题<\/h1>/);
  assert.match(html, /<h2>小标题<\/h2>/);
  assert.match(html, /<ul>[\s\S]*<li>bullet one<\/li>/);
  assert.match(html, /class="md-code"/);
  assert.match(html, /data-lang="js"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /const n = 1;/);
  assert.doesNotMatch(html, /browserbot-code-details/);
});

test('mountMarkdownCodeCopy adds a one-click copy bar without rewriting the code', async () => {
  const copied = [];
  class El {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = {};
      this.className = '';
      this.parentNode = null;
      this.parentElement = null;
      this.textContent = '';
      this.listeners = {};
    }
    get classList() {
      const parts = () => String(this.className || '').split(/\s+/).filter(Boolean);
      return {
        contains: (n) => parts().includes(n),
        add: (n) => {
          if (!parts().includes(n)) this.className = [...parts(), n].join(' ');
        },
        remove: (n) => {
          this.className = parts().filter((x) => x !== n).join(' ');
        }
      };
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] || ''; }
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      child.parentNode = this;
      child.parentElement = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(child);
      else this.children.splice(i, 0, child);
      return child;
    }
    querySelector(sel) {
      if (sel === '.md-code-bar') return this.children.find((c) => /\bmd-code-bar\b/.test(c.className)) || null;
      return null;
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  const host = new El('div');
  const wrap = new El('div');
  wrap.className = 'md-code';
  wrap.setAttribute('data-lang', 'js');
  const pre = new El('pre');
  const code = new El('code');
  code.className = 'language-js';
  code.textContent = 'const n = 1;';
  pre.appendChild(code);
  wrap.appendChild(pre);
  host.appendChild(wrap);
  host.querySelectorAll = (sel) => (sel === 'pre > code' ? [code] : []);
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    assert.equal(mountMarkdownCodeCopy(host, {
      copyLabel: '复制',
      copiedLabel: '已复制',
      writeText: (text) => { copied.push(text); }
    }), 1);
    const bar = wrap.children[0];
    assert.equal(bar.className, 'md-code-bar');
    assert.equal(bar.children[0].textContent, 'js');
    const btn = bar.children[1];
    assert.equal(btn.textContent, '复制');
    await btn.listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(copied, ['const n = 1;']);
    assert.equal(btn.textContent, '已复制');
    assert.equal(code.textContent, 'const n = 1;');
  } finally {
    globalThis.document = previous;
  }
});

test('i18n has zh+en code copy strings', () => {
  const i18n = readFileSync(new URL('../src/sidepanel/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /codeCopy: '复制'/);
  assert.match(i18n, /codeCopied: '已复制'/);
  assert.match(i18n, /codeCopy: 'Copy'/);
  assert.match(i18n, /codeCopied: 'Copied'/);
});
