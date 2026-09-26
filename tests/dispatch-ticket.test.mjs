import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeDispatchTicket, putDispatchTicket, dropTicketsForExecution, peekDispatchTicket } from '../src/agent/vnext/host/dispatchTicket.js';
import { installTestPolicy, resetTestPolicy } from './helpers/policyTestKit.mjs';

function bind(extra = {}) {
  return {
    sessionId: 's',
    executionId: 'e',
    payloadHash: 'h',
    ticketNonce: 'nonce-1',
    tabId: 11,
    documentId: 'doc-a',
    ...extra
  };
}

async function seed(operationId, extra = {}) {
  const req = bind(extra);
  await putDispatchTicket({
    operationId,
    nonce: req.ticketNonce,
    sessionId: req.sessionId,
    executionId: req.executionId,
    risk: extra.risk || 'reversible-write',
    payloadHash: req.payloadHash,
    tabId: extra.omitTab ? undefined : req.tabId,
    documentId: extra.omitDoc ? undefined : req.documentId,
    exp: extra.exp || Date.now() + 60_000
  });
  return req;
}

test('SW last door denies known payment even with a ticket, and one-shot consume', async () => {
  installTestPolicy({ mode: 'full' });
  const pay = await seed('op-pay', { risk: 'payment' });
  const denied = await consumeDispatchTicket(
    { operationId: 'op-pay', ...pay },
    { channel: 'action', op: 'click', name: 'Pay now', tabId: 11, documentId: 'doc-a' }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PAYMENT_DENIED');

  const save = await seed('op-save');
  const first = await consumeDispatchTicket(
    { operationId: 'op-save', ...save },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  );
  assert.equal(first.ok, true);
  const second = await consumeDispatchTicket(
    { operationId: 'op-save', ...save },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  );
  assert.equal(second.code, 'TICKET_REQUIRED');
  resetTestPolicy();
});

test('ticket owner, hash, nonce, tab, and document are hard-bound; raw code still needs a ticket', async () => {
  installTestPolicy();
  await seed('op-x');
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-x', ...bind({ sessionId: 's2' }) },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  )).code, 'APPROVAL_MISMATCH');

  await seed('op-y');
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-y', ...bind({ payloadHash: 'zzz' }) },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  )).code, 'APPROVAL_MISMATCH');

  await seed('op-n');
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-n', ...bind({ ticketNonce: '' }) },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  )).code, 'APPROVAL_MISMATCH');

  await seed('op-z', { exp: Date.now() - 1 });
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-z', ...bind() },
    { channel: 'action', op: 'click', name: 'Save', tabId: 11, documentId: 'doc-a' }
  )).code, 'APPROVAL_EXPIRED');

  await seed('op-del', { risk: 'reversible-write' });
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-del', ...bind() },
    { channel: 'action', op: 'click', name: 'Delete', tabId: 11, documentId: 'doc-a' }
  )).code, 'APPROVAL_MISMATCH');

  // Raw page code is no longer refused by mode; it still needs its own valid ticket.
  assert.equal((await consumeDispatchTicket(
    { operationId: 'op-eval', sessionId: 's', executionId: 'e', payloadHash: 'h', ticketNonce: 'n' },
    { channel: 'sys', op: 'eval', code: 'return 1' }
  )).code, 'TICKET_REQUIRED');
  resetTestPolicy();
});

test('empty hash cannot be stored; leftover tickets drop with the execution', async () => {
  installTestPolicy();
  await assert.rejects(
    () => putDispatchTicket({
      operationId: 'op-empty',
      nonce: 'n',
      sessionId: 's',
      executionId: 'e',
      payloadHash: '',
      exp: Date.now() + 1000
    }),
    { code: 'TICKET_REQUIRED' }
  );
  await seed('op-left');
  assert.ok(await peekDispatchTicket('op-left'));
  assert.equal(await dropTicketsForExecution('s', 'e'), 1);
  assert.equal(await peekDispatchTicket('op-left'), null);
  resetTestPolicy();
});
