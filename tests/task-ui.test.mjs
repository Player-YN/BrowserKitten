import test from 'node:test';
import assert from 'node:assert/strict';

import {
  partitionTaskCards,
  shouldCommitTaskResponse,
  shouldShowTaskRegion,
  taskBelongsToSession,
  tasksFromResponse
} from '../src/sidepanel/taskStatus.js';

test('durable task UI rejects foreign-session tasks', () => {
  assert.equal(taskBelongsToSession({ sessionId: 'session-a' }, 'session-a'), true);
  assert.equal(taskBelongsToSession({ sessionId: 'session-a' }, 'session-b'), false);
  assert.equal(taskBelongsToSession({ sessionId: '' }, 'session-a'), false);
});

test('late listTasks responses cannot repaint a switched session', () => {
  assert.equal(shouldCommitTaskResponse('session-a', 'session-b', 4, 4), false);
  assert.equal(shouldCommitTaskResponse('session-a', 'session-a', 3, 4), false);
  assert.equal(shouldCommitTaskResponse('session-a', 'session-a', 4, 4), true);
});

test('listTasks response accepts the service envelope only as a task list', () => {
  const task = { taskId: 'task-1', sessionId: 'session-a' };
  assert.deepEqual(tasksFromResponse({ tasks: [task] }), [task]);
  assert.deepEqual(tasksFromResponse({ items: [task] }), [task]);
  assert.deepEqual(tasksFromResponse({ task }), []);
});

test('terminal durable tasks are partitioned away from the live stack', () => {
  const { active, terminal } = partitionTaskCards([
    { taskId: 'a', status: 'waiting' },
    { taskId: 'b', status: 'completed' },
    { taskId: 'c', status: 'failed' },
    { taskId: 'd', status: 'paused' },
    { taskId: 'e', status: 'cancelled' }
  ]);
  assert.deepEqual(active.map((task) => task.taskId), ['a', 'd']);
  assert.deepEqual(terminal.map((task) => task.taskId), ['b', 'c', 'e']);
  assert.equal(shouldShowTaskRegion([]), false);
  assert.equal(shouldShowTaskRegion([{ taskId: 'b', status: 'completed' }]), true);
  assert.equal(shouldShowTaskRegion([{ taskId: 'a', status: 'waiting' }]), true);
});
