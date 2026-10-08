/** Closed-choice control selection. Jev returns a ref; the host still acts. */

export const CHOOSE_DEFAULT_STEPS = 4;
export const CHOOSE_STEP_CAP = 8;

const CAPTCHA_NAME = /验证码|人机验证|captcha/i;

/**
 * Named controls Jev is allowed to see. Canvas and captcha rows stay out.
 * @param {Array<object>|undefined} controls
 */
export function chooseCandidates(controls) {
  const list = [];
  for (const row of Array.isArray(controls) ? controls : []) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name || '').trim();
    const ref = String(row.ref || '').trim();
    if (!name || !ref || row.visible === false) continue;
    const role = String(row.role || '').toLowerCase();
    if (role === 'canvas' || /canvas/i.test(String(row.type || ''))) continue;
    if (CAPTCHA_NAME.test(name)) continue;
    list.push({ ref, name: name.slice(0, 80), role: role.slice(0, 32) });
    if (list.length >= 40) break;
  }
  return list;
}

/**
 * Skip Jev when the subgoal equals exactly one control name.
 * @param {string} subgoal
 * @param {Array<{ref:string,name:string,role?:string}>} candidates
 */
export function uniqueNameMatch(subgoal, candidates) {
  const want = String(subgoal || '').trim().toLowerCase();
  if (!want) return null;
  const hits = (candidates || []).filter((row) => row.name.toLowerCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * @param {string} until
 * @param {{url?:string}|null} page
 * @param {Array<object>|undefined} controls
 */
export function arrivalMet(until, page, controls) {
  const raw = String(until || '').trim();
  if (!raw) return false;
  const url = String(page?.url || '');
  if (url && url.includes(raw)) return true;
  const needle = raw.toLowerCase();
  return (Array.isArray(controls) ? controls : []).some((row) => String(row?.name || '').trim().toLowerCase() === needle);
}

/**
 * @param {{url?:string,documentId?:string}|null} before
 * @param {{url?:string,documentId?:string}|null} after
 */
export function pageMoved(before, after) {
  if (!before || !after) return false;
  if (before.documentId && after.documentId && before.documentId !== after.documentId) return true;
  const from = String(before.url || '');
  const to = String(after.url || '');
  return Boolean(from && to && from !== to);
}

/**
 * @param {unknown} body
 * @param {Set<string>} refs
 */
export function parseJevChoice(body, refs) {
  const choice = body && typeof body === 'object' ? body.answers?.pick?.choice : '';
  const id = String(choice || '').trim();
  if (!id || id === 'abstain' || !refs.has(id)) return { abstain: true };
  return { ref: id };
}

/**
 * Model-facing receipt. Drops scores and the full candidate list.
 * via is "name" for unique-name clicks, otherwise the Jev provider display name.
 * @param {object} input
 */
export function publicChooseReceipt(input = {}) {
  const steps = (Array.isArray(input.steps) ? input.steps : []).map((step) => ({
    subgoal: String(step?.subgoal || '').slice(0, 160),
    name: String(step?.name || '').slice(0, 80),
    ref: String(step?.ref || '').slice(0, 32),
    verified: step?.verified === true,
    url: String(step?.url || '').slice(0, 300),
    documentId: String(step?.documentId || '').slice(0, 80),
    via: step?.via === 'name' ? 'name' : String(step?.via || 'jev').slice(0, 80)
  }));
  /** @type {Record<string, unknown>} */
  const out = {
    ok: input.ok === true,
    op: 'choose',
    steps,
    hint: 'Completed steps already happened. Do not repeat them.'
  };
  if (input.code) out.code = String(input.code);
  if (input.reason) out.reason = String(input.reason);
  if (input.error) out.error = String(input.error);
  return out;
}

/** Fixed probe options — success means the answer is one of these ids. */
export const JEV_PROBE_CHOICES = Object.freeze({ yes: 'reachable', no: 'unreachable' });

/**
 * Normalize any OpenAI-compatible base into a System One URL.
 * /systemone stays; /v1 gets /systemone; anything else gets /v1/systemone.
 * @param {string} apiBase
 */
export function jevSystemOneUrl(apiBase) {
  const base = String(apiBase || '').trim().replace(/\/$/, '');
  if (!base) return '';
  if (/\/systemone$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

/**
 * Tiny System One body used only to check that this base speaks Jev.
 * Caller must supply the model id saved on that provider — no universal default.
 * @param {{model?:string}} [config]
 */
export function buildJevProbeBody(config = {}) {
  return {
    model: String(config.model || '').trim(),
    state: 'ping',
    questions: {
      pick: {
        type: 'choice',
        instructions: 'Pick either option. This is a connectivity check.',
        criteria: { ...JEV_PROBE_CHOICES }
      }
    }
  };
}

/**
 * Probe succeeds only when HTTP ok and answers.pick.choice is one of the fixed options.
 * @param {unknown} body
 */
export function interpretJevProbeResponse(body) {
  const choice = body && typeof body === 'object' ? body.answers?.pick?.choice : '';
  const id = String(choice || '').trim();
  if (!id || !(id in JEV_PROBE_CHOICES)) {
    return { ok: false, code: 'NOT_JEV', error: 'This address does not provide System1 (no valid answers.pick.choice).' };
  }
  return { ok: true };
}

/**
 * POST one tiny systemone choice. Does not call GET /models.
 * @param {{apiKey?:string,apiBase?:string,model?:string}|null} config
 * @param {typeof fetch} [fetchImpl]
 */
export async function probeJevSystemOne(config, fetchImpl = fetch) {
  const apiKey = String(config?.apiKey || '').trim();
  const apiBase = String(config?.apiBase || '').trim().replace(/\/$/, '');
  const model = String(config?.model || '').trim();
  const url = jevSystemOneUrl(apiBase);
  if (!apiKey || !url) {
    return { ok: false, code: 'NEED_JEV', error: 'System1 Base URL and API key are required.' };
  }
  if (!model) {
    return {
      ok: false,
      code: 'NEED_MODEL',
      error: 'System1 model id is required. Enter the id this gateway publishes.'
    };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildJevProbeBody({ ...config, model }))
    });
  } catch (error) {
    return { ok: false, code: 'JEV_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
  }
  if (!response?.ok) {
    return { ok: false, code: 'JEV_UNAVAILABLE', error: `System1 HTTP ${response?.status || 0}` };
  }
  let json;
  try {
    json = await response.json();
  } catch {
    return { ok: false, code: 'NOT_JEV', error: 'This address does not provide System1 (non-JSON response).' };
  }
  return interpretJevProbeResponse(json);
}

export function clampChooseSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CHOOSE_DEFAULT_STEPS;
  return Math.max(1, Math.min(CHOOSE_STEP_CAP, Math.round(n)));
}

/**
 * Observe, maybe ask Jev, act once, verify. Stops without replaying a failed step.
 * @param {object} opts
 */
export async function runChooseLoop(opts) {
  const subgoal = String(opts.subgoal || '').trim();
  const until = String(opts.until || '').trim();
  const maxSteps = clampChooseSteps(opts.maxSteps);
  const steps = [];
  let previous = null;
  let page = null;
  if (!subgoal) {
    return publicChooseReceipt({ ok: false, code: 'BAD_INPUT', reason: 'no_subgoal', error: 'choose requires subgoal', steps });
  }
  for (let i = 0; i < maxSteps; i++) {
    const snap = await opts.observe();
    if (snap && snap.ok === false) {
      return publicChooseReceipt({ ok: false, code: snap.code || 'NEED_PAGE', reason: 'observe_failed', error: snap.error || 'snapshot failed', steps });
    }
    page = snap?.page || page;
    const controls = snap?.controls || [];
    if (arrivalMet(until, page, controls)) {
      return publicChooseReceipt({ ok: true, reason: 'arrived', steps });
    }
    const candidates = chooseCandidates(controls);
    const unique = uniqueNameMatch(subgoal, candidates);
    let picked = unique;
    let via = 'name';
    if (!picked) {
      if (!candidates.length) {
        return publicChooseReceipt({ ok: false, code: 'NO_TARGET', reason: 'no_candidate', error: 'No named control matches the subgoal.', steps });
      }
      const chosen = await opts.select({ subgoal, candidates, previous });
      if (!chosen?.ref) {
        const code = String(chosen?.code || 'JEV_ABSTAIN');
        const reason =
          code === 'NEED_JEV' ? 'need_jev' : code === 'JEV_UNAVAILABLE' ? 'jev_unavailable' : 'abstain';
        return publicChooseReceipt({
          ok: false,
          code,
          reason,
          error: chosen?.error || 'System1 did not choose a control.',
          steps
        });
      }
      picked = candidates.find((row) => row.ref === chosen.ref) || null;
      if (!picked) {
        return publicChooseReceipt({ ok: false, code: 'JEV_ABSTAIN', reason: 'abstain', error: 'System1 chose a ref that is not a candidate.', steps });
      }
      via = String(opts.jevVia || 'jev').slice(0, 80);
    }
    const before = { url: page?.url || '', documentId: page?.documentId || '' };
    const acted = await opts.act(picked, snap);
    if (!acted || acted.ok === false) {
      steps.push(stepRow(subgoal, picked, via, false, before));
      opts.onStep?.(steps[steps.length - 1]);
      return publicChooseReceipt({
        ok: false,
        code: acted?.code || 'NEED_PAGE',
        reason: 'act_failed',
        error: acted?.error || 'click failed',
        steps
      });
    }
    const afterSnap = await opts.observe();
    if (afterSnap && afterSnap.ok === false) {
      steps.push(stepRow(subgoal, picked, via, false, before));
      opts.onStep?.(steps[steps.length - 1]);
      return publicChooseReceipt({ ok: false, code: afterSnap.code || 'NEED_PAGE', reason: 'observe_failed', error: afterSnap.error || 'snapshot after the click failed', steps });
    }
    const afterPage = afterSnap?.page || page;
    const verified = pageMoved(before, afterPage) || arrivalMet(until, afterPage, afterSnap?.controls) || namesChanged(controls, afterSnap?.controls);
    const row = stepRow(subgoal, picked, via, verified, afterPage);
    steps.push(row);
    opts.onStep?.(row);
    previous = { subgoal, name: picked.name, ref: picked.ref, verified };
    page = afterPage;
    if (!verified) {
      return publicChooseReceipt({ ok: false, code: 'VISUAL_UNCHANGED', reason: 'verify_failed', error: 'The page did not change after the choice.', steps });
    }
    if (arrivalMet(until, afterPage, afterSnap?.controls)) {
      return publicChooseReceipt({ ok: true, reason: 'arrived', steps });
    }
  }
  return publicChooseReceipt({ ok: false, code: 'CHOOSE_LIMIT', reason: 'max_steps', error: 'Choose stopped at the step cap.', steps });
}

/**
 * @param {{apiKey?:string,apiBase?:string,model?:string}|null} config
 * @param {{subgoal:string,candidates:Array<object>,previous?:object|null}} payload
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchJevChoice(config, payload, fetchImpl = fetch) {
  const apiKey = String(config?.apiKey || '').trim();
  const apiBase = String(config?.apiBase || '').trim().replace(/\/$/, '');
  const model = String(config?.model || '').trim();
  const url = jevSystemOneUrl(apiBase);
  if (!apiKey || !url) {
    return { ok: false, code: 'NEED_JEV', error: 'No active System1 provider. Add Base URL and key in Settings.' };
  }
  if (!model) {
    return {
      ok: false,
      code: 'NEED_MODEL',
      error: 'System1 model id is required on the active provider. Enter the id this gateway publishes.'
    };
  }
  const criteria = { abstain: 'None of the controls fits the subgoal.' };
  for (const row of payload.candidates || []) criteria[row.ref] = `${row.name}${row.role ? ` (${row.role})` : ''}`;
  const body = {
    model,
    state: {
      subgoal: String(payload.subgoal || '').slice(0, 200),
      previous: payload.previous
        ? {
            subgoal: String(payload.previous.subgoal || '').slice(0, 160),
            name: String(payload.previous.name || '').slice(0, 80),
            ref: String(payload.previous.ref || '').slice(0, 32),
            verified: payload.previous.verified === true
          }
        : null
    },
    questions: {
      pick: {
        type: 'choice',
        instructions: 'Pick the control ref that best matches subgoal. Choose abstain when none fits.',
        criteria
      }
    }
  };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return { ok: false, code: 'JEV_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
  }
  if (!response?.ok) {
    return { ok: false, code: 'JEV_UNAVAILABLE', error: `System1 HTTP ${response?.status || 0}` };
  }
  const json = await response.json();
  const parsed = parseJevChoice(json, new Set((payload.candidates || []).map((row) => row.ref)));
  if (parsed.abstain) return { ok: false, code: 'JEV_ABSTAIN', abstain: true };
  return { ok: true, ref: parsed.ref };
}

function stepRow(subgoal, picked, via, verified, page) {
  return {
    subgoal,
    name: picked.name,
    ref: picked.ref,
    via,
    verified: verified === true,
    url: page?.url || '',
    documentId: page?.documentId || ''
  };
}

function namesChanged(before, after) {
  const left = new Set(chooseCandidates(before).map((row) => row.name));
  const right = new Set(chooseCandidates(after).map((row) => row.name));
  if (left.size !== right.size) return true;
  for (const name of left) if (!right.has(name)) return true;
  return false;
}
