import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactActionControls,
  shouldAttachPageScreenshot,
  isNewPageObservation,
  actionToModelOutput,
  screenshotToModelParts,
  actionResultToModelFacts
} from '../src/agent/vnext/sessionWorkspace/actionObserve.js';
import { sessionToolToModelOutput } from '../src/agent/vnext/sessionWorkspace/canvasPreview.js';
import { handleWorkspacePageAction, invalidatePageActionTarget } from '../src/agent/vnext/host/pageActionHost.js';
import { resetTabLeases, releaseTabLeasesByExecution } from '../src/agent/vnext/host/tabLease.js';
import { classifyRisk } from '../src/agent/vnext/host/riskClassify.js';
import { installTestPolicy, seedResolvedActionTicket } from './helpers/policyTestKit.mjs';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createGuestSys } from '../src/agent/vnext/sessionWorkspace/browserSys.js';
import { loadSkillInstructions } from '../src/agent/vnext/skills/registry.js';
import { buildWorldStateBlock } from '../src/agent/vnext/sessionWorkspace/prompt.js';
import { projectToolOutputForWire } from '../src/agent/vnext/sessionWorkspace/wireTranscript.js';

function modelFacts(out) {
  assert.equal(out.type, 'content');
  const text = out.value.find((p) => p.type === 'text' && p.text);
  assert.ok(text, 'dual output needs a facts text part');
  return JSON.parse(text.text);
}

function fixture(opts = {}) {
  installTestPolicy({ mode: opts.mode });
  resetTabLeases();
  invalidatePageActionTarget(11);
  const state = {
    documentId: 'doc-a',
    url: 'https://example.com/a',
    clicks: 0,
    calls: [],
    frames: opts.frames || [
      { frameId: 0, parentFrameId: -1, documentId: 'doc-a', url: 'https://example.com/a' }
    ],
    failObserve: false,
    captureCalls: 0,
    debuggerAttaches: 0
  };
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: state.url, title: 'Test page', windowId: 1 }),
      query: async () => [{ id: 11, windowId: 1 }],
      sendMessage: async (tabId, message, options) => {
        state.calls.push({ tabId, message, options });
        if (message.action === 'ping') return { status: 'pong' };
        if (options?.documentId && options.documentId !== state.documentId) throw new Error('No such document');
        if (message.op === 'snapshot') {
          if (state.failObserve && state.clicks) throw new Error('page unloading');
          const frameId = options?.frameId ?? 0;
          return {
            ok: true,
            controls: frameId === 0 ? [{ ref: 'a1', name: 'Save', role: 'button' }] : [{ ref: 'a1', name: 'Iframe', role: 'button' }],
            frameUrl: state.url,
            canvasCount: opts.canvasCount || 0
          };
        }
        if (message.op === 'resolve_name') return { matches: [{ ref: 'a1', name: 'Save' }] };
        if (message.op === 'pointer') {
          state.clicks++;
          return { ok: true, methodUsed: 'point', x: message.x, y: message.y, after: { source: 'point' } };
        }
        state.clicks++;
        return { ok: true, after: { ref: 'a1' } };
      },
      captureVisibleTab: async () => {
        state.captureCalls++;
        return 'data:image/jpeg;base64,abc123';
      }
    },
    webNavigation: {
      getFrame: async ({ frameId } = {}) => {
        const fr = state.frames.find((row) => Number(row.frameId) === Number(frameId ?? 0)) || state.frames[0];
        return {
          frameId: fr.frameId,
          documentId: fr.documentId || state.documentId,
          documentLifecycle: 'active',
          url: fr.url || state.url
        };
      },
      getAllFrames: async () => state.frames
    },
    scripting: { executeScript: async () => [] },
    debugger: {
      attach: async () => { state.debuggerAttaches++; },
      detach: async () => {},
      sendCommand: async () => ({ cssLayoutViewport: { clientWidth: 100, clientHeight: 100 } })
    }
  };
  return state;
}

const request = (params) => ({ tabId: 11, sessionId: 's', executionId: 'e', ...params });

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

test('compact action controls drop options and cap rows', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({ ref: `f0.a${i}`, name: 'n'.repeat(200), role: 'button', options: ['a', 'b'], frameUrl: 'https://x' });
  }
  const compact = compactActionControls(rows);
  assert.equal(compact.length, 40);
  assert.equal(compact[0].name.length, 120);
  assert.equal(compact[0].options, undefined);
  assert.equal(compact[0].frameUrl, undefined);
});

test('shouldAttachPageScreenshot is smart: form click no, empty/nav/unobserved/explicit yes', () => {
  assert.equal(shouldAttachPageScreenshot({ controlCount: 12, canvasCount: 0 }), false);
  assert.equal(shouldAttachPageScreenshot({ controlCount: 0 }), true);
  assert.equal(shouldAttachPageScreenshot({ controlCount: 3, canvasCount: 2 }), true);
  assert.equal(shouldAttachPageScreenshot({ observe: 'screenshot', controlCount: 20 }), true);
  assert.equal(shouldAttachPageScreenshot({ observe: 'none', controlCount: 0 }), false);
  assert.equal(shouldAttachPageScreenshot({ observe: 'controls', controlCount: 12 }), false);
  assert.equal(shouldAttachPageScreenshot({
    page: { url: 'https://a.com/x', documentId: '2' },
    previousPage: { url: 'https://a.com/y', documentId: '1' },
    controlCount: 10
  }), true);
  assert.equal(shouldAttachPageScreenshot({
    observe: 'all-frames',
    page: { url: 'https://a.com/x', documentId: '2' },
    previousPage: { url: 'https://a.com/y', documentId: '1' },
    controlCount: 10
  }), true);
  assert.equal(shouldAttachPageScreenshot({ controlCount: 12, unobservedThisExecution: true }), true);
  assert.equal(shouldAttachPageScreenshot({ controlCount: 12, unobservedThisExecution: false }), false);
  assert.equal(isNewPageObservation({
    page: { url: 'https://a.com/x', documentId: '2' },
    previousPage: { url: 'https://a.com/x', documentId: '2' }
  }), false);
});

test('actionToModelOutput keeps facts and JPEG together without JSON base64', () => {
  const out = actionToModelOutput({
    output: {
      ok: true,
      op: 'snapshot',
      rev: 'r1',
      tabId: 11,
      page: { url: 'https://a.com', title: 'A', documentId: 'd' },
      count: 1,
      canvasCount: 0,
      controls: [{ ref: 'f0.a1', name: 'Go', role: 'button', options: ['x'] }],
      modelParts: screenshotToModelParts({ base64: 'abc', mediaType: 'image/jpeg' }),
      imageBase64: 'SHOULD_DROP'
    }
  });
  const facts = modelFacts(out);
  assert.equal(facts.rev, 'r1');
  assert.equal(facts.tabId, 11);
  assert.equal(facts.page.documentId, 'd');
  assert.equal(facts.page.url, 'https://a.com');
  assert.equal(facts.count, 1);
  assert.equal(facts.controls[0].ref, 'f0.a1');
  assert.equal(facts.controls[0].options, undefined);
  assert.ok(out.value.some((p) => p.type === 'file'));
  const factsText = out.value.find((p) => p.type === 'text').text;
  assert.doesNotMatch(factsText, /SHOULD_DROP/);
  assert.doesNotMatch(factsText, /"abc"/);
  const jsonLike = JSON.stringify(out);
  assert.doesNotMatch(jsonLike, /SHOULD_DROP/);
  const wire = projectToolOutputForWire(out);
  assert.doesNotMatch(JSON.stringify(wire), /"abc"/);
});

test('sessionToolToModelOutput is never vision-only when a file part exists', () => {
  const out = sessionToolToModelOutput({
    output: {
      ok: true,
      tabId: 9,
      stdout: 'hi',
      modelParts: screenshotToModelParts({ base64: 'px', mediaType: 'image/jpeg' })
    }
  });
  const facts = modelFacts(out);
  assert.equal(facts.tabId, 9);
  assert.equal(facts.stdout, 'hi');
  assert.equal(facts.modelParts, undefined);
  assert.ok(out.value.some((p) => p.type === 'file'));
});

test('post-mutate observe snapshots only the top frame; explicit snapshot hits all frames', async () => {
  const state = fixture({
    frames: [
      { frameId: 0, parentFrameId: -1, documentId: 'doc-a', url: 'https://example.com/a' },
      { frameId: 2, parentFrameId: 0, documentId: 'doc-a', url: 'https://example.com/frame' }
    ]
  });
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  assert.equal(snap.ok, true);
  const snapOps = state.calls.filter((c) => c.message.op === 'snapshot');
  assert.ok(snapOps.length >= 2);
  state.calls.length = 0;
  const clicked = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  assert.equal(clicked.ok, true);
  assert.ok(clicked.page?.documentId);
  const observeSnaps = state.calls.filter((c) => c.message.op === 'snapshot');
  assert.deepEqual(observeSnaps.map((c) => c.options.frameId), [0]);
  assert.equal(state.captureCalls, 1);
});

test('observationError keeps page and does not drop the action receipt', async () => {
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  state.failObserve = true;
  const clicked = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  assert.equal(clicked.ok, true);
  assert.ok(clicked.observationError);
  assert.equal(clicked.page?.url, 'https://example.com/a');
});

test('new page snapshot attaches JPEG plus compact structure; same-doc click does not', async () => {
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  assert.equal(snap.screenshot?.attached, true);
  assert.ok(Array.isArray(snap.modelParts) && snap.modelParts.length);
  assert.ok(snap.rev);
  assert.equal(snap.tabId, 11);
  assert.equal(snap.page?.documentId, 'doc-a');
  assert.ok(Array.isArray(snap.controls) && snap.controls.length);
  assert.equal(state.captureCalls, 1);
  const hop = actionToModelOutput({ output: snap });
  const facts = modelFacts(hop);
  assert.equal(facts.rev, snap.rev);
  assert.equal(facts.tabId, 11);
  assert.equal(facts.page.documentId, 'doc-a');
  assert.ok(facts.controls.length);
  assert.ok(hop.value.some((p) => p.type === 'file'));
  const clicked = await mutate({ op: 'click', ref: 'f0.a1', rev: snap.rev });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.modelParts, undefined);
  assert.equal(clicked.screenshot?.attached, undefined);
  assert.equal(state.captureCalls, 1);
  assert.ok(clicked.rev);
  assert.equal(clicked.tabId, 11);
});

test('document not yet observed this execution attaches again after nav or new turn', async () => {
  const state = fixture();
  const first = await handleWorkspacePageAction(request({ op: 'snapshot', executionId: 'e1' }));
  assert.equal(state.captureCalls, 1);
  state.documentId = 'doc-b';
  state.url = 'https://example.com/b';
  state.frames[0] = { frameId: 0, parentFrameId: -1, documentId: 'doc-b', url: state.url };
  invalidatePageActionTarget(11);
  const navigated = await handleWorkspacePageAction(request({ op: 'snapshot', executionId: 'e1' }));
  assert.equal(navigated.page?.documentId, 'doc-b');
  assert.equal(navigated.screenshot?.attached, true);
  assert.equal(state.captureCalls, 2);
  releaseTabLeasesByExecution('s', 'e1');
  const otherTurn = await handleWorkspacePageAction(request({ op: 'snapshot', executionId: 'e2' }));
  assert.equal(otherTurn.ok, true);
  assert.equal(otherTurn.screenshot?.attached, true);
  assert.equal(state.captureCalls, 3);
});

test('explicit observe=screenshot attaches on an already-observed document', async () => {
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  assert.equal(state.captureCalls, 1);
  const again = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  const shot = await mutate({ op: 'click', ref: 'f0.a1', rev: again.rev, observe: 'screenshot' });
  assert.equal(shot.screenshot?.attached, true);
  assert.ok(Array.isArray(shot.modelParts) && shot.modelParts.length);
  assert.equal(state.captureCalls, 2);
  const facts = actionResultToModelFacts(shot);
  assert.equal(facts.tabId, 11);
  assert.ok(facts.rev);
});

test('pointer point clicks via content script and never attaches debugger', async () => {
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  const out = await mutate({ op: 'pointer', method: 'point', x: 0.5, y: 0.25, rev: snap.rev });
  assert.equal(out.ok, true);
  assert.equal(out.methodUsed, 'point');
  assert.equal(state.debuggerAttaches, 0);
  assert.ok(state.calls.some((c) => c.message.op === 'pointer'));
});

test('pointer cdp is an unknown commit; without a ticket SW does not attach debugger', async () => {
  const classified = classifyRisk({
    channel: 'action',
    op: 'pointer',
    method: 'cdp',
    url: 'https://example.com/a',
    tabId: 11
  });
  assert.equal(classified.risk, 'external-commit');
  assert.equal(classified.confidence, 'unknown');
  const state = fixture();
  const snap = await handleWorkspacePageAction(request({ op: 'snapshot' }));
  const out = await handleWorkspacePageAction(request({
    op: 'pointer', method: 'cdp', x: 0.2, y: 0.2, rev: snap.rev
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TICKET_REQUIRED');
  assert.equal(state.debuggerAttaches, 0);
});

test('pointer cdp on a known payment host is PAYMENT_DENIED even in Full Access', async () => {
  fixture({ mode: 'full' });
  const classified = classifyRisk({
    channel: 'action',
    op: 'pointer',
    method: 'cdp',
    url: 'https://checkout.stripe.com/pay',
    tabId: 11
  });
  assert.equal(classified.risk, 'payment');
});

test('sys.screenshot without saveTo becomes vision parts, not leftover base64 on the guest receipt', async () => {
  const sys = createGuestSys({
    hostSys: async () => ({
      ok: true,
      result: { tabId: 11, format: 'jpeg', contentType: 'image/jpeg', base64: 'abc123' }
    })
  });
  const receipt = await sys.screenshot({});
  assert.equal(receipt.vision, true);
  assert.equal(receipt.base64, undefined);
  assert.ok(sys.visionParts.length >= 1);
});

test('skill and tool text do not prescribe a single live-page path', () => {
  const playbook = loadSkillInstructions('site-tool-reuse');
  assert.match(playbook, /not a required path|Pick the channel/i);
  assert.doesNotMatch(playbook, /Do not default to writing a replacement website/);
  assert.doesNotMatch(playbook, /Use action on the live tab \(snapshot → click/);
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const tools = createSessionTools({
    store,
    execution: { executionId: 'e' },
    fs: createSessionGuestFs(store, { sessionId: 's', executionId: 'e' }),
    sessionId: 's'
  });
  assert.match(tools.action.description, /pointer/);
  assert.match(tools.action.description, /sys\.eval/);
  assert.doesNotMatch(tools.action.description, /must screenshot first|prefer structure/i);
  assert.ok(tools.action.parameters.properties.tabId);
  assert.doesNotMatch(tools.run.description, /Do not use run for a pure click/);
});

test('world block includes tabId; action execute forwards it without retargeting focus', async () => {
  const world = buildWorldStateBlock({
    boundGroups: [],
    boundItems: [],
    activeTab: { url: 'https://a.example', title: 'A', origin: 'https://a.example', tabId: 22 }
  });
  assert.match(world, /"tabId":22/);
  assert.match(world, /does not switch Chrome focus/);
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const calls = [];
  const tools = createSessionTools({
    store,
    execution: { executionId: 'e' },
    fs: createSessionGuestFs(store, { sessionId: 's', executionId: 'e' }),
    sessionId: 's',
    activeTab: { tabId: 11, url: 'https://a.example', title: 'A' },
    hostPageAction: async (payload) => {
      calls.push(payload);
      return {
        ok: true,
        op: 'snapshot',
        rev: 'r1',
        tabId: payload.tabId,
        page: { url: 'https://a.example', documentId: 'd' },
        count: 0,
        controls: []
      };
    }
  });
  await tools.action.execute({ op: 'snapshot', tabId: 22 });
  await tools.action.execute({ op: 'snapshot' });
  assert.equal(calls[0].tabId, 22);
  assert.equal(calls[1].tabId, 11);
});
