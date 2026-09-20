/**
 * BrowserBot agent trajectory — record / serialize / redact for dev export.
 *
 * Human owns completion: conversation.humanStatus is only set by the user
 * (export modal or sticky control). Model `finish` ≠ human completed.
 */

import { truncateText, MAX_OBSERVATION_CHARS } from './state.js';
import {
  BEHAVIOR_TRAJECTORY_SCHEMA,
  serializeBehaviorTrajectory,
  MAX_TURN_THOUGHT_CHARS
} from './vnext/sessionWorkspace/behaviorPath.js';

/** Schema id for exported JSON — behavior path (tools + host), not a chat dump. */
export const TRAJECTORY_SCHEMA = BEHAVIOR_TRAJECTORY_SCHEMA;

export { serializeBehaviorTrajectory, BEHAVIOR_TRAJECTORY_SCHEMA };

/** chrome.storage.local key: enable dev trajectory download UI (default true when unset) */
export const DEV_TRAJECTORY_STORAGE_KEY = 'browserbot_dev_trajectory';

/** Per tool result / observation cap for trajectory export (debug-friendly) */
export const TRAJECTORY_OBS_MAX_CHARS = 8000;

/**
 * Cap for step `reasoning` when closing a step (storage + export).
 * Long-thinking models can emit tens of KB of chain-of-thought; keep enough for
 * abort/debug export. Trajectory is dev-oriented — large runs can grow
 * chrome.storage.local; MAX_RUN_STEPS_STORED / MAX_SESSION_TRAJECTORY_RUNS still
 * bound overall size. Raise further only if downloads still look truncated.
 */
export const TRAJECTORY_REASONING_MAX_CHARS = 48000;

/** Cap for step assistantText when closing a step (not model reasoning) */
export const TRAJECTORY_ASSISTANT_TEXT_MAX_CHARS = 6000;

/** Cap runs stored on a session to limit chrome.storage growth */
export const MAX_SESSION_TRAJECTORY_RUNS = 30;

/** Cap steps kept per run in storage */
export const MAX_RUN_STEPS_STORED = 64;

/** Cap chat messages included in export */
export const MAX_EXPORT_MESSAGES = 200;

/** Cap message content chars in export */
export const MAX_EXPORT_MESSAGE_CHARS = 12000;

/** Secret-like key name patterns (redacted in args/results deep walk) */
const SECRET_KEY_RE =
  /^(api[_-]?key|apikey|authorization|auth|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|sk[-_])/i;

/** Ordinary arrays share this cap; events / wire / audit keep their persist length. */
export const REDACT_ARRAY_CAP = 100;
const PRESERVE_ARRAY_KEYS = new Set(['events', 'wire']);

const HUMAN_STATUS_VALUES = new Set([
  'unknown',
  'in_progress',
  'completed',
  'failed',
  'partial',
  'cancelled'
]);

const RUN_STATUS_VALUES = new Set([
  'running',
  'finished',
  'aborted',
  'error',
  'waiting_user'
]);

/**
 * Host only from base URL — never full URL with credentials, never API key.
 * @param {string} [baseURL]
 * @returns {string}
 */
export function baseURLHost(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') return '';
  try {
    const u = new URL(baseURL.includes('://') ? baseURL : `https://${baseURL}`);
    return u.host || '';
  } catch {
    // Fallback: strip path-ish noise
    return String(baseURL)
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split('?')[0]
      .slice(0, 200);
  }
}

/**
 * Truncate text for trajectory (reuse state.truncateText with higher default).
 * @param {unknown} text
 * @param {number} [maxChars]
 */
export function truncateForTrajectory(text, maxChars = TRAJECTORY_OBS_MAX_CHARS) {
  return truncateText(text, maxChars);
}

/**
 * Deep-clone-ish redact of objects: strip secret keys, truncate long strings.
 * Never leave raw API keys in exported JSON.
 * Turn `events`, `wire`, and `sessionAudit.events` keep their full persist
 * length. Other arrays may still cap; the cut is marked.
 * @param {unknown} value
 * @param {{ maxString?: number, depth?: number, skipClip?: boolean, preserveArray?: boolean, arrayCap?: number }} [opts]
 * @returns {unknown}
 */
export function redactSecrets(value, opts = {}) {
  const maxString = opts.maxString ?? TRAJECTORY_OBS_MAX_CHARS;
  const depth = opts.depth ?? 0;
  const skipClip = opts.skipClip === true;
  const preserveArray = opts.preserveArray === true;
  const arrayCap = Number.isFinite(opts.arrayCap) ? opts.arrayCap : REDACT_ARRAY_CAP;
  if (depth > 12) return '[max depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    // Heuristic: long sk- tokens
    if (/sk-[a-zA-Z0-9]{16,}/.test(value) || /Bearer\s+[A-Za-z0-9._-]{20,}/i.test(value)) {
      return '[REDACTED]';
    }
    if (skipClip) return value;
    return truncateForTrajectory(value, maxString);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const childOpts = { maxString, depth: depth + 1, skipClip, arrayCap };
    if (preserveArray) {
      return value.map((v) => redactSecrets(v, childOpts));
    }
    const mapped = value.slice(0, arrayCap).map((v) => redactSecrets(v, childOpts));
    if (value.length > arrayCap) {
      mapped.push({ truncated: true, omitted: value.length - arrayCap });
    }
    return mapped;
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    const eventSkip = value.type === 'thought' || value.type === 'text';
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      // Never export nested provider key blobs
      if (k === 'apiKey' || k === 'api_key') {
        out[k] = '[REDACTED]';
        continue;
      }
      const childSkip = skipClip || k === 'thought' || k === 'text' || eventSkip;
      out[k] = redactSecrets(v, {
        maxString,
        depth: depth + 1,
        skipClip: childSkip,
        preserveArray: PRESERVE_ARRAY_KEYS.has(k),
        arrayCap
      });
    }
    return out;
  }
  return String(value).slice(0, 200);
}

/**
 * Infer tool success/fail from observation string/object.
 * @param {unknown} result
 * @returns {{ ok: boolean, errorCode: string }}
 */
export function inferToolResultMeta(result) {
  let ok = true;
  let errorCode = '';
  let parsed = null;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      // plain string — treat as ok unless it looks like an error blob
      if (/^\s*\{/.test(result) && /"status"\s*:\s*"(error|cancelled|failed)"/.test(result)) {
        ok = false;
      }
      return { ok, errorCode };
    }
  } else if (result && typeof result === 'object') {
    parsed = result;
  }
  if (parsed && typeof parsed === 'object') {
    const st = String(parsed.status || '').toLowerCase();
    if (
      st === 'error' ||
      st === 'cancelled' ||
      st === 'failed' ||
      st === 'denied' ||
      st === 'timeout'
    ) {
      ok = false;
    }
    if (parsed.code) errorCode = String(parsed.code);
    else if (!ok && parsed.message) errorCode = 'ERROR';
  }
  return { ok, errorCode };
}

/**
 * Normalize human status enum.
 * @param {string} [status]
 * @returns {string}
 */
export function normalizeHumanStatus(status) {
  const s = String(status || 'unknown').toLowerCase().trim();
  return HUMAN_STATUS_VALUES.has(s) ? s : 'unknown';
}

/**
 * Ensure session has a trajectory bag (mutates session).
 * @param {object} session
 * @returns {object} session.trajectory
 */
export function ensureSessionTrajectory(session) {
  if (!session || typeof session !== 'object') {
    return {
      humanStatus: 'unknown',
      humanStatusNote: '',
      humanStatusSetAt: null,
      runs: []
    };
  }
  if (!session.trajectory || typeof session.trajectory !== 'object') {
    session.trajectory = {
      humanStatus: 'unknown',
      humanStatusNote: '',
      humanStatusSetAt: null,
      runs: []
    };
  }
  if (!Array.isArray(session.trajectory.runs)) session.trajectory.runs = [];
  if (!session.trajectory.humanStatus) session.trajectory.humanStatus = 'unknown';
  if (session.trajectory.humanStatusNote == null) session.trajectory.humanStatusNote = '';
  return session.trajectory;
}

/**
 * User sets conversation-level human status (never auto from model finish).
 * @param {object} session
 * @param {string} status
 * @param {string} [note]
 */
export function setSessionHumanStatus(session, status, note = '') {
  const bag = ensureSessionTrajectory(session);
  bag.humanStatus = normalizeHumanStatus(status);
  bag.humanStatusNote = note != null ? String(note).slice(0, 2000) : '';
  bag.humanStatusSetAt = new Date().toISOString();
  return bag;
}

/**
 * Create a mutable trajectory run recorder (one agent invocation).
 * @param {object} opts
 */
export function createTrajectoryRun(opts = {}) {
  const page = opts.pageMeta || null;
  let domain = '';
  let url = '';
  let title = '';
  if (page && typeof page === 'object') {
    url = String(page.url || '').slice(0, 2000);
    title = String(page.title || '').slice(0, 500);
    domain = String(page.domain || '').slice(0, 200);
    if (!domain && url) {
      try {
        domain = new URL(url).hostname;
      } catch {
        /* ignore */
      }
    }
  }

  return {
    runId: opts.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: opts.startedAt || new Date().toISOString(),
    endedAt: null,
    status: 'running',
    finishReason: null,
    error: null,
    agentFinished: false,
    finishSummary: '',
    config: {
      model: String(opts.model || '').slice(0, 200),
      providerId: opts.providerId ? String(opts.providerId).slice(0, 120) : '',
      providerName: opts.providerName ? String(opts.providerName).slice(0, 120) : '',
      baseURLHost: baseURLHost(opts.baseURL || opts.apiBase || ''),
      planMode: !!opts.planMode,
      reasoning: !!opts.reasoning,
      lang: opts.lang || 'zh',
      maxSteps: opts.maxSteps || null
    },
    context: {
      userPrompt: truncateForTrajectory(opts.prompt || opts.userPrompt || '', 8000),
      page: { url, title, domain },
      selectionSummary: String(opts.selectionSummary || '').slice(0, 500),
      elementCount: Number(opts.elementCount) || 0,
      skillName: opts.skillName || null
    },
    steps: [],
    events: [],
    metrics: {},
    /** @private live step buffer */
    _currentStep: null
  };
}

/**
 * Append a run-level event (script_confirm, ask_user, user_abort, submit_confirm, …).
 * @param {object} run
 * @param {object} event
 */
export function appendTrajectoryEvent(run, event) {
  if (!run || !event) return;
  if (!Array.isArray(run.events)) run.events = [];
  const ts = event.ts || Date.now();
  const type = String(event.type || 'event');
  /** @type {Record<string, unknown>} */
  const safe = { type, ts };
  for (const [k, v] of Object.entries(event)) {
    if (k === 'type' || k === 'ts') continue;
    if (SECRET_KEY_RE.test(k)) {
      safe[k] = '[REDACTED]';
      continue;
    }
    if (typeof v === 'string') {
      safe[k] = truncateForTrajectory(v, k === 'code' ? 4000 : 4000);
    } else if (typeof v === 'object' && v != null) {
      safe[k] = redactSecrets(v, { maxString: 2000 });
    } else {
      safe[k] = v;
    }
  }
  run.events.push(safe);
  // Cap event list
  if (run.events.length > 200) {
    run.events = run.events.slice(-200);
  }
}

/**
 * Start a new step buffer on the run.
 * @param {object} run
 * @param {number} step
 */
export function trajectoryStartStep(run, step) {
  if (!run) return null;
  // Flush previous open step if any
  if (run._currentStep) {
    trajectoryEndStep(run);
  }
  run._currentStep = {
    step: step,
    ts: Date.now(),
    reasoning: '',
    assistantText: '',
    toolCalls: [],
    toolResults: []
  };
  return run._currentStep;
}

/**
 * Append deltas / tool data into current step.
 * @param {object} run
 * @param {'reasoning'|'text'|'tool_call'|'tool_result'} kind
 * @param {object} payload
 */
export function trajectoryStepPart(run, kind, payload = {}) {
  if (!run) return;
  if (!run._currentStep) {
    trajectoryStartStep(run, (run.steps?.length || 0) + 1);
  }
  const cur = run._currentStep;
  if (kind === 'reasoning') {
    cur.reasoning += String(payload.text || '');
  } else if (kind === 'text') {
    cur.assistantText += String(payload.text || payload.chunk || '');
  } else if (kind === 'tool_call') {
    cur.toolCalls.push({
      id: payload.id || payload.toolCallId || '',
      name: String(payload.name || ''),
      arguments: redactSecrets(payload.arguments || payload.args || {}, {
        maxString: 4000
      })
    });
  } else if (kind === 'tool_result') {
    const raw =
      typeof payload.result === 'string'
        ? payload.result
        : truncateForTrajectory(JSON.stringify(payload.result ?? ''), TRAJECTORY_OBS_MAX_CHARS);
    const meta = inferToolResultMeta(raw);
    const ok = payload.ok != null ? !!payload.ok : meta.ok;
    const errorCode = payload.errorCode || meta.errorCode || '';
    cur.toolResults.push({
      toolCallId: payload.toolCallId || payload.id || '',
      name: String(payload.name || ''),
      result: truncateForTrajectory(raw, TRAJECTORY_OBS_MAX_CHARS),
      ok,
      errorCode
    });

    // Infer submit_confirm from tool observation (content_script gate)
    tryInferSubmitConfirmEvent(run, payload.name, raw);
  }
}

/**
 * Detect in-page submit confirm from invoke tool results.
 * @param {object} run
 * @param {string} name
 * @param {string} raw
 */
function tryInferSubmitConfirmEvent(run, name, raw) {
  if (!raw || typeof raw !== 'string') return;
  if (name && name !== 'invoke' && name !== 'click') {
    // still scan if code present
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.code === 'SUBMIT_CONFIRM_REQUIRED' || parsed.needsUserConfirm) {
    appendTrajectoryEvent(run, {
      type: 'submit_confirm',
      allowed: false,
      reason: parsed.reason || 'cancelled',
      ts: Date.now()
    });
    return;
  }
  if (parsed.userConfirmedSubmit === true) {
    appendTrajectoryEvent(run, {
      type: 'submit_confirm',
      allowed: true,
      reason: 'confirmed',
      ts: Date.now()
    });
  }
}

/**
 * Close current step into run.steps.
 * @param {object} run
 */
export function trajectoryEndStep(run) {
  if (!run || !run._currentStep) return;
  const cur = run._currentStep;
  run._currentStep = null;
  // Truncate bulky fields for storage / session attach.
  // Reasoning uses TRAJECTORY_REASONING_MAX_CHARS so abort/export keeps long CoT
  // (not the old 6k debug kill). Trajectory remains dev-oriented for storage size.
  const stored = {
    step: cur.step,
    ts: cur.ts,
    reasoning: truncateForTrajectory(
      cur.reasoning || '',
      TRAJECTORY_REASONING_MAX_CHARS
    ),
    assistantText: truncateForTrajectory(
      cur.assistantText || '',
      TRAJECTORY_ASSISTANT_TEXT_MAX_CHARS
    ),
    toolCalls: (cur.toolCalls || []).map((c) => ({
      id: c.id || '',
      name: c.name || '',
      arguments: redactSecrets(c.arguments || {}, { maxString: 4000 })
    })),
    toolResults: (cur.toolResults || []).map((r) => ({
      toolCallId: r.toolCallId || '',
      name: r.name || '',
      result: truncateForTrajectory(r.result || '', TRAJECTORY_OBS_MAX_CHARS),
      ok: r.ok !== false,
      errorCode: r.errorCode || ''
    }))
  };
  if (!Array.isArray(run.steps)) run.steps = [];
  run.steps.push(stored);
  if (run.steps.length > MAX_RUN_STEPS_STORED) {
    run.steps = run.steps.slice(-MAX_RUN_STEPS_STORED);
  }
}

/**
 * Mark finish tool was called (does NOT set humanStatus).
 * @param {object} run
 * @param {string} summary
 */
export function trajectoryMarkAgentFinished(run, summary = '') {
  if (!run) return;
  run.agentFinished = true;
  run.finishSummary = truncateForTrajectory(summary || '', 4000);
}

/**
 * Finalize run status/metrics.
 * @param {object} run
 * @param {object} [opts]
 */
export function finalizeTrajectoryRun(run, opts = {}) {
  if (!run) return null;
  if (run._currentStep) trajectoryEndStep(run);

  run.endedAt = opts.endedAt || new Date().toISOString();
  if (opts.status && RUN_STATUS_VALUES.has(opts.status)) {
    run.status = opts.status;
  } else if (run.status === 'running') {
    run.status = 'finished';
  }
  if (opts.finishReason != null) run.finishReason = String(opts.finishReason).slice(0, 200);
  if (opts.error) {
    run.error = {
      message: truncateForTrajectory(
        opts.error.message || String(opts.error) || '',
        2000
      ),
      code: String(opts.error.code || opts.error.message || '').slice(0, 120)
    };
  }
  if (opts.metrics && typeof opts.metrics === 'object') {
    run.metrics = redactSecrets(opts.metrics, { maxString: 500 });
  }
  if (opts.agentFinished) {
    run.agentFinished = true;
  }
  if (opts.finishSummary) {
    run.finishSummary = truncateForTrajectory(opts.finishSummary, 4000);
  }
  return serializeTrajectoryRun(run);
}

/**
 * Strip private fields for storage/export.
 * @param {object} run
 */
export function serializeTrajectoryRun(run) {
  if (!run) return null;
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status || 'finished',
    finishReason: run.finishReason || null,
    error: run.error || null,
    agentFinished: !!run.agentFinished,
    finishSummary: run.finishSummary || '',
    config: {
      model: run.config?.model || '',
      providerId: run.config?.providerId || '',
      providerName: run.config?.providerName || '',
      baseURLHost: run.config?.baseURLHost || '',
      planMode: !!run.config?.planMode,
      reasoning: !!run.config?.reasoning,
      lang: run.config?.lang || 'zh',
      maxSteps: run.config?.maxSteps ?? null
    },
    context: {
      userPrompt: truncateForTrajectory(run.context?.userPrompt || '', 8000),
      page: {
        url: run.context?.page?.url || '',
        title: run.context?.page?.title || '',
        domain: run.context?.page?.domain || ''
      },
      selectionSummary: run.context?.selectionSummary || '',
      elementCount: run.context?.elementCount || 0,
      skillName: run.context?.skillName ?? null
    },
    steps: Array.isArray(run.steps) ? run.steps : [],
    events: Array.isArray(run.events) ? run.events : [],
    metrics: run.metrics || {},
    // Full UI thought buffer (tools + model text) when reasoning-delta was empty
    uiThought: run.uiThought
      ? truncateForTrajectory(String(run.uiThought), TRAJECTORY_REASONING_MAX_CHARS)
      : undefined
  };
}

/**
 * Attach a finished run to session.trajectory (mutates session).
 * @param {object} session
 * @param {object} runSerialized
 */
export function attachRunToSession(session, runSerialized) {
  if (!session || !runSerialized) return;
  const bag = ensureSessionTrajectory(session);
  const safe = serializeTrajectoryRun(runSerialized) || runSerialized;
  bag.runs.push(safe);
  if (bag.runs.length > MAX_SESSION_TRAJECTORY_RUNS) {
    bag.runs = bag.runs.slice(-MAX_SESSION_TRAJECTORY_RUNS);
  }
}

/**
 * Build export document: chat bubbles + thought + reply + tools + host + model/usage.
 * Prefers workspace messages (`path` / `toolCalls` / `wire`) when provided.
 * @param {object} opts
 * @param {object} opts.session - workspace or sidepanel session
 * @param {Array<object>} [opts.messages]
 * @param {string} [opts.humanStatus]
 * @param {string} [opts.humanStatusNote]
 * @returns {object}
 */
export function serializeConversationTrajectory(opts = {}) {
  const session = opts.session || {};
  const bag = ensureSessionTrajectory(session);

  let humanStatus = bag.humanStatus || 'unknown';
  let humanStatusNote = bag.humanStatusNote || '';
  let humanStatusSetAt = bag.humanStatusSetAt || null;

  if (opts.humanStatus != null && opts.humanStatus !== '') {
    humanStatus = normalizeHumanStatus(opts.humanStatus);
    if (opts.humanStatusNote != null) {
      humanStatusNote = String(opts.humanStatusNote).slice(0, 2000);
    }
    humanStatusSetAt = new Date().toISOString();
  }

  const messages = Array.isArray(opts.messages)
    ? opts.messages
    : Array.isArray(session.messages)
      ? session.messages
      : [];

  return serializeBehaviorTrajectory({
    session: {
      sessionId: session.sessionId || session.id || '',
      title: session.title || session.name || '',
      messages
    },
    messages,
    humanStatus,
    humanStatusNote,
    humanStatusSetAt
  });
}

/**
 * Safe JSON string for download (second pass redact of whole tree).
 * @param {object} doc
 * @returns {string}
 */
export function trajectoryToDownloadJson(doc) {
  // First-class thought/text events are the CoT source of truth (up to 256k).
  // Do not re-clip them to the 48k reasoning / 12k bubble caps.
  const maxString = Math.max(
    MAX_TURN_THOUGHT_CHARS,
    TRAJECTORY_REASONING_MAX_CHARS,
    TRAJECTORY_OBS_MAX_CHARS + 2000,
    MAX_EXPORT_MESSAGE_CHARS
  );
  const cleaned = redactSecrets(doc, { maxString });
  if (cleaned && typeof cleaned === 'object') {
    cleaned.schema = doc?.schema || TRAJECTORY_SCHEMA;
    if (doc?.kind) cleaned.kind = doc.kind;
  }
  return JSON.stringify(cleaned, null, 2);
}

/**
 * Filename for trajectory download.
 * @param {string} sessionId
 * @param {Date} [date]
 */
export function trajectoryDownloadFilename(sessionId, date = new Date()) {
  const sid = String(sessionId || 'session')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 40);
  const d = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `browserbot-trajectory-${sid}-${d}.json`;
}

// Re-export for tests / consumers that only need observation cap alignment
export { MAX_OBSERVATION_CHARS };
