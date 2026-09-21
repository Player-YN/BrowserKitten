import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_VERSION, validateWorkflow, resolveData, resolveTarget, parseWorkflowCsv, serializeWorkflowCsv,
  assertCollectionItems, extractScrape, cssUsesNth
} from '../src/agent/vnext/workflow/definition.js';
import { executeWorkflow } from '../src/agent/vnext/workflow/engine.js';
import { applyRecordingEvent } from '../src/agent/vnext/workflow/recording.js';
import { sanitizeWorkflowRecordingEvent } from '../src/agent/vnext/host/workflowHost.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createMemoryPersonalLibraryAdapter, openPersonalLibraryStore } from '../src/agent/vnext/sessionWorkspace/personalLibraryStore.js';
import { createWorkflowScheduler, WORKFLOW_WAKE_ALARM } from '../src/agent/vnext/host/workflowScheduler.js';

const button = { role: 'button', name: 'Save' };
const wf = (steps, extra = {}) => ({ version: WORKFLOW_VERSION, tabs: [{ id: 'main', title: 'Main', url: 'https://example.test/' }], steps, ...extra });

function makeRun(steps, extra = {}) {
  return {
    id: 'run-1', status: 'paused', nextStep: 0, input: {}, outputs: {}, attempts: [], attempt: null,
    bindings: { main: 11 }, startedAt: 1, vars: {}, table: { columns: [], rows: [] },
    definition: { workflow: wf(steps) },
    ...extra,
  };
}
function hostWith(overrides = {}) {
  let stored;
  return {
    save: async value => (stored = structuredClone(value)),
    event() {},
    observe: async () => ({ url: 'https://example.test/', rev: 'rev-1', controls: [{ ...button, ref: 'button-1', visible: true }] }),
    action: async () => ({ ok: true, result: { acknowledged: true } }),
    tabs: async () => [{ id: 11, url: 'https://example.test/' }],
    sys: async () => ({ ok: true }),
    tool: async () => ({ ok: true, result: true }),
    fileExists: async () => false,
    download: async () => false,
    writeFile: async () => {},
    get stored() { return stored; },
    ...overrides,
  };
}

test('workflow contract is version 2 and accepts loops, scrape, and schedule', () => {
  const definition = wf([
    { id: 'rows', title: 'Import', op: 'csvImport', value: 'name,url\nA,https://a.test' },
    {
      id: 'each', title: 'Each', op: 'foreach', collection: { $ref: 'table.rows' },
      steps: [
        { id: 'use', title: 'Use row', op: 'manual', value: { $ref: 'loop.row.name' } }
      ]
    },
    { id: 'list', title: 'Scrape', op: 'scrape', tab: 'main', kind: 'links', target: { role: 'link', name: 'More' }, itemKey: 'href' },
    {
      id: 'branch', title: 'Branch', op: 'if', when: { $ref: 'steps.list.count' },
      then: [{ id: 'ok', title: 'OK', op: 'manual' }],
      else: [{ id: 'empty', title: 'Empty', op: 'manual' }]
    }
  ], { table: { columns: ['name'], rows: [] }, schedule: { enabled: true, everyMinutes: 30 } });
  assert.deepEqual(validateWorkflow(definition), definition);
});

test('structured $ref reads loop row fields and table rows', () => {
  assert.equal(resolveData({ $ref: 'loop.row.title' }, {}, {}, { loop: { row: { title: 'Kitten' }, index: 0 } }), 'Kitten');
  assert.deepEqual(resolveData({ $ref: 'table.rows' }, {}, {}, { table: { columns: ['n'], rows: [{ n: '1' }] } }), [{ n: '1' }]);
});

test('CSV import/export keeps identifiers and quoted cells', () => {
  const parsed = parseWorkflowCsv('name,url\n"Kitten, Jr",https://k.test');
  assert.deepEqual(parsed.columns, ['name', 'url']);
  assert.equal(parsed.rows[0].name, 'Kitten, Jr');
  assert.match(serializeWorkflowCsv(parsed), /"Kitten, Jr"/);
});

test('foreach over table rows exposes $ref to the current row', async () => {
  const filled = [];
  const host = hostWith({
    observe: async () => ({ rev: 'r', controls: [{ role: 'textbox', name: 'Name', ref: 'n', visible: true }] }),
    action: async payload => { filled.push(payload.value); return { ok: true }; }
  });
  const run = makeRun([
    {
      id: 'each', title: 'Each', op: 'foreach', collection: { $ref: 'table.rows' },
      steps: [{
        id: 'fill', title: 'Fill', op: 'fill', tab: 'main', target: { role: 'textbox', name: 'Name' },
        value: { $ref: 'loop.row.name' }, check: { type: 'visible' }
      }]
    }
  ], { table: { columns: ['name'], rows: [{ name: 'Ada' }, { name: 'Grace' }] } });
  const result = await executeWorkflow(run, host, { controller: new AbortController() });
  assert.equal(result.status, 'completed');
  assert.deepEqual(filled, ['Ada', 'Grace']);
});

test('element foreach rejects nth-child identity and duplicate keys', () => {
  assert.throws(() => assertCollectionItems([
    { key: 'a', target: { css: 'li:nth-child(1)' } }
  ], { source: 'elements' }), /nth-child|stable/);
  assert.throws(() => assertCollectionItems([
    { key: 'same', target: { name: 'One' } }, { key: 'same', target: { name: 'Two' } }
  ], { source: 'elements' }), /unique/i);
  assert.equal(cssUsesNth('ul > li:nth-of-type(3)'), true);
});

test('unique-match still stops inside a loop body', async () => {
  let actions = 0;
  const host = hostWith({
    observe: async () => ({ rev: 'r', controls: [
      { role: 'button', name: 'Open', ref: 'one', visible: true },
      { role: 'button', name: 'Open', ref: 'two', visible: true }
    ] }),
    action: async () => { actions++; return { ok: true }; }
  });
  const result = await executeWorkflow(makeRun([
    {
      id: 'each', title: 'Each', op: 'foreach', collection: [{ name: 'A' }],
      steps: [{ id: 'open', title: 'Open', op: 'click', tab: 'main', target: { role: 'button', name: 'Open' }, check: { type: 'visible' } }]
    }
  ]), host, { controller: new AbortController() });
  assert.equal(actions, 0);
  assert.equal(result.status, 'needs_human');
  assert.equal(result.error.code, 'WORKFLOW_AMBIGUOUS');
});

test('scrape keeps unique keys and rejects nth-child item targets', () => {
  const scraped = extractScrape({
    items: [
      { key: 'https://a.test', href: 'https://a.test', target: { name: 'A', role: 'link' } },
      { key: 'https://b.test', href: 'https://b.test', target: { name: 'B', role: 'link' } }
    ]
  }, { kind: 'links', itemKey: 'href' });
  assert.equal(scraped.count, 2);
  assert.throws(() => extractScrape({ items: [{ key: 'x', target: { css: 'a:nth-child(2)' } }] }, { kind: 'links' }), /nth-child/);
});

test('if/else selects a branch from prior output', async () => {
  const run = makeRun([
    { id: 'read', title: 'Read', op: 'read', tab: 'main', target: { role: 'button', name: 'Save' } },
    {
      id: 'branch', title: 'If', op: 'if',
      when: { left: { $ref: 'steps.read.text' }, equals: 'Save' },
      then: [{ id: 'yes', title: 'Yes', op: 'manual' }],
      else: [{ id: 'no', title: 'No', op: 'manual' }]
    }
  ]);
  const result = await executeWorkflow(run, hostWith({
    observe: async () => ({ rev: 'r', controls: [{ role: 'button', name: 'Save', text: 'Save', ref: 'b', visible: true }] })
  }), { controller: new AbortController() });
  assert.equal(result.status, 'needs_human');
  assert.equal(result.outputs.branch.branch, 'then');
  assert.equal(result.error.code, 'WORKFLOW_MANUAL');
  assert.match(result.error.message, /Yes/);
});

test('on-error fallback journals the failed write and does not skip unknown dispatch', async () => {
  let writes = 0;
  const fallback = await executeWorkflow(makeRun([
    {
      id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, timeoutMs: 100,
      check: { type: 'text', contains: 'Saved' },
      onError: { action: 'fallback', fallback: [{ id: 'note', title: 'Fallback', op: 'manual' }] }
    }
  ]), hostWith({
    observe: async () => ({ rev: 'r', text: 'Editing', controls: [{ ...button, ref: 'b', visible: true }] }),
    action: async () => { writes++; return { ok: true }; }
  }), { controller: new AbortController() });
  assert.equal(writes, 1);
  assert.equal(fallback.status, 'needs_human');
  assert.equal(fallback.outputs.save.error.code, 'WORKFLOW_CHECK_FAILED');
  assert.match(fallback.error.message, /Fallback/);

  const unknown = await executeWorkflow(makeRun([
    {
      id: 'save', title: 'Save', op: 'click', tab: 'main', target: button, check: { type: 'visible' },
      onError: { action: 'fallback', fallback: [{ id: 'note', title: 'Should not run', op: 'manual' }] }
    }
  ]), hostWith({ action: async () => { throw new Error('connection lost'); } }), { controller: new AbortController() });
  assert.equal(unknown.status, 'needs_human');
  assert.equal(unknown.attempt.phase, 'dispatching');
  assert.equal(unknown.outputs.note, undefined);
});

test('hover and upload dispatch through the existing page action host', async () => {
  const calls = [];
  const file = { name: 'File', role: 'button' };
  const host = hostWith({
    observe: async (_tab, target) => ({
      rev: 'r',
      controls: target?.name === 'File'
        ? [{ ...file, ref: 'file', visible: true }]
        : [{ ...button, ref: 'button-1', visible: true }]
    }),
    action: async payload => { calls.push(payload); return { ok: true }; }
  });
  const result = await executeWorkflow(makeRun([
    { id: 'hover', title: 'Hover', op: 'hover', tab: 'main', target: button, check: { type: 'visible' } },
    { id: 'upload', title: 'Upload', op: 'upload', tab: 'main', target: file, path: '/scratch/doc.csv', check: { type: 'visible' } }
  ]), host, { controller: new AbortController() });
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].op, 'hover');
  assert.equal(calls[1].op, 'upload');
  assert.equal(calls[1].path, '/scratch/doc.csv');
});

test('iframe and shadow constraints stay unique-match fields', () => {
  const snapshot = { controls: [
    { ref: 'a', name: 'Save', shadowPath: 'host >> inner', frameUrl: 'https://child.test/', visible: true },
    { ref: 'b', name: 'Save', shadowPath: '', frameUrl: 'https://example.test/', visible: true }
  ] };
  assert.equal(resolveTarget(snapshot, { name: 'Save', shadowPath: 'host >> inner', frameUrl: 'https://child.test/' }).ref, 'a');
  assert.throws(() => resolveTarget(snapshot, { name: 'Save' }), { code: 'WORKFLOW_AMBIGUOUS' });
});

test('recording captures hover, toggle, and drag as an explicit manual gap', () => {
  const rec = { id: 'r', status: 'recording', sequence: 0, tabAliases: { 10: 'main' }, definition: { workflow: wf([]) } };
  const event = (type, extra = {}) => ({ type, tabId: 10, frameId: 0, at: 1000, ...extra });
  let record = applyRecordingEvent(rec, event('hover', { target: button }));
  record = applyRecordingEvent(record, event('toggle', { target: { role: 'checkbox', name: 'Agree' }, checked: true }));
  record = applyRecordingEvent(record, event('unsupported', { unresolvedReason: 'DRAG_UNSUPPORTED' }));
  assert.equal(record.definition.workflow.steps[0].op, 'hover');
  assert.equal(record.definition.workflow.steps[1].op, 'toggle');
  assert.equal(record.definition.workflow.steps[2].unresolvedReason, 'DRAG_UNSUPPORTED');
  assert.equal(sanitizeWorkflowRecordingEvent({ type: 'hover', target: { name: 'Menu' } }).type, 'hover');
});

test('a due alarm starts a new published run and never resumes a crashed one', async () => {
  const adapter = createMemoryPersonalLibraryAdapter();
  const library = await openPersonalLibraryStore({ adapter });
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({
    store, personalLibraryStore: library, memoryJournal: true,
    workflowHost: async op => op === 'tabs' ? [{ id: 7, url: 'https://example.test/', title: 'Page' }] : { ok: true },
    callModel: () => { throw new Error('MODEL MUST NOT RUN'); }
  });
  service._releaseTabLeases = async () => {};
  service._cleanupExecutionPolicy = async () => {};
  const made = await service.createWorkflowDraft({ name: 'Scheduled' });
  const workflow = wf([
    { id: 'click', title: 'Save', op: 'click', tab: 'main', target: button, check: { type: 'visible' } }
  ], { schedule: { enabled: true, everyMinutes: 15 } });
  const { draft } = await service.updateWorkflowDraft({ draftId: made.draftId, expectedRevision: made.draft.revision, patch: { workflow } });
  const entry = await service.publishLibraryDraft({ draftId: draft.draftId, expectedRevision: draft.revision });
  const crashedSession = service.runtime.createSession({ title: 'Crashed' });
  await library.putWorkflowRecord({ expectedRevision: 0, record: {
    id: 'crashed', type: 'run', status: 'needs_human', recovering: true, sessionId: crashedSession.sessionId,
    entryId: entry.entryId, definition: entry, bindings: { main: 7 }, input: {}, outputs: {}, nextStep: 0,
    attempts: [], attempt: { id: 'old', writes: true, phase: 'dispatching', stepId: 'click' }
  } });
  service._gatedPageAction = async payload => payload.op === 'snapshot'
    ? { ok: true, rev: 'r', controls: [{ ...button, ref: 'f0.a1', visible: true }] }
    : { ok: true };
  const due = await service.runDueWorkflows({ now: Date.now() });
  assert.equal(due.launched.length, 1);
  assert.notEqual(due.launched[0].runId, 'crashed');
  const crashed = await service.getWorkflowRun({ runId: 'crashed' });
  assert.equal(crashed.status, 'needs_human');
  assert.equal(crashed.attempt.phase, 'dispatching');
  await service._workflows.active.get(due.launched[0].runId)?.finished;
  const fresh = await service.getWorkflowRun({ runId: due.launched[0].runId });
  assert.equal(fresh.trigger, 'schedule');
  assert.notEqual(fresh.id, 'crashed');

  const alarms = new Map();
  const scheduler = createWorkflowScheduler({
    alarms: {
      get: async name => alarms.get(name) || null,
      create: async (name, info) => { alarms.set(name, { name, scheduledTime: info.when || Date.now() + 60_000 }); },
      clear: async name => alarms.delete(name)
    },
    rpc: async method => method === 'getWorkflowSchedule' ? { nextWakeAt: Date.now() + 60_000 } : due,
    now: () => Date.now()
  });
  await scheduler.onAlarm({ name: WORKFLOW_WAKE_ALARM });
  assert.ok(alarms.has(WORKFLOW_WAKE_ALARM));
});
