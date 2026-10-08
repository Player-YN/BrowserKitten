/**
 * `action op=choose` loop, run in offscreen like `delegate`.
 * System1 (or a unique name match) picks one named control per step; every click is
 * an ordinary `action op=click ref rev` through hostPageAction (Access Policy + journal
 * + its own one-shot ticket + tab lease + rev/documentId), so the SW last door checks
 * each click against a ticket minted for that exact click. Nothing here dispatches a
 * page write by itself.
 */
import { fetchJevChoice, runChooseLoop } from '../host/jevSelect.js';
import { executorRiskStop } from './delegateExecutor.js';
import { BYOK_PLAN_MESSAGE, BYOK_REQUIRES_PLAN, byokAllowedForProvider } from '../../byokGate.js';

/**
 * @param {object} opts
 * @param {(payload:object) => Promise<any>} opts.host gated page-action host (offscreen _gatedPageAction)
 * @param {object} opts.base { sessionId, tabId, url, executionId }
 * @param {{subgoal?:string,until?:string,maxSteps?:number}} opts.input
 * @param {object} [opts.settings] loadLlmSettings() shape
 * @param {(step:object) => void} [opts.onStep]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(kind:string, id:string) => Promise<boolean>} [opts.byokAllowed]
 */
export async function runOffscreenChoose(opts) {
  const { host, base, input = {} } = opts;
  const settings = opts.settings || {};
  const jev = settings.jev;
  const jevVia = String(settings.jevProviderName || 'jev').slice(0, 80);
  const byokAllowed = opts.byokAllowed || byokAllowedForProvider;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const tabId = base?.tabId;
  const receipt = await runChooseLoop({
    subgoal: input.subgoal,
    until: input.until,
    maxSteps: input.maxSteps,
    onStep: opts.onStep,
    jevVia,
    observe: async () => {
      const snap = await host({ ...base, op: 'snapshot', observe: 'none' });
      if (!snap || snap.ok === false) {
        return { ok: false, code: snap?.code || 'NEED_PAGE', error: snap?.error || 'snapshot failed' };
      }
      return { ok: true, rev: snap.rev, page: snap.page, controls: snap.controls, frames: snap.frames, title: snap.title };
    },
    select: async (payload) => {
      if (!jev?.apiKey || !jev?.apiBase) {
        return { code: 'NEED_JEV', error: 'No active System1 provider. Add one in Settings, or click with ref yourself.' };
      }
      if (!(await byokAllowed('jev', settings.jevProviderId))) {
        return { code: BYOK_REQUIRES_PLAN, error: BYOK_PLAN_MESSAGE };
      }
      const chosen = await fetchJevChoice({ apiKey: jev.apiKey, apiBase: jev.apiBase, model: jev.model }, payload, fetchImpl);
      if (!chosen.ok) return { code: chosen.code, error: chosen.error };
      return { ref: chosen.ref };
    },
    act: async (picked, snap) => {
      const control = (snap?.controls || []).find((row) => row?.ref === picked.ref) || null;
      // choose is navigation: payment and delete go back to the planner before dispatch.
      // The gate and the SW last door still classify the click again.
      const risk = executorRiskStop({ op: 'click', ref: picked.ref }, control, snap?.page, tabId);
      if (risk === 'payment') return { ok: false, code: 'PAYMENT_DENIED', error: 'Payment is never chosen for you.' };
      if (risk === 'delete') {
        return { ok: false, code: 'DELETE_NEEDS_PLANNER', error: 'Deletion goes back to the planner and its approval card.' };
      }
      return host({ ...base, op: 'click', ref: picked.ref, rev: snap?.rev, observe: 'none' });
    }
  });
  return tabId != null ? { ...receipt, tabId } : receipt;
}
