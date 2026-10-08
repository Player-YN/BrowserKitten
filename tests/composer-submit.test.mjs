import test from 'node:test';
import assert from 'node:assert/strict';
import { composerEnterAction, promoteQueueItem, removeQueueItem } from '../src/sidepanel/composerSubmit.js';

test('Enter breaks the line; modified Enter sends or interrupts', () => {
  assert.equal(composerEnterAction({ key: 'Enter' }), 'newline');
  assert.equal(composerEnterAction({ key: 'Enter', shiftKey: true }), 'newline');
  assert.equal(composerEnterAction({ key: 'Enter', metaKey: true }), 'send');
  assert.equal(composerEnterAction({ key: 'Enter', ctrlKey: true }), 'send');
  assert.equal(composerEnterAction({ key: 'Enter', metaKey: true, shiftKey: true }), 'send-now');
  assert.equal(composerEnterAction({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'send-now');
  assert.equal(composerEnterAction({ key: 'Enter', isComposing: true, metaKey: true }), 'ignore');
  assert.equal(composerEnterAction({ key: 'Enter', keyCode: 229 }), 'ignore');
  assert.equal(composerEnterAction({ key: 'a' }), 'ignore');
});

test('queue promote and remove keep the other waiting prompts', () => {
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(promoteQueueItem(queue, 'c').map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(promoteQueueItem(queue, 'missing').map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(removeQueueItem(queue, 'b').map((item) => item.id), ['a', 'c']);
  assert.deepEqual(queue.map((item) => item.id), ['a', 'b', 'c']);
});
