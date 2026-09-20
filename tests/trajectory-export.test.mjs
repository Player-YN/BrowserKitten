import test from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets, trajectoryToDownloadJson } from '../src/agent/trajectory.js';
import { serializeBehaviorTrajectory } from '../src/agent/vnext/sessionWorkspace/behaviorPath.js';
import {
  projectJsonForWire,
  projectWireForDownload,
  WIRE_MAX_ARRAY
} from '../src/agent/vnext/sessionWorkspace/wireTranscript.js';

test('redactSecrets keeps events/wire/audit and marks other array cuts', () => {
  const events = Array.from({ length: 113 }, (_, i) => ({ type: 'tool-call', i }));
  const wire = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', i }));
  const audit = Array.from({ length: 180 }, (_, i) => ({ type: 'journal', i }));
  const cleaned = redactSecrets({
    turns: [{ events, wire }],
    sessionAudit: { events: audit },
    extra: Array.from({ length: 105 }, (_, i) => i)
  });
  assert.equal(cleaned.turns[0].events.length, 113);
  assert.equal(cleaned.turns[0].wire.length, 60);
  assert.equal(cleaned.sessionAudit.events.length, 180);
  assert.equal(cleaned.extra.length, 101);
  assert.deepEqual(cleaned.extra[100], { truncated: true, omitted: 5 });
});

test('download wire keeps every hop; persist still caps nested arrays', () => {
  const hops = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? 'tool' : 'assistant',
    i
  }));
  const persist = projectJsonForWire(hops);
  assert.equal(persist.length, WIRE_MAX_ARRAY + 1);
  assert.deepEqual(persist[WIRE_MAX_ARRAY], { truncated: true, omitted: 10 });
  const download = projectWireForDownload(hops);
  assert.equal(download.length, 60);
  assert.equal(download.some((row) => row && row.truncated === true), false);
});

test('trajectory download JSON does not silently drop turn events or wire hops', () => {
  const events = Array.from({ length: 113 }, (_, i) => ({
    type: i % 2 ? 'tool-result' : 'tool-call',
    name: 'run',
    ts: i
  }));
  const wire = Array.from({ length: 72 }, (_, i) => ({
    role: i % 2 ? 'tool' : 'assistant',
    content: i % 2 ? [{ type: 'tool-result', toolCallId: `c${i}` }] : [{ type: 'tool-call', toolCallId: `c${i}` }]
  }));
  const doc = serializeBehaviorTrajectory({
    session: {
      sessionId: 'sess-export',
      title: 'export',
      messages: [
        { role: 'user', content: 'go', messageId: 'u1' },
        { role: 'assistant', content: 'done', messageId: 'a1', path: events, wire }
      ]
    },
    sessionAudit: {
      schema: 'browserbot.session-audit/v1',
      sessionId: 'sess-export',
      events: Array.from({ length: 120 }, (_, i) => ({ type: 'journal', i }))
    }
  });
  assert.ok(doc.turns[0].events.length >= 113);
  assert.equal(doc.turns[0].wire.length, 72);
  assert.equal(doc.sessionAudit.events.length, 120);
  const parsed = JSON.parse(trajectoryToDownloadJson(doc));
  assert.ok(parsed.turns[0].events.length >= 113);
  assert.equal(parsed.turns[0].wire.length, 72);
  assert.equal(parsed.sessionAudit.events.length, 120);
});
