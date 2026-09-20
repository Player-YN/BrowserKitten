import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallJournal, createMemoryCallJournal } from '../src/agent/vnext/host/callJournal.js';
import { gatedDispatch } from '../src/agent/vnext/host/operationGate.js';
import { peekDispatchTicket } from '../src/agent/vnext/host/dispatchTicket.js';
import { abortExecutionApprovals, pendingApprovalCount } from '../src/agent/vnext/sessionWorkspace/approvalGate.js';

async function waitForWaiter() {
  for (let i = 0; i < 80; i += 1) {
    if (pendingApprovalCount() > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('approval waiter was not registered');
}
import { installTestPolicy, resetTestPolicy } from './helpers/policyTestKit.mjs';

test('Guarded allows known Save, blocks raw; Full Access allows raw; payment never dispatches', async () => {
  const areas = installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  const sent = [];
  const save = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e', tabId: 1 },
    {
      journal,
      readPolicy: async () => ({ mode: 'guarded' }),
      putTicket: async (ticket) => areas.session.set({ browserbot_dispatch_tickets_v1: { [ticket.operationId]: ticket } }),
      send: async (req) => { sent.push(req); return { ok: true }; }
    }
  );
  assert.equal(save.ok, true);
  assert.equal(sent.length, 1);

  const rawGuarded = await gatedDispatch(
    { channel: 'sys', op: 'eval', code: 'return 1', sessionId: 's', executionId: 'e' },
    { journal, readPolicy: async () => ({ mode: 'guarded' }), send: async () => { sent.push('raw'); return { ok: true }; } }
  );
  assert.equal(rawGuarded.code, 'RAW_ESCAPE_DENIED');
  assert.equal(sent.includes('raw'), false);

  const rawFull = await gatedDispatch(
    { channel: 'sys', op: 'eval', code: 'return 1', sessionId: 's', executionId: 'e' },
    {
      journal,
      readPolicy: async () => ({ mode: 'full' }),
      putTicket: async () => {},
      send: async () => { sent.push('raw-full'); return { ok: true }; }
    }
  );
  assert.equal(rawFull.ok, true);
  assert.ok(sent.includes('raw-full'));

  const events = [];
  const pay = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Pay now', sessionId: 's', executionId: 'e' },
    {
      journal,
      readPolicy: async () => ({ mode: 'full' }),
      broadcast: (ev) => events.push(ev),
      send: async () => { sent.push('pay'); return { ok: true }; }
    }
  );
  assert.equal(pay.code, 'PAYMENT_DENIED');
  assert.equal(sent.includes('pay'), false);
  assert.equal(events.some((ev) => ev.type === 'approval-required'), false);
  assert.equal(events.some((ev) => ev.type === 'policy-blocked' && ev.kind === 'payment-handoff'), true);
  assert.match(events.find((ev) => ev.type === 'policy-blocked').summary, /请你接管付款/);
  const row = (await journal.listBySession('s')).find((item) => item.risk === 'payment');
  assert.equal(row.state, 'failed');
  resetTestPolicy();
});

test('known delete without approval never reaches send; unknown Full Access does', async () => {
  installTestPolicy({ mode: 'full' });
  const journal = createCallJournal(createMemoryCallJournal());
  let sent = 0;
  const pending = gatedDispatch(
    { channel: 'action', op: 'click', name: 'Delete', sessionId: 's', executionId: 'e' },
    { journal, readPolicy: async () => ({ mode: 'full' }), send: async () => { sent += 1; return { ok: true }; } }
  );
  await waitForWaiter();
  const waiting = (await journal.listBySession('s')).find((row) => row.risk === 'delete');
  assert.equal(waiting.state, 'awaiting_approval');
  assert.equal(sent, 0);
  abortExecutionApprovals('s', 'e');
  assert.equal((await pending).ok, false);
  const unknown = await gatedDispatch(
    { channel: 'action', op: 'click', sessionId: 's', executionId: 'e2' },
    { journal, readPolicy: async () => ({ mode: 'full' }), putTicket: async () => {}, send: async () => { sent += 1; return { ok: true }; } }
  );
  assert.equal(unknown.ok, true);
  resetTestPolicy();
});

test('ticket put failure after authorize does not dispatch', async () => {
  installTestPolicy();
  const journal = createCallJournal(createMemoryCallJournal());
  let sent = 0;
  const out = await gatedDispatch(
    { channel: 'action', op: 'click', name: 'Save', sessionId: 's', executionId: 'e' },
    {
      journal,
      readPolicy: async () => ({ mode: 'guarded' }),
      putTicket: async () => {
        const err = new Error('ticket store down');
        err.code = 'TICKET_REQUIRED';
        throw err;
      },
      send: async () => { sent += 1; return { ok: true }; }
    }
  );
  assert.ok(['JOURNAL_UNAVAILABLE', 'TICKET_REQUIRED'].includes(out.code));
  assert.equal(sent, 0);
  assert.equal(await peekDispatchTicket('missing'), null);
  resetTestPolicy();
});
