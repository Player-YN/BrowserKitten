import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYOK_ENFORCE_UNPACKED_KEY,
  BYOK_ENTITLEMENT_KEY,
  BYOK_REQUIRES_PLAN,
  byokAllowed,
  byokStatus,
  entitlementFromMe,
  gateWebAcquire,
  isCloudWebBase,
  isUnpackedManifest,
  resetByokGateState,
  webAcquireForPlan
} from '../src/agent/byokGate.js';
import { CLOUD_TAVILY_BASE, cloudNoticeFor, isByokPlanError } from '../src/agent/cloudAccount.js';
import { runConfiguredSearch } from '../src/agent/vnext/primitives/webSearch.js';
import { acquire } from '../src/agent/vnext/primitives/acquire.js';
import { ContextWindowChecks } from '../src/agent/contextWindowProbe.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';

const H = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const ACCOUNT = { browserbot_cloud_account: { token: 'bk_dev_tok', deviceId: 'd1' } };

/** A Web Store build (manifest has update_url) unless `unpacked`. */
function stubChrome({ store = {}, unpacked = false } = {}) {
  const bag = { ...store };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.2.0', ...(unpacked ? {} : { update_url: 'https://clients2.google.com/service/update2/crx' }) })
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in bag).map((k) => [k, bag[k]])),
        set: async (values) => { Object.assign(bag, values); },
        remove: async (k) => { delete bag[k]; }
      }
    }
  };
  resetByokGateState();
  return bag;
}

function withChrome(fn) {
  return async () => {
    const prev = globalThis.chrome;
    try {
      await fn();
    } finally {
      globalThis.chrome = prev;
      resetByokGateState();
    }
  };
}

const meFetch = (plan, calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ plan }) };
};

test('byokAllowed: paid and fresh, stale, expired, free, missing, unpacked', () => {
  for (const plan of ['developer', 'standard', 'pro', 'max', 'Pro']) {
    assert.deepEqual(byokAllowed({ plan, checkedAt: NOW - H }, { now: NOW }), { allowed: true, refresh: false, reason: 'paid' }, plan);
  }
  assert.deepEqual(byokAllowed({ plan: 'pro', checkedAt: NOW - 7 * H }, { now: NOW }), { allowed: true, refresh: true, reason: 'paid' }, 'older than 6 h: refresh first');
  assert.deepEqual(byokAllowed({ plan: 'pro', checkedAt: NOW - 73 * H }, { now: NOW }), { allowed: false, refresh: true, reason: 'expired' }, 'past 72 h');
  assert.equal(byokAllowed({ plan: 'free', checkedAt: NOW }, { now: NOW }).allowed, false);
  assert.equal(byokAllowed({ plan: 'free', checkedAt: NOW }, { now: NOW }).reason, 'plan');
  assert.equal(byokAllowed({ plan: 'trial', checkedAt: NOW }, { now: NOW }).allowed, false);
  assert.equal(byokAllowed(null, { now: NOW }).reason, 'signed-out');
  assert.equal(byokAllowed({ plan: 'pro' }, { now: NOW }).allowed, false, 'no checkedAt');
  assert.equal(byokAllowed({ plan: 'pro', checkedAt: NOW + 24 * H }, { now: NOW }).allowed, false, 'a future timestamp is not trusted');
  assert.deepEqual(byokAllowed(null, { now: NOW, unpacked: true }), { allowed: true, refresh: false, reason: 'unpacked' });
  assert.deepEqual(entitlementFromMe({ plan: 'Developer', credits: 0 }, NOW), { plan: 'developer', checkedAt: NOW });
  assert.deepEqual(entitlementFromMe({}, NOW), { plan: 'free', checkedAt: NOW });
});

test('unpacked means no update_url; the Web Store build is gated', () => {
  assert.equal(isUnpackedManifest({ version: '1.2.0' }), true);
  assert.equal(isUnpackedManifest({ version: '1.2.0', update_url: 'https://clients2.google.com/service/update2/crx' }), false);
  assert.equal(isUnpackedManifest(null), true);
});

test('the plan error is recognised however it surfaced, and gets its own notice', () => {
  assert.equal(isByokPlanError({ code: BYOK_REQUIRES_PLAN }), true);
  assert.equal(isByokPlanError({ message: 'LanguageModel unavailable: Using your own API keys needs a Browser Kitten plan (Developer or above).' }), true);
  assert.equal(isByokPlanError({ ok: false, code: 'BYOK_REQUIRES_PLAN', error: 'x' }), true, 'tool result shape');
  assert.equal(isByokPlanError({ code: 'CREDITS_EXHAUSTED' }), false);
  assert.equal(isByokPlanError(null), false);
  assert.deepEqual(cloudNoticeFor({ code: BYOK_REQUIRES_PLAN }), { kind: 'byok' });
  assert.deepEqual(cloudNoticeFor({ code: 'CREDITS_EXHAUSTED' }), { kind: 'credits' }, 'credits unchanged');
});

test('web slots: own keys are blanked without a plan, Browser Kitten slots stay', () => {
  assert.equal(isCloudWebBase(CLOUD_TAVILY_BASE), true);
  assert.equal(isCloudWebBase('https://api.tavily.com'), false);
  assert.equal(isCloudWebBase('https://browserkitten.com.evil.test/api/tavily'), false);
  const mine = { tavilyKey: 'tvly-mine', tavilyBaseURL: 'https://api.tavily.com', braveKey: 'BSA', firecrawlKey: 'fc', firecrawlBaseURL: 'https://api.firecrawl.dev' };
  const blocked = webAcquireForPlan(mine, false);
  assert.deepEqual([blocked.tavilyKey, blocked.braveKey, blocked.firecrawlKey], ['', '', '']);
  assert.deepEqual(blocked.byokBlocked.sort(), ['brave', 'firecrawl', 'tavily']);
  assert.equal(mine.tavilyKey, 'tvly-mine', 'saved settings untouched');
  assert.deepEqual(webAcquireForPlan(mine, true), mine);
  const cloud = { tavilyKey: 'bk_dev_tok', tavilyBaseURL: CLOUD_TAVILY_BASE };
  assert.deepEqual(webAcquireForPlan(cloud, false), cloud);
});

test('byokStatus: store build signed out, paid, free, and no account', withChrome(async () => {
  stubChrome();
  assert.deepEqual(await byokStatus({ now: NOW }), { allowed: false, reason: 'signed-out', plan: '', signedIn: false });

  stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'developer', checkedAt: NOW - H } } });
  const calls = [];
  const paid = await byokStatus({ now: NOW, fetchImpl: meFetch('developer', calls) });
  assert.equal(paid.allowed, true);
  assert.equal(calls.length, 0, 'fresh cache: no /api/me');

  // A paid cache without an account is not trusted (sign-out clears it anyway).
  stubChrome({ store: { [BYOK_ENTITLEMENT_KEY]: { plan: 'pro', checkedAt: NOW } } });
  assert.equal((await byokStatus({ now: NOW })).allowed, false);
}));

test('byokStatus refreshes a stale cache, falls back to 72 h offline, clears on 401', withChrome(async () => {
  let bag = stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'pro', checkedAt: NOW - 10 * H } } });
  const calls = [];
  const downgraded = await byokStatus({ now: NOW, fetchImpl: meFetch('free', calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://browserkitten.com/api/me');
  assert.equal(calls[0].init.headers.authorization, 'Bearer bk_dev_tok');
  assert.equal(downgraded.allowed, false);
  assert.deepEqual(bag[BYOK_ENTITLEMENT_KEY], { plan: 'free', checkedAt: NOW });

  stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'pro', checkedAt: NOW - 10 * H } } });
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await byokStatus({ now: NOW, fetchImpl: offline })).allowed, true, 'within 72 h grace');
  stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'pro', checkedAt: NOW - 80 * H } } });
  assert.equal((await byokStatus({ now: NOW, fetchImpl: offline })).allowed, false, 'past the grace');

  bag = stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'pro', checkedAt: NOW - 10 * H } } });
  const signedOutElsewhere = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal((await byokStatus({ now: NOW, fetchImpl: signedOutElsewhere })).allowed, false);
  assert.equal(bag[BYOK_ENTITLEMENT_KEY], null, '401 clears the cache');

  // Free and fresh: an upgrade is picked up by the next refused call.
  stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'free', checkedAt: NOW - H } } });
  assert.equal((await byokStatus({ now: NOW, fetchImpl: meFetch('pro') })).allowed, true);
}));

test('unpacked loads are exempt unless the enforce flag is set', withChrome(async () => {
  stubChrome({ unpacked: true });
  assert.equal((await byokStatus({ now: NOW })).reason, 'unpacked');
  stubChrome({ unpacked: true, store: { [BYOK_ENFORCE_UNPACKED_KEY]: true } });
  assert.equal((await byokStatus({ now: NOW })).allowed, false);
}));

test('chat gate: an own-key chat model is refused without a plan; the credit record is not', withChrome(async () => {
  stubChrome();
  const svc = { model: 'stale' };
  const resolve = (settings) => SessionWorkspaceService.prototype.resolveLanguageModel.call(svc, { settings, mediaCapabilities: { inputs: {} } });
  await assert.rejects(
    resolve({ apiKey: 'sk-mine', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', providerId: 'prov_me' }),
    (error) => error.code === BYOK_REQUIRES_PLAN && /Browser Kitten plan/.test(error.message)
  );
  await assert.rejects(
    resolve({ apiKey: 'sk-legacy', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', providerId: null }),
    (error) => error.code === BYOK_REQUIRES_PLAN,
    'legacy flat keys are the user’s own too'
  );
  const model = await resolve({ apiKey: 'bk_dev_tok', apiBase: 'https://browserkitten.com/api/v1', model: 'bk-auto', providerId: 'bk_cloud_chat' });
  assert.ok(model, 'credits need no plan');

  stubChrome({ store: { ...ACCOUNT, [BYOK_ENTITLEMENT_KEY]: { plan: 'developer', checkedAt: Date.now() } } });
  assert.ok(await resolve({ apiKey: 'sk-mine', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', providerId: 'prov_me' }));
}));

test('web search gate: own Tavily key refused without a plan, the Browser Kitten slot goes through', withChrome(async () => {
  stubChrome();
  const hits = [];
  const fetchImpl = async (url) => {
    hits.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: [{ title: 'a', url: 'https://a.test', content: 'x' }] }) };
  };
  const own = await gateWebAcquire({ searchProvider: 'tavily', tavilyKey: 'tvly-mine', tavilyBaseURL: 'https://api.tavily.com' }, { fetchImpl });
  const refused = await runConfiguredSearch(own, { query: 'q', limit: 3, fetchImpl });
  assert.equal(refused.code, BYOK_REQUIRES_PLAN);
  assert.equal(hits.length, 0, 'the user’s Tavily is never called');

  const cloud = await gateWebAcquire({ searchProvider: 'tavily', tavilyKey: 'bk_dev_tok', tavilyBaseURL: CLOUD_TAVILY_BASE }, { fetchImpl });
  const ok = await runConfiguredSearch(cloud, { query: 'q', limit: 3, fetchImpl });
  assert.equal(ok.ok, true);
  assert.ok(hits[0].startsWith(CLOUD_TAVILY_BASE));

  // map needs the site-read API: own Firecrawl without a plan says why.
  const fs = { writeFile: async () => {}, mkdir: async () => {} };
  const fc = await gateWebAcquire({ firecrawlKey: 'fc-mine', firecrawlBaseURL: 'https://api.firecrawl.dev' });
  const map = await acquire({ fs, fetchImpl, webAcquire: fc }, { action: 'map', url: 'https://example.com' });
  assert.equal(map.code, BYOK_REQUIRES_PLAN);
}));

test('background probes skip silently without a plan', async () => {
  let ran = 0;
  const checks = new ContextWindowChecks({
    getSettings: async () => ({ apiKey: 'sk-mine', apiBase: 'https://api.example.test/v1', model: 'm1', providerId: 'prov_me' }),
    getModels: async () => ({ models: [] }),
    get: async () => ({}),
    set: async () => {},
    run: async () => { ran++; return { window: null, source: 'unknown', kind: 'x' }; },
    byokAllowed: async () => false
  });
  assert.deepEqual(await checks.request({ force: true }), { queued: false, reason: BYOK_REQUIRES_PLAN });
  assert.equal(ran, 0);
});
