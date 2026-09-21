import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { addWebItem, createGroup, isClipboardGroup } from '../src/agent/vnext/sessionWorkspace/groups.js';
import { captureItemFromPage } from '../src/agent/vnext/sessionWorkspace/itemPixels.js';

function capture(overrides = {}) {
  return {
    selector: '#same', tag: 'div', text: 'visible text', src: '', href: '', kind: 'container',
    scope: 'card',
    facets: {
      text: 'line one\n\nline two',
      media: [{ src: 'https://cdn.example/a.jpg', alt: 'cover', href: 'https://example/a' }],
      links: [{ href: 'https://example/a', text: 'Read' }]
    },
    locatorFingerprint: { tag: 'div', src: '', href: '', text: 'visible text' },
    ...overrides
  };
}

function captureGroup(state) {
  return state.groups.find((group) => !isClipboardGroup(group));
}

test('selection sync retains object facets and isolates reconciliation by frame and document', async () => {
  const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), memoryJournal: true });
  await service.syncTabSelection({
    sessionId: 's', tabId: 7, frameId: 0, documentId: 'doc-main', url: 'https://example.test/a', pageTitle: 'A',
    elements: [capture()]
  });
  let state = await service.syncTabSelection({
    sessionId: 's', tabId: 7, frameId: 2, documentId: 'doc-embed', url: 'https://example.test/embed', pageTitle: 'Embed',
    elements: [capture({ scope: 'button', selector: '#same' })]
  });
  let items = captureGroup(state).items;
  assert.equal(items.length, 2, 'identical CSS in two frames stays distinct');
  const main = items.find((item) => item.frameId === 0);
  assert.equal(main.documentId, 'doc-main');
  assert.equal(main.scope, 'card');
  assert.deepEqual(main.facets.media, capture().facets.media);
  assert.deepEqual(main.locatorFingerprint, capture().locatorFingerprint);
  assert.equal(main.locator.strict, true);

  state = await service.syncTabSelection({
    sessionId: 's', tabId: 7, frameId: 2, documentId: 'doc-embed', url: 'https://example.test/embed',
    elements: [], cleared: true
  });
  items = captureGroup(state).items;
  assert.deepEqual(items.map((item) => item.frameId), [0], 'clearing one iframe cannot delete main-frame captures');

  state = await service.syncTabSelection({
    sessionId: 's', tabId: 7, frameId: 0, documentId: 'doc-main-next', url: 'https://example.test/b',
    elements: [capture({ text: 'new document' })]
  });
  items = captureGroup(state).items;
  assert.deepEqual(new Set(items.map((item) => item.documentId)), new Set(['doc-main', 'doc-main-next']),
    'a document change retains the prior document capture for strict stale handling');
});

test('clipboard keeps authored text and distinguishes explicit capture sources', async () => {
  const service = new SessionWorkspaceService({ store: new SessionWorkspaceStore(), memoryJournal: true });
  const raw = 'first line\n\n  indented second line';
  const common = { text: raw, textRaw: raw, kind: 'text' };
  await service.pinClipboard({ sessionId: 's', items: [
    { ...common, source: { tabId: 4, frameId: 0, documentId: 'a', url: 'https://example.test/a', pageTitle: 'A' } },
    { ...common, source: { tabId: 4, frameId: 1, documentId: 'b', url: 'https://example.test/b', pageTitle: 'B' } },
    common
  ] });
  const state = await service.pinClipboard({ sessionId: 's', items: [common] });
  const clipboard = state.groups.find(isClipboardGroup);
  assert.equal(clipboard.items.length, 3, 'legacy source-free pins still dedupe while distinct sources remain distinct');
  assert.equal(clipboard.items[0].text, raw);
  assert.equal(clipboard.items[0].source.clipboard, true);
  assert.equal(clipboard.items[0].source.frameId, 0);
  assert.equal(clipboard.items[0].source.pageTitle, 'A');

  const afterBlank = await service.pinClipboard({
    sessionId: 's',
    items: [{ text: ' \n ', source: { tabId: 9, frameId: 3, documentId: 'empty', url: 'https://example.test/empty' } }]
  });
  assert.equal(afterBlank.groups.find(isClipboardGroup).items.length, 3, 'a source never makes an empty body pinnable');
});

test('legacy source-free identity keys update their original main-frame item', async () => {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store, memoryJournal: true });
  service.ensureSession('s');
  const group = createGroup(store, { sessionId: 's' });
  // Simulates an item persisted before frame/document segments were added.
  const legacy = addWebItem(store, group.groupId, {
    source: { tabId: 7, url: 'https://example.test/a' }, locator: { css: '#same' },
    selector: '#same', text: 'visible text', kindHint: 'container', href: ''
  });
  const oldKey = '7|container|#same|||visible text';
  store.put('items', legacy.webItemId, { ...legacy, identityKey: oldKey });
  await service.setActiveGroup({ sessionId: 's', groupId: group.groupId });
  const state = await service.syncTabSelection({
    sessionId: 's', tabId: 7, url: 'https://example.test/a', elements: [capture()]
  });
  const items = captureGroup(state).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].webItemId, legacy.webItemId, 'legacy item retains its stable WebItem id');
  assert.notEqual(store.get('items', legacy.webItemId).identityKey, oldKey, 'the in-place update upgrades the key shape');
});

test('fragile pixel capture transports frame zero, document identity, and strict locator evidence', async () => {
  const previous = globalThis.chrome;
  const requests = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (request) => {
        requests.push(request);
        return { ok: true, dataUrl: 'data:image/png;base64,AA==' };
      }
    }
  };
  try {
    const fingerprint = { tag: 'img', src: 'https://cdn.example/a.jpg', href: '', text: '' };
    const result = await captureItemFromPage({
      capture: {
        source: { tabId: 8, frameId: 0, documentId: 'doc-main' },
        locator: { css: '#hero', fingerprint, strict: true },
        locatorFingerprint: fingerprint,
        src: 'https://cdn.example/a.jpg'
      }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(requests[0], {
      target: 'browserbot-background', action: 'workspace_capture_fragile', tabId: 8,
      selector: '#hero', src: 'https://cdn.example/a.jpg', frameId: 0, documentId: 'doc-main',
      locatorFingerprint: fingerprint, locator: { css: '#hero', fingerprint, strict: true }, captureBytes: true
    });
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
