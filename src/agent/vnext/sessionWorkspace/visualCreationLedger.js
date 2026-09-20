/**
 * Execution-scoped visual + workbook creation ledger + fail-closed target resolution.
 *
 * Lifetime: beginExecution → createSessionTools / ToolLoopAgent → settleExecution.
 * Keyed by semantic kind (`deck` | `poster` | `workbook`). Never persisted; never
 * shared across sessions or parallel executions. No model API clears it.
 *
 * Precedence:
 *   1. explicit artifactId (after type/session validation)
 *   2. artifactMode:"new" — at most one extra same-kind artifact per execution
 *   3. this execution's ledger (first successful create/reuse of that kind)
 *   4. open/selected surface (activeHtml / activeWorkbook) when kind matches
 *   5. exactly one matching existing artifact (late focus)
 *   6. zero matches → first create allowed
 *   7. two or more matches → AMBIGUOUS_CANVAS / AMBIGUOUS_WORKBOOK (mutate nothing)
 */

import { listArtifacts } from './artifacts.js';
import { isRemovedCanvasDoc } from './openClassify.js';
import { isSheetArtifact } from '../../../preview/sheetCodec.js';

export const AMBIGUOUS_CANVAS = 'AMBIGUOUS_CANVAS';
export const AMBIGUOUS_WORKBOOK = 'AMBIGUOUS_WORKBOOK';
export const CANVAS_KIND = 'CANVAS_KIND';
export const WORKBOOK_KIND = 'workbook';

export function normalizeSceneKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'deck' || k === 'slide' || k === 'slides') return 'deck';
  if (k === 'poster' || k === 'design') return 'poster';
  return '';
}

export function normalizeCreationKind(kind) {
  const scene = normalizeSceneKind(kind);
  if (scene) return scene;
  const k = String(kind || '').toLowerCase();
  if (
    k === 'workbook' ||
    k === 'sheet' ||
    k === 'xlsx' ||
    k === 'csv' ||
    k === 'tsv' ||
    k === 'spreadsheet'
  ) {
    return WORKBOOK_KIND;
  }
  return '';
}

export function getVisualCreationLedger(execution) {
  if (!execution || typeof execution !== 'object') return null;
  if (!execution.visualCreation || typeof execution.visualCreation !== 'object') {
    execution.visualCreation = emptyLedger();
  }
  if (!execution.visualCreation.byKind || typeof execution.visualCreation.byKind !== 'object') {
    execution.visualCreation.byKind = Object.create(null);
  }
  if (!execution.visualCreation.explicitNew || typeof execution.visualCreation.explicitNew !== 'object') {
    execution.visualCreation.explicitNew = Object.create(null);
  }
  return execution.visualCreation;
}

export function clearVisualCreationLedger(execution) {
  if (!execution || typeof execution !== 'object') return;
  execution.visualCreation = emptyLedger();
}

export function rememberVisualCreation(execution, kind, artifactId, opts = {}) {
  const key = normalizeCreationKind(kind);
  const id = String(artifactId || '').trim();
  if (!key || !id) return;
  const ledger = getVisualCreationLedger(execution);
  if (!ledger) return;
  if (!ledger.byKind[key]) ledger.byKind[key] = id;
  if (opts.explicitNew && !ledger.explicitNew[key]) ledger.explicitNew[key] = id;
}

export function ledgerArtifactId(execution, kind, opts = {}) {
  const ledger = execution?.visualCreation;
  if (!ledger) return '';
  if (opts.explicitNew) {
    const key = normalizeCreationKind(kind);
    return key ? String(ledger.explicitNew?.[key] || '').trim() : '';
  }
  const want = normalizeCreationKind(kind);
  if (want) return String(ledger.byKind?.[want] || '').trim();
  // Empty kind: infer only among Design/Slides so a workbook ledger entry
  // cannot steal a createScene target.
  const keys = Object.keys(ledger.byKind || {}).filter(
    (k) => ledger.byKind[k] && (k === 'deck' || k === 'poster')
  );
  return keys.length === 1 ? String(ledger.byKind[keys[0]] || '').trim() : '';
}

export function isOwnedRemovedCanvas(store, fs, sessionId, artifactId) {
  return !!readOwnedCanvasText(store, fs, sessionId, artifactId);
}

export function readOwnedCanvasText(store, fs, sessionId, artifactId) {
  const rec = (listArtifacts(store, sessionId) || []).find((a) => a.artifactId === artifactId);
  if (!rec) return '';
  try {
    const raw = fs.readFileBytes(rec.primaryPath);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return isRemovedCanvasDoc(text) ? text : '';
  } catch {
    return '';
  }
}

export function kindFromOwnedCanvas(store, fs, sessionId, artifactId) {
  const text = readOwnedCanvasText(store, fs, sessionId, artifactId);
  if (!text) return '';
  try {
    const doc = JSON.parse(text);
    const shell = String(doc?.shell || doc?.kind || '').toLowerCase();
    if (shell === 'slides' || shell === 'deck') return 'deck';
    if (shell === 'design' || shell === 'poster') return 'poster';
  } catch {
    /* leftover JSON */
  }
  return '';
}

export function listMatchingCanvases(store, fs, sessionId, kind) {
  const want = normalizeSceneKind(kind);
  if (!want) return [];
  return (listArtifacts(store, sessionId) || []).filter((a) => {
    const id = String(a.artifactId || '').trim();
    return (
      id &&
      isOwnedRemovedCanvas(store, fs, sessionId, id) &&
      kindFromOwnedCanvas(store, fs, sessionId, id) === want
    );
  });
}

/**
 * @returns {{
 *   ok: boolean,
 *   applyId?: string,
 *   create?: boolean,
 *   markExplicitNew?: boolean,
 *   kind?: string,
 *   code?: string,
 *   error?: string,
 *   candidates?: Array<{artifactId:string,name:string}>
 * }}
 */
export function resolveVisualCreateTarget(store, fs, sessionId, execution, opts = {}) {
  const want = normalizeSceneKind(opts.kind);
  const explicit = String(opts.canvasId || opts.explicitId || '').trim();
  const focused = String(opts.focusedId || '').trim();
  const wantNew = String(opts.artifactMode || '').trim().toLowerCase() === 'new';

  if (explicit && isOwnedRemovedCanvas(store, fs, sessionId, explicit)) {
    const live = kindFromOwnedCanvas(store, fs, sessionId, explicit);
    if (want && live && live !== want) {
      return {
        ok: false,
        code: CANVAS_KIND,
        error: `artifactId ${explicit} is a ${live === 'deck' ? 'Slides' : 'Design'} canvas, not ${want}`,
        hint: 'pass an artifactId of the matching kind, or omit artifactId'
      };
    }
    return { ok: true, applyId: explicit };
  }

  if (wantNew) {
    const newKind = inferCreateKind(want, focused, store, fs, sessionId, execution);
    const existingNew = ledgerArtifactId(execution, newKind, { explicitNew: true });
    if (existingNew && isOwnedRemovedCanvas(store, fs, sessionId, existingNew)) {
      return { ok: true, applyId: existingNew, markExplicitNew: true };
    }
    return { ok: true, applyId: '', create: true, markExplicitNew: true, kind: newKind };
  }

  const led = ledgerArtifactId(execution, want);
  if (led && isOwnedRemovedCanvas(store, fs, sessionId, led)) {
    if (!want || kindFromOwnedCanvas(store, fs, sessionId, led) === want) {
      return { ok: true, applyId: led };
    }
  }

  if (focused && isOwnedRemovedCanvas(store, fs, sessionId, focused)) {
    const live = kindFromOwnedCanvas(store, fs, sessionId, focused);
    if (!want || live === want) return { ok: true, applyId: focused };
  }

  if (!want) return { ok: true, applyId: '', create: true };

  const matches = listMatchingCanvases(store, fs, sessionId, want);
  if (matches.length === 1) return { ok: true, applyId: matches[0].artifactId };
  if (matches.length > 1) {
    return {
      ok: false,
      code: AMBIGUOUS_CANVAS,
      error: `AMBIGUOUS_CANVAS: ${matches.length} ${want === 'deck' ? 'Slides' : 'Design'} canvases and no explicit target. Pass artifactId or artifactMode:"new".`,
      candidates: matches.map((a) => ({ artifactId: a.artifactId, name: a.name || '' }))
    };
  }
  return { ok: true, applyId: '', create: true };
}

/**
 * Fail-closed workbook target for createWorkbook.
 * Same precedence as resolveVisualCreateTarget. Reuse does not wipe seed.sheets
 * onto the open book (default createWorkbook seed would clobber A1).
 *
 * @returns {{
 *   ok: boolean,
 *   applyId?: string,
 *   create?: boolean,
 *   markExplicitNew?: boolean,
 *   kind?: string,
 *   code?: string,
 *   error?: string,
 *   candidates?: Array<{artifactId:string,name:string}>
 * }}
 */
export function resolveWorkbookCreateTarget(store, fs, sessionId, execution, opts = {}) {
  const explicit = String(opts.explicitId || opts.artifactId || '').trim();
  const focused = String(opts.focusedId || '').trim();
  const wantNew = String(opts.artifactMode || '').trim().toLowerCase() === 'new';

  if (explicit && isOwnedWorkbook(store, fs, sessionId, explicit)) {
    return { ok: true, applyId: explicit };
  }

  if (wantNew) {
    const existingNew = ledgerArtifactId(execution, WORKBOOK_KIND, { explicitNew: true });
    if (existingNew && isOwnedWorkbook(store, fs, sessionId, existingNew)) {
      return { ok: true, applyId: existingNew, markExplicitNew: true };
    }
    return { ok: true, applyId: '', create: true, markExplicitNew: true, kind: WORKBOOK_KIND };
  }

  const led = ledgerArtifactId(execution, WORKBOOK_KIND);
  if (led && isOwnedWorkbook(store, fs, sessionId, led)) {
    return { ok: true, applyId: led };
  }

  if (focused && isOwnedWorkbook(store, fs, sessionId, focused)) {
    return { ok: true, applyId: focused };
  }

  const matches = listMatchingWorkbooks(store, fs, sessionId);
  if (matches.length === 1) return { ok: true, applyId: matches[0].artifactId };
  if (matches.length > 1) {
    return {
      ok: false,
      code: AMBIGUOUS_WORKBOOK,
      error: `AMBIGUOUS_WORKBOOK: ${matches.length} workbooks and no explicit target. Pass artifactId or artifactMode:"new".`,
      candidates: matches.map((a) => ({ artifactId: a.artifactId, name: a.name || '' }))
    };
  }
  return { ok: true, applyId: '', create: true, kind: WORKBOOK_KIND };
}

export function isOwnedWorkbook(store, fs, sessionId, artifactId) {
  const rec = (listArtifacts(store, sessionId) || []).find((a) => a.artifactId === artifactId);
  return !!(rec && isSheetArtifact(rec));
}

export function listMatchingWorkbooks(store, fs, sessionId) {
  return (listArtifacts(store, sessionId) || []).filter((a) => {
    const id = String(a.artifactId || '').trim();
    return id && isSheetArtifact(a);
  });
}

function inferCreateKind(want, focused, store, fs, sessionId, execution) {
  if (want) return want;
  if (focused && isOwnedRemovedCanvas(store, fs, sessionId, focused)) {
    return kindFromOwnedCanvas(store, fs, sessionId, focused) || 'deck';
  }
  const keys = Object.keys(execution?.visualCreation?.byKind || {}).filter(
    (k) => execution.visualCreation.byKind[k] && (k === 'deck' || k === 'poster')
  );
  if (keys.length === 1) return keys[0];
  return 'deck';
}

function emptyLedger() {
  return {
    byKind: Object.create(null),
    explicitNew: Object.create(null)
  };
}
