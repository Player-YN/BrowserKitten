import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowUi } from '../src/sidepanel/workflowUi.js';

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.open = false; this.value = ''; }
  append(...xs) { xs.forEach(x => this.appendChild(x)); }
  appendChild(x) { this.children.push(x); x.parentNode = this; return x; }
  replaceChildren(...xs) { this.children.forEach(x => x.parentNode = null); this.children = []; this.append(...xs); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async fire(name) { await Promise.all((this.listeners[name] || []).map(fn => fn({ target: this, preventDefault() {} }))); }
  get isConnected() { return this.tagName === 'body' || !!this.parentNode?.isConnected; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
  querySelectorAll() { return []; }
  setCustomValidity(value) { this.validityMessage = value; }
  showModal() { this.open = true; } close() { this.open = false; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
function setup(rpc) {
  const doc = new El('document'); doc.body = new El('body'); doc.defaultView = new El('window'); doc.visibilityState = 'visible';
  doc.createElement = tag => new El(tag); doc.createTextNode = text => Object.assign(new El('#text'), { textContent: text }); doc.getElementById = () => null;
  const errors = [];
  const ui = createWorkflowUi({ document: doc, rpc, onError: e => errors.push(e), getLang: () => 'en' });
  const text = () => walk(doc.body).map(n => n.textContent || '').join('\n');
  return { ui, doc, text, errors };
}
const workflow = { version: 2, tabs: [], steps: [{ id: 'manual', title: 'Review', op: 'manual' }] };
const entry = { entryId: 'entry', kind: 'workflow', name: 'Flow', workflow, parameters: {} };
const run = (revision, status, id = 'run1') => ({ id, type: 'run', revision, status, definition: entry, sessionId: 'session', nextStep: 0, attempts: [], bindings: {} });
const draft = { ...entry, draftId: 'draft', sessionId: 'maker', revision: 1 };
const recording = (revision, status) => ({ id: 'rec1', type: 'recording', draftId: 'draft', revision, status, definition: draft });

test('run events update UI without reads, reject stale/unrelated records, and preserve editor nodes', async () => {
  const calls = [];
  const f = setup(async method => { calls.push(method); return method === 'startWorkflowRun' ? { run: run(1, 'paused'), sessionId: 'session' } : run(2, 'running'); });
  await f.ui.runPublished(entry);
  await walk(f.doc.body).find(n => n.tagName === 'button' && n.textContent === 'Run monitor').fire('click');
  const inputs = walk(f.doc.body).filter(n => n.tagName === 'input');
  inputs[0].value = 'unsaved edit';
  const before = calls.length;
  assert.equal(f.ui.handleEvent({ type: 'workflow-run', run: run(4, 'completed') }), true);
  assert.equal(f.ui.handleEvent({ type: 'workflow-run', run: run(3, 'running') }), false);
  assert.equal(f.ui.handleEvent({ type: 'workflow-run', run: run(5, 'running', 'other') }), false);
  assert.equal(calls.length, before);
  assert.match(f.text(), /completed/);
  assert.equal(walk(f.doc.body).filter(n => n.tagName === 'input')[0], inputs[0]);
  assert.equal(inputs[0].value, 'unsaved edit');
});

test('one attachment read catches events emitted before start RPC returns', async () => {
  let ui; const calls = [];
  const f = setup(async method => {
    calls.push(method);
    if (method === 'startWorkflowRun') {
      ui.handleEvent({ type: 'workflow-run', run: run(3, 'completed') });
      return { run: run(1, 'paused'), sessionId: 'session' };
    }
    return run(3, 'completed');
  }); ui = f.ui;
  await ui.runPublished(entry);
  assert.match(f.text(), /completed/);
  assert.deepEqual(calls, ['listWorkflowTabs', 'startWorkflowRun', 'getWorkflowRun']);
});

test('focus/visibility reconciliation coalesces reads; an older response cannot roll back a push', async () => {
  let readResolve; let slow = false; let reads = 0;
  const f = setup(async method => {
    if (method === 'startWorkflowRun') return { run: run(1, 'paused') };
    if (method === 'listWorkflowTabs') return [];
    reads++; return slow ? new Promise(resolve => readResolve = resolve) : run(2, 'running');
  });
  await f.ui.runPublished(entry); slow = true;
  const pending = f.ui.resync();
  await f.doc.defaultView.fire('focus'); await f.doc.fire('visibilitychange');
  assert.equal(reads, 2);
  f.ui.handleEvent({ type: 'workflow-run', run: run(5, 'completed') });
  readResolve(run(3, 'running')); await pending;
  assert.match(f.text(), /completed/);
  assert.deepEqual(f.errors, []);
});

test('recording events update enrollment progress without draft polling and restore after reopen', async () => {
  const calls = [];
  const f = setup(async method => { calls.push(method); return method === 'getPersonalLibraryDraft' ? { draft } : recording(2, 'recording'); });
  await f.ui.restore();
  const before = calls.length;
  assert.equal(f.ui.handleEvent({ type: 'workflow-recording', recording: recording(4, 'paused') }), true);
  assert.equal(f.ui.handleEvent({ type: 'workflow-recording', recording: recording(3, 'recording') }), false);
  assert.match(f.text(), /paused/);
  assert.equal(calls.length, before);
  assert.deepEqual(calls, ['getWorkflowRecording', 'getPersonalLibraryDraft', 'getWorkflowRecording']);
});

test('a stop event carries the committed draft revision into the next editor save', async () => {
  let current = recording(2, 'recording'); let savedRevision;
  const f = setup(async (method, params) => {
    if (method === 'getPersonalLibraryDraft') return { draft };
    if (method === 'updateWorkflowDraft') { savedRevision = params.expectedRevision; return { draft: { ...draft, revision: 3, ...params.patch } }; }
    return current;
  });
  await f.ui.restore();
  await walk(f.doc.body).find(n => n.tagName === 'button' && n.textContent === 'Edit').fire('click');
  current = recording(4, 'stopped');
  f.ui.handleEvent({ type: 'workflow-recording', recording: current, draft: { ...draft, revision: 2 } });
  await walk(f.doc.body).find(n => n.tagName === 'button' && n.textContent === 'Save draft').fire('click');
  assert.equal(savedRevision, 2);
  assert.deepEqual(f.errors, []);
});
