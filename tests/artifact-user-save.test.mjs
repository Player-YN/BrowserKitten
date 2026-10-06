import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { createCallJournal, createMemoryCallJournal } from '../src/agent/vnext/host/callJournal.js';
import { gatedDispatch } from '../src/agent/vnext/host/operationGate.js';

async function serviceWithDoc() {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true });
  service.ensureSession('s');
  const created = await service.createArtifact({ sessionId: 's', name: 'doc.html', mimeType: 'text/html', content: '<p>v0</p>' });
  return { store, service, artifact: created.artifact };
}

test('preview save with no active execution writes and advances the revision (no ticket needed)', async () => {
  const { service, artifact } = await serviceWithDoc();
  assert.equal(service._activeBySession.get('s'), undefined);
  service._putTicket = async () => { throw Object.assign(new Error('ticket'), { code: 'TICKET_REQUIRED' }); };
  const saved = await service.updateArtifact({ sessionId: 's', artifactId: artifact.artifactId, content: '<p>v1</p>', expectedRevision: artifact.revision });
  assert.equal(saved.ok, true);
  assert.ok(saved.artifact.revision > artifact.revision);
  const read = await service.readArtifact({ sessionId: 's', artifactId: artifact.artifactId });
  assert.equal(read.content, '<p>v1</p>');
});

test('stale preview save rejects with ARTIFACT_CONFLICT and the actual revision', async () => {
  const { service, artifact } = await serviceWithDoc();
  const first = await service.updateArtifact({ sessionId: 's', artifactId: artifact.artifactId, content: '<p>v1</p>', expectedRevision: artifact.revision });
  await assert.rejects(
    service.updateArtifact({ sessionId: 's', artifactId: artifact.artifactId, content: '<p>stale</p>', expectedRevision: artifact.revision }),
    (err) => err.code === 'ARTIFACT_CONFLICT' && err.actualRevision === first.artifact.revision
  );
  // Also rejects while an agent execution is live: conflict is never swallowed as a resolved result.
  service._activeBySession.set('s', { sessionId: 's', executionId: 'e', controller: new AbortController() });
  await assert.rejects(
    service.updateArtifact({ sessionId: 's', artifactId: artifact.artifactId, content: '<p>stale</p>', expectedRevision: artifact.revision }),
    { code: 'ARTIFACT_CONFLICT' }
  );
});

test('gate journals a thrown ARTIFACT_CONFLICT as failed, not unknown', async () => {
  const journal = createCallJournal(createMemoryCallJournal());
  const out = await gatedDispatch(
    { channel: 'artifact', op: 'updateArtifact', sessionId: 's', executionId: 'e', artifactId: 'a', expectedRevision: 1 },
    {
      journal,
      readPolicy: async () => ({ mode: 'full' }),
      putTicket: async () => {},
      send: async () => { throw Object.assign(new Error('ARTIFACT_CONFLICT'), { code: 'ARTIFACT_CONFLICT', actualRevision: 3 }); }
    }
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ARTIFACT_CONFLICT');
  assert.equal(out.outcome, 'failed');
  assert.equal(out.actualRevision, 3);
  const row = await journal.get(out.operationId);
  assert.equal(row.state, 'failed');
  assert.equal(row.outcome, 'failed');
});
