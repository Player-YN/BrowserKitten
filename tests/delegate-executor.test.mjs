import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDelegateLoop,
  parseExecutorStep,
  fetchExecutorStep,
  executorVision,
  executorChatUrl,
  readExecutorV2Flag,
  EXECUTOR_V2_KEY
} from '../src/agent/vnext/sessionWorkspace/delegateExecutor.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { actionToModelOutput } from '../src/agent/vnext/sessionWorkspace/actionObserve.js';

/** A fake page: each act() may move to the next state. */
function fakePage(states) {
  let i = 0;
  let rev = 0;
  return {
    observe: async () => ({ ok: true, rev: `r${++rev}`, ...states[Math.min(i, states.length - 1)] }),
    advance: () => { i += 1; },
    get index() { return i; }
  };
}

const reply = (obj) => async () => ({ ok: true, text: JSON.stringify(obj) });

test('executor arrives: one click per step through act, until checked by the host', async () => {
  const page = fakePage([
    { page: { url: 'https://shop.test/list', title: 'List' }, controls: [{ ref: 'f0.a1', name: 'Next page', role: 'link' }, { ref: 'f0.a2', name: 'Help', role: 'link' }] },
    { page: { url: 'https://shop.test/list?p=2', title: 'List 2' }, controls: [{ ref: 'f0.a1', name: 'Next page', role: 'link' }] }
  ]);
  const acts = [];
  const receipt = await runDelegateLoop({
    subgoal: 'go to page 2',
    until: 'p=2',
    observe: page.observe,
    decide: reply({ action: 'click', ref: 'f0.a1' }),
    act: async (step, snap) => { acts.push({ op: step.op, ref: step.ref, rev: snap.rev }); page.advance(); return { ok: true }; }
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 'arrived');
  assert.deepEqual(acts, [{ op: 'click', ref: 'f0.a1', rev: 'r1' }]);
  assert.equal(receipt.steps.length, 1);
  assert.equal(receipt.steps[0].changed, true);
  assert.equal(receipt.final.url, 'https://shop.test/list?p=2');
  assert.equal('controls' in receipt, false);
});

test('budget exhausted escalates after maxSteps acts even while the page keeps changing', async () => {
  let n = 0;
  const receipt = await runDelegateLoop({
    subgoal: 'find the end',
    until: 'never-here',
    maxSteps: 2,
    observe: async () => ({ ok: true, rev: 'r', page: { url: `https://x.test/${n}` }, controls: [{ ref: 'f0.a1', name: 'More', role: 'button' }] }),
    decide: reply({ action: 'click', ref: 'f0.a1' }),
    act: async () => { n += 1; return { ok: true }; }
  });
  assert.equal(n, 2);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'escalated');
  assert.equal(receipt.reason, 'budget');
  assert.equal(receipt.code, 'DELEGATE_LIMIT');
});

test('invalid JSON twice escalates without acting', async () => {
  let acts = 0;
  const notes = [];
  const receipt = await runDelegateLoop({
    subgoal: 'x',
    observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: 'Go', role: 'button' }] }),
    decide: async (payload) => { notes.push(payload.note); return { ok: true, text: 'I would click Go.' }; },
    act: async () => { acts += 1; return { ok: true }; }
  });
  assert.equal(acts, 0);
  assert.equal(receipt.reason, 'invalid_reply');
  assert.equal(receipt.code, 'EXECUTOR_INVALID');
  assert.match(notes[1], /rejected/);
});

test('no visible change twice escalates', async () => {
  let acts = 0;
  const receipt = await runDelegateLoop({
    subgoal: 'open menu',
    until: 'Settings',
    observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test', documentId: 'd' }, controls: [{ ref: 'f0.a1', name: 'Menu', role: 'button' }] }),
    decide: reply({ action: 'click', ref: 'f0.a1' }),
    act: async () => { acts += 1; return { ok: true }; }
  });
  assert.equal(acts, 2);
  assert.equal(receipt.reason, 'no_change');
  assert.equal(receipt.steps.every((row) => row.changed === false), true);
});

test('a host gate denial stops at once and is reported, never retried', async () => {
  for (const code of ['PAYMENT_DENIED', 'APPROVAL_DENIED', 'TAB_LEASED', 'TICKET_REQUIRED']) {
    let acts = 0;
    const receipt = await runDelegateLoop({
      subgoal: 'continue',
      observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: 'Continue', role: 'button' }] }),
      decide: reply({ action: 'click', ref: 'f0.a1' }),
      act: async () => { acts += 1; return { ok: false, code, error: 'no' }; }
    });
    assert.equal(acts, 1, code);
    assert.equal(receipt.reason, 'gate_denied');
    assert.equal(receipt.code, code);
  }
  const unknown = await runDelegateLoop({
    subgoal: 'continue',
    observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: 'Continue', role: 'button' }] }),
    decide: reply({ action: 'click', ref: 'f0.a1' }),
    act: async () => ({ ok: false, code: 'ACTION_OUTCOME_UNKNOWN' })
  });
  assert.equal(unknown.reason, 'outcome_unknown');
});

test('payment, delete and captcha hand control back before any dispatch', async () => {
  for (const [name, reason] of [['Pay now', 'payment'], ['立即支付', 'payment'], ['Delete', 'delete'], ['删除', 'delete']]) {
    let acts = 0;
    const receipt = await runDelegateLoop({
      subgoal: 'finish',
      observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name, role: 'button' }] }),
      decide: reply({ action: 'click', ref: 'f0.a1' }),
      act: async () => { acts += 1; return { ok: true }; }
    });
    assert.equal(acts, 0, name);
    assert.equal(receipt.status, 'escalated');
    assert.equal(receipt.reason, reason, name);
  }
  let decided = 0;
  const captcha = await runDelegateLoop({
    subgoal: 'sign in',
    observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: "I'm not a robot", role: 'checkbox' }, { ref: 'f0.a2', name: 'Sign in', role: 'button' }] }),
    decide: async () => { decided += 1; return { ok: true, text: '{"action":"done"}' }; },
    act: async () => ({ ok: true })
  });
  assert.equal(decided, 0);
  assert.equal(captcha.reason, 'captcha');
});

test('fill values come from the planner data; invented values are rejected and never typed', async () => {
  const controls = [{ ref: 'f0.a1', name: 'Email', role: 'textbox' }, { ref: 'f0.a2', name: 'Country', role: 'combobox', options: ['France', 'Japan'] }];
  const ctx = { controls, data: [{ field: 'email', value: 'ann@example.com' }], hasImage: false };
  assert.equal(parseExecutorStep('{"action":"fill","ref":"f0.a1","value":"bob@example.com"}', ctx).ok, false);
  assert.deepEqual(parseExecutorStep('```json\n{"action":"fill","ref":"f0.a1","value":"ann@example.com"}\n```', ctx), { ok: true, action: 'fill', op: 'fill', ref: 'f0.a1', value: 'ann@example.com', field: 'email' });
  assert.equal(parseExecutorStep('{"action":"select","ref":"f0.a2","value":"Japan"}', ctx).ok, true);
  assert.equal(parseExecutorStep('{"action":"select","ref":"f0.a2","value":"Mars"}', ctx).ok, false);
  assert.equal(parseExecutorStep('{"action":"click","ref":"f0.a9"}', ctx).ok, false);
  assert.equal(parseExecutorStep('{"action":"pointer","x":0.5,"y":0.5}', ctx).ok, false);
  assert.equal(parseExecutorStep('{"action":"pointer","x":0.5,"y":0.5}', { ...ctx, hasImage: true }).ok, true);
  assert.equal(parseExecutorStep('{"action":"eval","code":"1"}', ctx).ok, false);

  let state = 0;
  const typed = [];
  const answers = ['{"action":"fill","ref":"f0.a1","value":"made-up@x.test"}', '{"action":"fill","ref":"f0.a1","value":"ann@example.com"}'];
  const receipt = await runDelegateLoop({
    subgoal: 'fill the email',
    until: 'Thanks',
    data: [{ field: 'email', value: 'ann@example.com' }],
    observe: async () => ({ ok: true, rev: `r${state}`, page: { url: 'https://x.test' }, controls: state ? [{ ref: 'f0.a3', name: 'Thanks', role: 'heading' }] : controls }),
    decide: async () => ({ ok: true, text: answers.shift() }),
    act: async (step) => { typed.push(step.value); state = 1; return { ok: true }; }
  });
  assert.deepEqual(typed, ['ann@example.com']);
  assert.equal(receipt.status, 'arrived');
  assert.equal(receipt.steps[0].field, 'email');
  assert.equal(JSON.stringify(receipt).includes('ann@example.com'), false, 'receipt never echoes typed values');
});

test('done without until is reported as unverified done; done with an unmet until escalates', async () => {
  const base = { subgoal: 'x', observe: async () => ({ ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: 'Go', role: 'button' }] }), decide: reply({ action: 'done' }), act: async () => ({ ok: true }) };
  const done = await runDelegateLoop(base);
  assert.equal(done.status, 'done');
  assert.match(done.hint, /verify/i);
  const claimed = await runDelegateLoop({ ...base, until: 'elsewhere' });
  assert.equal(claimed.reason, 'claimed_done');
  const esc = await runDelegateLoop({ ...base, decide: reply({ action: 'escalate', reason: 'needs login' }) });
  assert.equal(esc.reason, 'needs login');
});

test('a screenshot is requested only with vision and only when text controls are not enough', async () => {
  const modes = [];
  const observe = async ({ screenshot }) => {
    modes.push(screenshot);
    return { ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [], canvasCount: 1, image: screenshot ? { data: 'AAAA', mediaType: 'image/jpeg' } : null };
  };
  const seen = [];
  await runDelegateLoop({ subgoal: 'x', vision: true, observe, decide: async (p) => { seen.push(Boolean(p.image)); return { ok: true, text: '{"action":"escalate","reason":"r"}' }; }, act: async () => ({ ok: true }) });
  assert.deepEqual(modes, [false, true]);
  assert.deepEqual(seen, [true]);
  modes.length = 0;
  const blind = await runDelegateLoop({ subgoal: 'x', vision: false, observe, decide: async () => ({ ok: true, text: '{}' }), act: async () => ({ ok: true }) });
  assert.deepEqual(modes, [false]);
  assert.equal(blind.reason, 'no_target');
});

function tools(extra = {}) {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  return createSessionTools({ store, execution: { executionId: 'e' }, fs: createSessionGuestFs(store, { sessionId: 's', executionId: 'e' }), sessionId: 's', ...extra });
}
const schemaOf = (t) => JSON.parse(JSON.stringify({ d: t.action.description, p: t.action.parameters }));

test('flag off: the action schema is exactly the old one; flag on only adds delegate', () => {
  const off = schemaOf(tools());
  assert.deepEqual(schemaOf(tools({ executorV2: false })), off);
  assert.equal(off.p.properties.op.enum.includes('delegate'), false);
  assert.equal('data' in off.p.properties, false);
  assert.doesNotMatch(off.d, /delegate/);
  const on = schemaOf(tools({ executorV2: true }));
  assert.deepEqual(on.p.properties.op.enum, [...off.p.properties.op.enum, 'delegate']);
  for (const key of Object.keys(off.p.properties)) {
    if (['op', 'subgoal', 'until', 'maxSteps'].includes(key)) continue;
    assert.deepEqual(on.p.properties[key], off.p.properties[key], key);
  }
  assert.ok(on.d.startsWith(off.d));
  assert.match(on.d, /escalated returns control/);
  assert.ok(on.d.length <= 850, `flag-on action description ${on.d.length}`);
  assert.equal(on.p.properties.data.type, 'array');
});

test('flag off: op=delegate is not run by the executor loop', async () => {
  const calls = [];
  const t = tools({ activeTab: { tabId: 3, url: 'https://x.test' }, hostPageAction: async (p) => { calls.push(p.op); return { ok: false, code: 'BAD_INPUT' }; } });
  await t.action.execute({ op: 'delegate', subgoal: 'x' });
  assert.deepEqual(calls, ['delegate']);
});

test('flag on: delegate observes and acts only through hostPageAction and calls the cloud executor route', async () => {
  const calls = [];
  let moved = false;
  const fetches = [];
  const t = tools({
    executorV2: true,
    activeTab: { tabId: 7, url: 'https://x.test/a', title: 'A' },
    settings: { jev: { apiKey: 'dev-token', apiBase: 'https://browserkitten.com/api/v1', model: 'bk-system1' }, jevProviderId: 'bk_cloud_jev', jevProviderName: 'Browser Kitten' },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"click","ref":"f0.a1"}' } }] }) };
    },
    hostPageAction: async (p) => {
      calls.push({ op: p.op, rev: p.rev, ref: p.ref, observe: p.observe, tabId: p.tabId, executionId: p.executionId });
      if (p.op === 'snapshot') {
        return moved
          ? { ok: true, rev: 'r2', page: { url: 'https://x.test/b', title: 'B' }, controls: [] }
          : { ok: true, rev: 'r1', page: { url: 'https://x.test/a', title: 'A' }, controls: [{ ref: 'f0.a1', name: 'Next', role: 'link' }] };
      }
      moved = true;
      return { ok: true, op: p.op };
    }
  });
  const out = await t.action.execute({ op: 'delegate', subgoal: 'go to b', until: '/b' });
  assert.equal(out.status, 'arrived');
  assert.deepEqual(calls, [
    { op: 'snapshot', rev: undefined, ref: undefined, observe: 'none', tabId: 7, executionId: 'e' },
    { op: 'click', rev: 'r1', ref: 'f0.a1', observe: 'none', tabId: 7, executionId: 'e' },
    { op: 'snapshot', rev: undefined, ref: undefined, observe: 'none', tabId: 7, executionId: 'e' }
  ]);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://browserkitten.com/api/v1/chat/completions');
  assert.equal(fetches[0].init.headers['x-bk-purpose'], 'executor');
  const body = JSON.parse(fetches[0].init.body);
  assert.equal(body.model, 'bk-system1');
  assert.equal(typeof body.messages[1].content, 'string');
  const model = actionToModelOutput({ output: out });
  const facts = model.value || model;
  const text = JSON.stringify(facts);
  assert.match(text, /"status":"arrived"/);
  assert.doesNotMatch(text, /"controls"/);
});

test('BYOK executor posts to its own chat/completions without our purpose header; images only when declared', async () => {
  assert.equal(executorChatUrl('https://gw.test/v1/systemone'), 'https://gw.test/v1/chat/completions');
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"done"}' } }] }) }; };
  const r = await fetchExecutorStep({ apiKey: 'k', apiBase: 'https://gw.test/v1', model: 'small-1' }, { subgoal: 'x', image: { data: 'AAAA', mediaType: 'image/jpeg' } }, { fetchImpl });
  assert.deepEqual(r, { ok: true, text: '{"action":"done"}' });
  assert.equal(sent[0].url, 'https://gw.test/v1/chat/completions');
  assert.equal('x-bk-purpose' in sent[0].init.headers, false);
  assert.equal(JSON.parse(sent[0].init.body).messages[1].content[1].type, 'image_url');
  assert.equal((await fetchExecutorStep(null, {}, { fetchImpl })).code, 'NEED_JEV');

  assert.equal(executorVision({ jev: { apiKey: 'k', apiBase: 'https://browserkitten.com/api/v1', model: 'bk-system1' } }), true);
  assert.equal(executorVision({ jev: { apiKey: 'k', apiBase: 'https://gw.test/v1', model: 'small-1' }, jevProviderId: 'p1', providers: [{ id: 'p1' }] }), false);
  assert.equal(executorVision({
    jev: { apiKey: 'k', apiBase: 'https://gw.test/v1', model: 'small-1' },
    jevProviderId: 'p1',
    providers: [{ id: 'p1', chatMediaOverrides: { 'https://gw.test/v1\nsmall-1': { image: true } } }]
  }), true);
  assert.equal(executorVision({}), false);
});

test('the feature flag is read from browserbot_executor_v2 and defaults off', async () => {
  assert.equal(EXECUTOR_V2_KEY, 'browserbot_executor_v2');
  assert.equal(await readExecutorV2Flag({ get: async () => ({}) }), false);
  assert.equal(await readExecutorV2Flag({ get: async () => ({ browserbot_executor_v2: 'yes' }) }), false);
  assert.equal(await readExecutorV2Flag({ get: async () => ({ browserbot_executor_v2: true }) }), true);
  assert.equal(await readExecutorV2Flag({ get: async () => { throw new Error('x'); } }), false);
  assert.equal(await readExecutorV2Flag(undefined), false);
});
