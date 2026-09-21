/**
 * Canonical payload hash for dispatch tickets and call journal.
 * Never include password / card / cookie / Authorization plaintext.
 */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return String(value);
}

export function canonicalPayload(input = {}) {
  const fields = Array.isArray(input.fields)
    ? input.fields.map((field) => ({
        ref: field?.ref ? String(field.ref) : '',
        name: field?.name || field?.label ? String(field.name || field.label) : '',
        valueChars: field?.valueChars != null
          ? Number(field.valueChars)
          : field?.value != null ? String(field.value).length : 0,
        frameId: field?.frameId ?? null,
        frameUrl: field?.frameUrl || '',
        documentId: field?.documentId || ''
      }))
    : undefined;
  const code = input.code != null ? String(input.code) : '';
  return stableValue({
    channel: input.channel || '',
    op: input.op || '',
    act: input.act || '',
    ref: input.ref || '',
    name: input.name || input.label || '',
    key: input.key || '',
    ...(input.deltaY != null ? { deltaY: input.deltaY } : {}),
    url: input.frameUrl || input.url || '',
    frameUrl: input.frameUrl || '',
    method: input.method || '',
    sysOp: input.sysOp || input.sys?.op || '',
    valueChars: input.value != null ? String(input.value).length : 0,
    fields,
    codeChars: code ? code.length : 0,
    codeHash: input.codeHash || '',
    artifactId: input.artifactId || '',
    itemId: input.itemId || '',
    path: input.path || '',
    bytesHash: input.bytesHash || '',
    expectedRevision: input.expectedRevision ?? null,
    tabId: input.tabId ?? null,
    documentId: input.documentId || '',
    frameId: input.frameId ?? null
  });
}

export async function sha256Bytes(bytes) {
  const u8 = bytes instanceof Uint8Array
    ? bytes
    : bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new TextEncoder().encode(String(bytes || ''));
  if (globalThis.crypto?.subtle?.digest) {
    const buf = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(u8)).digest('hex');
}

export async function sha256Hex(text) {
  return sha256Bytes(new TextEncoder().encode(String(text || '')));
}

export async function hashOperationPayload(input = {}) {
  const extra = isPlainObject(input) ? input : {};
  let codeHash = extra.codeHash || '';
  if (!codeHash && extra.code != null && String(extra.code)) {
    codeHash = await sha256Hex(String(extra.code));
  }
  return sha256Hex(JSON.stringify(canonicalPayload({ ...extra, codeHash, code: undefined })));
}

export function newOperationId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newNonce() {
  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 32);
}
