import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PRESETS,
  IMAGE_PROVIDER_PRESETS,
  STT_PROVIDER_PRESETS,
  JEV_PROVIDER_PRESETS,
  WEB_PROVIDER_PRESETS,
  assertInferencePresetsValid,
  normalizePresetBaseURL
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
