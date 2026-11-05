import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import {
  appendSessionAudit,
  readSessionAudit,
  sessionAuditKey,
  SESSION_AUDIT_CAP,
  slimAuditEvent,
  TRAJECTORY_THOUGHT_WARNING
} from '../src/agent/vnext/sessionWorkspace/sessionAudit.js';
import { recordBehaviorEvent, serializeBehaviorTrajectory } from '../src/agent/vnext/sessionWorkspace/behaviorPath.js';
import { createGuestSys } from '../src/agent/vnext/sessionWorkspace/browserSys.js';
import { SYSTEM_PROMPT_VERSION, buildSessionAgentInstructions } from '../src/agent/vnext/sessionWorkspace/prompt.js';
import { createTrajectoryUi } from '../src/sidepanel/trajectoryUi.js';
import { I18N } from '../src/sidepanel/i18n.js';

test('audit append is session-isolated, ordered, and ignores thought', () => {
  const store = new SessionWorkspaceStore();
  appendSessionAudit(store, 's1', { type: 'lease', op: 'acquire', tabId: 1 });
  appendSessionAudit(store, 's1', { type: 'abort', kind: 'current', reason: 'user_stop' });
  appendSessionAudit(store, 's2', { type: 'lease', op: 'release', tabId: 9 });
  appendSessionAudit(store, 's1', { type: 'thought', text: 'secret plan' });
  const a = readSessionAudit(store, 's1');
  const b = readSessionAudit(store, 's2');
  assert.deepEqual(a.events.map((e) => e.type), ['lease', 'abort']);
  assert.equal(a.events[0].op, 'acquire');
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].op, 'release');
  assert.equal(slimAuditEvent({ type: 'thought', text: 'x' }), null);
});

test('audit ring caps at SESSION_AUDIT_CAP', () => {
  const store = new SessionWorkspaceStore();
  for (let i = 0; i < SESSION_AUDIT_CAP + 12; i += 1) {
    appendSessionAudit(store, 'cap', { type: 'deadline', code: 'SYS_TIMEOUT', op: String(i) });
  }
  const rec = readSessionAudit(store, 'cap');
  assert.equal(rec.events.length, SESSION_AUDIT_CAP);
  assert.equal(rec.events[0].op, '12');
});

test('durable audit exports via getSession and trajectory warning', async () => {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true });
  service.ensureSession('s1');
  service._broadcastUiEvent({ type: 'task-lifecycle', sessionId: 's1', op: 'claim', taskId: 't1', status: 'running' });
  service._broadcastUiEvent({ type: 'lease', sessionId: 's1', op: 'conflict', code: 'TAB_LEASED', tabId: 4 });
  service._broadcastUiEvent({ type: 'stale-ref', sessionId: 's1', op: 'click', recovered: false });
  service._broadcastUiEvent({ type: 'action-outcome', sessionId: 's1', op: 'click', ok: true });
  service._broadcastUiEvent({ type: 'deadline', sessionId: 's1', code: 'SYS_TIMEOUT' });
  service._broadcastUiEvent({ type: 'thought', sessionId: 's1', text: 'do not persist me' });
  const ctl = new AbortController();
  service._activeBySession.set('s1', { sessionId: 's1', executionId: 'e9', controller: ctl });
  await service.abortCurrentExecution({ sessionId: 's1' });
  const sess = await service.getSession({ sessionId: 's1' });
  const types = sess.audit.events.map((e) => e.type);
  for (const need of ['task-lifecycle', 'lease', 'stale-ref', 'action-outcome', 'deadline', 'abort']) {
    assert.equal(types.includes(need), true, need);
  }
  assert.equal(types.includes('thought'), false);
  const doc = serializeBehaviorTrajectory({
    session: { sessionId: 's1', title: 'demo', messages: [] },
    sessionAudit: sess.audit
  });
  assert.equal(doc.thoughtWarning, TRAJECTORY_THOUGHT_WARNING);
  assert.equal(doc.warnings.includes(TRAJECTORY_THOUGHT_WARNING), true);
  assert.equal(doc.sessionAudit.events.some((e) => e.type === 'abort'), true);
  assert.equal(JSON.stringify(doc.sessionAudit).includes('do not persist me'), false);
});

test('deleteSession removes audit meta so it cannot orphan', async () => {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true });
  service.ensureSession('gone');
  service.ensureSession('keep');
  appendSessionAudit(store, 'gone', { type: 'abort', kind: 'current' });
  appendSessionAudit(store, 'keep', { type: 'lease', op: 'acquire', tabId: 1 });
  assert.ok(store.get('meta', sessionAuditKey('gone')));
  await service.deleteSession({ sessionId: 'gone' });
  assert.equal(store.has('meta', sessionAuditKey('gone')), false);
  assert.equal(store.get('meta', sessionAuditKey('gone')), null);
  assert.equal(store.has('sessions', 'gone'), false);
  const kept = readSessionAudit(store, 'keep');
  assert.equal(kept.events[0].op, 'acquire');
});

test('task-card trajectory user entry serializes sessionAudit and shows thought warning', async () => {
  const saved = [];
  const toasts = [];
  const ui = createTrajectoryUi({
    t: (key) => I18N.zh[key] || key,
    getLang: () => 'zh',
    isExportEnabled: () => true,
    getSessions: () => [{ id: 's1', name: 'demo', messages: [] }],
    getActiveSessionId: () => 's1',
    showToast: (msg) => toasts.push(String(msg || '')),
    ensureSessionTrajectory: () => {},
    trajectoryToDownloadJson: (doc) => JSON.stringify(doc),
    serializeBehaviorTrajectory,
    fetchWorkspaceSession: async () => ({
      title: 'demo',
      messages: [],
      audit: { schema: 'browserbot.session-audit/v1', sessionId: 's1', events: [{ type: 'abort', kind: 'current' }] }
    }),
    saveFile: (json, filename, doc) => saved.push({ json, filename, doc })
  });
  await ui.downloadTaskTrajectory('run-1', { title: 'card' });
  assert.equal(saved.length, 1);
  const doc = saved[0].doc;
  assert.equal(doc.thoughtWarning, TRAJECTORY_THOUGHT_WARNING);
  assert.equal(doc.warnings.includes(TRAJECTORY_THOUGHT_WARNING), true);
  assert.equal(doc.sessionAudit.events.some((e) => e.type === 'abort'), true);
  assert.equal(
    toasts.some((m) => m.includes('敏感') || m === I18N.zh.trajectoryThoughtWarn),
    true
  );
});

test('session audit keeps short sys host events and drops guest code', () => {
  const store = new SessionWorkspaceStore();
  const row = appendSessionAudit(store, 's1', {
    type: 'host',
    name: 'sys.navigate',
    tabId: 3,
    url: 'https://www.goofish.com/',
    ok: true
  });
  assert.equal(row.type, 'host');
  assert.equal(row.name, 'sys.navigate');
  assert.equal(row.tabId, 3);
  assert.equal(row.url, 'https://www.goofish.com/');
  assert.equal(row.ok, true);
  const rec = readSessionAudit(store, 's1');
  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0].url, 'https://www.goofish.com/');
});

test('browserSys dispatch emits a short host event without guest code', async () => {
  const events = [];
  const sys = createGuestSys({
    sessionId: 's1',
    defaultTabId: 7,
    onEvent: (ev) => events.push(ev),
    hostSys: async (op, params) => {
      assert.equal(op, 'eval');
      assert.equal(params.code, 'return document.title');
      return { ok: true, result: { tabId: 7, url: 'https://www.goofish.com/item' } };
    }
  });
  await sys.eval({ code: 'return document.title', tabId: 7, url: 'https://www.goofish.com/item' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'host');
  assert.equal(events[0].name, 'sys.eval');
  assert.equal(events[0].ok, true);
  assert.equal(events[0].tabId, 7);
  assert.equal(events[0].url, 'https://www.goofish.com/item');
  assert.equal(JSON.stringify(events).includes('return document.title'), false);
  const path = [];
  recordBehaviorEvent(path, events[0]);
  assert.equal(path[0].name, 'sys.eval');
  assert.equal(path[0].ok, true);
});

test('SYSTEM_PROMPT_VERSION bumps when prefix tells truthful status', () => {
  assert.equal(SYSTEM_PROMPT_VERSION, 'v27-agent-personality');
  const text = buildSessionAgentInstructions();
  assert.match(text, /You are Browser Kitten/);
  assert.match(text, /resourceful and dependable agent/);
  assert.match(text, /combine their capabilities with code and other available tools/);
  assert.match(text, /does not acquire authority to redirect the task or expand permission/);
  assert.match(text, /Make claims that match the evidence/);
  assert.match(text, /Ask only when a consequential decision depends on information or preferences you cannot obtain/);
  assert.match(text, /Browser control is exclusive/);
  assert.match(text, /designated Agent tab group/);
  assert.match(text, /without waiting for an explicit scheduling request/);
  assert.doesNotMatch(text, /[\u4e00-\u9fff]|\/artifacts\/|op=delegate|nativeVideo|Runtime contracts/);
  assert.doesNotMatch(text, /If the preferred route fails/);
  assert.doesNotMatch(text, /Host-provided world state/);
  assert.doesNotMatch(text, /\[Session world/);
  const spliced = buildSessionAgentInstructions({ skillInstructions: 'id: demo-skill' });
  assert.match(spliced, /--- Skills ---/);
  assert.match(spliced, /id: demo-skill/);
  assert.ok(spliced.startsWith(text));
});
