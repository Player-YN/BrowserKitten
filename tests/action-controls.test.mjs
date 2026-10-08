import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyRisk } from '../src/agent/vnext/host/riskClassify.js';

// The naming / heuristic-clickable logic lives in a marked pure block inside the classic content script
// (no DOM or window access inside the block). Evaluate just that block with small element fakes.
const source = readFileSync(new URL('../src/content_script.js', import.meta.url), 'utf8');
const begin = source.indexOf('// ── action-controls:pure-begin ──');
const end = source.indexOf('// ── action-controls:pure-end ──');
assert.ok(begin > 0 && end > begin, 'pure block markers present in content_script.js');
const { computeActionName, selectHeuristicClickables, ACTION_HEURISTIC_CAP } = new Function(
  `${source.slice(begin, end)}\nreturn { computeActionName, selectHeuristicClickables, ACTION_HEURISTIC_CAP };`
)();

// ── minimal DOM fakes ──
const txt = (value) => ({ nodeType: 3, nodeValue: value });
function el(tag, attrs = {}, children = [], props = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    childNodes: [],
    parentElement: null,
    ...props,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    contains(other) {
      for (let cur = other; cur; cur = cur.parentElement) if (cur === this) return true;
      return false;
    }
  };
  for (const c of children) {
    const child = typeof c === 'string' ? txt(c) : c;
    if (child.nodeType === 1) child.parentElement = node;
    node.childNodes.push(child);
  }
  return node;
}
function flatten(root) {
  const out = [];
  const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c); } });
  walk(root);
  return out;
}
const NEARBY = 'Get the best stories in your inbox.';
const env = (extra = {}) => ({ byId: () => null, labels: () => [], nearby: () => NEARBY, ...extra });

// ── accessible name ──
test('buttons and links are named by their own text, never by nearby text', () => {
  assert.equal(computeActionName(el('button', {}, ['Subscribe to newsletter']), env()), 'Subscribe to newsletter');
  assert.equal(computeActionName(el('button', { type: 'submit' }, ['  Create\n   account ']), env()), 'Create account');
  assert.equal(computeActionName(el('a', { href: '#' }, ['Cart (', el('span', {}, ['0']), ')']), env()), 'Cart (0)');
  assert.equal(computeActionName(el('div', { role: 'menuitem' }, ['Users']), env()), 'Users');
  assert.equal(computeActionName(el('li', { role: 'tab' }, ['Billing']), env()), 'Billing');
  assert.equal(computeActionName(el('option', {}, ['Japan']), env()), 'Japan');
});

test('button content includes img alt and nested blocks are space separated; aria-hidden skipped', () => {
  const b = el('button', {}, [el('img', { alt: 'Settings' }), el('span', { 'aria-hidden': 'true' }, ['⚙'])]);
  assert.equal(computeActionName(b, env()), 'Settings');
  const card = el('div', { tabindex: '0' }, [el('div', {}, ['Plan']), el('div', {}, ['Pro'])]);
  assert.equal(computeActionName(card, env()), 'Plan Pro');
});

test('input submit/button use their value; empty submit falls back to "Submit"', () => {
  assert.equal(computeActionName(el('input', { type: 'submit' }, [], { type: 'submit', value: 'Send message' }), env()), 'Send message');
  assert.equal(computeActionName(el('input', { type: 'button' }, [], { type: 'button', value: 'Go' }), env()), 'Go');
  assert.equal(computeActionName(el('input', { type: 'submit' }, [], { type: 'submit', value: '' }), env()), 'Submit');
  assert.equal(computeActionName(el('input', { type: 'image', alt: 'Search' }, [], { type: 'image', value: '' }), env()), 'Search');
});

test('aria-labelledby beats aria-label beats own text', () => {
  const heading = el('h2', {}, ['Billing address']);
  const byId = (id) => (id === 'h' ? heading : null);
  const b = el('button', { 'aria-labelledby': 'h missing', 'aria-label': 'Edit' }, ['Change']);
  assert.equal(computeActionName(b, env({ byId })), 'Billing address');
  assert.equal(computeActionName(el('button', { 'aria-label': '4 stars' }, ['4★']), env()), '4 stars');
});

test('fields: label, then placeholder, then title, then nearby text', () => {
  const input = (attrs = {}, props = {}) => el('input', attrs, [], { type: attrs.type || 'text', ...props });
  assert.equal(computeActionName(input(), env({ labels: () => ['  Full   name '] })), 'Full name');
  assert.equal(computeActionName(input({ placeholder: 'Search products' }, { placeholder: 'Search products' }), env()), 'Search products');
  assert.equal(computeActionName(input({ title: 'Quantity' }), env()), 'Quantity');
  assert.equal(computeActionName(input(), env({ nearby: () => 'Phone' })), 'Phone');
  assert.equal(computeActionName(input({ type: 'checkbox' }), env({ labels: () => ['I agree to the Terms of Service'] })), 'I agree to the Terms of Service');
  assert.equal(computeActionName(el('textarea'), env({ labels: () => ['Comments'] })), 'Comments');
  assert.equal(computeActionName(el('div', { contenteditable: 'true' }, ['draft body']), env({ role: () => 'textbox', labels: () => [], nearby: () => 'Message' })), 'Message');
});

test('icon-only buttons fall back to title, then nearby text', () => {
  assert.equal(computeActionName(el('button', { title: 'Close' }, [el('svg')]), env()), 'Close');
  assert.equal(computeActionName(el('button', {}, [el('svg')]), env({ nearby: () => 'Delete row' })), 'Delete row');
});

test('names are collapsed and capped at 80 chars', () => {
  const long = 'word '.repeat(40);
  const name = computeActionName(el('button', {}, [long]), env());
  assert.ok(name.length <= 80);
  assert.ok(!/\s{2}|^\s|\s$/.test(name));
});

// ── heuristic clickables ──
function pageEnv(root, opts = {}) {
  const pointer = opts.pointer || new Set();
  const owner = (n) => ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(n.tagName) || ['button', 'link', 'menuitem', 'switch'].includes(n.getAttribute('role'));
  const cursorOf = (n) => {
    for (let cur = n; cur; cur = cur.parentElement) if (pointer.has(cur)) return 'pointer';
    return 'auto';
  };
  return {
    already: opts.already || new Set(),
    cursor: cursorOf,
    visible: (n) => !(opts.hidden || new Set()).has(n),
    isChrome: () => false,
    insideControl: (n) => { for (let cur = n.parentElement; cur; cur = cur.parentElement) if (owner(cur)) return true; return false; },
    containsControl: (n) => flatten(n).some(owner),
    inMenu: (n) => { for (let cur = n.parentElement; cur; cur = cur.parentElement) if (cur.tagName === 'NAV') return true; return false; }
  };
}

test('admin-style div menu: pointer items and plain nav items become controls; hidden submenu does not', () => {
  const dash = el('div', { 'data-k': 'dash' }, ['Dashboard']);
  const sys = el('div', { 'data-k': 'sys' }, ['System ▸']);
  const users = el('div', { 'data-k': 'users' }, ['Users']);
  const sub = el('div', { id: 'sys' }, [users]);
  const nav = el('nav', {}, [dash, sys, sub]);
  const body = el('body', {}, [nav, el('main', {}, [el('p', {}, ['Select a section.'])])]);
  const picked = selectHeuristicClickables(flatten(body), pageEnv(body, { pointer: new Set([sys, users]), hidden: new Set([sub, users]) }));
  assert.deepEqual(picked, [dash, sys]);
});

test('signals: onclick / data-action / interactive role attributes; non-interactive roles and plain text ignored', () => {
  const a = el('span', { onclick: 'go()' }, ['Open']);
  const b = el('li', { 'data-action': 'archive' }, ['Archive']);
  const c = el('div', { role: 'menuitem' }, ['Rename']);
  const d = el('div', { role: 'alert' }, ['Saved']);
  const e = el('p', {}, ['Just some text']);
  const body = el('body', {}, [a, b, c, d, e]);
  assert.deepEqual(selectHeuristicClickables(flatten(body), pageEnv(body)), [a, b, c]);
});

test('cursor:pointer needs own text; inherited pointer inside a candidate with own text is dropped; innermost wins otherwise', () => {
  // <ul pointer><li>Alpha</li><li>Beta</li></ul>: ul has no own text, items win.
  const li1 = el('li', {}, ['Alpha']);
  const li2 = el('li', {}, ['Beta']);
  const ul = el('ul', {}, [li1, li2]);
  // <div pointer>Inbox <span>3</span></div>: badge inherits pointer, the row keeps it.
  const badge = el('span', {}, ['3']);
  const row = el('div', {}, ['Inbox ', badge]);
  // <div onclick><span pointer>Reports</span></div>: both candidates, innermost wins.
  const inner = el('span', {}, ['Reports']);
  const outer = el('div', { onclick: 'x()' }, [inner]);
  const body = el('body', {}, [ul, row, outer]);
  const picked = selectHeuristicClickables(flatten(body), pageEnv(body, { pointer: new Set([ul, row, inner]) }));
  assert.deepEqual(picked, [li1, li2, row, inner]);
});

test('skips text inside or around real controls, long text, and elements already in the snapshot', () => {
  const inButton = el('span', {}, ['Buy']);
  const button = el('button', {}, [inButton]);
  const wrapper = el('div', {}, ['Card ', el('a', { href: '#' }, ['link'])]);
  const longText = el('div', {}, ['x'.repeat(61)]);
  const known = el('div', { tabindex: '0' }, ['Known']);
  const body = el('body', {}, [button, wrapper, longText, known]);
  const picked = selectHeuristicClickables(flatten(body), pageEnv(body, { pointer: new Set([inButton, wrapper, longText, known]), already: new Set([known]) }));
  assert.deepEqual(picked, []);
});

test('heuristic controls are capped', () => {
  const items = Array.from({ length: 120 }, (_, i) => el('div', { onclick: 'f()' }, [`Item ${i}`]));
  const body = el('body', {}, items);
  assert.equal(selectHeuristicClickables(flatten(body), pageEnv(body)).length, ACTION_HEURISTIC_CAP);
  assert.equal(selectHeuristicClickables(flatten(body), pageEnv(body), 5).length, 5);
});

test('risk classification still sees delete / discard / pay on generic-clickable controls', () => {
  const risk = (name) => classifyRisk({ channel: 'action', op: 'click', name, control: { role: 'generic-clickable', name } }).risk;
  assert.equal(risk('Discard draft'), classifyRisk({ channel: 'action', op: 'click', name: 'Discard draft', control: { role: 'button', name: 'Discard draft' } }).risk);
  assert.equal(risk('Delete account'), classifyRisk({ channel: 'action', op: 'click', name: 'Delete account', control: { role: 'button', name: 'Delete account' } }).risk);
  assert.equal(risk('Pay now'), classifyRisk({ channel: 'action', op: 'click', name: 'Pay now', control: { role: 'button', name: 'Pay now' } }).risk);
  assert.notEqual(risk('Discard draft'), classifyRisk({ channel: 'action', op: 'click', name: 'Discard draft', control: { role: 'div', name: 'Discard draft' } }).risk);
});
