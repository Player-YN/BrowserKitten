import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_ORIGIN, STAGING_ORIGIN, isCloudApiUrl, resolveCloudOrigin } from '../src/agent/cloudModels.js';
import { cloudBases, planCloudSignIn, planCloudSignOut } from '../src/agent/cloudAccount.js';
import { isCloudWebBase } from '../src/agent/byokGate.js';
import { defaultWebAcquireSettings, normalizeWebAcquireSettings } from '../src/agent/webAcquireSettings.js';

const store = (value) => ({ get: async () => (value === undefined ? {} : { browserbot_cloud_origin: value }) });
const empty = { providers: [], activeProviderId: null, active: null, activeImageProviderId: null, activeImage: null, activeSttProviderId: null, activeStt: null, activeJevProviderId: null, activeJev: null };

test('store builds always use production; unpacked builds switch only to the exact staging URL', async () => {
  const unpacked = { version: '1.2.0' };
  const store_ = { version: '1.2.0', update_url: 'https://clients2.google.com/service/update2/crx' };
  assert.equal(await resolveCloudOrigin({ storage: store(STAGING_ORIGIN), manifest: store_ }), CLOUD_ORIGIN);
  assert.equal(await resolveCloudOrigin({ storage: store(STAGING_ORIGIN), manifest: unpacked }), STAGING_ORIGIN);
  assert.equal(await resolveCloudOrigin({ storage: store(undefined), manifest: unpacked }), CLOUD_ORIGIN);
  assert.equal(await resolveCloudOrigin({ storage: store('https://evil.example'), manifest: unpacked }), CLOUD_ORIGIN);
  assert.equal(await resolveCloudOrigin({ storage: { get: async () => { throw new Error('x'); } }, manifest: unpacked }), CLOUD_ORIGIN);
});

test('both origins are ours; look-alike hosts and non-API paths are not', () => {
  assert.equal(isCloudApiUrl('https://browserkitten.com/api/v1/chat/completions'), true);
  assert.equal(isCloudApiUrl('https://staging.browserkitten.com/api/me'), true);
  assert.equal(isCloudApiUrl('https://browserkitten.com.evil.test/api/v1'), false);
  assert.equal(isCloudApiUrl('https://evil.test/?u=https://browserkitten.com/api/'), false);
  assert.equal(isCloudApiUrl('https://browserkitten.com/account.html'), false);
  assert.equal(isCloudWebBase('https://staging.browserkitten.com/api/tavily'), true);
  assert.equal(isCloudWebBase('https://api.tavily.com'), false);
});

test('a staging sign-in writes staging bases, and sign-out removes them', () => {
  const plan = planCloudSignIn(empty, defaultWebAcquireSettings(), 'bk_dev_t', null, STAGING_ORIGIN);
  const chat = plan.providers.find((p) => p.id === 'bk_cloud_chat');
  assert.equal(chat.baseURL, `${STAGING_ORIGIN}/api/v1`);
  assert.equal(plan.webPatch.tavilyBaseURL, cloudBases(STAGING_ORIGIN).tavily);
  const web = normalizeWebAcquireSettings({ ...defaultWebAcquireSettings(), ...plan.webPatch });
  // Re-signing in to production replaces the staging slots instead of treating them as the user's own keys.
  const again = planCloudSignIn({ ...empty, providers: plan.providers }, web, 'bk_dev_p');
  assert.equal(again.webPatch.tavilyBaseURL, cloudBases(CLOUD_ORIGIN).tavily);
  const out = planCloudSignOut({ ...empty, providers: plan.providers }, web);
  assert.equal(out.webPatch.tavilyKey, '');
  assert.equal(out.webPatch.firecrawlKey, '');
  assert.equal(out.providers.length, 0);
});
