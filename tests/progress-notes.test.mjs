import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROGRESS_NUDGE_MS,
  PROGRESS_NUDGE_STEPS,
  PROGRESS_NUDGE_TEXT,
  appendProgressNote,
  createProgressNoteEmitter,
  createProgressTracker,
  dropEchoedFinalNote,
  progressNotesFromSteps
} from '../src/agent/vnext/sessionWorkspace/progressNotes.js';
import { makeOfficePrepareStep } from '../src/agent/vnext/sessionWorkspace/toolSchedule.js';
import { SessionWorkspaceService, liveTurnProgress } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import {
  applyExecutionStatus,
  createExecutionStatus,
  foldStubFromState,
  formatFoldLine,
  latestActivityShine,
  seedEventsFromLiveProgress,
  statusFromAssistantRecord,
  visibleSummaryRows
} from '../src/sidepanel/executionStatus.js';
import { I18N } from '../src/sidepanel/i18n.js';
import { buildSessionRuntimeInstructions } from '../src/agent/vnext/sessionWorkspace/runtimeInstructions.js';

const zh = (k) => I18N.zh[k] || k;
const en = (k) => I18N.en[k] || k;

function feed(emitter, parts) {
  return parts.map((p) => emitter.ingest(p)).filter(Boolean);
}

test('progress notes come only from steps that end in tool calls', () => {
  const em = createProgressNoteEmitter({ now: () => 42 });
  const notes = feed(em, [
    { type: 'start-step' },
    { type: 'text-delta', text: '已打开订单页，' },
    { type: 'text-delta', text: '接下来读取表格。' },
    { type: 'tool-call', toolName: 'action' },
    { type: 'tool-call', toolName: 'run' },
    { type: 'finish-step', finishReason: 'tool-calls' },
    { type: 'start-step' },
    { type: 'tool-call', toolName: 'run' },
    { type: 'finish-step', finishReason: 'tool-calls' },
    { type: 'start-step' },
    { type: 'text-delta', text: '这是最终回答。' },
    { type: 'finish-step', finishReason: 'stop' }
  ]);
  assert.deepEqual(notes, [
    { type: 'progress-note', text: '已打开订单页，接下来读取表格。', stepIndex: 0, toolIndex: 0, at: 42 }
  ]);
});

test('commentary after the calls of a tool step is emitted at finish-step', () => {
  const em = createProgressNoteEmitter({ now: () => 1 });
  const notes = feed(em, [
    { type: 'start-step' },
    { type: 'tool-call', toolName: 'inspect' },
    { type: 'text-delta', delta: 'Found 3 rows; next I will export them.' },
    { type: 'finish-step', finishReason: { unified: 'tool-calls' } }
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].toolIndex, 1);
  assert.equal(notes[0].stepIndex, 0);
});

test('progressNotesFromSteps mirrors the stream rule over finished steps', () => {
  const notes = progressNotesFromSteps(
    [
      { text: 'Opened the page; reading it next.', toolCalls: [{}, {}], finishReason: 'tool-calls' },
      { text: '', toolCalls: [{}], finishReason: 'tool-calls' },
      { text: 'Final answer', toolCalls: [], finishReason: 'stop' }
    ],
    { now: 5 }
  );
  assert.deepEqual(notes, [
    { type: 'progress-note', text: 'Opened the page; reading it next.', stepIndex: 0, toolIndex: 0, at: 5 }
  ]);
});

test('note text is bounded and empty notes are dropped', () => {
  let list = appendProgressNote([], { text: '   ', at: 1 });
  assert.equal(list.length, 0);
  list = appendProgressNote(list, { text: 'x'.repeat(2000), at: 2, stepIndex: 3, toolIndex: 4 });
  assert.equal(list.length, 1);
  assert.ok(list[0].text.length <= 601);
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'stepIndex', 'text', 'toolIndex']);
  assert.deepEqual(dropEchoedFinalNote([{ text: 'a' }, { text: 'same' }], ' same '), [{ text: 'a' }]);
  assert.deepEqual(dropEchoedFinalNote([{ text: 'a' }], 'other'), [{ text: 'a' }]);
});

test('nudge fires after 6 quiet steps, once per gap, and re-arms after a note', () => {
  const t0 = 1_000_000;
  const tr = createProgressTracker({ startedAt: t0 });
  assert.equal(tr.nudge({ steps: 0, now: t0 + PROGRESS_NUDGE_MS * 2 }), '', 'no nudge before any step finished');
  assert.equal(tr.nudge({ steps: PROGRESS_NUDGE_STEPS - 1, now: t0 + 1000 }), '');
  assert.equal(tr.nudge({ steps: PROGRESS_NUDGE_STEPS, now: t0 + 1000 }), PROGRESS_NUDGE_TEXT);
  assert.equal(tr.nudge({ steps: PROGRESS_NUDGE_STEPS + 3, now: t0 + 2000 }), '', 'only once per gap');
  tr.markNote({ stepIndex: 9, at: t0 + 3000 });
  assert.equal(tr.nudge({ steps: 12, now: t0 + 4000 }), '', 'new gap starts at the note');
  assert.equal(tr.nudge({ steps: 16, now: t0 + 4000 }), PROGRESS_NUDGE_TEXT);
});

test('nudge fires after 60 s of turn time even with few steps', () => {
  const t0 = 5_000;
  const tr = createProgressTracker({ startedAt: t0 });
  assert.equal(tr.nudge({ steps: 1, now: t0 + PROGRESS_NUDGE_MS - 1 }), '');
  assert.equal(tr.nudge({ steps: 2, now: t0 + PROGRESS_NUDGE_MS }), PROGRESS_NUDGE_TEXT);
  assert.equal(tr.nudge({ steps: 3, now: t0 + PROGRESS_NUDGE_MS * 3 }), '');
});

test('prepareStep appends the nudge to instructions only when due', async () => {
  const tr = createProgressTracker({ startedAt: Date.now() });
  const prepare = makeOfficePrepareStep({ instructions: 'BASE', progress: tr });
  const early = await prepare({ steps: [{}, {}] });
  assert.doesNotMatch(String(early.instructions || ''), /Progress reminder/);
  const due = await prepare({ steps: new Array(PROGRESS_NUDGE_STEPS).fill({}) });
  assert.match(due.instructions, /^BASE\n\nProgress reminder \(host\)/);
  const again = await prepare({ steps: new Array(PROGRESS_NUDGE_STEPS + 1).fill({}) });
  assert.doesNotMatch(String(again.instructions || ''), /Progress reminder/);
});

test('runtime instructions preserve milestone progress in the same step as tool calls', () => {
  const text = buildSessionRuntimeInstructions();
  assert.match(text, /write one or two progress sentences before the tool calls in that same step/);
  assert.match(text, /a step without a tool call ends the turn/);
});

function serviceWithSession(sessionId = 's1') {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true, callModel: async () => ({ text: 'ok' }) });
  service.ensureSession(sessionId);
  return { store, service, sessionId };
}

const inspectCall = (id) => ({ id, name: 'inspect', args: { view: 'artifacts' } });

test('completed turn: notes persist on the one assistant record, live slot is visible mid-turn', async () => {
  const { store, service, sessionId } = serviceWithSession();
  const events = [];
  let midTurn = null;
  let calls = 0;
  const result = await service.sendMessage({
    sessionId,
    content: '整理订单',
    onEvent: (ev) => events.push(ev),
    callModel: async () => {
      calls += 1;
      if (calls === 1) return { text: '先看看会话里已有的文件。', toolCalls: [inspectCall('c1')] };
      if (calls === 2) {
        midTurn = {
          slot: store.get('sessions', sessionId).turnProgress,
          live: (await service.getSession({ sessionId })).liveProgress
        };
        return { text: '没有现成文件，接下来自己整理。', toolCalls: [inspectCall('c2')] };
      }
      return { text: '整理完成。' };
    }
  });
  assert.equal(midTurn.slot.notes.length, 1);
  assert.equal(midTurn.slot.notes[0].text, '先看看会话里已有的文件。');
  assert.equal(midTurn.live.executionId, result.executionId);
  assert.equal(midTurn.live.notes[0].text, '先看看会话里已有的文件。');

  const notesEv = events.filter((e) => e.type === 'progress-note');
  assert.equal(notesEv.length, 2);
  for (const ev of notesEv) {
    assert.equal(ev.sessionId, sessionId);
    assert.equal(ev.executionId, result.executionId);
    assert.equal(typeof ev.text, 'string');
    assert.equal(typeof ev.at, 'number');
    assert.equal(typeof ev.stepIndex, 'number');
    assert.equal(typeof ev.toolIndex, 'number');
  }
  const firstNote = events.findIndex((e) => e.type === 'progress-note');
  const firstCall = events.findIndex((e) => e.type === 'tool-call');
  assert.ok(firstNote >= 0 && firstNote < firstCall, 'note precedes its step tool row');

  const sess = store.get('sessions', sessionId);
  assert.equal('turnProgress' in sess, false, 'in-flight slot cleared on settle');
  const assistants = sess.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'no extra assistant messages');
  const rec = assistants[0];
  assert.equal(rec.status, 'completed');
  assert.equal(rec.executionId, result.executionId);
  assert.equal(rec.content, '整理完成。');
  assert.deepEqual(rec.progress.map((n) => [n.text, n.stepIndex, n.toolIndex]), [
    ['先看看会话里已有的文件。', 0, 0],
    ['没有现成文件，接下来自己整理。', 1, 1]
  ]);
  assert.ok(!rec.progress.some((n) => n.text === rec.content), 'final answer is not a note');
  assert.equal((await service.getSession({ sessionId })).liveProgress, null);
});

test('failed turn keeps the notes it already wrote', async () => {
  const { store, service, sessionId } = serviceWithSession();
  let calls = 0;
  await assert.rejects(
    service.sendMessage({
      sessionId,
      content: 'go',
      callModel: async () => {
        calls += 1;
        if (calls === 1) return { text: 'Checked the files; trying the export next.', toolCalls: [inspectCall('c1')] };
        throw Object.assign(new Error('provider down'), { code: 'PROVIDER' });
      }
    })
  );
  const sess = store.get('sessions', sessionId);
  const rec = sess.messages.filter((m) => m.role === 'assistant').pop();
  assert.equal(rec.status, 'failed');
  assert.equal(rec.progress.length, 1);
  assert.equal(rec.progress[0].text, 'Checked the files; trying the export next.');
  assert.ok(rec.executionId);
  assert.equal('turnProgress' in sess, false);
});

test('aborted turn keeps the notes it already wrote', async () => {
  const { store, service, sessionId } = serviceWithSession();
  let calls = 0;
  await assert.rejects(
    service.sendMessage({
      sessionId,
      content: 'go',
      callModel: async ({ signal }) => {
        calls += 1;
        if (calls === 1) return { text: 'Step one done; starting step two.', toolCalls: [inspectCall('c1')] };
        void service.abortCurrentExecution({ sessionId });
        await new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason || new Error('aborted'));
          signal?.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
        });
      }
    })
  );
  const rec = store.get('sessions', sessionId).messages.filter((m) => m.role === 'assistant').pop();
  assert.equal(rec.status, 'aborted');
  assert.deepEqual(rec.progress.map((n) => n.text), ['Step one done; starting step two.']);
});

test('liveTurnProgress ignores a slot left by another (crashed) execution', () => {
  const session = { turnProgress: { executionId: 'old', startedAt: 1, notes: [{ text: 'x' }] } };
  assert.equal(liveTurnProgress(session, { executionId: 'new' }), null);
  assert.equal(liveTurnProgress(session, null), null);
  assert.deepEqual(liveTurnProgress(session, { executionId: 'old' }).notes, [{ text: 'x' }]);
});

// ── Side panel timeline ──

function run(events) {
  let state = createExecutionStatus({ sessionId: 's' });
  for (const ev of events) state = applyExecutionStatus(state, ev, { lang: 'zh' });
  return state;
}

test('progress-note is a timeline row, never execution current', () => {
  const state = run([
    { type: 'execution-start', executionId: 'e1', startedAt: 1_000 },
    { type: 'progress-note', text: '已打开页面，接下来填写表单。', stepIndex: 0, toolIndex: 0, at: 1_500 },
    { type: 'tool-call', toolCallId: 'c1', name: 'action', args: { op: 'fill', name: '姓名' } }
  ]);
  assert.equal(state.summary[0].kind, 'note');
  assert.equal(state.summary[0].label, '已打开页面，接下来填写表单。');
  assert.equal(state.summary[1].tool, 'action');
  assert.equal(state.noteCount, 1);
  assert.equal(state.current.tool, 'action');
  const only = run([
    { type: 'execution-start', executionId: 'e1' },
    { type: 'progress-note', text: 'note', stepIndex: 0, toolIndex: 0, at: 1 }
  ]);
  assert.equal(only.current, null);
  assert.equal(only.phase, 'running');
  const dup = applyExecutionStatus(only, { type: 'progress-note', text: 'note', stepIndex: 0, toolIndex: 0, at: 1 });
  assert.equal(dup.noteCount, 1, 'same note id is not painted twice');
});

test('timeline keeps every note while activity rows keep the live window', () => {
  const events = [{ type: 'execution-start', executionId: 'e1' }];
  for (let i = 0; i < 30; i += 1) {
    if (i % 10 === 0) events.push({ type: 'progress-note', text: `note ${i}`, stepIndex: i, toolIndex: i, at: i + 1 });
    events.push({ type: 'tool-call', toolCallId: `c${i}`, name: 'run', args: { op: 'write_artifact', path: `/artifacts/f${i}.txt` } });
  }
  const state = run(events);
  const rows = visibleSummaryRows(state.summary, 8);
  assert.deepEqual(rows.filter((r) => r.kind === 'note').map((r) => r.label), ['note 0', 'note 10', 'note 20']);
  assert.equal(rows.filter((r) => r.kind !== 'note').length, 8);
  const shine = latestActivityShine(state);
  assert.equal(shine.rowId, 'c29');
  const noteLast = applyExecutionStatus(state, { type: 'progress-note', text: 'tail', stepIndex: 99, toolIndex: 30, at: 99 });
  assert.equal(latestActivityShine(noteLast).rowId, 'c29', 'shine skips the note');
});

test('fold line counts notes and files in zh and en', () => {
  assert.equal(
    formatFoldLine({ phase: 'completed', durationMs: 480_000, noteCount: 5, artifactCount: 2 }, zh),
    '完成 · 8 分 · 5 条进度 · 2 个文件'
  );
  assert.equal(formatFoldLine({ phase: 'completed', durationMs: 12_000, noteCount: 1 }, zh), '完成 · 12 秒 · 1 条进度');
  assert.equal(formatFoldLine({ phase: 'failed', durationMs: 12_000, noteCount: 3, artifactCount: 1 }, en), 'Failed · 12s · 3 updates · 1 file');
  assert.equal(formatFoldLine({ phase: 'stopped', durationMs: 12_000, noteCount: 1 }, en), 'Stopped · 12s · 1 update');
  assert.equal(formatFoldLine({ phase: 'completed', durationMs: 12_000 }, zh), '完成 · 12 秒');

  const state = run([
    { type: 'execution-start', executionId: 'e1', startedAt: 1_000 },
    { type: 'progress-note', text: 'a', stepIndex: 0, toolIndex: 0, at: 1 },
    { type: 'progress-note', text: 'b', stepIndex: 1, toolIndex: 0, at: 2 },
    { type: 'execution-end', status: 'completed', endedAt: 61_000 }
  ]);
  assert.equal(foldStubFromState(state, zh).line, '完成 · 1 分 · 2 条进度');
});

test('final answer equal to the last note drops that note (task-yield echo)', () => {
  const state = run([
    { type: 'execution-start', executionId: 'e1' },
    { type: 'progress-note', text: 'Waiting until 9:00 to check again.', stepIndex: 0, toolIndex: 0, at: 1 },
    { type: 'assistant-final', content: 'Waiting until 9:00 to check again.' }
  ]);
  assert.equal(state.noteCount, 0);
  assert.equal(state.summary.some((r) => r.kind === 'note'), false);
});

test('restore rebuilds the folded line and interleaved notes from the persisted record', () => {
  const record = {
    role: 'assistant',
    messageId: 'm9',
    executionId: 'exec_9',
    status: 'completed',
    content: 'Done.',
    startedAt: 10_000,
    endedAt: 10_000 + 8 * 60_000,
    toolCalls: [
      { toolName: 'inspect', toolCallId: 'c1', args: { view: 'artifacts' }, result: { ok: true } },
      { toolName: 'run', toolCallId: 'c2', args: { op: 'write_artifact', path: '/artifacts/a.csv' }, result: { ok: true, artifactId: 'a1' } },
      { toolName: 'run', toolCallId: 'c3', args: { op: 'write_artifact', path: '/artifacts/b.csv' }, result: { ok: true, artifactId: 'a2' } }
    ],
    progress: [
      { at: 10_500, text: 'Looking at existing files first.', stepIndex: 0, toolIndex: 0 },
      { at: 70_000, text: 'Nothing usable; writing both CSVs now.', stepIndex: 1, toolIndex: 1 }
    ]
  };
  const state = statusFromAssistantRecord(record, { lang: 'zh' });
  assert.equal(state.phase, 'completed');
  assert.equal(state.executionId, 'exec_9');
  assert.deepEqual(
    state.summary.map((r) => (r.kind === 'note' ? `note:${r.label}` : `row:${r.id}`)),
    ['note:Looking at existing files first.', 'row:c1', 'note:Nothing usable; writing both CSVs now.', 'row:c2', 'row:c3']
  );
  assert.equal(foldStubFromState(state, zh).line, '完成 · 8 分 · 2 条进度 · 2 个文件');
  assert.equal(state.summary.find((r) => r.id === 'c1').at, 0, 'replayed tool rows carry no invented time');
  assert.equal(statusFromAssistantRecord({ ...record, progress: [] }), null, 'records without notes keep the old restore');
  const failed = statusFromAssistantRecord({ ...record, status: 'aborted', toolCalls: [] }, { lang: 'en' });
  assert.match(foldStubFromState(failed, en).line, /^Stopped · 8m · 2 updates$/);
});

test('reopened panel seeds only the running execution notes it lacks', () => {
  const slot = {
    executionId: 'e1',
    startedAt: 5,
    notes: [
      { at: 6, text: 'one', stepIndex: 0, toolIndex: 0 },
      { at: 7, text: 'two', stepIndex: 2, toolIndex: 3 }
    ]
  };
  const fresh = seedEventsFromLiveProgress(createExecutionStatus(), slot, 's');
  assert.deepEqual(fresh.map((e) => e.type), ['execution-start', 'progress-note', 'progress-note']);
  let state = createExecutionStatus();
  for (const ev of fresh) state = applyExecutionStatus(state, ev);
  assert.equal(state.phase, 'running');
  assert.equal(state.noteCount, 2);
  assert.deepEqual(seedEventsFromLiveProgress(state, slot, 's'), []);
  const partial = run([
    { type: 'execution-start', executionId: 'e1' },
    { type: 'progress-note', text: 'one', stepIndex: 0, toolIndex: 0, at: 6 }
  ]);
  assert.deepEqual(seedEventsFromLiveProgress(partial, slot, 's').map((e) => e.text), ['two']);
  assert.deepEqual(seedEventsFromLiveProgress(partial, null, 's'), []);
});

test('turn durations read naturally in the UI language', async () => {
  const { formatDisclosureDuration } = await import('../src/sidepanel/executionStatus.js');
  assert.equal(formatDisclosureDuration(5_000, zh), '5 秒');
  assert.equal(formatDisclosureDuration(485_000, zh), '8 分 5 秒');
  assert.equal(formatDisclosureDuration(3_780_000, zh), '1 小时 3 分');
  assert.equal(formatDisclosureDuration(485_000, en), '8m 5s');
  assert.equal(formatDisclosureDuration(3_600_000, en), '1h');
  assert.equal(formatDisclosureDuration(5_000), '5s');
});
