import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveData,
  resolveTarget,
  sanitizeRecordedUrl,
  validateWorkflow,
} from '../src/agent/vnext/workflow/definition.js';

const target = { role: 'button', name: 'Save' };

function workflow(steps, tabs = [{ id: 'main', title: 'Main', url: 'https://example.com/' }]) {
  return { version: 2, tabs, steps };
}

test('workflow data references may use declared inputs and earlier step outputs', () => {
  const definition = workflow([
    { id: 'readName', title: 'Read name', op: 'read', tab: 'main', target },
    {
      id: 'fillName',
      title: 'Fill name',
      op: 'fill',
      tab: 'main',
      target: { role: 'textbox', name: 'Name' },
      value: { prefix: { $ref: 'input.prefix' }, name: { $ref: 'steps.readName.value' } },
      check: { type: 'value', equals: { $ref: 'steps.readName.value' } },
    },
  ]);

  assert.deepEqual(validateWorkflow(definition, {
    parameters: { properties: { prefix: { type: 'string' } } },
  }), definition);
  assert.deepEqual(resolveData(
    { values: [{ $ref: 'input.prefix' }, { $ref: 'steps.readName.value' }] },
    { prefix: 'Dr. ' },
    { readName: { value: 'Kitten' } },
  ), { values: ['Dr. ', 'Kitten'] });
});

test('workflow rejects forward, missing-input, and malformed references', () => {
  const make = value => workflow([
    { id: 'first', title: 'First', op: 'manual', value },
    { id: 'later', title: 'Later', op: 'manual' },
  ]);

  assert.throws(() => validateWorkflow(make({ $ref: 'steps.later.value' })), { code: 'WORKFLOW_INVALID' });
  assert.throws(() => validateWorkflow(make({ $ref: 'input.undeclared' })), { code: 'WORKFLOW_INVALID' });
  assert.throws(() => validateWorkflow(make({ $ref: 'steps.first.value.extra!' })), { code: 'WORKFLOW_INVALID' });
  assert.throws(() => resolveData({ $ref: 'steps.missing.value' }, {}, {}), { code: 'WORKFLOW_INPUT' });
});

test('workflow rejects duplicate ids and transient browser fields', () => {
  assert.throws(() => validateWorkflow(workflow([], [
    { id: 'main', title: 'One' },
    { id: 'main', title: 'Two' },
  ]), { partial: true }), { code: 'WORKFLOW_INVALID' });

  assert.throws(() => validateWorkflow(workflow([
    { id: 'same', title: 'One', op: 'manual' },
    { id: 'same', title: 'Two', op: 'manual' },
  ])), { code: 'WORKFLOW_INVALID' });

  assert.throws(() => validateWorkflow({
    version: 2,
    tabs: [{ id: 'main', title: 'Main', tabId: 42 }],
    steps: [],
  }, { partial: true }), /Unknown fields: tabId/);

  assert.throws(() => validateWorkflow(workflow([
    { id: 'click', title: 'Click', op: 'click', tab: 'main', target: { ...target, ref: 'r17' } },
  ]), { partial: true }), /Unknown fields: ref/);
});

test('resolveTarget requires exactly one available control matching every constraint', () => {
  const snapshot = {
    controls: [
      { ref: 'a', role: 'button', name: 'Save', region: 'dialog', visible: true },
      { ref: 'b', role: 'button', name: 'Save', region: 'toolbar', visible: true },
      { ref: 'c', role: 'button', name: 'Delete', region: 'dialog', disabled: true },
    ],
  };

  assert.equal(resolveTarget(snapshot, { role: 'button', name: 'Save', region: 'dialog' }).ref, 'a');
  assert.throws(() => resolveTarget(snapshot, { role: 'button', name: 'Save' }), { code: 'WORKFLOW_AMBIGUOUS' });
  assert.throws(() => resolveTarget(snapshot, { role: 'button', name: 'Missing' }), { code: 'WORKFLOW_TARGET_MISSING' });
  assert.throws(() => resolveTarget(snapshot, { role: 'button', name: 'Delete' }), { code: 'WORKFLOW_TARGET_MISSING' });
});

test('draft workflows permit unresolved edits, while publishing requires targets and checks', () => {
  const draft = workflow([
    { id: 'clickSave', title: 'Click save', op: 'click', tab: 'main', unresolved: true },
  ]);

  assert.deepEqual(validateWorkflow(draft, { partial: true }), draft);
  assert.throws(() => validateWorkflow(draft), { code: 'WORKFLOW_INVALID' });

  const resolvedWithoutCheck = workflow([
    { id: 'clickSave', title: 'Click save', op: 'click', tab: 'main', target },
  ]);
  assert.throws(() => validateWorkflow(resolvedWithoutCheck), /success check/);
});

test('tool steps require a complete pinned executable definition when published', () => {
  const pinnedTool = {
    entryId: 'library-tool',
    revision: 3,
    kind: 'tool',
    name: 'Lookup',
    description: 'Look up a record',
    code: 'export default async function main() { return true; }',
    parameters: { type: 'object' },
    runtimeVersion: 'browserbot-library-v1',
    scope: 'workspace',
    allowedHosts: ['example.com'],
  };
  const definition = workflow([
    {
      id: 'lookup',
      title: 'Look up record',
      op: 'tool',
      tool: pinnedTool,
      check: { type: 'result', equals: true },
    },
  ]);

  assert.deepEqual(validateWorkflow(definition), definition);
  assert.throws(() => validateWorkflow(workflow([
    { ...definition.steps[0], tool: { ...pinnedTool, revision: 0 } },
  ])), /full pinned definition and revision/);
  assert.throws(() => validateWorkflow(workflow([
    { ...definition.steps[0], tool: { ...pinnedTool, runtimeVersion: 'latest' } },
  ])), /full pinned definition and revision/);
  assert.throws(() => validateWorkflow(workflow([
    { ...definition.steps[0], tool: { ...pinnedTool, transientHandle: 'live-1' } },
  ])), /Unsupported tool snapshot fields/);
});

test('sanitizeRecordedUrl strips credentials and sensitive query or fragment data', () => {
  assert.equal(
    sanitizeRecordedUrl('https://user:pass@example.com/path?view=all&token=abc&API_KEY=def#session=ghi'),
    'https://example.com/path?view=all',
  );
  assert.equal(
    sanitizeRecordedUrl('https://example.com/path?postcode=123&theme=dark#section-2'),
    'https://example.com/path?postcode=123&theme=dark#section-2',
  );
  assert.equal(sanitizeRecordedUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeRecordedUrl('not a url'), '');
});
