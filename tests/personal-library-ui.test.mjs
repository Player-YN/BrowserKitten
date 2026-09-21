import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPersonalLibraryInput, createPersonalLibraryUi } from '../src/sidepanel/personalLibraryUi.js';

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.checked = false; this.open = false; this.dataset = {}; }
  appendChild(x) { this.children.push(x); x.parentNode = this; return x; }
  append(...xs) { xs.forEach(x => this.appendChild(x)); }
  replaceChildren(...xs) { this.children = []; this.append(...xs); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, target: this, ...extra }); }
  setAttribute(k, v) { this[k] = String(v); }
  getAttribute(k) { return this[k] || null; }
  querySelectorAll() { return []; }
  querySelector(selector) { return selector === '.personal-library-card-actions' ? this.actions : null; }
  showModal() { this.open = true; } close() { this.open = false; } remove() { this.removed = true; }
  reportValidity() { return true; }
}
function miniDom() { const body = new El('body'); return { doc: { body, createElement: tag => new El(tag) }, body }; }
function descendants(node, tag) { const out = []; for (const child of node.children || []) { if (child.tagName === tag) out.push(child); out.push(...descendants(child, tag)); } return out; }

test('parameter dialog converts boolean, number, integer and enum; cancel resolves null', async () => {
  const { doc, body } = miniDom();
  const entry = { name: 'Tool', parameters: { required: ['count'], properties: { enabled: { type: 'boolean', default: true }, amount: { type: 'number', default: 1.5 }, count: { type: 'integer', default: 2 }, mode: { type: 'string', enum: ['a', 'b'], default: 'b' } } } };
  const pending = collectPersonalLibraryInput(entry, { document: doc });
  const form = body.children[0].children[0]; const inputs = descendants(form, 'input'); const select = descendants(form, 'select')[0];
  assert.equal(inputs.find(x => x.name === 'enabled').checked, true);
  inputs.find(x => x.name === 'amount').value = '3.25'; inputs.find(x => x.name === 'count').value = '7'; select.value = '0'; form.fire('submit');
  assert.deepEqual(await pending, { enabled: true, amount: 3.25, count: 7, mode: 'a' });
  const cancelled = collectPersonalLibraryInput({ parameters: { properties: { note: { type: 'string' } } } }, { document: doc });
  const cancelForm = body.children.at(-1).children[0]; descendants(cancelForm, 'button')[0].fire('click');
  assert.equal(await cancelled, null);
});

test('persisted pin slot runs without parameters and library errors do not create or publish', async () => {
  const { doc } = miniDom(); const nodes = new Map();
  for (const id of ['personalLibraryDialog','personalLibraryList','personalToolsBtn','personalWorkflowsBtn','personalLibraryManageBtn','personalLibraryClose','personalLibraryCreate','personalLibraryExport','personalLibraryImport','personalLibraryImportFile']) nodes.set(id, new El('x'));
  nodes.get('personalLibraryDialog').querySelectorAll = () => [];
  const calls = { run: [], errors: [], create: 0 };
  const tool = { entryId: 'tool-1', kind: 'tool', name: 'Pinned tool', revision: 1, parameters: {} };
  const workflow = { entryId: 'wf-1', kind: 'workflow', name: 'Workflow', revision: 1, parameters: { properties: { dry: { type: 'boolean', default: false } } } };
  const ui = createPersonalLibraryUi({ document: doc, $: id => nodes.get(id), t: x => x,
    rpc: async () => ({ entries: [tool, workflow] }), getPins: async () => ['tool-1'], setPins: async () => {},
    run: async (entry, input) => calls.run.push([entry.entryId, input]), create: () => calls.create++, onError: error => calls.errors.push(error.message)
  });
  await ui.wire(); assert.equal(nodes.get('personalToolsBtn').textContent, 'Pinned tool');
  nodes.get('personalToolsBtn').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.run, [['tool-1', {}]]); assert.equal(calls.create, 0);
  const failing = createPersonalLibraryUi({ document: doc, $: id => nodes.get(id), t: x => x, rpc: async () => { throw new Error('RPC_DOWN'); }, getPins: async () => [], onError: error => calls.errors.push(error.message) });
  await failing.wire(); assert.deepEqual(calls.errors, ['RPC_DOWN']);
});
