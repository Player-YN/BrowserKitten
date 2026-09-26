import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_API_BASE,
  CLOUD_FIRECRAWL_BASE,
  CLOUD_IDS,
  CLOUD_TAVILY_BASE,
  cloudNoticeFor,
  cloudPausedMessage,
  cloudUsageRows,
  fetchCloudAccount,
  isCloudCreditsError,
  isCloudUsageLimitError,
  cloudLimitResetAt,
  isCloudPausedError,
  isCloudUpgradeError,
  planCloudSignIn,
  planCloudSignOut
} from '../src/agent/cloudAccount.js';
import { defaultWebAcquireSettings, normalizeWebAcquireSettings } from '../src/agent/webAcquireSettings.js';
import { normalizeProvider } from '../src/agent/llm.js';
import { formatModelChipLabel } from '../src/agent/modelCatalog.js';

const empty = { providers: [], activeProviderId: null, active: null, activeImageProviderId: null, activeImage: null, activeSttProviderId: null, activeStt: null, activeJevProviderId: null, activeJev: null };
const TOKEN = 'bk_dev_abc';

test('a fresh install gets every service on credits and all cloud records active', () => {
  const plan = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN);
  assert.deepEqual(plan.providers.map((p) => p.id), Object.values(CLOUD_IDS));
  const chat = plan.providers.find((p) => p.id === CLOUD_IDS.chat);
  assert.equal(chat.baseURL, CLOUD_API_BASE);
  assert.equal(chat.apiKey, TOKEN);
  assert.equal(chat.model, 'bk-auto', 'credit chat always sends the bk-auto route');
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

test('credit records always send their route, whatever a picker, editor or old record wrote', () => {
  const chat = normalizeProvider({ id: CLOUD_IDS.chat, baseURL: CLOUD_API_BASE, apiKey: TOKEN, model: 'deepseek-v4-flash', purpose: 'chat' });
  assert.equal(chat.model, 'bk-auto');
  assert.equal(normalizeProvider({ id: CLOUD_IDS.chat, model: '', purpose: 'chat' }).model, 'bk-auto', 'an empty model never falls back to a vendor default');
  assert.equal(normalizeProvider({ id: CLOUD_IDS.stt, model: 'whisper-1', purpose: 'stt' }).model, 'bk-stt');
  assert.equal(normalizeProvider({ id: CLOUD_IDS.jev, model: 'x', purpose: 'jev' }).model, 'bk-system1');
  const records = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN).providers;
  const image = normalizeProvider({ ...records.find((p) => p.id === CLOUD_IDS.image), image: { ...records.find((p) => p.id === CLOUD_IDS.image).image, model: 'dall-e-3' } });
  assert.equal(image.image.model, 'bk-image');
  assert.equal(image.model, '');
  const mine = normalizeProvider({ id: 'prov_me', model: 'deepseek-chat', purpose: 'chat' });
  assert.equal(mine.model, 'deepseek-chat', 'the user’s own providers keep their model');
});

test('the composer chip names the service, not the route id', () => {
  assert.equal(formatModelChipLabel('bk-auto', ''), 'Browser Kitten');
  assert.equal(formatModelChipLabel('bk-auto', 'bk-image'), 'Browser Kitten');
  assert.equal(formatModelChipLabel('openai/gpt-x', 'bk-image'), 'gpt-x · Browser Kitten');
  assert.equal(formatModelChipLabel('openai/gpt-x', ''), 'gpt-x');
});

test('sign-in only writes records the server hosts; chat always', () => {
  const plan = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN, { chat: true, light: true, systemone: false, image: false, stt: true });
  assert.deepEqual(plan.providers.map((p) => p.id), [CLOUD_IDS.chat, CLOUD_IDS.stt]);
  assert.equal(plan.activeProviderId, CLOUD_IDS.chat);
  assert.equal(plan.activeSttProviderId, CLOUD_IDS.stt);
  assert.equal(plan.activeImageProviderId, null, 'no dangling active id for an unhosted service');
  assert.equal(plan.activeJevProviderId, null);
  assert.deepEqual(plan.filled, { tavily: true, firecrawl: true }, 'web slots unchanged');
  const chatOnly = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN, { chat: false });
  assert.deepEqual(chatOnly.providers.map((p) => p.id), [CLOUD_IDS.chat], 'chat record is written even when chat is not hosted yet');
});

test('an older server without `hosted` still gets every record', () => {
  for (const hosted of [undefined, null, 'x']) {
    const plan = planCloudSignIn(empty, defaultWebAcquireSettings(), TOKEN, hosted);
    assert.deepEqual(plan.providers.map((p) => p.id), Object.values(CLOUD_IDS));
  }
});

test('re-sign-in after the server stops hosting a service drops the stale record but keeps the user’s own', () => {
  const first = planCloudSignIn(empty, defaultWebAcquireSettings(), 'bk_dev_old');
  const mineImg = { id: 'prov_img', name: 'Img', baseURL: '', apiKey: '', purpose: 'image', image: { apiKey: 'sk-img' } };
  const state = { ...empty, providers: [...first.providers, mineImg], activeProviderId: CLOUD_IDS.chat, activeJevProviderId: CLOUD_IDS.jev, activeImageProviderId: 'prov_img', activeImage: mineImg };
  const plan = planCloudSignIn(state, defaultWebAcquireSettings(), TOKEN, { image: false, stt: false, systemone: false });
  assert.deepEqual(plan.providers.map((p) => p.id), ['prov_img', CLOUD_IDS.chat]);
  assert.equal(plan.activeImageProviderId, 'prov_img');
  assert.equal(plan.activeJevProviderId, null);
});

test('426 and 503 from the proxy are recognized; other vendors’ are not', () => {
  assert.equal(isCloudUpgradeError({ statusCode: 426, message: 'Update Browser Kitten to keep using credits.' }), true);
  assert.equal(isCloudUpgradeError({ code: 'CLIENT_UPGRADE_REQUIRED' }), true);
  assert.equal(isCloudUpgradeError({ status: 426, responseBody: '{"error":{"code":"CLIENT_UPGRADE_REQUIRED","minVersion":"1.3.0"}}' }), true);
  assert.equal(isCloudUpgradeError({ statusCode: 426, message: 'Upgrade Required' }), false);
  assert.equal(isCloudPausedError({ statusCode: 503, message: 'SERVICE_PAUSED' }), true);
  assert.equal(isCloudPausedError({ statusCode: 503, message: 'Browser Kitten credits are paused for maintenance.' }), true);
  assert.equal(isCloudPausedError({ statusCode: 503, message: 'Service Unavailable' }), false);
  assert.equal(isCloudPausedError({ message: 'Failed after 3 attempts. Last error: Browser Kitten image generation is paused.' }), true, 'SDK retry wrapper');
  assert.equal(isCloudPausedError({ statusCode: 500, message: 'Browser Kitten paused' }), false);
  assert.equal(isCloudPausedError({ statusCode: 402, message: 'Out of Browser Kitten credits' }), false);
});

test('cloudNoticeFor keeps credits first and carries the server’s pause message', () => {
  assert.deepEqual(cloudNoticeFor({ code: 'CREDITS_EXHAUSTED' }), { kind: 'credits' });
  assert.deepEqual(cloudNoticeFor({ code: 'CLIENT_UPGRADE_REQUIRED' }), { kind: 'upgrade' });
  assert.deepEqual(cloudNoticeFor({ statusCode: 503, code: 'SERVICE_PAUSED', message: 'Image generation is paused until 18:00 UTC.' }), {
    kind: 'paused',
    message: 'Image generation is paused until 18:00 UTC.'
  });
  assert.equal(cloudNoticeFor({ statusCode: 500, message: 'boom' }), null);
  assert.equal(cloudPausedMessage({ message: 'HTTP 503', code: 'SERVICE_PAUSED' }), '');
  assert.equal(cloudPausedMessage({ message: 'Failed after 3 attempts. Last error: Browser Kitten is paused.' }), 'Browser Kitten is paused.');
  assert.equal(cloudPausedMessage({ responseBody: '{"error":{"code":"SERVICE_PAUSED","message":"Back soon."}}', message: 'x' }), 'Back soon.');
});

test('usage rows follow whatever windows the server sends', () => {
  assert.deepEqual(cloudUsageRows({ fiveHour: 12, weekly: 40 }, { fiveHour: 100, weekly: null, monthly: 900 }), [
    { key: 'fiveHour', used: 12, limit: 100 },
    { key: 'weekly', used: 40, limit: null },
    { key: 'monthly', used: 0, limit: 900 }
  ]);
  assert.deepEqual(cloudUsageRows(undefined, undefined), []);
});

test('Browser Kitten API calls name the client, and /api/me passes usage and limits through', async () => {
  const seen = [];
  const store = { browserbot_cloud_account: { token: TOKEN, deviceId: 'd1' } };
  const prevChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '9.8.7' }) }, storage: { local: { get: async (k) => ({ [k]: store[k] }) } } };
  try {
    const fetchImpl = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ email: 'a@b.c', plan: 'pro', planLabel: 'Pro', credits: 5, usage: { weekly: 3 }, limits: { weekly: 10 } }) };
    };
    const acct = await fetchCloudAccount({ fetchImpl });
    assert.equal(seen[0].headers['x-bk-client'], 'browser-kitten/9.8.7');
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(acct.usage, { weekly: 3 });
    assert.deepEqual(acct.limits, { weekly: 10 });
    assert.equal(acct.email, 'a@b.c');
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test('a weekly usage limit is its own notice, with when it frees up', () => {
  const at = '2026-10-04T03:00:00.000Z';
  const body = JSON.stringify({ error: { code: 'USAGE_LIMIT', message: 'You reached your weekly Browser Kitten usage limit on plan credits.', window: 'weekly', resetAt: at, boosterAvailable: 0 } });
  const fromBody = { statusCode: 429, responseBody: body };
  assert.equal(isCloudUsageLimitError(fromBody), true);
  assert.equal(isCloudCreditsError(fromBody), false);
  assert.deepEqual(cloudNoticeFor(fromBody), { kind: 'limit', resetAt: at });
  const fromText = { message: `USAGE_LIMIT: You reached your weekly Browser Kitten usage limit on plan credits. It frees up by ${at}. Booster credits are not limited.` };
  assert.equal(cloudLimitResetAt(fromText), at);
  assert.equal(cloudNoticeFor({ statusCode: 429, message: 'Rate limit from some other provider' }), null);
});
