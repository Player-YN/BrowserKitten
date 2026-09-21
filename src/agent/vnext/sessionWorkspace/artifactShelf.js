/**
 * Deliverable-rail folders. Family chips come from the capability registry.
 * Stored folder aliases (sheets/images/sites/design/slides) stay readable.
 */

import {
  capabilityForItem,
  familyForItem,
  PRIMARY_FAMILIES,
  projectFamilyId
} from './artifactCapability.js';

export const SHELF_FOLDER_IDS = ['docs', 'data', 'web', 'media', 'files', 'images', 'sheets', 'sites', 'design', 'slides', 'legacy'];
export const PRIMARY_SHELF_CHIPS = [...PRIMARY_FAMILIES];
export const LEGACY_SHELF_FOLDERS = ['design', 'slides', 'legacy'];

const FOLDER_ALIASES = {
  images: 'images',
  image: 'images',
  图片: 'images',
  photos: 'images',
  media: 'media',
  design: 'design',
  画板: 'design',
  poster: 'design',
  canvas: 'design',
  slides: 'slides',
  幻灯: 'slides',
  deck: 'slides',
  sheets: 'sheets',
  sheet: 'sheets',
  表格: 'sheets',
  excel: 'sheets',
  data: 'data',
  docs: 'docs',
  doc: 'docs',
  文档: 'docs',
  document: 'docs',
  sites: 'sites',
  site: 'sites',
  网站: 'sites',
  web: 'web',
  files: 'files',
  file: 'files',
  其他: 'files',
  其它: 'files',
  other: 'files',
  legacy: 'legacy'
};

const DEFAULT_LABELS = {
  docs: { zh: '文档', en: 'Documents' },
  data: { zh: '表格/数据', en: 'Data' },
  web: { zh: '网站/代码', en: 'Web' },
  media: { zh: '媒体', en: 'Media' },
  files: { zh: '其它', en: 'Files' },
  images: { zh: '媒体', en: 'Media' },
  design: { zh: '遗留', en: 'Legacy' },
  slides: { zh: '遗留', en: 'Legacy' },
  sheets: { zh: '表格/数据', en: 'Data' },
  sites: { zh: '网站/代码', en: 'Web' },
  legacy: { zh: '其它 / Legacy', en: 'Other / Legacy' }
};

export function normalizeShelfFolderId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = FOLDER_ALIASES[s] || FOLDER_ALIASES[s.toLowerCase()];
  if (hit) return hit;
  return s.replace(/[^\w\u4e00-\u9fff.\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function inferArtifactShelfFolder(rec = {}) {
  const explicit = normalizeShelfFolderId(rec.folder || rec.shelf);
  if (explicit === 'design' || explicit === 'slides' || explicit === 'legacy') return explicit;
  if (explicit) {
    const projected = projectFamilyId(explicit);
    if (PRIMARY_FAMILIES.includes(projected)) return projected;
  }
  const family = familyForItem(rec);
  return family === 'legacy' ? 'legacy' : family;
}

export function shelfFolderLabel(folderId, lang = 'zh', labels = {}) {
  const id = normalizeShelfFolderId(folderId) || 'files';
  if (labels[id]) return String(labels[id]);
  const projected = projectFamilyId(id);
  if (labels[projected]) return String(labels[projected]);
  const pack = DEFAULT_LABELS[id] || DEFAULT_LABELS[projected];
  if (pack) return lang === 'en' ? pack.en : pack.zh;
  return id;
}

/**
 * @param {object[]} arts
 * @param {{ labels?: Record<string,string>, layout?: Array<{id:string,label?:string,items?:string[]}> }|null} shelf
 */
export function buildShelfView(arts = [], shelf = null) {
  const list = Array.isArray(arts) ? arts.filter((a) => a && a.artifactId) : [];
  const labels = shelf && typeof shelf.labels === 'object' && shelf.labels ? shelf.labels : {};
  const layout = Array.isArray(shelf?.layout) ? shelf.layout : null;
  const used = new Set();
  /** @type {Array<{id:string,label?:string,items:object[]}>} */
  const folders = [];

  if (layout && layout.length) {
    for (const row of layout) {
      const id = inferArtifactShelfFolder({ folder: row?.id || row?.folder || row?.label });
      if (!id) continue;
      const items = [];
      for (const rawId of Array.isArray(row.items) ? row.items : []) {
        const rec = list.find((a) => a.artifactId === rawId);
        if (rec) {
          items.push(rec);
          used.add(rec.artifactId);
        }
      }
      folders.push({ id, label: row.label || labels[id] || '', items });
    }
  }

  for (const rec of list) {
    if (used.has(rec.artifactId)) continue;
    const id = inferArtifactShelfFolder(rec);
    let bucket = folders.find((f) => f.id === id);
    if (!bucket) {
      bucket = { id, label: labels[id] || '', items: [] };
      folders.push(bucket);
    }
    bucket.items.push(rec);
  }

  const order = new Map(SHELF_FOLDER_IDS.map((id, i) => [id, i]));
  folders.sort((a, b) => {
    const ia = order.has(a.id) ? order.get(a.id) : 80;
    const ib = order.has(b.id) ? order.get(b.id) : 80;
    if (ia !== ib) return ia - ib;
    return a.id.localeCompare(b.id);
  });
  return folders.filter((f) => f.items.length);
}

export function compactShelfSnapshot(arts = [], shelf = null, lang = 'zh') {
  return buildShelfView(arts, shelf).map((f) => ({
    id: f.id,
    label: shelfFolderLabel(f.id, lang, shelf?.labels || {}),
    n: f.items.length,
    items: f.items.map((a) => a.artifactId)
  }));
}

export function setArtifactFolder(store, sessionId, artifactId, folder) {
  const rec = store.get('artifacts', artifactId);
  if (!rec || rec.sessionId !== sessionId) {
    return { ok: false, code: 'AUTH_DENIED', error: 'artifact not owned by session' };
  }
  const nextFolder = normalizeShelfFolderId(folder);
  if (nextFolder === 'trash') {
    const name = String(rec.name || '').toLowerCase();
    const path = String(rec.primaryPath || '');
    if (
      name === 'agents.md' ||
      name === 'memory.md' ||
      name === 'status.md' ||
      /\/AGENTS\.md$/i.test(path) ||
      /\/Memory\.md$/i.test(path) ||
      /\/STATUS\.md$/i.test(path)
    ) {
      return {
        ok: false,
        code: 'WORKSPACE_FILE',
        error: 'AGENTS.md, Memory.md, and STATUS.md cannot go in the trash'
      };
    }
  }
  const next = { ...rec, folder: nextFolder, updatedAt: Date.now() };
  store.put('artifacts', artifactId, next);
  return { ok: true, artifact: next };
}

/**
 * Path tree under /artifacts. Trash is a root folder, not a family chip.
 * @param {object[]} arts
 * @returns {Array<{id:string,label:string,items:object[],children:object[]}>}
 */
export function buildArtifactPathTree(arts = []) {
  const root = { id: 'root', label: '', items: [], children: [] };
  const trash = { id: 'trash', label: 'trash', items: [], children: [] };
  for (const rec of Array.isArray(arts) ? arts : []) {
    if (!rec?.artifactId) continue;
    const path = String(rec.primaryPath || '');
    const trashed = rec.folder === 'trash' || path.startsWith('/artifacts/.trash/');
    const rel = trashed
      ? path.replace(/^\/artifacts\/\.trash\//, '')
      : path.replace(/^\/artifacts\//, '');
    const parts = rel.split('/').filter(Boolean);
    const fileName = parts.pop() || rec.name || rec.artifactId;
    const host = trashed ? trash : root;
    let node = host;
    let acc = trashed ? 'trash' : 'path';
    for (const part of parts) {
      acc += `/${part}`;
      let child = node.children.find((c) => c.label === part);
      if (!child) {
        child = { id: acc, label: part, items: [], children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.items.push({ ...rec, displayLabel: rec.displayLabel || fileName });
  }
  const folders = root.children.slice();
  if (root.items.length) folders.unshift({ id: 'path/files', label: 'files', items: root.items, children: [] });
  if (trash.items.length || trash.children.length) folders.push(trash);
  return folders;
}

export function setShelfMeta(store, sessionId, patch = {}) {
  const sess = store.get('sessions', sessionId) || { sessionId };
  const prev = sess.shelf && typeof sess.shelf === 'object' ? sess.shelf : {};
  const shelf = { ...prev };
  if (patch.labels && typeof patch.labels === 'object') {
    shelf.labels = { ...(prev.labels || {}), ...patch.labels };
  }
  if (Array.isArray(patch.layout)) {
    shelf.layout = patch.layout
      .map((row) => ({
        id: normalizeShelfFolderId(row?.id || row?.folder || row?.label),
        label: row?.label != null ? String(row.label) : undefined,
        items: Array.isArray(row?.items) ? row.items.map(String) : []
      }))
      .filter((row) => row.id);
  }
  store.put('sessions', sessionId, { ...sess, shelf, updatedAt: Date.now() });
  return { ok: true, shelf };
}

export function folderCollapsedByDefault(folderId) {
  const id = projectFamilyId(normalizeShelfFolderId(folderId));
  return id === 'media' || id === 'legacy';
}

export function isPrimaryShelfChip(folderId) {
  const id = projectFamilyId(normalizeShelfFolderId(folderId));
  return PRIMARY_SHELF_CHIPS.includes(id);
}

/**
 * Hide retired Design/Slides chips. Leftover items stay openable under Files/Legacy.
 * @param {Array<{id:string,label?:string,items:object[]}>} folders
 */
export function foldLegacyShelfFolders(folders = []) {
  const list = Array.isArray(folders) ? folders : [];
  const legacyItems = [];
  const merged = new Map();
  for (const folder of list) {
    const raw = normalizeShelfFolderId(folder?.id);
    if (LEGACY_SHELF_FOLDERS.includes(raw)) {
      for (const item of folder.items || []) {
        legacyItems.push({ ...item, legacyCanvas: true });
      }
      continue;
    }
    const id = projectFamilyId(raw) === 'legacy' ? 'files' : projectFamilyId(raw) || raw;
    const prev = merged.get(id);
    if (prev) prev.items.push(...(folder.items || []));
    else merged.set(id, { ...folder, id, items: [...(folder.items || [])] });
  }
  const out = [...merged.values()];
  if (legacyItems.length) {
    let files = out.find((f) => f.id === 'files');
    if (!files) {
      files = { id: 'files', label: '', items: [] };
      out.push(files);
    }
    files.items = [...(files.items || []), ...legacyItems];
  }
  return out.filter((f) => (f.items || []).length && isPrimaryShelfChip(f.id));
}

/** Honest badge axis: editable / previewable / download-only. */
export function artifactAccessKind(item = {}) {
  const cap = capabilityForItem(item);
  if (cap.uncertain) return 'unknown';
  if (cap.badges.editable) return 'editable';
  if (cap.badges.previewable) return 'preview';
  return 'download';
}

export function artifactAccessLabelKey(kind) {
  if (kind === 'unknown') return 'artifactAccessUnknown';
  if (kind === 'editable') return 'artifactAccessEdit';
  if (kind === 'preview' || kind === 'saveable') return 'artifactAccessPreview';
  return 'artifactAccessDownload';
}

export function artifactAccessBadgeKeys(item = {}) {
  const cap = capabilityForItem(item);
  if (cap.uncertain) return ['artifactAccessUnknown'];
  const keys = [];
  if (cap.badges.editable) keys.push('artifactAccessEdit');
  if (cap.badges.previewable) keys.push('artifactAccessPreview');
  if (cap.badges.downloadOnly) keys.push('artifactAccessDownload');
  return keys.length ? keys : ['artifactAccessUnknown'];
}
