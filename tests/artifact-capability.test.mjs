import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capabilityForItem,
  escapePreviewText,
  inspectorMeta,
  inspectorPrefix,
  INSPECTOR_PREFIX_BYTES,
  persistableCapabilityHint,
  previewTextPayload,
  PRIMARY_FAMILIES
} from '../src/agent/vnext/sessionWorkspace/artifactCapability.js';
import {
  artifactAccessBadgeKeys,
  artifactAccessKind,
  foldLegacyShelfFolders,
  inferArtifactShelfFolder,
  isPrimaryShelfChip,
  PRIMARY_SHELF_CHIPS
} from '../src/agent/vnext/sessionWorkspace/artifactShelf.js';
import { classifyOpenArtifact, previewEntryForItem, previewViewForItem } from '../src/agent/vnext/sessionWorkspace/openClassify.js';

const CASES = [
  { name: 'notes.txt', text: 'hello', family: 'files', view: 'text', editable: false, preview: true },
  { name: 'readme.md', text: '# hi', family: 'files', view: 'text', editable: false, preview: true },
  { name: 'data.json', text: '{"a":1}', family: 'files', view: 'text', editable: false, preview: true },
  { name: 'mark.svg', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', family: 'media', view: 'image', editable: false, preview: true },
  { name: 'clip.mp3', mimeType: 'audio/mpeg', family: 'media', view: 'media', editable: false, preview: true },
  { name: 'reel.mp4', mimeType: 'video/mp4', family: 'media', view: 'media', editable: false, preview: true },
  { name: 'pack.zip', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), family: 'files', view: 'inspector', editable: false, preview: false },
  { name: 'mystery.xyz', bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]), family: 'files', view: 'inspector', editable: false, preview: false }
];

test('five families are the only primary chips; design/slides are not', () => {
  assert.deepEqual(PRIMARY_SHELF_CHIPS, PRIMARY_FAMILIES);
  assert.deepEqual(PRIMARY_FAMILIES, ['docs', 'data', 'web', 'media', 'files']);
  assert.equal(isPrimaryShelfChip('design'), false);
  assert.equal(isPrimaryShelfChip('slides'), false);
  assert.equal(isPrimaryShelfChip('legacy'), false);
  assert.equal(isPrimaryShelfChip('docs'), true);
});

test('txt/md/json/svg/audio/video/zip/unknown are openable with honest badges', () => {
  for (const row of CASES) {
    const item = {
      artifactId: row.name,
      name: row.name,
      mimeType: row.mimeType || '',
      text: row.text || '',
      bytes: row.bytes
    };
    const cap = capabilityForItem(item);
    const view = previewViewForItem(item);
    const entry = previewEntryForItem(item);
    assert.equal(cap.openable, true, row.name);
    assert.equal(!!entry.entry, true, row.name);
    assert.equal(cap.family, row.family, row.name);
    assert.equal(cap.view, row.view, row.name);
    assert.equal(view.view, row.view, row.name);
    assert.equal(cap.badges.editable, row.editable, row.name);
    assert.equal(cap.canSave, row.editable, row.name);
    assert.equal(cap.badges.previewable, row.preview, row.name);
    assert.equal(cap.executable, false, row.name);
    assert.equal(artifactIsClickable(item), true, row.name);
  }
});

function artifactIsClickable(item) {
  const cap = capabilityForItem(item);
  return cap.openable === true && !!cap.entry && cap.entry !== 'about:blank';
}

test('unknown HTML is escaped text and not executable', () => {
  const html = '<script>window.__pwned=1</script><img src=x onerror="alert(1)">';
  const item = { name: 'evil.html', text: html };
  const cap = capabilityForItem(item);
  assert.equal(classifyOpenArtifact(item).kind, 'html');
  assert.equal(cap.view, 'text');
  assert.equal(cap.escape, true);
  assert.equal(cap.executable, false);
  assert.equal(cap.canSave, false);
  assert.equal(cap.badges.editable, false);
  assert.equal(previewViewForItem(item).view, 'text');
  const payload = previewTextPayload(html);
  assert.match(payload.escaped, /&lt;script/);
  assert.equal(payload.escaped.includes('<script'), false);
  assert.equal(escapePreviewText('<b>'), '&lt;b&gt;');
});

test('Univer surfaces stay editable; zip stays download-only', () => {
  const sheet = capabilityForItem({
    name: 'book.csv',
    text: 'a,b\n1,2'
  });
  assert.equal(sheet.family, 'data');
  assert.equal(sheet.entry, 'sheet.html');
  assert.equal(sheet.badges.editable, true);
  assert.equal(sheet.badges.previewable, true);
  assert.deepEqual(artifactAccessBadgeKeys({ name: 'book.csv', text: 'a,b\n1,2' }), [
    'artifactAccessEdit',
    'artifactAccessPreview'
  ]);

  const zipItem = {
    name: 'pack.zip',
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  };
  const zip = capabilityForItem(zipItem);
  assert.equal(artifactAccessKind(zipItem), 'download');
  assert.equal(zip.view, 'inspector');
  const meta = inspectorMeta({ name: 'pack.zip' }, zip.kind ? new Uint8Array([0x50, 0x4b, 0x03, 0x04]) : new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(meta.openable, true);
  assert.equal(meta.executable, false);
  assert.equal(meta.magic.startsWith('504b0304'), true);
});

test('legacy design/slides fold into files and stay openable', () => {
  const folded = foldLegacyShelfFolders([
    { id: 'design', items: [{ artifactId: 'old', name: 'poster.json', folder: 'design' }] },
    { id: 'docs', items: [{ artifactId: 'doc1', name: 'note.docx' }] }
  ]);
  assert.equal(folded.some((f) => f.id === 'design' || f.id === 'slides'), false);
  const files = folded.find((f) => f.id === 'files');
  assert.ok(files);
  assert.equal(files.items[0].legacyCanvas, true);
  const cap = capabilityForItem({ ...files.items[0], text: '{"pawCanvas":1,"tldraw":{}}' });
  assert.equal(cap.family, 'legacy');
  assert.equal(cap.openable, true);
  assert.equal(cap.view, 'inspector');
  assert.equal(inferArtifactShelfFolder({ name: 'notes.json', text: '{"hello":true}' }), 'files');
});

test('insufficient metadata stays a neutral badge', () => {
  const item = { artifactId: 'bare' };
  const cap = capabilityForItem(item);
  assert.equal(cap.uncertain, true);
  assert.equal(cap.badges.editable, false);
  assert.equal(cap.badges.previewable, false);
  assert.equal(cap.badges.downloadOnly, false);
  assert.deepEqual(artifactAccessBadgeKeys(item), ['artifactAccessUnknown']);
  assert.equal(artifactAccessKind(item), 'unknown');
});

test('name-only html stays neutral until first open persists a hint', async () => {
  const { SessionWorkspaceService } = await import('../src/agent/vnext/service/sessionWorkspaceService.js');
  const { SessionWorkspaceStore } = await import('../src/agent/vnext/sessionWorkspace/store.js');
  const named = { artifactId: 'old', name: 'legacy.html' };
  const cap = capabilityForItem(named);
  assert.equal(cap.uncertain, true);
  assert.equal(cap.proven, false);
  assert.deepEqual(artifactAccessBadgeKeys(named), ['artifactAccessUnknown']);
  const hint = persistableCapabilityHint(named);
  assert.equal(hint.proven, false);

  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true });
  service.ensureSession('s');
  const created = await service.createArtifact({
    sessionId: 's',
    name: 'legacy.html',
    mimeType: 'text/html',
    content: '<html data-browserbot-kind="site"><body>hi</body></html>'
  });
  const id = created.artifact.artifactId;
  const rec = store.get('artifacts', id);
  store.put('artifacts', id, { ...rec, contentKind: undefined, capability: undefined });
  assert.equal(capabilityForItem({ name: rec.name }).uncertain, true);
  await service.readArtifactPreview({ sessionId: 's', artifactId: id });
  const after = store.get('artifacts', id);
  assert.equal(after.capability?.proven, true);
  assert.equal(after.contentKind, 'html-site');
});

test('create/list persist a proveable capability hint', () => {
  const hint = persistableCapabilityHint({
    name: 'book.csv',
    mimeType: 'text/csv',
    text: 'a,b\n1,2'
  });
  assert.equal(hint.proven, true);
  assert.equal(hint.contentKind, 'csv');
  const listed = capabilityForItem({
    name: 'book.csv',
    contentKind: hint.contentKind,
    capability: hint
  });
  assert.equal(listed.badges.editable, true);
  assert.equal(listed.uncertain, false);
});

test('unknown binary inspector is bounded', () => {
  const huge = new Uint8Array(INSPECTOR_PREFIX_BYTES + 4096);
  huge[0] = 0x00;
  const prefix = inspectorPrefix(huge);
  assert.equal(prefix.byteLength, INSPECTOR_PREFIX_BYTES);
  const meta = inspectorMeta({ name: 'blob.bin', byteLength: huge.byteLength }, huge);
  assert.equal(meta.truncated, true);
  assert.equal(meta.prefixBytes, INSPECTOR_PREFIX_BYTES);
  assert.ok(String(meta.magic).length <= 16);
});

test('shelf and openClassify share the capability mapping', () => {
  const item = { name: 'site.html', text: '<html data-browserbot-kind="site"></html>' };
  assert.equal(inferArtifactShelfFolder(item), 'web');
  assert.equal(previewEntryForItem(item).entry, 'site.html');
  assert.equal(capabilityForItem(item).family, 'web');
});
