/**
 * Open OOXML .docx as document blocks. Zip bytes are not UTF-8 text.
 */

import { unzipSync, strFromU8 } from './vendor/fflate.js';
import { looksLikeZipBytes } from '../agent/vnext/sessionWorkspace/openClassify.js';
import { bytesToDataUrl } from './durableImage.js';

export { looksLikeZipBytes };

function asBytes(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
}

function xmlUnescape(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function fileAt(files, path) {
  if (files[path]) return files[path];
  const lower = String(path).toLowerCase();
  for (const k of Object.keys(files)) {
    if (k.replace(/\\/g, '/').toLowerCase() === lower) return files[k];
  }
  return null;
}

function parseRels(files) {
  const raw = fileAt(files, 'word/_rels/document.xml.rels');
  const xml = raw ? strFromU8(raw) : '';
  const map = new Map();
  for (const m of xml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) {
    let target = m[2].replace(/^\.\//, '').replace(/\\/g, '/');
    if (!target.startsWith('word/')) target = `word/${target}`;
    map.set(m[1], target);
  }
  for (const m of xml.matchAll(/Target="([^"]+)"[^>]*Id="(rId\d+)"/g)) {
    if (map.has(m[2])) continue;
    let target = m[1].replace(/^\.\//, '').replace(/\\/g, '/');
    if (!target.startsWith('word/')) target = `word/${target}`;
    map.set(m[2], target);
  }
  return map;
}

function mimeFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

function paragraphText(inner) {
  const parts = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(inner))) parts.push(xmlUnescape(m[1]));
  return parts.join('');
}

function paragraphStyle(inner) {
  const m = /<w:pStyle\b[^>]*w:val="([^"]+)"/i.exec(inner) || /w:val="([^"]+)"[^>]*\/?>(?=[\s\S]*<w:pStyle)/i.exec(inner);
  return m ? String(m[1]) : '';
}

function isHeading1(style) {
  return /^(heading\s*1|heading1|title|标题\s*1|标题1)$/i.test(String(style || '').trim());
}

function isListPara(inner) {
  return /<w:numPr\b/i.test(inner);
}

function embedIds(inner) {
  const ids = [];
  for (const m of String(inner).matchAll(/r:embed="(rId\d+)"/g)) ids.push(m[1]);
  return ids;
}

/**
 * @param {Uint8Array} bytes
 * @param {{ title?: string, id?: string }} [opts]
 */
export function docxBytesToSnapshot(bytes, opts = {}) {
  const buf = asBytes(bytes);
  if (!looksLikeZipBytes(buf)) throw new Error('not a docx zip');
  let files;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error('无法打开 Word 文档');
  }
  const xmlBytes = fileAt(files, 'word/document.xml');
  if (!xmlBytes) throw new Error('Word 文档缺少 word/document.xml');
  const xml = strFromU8(xmlBytes);
  const rels = parseRels(files);
  const blocks = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  let i = 0;
  while ((m = re.exec(xml))) {
    const inner = m[1] || '';
    const text = paragraphText(inner);
    const rids = embedIds(inner);
    for (const rid of rids) {
      const path = rels.get(rid);
      const media = path ? fileAt(files, path) : null;
      if (media && media.length) {
        i += 1;
        blocks.push({
          id: `img${i}`,
          type: 'img',
          src: bytesToDataUrl(media, mimeFromName(path)),
          text: text || undefined
        });
      }
    }
    if (!text.trim()) continue;
    i += 1;
    const style = paragraphStyle(inner);
    if (isHeading1(style)) blocks.push({ id: `b${i}`, type: 'h1', text });
    else if (isListPara(inner)) blocks.push({ id: `b${i}`, type: 'li', list: 'ul', text });
    else blocks.push({ id: `b${i}`, type: 'p', text });
  }
  const title = String(opts.title || '').trim() || 'Document';
  return { title, blocks };
}
