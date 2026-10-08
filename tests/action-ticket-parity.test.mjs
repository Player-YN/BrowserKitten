/**
 * Offscreen and SW must hash and classify the same canonical action payload.
 * The offscreen service and the SW page-action host run in different JS realms in
 * Chrome; the SW host is imported here under a second module URL so its in-memory
 * control map is NOT shared with the offscreen copy (as in production). Ticket
 * storage (chrome.storage.session) is shared, as in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { resetTabLeases } from '../src/agent/vnext/host/tabLease.js';
import { installTestPolicy, resetTestPolicy } from './helpers/policyTestKit.mjs';
import { runOffscreenChoose } from '../src/agent/vnext/sessionWorkspace/chooseAction.js';
import { runDelegateLoop } from '../src/agent/vnext/sessionWorkspace/delegateExecutor.js';

const sw = await import('../src/agent/vnext/host/pageActionHost.js?realm=sw');

const TAB = 41;
const SID = 's-parity';
const EID = 'e-parity';

function pageFixture() {
  const state = { page: 1, mutates: [] };
  const docId = () => `doc-${state.page}`;
  const url = () => `https://shop.example/list?page=${state.page}`;
  const controls = () => [
    { ref: 'a1', name: 'Next page', role: 'link' },
    { ref: 'a2', name: 'Search', role: 'textbox' },
    { ref: 'a3', name: 'Sort', role: 'combobox', options: ['Price', 'Name'] },
    { ref: 'a4', name: 'Delete', role: 'button' },
    { ref: 'a5', name: 'Pay now', role: 'button' },
    { ref: 'a6', name: `Item ${state.page}`, role: 'link' }
  ];
  installTestPolicy();
  resetTabLeases();
  sw.invalidatePageActionTarget(TAB);
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: url(), title: `List ${state.page}` }),
      sendMessage: async (_tabId, message) => {
        if (message.op === 'snapshot') return { ok: true, controls: controls(), frameUrl: url(), title: `List ${state.page}` };
        if (message.op === 'resolve_name') {
          const hit = controls().find((row) => row.name === message.name);
          return { matches: hit ? [{ ref: hit.ref, name: hit.name }] : [] };
        }
        if (!['click', 'fill', 'select', 'fill_form', 'press', 'scroll'].includes(message.op)) return { ok: true };
        state.mutates.push({ op: message.op, ref: message.ref, value: message.value, fields: message.fields });
        if (message.op === 'click' && message.ref === 'a1') state.page += 1;
        if (message.op === 'fill_form') {
          return { ok: true, results: (message.fields || []).map((field) => ({ ok: true, ref: field.ref })) };
        }
        return { ok: true, after: { ref: message.ref } };
      }
    },
    webNavigation: {
      getFrame: async ({ frameId }) => ({ frameId, documentId: docId(), documentLifecycle: 'active', url: url() }),
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: docId(), url: url() }]
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    },
    runtime: {
      // Offscreen → SW bridge. Only page actions are routed; tickets use the shared session store.
      sendMessage: async (message) => {
        if (message?.action === 'workspace_page_action') {
          const { target: _t, action: _a, ...request } = message;
          return sw.handleWorkspacePageAction(request);
        }
        return { ok: false, code: 'UNROUTED' };
      }
    }
  };
  const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), memoryJournal: true });
  const host = (payload) => service._gatedPageAction({ sessionId: SID, executionId: EID, tabId: TAB, ...payload }, SID);
  return { state, service, host };
}

const BASE = { sessionId: SID, executionId: EID, tabId: TAB };

function jevPicking(name) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const ref = Object.entries(body.questions.pick.criteria).find(([, label]) => label.startsWith(name))?.[0];
    return { ok: true, json: async () => ({ answers: { pick: { choice: ref || 'abstain' } } }) };
  };
}

const JEV_SETTINGS = { jev: { apiKey: 'k', apiBase: 'https://jev.example/v1', model: 'm' }, jevProviderId: 'p', jevProviderName: 'Jev' };

async function snapshot(host) {
  const snap = await host({ op: 'snapshot', observe: 'none' });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  return snap;
}


test('choose (unique name): every step is its own ticketed click and passes the SW last door', async () => {
  const { state, service, host } = pageFixture();
  const out = await runOffscreenChoose({ host, base: BASE, input: { subgoal: 'Next page', until: 'page=3', maxSteps: 4 } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.reason, 'arrived');
  assert.deepEqual(state.mutates.map((row) => [row.op, row.ref]), [['click', 'a1'], ['click', 'a1']]);
  const rows = (await service._journal.listBySession(SID)).filter((row) => row.intent?.op === 'click');
  assert.equal(rows.length, 2, 'one journal row and one ticket per click');
  assert.notEqual(rows[0].operationId, rows[1].operationId);
  assert.ok(rows.every((row) => row.risk === 'reversible-write'));
  resetTestPolicy();
});

test('choose (System1 pick): navigation click is dispatched', async () => {
  const { state, host } = pageFixture();
  const out = await runOffscreenChoose({
    host, base: BASE, input: { subgoal: 'go to the following page', until: 'page=2' },
    settings: JEV_SETTINGS, fetchImpl: jevPicking('Next page'), byokAllowed: async () => true
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.steps[0].via, 'Jev');
  assert.deepEqual(state.mutates.map((row) => row.op), ['click']);
  resetTestPolicy();
});

test('choose: System1 picking a payment or delete control is refused with zero page writes', async () => {
  for (const [name, code] of [['Pay now', 'PAYMENT_DENIED'], ['Delete', 'DELETE_NEEDS_PLANNER']]) {
    const { state, host } = pageFixture();
    const out = await runOffscreenChoose({
      host, base: BASE, input: { subgoal: 'finish up' },
      settings: JEV_SETTINGS, fetchImpl: jevPicking(name), byokAllowed: async () => true
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, code);
    assert.equal(state.mutates.length, 0);
    resetTestPolicy();
  }
});

test('payment click is still denied by the gate when sent directly by ref', async () => {
  const { state, host } = pageFixture();
  const snap = await snapshot(host);
  const out = await host({ op: 'click', ref: 'f0.a5', rev: snap.rev });
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(state.mutates.length, 0);
  resetTestPolicy();
});

test('SW no longer runs a choose loop under one ticket', async () => {
  const { state } = pageFixture();
  const out = await sw.handleWorkspacePageAction({ ...BASE, op: 'choose', subgoal: 'Next page' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_INPUT');
  assert.equal(state.mutates.length, 0);
  resetTestPolicy();
});

for (const [label, payload, expectOp] of [
  ['click', { op: 'click', ref: 'f0.a6' }, 'click'],
  ['fill', { op: 'fill', ref: 'f0.a2', value: 'socks' }, 'fill'],
  ['select', { op: 'select', ref: 'f0.a3', value: 'Name' }, 'select'],
  ['fill_form', { op: 'fill_form', fields: [{ ref: 'f0.a2', value: 'socks' }] }, 'fill_form']
]) {
  test(`ref-only ${label} (no name) passes the SW last door`, async () => {
    const { state, host } = pageFixture();
    const snap = await snapshot(host);
    const out = await host({ ...payload, rev: snap.rev });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(state.mutates.map((row) => row.op), [expectOp]);
    resetTestPolicy();
  });
}

test('delegate-style ref-only steps (rev from its own snapshot) pass the last door', async () => {
  const { state, host } = pageFixture();
  let n = 0;
  const out = await runDelegateLoop({
    subgoal: 'search socks then go on',
    until: 'page=2',
    data: [{ field: 'Search', value: 'socks' }],
    maxSteps: 4,
    tabId: TAB,
    observe: async () => {
      const snap = await host({ ...BASE, op: 'snapshot', observe: 'none' });
      return { ok: true, rev: snap.rev, page: snap.page, controls: snap.controls };
    },
    decide: async () => {
      n += 1;
      return { ok: true, text: n === 1 ? '{"action":"fill","ref":"f0.a2","value":"socks"}' : '{"action":"click","ref":"f0.a1"}' };
    },
    act: (step, snap) => host({ ...BASE, op: step.op, rev: snap.rev, ref: step.ref, value: step.value, observe: 'none' })
  });
  assert.equal(out.status, 'arrived', JSON.stringify(out));
  assert.deepEqual(state.mutates.map((row) => row.op), ['fill', 'click']);
  resetTestPolicy();
});

test('a click ticket cannot be replayed on another tab or another execution', async () => {
  for (const variant of ['tab', 'execution']) {
    const { state, host } = pageFixture();
    const snap = await snapshot(host);
    let captured = null;
    const bridge = globalThis.chrome.runtime.sendMessage;
    globalThis.chrome.runtime.sendMessage = async (message) => {
      if (message?.op === 'click' && message.operationId) {
        captured = message;
        return { ok: false, code: 'HELD' };
      }
      return bridge(message);
    };
    await host({ op: 'click', ref: 'f0.a6', rev: snap.rev });
    globalThis.chrome.runtime.sendMessage = bridge;
    assert.ok(captured?.operationId && captured.ticketNonce);
    const { target: _t, action: _a, ...request } = captured;
    resetTabLeases();
    let replay;
    if (variant === 'tab') {
      const other = await sw.handleWorkspacePageAction({ ...BASE, tabId: 42, op: 'snapshot' });
      replay = await sw.handleWorkspacePageAction({ ...request, tabId: 42, rev: other.rev });
    } else {
      replay = await sw.handleWorkspacePageAction({ ...request, executionId: 'e-other' });
    }
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'APPROVAL_MISMATCH', `${variant}: ${JSON.stringify(replay)}`);
    assert.equal(state.mutates.length, 0);
    resetTestPolicy();
  }
});
