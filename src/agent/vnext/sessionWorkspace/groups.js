/**
 * SelectionGroup + WebItem ambient context (user-owned).
 * Groups are session-independent; sessions only bind ids.
 */

import { createGroupId, createWebItemId } from './ids.js';
import { normalizeLabelKind, classifyLabelKind } from './itemLabel.js';
import { clipClipboardText } from './pickContext.js';

export { isClipboardTextPick, clipClipboardText, CLIPBOARD_TEXT_HOST_MAX } from './pickContext.js';

export function normalizeGroupName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

export function groupNameKey(name) {
  return normalizeGroupName(name).toLowerCase();
}

export const CLIPBOARD_GROUP_KIND = 'clipboard';
export const CLIPBOARD_GROUP_NAME = 'Clipboard';

const CLIPBOARD_NAME_KEYS = new Set(['clipboard', '剪切板']);

export function isClipboardGroup(g) {
  if (!g || typeof g !== 'object') return false;
  if (String(g.kind || '') === CLIPBOARD_GROUP_KIND) return true;
  return CLIPBOARD_NAME_KEYS.has(groupNameKey(g.name));
}

export function isReservedClipboardName(name) {
  return CLIPBOARD_NAME_KEYS.has(groupNameKey(name));
}

export function findClipboardGroup(store, sessionId) {
  const sid = String(sessionId || '');
  let unscoped = null;
  for (const id of store.keys('groups')) {
    const g = store.get('groups', id);
    if (!isClipboardGroup(g)) continue;
    if (String(g.sessionId || '') === sid) return g;
    if (!g.sessionId && !unscoped) unscoped = g;
  }
  return sid ? null : unscoped;
}

/** One clipboard group per session. Not a wand capture target. */
export function ensureClipboardGroup(store, sessionId = '') {
  const sid = String(sessionId || '');
  const existing = findClipboardGroup(store, sid);
  if (existing) {
    const patch = {};
    if (existing.kind !== CLIPBOARD_GROUP_KIND) patch.kind = CLIPBOARD_GROUP_KIND;
    if (sid && !existing.sessionId) patch.sessionId = sid;
    if (Object.keys(patch).length) {
      store.put('groups', existing.groupId, { ...existing, ...patch });
      return store.get('groups', existing.groupId);
    }
    return existing;
  }
  const groupId = createGroupId();
  const now = Date.now();
  const group = {
    groupId,
    name: CLIPBOARD_GROUP_NAME,
    kind: CLIPBOARD_GROUP_KIND,
    sessionId: sid,
    createdAt: now,
    updatedAt: now
  };
  store.put('groups', groupId, group);
  store.put('groupMembers', groupId, []);
  return group;
}

function clipboardPinTextKey(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A source makes an otherwise identical clipboard quote a distinct capture. */
function clipboardSourceKey(source) {
  if (!source || typeof source !== 'object') return '';
  const tabId = source.tabId != null ? String(source.tabId) : '';
  const frameId = source.frameId != null ? String(source.frameId) : '';
  const documentId = String(source.documentId || '');
  const url = String(source.url || '');
  // `{ clipboard: true }` was the legacy marker, not a provenance record.
  if (!tabId && !frameId && !documentId && !url) return '';
  return `${tabId}|${frameId}|${documentId}|${url}`;
}

function clipboardItemKey(text, source) {
  const body = clipboardPinTextKey(text);
  if (!body) return '';
  const provenance = clipboardSourceKey(source);
  return provenance ? `${body}\u0000${provenance}` : body;
}

/**
 * Pin text snippets into the clipboard group. Dedupes identical text.
 * @returns {{ group: object, added: object[] }}
 */
export function pinClipboardItems(store, rawItems, sessionId = '') {
  const g = ensureClipboardGroup(store, sessionId);
  const existing = listGroupItems(store, g.groupId);
  const seen = new Set(existing.map((it) =>
    clipboardItemKey(it.capture?.textRaw || it.capture?.text || it.capture?.preview?.textSnippet, it.capture?.source)
  ));
  const added = [];
  const list = Array.isArray(rawItems) ? rawItems : [];
  for (const raw of list) {
    let text = '';
    let textRaw = '';
    let kindHint = 'text';
    let source = null;
    if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw === 'object') {
      textRaw = raw.textRaw != null ? String(raw.textRaw) : '';
      text = textRaw || (raw.text != null ? String(raw.text) : String(raw.content || raw.body || ''));
      if (raw.kind) kindHint = String(raw.kind);
      if (raw.source && typeof raw.source === 'object') source = raw.source;
    }
    const key = clipboardItemKey(text, source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const savedText = clipClipboardText(text);
    added.push(
      addWebItem(store, g.groupId, {
        // Preserve the authored body in text for existing copy/export consumers.
        text: savedText,
        ...(textRaw && textRaw !== savedText ? { textRaw: clipClipboardText(textRaw) } : {}),
        kindHint,
        source: { clipboard: true, ...(source || {}) }
      })
    );
  }
  return { group: store.get('groups', g.groupId), added };
}

export function clearClipboardGroup(store, sessionId = '') {
  const g = ensureClipboardGroup(store, sessionId);
  const members = /** @type {string[]} */ (store.get('groupMembers', g.groupId) || []);
  store.put('groupMembers', g.groupId, []);
  store.put('groups', g.groupId, { ...g, updatedAt: Date.now() });
  return { groupId: g.groupId, removed: members.length, memberIds: members };
}

export function listGroupNames(store, opts = {}) {
  const skip = opts.excludeGroupId ? String(opts.excludeGroupId) : '';
  const sid = opts.sessionId != null ? String(opts.sessionId) : '';
  const boundIds = opts.boundIds || [];
  /** @type {string[]} */
  const names = [];
  for (const id of store.keys('groups')) {
    if (skip && String(id) === skip) continue;
    const g = store.get('groups', id);
    if (!g?.name) continue;
    if (sid && !groupVisibleToSession(g, sid, boundIds)) continue;
    names.push(String(g.name));
  }
  return names;
}

export const ACTIVE_CAPTURE_GROUP_META = 'activeCaptureGroupId';

/** Wand capture groups are ambient. Clipboard stays per-session. Bind is separate. */
export function groupVisibleToSession(g, sessionId, _boundIds) {
  if (!g) return false;
  if (isClipboardGroup(g)) return String(g.sessionId || '') === String(sessionId || '');
  return true;
}

export function readActiveCaptureGroupId(store) {
  const raw = store.get('meta', ACTIVE_CAPTURE_GROUP_META);
  const id = typeof raw === 'string' ? raw : raw?.groupId || '';
  if (!id || !store.has('groups', id)) return null;
  const g = store.get('groups', id);
  if (!g || isClipboardGroup(g)) return null;
  return String(id);
}

export function writeActiveCaptureGroupId(store, groupId) {
  const id = String(groupId || '');
  if (!id) {
    store.delete('meta', ACTIVE_CAPTURE_GROUP_META);
    return null;
  }
  if (!store.has('groups', id)) return readActiveCaptureGroupId(store);
  const g = store.get('groups', id);
  if (isClipboardGroup(g)) {
    store.delete('meta', ACTIVE_CAPTURE_GROUP_META);
    return null;
  }
  store.put('meta', ACTIVE_CAPTURE_GROUP_META, id);
  return id;
}

/** Next unused Group 1 / Group 2… (skips gaps and custom names). */
export function nextGroupName(existingNames) {
  const taken = new Set((existingNames || []).map(groupNameKey).filter(Boolean));
  let n = 1;
  while (taken.has(`group ${n}`)) n += 1;
  return `Group ${n}`;
}

export function findGroupIdByName(store, name, opts = {}) {
  const key = groupNameKey(name);
  if (!key) return null;
  const skip = opts.excludeGroupId ? String(opts.excludeGroupId) : '';
  const sid = opts.sessionId != null ? String(opts.sessionId) : '';
  const boundIds = opts.boundIds || [];
  for (const id of store.keys('groups')) {
    if (skip && String(id) === skip) continue;
    const g = store.get('groups', id);
    if (!g || groupNameKey(g.name) !== key) continue;
    if (sid && !groupVisibleToSession(g, sid, boundIds)) continue;
    return g.groupId;
  }
  return null;
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {{ name?: string }} [opts]
 */
export function createGroup(store, opts = {}) {
  const groupId = createGroupId();
  const now = Date.now();
  const existing = listGroupNames(store);
  let name = normalizeGroupName(opts.name);
  if (isReservedClipboardName(name)) {
    const err = new Error('CLIPBOARD_NAME_RESERVED');
    err.code = 'CLIPBOARD_NAME_RESERVED';
    throw err;
  }
  if (!name) name = nextGroupName(existing);
  else if (findGroupIdByName(store, name)) {
    const err = new Error(`DUPLICATE_GROUP_NAME: ${name}`);
    err.code = 'DUPLICATE_GROUP_NAME';
    throw err;
  }
  const group = {
    groupId,
    name,
    createdAt: now,
    updatedAt: now
  };
  store.put('groups', groupId, group);
  store.put('groupMembers', groupId, []);
  return group;
}

/** Reuse an ambient named capture group, or create it once. */
export function findOrCreateNamedGroup(store, name) {
  const wanted = normalizeGroupName(name);
  if (!wanted || isReservedClipboardName(wanted)) {
    return createGroup(store, {});
  }
  const existing = findGroupIdByName(store, wanted);
  if (existing) return store.get('groups', existing);
  return createGroup(store, { name: wanted });
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} groupId
 * @param {string} name
 */
export function renameGroup(store, groupId, name) {
  const g = store.get('groups', groupId);
  if (!g) throw new Error(`unknown group ${groupId}`);
  if (isClipboardGroup(g)) {
    const err = new Error('CLIPBOARD_GROUP_PROTECTED');
    err.code = 'CLIPBOARD_GROUP_PROTECTED';
    throw err;
  }
  const next = normalizeGroupName(name);
  if (isReservedClipboardName(next)) {
    const err = new Error('CLIPBOARD_NAME_RESERVED');
    err.code = 'CLIPBOARD_NAME_RESERVED';
    throw err;
  }
  if (!next) {
    const err = new Error('GROUP_NAME_REQUIRED');
    err.code = 'GROUP_NAME_REQUIRED';
    throw err;
  }
  if (
    findGroupIdByName(store, next, {
      excludeGroupId: groupId
    })
  ) {
    const err = new Error(`DUPLICATE_GROUP_NAME: ${next}`);
    err.code = 'DUPLICATE_GROUP_NAME';
    throw err;
  }
  store.put('groups', groupId, { ...g, name: next, updatedAt: Date.now() });
  return store.get('groups', groupId);
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} groupId
 * @param {object} capture
 */
export function addWebItem(store, groupId, capture = {}) {
  if (!store.has('groups', groupId)) throw new Error(`unknown group ${groupId}`);
  const webItemId = createWebItemId();
  const item = {
    webItemId,
    capture: { ...capture },
    kindHint: capture.kindHint || classifyLabelKind(capture),
    createdAt: Date.now(),
    identityKey: capture.identityKey || selectionIdentityKey(capture)
  };
  const lk = normalizeLabelKind(capture.labelKind);
  const ln = Math.floor(Number(capture.labelN) || 0);
  if (lk && ln > 0) {
    item.labelKind = lk;
    item.labelN = ln;
  }
  store.put('items', webItemId, item);
  const members = /** @type {string[]} */ (store.get('groupMembers', groupId) || []);
  members.push(webItemId);
  store.put('groupMembers', groupId, members);
  const g = store.get('groups', groupId);
  store.put('groups', groupId, { ...g, updatedAt: Date.now() });
  return item;
}

/**
 * Stable selection identity for resync (audit H-8 / E2E-9).
 * Same tab + locator/src/text → same key; IDs must not churn on no-op resync.
 * @param {object} capture
 */
export function selectionIdentityKey(capture = {}) {
  const tabId = capture.source?.tabId ?? capture.tabId ?? '';
  // Legacy captures predate frame/document identity and are main-frame entries.
  const frameId = capture.source?.frameId ?? capture.frameId ?? 0;
  const documentId = capture.source?.documentId ?? capture.documentId ?? '';
  const css = capture.locator?.css || capture.selector || capture.css || '';
  const src = capture.src || capture.preview?.src || '';
  const href = capture.href || '';
  const kind = capture.kindHint || capture.kind || '';
  const text = String(capture.text || capture.preview?.textSnippet || '').slice(0, 120);
  return `${tabId}|${frameId}|${documentId}|${kind}|${css}|${src}|${href}|${text}`;
}

/**
 * Update capture on an existing WebItem (keeps id).
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} webItemId
 * @param {object} capture
 */
export function updateWebItem(store, webItemId, capture = {}) {
  const prev = store.get('items', webItemId);
  if (!prev) throw new Error(`unknown item ${webItemId}`);
  const next = {
    ...prev,
    capture: { ...capture },
    kindHint: capture.kindHint || prev.kindHint || classifyLabelKind(capture),
    identityKey: capture.identityKey || selectionIdentityKey(capture),
    labelKind: prev.labelKind,
    labelN: prev.labelN,
    updatedAt: Date.now()
  };
  store.put('items', webItemId, next);
  return next;
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} groupId
 * @param {string} webItemId
 */
export function removeWebItem(store, groupId, webItemId) {
  const members = /** @type {string[]} */ (store.get('groupMembers', groupId) || []);
  store.put(
    'groupMembers',
    groupId,
    members.filter((id) => id !== webItemId)
  );
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} groupId
 */
export function deleteGroup(store, groupId) {
  if (!store.has('groups', groupId)) throw new Error(`unknown group ${groupId}`);
  const existing = store.get('groups', groupId);
  if (isClipboardGroup(existing)) {
    const err = new Error('CLIPBOARD_GROUP_PROTECTED');
    err.code = 'CLIPBOARD_GROUP_PROTECTED';
    throw err;
  }
  const members = /** @type {string[]} */ (store.get('groupMembers', groupId) || []);
  store.delete('groups', groupId);
  store.delete('groupMembers', groupId);
  for (const sid of store.keys('sessionBindings')) {
    const bound = /** @type {string[]} */ (store.get('sessionBindings', sid) || []);
    if (bound.includes(groupId)) {
      store.put(
        'sessionBindings',
        sid,
        bound.filter((id) => id !== groupId)
      );
    }
  }
  return { deleted: true, groupId, memberIds: members };
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 * @param {string[]} groupIds
 */
export function bindGroupsToSession(store, sessionId, groupIds) {
  if (!store.has('sessions', sessionId)) throw new Error(`unknown session ${sessionId}`);
  const ids = [...new Set((groupIds || []).map(String))];
  for (const gid of ids) {
    if (!store.has('groups', gid)) throw new Error(`unknown group ${gid}`);
  }
  store.put('sessionBindings', sessionId, ids);
  return { sessionId, groupIds: ids };
}

/**
 * Compact ambient index — never dump all items.
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} sessionId
 */
export function getBoundGroupsCompact(store, sessionId) {
  const ids = /** @type {string[]} */ (store.get('sessionBindings', sessionId) || []);
  /** @type {Array<{id:string,name:string,itemCount:number}>} */
  const out = [];
  for (const id of ids) {
    const g = store.get('groups', id);
    if (!g) continue;
    const members = /** @type {string[]} */ (store.get('groupMembers', id) || []);
    out.push({
      id: g.groupId,
      name: g.name,
      itemCount: members.length,
      kind: g.kind || (isClipboardGroup(g) ? CLIPBOARD_GROUP_KIND : '')
    });
  }
  return out;
}

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {string} groupId
 */
export function listGroupItems(store, groupId) {
  const members = /** @type {string[]} */ (store.get('groupMembers', groupId) || []);
  return members.map((id) => store.get('items', id)).filter(Boolean);
}
