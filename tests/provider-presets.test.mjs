import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PRESETS,
  IMAGE_PROVIDER_PRESETS,
  STT_PROVIDER_PRESETS,
  JEV_PROVIDER_PRESETS,
  WEB_PROVIDER_PRESETS,
  assertInferencePresetsValid,
  normalizePresetBaseURL,
  presetsForTemplateCombobox
} from '../src/agent/providerPresets.js';
import { PROVIDER_PRESETS as llmProviderPresets } from '../src/agent/llm.js';

test('llm.js re-exports the same PROVIDER_PRESETS catalog', () => {
  assert.equal(llmProviderPresets, PROVIDER_PRESETS);
});

test('inference presets: unique ids, names, http(s) bases, allowed protocols', () => {
  assert.ok(PROVIDER_PRESETS.length >= 20);
  assertInferencePresetsValid(PROVIDER_PRESETS);
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.protocol, `protocol required for ${p.id}`);
    assert.match(p.protocol, /^(openai-compatible|anthropic|auto)$/);
  }
});

test('openai-compatible custom preset keeps empty base and still has protocol', () => {
  const custom = PROVIDER_PRESETS.find((p) => p.id === 'openai-compatible');
  assert.ok(custom);
  assert.equal(normalizePresetBaseURL(custom.baseURL), '');
  assert.equal(custom.protocol, 'openai-compatible');
});

test('custom preset stays in catalogs for apply, but not in template combobox options', () => {
  assert.ok(PROVIDER_PRESETS.some((p) => p.id === 'openai-compatible'));
  assert.ok(IMAGE_PROVIDER_PRESETS.some((p) => p.id === 'openai-compatible'));
  assert.ok(STT_PROVIDER_PRESETS.some((p) => p.id === 'openai-compatible'));
  assert.ok(JEV_PROVIDER_PRESETS.some((p) => p.id === 'openai-compatible'));
  assert.equal(
    presetsForTemplateCombobox(PROVIDER_PRESETS).some((p) => p.id === 'openai-compatible'),
    false
  );
  assert.equal(
    presetsForTemplateCombobox(IMAGE_PROVIDER_PRESETS).some((p) => p.id === 'openai-compatible'),
    false
  );
  assert.equal(
    presetsForTemplateCombobox(STT_PROVIDER_PRESETS).some((p) => p.id === 'openai-compatible'),
    false
  );
  assert.equal(
    presetsForTemplateCombobox(JEV_PROVIDER_PRESETS).some((p) => p.id === 'openai-compatible'),
    false
  );
  // Web never had a blank custom entry — filter is a no-op.
  assert.deepEqual(
    presetsForTemplateCombobox(WEB_PROVIDER_PRESETS).map((p) => p.id).sort(),
    WEB_PROVIDER_PRESETS.map((p) => p.id).sort()
  );
});

test('legacy presets remain present', () => {
  for (const id of ['deepseek', 'openai', 'anthropic', 'opencode-zen', 'openrouter', 'minimax']) {
    assert.ok(
      PROVIDER_PRESETS.some((p) => p.id === id),
      `missing legacy preset ${id}`
    );
  }
  const zen = PROVIDER_PRESETS.find((p) => p.id === 'opencode-zen');
  assert.equal(zen.protocol, 'auto');
});

test('sibling preset catalogs stay populated', () => {
  assert.ok(IMAGE_PROVIDER_PRESETS.some((p) => p.id === 'openrouter'));
  assert.ok(STT_PROVIDER_PRESETS.some((p) => p.id === 'openai'));
  assert.ok(JEV_PROVIDER_PRESETS.some((p) => p.id === 'opencode'));
  assert.deepEqual(
    WEB_PROVIDER_PRESETS.map((p) => p.id).sort(),
    ['brave', 'firecrawl', 'tavily']
  );
});

test('System1 presets use vendor-confirmed model ids; custom leaves model empty; Laya local uses multilingual', () => {
  const zen = JEV_PROVIDER_PRESETS.find((p) => p.id === 'opencode');
  const typesafe = JEV_PROVIDER_PRESETS.find((p) => p.id === 'typesafe');
  const openrouter = JEV_PROVIDER_PRESETS.find((p) => p.id === 'openrouter');
  const laya = JEV_PROVIDER_PRESETS.find((p) => p.id === 'laya-local');
  const custom = JEV_PROVIDER_PRESETS.find((p) => p.id === 'openai-compatible');
  assert.equal(zen.model, 'jev-1.13');
  assert.equal(zen.baseURL, 'https://opencode.ai/zen/v1');
  assert.equal(typesafe.model, 'jev-1.13.0');
  assert.equal(typesafe.baseURL, 'https://api.typesafe.ai/v1');
  assert.equal(openrouter.model, 'typesafe/jev-1.13');
  assert.equal(openrouter.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(laya.model, 'multilingual');
  assert.equal(laya.baseURL, 'http://localhost:8000/v1');
  assert.equal(custom.model, '');
  assert.equal(custom.baseURL, '');
});
