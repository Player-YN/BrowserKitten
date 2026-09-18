import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageSnapshotRegistry, readDocumentTarget } from '../src/agent/vnext/host/documentTarget.js';
import { handleWorkspacePageAction, invalidatePageActionTarget } from '../src/agent/vnext/host/pageActionHost.js';
import { resetTabLeases } from '../src/agent/vnext/host/tabLease.js';
import { installTestPolicy, seedResolvedActionTicket } from './helpers/policyTestKit.mjs';

function fixture() {
  installTestPolicy();
  resetTabLeases(); invalidatePageActionTarget(11);
  const state = { documentId: 'doc-a', url: 'https://example.com/a', clicks: 0, calls: [], loseReply: false, emptyReply: false, failObserve: false };
  globalThis.chrome = {
    tabs: {
      get: async id => ({ id, url: state.url, title: 'Test page' }),
      sendMessage: async (tabId, message, options) => {
        state.calls.push({ tabId, message, options });
        if (message.action === 'ping') return { status: 'pong' };
        if (options.documentId !== state.documentId) throw new Error('No such document');
        if (message.op === 'snapshot') {
          if (state.failObserve && state.clicks) throw new Error('page unloading');
          return { ok: true, controls: [{ ref: 'a1', name: 'Save' }], frameUrl: state.url, mediaElements: state.mediaElements || [] };
        }
        if (message.op === 'resolve_name') return { matches: [{ ref: 'a1', name: 'Save' }] };
        state.clicks++;
        if (state.loseReply) throw new Error('The message port closed');
        if (state.emptyReply) return undefined;
        return { ok: true, after: { ref: 'a1' } };
      }
    },
    webNavigation: {
      getFrame: async () => ({ frameId: 0, documentId: state.documentId, documentLifecycle: 'active', url: state.url }),
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: state.documentId, url: state.url }]
    },
    scripting: { executeScript: async () => [] }
  };
  return state;
}
const request = params => ({ tabId: 11, sessionId: 's', executionId: 'e', ...params });
async function mutate(params) {
  const req = request(params);
  const seeded = await seedResolvedActionTicket(handleWorkspacePageAction, req);
  if (seeded.resolved && seeded.resolved.ok === false) return seeded.resolved;
  Object.assign(req, {
    operationId: seeded.operationId,
    ticketNonce: seeded.ticketNonce,
    payloadHash: seeded.payloadHash,
    documentId: seeded.documentId
  });
  return handleWorkspacePageAction(req);
}

test('same URL with a different documentId is a different target', async () => {
  const state = fixture(); const old = await readDocumentTarget(chrome, 11);
  state.documentId = 'doc-b';
  await assert.rejects(readDocumentTarget(chrome, 11, 0, old), { code: 'TARGET_CHANGED' });
});
test('snapshot revisions never repeat across independent registries and invalidation requires re-observe', () => {
  const one = createPageSnapshotRegistry(), two = createPageSnapshotRegistry();
  const a = one.capture(11, [{ frameId: 0, documentId: 'd' }]);
  const b = two.capture(11, [{ frameId: 0, documentId: 'd' }]);
  assert.notEqual(a.rev, b.rev); one.invalidate(11);
  assert.throws(() => one.require(11, a.rev), { code: 'STALE_REF' });
});
test('all page mutations, including name and bare press, require a snapshot revision', async () => {
  const state = fixture();
  for (const input of [{ op: 'click', name: 'Save' }, { op: 'press', key: 'Enter' }, { op: 'click', ref: 'f0.a1' }]) {
    assert.equal((await handleWorkspacePageAction(request(input))).code, 'STALE_REF');
  }
  assert.equal(state.clicks, 0);
});
test('snapshot and mutation route messages to the exact documentId', async () => {
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  assert.equal(snap.ok, true); assert.equal(snap.documentId, 'doc-a');
  const out = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  assert.equal(out.ok, true); assert.equal(state.clicks, 1); assert.notEqual(out.rev, snap.rev);
  const click = state.calls.find(call => call.message.op === 'click');
  assert.deepEqual(click.options, { frameId: 0, documentId: 'doc-a' });
});
test('navigation and SPA route changes reject old snapshot before any mutation is sent', async () => {
  for (const change of ['documentId', 'url']) {
    const state = fixture(); const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
    state[change] = change === 'documentId' ? 'doc-b' : 'https://example.com/b';
    const out = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
    assert.equal(out.code, 'TARGET_CHANGED'); assert.equal(state.clicks, 0);
  }
});
test('same-execution simultaneous clicks serialize; the second stale rev is not dispatched', async () => {
  const state = fixture(); const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  const input = request({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  const seeded = await seedResolvedActionTicket(handleWorkspacePageAction, input);
  Object.assign(input, {
    operationId: seeded.operationId,
    ticketNonce: seeded.ticketNonce,
    payloadHash: seeded.payloadHash,
    documentId: seeded.documentId
  });
  const [one, two] = await Promise.all([handleWorkspacePageAction(input), handleWorkspacePageAction(input)]);
  assert.equal(one.ok, true); assert.equal(two.code, 'STALE_REF'); assert.equal(state.clicks, 1);
});
test('lost or empty mutation reply is unknown, never reported as success or retried', async () => {
  for (const loss of ['loseReply', 'emptyReply']) {
    const state = fixture(); const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
    state[loss] = true;
    const out = await mutate({ op: 'click', name: 'Save', rev: snap.rev });
    assert.equal(out.code, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(out.outcome, 'unknown'); assert.equal(state.clicks, 1);
  }
});
test('failure to observe after a confirmed action is not falsely reported as a failed action', async () => {
  const state = fixture(); const snap = await handleWorkspacePageAction(request({ op: 'snapshot' })); state.failObserve = true;
  const out = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  assert.equal(out.ok, true); assert.equal(out.observationError.code, 'NEED_PAGE'); assert.equal(out.rev, undefined);
  assert.equal(state.clicks, 1);
});
test('missing document identity fails closed rather than falling back to a frameId', async () => {
  fixture(); chrome.webNavigation.getFrame = async () => ({ frameId: 0, url: 'https://example.com/a' });
  assert.equal((await handleWorkspacePageAction(request({ op: 'snapshot' }))).code, 'DOCUMENT_UNAVAILABLE');
});

test('form receipt loss propagates unknown at the top level without resubmission', async () => {
  const state = fixture(); const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  state.emptyReply = true;
  const out = await mutate({ op: 'fill_form', rev: snap.rev, fields: [{ ref: 'f0.a1', value: 'x' }] });
  assert.equal(out.ok, false); assert.equal(out.code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(out.outcome, 'unknown'); assert.equal(out.partial, true); assert.equal(state.clicks, 1);
});


test('snapshot transports bounded media evidence with frame/document identity', async () => {
  const state = fixture();
  state.mediaElements = Array.from({ length: 9 }, () => ({ kind: 'video', paused: false, sourceKind: 'stream' }));
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  assert.equal(snap.ok, true);
  assert.equal(snap.mediaElements.length, 6);
  assert.equal(snap.mediaElements[0].frameId, 0);
  assert.equal(snap.mediaElements[0].documentId, 'doc-a');
  assert.equal(snap.mediaElements[0].sourceKind, 'stream');
});
