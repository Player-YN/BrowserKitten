import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACT_RATIO,
  shouldCompact,
  findCompactCutByBudget,
  packFoldedTurnsForSummary,
  generateCompactText,
  runSessionCompact,
  freezeSessionGoal,
  formatSessionGoalInstructions,
  isGreetingOrFiller,
  firstRequestLikeUserText,
  parseHandoffGoal,
  ensureFrozenGoalInHandoff,
  pruneSdkToolResults,
  spliceCompactIntoSdkMessages,
  estimateMessagesTokens
} from '../src/agent/vnext/sessionWorkspace/contextCompact.js';
import { USER_REQUESTS_PATH, CONVERSATION_PATH, formatUserRequestInstructions } from '../src/agent/vnext/sessionWorkspace/sessionIntent.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { DurableSessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/durableStore.js';
import { replayWireMessages } from '../src/agent/vnext/sessionWorkspace/wireTranscript.js';
import { createCallModelLanguageModel, runSessionToolLoopAgent } from '../src/agent/vnext/sessionWorkspace/sessionAgent.js';
import { makeOfficePrepareStep } from '../src/agent/vnext/sessionWorkspace/toolSchedule.js';

function user(id, content) {
  return { role: 'user', messageId: id, content };
}

function bulky(id, n = 28000) {
  return tool(id, 'inspect', 'x'.repeat(n));
}

function assistant(id, content, toolCalls) {
  return { role: 'assistant', messageId: id, content, toolCalls };
}

function tool(id, name, content) {
  return { role: 'tool', messageId: id, toolName: name, content };
}

function memStore(session) {
  const data = { [session.sessionId]: { ...session } };
  return {
    get: (_c, id) => data[id],
    has: (_c, id) => Boolean(data[id]),
    put: (_c, id, v) => {
      data[id] = v;
    }
  };
}

test('greetings are not request-like and never freeze as sessionGoal', () => {
  assert.equal(isGreetingOrFiller('你好'), true);
  assert.equal(isGreetingOrFiller('hi'), true);
  assert.equal(isGreetingOrFiller('thanks!'), true);
  assert.equal(isGreetingOrFiller('ok'), true);
  assert.equal(isGreetingOrFiller('帮我把预算表整理成 TSV'), false);
  const folded = [
    user('u1', '你好'),
    assistant('a1', '你好，需要我做什么？'),
    user('u2', '谢谢'),
    assistant('a2', '随时')
  ];
  assert.equal(firstRequestLikeUserText(folded), '');
  const next = freezeSessionGoal({}, 'Folded turns:\n- user: 你好', folded);
  assert.equal(next.sessionGoal, undefined);
});

test('first successful compact freezes high-level Goal; later local goals cannot replace it', async () => {
  const messages = [
    user('u1', '你好'),
    assistant('a1', '你好'),
    bulky('t0'),
    user('u2', '帮我做一个全年预算表，按月列出收入和支出'),
    assistant('a2', '先建表'),
    bulky('t1'),
    user('u3', '把三月改成红色'),
    assistant('a3', '好'),
    user('u4', '再加一列备注'),
    assistant('a4', '好')
  ];
  const store = memStore({
    sessionId: 's1',
    messages,
    contextUsage: { promptTokens: 90000 }
  });
  const model = {
    async doGenerate() {
      return {
        content: [
          {
            type: 'text',
            text:
              'Goal:\n做一个全年预算表，按月列出收入和支出\nConstraints:\n无\nDecisions:\n先建表\nFiles/artifacts:\n/artifacts/budget.tsv\nErrors:\n无\nRemaining:\n填数\nNext:\n写单元格'
          }
        ]
      };
    }
  };
  const first = await runSessionCompact({
    store,
    sessionId: 's1',
    messages,
    contextWindow: 32000,
    promptTokens: 28000,
    model
  });
  assert.equal(first.didCompact, true);
  assert.equal(store.get('sessions', 's1').sessionGoal.includes('全年预算表'), true);
  const frozen = store.get('sessions', 's1').sessionGoal;

  const more = [
    ...messages,
    bulky('t2', 20000),
    user('u5', '只改一下表头颜色'),
    assistant('a5', '改了')
  ];
  store.put('sessions', 's1', { ...store.get('sessions', 's1'), messages: more });
  const hijack = {
    async doGenerate() {
      return {
        content: [
          {
            type: 'text',
            text:
              'Goal:\n把表头改成红色\nConstraints:\n无\nDecisions:\n改样式\nFiles/artifacts:\n/artifacts/budget.tsv\nErrors:\n无\nRemaining:\n无\nNext:\n完成'
          }
        ]
      };
    }
  };
  const second = await runSessionCompact({
    store,
    sessionId: 's1',
    messages: more,
    contextWindow: 32000,
    promptTokens: 28000,
    model: hijack
  });
  assert.equal(store.get('sessions', 's1').sessionGoal, frozen);
  assert.equal(parseHandoffGoal(second.compact.text), frozen);
  assert.ok(!String(second.compact.text).includes('把表头改成红色') || parseHandoffGoal(second.compact.text) === frozen);
});

test('tail cut stays on a user boundary and short sessions keep at least two user turns', () => {
  const short = [
    user('u1', '第一轮任务：建表'),
    assistant('a1', '好'),
    bulky('t-short'),
    user('u2', '第二轮：填数'),
    assistant('a2', '好'),
    user('u3', '第三轮：导出')
  ];
  const cut = findCompactCutByBudget(short, 8000);
  assert.ok(cut > 0);
  assert.equal(short[cut].role, 'user');
  assert.equal(short[cut].messageId, 'u2');
  const generous = findCompactCutByBudget(short, 128000);
  assert.ok(generous <= cut);

  const two = [user('u1', '只问一件事'), assistant('a1', '答'), user('u2', '再问')];
  assert.equal(findCompactCutByBudget(two, 128000), -1);

  const long = [];
  for (let i = 0; i < 8; i++) {
    long.push(user(`u${i}`, '任务细节 '.repeat(80) + i));
    long.push(assistant(`a${i}`, '回 '.repeat(40)));
  }
  const budgetCut = findCompactCutByBudget(long, 8000);
  assert.ok(budgetCut > 0);
  assert.equal(long[budgetCut].role, 'user');
  const tailUsers = long.slice(budgetCut).filter((m) => m.role === 'user').length;
  assert.ok(tailUsers >= 2);
});

test('doGenerate is the product path; extractive pack is fallback only', async () => {
  const messages = [
    user('u1', '帮我核对发票并写入表格'),
    assistant('a1', '开始核对')
  ];
  const generated = await generateCompactText({
    messages,
    model: {
      async doGenerate() {
        return {
          content: [
            {
              type: 'text',
              text:
                'Goal:\n核对发票并写入表格\nConstraints:\n无\nDecisions:\n先读表\nFiles/artifacts:\n/artifacts/inv.tsv\nErrors:\n无\nRemaining:\n写入\nNext:\nsheet write'
            }
          ]
        };
      }
    }
  });
  assert.ok(generated.startsWith('Goal:'));
  assert.ok(!generated.includes('Folded turns:'));

  const stub = await generateCompactText({
    messages,
    callModel: () => 'unused'
  });
  assert.ok(stub.includes('Folded turns:'));

  const failed = await generateCompactText({
    messages,
    model: {
      async doGenerate() {
        throw new Error('unavailable');
      }
    }
  });
  assert.ok(failed.includes('Folded turns:'));
  assert.ok(failed.includes('核对发票'));
});

test('packFoldedTurnsForSummary truncates old tool bodies and strips base64', () => {
  const jpeg = `data:image/jpeg;base64,${'A'.repeat(400)}`;
  const recent = 'x'.repeat(1200);
  const old = 'y'.repeat(8000);
  const folded = [
    user('u1', '请整理页面快照'),
    assistant('a1', 'snapshot', [{ toolName: 'action' }]),
    tool('t1', 'action', `${old} path=/scratch/old.json`),
    assistant('a2', 'inspect', [{ toolName: 'inspect' }]),
    tool('t2', 'inspect', `${jpeg} ${recent} /artifacts/shot.json`)
  ];
  const pack = packFoldedTurnsForSummary(folded);
  assert.ok(!pack.includes('AAAA'));
  assert.ok(!pack.includes(jpeg));
  assert.match(pack, /\[media omitted\]|\[base64 omitted\]/);
  assert.ok(pack.includes('action'));
  assert.ok(pack.includes('/scratch/old.json') || pack.includes('path='));
});

test('prepareStep returns shortened messages over 80% and skips below the threshold', async () => {
  const bulky = [
    user('u1', 'x'.repeat(4000)),
    assistant('a1', 'y'.repeat(4000)),
    tool('t1', 'inspect', 'z'.repeat(8000)),
    user('u2', '继续'),
    assistant('a2', 'ok')
  ];
  let compactCalls = 0;
  const over = makeOfficePrepareStep({
    contextWindow: 4000,
    onMidLoopCompact: async ({ messages }) => {
      compactCalls += 1;
      return { messages: spliceCompactIntoSdkMessages(messages, { text: 'Goal:\nkeep going' }, 't1') };
    }
  });
  const overOut = await over({ messages: bulky, steps: [] });
  assert.equal(compactCalls, 1);
  assert.ok(Array.isArray(overOut.messages));
  assert.ok(overOut.messages.length < bulky.length);
  assert.ok(String(overOut.messages[0]?.content?.[0]?.text || '').includes('Session compact'));

  const again = await over({ messages: bulky, steps: [] });
  assert.equal(compactCalls, 1);
  assert.equal(again.messages, undefined);

  let underCalls = 0;
  const under = makeOfficePrepareStep({
    contextWindow: 128000,
    onMidLoopCompact: async () => {
      underCalls += 1;
      return { messages: [{ role: 'user', content: 'should not happen' }] };
    }
  });
  const underOut = await under({
    messages: [user('u1', 'hi there friend'), assistant('a1', 'ok')],
    steps: []
  });
  assert.equal(underCalls, 0);
  assert.equal(underOut.messages, undefined);
});

test('shouldCompact stays off below 80% even when history is long enough to cut', () => {
  const messages = [
    user('u1', '第一件'),
    assistant('a1', '好'),
    bulky('t-ratio'),
    user('u2', '第二件'),
    assistant('a2', '好'),
    user('u3', '第三件')
  ];
  assert.equal(
    shouldCompact({
      promptTokens: Math.floor(32000 * COMPACT_RATIO) - 10,
      contextWindow: 32000,
      messages
    }),
    false
  );
  assert.equal(
    shouldCompact({
      promptTokens: Math.floor(32000 * COMPACT_RATIO) + 10,
      contextWindow: 32000,
      messages
    }),
    true
  );
});

test('formatSessionGoalInstructions yields to durable-task originalGoal', () => {
  const session = { sessionGoal: '整理发票' };
  assert.match(formatSessionGoalInstructions(session, null), /fallible, not user authority/);
  assert.equal(formatSessionGoalInstructions(session, { originalGoal: 'task wins' }), '');
});

test('extractive fallback never invents a goal from the first request-like user', async () => {
  const messages = [
    user('u1', '你好'),
    assistant('a1', '你好'),
    bulky('t-fb'),
    user('u2', '请把这个表格导出成 TSV'),
    assistant('a2', '好'),
    bulky('t-fb2', 20000),
    user('u3', '加上合计行'),
    assistant('a3', '好'),
    user('u4', '再看一眼合计'),
    assistant('a4', '好')
  ];
  const store = memStore({
    sessionId: 's2',
    messages,
    contextUsage: { promptTokens: 40000 }
  });
  const out = await runSessionCompact({
    store,
    sessionId: 's2',
    messages,
    contextWindow: 16000,
    promptTokens: 14000,
    model: {
      async doGenerate() {
        throw new Error('down');
      }
    }
  });
  assert.equal(out.didCompact, true);
  assert.equal(store.get('sessions', 's2').sessionGoal, undefined);
  assert.ok(formatUserRequestInstructions(store.get('sessions', 's2')).includes('导出成 TSV'));
  assert.ok(!String(store.get('sessions', 's2').sessionGoal).includes('你好'));
});

test('pruneSdkToolResults drops older tool bodies after the recent token budget', () => {
  const messages = [
    tool('t1', 'inspect', 'old-body '.repeat(2000)),
    tool('t2', 'run', 'new-body '.repeat(40))
  ];
  const pruned = pruneSdkToolResults(messages, 200);
  assert.ok(String(pruned[0].content).includes('compacted tool result'));
  assert.ok(String(pruned[1].content).includes('new-body'));
});

test('ensureFrozenGoalInHandoff rewrites a drifted Goal heading', () => {
  const out = ensureFrozenGoalInHandoff(
    'Goal:\n改个颜色\nConstraints:\n无\nNext:\n停',
    '做一个全年预算表'
  );
  assert.equal(parseHandoffGoal(out), '做一个全年预算表');
});


test('summary input preserves long user requirements and late requests past verbose early tools', async () => {
  const requirement = 'Specification line. '.repeat(100) + 'MUST_KEEP_END_CONSTRAINT';
  const messages = [user('start', 'Prepare a comparison report'),
    tool('big', 'inspect', 'old irrelevant evidence '.repeat(6000)),
    user('revision', requirement)];
  let body;
  await generateCompactText({ messages, model: { async doGenerate(input) {
    body = input.prompt[1].content[0].text;
    return { text: 'Goal: Prepare a comparison report\nConstraints: MUST_KEEP_END_CONSTRAINT' };
  } } });
  assert.ok(body.includes(requirement));
  assert.ok(body.length <= 33000);
});

test('successive compacts summarize only newly covered turns and allow explicit replacements', async () => {
  const messages = [user('u1', 'OLD_TRANSCRIPT_SENTINEL'), assistant('a1', 'Old report'),
    user('u2', 'Cancel that report. NEW_GOAL_SENTINEL: make a spreadsheet instead.'),
    assistant('a2', 'new evidence '.repeat(6000)), user('u3', 'Use columns A and B.'),
    assistant('a3', 'More recent evidence '.repeat(3000)), user('u4', 'Continue')];
  const store = memStore({ sessionId: 'incremental', messages, sessionGoal: 'Old report',
    compact: { throughMessageId: 'a1', text: 'Goal: Old report\nRemaining: collect data' } });
  let input;
  const out = await runSessionCompact({ store, sessionId: 'incremental', messages,
    contextWindow: 8000, promptTokens: 7500, model: { async doGenerate(request) {
      input = request.prompt[1].content[0].text;
      return { text: 'Goal: make a spreadsheet instead\nConstraints: keep user changes\nNext: populate sheet' };
    } } });
  assert.equal(out.didCompact, true);
  assert.ok(!input.includes('OLD_TRANSCRIPT_SENTINEL'));
  assert.ok(input.includes('NEW_GOAL_SENTINEL'));
  assert.match(out.compact.text, /Goal: make a spreadsheet instead/);
  assert.equal(out.session.sessionGoal, 'Old report'); // history is not silently rewritten
  const instructions = formatUserRequestInstructions(out.session, 8000);
  assert.ok(instructions.includes('NEW_GOAL_SENTINEL'));
  assert.match(instructions, /take precedence/);
  assert.deepEqual(out.session.messages, messages);
});

test('first compact retains its extracted constraints as fallible hints', () => {
  const session = freezeSessionGoal({}, 'Goal: Build report\nConstraints:\n- No paid API\nNext: inspect', []);
  assert.deepEqual(session.sessionAmendments, ['No paid API']);
});

test('restart recovers exact original requests via read-only session-isolated archive', async () => {
  const dbName = 'compact-intent-restart';
  const store = await new DurableSessionWorkspaceStore({ dbName }).open();
  const original = 'Keep exactly this whitespace\n  ' + 'long original requirement '.repeat(2000) + '\nNO_PUBLISH';
  store.put('sessions', 's', { sessionId: 's', messages: [user('original', original),
    assistant('a', 'untrusted generated goal'), user('cancel', 'Cancel publishing. Draft only.')],
    sessionGoal: 'Publish report', compact: { throughMessageId: 'a', text: 'Historical draft' } });
  store.put('sessions', 'other', { sessionId: 'other', messages: [user('secret', 'OTHER_SESSION_SECRET')] });
  await store.flush();
  const restored = await new DurableSessionWorkspaceStore({ dbName }).open();
  const fs = createSessionGuestFs(restored, { sessionId: 's', executionId: 'e' });
  const rows = JSON.parse(fs.readFile(USER_REQUESTS_PATH));
  assert.equal(rows[0].content, original);
  assert.equal(rows[1].content, 'Cancel publishing. Draft only.');
  assert.ok(!fs.readFile(USER_REQUESTS_PATH).includes('OTHER_SESSION_SECRET'));
  assert.ok(fs.list('/context').includes(USER_REQUESTS_PATH));
  assert.equal(fs.exists(USER_REQUESTS_PATH), true);
  assert.equal(fs.readFileMimeType(USER_REQUESTS_PATH), 'application/json');
  assert.equal(new TextDecoder().decode(fs.readFileBytes(USER_REQUESTS_PATH)), fs.readFile(USER_REQUESTS_PATH));
  assert.throws(() => fs.writeFile(USER_REQUESTS_PATH, 'overwrite'), /read-only/);
  const prepare = makeOfficePrepareStep({ store: restored, sessionId: 's', contextWindow: 8000,
    taskContext: { taskId: 'task', originalGoal: 'Publish report' } });
  const output = await prepare();
  assert.match(output.instructions, /Cancel publishing. Draft only/);
  assert.match(output.instructions, /omitted/);
  assert.match(output.instructions, /concerning this task take precedence/);
});

test('SDK tool-result output is counted and pruned without breaking call/result identity', () => {
  const result = (id, value) => ({ role: 'tool', content: [{ type: 'tool-result', toolName: 'inspect', toolCallId: id,
    output: { type: 'json', value } }] });
  const messages = [result('old', { ok: false, code: 'UNKNOWN_OUTCOME', path: '/artifacts/evidence.json', body: 'verbose content '.repeat(3000) }),
    result('recent', { ok: true, text: 'recent evidence' })];
  assert.ok(estimateMessagesTokens(messages) > 9000);
  const compacted = pruneSdkToolResults(messages, 200);
  assert.equal(compacted[0].content[0].toolCallId, 'old');
  assert.equal(compacted[0].content[0].type, 'tool-result');
  assert.equal(compacted[0].content[0].output.type, 'text');
  assert.match(compacted[0].content[0].output.value, /UNKNOWN_OUTCOME/);
  assert.match(compacted[0].content[0].output.value, /artifacts\/evidence.json/);
  assert.deepEqual(compacted[1], messages[1]);
  assert.ok(estimateMessagesTokens(compacted) < 600);
});

test('wire replay preserves persisted-turn boundary through expanded tool call/result pairs', () => {
  const stored = [user('u1', 'Original'), { role: 'assistant', messageId: 'a1', wire: [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'inspect', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'inspect', output: { type: 'json', value: { ok: true } } }] },
    { role: 'assistant', content: 'done' }
  ] }, user('u2', 'keep this')];
  const wire = replayWireMessages(stored);
  const out = spliceCompactIntoSdkMessages(wire, { text: 'Goal: Original' }, 'a1');
  assert.equal(out.length, 3);
  assert.equal(out[2].content, 'keep this');
  assert.ok(!JSON.stringify(out).includes('"toolCallId":"c"'));
});

test('first mid-step compact injects original request source into that very request', async () => {
  const messages = [user('u1', 'Original exact requirement with constraint ALPHA')];
  const store = memStore({ sessionId: 'mid', messages });
  const prepare = makeOfficePrepareStep({ store, sessionId: 'mid', contextWindow: 2048,
    onMidLoopCompact: async () => {
      store.put('sessions', 'mid', { ...store.get('sessions', 'mid'), sessionGoal: 'Inferred', compact: { throughMessageId: 'u1', text: 'Inferred' } });
      return { messages: [user('short', 'continue')] };
    } });
  const out = await prepare({ messages: [user('u1', 'large context '.repeat(2000))], steps: [] });
  assert.match(out.instructions, /constraint ALPHA/);
  assert.match(out.instructions, /user-requests.json/);
});

test('actual bundled ToolLoopAgent accepts pruned SDK outputs and retains them on the next hop', async () => {
  const requests = [];
  let toolsRun = 0;
  const model = createCallModelLanguageModel(async (input) => {
    requests.push(input);
    return requests.length < 4 ? { toolCalls: [{ name: 'inspect', args: {} }] } : { text: 'finished' };
  });
  const prepare = makeOfficePrepareStep({ contextWindow: 8000,
    onMidLoopCompact: async ({ messages }) => ({ messages: pruneSdkToolResults(messages, 400) }) });
  const output = await runSessionToolLoopAgent({ model, system: 'Keep constraints',
    messages: replayWireMessages([user('source', 'User requirement ORIGINAL_EXACT')]),
    tools: { inspect: { name: 'inspect', description: 'Read evidence', parameters: { type: 'object', properties: {} },
      async execute() { return { ok: true, sequence: ++toolsRun, text: 'long tool evidence '.repeat(1500) }; } } }, prepareStep: prepare });
  assert.equal(output.finalText, 'finished');
  assert.equal(requests.length, 4);
  assert.match(JSON.stringify(requests[2]), /compacted tool result/);
  assert.match(JSON.stringify(requests[3]), /compacted tool result/);
  for (const request of requests) assert.match(JSON.stringify(request), /ORIGINAL_EXACT/);
});


test('greeting, vague request, adopted proposal and correction remain dialogue evidence, not a first-message goal', async () => {
  const messages = [user('greeting', 'Hi, good to see you again. How are you?'),
    user('vague', 'I need some help comparing suppliers.'),
    assistant('proposal', 'Option A: publish a report. Option B: prepare a private comparison spreadsheet.'),
    user('adoption', 'Use your second option, for three suppliers.'),
    user('correction', 'Actually compare five suppliers; exclude shipping costs.')];
  const store = new SessionWorkspaceStore();
  store.put('sessions', 'dialogue', { sessionId: 'dialogue', messages,
    compact: { throughMessageId: 'proposal', text: 'Working interpretation of a supplier comparison.' } });
  const fs = createSessionGuestFs(store, { sessionId: 'dialogue' });
  const context = formatUserRequestInstructions(store.get('sessions', 'dialogue'), 128000);
  for (const m of messages.filter((m) => m.role === 'user')) assert.ok(context.includes(m.content));
  assert.match(context, /no individual message is automatically the goal/);
  assert.match(context, /not requirements unless the user adopts them/);
  const archive = JSON.parse(fs.readFile(CONVERSATION_PATH));
  assert.equal(archive.find((m) => m.messageId === 'proposal').content, messages[2].content);
  assert.equal(archive.find((m) => m.messageId === 'proposal').role, 'assistant');
  assert.throws(() => fs.writeFile(CONVERSATION_PATH, 'fake proposal'), /read-only/);
  const fallback = await generateCompactText({ messages, model: { async doGenerate() { throw new Error('offline'); } } });
  assert.equal(freezeSessionGoal({}, fallback, messages).sessionGoal, undefined);
});

test('clarification answer is saved losslessly before tool projection and survives restart without fake chat messages', async () => {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 'clarified', { sessionId: 'clarified', messages: [user('u', 'Help me compare suppliers')] });
  const fs = createSessionGuestFs(store, { sessionId: 'clarified', executionId: 'e' });
  const answer = 'Use option B. ' + 'constraint details '.repeat(300) + ' Never publish.';
  const tools = createSessionTools({ store, fs, sessionId: 'clarified', execution: { executionId: 'e' },
    waitForClarify: async () => ({ choice: answer }) });
  const result = await tools.clarify.execute({ question: 'Which deliverable?', options: ['A: public report', 'B: private sheet'] });
  assert.equal(result.ok, true);
  assert.equal(store.get('sessions', 'clarified').messages.length, 1);
  const restored = new SessionWorkspaceStore();
  restored.importSnapshot(structuredClone(store.exportSnapshot()));
  const rows = JSON.parse(createSessionGuestFs(restored, { sessionId: 'clarified' }).readFile(USER_REQUESTS_PATH));
  assert.equal(rows[1].source, 'clarification');
  assert.equal(rows[1].content.answers.choice, answer);
  assert.equal(rows[1].content.questions[0].question, 'Which deliverable?');
  const step = await makeOfficePrepareStep({ store: restored, sessionId: 'clarified', contextWindow: 128000 })();
  assert.ok(step.instructions.includes('Never publish.'));
});
