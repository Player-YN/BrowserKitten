/**
 * Progress notes: the model's own prose from steps that END IN TOOL CALLS.
 * A text-only step ends ToolLoopAgent's loop and becomes the final answer,
 * so progress must ride along with a tool call in the same step. No new
 * tool, no extra step. Notes are user-facing prose, never raw reasoning.
 *
 * Host side: the stream emitter turns commentary into `progress-note` events;
 * sendMessage persists them on `session.turnProgress` while the turn runs and
 * on the turn's assistant record (`progress`) when it settles; prepareStep
 * nudges once per long silent gap.
 */

export const PROGRESS_NOTE_MAX = 600;
export const PROGRESS_NOTES_CAP = 60;
export const PROGRESS_NUDGE_STEPS = 6;
export const PROGRESS_NUDGE_MS = 60_000;

export const PROGRESS_NUDGE_TEXT =
  'Progress reminder (host): the user has seen no progress note for a while. In the same step as your next tool call, write one or two sentences in the user\'s language: what was done or found, and what comes next. Do not echo tool arguments or reasoning. Do not write it as a step without a tool call — that ends the turn.';

/** Bounded prose. Keeps line breaks; collapses runs of blank lines. */
export function normalizeProgressText(text, max = PROGRESS_NOTE_MAX) {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!t || t === '[object Object]') return '';
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

function finishIsToolCalls(fr) {
  const s = typeof fr === 'string' ? fr : fr && typeof fr === 'object' ? fr.unified || fr.reason || '' : '';
  return /tool-call/i.test(String(s));
}

function deltaText(part) {
  const v = part?.text ?? part?.delta ?? part?.textDelta;
  return typeof v === 'string' ? v : '';
}

/**
 * Stream-side extractor. Feed every fullStream part in order; returns a
 * `progress-note` event (or null). The note is emitted at the step's first
 * tool-call part so it precedes that step's activity rows; text that only
 * arrives after the calls is emitted at finish-step if the step ended in
 * tool calls. A step that ends without tool calls never yields a note.
 *
 * @param {{ now?: () => number }} [opts]
 */
export function createProgressNoteEmitter(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let stepIndex = -1;
  let stepText = '';
  let emitted = false;
  let toolIndex = 0;
  const note = (text) => ({
    type: 'progress-note',
    text,
    stepIndex: Math.max(0, stepIndex),
    toolIndex,
    at: now()
  });
  return {
    ingest(part) {
      const type = String(part?.type || '');
      if (type === 'start-step' || type === 'step-start') {
        stepIndex += 1;
        stepText = '';
        emitted = false;
        return null;
      }
      if (type === 'text-delta') {
        stepText += deltaText(part);
        return null;
      }
      if (type === 'tool-call') {
        let ev = null;
        const text = emitted ? '' : normalizeProgressText(stepText);
        if (text) {
          emitted = true;
          ev = note(text);
        }
        toolIndex += 1;
        return ev;
      }
      if (type === 'finish-step') {
        const text = emitted || !finishIsToolCalls(part.finishReason) ? '' : normalizeProgressText(stepText);
        emitted = true;
        return text ? note(text) : null;
      }
      return null;
    }
  };
}

/** Same rule over finished SDK steps (generate() fallback, tests). */
export function progressNotesFromSteps(steps, { now = Date.now() } = {}) {
  const out = [];
  let toolIndex = 0;
  (Array.isArray(steps) ? steps : []).forEach((step, stepIndex) => {
    const calls = Array.isArray(step?.toolCalls) ? step.toolCalls.length : 0;
    const text = calls > 0 || finishIsToolCalls(step?.finishReason) ? normalizeProgressText(step?.text) : '';
    if (text) out.push({ type: 'progress-note', text, stepIndex, toolIndex, at: now });
    toolIndex += calls;
  });
  return out;
}

/** Persisted shape: `{ at, text, stepIndex, toolIndex }`, capped. */
export function appendProgressNote(notes, ev) {
  const list = Array.isArray(notes) ? notes.slice() : [];
  const text = normalizeProgressText(ev?.text);
  if (!text) return list;
  list.push({
    at: Number(ev.at) || Date.now(),
    text,
    stepIndex: Math.max(0, Number(ev.stepIndex) || 0),
    toolIndex: Math.max(0, Number(ev.toolIndex) || 0)
  });
  return list.length > PROGRESS_NOTES_CAP ? list.slice(list.length - PROGRESS_NOTES_CAP) : list;
}

/**
 * A task-yield stop can end on a tool-call step whose prose was already a
 * note; the SDK then reports that prose as the final text. The answer owns it.
 */
export function dropEchoedFinalNote(notes, finalText) {
  const list = Array.isArray(notes) ? notes : [];
  const last = list[list.length - 1];
  const fin = normalizeProgressText(finalText);
  if (last && fin && normalizeProgressText(last.text) === fin) return list.slice(0, -1);
  return list;
}

/**
 * Nudge bookkeeping for prepareStep. A "gap" starts at turn start or at the
 * last note; it is due after PROGRESS_NUDGE_STEPS finished steps or
 * PROGRESS_NUDGE_MS of turn time, and fires once per gap.
 * @param {{ startedAt?: number }} [opts]
 */
export function createProgressTracker(opts = {}) {
  const state = {
    anchorStep: 0,
    anchorAt: Number(opts.startedAt) || Date.now(),
    nudgedGap: -1,
    gap: 0,
    notes: 0
  };
  return {
    state,
    markNote(ev = {}) {
      state.notes += 1;
      state.gap += 1;
      state.anchorStep = Math.max(state.anchorStep, (Number(ev.stepIndex) || 0) + 1);
      state.anchorAt = Number(ev.at) || Date.now();
    },
    /** @param {{ steps?: number, now?: number }} at finished step count + clock */
    nudge({ steps = 0, now = Date.now() } = {}) {
      if (state.nudgedGap === state.gap) return '';
      const quietSteps = Math.max(0, Number(steps) - state.anchorStep);
      const quietMs = Math.max(0, Number(now) - state.anchorAt);
      if (quietSteps < PROGRESS_NUDGE_STEPS && quietMs < PROGRESS_NUDGE_MS) return '';
      // Nothing to report before the first tool step has even finished.
      if (Number(steps) < 1) return '';
      state.nudgedGap = state.gap;
      return PROGRESS_NUDGE_TEXT;
    }
  };
}
