import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableSessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/durableStore.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createIntentUpdater, validateIntentPatch, pendingIntentRequests, formatIntentInstructions } from '../src/agent/vnext/sessionWorkspace/intentState.js';
import { makeOfficePrepareStep } from '../src/agent/vnext/sessionWorkspace/toolSchedule.js';
import { pruneSdkToolResults, messagePlainText, estimateTextTokens } from '../src/agent/vnext/sessionWorkspace/contextCompact.js';
import { createPageWandLanguageModel } from '../src/agent/provider.js';

const user = (messageId, content) => ({ messageId, content, role: 'user' });
const item = (id, sourceMessageIds, extra = {}) => ({ id, sourceMessageIds, kind: 'objective', status: 'active', text: id, taskId: null, ...extra });
const response = (upserts) => ({ content: [{ type: 'text', text: JSON.stringify({ upserts }) }] });
function fixture(messages = [user('u1', 'Prepare a private report')]) {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages });
  const get = () => store.get('sessions', 's');
  const add = (row) => store.put('sessions', 's', { ...get(), messages: [...get().messages, row] });
  return { store, sessionId: 's', get, add };
}

test('incremental multi-turn intent keeps IDs, adopted proposal sources, independent constraints and cancellation history', async () => {
  const f = fixture([user('hello', 'Hello')]);
  let patch = [], calls = 0;
  const update = createIntentUpdater({ ...f, model: { async doGenerate(request) {
    calls++; assert.equal(request.maxOutputTokens, 2048); assert.equal(request.tools, undefined);
    return response(patch);
  } } });
  await update(); assert.deepEqual(f.get().intentState.items, []);
  f.add({ messageId: 'proposal', role: 'assistant', content: 'A: publish. B: private report.' });
  f.add(user('adopt', 'Use option B; do not email it.'));
  patch = [item('report', ['adopt', 'proposal']), item('no-email', ['adopt'], { kind: 'constraint' })];
  await update();
  f.add(user('status', 'How far along are you?')); patch = []; await update();
  assert.equal(f.get().intentState.items.length, 2);
  f.add(user('replace', 'Replace the report with a spreadsheet. Still private.'));
  patch = [item('report', ['replace'], { status: 'superseded' }), item('sheet', ['replace'])];
  await update();
  assert.equal(f.get().intentState.items.find((r) => r.id === 'no-email').status, 'active');
  assert.deepEqual(f.get().intentState.items[0].sourceMessageIds, ['adopt', 'proposal', 'replace']);
  f.add(user('cancel', 'Cancel the spreadsheet')); patch = [item('sheet', ['cancel'], { status: 'cancelled' })];
  await update(); await update(); assert.equal(calls, 5);
});

test('restart, repeated compact and read-only session-isolated virtual state', async () => {
  const f = fixture(); let calls = 0;
  const model = { async doGenerate() { calls++; return response([item('goal', ['u1'])]); } };
  await createIntentUpdater({ ...f, model })();
  const restored = new SessionWorkspaceStore();
  restored.put('sessions', 's', JSON.parse(JSON.stringify(f.get())));
  for (let i = 0; i < 3; i++) restored.put('sessions', 's', { ...restored.get('sessions', 's'), compact: { text: 'different summary', throughMessageId: 'u1' } });
  await createIntentUpdater({ store: restored, sessionId: 's', model })(); assert.equal(calls, 1);
  const fs = createSessionGuestFs(restored, { sessionId: 's' });
  assert.match(fs.readFile('/context/intent.md'), /goal/);
  assert.equal(fs.readFileMimeType('/context/intent.md'), 'text/markdown');
  assert.ok(fs.list('/context').includes('/context/intent.md'));
  assert.throws(() => fs.writeFile('/context/intent.md', 'override'), /read-only/);
  assert.doesNotMatch(createSessionGuestFs(restored, { sessionId: 'other' }).readFile('/context/intent.md'), /"id":"goal"/);
});

test('prepareStep updates on clarification and shares the new state in the same hop', async () => {
  const f = fixture(); let calls = 0;
  const model = { async doGenerate() { calls++; return response([item('goal', [calls === 1 ? 'u1' : 'clarify1'], { text: calls === 1 ? 'Report' : 'Only Europe' })]); } };
  const prepare = makeOfficePrepareStep({ ...f, updateIntent: createIntentUpdater({ ...f, model }) });
  assert.match((await prepare()).instructions, /Report/);
  f.store.put('sessions', 's', { ...f.get(), userClarifications: [{ messageId: 'clarify1', source: 'clarification', content: 'Only Europe' }] });
  assert.match((await prepare()).instructions, /Only Europe/);
  await prepare(); assert.equal(calls, 2);
  assert.deepEqual(pendingIntentRequests(f.get()), []);
});

test('invalid output and invalid sources preserve prior state and raw pending input; no retry per hop', async () => {
  for (const bad of ['not-json', JSON.stringify({ upserts: [item('x', ['foreign'])] }), JSON.stringify({ upserts: [item('x', ['a'])] })]) {
    const f = fixture([user('u1', 'do it'), { messageId: 'a', role: 'assistant', content: 'suggestion' }]);
    let calls = 0;
    const update = createIntentUpdater({ ...f, model: { async doGenerate() { calls++; return { text: bad }; } } });
    await update(); await update();
    assert.equal(calls, 1); assert.equal(f.get().intentState.revision, 0);
    assert.equal(pendingIntentRequests(f.get()).length, 1);
    assert.match(formatIntentInstructions(f.get()), /do it/);
  }
});

test('timeout aborts one request and discards late success without blocking business context', async () => {
  const f = fixture(); let finish, signal;
  const update = createIntentUpdater({ ...f, timeoutMs: 5, model: { doGenerate(req) { signal = req.abortSignal; return new Promise((r) => { finish = r; }); } } });
  await update(); assert.equal(signal.aborted, true);
  assert.equal(f.get().intentState.lastError, 'INTENT_TIMEOUT');
  finish(response([item('late', ['u1'])])); await Promise.resolve();
  assert.equal(f.get().intentState.revision, 0);
});

test('concurrent source or revision changes reject stale successful updates', async () => {
  for (const change of ['source', 'revision']) {
    const f = fixture(); let finish;
    const work = createIntentUpdater({ ...f, model: { doGenerate() { return new Promise((r) => { finish = r; }); } } })();
    if (change === 'source') f.add(user('u2', 'Cancel'));
    else f.store.put('sessions', 's', { ...f.get(), intentState: { revision: 7, items: [] } });
    finish(response([item('stale', ['u1'])])); await work;
    assert.ok(!f.get().intentState?.items?.some((r) => r.id === 'stale'));
  }
});

test('oversized input remains uncovered; missing references and task ambiguity remain questions', async () => {
  const f = fixture([user('big', 'x'.repeat(50000)), user('latest', 'Use his proposal for the other task')]);
  await createIntentUpdater({ ...f, model: { async doGenerate(req) {
    const data = JSON.parse(req.prompt[1].content[0].text);
    assert.deepEqual(data.omittedInputIds, ['big']);
    assert.ok(!data.dialogue.some((r) => r.messageId === 'big'));
    return response([item('which-task', ['latest'], { kind: 'question' })]);
  } } })();
  assert.deepEqual(pendingIntentRequests(f.get()).map((r) => r.messageId), ['big']);
  assert.match(formatIntentInstructions(f.get()), /excerpted/);
  assert.throws(() => validateIntentPatch({ upserts: [item('wrong-task', ['latest'], { taskId: 'unknown' })] }, f.get(), [user('latest', 'x')]), /INVALID_TASK/);
  assert.equal(f.store.keys('meta').length, 0);
});

test('latest huge result and multipart outputs obey a shared payload budget, preserving call identity', () => {
  const messages = [{ role: 'tool', content: Array.from({ length: 8 }, (_, i) => ({ type: 'tool-result', toolName: 'inspect', toolCallId: `c${i}`, output: { type: 'text', value: '中'.repeat(15000) } })) }];
  const out = pruneSdkToolResults(messages, 500);
  assert.ok(out.reduce((n, m) => n + estimateTextTokens(messagePlainText(m)), 0) <= 500);
  assert.deepEqual(out[0].content.map((r) => r.toolCallId), messages[0].content.map((r) => r.toolCallId));
});

test('bundled provider receives bounded no-tool extraction and suppresses proxy retry without leaking internal header', async () => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  let requests = 0, proxies = 0, sent;
  globalThis.chrome = { runtime: { sendMessage() { proxies++; } } };
  globalThis.fetch = async (_url, init) => {
    requests++; sent = init;
    throw new TypeError('network');
  };
  try {
    const { model } = await createPageWandLanguageModel({ settings: { apiKey: 'test', apiBase: 'https://gateway.test/v1', model: 'test' }, mediaCapabilities: {} });
    const f = fixture();
    await createIntentUpdater({ ...f, model })();
    assert.equal(requests, 1); assert.equal(proxies, 0);
    assert.equal(new Headers(sent.headers).has('x-paw-internal-no-retry'), false);
    assert.equal(JSON.parse(sent.body).max_tokens, 2048);
    assert.ok(!JSON.parse(sent.body).tools?.length);
    assert.equal(f.get().intentState.lastError, 'INTENT_UPDATE_FAILED');
  } finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
});


test('durable flush/reopen preserves intent revision and processing cursor', async () => {
  const dbName = 'intent-state-v1-restart';
  const store = await new DurableSessionWorkspaceStore({ dbName }).open();
  store.put('sessions', 's', { sessionId: 's', messages: [user('u1', 'Keep private')] });
  let calls = 0;
  const model = { async doGenerate() { calls++; return response([item('private', ['u1'], { kind: 'constraint' })]); } };
  await createIntentUpdater({ store, sessionId: 's', model })();
  await store.flush();
  const restored = await new DurableSessionWorkspaceStore({ dbName }).open();
  await createIntentUpdater({ store: restored, sessionId: 's', model })();
  assert.equal(calls, 1);
  assert.equal(restored.get('sessions', 's').intentState.revision, 1);
  assert.deepEqual(pendingIntentRequests(restored.get('sessions', 's')), []);
});

test('user abort leaves previous state untouched and late generation cannot revive it', async () => {
  const f = fixture(); const controller = new AbortController(); let finish;
  const work = createIntentUpdater({ ...f, signal: controller.signal, model: {
    doGenerate() { return new Promise((resolve) => { finish = resolve; }); }
  } })();
  controller.abort(); await work;
  assert.equal(f.get().intentState, undefined);
  finish(response([item('late', ['u1'])])); await Promise.resolve();
  assert.equal(f.get().intentState, undefined);
});
