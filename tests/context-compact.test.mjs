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
  spliceCompactIntoSdkMessages
} from '../src/agent/vnext/sessionWorkspace/contextCompact.js';
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
  assert.ok(formatSessionGoalInstructions(session, null).includes('immutable'));
  assert.equal(formatSessionGoalInstructions(session, { originalGoal: 'task wins' }), '');
});

test('extractive fallback after generate failure can still pin a request-like user, never 你好', async () => {
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
  assert.equal(store.get('sessions', 's2').sessionGoal.includes('导出成 TSV'), true);
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
