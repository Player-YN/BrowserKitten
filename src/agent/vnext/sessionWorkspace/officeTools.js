/**
 * Model office tools — always registered. Inventory aims targets; missing canvas → NO_CANVAS.
 */

import { assertArtifactOwned } from './auth.js';
import { listArtifacts, revertArtifactContent, updateArtifactContent } from './artifacts.js';
import { inventoryFromSession } from './canvasInventory.js';
import { SITE_MOTION_CAPABILITY } from './siteMotionSchema.js';
import {
  applyCommandsToWorkbookData,
  compactSheetList,
  hydrateSheetGridCommands,
  inspectSheetSelection,
  malformedSheetWriteError,
  overviewFromWorkbookData,
  overviewFromSheets,
  SHEET_SNAPSHOT_MAX_ROWS,
  snapshotSheetRange
} from './sheetApply.js';
import {
  drawingHydrateFailed,
  expandOmittedImageCommands,
  hydrateOfficeImageCommands,
  HTML_IMAGE_OPS,
  officeImageRef,
  readbackLooksLikeUnresolvedImage,
  SHEET_DRAWING_OPS
} from './sheetImageHydrate.js';
import { extractWorkbookSnapshot } from '../../../preview/sheetModel.js';
import {
  aoaToCsv,
  bytesToUtf8,
  isSheetArtifact,
  parseDelimited,
  sheetKindFromArtifact,
  sheetsToWorkbookData,
  workbookDataToSheets
} from '../../../preview/sheetCodec.js';
import { NEED_SELECTION } from './htmlApply.js';
import { applySiteCommands, listSiteNodes, stampSiteHtml, pinnedSiteIds, siteSelectionsFromIds } from './siteApply.js';
import { runSiteClone, WEB_CLONE_DESCRIPTION } from './siteClone.js';
import { applyDocCommands, overviewFromDocSnapshot, parseDocSnapshot, serializeDocHtml } from './docsApply.js';
import {
  hydrateDocCommands,
  malformedDocWriteError,
  malformedWebWriteError,
  resolveOfficeWriteInput
} from './officePathHydrate.js';
import { sessionToolToModelOutput } from './canvasPreview.js';

const NO_CANVAS = {
  ok: false,
  code: 'NO_CANVAS',
  error: 'no spreadsheet or website canvas in this session',
  hint: 'register a workbook with run op=sheet, or a site with write_artifact data-browserbot-kind=site'
};

const NO_DOCUMENT = {
  ok: false,
  code: 'NO_DOCUMENT',
  error: 'no document file in this session',
  hint: 'register a document with run op=doc (createDocument); then edit with the doc tool. Documents are marked HTML, not a canvas engine.'
};

/**
 * @param {object} env same shape as createSessionTools
 */
export function createOfficeTools(env) {
  const { store, fs, sessionId } = env;
  const onEvent = typeof env.onEvent === 'function' ? env.onEvent : null;

  const doc = {
    name: 'doc',
    description:
      'Read and write a session document stored as marked HTML (headings, paragraphs, lists, images). act=write applies commands[] (createDocument, insertParagraph, setText, insertList, insertImage) and saves HTML. After run writes commands JSON, pass path|from — do not retype. Missing op or empty payload → BAD_INPUT. Missing file → ENOENT. No document yet → NO_DOCUMENT.',
    parameters: {
      type: 'object',
      properties: {
        act: { type: 'string', enum: ['read', 'write'], description: 'read | write' },
        artifactId: { type: 'string' },
        text: { type: 'string' },
        path: { type: 'string', description: 'Guest /scratch|/artifacts JSON of commands[] / blocks[] / {text}' },
        from: { type: 'string', description: 'Alias of path for doc JSON' },
        commands: { type: 'array', items: { type: 'object' } }
      }
    },
    async execute(input = {}) {
      const inv = inventoryFromSession(store, sessionId, fs);
      if (!inv.doc.length) {
        return { ...NO_DOCUMENT };
      }
      const artifactId = String(input.artifactId || inv.doc[0] || '');
      const rec = listArtifacts(store, sessionId).find((a) => a.artifactId === artifactId);
      if (!rec) return { ok: false, error: 'artifact not found', available: inv.doc };
      let raw = '';
      try {
        raw = bytesToUtf8(fs.readFileBytes(rec.primaryPath));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const current = parseDocSnapshot(raw, { title: rec.name });
      const act = String(input.act || (input.commands || input.text != null || input.path || input.from ? 'write' : 'read'));
      if (act === 'read') {
        return { ok: true, artifactId, overview: overviewFromDocSnapshot(current, { artifactId }) };
      }
      const resolvedDoc = resolveOfficeWriteInput(fs, input, 'doc');
      if (!resolvedDoc.ok) {
        return {
          ok: false,
          error: resolvedDoc.error,
          code: resolvedDoc.code,
          hint: resolvedDoc.hint,
          artifactId
        };
      }
      const seededDoc = resolvedDoc.input;
      const rawDoc =
        Array.isArray(seededDoc.commands) && seededDoc.commands.length
          ? seededDoc.commands
          : seededDoc.src || seededDoc.item
            ? [{ op: 'insertImage', src: seededDoc.src || seededDoc.item }]
            : [{ op: 'setText', text: seededDoc.text != null ? seededDoc.text : seededDoc.value }];
      const hydratedDoc = hydrateDocCommands(fs, rawDoc);
      if (!hydratedDoc.ok) {
        return {
          ok: false,
          error: hydratedDoc.error,
          code: hydratedDoc.code,
          hint: hydratedDoc.hint,
          artifactId
        };
      }
      const malformedDoc = malformedDocWriteError(hydratedDoc.commands);
      if (malformedDoc) return { ...malformedDoc, artifactId };
      const commands = await hydrateOfficeImageCommands(store, sessionId, hydratedDoc.commands, {
        fetchImpl: env.fetchImpl,
        onEvent: env.onEvent,
        signal: env.signal || env.execution?.abortSignal,
        fs
      });
      const docImgFails = drawingHydrateFailed(commands);
      if (docImgFails.length && commands.every((c) => c.op !== 'setText' && c.op !== 'insertParagraph' && c.op !== 'insertList')) {
        return {
          ok: false,
          error: docImgFails[0].srcError || 'image bytes unavailable'
        };
      }
      const applied = applyDocCommands(
        current,
        commands.filter((c) => !c.srcError)
      );
      if (applied.ok === false) {
        return speakOfficeApplyResult(
          {
            ok: false,
            error: applied.error,
            available: (current.blocks || []).map((b) => b.id),
            applied: applied.applied
          },
          commands
        );
      }
      const payload = applied.html || serializeDocHtml(applied.snapshot);
      updateArtifactContent(store, fs, sessionId, artifactId, payload, { mimeType: 'text/html', expectedRevision: Number(rec.revision) || 0 });
      return speakOfficeApplyResult(
        {
          ok: true,
          artifactId,
          applied: applied.applied,
          readback: {
            title: applied.snapshot.title,
            blocks: applied.snapshot.blocks
          }
        },
        commands
      );
    }
  };

  const web = {
    name: 'web',
    description:
      'Website page (data-browserbot-kind=site). Acts: read, write, undo, clone, capture. After create, mutate in place — never a second site HTML. Writes: setText/setHref/setSrc on a pinned node, commands[], or path|from to /scratch|/artifacts JSON (commands) or HTML (replaceHtml on the same file) — after run writes the payload, pass the path, do not retype. Missing op or empty payload → BAD_INPUT; missing file → ENOENT. ' +
      WEB_CLONE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        act: { type: 'string', enum: ['read', 'write', 'undo', 'clone', 'capture'] },
        artifactId: { type: 'string' },
        nodeId: { type: 'string' },
        text: { type: 'string' },
        src: { type: 'string' },
        href: { type: 'string' },
        commands: { type: 'array', items: { type: 'object' } },
        source: { type: 'string', description: 'clone/capture: active | url | path' },
        url: { type: 'string', description: 'clone/capture: public page URL' },
        path: {
          type: 'string',
          description:
            'write: guest /scratch|/artifacts JSON commands or HTML; clone/capture: guest HTML or blueprint path; image writes still use src|item'
        },
        from: { type: 'string', description: 'Alias of path for site patch JSON or HTML' },
        viewport: { type: 'object', description: 'clone: { width, height }' },
        assets: { type: 'string', description: 'clone: bundle (default)' },
        motion: { type: 'string', description: 'clone: declarative (retain CSS keyframes/transitions)' }
      }
    },
    async execute(input = {}) {
      const actEarly = String(input.act || '').toLowerCase();
      if (actEarly === 'clone' || actEarly === 'capture') {
        return runSiteClone(
          {
            store,
            fs,
            sessionId,
            execution: env.execution,
            fetchImpl: env.fetchImpl,
            webAcquire: env.webAcquire,
            signal: env.signal,
            onEvent,
            hostPageCapture: env.hostPageCapture,
            activeTab: env.activeTab,
            focusPage: env.focusPage
          },
          input
        );
      }
      const inv = inventoryFromSession(store, sessionId, fs);
      if (!inv.web.length) {
        return { ...NO_CANVAS, hint: 'create a website with write_artifact HTML marked data-browserbot-kind=site, or web act=clone' };
      }
      const artifactId = String(input.artifactId || focusWebId(store, sessionId, inv) || '');
      if (!artifactId) return { ...NO_CANVAS };
      if (!inv.web.includes(artifactId)) {
        return { ...NO_CANVAS, hint: 'artifact is not a website canvas' };
      }
      const gate = assertArtifactOwned(store, sessionId, artifactId);
      if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
      const rec = gate.record || listArtifacts(store, sessionId).find((a) => a.artifactId === artifactId);
      if (!rec) return { ok: false, error: 'artifact not found' };
      if (String(input.act || '') === 'undo') {
        const reverted = revertArtifactContent(store, fs, sessionId, artifactId);
        if (reverted.ok && onEvent) {
          try {
            onEvent({ type: 'html_canvas_updated', sessionId, artifactId });
          } catch {
            /* ignore */
          }
        }
        return { ...reverted, artifactId };
      }
      let html = '';
      try {
        html = bytesToUtf8(fs.readFileBytes(rec.primaryPath));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      html = stampSiteHtml(html);
      const sess = store.get('sessions', sessionId) || {};
      const selections = sess.activeHtml?.selections || input.selections;
      const selected = pinnedSiteIds(selections);
      const act = String(
        input.act ||
          (input.commands || input.text != null || input.src || input.path || input.from || input.item || input.href
            ? 'write'
            : 'read')
      );
      if (act === 'read') {
        return {
          ok: true,
          artifactId,
          nodes: listSiteNodes(html),
          available: listSiteNodes(html).map((n) => n.nodeId),
          selected,
          selections: siteSelectionsFromIds(html, selected),
          motion: SITE_MOTION_CAPABILITY
        };
      }
      const resolvedWeb = resolveOfficeWriteInput(fs, input, 'web');
      if (!resolvedWeb.ok) {
        return {
          ok: false,
          artifactId,
          error: resolvedWeb.error,
          code: resolvedWeb.code,
          hint: resolvedWeb.hint
        };
      }
      const seededWeb = resolvedWeb.input;
      const pinnedList = Array.isArray(selections) ? selections : [];
      const pinnedIsImg =
        pinnedList.length > 0 &&
        pinnedList.every((p) => p && (p.tag === 'img' || p.kind === 'image' || p.type === 'image'));
      const explicitSrc = webImageRef(seededWeb);
      const latestImage = latestSessionImagePath(store, sessionId);
      const rawWeb =
        Array.isArray(seededWeb.commands) && seededWeb.commands.length
          ? seededWeb.commands.map((c) => attachLatestSiteImage(c, latestImage))
          : [
              {
                op:
                  explicitSrc || seededWeb.src || seededWeb.path || seededWeb.item || pinnedIsImg
                    ? 'setSrc'
                    : seededWeb.href
                      ? 'setHref'
                      : 'setText',
                nodeId: seededWeb.nodeId,
                text: seededWeb.text,
                value: seededWeb.value,
                src: explicitSrc || seededWeb.src || (pinnedIsImg ? latestImage : ''),
                href: seededWeb.href
              }
            ];
      const malformedWeb = malformedWebWriteError(rawWeb);
      if (malformedWeb) return { ...malformedWeb, artifactId };
      const commands = await hydrateOfficeImageCommands(store, sessionId, rawWeb, {
        fetchImpl: env.fetchImpl,
        onEvent: env.onEvent,
        signal: env.signal || env.execution?.abortSignal,
        fs,
        ops: HTML_IMAGE_OPS,
        persistGuestPath: true
      });
      const imgCmds = commands.filter((c) => c && HTML_IMAGE_OPS.has(String(c.op || '')));
      const imgFails = imgCmds.filter((c) => c.srcError);
      if (imgFails.length && imgFails.length === imgCmds.length) {
        return {
          ok: false,
          artifactId,
          code: 'IMAGE_UNRESOLVED',
          error: imgFails[0].srcError || 'image artifact not found'
        };
      }
      const applied = applySiteCommands(html, commands.filter((c) => !c?.srcError), { selections });
      if (applied.ok === false) {
        return speakOfficeApplyResult({ ...applied, artifactId }, commands);
      }
      updateArtifactContent(store, fs, sessionId, artifactId, applied.html, { mimeType: 'text/html', expectedRevision: Number(rec.revision) || 0 });
      if (onEvent) {
        try {
          onEvent({ type: 'html_canvas_updated', sessionId, artifactId });
        } catch {
          /* ignore */
        }
      }
      return speakOfficeApplyResult(
        {
          ok: true,
          artifactId,
          dirty: applied.dirty,
          readback: applied.readback,
          applied: applied.applied,
          available: applied.available,
          selected: applied.selected || selected,
          nodeIds: applied.nodeIds || selected,
          canUndo: true
        },
        commands
      );
    }
  };

  return { doc, web };
}

function focusSheetId(store, sessionId, inv) {
  const sess = store.get('sessions', sessionId) || {};
  return sess.activeWorkbook?.artifactId || inv.sheet[0] || '';
}

function webImageRef(raw = {}) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  return String(raw.src || raw.path || raw.item || raw.handle || raw.image || raw.url || '').trim();
}

function attachLatestSiteImage(cmd, latestPath) {
  if (!cmd || typeof cmd !== 'object') return cmd;
  const op = String(cmd.op || cmd.type || '');
  if (!HTML_IMAGE_OPS.has(op)) return cmd;
  if (webImageRef(cmd) || officeImageRef(cmd, { allowValue: false })) return cmd;
  if (!latestPath) return cmd;
  return { ...cmd, src: latestPath };
}

function latestSessionImagePath(store, sessionId) {
  return listArtifacts(store, sessionId)
    .filter(
      (a) =>
        /^image\//i.test(String(a?.mimeType || '')) || /\.(png|jpe?g|webp|gif)$/i.test(String(a?.name || ''))
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.primaryPath || '';
}

function focusWebId(store, sessionId, inv) {
  const sess = store.get('sessions', sessionId) || {};
  const aid = String(sess.activeHtml?.artifactId || '');
  if (aid && inv.web.includes(aid)) return aid;
  return inv.web[0] || '';
}

function focusA1(store, sessionId) {
  const sess = store.get('sessions', sessionId) || {};
  const sel = sess.activeWorkbook?.overview?.selections?.[0] || sess.activeWorkbook?.overview?.selection;
  return sel?.a1 || '';
}

function officeSheetCommands(input, store, sessionId) {
  const sess = store.get('sessions', sessionId) || {};
  const sel = sess.activeWorkbook?.overview?.selections?.[0] || sess.activeWorkbook?.overview?.selection || {};
  const a1 = input.a1 || sel.a1;
  const sheet = input.sheet || sel.sheet;
  if (Array.isArray(input.commands) && input.commands.length) {
    return input.commands.map((c) => ({
      ...c,
      a1: c.a1 || a1,
      sheet: c.sheet || sheet
    }));
  }
  if (input.act === 'draw' || input.item || looksLikeImageRef(input.src || input.path || input.handle)) {
    return [{ op: 'insertCellImage', a1, sheet, src: officeImageRef(input, { allowValue: false }) || input.src || input.item || '' }];
  }
  const value = input.value != null ? input.value : input.text;
  if (value === undefined && !input.formula) return [];
  return [
    {
      op: input.formula ? 'setFormula' : 'setRange',
      a1,
      sheet,
      value,
      formula: input.formula
    }
  ];
}

function looksLikeImageRef(src) {
  const s = String(src || '').trim();
  if (!s) return false;
  return (
    /^wi_/i.test(s) ||
    /^data:image\//i.test(s) ||
    /^https?:\/\//i.test(s) ||
    /^(图片|image|img|screenshot|截图)\s*\d+$/i.test(s) ||
    /^\/artifacts\//i.test(s)
  );
}

function liveDrawingsMissed(body, drawingCmds) {
  if (!drawingCmds.length) return false;
  const d = body?.drawings;
  if (!d || typeof d !== 'object') return false;
  const count = Number(d.count) || 0;
  const failed = Number(d.failed) || 0;
  return count === 0 && failed > 0;
}

function loadWorkbook(fs, rec, artifactId) {
  if (!isSheetArtifact(rec)) {
    return {
      ok: false,
      error: 'artifact is not a spreadsheet',
      code: 'NOT_SHEET',
      hint: 'pass a sheet artifactId, or register one with run createWorkbook'
    };
  }
  const bytes = fs.readFileBytes(rec.primaryPath);
  const kind = sheetKindFromArtifact(rec);
  if (kind === 'xlsx') {
    const snap = extractWorkbookSnapshot(bytes);
    if (snap) return { ok: true, rec, kind, data: snap, sheets: workbookDataToSheets(snap) };
    return {
      ok: false,
      error: 'xlsx inspect needs the live sheet tab',
      code: 'NEED_TAB',
      hint: 'open the live sheet tab and retry inspect/snapshot',
      rec
    };
  }
  const text = bytesToUtf8(bytes);
  const sheets = [{ name: 'Sheet1', rows: parseDelimited(text, kind) }];
  return { ok: true, rec, kind, sheets, data: sheetsToWorkbookData(sheets, rec.name) };
}

function persistWorkbook(store, fs, sessionId, artifactId, rec, applied, kind) {
  const delim = kind === 'tsv' ? '\t' : ',';
  const rows = applied.sheets?.[0]?.rows || [];
  updateArtifactContent(store, fs, sessionId, artifactId, aoaToCsv(rows, delim), {
    expectedRevision: Number(rec.revision) || 0,
    mimeType: rec.mimeType
  });
}

function appliedCount(applied) {
  if (typeof applied === 'number') return applied;
  if (Array.isArray(applied)) return applied.length;
  if (applied && typeof applied === 'object') return 1;
  return 0;
}

function hasExplicitApplied(applied) {
  return typeof applied === 'number' || Array.isArray(applied);
}

function classifyOfficeSkipped(commands) {
  const list = Array.isArray(commands) ? commands : commands && typeof commands === 'object' ? [commands] : [];
  const reasons = [];
  if (!list.length) reasons.push('missing-op');
  for (const c of list) {
    if (!c || typeof c !== 'object') {
      reasons.push('missing-op');
      continue;
    }
    const op = String(c.op || c.type || '').trim();
    if (!op) {
      reasons.push('missing-op');
      continue;
    }
    const path = String(c.path || c.from || c.valuesPath || c.scratchPath || '').trim();
    if (op === 'setValues2d' || op === 'applyGrid') {
      const empty = !Array.isArray(c.values) || !c.values.length;
      if (empty && path) reasons.push('no-hydrate');
      else if (empty) reasons.push('empty-grid');
    } else if (op === 'replacePlate') {
      const emptySlots = c.slots == null || (typeof c.slots === 'object' && !Object.keys(c.slots).length);
      if (emptySlots && path) reasons.push('no-hydrate');
      else if (emptySlots) reasons.push('empty-grid');
    } else if (op === 'createDocument') {
      const emptyBlocks = !Array.isArray(c.blocks) || !c.blocks.length;
      if (emptyBlocks && path) reasons.push('no-hydrate');
      else if (emptyBlocks) reasons.push('empty-grid');
    }
  }
  return reasons.length ? [...new Set(reasons)] : ['empty-grid'];
}

function speakHint(skipped) {
  const s = Array.isArray(skipped) ? skipped[0] : skipped;
  if (s === 'missing-op') return 'each commands[] item needs op';
  if (s === 'no-hydrate') return 'path was not resolved to a payload — write JSON via run, then pass that path';
  if (s === 'empty-grid') return 'write applied 0 cells/slots/blocks — pass values or a guest path';
  return 'write applied 0 commands';
}

/** ok && applied===0 must not look like success — emit hint + skipped[]. */
export function speakOfficeApplyResult(result, commands) {
  if (!result || typeof result !== 'object') return result;
  const n = appliedCount(result.applied);
  const zero = hasExplicitApplied(result.applied) && n === 0;
  const skipped = Array.isArray(result.skipped) && result.skipped.length
    ? result.skipped
    : zero
      ? classifyOfficeSkipped(commands)
      : undefined;
  if (result.ok === true && zero) {
    return {
      ...result,
      ok: false,
      code: result.code || 'BAD_INPUT',
      error: result.error || 'write applied 0 commands',
      hint: result.hint || speakHint(skipped),
      skipped
    };
  }
  if (zero && (!result.hint || !result.skipped)) {
    return {
      ...result,
      hint: result.hint || speakHint(skipped),
      skipped: result.skipped || skipped
    };
  }
  return result;
}

function decorateSheetResult(ok, artifactId, body, error, commands) {
  const rb = body?.readback || {};
  const overview = body?.overview || (body?.sheets ? overviewFromSheets(body.sheets) : undefined);
  return speakOfficeApplyResult(
    {
      ok,
      artifactId,
      dirty: rb.a1 || '',
      readback: rb,
      applied: body?.applied,
      overview,
      sheets: compactSheetList(overview || body?.sheets),
      error: error || undefined,
      code: body?.code,
      hint: body?.hint,
      available: body?.available,
      skipped: body?.skipped
    },
    commands
  );
}

async function snapshotArtifact(env, { fs, hostSheet, gate, artifactId, a1, sheet }) {
  let snap = null;
  let overview = null;
  if (hostSheet) {
    try {
      const res = await hostSheet({
        method: 'snapshot',
        artifactId,
        a1,
        sheet,
        promptId: String(env.promptId || env.execution?.executionId || '')
      });
      const body = res?.result || res || {};
      if (body?.code === 'SNAPSHOT_TOO_LARGE' || (body?.ok === false && body?.rowCount > SHEET_SNAPSHOT_MAX_ROWS)) {
        overview = body.overview;
        return {
          ok: false,
          act: 'snapshot',
          artifactId,
          code: body.code || 'SNAPSHOT_TOO_LARGE',
          error: body.error,
          rowCount: body.rowCount,
          sheetRowCount: body.sheetRowCount,
          sheets: compactSheetList(overview || body.sheets),
          overview
        };
      }
      if (body?.ok !== false && Array.isArray(body.values)) {
        snap = { ...body, ok: true };
        overview = body.overview;
      }
    } catch {
      /* fall back to artifact bytes */
    }
  }
  if (!snap) {
    const loaded = loadWorkbook(fs, gate.record, artifactId);
    if (!loaded.ok) return loaded;
    snap = snapshotSheetRange(loaded.data, a1, sheet);
    overview = overviewFromWorkbookData(loaded.data);
  }
  if (snap.ok === false) {
    return {
      ok: false,
      act: 'snapshot',
      artifactId,
      code: snap.code || 'SNAPSHOT_TOO_LARGE',
      error: snap.error,
      rowCount: snap.rowCount,
      sheetRowCount: snap.sheetRowCount,
      sheets: compactSheetList(overview),
      overview
    };
  }
  if ((snap.values || []).length > SHEET_SNAPSHOT_MAX_ROWS) {
    return {
      ok: false,
      act: 'snapshot',
      artifactId,
      code: 'SNAPSHOT_TOO_LARGE',
      error: `snapshot exceeds ${SHEET_SNAPSHOT_MAX_ROWS} rows (${snap.values.length}); pass a smaller a1`,
      rowCount: snap.values.length,
      sheetRowCount: snap.sheetRowCount,
      sheets: compactSheetList(overview),
      overview
    };
  }
  let path;
  try {
    path = writeScratchCsv(fs, artifactId, snap);
  } catch (e) {
    return {
      ok: false,
      act: 'snapshot',
      artifactId,
      error: e instanceof Error ? e.message : String(e),
      sheets: compactSheetList(overview),
      overview
    };
  }
  return {
    ok: true,
    act: 'snapshot',
    artifactId,
    path,
    sheet: snap.sheet,
    a1: snap.a1,
    headers: snap.headers,
    rowCount: snap.rowCount,
    columnCount: snap.columnCount,
    sheetRowCount: snap.sheetRowCount,
    sheets: compactSheetList(overview),
    overview
  };
}

function writeScratchCsv(fs, artifactId, snap) {
  const id = String(artifactId || 'sheet').replace(/[^\w.-]+/g, '_').slice(0, 48);
  const sheet = String(snap.sheet || 'Sheet1').replace(/[^\w.-]+/g, '_').slice(0, 31);
  const guestPath = `/scratch/snapshots/${id}-${sheet}.csv`;
  fs.mkdirp('/scratch/snapshots');
  fs.writeFile(guestPath, aoaToCsv(snap.values || []), { mimeType: 'text/csv' });
  return guestPath;
}

function sheetNamesFrom(store, sessionId, fs, artifactId) {
  try {
    const rec = listArtifacts(store, sessionId).find((a) => a.artifactId === artifactId);
    if (!rec) return [];
    const loaded = loadWorkbook(fs, rec, artifactId);
    if (!loaded.ok) return [];
    return (overviewFromWorkbookData(loaded.data).sheets || []).map((s) => s.name);
  } catch {
    return [];
  }
}
