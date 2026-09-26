/**
 * BYOK needs a paid Browser Kitten plan.
 *
 * Using your own API keys (any provider the user configured: not a fixed-id `bk_cloud_*`
 * record, and not a Tavily / Firecrawl slot whose base URL is browserkitten.com) is
 * allowed only while the user is signed in to Browser Kitten on the developer,
 * standard, pro or max plan. Free / trial accounts use credits only. BYOK calls never
 * reach our server and never cost credits; this is a client-side gate, checked at the
 * places the extension calls a user-configured model / search / fetch service.
 *
 *   chrome.storage.local  browserbot_cloud_entitlement = { plan, checkedAt }
 *     written whenever /api/me is read (sign-in, Settings, the refresh below);
 *     cleared on sign-out and on a 401 from /api/me.
 *
 * Freshness: a paid plan checked within 72 h allows BYOK. Older than 6 h (or not
 * allowed at all) → refresh /api/me first; a network failure falls back to the 72 h rule.
 *
 * Unpacked builds are exempt: the Chrome Web Store adds `update_url` to the manifest,
 * so a manifest without it is a development (unpacked) load. Store builds are gated.
 * No manifest at all (Node tests) also counts as unpacked. To try the gate on an
 * unpacked load, set chrome.storage.local `browserbot_byok_enforce_unpacked = true`.
 *
 * Leaf module: imports only cloudModels.js, so llm.js / cloudAccount.js / SW / offscreen
 * can all use it without cycles. Storage goes direct when chrome.storage exists
 * (SW, side panel) and through the SW bridge otherwise (offscreen).
 */
import { BK_CLIENT_HEADER, CLOUD_ORIGIN, bkClientHeaderValue, cloudOriginOf, isCloudProviderId } from './cloudModels.js';

export const BYOK_ENTITLEMENT_KEY = 'browserbot_cloud_entitlement';
export const BYOK_ENFORCE_UNPACKED_KEY = 'browserbot_byok_enforce_unpacked';
/** Same key cloudAccount.js writes the device token to. */
export const BYOK_ACCOUNT_KEY = 'browserbot_cloud_account';
export const BYOK_REQUIRES_PLAN = 'BYOK_REQUIRES_PLAN';
export const BYOK_PLANS = Object.freeze(['developer', 'standard', 'pro', 'max']);
export const BYOK_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
export const BYOK_GRACE_MS = 72 * 60 * 60 * 1000;
/** A cache timestamp this far in the future is treated as bogus. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** A refused call retries /api/me at most this often (an upgrade shows up without waiting 6 h). */
const DENIED_REFRESH_MIN_MS = 30 * 1000;

export const BYOK_PLAN_MESSAGE =
  'Using your own API keys needs a Browser Kitten plan (Developer or above). Sign in or upgrade, or switch this service to Browser Kitten credits.';

/** The cache entry to store after reading /api/me. */
export function entitlementFromMe(me, now = Date.now()) {
  const plan = String(me?.plan || 'free').trim().toLowerCase() || 'free';
  return { plan, checkedAt: now };
}

/**
 * Pure decision.
 * @param {{ plan?: string, checkedAt?: number } | null | undefined} entitlement
 * @param {{ now?: number, unpacked?: boolean }} [opts]
 * @returns {{ allowed: boolean, refresh: boolean, reason: 'unpacked'|'paid'|'signed-out'|'plan'|'expired' }}
 *   `refresh`: the caller should read /api/me before deciding (non-fatal if that fails).
 */
export function byokAllowed(entitlement, { now = Date.now(), unpacked = false } = {}) {
  if (unpacked) return { allowed: true, refresh: false, reason: 'unpacked' };
  const plan = String(entitlement?.plan || '').toLowerCase();
  const checkedAt = Number(entitlement?.checkedAt);
  if (!plan || !Number.isFinite(checkedAt) || checkedAt <= 0) {
    return { allowed: false, refresh: true, reason: 'signed-out' };
  }
  const age = now - checkedAt;
  const sane = age >= -FUTURE_SKEW_MS;
  const paid = BYOK_PLANS.includes(plan);
  const withinGrace = sane && age <= BYOK_GRACE_MS;
  const stale = !sane || age > BYOK_REFRESH_AFTER_MS;
  if (!paid) return { allowed: false, refresh: true, reason: 'plan' };
  if (!withinGrace) return { allowed: false, refresh: true, reason: 'expired' };
  return { allowed: true, refresh: stale, reason: 'paid' };
}

/** Web Store builds carry `update_url`; unpacked loads (and Node, with no manifest) do not. */
export function isUnpackedManifest(manifest) {
  return !manifest || typeof manifest !== 'object' || !manifest.update_url;
}

/** A provider record / settings providerId the user configured themselves (legacy flat keys have none). */
export function isByokProviderId(id) {
  return !isCloudProviderId(id);
}

/** A web slot base URL that is ours (credits), not the user's own Tavily / Firecrawl account. */
export function isCloudWebBase(baseURL) {
  try {
    return !!cloudOriginOf(new URL(String(baseURL || '')).origin);
  } catch {
    return false;
  }
}

export function byokPlanError(purpose = '') {
  return Object.assign(new Error(BYOK_PLAN_MESSAGE), { code: BYOK_REQUIRES_PLAN, purpose: String(purpose || '') });
}

/** The failed-tool shape the web / image / stt / System1 paths return to the model. */
export function byokPlanFailure(purpose = '', extra = {}) {
  return { ok: false, code: BYOK_REQUIRES_PLAN, error: BYOK_PLAN_MESSAGE, purpose: String(purpose || ''), ...extra };
}

/**
 * Web settings for a turn: BYOK slots are blanked when not allowed; `byokBlocked` lists
 * which, so search / map / crawl can say why instead of "not configured". The saved
 * settings are never changed. Pure.
 */
export function webAcquireForPlan(settings, allowed) {
  const s = settings && typeof settings === 'object' ? { ...settings } : {};
  if (allowed) return s;
  const blocked = [];
  if (s.tavilyKey && !isCloudWebBase(s.tavilyBaseURL)) {
    s.tavilyKey = '';
    blocked.push('tavily');
  }
  if (s.firecrawlKey && !isCloudWebBase(s.firecrawlBaseURL)) {
    s.firecrawlKey = '';
    blocked.push('firecrawl');
  }
  if (s.braveKey) {
    s.braveKey = '';
    blocked.push('brave');
  }
  if (blocked.length) s.byokBlocked = blocked;
  return s;
}

export function webAcquireHasByok(settings) {
  const s = settings || {};
  return !!(
    (s.tavilyKey && !isCloudWebBase(s.tavilyBaseURL)) ||
    (s.firecrawlKey && !isCloudWebBase(s.firecrawlBaseURL)) ||
    s.braveKey
  );
}

// ---------- chrome-facing ----------

async function localGet(keys) {
  const c = globalThis.chrome;
  if (c?.storage?.local?.get) return (await c.storage.local.get(keys)) || {};
  if (c?.runtime?.sendMessage) {
    const res = await c.runtime.sendMessage({ target: 'browserbot-background', action: 'storage_local_get', keys });
    if (!res?.ok) throw new Error(res?.error || 'storage_local_get failed');
    return res.result || {};
  }
  return {};
}

async function localSet(values) {
  const c = globalThis.chrome;
  if (c?.storage?.local?.set) return c.storage.local.set(values);
  if (c?.runtime?.sendMessage) {
    const res = await c.runtime.sendMessage({ target: 'browserbot-background', action: 'storage_local_set', values });
    if (!res?.ok) throw new Error(res?.error || 'storage_local_set failed');
  }
}

function currentManifest() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.() || null;
  } catch {
    return null;
  }
}

/** Best-effort: a storage failure must not fail sign-in or Settings. */
export async function writeByokEntitlement(me, now = Date.now()) {
  try {
    await localSet({ [BYOK_ENTITLEMENT_KEY]: entitlementFromMe(me, now) });
  } catch {
    /* next gated call refreshes */
  }
}

export async function clearByokEntitlement() {
  try {
    await localSet({ [BYOK_ENTITLEMENT_KEY]: null });
  } catch {
    /* ignore */
  }
}

let refreshing = null;
let lastRefreshAt = 0;

/** Tests only. */
export function resetByokGateState() {
  refreshing = null;
  lastRefreshAt = 0;
}

async function refreshEntitlement(token, { fetchImpl, now, origin = CLOUD_ORIGIN }) {
  const client = bkClientHeaderValue();
  const res = await fetchImpl(`${origin}/api/me`, {
    headers: { ...(client ? { [BK_CLIENT_HEADER]: client } : {}), authorization: `Bearer ${token}` }
  });
  if (res.status === 401) {
    await clearByokEntitlement();
    return null;
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const me = await res.json();
  const ent = entitlementFromMe(me, now);
  await localSet({ [BYOK_ENTITLEMENT_KEY]: ent }).catch(() => {});
  return ent;
}

/**
 * Current verdict, refreshing /api/me when the cache says so.
 * @param {{ now?: number, fetchImpl?: typeof fetch, refresh?: boolean }} [opts]
 * @returns {Promise<{ allowed: boolean, reason: string, plan: string, signedIn: boolean }>}
 */
export async function byokStatus({ now = Date.now(), fetchImpl = globalThis.fetch, refresh = true } = {}) {
  const manifest = currentManifest();
  let bag = {};
  try {
    bag = await localGet([BYOK_ENTITLEMENT_KEY, BYOK_ACCOUNT_KEY, BYOK_ENFORCE_UNPACKED_KEY]);
  } catch {
    bag = {};
  }
  const unpacked = isUnpackedManifest(manifest) && bag[BYOK_ENFORCE_UNPACKED_KEY] !== true;
  const token = typeof bag[BYOK_ACCOUNT_KEY]?.token === 'string' ? bag[BYOK_ACCOUNT_KEY].token : '';
  if (unpacked) return { allowed: true, reason: 'unpacked', plan: String(bag[BYOK_ENTITLEMENT_KEY]?.plan || ''), signedIn: !!token };
  // Signed out means no entitlement, whatever the cache still says.
  if (!token) return { allowed: false, reason: 'signed-out', plan: '', signedIn: false };
  let ent = bag[BYOK_ENTITLEMENT_KEY] || null;
  let verdict = byokAllowed(ent, { now });
  if (verdict.refresh && refresh && typeof fetchImpl === 'function') {
    // Stale or missing cache: always ask. A fresh "free" answer: at most every 30 s,
    // so an upgrade is picked up quickly without a request per tool call.
    const stale = verdict.allowed || !ent || !(now - Number(ent.checkedAt) <= BYOK_REFRESH_AFTER_MS);
    if (refreshing || stale || now - lastRefreshAt >= DENIED_REFRESH_MIN_MS) {
      if (!refreshing) {
        lastRefreshAt = now;
        const origin = cloudOriginOf(bag[BYOK_ACCOUNT_KEY]?.origin) || CLOUD_ORIGIN;
        refreshing = refreshEntitlement(token, { fetchImpl, now, origin }).finally(() => {
          refreshing = null;
        });
      }
      try {
        ent = await refreshing;
        verdict = byokAllowed(ent, { now });
      } catch {
        /* offline / server error: the cached entitlement and its 72 h grace decide */
      }
    }
  }
  return { allowed: verdict.allowed, reason: ent ? verdict.reason : 'signed-out', plan: String(ent?.plan || ''), signedIn: !!ent };
}

/** Throws BYOK_REQUIRES_PLAN unless BYOK is allowed now. */
export async function assertByokAllowed(purpose, opts) {
  const status = await byokStatus(opts);
  if (!status.allowed) throw byokPlanError(purpose);
  return status;
}

/** Cloud records pass; anything the user configured goes through the gate. */
export async function assertByokForProvider(purpose, providerId, opts) {
  if (!isByokProviderId(providerId)) return null;
  return assertByokAllowed(purpose, opts);
}

/** Boolean form for background probes: skip silently when not allowed. */
export async function byokAllowedForProvider(purpose, providerId, opts) {
  if (!isByokProviderId(providerId)) return true;
  try {
    return (await byokStatus(opts)).allowed;
  } catch {
    return false;
  }
}

/** Web settings for a turn (see webAcquireForPlan). Reads nothing when no BYOK slot is set. */
export async function gateWebAcquire(settings, opts) {
  if (!webAcquireHasByok(settings)) return settings;
  let allowed = false;
  try {
    allowed = (await byokStatus(opts)).allowed;
  } catch {
    allowed = false;
  }
  return webAcquireForPlan(settings, allowed);
}
