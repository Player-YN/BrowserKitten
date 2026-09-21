/**
 * Single artifact capability registry.
 * openClassify owns kind / MIME / magic. This file maps kind → family ×
 * open surface × honest badges. Shelf chips and preview routing must call here.
 */

import {
  classifyOpenArtifact,
  DOCS_OPEN_KINDS,
  RASTER_OPEN_KINDS,
  SHEET_OPEN_KINDS
} from './openClassify.js';

export const PRIMARY_FAMILIES = ['docs', 'data', 'web', 'media', 'files'];
export const FAMILY_IDS = [...PRIMARY_FAMILIES, 'legacy'];
export const TEXT_PREVIEW_CHAR_CAP = 200_000;
export const INSPECTOR_PREFIX_BYTES = 64 * 1024;

const TEXT_KINDS = new Set([
  'text',
  'markdown',
  'html',
  'html-plates',
  'json',
  'yaml',
  'xml',
  'css',
  'javascript',
  'typescript',
  'log'
]);

const TEXT_EXT =
  /\.(txt|md|markdown|json|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|log|ini|cfg|env|toml)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac|opus|oga)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|ogv|m4v)$/i;

const RASTER_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
};

function itemName(item) {
  return String(item?.name || item?.artifact?.name || item?.primaryPath || item?.downloadName || '');
}

function itemMime(item) {
  return String(item?.mimeType || item?.mime || item?.artifact?.mimeType || '');
}

function itemText(item) {
  if (item?.text != null && String(item.text).length) return String(item.text);
  if (item?.content != null) return String(item.content);
  return '';
}

export function mediaKindFromHint(item = {}) {
  const name = itemName(item);
  const mime = itemMime(item).toLowerCase();
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  return '';
}

export function isTextLikeItem(kind, item = {}) {
  const k = String(kind || '');
  if (SHEET_OPEN_KINDS.has(k) || DOCS_OPEN_KINDS.has(k) || k === 'html-site') return false;
  if (TEXT_KINDS.has(k)) return true;
  const name = itemName(item);
  const mime = itemMime(item).toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('xml') || mime.includes('javascript') || mime.includes('yaml')) {
    return true;
  }
  return TEXT_EXT.test(name);
}

function pack({
  kind,
  family,
  entry,
  view,
  editable = false,
  previewable = false,
  downloadOnly = false,
  executable = false,
  mimeType = '',
  downloadName = '',
  escape = false,
  uncertain = false
}) {
  const canPreview = !!previewable && !uncertain;
  const canEdit = !!editable && !uncertain;
  const onlyDownload = !uncertain && (!!downloadOnly || (!canEdit && !canPreview));
  return {
    kind: String(kind || 'unknown'),
    family: String(family || 'files'),
    entry: String(entry || 'artifactPreview.html'),
    view: String(view || 'inspector'),
    badges: {
      editable: canEdit,
      previewable: canPreview,
      downloadOnly: onlyDownload
    },
    canSave: canEdit,
    executable: !!executable,
    mimeType: String(mimeType || ''),
    downloadName: String(downloadName || ''),
    escape: !!escape,
    openable: true,
    uncertain: !!uncertain,
    proven: !uncertain
  };
}

const HTML_NAME_UNPROVEN = new Set(['html', 'html-site', 'html-document', 'html-plates']);

export function capabilityEvidence(item = {}) {
  if (item.bytes instanceof Uint8Array && item.bytes.byteLength) return 'bytes';
  if (itemText(item)) return 'bytes';
  if (item.capability?.proven === true && (item.contentKind || item.capability.contentKind)) return 'stored';
  const cls = classifyOpenArtifact({ name: itemName(item), mimeType: itemMime(item) });
  if (cls.kind && cls.kind !== 'empty' && cls.reason === 'name') {
    if (HTML_NAME_UNPROVEN.has(cls.kind)) return '';
    return 'name';
  }
  return '';
}

/**
 * @param {string} kind
 * @param {object} [item]
 */
export function resolveArtifactCapability(kind, item = {}) {
  const name = itemName(item);
  const mime = itemMime(item);
  let k = String(kind || '');

  if (item.legacyCanvas === true) {
    return pack({
      kind: k || 'json-canvas',
      family: 'legacy',
      entry: 'artifactPreview.html',
      view: 'inspector',
      downloadOnly: true,
      mimeType: mime || 'application/json',
      downloadName: name || 'canvas.json'
    });
  }

  const media = mediaKindFromHint(item);
  if ((k === 'binary' || k === 'empty' || !k) && media) k = media;

  if (SHEET_OPEN_KINDS.has(k)) {
    const binary = k === 'xlsx';
    return pack({
      kind: k,
      family: 'files',
      entry: 'artifactPreview.html',
      view: binary ? 'inspector' : 'text',
      previewable: !binary,
      downloadOnly: binary,
      escape: !binary,
      mimeType: mime || (binary ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv'),
      downloadName: name
    });
  }
  if (DOCS_OPEN_KINDS.has(k)) {
    return pack({
      kind: k,
      family: 'docs',
      entry: 'docs.html',
      view: 'docs',
      editable: true,
      previewable: true,
      mimeType: mime,
      downloadName: name
    });
  }
  if (k === 'html-site') {
    return pack({
      kind: k,
      family: 'web',
      entry: 'site.html',
      view: 'site',
      editable: true,
      previewable: true,
      mimeType: mime || 'text/html',
      downloadName: name
    });
  }
  if (RASTER_OPEN_KINDS.has(k) || k === 'svg') {
    return pack({
      kind: k,
      family: 'media',
      entry: 'artifactPreview.html',
      view: 'image',
      previewable: true,
      mimeType: RASTER_MIME[k] || mime || 'image/png',
      downloadName: name
    });
  }
  if (k === 'audio' || k === 'video') {
    return pack({
      kind: k,
      family: 'media',
      entry: 'artifactPreview.html',
      view: 'media',
      previewable: true,
      mimeType: mime || (k === 'audio' ? 'audio/mpeg' : 'video/mp4'),
      downloadName: name
    });
  }
  if (k === 'pdf') {
    return pack({
      kind: k,
      family: 'files',
      entry: 'artifactPreview.html',
      view: 'pdf',
      previewable: true,
      mimeType: 'application/pdf',
      downloadName: name || 'file.pdf'
    });
  }
  if (k === 'html' || k === 'html-plates') {
    return pack({
      kind: k,
      family: 'files',
      entry: 'artifactPreview.html',
      view: 'text',
      previewable: true,
      escape: true,
      executable: false,
      mimeType: 'text/plain',
      downloadName: name || 'file.html'
    });
  }
  if (isTextLikeItem(k, item)) {
    return pack({
      kind: k || 'text',
      family: 'files',
      entry: 'artifactPreview.html',
      view: 'text',
      previewable: true,
      escape: true,
      mimeType: mime || 'text/plain',
      downloadName: name || 'file.txt'
    });
  }
  return pack({
    kind: k || 'unknown',
    family: 'files',
    entry: 'artifactPreview.html',
    view: 'inspector',
    downloadOnly: true,
    mimeType: mime || 'application/octet-stream',
    downloadName: name || 'artifact.bin'
  });
}

export function capabilityForItem(item = {}) {
  const storedKind = String(item.contentKind || item.capability?.contentKind || item.artifact?.contentKind || '');
  const evidence = capabilityEvidence(item);
  if (evidence === 'bytes') {
    return resolveArtifactCapability(classifyOpenArtifact(item).kind, item);
  }
  if (evidence === 'stored' && storedKind) {
    return resolveArtifactCapability(storedKind, item);
  }
  const cls = classifyOpenArtifact(item);
  if (evidence === 'name' && cls.kind && cls.kind !== 'empty') {
    return resolveArtifactCapability(cls.kind, item);
  }
  if (!evidence || cls.kind === 'empty' || cls.kind === 'unknown' || !cls.kind) {
    return pack({
      kind: cls.kind || 'unknown',
      family: 'files',
      entry: 'artifactPreview.html',
      view: 'inspector',
      uncertain: true,
      mimeType: itemMime(item) || 'application/octet-stream',
      downloadName: itemName(item) || 'artifact.bin'
    });
  }
  return resolveArtifactCapability(cls.kind, item);
}

export function persistableCapabilityHint(item = {}) {
  const cap = capabilityForItem(item);
  return {
    proven: cap.uncertain !== true,
    contentKind: cap.kind,
    family: cap.family,
    entry: cap.entry,
    view: cap.view,
    editable: cap.badges.editable === true,
    previewable: cap.badges.previewable === true,
    downloadOnly: cap.badges.downloadOnly === true
  };
}

export function previewViewFromCapability(cap) {
  return {
    view: cap.view,
    kind: cap.kind,
    canSave: cap.canSave === true,
    mimeType: cap.mimeType,
    downloadName: cap.downloadName,
    family: cap.family,
    executable: cap.executable === true,
    escape: cap.escape === true
  };
}

export function previewEntryFromCapability(cap) {
  return {
    entry: cap.entry,
    shell: '',
    kind: cap.kind,
    family: cap.family
  };
}

export function previewViewForItem(item = {}) {
  return previewViewFromCapability(capabilityForItem(item));
}

export function previewEntryForItem(item = {}) {
  return previewEntryFromCapability(capabilityForItem(item));
}

export function projectFamilyId(folderId) {
  const id = String(folderId || '');
  if (id === 'images' || id === 'image') return 'media';
  if (id === 'sheets' || id === 'sheet') return 'data';
  if (id === 'sites' || id === 'site') return 'web';
  if (id === 'design' || id === 'slides' || id === 'legacy') return 'legacy';
  if (PRIMARY_FAMILIES.includes(id)) return id;
  return id || 'files';
}

export function familyForItem(item = {}) {
  const explicit = String(item.folder || item.shelf || '').trim();
  if (explicit === 'design' || explicit === 'slides') return 'legacy';
  const projected = projectFamilyId(explicit);
  if (projected === 'legacy') return 'legacy';
  if (PRIMARY_FAMILIES.includes(projected) && explicit) return projected;
  return capabilityForItem(item).family;
}

export function artifactIsOpenable(item = {}) {
  return capabilityForItem(item).openable === true;
}

export function escapePreviewText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function previewTextPayload(text, cap = TEXT_PREVIEW_CHAR_CAP) {
  const raw = String(text ?? '');
  const limit = Math.max(0, Number(cap) || TEXT_PREVIEW_CHAR_CAP);
  const truncated = raw.length > limit;
  const slice = truncated ? raw.slice(0, limit) : raw;
  return {
    text: slice,
    escaped: escapePreviewText(slice),
    truncated,
    omitted: Math.max(0, raw.length - slice.length)
  };
}

export function inspectorPrefix(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return new Uint8Array(0);
  return bytes.byteLength > INSPECTOR_PREFIX_BYTES ? bytes.subarray(0, INSPECTOR_PREFIX_BYTES) : bytes;
}

export function inspectorMeta(item = {}, bytes) {
  const raw = bytes instanceof Uint8Array
    ? bytes
    : item.bytes instanceof Uint8Array
      ? item.bytes
      : new Uint8Array(0);
  const prefix = inspectorPrefix(raw);
  const cap = capabilityForItem({ ...item, bytes: raw.byteLength ? raw : undefined });
  const take = Math.min(8, prefix.byteLength);
  let magic = '';
  for (let i = 0; i < take; i += 1) magic += prefix[i].toString(16).padStart(2, '0');
  const total = Number(item.byteLength) > 0 ? Number(item.byteLength) : raw.byteLength;
  return {
    name: itemName(item) || cap.downloadName || 'artifact',
    mimeType: cap.mimeType || itemMime(item) || 'application/octet-stream',
    byteLength: total,
    prefixBytes: prefix.byteLength,
    truncated: total > prefix.byteLength,
    kind: cap.kind,
    family: cap.family,
    magic: magic || '—',
    view: cap.view,
    openable: true,
    executable: false
  };
}
