import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_API_BASE,
  CLOUD_FIRECRAWL_BASE,
  CLOUD_IDS,
  CLOUD_TAVILY_BASE,
  isCloudCreditsError,
  planCloudSignIn,
  planCloudSignOut
} from '../src/agent/cloudAccount.js';
import { defaultWebAcquireSettings, normalizeWebAcquireSettings } from '../src/agent/webAcquireSettings.js';

const empty = { providers: [], activeProviderId: null, active: null, activeImageProviderId: null, activeImage: null, activeSttProviderId: null, activeStt: null, activeJevProviderId: null, activeJev: null };
const TOKEN = 'bk_dev_abc';

test('a fresh install gets every service on credits and all cloud records active', () => {
  const plan = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN, { chatModel: 'bk-default' });
  assert.deepEqual(plan.providers.map((p) => p.id), Object.values(CLOUD_IDS));
  const chat = plan.providers.find((p) => p.id === CLOUD_IDS.chat);
  assert.equal(chat.baseURL, CLOUD_API_BASE);
  assert.equal(chat.apiKey, TOKEN);
  assert.equal(chat.model, 'bk-default');
  const image = plan.providers.find((p) => p.id === CLOUD_IDS.image);
  assert.equal(image.image.protocol, 'openai-image');
  assert.equal(image.image.apiKey, TOKEN);
  assert.equal(plan.activeProviderId, CLOUD_IDS.chat);
  assert.equal(plan.activeImageProviderId, CLOUD_IDS.image);
  assert.equal(plan.activeSttProviderId, CLOUD_IDS.stt);
  assert.equal(plan.activeJevProviderId, CLOUD_IDS.jev);
  assert.deepEqual(plan.filled, { tavily: true, firecrawl: true });
  assert.equal(plan.webPatch.tavilyBaseURL, CLOUD_TAVILY_BASE);
  assert.equal(plan.webPatch.firecrawlBaseURL, CLOUD_FIRECRAWL_BASE);
});

test('the user’s own keys stay active and untouched', () => {
  const mine = { id: 'prov_me', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-mine', model: 'deepseek-chat', purpose: 'chat' };
  const state = { ...empty, providers: [mine], activeProviderId: 'prov_me', active: mine };
  const web = normalizeWebAcquireSettings({ tavilyKey: 'tvly-mine', firecrawlKey: '' });
  const plan = planCloudSignIn(state, web, TOKEN);
  assert.equal(plan.activeProviderId, 'prov_me');
  assert.equal(plan.providers.find((p) => p.id === 'prov_me').apiKey, 'sk-mine');
  assert.equal(plan.activeSttProviderId, CLOUD_IDS.stt, 'empty slots still get credits');
  assert.equal(plan.webPatch.tavilyKey, undefined, 'own Tavily key kept');
  assert.equal(plan.webPatch.firecrawlKey, TOKEN);
  assert.deepEqual(plan.filled, { tavily: false, firecrawl: true });
});

test('signing in again replaces the token instead of duplicating records', () => {
  const first = planCloudSignIn(empty, defaultWebAcquireSettings(), 'bk_dev_old');
  const web = normalizeWebAcquireSettings({ ...defaultWebAcquireSettings(), ...first.webPatch });
  const second = planCloudSignIn({ ...empty, providers: first.providers, activeProviderId: CLOUD_IDS.chat, active: first.providers[0] }, web, 'bk_dev_new');
  assert.equal(second.providers.length, 4);
  assert.ok(second.providers.every((p) => !JSON.stringify(p).includes('bk_dev_old')));
  assert.equal(second.webPatch.tavilyKey, 'bk_dev_new');
  assert.equal(second.activeProviderId, CLOUD_IDS.chat);
});

test('sign-out removes only what sign-in added', () => {
  const mine = { id: 'prov_me', name: 'Mine', baseURL: 'https://x.test/v1', apiKey: 'sk-mine', model: 'm', purpose: 'chat' };
  const signedIn = planCloudSignIn({ ...empty, providers: [mine], activeProviderId: 'prov_me', active: mine }, normalizeWebAcquireSettings({ tavilyKey: 'tvly-mine' }), TOKEN);
  const web = normalizeWebAcquireSettings({ tavilyKey: 'tvly-mine', ...signedIn.webPatch });
  const out = planCloudSignOut({ ...empty, providers: signedIn.providers, activeProviderId: 'prov_me', activeSttProviderId: CLOUD_IDS.stt }, web);
  assert.deepEqual(out.providers.map((p) => p.id), ['prov_me']);
  assert.equal(out.activeProviderId, 'prov_me');
  assert.equal(out.activeSttProviderId, null);
  assert.equal(out.webPatch.tavilyKey, undefined, 'own Tavily key survives sign-out');
  assert.equal(out.webPatch.firecrawlKey, '');
});

test('credit exhaustion is recognized from the proxy’s 402 however it was surfaced', () => {
  assert.equal(isCloudCreditsError({ statusCode: 402, message: 'Out of Browser Kitten credits. Add a booster…' }), true);
  assert.equal(isCloudCreditsError({ code: 'CREDITS_EXHAUSTED' }), true);
  assert.equal(isCloudCreditsError({ statusCode: 402, responseBody: '{"error":{"code":"CREDITS_EXHAUSTED"}}' }), true);
  assert.equal(isCloudCreditsError({ statusCode: 402, message: 'Insufficient balance' }), false, "another vendor's 402 is not ours");
  assert.equal(isCloudCreditsError({ statusCode: 500, message: 'boom' }), false);
});
