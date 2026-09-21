import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSession } from '../src/agent/vnext/sessionWorkspace/sessionApi.js';
import { beginExecution, settleExecution } from '../src/agent/vnext/sessionWorkspace/execution.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createArtifact } from '../src/agent/vnext/sessionWorkspace/artifacts.js';
import { classifyCanvasKind } from '../src/agent/vnext/sessionWorkspace/canvasInventory.js';
import { serializeDocHtml, emptyDocSnapshot, applyDocCommands } from '../src/agent/vnext/sessionWorkspace/docsApply.js';
import { htmlWritePolicy } from '../src/agent/vnext/sessionWorkspace/htmlWritePolicy.js';
import { buildArtifactPathTree, setArtifactFolder } from '../src/agent/vnext/sessionWorkspace/artifactShelf.js';
import {
  SESSION_AGENTS_PATH,
  SESSION_MEMORY_PATH,
  SESSION_STATUS_PATH,
  readSessionAgentsMd,
  replaceAgentsMdPointers
} from '../src/agent/vnext/sessionWorkspace/sessionAgentsMd.js';
import { moveArtifactToTrash } from '../src/agent/vnext/sessionWorkspace/workspaceTrash.js';

test('createSession scaffolds AGENTS, Memory, and STATUS', () => {
  const store = new SessionWorkspaceStore();
  const session = createSession(store, { title: 'Notes' });
  const fs = createSessionGuestFs(store, { sessionId: session.sessionId });
  assert.equal(fs.exists(SESSION_AGENTS_PATH), true);
  assert.equal(fs.exists(SESSION_MEMORY_PATH), true);
  assert.equal(fs.exists(SESSION_STATUS_PATH), true);
  assert.match(readSessionAgentsMd(store, session.sessionId), /## Red lines/);
});

test('settle rewrites Pointers, keeps Red lines, and empties trash', () => {
  const store = new SessionWorkspaceStore();
  const session = createSession(store, { title: 'Notes' });
  const fs = createSessionGuestFs(store, { sessionId: session.sessionId });
  const edited = readSessionAgentsMd(store, session.sessionId).replace(
    'Payment / receipt / publish confirmation: wait for the user.',
    'Custom red line stays.'
  );
  fs.writeFile(SESSION_AGENTS_PATH, edited, { mimeType: 'text/markdown' });
  const junk = createArtifact(store, fs, {
    sessionId: session.sessionId,
    name: 'scratch-note.txt',
    content: 'tmp',
    mimeType: 'text/plain'
  });
  const moved = moveArtifactToTrash(store, fs, session.sessionId, junk.artifactId);
  assert.equal(moved.ok, true);
  assert.match(moved.artifact.primaryPath, /\/artifacts\/\.trash\//);
  const blocked = setArtifactFolder(store, session.sessionId, store.keys('artifacts').find((id) => {
    const rec = store.get('artifacts', id);
    return rec.primaryPath === SESSION_AGENTS_PATH;
  }), 'trash');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'WORKSPACE_FILE');
  const ctx = beginExecution(store, session.sessionId);
  settleExecution(store, ctx, 'settled');
  const after = readSessionAgentsMd(store, session.sessionId);
  assert.match(after, /Custom red line stays/);
  assert.match(after, /## Pointers/);
  assert.equal(store.get('artifacts', junk.artifactId) || null, null);
});

test('pointer rewrite does not drop a custom red line', () => {
  const next = replaceAgentsMdPointers('# AGENTS.md\n\n## Red lines\n- keep me\n\n## Pointers\n- old\n', [
    '/artifacts/notes/a.md'
  ]);
  assert.match(next, /keep me/);
  assert.match(next, /\/artifacts\/notes\/a\.md/);
  assert.doesNotMatch(next, /- old/);
});

test('doc registration html is a doc canvas; bare html is not a tldraw error', () => {
  const applied = applyDocCommands(emptyDocSnapshot('Hi'), [
    { op: 'createDocument', title: 'Hi', text: 'Hello' }
  ]);
  assert.match(applied.html, /data-browserbot-kind="document"/);
  assert.equal(classifyCanvasKind({ name: 'document.html', mimeType: 'text/html' }, applied.html), 'doc');
  const denied = htmlWritePolicy('<html><body>hi</body></html>', 'note.html');
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 'NEED_HTML_KIND');
  assert.doesNotMatch(denied.error, /tldraw/i);
  assert.doesNotMatch(denied.error, /Design\/Slides/);
});

test('path tree nests folders and keeps trash at the root', () => {
  const tree = buildArtifactPathTree([
    { artifactId: 'a', name: 'a.md', primaryPath: '/artifacts/notes/a.md' },
    { artifactId: 'b', name: 'b.txt', primaryPath: '/artifacts/.trash/b/b.txt', folder: 'trash' }
  ]);
  const notes = tree.find((n) => n.label === 'notes');
  assert.ok(notes);
  assert.equal(notes.items[0].artifactId, 'a');
  const trash = tree.find((n) => n.id === 'trash');
  assert.ok(trash);
  assert.equal(trash.children[0].items[0].artifactId, 'b');
});
