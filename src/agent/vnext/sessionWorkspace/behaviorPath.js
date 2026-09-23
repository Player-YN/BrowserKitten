/**
 * Session trajectory: causal audit of the **agent run** (chat + model + tools + host).
 * Events are occurrence order. tool-result is never written back onto tool-call.
 * Thought / visible text are first-class path events (not an 8k smear).
 * User edits in live office canvases (preview `updateArtifact`) never enter this log.
 */

import { TRAJECTORY_SCHEMA as BEHAVIOR_TRAJECTORY_SCHEMA } from '../../../brand.js';
import { projectJsonForWire, projectWireForDownload } from './wireTranscript.js';
import { harvestModelUsage } from './contextCompact.js';
import { SESSION_AUDIT_SCHEMA, TRAJECTORY_THOUGHT_WARNING } from './sessionAudit.js';

export { BEHAVIOR_TRAJECTORY_SCHEMA };

const OFFICE_TOOLS = new Set(['sheet', 'doc', 'web']);
const COMMAND_KEEP = [
  'op',
  'act',
  'a1',
  'sheet',
  'nodeId',
  'plateId',
  'slotId',
  'artifactId',
  'skillId',
  'id',
  'name',
  'path'
];
const RESULT_KEEP = [
  'ok',
  'artifactId',
  'act',
  'op',
  'view',
  'skillId',
  'origin',
  'dirty',
  'code',
  'error',
  'hint',
  'skipped',
  'path',
  'name',
  'guestRoot',
  'kind',
  'shell'
];
const GRID_WRITE_OPS = new Set(['setValues2d', 'applyGrid']);
const SLOT_WRITE_OPS = new Set(['replacePlate']);
const BLOCK_WRITE_OPS = new Set(['createDocument']);
const HTML_WRITE_OPS = new Set(['replaceHtml', 'setHtml']);
const PAYLOAD_MARKERS = new Set(['[omitted]', '[stripped]', '[path-hydrate]']);
const PREVIEW_CELLS = 12;

const MAX_BUBBLE_CHARS = 12000;
/** Per thought / mid-loop text event (and per-step model attachment). Tens of KB, not 8k. */
export const MAX_THOUGHT_CHARS = 48_000;
/** Concatenated assistant-bubble thought across a whole turn. */
export const MAX_TURN_THOUGHT_CHARS = 256_000;
const MAX_COMPACT_PREVIEW = 2000;

function slim(value) {
  return projectJsonForWire(value);
}

function clipStr(value, max = 200) {
  const s = value == null ? '' : String(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

function compactPage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const url = String(raw.url || '').trim().slice(0, 2000);
  if (!url) return undefined;
  const out = { url };
  if (raw.title) out.title = String(raw.title).slice(0, 120);
  if (raw.origin) out.origin = String(raw.origin).slice(0, 200);
  return out;
}

function compactMentions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && m.id)
    .slice(0, 32)
    .map((m) => ({
      kind: String(m.kind || 'group').slice(0, 24),
      id: String(m.id).slice(0, 96),
      ...(m.label ? { label: String(m.label).slice(0, 80) } : {}),
      ...(m.handle ? { handle: String(m.handle).slice(0, 40) } : {}),
      ...(m.url ? { url: String(m.url).slice(0, 2000) } : {})
    }));
}

function compactCanvases(canvases) {
  if (!canvases || typeof canvases !== 'object') return undefined;
  const out = {};
  for (const key of ['sheet', 'doc', 'web']) {
    const ids = Array.isArray(canvases[key]) ? canvases[key].map(String).slice(0, 20) : [];
    if (ids.length) out[key] = ids;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * What the model saw this turn — not the live canvas bytes, not user edits.
 * @param {object} [input]
 */
export function compactTurnContext(input = {}) {
  const tools = Array.isArray(input.tools) ? input.tools.map(String).slice(0, 16) : [];
  const skills = Array.isArray(input.skills)
    ? input.skills.slice(0, 40).map((s) => ({
        id: String(s.id || ''),
        ...(s.origin ? { origin: String(s.origin) } : {})
      }))
    : [];
  const mentions = compactMentions(input.mentions || input.focusedMentions);
  const ctx = {
    tools,
    canvases: compactCanvases(input.canvases),
    artifactCount: Number(input.artifactCount) || 0,
    boundGroupCount: Array.isArray(input.boundGroups)
      ? input.boundGroups.length
      : Number(input.boundGroupCount) || 0,
    boundItemCount: Number(input.boundItemCount) || 0
  };
  const focusPage = compactPage(input.focusPage);
  const activeTab = compactPage(input.activeTab);
  if (focusPage) ctx.focusPage = focusPage;
  if (activeTab) ctx.activeTab = activeTab;
  if (mentions.length) ctx.focusedMentions = mentions;
  if (skills.length) ctx.skills = skills;
  const html = input.activeHtml;
  if (html && html.artifactId) {
    ctx.activeHtml = {
      artifactId: String(html.artifactId),
      selections: (html.selections || html.overview?.selections || []).slice(0, 8).map((s) => ({
        ...(s.nodeId || s.id ? { nodeId: String(s.nodeId || s.id) } : {}),
        ...(s.plateId ? { plateId: String(s.plateId) } : {})
      }))
    };
  }
  const wb = input.activeWorkbook;
  if (wb && wb.artifactId) {
    const sels = wb.overview?.selections || (wb.overview?.selection ? [wb.overview.selection] : []);
    ctx.activeWorkbook = {
      artifactId: String(wb.artifactId),
      selections: sels.slice(0, 8).map((s) => ({
        ...(s.sheet ? { sheet: String(s.sheet) } : {}),
        ...(s.a1 ? { a1: String(s.a1) } : {})
      }))
    };
  }
  return ctx;
}

function commandGuestPath(cmd) {
  if (!cmd || typeof cmd !== 'object') return '';
  return String(cmd.path || cmd.from || cmd.valuesPath || cmd.scratchPath || '').trim();
}

function shortHash(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 2166136261;
  const n = Math.min(s.length, 8000);
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function previewCells(values, max = PREVIEW_CELLS) {
  const out = [];
  if (!Array.isArray(values)) return out;
  for (const row of values) {
    const cells = Array.isArray(row) ? row : [row];
    for (const cell of cells) {
      if (out.length >= max) return out;
      if (cell == null) out.push('');
      else if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
        out.push(typeof cell === 'string' ? clipStr(cell, 40) : cell);
      } else {
        out.push(clipStr(JSON.stringify(cell), 40));
      }
    }
  }
  return out;
}

function gridShape(values) {
  if (!Array.isArray(values)) return { rows: 0, cols: 0 };
  const rows = values.length;
  let cols = 0;
  for (const row of values) {
    cols = Math.max(cols, Array.isArray(row) ? row.length : row == null ? 0 : 1);
  }
  return { rows, cols };
}

function keepPayloadMarker(out, raw, key, rowsKey, colsKey) {
  if (!PAYLOAD_MARKERS.has(raw[key])) return false;
  out[key] = raw[key];
  if (raw[rowsKey] != null) out[rowsKey] = Number(raw[rowsKey]) || 0;
  if (raw[colsKey] != null) out[colsKey] = Number(raw[colsKey]) || 0;
  const countKey = `${key}Count`;
  if (raw[countKey] != null) out[countKey] = Number(raw[countKey]) || 0;
  const previewKey = `${key}Preview`;
  const hashKey = `${key}Hash`;
  if (Array.isArray(raw[previewKey])) out[previewKey] = raw[previewKey].slice(0, PREVIEW_CELLS);
  if (raw[hashKey]) out[hashKey] = String(raw[hashKey]).slice(0, 16);
  return true;
}

function annotateWritePayload(out, cmd) {
  const op = String(out.op || cmd.op || cmd.type || '');
  const path = commandGuestPath(cmd);
  if (path) out.path = clipStr(path, 80);

  const hasValues = Object.prototype.hasOwnProperty.call(cmd, 'values');
  const hasSlots = Object.prototype.hasOwnProperty.call(cmd, 'slots');
  const hasBlocks = Object.prototype.hasOwnProperty.call(cmd, 'blocks');
  const html = cmd.html ?? cmd.content;
  const hasHtml = html != null && String(html) !== '';
  const gridOp = GRID_WRITE_OPS.has(op);
  const slotOp = SLOT_WRITE_OPS.has(op);
  const blockOp = BLOCK_WRITE_OPS.has(op);
  const htmlOp = HTML_WRITE_OPS.has(op);
  const writeLike = gridOp || slotOp || blockOp || htmlOp || hasValues || hasSlots || hasBlocks || hasHtml;

  if (writeLike) {
    if (path) out.source = 'path';
    else if (hasValues || hasSlots || hasBlocks || hasHtml) out.source = 'inline';
  }

  if (hasValues || gridOp) {
    if (!keepPayloadMarker(out, cmd, 'values', 'valuesRows', 'valuesCols')) {
      if (Array.isArray(cmd.values)) {
        const { rows, cols } = gridShape(cmd.values);
        out.valuesRows = rows;
        out.valuesCols = cols;
        out.valuesPreview = previewCells(cmd.values);
        out.valuesHash = shortHash(cmd.values);
        out.values = '[stripped]';
        if (!path) out.source = 'inline';
      } else if (path) {
        out.values = '[path-hydrate]';
        out.source = 'path';
      } else {
        out.values = '[omitted]';
      }
    } else if (!out.source) {
      out.source = path ? 'path' : 'inline';
    }
  }

  if (hasSlots || slotOp) {
    if (!keepPayloadMarker(out, cmd, 'slots', 'slotsRows', 'slotsCols')) {
      const slots = cmd.slots;
      if (slots && typeof slots === 'object') {
        const keys = Array.isArray(slots) ? slots.length : Object.keys(slots).length;
        out.slotsCount = keys;
        const sample = Array.isArray(slots)
          ? slots.slice(0, PREVIEW_CELLS).map((s) => clipStr(typeof s === 'string' ? s : JSON.stringify(s), 40))
          : Object.keys(slots).slice(0, PREVIEW_CELLS);
        out.slotsPreview = sample;
        out.slotsHash = shortHash(slots);
        out.slots = '[stripped]';
        if (!path) out.source = 'inline';
      } else if (path) {
        out.slots = '[path-hydrate]';
        out.source = 'path';
      } else if (slotOp) {
        out.slots = '[omitted]';
      }
    }
  }

  if (hasBlocks || blockOp) {
    if (!keepPayloadMarker(out, cmd, 'blocks', 'blocksRows', 'blocksCols')) {
      if (Array.isArray(cmd.blocks)) {
        out.blocksCount = cmd.blocks.length;
        out.blocksPreview = cmd.blocks.slice(0, PREVIEW_CELLS).map((b) =>
          clipStr(typeof b === 'string' ? b : String(b?.type || b?.text || JSON.stringify(b)), 40)
        );
        out.blocksHash = shortHash(cmd.blocks);
        out.blocks = '[stripped]';
        if (!path) out.source = 'inline';
      } else if (path) {
        out.blocks = '[path-hydrate]';
        out.source = 'path';
      } else if (blockOp) {
        out.blocks = '[omitted]';
      }
    }
  }

  if (hasHtml || htmlOp) {
    if (typeof html === 'string' && PAYLOAD_MARKERS.has(html)) {
      out.html = html;
      if (cmd.htmlChars != null) out.htmlChars = Number(cmd.htmlChars) || 0;
      if (cmd.htmlHash) out.htmlHash = String(cmd.htmlHash).slice(0, 16);
    } else if (hasHtml) {
      const s = String(html);
      out.htmlChars = s.length;
      out.htmlHash = shortHash(s);
      out.html = '[stripped]';
      if (!path) out.source = 'inline';
    } else if (path) {
      out.html = '[path-hydrate]';
      out.source = 'path';
    } else if (htmlOp) {
      out.html = '[omitted]';
    }
  }

  if (cmd.source === 'inline' || cmd.source === 'path') out.source = cmd.source;
}

function compactCommands(commands) {
  if (!Array.isArray(commands)) return undefined;
  return commands.slice(0, 40).map((c) => {
    if (!c || typeof c !== 'object') return { op: String(c) };
    const out = {};
    for (const k of COMMAND_KEEP) {
      if (c[k] != null && c[k] !== '') out[k] = clipStr(c[k], 80);
    }
    if (!out.op && c.type) out.op = clipStr(c.type, 80);
    if (c.text != null) out.text = clipStr(c.text, 200);
    if (c.value != null && (typeof c.value === 'string' || typeof c.value === 'number')) {
      out.value = clipStr(c.value, 200);
    } else if (c.value != null) {
      out.value = '[omitted]';
    }
    if (c.src) out.src = clipStr(c.src, 80);
    annotateWritePayload(out, c);
    return out;
  });
}

function officeSurface(tool, args, result) {
  const name = String(tool || '');
  if (OFFICE_TOOLS.has(name)) return name;
  const op = String(args?.op || result?.op || '');
  if (name === 'run') {
    if (op === 'skill') return 'skill';
    if (op === 'sheet' || op === 'doc') return op;
    if (op === 'ingestPdf') return 'doc';
    if (op === 'write_artifact' || op === 'update_artifact') return 'artifact';
  }
  if (name === 'inspect') {
    const view = String(args?.view || result?.view || '');
    if (view === 'skill' || view === 'skills') return 'skill';
    if (view === 'workbook' || view === 'range') return 'sheet';
  }
  return undefined;
}

function slimToolArgs(tool, raw) {
  const parsed = asArgsRaw(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return slim(parsed);
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null) continue;
    if (k === 'commands') {
      out.commands = compactCommands(v);
      continue;
    }
    if (k === 'values' || k === 'slots' || k === 'blocks') {
      const fake = compactCommands([{ op: k === 'values' ? 'setValues2d' : k === 'slots' ? 'replacePlate' : 'createDocument', [k]: v }]);
      const one = fake && fake[0];
      if (one) {
        if (k === 'values') {
          if (one.values != null) out.values = one.values;
          if (one.valuesRows != null) out.valuesRows = one.valuesRows;
          if (one.valuesCols != null) out.valuesCols = one.valuesCols;
          if (one.valuesPreview) out.valuesPreview = one.valuesPreview;
          if (one.valuesHash) out.valuesHash = one.valuesHash;
        } else if (k === 'slots') {
          if (one.slots != null) out.slots = one.slots;
          if (one.slotsCount != null) out.slotsCount = one.slotsCount;
          if (one.slotsPreview) out.slotsPreview = one.slotsPreview;
        } else if (one.blocks != null) {
          out.blocks = one.blocks;
          if (one.blocksCount != null) out.blocksCount = one.blocksCount;
        }
        if (one.source) out.source = one.source;
      }
      continue;
    }
    if (k === 'code') {
      out.code = '[omitted]';
      out.codeChars = String(v).length;
      continue;
    }
    if (k === 'content' || k === 'instructions' || k === 'markdown' || k === 'html') {
      out[k] = clipStr(v, 400);
      continue;
    }
    if (k === 'files' && v && typeof v === 'object') {
      out.files = Object.keys(v).slice(0, 20);
      continue;
    }
    out[k] = slim(v);
  }
  return out;
}

function slimToolResult(tool, raw) {
  const value = unwrapToolResultRaw(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return slim(value);
  const surface = officeSurface(tool, {}, value);
  const officeLike =
    OFFICE_TOOLS.has(String(tool || '')) ||
    surface === 'skill' ||
    surface === 'canvas' ||
    surface === 'sheet' ||
    surface === 'doc' ||
    surface === 'artifact';
  if (!officeLike) return slim(value);
  const out = {};
  if (value.ok === false) out.ok = false;
  else if (value.ok === true) out.ok = true;
  for (const k of RESULT_KEEP) {
    if (value[k] != null && value[k] !== '') {
      out[k] = typeof value[k] === 'string' ? clipStr(value[k], 400) : slim(value[k]);
    }
  }
  if (value.readback && typeof value.readback === 'object') {
    const rb = {};
    for (const [k, v] of Object.entries(value.readback)) {
      if (v == null) continue;
      if (k === 'src' || k === 'html' || k === 'values' || k === 'rows') {
        rb[k] = typeof v === 'string' ? clipStr(v, 200) : slim(v);
      } else {
        rb[k] = slim(v);
      }
    }
    out.readback = rb;
  }
  if (Array.isArray(value.applied)) out.applied = compactCommands(value.applied);
  else if (value.applied != null && typeof value.applied === 'object') out.applied = compactCommands([value.applied]);
  else if (typeof value.applied === 'number') out.applied = value.applied;
  if (Array.isArray(value.available)) {
    out.available = value.available.slice(0, 40).map((x) =>
      typeof x === 'string' ? x : String(x?.id || x?.nodeId || x?.path || '')
    );
  }
  if (Array.isArray(value.resources)) {
    out.resources = value.resources.slice(0, 40).map((r) => (typeof r === 'string' ? r : r?.path)).filter(Boolean);
  }
  if (value.playbook != null) out.playbookChars = String(value.playbook).length;
  else if (value.playbookChars != null) out.playbookChars = Number(value.playbookChars) || 0;
  if (Array.isArray(value.catalog)) {
    out.catalog = value.catalog.slice(0, 40).map((s) => ({
      id: String(s.id || ''),
      ...(s.name ? { name: String(s.name).slice(0, 80) } : {})
    }));
  }
  if (Array.isArray(value.sheets)) {
    out.sheets = value.sheets.slice(0, 20).map((s) =>
      typeof s === 'string' ? s : String(s?.name || '')
    );
  }
  if (value.skill && typeof value.skill === 'object') {
    out.skill = {
      id: String(value.skill.id || ''),
      ...(value.skill.origin ? { origin: String(value.skill.origin) } : {})
    };
  }
  if (out.ok == null && Object.keys(out).length === 0) return slim(value);
  return out;
}

function decorateOfficeStep(out, tool, args, result) {
  const surface = officeSurface(tool, args, result);
  if (surface) out.surface = surface;
  const artifactId = args?.artifactId || result?.artifactId;
  if (artifactId) out.artifactId = String(artifactId);
  const act = args?.act || args?.op || result?.act || result?.op;
  if (act) out.act = clipStr(act, 40);
  const skillId = args?.skillId || args?.id || result?.skillId || result?.skill?.id;
  if (surface === 'skill' && skillId) out.skillId = String(skillId);
  return out;
}

function asArgsRaw(raw) {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* keep string */
      }
    }
    return raw;
  }
  return raw ?? {};
}

function unwrapToolResultRaw(raw) {
  if (raw && typeof raw === 'object' && raw.type === 'json' && 'value' in raw) {
    return raw.value;
  }
  return raw ?? null;
}

export function isoTime(ms) {
  if (typeof ms === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ms)) return ms;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

export function intMs(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return undefined;
  return Math.round(v);
}

export function finishReasonOf(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') {
    if (value === '[object Object]') return undefined;
    return value.slice(0, 80);
  }
  if (typeof value === 'object') {
    const u = value.unified ?? value.reason ?? value.type;
    if (typeof u === 'string' && u) return u.slice(0, 80);
  }
  return undefined;
}

function nowTs(ev) {
  const n = Number(ev?.ts);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function asArgs(raw) {
  return slim(asArgsRaw(raw));
}

function unwrapToolResult(raw) {
  return slim(unwrapToolResultRaw(raw));
}

function resultOk(result, ev) {
  if (ev && ev.ok === false) return false;
  if (result && typeof result === 'object' && result.ok === false) return false;
  return ev?.ok !== false;
}

function copyTiming(out, step) {
  if (!out || !step) return out;
  const ts = isoTime(step.ts ?? step.startedAt ?? step.endedAt);
  if (ts) out.ts = ts;
  const started = isoTime(step.startedAt);
  const ended = isoTime(step.endedAt);
  if (started) out.startedAt = started;
  if (ended) out.endedAt = ended;
  const lat = intMs(step.latencyMs);
  if (lat != null) out.latencyMs = lat;
  const inf = intMs(step.inferenceMs);
  if (inf != null) out.inferenceMs = inf;
  if (step.usage && typeof step.usage === 'object') out.usage = harvestModelUsage(step.usage);
  if (step.model) out.model = String(step.model);
  if (step.provider) out.provider = String(step.provider);
  if (step.synthetic === true) out.synthetic = true;
  return out;
}

function sumToolMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 0;
  let n = 0;
  for (const v of Object.values(map)) n += Number(v) || 0;
  return n;
}

/**
 * Three clocks for a turn: agent inference, tool/host execute, wall total.
 * `model.latencyMs` is inference-only on new recordings. Legacy rows stored
 * SDK stepTimeMs (inference+tools); those are split by subtracting following tools.
 * @param {Array<object>|undefined} events
 * @param {number|undefined} totalFallback wall-clock ms
 */
export function splitTurnTiming(events, totalFallback) {
  let inferenceMs = 0;
  let toolMs = 0;
  const list = Array.isArray(events) ? events : [];
  let i = 0;
  while (i < list.length) {
    const e = list[i];
    if (e?.type === 'model') {
      let followingTool = 0;
      let j = i + 1;
      while (j < list.length && list[j]?.type !== 'model') {
        if (list[j]?.type === 'tool-result') followingTool += intMs(list[j].latencyMs) || 0;
        j += 1;
      }
      const storedInf = intMs(e.inferenceMs);
      const lat = intMs(e.latencyMs);
      if (storedInf != null) inferenceMs += storedInf;
      else if (lat != null && followingTool > 0 && lat >= followingTool) {
        inferenceMs += lat - followingTool;
      } else if (lat != null) {
        inferenceMs += lat;
      }
      toolMs += followingTool;
      i = j;
      continue;
    }
    if (e?.type === 'tool-result') toolMs += intMs(e.latencyMs) || 0;
    i += 1;
  }
  const totalMs = intMs(totalFallback);
  return {
    inferenceMs,
    toolMs,
    totalMs: totalMs != null ? totalMs : inferenceMs + toolMs
  };
}

function inferenceMsFromModelEnd(ev, step) {
  const perf = ev?.performance && typeof ev.performance === 'object' ? ev.performance : {};
  const responseMs = intMs(perf.responseTimeMs);
  if (responseMs != null) return responseMs;
  const stepMs = intMs(perf.stepTimeMs);
  const toolSum = sumToolMap(perf.toolExecutionMs);
  if (stepMs != null && toolSum > 0) return Math.max(0, stepMs - toolSum);
  if (step?.generatedAt != null && step?.startedAt != null) {
    const wall = Number(step.generatedAt) - Number(step.startedAt);
    if (Number.isFinite(wall) && wall >= 0) return Math.round(wall);
  }
  if (toolSum === 0) {
    const given = intMs(ev.latencyMs);
    if (given != null) return given;
    if (stepMs != null) return stepMs;
  }
  if (step?.startedAt != null) {
    const ts = nowTs(ev);
    return Math.max(0, ts - Number(step.startedAt));
  }
  return intMs(ev.latencyMs) ?? 0;
}

function slimEvent(step) {
  if (!step || typeof step !== 'object') return step;
  const type = String(step.type || '');
  if (type === 'turn-context') {
    const ctx = compactTurnContext(step);
    const ts = isoTime(step.ts);
    return ts ? { type: 'turn-context', ...ctx, ts } : { type: 'turn-context', ...ctx };
  }
  if (type === 'tool-call' || type === 'tool') {
    const tool = String(step.tool || step.name || 'tool');
    const args = slimToolArgs(tool, step.args ?? step.input ?? {});
    const resultHint = unwrapToolResultRaw(step.result);
    return copyTiming(
      decorateOfficeStep(
        {
          type: 'tool-call',
          tool,
          toolCallId: step.toolCallId ? String(step.toolCallId) : '',
          args
        },
        tool,
        args,
        resultHint
      ),
      step
    );
  }
  if (type === 'tool-result') {
    const tool = String(step.tool || step.name || 'tool');
    const args = slimToolArgs(tool, step.args ?? step.input ?? {});
    const result = slimToolResult(tool, step.result);
    return copyTiming(
      decorateOfficeStep(
        {
          type: 'tool-result',
          tool,
          toolCallId: step.toolCallId ? String(step.toolCallId) : '',
          ok: step.ok !== false,
          result
        },
        tool,
        args,
        result
      ),
      step
    );
  }
  if (type === 'thought') {
    const text = String(step.text || step.thought || '').trim();
    if (!text) return null;
    return copyTiming({ type: 'thought', text: clipBubble(text, MAX_TURN_THOUGHT_CHARS) }, step);
  }
  if (type === 'text') {
    const text = String(step.text || step.content || step.chunk || '').trim();
    if (!text) return null;
    return copyTiming({ type: 'text', text: clipBubble(text, MAX_TURN_THOUGHT_CHARS) }, step);
  }
  if (type === 'plan-pinned') {
    const plan = step.plan && typeof step.plan === 'object' ? slim(step.plan) : undefined;
    return copyTiming({ type: 'plan-pinned', ...(plan ? { plan } : {}) }, step);
  }
  if (type === 'model') {
    const out = copyTiming(
      {
        type: 'model',
        name: 'llm',
        index: step.index != null ? Number(step.index) : undefined
      },
      step
    );
    const fr = finishReasonOf(step.finishReason);
    if (fr) out.finishReason = fr;
    return out;
  }
  if (type === 'host') {
    const out = { type: 'host', name: String(step.name || 'host') };
    for (const [k, v] of Object.entries(step)) {
      if (
        k === 'type' ||
        k === 'name' ||
        k === 'dataUrl' ||
        k === 'bytes' ||
        k === 'imageBase64' ||
        k === 'usage' ||
        k === 'thought'
      ) {
        continue;
      }
      out[k] = slim(v);
    }
    return copyTiming(out, step);
  }
  if (type === 'error') {
    return {
      type: 'error',
      name: step.name ? String(step.name) : 'Error',
      message: step.message ? String(step.message).slice(0, 400) : '',
      code: step.code != null && step.code !== '' ? String(step.code) : undefined,
      statusCode: step.statusCode != null ? Number(step.statusCode) : undefined,
      ok: false,
      ts: isoTime(step.ts) || undefined
    };
  }
  if (type === 'assistant-final') {
    return {
      type: 'assistant-final',
      content: clipBubble(step.content || ''),
      ts: isoTime(step.ts) || undefined
    };
  }
  if (
    type === 'task-lifecycle' ||
    type === 'lease' ||
    type === 'abort' ||
    type === 'stale-ref' ||
    type === 'action-outcome'
  ) {
    return compactAuditFact(type, step, isoTime(step.ts) || step.ts);
  }
  return slim(step);
}

function findOpenCall(pathLog, name, id) {
  for (let i = pathLog.length - 1; i >= 0; i--) {
    const p = pathLog[i];
    if (p.type !== 'tool-call' && p.type !== 'tool') continue;
    if (id && p.toolCallId && String(p.toolCallId) === String(id)) return p;
    if ((p.tool || p.name) === name) return p;
  }
  return null;
}

function findOpenModel(pathLog) {
  for (let i = pathLog.length - 1; i >= 0; i--) {
    if (pathLog[i].type === 'model' && pathLog[i].endedAt == null) return pathLog[i];
  }
  return null;
}

function streamPiece(ev) {
  const piece = ev?.text != null ? ev.text : ev?.chunk;
  if (typeof piece !== 'string' || !piece || piece === '[object Object]') return '';
  return piece;
}

function appendNarrativeEvent(pathLog, type, piece, ts) {
  const last = pathLog[pathLog.length - 1];
  if (last && last.type === type) {
    last.text = `${last.text || ''}${piece}`;
    last.ts = ts;
    return last;
  }
  const row = { type, text: piece, ts };
  pathLog.push(row);
  return row;
}

/**
 * Reconstruct tool-call then tool-result from stored toolCalls (old sessions).
 * @param {Array<object>} [toolCalls]
 */
export function pathFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  const out = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const tool = String(tc.toolName || tc.name || 'tool');
    const toolCallId = String(tc.toolCallId || tc.id || `call_${i}`);
    out.push({
      type: 'tool-call',
      tool,
      toolCallId,
      args: asArgs(tc.args ?? tc.input ?? tc.arguments ?? {})
    });
    const result = unwrapToolResult(tc.result ?? tc.output ?? null);
    out.push({
      type: 'tool-result',
      tool,
      toolCallId,
      ok: resultOk(result, tc),
      result
    });
  }
  return out;
}

/**
 * Reconstruct occurrence-order tool events from stored wire.
 * @param {Array<object>} [wire]
 */
export function pathFromWire(wire) {
  if (!Array.isArray(wire) || !wire.length) return [];
  const path = [];
  for (const msg of wire) {
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    const parts = Array.isArray(content)
      ? content
      : typeof content === 'string' && content
        ? [{ type: 'text', text: content }]
        : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'reasoning') {
        const text = String(part.text || '').trim();
        if (text) path.push({ type: 'thought', text });
        continue;
      }
      if (part.type === 'text' && Array.isArray(msg.content)) {
        const text = String(part.text || '').trim();
        if (text) path.push({ type: 'text', text });
        continue;
      }
      if (part.type === 'tool-call') {
        path.push({
          type: 'tool-call',
          tool: String(part.toolName || part.name || 'tool'),
          toolCallId: String(part.toolCallId || ''),
          args: asArgs(part.input ?? part.args ?? {})
        });
        continue;
      }
      if (part.type === 'tool-result') {
        const output = part.output ?? part.result ?? null;
        const value =
          output && typeof output === 'object' && output.type === 'json' && 'value' in output
            ? output.value
            : output;
        path.push({
          type: 'tool-result',
          tool: String(part.toolName || part.name || 'tool'),
          toolCallId: String(part.toolCallId || ''),
          ok: resultOk(value, part),
          result: slim(value)
        });
      }
    }
  }
  return path;
}

/**
 * Live event log wins (already occurrence order). Else derive call/result pairs.
 * @param {{ path?: Array<object>, toolCalls?: Array<object>, traces?: Array<object>, wire?: Array<object> }} [input]
 */
export function mergeBehaviorPath(input = {}) {
  const live = Array.isArray(input.path) ? input.path.filter(Boolean) : [];
  if (live.length) return live.map(slimEvent).filter(Boolean);
  // Wire is paired by toolCallId. toolCalls may have been stored with a
  // same-name fallback (two inspects → first result duplicated).
  const fromWire = pathFromWire(input.wire).map(slimEvent).filter(Boolean);
  if (fromWire.length) return fromWire;
  return pathFromToolCalls(input.toolCalls || input.traces).map(slimEvent).filter(Boolean);
}

/**
 * Record a live onEvent into a path buffer (sendMessage).
 * @param {Array<object>} pathLog
 * @param {object} ev
 */
export function recordBehaviorEvent(pathLog, ev) {
  if (!Array.isArray(pathLog) || !ev || typeof ev !== 'object') return;
  const type = String(ev.type || '');
  const ts = nowTs(ev);

  if (type === 'thought') {
    const piece = streamPiece(ev);
    if (!piece) return;
    appendNarrativeEvent(pathLog, 'thought', piece, ts);
    return;
  }

  if (type === 'text') {
    const piece = streamPiece(ev);
    if (!piece) return;
    appendNarrativeEvent(pathLog, 'text', piece, ts);
    return;
  }

  if (type === 'plan-pinned') {
    pathLog.push({
      type: 'plan-pinned',
      plan: slim(ev.plan || {}),
      ts
    });
    return;
  }

  if (type === 'clarify') {
    pathLog.push({
      type: 'clarify',
      clarifyId: String(ev.clarifyId || ''),
      questions: Array.isArray(ev.questions) ? slim(ev.questions) : [],
      ...(ev.kind === 'plan' || ev.plan
        ? { kind: 'plan', plan: slim(ev.plan || {}) }
        : {}),
      ts,
      startedAt: ts
    });
    return;
  }

  if (type === 'clarify-done') {
    const id = String(ev.clarifyId || '');
    let open = null;
    for (let i = pathLog.length - 1; i >= 0; i--) {
      if (pathLog[i].type === 'clarify' && (!id || String(pathLog[i].clarifyId) === id)) {
        open = pathLog[i];
        break;
      }
    }
    const latencyMs = open?.startedAt ? Math.max(0, ts - Number(open.startedAt)) : undefined;
    const decision = String(ev.decision || '').trim().slice(0, 24);
    const notes = String(ev.notes || ev.answers?.notes || '').trim();
    pathLog.push({
      type: 'clarify-done',
      clarifyId: id || open?.clarifyId || '',
      answers: ev.aborted ? undefined : slim(ev.answers || {}),
      aborted: ev.aborted === true,
      ...(ev.kind === 'plan' || open?.kind === 'plan'
        ? {
            kind: 'plan',
            approved: ev.approved === true,
            ...(decision ? { decision } : ev.approved === true ? { decision: 'approved' } : {}),
            ...(notes ? { notes: clipStr(notes, 400) } : {})
          }
        : {}),
      ts,
      endedAt: ts,
      latencyMs
    });
    return;
  }

  if (type === 'tool-call') {
    const model = findOpenModel(pathLog);
    if (model && model.generatedAt == null) model.generatedAt = ts;
    const tool = String(ev.name || ev.toolName || ev.tool || 'tool');
    pathLog.push({
      type: 'tool-call',
      tool,
      toolCallId: String(ev.toolCallId || ev.id || ''),
      args: slimToolArgs(tool, ev.args ?? ev.input ?? {}),
      ts,
      startedAt: ts
    });
    return;
  }

  if (type === 'tool-result') {
    const tool = String(ev.name || ev.toolName || ev.tool || 'tool');
    const id = String(ev.toolCallId || ev.id || '');
    const result = slimToolResult(tool, ev.result ?? ev.output ?? null);
    const call = findOpenCall(pathLog, tool, id);
    const given = Number(ev.latencyMs ?? ev.toolExecutionMs);
    const latencyMs =
      Number.isFinite(given) && given >= 0
        ? given
        : call?.startedAt
          ? Math.max(0, ts - Number(call.startedAt))
          : undefined;
    pathLog.push({
      type: 'tool-result',
      tool,
      toolCallId: id || call?.toolCallId || '',
      ok: resultOk(result, ev),
      result,
      ts,
      endedAt: ts,
      latencyMs
    });
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    if (tool === 'action') {
      pathLog.push(
        compactAuditFact(
          'action-outcome',
          {
            op: args.op || result?.op,
            ok: resultOk(result, ev),
            code: result?.code || ev.code,
            name: args.name,
            tabId: result?.tabId || ev.tabId,
            title: result?.title || ev.title
          },
          ts
        )
      );
      if (String(result?.code || ev.code || '') === 'STALE_REF') {
        pathLog.push(compactAuditFact('stale-ref', { op: args.op, recovered: false, name: args.name }, ts));
      }
      if (String(args.op || '') === 'snapshot' && resultOk(result, ev)) {
        pathLog.push(compactAuditFact('stale-ref', { op: 'snapshot', recovered: true }, ts));
      }
      if (String(result?.code || ev.code || '') === 'TAB_LEASED') {
        pathLog.push(
          compactAuditFact(
            'lease',
            {
              op: 'conflict',
              tabId: result?.tabId || ev.tabId,
              title: result?.title || ev.title,
              holderSessionId: result?.holderSessionId || ev.holderSessionId,
              code: 'TAB_LEASED'
            },
            ts
          )
        );
      }
    }
    if (tool === 'task') {
      pathLog.push(
        compactAuditFact(
          'task-lifecycle',
          {
            op: args.op || result?.op,
            status: result?.task?.status || result?.status,
            taskId: result?.task?.taskId || result?.taskId,
            nextAction: result?.task?.nextAction,
            dueAt: result?.task?.dueAt,
            ok: resultOk(result, ev)
          },
          ts
        )
      );
    }
    return;
  }

  if (type === 'tool-execution-end') {
    const id = String(ev.toolCallId || ev.id || '');
    const latencyMs = intMs(ev.latencyMs ?? ev.toolExecutionMs);
    if (latencyMs == null) return;
    for (let i = pathLog.length - 1; i >= 0; i--) {
      const p = pathLog[i];
      if (p.type === 'tool-result' && String(p.toolCallId) === id) {
        p.latencyMs = latencyMs;
        return;
      }
    }
    return;
  }

  if (type === 'model-start' || type === 'step') {
    pathLog.push({
      type: 'model',
      name: 'llm',
      index: ev.index != null ? Number(ev.index) : pathLog.filter((p) => p.type === 'model').length,
      model: ev.modelId || ev.model || '',
      ts,
      startedAt: ts
    });
    return;
  }

  if (type === 'model-end' || type === 'finish-step') {
    const step = findOpenModel(pathLog);
    const usage = harvestModelUsage(ev.usage);
    const perf = ev.performance && typeof ev.performance === 'object' ? ev.performance : {};
    const modelId = ev.modelId || ev.response?.modelId || ev.model || '';
    const fr = finishReasonOf(ev.finishReason);
    const inferenceMs = inferenceMsFromModelEnd(ev, step);
    if (step) {
      if (usage && usage.source !== 'none') step.usage = usage;
      if (modelId) step.model = String(modelId);
      if (fr) step.finishReason = fr;
      step.inferenceMs = inferenceMs;
      step.latencyMs = inferenceMs;
      if (step.generatedAt != null) step.endedAt = Number(step.generatedAt);
      else if (step.startedAt != null) step.endedAt = Number(step.startedAt) + inferenceMs;
      else step.endedAt = ts;
      const toolMs = perf.toolExecutionMs;
      if (toolMs && typeof toolMs === 'object') {
        for (const [id, ms] of Object.entries(toolMs)) {
          const row = [...pathLog]
            .reverse()
            .find((p) => p.type === 'tool-result' && String(p.toolCallId) === String(id));
          if (row) row.latencyMs = intMs(ms);
        }
      }
    } else {
      pathLog.push({
        type: 'model',
        name: 'llm',
        model: modelId,
        usage,
        ts,
        endedAt: ts,
        inferenceMs,
        latencyMs: inferenceMs,
        finishReason: fr
      });
    }
    return;
  }

  if (type === 'model-meta') {
    const step = findOpenModel(pathLog);
    if (step && (ev.modelId || ev.model)) step.model = String(ev.modelId || ev.model);
    return;
  }

  if (type === 'pixels') {
    pathLog.push({
      type: 'host',
      name: 'pixels',
      itemId: ev.itemId || '',
      ok: ev.ok !== false,
      source: ev.source || '',
      byteLength: Number(ev.byteLength) || 0,
      code: ev.code || undefined,
      error: ev.error ? String(ev.error).slice(0, 240) : undefined,
      ts,
      latencyMs: intMs(ev.latencyMs)
    });
    return;
  }

  if (type === 'image_request') {
    pathLog.push({
      type: 'host',
      name: 'image_request',
      model: ev.model || '',
      protocol: ev.protocol || '',
      host: ev.host || '',
      path: ev.path || '',
      mode: ev.mode || '',
      refCount: Number(ev.refCount) || 0,
      ts,
      startedAt: ts
    });
    return;
  }

  if (type === 'image_generated') {
    const req = [...pathLog].reverse().find((p) => p.type === 'host' && p.name === 'image_request');
    const latencyMs = intMs(ev.latencyMs) ?? (req?.startedAt ? Math.max(0, ts - Number(req.startedAt)) : undefined);
    pathLog.push({
      type: 'host',
      name: 'image',
      model: ev.model || '',
      mode: ev.mode || '',
      artifactId: ev.artifactId || '',
      path: ev.path || '',
      downloadName: ev.downloadName || ev.name || '',
      mimeType: ev.mimeType || '',
      byteLength: Number(ev.byteLength) || 0,
      ok: true,
      ts,
      endedAt: ts,
      latencyMs
    });
    if (req && req.latencyMs == null && req.startedAt) {
      req.endedAt = ts;
      req.latencyMs = latencyMs;
    }
    return;
  }

  if (type === 'image_error') {
    const req = [...pathLog].reverse().find((p) => p.type === 'host' && p.name === 'image_request');
    const latencyMs = intMs(ev.latencyMs) ?? (req?.startedAt ? Math.max(0, ts - Number(req.startedAt)) : undefined);
    pathLog.push({
      type: 'host',
      name: 'image_error',
      model: ev.model || '',
      host: ev.host || '',
      path: ev.path || '',
      status: ev.status != null ? Number(ev.status) : undefined,
      code: ev.code || 'IMAGE_HTTP',
      error: ev.error ? String(ev.error).slice(0, 400) : '',
      ok: false,
      ts,
      endedAt: ts,
      latencyMs
    });
    if (req && req.latencyMs == null && req.startedAt) {
      req.endedAt = ts;
      req.latencyMs = latencyMs;
    }
    return;
  }

  if (type === 'compacting' || type === 'compact-done') {
    pathLog.push({
      type: 'host',
      name: 'compact',
      promptTokens: Number(ev.promptTokens) || 0,
      contextWindow: Number(ev.contextWindow) || 0,
      throughMessageId: ev.throughMessageId || undefined,
      text: ev.text ? String(ev.text).slice(0, MAX_COMPACT_PREVIEW) : undefined,
      ts
    });
    return;
  }

  if (type === 'turn-context') {
    pathLog.push({
      type: 'turn-context',
      ...compactTurnContext(ev),
      ts
    });
    return;
  }

  if (type === 'html_canvas_updated') {
    pathLog.push({
      type: 'host',
      name: 'canvas_updated',
      artifactId: String(ev.artifactId || ''),
      source: 'agent',
      ts
    });
    return;
  }

  if (type === 'artifact_preview') {
    pathLog.push({
      type: 'host',
      name: 'preview',
      artifactId: String(ev.artifactId || ''),
      kind: ev.kind || ev.shell || '',
      shell: ev.shell || '',
      fileName: ev.name ? String(ev.name).slice(0, 120) : '',
      path: ev.path ? String(ev.path).slice(0, 200) : '',
      source: 'agent',
      ts
    });
    return;
  }

  if (type === 'context-usage') {
    pathLog.push({
      type: 'host',
      name: 'context-usage',
      promptTokens: Number(ev.promptTokens) || 0,
      completionTokens: Number(ev.completionTokens) || 0,
      contextWindow: Number(ev.contextWindow) || 0,
      ratio: Number(ev.ratio) || 0,
      compacting: ev.compacting === true,
      ts
    });
    return;
  }

  if (type === 'session-title') {
    pathLog.push({
      type: 'host',
      name: 'session-title',
      title: String(ev.title || '').slice(0, 120),
      ts
    });
    return;
  }

  if (type === 'error') {
    pathLog.push({
      type: 'error',
      name: ev.name ? String(ev.name) : 'Error',
      message: ev.message ? String(ev.message).slice(0, 400) : '',
      code: ev.code != null && ev.code !== '' ? String(ev.code) : undefined,
      statusCode: ev.statusCode != null ? Number(ev.statusCode) : undefined,
      ok: false,
      ts
    });
    return;
  }

  if (type === 'host') {
    const row = {
      type: 'host',
      name: String(ev.name || 'host').slice(0, 80),
      ts
    };
    if (ev.ok != null) row.ok = ev.ok === true;
    if (ev.code) row.code = String(ev.code).slice(0, 64);
    if (ev.tabId != null && ev.tabId !== '') row.tabId = ev.tabId;
    if (ev.url) row.url = String(ev.url).slice(0, 2000);
    if (ev.sessionId) row.sessionId = String(ev.sessionId).slice(0, 80);
    pathLog.push(row);
    return;
  }

  if (type === 'assistant-final') {
    pathLog.push({
      type: 'assistant-final',
      content: clipBubble(ev.content || ''),
      ts
    });
    return;
  }

  if (type === 'execution-start' || type === 'execution-end') {
    pathLog.push({
      type,
      executionId: String(ev.executionId || ''),
      status: ev.status ? String(ev.status) : type === 'execution-start' ? 'running' : 'completed',
      ts
    });
    return;
  }

  if (
    type === 'task-lifecycle' ||
    type === 'lease' ||
    type === 'abort' ||
    type === 'deadline' ||
    type === 'stale-ref' ||
    type === 'action-outcome'
  ) {
    pathLog.push(compactAuditFact(type, ev, ts));
  }
}

function compactAuditFact(type, ev, ts) {
  const row = { type, ts };
  if (ev.op) row.op = String(ev.op).slice(0, 40);
  if (ev.status) row.status = String(ev.status).slice(0, 40);
  if (ev.ok != null) row.ok = ev.ok === true;
  if (ev.code) row.code = String(ev.code).slice(0, 64);
  if (ev.taskId) row.taskId = String(ev.taskId).slice(0, 160);
  if (ev.executionId) row.executionId = String(ev.executionId).slice(0, 80);
  if (ev.sessionId) row.sessionId = String(ev.sessionId).slice(0, 80);
  if (ev.tabId != null && ev.tabId !== '') row.tabId = ev.tabId;
  if (ev.url) row.url = String(ev.url).slice(0, 2000);
  if (ev.title) row.title = String(ev.title).slice(0, 120);
  if (ev.holderSessionId) row.holderSessionId = String(ev.holderSessionId).slice(0, 80);
  if (ev.name) row.name = String(ev.name).slice(0, 80);
  if (ev.recovered === true) row.recovered = true;
  if (ev.reason) row.reason = String(ev.reason).slice(0, 40);
  if (ev.subgoal) row.subgoal = String(ev.subgoal).slice(0, 80);
  if (ev.ref) row.ref = String(ev.ref).slice(0, 32);
  if (ev.via) row.via = String(ev.via).slice(0, 8);
  if (ev.verified === true || ev.verified === false) row.verified = ev.verified === true;
  if (ev.kind) row.kind = String(ev.kind).slice(0, 24);
  if (ev.matched === false) row.matched = false;
  if (ev.dueAt) row.dueAt = String(ev.dueAt).slice(0, 80);
  if (ev.nextAction) row.nextAction = String(ev.nextAction).slice(0, 200);
  return row;
}

export function collectAuditFacts(pathLog = []) {
  const kinds = new Set();
  for (const ev of Array.isArray(pathLog) ? pathLog : []) {
    const type = String(ev?.type || '');
    if (
      type === 'task-lifecycle' ||
      type === 'lease' ||
      type === 'abort' ||
      type === 'deadline' ||
      type === 'stale-ref' ||
      type === 'action-outcome'
    ) {
      kinds.add(type);
    }
    if (type === 'execution-end' && String(ev.status || '') === 'aborted') kinds.add('abort');
    if (type === 'tool-result' && String(ev.tool || ev.name || '') === 'action') kinds.add('action-outcome');
    if (type === 'tool-result' && String(ev.result?.code || ev.code || '') === 'STALE_REF') kinds.add('stale-ref');
    if (type === 'tool-result' && String(ev.result?.code || ev.code || '') === 'TAB_LEASED') kinds.add('lease');
    if (type === 'tool-result' && String(ev.tool || '') === 'task') kinds.add('task-lifecycle');
  }
  return [...kinds];
}

function clipBubble(text, max = MAX_BUBBLE_CHARS) {
  const s = text == null ? '' : String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/** Catalog nicknames (`~google/gemini-flash-latest`) are not the routed model. */
export function isCatalogAliasId(id) {
  return String(id || '').trim().startsWith('~');
}

function storedModelId(stored) {
  if (typeof stored === 'string') return stored.trim();
  if (stored && typeof stored === 'object') {
    return String(stored.id || stored.model || '').trim();
  }
  return '';
}

/**
 * Audit files keep the model the API actually served, not the picker alias.
 * @param {Array<object>|undefined} events
 * @param {string|{id?: string, model?: string}|undefined} stored
 * @returns {string}
 */
export function pickRoutedModelId(events, stored) {
  const fromEvents = [];
  for (const e of events || []) {
    if (e?.type !== 'model') continue;
    const id = String(e.model || '').trim();
    if (id) fromEvents.push(id);
  }
  const routed = fromEvents.find((id) => !isCatalogAliasId(id));
  if (routed) return routed;
  const fallback = storedModelId(stored);
  if (fallback && !isCatalogAliasId(fallback)) return fallback;
  return '';
}

function exportModelRef(events, stored) {
  const id = pickRoutedModelId(events, stored);
  return id ? { id } : undefined;
}

function exportBubble(m, events) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role || 'unknown';
  /** @type {Record<string, unknown>} */
  const out = {
    role,
    content: clipBubble(m.content ?? m.text ?? ''),
    ts: isoTime(m.createdAt || m.ts) || isoTime(Date.now())
  };
  if (m.messageId) out.messageId = String(m.messageId);
  if (role === 'assistant') {
    const model = exportModelRef(events || m.path, m.model);
    if (model) out.model = model;
    if (m.usage) out.usage = harvestModelUsage(m.usage);
    const timing = splitTurnTiming(events || m.path, m.latencyMs);
    out.timing = timing;
    out.latencyMs = timing.totalMs;
    const started = isoTime(m.startedAt);
    const ended = isoTime(m.endedAt);
    if (started) out.startedAt = started;
    if (ended) out.endedAt = ended;
    if (m.status && m.status !== 'completed') out.status = String(m.status);
  }
  return out;
}

function exportTurn(index, userMsg, assistant) {
  const events = mergeBehaviorPath({
    path: assistant?.path,
    toolCalls: assistant?.toolCalls || assistant?.traces,
    traces: assistant?.traces,
    wire: assistant?.wire
  });
  const finalText = String(assistant?.content ?? assistant?.finalText ?? '').trim();
  if (finalText && !events.some((e) => e.type === 'assistant-final')) {
    events.push({
      type: 'assistant-final',
      content: clipBubble(finalText),
      ts: isoTime(assistant?.createdAt || assistant?.endedAt) || undefined
    });
  }
  /** @type {Record<string, unknown>} */
  const turn = {
    index,
    status: String(assistant?.status || (assistant ? 'completed' : 'pending')),
    messageIds: {
      user: userMsg?.messageId ? String(userMsg.messageId) : '',
      assistant: assistant?.messageId ? String(assistant.messageId) : ''
    },
    events
  };
  const model = exportModelRef(events, assistant?.model);
  if (model) turn.model = model;
  if (assistant?.usage) turn.usage = harvestModelUsage(assistant.usage);
  const timing = splitTurnTiming(events, assistant?.latencyMs);
  turn.timing = timing;
  turn.latencyMs = timing.totalMs;
  const started = isoTime(assistant?.startedAt || userMsg?.createdAt);
  const ended = isoTime(assistant?.endedAt || assistant?.createdAt);
  if (started) turn.startedAt = started;
  if (ended) turn.endedAt = ended;
  if (Array.isArray(assistant?.wire) && assistant.wire.length) {
    // Persist already bounded each hop; do not re-cut the hop list at 50.
    turn.wire = projectWireForDownload(assistant.wire);
  }
  const ctxEv = events.find((e) => e?.type === 'turn-context');
  if (ctxEv) {
    const { type: _t, ts: _ts, ...rest } = ctxEv;
    turn.context = rest;
  }
  if (assistant?.error) {
    turn.error =
      typeof assistant.error === 'object'
        ? {
            code: String(assistant.error.code || ''),
            message: String(assistant.error.message || assistant.error).slice(0, 500)
          }
        : { message: String(assistant.error).slice(0, 500) };
  }
  return turn;
}

function countEvents(turns) {
  const byTool = {};
  const byHost = {};
  const byModel = {};
  let toolCount = 0;
  let hostCount = 0;
  let modelCount = 0;
  let thoughtCount = 0;
  let textCount = 0;
  let latencyMs = 0;
  let inferenceMs = 0;
  let toolMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let usageSource = 'none';
  for (const turn of turns) {
    latencyMs += Number(turn.timing?.totalMs ?? turn.latencyMs) || 0;
    inferenceMs += Number(turn.timing?.inferenceMs) || 0;
    toolMs += Number(turn.timing?.toolMs) || 0;
    if (turn.usage) {
      promptTokens += Number(turn.usage.promptTokens) || 0;
      completionTokens += Number(turn.usage.completionTokens) || 0;
      if (turn.usage.source === 'api') usageSource = 'api';
      else if (usageSource === 'none' && turn.usage.source === 'estimate') usageSource = 'estimate';
    }
    for (const step of turn.events || []) {
      if (step?.type === 'tool-call') {
        toolCount += 1;
        const n = step.tool || 'tool';
        byTool[n] = (byTool[n] || 0) + 1;
      } else if (step?.type === 'host' || step?.type === 'turn-context') {
        hostCount += 1;
        const n = step.type === 'turn-context' ? 'turn-context' : step.name || 'host';
        byHost[n] = (byHost[n] || 0) + 1;
      } else if (step?.type === 'model') {
        modelCount += 1;
        const n = step.model || step.name || 'llm';
        byModel[n] = (byModel[n] || 0) + 1;
      } else if (step?.type === 'thought') {
        thoughtCount += 1;
      } else if (step?.type === 'text') {
        textCount += 1;
      }
    }
  }
  return {
    tools: toolCount,
    host: hostCount,
    modelCalls: modelCount,
    thoughts: thoughtCount,
    replies: textCount,
    latencyMs,
    timing: { inferenceMs, toolMs, totalMs: latencyMs },
    usage: { source: usageSource, promptTokens, completionTokens },
    byTool,
    byHost,
    byModel
  };
}

/**
 * Full audit export: one bubble copy + causal events + wire appendix.
 * @param {object} [opts]
 */
export function serializeBehaviorTrajectory(opts = {}) {
  const session = opts.session || {};
  const rawMessages = Array.isArray(opts.messages) ? opts.messages : session.messages || [];
  const turns = [];
  const bubbles = [];
  let pendingUser = null;
  let turnIndex = 0;

  function flushOrphanUser() {
    if (!pendingUser) return;
    const bubble = exportBubble(pendingUser);
    if (bubble) bubbles.push(bubble);
    turns.push(exportTurn(turnIndex, pendingUser, null));
    turnIndex += 1;
    pendingUser = null;
  }

  for (const m of rawMessages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      flushOrphanUser();
      pendingUser = m;
      continue;
    }
    if (m.role !== 'assistant') continue;
    const userBubble = pendingUser ? exportBubble(pendingUser) : null;
    if (userBubble) bubbles.push(userBubble);
    const turn = exportTurn(turnIndex, pendingUser, m);
    const asstBubble = exportBubble(m, turn.events);
    if (asstBubble) bubbles.push(asstBubble);
    turns.push(turn);
    turnIndex += 1;
    pendingUser = null;
  }
  flushOrphanUser();

  const counts = countEvents(turns);
  const statuses = turns.map((t) => t.status).filter((s) => s && s !== 'completed' && s !== 'pending');
  const convStatus = statuses.includes('aborted')
    ? 'aborted'
    : statuses.includes('failed')
      ? 'failed'
      : opts.humanStatus && opts.humanStatus !== 'unknown'
        ? opts.humanStatus
        : 'completed';

  const sessionAudit = opts.sessionAudit && typeof opts.sessionAudit === 'object'
    ? opts.sessionAudit
    : { schema: SESSION_AUDIT_SCHEMA, sessionId: String(session.sessionId || session.id || opts.sessionId || ''), events: [] };

  return {
    schema: BEHAVIOR_TRAJECTORY_SCHEMA,
    kind: 'audit',
    exportedAt: new Date().toISOString(),
    warnings: [TRAJECTORY_THOUGHT_WARNING],
    thoughtWarning: TRAJECTORY_THOUGHT_WARNING,
    sessionAudit,
    conversation: {
      sessionId: String(session.sessionId || session.id || opts.sessionId || ''),
      title: String(session.title || session.name || opts.title || ''),
      status: convStatus,
      humanStatus: opts.humanStatus || 'unknown',
      humanStatusNote: opts.humanStatusNote || '',
      humanStatusSetAt: opts.humanStatusSetAt || null
    },
    summary: {
      turns: turns.length,
      messages: bubbles.length,
      ...counts
    },
    messages: bubbles,
    turns
  };
}
