/**
 * Model-visible tool set is always the full session surface.
 * Inventory is a targeting index, not a progressive-disclosure gate.
 */

import { SESSION_TOOL_NAMES } from './canvasInventory.js';
import { formatFrozenPlanInstructions } from './planContract.js';
import { formatTaskInstructions } from './taskInstructions.js';
import { formatUserRequestInstructions } from './sessionIntent.js';
import {
  COMPACT_RATIO,
  contextUsageRatio,
  estimateMessagesTokens,
  estimateTextTokens
} from './contextCompact.js';

/**
 * @param {{ sheet?: string[], doc?: string[], web?: string[] }} [inventory]
 * @param {{ tabUnfocused?: boolean }} [runtime]
 * @returns {string[]}
 */
export function scheduleActiveToolNames(inventory = {}, runtime = {}) {
  void inventory;
  void runtime.tabUnfocused;
  return [...SESSION_TOOL_NAMES];
}

/**
 * @param {Record<string, any>} tools
 * @param {object} [inventory]
 * @param {{ tabUnfocused?: boolean }} [runtime]
 */
export function scheduleSessionTools(tools, inventory, runtime = {}) {
  const names = scheduleActiveToolNames(inventory, runtime);
  /** @type {Record<string, any>} */
  const out = {};
  for (const n of names) {
    if (tools && tools[n]) out[n] = tools[n];
  }
  return out;
}

/**
 * prepareStep keeps the same always-on list each hop (no mid-turn hide/reveal).
 * After the user approves a plan, re-inject the pinned contract every step.
 * Occupancy over COMPACT_RATIO can return shortened `messages` (SDK wire only).
 * @param {{ store?: object, sessionId?: string, fs?: object, tools?: Record<string, any>, execution?: object, instructions?: string, taskContext?: object|null, getTaskContext?: Function, contextWindow?: number, onMidLoopCompact?: Function }} env
 */
export function makeOfficePrepareStep(env = {}) {
  let lastHop = -1;
  let lastThrough = '';
  let busy = false;
  return async function prepareStep(step = {}) {
    const out = { activeTools: [...SESSION_TOOL_NAMES] };
    let task = env.taskContext || null;
    if (typeof env.getTaskContext === 'function') {
      try {
        task = (await env.getTaskContext()) || task;
      } catch {
        /* retain the last host snapshot */
      }
    }
    const taskText = formatTaskInstructions(task);
    const pinned = taskText ? '' : formatFrozenPlanInstructions(env.execution?.frozenPlan);
    const media = env.mediaContext ? await env.mediaContext.refresh() : env.mediaCapabilities;
    const refreshInstructions = () => {
      const sess = env.store && env.sessionId ? env.store.get('sessions', env.sessionId) : env.session || null;
      const additions = [
        taskText,
        pinned,
        formatUserRequestInstructions(sess, env.contextWindow)
      ].filter(Boolean);
      if (media) additions.push(
        `Current chat media input (host-resolved for this step): ${JSON.stringify(media)}\nVideo picture capability does not prove soundtrack perception; when videoAudio is unknown, use separate audio input or STT for sound evidence. Never issue capability checks from tools.`
      );
      if (additions.length) out.instructions = [String(env.instructions || '').trim(), ...additions].filter(Boolean).join('\n\n');
    };
    refreshInstructions();
    const sdkMessages = step.messages;
    const hop = Array.isArray(step.steps) ? step.steps.length : 0;
    if (
      Array.isArray(sdkMessages) &&
      typeof env.onMidLoopCompact === 'function' &&
      !busy &&
      hop !== lastHop
    ) {
      const tokens =
        estimateMessagesTokens(sdkMessages) + estimateTextTokens(out.instructions || env.instructions);
      if (contextUsageRatio(tokens, env.contextWindow) >= COMPACT_RATIO) {
        busy = true;
        try {
          const result = await env.onMidLoopCompact({
            messages: sdkMessages,
            steps: step.steps,
            promptTokens: tokens
          });
          if (Array.isArray(result?.messages)) {
            out.messages = result.messages;
            // A first mid-turn compact may have just established the goal.
            // The very request using that compact must carry the source too.
            refreshInstructions();
            lastHop = hop;
            if (result.throughMessageId) lastThrough = result.throughMessageId;
          } else if (lastThrough && result?.throughMessageId === lastThrough) {
            lastHop = hop;
          }
        } finally {
          busy = false;
        }
      }
    }
    return out;
  };
}
