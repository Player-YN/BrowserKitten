import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextWindowSettings } from '../src/sidepanel/contextWindowSettings.js';

const provider = { id: 'current', baseURL: 'https://gateway.test/v1', model: 'model-a', apiKey: 'saved-secret' };

test('context-window paint does not assign the read-only HTMLElement.dataset getter', () => {
  const nodes = new Map();
  class GetterOnlyDatasetNode {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.hidden = false;
      this.handlers = {};
      this._data = {};
    }
    get dataset() { return this._data; }
    append(...children) { for (const child of children) if (child.id) nodes.set(child.id, child); }
    replaceChildren() {}
    setAttribute() {}
    addEventListener(name, cb) { this.handlers[name] = cb; }
  }
  assert.throws(() => {
    const n = new GetterOnlyDatasetNode('x');
    n.dataset = n.dataset || {};
  }, { name: 'TypeError' });

  for (const id of ['agentSettingsModal', 'inferenceEditor', 'contextWindowStatusPanel', 'apiBaseInput', 'providerModelInput', 'apiKeyInput']) {
    nodes.set(id, new GetterOnlyDatasetNode(id));
  }
  nodes.get('apiBaseInput').value = provider.baseURL;
  nodes.get('providerModelInput').value = provider.model;
  const root = {
    visibilityState: 'visible',
    getElementById: (id) => nodes.get(id),
    createElement: () => new GetterOnlyDatasetNode(),
    addEventListener() {}
  };
  assert.doesNotThrow(() => {
    const ui = createContextWindowSettings({
      root,
      t: (key) => key,
      workspaceRpc: async () => ({}),
      loadProvidersState: async () => ({ activeProviderId: provider.id, providers: [provider] }),
      getProviderId: () => provider.id,
      storage: { local: { get: (_keys, cb) => cb({}) } }
    });
    ui.load();
    ui.sync();
  });
});

test('context-window auto-check mounts in the advanced host, not the status panel', () => {
  const nodes = new Map();
  class Node {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.hidden = false;
      this.handlers = {};
      this.children = [];
    }
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
  for (const id of ['agentSettingsModal', 'inferenceEditor', 'contextWindowStatusPanel', 'inferenceAutoCheckHost', 'apiBaseInput', 'providerModelInput', 'apiKeyInput']) {
    nodes.set(id, new Node(id));
  }
  nodes.get('apiBaseInput').value = provider.baseURL;
  nodes.get('providerModelInput').value = provider.model;
  const root = {
    visibilityState: 'visible',
    getElementById: (id) => nodes.get(id),
    createElement: () => new Node(),
    addEventListener() {}
  };
  createContextWindowSettings({
    root,
    t: (key) => key,
    workspaceRpc: async () => ({}),
    loadProvidersState: async () => ({ activeProviderId: provider.id, providers: [provider] }),
    getProviderId: () => provider.id,
    storage: { local: { get: (_keys, cb) => cb({}) } }
  }).load();
  assert.ok(nodes.get('contextWindowAutoCheck'));
  assert.equal(nodes.get('contextWindowStatusPanel').children.some((c) => c.id === 'contextWindowAutoCheck'), false);
});
