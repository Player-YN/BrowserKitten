import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const contentSource = readFileSync(new URL('../src/content_script.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');

// Pull the implementation out of the extension bundle so these tests execute the
// shipped functions, while keeping Node free of Chrome and a browser DOM.
function functionSource(source, name) {
  const bareStart = source.indexOf(`function ${name}(`);
  assert.ok(bareStart >= 0, `missing ${name}`);
  const start = source.slice(Math.max(0, bareStart - 6), bareStart) === 'async ' ? bareStart - 6 : bareStart;
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  // Find the declaration's opening brace after balancing its parameter list;
  // this skips object destructuring and default objects in parameters.
  const paren = source.indexOf('(', bareStart);
  let params = 0, body = -1;
  for (let i = paren; i < source.length; i++) {
    if (source[i] === '(') params++;
    else if (source[i] === ')' && --params === 0) { body = source.indexOf('{', i); break; }
  }
  assert.ok(body >= 0, `missing body for ${name}`);
  for (let i = body; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function runFunction(source, name, bindings = {}) {
  const context = vm.createContext({ console, ...bindings });
  vm.runInContext(functionSource(source, name), context);
  return context;
}

function node({ tag = 'DIV', text = '', src = '', href = '', connected = true } = {}) {
  const classes = new Set();
  return {
    nodeType: 1, tagName: tag, innerText: text, textContent: text, src, currentSrc: src, href,
    isConnected: connected,
    classList: { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n) },
    getAttribute: key => key === 'src' ? src : null,
    querySelectorAll: () => [],
    closest: () => null
  };
}

test('strict locator fingerprints require every captured field and never reuse a mismatched live node', () => {
  const exact = node({ tag: 'A', text: '  Read\n more ', src: '', href: '' });
  const replacement = node({ tag: 'A', text: 'Read more', src: '', href: '' });
  const ctx = runFunction(contentSource, 'findElementForItem', {
    document: { querySelector: () => replacement, querySelectorAll: () => [] },
    location: { href: 'https://example.test/' }, URL,
    isLiveElement: el => !!(el && el.nodeType === 1 && el.isConnected !== false),
    srcIdentity: u => String(u || '').split('?')[0],
    contextSrcOf: el => el.currentSrc || el.src || '', contextHrefOf: el => el.href || ''
  });
  const fingerprint = { tag: 'a', src: '', href: '', text: 'Read more' };
  assert.equal(ctx.findElementForItem({ selector: '#read', locatorFingerprint: fingerprint }), replacement);
  assert.equal(ctx.findElementForItem({ selector: '#read', element: node({ tag: 'A', text: 'changed' }), locatorFingerprint: fingerprint }), null,
    'a live item is only a candidate; fingerprint evidence still decides');
  assert.equal(ctx.findElementForItem({ element: exact, locatorFingerprint: { tag: 'a', src: '', href: '', text: 'other' } }), null);
});

test('legacy restores retain the permissive src, selector, then text fallback', () => {
  const image = node({ tag: 'IMG', src: 'https://cdn.test/pic.png?rev=2' });
  const text = node({ tag: 'DIV', text: 'A matching legacy paragraph' });
  const ctx = runFunction(contentSource, 'findElementForItem', {
    document: { querySelector: selector => selector === '#text' ? text : null, querySelectorAll: selector => selector === 'img' ? [image] : [text] },
    location: { href: 'https://example.test/' }, URL,
    isLiveElement: el => !!(el && el.nodeType === 1 && el.isConnected !== false),
    srcIdentity: u => String(u || '').split('?')[0],
    contextSrcOf: el => el.currentSrc || el.src || '', contextHrefOf: el => el.href || ''
  });
  assert.equal(ctx.findElementForItem({ src: 'https://cdn.test/pic.png?old=1' }), image);
  assert.equal(ctx.findElementForItem({ selector: '#text' }), text);
  assert.equal(ctx.findElementForItem({ tag: 'div', text: 'matching legacy' }), text);
});

test('scope choice button passes its candidate into the real capture function', () => {
  const buttons = [];
  const target = node({ tag: 'TD', text: 'cell' });
  const defaultTarget = node({ tag: 'DIV', text: 'default' });
  const body = { appendChild(el) { this.last = el; } };
  const doc = {
    body, querySelectorAll: () => [],
    createElement(tag) {
      const listeners = new Map();
      const el = { tagName: tag, style: {}, classList: { add() {}, remove() {} }, parentNode: body,
        appendChild(child) { buttons.push(child); }, addEventListener(type, fn) { listeners.set(type, fn); },
        fire(type) { listeners.get(type)?.({ preventDefault() {}, stopPropagation() {} }); }, remove() {} };
      return el;
    }
  };
  const ctx = vm.createContext({ document: doc, window: { innerWidth: 800, innerHeight: 600 }, Math, hoveredElement: defaultTarget, scopeOptionBubble: null, pickerLang: 'en', captureCalls: [] });
  vm.runInContext('function hideScopeOptionBubble() {}\nfunction scopeOptionLabel(c) { return c.scope; }\nfunction captureCandidate(element, candidate) { captureCalls.push({ element, candidate }); }\n' + functionSource(contentSource, 'showScopeOptionBubble'), ctx);
  const choice = { element: target, scope: 'cell', kind: 'table' };
  ctx.showScopeOptionBubble({ clientX: 4, clientY: 5 }, [choice]);
  assert.equal(buttons.length, 1);
  buttons[0].fire('click');
  assert.equal(ctx.captureCalls.length, 1);
  assert.equal(ctx.captureCalls[0].element, target);
  assert.equal(ctx.captureCalls[0].candidate, choice);
});

test('table matrix export honors an individual cell and an individual row', () => {
  const cell = node({ tag: 'TD', text: ' one\u00a0 ' });
  const rowCellA = node({ tag: 'TH', text: 'head' });
  const rowCellB = node({ tag: 'TD', text: ' value ' });
  const row = { tagName: 'TR', querySelectorAll: selector => selector === 'th,td' ? [rowCellA, rowCellB] : [] };
  const ctx = runFunction(contentSource, 'tableElToMatrix');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.tableElToMatrix(cell))), [['one']]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.tableElToMatrix(row))), [['head', 'value']]);
});

test('restore_selection persists scope, facets, and fingerprint for the next notify', () => {
  const source = contentSource;
  const start = source.indexOf("else if (request.action === 'restore_selection') {");
  const end = source.indexOf("\n    else if", start + 10);
  assert.ok(start >= 0 && end > start);
  const branch = source.slice(start, end).replace(/^else if/, 'if');
  const restored = node({ tag: 'TD', text: 'restored' });
  const notifications = [];
  const ctx = vm.createContext({
    request: { action: 'restore_selection', silent: false, items: [{ selector: '#x', scope: 'row', facets: { text: 'raw', links: [] }, locatorFingerprint: { tag: 'td', src: '', href: '', text: 'restored' } }] },
    document: { querySelectorAll: () => [] }, selectedElements: [], hoveredElement: null,
    findElementForItem: () => restored, isLiveElement: el => !!el?.nodeType,
    generateSelector: () => '#x', cleanDOMText: s => s, classifyContextKind: () => 'table',
    refreshHighlightClasses() {}, notifySidePanel: payload => notifications.push(payload), sendResponse() {}
  });
  vm.runInContext(branch, ctx);
  assert.equal(ctx.selectedElements[0].scope, 'row');
  assert.deepEqual(ctx.selectedElements[0].facets, { text: 'raw', links: [] });
  assert.deepEqual(ctx.selectedElements[0].locatorFingerprint, { tag: 'td', src: '', href: '', text: 'restored' });
  assert.equal(notifications.length, 1);
});

test('restore routing targets frame zero and clears stale live frames without concurrent same-frame replaces', async () => {
  const sends = [];
  const ctx = runFunction(panelSource, 'restoreItemsToFrames', {
    chrome: { webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'live-main' }, { frameId: 2, documentId: 'live-child' }] }, tabs: { sendMessage: async (...args) => { sends.push(args); return { ok: true }; } } },
    Promise, Map, Number, String, Array
  });
  await ctx.restoreItemsToFrames(11, [{ selector: '#legacy', frameId: 0 }]);
  assert.equal(sends.filter(([, , options]) => options.frameId === 0).length, 1, 'legacy main-frame item is merged with its live document clear');
  assert.deepEqual(JSON.parse(JSON.stringify(sends.map(([, message, options]) => ({ frameId: options.frameId, documentId: options.documentId || '', selectors: message.items.map(x => x.selector) })).sort((a, b) => a.frameId - b.frameId))), [
    { frameId: 0, documentId: 'live-main', selectors: ['#legacy'] },
    { frameId: 2, documentId: 'live-child', selectors: [] }
  ], 'switching to a group without child-frame captures clears its old child selection');
  sends.length = 0;
  await ctx.restoreItemsToFrames(11, []);
  assert.deepEqual(JSON.parse(JSON.stringify(sends.map(([, message, options]) => [options.frameId, options.documentId, message.items.length]).sort((a, b) => a[0] - b[0]))), [[0, 'live-main', 0], [2, 'live-child', 0]], 'switching to an empty or different group clears every live frame');
});

test('clipboard pins keep raw text and still RPC same text captured from another source', async () => {
  const rpc = [];
  const local = [];
  let state = { groups: [{ groupId: 'clipboard', kind: 'clipboard', items: [] }] };
  const ctx = vm.createContext({
    workspaceGroupState: state, CLIPBOARD_GROUP_KIND: 'clipboard', currentLang: 'en', Date,
    isClipboardGroup: g => g?.kind === 'clipboard', clipClipboardText: s => s,
    pinClipboardItemsToStore: rows => { local.push(...rows); return rows; },
    workspaceRpc: (_method, payload) => { rpc.push(payload); return Promise.resolve(null); },
    getWorkspaceSessionId: () => 's', renderWorkspaceGroupControls() {}, renderClipboardUI() {}, renderQuickTools() {}, showQuickToast() {}, t: x => x,
    $: () => null, holdDrawerOpen() {}, listClipboardItemsFromStore: () => [], clearClipboardStore() {},
    removeClipboardIdsFromStore() {}, syncLocalClipboardMirrorFromGroup() {}, clipDrawerOpen: false
  });
  vm.runInContext(functionSource(panelSource, 'clipboardGroupFromState') + '\n' + functionSource(panelSource, 'getClipboardPins') + '\n' + functionSource(panelSource, 'clipboardUiKey') + '\n' + functionSource(panelSource, 'pinTextsToClipboard'), ctx);
  const raw = 'first line\n\n  indented line';
  ctx.pinTextsToClipboard([{ text: raw, textRaw: raw, source: { tabId: 1, frameId: 0, documentId: 'one', url: 'https://a.test' } }], { openDrawer: false, toast: false });
  ctx.pinTextsToClipboard([{ text: raw, textRaw: raw, source: { tabId: 1, frameId: 0, documentId: 'two', url: 'https://a.test' } }], { openDrawer: false, toast: false });
  ctx.pinTextsToClipboard([{ text: raw, textRaw: raw, source: { tabId: 1, frameId: 0, documentId: 'two', url: 'https://a.test' } }], { openDrawer: false, toast: false });
  await Promise.resolve();
  assert.equal(local.length, 2, 'the same source remains deduplicated');
  assert.equal(local[0].textRaw, raw);
  assert.equal(rpc.length, 2, 'same authored text from a new document is not swallowed by UI de-dupe');
});
