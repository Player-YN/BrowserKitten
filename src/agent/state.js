/**
 * BrowserBot Browser Agent — session / run state helpers
 */

/** Internal safety ceiling only — not a user setting (loops stop on finish/abort). */
/** Safety ceiling — sidepanel may pass a lower maxSteps (e.g. 20). */
export const DEFAULT_MAX_STEPS = 20;
export const MAX_HISTORY_TURNS = 12;
export const MAX_OBSERVATION_CHARS = 6000;
export const MAX_DOM_SUMMARY_CHARS = 2500;

/**
 * @typedef {Object} AgentTraceStep
 * @property {number} step
 * @property {string} [thought]
 * @property {Array<{id?: string, name: string, arguments: object}>} [toolCalls]
 * @property {Array<{toolCallId?: string, name: string, result: string}>} [observations]
 * @property {string} [assistantText]
 * @property {number} ts
 */

/**
 * @typedef {Object} AgentRunState
 * @property {string} runId
 * @property {string} sessionId
 * @property {number} step
 * @property {number} maxSteps
 * @property {boolean} done
 * @property {boolean} aborted
 * @property {boolean} waitingForUser
 * @property {AgentTraceStep[]} traces
 * @property {Array<{role: string, content?: string, tool_calls?: any[], tool_call_id?: string, name?: string}>} messages
 * @property {string} finalText
 * @property {string} extractedCode
 * @property {object|null} metrics
 */

export function createRunState({ sessionId = 'default', maxSteps = DEFAULT_MAX_STEPS } = {}) {
  return {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    step: 0,
    maxSteps: maxSteps || DEFAULT_MAX_STEPS,
    done: false,
    aborted: false,
    waitingForUser: false,
    traces: [],
    messages: [],
    finalText: '',
    extractedCode: '',
    metrics: null,
    /** B1: chat | shape | task */
    intent: null,
    intentConfidence: null,
    /** B3: chat | shape | plan | execute | verify */
    phase: null,
    /** B2: Task Brief { goal, scope, format, limits, success_checks[] } */
    taskBrief: null,
    /**
     * D2 finish gate run log (mutations / successful verify_*).
     * Runtime assigns createRunToolLog() from tools.js.
     */
    runToolLog: null,
    /** @type {'not_required'|'verified'|'unverified'|null} */
    finishVerification: null
  };
}

export function truncateText(text, maxChars = MAX_OBSERVATION_CHARS) {
  if (text == null) return '';
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…[truncated ${s.length - maxChars} chars]`;
}

export function compactHistoryMessages(messages, maxTurns = MAX_HISTORY_TURNS) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  // Keep system separate; trim oldest user/assistant pairs
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const capped = rest.slice(-Math.max(2, maxTurns * 2));
  return [...system, ...capped];
}

export function serializeTraceForStorage(traces, maxSteps = 20) {
  if (!Array.isArray(traces)) return [];
  return traces.slice(-maxSteps).map((t) => ({
    step: t.step,
    thought: truncateText(t.thought || '', 2000),
    toolCalls: (t.toolCalls || []).map((c) => ({
      name: c.name,
      arguments: c.arguments
    })),
    observations: (t.observations || []).map((o) => ({
      name: o.name,
      result: truncateText(o.result || '', 1500)
    })),
    assistantText: truncateText(t.assistantText || '', 2000),
    ts: t.ts
  }));
}
