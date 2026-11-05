/**
 * Model-facing failure receipts. Codes stay off the tool schema;
 * this table is the next-call copy attached only when ok is false.
 */

export const TOOL_FAILURE_HINTS = Object.freeze({
  ACTION_OUTCOME_UNKNOWN: 'read the page or artifact after this hop, then decide; do not replay the write',
  AMBIGUOUS: 'action op=delegate with a subgoal that names the one control; do not pass a ref',
  AMBIGUOUS_SITE: 'pass artifactId for the existing site, or read before clone',
  ARTIFACT_CONFLICT: 're-read the artifact revision, then write with the current expectedRevision',
  BAD_INPUT: 'check required fields for this op; mutations need rev; inspect view=sys for the sys ISA',
  CDP_BUSY: 'detach the other debugger, or use pointer method=point / upload method=auto',
  DOCUMENT_UNAVAILABLE: 'action op=snapshot on a live http(s) tab, then retry',
  ENOENT: 'pass a guest path that exists under /scratch, /artifacts, or /context',
  FILE_CHOOSER: 'action op=upload with path|itemId|artifactId instead of click on a file input',
  FILE_INPUT: 'action op=upload; fill cannot set a file input',
  FORM_PARTIAL: 'action op=snapshot, then retry only the failed fields with the new rev',
  IMAGE_UNRESOLVED: 'pass src as a guest path, wi_ id, or 图片N, or omit src to pin the selection',
  JOURNAL_UNAVAILABLE: 'retry the same call after the journal is writable; do not invent a new write',
  NEED_CAPTURE_GRANT: 'wait for the side-panel capture grant, then retry the requested listen or record operation',
  NEED_EXPLICIT_TAB: 'pass tabId from this turn world or the previous action receipt',
  NEED_PAGE: 'target a live http(s) tab; action op=snapshot, or run + sys.tabs.list',
  NO_CANVAS: 'create a website with write_artifact HTML marked data-browserbot-kind=site, then edit with web. There is no sheet canvas.',
  NO_DOCUMENT: 'register a document with run op=doc (createDocument), then edit with the doc tool. Documents are marked HTML.',
  OP_REMOVED: 'there is no canvas HTML op. Use run op=doc for a document, or write_artifact with data-browserbot-kind=site for a website.',
  COORD_MISMATCH: 'snapshot again; x,y are 0–1 against the current CSS viewport',
  FALLBACK_VISUAL:
    'action op=delegate with a subgoal describing the control. System1 chooses the click. Do not pass x,y or a ref',
  NO_TARGET:
    'action op=delegate with a subgoal naming the control. Do not pass a ref or x,y. If the page forbids the act, run + sys.eval world:"MAIN" on this tabId',
  PAYMENT_DENIED: 'stop; payment surfaces are not dispatched',
  PERMISSION_REQUIRED:
    'tell the user which ability is off (see permission) and that they can turn it on in Settings → Advanced abilities; meanwhile use action ops that do not need it',
  SNAPSHOT_TOO_LARGE: 'pass a smaller a1; do not silently truncate',
  STALE_REF: 'action op=snapshot if you need to read the page, then op=delegate with the control name as subgoal. Do not pass the old ref',
  VISUAL_UNCHANGED: 'do not repeat that click; delegate a different subgoal, or snapshot',
  SYS_DENIED: 'inspect view=sys and pick an allowed op',
  TAB_LEASED: 'wait for the other session to finish, or target a different tabId',
  TAB_NOT_VISIBLE: 'bring the tab into a visible window, then snapshot, listen or record again',
  TARGET_CHANGED: 'action op=snapshot on the current document, then retry with the new rev',
  TASK_UNAVAILABLE: 'continue within the authorized goal; use a task-capable host when waiting or future follow-up is needed',
  TASK_YIELDED: 'stop calling tools this turn; wait or complete already yielded',
  TICKET_REQUIRED: 'retry the same call after the host approval ticket is issued',
  TOO_LARGE: 'use a file under the size cap, or sys.fetch as:"page" with saveTo',
  TOOL_FAILED: 'read error and retry with corrected arguments',
  UPLOAD_REJECTED: 'action op=snapshot, then upload to the file input or dropzone with a new rev'
});

export function hintForToolFailure(code, existingHint) {
  const kept = existingHint != null && String(existingHint).trim() ? String(existingHint).trim() : '';
  if (kept) return kept;
  const key = String(code || '').trim();
  return TOOL_FAILURE_HINTS[key] || TOOL_FAILURE_HINTS.TOOL_FAILED;
}

/**
 * Normalize a failed tool object to { ok:false, code, error, hint }.
 * Success and non-objects are returned unchanged.
 * @param {unknown} result
 */
export function attachToolFailureHint(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.ok !== false) return result;
  const code = String(result.code || 'TOOL_FAILED');
  const error =
    result.error != null
      ? String(result.error)
      : result.message != null
        ? String(result.message)
        : 'tool failed';
  return { ...result, ok: false, code, error, hint: hintForToolFailure(code, result.hint) };
}
