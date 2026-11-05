import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createTask, getTask, hostTaskMutation, listTasks } from '../src/agent/vnext/sessionWorkspace/tasks.js';

function fixture(options = {}) {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true, ...options });
  service.ensureSession('local');
  return { store, service };
}

test('discovery checks run independently; bound checks pause when their target disappears', async () => {
  let resolutions = 0;
  let calls = 0;
  const { store, service } = fixture({
    resolveTaskPage: async () => { resolutions++; return { ok: false, error: 'Saved page closed.' }; },
    callModel: async ({ system }) => { calls++; assert.doesNotMatch(system, /unrelated\.example/); return { text: 'Checked sources.' }; }
  });
  const discovery = hostTaskMutation(store, {
    sessionId: 'local', targetPage: { tabId: 8, url: 'https://unrelated.example/' },
    input: { op: 'schedule', goal: 'Check sources', intervalMinutes: 1 }
  }).task;
  await service._runTask(discovery);
  assert.equal(resolutions, 0);
  assert.equal(calls, 1);
  assert.equal(getTask(store, discovery.taskId).status, 'waiting');

  const bound = hostTaskMutation(store, {
    sessionId: 'local', targetPage: { tabId: 8, url: 'https://bound.example/' },
    input: { op: 'schedule', goal: 'Check this page', intervalMinutes: 1, target: { mode: 'page' } }
  }).task;
  await service._runTask(bound);
  assert.equal(resolutions, 1);
  assert.equal(calls, 1);
  assert.equal(getTask(store, bound.taskId).status, 'paused');
});

test('cancelling while page resolution is in flight prevents a late model launch', async () => {
  const started = Promise.withResolvers();
  const target = Promise.withResolvers();
  let calls = 0;
  const { store, service } = fixture({
    resolveTaskPage: async () => { started.resolve(); return target.promise; },
    callModel: async () => { calls++; return { text: 'Must not run.' }; }
  });
  const task = createTask(store, {
    sessionId: 'local', goal: 'Watch page', scheduled: true, intervalMinutes: 1,
    targetPage: { tabId: 1, url: 'https://bound.example/' }
  });
  const checking = service._runTask(task);
  await started.promise;
  await service.updateTask({ taskId: task.taskId, op: 'cancel' });
  target.resolve({ ok: true, tab: { tabId: 1, url: 'https://bound.example/' } });
  await checking;
  assert.equal(calls, 0);
  assert.equal(getTask(store, task.taskId).status, 'cancelled');
});

for (const expiry of [false, true]) {
  test(expiry ? 'end time cancels an active check without scheduling another round'
    : 'round budget aborts the model and pauses with an inspect-before-resume checkpoint', async t => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    const entered = Promise.withResolvers();
    let signal;
    const { store, service } = fixture({
      callModel: async input => {
        signal = input.signal;
        entered.resolve();
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    });
    const task = createTask(store, {
      sessionId: 'local', goal: 'Watch sources', scheduled: true,
      intervalMinutes: 1, maxRoundMinutes: 1,
      ...(expiry ? { stopAt: new Date(now + 30_000).toISOString() } : {})
    });
    const running = service.sendMessage({
      sessionId: 'local', taskId: task.taskId, taskRun: true,
      taskContinuation: true, scheduledRun: true
    });
    const rejected = assert.rejects(running, error =>
      error.code === (expiry ? 'TASK_EXPIRED' : 'TASK_ROUND_TIMEOUT'));
    await entered.promise;
    t.mock.timers.tick(expiry ? 30_000 : 60_000);
    await rejected;
    assert.equal(signal.aborted, true);
    const after = getTask(store, task.taskId);
    assert.equal(after.status, expiry ? 'cancelled' : 'paused');
    assert.match(after.summary, expiry ? /end time|expired/i : /time budget/i);
    if (!expiry) assert.match(after.nextAction, /inspect/i);
    assert.equal((await service.getTaskSchedule()).nextWakeAt, null);
    assert.equal((await service.getActiveExecution({ sessionId: 'local' })).activeExecution, null);
  });
}

test('a long-task agent can set and remove its own timer without creating another task or stopping ongoing tools', async t => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const { store, service } = fixture();
  const task = createTask(store, { sessionId: 'local', goal: 'Keep checking the authorized sources', summary: 'Initial scan saved' });
  let firstCalls = 0;
  const scheduled = await service.sendMessage({
    sessionId: 'local', taskId: task.taskId, taskRun: true,
    content: 'Continue this task.',
    callModel: async () => {
      firstCalls++;
      return { text: 'I will check again later.', toolCalls: [
        { id: 'set_timer', name: 'task', args: {
          op: 'schedule', intervalMinutes: 1,
          stopAt: new Date(now + 30_000).toISOString()
        } },
        { id: 'late_checkpoint', name: 'task', args: { op: 'checkpoint', summary: 'Must not run after yielding' } }
      ] };
    }
  });
  assert.equal(firstCalls, 1);
  assert.equal(scheduled.task.taskId, task.taskId);
  assert.equal(listTasks(store).length, 1);
  assert.equal(scheduled.task.status, 'waiting');
  assert.equal(scheduled.task.summary, 'Initial scan saved', 'sibling tools after schedule are suppressed');

  let resumedCalls = 0;
  const continued = await service.sendMessage({
    sessionId: 'local', taskId: task.taskId, taskRun: true, taskContinuation: true, scheduledRun: true,
    callModel: async input => {
      resumedCalls++;
      if (resumedCalls === 1) return { toolCalls: [
        { id: 'remove_timer', name: 'task', args: { op: 'unschedule' } },
        { id: 'continue_checkpoint', name: 'task', args: { op: 'checkpoint', summary: 'Continue interactively' } }
      ] };
      assert.equal(getTask(store, task.taskId).summary, 'Continue interactively');
      t.mock.timers.tick(60_000);
      assert.equal(input.signal.aborted, false, 'removed expiry must not abort the continuing turn');
      return { text: 'Automatic checks removed; progress kept.' };
    }
  });
  assert.equal(resumedCalls, 2);
  assert.equal(continued.task.taskId, task.taskId);
  assert.equal(continued.task.scheduled, false);
  assert.equal(continued.task.stopAt, null);
  assert.equal(continued.task.dueAt, null);
  assert.equal(continued.task.originalGoal, task.originalGoal);
  assert.equal((await service.getTaskSchedule()).nextWakeAt, null);
  assert.equal((await service.getActiveExecution({ sessionId: 'local' })).activeExecution, null);
});
