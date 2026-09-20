/**
 * Host bind: load a guest JSON/HTML payload and apply through official office commands.
 * Prompt cannot enforce “don’t retype”. Missing file ENOENT; invalid/empty BAD_INPUT.
 */

export function officePayloadPath(cmd) {
  if (!cmd || typeof cmd !== 'object') return '';
  return String(cmd.path || cmd.from || cmd.valuesPath || cmd.scratchPath || '').trim();
}

export function guestReadError(path, err, label = 'payload') {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT/i.test(msg)) {
    return {
      ok: false,
      code: 'ENOENT',
      error: `${label} file not found: ${path}`,
      hint: 'write JSON to /scratch or /artifacts via run, then pass that path'
    };
  }
  if (/FS_DENIED/i.test(msg)) {
    return {
      ok: false,
      code: 'FS_DENIED',
      error: msg,
      hint: 'path must be a session guest file under /scratch or /artifacts'
    };
  }
  return { ok: false, code: 'BAD_INPUT', error: msg, hint: `pass path to a /scratch or /artifacts ${label}` };
}

export function readGuestText(fs, rawPath, label = 'payload') {
  const p = String(rawPath || '').trim();
  if (!p) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: `${label} path is empty`,
      hint: 'pass path / from to a /scratch or /artifacts file'
    };
  }
  if (!fs || (typeof fs.readFileBytes !== 'function' && typeof fs.readFile !== 'function')) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'guest FS unavailable for path',
      hint: 'office write resolves path on the host before apply'
    };
  }
  try {
    if (typeof fs.readFileBytes === 'function') {
      const bytes = fs.readFileBytes(p);
      const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      return { ok: true, path: p, text };
    }
    return { ok: true, path: p, text: String(fs.readFile(p) ?? '') };
  } catch (err) {
    return guestReadError(p, err, label);
  }
}

export function readGuestJson(fs, rawPath, label = 'payload') {
  const loaded = readGuestText(fs, rawPath, label);
  if (!loaded.ok) return loaded;
  try {
    return { ok: true, path: loaded.path, value: JSON.parse(String(loaded.text ?? '')) };
  } catch {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: `${label} JSON is invalid`,
      hint: 'write valid JSON via run, then pass that path — do not retype'
    };
  }
}

function looksLikeRemoteOrBoundImage(ref) {
  const s = String(ref || '').trim();
  return /^(wi_|data:image|https?:\/\/|图片|截图|image|img|screenshot|矢量)/i.test(s);
}

function looksLikeImageFile(ref) {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(String(ref || '').trim());
}

function looksLikeHtmlText(text) {
  const t = String(text || '').trim();
  return /^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t) || /data-browserbot-kind\s*=/i.test(t);
}

function isEmptyObject(value) {
  return !value || typeof value !== 'object' || (Array.isArray(value) ? value.length === 0 : !Object.keys(value).length);
}

function emptyPayloadError(label) {
  return {
    ok: false,
    code: 'BAD_INPUT',
    error: `${label} JSON is empty`,
    hint: 'write a non-empty payload via run, then pass path — do not retype'
  };
}

function stripConsumedPath(input) {
  const next = { ...input };
  delete next.path;
  delete next.from;
  delete next.valuesPath;
  delete next.scratchPath;
  return next;
}

function commandsFromDocJson(value) {
  if (Array.isArray(value)) {
    if (!value.length) return emptyPayloadError('doc');
    if (value.some((c) => c && typeof c === 'object' && String(c.op || c.type || '').trim())) {
      return { ok: true, commands: value };
    }
    return { ok: true, commands: [{ op: 'createDocument', blocks: value }] };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'BAD_INPUT', error: 'doc JSON must be commands[], blocks[], or {text}', hint: 'pass path to doc JSON' };
  }
  if (Array.isArray(value.commands)) {
    if (!value.commands.length) return emptyPayloadError('doc');
    return { ok: true, commands: value.commands };
  }
  if (Array.isArray(value.blocks)) {
    if (!value.blocks.length) return emptyPayloadError('doc');
    return { ok: true, commands: [{ op: 'createDocument', title: value.title, blocks: value.blocks }] };
  }
  if (value.text != null && String(value.text) !== '') {
    return { ok: true, commands: [{ op: 'setText', text: String(value.text), id: value.id }] };
  }
  return { ok: false, code: 'BAD_INPUT', error: 'doc JSON needs commands, blocks, or text', hint: 'pass path to doc JSON' };
}

function commandsFromWebJson(value) {
  if (Array.isArray(value)) {
    if (!value.length) return emptyPayloadError('web');
    return { ok: true, commands: value };
  }
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'web JSON must be commands[] or {html}',
      hint: 'pass path to site patch JSON or HTML'
    };
  }
  if (Array.isArray(value.commands) && value.commands.length) {
    return { ok: true, commands: value.commands };
  }
  const html = value.html || value.content;
  if (html != null && String(html).trim()) {
    return { ok: true, commands: [{ op: 'replaceHtml', html: String(html) }] };
  }
  return emptyPayloadError('web');
}

/**
 * Top-level path/from on an office write. Image refs stay on the command; JSON/HTML becomes commands.
 * @param {'doc'|'web'} surface
 */
export function resolveOfficeWriteInput(fs, input = {}, surface = 'doc') {
  const src = input && typeof input === 'object' ? input : {};
  if (Array.isArray(src.commands) && src.commands.length) {
    return { ok: true, input: src };
  }
  if (surface === 'doc' && (src.text != null || src.src || src.item)) {
    return { ok: true, input: src };
  }
  if (surface === 'web' && (src.text != null || src.src || src.item || src.href || src.html)) {
    return { ok: true, input: src };
  }
  const p = officePayloadPath(src);
  if (!p) return { ok: true, input: src };
  if (looksLikeRemoteOrBoundImage(p) || looksLikeImageFile(p)) {
    return { ok: true, input: src };
  }
  if (surface === 'web' && /\.html?$/i.test(p)) {
    const loaded = readGuestText(fs, p, 'site');
    if (!loaded.ok) return loaded;
    if (!String(loaded.text || '').trim()) return emptyPayloadError('web');
    return { ok: true, input: { ...stripConsumedPath(src), commands: [{ op: 'replaceHtml', html: loaded.text }] } };
  }
  const json = readGuestJson(fs, p, surface);
  if (json.ok) {
    if (isEmptyObject(json.value) && typeof json.value !== 'string') return emptyPayloadError(surface);
    const mapped =
      surface === 'doc' ? commandsFromDocJson(json.value) : commandsFromWebJson(json.value);
    if (!mapped.ok) return mapped;
    return { ok: true, input: { ...stripConsumedPath(src), commands: mapped.commands } };
  }
  if (surface === 'web' && json.code === 'BAD_INPUT') {
    const text = readGuestText(fs, p, 'site');
    if (!text.ok) return text;
    if (looksLikeHtmlText(text.text)) {
      if (!String(text.text || '').trim()) return emptyPayloadError('web');
      return { ok: true, input: { ...stripConsumedPath(src), commands: [{ op: 'replaceHtml', html: text.text }] } };
    }
  }
  return json;
}

export function hydrateDocCommands(fs, commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  const out = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') {
      out.push(cmd);
      continue;
    }
    const op = String(cmd.op || cmd.type || '').trim();
    const p = officePayloadPath(cmd);
    if (op === 'createDocument' && isEmptyObject(cmd.blocks) && p) {
      const loaded = readGuestJson(fs, p, 'doc');
      if (!loaded.ok) return loaded;
      const mapped = commandsFromDocJson(loaded.value);
      if (!mapped.ok) return mapped;
      const seed = mapped.commands[0] || {};
      out.push({
        ...cmd,
        title: cmd.title || seed.title,
        blocks: seed.blocks || cmd.blocks,
        text: cmd.text != null ? cmd.text : seed.text
      });
      continue;
    }
    if (op === 'setText' && (cmd.text == null || cmd.text === '') && p) {
      const loaded = readGuestText(fs, p, 'doc');
      if (!loaded.ok) return loaded;
      if (!String(loaded.text || '').trim()) return emptyPayloadError('doc');
      out.push({ ...cmd, text: loaded.text });
      continue;
    }
    out.push(cmd);
  }
  return { ok: true, commands: out };
}

export function malformedDocWriteError(commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  const ops = new Set(['createDocument', 'insertParagraph', 'setText', 'insertImage', 'insertList']);
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: 'doc command is missing op',
        hint: 'each commands[] item needs op (setText / insertParagraph / createDocument / …)'
      };
    }
    const op = String(cmd.op || cmd.type || '').trim();
    if (!ops.has(op)) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: op ? `unknown doc op "${op}"` : 'doc command is missing op',
        hint: 'each commands[] item needs op (setText / insertParagraph / createDocument / …)'
      };
    }
  }
  return null;
}

export function malformedWebWriteError(commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  const ops = new Set([
    'setText',
    'setSlotText',
    'updateText',
    'setHref',
    'setSrc',
    'setSlotSrc',
    'remove',
    'delete',
    'removeNode',
    'duplicate',
    'replaceHtml',
    'setHtml'
  ]);
  for (const cmd of list) {
    if (!cmd || typeof cmd !== 'object') {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: 'web command is missing op',
        hint: 'each commands[] item needs op (setText / setHref / setSrc / replaceHtml / …)'
      };
    }
    const op = String(cmd.op || cmd.type || '').trim();
    if (!ops.has(op)) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: op ? `unknown web op "${op}"` : 'web command is missing op',
        hint: 'each commands[] item needs op (setText / setHref / setSrc / replaceHtml / …)'
      };
    }
    if ((op === 'replaceHtml' || op === 'setHtml') && !String(cmd.html || cmd.content || cmd.value || '').trim() && !officePayloadPath(cmd)) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: 'replaceHtml needs html or a guest path',
        hint: 'pass html, or path / from to /scratch or /artifacts HTML — do not retype'
      };
    }
  }
  return null;
}
