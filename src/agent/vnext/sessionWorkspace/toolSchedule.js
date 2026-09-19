/**
 * Model-visible tool set is always the full session surface.
 * Inventory is a targeting index, not a progressive-disclosure gate.
 */

import { SESSION_TOOL_NAMES } from './canvasInventory.js';
import { formatFrozenPlanInstructions } from './planContract.js';
import { formatTaskInstructions } from './taskInstructions.js';

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
 * @param {{ store?: object, sessionId?: string, fs?: object, tools?: Record<string, any>, execution?: object, instructions?: string, taskContext?: object|null, getTaskContext?: Function }} env
 */
export function makeOfficePrepareStep(env = {}) {
  return async function prepareStep() {
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
    const pinned = formatFrozenPlanInstructions(env.execution?.frozenPlan);
    const additions = [taskText, pinned].filter(Boolean);
    const media = env.mediaContext ? await env.mediaContext.refresh() : env.mediaCapabilities;
    if (media) additions.push(`Current chat media input (host-resolved for this step): ${JSON.stringify(media)}\nVideo picture capability does not prove soundtrack perception; when videoAudio is unknown, use separate audio input or STT for sound evidence. Never issue capability checks from tools.`);
    if (additions.length) {
      const base = String(env.instructions || '').trim();
      out.instructions = [base, ...additions].filter(Boolean).join('\n\n');
    }
    return out;
  };
}
