/**
 * Browser Kitten account: credits instead of the user's own keys.
 *
 * Sign-in writes provider records with fixed ids (chat always; image / stt / System1
 * only when /api/me says the server hosts them) that point at the Browser Kitten API
 * with the device token as apiKey, and fills
 * the Tavily / Firecrawl slots only when they are empty. Every model, image, STT,
 * System1, search and fetch call then works unchanged. Nothing the user configured
 * is overwritten, and an active BYOK provider stays active.
 *
 * Sign-out removes exactly what sign-in added. The server decides plan and credits
 * on every request; nothing stored here grants anything (see site server/router.js).
 *
 *   chrome.storage.local  browserbot_cloud_account = { token, deviceId, filled: { tavily, firecrawl }, connectedAt }
 *   chrome.storage.local  browserbot_cloud_entitlement = { plan, checkedAt }  (byokGate.js: own keys need a paid plan)
 */
import { BK_CLIENT_HEADER, CLOUD_IDS, CLOUD_MODELS, CLOUD_ORIGIN, bkClientHeaderValue, isCloudProvider } from './cloudModels.js';
import { defaultImageConfig, loadProvidersState, saveProvidersState } from './llm.js';
import { loadWebAcquireSettings, saveWebAcquireSettings } from './webAcquireSettings.js';
import { BYOK_REQUIRES_PLAN, clearByokEntitlement, writeByokEntitlement } from './byokGate.js';

export const CLOUD_API_BASE = `${CLOUD_ORIGIN}/api/v1`;
export const CLOUD_TAVILY_BASE = `${CLOUD_ORIGIN}/api/tavily`;
export const CLOUD_FIRECRAWL_BASE = `${CLOUD_ORIGIN}/api/firecrawl`;
export const CLOUD_ACCOUNT_URL = `${CLOUD_ORIGIN}/account.html`;
export const CLOUD_ACCOUNT_KEY = 'browserbot_cloud_account';
export const CLOUD_NAME = 'Browser Kitten';

export { CLOUD_IDS, CLOUD_MODELS, CLOUD_ORIGIN, isCloudProvider };

/**
 * Each record always sends its route (bk-auto, …); the server picks the real model.
 * @returns {Record<'chat'|'image'|'stt'|'jev', object>}
 */
export function cloudProviderRecords(token) {
  const createdAt = Date.now();
  return {
    chat: { id: CLOUD_IDS.chat, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: CLOUD_MODELS.chat, purpose: 'chat', protocol: 'openai-compatible', createdAt },
    image: {
      id: CLOUD_IDS.image,
      name: CLOUD_NAME,
      baseURL: '',
      apiKey: '',
      model: '',
      purpose: 'image',
      createdAt,
      image: defaultImageConfig({ enabled: true, protocol: 'openai-image', path: '/images/generations', baseURL: CLOUD_API_BASE, apiKey: token, model: CLOUD_MODELS.image })
    },
    stt: { id: CLOUD_IDS.stt, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: CLOUD_MODELS.stt, purpose: 'stt', createdAt },
    jev: { id: CLOUD_IDS.jev, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: CLOUD_MODELS.jev, purpose: 'jev', createdAt }
  };
}

const usable = (p) => !!p && (!!String(p.apiKey || '').trim() || !!String(p.image?.apiKey || '').trim());

/**
 * Which extra services the server hosts, from /api/me `hosted`. Chat is always written
 * (it is the point of signing in). An absent or malformed `hosted` means an older
 * server that hosts everything, as before.
 * @param {{ image?: boolean, stt?: boolean, systemone?: boolean } | null | undefined} hosted
 */
export function cloudHostedPurposes(hosted) {
  const all = !hosted || typeof hosted !== 'object';
  return { chat: true, image: all || hosted.image === true, stt: all || hosted.stt === true, jev: all || hosted.systemone === true };
}

/**
 * What sign-in writes. Cloud becomes active for a purpose only when nothing usable is active,
 * and image / STT / System1 records only exist when the server hosts them.
 * @param {Awaited<ReturnType<typeof loadProvidersState>>} state
 * @param {ReturnType<typeof import('./webAcquireSettings.js').normalizeWebAcquireSettings>} web
 * @param {string} token
 * @param {{ chat?: boolean, light?: boolean, systemone?: boolean, image?: boolean, stt?: boolean } | null} [hosted] /api/me `hosted`
 */
export function planCloudSignIn(state, web, token, hosted = null) {
  const records = cloudProviderRecords(token);
  const on = cloudHostedPurposes(hosted);
  const added = ['chat', 'image', 'stt', 'jev'].filter((k) => on[k]).map((k) => records[k]);
  const providers = [...(state.providers || []).filter((p) => !isCloudProvider(p)), ...added];
  // A purpose the server does not host keeps the user's choice, minus any stale cloud id.
  const pick = (activeId, active, cloudId, purpose) => {
    if (usable(active) && !isCloudProvider(active)) return activeId;
    if (on[purpose]) return cloudId;
    return activeId && !String(activeId).startsWith('bk_cloud_') ? activeId : null;
  };
  const webPatch = {};
  const filled = { tavily: false, firecrawl: false };
  if (!web.tavilyKey || web.tavilyBaseURL === CLOUD_TAVILY_BASE) {
    Object.assign(webPatch, { tavilyKey: token, tavilyBaseURL: CLOUD_TAVILY_BASE, tavilyNickname: CLOUD_NAME });
    if (!web.braveKey) webPatch.searchProvider = 'tavily';
    filled.tavily = true;
  }
  if (!web.firecrawlKey || web.firecrawlBaseURL === CLOUD_FIRECRAWL_BASE) {
    Object.assign(webPatch, { firecrawlKey: token, firecrawlBaseURL: CLOUD_FIRECRAWL_BASE, firecrawlNickname: CLOUD_NAME });
    filled.firecrawl = true;
  }
  return {
    providers,
    activeProviderId: pick(state.activeProviderId, state.active, CLOUD_IDS.chat, 'chat'),
    activeImageProviderId: pick(state.activeImageProviderId, state.activeImage, CLOUD_IDS.image, 'image'),
    activeSttProviderId: pick(state.activeSttProviderId, state.activeStt, CLOUD_IDS.stt, 'stt'),
    activeJevProviderId: pick(state.activeJevProviderId, state.activeJev, CLOUD_IDS.jev, 'jev'),
    webPatch,
    filled
  };
}

/** What sign-out undoes: the cloud records, and web slots only while they still point at us. */
export function planCloudSignOut(state, web) {
  const providers = (state.providers || []).filter((p) => !isCloudProvider(p));
  const keep = (id) => (id && !String(id).startsWith('bk_cloud_') ? id : null);
  const webPatch = {};
  if (web.tavilyBaseURL === CLOUD_TAVILY_BASE) Object.assign(webPatch, { tavilyKey: '', tavilyBaseURL: '', tavilyNickname: '' });
  if (web.firecrawlBaseURL === CLOUD_FIRECRAWL_BASE) Object.assign(webPatch, { firecrawlKey: '', firecrawlBaseURL: '', firecrawlNickname: '' });
  return {
    providers,
    activeProviderId: keep(state.activeProviderId),
    activeImageProviderId: keep(state.activeImageProviderId),
    activeSttProviderId: keep(state.activeSttProviderId),
    activeJevProviderId: keep(state.activeJevProviderId),
    webPatch
  };
}

/** The server's 402 body (see site server/proxy/metered.js), however the caller surfaced it. */
export function isCloudCreditsError(error) {
  const status = Number(error?.statusCode ?? error?.status) || 0;
  const text = `${error?.code || ''} ${error?.message || ''} ${typeof error?.responseBody === 'string' ? error.responseBody : ''}`;
  return /CREDITS_EXHAUSTED|Out of Browser Kitten credits/i.test(text) || (status === 402 && /browser ?kitten/i.test(text));
}

function cloudErrorParts(error) {
  const status = Number(error?.statusCode ?? error?.status) || 0;
  const body = typeof error?.responseBody === 'string' ? error.responseBody : '';
  const text = `${error?.code || ''} ${error?.message || ''} ${body}`;
  return { status, text, body };
}

/** The proxy's 426: this build is older than the server's minVersion. */
export function isCloudUpgradeError(error) {
  const { status, text } = cloudErrorParts(error);
  return /CLIENT_UPGRADE_REQUIRED/i.test(text) || (status === 426 && /browser ?kitten/i.test(text));
}

/** The proxy's 503: the operator paused credits (all or one category). Another vendor's 503 is not ours. */
export function isCloudPausedError(error) {
  const { status, text } = cloudErrorParts(error);
  // status 0: the SDK retries 503s and its RetryError carries only the last message.
  return /SERVICE_PAUSED/i.test(text) || ((status === 503 || status === 0) && /browser ?kitten/i.test(text) && /\bpaused?\b/i.test(text));
}

/**
 * The server's own words for a pause, or '' when there is nothing better than a
 * code / status to show (the caller then uses its localized default).
 */
export function cloudPausedMessage(error) {
  const { body } = cloudErrorParts(error);
  if (body) {
    try {
      const m = JSON.parse(body)?.error?.message;
      if (typeof m === 'string' && m.trim()) return m.trim();
    } catch {
      /* not JSON */
    }
  }
  const msg = String(error?.message || '')
    .replace(/^Failed after \d+ attempts?\.\s*Last error:\s*/i, '')
    .replace(/\bSERVICE_PAUSED\b:?\s*/g, '')
    .trim();
  if (!msg || /^HTTP \d+$/i.test(msg) || /^(Service Unavailable|unknown( error)?)$/i.test(msg)) return '';
  return msg;
}

/** A BYOK call refused because the account has no paid plan (byokGate.js), however it surfaced. */
export function isByokPlanError(error) {
  if (!error || typeof error !== 'object') return false;
  const text = `${error.code || ''} ${error.message || ''} ${error.error || ''}`;
  return new RegExp(`${BYOK_REQUIRES_PLAN}|needs a Browser Kitten plan`, 'i').test(text);
}

/**
 * Which account notice an error calls for, if any. Credits first (unchanged behavior),
 * then own keys without a plan.
 * @returns {{ kind: 'credits' } | { kind: 'byok' } | { kind: 'upgrade' } | { kind: 'paused', message: string } | null}
 */
export function cloudNoticeFor(error) {
  if (isCloudCreditsError(error)) return { kind: 'credits' };
  if (isByokPlanError(error)) return { kind: 'byok' };
  if (isCloudUpgradeError(error)) return { kind: 'upgrade' };
  if (isCloudPausedError(error)) return { kind: 'paused', message: cloudPausedMessage(error) };
  return null;
}

/**
 * Usage windows from /api/me, in the server's order. Keys may change (the 5-hour
 * window may go away); whatever is present is shown.
 * @returns {Array<{ key: string, used: number, limit: number|null }>}
 */
export function cloudUsageRows(usage, limits) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const l = limits && typeof limits === 'object' ? limits : {};
  const keys = [...new Set([...Object.keys(u), ...Object.keys(l)])];
  return keys.map((key) => {
    const raw = l[key];
    const limit = raw == null || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
    return { key, used: Number(u[key]) || 0, limit };
  });
}

// ---------- chrome-facing ----------

async function readAccount() {
  const bag = await chrome.storage.local.get(CLOUD_ACCOUNT_KEY);
  const acct = bag?.[CLOUD_ACCOUNT_KEY];
  return acct && typeof acct.token === 'string' && acct.token ? acct : null;
}

export async function getCloudAccount() {
  try {
    return await readAccount();
  } catch {
    return null;
  }
}

async function cloudJson(path, { token, method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CLOUD_ORIGIN}${path}`, {
    method,
    headers: {
      ...(bkClientHeaderValue() ? { [BK_CLIENT_HEADER]: bkClientHeaderValue() } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), {
      status: res.status,
      code: json?.error?.code,
      responseBody: JSON.stringify(json || {})
    });
  }
  return json;
}

function deviceLabel() {
  const ua = String(globalThis.navigator?.userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Opens browserkitten.com in the identity window; the user signs in and approves
 * this browser; the page returns a one-time code, exchanged here for a device token.
 */
export async function signInWithBrowserKitten({ fetchImpl = fetch } = {}) {
  if (!chrome?.identity?.launchWebAuthFlow) throw new Error('chrome.identity is unavailable. Reload the extension.');
  const state = crypto.randomUUID();
  const redirectUri = chrome.identity.getRedirectURL('bk');
  const url = `${CLOUD_ORIGIN}/connect.html?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const back = new URL(String(responseUrl || ''));
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted. Try again.');
  const code = back.searchParams.get('code');
  if (!code) throw new Error('Sign-in did not return a code.');
  const { token, deviceId } = await cloudJson('/api/device/exchange', { method: 'POST', body: { code, label: deviceLabel() }, fetchImpl });
  // Which services the server hosts; absent (older server) or unreadable → all, as before.
  let services = null;
  try {
    const me = await cloudJson('/api/me', { token, fetchImpl });
    services = me?.hosted ?? null;
    await writeByokEntitlement(me);
  } catch {
    /* keep null: write every record rather than fail the sign-in */
  }
  // Only to tell the user whether chat on credits works yet; the record always sends bk-auto.
  let chatWorks = false;
  try {
    chatWorks = (await cloudJson('/api/v1/models', { token, fetchImpl }))?.data?.length > 0;
  } catch {
    /* unknown: say so like "not offered yet" rather than fail the sign-in */
  }
  const plan = planCloudSignIn(await loadProvidersState(), await loadWebAcquireSettings(), token, services);
  await saveProvidersState(plan.providers, plan.activeProviderId, plan.activeImageProviderId, plan.activeSttProviderId, plan.activeJevProviderId);
  if (Object.keys(plan.webPatch).length) await saveWebAcquireSettings(plan.webPatch);
  await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: { token, deviceId, filled: plan.filled, connectedAt: Date.now() } });
  return { deviceId, hosted: chatWorks };
}

export async function signOutOfBrowserKitten({ fetchImpl = fetch } = {}) {
  const acct = await getCloudAccount();
  if (acct?.token) await cloudJson('/api/device/revoke', { token: acct.token, method: 'POST', body: {}, fetchImpl }).catch(() => {});
  const plan = planCloudSignOut(await loadProvidersState(), await loadWebAcquireSettings());
  await saveProvidersState(plan.providers, plan.activeProviderId, plan.activeImageProviderId, plan.activeSttProviderId, plan.activeJevProviderId);
  if (Object.keys(plan.webPatch).length) await saveWebAcquireSettings(plan.webPatch);
  await chrome.storage.local.remove(CLOUD_ACCOUNT_KEY);
  await clearByokEntitlement();
}

/**
 * Plan and credits from the server. A 401 means the device was signed out
 * elsewhere (account page); the caller should offer sign-in again.
 * @returns {Promise<{ signedIn: false } | { signedIn: true, plan: string, planLabel: string, credits: number, periodEnd: string|null, usage: Record<string, number>, limits: Record<string, number|null>, expired?: boolean }>}
 */
export async function fetchCloudAccount({ fetchImpl = fetch } = {}) {
  const acct = await getCloudAccount();
  if (!acct) return { signedIn: false };
  try {
    const me = await cloudJson('/api/me', { token: acct.token, fetchImpl });
    await writeByokEntitlement(me);
    return {
      signedIn: true,
      plan: me.plan,
      planLabel: me.planLabel,
      credits: Number(me.credits) || 0,
      periodEnd: me.periodEnd || null,
      usage: me.usage && typeof me.usage === 'object' ? me.usage : {},
      limits: me.limits && typeof me.limits === 'object' ? me.limits : {}
    };
  } catch (error) {
    if (error.status === 401) {
      await clearByokEntitlement();
      return { signedIn: true, expired: true, plan: 'free', planLabel: '', credits: 0, periodEnd: null, usage: {}, limits: {} };
    }
    throw error;
  }
}
