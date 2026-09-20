/**
 * Durable skill overlay (user-authored + GitHub), merged with packaged registry.
 * Cross-session. Packaged folders stay the read-only source.
 */

import { parseSkillMd } from '../skills/parseSkillMd.js';
import { resolveSkillId, SKILL_ID_ALIASES } from '../skills/registry.js';
import { assertPublicHttpUrl } from '../primitives/netGuard.js';

export const SKILL_STORE_KEY = 'browserbot_durable_skills';
export const MAX_INSTRUCTION_CHARS = 64 * 1024;
export const MAX_RESOURCE_CHARS = 256 * 1024;
export const MAX_PACK_CHARS = 2 * 1024 * 1024;
const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export function createMemorySkillStore(seed = {}) {
  const map = new Map();
  for (const [id, rec] of Object.entries(seed || {})) {
    if (rec && rec.id) map.set(String(rec.id), cloneSkill(rec));
  }
  return {
    async list() {
      return [...map.values()].map(cloneSkill);
    },
    async get(id) {
      const raw = String(id || '');
      const hit =
        map.get(raw) ||
        map.get(resolveSkillId(raw)) ||
        findAliasOverlay(map, raw);
      return hit ? cloneSkill(hit) : null;
    },
    async upsert(rec) {
      const next = normalizeDurableSkill(rec);
      map.set(next.id, next);
      return cloneSkill(next);
    },
    async remove(id) {
      map.delete(String(id || ''));
      return { ok: true };
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, cloneSkill(v)]));
    }
  };
}

export function normalizeDurableSkill(input = {}) {
  const id = sanitizeSkillId(input.id || input.name);
  if (!id) throw new Error('skill id required (lowercase kebab-case)');
  const description = String(input.description || '').trim();
  if (!description) throw new Error('skill description required');
  const instructions = String(input.instructions || '').trim();
  if (instructions.length > MAX_INSTRUCTION_CHARS) {
    throw new Error('skill instructions too large');
  }
  const resources = {};
  let pack = instructions.length;
  const rawRes = input.resources && typeof input.resources === 'object' ? input.resources : {};
  for (const [path, body] of Object.entries(rawRes)) {
    const p = sanitizeResourcePath(path);
    if (!p) continue;
    const text = String(body ?? '');
    if (text.length > MAX_RESOURCE_CHARS) throw new Error(`skill resource too large: ${p}`);
    pack += text.length;
    if (pack > MAX_PACK_CHARS) throw new Error('skill pack too large');
    resources[p] = text;
  }
  const origin = ['overlay', 'github', 'authored', 'learned'].includes(input.origin)
    ? input.origin
    : 'authored';
  const rec = {
    id,
    name: String(input.name || id).trim().slice(0, 80) || id,
    description: description.slice(0, 500),
    instructions,
    resources,
    origin,
    sourceUrl: input.sourceUrl ? String(input.sourceUrl).slice(0, 2000) : '',
    updatedAt: Number(input.updatedAt) || Date.now()
  };
  if (origin === 'learned' || input.learned === true) {
    rec.learned = true;
    rec.taskClass = String(input.taskClass || '').trim().slice(0, 80);
    rec.reuseConfirmed = input.reuseConfirmed === true;
  }
  return rec;
}

export function skillRecordFromMarkdown(id, md, extra = {}) {
  const { meta, body } = parseSkillMd(md);
  return normalizeDurableSkill({
    id: extra.id || meta.id || id,
    name: extra.name || meta.name || id,
    description: extra.description || meta.description,
    instructions: body,
    resources: extra.resources,
    origin: extra.origin || 'authored',
    sourceUrl: extra.sourceUrl || ''
  });
}

export function sanitizeSkillId(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return ID_RE.test(s) ? s : '';
}

export function sanitizeResourcePath(raw) {
  const s = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.includes('..') || s.startsWith('/') || s.includes(':')) return '';
  if (!/^(scripts|templates|references|assets)\/[A-Za-z0-9._/-]+$/.test(s) && !/^SKILL\.md$/i.test(s)) {
    if (!/^[A-Za-z0-9._/-]+$/.test(s)) return '';
  }
  return s.slice(0, 180);
}

export function mergeSkillCatalog(packaged, durable) {
  const byId = new Map();
  for (const s of packaged || []) {
    if (!s?.id) continue;
    byId.set(s.id, {
      id: s.id,
      name: s.name || s.id,
      description: s.description || '',
      resourcePaths: Array.isArray(s.resourcePaths) ? s.resourcePaths.slice() : Object.keys(s.resources || {}),
      origin: 'packaged'
    });
  }
  for (const s of durable || []) {
    if (!s?.id) continue;
    const id = resolveSkillId(s.id);
    const base = byId.get(id) || {};
    byId.set(id, {
      id,
      name: s.name || base.name || s.id,
      description: s.description || base.description || '',
      resourcePaths: Object.keys(s.resources || {}).length
        ? Object.keys(s.resources)
        : base.resourcePaths || [],
      origin: base.origin === 'packaged' ? 'overlay' : s.origin || 'authored',
      sourceUrl: s.sourceUrl || ''
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeSkillRecord(packaged, durable) {
  if (!packaged && !durable) return null;
  if (!durable) {
    return {
      ...packaged,
      origin: 'packaged',
      resources: packaged.resources || {},
      instructions:
        typeof packaged.instructions === 'function' ? packaged.instructions() : packaged.instructions
    };
  }
  if (!packaged) return { ...durable };
  const inst =
    durable.instructions != null && String(durable.instructions).trim()
      ? durable.instructions
      : typeof packaged.instructions === 'function'
        ? packaged.instructions()
        : packaged.instructions;
  return {
    ...packaged,
    name: durable.name || packaged.name,
    description: durable.description || packaged.description,
    instructions: inst,
    resources: { ...(packaged.resources || {}), ...(durable.resources || {}) },
    origin: 'overlay',
    sourceUrl: durable.sourceUrl || ''
  };
}

const RESOURCE_DIR_RE = /^(scripts|templates|references|assets)(\/|$)/;
const MAX_GITHUB_FILES = 40;
const MAX_GITHUB_DEPTH = 3;

export function githubSkillUrls(rawUrl) {
  const gate = assertPublicHttpUrl(rawUrl);
  if (!gate.ok) return gate;
  const u = gate.url;
  const host = u.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    const user = parts[0];
    const repo = parts[1];
    const branch = parts[2] || 'HEAD';
    if (!user || !repo) return { ok: true, rawSkillMd: u.href, pageUrl: u.href };
    const rest = parts.slice(3).join('/');
    const dir = rest.replace(/\/SKILL\.md$/i, '');
    return {
      ok: true,
      rawSkillMd: u.href,
      pageUrl: u.href,
      user,
      repo,
      branch,
      apiContents: dir ? `${user}/${repo}/${dir}` : `${user}/${repo}`
    };
  }
  if (host !== 'github.com') {
    return { ok: false, error: 'only github.com or raw.githubusercontent.com', code: 'NET_DENIED' };
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const user = parts[0];
  const repo = parts[1];
  if (!user || !repo) return { ok: false, error: 'github url needs owner/repo', code: 'NET_DENIED' };
  let branch = 'HEAD';
  let sub = '';
  if (parts[2] === 'tree' && parts[3]) {
    branch = parts[3];
    sub = parts.slice(4).join('/');
  } else if (parts[2] === 'blob' && parts[3]) {
    branch = parts[3];
    sub = parts.slice(4).join('/');
  }
  const base = `https://raw.githubusercontent.com/${user}/${repo}/${branch}`;
  const dir = sub.replace(/\/SKILL\.md$/i, '');
  const rawSkillMd = dir ? `${base}/${dir}/SKILL.md` : `${base}/SKILL.md`;
  return {
    ok: true,
    rawSkillMd,
    apiContents: dir ? `${user}/${repo}/${dir}` : `${user}/${repo}`,
    branch,
    user,
    repo
  };
}

export async function importSkillFromUrl(url, opts = {}) {
  const mapped = githubSkillUrls(url);
  if (!mapped.ok) return mapped;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const signal = opts.signal;
  const mdRes = await fetchImpl(mapped.rawSkillMd, { signal });
  if (!mdRes || !mdRes.ok) {
    const nested = await trySkillsSubfolder(mapped, fetchImpl, signal, url, opts);
    if (nested) return nested;
    return { ok: false, error: `SKILL.md not found (${mdRes?.status || 0})` };
  }
  const md = await mdRes.text();
  if (!String(md).trim()) return { ok: false, error: 'empty SKILL.md' };
  const idGuess =
    opts.id || sanitizeSkillId(idFromRawPath(mapped.rawSkillMd)) || sanitizeSkillId(mapped.repo);
  const resources = await maybeFetchGithubDir(mapped, fetchImpl, signal);
  const rec = skillRecordFromMarkdown(idGuess, md, {
    origin: 'github',
    sourceUrl: String(url),
    resources
  });
  return { ok: true, skill: rec };
}

async function trySkillsSubfolder(mapped, fetchImpl, signal, sourceUrl, opts = {}) {
  if (!mapped.user || !mapped.repo) return null;
  const rootKey = `${mapped.user}/${mapped.repo}`;
  if (mapped.apiContents && mapped.apiContents !== rootKey) return null;
  const ref = mapped.branch || 'HEAD';
  const api = `https://api.github.com/repos/${mapped.user}/${mapped.repo}/contents/skills?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await fetchImpl(api, {
      signal,
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res?.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    const dirs = list.filter((e) => e?.type === 'dir' && e.name).slice(0, 20);
    const hits = [];
    for (const d of dirs) {
      const mdUrl = `https://raw.githubusercontent.com/${mapped.user}/${mapped.repo}/${ref}/skills/${d.name}/SKILL.md`;
      const mdRes = await fetchImpl(mdUrl, { signal });
      if (!mdRes?.ok) continue;
      const md = await mdRes.text();
      if (!String(md).trim()) continue;
      hits.push({ name: d.name, md, dir: `skills/${d.name}` });
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `repo has multiple skills (${hits.map((h) => h.name).join(', ')}); paste a folder URL`
      };
    }
    if (hits.length !== 1) return null;
    const hit = hits[0];
    const nested = {
      ...mapped,
      apiContents: `${mapped.user}/${mapped.repo}/${hit.dir}`,
      rawSkillMd: `https://raw.githubusercontent.com/${mapped.user}/${mapped.repo}/${ref}/${hit.dir}/SKILL.md`
    };
    const resources = await maybeFetchGithubDir(nested, fetchImpl, signal);
    const rec = skillRecordFromMarkdown(opts.id || sanitizeSkillId(hit.name), hit.md, {
      origin: 'github',
      sourceUrl: String(sourceUrl || ''),
      resources
    });
    return { ok: true, skill: rec };
  } catch {
    return null;
  }
}

async function maybeFetchGithubDir(mapped, fetchImpl, signal) {
  const resources = {};
  if (!mapped.user || !mapped.repo) return resources;
  const dir = String(mapped.apiContents || '')
    .replace(`${mapped.user}/${mapped.repo}`, '')
    .replace(/^\//, '');
  await fetchGithubListing(mapped, dir, fetchImpl, signal, resources, 0);
  return resources;
}

function skillRelPath(mapped, filePath) {
  const root = String(mapped.apiContents || '')
    .replace(`${mapped.user}/${mapped.repo}`, '')
    .replace(/^\//, '');
  const name = String(filePath || '').replace(/^\/+/, '');
  if (!root) return name;
  if (name === root) return '';
  if (name.startsWith(`${root}/`)) return name.slice(root.length + 1);
  return name;
}

async function fetchGithubListing(mapped, dir, fetchImpl, signal, resources, depth) {
  if (depth > MAX_GITHUB_DEPTH) return;
  if (Object.keys(resources).length >= MAX_GITHUB_FILES) return;
  const ref = mapped.branch || 'HEAD';
  const api = dir
    ? `https://api.github.com/repos/${mapped.user}/${mapped.repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${mapped.user}/${mapped.repo}/contents?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await fetchImpl(api, {
      signal,
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res?.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    for (const ent of list) {
      if (Object.keys(resources).length >= MAX_GITHUB_FILES) return;
      const name = String(ent.path || ent.name || '');
      const rel = skillRelPath(mapped, name);
      if (ent.type === 'dir') {
        const folder = String(ent.name || rel.split('/')[0] || '');
        const allow = depth > 0 || RESOURCE_DIR_RE.test(folder) || RESOURCE_DIR_RE.test(rel);
        if (!allow) continue;
        await fetchGithubListing(mapped, name, fetchImpl, signal, resources, depth + 1);
        continue;
      }
      if (ent.type !== 'file' || !ent.download_url) continue;
      const p = sanitizeResourcePath(rel);
      if (!p || /^SKILL\.md$/i.test(p)) continue;
      if (Number(ent.size) > MAX_RESOURCE_CHARS) continue;
      const fileRes = await fetchImpl(ent.download_url, { signal });
      if (!fileRes?.ok) continue;
      const text = await fileRes.text();
      if (text.length <= MAX_RESOURCE_CHARS) resources[p] = text;
    }
  } catch {
    /* SKILL.md alone is enough */
  }
}

/**
 * Write a skill pack (playbook + resources/scripts) into guest /scratch for run sandbox.
 */
export function writeSkillPackToGuest(fs, rec) {
  if (!fs || typeof fs.writeFile !== 'function' || !rec?.id) return;
  const root = `/scratch/skills/${rec.id}`;
  try {
    fs.mkdirp(root);
    const inst = rec.instructions;
    const text = typeof inst === 'function' ? inst() : inst;
    if (text) fs.writeFile(`${root}/SKILL.md`, String(text));
    for (const [p, body] of Object.entries(rec.resources || {})) {
      const rel = sanitizeResourcePath(p) || p;
      if (!rel) continue;
      const dir = rel.includes('/') ? `${root}/${rel.split('/').slice(0, -1).join('/')}` : root;
      fs.mkdirp(dir);
      fs.writeFile(`${root}/${rel}`, String(body ?? ''));
    }
  } catch {
    /* hydrate must not fail run */
  }
}

function findAliasOverlay(map, id) {
  const raw = String(id || '');
  const canonical = resolveSkillId(raw);
  for (const [alias, target] of Object.entries(SKILL_ID_ALIASES)) {
    if (target === canonical && map.has(alias)) return map.get(alias);
    if (alias === raw && map.has(target)) return map.get(target);
  }
  return null;
}

function idFromRawPath(raw) {
  const parts = String(raw || '').split('/').filter(Boolean);
  const i = parts.findIndex((p) => /^SKILL\.md$/i.test(p));
  if (i <= 0) return '';
  const parent = parts[i - 1];
  if (!/^(HEAD|main|master|develop|trunk)$/i.test(parent)) return parent;
  return i > 1 ? parts[i - 2] : '';
}

function cloneSkill(rec) {
  return {
    ...rec,
    resources: rec.resources && typeof rec.resources === 'object' ? { ...rec.resources } : {}
  };
}

let activeStore = createMemorySkillStore();

export function getDurableSkillStore() {
  return activeStore;
}

export function setDurableSkillStore(store) {
  if (store) activeStore = store;
  return activeStore;
}

export async function hydrateDurableSkillsFromChrome() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return getDurableSkillStore();
  try {
    const bag = await chrome.storage.local.get(SKILL_STORE_KEY);
    const raw = bag?.[SKILL_STORE_KEY];
    const seed = raw && typeof raw === 'object' ? raw : {};
    const mem = createMemorySkillStore(seed);
    const wrapped = {
      list: () => mem.list(),
      get: (id) => mem.get(id),
      snapshot: () => mem.snapshot(),
      async upsert(rec) {
        const saved = await mem.upsert(rec);
        await chrome.storage.local.set({ [SKILL_STORE_KEY]: mem.snapshot() });
        return saved;
      },
      async remove(id) {
        const r = await mem.remove(id);
        await chrome.storage.local.set({ [SKILL_STORE_KEY]: mem.snapshot() });
        return r;
      }
    };
    setDurableSkillStore(wrapped);
    return wrapped;
  } catch {
    return getDurableSkillStore();
  }
}
