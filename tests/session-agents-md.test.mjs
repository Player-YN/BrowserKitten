import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { buildSessionAgentInstructions, buildWorldStateBlock } from '../src/agent/vnext/sessionWorkspace/prompt.js';
import { makeOfficePrepareStep } from '../src/agent/vnext/sessionWorkspace/toolSchedule.js';
import {
  AGENTS_MD_INJECT_CAP,
  SESSION_AGENTS_PATH,
  SESSION_STATUS_PATH,
  ensureSessionAgentsMd,
  formatAgentsMdInstructions,
  readSessionAgentsMd,
  sessionAgentsPresent,
  stubAgentsMd
} from '../src/agent/vnext/sessionWorkspace/sessionAgentsMd.js';

test('AGENTS.md stub is a short contract, not a progress diary', () => {
  const md = stubAgentsMd({ title: '闲鱼调研', summary: '先验证需求再上架' });
  assert.match(md, /# AGENTS\.md/);
  assert.match(md, /## Red lines/);
  assert.match(md, /## Pointers/);
  assert.match(md, /not user authorization/i);
  assert.match(md, /\/artifacts\/STATUS\.md/);
  assert.doesNotMatch(md, /## 进度/);
  assert.doesNotMatch(md, /## Progress/);
});

test('host scaffolds AGENTS.md once; ordinary absence stays empty', () => {
  const store = new SessionWorkspaceStore();
  assert.equal(sessionAgentsPresent(store, 's1'), false);
  assert.equal(readSessionAgentsMd(store, 's1'), '');
  const first = ensureSessionAgentsMd(store, 's1', { title: 'Long work' });
  assert.equal(first.created, true);
  assert.equal(first.path, SESSION_AGENTS_PATH);
  assert.equal(sessionAgentsPresent(store, 's1'), true);
  const again = ensureSessionAgentsMd(store, 's1', { title: 'Other' });
  assert.equal(again.created, false);
  assert.match(readSessionAgentsMd(store, 's1'), /Long work/);
  const fs = createSessionGuestFs(store, { sessionId: 's1' });
  assert.equal(fs.exists(SESSION_AGENTS_PATH), true);
});

test('injected AGENTS.md is fallible and capped; empty text injects nothing', () => {
  assert.equal(formatAgentsMdInstructions(''), '');
  const text = formatAgentsMdInstructions('# AGENTS.md\n\n## Red lines\n- wait for payment');
  assert.match(text, /fallible/);
  assert.match(text, /not user authorization/);
  assert.match(text, /Durable Task contract/);
  assert.ok(text.indexOf('Durable Task') < text.indexOf('## Red lines'));
  const huge = 'x'.repeat(AGENTS_MD_INJECT_CAP + 80);
  const clipped = formatAgentsMdInstructions(huge);
  assert.match(clipped, /truncated/);
  assert.equal(clipped.includes(huge), false);
  assert.ok((clipped.match(/x/g) || []).length <= AGENTS_MD_INJECT_CAP);
});

test('world block reports AGENTS.md presence without dumping the body', () => {
  const absent = buildWorldStateBlock({ agentsMd: { present: false } });
  assert.match(absent, /agentsMd=\{"present":false/);
  assert.match(absent, /No AGENTS\.md yet/);
  const present = buildWorldStateBlock({ agentsMd: { present: true } });
  assert.match(present, /agentsMd=\{"present":true/);
  assert.match(present, /bounded copy/);
  assert.doesNotMatch(present, /## Red lines/);
});

test('prepareStep injects AGENTS.md after the host instruction prefix', async () => {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's1', { sessionId: 's1', messages: [] });
  ensureSessionAgentsMd(store, 's1', { title: 'Contract title' });
  const prepare = makeOfficePrepareStep({
    store,
    sessionId: 's1',
    instructions: 'base host prefix',
    contextWindow: 128000
  });
  const out = await prepare({ messages: [], steps: [] });
  const text = String(out.instructions || '');
  assert.match(text, /base host prefix/);
  assert.match(text, /Workspace AGENTS\.md/);
  assert.match(text, /Contract title/);
  assert.ok(text.indexOf('base host prefix') < text.indexOf('Workspace AGENTS.md'));
});

test('system prefix names the AGENTS.md contract', () => {
  const text = buildSessionAgentInstructions();
  assert.match(text, /\/artifacts\/AGENTS\.md/);
  assert.match(text, /不是用户授权/);
});
