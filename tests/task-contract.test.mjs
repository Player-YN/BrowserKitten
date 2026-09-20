import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createTaskTool } from '../src/agent/vnext/sessionWorkspace/taskTool.js';
import {
  getTask,
  hostTaskMutation,
  listTasks,
  updateTaskControl
} from '../src/agent/vnext/sessionWorkspace/tasks.js';
import {
  contractFingerprint,
  getActiveTaskId,
  normalizeContractDraft,
  putTaskCard
} from '../src/agent/vnext/sessionWorkspace/taskContract.js';
import { formatTaskInstructions } from '../src/agent/vnext/sessionWorkspace/taskInstructions.js';
import { pinFrozenPlan } from '../src/agent/vnext/sessionWorkspace/planContract.js';

function harness(sessionId = 's1') {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({
    store,
    memoryJournal: true,
    callModel: async () => ({ text: 'ok' })
  });
  service.ensureSession(sessionId);
  return { store, service, sessionId };
}

function pendingStart(store, sessionId, draft, extras = {}) {
  const normalized = normalizeContractDraft(draft);
  const fingerprint = contractFingerprint(normalized);
  const cardId = extras.cardId || 'card-start-1';
  putTaskCard(store, sessionId, {
    cardId,
    kind: extras.kind || 'task-start',
    draft: normalized,
    draftSteps: extras.steps || [{ title: 'First step', status: 'pending' }],
    fingerprint,
    status: extras.status || 'pending',
    createdAt: extras.createdAt || Date.now(),
    taskId: extras.taskId || null
  });
  return { cardId, fingerprint, draft: normalized };
}

test('hostTask start ignores approved:true and requires a pending UI card', () => {
  const { store, sessionId } = harness();
  assert.throws(
    () =>
      hostTaskMutation(store, {
        sessionId,
        executionId: 'exec_1',
        input: { op: 'start', goal: 'Do it', approved: true }
      }),
    /card|CARD/i
  );
  assert.equal(listTasks(store, { sessionId }).length, 0);
});

test('confirmed start card creates one task, binds the session, and reuses the receipt', () => {
  const { store, sessionId } = harness();
  const { cardId, fingerprint } = pendingStart(store, sessionId, {
    goal: 'Build the yearly budget',
    scope: 'One workbook',
    constraints: ['No paid API'],
    acceptance: ['TSV exported']
  });
  const first = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_1',
    input: { op: 'start', cardId, fingerprint }
  });
  assert.equal(first.created, true);
  assert.equal(first.task.contract.goal, 'Build the yearly budget');
  assert.equal(first.task.contract.version, 1);
  assert.equal(getActiveTaskId(store, sessionId), first.task.taskId);
  assert.equal(first.task.status, 'running');
  assert.equal(first.task.ownership.executionId, 'exec_1');

  const again = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_1',
    input: { op: 'start', cardId, fingerprint }
  });
  assert.equal(again.reused, true);
  assert.equal(again.task.taskId, first.task.taskId);
  assert.equal(listTasks(store, { sessionId }).length, 1);
});

test('declined, expired, or modified cards cannot create the old task', () => {
  const { store, sessionId } = harness();
  const declined = pendingStart(store, sessionId, { goal: 'Old goal' }, { cardId: 'c-declined', status: 'declined' });
  assert.throws(
    () =>
      hostTaskMutation(store, {
        sessionId,
        input: { op: 'start', cardId: declined.cardId, fingerprint: declined.fingerprint }
      }),
    /card|declined|CARD/i
  );

  const expired = pendingStart(store, sessionId, { goal: 'Expired goal' }, {
    cardId: 'c-expired',
    createdAt: Date.now() - 8 * 60 * 60 * 1000
  });
  assert.throws(
    () =>
      hostTaskMutation(store, {
        sessionId,
        input: { op: 'start', cardId: expired.cardId, fingerprint: expired.fingerprint }
      }),
    /expired/i
  );

  const stale = pendingStart(store, sessionId, { goal: 'Fresh draft' }, { cardId: 'c-stale' });
  assert.throws(
    () =>
      hostTaskMutation(store, {
        sessionId,
        input: { op: 'start', cardId: stale.cardId, fingerprint: 'cfn_tampered' }
      }),
    /modified/i
  );
  assert.equal(listTasks(store, { sessionId }).length, 0);
});

test('task tool start waits for a UI receipt and then binds the current execution', async () => {
  const { store, sessionId } = harness();
  let bound = null;
  const tool = createTaskTool({
    store,
    sessionId,
    waitForClarify: async () => ({ approved: true, decision: 'approve' }),
    getTaskContext: () => (bound?.taskId ? getTask(store, bound.taskId) : null),
    hostTask: (input) => {
      const out = hostTaskMutation(store, {
        sessionId,
        executionId: 'exec_live',
        input
      });
      bound = out.task;
      return out;
    }
  });
  const out = await tool.execute({
    op: 'start',
    goal: 'Export invoices',
    scope: 'This quarter',
    constraints: ['Do not email'],
    acceptance: ['File in /artifacts'],
    steps: [{ title: 'Collect rows', status: 'pending' }]
  });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(getActiveTaskId(store, sessionId), out.task.taskId);
  assert.equal(getTask(store, out.task.taskId).ownership.executionId, 'exec_live');
  const injected = formatTaskInstructions(getTask(store, out.task.taskId));
  assert.match(injected, /Export invoices/);
  assert.match(injected, /user-confirmed contract/);
});

test('ordinary plan pin does not create a durable task', () => {
  const { store, sessionId } = harness();
  const execution = {};
  pinFrozenPlan(execution, { title: 'Look around', steps: [{ title: 'Open tab' }] });
  assert.equal(listTasks(store, { sessionId }).length, 0);
  assert.ok(execution.frozenPlan);
});

test('amend requires a change card and keeps the previous contract version', () => {
  const { store, sessionId } = harness();
  const start = pendingStart(store, sessionId, { goal: 'Draft A', acceptance: ['Ship A'] });
  const created = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_1',
    input: { op: 'start', cardId: start.cardId, fingerprint: start.fingerprint }
  });
  const amendDraft = normalizeContractDraft({ goal: 'Draft B', acceptance: ['Ship B'] });
  const amendPrint = contractFingerprint(amendDraft);
  putTaskCard(store, sessionId, {
    cardId: 'card-amend-1',
    kind: 'task-amend',
    draft: amendDraft,
    fingerprint: amendPrint,
    status: 'pending',
    createdAt: Date.now()
  });
  const amended = hostTaskMutation(store, {
    sessionId,
    taskId: created.task.taskId,
    executionId: 'exec_1',
    input: { op: 'amend', cardId: 'card-amend-1', fingerprint: amendPrint }
  });
  assert.equal(amended.task.contract.goal, 'Draft B');
  assert.equal(amended.task.contract.version, 2);
  assert.equal(amended.task.contractHistory[0].goal, 'Draft A');
});

test('pause keeps the binding; detach and complete stop injecting the old contract', async () => {
  const { store, service, sessionId } = harness();
  const start = pendingStart(store, sessionId, { goal: 'Keep going' });
  const created = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_1',
    input: { op: 'start', cardId: start.cardId, fingerprint: start.fingerprint }
  });
  updateTaskControl(store, created.task.taskId, 'pause');
  assert.equal(getActiveTaskId(store, sessionId), created.task.taskId);

  updateTaskControl(store, created.task.taskId, 'detach');
  assert.equal(getActiveTaskId(store, sessionId), null);
  const unbound = await service.sendMessage({
    sessionId,
    content: 'just chatting after exit',
    callModel: async () => ({ text: 'hello' })
  });
  assert.equal(unbound.task, null);

  const other = pendingStart(store, sessionId, { goal: 'Second job' }, { cardId: 'card-2' });
  const second = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_2',
    input: { op: 'start', cardId: other.cardId, fingerprint: other.fingerprint }
  });
  hostTaskMutation(store, {
    sessionId,
    taskId: second.task.taskId,
    executionId: 'exec_2',
    input: { op: 'complete', summary: 'Done', evidence: ['Checked the file'] }
  });
  assert.equal(getActiveTaskId(store, sessionId), null);
  const afterComplete = formatTaskInstructions(getTask(store, second.task.taskId));
  assert.match(afterComplete, /Second job/);
  const follow = await service.sendMessage({
    sessionId,
    content: 'new topic',
    callModel: async () => ({ text: 'ok' })
  });
  assert.equal(follow.task, null);
  assert.equal(getActiveTaskId(store, sessionId), null);
});

test('bound follow-up attaches the active task without creating another', async () => {
  const { store, service, sessionId } = harness();
  const start = pendingStart(store, sessionId, { goal: 'Bound work' });
  const created = hostTaskMutation(store, {
    sessionId,
    executionId: 'exec_1',
    input: { op: 'start', cardId: start.cardId, fingerprint: start.fingerprint }
  });
  updateTaskControl(store, created.task.taskId, 'pause');
  const follow = await service.sendMessage({
    sessionId,
    content: 'also add a totals row',
    callModel: async () => ({ text: 'ok' })
  });
  assert.equal(follow.task?.taskId, created.task.taskId);
  assert.equal(listTasks(store, { sessionId }).length, 1);
});

test('task start without a waitForClarify host fails closed', async () => {
  const tool = createTaskTool({
    hostTask: async () => ({ ok: true, created: true })
  });
  const out = await tool.execute({ op: 'start', goal: 'Should not create' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TASK_CARD_REQUIRED');
});
