/**
 * Host-owned faithful site clone.
 * Compiles a self-contained data-browserbot-kind=site HTML from complete DOM + CSS.
 * Node-safe — no DOMParser, no model JavaScript execution.
 */

import { assertPublicHttpUrl } from '../primitives/netGuard.js';
import { createArtifact, updateArtifactContent, writePackageFile, listArtifacts } from './artifacts.js';
import { inventoryFromSession } from './canvasInventory.js';
import { htmlWritePolicy } from './htmlWritePolicy.js';
import { storePageBlueprint, normalizePageBlueprint, compactBlueprintSummary } from './pageBlueprint.js';
import { stampSiteHtml, listSiteNodes } from './siteApply.js';
import { sanitizeSiteHtml } from './siteSanitize.js';
import { annotateSiteMotionBlueprint } from './siteMotionBlueprint.js';
import { assessSiteClone, compactSiteQaReport } from './siteQa.js';

export const SITE_CLONE_LIMITS = {
  htmlChars: 1_500_000,
  cssCharsPerSheet: 400_000,
  cssCharsTotal: 1_200_000,
  importDepth: 3,
  assetCount: 48,
  assetBytesEach: 8 * 1024 * 1024,
  assetBytesTotal: 48 * 1024 * 1024,
  fetchMs: 12000,
  computedNodes: 120
};

export const AMBIGUOUS_SITE = 'AMBIGUOUS_SITE';

const LAYOUT_TAGS = 'header|nav|main|aside|footer|section|article';
const FONT_URL_RE = /@font-face\s*\{[\s\S]*?\}/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?\s*([^;]*);/gi;

/**
 * Remove active / unsafe content. Scripts never survive into the site artifact.
 * @param {string} html
 * @returns {{ html: string, stripped: string[] }}
 */
export function stripActiveContent(html) {
  const stripped = [];
  const note = (kind) => {
    if (!stripped.includes(kind)) stripped.push(kind);
  };
  let next = String(html || '');
  next = next.replace(/<script\b[\s\S]*?<\/script>/gi, () => {
    note('script');
    return '';
  });
  next = next.replace(/<script\b[^>]*\/?>/gi, () => {
    note('script');
    return '';
  });
  next = next.replace(/<(object|embed|applet|iframe|frame|frameset)\b[\s\S]*?<\/\1>/gi, (_, tag) => {
    note(String(tag).toLowerCase());
    return '';
  });
  next = next.replace(/<(object|embed|applet|iframe|frame)\b[^>]*\/?>/gi, (_, tag) => {
    note(String(tag).toLowerCase());
    return '';
  });
  next = next.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
    note('handler');
    return '';
  });
  next = next.replace(
    /\s(href|src|action|formaction|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    (_, attr, q) => {
      note('javascript-url');
      return ` ${attr}=${q}#${q}`;
    }
  );
  next = next.replace(/<form\b([^>]*)>/gi, (_, attrs) => {
    note('form-submit');
    let a = String(attrs || '')
      .replace(/\saction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s(method|onsubmit|target)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<form${a} action="#" method="dialog" data-paw-inert="form">`;
  });
  next = next.replace(/<(a|area)\b([^>]*)>/gi, (full, tag, attrs) => {
    if (/\starget\s*=\s*(["'])_blank\1/i.test(attrs) && !/\srel\s*=/i.test(attrs)) {
      return `<${tag}${attrs} rel="noopener noreferrer">`;
    }
    return full;
  });
  return { html: next, stripped };
}

/**
 * Stamp data-browserbot-kind=site, layout nodes, and text/img nodes.
 * Preserves existing data-paw-node ids.
 */
export function stampCloneHtml(html, opts = {}) {
  const lang = String(opts.lang || '').trim();
  const sourceUrl = String(opts.sourceUrl || opts.url || '').trim();
  let next = String(html || '');
  if (!/<html\b/i.test(next)) {
    next = `<!DOCTYPE html><html>${next}</html>`;
  }
  if (!/data-browserbot-kind\s*=\s*["']site["']/i.test(next)) {
    next = next.replace(/<html\b([^>]*)>/i, '<html$1 data-browserbot-kind="site">');
  }
  if (lang && !/\slang\s*=/i.test(next.match(/<html\b[^>]*>/i)?.[0] || '')) {
    next = next.replace(/<html\b/i, `<html lang="${escapeAttr(lang)}"`);
  }
  if (sourceUrl) {
    next = next.replace(/<html\b([^>]*)>/i, (m, attrs) =>
      /data-paw-clone-url=/i.test(m)
        ? m
        : `<html${attrs} data-paw-clone-url="${escapeAttr(sourceUrl)}">`
    );
  }
  next = stampLayoutNodes(next);
  next = stampSiteHtml(next);
  return next;
}

function stampLayoutNodes(html) {
  let n = 0;
  const existing = [...String(html || '').matchAll(/data-paw-node="n(\d+)"/gi)].map((m) => Number(m[1]));
  if (existing.length) n = Math.max(...existing);
  return String(html || '').replace(new RegExp(`<(${LAYOUT_TAGS})(\\s[^>]*)?>`, 'gi'), (m) => {
    if (/data-paw-node=/i.test(m)) return m;
    n += 1;
    if (m.endsWith('/>')) return `${m.slice(0, -2)} data-paw-node="n${n}"/>`;
    return `${m.slice(0, -1)} data-paw-node="n${n}">`;
  });
}

export function extractStylesheetHrefs(html) {
  const out = [];
  const re = /<link\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[1] || '';
    const rel = attr(attrs, 'rel');
    if (!/\bstylesheet\b/i.test(rel)) continue;
    const href = attr(attrs, 'href');
    if (href) out.push({ href, media: attr(attrs, 'media') });
  }
  return out;
}

export function extractInlineStyles(html) {
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    out.push({ media: attr(m[1] || '', 'media'), cssText: m[2] || '' });
  }
  return out;
}

export function listHtmlAssetUrls(html, opts = {}) {
  const primary = [];
  const extras = [];
  const push = (u, bucket) => {
    const s = decodeAttr(String(u || '').trim());
    if (!s || s.startsWith('#') || /^javascript:/i.test(s) || /^mailto:/i.test(s) || /^data:/i.test(s)) return;
    bucket.push(s);
  };
  const re = /<(img|source|video|image)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[2] || '';
    push(attr(attrs, 'src'), primary);
    push(attr(attrs, 'poster'), primary);
    const srcset = attr(attrs, 'srcset');
    if (srcset && opts.srcset !== false) {
      for (const part of srcset.split(',')) push(part.trim().split(/\s+/)[0], extras);
    }
  }
  const styleRe = /\sstyle\s*=\s*(["'])([^"']*)\1/gi;
  while ((m = styleRe.exec(String(html || '')))) {
    const urls = collectCssUrls(m[2] || '');
    for (const u of urls) push(u, primary);
  }
  if (opts.srcset === false) return unique(primary);
  return unique([...primary, ...extras]);
}

export function assetIdentity(url) {
  const s = String(url || '').trim();
  if (!s || /^(data:|javascript:|mailto:|#)/i.test(s)) return s;
  return s.split('#')[0].split('?')[0];
}

export function collectCssUrls(css) {
  const urls = [];
  const re = new RegExp(CSS_URL_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(css || '')))) {
    const u = String(m[2] || '').trim();
    if (!u || /^data:/i.test(u) || /^#/.test(u)) continue;
    urls.push(u);
  }
  return unique(urls);
}

export function collectCssImports(css) {
  const out = [];
  const re = new RegExp(IMPORT_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(css || '')))) {
    out.push({ href: m[2], media: String(m[3] || '').trim() });
  }
  return out;
}

/**
 * Neutralize @font-face remote urls. Keep family + local/system fallback.
 * @returns {{ css: string, unresolvedFonts: string[] }}
 */
export function neutralizeFontFaces(css) {
  const unresolvedFonts = [];
  const next = String(css || '').replace(FONT_URL_RE, (block) => {
    const urls = collectCssUrls(block);
    for (const u of urls) {
      if (!/^data:/i.test(u) && !/^local\(/i.test(u)) unresolvedFonts.push(u);
    }
    return block.replace(CSS_URL_RE, (full, q, href) => {
      if (/^data:/i.test(href) || /^local\(/i.test(href)) return full;
      return 'local("Browser Kitten Fallback")';
    });
  });
  return { css: next, unresolvedFonts: unique(unresolvedFonts) };
}

export function rewriteCssUrls(css, mapUrl) {
  return String(css || '').replace(CSS_URL_RE, (full, q, href) => {
    if (/^data:/i.test(href) || /^local\(/i.test(href)) return full;
    const mapped = mapUrl(href, 'url');
    if (!mapped) return full;
    return `url(${q}${mapped}${q})`;
  });
}

export function stripRemoteStylesheetLinks(html) {
  return String(html || '').replace(/<link\b([^>]*)>/gi, (full, attrs) => {
    const rel = attr(attrs, 'rel');
    if (!/\bstylesheet\b/i.test(rel)) return full;
    return '';
  });
}

export function stripInlineStyleBlocks(html) {
  return String(html || '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

export function resolveRef(ref, baseUrl) {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:|javascript:|mailto:|#)/i.test(raw)) return raw;
  if (raw.startsWith('/scratch/') || raw.startsWith('/artifacts/') || raw.startsWith('/context/')) {
    return raw.split('?')[0];
  }
  const base = String(baseUrl || '').trim();
  if (base.startsWith('/scratch/') || base.startsWith('/artifacts/') || base.startsWith('/context/')) {
    if (raw.startsWith('/')) return raw.split('?')[0];
    const dir = base.replace(/\/[^/]*$/, '/');
    return normalizeGuestPath(dir + raw.split('?')[0]);
  }
  try {
    return new URL(raw, base || undefined).href;
  } catch {
    return raw;
  }
}

export function isSameOriginRef(url, baseUrl) {
  const a = String(url || '');
  const b = String(baseUrl || '');
  if (a.startsWith('/') && b.startsWith('/')) {
    const root = b.split('/').slice(0, 3).join('/');
    return a.startsWith(root) || a.startsWith('/scratch/') || a.startsWith('/artifacts/');
  }
  try {
    return new URL(a, b).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function looksLikeFontUrl(url) {
  return /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(String(url || ''));
}

export function looksLikeImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|#|$)/i.test(String(url || '')) || /^data:image\//i.test(url);
}

/**
 * Fail-closed site target: one clone intent = one site artifact.
 */
export function resolveSiteCloneTarget(store, fs, sessionId, execution, opts = {}) {
  const explicit = String(opts.artifactId || '').trim();
  const inv = inventoryFromSession(store, sessionId, fs);
  const webIds = inv.web || [];
  if (explicit) {
    if (!webIds.includes(explicit)) {
      return { ok: false, code: 'NO_CANVAS', error: 'artifactId is not a website canvas' };
    }
    return { ok: true, applyId: explicit };
  }
  const led = String(execution?.siteClone?.artifactId || '').trim();
  if (led && webIds.includes(led)) return { ok: true, applyId: led };
  const sess = store.get('sessions', sessionId) || {};
  const focused = String(sess.activeHtml?.artifactId || '').trim();
  if (focused && webIds.includes(focused)) return { ok: true, applyId: focused };
  if (webIds.length === 1) return { ok: true, applyId: webIds[0] };
  if (webIds.length > 1) {
    const arts = listArtifacts(store, sessionId) || [];
    return {
      ok: false,
      code: AMBIGUOUS_SITE,
      error: `AMBIGUOUS_SITE: ${webIds.length} website artifacts and no explicit target. Pass artifactId.`,
      candidates: webIds.map((id) => {
        const rec = arts.find((a) => a.artifactId === id);
        return { artifactId: id, name: rec?.name || '' };
      })
    };
  }
  return { ok: true, applyId: '', create: true };
}

/**
 * Sync compile from already-fetched materials.
 * @param {{
 *   html: string,
 *   cssTexts?: string[],
 *   baseUrl?: string,
 *   lang?: string,
 *   url?: string,
 *   viewport?: { width?: number, height?: number },
 *   computed?: Array<{ nodeId?: string, selector?: string, styles?: object }>,
 *   assetMap?: Record<string, string>,
 *   cssIncomplete?: boolean,
 *   motion?: object
 * }} input
 */
export function compileSiteClone(input = {}) {
  const warnings = [];
  const sourceUrl = String(input.url || input.baseUrl || '').trim();
  const lang = String(input.lang || '').trim();
  const stripped = stripActiveContent(input.html || '');
  let html = sanitizeSiteHtml(stripped.html);
  const cssParts = [];
  let cssBytes = 0;
  const pushCss = (text, origin = '') => {
    const raw = String(text || '');
    if (!raw.trim()) return;
    const room = SITE_CLONE_LIMITS.cssCharsTotal - cssBytes;
    if (room <= 0) {
      warnings.push('css-budget');
      return;
    }
    const sliced = raw.slice(0, Math.min(SITE_CLONE_LIMITS.cssCharsPerSheet, room));
    if (sliced.length < raw.length) warnings.push('css-truncated');
    cssBytes += sliced.length;
    const fonts = neutralizeFontFaces(sliced);
    for (const u of fonts.unresolvedFonts) {
      if (!warnings.includes(`font:${u}`)) warnings.push(`font-unresolved`);
    }
    const mapped = rewriteCssUrls(fonts.css, (href) => {
      const abs = resolveRef(href, origin || input.baseUrl || sourceUrl);
      if (looksLikeFontUrl(abs) || looksLikeFontUrl(href)) return '';
      return lookupAsset(input.assetMap, href, origin || input.baseUrl || sourceUrl) || abs;
    });
    cssParts.push(mapped);
    return fonts.unresolvedFonts;
  };

  const unresolvedFonts = [];
  for (const block of extractInlineStyles(html)) {
    const fonts = pushCss(block.cssText, input.baseUrl);
    if (fonts) unresolvedFonts.push(...fonts);
  }
  for (const css of input.cssTexts || []) {
    const fonts = pushCss(css, input.baseUrl);
    if (fonts) unresolvedFonts.push(...fonts);
  }

  html = stripRemoteStylesheetLinks(html);
  html = stripInlineStyleBlocks(html);
  html = rewriteHtmlAssets(html, (href) => {
    return lookupAsset(input.assetMap, href, input.baseUrl || sourceUrl) || href;
  });

  if (input.cssIncomplete && Array.isArray(input.computed) && input.computed.length) {
    cssParts.push(computedFallbackCss(input.computed));
    warnings.push('computed-fallback');
  }

  const bundledCss = cssParts.filter(Boolean).join('\n\n');
  const styleBlock = bundledCss
    ? `<style data-paw-clone-css="1">\n${bundledCss}\n</style>`
    : '';
  if (styleBlock) {
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${styleBlock}</head>`);
    else if (/<html\b[^>]*>/i.test(html)) {
      html = html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${styleBlock}</head>`);
    } else {
      html = `${styleBlock}${html}`;
    }
  }

  html = stampCloneHtml(html, { lang, sourceUrl });
  let motionMeta = { mappings: 0, warnings: [] };
  if (String(input.motion || 'declarative').toLowerCase() !== 'off') {
    try {
      const annotated = annotateSiteMotionBlueprint(html);
      html = stripForeignDataAttrs(annotated.html);
      motionMeta = {
        mappings: (annotated.mappings || []).length,
        warnings: annotated.warnings || []
      };
      if (Array.isArray(annotated.warnings) && annotated.warnings.length) {
        warnings.push('motion-partial');
      }
    } catch {
      html = stripForeignDataAttrs(html);
    }
  } else {
    html = stripForeignDataAttrs(html);
  }
  const policy = htmlWritePolicy(html, 'site.html');
  if (policy.allow === false) {
    return { ok: false, code: policy.code, error: policy.error, warnings };
  }

  const hasRemoteCss = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/i.test(html);
  if (hasRemoteCss) warnings.push('remote-stylesheet-remains');

  return {
    ok: true,
    html,
    cssBytes,
    stripped: stripped.stripped,
    unresolvedFonts: unique(unresolvedFonts),
    warnings: unique(warnings),
    locale: lang,
    url: sourceUrl,
    viewport: input.viewport || null,
    motion: {
      keyframeNames: listKeyframeNames(bundledCss),
      retained: /@keyframes|transition\s*:|animation\s*:/i.test(bundledCss),
      mapped: motionMeta.mappings,
      warnings: (motionMeta.warnings || []).map((w) => w.code).filter(Boolean)
    },
    nodes: listSiteNodes(html).map((n) => n.nodeId),
    motionMappings: motionMeta.mappings,
    motionWarnings: motionMeta.warnings
  };
}

function lookupAsset(assetMap, href, baseUrl) {
  if (!assetMap) return '';
  const raw = String(href || '').trim();
  const abs = resolveRef(raw, baseUrl);
  return (
    assetMap[abs] ||
    assetMap[raw] ||
    assetMap[assetIdentity(abs)] ||
    assetMap[assetIdentity(raw)] ||
    ''
  );
}

function rememberAsset(assetMap, raw, abs, path) {
  assetMap[abs] = path;
  assetMap[raw] = path;
  assetMap[assetIdentity(abs)] = path;
  assetMap[assetIdentity(raw)] = path;
  try {
    const u = new URL(abs);
    u.search = '';
    u.hash = '';
    assetMap[u.href] = path;
  } catch {
    /* ignore */
  }
}

function rewriteHtmlAssets(html, mapUrl) {
  return String(html || '')
    .replace(/(\s(?:src|poster)\s*=\s*)(["'])([^"']+)\2/gi, (full, pre, q, src) => {
      if (/^data:/i.test(src)) return full;
      const mapped = mapUrl(src);
      return mapped ? `${pre}${q}${mapped}${q}` : full;
    })
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi, (full, pre, q, srcset) => {
      const next = srcset
        .split(',')
        .map((part) => {
          const bits = part.trim().split(/\s+/);
          if (!bits[0]) return '';
          const mapped = mapUrl(bits[0]);
          if (!mapped || mapped === bits[0]) return '';
          bits[0] = mapped;
          return bits.join(' ');
        })
        .filter(Boolean);
      if (!next.length) return '';
      return `${pre}${q}${next.join(', ')}${q}`;
    })
    .replace(/(\sstyle\s*=\s*)(["'])([^"']*)\2/gi, (full, pre, q, style) => {
      const mapped = String(style || '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (u, qq, href) => {
        if (/^data:/i.test(href) || /^#/.test(href)) return u;
        const hit = mapUrl(href);
        return hit && hit !== href ? `url(${qq}${hit}${qq})` : u;
      });
      return `${pre}${q}${mapped}${q}`;
    });
}

function stripForeignDataAttrs(html) {
  return String(html || '').replace(/<([a-z][\w:-]*)([^>]*)>/gi, (full, tag, attrs) => {
    if (!/\sdata-/i.test(attrs)) return full;
    const next = String(attrs || '').replace(/\sdata-(?!paw-)[\w.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    return `<${tag}${next}>`;
  });
}

function computedFallbackCss(computed) {
  const lines = [];
  let i = 0;
  for (const node of computed.slice(0, SITE_CLONE_LIMITS.computedNodes)) {
    const styles = node?.styles && typeof node.styles === 'object' ? node.styles : {};
    const decls = Object.entries(styles)
      .filter(([, v]) => v != null && String(v).trim() && String(v) !== 'none')
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    if (!decls) continue;
    const sel = node.nodeId
      ? `[data-paw-node="${escapeAttr(node.nodeId)}"]`
      : node.selector
        ? String(node.selector).slice(0, 160)
        : `[data-paw-computed="${++i}"]`;
    lines.push(`${sel} { ${decls} }`);
  }
  return lines.length ? `/* computed fallback — used only when source CSS is incomplete */\n${lines.join('\n')}` : '';
}

function listKeyframeNames(css) {
  const names = [];
  const re = /@keyframes\s+([A-Za-z_-][\w-]*)/gi;
  let m;
  while ((m = re.exec(String(css || '')))) names.push(m[1]);
  return unique(names);
}

/**
 * Host entry for `web act=clone` / `web act=capture`.
 */
export async function runSiteClone(env, input = {}) {
  const act = String(input.act || 'clone').toLowerCase();
  const source = String(input.source || inferSource(input)).toLowerCase();
  const warnings = [];
  const store = env.store;
  const fs = env.fs;
  const sessionId = env.sessionId;
  const execution = env.execution;
  if (!fs) return { ok: false, error: 'fs required' };

  const captured = await loadCloneSource(env, { ...input, source }, warnings);
  if (!captured.ok) return captured;

  const stored = storePageBlueprint(fs, captured.blueprint, {
    executionId: execution?.executionId || Date.now().toString(36)
  });
  if (act === 'capture') {
    return {
      ok: true,
      act: 'capture',
      source,
      captureDir: stored.captureDir,
      path: stored.path,
      summary: stored.summary,
      warnings: unique([...(captured.warnings || []), ...warnings])
    };
  }

  const target = resolveSiteCloneTarget(store, fs, sessionId, execution, {
    artifactId: input.artifactId
  });
  if (!target.ok) return target;

  const packageDir = target.applyId
    ? packageDirOf(store, sessionId, target.applyId)
    : safeDir(hostFromUrl(captured.blueprint.url || captured.blueprint.baseUrl) || 'site');
  const assetMap = {};
  const bundled = [];
  const unresolved = [];
  const fetched = await bundleAssets(env, captured, packageDir, {
    assetMap,
    bundled,
    unresolved,
    warnings
  });

  const cssIncomplete = captured.cssIncomplete === true || !captured.cssTexts?.length;
  const compiled = compileSiteClone({
    html: captured.blueprint.html,
    cssTexts: captured.cssTexts,
    baseUrl: captured.blueprint.baseUrl,
    lang: captured.blueprint.lang || captured.blueprint.locale,
    url: captured.requestedUrl || captured.blueprint.url,
    viewport: input.viewport || captured.blueprint.viewport,
    computed: cssIncomplete ? captured.blueprint.computed : [],
    assetMap: fetched.assetMap,
    cssIncomplete,
    motion: captured.blueprint.motion
  });
  if (!compiled.ok) return compiled;

  const rec = persistSiteArtifact(env, target, compiled.html, packageDir);
  if (!rec?.artifactId) {
    return { ok: false, error: rec?.error || 'failed to write site artifact', code: rec?.code };
  }
  rememberSiteClone(execution, rec.artifactId);
  try {
    if (typeof fs.mkdirp === 'function') fs.mkdirp(`/artifacts/${packageDir}/assets`);
  } catch {
    /* writePackageFile may still succeed */
  }

  for (const asset of fetched.written) {
    try {
      writePackageFile(store, fs, {
        sessionId,
        artifactId: rec.artifactId,
        path: asset.path,
        content: asset.bytes,
        mimeType: asset.mimeType
      });
    } catch (e) {
      warnings.push(`asset-write:${asset.name || 'file'}`);
      unresolved.push({ url: asset.sourceUrl, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const qa = assessSiteClone({
    html: compiled.html,
    sourceHtml: captured.blueprint.html,
    viewport: compiled.viewport || { width: 1440, height: 900 },
    bundled: fetched.written,
    unresolved: [...unresolved, ...fetched.unresolved],
    stripped: compiled.stripped,
    motionWarnings: compiled.motionWarnings
  });
  const qaReport = compactSiteQaReport(qa);

  const report = {
    locale: compiled.locale,
    url: compiled.url,
    viewport: compiled.viewport,
    cssBytes: compiled.cssBytes,
    bundledAssets: fetched.written.map((a) => ({ path: a.path, bytes: a.bytes.byteLength, source: a.sourceUrl })),
    unresolvedAssets: [...unresolved, ...fetched.unresolved],
    unresolvedFonts: compiled.unresolvedFonts,
    stripped: compiled.stripped,
    motion: compiled.motion,
    issues: qaReport.issues,
    qa: qaReport,
    warnings: unique([
      ...warnings,
      ...compiled.warnings,
      ...(captured.warnings || []),
      ...(stored.summary?.warnings || []),
      ...qaReport.issues.filter((i) => i.severity === 'hard').map((i) => i.code)
    ]),
    captureDir: stored.captureDir
  };
  try {
    writePackageFile(store, fs, {
      sessionId,
      artifactId: rec.artifactId,
      path: `/artifacts/${packageDir}/clone-report.json`,
      content: JSON.stringify(report, null, 2),
      mimeType: 'application/json'
    });
  } catch {
    /* report is also returned */
  }

  if (env.onEvent) {
    try {
      env.onEvent({ type: 'html_canvas_updated', sessionId, artifactId: rec.artifactId });
    } catch {
      /* ignore */
    }
  }

  const partial = qa.partial === true || report.warnings.length > 0 || report.unresolvedAssets.length > 0;
  return {
    ok: true,
    act: 'clone',
    source,
    artifactId: rec.artifactId,
    path: rec.primaryPath,
    captureDir: stored.captureDir,
    summary: compactBlueprintSummary(captured.blueprint, { captureDir: stored.captureDir }),
    report: {
      locale: report.locale,
      url: report.url,
      viewport: report.viewport,
      cssBytes: report.cssBytes,
      bundled: report.bundledAssets.length,
      unresolved: report.unresolvedAssets.length,
      unresolvedFonts: report.unresolvedFonts.length,
      stripped: report.stripped,
      motion: report.motion,
      warnings: report.warnings,
      partial,
      issues: qaReport.issues,
      qa: qaReport
    },
    partial,
    canUndo: !target.create
  };
}

function inferSource(input) {
  if (input.url) return 'url';
  if (input.path) return 'path';
  return 'active';
}

async function loadCloneSource(env, input, warnings) {
  const source = String(input.source || 'active');
  if (source === 'path') {
    return loadFromPath(env, input, warnings);
  }
  if (source === 'url') {
    return loadFromUrl(env, input, warnings);
  }
  return loadFromActive(env, input, warnings);
}

async function loadFromActive(env, input, warnings) {
  const tabId = env.activeTab?.tabId ?? env.activeTab?.id ?? input.tabId;
  if (typeof env.hostPageCapture === 'function') {
    try {
      const raw = await env.hostPageCapture({
        tabId,
        url: env.activeTab?.url || env.focusPage?.url || input.url
      });
      if (raw && raw.ok !== false && (raw.html || raw.outerHTML)) {
        const blueprint = normalizePageBlueprint(raw);
        const cssTexts = await completeStylesheets(env, blueprint, warnings);
        return {
          ok: true,
          blueprint,
          cssTexts,
          cssIncomplete: cssTexts.length === 0,
          requestedUrl: blueprint.url,
          warnings: blueprint.warnings
        };
      }
      if (raw && raw.ok === false) warnings.push(raw.error || 'capture-failed');
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e));
    }
  }
  const url = String(input.url || env.focusPage?.url || env.activeTab?.url || '').trim();
  if (url) {
    warnings.push('active-capture-unavailable-fell-back-to-url');
    return loadFromUrl(env, { ...input, url }, warnings);
  }
  return { ok: false, code: 'NEED_PAGE', error: 'clone source=active needs a live tab or url' };
}

async function loadFromUrl(env, input, warnings) {
  const url = String(input.url || '').trim();
  if (!url) return { ok: false, code: 'NEED_URL', error: 'clone source=url needs url' };
  const fetched = await fetchPublicText(env, url);
  if (!fetched.ok) return { ...fetched, action: 'clone' };
  if (fetched.finalUrl && fetched.finalUrl !== url && localePathShifted(url, fetched.finalUrl)) {
    warnings.push(`redirect-locale:${fetched.finalUrl}`);
  }
  const html = fetched.text;
  const baseUrl = url;
  const lang = guessLang(html);
  const hrefs = extractStylesheetHrefs(html);
  const cssTexts = [];
  for (const sheet of hrefs) {
    const abs = resolveRef(sheet.href, baseUrl);
    const css = await fetchPublicText(env, abs);
    if (css.ok) cssTexts.push(css.text);
    else warnings.push(`css-unresolved:${abs}`);
  }
  const inline = extractInlineStyles(html).map((s) => s.cssText);
  const blueprint = normalizePageBlueprint({
    ok: true,
    url,
    baseUrl,
    lang,
    locale: lang,
    title: guessTitle(html),
    html,
    stylesheets: [
      ...inline.map((cssText) => ({ inline: true, readable: true, cssText })),
      ...hrefs.map((h, i) => ({
        href: resolveRef(h.href, baseUrl),
        readable: !!cssTexts[i],
        cssText: cssTexts[i] || ''
      }))
    ],
    assets: {
      images: listHtmlAssetUrls(html),
      backgrounds: cssTexts.concat(inline).flatMap((c) => collectCssUrls(c).filter(looksLikeImageUrl)),
      fonts: cssTexts.concat(inline).flatMap((c) => collectCssUrls(c).filter(looksLikeFontUrl))
    },
    viewport: input.viewport || { width: 1440, height: 900 },
    warnings: [...warnings]
  });
  const resolvedCss = await expandCssImports(
    env,
    cssTexts.concat(inline),
    baseUrl,
    warnings
  );
  return {
    ok: true,
    blueprint,
    cssTexts: resolvedCss,
    cssIncomplete: resolvedCss.length === 0 && !inline.length,
    requestedUrl: url,
    warnings
  };
}

async function loadFromPath(env, input, warnings) {
  const path = String(input.path || '').trim();
  if (!path) return { ok: false, error: 'clone source=path needs path' };
  let raw;
  try {
    raw = env.fs.readFileBytes(path);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  if (/^\s*\{/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && (parsed.html || parsed.outerHTML || parsed.blueprint)) {
        const blueprint = normalizePageBlueprint(parsed.blueprint || parsed);
        const cssTexts = (blueprint.stylesheets || []).map((s) => s.cssText).filter(Boolean);
        const resolvedCss = await expandCssImports(env, cssTexts, blueprint.baseUrl || path, warnings);
        return { ok: true, blueprint, cssTexts: resolvedCss, requestedUrl: blueprint.url, warnings };
      }
    } catch {
      /* treat as html */
    }
  }
  const baseUrl = path;
  const html = text;
  const hrefs = extractStylesheetHrefs(html);
  const cssTexts = [];
  for (const sheet of hrefs) {
    const abs = resolveRef(sheet.href, baseUrl);
    const css = await readGuestOrFetch(env, abs);
    if (css.ok) cssTexts.push(css.text);
    else warnings.push(`css-unresolved:${abs}`);
  }
  const inline = extractInlineStyles(html).map((s) => s.cssText);
  const resolvedCss = await expandCssImports(env, cssTexts.concat(inline), baseUrl, warnings);
  const blueprint = normalizePageBlueprint({
    ok: true,
    url: input.url || '',
    baseUrl,
    lang: guessLang(html) || input.lang || 'en',
    locale: guessLang(html) || input.lang || 'en',
    title: guessTitle(html),
    html,
    stylesheets: hrefs.map((h, i) => ({
      href: resolveRef(h.href, baseUrl),
      readable: !!cssTexts[i],
      cssText: cssTexts[i] || ''
    })),
    assets: {
      images: listHtmlAssetUrls(html),
      backgrounds: resolvedCss.flatMap((c) => collectCssUrls(c).filter(looksLikeImageUrl)),
      fonts: resolvedCss.flatMap((c) => collectCssUrls(c).filter(looksLikeFontUrl))
    },
    viewport: input.viewport || { width: 1440, height: 900 }
  });
  return {
    ok: true,
    blueprint,
    cssTexts: resolvedCss,
    cssIncomplete: resolvedCss.length === 0,
    requestedUrl: blueprint.url,
    warnings
  };
}

async function completeStylesheets(env, blueprint, warnings) {
  const texts = [];
  for (const sheet of blueprint.stylesheets || []) {
    if (sheet.cssText) {
      texts.push(sheet.cssText);
      continue;
    }
    if (!sheet.href) continue;
    const css = await fetchPublicText(env, sheet.href);
    if (css.ok) texts.push(css.text);
    else warnings.push(`css-unresolved:${sheet.href}`);
  }
  return expandCssImports(env, texts, blueprint.baseUrl, warnings);
}

async function expandCssImports(env, cssTexts, baseUrl, warnings, depth = 0) {
  if (depth >= SITE_CLONE_LIMITS.importDepth) {
    if (cssTexts.some((c) => collectCssImports(c).length)) warnings.push('import-depth');
    return cssTexts.map((c) => String(c || '').replace(IMPORT_RE, ''));
  }
  const out = [];
  for (const css of cssTexts) {
    const imports = collectCssImports(css);
    const extras = [];
    for (const imp of imports) {
      const abs = resolveRef(imp.href, baseUrl);
      if (!isSameOriginRef(abs, baseUrl) && !abs.startsWith('/')) {
        warnings.push(`import-cross-origin:${abs}`);
        continue;
      }
      const got = await readGuestOrFetch(env, abs);
      if (!got.ok) {
        warnings.push(`import-unresolved:${abs}`);
        continue;
      }
      extras.push(got.text);
    }
    const expanded = extras.length
      ? await expandCssImports(env, extras, baseUrl, warnings, depth + 1)
      : [];
    out.push(...expanded, String(css || '').replace(IMPORT_RE, ''));
  }
  return out;
}

async function bundleAssets(env, captured, packageDir, acc) {
  const html = captured.blueprint.html;
  const primary = unique([
    ...listHtmlAssetUrls(html, { srcset: false }),
    ...(captured.cssTexts || []).flatMap((c) => collectCssUrls(c).filter((u) => looksLikeImageUrl(u) || !looksLikeFontUrl(u)))
  ]);
  const extras = listHtmlAssetUrls(html, { srcset: true }).filter((u) => {
    const id = assetIdentity(resolveRef(u, captured.blueprint.baseUrl));
    return !primary.some((p) => assetIdentity(resolveRef(p, captured.blueprint.baseUrl)) === id);
  });
  const urls = unique([...primary, ...extras]);
  const written = [];
  const unresolved = [];
  const assetMap = acc.assetMap || {};
  const seenId = new Set();
  let totalBytes = 0;
  let count = 0;
  const candidates = [];
  for (const raw of urls) {
    const abs = resolveRef(raw, captured.blueprint.baseUrl);
    if (!abs || /^data:/i.test(abs) || /^javascript:/i.test(abs)) continue;
    const id = assetIdentity(abs);
    if (seenId.has(id)) {
      const existing = assetMap[id];
      if (existing) rememberAsset(assetMap, raw, abs, existing);
      continue;
    }
    seenId.add(id);
    if (looksLikeFontUrl(abs)) {
      unresolved.push({ url: abs, reason: 'font-not-redistributed' });
      continue;
    }
    if (!looksLikeImageUrl(abs) && !/^https?:/i.test(abs) && !abs.startsWith('/')) continue;
    candidates.push({ raw, abs, id });
  }
  const fetched = await mapPool(candidates, 6, async (c) => ({
    ...c,
    got: await readGuestOrFetch(env, c.abs, { binary: true })
  }));
  for (const item of fetched) {
    const { raw, abs, id, got } = item;
    if (count >= SITE_CLONE_LIMITS.assetCount) {
      acc.warnings.push('asset-count');
      unresolved.push({ url: abs, reason: 'asset-count' });
      continue;
    }
    if (!got?.ok || !got.bytes?.byteLength) {
      unresolved.push({ url: abs, reason: got?.error || 'fetch-failed' });
      continue;
    }
    const kind = sniffImageMime(got.bytes, got.mimeType) || got.mimeType || '';
    if (kind && !/^image\//i.test(kind) && !/svg/i.test(kind)) {
      unresolved.push({ url: abs, reason: 'not-image' });
      continue;
    }
    if (got.bytes.byteLength > SITE_CLONE_LIMITS.assetBytesEach) {
      unresolved.push({ url: abs, reason: 'too-large' });
      continue;
    }
    if (totalBytes + got.bytes.byteLength > SITE_CLONE_LIMITS.assetBytesTotal) {
      acc.warnings.push('asset-bytes');
      unresolved.push({ url: abs, reason: 'asset-bytes' });
      continue;
    }
    count += 1;
    totalBytes += got.bytes.byteLength;
    const mimeType = kind || guessImageMime(id);
    const name = assetFileName(id || abs, count, mimeType);
    const path = `/artifacts/${packageDir}/assets/${name}`;
    rememberAsset(assetMap, raw, abs, path);
    written.push({
      path,
      name,
      bytes: got.bytes,
      mimeType,
      sourceUrl: abs
    });
  }
  acc.bundled.push(...written);
  acc.unresolved.push(...unresolved);
  return { assetMap, written, unresolved };
}

function sniffImageMime(bytes, declared) {
  const d = String(declared || '').split(';')[0].trim().toLowerCase();
  if (!bytes?.byteLength) return d.startsWith('image/') ? d : '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const tag = new TextDecoder().decode(bytes.slice(8, 12));
    if (tag === 'WEBP') return 'image/webp';
  }
  const head = new TextDecoder().decode(bytes.slice(0, 240)).trim();
  if (/^(<\?xml[\s\S]{0,200})?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  if (d.startsWith('image/')) return d;
  return '';
}

function persistSiteArtifact(env, target, html, packageDir) {
  const { store, fs, sessionId } = env;
  try {
    if (target.applyId) {
      return updateArtifactContent(store, fs, sessionId, target.applyId, html, {
        mimeType: 'text/html'
      });
    }
    return createArtifact(store, fs, {
      sessionId,
      name: 'site.html',
      packageDir,
      path: `/artifacts/${packageDir}/site.html`,
      content: html,
      mimeType: 'text/html',
      displayLabel: 'Site'
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), code: e?.code || 'WRITE_FAILED' };
  }
}

function rememberSiteClone(execution, artifactId) {
  if (!execution || typeof execution !== 'object') return;
  if (!execution.siteClone || typeof execution.siteClone !== 'object') {
    execution.siteClone = { artifactId: '' };
  }
  if (!execution.siteClone.artifactId) execution.siteClone.artifactId = artifactId;
}

function packageDirOf(store, sessionId, artifactId) {
  const rec = (listArtifacts(store, sessionId) || []).find((a) => a.artifactId === artifactId);
  return rec?.packageDir || 'site';
}

async function readGuestOrFetch(env, url, opts = {}) {
  const u = String(url || '');
  if (u.startsWith('/scratch/') || u.startsWith('/artifacts/') || u.startsWith('/context/')) {
    try {
      const bytes = env.fs.readFileBytes(u);
      const text = opts.binary ? '' : new TextDecoder().decode(bytes);
      return {
        ok: true,
        bytes: bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes || '')),
        text,
        mimeType: guessImageMime(u),
        url: u
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), url: u };
    }
  }
  if (opts.binary) return fetchPublicBytes(env, u);
  return fetchPublicText(env, u);
}

async function fetchPublicText(env, url) {
  const got = await fetchPublicBytes(env, url);
  if (!got.ok) return got;
  return { ...got, text: new TextDecoder().decode(got.bytes) };
}

/**
 * Anonymous public GET. Does not use Firecrawl markdown scrape as clone truth.
 */
export async function fetchPublicBytes(env, url) {
  const gate = assertPublicHttpUrl(url);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, url };
  const fetchImpl = env.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch unavailable', url };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SITE_CLONE_LIMITS.fetchMs);
  const parent = env.signal;
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) {
      clearTimeout(t);
      return { ok: false, error: 'aborted', url };
    }
    parent.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetchImpl(gate.url.href, {
      credentials: 'omit',
      signal: ctrl.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url: gate.url.href };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > SITE_CLONE_LIMITS.assetBytesEach && !/text\/(css|html)|javascript/i.test(res.headers.get('content-type') || '')) {
      return { ok: false, error: 'too-large', url: gate.url.href };
    }
    const sliced =
      buf.byteLength > SITE_CLONE_LIMITS.cssCharsTotal && /text\/(css|html)/i.test(res.headers.get('content-type') || '')
        ? buf.subarray(0, SITE_CLONE_LIMITS.cssCharsTotal)
        : buf;
    return {
      ok: true,
      bytes: sliced,
      mimeType: res.headers.get('content-type') || '',
      url: gate.url.href,
      finalUrl: String(res.url || gate.url.href)
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), url: gate.url.href };
  } finally {
    clearTimeout(t);
    if (parent) parent.removeEventListener('abort', onAbort);
  }
}

function localePathShifted(requested, finalUrl) {
  try {
    const a = new URL(requested);
    const b = new URL(finalUrl);
    if (a.origin !== b.origin) return true;
    const left = a.pathname.replace(/\/+$/, '') || '/';
    const right = b.pathname.replace(/\/+$/, '') || '/';
    if (left === right) return false;
    return /(?:^|\/)(?:zh|cn|zh-cn|zh-hans|-cn)(?:\/|$)/i.test(right) && !/(?:^|\/)(?:zh|cn|zh-cn|-cn)(?:\/|$)/i.test(left);
  } catch {
    return requested !== finalUrl;
  }
}

function guessLang(html) {
  const m = /<html\b[^>]*\slang\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? m[1].trim() : '';
}

function guessTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? stripTags(m[1]).slice(0, 240) : '';
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    String(attrs || '')
  );
  if (!m) return '';
  return decodeAttr(m[2] ?? m[3] ?? m[4] ?? '');
}

function decodeAttr(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

async function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, async () => {
    while (i < list.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function normalizeGuestPath(p) {
  const parts = [];
  for (const bit of String(p || '').replace(/\\/g, '/').split('/')) {
    if (!bit || bit === '.') continue;
    if (bit === '..') parts.pop();
    else parts.push(bit);
  }
  return `/${parts.join('/')}`;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function safeDir(name) {
  return String(name || 'site')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'site';
}

function assetFileName(url, index, mimeType) {
  let base = 'asset';
  try {
    const u = new URL(url, 'https://local.test');
    base = decodeURIComponent((u.pathname.split('/').pop() || '').split('?')[0]);
  } catch {
    base = String(url).split('/').pop() || '';
  }
  base = safeDir(base) || `asset-${index}`;
  if (!/\.[a-z0-9]+$/i.test(base)) {
    const ext = (mimeType || '').includes('svg')
      ? '.svg'
      : (mimeType || '').includes('webp')
        ? '.webp'
        : (mimeType || '').includes('jpeg') || (mimeType || '').includes('jpg')
          ? '.jpg'
          : '.png';
    base += ext;
  }
  return `${String(index).padStart(2, '0')}-${base}`.slice(0, 80);
}

function guessImageMime(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.svg')) return 'image/svg+xml';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

export const WEB_CLONE_DESCRIPTION =
  'Clone a whole page into one self-contained data-browserbot-kind=site artifact (host captures DOM+CSS+assets; do not rewrite from inspect snippets). source=active|url|path. assets=bundle. motion=declarative (CSS keyframes/transitions retained).';
