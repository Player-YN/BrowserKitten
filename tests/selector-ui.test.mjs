import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerHoverDrawer, holdDrawerOpen, closeDrawer, setDrawerPinned } from '../src/sidepanel/hoverDrawer.js';

class UiNode {
  constructor() {
    this.nodeType = 1;
    this.hidden = false;
    this.hover = false;
    this.focusVisible = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: n => classes.has(n),
      toggle: (n, on = !classes.has(n)) => on ? classes.add(n) : classes.delete(n)
    };
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  matches(selector) { return selector === ':focus-visible' ? this.focusVisible : selector === ':hover' && this.hover; }
  querySelector(selector) { return selector === '[data-drawer-body]' ? this.drawerBody : null; }
  closest() { return null; }
}

function drawer(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = Object.fromEntries(['window', 'document', 'Node'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const doc = new UiNode();
  doc.activeElement = new UiNode();
  doc.visibilityState = 'visible';
  const win = new UiNode();
  win.matchMedia = () => ({ matches: true });
  win.setTimeout = (...args) => setTimeout(...args);
  win.clearTimeout = (...args) => clearTimeout(...args);
  Object.assign(globalThis, { window: win, document: doc, Node: UiNode });
  const root = new UiNode();
  const body = new UiNode();
  const trigger = new UiNode();
  const field = new UiNode();
  const menu = new UiNode();
  menu.hidden = true;
  root.children.push(trigger, body);
  body.children.push(field);
  root.drawerBody = body;
  let closes = 0;
  const unregister = registerHoverDrawer('selection-test', {
    root, trigger, body, interactionRoots: [menu], onClose: () => { closes++; }
  });
  t.after(() => {
    closeDrawer('selection-test', { force: true });
    unregister();
    for (const [key, desc] of Object.entries(previous)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  });
  return { root, body, trigger, field, menu, doc, isOpen: () => root.classList.contains('is-drawer-open'), closes: () => closes };
}

test('a picked object opens briefly; pointer leave uses the original grace period', t => {
  const d = drawer(t);
  holdDrawerOpen('selection-test', 2000);
  assert.equal(d.isOpen(), true);
  t.mock.timers.tick(1999);
  assert.equal(d.isOpen(), true);
  t.mock.timers.tick(1);
  assert.equal(d.isOpen(), false);
  d.root.emit('pointerenter');
  t.mock.timers.tick(40);
  assert.equal(d.isOpen(), true);
  d.root.emit('pointerleave', { relatedTarget: null });
  t.mock.timers.tick(479);
  assert.equal(d.isOpen(), true);
  t.mock.timers.tick(1);
  assert.equal(d.isOpen(), false);
});

test('portaled collection/export menus protect the drawer, then resume normal collapse', async t => {
  const d = drawer(t);
  holdDrawerOpen('selection-test', 2000);
  d.menu.hidden = false; // outside root, like a menu moved to document.body
  d.root.emit('pointerleave', { relatedTarget: d.menu });
  t.mock.timers.tick(3000);
  assert.equal(d.isOpen(), true);
  d.menu.emit('pointerleave', { relatedTarget: null });
  t.mock.timers.tick(500);
  assert.equal(d.isOpen(), true);
  d.menu.hidden = true;
  d.doc.emit('click');
  await Promise.resolve();
  t.mock.timers.tick(480);
  assert.equal(d.isOpen(), false);
});

test('keyboard focus opens empty collection controls and prevents closing while editing', async t => {
  const d = drawer(t);
  d.trigger.focusVisible = true;
  d.field.focusVisible = true;
  d.doc.activeElement = d.trigger;
  d.root.emit('focusin');
  assert.equal(d.isOpen(), true);
  d.doc.activeElement = d.field;
  d.root.emit('pointerleave', { relatedTarget: null });
  t.mock.timers.tick(3000);
  assert.equal(d.isOpen(), true);
  d.doc.activeElement = new UiNode();
  d.root.emit('focusout');
  await Promise.resolve();
  t.mock.timers.tick(480);
  assert.equal(d.isOpen(), false);
});

test('menu interaction does not overwrite a user pin; explicit dismissal still works', t => {
  const d = drawer(t);
  setDrawerPinned('selection-test', true);
  d.menu.hidden = false;
  d.root.emit('pointerleave', { relatedTarget: null });
  t.mock.timers.tick(3000);
  assert.equal(d.isOpen(), true);
  d.menu.hidden = true;
  closeDrawer('selection-test');
  assert.equal(d.isOpen(), true);
  closeDrawer('selection-test', { force: true });
  assert.equal(d.isOpen(), false);
});

const panelSource = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtml = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../src/sidepanel.css', import.meta.url), 'utf8');
function panelFunction(name) {
  const start = panelSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return panelSource.slice(start, panelSource.indexOf('\n}', start) + 2);
}

test('chat reference status follows bound groups, independent of capture target and picked item count', () => {
  const label = {};
  const state = { activeGroupId: 'unbound', groups: [{ groupId: 'unbound', itemCount: 99 }], boundGroupIds: [] };
  const context = vm.createContext({
    $: () => label, workspaceGroupState: state,
    t: key => ({ referenceNone: 'none', referenceCount: 'references {n}', referenceHint: 'hint' })[key],
    currentAimedCount: () => 99,
    botStatusUi: { apply() {} }, botStatusContext() {}, accessPolicyUi: {}, paintLiveTurnDisclosure() {}
  });
  vm.runInContext(panelFunction('refreshBotChrome'), context);
  context.refreshBotChrome();
  assert.equal(label.textContent, 'none');
  state.boundGroupIds = ['a', 'b'];
  context.refreshBotChrome();
  assert.equal(label.textContent, 'references 2');
  state.activeGroupId = 'another-unbound';
  context.refreshBotChrome();
  assert.equal(label.textContent, 'references 2');
  state.boundGroupIds = [];
  context.refreshBotChrome();
  assert.equal(label.textContent, 'none');
});

test('opening collection controls on the empty home does not immediately collapse them', () => {
  const panel = new UiNode();
  const welcome = new UiNode();
  let closes = 0;
  const context = vm.createContext({
    $: id => id === 'panel' ? panel : id === 'welcome' ? welcome : null,
    liveTask: null, hasHomeWorkSurface: () => false, getClipboardPins: () => [],
    setDrawerPinned() {}, closeDrawer() { closes++; },
    setHomeEmptyMode() {}, enhanceTopbarIcons() {}, renderHintChips() {}, getGuideOnlyHints: () => []
  });
  vm.runInContext(panelFunction('syncHomeWorkSurfaceLayout'), context);
  context.syncHomeWorkSurfaceLayout();
  assert.equal(closes, 0);
  panel.classList.add('is-home-working');
  context.syncHomeWorkSurfaceLayout();
  assert.equal(closes, 1, 'clearing the last capture still closes the drawer');
  context.syncHomeWorkSurfaceLayout();
  assert.equal(closes, 1, 'subsequent empty renders allow collection management');
});

test('mouse focus on a direct-action button does not pin the drawer open', t => {
  const d = drawer(t);
  holdDrawerOpen('selection-test', 2000);
  d.doc.activeElement = d.field; // clicked button stays focused, but is not :focus-visible
  d.root.emit('pointerleave', { relatedTarget: null });
  t.mock.timers.tick(2000);
  assert.equal(d.isOpen(), false);
});

test('clipboard-only content updates the collapsed summary without changing references or enabling selection clear', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new UiNode());
    return nodes.get(id);
  };
  let clipboard = [{ text: 'one' }, { text: 'two' }];
  const context = vm.createContext({
    $: node, selectedElementsSummary: [],
    document: { querySelector: node }, t: key => key,
    selectionCountsFrom: () => ({ text: 0, images: 0, tables: 0, links: 0, vectors: 0, videos: 0, pages: 0 }),
    isSelectionChipKind: () => false, classifyElementKind: () => 'text',
    getClipboardPins: () => clipboard
  });
  vm.runInContext(panelFunction('updateSelectionSummary'), context);
  context.updateSelectionSummary();
  assert.equal(node('countText').textContent, '2');
  assert.equal(node('selSummary').hidden, false);
  assert.equal(node('clearSelBtn').hidden, true, 'selection clear must not imply clearing Clipboard');
  assert.equal(node('selectionBar').classList.contains('is-empty'), false);
  clipboard = [];
  context.updateSelectionSummary();
  assert.equal(node('countText').textContent, '0');
  assert.equal(node('selSummary').hidden, true);
  assert.equal(node('selectionBar').classList.contains('is-empty'), true);
});

test('collection destination follows selection-summary content, never the existence of an empty group', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new UiNode());
    return nodes.get(id);
  };
  let clipboard = [];
  const groupMenuTransitions = [];
  const context = vm.createContext({
    $: node,
    selectedElementsSummary: [],
    document: { querySelector: node },
    t: key => key,
    selectionCountsFrom: () => ({ text: 0, images: 0, tables: 0, links: 0, vectors: 0, videos: 0, pages: 0 }),
    isSelectionChipKind: () => false,
    classifyElementKind: () => 'text',
    getClipboardPins: () => clipboard,
    setGroupSelectOpen(open) { groupMenuTransitions.push(open); }
  });
  vm.runInContext(panelFunction('updateSelectionSummary'), context);

  context.updateSelectionSummary();
  assert.equal(node('captureDestination').hidden, true, 'an empty saved group is not drawer content');

  clipboard = [{ text: 'kept clipboard text' }];
  context.updateSelectionSummary();
  assert.equal(node('captureDestination').hidden, false, 'clipboard-only content follows the visible summary');

  clipboard = [];
  context.isSelectionChipKind = () => true;
  context.classifyElementKind = () => 'image';
  context.updateSelectionSummary([{ src: 'https://example.test/image.png' }]);
  assert.equal(node('captureDestination').hidden, false, 'a picked object keeps its collection destination');

  context.updateSelectionSummary([]);
  assert.equal(node('captureDestination').hidden, true, 'removing the last picked item hides the destination');
  assert.equal(groupMenuTransitions.at(-1), false, 'removing the last picked item closes the destination menu');
});

test('collection destination has an explicit zero-layout hidden contract from first paint', () => {
  assert.match(
    sidepanelHtml,
    /<div class="capture-destination" id="captureDestination" hidden>/,
    'the destination starts hidden before the first state render'
  );
  assert.match(
    sidepanelCss,
    /\.capture-destination\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/,
    'the flex component explicitly honors its hidden state'
  );
  assert.match(
    sidepanelCss,
    /\.selection-bar\.is-empty \.sel-expand-body\s*\{\s*display:\s*none;/,
    'an empty drawer cannot leave an expanded blank surface'
  );
});
