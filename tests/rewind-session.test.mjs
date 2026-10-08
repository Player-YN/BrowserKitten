import test from 'node:test';
import assert from 'node:assert/strict';
import { rewindSessionRecord } from '../src/agent/vnext/sessionWorkspace/rewindSession.js';

const user = (messageId, content) => ({ messageId, role: 'user', content });
const assistant = (messageId, content) => ({ messageId, role: 'assistant', content });

test('rewind drops the chosen user turn and everything after it', () => {
  const session = {
    sessionId: 's',
    messages: [user('u1', 'first'), assistant('a1', 'ok'), user('u2', 'second'), assistant('a2', 'done')],
    compact: { throughMessageId: 'a1', text: 'summary' },
    turnProgress: { notes: ['x'] }
  };
  const { session: next, restored } = rewindSessionRecord(session, { messageId: 'u2' });
  assert.equal(restored.content, 'second');
  assert.deepEqual(next.messages.map((m) => m.messageId), ['u1', 'a1']);
  assert.equal(next.compact.throughMessageId, 'a1');
  assert.equal(next.turnProgress, undefined);
  assert.equal(session.messages.length, 4);
});

test('rewind by user index and drops a compact that covered the removed tail', () => {
  const session = {
    messages: [user('u1', 'first'), assistant('a1', 'ok'), user('u2', [{ type: 'text', text: 'edit me' }])],
    compact: { throughMessageId: 'a1', text: 'summary' }
  };
  const { session: next, restored } = rewindSessionRecord(session, { userIndex: 0 });
  assert.equal(restored.content, 'first');
  assert.deepEqual(next.messages, []);
  assert.equal(next.compact, undefined);
});

test('unknown message is not a silent no-op', () => {
  assert.throws(
    () => rewindSessionRecord({ messages: [user('u1', 'hi')] }, { messageId: 'missing' }),
    (err) => err.code === 'REWIND_NOT_FOUND'
  );
});
