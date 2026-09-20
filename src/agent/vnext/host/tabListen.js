/**
 * SW-side tab listen: grant, visibility, tabCapture stream id.
 * Recording itself lives in the offscreen listen runtime.
 */

export const LISTEN_GRANT_PREFIX = 'browserbot_listen_grant:';
export const RECORD_GRANT_PREFIX = 'browserbot_record_grant:';
export const DEFAULT_LISTEN_SECONDS = 20;
export const MAX_LISTEN_SECONDS = 120;

export function listenGrantKey(sessionId, tabId, kind = 'audio') {
  return `${kind === 'video' ? RECORD_GRANT_PREFIX : LISTEN_GRANT_PREFIX}${String(sessionId || '')}:${Number(tabId)}`;
}

export function clampRecordSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(30, Math.max(1, Math.round(n))) : 8;
}

export function normalizeListenVerb(value) {
  const v = String(value || 'clip')
    .trim()
    .toLowerCase();
  if (v === 'start' || v === 'stop' || v === 'clip') return v;
  return '';
}

export function clampListenSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LISTEN_SECONDS;
  return Math.min(MAX_LISTEN_SECONDS, Math.max(1, Math.round(n)));
}

export async function readListenGrant(sessionStorage, sessionId, tabId, kind = 'audio') {
  if (!sessionStorage?.get) return false;
  const key = listenGrantKey(sessionId, tabId, kind);
  const res = await sessionStorage.get([key]);
  return !!(res && res[key]);
}

export async function putListenGrant(sessionStorage, sessionId, tabId, kind = 'audio') {
  const sid = String(sessionId || '');
  const id = Number(tabId);
  if (!sid || !Number.isInteger(id) || id <= 0) {
    throw new Error('listen grant needs sessionId and tabId');
  }
  const key = listenGrantKey(sid, id, kind);
  await sessionStorage.set({
    [key]: { at: Date.now(), sessionId: sid, tabId: id }
  });
  return key;
}

export async function dropListenGrantsForTab(sessionStorage, tabId) {
  if (!sessionStorage?.get) return 0;
  const id = Number(tabId);
  const suffix = `:${id}`;
  let bag = {};
  try {
    bag = (await sessionStorage.get(null)) || {};
  } catch {
    bag = {};
  }
  const keys = Object.keys(bag).filter(
    (k) => (k.startsWith(LISTEN_GRANT_PREFIX) || k.startsWith(RECORD_GRANT_PREFIX)) && k.endsWith(suffix)
  );
  if (keys.length && sessionStorage.remove) await sessionStorage.remove(keys);
  return keys.length;
}

export async function assertListenTabVisible(chromeLike, tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, code: 'NEED_EXPLICIT_TAB', error: 'listen requires tabId' };
  }
  if (typeof chromeLike?.tabs?.get !== 'function') {
    return { ok: false, code: 'NEED_PAGE', error: 'tabs.get unavailable' };
  }
  let tab;
  try {
    tab = await chromeLike.tabs.get(id);
  } catch (error) {
    return { ok: false, code: 'NEED_PAGE', error: error?.message || String(error), tabId: id };
  }
  try {
    const [active] = await chromeLike.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id) {
      return { ok: false, code: 'TAB_NOT_VISIBLE', error: 'Target tab is not visible.', tabId: id };
    }
  } catch {
    /* tests / no windows */
  }
  return { ok: true, tab, tabId: id, audible: tab?.audible === true };
}

/**
 * @param {object} request
 * @param {{ chromeLike?: any, sessionStorage?: { get: Function, set?: Function, remove?: Function } }} [deps]
 */
export async function handleWorkspaceTabListen(request, deps = {}) {
  const chromeLike = deps.chromeLike || globalThis.chrome;
  const sessionStorage = deps.sessionStorage || chromeLike?.storage?.session;
  const kind = request?.op === 'record' ? 'video' : 'audio';
  const verb = kind === 'video' ? 'clip' : normalizeListenVerb(request?.listen);
  if (!verb) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'listen must be start, stop, or clip',
      hint: 'pass listen=start, listen=stop, or listen=clip'
    };
  }
  const tabId = Number(request?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, code: 'NEED_EXPLICIT_TAB', error: 'listen requires tabId' };
  }
  if (verb === 'stop') {
    return { ok: true, listen: 'stop', tabId };
  }

  const visible = await assertListenTabVisible(chromeLike, tabId);
  if (!visible.ok) return visible;

  const granted = await readListenGrant(sessionStorage, request.sessionId, tabId, kind);
  if (!granted) {
    return {
      ok: false,
      code: 'NEED_CAPTURE_GRANT',
      captureKind: kind,
      error: 'side-panel capture grant required',
      tabId,
      title: visible.tab?.title || '',
      hint: kind === 'video'
        ? 'wait for the side-panel video capture grant, then retry action op=record'
        : 'wait for the side-panel capture grant, then retry action op=listen'
    };
  }

  if (typeof chromeLike?.tabCapture?.getMediaStreamId !== 'function') {
    return { ok: false, code: 'NEED_PAGE', error: 'tabCapture unavailable', tabId };
  }
  let streamId = '';
  try {
    streamId = await chromeLike.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    return {
      ok: false,
      code: 'NEED_PAGE',
      error: error?.message || String(error),
      tabId
    };
  }
  if (!streamId) {
    return { ok: false, code: 'NEED_PAGE', error: 'no media stream id', tabId };
  }
  return {
    ok: true,
    listen: verb,
    captureKind: kind,
    tabId,
    streamId: String(streamId),
    audible: visible.audible === true,
    seconds: kind === 'video' ? clampRecordSeconds(request.seconds) : clampListenSeconds(request.seconds),
    title: visible.tab?.title || ''
  };
}
