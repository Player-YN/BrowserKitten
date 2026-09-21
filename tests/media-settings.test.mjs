import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatMediaSettings, matchesChatMediaConfig, mediaStatusLabel, mediaCheckErrorLabel, mediaIconState } from '../src/sidepanel/chatMediaSettings.js';
import { mediaModelKey } from '../src/agent/chatMedia.js';

const provider = { id: 'current', baseURL: 'https://gateway.test/v1', model: 'model-a', apiKey: 'saved-secret' };
const draft = { provider, providerId: provider.id, base: provider.baseURL, model: provider.model, apiKey: '', overrides: {} };
test('media settings only show evidence for the saved connection and exact model', () => {
  assert.equal(matchesChatMediaConfig(draft), true);
  for (const patch of [{ providerId: 'other' }, { model: 'model-b' }, { base: 'https://other.test/v1' }, { apiKey: 'new-secret' },
    { overrides: { [mediaModelKey(provider.baseURL, provider.model)]: { video: true } } }]) {
    assert.equal(matchesChatMediaConfig({ ...draft, ...patch }), false);
  }
  assert.equal(matchesChatMediaConfig({ ...draft, apiKey: provider.apiKey }), true);
});

test('media status distinguishes verification, declarations and rejected formats', () => {
  assert.equal(mediaStatusLabel({ state: 'supported', source: 'verified' }, null, 'video'), 'chatMediaVerified');
  assert.equal(mediaStatusLabel({ state: 'supported', source: 'verified', stale: true }, null, 'video'), 'chatMediaVerifiedStale');
  assert.equal(mediaStatusLabel({ state: 'supported', source: 'catalog' }, null, 'image'), 'chatMediaDeclared');
  assert.equal(mediaStatusLabel({ state: 'supported', rejectedFormats: ['video/webm'] }, null, 'video'), 'chatMediaRejected');
  assert.equal(mediaStatusLabel({}, 'audio', 'audio'), 'chatMediaChecking');
  assert.equal(mediaStatusLabel({}, 'audio', 'video'), 'chatMediaUnknown');
  assert.equal(mediaIconState('chatMediaDeclared'), 'supported');
  assert.equal(mediaIconState('chatMediaNo'), 'unsupported');
  assert.equal(mediaIconState('chatMediaUnknown'), 'unknown');
  assert.equal(mediaIconState('chatMediaChecking'), 'checking');
});

test('last check error copy never exposes raw upstream errors', () => {
  assert.equal(mediaCheckErrorLabel('HTTP_401'), 'chatMediaCheckAuth');
  assert.equal(mediaCheckErrorLabel('HTTP_429'), 'chatMediaCheckRateLimit');
  assert.equal(mediaCheckErrorLabel('ANSWER_MISMATCH'), 'chatMediaCheckAnswerMismatch');
  assert.equal(mediaCheckErrorLabel('an upstream error with a secret'), 'chatMediaCheckUnavailable');
});

function fixture(rpc, loadProvidersState = async () => ({ activeProviderId: provider.id, providers: [provider] }), NodeImpl, extraIds = []) {
  const nodes = new Map();
  class Node {
    constructor(id) { this.id = id; this.value = ''; this.hidden = false; this.handlers = {}; this.children = []; }
    append(...children) {
      for (const child of children) {
        this.children.push(child);
        if (child.id) nodes.set(child.id, child);
        for (const nested of child.children || []) if (nested.id) nodes.set(nested.id, nested);
      }
    }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    addEventListener(name, cb) { this.handlers[name] = cb; }
  }
  const Ctor = NodeImpl || Node;
  for (const id of ['agentSettingsModal', 'inferenceEditor', 'chatMediaSettings', 'chatMediaStatusPanel', 'apiBaseInput', 'providerModelInput', 'apiKeyInput', ...extraIds]) nodes.set(id, new Ctor(id));
  nodes.get('apiBaseInput').value = provider.baseURL;
  nodes.get('providerModelInput').value = provider.model;
  const root = { visibilityState: 'visible', getElementById: id => nodes.get(id), createElement: () => new Ctor(), addEventListener() {} };
  const ui = createChatMediaSettings({ root, t: key => key, workspaceRpc: rpc,
    loadProvidersState, getProviderId: () => provider.id,
    storage: { local: { get: (_keys, cb) => cb({}) } } });
  ui.load(provider);
  return { ui, nodes, root };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('opening settings checks in background; unsaved draft never requests a check', async () => {
  const calls = [];
  const f = fixture(async (method) => {
    calls.push(method);
    return { providerId: provider.id, model: provider.model, base: provider.baseURL, capabilities: { inputs: {} } };
  });
  f.nodes.get('agentSettingsModal').open = true;
  f.ui.open(); await tick();
  assert.deepEqual(calls, ['requestChatMediaCheck', 'getChatMediaStatus']);
  calls.length = 0;
  f.nodes.get('apiKeyInput').value = 'unsaved-key';
  f.ui.open(); await tick();
  assert.equal(calls.length, 0);
  assert.equal(f.nodes.get('chatMediaStatus').title, 'chatMediaSaveFirst');
});

test('late status does not overwrite closed settings or a changed draft', async () => {
  let finish;
  const f = fixture(method => method === 'getChatMediaStatus' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ queued: true }));
  f.nodes.get('agentSettingsModal').open = true;
  f.ui.open(); await tick();
  f.nodes.get('agentSettingsModal').open = false;
  f.nodes.get('agentSettingsModal').handlers.close();
  finish({ providerId: provider.id, base: provider.baseURL, model: provider.model, capabilities: { inputs: { video: { state: 'supported', source: 'verified' } } } });
  await tick();
  assert.equal(f.nodes.get('chatMediaStatus').title, 'chatMediaUnknown');
});

test('verified video soundtrack does not show the unverified audio warning', async () => {
  const f = fixture(async () => ({ providerId: provider.id, model: provider.model, base: provider.baseURL,
    capabilities: { inputs: { video: { state: 'supported', source: 'verified' } }, videoAudio: 'verified' } }));
  f.nodes.get('agentSettingsModal').open = true;
  f.ui.open(); await tick();
  assert.match(f.nodes.get('chatMediaStatus').title, /chatMediaVerified/);
  assert.doesNotMatch(f.nodes.get('chatMediaStatus').title, /chatMediaVideoAudioUnknown/);
});

test('a key saved during a status request prevents showing the old key evidence', async () => {
  let current = { ...provider }, finish, reads = 0;
  const f = fixture(method => {
    if (method !== 'getChatMediaStatus') return Promise.resolve({ queued: true });
    reads++;
    if (reads === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ providerId: provider.id, model: provider.model, base: provider.baseURL, capabilities: { inputs: {} } });
  }, async () => ({ activeProviderId: current.id, providers: [current] }));
  f.nodes.get('agentSettingsModal').open = true;
  f.ui.open(); await tick();
  current = { ...provider, apiKey: 'replacement-key' };
  finish({ providerId: provider.id, model: provider.model, base: provider.baseURL,
    capabilities: { inputs: { audio: { state: 'supported', source: 'verified' } } } });
  await tick();
  assert.equal(reads, 2);
  assert.doesNotMatch(f.nodes.get('chatMediaStatus').title, /chatMediaVerified/);
});

test('capability paint does not assign the read-only HTMLElement.dataset getter', () => {
  class GetterOnlyDatasetNode {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.hidden = false;
      this.handlers = {};
      this._data = {};
    }
    get dataset() { return this._data; }
    append() {}
    replaceChildren() {}
    setAttribute() {}
    addEventListener(name, cb) { this.handlers[name] = cb; }
  }
  assert.throws(() => {
    const n = new GetterOnlyDatasetNode('x');
    n.dataset = n.dataset || {};
  }, { name: 'TypeError' });
  assert.doesNotThrow(() => {
    fixture(async () => ({
      providerId: provider.id,
      model: provider.model,
      base: provider.baseURL,
      capabilities: { inputs: {} }
    }), undefined, GetterOnlyDatasetNode);
  });
});

test('auto-check stays off the main surface and mounts in the advanced host', () => {
  const main = fixture(async () => ({ providerId: provider.id, model: provider.model, base: provider.baseURL, capabilities: { inputs: {} } }));
  assert.equal(main.nodes.has('chatMediaAutoCheck'), false);
  const advanced = fixture(async () => ({ providerId: provider.id, model: provider.model, base: provider.baseURL, capabilities: { inputs: {} } }), undefined, undefined, ['inferenceAutoCheckHost']);
  assert.ok(advanced.nodes.get('chatMediaAutoCheck'));
  assert.equal(advanced.nodes.get('chatMediaStatusPanel').children.some((c) => c.id === 'chatMediaAutoCheck'), false);
});

test('hidden inference diagnostics do not start a media check', async () => {
  const calls = [];
  const f = fixture(async (method) => {
    calls.push(method);
    return { providerId: provider.id, model: provider.model, base: provider.baseURL, capabilities: { inputs: {} } };
  }, undefined, undefined, ['inferenceDiagnostics']);
  f.nodes.get('inferenceDiagnostics').hidden = true;
  f.nodes.get('agentSettingsModal').open = true;
  f.ui.open(); await tick();
  assert.deepEqual(calls, []);
});
