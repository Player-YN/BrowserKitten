/**
 * Browser Kitten credit records: fixed ids, and the route each one always sends.
 * Credit users never pick a model; the server maps each route to a real model
 * (site server/modelRoutes.js). Leaf module so llm.js can pin records without
 * importing cloudAccount.js (which imports llm.js).
 */
export const CLOUD_ORIGIN = 'https://browserkitten.com';

/**
 * Staging backend for testing a release before production. Only an unpacked
 * (development) build can be pointed at it, by setting chrome.storage.local
 * `browserbot_cloud_origin` to this exact URL before signing in; a Web Store build
 * (manifest has update_url) always uses CLOUD_ORIGIN. Both count as "our" API, so
 * the x-bk-* headers and the credit records work against either.
 */
export const STAGING_ORIGIN = 'https://staging.browserkitten.com';
export const CLOUD_ORIGINS = [CLOUD_ORIGIN, STAGING_ORIGIN];
export const CLOUD_ORIGIN_OVERRIDE_KEY = 'browserbot_cloud_origin';

export const isCloudOrigin = (origin) => CLOUD_ORIGINS.includes(String(origin || ''));

/** The origin of a URL when it is one of ours, else ''. */
export function cloudOriginOf(url) {
  try {
    const origin = new URL(String(url || '')).origin;
    return isCloudOrigin(origin) ? origin : '';
  } catch {
    return '';
  }
}

/**
 * Backend for a new sign-in. Store builds: always production. Unpacked builds:
 * staging only when explicitly opted in; anything else falls back to production.
 */
export async function resolveCloudOrigin({
  storage = globalThis.chrome?.storage?.local,
  manifest = globalThis.chrome?.runtime?.getManifest?.()
} = {}) {
  if (manifest?.update_url) return CLOUD_ORIGIN;
  try {
    const value = (await storage?.get?.(CLOUD_ORIGIN_OVERRIDE_KEY))?.[CLOUD_ORIGIN_OVERRIDE_KEY];
    return value === STAGING_ORIGIN ? STAGING_ORIGIN : CLOUD_ORIGIN;
  } catch {
    return CLOUD_ORIGIN;
  }
}

/**
 * Marks cheap background calls (compaction, titles) so the server can route them to a
 * lighter model. Only ever sent to the Browser Kitten API; stripped for any other host.
 */
export const BK_PURPOSE_HEADER = 'x-bk-purpose';
export function isCloudApiUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return isCloudOrigin(u.origin) && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export const CLOUD_IDS = {
  chat: 'bk_cloud_chat',
  image: 'bk_cloud_image',
  stt: 'bk_cloud_stt',
  jev: 'bk_cloud_jev'
};

export const CLOUD_MODELS = {
  chat: 'bk-auto',
  image: 'bk-image',
  stt: 'bk-stt',
  jev: 'bk-system1'
};

export const isCloudProviderId = (id) => typeof id === 'string' && id.startsWith('bk_cloud_');
export const isCloudProvider = (p) => isCloudProviderId(p?.id);

/** The route a credit record must send, or null for the user's own provider. */
export function pinnedCloudModel(id) {
  for (const [purpose, cloudId] of Object.entries(CLOUD_IDS)) if (cloudId === id) return CLOUD_MODELS[purpose];
  return null;
}

/**
 * Names this build on every Browser Kitten API request so the server can ask old
 * clients to update (HTTP 426 CLIENT_UPGRADE_REQUIRED). Only sent to our own API.
 * '' outside an extension (no manifest): callers then send no header at all.
 */
export const BK_CLIENT_HEADER = 'x-bk-client';
export function bkClientHeaderValue() {
  try {
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    return version ? `browser-kitten/${version}` : '';
  } catch {
    return '';
  }
}
