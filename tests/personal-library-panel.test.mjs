import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('let personalLibraryUi = null;'), source.indexOf('function setupCoreEventListeners()'));
function fixture(rpc) {
  const nodes = new Map();
  const calls = []; let callbacks; let active = 'original';
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: node, t: key => key, currentLang: 'en', sessions: [{ id: active }],
    getWorkspaceSessionId: () => active,
    switchSession: async id => { active = id; },
    submitCustomPrompt: content => { calls.push(['send', content]); },
    workspaceRpc: async (method, params) => { calls.push([method, params]); return rpc?.(method, params) ?? (method === 'getPersonalLibraryDraftBySession' ? { draft: null } : {}); },
    createPersonalLibraryUi: opts => { callbacks = opts; return { wire() {}, close() {}, refresh: async () => {}, open: async () => {} }; },
    collectPersonalLibraryInput: async () => ({ count: 3 }),
    chrome: { tabs: { query: async () => [{ id: 7, url: 'https://example.com' }] } },
    showQuickToast: message => calls.push(['toast', message])
  });
  vm.runInContext(block + '\nsetupPersonalLibrary();', context);
  return { context, calls, nodes, node, get callbacks() { return callbacks; }, setActive: id => { active = id; } };
}

test('creation adopts exactly the service-created session before submitting the creation prompt', async () => {
  const f = fixture(method => method === 'startLibraryCreation' ? {
    sessionId: 'builder', title: 'Create tool', content: 'Help me define a tool.',
    draft: { draftId: 'draft', sessionId: 'builder', kind: 'tool', revision: 0 }
  } : undefined);
  await f.callbacks.create('tool');
  assert.equal(f.context.sessions.length, 2);
  assert.equal(f.context.getWorkspaceSessionId(), 'builder');
  assert.deepEqual(f.calls.filter(([method]) => method === 'send'), [['send', 'Help me define a tool.']]);
  assert.equal(f.calls.some(([method]) => method === 'getSession'), false, 'no second empty conversation');
  assert.equal(f.node('personalLibraryDraftPublish').disabled, true);
});

test('workflow parameter values reach preparation and execution uses the normal conversation submit path', async () => {
  const f = fixture(method => method === 'startLibraryWorkflow' ? { sessionId: 'workflow-run', content: 'Run workflow.', title: 'Workflow' } : undefined);
  await f.callbacks.run({ entryId: 'workflow', name: 'Workflow', kind: 'workflow' }, { count: 3 });
  const params = f.calls.find(([method]) => method === 'startLibraryWorkflow')[1];
  assert.equal(params.input.count, 3);
  assert.equal(params.lang, 'en');
  assert.equal(f.context.getWorkspaceSessionId(), 'workflow-run');
  assert.equal(f.calls.filter(([method]) => method === 'send').length, 1);
});

test('direct tools expose independent output/stop controls and never submit a model prompt', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(method => method === 'runPersonalLibraryTool' ? pending : undefined);
  const running = f.callbacks.run({ entryId: 'tool', name: 'Echo', kind: 'tool' }, { count: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.node('personalLibraryRunCard').hidden, false);
  assert.equal(f.node('personalLibraryRunStop').hidden, false);
  await f.node('personalLibraryRunStop').listeners.click();
  assert.equal(f.calls.find(([method]) => method === 'abortCurrentExecution')[1].sessionId, 'original');
  release({ ok: true, result: { value: 6 } }); await running;
  assert.match(f.node('personalLibraryRunOutput').textContent, /"value": 6/);
  assert.equal(f.node('personalLibraryRunStop').hidden, true);
  assert.equal(f.calls.some(([method]) => method === 'send'), false);
});

test('tool lifecycle events update busy/approval state without sealing an earlier Agent turn', () => {
  const eventHandler = source.slice(source.indexOf('function handleSessionWorkspaceEvent('), source.indexOf('function isMessageChannelError('));
  const state = {}; const calls = [];
  const context = vm.createContext({
    getWorkspaceSessionId: () => 's', uiState: () => state, currentWorkspaceTaskId: null,
    setAgentRunningUi: running => calls.push(['busy', running]),
    approvalUi: { hide: sid => calls.push(['hide', sid]) }, renderSessionRailList() {},
    botStatusUi: { apply() { throw new Error('must not alter the old model turn'); } },
    settleLiveTurnFromTerminalEvent() { throw new Error('must not seal the old model turn'); }
  });
  vm.runInContext(eventHandler, context);
  for (const type of ['execution-start', 'execution-end']) {
    assert.equal(context.handleSessionWorkspaceEvent({ action: 'session_workspace_event', event: { type, sessionId: 's', executionId: 'tool-execution', executionKind: 'personal-tool' } }), true);
  }
  assert.deepEqual(calls, [['busy', true], ['busy', false], ['hide', 's']]);
  assert.equal(state.running, false);
});
