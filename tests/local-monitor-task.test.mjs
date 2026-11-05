import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import {
  claimTask, createTask, dueTasks, expireTasks, getTask, hostTaskMutation,
  listTasks, nextTaskWakeAt, settleTaskAfterTurn, updateTaskControl
} from '../src/agent/vnext/sessionWorkspace/tasks.js';
import { createTaskTool } from '../src/agent/vnext/sessionWorkspace/taskTool.js';

const now = Date.parse('2030-01-01T00:00:00Z');
const later = (minutes) => new Date(now + minutes * 60_000).toISOString();
const errorCode = (code) => (error) => error.code === code;

function fixture(config = {}) {
  const store = new SessionWorkspaceStore();
  const task = createTask(store, {
    sessionId: 's1', goal: 'Watch for new items', scheduled: true,
    dueAt: later(1), intervalMinutes: 1, now, ...config
  });
  claimTask(store, task.taskId, 'e1', now);
  const mutate = (input, at = now) => hostTaskMutation(store, {
    sessionId: 's1', taskId: task.taskId, executionId: 'e1', now: at, input
  });
  return { store, taskId: task.taskId, mutate };
}

test('new scheduled targets discover independently; explicit page and legacy bindings stay precise', async () => {
  const store = new SessionWorkspaceStore();
  const activePage = { tabId: 9, url: 'https://example.com/inbox', title: 'Inbox' };
  const schedule = (input) => hostTaskMutation(store, {
    sessionId: 's1', targetPage: activePage, now,
    input: { op: 'schedule', goal: 'Observe', intervalMinutes: 2, ...input }
  }).task;
  const independent = schedule({});
  assert.equal(independent.targetMode, 'discover');
  assert.equal(independent.targetPage, null);
  assert.equal(independent.reportPolicy, 'changes');
  assert.equal(independent.maxRoundMinutes, 5);
  const bound = schedule({ target: { mode: 'page' }, maxRoundMinutes: 100 });
  assert.deepEqual(bound.targetPage, activePage);
  assert.equal(bound.maxRoundMinutes, 30);
  assert.throws(() => schedule({ target: { mode: 'page', url: 'chrome://settings' } }), errorCode('TASK_INVALID_TARGET'));
  const raw = { ...bound, taskId: 'legacy' };
  delete raw.targetMode; delete raw.reportPolicy;
  store.put('meta', 'task:legacy', raw);
  assert.equal(getTask(store, 'legacy').targetMode, 'page');
  assert.equal(getTask(store, 'legacy').reportPolicy, 'always');
  const tool = createTaskTool({ hostTask: async (payload) => ({ ok: true, payload }) });
  const result = await tool.execute({ op: 'schedule', goal: 'Observe', intervalMinutes: 1, target: { mode: 'discover' }, reportPolicy: 'changes', stopAt: later(60), stopWhen: 'Done', maxRoundMinutes: 3 });
  assert.equal(result.payload.stopWhen, 'Done');
  assert.equal(result.payload.target.mode, 'discover');
});

test('observation candidates survive rounds until acknowledged; identical handled content is suppressed', () => {
  const { store, taskId, mutate } = fixture();
  const item = { key: 'inbox:42', fingerprint: 'v1', summary: 'Question' };
  assert.equal(mutate({ op: 'observe', observations: [item] }).changes[0].kind, 'new');
  assert.equal(mutate({ op: 'observe', observations: [item] }).changes[0].kind, 'pending');
  assert.throws(() => mutate({ op: 'wait', wakeAt: later(3), report: 'quiet' }), errorCode('TASK_PENDING_OBSERVATIONS'));
  mutate({ op: 'wait', wakeAt: later(3), handledKeys: [item.key], report: 'action' });
  settleTaskAfterTurn(store, { taskId, executionId: 'e1', scheduledRun: true, previousDueAt: later(1), now });
  assert.equal(getTask(store, taskId).dueAt, later(3));
  claimTask(store, taskId, 'e1', now);
  assert.equal(getTask(store, taskId).roundReport, null);
  assert.deepEqual(mutate({ op: 'observe', observations: [item] }).changes, []);
  assert.equal(mutate({ op: 'observe', observations: [{ ...item, fingerprint: 'v2' }] }).changes[0].kind, 'changed');
  assert.equal(mutate({ op: 'observe', observations: [] }).changes[0].kind, 'pending');
});

test('first baseline is one-shot; invalid or overflowing ledgers do not mutate task state', () => {
  const { store, taskId, mutate } = fixture();
  assert.deepEqual(mutate({ op: 'observe', baseline: true, observations: [{ key: 'old', fingerprint: 'v1' }] }).changes, []);
  assert.throws(() => mutate({ op: 'observe', baseline: true, observations: [] }), errorCode('TASK_BASELINE_INITIALIZED'));
  const entries = Array.from({ length: 511 }, (_, i) => ({ key: `item:${i}`, fingerprint: 'v1' }));
  mutate({ op: 'observe', observations: entries });
  const before = getTask(store, taskId);
  for (const rows of [
    [{ key: 'new', fingerprint: 'v1' }],
    [{ key: 'x'.repeat(257), fingerprint: 'v1' }],
    [{ key: 'old', fingerprint: 'v1' }, { key: 'old', fingerprint: 'v2' }]
  ]) assert.throws(() => mutate({ op: 'observe', observations: rows }));
  assert.deepEqual(getTask(store, taskId), before);
});

test('complete permanently stops recurrence; wait preserves its wake time and pause yields for attention', () => {
  const f = fixture();
  f.mutate({ op: 'complete', summary: 'Responsibility fulfilled', evidence: ['Readback'] });
  const settled = settleTaskAfterTurn(f.store, { taskId: f.taskId, executionId: 'e1', scheduledRun: true, now });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.dueAt, null);
  assert.equal(settled.roundCount, 1);
  assert.equal(settled.lastCheckedAt, new Date(now).toISOString());
  assert.equal(settleTaskAfterTurn(f.store, { taskId: f.taskId, executionId: 'e1', scheduledRun: true, now }).roundCount, 1);
  const p = fixture();
  assert.equal(p.mutate({ op: 'pause', summary: 'Unknown send outcome', nextAction: 'Inspect before retrying' }).yield, true);
  assert.equal(getTask(p.store, p.taskId).roundReport.kind, 'needs_attention');
  assert.equal(settleTaskAfterTurn(p.store, { taskId: p.taskId, executionId: 'e1', scheduledRun: true, now }).status, 'paused');
});

test('expiry cancels even paused tasks without asserting completion, clears wake, and prevents resume', () => {
  const f = fixture({ stopAt: later(2) });
  f.mutate({ op: 'wait', wakeAt: later(10), report: 'quiet' });
  assert.equal(nextTaskWakeAt(f.store), later(2));
  updateTaskControl(f.store, f.taskId, 'pause', now);
  assert.equal(nextTaskWakeAt(f.store), later(2));
  const at = now + 2 * 60_000;
  assert.throws(() => claimTask(f.store, f.taskId, 'e2', at), errorCode('TASK_EXPIRED'));
  assert.throws(() => updateTaskControl(f.store, f.taskId, 'resume', at), errorCode('TASK_EXPIRED'));
  assert.deepEqual(dueTasks(f.store, at), []);
  const expired = expireTasks(f.store, at);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'cancelled');
  assert.match(expired[0].summary, /completion was not asserted/);
  assert.equal(nextTaskWakeAt(f.store), null);
  assert.throws(() => updateTaskControl(f.store, f.taskId, 'resume', at), errorCode('TASK_TERMINAL'));
});

test('an agent schedules its bound responsibility without a new goal or duplicate task', async () => {
  const f = fixture({
    scheduled: false,
    contract: { goal: 'Watch for new items', scope: 'Public sources', constraints: ['Read only'], acceptance: ['Report new items'] }
  });
  f.mutate({ op: 'observe', baseline: true, observations: [{ key: 'source:42', fingerprint: 'v1' }] });
  f.mutate({ op: 'checkpoint', summary: 'First scan done', nextAction: 'Check later' });
  const before = getTask(f.store, f.taskId);
  const tool = createTaskTool({ getTaskContext: () => getTask(f.store, f.taskId), hostTask: async (input) => f.mutate(input) });
  const scheduled = await tool.execute({ op: 'schedule', wakeAt: later(7), intervalMinutes: 7 });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.yield, true);
  assert.equal(scheduled.task.taskId, f.taskId);
  assert.equal(listTasks(f.store).length, 1);
  assert.equal(scheduled.task.status, 'waiting');
  assert.equal(scheduled.task.scheduled, true);
  assert.equal(scheduled.task.dueAt, later(7));
  assert.deepEqual(scheduled.task.contract, before.contract);
  assert.deepEqual(scheduled.task.observationState, before.observationState);
  assert.equal(scheduled.task.summary, before.summary);
  assert.equal(scheduled.task.ownership.executionId, null);
});

test('removing timers preserves responsibility and progress without a later recurrence fallback', () => {
  const f = fixture({ stopAt: later(20) });
  f.mutate({ op: 'observe', baseline: true, observations: [{ key: 'source:42', fingerprint: 'v1' }] });
  f.mutate({ op: 'checkpoint', summary: 'First scan done', nextAction: 'Continue interactively' });
  const before = getTask(f.store, f.taskId);
  const removed = f.mutate({ op: 'unschedule' });
  assert.equal(removed.yield, false);
  assert.equal(removed.task.status, 'running');
  assert.equal(removed.task.ownership.executionId, 'e1');
  assert.equal(removed.task.scheduled, false);
  for (const key of ['dueAt', 'intervalMinutes', 'stopAt']) assert.equal(removed.task[key], null);
  assert.equal(removed.task.originalGoal, before.originalGoal);
  assert.equal(removed.task.summary, before.summary);
  assert.deepEqual(removed.task.observationState, before.observationState);
  assert.equal(nextTaskWakeAt(f.store), null);

  const other = createTask(f.store, { sessionId: 's1', goal: 'Another check', scheduled: true, dueAt: later(2), intervalMinutes: 2, stopAt: later(20), now });
  assert.equal(f.mutate({ op: 'unschedule', taskId: other.taskId }).task.status, 'paused');
  assert.equal(nextTaskWakeAt(f.store), null);
  settleTaskAfterTurn(f.store, { taskId: f.taskId, executionId: 'e1', scheduledRun: true, now });
  assert.equal(nextTaskWakeAt(f.store), null);
  // The same operation is available from the user control without ending the task.
  const ui = createTask(f.store, { sessionId: 's1', goal: 'UI timer', scheduled: true, dueAt: later(2), intervalMinutes: 2, now });
  const controlled = updateTaskControl(f.store, ui.taskId, 'unschedule', now);
  assert.equal(controlled.status, 'paused');
  assert.equal(controlled.originalGoal, ui.originalGoal);
  assert.equal(nextTaskWakeAt(f.store), null);
});

test('timer mutations cannot change goal or cross session and execution ownership', () => {
  const f = fixture();
  const foreign = createTask(f.store, { sessionId: 's2', goal: 'Foreign task', dueAt: later(3), now });
  const owned = createTask(f.store, { sessionId: 's1', goal: 'Other execution', now });
  claimTask(f.store, owned.taskId, 'e2', now);
  const completed = createTask(f.store, { sessionId: 's1', goal: 'Already done', status: 'completed', now });
  const before = listTasks(f.store);
  assert.throws(() => f.mutate({ op: 'schedule', goal: 'Change the responsibility', intervalMinutes: 1 }), errorCode('TASK_SCOPE_CHANGE_REQUIRED'));
  for (const taskId of [foreign.taskId, owned.taskId, completed.taskId]) {
    assert.throws(() => f.mutate({ op: 'unschedule', taskId }));
  }
  assert.deepEqual(listTasks(f.store), before);
});
