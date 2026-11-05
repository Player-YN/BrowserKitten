import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { buildSessionAgentInstructions, buildWorldStateBlock } from '../src/agent/vnext/sessionWorkspace/prompt.js';
import { buildSessionRuntimeInstructions } from '../src/agent/vnext/sessionWorkspace/runtimeInstructions.js';
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
  assert.doesNotMatch(md, /闲鱼调研/);
  assert.doesNotMatch(md, /先验证需求再上架/);
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
  assert.match(readSessionAgentsMd(store, 's1'), /## How to work/);
  assert.doesNotMatch(readSessionAgentsMd(store, 's1'), /Long work/);
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
  const body = clipped.slice(clipped.lastIndexOf('\n'));
  assert.ok((body.match(/x/g) || []).length <= AGENTS_MD_INJECT_CAP);
});

test('world block reports AGENTS.md presence without dumping the body', () => {
  const absent = buildWorldStateBlock({ agentsMd: { present: false } });
  assert.match(absent, /agentsMd=\{"present":false/);
  assert.match(absent, /Workspace files are missing/);
  assert.match(absent, /statusMd=\/artifacts\/STATUS\.md/);
  const present = buildWorldStateBlock({ agentsMd: { present: true } });
  assert.match(present, /agentsMd=\{"present":true/);
  assert.match(present, /stable system prefix/);
  assert.doesNotMatch(present, /## Red lines/);
});

test('prepareStep leaves the system prefix untouched so AGENTS.md cannot bust it', async () => {
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
  assert.equal(out.instructions, undefined);
  const body = readSessionAgentsMd(store, 's1');
  const tail = formatAgentsMdInstructions(body);
  assert.match(tail, /Workspace AGENTS\.md/);
  assert.doesNotMatch('base host prefix', /Workspace AGENTS\.md/);
});

test('runtime instructions preserve the AGENTS.md contract outside the personality', () => {
  assert.doesNotMatch(buildSessionAgentInstructions(), /\/artifacts\/AGENTS\.md/);
  const text = buildSessionRuntimeInstructions();
  assert.match(text, /\/artifacts\/AGENTS\.md/);
  assert.match(text, /Memory\.md/);
  assert.match(text, /STATUS\.md/);
  assert.match(text, /do not grant user authorization/);
  assert.match(text, /ordinary send does not create a Durable Task/);
});
