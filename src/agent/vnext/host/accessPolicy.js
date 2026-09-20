/**
 * Guarded / Full Access. Host-enforced, not a prompt preference.
 * Profile: chrome.storage.local browserbot_access_policy
 * Session override: chrome.storage.session browserbot_access_policy_session
 * Precedence: session > profile > guarded
 */

import {
  ACCESS_POLICY_SCHEMA,
  ACCESS_POLICY_SESSION_SCHEMA,
  STORAGE_ACCESS_POLICY,
  STORAGE_ACCESS_POLICY_SESSION
} from '../../../brand.js';
import { deriveRawEscape } from './riskClassify.js';

export const ACCESS_POLICY_PROFILE_KEY = STORAGE_ACCESS_POLICY;
export const ACCESS_POLICY_SESSION_KEY = STORAGE_ACCESS_POLICY_SESSION;
export { ACCESS_POLICY_SCHEMA, ACCESS_POLICY_SESSION_SCHEMA };

/** @type {{ local?: any, session?: any } | null} */
let installed = null;
const listeners = new Set();

export function installAccessPolicyStorage(areas) {
  installed = areas && typeof areas === 'object' ? areas : null;
}

export function accessPolicyStorageInstalled() {
  return !!installed;
}

export function resetAccessPolicyStorage() {
  installed = null;
}

function chromeAreas() {
  if (installed) return installed;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return { local: chrome.storage.local, session: chrome.storage.session };
    }
  } catch {
    /* ignore */
  }
  return { local: null, session: null };
}

async function areaGet(area, key) {
  if (!area || typeof area.get !== 'function') return undefined;
  const bag = await area.get(key);
  if (bag == null) return undefined;
  if (typeof bag === 'object' && key in bag) return bag[key];
  return bag;
}

async function areaSet(area, key, value) {
  if (!area || typeof area.set !== 'function') {
    const err = new Error('access policy storage unavailable');
    err.code = 'POLICY_STORAGE_UNAVAILABLE';
    throw err;
  }
  await area.set({ [key]: value });
}

async function areaRemove(area, key) {
  if (!area) return;
  if (typeof area.remove === 'function') {
    await area.remove(key);
    return;
  }
  if (typeof area.set === 'function') await area.set({ [key]: undefined });
}

function normalizeMode(value) {
  return value === 'full' ? 'full' : value === 'guarded' ? 'guarded' : '';
}

function defaultPolicy() {
  return {
    mode: 'guarded',
    source: 'default',
    profileMode: 'guarded',
    sessionOverride: null,
    rawEscapeDefault: 'deny'
  };
}

export function snapshotAccessPolicy(effective, now = Date.now()) {
  return { ...effective, frozenAt: now };
}

export async function readEffectiveAccessPolicy() {
  const areas = chromeAreas();
  try {
    const sessionRaw = await areaGet(areas.session, ACCESS_POLICY_SESSION_KEY);
    const profileRaw = await areaGet(areas.local, ACCESS_POLICY_PROFILE_KEY);
    const profileMode = normalizeMode(profileRaw?.mode) || 'guarded';
    const sessionMode = normalizeMode(sessionRaw?.mode);
    const mode = sessionMode || profileMode || 'guarded';
    const source = sessionMode ? 'session' : profileRaw && normalizeMode(profileRaw.mode) ? 'profile' : 'default';
    return {
      mode,
      source,
      profileMode,
      sessionOverride: sessionMode || null,
      rawEscapeDefault: deriveRawEscape(mode, 'raw-escape') === 'allow' ? 'allow' : 'deny'
    };
  } catch {
    return defaultPolicy();
  }
}

/**
 * @param {{ mode: 'guarded'|'full', rememberProfile?: boolean }} input
 */
export async function writeAccessPolicy(input = {}) {
  const mode = normalizeMode(input.mode);
  if (!mode) {
    const err = new Error('access mode must be guarded or full');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const areas = chromeAreas();
  const now = Date.now();
  if (mode === 'guarded') {
    await areaSet(areas.local, ACCESS_POLICY_PROFILE_KEY, {
      schema: ACCESS_POLICY_SCHEMA,
      mode: 'guarded',
      updatedAt: now,
      updatedBy: 'ui'
    });
    await areaRemove(areas.session, ACCESS_POLICY_SESSION_KEY);
    return readEffectiveAccessPolicy();
  }
  if (input.rememberProfile === true) {
    await areaSet(areas.local, ACCESS_POLICY_PROFILE_KEY, {
      schema: ACCESS_POLICY_SCHEMA,
      mode: 'full',
      updatedAt: now,
      updatedBy: 'ui'
    });
    await areaRemove(areas.session, ACCESS_POLICY_SESSION_KEY);
    return readEffectiveAccessPolicy();
  }
  await areaSet(areas.session, ACCESS_POLICY_SESSION_KEY, {
    schema: ACCESS_POLICY_SESSION_SCHEMA,
    mode: 'full',
    setAt: now,
    rememberProfileDeclined: true
  });
  return readEffectiveAccessPolicy();
}

export function notifyAccessPolicyChanged(policy) {
  for (const fn of listeners) {
    try {
      fn(policy);
    } catch {
      /* ignore */
    }
  }
}

export function onAccessPolicyChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function createMemoryAccessPolicyStorage(seed = {}) {
  const local = new Map();
  const session = new Map();
  if (seed.profile) local.set(ACCESS_POLICY_PROFILE_KEY, seed.profile);
  if (seed.session) session.set(ACCESS_POLICY_SESSION_KEY, seed.session);
  const make = (map) => ({
    get: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    set: async (values) => {
      for (const [k, v] of Object.entries(values || {})) {
        if (v === undefined) map.delete(k);
        else map.set(k, v);
      }
    },
    remove: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) map.delete(k);
    }
  });
  return {
    local: make(local),
    session: make(session),
    _local: local,
    _session: session
  };
}

export function bindAccessPolicyChromeListener() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' && area !== 'session') return;
      if (!changes?.[ACCESS_POLICY_PROFILE_KEY] && !changes?.[ACCESS_POLICY_SESSION_KEY]) return;
      void readEffectiveAccessPolicy().then((policy) => notifyAccessPolicyChanged(policy));
    });
  } catch {
    /* tests / Node */
  }
}
