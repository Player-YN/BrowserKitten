/**
 * Browser Kitten account: credits instead of the user's own keys.
 *
 * Sign-in writes four provider records with fixed ids (chat / image / stt / System1)
 * that point at the Browser Kitten API with the device token as apiKey, and fills
 * the Tavily / Firecrawl slots only when they are empty. Every model, image, STT,
 * System1, search and fetch call then works unchanged. Nothing the user configured
 * is overwritten, and an active BYOK provider stays active.
 *
 * Sign-out removes exactly what sign-in added. The server decides plan and credits
 * on every request; nothing stored here grants anything (see site server/router.js).
 *
 *   chrome.storage.local  browserbot_cloud_account = { token, deviceId, filled: { tavily, firecrawl }, connectedAt }
 */
import { defaultImageConfig, loadProvidersState, saveProvidersState } from './llm.js';
import { loadWebAcquireSettings, saveWebAcquireSettings } from './webAcquireSettings.js';

export const CLOUD_ORIGIN = 'https://browserkitten.com';
export const CLOUD_API_BASE = `${CLOUD_ORIGIN}/api/v1`;
export const CLOUD_TAVILY_BASE = `${CLOUD_ORIGIN}/api/tavily`;
export const CLOUD_FIRECRAWL_BASE = `${CLOUD_ORIGIN}/api/firecrawl`;
export const CLOUD_ACCOUNT_URL = `${CLOUD_ORIGIN}/account.html`;
export const CLOUD_ACCOUNT_KEY = 'browserbot_cloud_account';
export const CLOUD_NAME = 'Browser Kitten';

export const CLOUD_IDS = {
  chat: 'bk_cloud_chat',
  image: 'bk_cloud_image',
  stt: 'bk_cloud_stt',
  jev: 'bk_cloud_jev'
};

export const isCloudProvider = (p) => typeof p?.id === 'string' && p.id.startsWith('bk_cloud_');

/** @returns {Record<'chat'|'image'|'stt'|'jev', object>} */
export function cloudProviderRecords(token, { chatModel = '' } = {}) {
  const createdAt = Date.now();
  return {
    chat: { id: CLOUD_IDS.chat, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: chatModel, purpose: 'chat', protocol: 'openai-compatible', createdAt },
    image: {
      id: CLOUD_IDS.image,
      name: CLOUD_NAME,
      baseURL: '',
      apiKey: '',
      model: '',
      purpose: 'image',
      createdAt,
      image: defaultImageConfig({ enabled: true, protocol: 'openai-image', path: '/images/generations', baseURL: CLOUD_API_BASE, apiKey: token, model: 'bk-image' })
    },
    stt: { id: CLOUD_IDS.stt, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: 'bk-stt', purpose: 'stt', createdAt },
    jev: { id: CLOUD_IDS.jev, name: CLOUD_NAME, baseURL: CLOUD_API_BASE, apiKey: token, model: 'bk-system1', purpose: 'jev', createdAt }
  };
}

const usable = (p) => !!p && (!!String(p.apiKey || '').trim() || !!String(p.image?.apiKey || '').trim());

/**
 * What sign-in writes. Cloud becomes active for a purpose only when nothing usable is active.
 * @param {Awaited<ReturnType<typeof loadProvidersState>>} state
 * @param {ReturnType<typeof import('./webAcquireSettings.js').normalizeWebAcquireSettings>} web
 */
export function planCloudSignIn(state, web, token, { chatModel = '' } = {}) {
  const records = cloudProviderRecords(token, { chatModel });
  const providers = [...(state.providers || []).filter((p) => !isCloudProvider(p)), records.chat, records.image, records.stt, records.jev];
  const pick = (activeId, active, cloudId) => (usable(active) && !isCloudProvider(active) ? activeId : cloudId);
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
    activeProviderId: pick(state.activeProviderId, state.active, CLOUD_IDS.chat),
    activeImageProviderId: pick(state.activeImageProviderId, state.activeImage, CLOUD_IDS.image),
    activeSttProviderId: pick(state.activeSttProviderId, state.activeStt, CLOUD_IDS.stt),
    activeJevProviderId: pick(state.activeJevProviderId, state.activeJev, CLOUD_IDS.jev),
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
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { status: res.status, code: json?.error?.code });
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

  let chatModel = '';
  try {
    const models = await cloudJson('/api/v1/models', { token, fetchImpl });
    chatModel = models?.data?.[0]?.id || '';
  } catch {
    /* no hosted models yet: the chat record stays without a model until one is offered */
  }
  const plan = planCloudSignIn(await loadProvidersState(), await loadWebAcquireSettings(), token, { chatModel });
  await saveProvidersState(plan.providers, plan.activeProviderId, plan.activeImageProviderId, plan.activeSttProviderId, plan.activeJevProviderId);
  if (Object.keys(plan.webPatch).length) await saveWebAcquireSettings(plan.webPatch);
  await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: { token, deviceId, filled: plan.filled, connectedAt: Date.now() } });
  return { deviceId, chatModel };
}

export async function signOutOfBrowserKitten({ fetchImpl = fetch } = {}) {
  const acct = await getCloudAccount();
  if (acct?.token) await cloudJson('/api/device/revoke', { token: acct.token, method: 'POST', body: {}, fetchImpl }).catch(() => {});
  const plan = planCloudSignOut(await loadProvidersState(), await loadWebAcquireSettings());
  await saveProvidersState(plan.providers, plan.activeProviderId, plan.activeImageProviderId, plan.activeSttProviderId, plan.activeJevProviderId);
  if (Object.keys(plan.webPatch).length) await saveWebAcquireSettings(plan.webPatch);
  await chrome.storage.local.remove(CLOUD_ACCOUNT_KEY);
}

/**
 * Plan and credits from the server. A 401 means the device was signed out
 * elsewhere (account page); the caller should offer sign-in again.
 * @returns {Promise<{ signedIn: false } | { signedIn: true, plan: string, planLabel: string, credits: number, periodEnd: string|null, expired?: boolean }>}
 */
export async function fetchCloudAccount({ fetchImpl = fetch } = {}) {
  const acct = await getCloudAccount();
  if (!acct) return { signedIn: false };
  try {
    const me = await cloudJson('/api/me', { token: acct.token, fetchImpl });
    return { signedIn: true, plan: me.plan, planLabel: me.planLabel, credits: Number(me.credits) || 0, periodEnd: me.periodEnd || null };
  } catch (error) {
    if (error.status === 401) return { signedIn: true, expired: true, plan: 'free', planLabel: '', credits: 0, periodEnd: null };
    throw error;
  }
}
