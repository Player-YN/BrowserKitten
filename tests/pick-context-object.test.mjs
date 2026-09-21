import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContextKind, contextTextPreservingBlocks, pierceAndSnapWithCandidates } from '../src/agent/vnext/sessionWorkspace/pickContext.js';

const selectorTags = (selector) => selector.split(',').map((part) => part.trim().split(/[\[.:\s]/)[0].toLowerCase()).filter(Boolean);

function node(tag, opts = {}) {
  const children = [];
  const attrs = { ...(opts.attrs || {}) };
  const rect = opts.rect || { left: 0, top: 0, right: 200, bottom: 120, width: 200, height: 120 };
  const doc = opts.doc || {
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    defaultView: { getComputedStyle: (el) => ({ pointerEvents: el._pointerEvents, opacity: '1', visibility: 'visible', position: 'static' }) }
  };
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), id: opts.id || '', className: opts.className || '',
    innerText: opts.text || '', textContent: opts.text || '', parentElement: null, ownerDocument: doc,
    src: opts.src || '', currentSrc: opts.src || '', href: opts.href || '', _pointerEvents: opts.pointerEvents || 'auto',
    getBoundingClientRect: () => rect,
    getAttribute(name) { return attrs[name] || (name === 'src' ? this.src : name === 'href' ? this.href : ''); },
    classList: { contains: () => false },
    contains(other) { return other === this || children.some((child) => child.contains(other)); },
    querySelectorAll(selector) {
      const tags = selectorTags(selector);
      const out = [];
      const visit = (current) => current._children.forEach((child) => {
        if (tags.includes(child.tagName.toLowerCase())) out.push(child);
        visit(child);
      });
      visit(this);
      return out;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) {
      const tags = selectorTags(selector);
      let current = this;
      while (current) {
        if (tags.includes(current.tagName.toLowerCase())) return current;
        if (selector.includes('[role="link"]') && current.getAttribute('role') === 'link') return current;
        if (selector.includes('[role="button"]') && current.getAttribute('role') === 'button') return current;
        current = current.parentElement;
      }
      return null;
    },
    _children: children
  };
  for (const child of opts.children || []) {
    child.parentElement = el;
    children.push(child);
  }
  return el;
}

function docAt(...stack) { return { elementsFromPoint: () => stack }; }

test('container picks remain non-text and source text preserves authored whitespace', () => {
  assert.equal(classifyContextKind({ kindHint: 'container', text: 'button label' }), 'container');
  assert.equal(contextTextPreservingBlocks({ innerText: '  code\r\n\tindent\rnext  ' }), '  code\n\tindent\nnext  ');
});

test('pointer-events-none image inside a link offers image and link from the seed subtree', () => {
  const image = node('img', { src: 'https://cdn.example/cover.jpg', pointerEvents: 'none' });
  const link = node('a', { href: 'https://example.test/post', children: [image] });
  const snap = pierceAndSnapWithCandidates(docAt(link), 8, 8);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.scope), ['media', 'link']);
  assert.equal(snap.candidates[0].element, image);
  assert.equal(snap.candidates[1].element, link);
});

test('an obscured background image outside the seed subtree cannot become a candidate', () => {
  const background = node('img', { src: 'https://cdn.example/background.jpg' });
  const button = node('button', { text: 'Open' });
  const snap = pierceAndSnapWithCandidates(docAt(button, background), 8, 8);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.scope), ['button']);
  assert.equal(snap.candidates.some((candidate) => candidate.element === background), false);
});

test('a paragraph and a one-image wrapper do not invent a card boundary', () => {
  const image = node('img', { src: 'https://cdn.example/one.jpg' });
  const paragraph = node('p', { text: 'This is a normal paragraph with plenty of text.' });
  const wrapper = node('div', { children: [image, paragraph] });
  const snap = pierceAndSnapWithCandidates(docAt(paragraph, wrapper), 8, 8);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.scope), ['paragraph']);
});

test('button keeps its nested icon as an alternate candidate', () => {
  const icon = node('svg');
  const button = node('button', { text: 'Save', children: [icon] });
  const snap = pierceAndSnapWithCandidates(docAt(icon, button), 8, 8);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.scope), ['media', 'button']);
  assert.equal(snap.candidates[0].element, icon);
});

test('linked table media retains media, link, cell, row, and table choices', () => {
  const image = node('img', { src: 'https://cdn.example/a.jpg' });
  const link = node('a', { href: 'https://example.test/a', children: [image] });
  const cell = node('td', { children: [link] });
  const row = node('tr', { children: [cell] });
  const table = node('table', { children: [row] });
  const snap = pierceAndSnapWithCandidates(docAt(image, link, cell, row, table), 8, 8);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.scope), ['media', 'link', 'cell', 'row', 'table']);
  assert.deepEqual(snap.candidates.map((candidate) => candidate.kind), ['image', 'link', 'table', 'table', 'table']);
});
