import test from 'node:test';
import assert from 'node:assert/strict';

import { applyRecordingEvent } from '../src/agent/vnext/workflow/recording.js';

const field = { role: 'textbox', name: 'Name' };
const button = { role: 'button', name: 'Continue' };

function recording(extra = {}) {
  return {
    id: 'recording-1', status: 'recording', sequence: 0, tabAliases: { 10: 'main' },
    definition: { workflow: { version: 2, tabs: [{ id: 'main', title: 'Main', url: 'https://example.test/' }], steps: [] } },
    ...extra,
  };
}

const event = (type, extra = {}) => ({ type, tabId: 10, frameId: 0, at: 1000, ...extra });

test('contiguous fills on the same target coalesce to the final value', () => {
  let record = applyRecordingEvent(recording(), event('fill', { target: field, value: 'K' }));
  record = applyRecordingEvent(record, event('fill', { target: field, value: 'Kitten', at: 1100 }));
  assert.equal(record.definition.workflow.steps.length, 1);
  assert.equal(record.definition.workflow.steps[0].value, 'Kitten');
  assert.deepEqual(record.definition.workflow.steps[0].check, { type: 'value', equals: 'Kitten' });
});

test('sensitive event values are never persisted', () => {
  const secret = 'correct horse battery staple';
  const record = applyRecordingEvent(recording(), event('fill', { target: field, value: secret, sensitive: true }));
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.deepEqual(record.definition.workflow.steps, [
    { id: 'step1', title: 'Complete sensitive input manually, then continue', op: 'manual' },
  ]);
});

test('unsupported actions become unresolved manual review steps', () => {
  const record = applyRecordingEvent(recording(), event('unsupported', { detail: { arbitrary: true } }));
  assert.equal(record.definition.workflow.steps[0].op, 'manual');
  assert.equal(record.definition.workflow.steps[0].unresolved, true);
});

test('events from tabs outside the recording enrollment are ignored', () => {
  const before = recording();
  const after = applyRecordingEvent(before, event('click', { tabId: 99, target: button }));
  assert.deepEqual(after.definition.workflow.steps, []);
  assert.deepEqual(before.definition.workflow.steps, []);
});

test('click followed by same-tab navigation remains one checked action', () => {
  let record = applyRecordingEvent(recording(), event('click', { target: button }));
  record = applyRecordingEvent(record, event('navigation', { url: 'https://example.test/next', at: 1200 }));
  assert.equal(record.definition.workflow.steps.length, 1);
  assert.equal(record.definition.workflow.steps[0].op, 'click');
  assert.deepEqual(record.definition.workflow.steps[0].check, { type: 'url', equals: 'https://example.test/next' });
  assert.equal(record.definition.workflow.steps[0].unresolved, undefined);
});

test('click opening a new tab followed by its navigation does not add a duplicate navigate step', () => {
  let record = recording();
  record.tabAliases[20] = 'child';
  record.definition.workflow.tabs.push({ id: 'child', title: 'Child', opener: 'main' });
  record = applyRecordingEvent(record, event('click', { target: button }));
  record = applyRecordingEvent(record, event('newTab', { newTabId: 20, at: 1100 }));
  record = applyRecordingEvent(record, event('navigation', { tabId: 20, url: 'https://example.test/child', at: 1200 }));

  assert.equal(record.definition.workflow.steps.length, 1);
  assert.equal(record.definition.workflow.steps[0].op, 'click');
  assert.equal(record.definition.workflow.steps[0].opensTab, 'child');
  assert.deepEqual(record.definition.workflow.steps[0].check, { type: 'url', equals: 'https://example.test/child', tab: 'child' });
});

test('Enter followed by navigation is associated with the press action', () => {
  let record = applyRecordingEvent(recording(), event('press', { target: field, key: 'Enter' }));
  record = applyRecordingEvent(record, event('navigation', { url: 'https://example.test/results', at: 1200 }));

  assert.equal(record.definition.workflow.steps.length, 1);
  assert.equal(record.definition.workflow.steps[0].op, 'press');
  assert.equal(record.definition.workflow.steps[0].key, 'Enter');
  assert.deepEqual(record.definition.workflow.steps[0].check, { type: 'url', equals: 'https://example.test/results' });
  assert.equal(record.definition.workflow.steps[0].unresolved, undefined);
});
