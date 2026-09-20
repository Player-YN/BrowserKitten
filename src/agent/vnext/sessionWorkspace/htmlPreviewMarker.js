/**
 * Host-enforced opt-in for auto HTML preview tabs.
 * Skills that need preview put data-browserbot-preview="blocks" (or meta) in the HTML.
 */

const HEAD_CHARS = 8000;
const BLOCKS = 'blocks';

/**
 * @param {string|Uint8Array|ArrayBuffer|number[]|null|undefined} content
 * @returns {'blocks'|null}
 */
export function readHtmlPreviewKind(content) {
  const head = toHead(content);
  if (!head) return null;
  if (!looksLikeHtml(head)) return null;
  if (
    /data-browserbot-preview\s*=\s*["']blocks["']/i.test(head) ||
    /name\s*=\s*["']browserbot-preview["'][^>]*content\s*=\s*["']blocks["']/i.test(head) ||
    /content\s*=\s*["']blocks["'][^>]*name\s*=\s*["']browserbot-preview["']/i.test(head)
  ) {
    return BLOCKS;
  }
  return null;
}

function looksLikeHtml(head) {
  const t = head.trim();
  return (
    /^<!doctype\s+html/i.test(t) ||
    /^<html[\s>]/i.test(t) ||
    /<html[\s>][\s\S]{0,400}data-browserbot-preview/i.test(t)
  );
}

function toHead(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.slice(0, HEAD_CHARS);
  try {
    const u8 =
      content instanceof Uint8Array
        ? content
        : content instanceof ArrayBuffer
          ? new Uint8Array(content)
          : Array.isArray(content)
            ? Uint8Array.from(content)
            : null;
    if (!u8) return '';
    return new TextDecoder().decode(u8.slice(0, HEAD_CHARS));
  } catch {
    return '';
  }
}
