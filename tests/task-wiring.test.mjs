import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import {
  claimTask,
  cloneTaskValue,
  createTask,
  ensureTaskForMessage,
  getTask,
  hostTaskMutation,
  listTasks,
  settleTaskAfterTurn
} from '../src/agent/vnext/sessionWorkspace/tasks.js';

function storeWithSession(sessionId = 's1') {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({
    store,
    memoryJournal: true,
    callModel: async () => ({ text: 'ok' })
  });
  service.ensureSession(sessionId);
  return { store, service, sessionId };
}

test('cloneTaskValue and _taskMetaSnapshot do not throw; rollback stays on task:*', async () => {
  const { store, service, sessionId } = storeWithSession();
  createTask(store, { sessionId, goal: 'Keep this' });
  store.put('meta', 'other', { keep: true });
  const snap = service._taskMetaSnapshot();
  assert.equal(snap.length, 1);
  assert.match(snap[0][0], /^task:/);
  assert.equal(snap[0][1].originalGoal, 'Keep this');
  assert.deepEqual(cloneTaskValue({ a: 1 }), { a: 1 });
  assert.equal(cloneTaskValue(undefined), undefined);

  await assert.rejects(
    () =>
      service._commitTaskMutation(() => {
        createTask(store, { sessionId, goal: 'Should roll back' });
        store.put('meta', 'other', { keep: false });
        throw new Error('boom');
      }),
    /boom/
  );
  const tasks = listTasks(store, { sessionId });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].originalGoal, 'Keep this');
  assert.deepEqual(store.get('meta', 'other'), { keep: false });
});

test('ordinary sendMessage does not create or attach a durable task', async () => {
  const { store, service, sessionId } = storeWithSession();
  const result = await service.sendMessage({
    sessionId,
    content: 'just chatting',
    callModel: async () => ({ text: 'hello' })
  });
  assert.equal(result.task, null);
  assert.equal(listTasks(store, { sessionId }).length, 0);
  const messages = store.get('sessions', sessionId).messages || [];
  assert.ok(messages.some((m) => m.role === 'user' && m.content === 'just chatting'));
});

test('empty plan settle is ready, not completed; complete is the only completed path', () => {
  const store = new SessionWorkspaceStore();
  const empty = createTask(store, { sessionId: 's1', goal: 'Do it' });
  const claimed = claimTask(store, empty.taskId, 'exec_1');
  const settled = settleTaskAfterTurn(store, {
    taskId: claimed.taskId,
    executionId: 'exec_1',
    summary: 'Model never called complete'
  });
  assert.equal(settled.status, 'ready');

  const planned = createTask(store, {
    sessionId: 's1',
    goal: 'Do more',
    steps: [{ title: 'Open page', status: 'pending' }]
  });
  claimTask(store, planned.taskId, 'exec_2');
  const paused = settleTaskAfterTurn(store, {
    taskId: planned.taskId,
    executionId: 'exec_2'
  });
  assert.equal(paused.status, 'paused');

  const fin = createTask(store, { sessionId: 's1', goal: 'Finish' });
  claimTask(store, fin.taskId, 'exec_3');
  const done = hostTaskMutation(store, {
    taskId: fin.taskId,
    executionId: 'exec_3',
    input: { op: 'complete', summary: 'Done', evidence: ['Checked the page'] }
  });
  assert.equal(done.task.status, 'completed');
  const after = settleTaskAfterTurn(store, {
    taskId: fin.taskId,
    executionId: 'exec_3'
  });
  assert.equal(after.status, 'completed');
});

test('ensureTaskForMessage does not steal waiting or paused tasks', () => {
  const store = new SessionWorkspaceStore();
  const waiting = createTask(store, {
    sessionId: 's1',
    goal: 'Watch the board',
    dueAt: '2030-01-01T00:00:00.000Z',
    status: 'waiting'
  });
  const out = ensureTaskForMessage(store, {
    sessionId: 's1',
    goal: 'A later chat that must not hijack the waiter',
    now: Date.parse('2026-01-01T00:00:00.000Z')
  });
  assert.equal(out.created, false);
  assert.equal(out.task.taskId, waiting.taskId);
  assert.equal(out.task.status, 'waiting');
  assert.equal(out.task.dueAt, waiting.dueAt);
  assert.equal(out.task.amendments.length, 0);
  assert.equal(out.task.originalGoal, 'Watch the board');

  const paused = createTask(store, { sessionId: 's2', goal: 'Paused work', status: 'paused' });
  const pausedOut = ensureTaskForMessage(store, {
    sessionId: 's2',
    goal: 'Different chatter'
  });
  assert.equal(pausedOut.task.taskId, paused.taskId);
  assert.equal(pausedOut.task.status, 'paused');
  assert.equal(pausedOut.task.dueAt, null);
  assert.equal(pausedOut.task.amendments.length, 0);
});

test('claim failure skips the agent and does not mark the task failed', async () => {
  const { store, service, sessionId } = storeWithSession();
  const busy = createTask(store, { sessionId, goal: 'Owned elsewhere' });
  claimTask(store, busy.taskId, 'exec_other');
  let modelCalls = 0;
  const busyResult = await service.sendMessage({
    sessionId,
    taskId: busy.taskId,
    taskRun: true,
    taskContinuation: true,
    callModel: async () => {
      modelCalls++;
      return { text: 'should not run' };
    }
  });
  assert.equal(busyResult.skipAgent, true);
  assert.equal(getTask(store, busy.taskId).status, 'running');
  assert.equal(getTask(store, busy.taskId).ownership.executionId, 'exec_other');
  assert.equal(modelCalls, 0);

  const done = createTask(store, { sessionId, goal: 'Already finished' });
  claimTask(store, done.taskId, 'exec_done');
  hostTaskMutation(store, {
    taskId: done.taskId,
    executionId: 'exec_done',
    input: { op: 'complete', summary: 'Done', evidence: ['Readback'] }
  });
  const terminalResult = await service.sendMessage({
    sessionId,
    taskId: done.taskId,
    taskRun: true,
    taskContinuation: true,
    callModel: async () => {
      modelCalls++;
      return { text: 'should not run' };
    }
  });
  assert.equal(terminalResult.skipAgent, true);
  assert.equal(getTask(store, done.taskId).status, 'completed');
  assert.equal(modelCalls, 0);
});

test('task continuation does not persist a fake user utterance', async () => {
  const { store, service, sessionId } = storeWithSession();
  store.put('sessions', sessionId, {
    ...store.get('sessions', sessionId),
    messages: [{ messageId: 'm1', role: 'user', content: 'original ask', createdAt: 1 }]
  });
  const task = createTask(store, { sessionId, goal: 'Watch the page', status: 'ready' });
  await service.sendMessage({
    sessionId,
    taskId: task.taskId,
    taskRun: true,
    taskContinuation: true,
    callModel: async ({ messages, system }) => {
      const blob = JSON.stringify({ messages, system });
      assert.match(blob, /taskContinuation=true|Durable task/);
      assert.doesNotMatch(blob, /Continue the durable task from its saved checkpoint/);
      return { text: 'resumed from checkpoint' };
    }
  });
  const messages = store.get('sessions', sessionId).messages || [];
  assert.ok(!messages.some((m) => String(m.content).includes('Continue the durable task')));
  assert.equal(messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(messages.find((m) => m.role === 'user').content, 'original ask');
});

test('abort or deadline settle pauses with unknown-outcome inspect, never completed', () => {
  const store = new SessionWorkspaceStore();
  const task = createTask(store, { sessionId: 's1', goal: 'Long job' });
  claimTask(store, task.taskId, 'exec_1');
  const paused = settleTaskAfterTurn(store, {
    taskId: task.taskId,
    executionId: 'exec_1',
    error: true,
    aborted: true
  });
  assert.equal(paused.status, 'paused');
  assert.match(paused.nextAction, /inspect/i);
  assert.match(paused.summary, /outcome was recorded/i);

  const other = createTask(store, { sessionId: 's1', goal: 'Deadline job' });
  claimTask(store, other.taskId, 'exec_2');
  const deadline = settleTaskAfterTurn(store, {
    taskId: other.taskId,
    executionId: 'exec_2',
    error: true,
    deadline: true
  });
  assert.equal(deadline.status, 'paused');
  assert.match(deadline.nextAction, /inspect/i);
});

test('checked plan approval binds the task to the turn and releases it, so the next message runs', async () => {
  const { answerClarify } = await import('../src/agent/vnext/sessionWorkspace/clarifyGate.js');
  const { getActiveTaskId } = await import('../src/agent/vnext/sessionWorkspace/taskContract.js');
  const { store, service, sessionId } = storeWithSession();
  let calls = 0;
  const first = await service.sendMessage({
    sessionId,
    content: '/plan apply for the visa',
    callModel: async () => {
      calls++;
      if (calls === 1) {
        return {
          toolCalls: [{
            id: 'c1',
            name: 'clarify',
            args: { plan: { title: 'Prepare the visa application', steps: ['Collect documents', 'Submit'] } }
          }]
        };
      }
      return { text: 'Plan approved; tell me your details.' };
    },
    onEvent: (ev) => {
      if (ev?.type === 'clarify' && ev.clarifyId) {
        queueMicrotask(() => answerClarify({
          clarifyId: ev.clarifyId,
          answers: { approved: true, startDurableTask: true }
        }));
      }
    }
  });
  const taskId = getActiveTaskId(store, sessionId);
  assert.ok(taskId, 'checked plan approval creates a bound task');
  assert.equal(first.task?.taskId, taskId);
  const settled = getTask(store, taskId);
  assert.notEqual(settled.status, 'running');
  assert.equal(settled.ownership.executionId, null);

  let followUpRan = false;
  const second = await service.sendMessage({
    sessionId,
    content: 'Here are my details.',
    callModel: async () => {
      followUpRan = true;
      return { text: 'Thanks.' };
    }
  });
  assert.notEqual(second.skipAgent, true);
  assert.equal(second.taskClaimError, undefined);
  assert.equal(followUpRan, true);
  assert.equal(second.task?.taskId, taskId);
});
