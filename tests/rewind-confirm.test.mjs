import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { I18N } from '../src/sidepanel/i18n.js';
import {
  bindRewindEditButton,
  dismissRewindConfirm,
  openRewindInlineConfirm,
  syncRewindConfirmCopy
} from '../src/sidepanel/rewindConfirm.js';

function createDocument() {
  const listeners = [];
  const doc = {
    activeElement: null,
    listeners,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture: !!capture });
    },
    removeEventListener(type, fn, capture) {
      const cap = !!capture;
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === cap);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatch(type, event) {
      for (const l of [...listeners]) {
        if (l.type === type) l.fn(event);
      }
    },
    createElement(tag) {
      return createEl(doc, tag);
    }
  };
  return doc;
}

function createEl(doc, tag) {
  const classes = new Set();
  const el = {
    ownerDocument: doc,
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    type: '',
    attrs: {},
    style: {},
    listeners: [],
    blurred: 0,
    isConnected: true,
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name))
    },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
    get className() {
      return [...classes].join(' ');
    },
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    getAttribute(key) {
      return this.attrs[key];
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
      }
      child.parentNode = this;
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    get nextSibling() {
      const siblings = this.parentNode?.children;
      if (!siblings) return null;
      const index = siblings.indexOf(this);
      return index >= 0 ? siblings[index + 1] || null : null;
    },
    remove() {
      this.parentNode?.children && (this.parentNode.children = this.parentNode.children.filter((child) => child !== this));
      this.parentNode = null;
      this.isConnected = false;
    },
    addEventListener(type, fn) {
      this.listeners.push({ type, fn });
    },
    dispatch(type, event) {
      for (const l of [...this.listeners]) {
        if (l.type === type) l.fn(event);
      }
    },
    focus() {
      doc.activeElement = this;
    },
    blur() {
      this.blurred += 1;
      if (doc.activeElement === this) doc.activeElement = null;
    },
    contains(node) {
      if (!node) return false;
      let parent = node;
      while (parent) {
        if (parent === this) return true;
        parent = parent.parentNode;
      }
      return false;
    },
    querySelector(sel) {
      const name = String(sel || '').startsWith('.') ? String(sel).slice(1) : '';
      const walk = (node) => {
        for (const child of node.children) {
          if (name && child.classList.contains(name)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return name ? walk(this) : null;
    }
  };
  return el;
}

function bubble(doc) {
  const parent = doc.createElement('div');
  parent.className = 'task-body';
  const host = doc.createElement('div');
  host.className = 'msg user';
  const edit = doc.createElement('button');
  edit.className = 'msg-user-edit';
  host.appendChild(edit);
  parent.appendChild(host);
  return { parent, host, edit };
}

function confirmCard(host) {
  const card = host.nextSibling;
  if (!card || !card.classList.contains('msg-rewind-confirm')) return null;
  return card;
}

function clickEvent() {
  return {
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
}

const t = (key) => I18N.zh[key] || key;

test.afterEach(() => dismissRewindConfirm());

test('cancel, Escape, and an outside press clear the pencil focus', () => {
  const doc = createDocument();
  const { host, edit } = bubble(doc);
  let commits = 0;
  bindRewindEditButton(edit, () => openRewindInlineConfirm(host, {
    t,
    onConfirm: () => { commits += 1; }
  }));

  const down = { button: 0, preventDefault() { down.prevented = true; } };
  edit.dispatch('mousedown', down);
  assert.equal(down.prevented, true);

  edit.focus();
  edit.dispatch('click', clickEvent());
  assert.equal(host.classList.contains('is-rewind-confirm'), true);
  assert.equal(edit.blurred > 0, true);
  assert.equal(doc.activeElement.className, 'msg-rewind-confirm-cancel');
  const panel = confirmCard(host);
  assert.equal(host.contains(panel), false);
  assert.equal(panel.getAttribute('aria-label'), I18N.zh.rewindInlineHint);
  assert.equal(panel.querySelector('.msg-rewind-confirm-ok').textContent, '确认回滚');

  doc.dispatch('pointerdown', { target: panel.querySelector('.msg-rewind-confirm-text') });
  assert.equal(host.classList.contains('is-rewind-confirm'), true);

  const esc = clickEvent();
  esc.key = 'Escape';
  doc.dispatch('keydown', esc);
  assert.equal(esc.prevented, true);
  assert.equal(host.classList.contains('is-rewind-confirm'), false);
  assert.equal(confirmCard(host), null);
  assert.equal(doc.activeElement, null);
  assert.equal(edit.blurred > 1, true);
  assert.equal(Object.keys(edit.style).length, 0);
  assert.equal(doc.listeners.length, 0);
  assert.equal(commits, 0);

  edit.dispatch('click', clickEvent());
  confirmCard(host).querySelector('.msg-rewind-confirm-cancel').dispatch('click', clickEvent());
  assert.equal(host.classList.contains('is-rewind-confirm'), false);
  assert.equal(doc.activeElement, null);
  assert.equal(commits, 0);
});

test('outside press cancels and confirm still rewinds once', () => {
  const doc = createDocument();
  const { host, edit } = bubble(doc);
  let commits = 0;
  openRewindInlineConfirm(host, { t, onConfirm: () => { commits += 1; } });
  doc.dispatch('pointerdown', { target: edit });
  assert.equal(host.classList.contains('is-rewind-confirm'), false);
  assert.equal(commits, 0);

  openRewindInlineConfirm(host, { t, onConfirm: () => { commits += 1; } });
  const ok = confirmCard(host).querySelector('.msg-rewind-confirm-ok');
  ok.dispatch('click', clickEvent());
  ok.dispatch('click', clickEvent());
  assert.equal(commits, 1);
  assert.equal(host.classList.contains('is-rewind-confirm'), false);
  assert.equal(doc.activeElement, null);
});

test('only one message keeps the inline confirm', () => {
  const doc = createDocument();
  const a = bubble(doc);
  const b = bubble(doc);
  openRewindInlineConfirm(a.host, { t, onConfirm() {} });
  openRewindInlineConfirm(a.host, { t, onConfirm() {} });
  assert.equal(confirmCard(a.host) != null, true);
  assert.equal(a.host.contains(confirmCard(a.host)), false);
  assert.equal(a.parent.children.filter((child) => child.classList.contains('msg-rewind-confirm')).length, 1);

  openRewindInlineConfirm(b.host, { t, onConfirm() {} });
  assert.equal(a.host.classList.contains('is-rewind-confirm'), false);
  assert.equal(confirmCard(a.host), null);
  assert.equal(b.host.classList.contains('is-rewind-confirm'), true);
  assert.equal(b.host.contains(confirmCard(b.host)), false);
  assert.equal(doc.listeners.length, 2);

  syncRewindConfirmCopy((key) => I18N.en[key] || key);
  assert.equal(confirmCard(b.host).querySelector('.msg-rewind-confirm-ok').textContent, 'Confirm rewind');
  assert.match(confirmCard(b.host).querySelector('.msg-rewind-confirm-text').textContent, /leave the transcript/);
  dismissRewindConfirm();
  assert.equal(doc.listeners.length, 0);
});

test('rewind copy and pencil visibility do not use a modal or focus-within', () => {
  assert.match(I18N.zh.rewindInlineHint, /这条和之后的对话会从记录里去掉/);
  assert.match(I18N.zh.rewindInlineHint, /已生成的文件会留着/);
  assert.equal(I18N.zh.rewindInlineOk, '确认回滚');
  assert.equal(I18N.zh.rewindInlineCancel, '取消');
  assert.match(I18N.en.rewindInlineHint, /This message and everything after it leave the transcript/);
  assert.match(I18N.en.rewindInlineHint, /Files already created stay/);

  const css = readFileSync(new URL('../src/sidepanel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.msg\.user:focus-within\s+\.msg-user-edit/);
  const hover = css.indexOf('.msg.user:hover .msg-user-edit');
  const hide = css.indexOf('.msg.user.is-rewind-confirm .msg-user-edit');
  assert.ok(hover >= 0 && hide > hover);
  const card = css.slice(css.indexOf('.msg-rewind-confirm {'), css.indexOf('.msg-rewind-confirm-text'));
  assert.match(card, /align-self:\s*flex-end/);
  assert.match(card, /background:\s*var\(--bg-elevated\)/);
  assert.match(card, /color:\s*var\(--text\)/);
  assert.match(card, /border:\s*1px solid var\(--border\)/);
  assert.doesNotMatch(card, /accent|currentColor|#fff/);

  const src = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function rewindUserTurn'), src.indexOf('function rebuildTurnJumpRail'));
  assert.match(fn, /openRewindInlineConfirm/);
  assert.match(fn, /workspaceRpc\('rewindSession'/);
  assert.doesNotMatch(fn, /confirmInApp/);
});
