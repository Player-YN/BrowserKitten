/**
 * Browser Kitten credit records: fixed ids, and the route each one always sends.
 * Credit users never pick a model; the server maps each route to a real model
 * (site server/modelRoutes.js). Leaf module so llm.js can pin records without
 * importing cloudAccount.js (which imports llm.js).
 */
export const CLOUD_ORIGIN = 'https://browserkitten.com';

/**
 * Marks cheap background calls (compaction, titles) so the server can route them to a
 * lighter model. Only ever sent to the Browser Kitten API; stripped for any other host.
 */
export const BK_PURPOSE_HEADER = 'x-bk-purpose';
export const isCloudApiUrl = (url) => String(url || '').startsWith(`${CLOUD_ORIGIN}/api/`);

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
