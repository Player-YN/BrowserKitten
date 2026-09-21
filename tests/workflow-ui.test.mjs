import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowBindableAliases, workflowRecordId, workflowRecordingRequest, workflowRunDefinition, workflowTrialBoundary } from '../src/sidepanel/workflowUi.js';

test('workflow UI uses persisted record ids and nested published definition', () => {
  const workflow = { version: 1, tabs: [{ id: 'main', title: 'Main' }], steps: [{ id: 'click-save', op: 'click', title: 'Save', tab: 'main' }] };
  const run = { id: 'workflow_1', definition: { entryId: 'entry_1', workflow } };
  assert.equal(workflowRecordId(run), 'workflow_1');
  assert.deepEqual(workflowRunDefinition(run), workflow);
  assert.equal(workflowTrialBoundary(workflow.steps[0]), 'click-save');
  assert.deepEqual(workflowRecordingRequest({ id: 'recording_1' }, 'addTab', 42), { recordingId: 'recording_1', action: 'addTab', tabId: 42 });
});

test('binding UI excludes aliases produced by future open and click steps', () => {
  const workflow = { version: 1, tabs: [{ id: 'main' }, { id: 'opened' }, { id: 'popup' }], steps: [
    { id: 'open', op: 'open', tab: 'opened' },
    { id: 'click', op: 'click', tab: 'main', opensTab: 'popup' }
  ] };
  assert.deepEqual(workflowBindableAliases(workflow).map(x => x.id), ['main']);
  assert.deepEqual(workflowBindableAliases(workflow, 1).map(x => x.id), ['main', 'opened']);
  assert.deepEqual(workflowBindableAliases(workflow, 1, true).map(x => x.id), ['main', 'opened', 'popup']);
});
