import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDelegateLoop,
  parseExecutorStep,
  fetchExecutorStep,
  probeExecutor,
  executorVision,
  executorChatUrl,
  readExecutorV2Flag,
  EXECUTOR_V2_KEY,
  plannerClickAssignment,
  bindClickAssignmentNames,
  assignmentRequestsDelete
} from '../src/agent/vnext/sessionWorkspace/delegateExecutor.js';
import { SYSTEM_PROMPT_VERSION } from '../src/agent/vnext/sessionWorkspace/prompt.js';
import { buildSessionRuntimeInstructions } from '../src/agent/vnext/sessionWorkspace/runtimeInstructions.js';
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

test('action schema always assigns clicks to System1, with or without the legacy flag', () => {
  const schema = schemaOf(tools());
  assert.deepEqual(schema, schemaOf(tools({ executorV2: false })));
  assert.deepEqual(schema, schemaOf(tools({ executorV2: true })));
  const props = schema.p.properties;
  assert.ok(props.op.enum.includes('delegate'));
  assert.ok(props.op.enum.includes('click'));
  assert.ok(props.op.enum.includes('pointer'));
  assert.ok(props.op.enum.includes('choose'));
  assert.equal(props.data.type, 'array');
  assert.match(schema.d, /op=delegate/);
  assert.match(schema.d, /Do not pass a ref/);
  assert.match(schema.d, /pointer/);
  assert.match(schema.d, /sys\.eval/);
  assert.doesNotMatch(schema.d, /x,y in 0–1/);
  assert.ok(schema.d.length <= 700, `action description ${schema.d.length}`);
});

test('runtime instructions tell the planner to assign clicks, not to pick refs', () => {
  assert.equal(SYSTEM_PROMPT_VERSION, 'v27-agent-personality');
  const text = buildSessionRuntimeInstructions();
  assert.match(text, /op=delegate/);
  assert.match(text, /Do not pass a ref/);
  assert.doesNotMatch(text, /自己带 ref/);
  assert.doesNotMatch(text, /op=pointer/);
});

test('a planner click assignment keeps the goal and the values, and drops the planner ref', () => {
  const click = plannerClickAssignment({ op: 'click', ref: 'f0.planner', name: 'Next', rev: 'old', x: 0.1, y: 0.2 });
  assert.equal(click.subgoal, 'Click Next');
  assert.equal('ref' in click, false);
  assert.equal('x' in click, false);
  assert.equal(plannerClickAssignment({ op: 'pointer', x: 0.2, y: 0.3 }).error.includes('name or subgoal'), true);
  const fill = plannerClickAssignment({ op: 'fill', ref: 'f0.no', name: 'Email', value: 'ann@example.com' });
  assert.deepEqual(fill.data, [{ field: 'Email', value: 'ann@example.com' }]);
  assert.equal('ref' in fill, false);
  assert.equal(plannerClickAssignment({ op: 'press', key: 'Space', name: 'Play' }).subgoal, 'Activate Play');
  assert.equal(plannerClickAssignment({ op: 'press', key: 'Tab' }), null);
  assert.equal(plannerClickAssignment({ op: 'scroll' }), null);
  assert.equal(plannerClickAssignment({ op: 'snapshot' }), null);
  assert.equal(plannerClickAssignment({ op: 'upload' }), null);
  const unnamed = bindClickAssignmentNames(
    plannerClickAssignment({ op: 'click', ref: 'f0.stale' }),
    [{ ref: 'f0.a1', name: 'Next' }]
  );
  assert.match(unnamed.error, /not clicked/);
  const named = bindClickAssignmentNames(
    plannerClickAssignment({ op: 'click', ref: 'f0.a1' }),
    [{ ref: 'f0.a1', name: 'Next' }]
  );
  assert.equal(named.subgoal, 'Click Next');
  assert.equal('resolveRef' in named, false);
  assert.equal(assignmentRequestsDelete('Click Delete'), true);
  assert.equal(assignmentRequestsDelete('open the help page'), false);
});

test('delegate runs the System1 loop without the legacy flag', async () => {
  const calls = [];
  const t = tools({
    activeTab: { tabId: 3, url: 'https://x.test' },
    hostPageAction: async (p) => {
      calls.push(p.op);
      if (p.op === 'snapshot') return { ok: true, rev: 'r', page: { url: 'https://x.test' }, controls: [{ ref: 'f0.a1', name: 'Go', role: 'button' }] };
      return { ok: false, code: 'BAD_INPUT' };
    }
  });
  const out = await t.action.execute({ op: 'delegate', subgoal: 'x' });
  assert.deepEqual(calls, ['snapshot']);
  assert.equal(out.code, 'NEED_JEV');
  assert.equal(out.requestedOp, 'delegate');
});

test('delegate observes and acts only through hostPageAction and calls the cloud executor route', async () => {
  const calls = [];
  let moved = false;
  const fetches = [];
  const t = tools({
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

test('the legacy feature flag is still readable and defaults off; it does not gate clicks', async () => {
  assert.equal(EXECUTOR_V2_KEY, 'browserbot_executor_v2');
  assert.equal(await readExecutorV2Flag({ get: async () => ({}) }), false);
  assert.equal(await readExecutorV2Flag({ get: async () => ({ browserbot_executor_v2: 'yes' }) }), false);
  assert.equal(await readExecutorV2Flag({ get: async () => ({ browserbot_executor_v2: true }) }), true);
  assert.equal(await readExecutorV2Flag({ get: async () => { throw new Error('x'); } }), false);
  assert.equal(await readExecutorV2Flag(undefined), false);
});

const JEV = {
  jev: { apiKey: 'dev-token', apiBase: 'https://browserkitten.com/api/v1', model: 'bk-system1' },
  jevProviderId: 'bk_cloud_jev',
  jevProviderName: 'Browser Kitten'
};

function scripted(pages, replies) {
  const calls = [];
  const seen = [];
  let n = 0;
  const t = tools({
    activeTab: { tabId: 7, url: 'https://x.test/a', title: 'A' },
    settings: JEV,
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      const content = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    },
    hostPageAction: async (p) => {
      calls.push({ op: p.op, ref: p.ref, rev: p.rev, value: p.value, key: p.key, x: p.x, y: p.y, observe: p.observe });
      if (p.op !== 'snapshot') return { ok: true };
      const page = pages[Math.min(calls.filter((row) => row.op === 'snapshot').length - 1, pages.length - 1)];
      return { ok: true, rev: page.rev || 'r1', page: page.page, controls: page.controls, canvasCount: page.canvasCount, modelParts: page.modelParts };
    }
  });
  return { t, calls, seen };
}

const pageOf = (controls, extra = {}) => ({
  rev: 'r1',
  page: { url: 'https://x.test/a', title: 'A' },
  controls,
  ...extra
});

test('planner op=click is performed by System1; the planner ref is not the click', async () => {
  const { t, calls, seen } = scripted(
    [pageOf([{ ref: 'f0.a1', name: 'Next', role: 'link' }, { ref: 'f0.a2', name: 'Help', role: 'link' }])],
    ['{"action":"click","ref":"f0.a1"}', '{"action":"done"}']
  );
  const out = await t.action.execute({ op: 'click', ref: 'f0.planner', name: 'Next', rev: 'old', x: 0.1, y: 0.2 });
  assert.equal(out.requestedOp, 'click');
  assert.equal(out.status, 'done');
  assert.equal(calls.some((row) => row.ref === 'f0.planner'), false);
  assert.deepEqual(calls.filter((row) => row.op === 'click'), [{ op: 'click', ref: 'f0.a1', rev: 'r1', value: undefined, key: undefined, x: undefined, y: undefined, observe: 'none' }]);
  assert.equal(JSON.stringify(seen).includes('f0.planner'), false);
  assert.match(seen[0].messages[1].content, /Click Next/);
});

test('a ref-only click recovers the name and still does not click that ref itself', async () => {
  const { t, calls } = scripted(
    [pageOf([{ ref: 'f0.a1', name: 'Next', role: 'link' }, { ref: 'f0.a2', name: 'Help', role: 'button' }])],
    ['{"action":"click","ref":"f0.a2"}', '{"action":"done"}']
  );
  const out = await t.action.execute({ op: 'click', ref: 'f0.a1', rev: 'old' });
  assert.equal(out.status, 'done');
  assert.equal(calls.filter((row) => row.op === 'click').map((row) => row.ref).join(','), 'f0.a2');
  const missing = await tools({
    activeTab: { tabId: 7, url: 'https://x.test/a' },
    settings: JEV,
    hostPageAction: async (p) => {
      calls.push(p);
      return { ok: true, rev: 'r1', page: { url: 'https://x.test/a' }, controls: [{ ref: 'f0.a1', name: 'Next', role: 'link' }] };
    }
  }).action.execute({ op: 'click', ref: 'f0.missing' });
  assert.equal(missing.code, 'BAD_INPUT');
  assert.match(missing.error, /not clicked/);
});

test('planner pointer coordinates are ignored; System1 chooses the point', async () => {
  const shot = [{ type: 'file', data: 'AAAA', mediaType: 'image/jpeg' }];
  const { t, calls } = scripted(
    [pageOf([], { canvasCount: 1, modelParts: shot })],
    ['{"action":"pointer","x":0.8,"y":0.2}', '{"action":"done"}']
  );
  const out = await t.action.execute({ op: 'pointer', name: 'canvas button', x: 0.1, y: 0.9, method: 'cdp' });
  assert.equal(out.requestedOp, 'pointer');
  const point = calls.find((row) => row.op === 'pointer');
  assert.equal(point.x, 0.8);
  assert.equal(point.y, 0.2);
  assert.equal(calls.some((row) => row.x === 0.1 || row.y === 0.9), false);
});

test('fill and fill_form type only the planner value, on the control System1 chooses', async () => {
  const controls = [{ ref: 'f0.a1', name: 'Email', role: 'textbox' }];
  const { t, calls } = scripted([pageOf(controls)], ['{"action":"fill","ref":"f0.a1","value":"ann@example.com"}', '{"action":"done"}']);
  const out = await t.action.execute({ op: 'fill', ref: 'f0.planner', name: 'Email', value: 'ann@example.com' });
  assert.equal(out.status, 'done');
  assert.deepEqual(calls.filter((row) => row.op === 'fill').map((row) => ({ ref: row.ref, value: row.value })), [{ ref: 'f0.a1', value: 'ann@example.com' }]);
  const form = scripted([pageOf(controls)], ['{"action":"fill","ref":"f0.a1","value":"ann@example.com"}', '{"action":"done"}']);
  const formed = await form.t.action.execute({ op: 'fill_form', fields: [{ name: 'Email', value: 'ann@example.com' }] });
  assert.equal(formed.status, 'done');
  assert.equal(form.calls.some((row) => row.op === 'fill_form'), false);
  assert.deepEqual(form.calls.filter((row) => row.op === 'fill').map((row) => row.value), ['ann@example.com']);
  const missing = [];
  const rejected = await tools({
    activeTab: { tabId: 7, url: 'https://x.test/a' },
    settings: JEV,
    hostPageAction: async (p) => {
      missing.push(p.op);
      return { ok: true, rev: 'r1', page: { url: 'https://x.test/a' }, controls };
    }
  }).action.execute({ op: 'fill_form', fields: [{ ref: 'f0.nope', value: 'nope' }] });
  assert.equal(rejected.code, 'BAD_INPUT');
  assert.deepEqual(missing, ['snapshot']);
});

test('Enter is a System1 click; Tab, scroll, snapshot, and upload stay with the planner', async () => {
  const { t, calls } = scripted(
    [pageOf([{ ref: 'f0.a1', name: 'Search', role: 'textbox' }])],
    ['{"action":"press","key":"Enter"}', '{"action":"done"}']
  );
  const entered = await t.action.execute({ op: 'press', key: 'Enter', ref: 'f0.planner', name: 'Search', rev: 'old' });
  assert.equal(entered.requestedOp, 'press');
  assert.equal(calls.some((row) => row.ref === 'f0.planner'), false);
  assert.equal(calls.some((row) => row.op === 'press' && row.key === 'Enter'), true);
  for (const input of [
    { op: 'press', key: 'Tab', ref: 'f0.a1', rev: 'r9' },
    { op: 'scroll', ref: 'f0.a1', rev: 'r9' },
    { op: 'snapshot' },
    { op: 'upload', path: '/scratch/a.txt' }
  ]) {
    const direct = [];
    const bare = tools({
      activeTab: { tabId: 7, url: 'https://x.test/a' },
      hostPageAction: async (p) => { direct.push(p.op); return { ok: true, rev: 'r9' }; }
    });
    await bare.action.execute(input);
    assert.deepEqual(direct, [input.op], input.op);
  }
});

test('a delete assignment raises one gated click; a vague subgoal and payment do not', async () => {
  const controls = [{ ref: 'f0.a4', name: 'Delete', role: 'button' }, { ref: 'f0.a5', name: 'Pay now', role: 'button' }];
  const deleting = scripted([pageOf(controls)], ['{"action":"click","ref":"f0.a4"}']);
  const deleted = await deleting.t.action.execute({ op: 'click', name: 'Delete', ref: 'f0.planner' });
  assert.equal(deleted.reason, 'delete_approved');
  assert.equal(deleted.pending, undefined);
  assert.deepEqual(deleting.calls.filter((row) => row.op === 'click').map((row) => row.ref), ['f0.a4']);
  const vague = scripted([pageOf(controls)], ['{"action":"click","ref":"f0.a4"}']);
  const held = await vague.t.action.execute({ op: 'delegate', subgoal: 'open the help page' });
  assert.equal(held.code, 'DELETE_NEEDS_PLANNER');
  assert.equal(held.pending, undefined);
  assert.equal(vague.calls.some((row) => row.op === 'click'), false);
  const paying = scripted([pageOf(controls)], ['{"action":"click","ref":"f0.a5"}']);
  const pay = await paying.t.action.execute({ op: 'click', name: 'Pay now' });
  assert.equal(pay.code, 'PAYMENT_DENIED');
  assert.equal(paying.calls.some((row) => row.op === 'click'), false);
});


test('System1 settings probe uses the actual executor chat route and rejects non-decision responses', async () => {
  const config = { apiKey: 'test-key', apiBase: 'https://gw.test/v1', model: 'executor' };
  const requests = [];
  const probe = content => probeExecutor(config, { fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  } });
  assert.deepEqual(await probe('{"action":"done"}'), { ok: true });
  assert.equal(requests[0].url, executorChatUrl(config.apiBase));
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, config.model);
  assert.deepEqual(JSON.parse(body.messages[1].content).controls, []);
  assert.equal((await probe('I am connected.')).code, 'NOT_JEV');
  assert.equal((await probe('{"action":"click","ref":"unknown"}')).ok, false);
  const denied = await probeExecutor(config, { fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(denied.code, 'JEV_UNAVAILABLE');
  assert.match(denied.error, /401/);
  assert.equal((await probeExecutor(null, { fetchImpl: () => { throw new Error('unexpected network'); } })).code, 'NEED_JEV');
});
