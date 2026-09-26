import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyRisk, decideAccess } from '../src/agent/vnext/host/riskClassify.js';
import { handleWorkspacePageAction, invalidatePageActionTarget } from '../src/agent/vnext/host/pageActionHost.js';
import { resetTabLeases } from '../src/agent/vnext/host/tabLease.js';
import {
  createCallJournal,
  createMemoryCallJournal,
  createUnavailableCallJournal,
  openCallJournal,
  openIndexedDbCallJournal
} from '../src/agent/vnext/host/callJournal.js';
import { gatedDispatch } from '../src/agent/vnext/host/operationGate.js';
import { consumeDispatchTicket, peekDispatchTicket, putDispatchTicket, dropTicketsForExecution } from '../src/agent/vnext/host/dispatchTicket.js';
import { defaultPostconditions, verifyPostconditions, applyVerifyToJournalState } from '../src/agent/vnext/host/postcondition.js';
import { applyExecutionStatus, createExecutionStatus } from '../src/sidepanel/executionStatus.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { installTestPolicy, resetTestPolicy, seedResolvedActionTicket } from './helpers/policyTestKit.mjs';
import { pendingApprovalCount } from '../src/agent/vnext/sessionWorkspace/approvalGate.js';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));

function shopStripeFixture() {
  installTestPolicy();
  resetTabLeases();
  invalidatePageActionTarget(22);
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://shop.example/cart', title: 'Shop' }),
      sendMessage: async (_tabId, message, options) => {
        const frameId = options?.frameId ?? 0;
        if (message.op === 'snapshot') {
          return frameId === 1
            ? { ok: true, controls: [{ ref: 'a1', name: 'Submit', role: 'button' }], frameUrl: 'https://js.stripe.com/v3/controller' }
            : { ok: true, controls: [{ ref: 'a1', name: 'Checkout', role: 'button' }], frameUrl: 'https://shop.example/cart' };
        }
        if (message.op === 'resolve_name') {
          if (frameId === 1 && /submit/i.test(message.name || '')) {
            return { matches: [{ ref: 'a1', name: 'Submit' }] };
          }
          if (frameId === 0 && /checkout/i.test(message.name || '')) {
            return { matches: [{ ref: 'a1', name: 'Checkout' }] };
          }
          return { matches: [] };
        }
        return { ok: true, after: { ref: 'a1' } };
      }
    },
    webNavigation: {
      getFrame: async ({ frameId }) => ({
        frameId,
        documentId: frameId === 1 ? 'doc-stripe' : 'doc-shop',
        documentLifecycle: 'active',
        url: frameId === 1 ? 'https://js.stripe.com/v3/controller' : 'https://shop.example/cart'
      }),
      getAllFrames: async () => [
        { frameId: 0, parentFrameId: -1, documentId: 'doc-shop', url: 'https://shop.example/cart' },
        { frameId: 1, parentFrameId: 0, documentId: 'doc-stripe', url: 'https://js.stripe.com/v3/controller' }
      ]
    },
    scripting: { executeScript: async () => [] }
  };
}

test('P0: top-level shop + Stripe iframe Submit is known payment and never dispatched', async () => {
  shopStripeFixture();
  const snap = await handleWorkspacePageAction({ tabId: 22, sessionId: 's', executionId: 'e', op: 'snapshot' });
  assert.equal(snap.ok, true);
  const stripe = snap.controls.find((row) => row.frameUrl.includes('stripe'));
  assert.ok(stripe);
  assert.equal(stripe.frameUrl, 'https://js.stripe.com/v3/controller');

  const resolved = await handleWorkspacePageAction({
    tabId: 22, sessionId: 's', executionId: 'e', op: 'resolve_intent', targetOp: 'click', name: 'Submit', rev: snap.rev
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.classified.risk, 'payment');
  assert.equal(resolved.classified.confidence, 'known');
  assert.equal(resolved.frameUrl, 'https://js.stripe.com/v3/controller');
  assert.notEqual(resolved.frameUrl, 'https://shop.example/cart');

  const click = { tabId: 22, sessionId: 's', executionId: 'e', op: 'click', name: 'Submit', rev: snap.rev };
  const seeded = await seedResolvedActionTicket(handleWorkspacePageAction, click);
  Object.assign(click, {
    operationId: seeded.operationId,
    ticketNonce: seeded.ticketNonce,
    payloadHash: seeded.payloadHash,
    documentId: seeded.documentId
  });
  const denied = await handleWorkspacePageAction(click);
  assert.equal(denied.code, 'PAYMENT_DENIED');
  resetTestPolicy();
});

test('P1: product journal does not silently fall back to memory', async () => {
  await assert.rejects(() => openIndexedDbCallJournal(null), { code: 'JOURNAL_UNAVAILABLE' });
  const failingIdb = {
    open() {
      const err = Object.assign(new Error('idb open failed'), { code: 'JOURNAL_UNAVAILABLE' });
      throw err;
    }
  };
  await assert.rejects(() => openCallJournal({ indexedDB: failingIdb }), { code: 'JOURNAL_UNAVAILABLE' });
  const memory = await openCallJournal({ memory: true });
  assert.equal(memory.kind, 'memory');
  const blocked = createUnavailableCallJournal();
  let sent = 0;
  const out = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e', tabId: 1, documentId: 'd' },
    { journal: blocked, readPolicy: async () => ({ mode: 'guarded' }), send: async () => { sent += 1; return { ok: true }; } }
  );
  assert.equal(out.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(sent, 0);
});

test('P1: SW recomputes hash and rejects missing bind fields; empty hash cannot seed', async () => {
  installTestPolicy();
  await assert.rejects(
    () => putDispatchTicket({
      operationId: 'op-blank',
      nonce: 'n',
      sessionId: 's',
      executionId: 'e',
      payloadHash: '',
      exp: Date.now() + 1000
    }),
    { code: 'TICKET_REQUIRED' }
  );
  await putDispatchTicket({
    operationId: 'op-hash',
    nonce: 'n',
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'ticket-hash',
    tabId: 9,
    documentId: 'doc',
    risk: 'reversible-write',
    exp: Date.now() + 60_000
  });
  const mismatch = await consumeDispatchTicket(
    {
      operationId: 'op-hash',
      sessionId: 's',
      executionId: 'e',
      payloadHash: 'host-recomputed-different',
      ticketNonce: 'n',
      tabId: 9,
      documentId: 'doc'
    },
    { channel: 'action', op: 'click', name: 'Save', tabId: 9, documentId: 'doc' }
  );
  assert.equal(mismatch.code, 'APPROVAL_MISMATCH');
  resetTestPolicy();
});

test('P1: ref-only delete resolves to known delete so offscreen and SW agree', async () => {
  installTestPolicy();
  resetTabLeases();
  invalidatePageActionTarget(33);
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://mail.example/inbox', title: 'Mail' }),
      sendMessage: async (_tabId, message) => {
        if (message.op === 'snapshot') {
          return { ok: true, controls: [{ ref: 'a1', name: 'Delete', role: 'button' }], frameUrl: 'https://mail.example/inbox' };
        }
        if (message.op === 'resolve_name') return { matches: [{ ref: 'a1', name: 'Delete' }] };
        return { ok: true, after: { ref: 'a1' } };
      }
    },
    webNavigation: {
      getFrame: async () => ({ frameId: 0, documentId: 'doc-mail', documentLifecycle: 'active', url: 'https://mail.example/inbox' }),
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'doc-mail', url: 'https://mail.example/inbox' }]
    },
    scripting: { executeScript: async () => [] }
  };
  const snap = await handleWorkspacePageAction({ tabId: 33, sessionId: 's', executionId: 'e', op: 'snapshot' });
  const resolved = await handleWorkspacePageAction({
    tabId: 33, sessionId: 's', executionId: 'e', op: 'resolve_intent', targetOp: 'click', ref: 'f0.a1', rev: snap.rev
  });
  assert.equal(resolved.classified.risk, 'delete');
  assert.equal(resolved.classified.confidence, 'known');
  assert.equal(resolved.name, 'Delete');
  const unnamed = classifyRisk({ channel: 'action', op: 'click', ref: 'f0.a1' });
  assert.equal(unnamed.confidence, 'unknown');
  assert.notEqual(unnamed.risk, resolved.classified.risk);
  resetTestPolicy();
});

test('P1: payment deny broadcasts policy-blocked, never approval-required', async () => {
  installTestPolicy({ mode: 'full' });
  const journal = createCallJournal(createMemoryCallJournal());
  const events = [];
  const out = await gatedDispatch(
    {
      channel: 'action',
      op: 'click',
      name: 'Submit',
      sessionId: 's',
      executionId: 'e',
      control: { name: 'Submit', frameUrl: 'https://js.stripe.com/v3/controller' }
    },
    { journal, readPolicy: async () => ({ mode: 'full' }), broadcast: (ev) => events.push(ev), send: async () => ({ ok: true }) }
  );
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(events.filter((ev) => ev.type === 'approval-required').length, 0);
  assert.equal(events.filter((ev) => ev.type === 'policy-blocked').length, 1);
  resetTestPolicy();
});

test('P1: verifier stays honest — no postcondition is not verified; delete needs snapshot', async () => {
  const click = { channel: 'action', op: 'click', name: 'Save' };
  assert.deepEqual(defaultPostconditions(click), []);
  const skipped = await verifyPostconditions({
    intent: { channel: 'action', op: 'click' },
    postconditions: [],
    state: 'succeeded'
  }, { facts: { snapshotOk: true, controls: [] } });
  assert.equal(skipped.status, 'skipped');
  assert.equal(applyVerifyToJournalState({ state: 'succeeded' }, skipped), 'succeeded');

  const del = await verifyPostconditions({
    risk: 'delete',
    postconditions: defaultPostconditions({ risk: 'delete', ref: 'f0.a1' }),
    state: 'succeeded'
  }, { facts: { controls: [] } });
  assert.equal(del.status, 'needs_human');

  const send = await verifyPostconditions({
    intent: { channel: 'sys', op: 'fetch', act: 'POST' },
    unprovable: true,
    state: 'succeeded'
  }, { facts: {} });
  assert.equal(send.status, 'needs_human');
  assert.notEqual(send.status, 'verified');
});

test('P1: storage bridge cannot write dispatch tickets; tickets stay on their own messages', () => {
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');
  assert.match(bg, /STORAGE_BRIDGE_DENIED = new Set\(\[DISPATCH_TICKETS_KEY\]\)/);
  assert.match(bg, /workspace_ticket_put/);
  assert.match(bg, /workspace_ticket_drop/);
  const service = readFileSync(join(root, 'src/agent/vnext/service/sessionWorkspaceService.js'), 'utf8');
  assert.match(service, /listJournal/);
  assert.match(service, /exportJournal/);
  assert.match(service, /memoryJournal === true/);
});

test('P1: startup recover drops authorized leftover tickets; abort drops execution tickets', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  await journal.commit({
    operationId: 'op-auth',
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'hh',
    state: 'prepared'
  });
  await journal.update('op-auth', { state: 'authorized' });
  await putDispatchTicket({
    operationId: 'op-auth',
    nonce: 'n',
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'hh',
    tabId: 1,
    documentId: 'd',
    risk: 'reversible-write',
    exp: Date.now() + 60_000
  });
  const dropped = [];
  await journal.recoverOnStartup({
    isExecutionActive: () => false,
    dropTicket: async (id) => { dropped.push(id); await dropTicketsForExecution('s', 'e'); },
    listTickets: async () => [{ operationId: 'op-auth', sessionId: 's', executionId: 'e' }]
  });
  assert.equal((await journal.get('op-auth')).state, 'failed');
  assert.ok(dropped.includes('op-auth'));
  assert.equal(await peekDispatchTicket('op-auth'), null);

  const service = new SessionWorkspaceService({
    store: new SessionWorkspaceStore(),
    memoryJournal: true,
    journal
  });
  service._activeBySession.set('s', { sessionId: 's', executionId: 'e', controller: new AbortController() });
  await putDispatchTicket({
    operationId: 'op-live',
    nonce: 'n2',
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'zz',
    tabId: 1,
    documentId: 'd',
    risk: 'reversible-write',
    exp: Date.now() + 60_000
  });
  await service.abortExecution({ sessionId: 's', executionId: 'e' });
  assert.equal(await peekDispatchTicket('op-live'), null);
  resetTestPolicy();
});

test('P2: approval-done leaves awaiting unless another approval is pending; execution-end clears payment sticky', () => {
  let state = createExecutionStatus({ sessionId: 's' });
  state = applyExecutionStatus(state, { type: 'execution-start', sessionId: 's', executionId: 'e' });
  state = applyExecutionStatus(state, { type: 'approval-required', risk: 'delete', summary: '确认删除', approvalId: 'a1' });
  assert.equal(state.phase, 'awaiting_approval');
  state = applyExecutionStatus(state, { type: 'approval-done', approvalId: 'a1', decision: 'approve' });
  assert.equal(state.phase, 'running');
  assert.equal(state.approvalOpen, false);

  state = applyExecutionStatus(state, { type: 'policy-blocked', kind: 'payment-handoff', summary: '请你接管付款' });
  assert.notEqual(state.phase, 'awaiting_approval');
  assert.equal(state.policyBlocked, 'payment-handoff');
  state = applyExecutionStatus(state, { type: 'execution-end', status: 'completed' });
  assert.equal(state.policyBlocked, null);
});

test('P2: listJournal and exportJournal return real session rows', async () => {
  const journal = createCallJournal(createMemoryCallJournal());
  const service = new SessionWorkspaceService({
    store: new SessionWorkspaceStore(),
    memoryJournal: true,
    journal
  });
  await journal.commit({ operationId: 'op-q', sessionId: 's', state: 'prepared', payloadHash: 'q' });
  const listed = await service.listJournal({ sessionId: 's' });
  assert.equal(listed.operations.length, 1);
  assert.equal(listed.operations[0].operationId, 'op-q');
  const exported = await service.exportJournal({ sessionId: 's' });
  assert.equal(exported.schema, 'browserbot.call-journal/v1');
  assert.equal(exported.operations[0].operationId, 'op-q');
  assert.equal(exported.operations[0].payload, undefined);
});

test('delete approval still waits once after resolve_intent classification', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  const classified = classifyRisk({
    channel: 'action',
    op: 'click',
    name: 'Delete',
    control: { name: 'Delete', frameUrl: 'https://mail.example/inbox' }
  });
  assert.equal(decideAccess(classified), 'approve');
  const events = [];
  const pending = gatedDispatch(
    {
      channel: 'action',
      op: 'click',
      name: 'Delete',
      sessionId: 's',
      executionId: 'e',
      classified,
      payloadHash: 'resolved-hash',
      documentId: 'doc-mail',
      tabId: 33
    },
    { journal, readPolicy: async () => ({ mode: 'guarded' }), broadcast: (ev) => events.push(ev), send: async () => ({ ok: true }) }
  );
  for (let i = 0; i < 80 && pendingApprovalCount() === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(events.filter((ev) => ev.type === 'approval-required').length, 1);
  assert.equal(events[0].risk, 'delete');
  const { abortExecutionApprovals } = await import('../src/agent/vnext/sessionWorkspace/approvalGate.js');
  abortExecutionApprovals('s', 'e');
  await pending;
  resetTestPolicy();
});

function checkoutFillFixture({ nested = false, onlyShop = false } = {}) {
  const state = { mutates: [] };
  const frames = onlyShop
    ? [
        { frameId: 0, parentFrameId: -1, documentId: 'doc-shop', url: 'https://shop.example/cart',
          controls: [{ ref: 'a1', name: 'Email' }, { ref: 'a2', name: 'Full name' }] }
      ]
    : nested
      ? [
          { frameId: 0, parentFrameId: -1, documentId: 'doc-shop', url: 'https://shop.example/cart',
            controls: [{ ref: 'a1', name: 'Email' }] },
          { frameId: 1, parentFrameId: 0, documentId: 'doc-mid', url: 'https://shop.example/embed',
            controls: [{ ref: 'a1', name: 'Note' }] },
          { frameId: 2, parentFrameId: 1, documentId: 'doc-stripe', url: 'https://js.stripe.com/v3/controller',
            controls: [{ ref: 'a1', name: 'Card number' }] }
        ]
      : [
          { frameId: 0, parentFrameId: -1, documentId: 'doc-shop', url: 'https://shop.example/cart',
            controls: [{ ref: 'a1', name: 'Email' }] },
          { frameId: 1, parentFrameId: 0, documentId: 'doc-stripe', url: 'https://js.stripe.com/v3/controller',
            controls: [{ ref: 'a1', name: 'Card number' }] }
        ];
  installTestPolicy();
  resetTabLeases();
  invalidatePageActionTarget(22);
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://shop.example/cart', title: 'Shop' }),
      sendMessage: async (_tabId, message, options) => {
        const frameId = options?.frameId ?? 0;
        const frame = frames.find((row) => row.frameId === frameId);
        if (message.op === 'snapshot') {
          return { ok: true, controls: frame?.controls || [], frameUrl: frame?.url || '' };
        }
        if (message.op === 'resolve_name') {
          const hit = (frame?.controls || []).find((row) => row.name === message.name);
          return { matches: hit ? [{ ref: hit.ref, name: hit.name }] : [] };
        }
        if (message.op === 'fill_form') {
          state.mutates.push({ frameId, fields: message.fields });
          return { ok: true, results: (message.fields || []).map((field) => ({ ok: true, ref: field.ref })) };
        }
        return { ok: true, after: { ref: 'a1' } };
      }
    },
    webNavigation: {
      getFrame: async ({ frameId }) => {
        const frame = frames.find((row) => row.frameId === frameId) || frames[0];
        return { frameId, documentId: frame.documentId, documentLifecycle: 'active', url: frame.url };
      },
      getAllFrames: async () => frames
    },
    scripting: { executeScript: async () => [] }
  };
  return state;
}

async function denyFillForm(fields, { mode } = {}) {
  if (mode === 'full') installTestPolicy({ mode: 'full' });
  const snap = await handleWorkspacePageAction({ tabId: 22, sessionId: 's', executionId: 'e', op: 'snapshot' });
  const resolved = await handleWorkspacePageAction({
    tabId: 22, sessionId: 's', executionId: 'e', op: 'resolve_intent', targetOp: 'fill_form', fields, rev: snap.rev
  });
  const out = await handleWorkspacePageAction({
    tabId: 22, sessionId: 's', executionId: 'e', op: 'fill_form', fields, rev: snap.rev
  });
  return { snap, resolved, out };
}

test('P0: shop email + Stripe card fill_form is payment and no frame is written', async () => {
  for (const mode of ['guarded', 'full']) {
    const state = checkoutFillFixture();
    const { resolved, out } = await denyFillForm(
      [{ name: 'Email', value: 'a@b.com' }, { name: 'Card number', value: '4242' }],
      { mode }
    );
    assert.equal(resolved.classified.risk, 'payment');
    assert.equal(resolved.classified.confidence, 'known');
    assert.ok(resolved.frames.some((frame) => /stripe/i.test(frame.frameUrl)));
    assert.ok(resolved.frames.some((frame) => /shop\.example/i.test(frame.frameUrl)));
    assert.equal(out.code, 'PAYMENT_DENIED');
    assert.equal(state.mutates.length, 0);
    resetTestPolicy();
  }
});

test('P0: Stripe-first then shop fill_form is still payment with zero writes', async () => {
  const state = checkoutFillFixture();
  const { resolved, out } = await denyFillForm([
    { name: 'Card number', value: '4242' },
    { name: 'Email', value: 'a@b.com' }
  ]);
  assert.equal(resolved.classified.risk, 'payment');
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(state.mutates.length, 0);
  resetTestPolicy();
});

test('P0: nested shop → middle → Stripe leaf fill_form denies the whole batch', async () => {
  const state = checkoutFillFixture({ nested: true });
  const { resolved, out } = await denyFillForm([
    { name: 'Email', value: 'a@b.com' },
    { name: 'Note', value: 'gift' },
    { name: 'Card number', value: '4242' }
  ]);
  assert.equal(resolved.classified.risk, 'payment');
  assert.ok(resolved.frames.length >= 2);
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(state.mutates.length, 0);
  resetTestPolicy();
});

test('P0: ordinary same-frame fill_form still writes after a ticket', async () => {
  const state = checkoutFillFixture({ onlyShop: true });
  const req = {
    tabId: 22,
    sessionId: 's',
    executionId: 'e',
    op: 'fill_form',
    fields: [{ name: 'Email', value: 'a@b.com' }, { name: 'Full name', value: 'Ada' }]
  };
  const snap = await handleWorkspacePageAction({ ...req, op: 'snapshot' });
  req.rev = snap.rev;
  const seeded = await seedResolvedActionTicket(handleWorkspacePageAction, req);
  Object.assign(req, {
    operationId: seeded.operationId,
    ticketNonce: seeded.ticketNonce,
    payloadHash: seeded.payloadHash,
    documentId: seeded.documentId
  });
  const out = await handleWorkspacePageAction(req);
  assert.equal(out.ok, true);
  assert.equal(state.mutates.length, 1);
  assert.equal(state.mutates[0].frameId, 0);
  assert.equal(state.mutates[0].fields.length, 2);
  resetTestPolicy();
});

test('P1: abort after ticket and before send drops the ticket and is not dispatched', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  const ac = new AbortController();
  let sent = 0;
  const tickets = new Map();
  const out = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e', tabId: 1, documentId: 'd' },
    {
      journal,
      signal: ac.signal,
      readPolicy: async () => ({ mode: 'guarded' }),
      putTicket: async (ticket) => {
        tickets.set(ticket.operationId, ticket);
        ac.abort();
      },
      dropTicket: async (id) => { tickets.delete(id); },
      send: async () => { sent += 1; return { ok: true }; }
    }
  );
  assert.equal(out.code, 'SYS_ABORTED');
  assert.equal(sent, 0);
  assert.equal(tickets.size, 0);
  const row = (await journal.listBySession('s'))[0];
  assert.ok(row);
  assert.notEqual(row.state, 'dispatched');
  assert.equal(row.state, 'failed');
  assert.equal(row.outcome, 'aborted');
  resetTestPolicy();
});

test('P1: untrusted classified is ignored so offscreen cannot fake a payment as Save', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  let sent = 0;
  const out = await gatedDispatch(
    {
      channel: 'action',
      op: 'click',
      name: 'Pay now',
      sessionId: 's',
      executionId: 'e',
      classified: { risk: 'reversible-write', confidence: 'known', summary: 'fake' }
    },
    { journal, readPolicy: async () => ({ mode: 'full' }), send: async () => { sent += 1; return { ok: true }; } }
  );
  assert.equal(out.code, 'PAYMENT_DENIED');
  assert.equal(sent, 0);
  resetTestPolicy();
});
