/**
 * User-initiated blank canvases for the artifact rail.
 * Reuses existing durable formats — no second file type.
 */

import { applyDocCommands, emptyDocSnapshot } from './docsApply.js';
import { stampSiteHtml } from './siteApply.js';

export const BLANK_KINDS = ['sheet', 'doc', 'site'];

const BLANK_SITE_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-browserbot-kind="site">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Site</title>
</head>
<body>
  <main>
    <h1></h1>
  </main>
</body>
</html>
`;

function stampDocumentKind(html) {
  const src = String(html || '');
  if (/data-browserbot-kind\s*=\s*["']document["']/i.test(src)) return src;
  return src.replace(/<html\b([^>]*)>/i, '<html$1 data-browserbot-kind="document">');
}

/**
 * @param {string} kind
 * @returns {{ kind: string, name: string, mimeType: string, content: string, folder: string } | { kind: 'sheet' }}
 */
export function blankArtifactPayload(kind) {
  const k = String(kind || '').trim();
  if (k === 'sheet') return { kind: 'sheet' };
  if (k === 'doc') {
    const applied = applyDocCommands(emptyDocSnapshot('Document'), [
      { op: 'createDocument', title: 'Document' }
    ]);
    return {
      kind: 'doc',
      name: 'document.html',
      mimeType: 'text/html',
      content: stampDocumentKind(applied.html),
      folder: 'docs'
    };
  }
  if (k === 'site') {
    return {
      kind: 'site',
      name: 'site.html',
      mimeType: 'text/html',
      content: stampSiteHtml(BLANK_SITE_HTML),
      folder: 'sites'
    };
  }
  const err = new Error(`unknown blank kind: ${k || '(empty)'}`);
  err.code = 'UNKNOWN_BLANK_KIND';
  throw err;
}
