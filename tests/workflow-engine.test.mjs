import test from 'node:test';
import assert from 'node:assert/strict';

import { bindWorkflowTabs, executeWorkflow, verifyStep } from '../src/agent/vnext/workflow/engine.js';

const button = { role: 'button', name: 'Save' };

function makeRun(steps, extra = {}) {
  return {
    id: 'run-1', status: 'paused', nextStep: 0, input: {}, outputs: {}, attempts: [], attempt: null,
    bindings: { main: 11 }, startedAt: 1,
    definition: { workflow: { tabs: [{ id: 'main', title: 'Main', url: 'https://example.test/' }], steps } },
    ...extra,
  };
}

function hostWith(overrides = {}) {
  let stored;
  return {
    save: async value => (stored = structuredClone(value)),
    event() {},
    observe: async () => ({ url: 'https://example.test/', rev: 'rev-1', controls: [{ ...button, ref: 'button-1', visible: true }] }),
    action: async () => ({ ok: true, result: { acknowledged: true } }),
    tabs: async () => [{ id: 11, url: 'https://example.test/' }],
    sys: async () => ({ ok: true }),
    tool: async () => ({ ok: true, result: true }),
    fileExists: async () => false,
    download: async () => false,
    get stored() { return stored; },
    ...overrides,
  };
}

test('an action uses the ref and revision from its current snapshot', async () => {
  const calls = [];
  const host = hostWith({
    observe: async () => ({ rev: 'current-rev', controls: [{ ...button, ref: 'current-ref', visible: true }] }),
    action: async payload => { calls.push(payload); return { ok: true }; },
  });
  const run = makeRun([{ id: 'save', title: 'Save', op: 'click', tab: 'main', target: button,
    check: { type: 'visible', target: button } }]);

  const result = await executeWorkflow(run, host, { controller: new AbortController(), cancelled: false });

  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, 'current-ref');
  assert.equal(calls[0].rev, 'current-rev');
});

test('an ambiguous target fails before dispatch', async () => {
  let actions = 0;
  const host = hostWith({
    observe: async () => ({ rev: 'r', controls: [
      { ...button, ref: 'one', visible: true }, { ...button, ref: 'two', visible: true },
    ] }),
    action: async () => { actions++; },
  });
  const result = await executeWorkflow(makeRun([
    { id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, check: { type: 'visible' } },
  ]), host, { controller: new AbortController(), cancelled: false });

  assert.equal(actions, 0);
  assert.equal(result.status, 'needs_human');
  assert.equal(result.error.code, 'WORKFLOW_AMBIGUOUS');
});

test('a host acknowledgement does not replace the step postcondition', async () => {
  let observations = 0;
  const host = hostWith({
    observe: async () => {
      observations++;
      return observations === 1
        ? { rev: 'before', controls: [{ ...button, ref: 'save', visible: true }] }
        : { rev: 'after', text: 'Still editing', controls: [{ ...button, ref: 'save', visible: true }] };
    },
    action: async () => ({ ok: true, result: { acknowledged: true } }),
  });
  const result = await executeWorkflow(makeRun([
    { id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, timeoutMs: 100,
      check: { type: 'text', contains: 'Saved' } },
  ]), host, { controller: new AbortController(), cancelled: false });

  assert.equal(result.status, 'needs_human');
  assert.equal(result.error.code, 'WORKFLOW_CHECK_FAILED');
  assert.ok(observations >= 2);
});

test('failure to persist the prepared attempt prevents dispatch', async () => {
  let saves = 0; let actions = 0;
  const host = hostWith({
    save: async value => { saves++; if (saves === 2) throw new Error('disk full'); return structuredClone(value); },
    action: async () => { actions++; return { ok: true }; },
  });
  const result = await executeWorkflow(makeRun([
    { id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, check: { type: 'visible' } },
  ]), host, { controller: new AbortController(), cancelled: false });

  assert.equal(actions, 0);
  assert.equal(result.status, 'needs_human');
  assert.equal(result.error.message, 'disk full');
});

test('a thrown dispatch retains its uncertain attempt and pause differs from cancel', async () => {
  const uncertain = await executeWorkflow(makeRun([
    { id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, check: { type: 'visible' } },
  ]), hostWith({ action: async () => { throw new Error('connection lost'); } }),
  { controller: new AbortController(), cancelled: false });
  assert.equal(uncertain.status, 'needs_human');
  assert.equal(uncertain.attempt.phase, 'dispatching');
  assert.equal(uncertain.attempts.at(-1).phase, 'dispatching');

  for (const [cancelled, expected] of [[false, 'paused'], [true, 'cancelled']]) {
    const controller = new AbortController(); controller.abort(new Error('stopped'));
    const stopped = await executeWorkflow(makeRun([
      { id: 'wait', title: 'Wait', op: 'wait', tab: 'main', check: { type: 'url', equals: 'x' } },
    ]), hostWith(), { controller, cancelled });
    assert.equal(stopped.status, expected);
  }
});

test('a popup alias binds only the new child of the acting tab', async () => {
  let tabReads = 0;
  const host = hostWith({
    tabs: async () => ++tabReads === 1
      ? [{ id: 11, url: 'https://example.test/' }]
      : [{ id: 11 }, { id: 90, openerTabId: 77 }, { id: 91, openerTabId: 11 }],
  });
  const run = makeRun([
    { id: 'openPopup', title: 'Open popup', op: 'click', tab: 'main', opensTab: 'popup', target: button,
      check: { type: 'visible', target: button } },
  ]);
  run.definition.workflow.tabs.push({ id: 'popup', title: 'Popup' });

  const result = await executeWorkflow(run, host, { controller: new AbortController(), cancelled: false });
  assert.equal(result.status, 'completed');
  assert.equal(result.bindings.popup, 91);
});

test('tool receives the complete pinned snapshot and cannot mutate the definition', async () => {
  const pinned = { entryId: 'tool-1', revision: 4, kind: 'tool', name: 'Lookup', description: 'Lookup',
    code: 'export default () => true', parameters: { type: 'object' }, runtimeVersion: 'browserbot-library-v1',
    scope: 'workspace', allowedHosts: ['example.test'] };
  let received;
  const host = hostWith({ tool: async (tool, args) => { received = structuredClone(tool); tool.code = 'mutated'; return { ok: true, result: args }; } });
  const run = makeRun([{ id: 'lookup', title: 'Lookup', op: 'tool', tool: pinned,
    args: { query: { $ref: 'input.query' } }, check: { type: 'result', equals: { query: 'kitten' } } }],
  { input: { query: 'kitten' } });

  const result = await executeWorkflow(run, host, { controller: new AbortController(), cancelled: false });
  assert.equal(result.status, 'completed');
  assert.deepEqual(received, pinned);
  assert.equal(run.definition.workflow.steps[0].tool.code, 'export default () => true');
});

test('a false download check fails instead of treating the host response as success', async () => {
  await assert.rejects(() => verifyStep(
    { id: 'download', title: 'Download', op: 'check', tab: 'main', check: { type: 'download', contains: '.csv' } },
    makeRun([]), hostWith({ download: async () => false }), new AbortController().signal, {},
  ), { code: 'WORKFLOW_CHECK_FAILED' });
});

test('retry execution can resolve data from a previously completed step output', async () => {
  let filled;
  const host = hostWith({ action: async payload => { filled = payload.value; return { ok: true }; } });
  const run = makeRun([
    { id: 'readName', title: 'Read', op: 'read', tab: 'main', target: { role: 'textbox', name: 'Name' } },
    { id: 'fillName', title: 'Fill', op: 'fill', tab: 'main', target: { role: 'textbox', name: 'Name' },
      value: { $ref: 'steps.readName.value' }, check: { type: 'visible' } },
  ], { nextStep: 1, outputs: { readName: { text: 'Kitten', value: 'Kitten' } } });
  host.observe = async () => ({ rev: 'r2', controls: [{ role: 'textbox', name: 'Name', ref: 'name', visible: true }] });

  const result = await executeWorkflow(run, host, { controller: new AbortController(), cancelled: false });
  assert.equal(result.status, 'completed');
  assert.equal(filled, 'Kitten');
});

test('tab binding defers every future-produced alias even when its URL is duplicated', async () => {
  const run = makeRun([
    { id: 'popup', title: 'Popup', op: 'click', tab: 'main', opensTab: 'child', target: button },
  ]);
  run.definition.workflow.tabs.push({ id: 'child', title: 'Child', url: 'https://duplicate.test/' });
  run.bindings = {};
  await assert.doesNotReject(async () => {
    const bindings = await bindWorkflowTabs(run, { tabs: async () => [
      { id: 11, url: 'https://example.test/' },
      { id: 21, url: 'https://duplicate.test/' }, { id: 22, url: 'https://duplicate.test/' },
    ] });
    assert.deepEqual(bindings, { main: 11 });
  });
});

test('popup URL verification observes the child alias, not the source button tab', async () => {
  const visited = [];
  const run = makeRun([], { bindings: { main: 11, popup: 91 } });
  const evidence = await verifyStep({ op: 'check', tab: 'main', check: { type: 'url', equals: 'https://child.test/', tab: 'popup' } }, run,
    hostWith({ observe: async tabId => { visited.push(tabId); return { page: { url: 'https://child.test/' } }; } }), new AbortController().signal);
  assert.equal(evidence.ok, true); assert.deepEqual(visited, [91]);
});

test('an unavailable frame cannot prove an element absent', async () => {
  await assert.rejects(() => verifyStep({ op: 'check', tab: 'main', target: { name: 'Save', frameUrl: 'https://child.test/' }, check: { type: 'absent' } }, makeRun([]),
    hostWith({ observe: async () => ({ controls: [], frames: [{ frameId: 0, url: 'https://example.test/' }] }) }), new AbortController().signal), { code: 'WORKFLOW_FRAME_MISSING' });
});

test('tool output flush failure leaves an uncertain dispatched attempt and never advances', async () => {
  let calls = 0;
  const host = hostWith({ tool: async () => { calls++; return { ok: true, result: 7 }; }, checkpoint: async () => { throw Error('Output store unavailable'); } });
  const result = await executeWorkflow(makeRun([{ id: 'tool', title: 'Write', op: 'tool', tool: {}, check: { type: 'result', equals: 7 } }]), host, { controller: new AbortController() });
  assert.equal(calls, 1); assert.equal(result.nextStep, 0); assert.equal(result.status, 'needs_human'); assert.equal(result.attempt.phase, 'dispatching');
});

test('download failure object is not proof of success and null tool result remains checkable', async () => {
  await assert.rejects(() => verifyStep({ op: 'check', tab: 'main', check: { type: 'download', contains: 'report.csv' } }, makeRun([]), hostWith({ download: async () => ({ ok: false }) }), new AbortController().signal), { code: 'WORKFLOW_CHECK_FAILED' });
  assert.equal((await verifyStep({ op: 'check', check: { type: 'result', equals: null } }, makeRun([]), hostWith(), new AbortController().signal, { ok: true, result: null })).ok, true);
});
