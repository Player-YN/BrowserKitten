/**
 * One access mode. There is no user setting to switch.
 *
 * Every mutating page action and sys call still passes the host gate
 * (operationGate → dispatchTicket), whose rules do not depend on a mode:
 *   known payment → never dispatched
 *   known delete  → one-shot host approval
 *   everything else, including page scripts and CDP → dispatched (best effort; the
 *   classifier is heuristic and raw code can reach anything the page can)
 *
 * The former Guarded / Full storage keys are deleted on startup (clearLegacyAccessPolicy).
 * Journal rows keep `accessMode` for compatibility; it is always "full".
 */

import { STORAGE_ACCESS_POLICY, STORAGE_ACCESS_POLICY_SESSION } from '../../../brand.js';

export const ACCESS_MODE = 'full';

const POLICY = Object.freeze({ mode: ACCESS_MODE, source: 'fixed' });

export async function readEffectiveAccessPolicy() {
  return POLICY;
}

export function snapshotAccessPolicy(effective = POLICY, now = Date.now()) {
  return { ...effective, frozenAt: now };
}

/** Remove the old per-profile and per-session mode keys. Safe to call repeatedly. */
export async function clearLegacyAccessPolicy(areas) {
  const local = areas?.local ?? globalThis.chrome?.storage?.local;
  const session = areas?.session ?? globalThis.chrome?.storage?.session;
  await Promise.all([
    local?.remove?.(STORAGE_ACCESS_POLICY)?.catch?.(() => {}),
    session?.remove?.(STORAGE_ACCESS_POLICY_SESSION)?.catch?.(() => {})
  ]);
}
