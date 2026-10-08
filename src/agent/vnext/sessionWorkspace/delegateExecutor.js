/**
 * Planner/executor split (flag `browserbot_executor_v2`, default off).
 * The main model hands `action op=delegate` a subgoal, its own fill values, an
 * `until` and a step budget. A cheap System1-provider model picks ONE next step
 * as strict JSON; the host dispatches it through the ordinary gated action path
 * (hostPageAction: Access Policy + journal + ticket + tab lease + rev/documentId).
 * Nothing here dispatches a page write by itself.
 */
import { classifyRisk, RISK_DELETE, RISK_PAYMENT } from '../host/riskClassify.js';
import { BK_CLIENT_HEADER, BK_PURPOSE_HEADER, bkClientHeaderValue, isCloudApiUrl } from '../../cloudModels.js';
import { openaiChatCompletionsUrl } from '../../llm.js';
import { resolveChatMediaCapabilities } from '../../chatMedia.js';

export const EXECUTOR_V2_KEY = 'browserbot_executor_v2';
export const DELEGATE_DEFAULT_STEPS = 6;
export const DELEGATE_STEP_CAP = 12;

const CONTROL_CAP = 60;
const DATA_CAP = 20;
const PRESS_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'PageDown', 'PageUp']);
const CAPTCHA = /验证码|人机验证|滑块验证|captcha|recaptcha|hcaptcha|i'?m not a robot|verify you are (a )?human/i;
/** Host refusals: the executor never retries around these. */
const GATE_CODES = new Set([
  'PAYMENT_DENIED', 'POLICY_DENIED', 'APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_MISMATCH',
  'TICKET_REQUIRED', 'JOURNAL_UNAVAILABLE', 'DUPLICATE_INTENT', 'RAW_ESCAPE_DENIED', 'TAB_LEASED',
  'NEED_EXPLICIT_TAB', 'PERMISSION_REQUIRED', 'BYOK_REQUIRES_PLAN', 'SYS_ABORTED'
]);
/** A write may have happened; re-reading is the planner's job, never a blind replay. */
const UNKNOWN_CODES = new Set(['ACTION_OUTCOME_UNKNOWN', 'RPC_OUTCOME_UNKNOWN', 'SYS_OUTCOME_UNKNOWN']);

export const EXECUTOR_SYSTEM = [
  'You operate one browser tab for a planner. Reply with ONE JSON object and nothing else.',
  'Allowed replies:',
  '{"action":"click","ref":"<ref>"}',
  '{"action":"fill","ref":"<ref>","value":"<a value copied exactly from data>"}',
  '{"action":"select","ref":"<ref>","value":"<an option of that control, or a value from data>"}',
  '{"action":"press","key":"Enter|Tab|Escape|ArrowDown|ArrowUp|Space|Backspace|PageDown|PageUp"}',
  '{"action":"scroll","dir":"down|up"}',
  '{"action":"pointer","x":0.5,"y":0.5}  only when a screenshot is attached; x,y are 0-1 of the viewport',
  '{"action":"done"}  the goal is reached',
  '{"action":"escalate","reason":"<short>"}  unsure, blocked, login/captcha/payment/delete needed, or the value is not in data',
  'Use only refs from controls. Never type a value that is not in data. Do not repeat a step that changed nothing.'
].join('\n');

/** @param {{get?:Function}|undefined} storage chrome.storage.local-like */
export async function readExecutorV2Flag(storage = globalThis.chrome?.storage?.local) {
  try {
    const got = await storage?.get?.(EXECUTOR_V2_KEY);
    return got?.[EXECUTOR_V2_KEY] === true;
  } catch {
    return false;
  }
}

export function clampDelegateSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DELEGATE_DEFAULT_STEPS;
  return Math.max(1, Math.min(DELEGATE_STEP_CAP, Math.round(n)));
}

/**
 * Planner-supplied values. The executor may only type these.
 * @param {unknown} raw [{ field, value }]
 */
export function normalizeDelegateData(raw) {
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object' || row.value == null) continue;
    out.push({ field: String(row.field || row.name || '').slice(0, 80), value: String(row.value) });
    if (out.length >= DATA_CAP) break;
  }
  return out;
}

/**
 * Text controls the executor sees: named, visible, enabled, not canvas or captcha.
 * @param {Array<object>|undefined} controls
 */
export function executorControls(controls) {
  const list = [];
  for (const row of Array.isArray(controls) ? controls : []) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name || '').trim();
    const ref = String(row.ref || '').trim();
    if (!name || !ref || row.visible === false || row.disabled) continue;
    const role = String(row.role || '').toLowerCase();
    if (role === 'canvas' || /canvas/i.test(String(row.type || ''))) continue;
    if (CAPTCHA.test(name)) continue;
    const item = { ref, role: role.slice(0, 32), name: name.slice(0, 80) };
    if (row.type) item.type = String(row.type).slice(0, 24);
    if (row.value != null && row.value !== '') item.value = String(row.value).slice(0, 60);
    if (Array.isArray(row.options)) {
      item.options = row.options.slice(0, 12).map((opt) => String(opt?.label ?? opt?.text ?? opt?.value ?? opt).slice(0, 40));
    }
    list.push(item);
    if (list.length >= CONTROL_CAP) break;
  }
  return list;
}

/** Captcha / bot challenge anywhere on the observed page. */
export function captchaDetected(snap) {
  const page = snap?.page || {};
  if (CAPTCHA.test(String(page.title || '')) || /captcha|cdn-cgi\/challenge-platform/i.test(String(page.url || ''))) return true;
  return (Array.isArray(snap?.controls) ? snap.controls : []).some((row) => row && row.visible !== false && CAPTCHA.test(String(row.name || '')));
}

/**
 * until: URL contains it, title contains it, or a control has exactly this name.
 * @param {string} until
 * @param {{page?:object,controls?:Array<object>}|null} snap
 */
export function delegateArrived(until, snap) {
  const raw = String(until || '').trim();
  if (!raw) return false;
  const page = snap?.page || {};
  if (String(page.url || '').includes(raw)) return true;
  const needle = raw.toLowerCase();
  if (String(page.title || '').toLowerCase().includes(needle)) return true;
  return (Array.isArray(snap?.controls) ? snap.controls : []).some((row) => String(row?.name || '').trim().toLowerCase() === needle);
}

/** Page identity + control names/values; refs are excluded (they renumber). */
export function pageFingerprint(snap) {
  const page = snap?.page || {};
  const rows = (Array.isArray(snap?.controls) ? snap.controls : []).map((row) =>
    [row?.role || '', row?.name || '', row?.value ?? '', row?.visible === false ? 0 : 1, row?.checked ? 1 : 0].join('\u0001')
  );
  return [page.url || '', page.documentId || '', page.title || '', rows.join('\u0002')].join('\u0003');
}

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(s.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Strict whitelist. fill values must be planner data; select values a data value or the control's own option.
 * @param {string} text model reply
 * @param {{controls:Array<object>,data:Array<{field:string,value:string}>,hasImage:boolean}} ctx
 */
export function parseExecutorStep(text, ctx) {
  const json = extractJson(text);
  if (!json) return { ok: false, error: 'Reply was not one JSON object.' };
  const action = String(json.action || '').trim().toLowerCase();
  const byRef = new Map((ctx.controls || []).map((row) => [row.ref, row]));
  const needRef = () => {
    const ref = String(json.ref || '').trim();
    return byRef.has(ref) ? ref : '';
  };
  if (action === 'done') return { ok: true, action };
  if (action === 'escalate') return { ok: true, action, reason: String(json.reason || 'executor unsure').slice(0, 160) };
  if (action === 'click') {
    const ref = needRef();
    return ref ? { ok: true, action, op: 'click', ref } : { ok: false, error: 'click needs a ref from controls.' };
  }
  if (action === 'fill') {
    const ref = needRef();
    if (!ref) return { ok: false, error: 'fill needs a ref from controls.' };
    const value = json.value == null ? null : String(json.value);
    const hit = (ctx.data || []).find((row) => row.value === value);
    if (!hit) return { ok: false, error: 'fill value must be copied exactly from data.' };
    return { ok: true, action, op: 'fill', ref, value: hit.value, field: hit.field };
  }
  if (action === 'select') {
    const ref = needRef();
    if (!ref) return { ok: false, error: 'select needs a ref from controls.' };
    const value = json.value == null ? '' : String(json.value);
    const hit = (ctx.data || []).find((row) => row.value === value);
    const options = byRef.get(ref)?.options || [];
    if (!hit && !options.includes(value)) return { ok: false, error: 'select value must be an option of that control or a value from data.' };
    return { ok: true, action, op: 'select', ref, value, ...(hit ? { field: hit.field } : {}) };
  }
  if (action === 'press') {
    const key = String(json.key || '').trim();
    return PRESS_KEYS.has(key) ? { ok: true, action, op: 'press', key } : { ok: false, error: 'press key is not allowed.' };
  }
  if (action === 'scroll') {
    const dir = String(json.dir || 'down').toLowerCase();
    if (dir !== 'down' && dir !== 'up') return { ok: false, error: 'scroll dir must be down or up.' };
    return { ok: true, action, op: 'scroll', dir };
  }
  if (action === 'pointer') {
    if (!ctx.hasImage) return { ok: false, error: 'pointer needs an attached screenshot.' };
    const x = Number(json.x);
    const y = Number(json.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { ok: false, error: 'pointer x,y must be within 0-1.' };
    return { ok: true, action, op: 'pointer', x, y };
  }
  return { ok: false, error: `action "${action || '?'}" is not allowed.` };
}

/**
 * Scroll has no page-level op without a target: bring the last (down) or first (up)
 * listed control into view through the ordinary scroll mutate.
 */
export function scrollAnchor(dir, controls) {
  const list = Array.isArray(controls) ? controls.filter((row) => row?.ref) : [];
  if (!list.length) return null;
  return dir === 'up' ? list[0] : list[list.length - 1];
}

/**
 * Known payment / delete (any confidence) hands control back before dispatch.
 * The host gate still classifies again on dispatch.
 */
export function executorRiskStop(step, control, page, tabId) {
  if (control?.hints?.secrets === 'payment') return 'payment';
  const verdict = classifyRisk({
    channel: 'action',
    op: step.op,
    ref: step.ref,
    name: control?.name || '',
    key: step.key,
    control: control || undefined,
    url: control?.frameUrl || page?.url || '',
    frameUrl: control?.frameUrl || page?.url || '',
    tabId,
    documentId: control?.documentId || page?.documentId || ''
  });
  if (verdict.risk === RISK_PAYMENT) return 'payment';
  if (verdict.risk === RISK_DELETE) return 'delete';
  return '';
}

function stepRow(n, step, control, out) {
  const row = { n, action: step.action };
  if (step.ref) row.ref = step.ref;
  if (control?.name) row.name = String(control.name).slice(0, 80);
  if (step.field) row.field = step.field;
  if (step.key) row.key = step.key;
  if (step.dir) row.dir = step.dir;
  if (step.op === 'pointer') {
    row.x = Math.round(step.x * 1000) / 1000;
    row.y = Math.round(step.y * 1000) / 1000;
  }
  row.ok = Boolean(out) && out.ok !== false;
  if (out?.code) row.code = String(out.code);
  return row;
}

/**
 * Model-facing receipt: no snapshots, no screenshots, no typed values.
 * @param {object} input
 */
export function publicDelegateReceipt(input = {}) {
  const status = input.status === 'arrived' || input.status === 'done' ? input.status : 'escalated';
  /** @type {Record<string, unknown>} */
  const out = {
    ok: status !== 'escalated',
    op: 'delegate',
    status,
    reason: String(input.reason || status).slice(0, 160),
    steps: (Array.isArray(input.steps) ? input.steps : []).slice(-DELEGATE_STEP_CAP),
    final: { url: String(input.page?.url || '').slice(0, 300), title: String(input.page?.title || '').slice(0, 160) }
  };
  if (status === 'escalated') out.code = String(input.code || 'DELEGATE_ESCALATED');
  if (input.error) out.error = String(input.error).slice(0, 240);
  out.hint = status === 'arrived'
    ? 'until was met. Steps already happened; do not repeat them. Snapshot to verify before the next mutate.'
    : status === 'done'
      ? 'Executor says done; no until was checked. Snapshot to verify.'
      : 'Executor stopped and you have control. Steps already happened. Snapshot, then act yourself or delegate a narrower subgoal.';
  return out;
}

/**
 * Observe → ask executor → gated act → repeat. Stops on until, done, or any escalation.
 * @param {object} opts
 * @param {string} opts.subgoal
 * @param {string} [opts.until]
 * @param {Array<{field:string,value:string}>} [opts.data]
 * @param {number} [opts.maxSteps]
 * @param {boolean} [opts.vision]
 * @param {(o:{screenshot:boolean}) => Promise<object>} opts.observe → { ok, rev, page, controls, canvasCount, image? }
 * @param {(payload:object) => Promise<{ok:boolean,text?:string,code?:string,error?:string}>} opts.decide
 * @param {(step:object, snap:object, control:object|null) => Promise<object>} opts.act
 * @param {(row:object) => void} [opts.onStep]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.tabId]
 */
export async function runDelegateLoop(opts) {
  const subgoal = String(opts.subgoal || '').trim();
  const until = String(opts.until || '').trim();
  const data = normalizeDelegateData(opts.data);
  const maxSteps = clampDelegateSteps(opts.maxSteps);
  const maxCalls = maxSteps + 2;
  const steps = [];
  let page = null;
  const stop = (status, reason, extra = {}) => publicDelegateReceipt({ status, reason, steps, page, ...extra });
  if (!subgoal) return stop('escalated', 'no_subgoal', { code: 'BAD_INPUT', error: 'delegate requires subgoal' });

  let calls = 0;
  let acted = 0;
  let invalid = 0;
  let unchanged = 0;
  let feedback = '';
  let lastFingerprint = null;
  let lastRow = null;
  let lastVerifiedByHost = false;
  for (;;) {
    if (opts.signal?.aborted) return stop('escalated', 'aborted', { code: 'SYS_ABORTED' });
    let snap = await opts.observe({ screenshot: false });
    if (!snap || snap.ok === false) {
      return stop('escalated', 'observe_failed', { code: snap?.code || 'NEED_PAGE', error: snap?.error || 'snapshot failed' });
    }
    page = snap.page || page;
    if (lastFingerprint != null && lastRow) {
      // A CDP pointer receipt is already a host-verified visual change (else VISUAL_UNCHANGED).
      const changed = lastVerifiedByHost || pageFingerprint(snap) !== lastFingerprint;
      lastRow.changed = changed;
      unchanged = changed ? 0 : unchanged + 1;
      if (unchanged >= 2) return stop('escalated', 'no_change', { code: 'VISUAL_UNCHANGED', error: 'Two steps in a row changed nothing visible.' });
    }
    if (delegateArrived(until, snap)) return stop('arrived', 'arrived');
    if (captchaDetected(snap)) return stop('escalated', 'captcha', { code: 'NEED_HUMAN', error: 'A captcha or bot check is on the page.' });
    if (acted >= maxSteps) return stop('escalated', 'budget', { code: 'DELEGATE_LIMIT', error: 'Step budget exhausted before until was met.' });
    if (calls >= maxCalls) return stop('escalated', 'budget', { code: 'DELEGATE_LIMIT', error: 'Executor call budget exhausted.' });

    let controls = executorControls(snap.controls);
    const needShot = opts.vision === true && (!controls.length || Number(snap.canvasCount) > 0 || unchanged > 0);
    if (needShot) {
      const shot = await opts.observe({ screenshot: true });
      if (shot && shot.ok !== false) {
        snap = shot;
        page = snap.page || page;
        controls = executorControls(snap.controls);
      }
    }
    const image = snap.image || null;
    if (!controls.length && !image) {
      return stop('escalated', 'no_target', { code: 'NO_TARGET', error: 'No named control to act on and no screenshot for the executor.' });
    }

    calls += 1;
    const answer = await opts.decide({
      subgoal,
      until,
      data,
      page: { url: String(page?.url || '').slice(0, 300), title: String(page?.title || '').slice(0, 160) },
      controls,
      history: steps.slice(-6).map(({ n, action, name, field, key, dir, ok, changed, code }) => ({ n, action, name, field, key, dir, ok, changed, code })),
      note: feedback,
      image
    });
    if (!answer || answer.ok === false) {
      return stop('escalated', 'executor_unavailable', { code: answer?.code || 'JEV_UNAVAILABLE', error: answer?.error || 'executor model failed' });
    }
    const step = parseExecutorStep(answer.text, { controls, data, hasImage: Boolean(image) });
    if (!step.ok) {
      invalid += 1;
      if (invalid >= 2) return stop('escalated', 'invalid_reply', { code: 'EXECUTOR_INVALID', error: step.error });
      feedback = `Previous reply rejected: ${step.error}`;
      lastFingerprint = null;
      continue;
    }
    invalid = 0;
    feedback = '';
    if (step.action === 'done') {
      if (until) return stop('escalated', 'claimed_done', { code: 'DELEGATE_UNVERIFIED', error: 'Executor said done but until is not met.' });
      return stop('done', 'done');
    }
    if (step.action === 'escalate') return stop('escalated', step.reason, { code: 'DELEGATE_ESCALATED' });

    let control = step.ref ? (snap.controls || []).find((row) => row?.ref === step.ref) || null : null;
    if (step.op === 'scroll') {
      control = scrollAnchor(step.dir, snap.controls);
      if (!control) return stop('escalated', 'no_target', { code: 'NO_TARGET', error: 'Nothing to scroll to.' });
      step.ref = control.ref;
    }
    const risk = executorRiskStop(step, control, page, opts.tabId);
    if (risk) {
      steps.push({ ...stepRow(steps.length + 1, step, control, { ok: false, code: risk === 'payment' ? 'PAYMENT_DENIED' : 'DELETE_NEEDS_PLANNER' }), changed: false });
      opts.onStep?.(steps[steps.length - 1]);
      return stop('escalated', risk, { code: risk === 'payment' ? 'PAYMENT_DENIED' : 'DELETE_NEEDS_PLANNER', error: risk === 'payment' ? 'Payment is never delegated.' : 'Deletion goes back to the planner and its approval card.' });
    }

    acted += 1;
    lastFingerprint = pageFingerprint(snap);
    const out = await opts.act(step, snap, control);
    const row = stepRow(steps.length + 1, step, control, out);
    steps.push(row);
    lastRow = row;
    lastVerifiedByHost = Boolean(out) && out.ok !== false && step.op === 'pointer';
    opts.onStep?.(row);
    const code = String(out?.code || '');
    if (!out || out.ok === false) {
      if (GATE_CODES.has(code)) return stop('escalated', 'gate_denied', { code, error: out?.error || 'host gate refused the step' });
      if (UNKNOWN_CODES.has(code)) return stop('escalated', 'outcome_unknown', { code, error: out?.error || 'step outcome unknown' });
      feedback = `Last step failed (${code || 'error'}): ${String(out?.error || '').slice(0, 120)}`;
    }
  }
}

/** OpenAI-compatible chat URL for a System1 provider record (strips a /systemone suffix). */
export function executorChatUrl(apiBase) {
  const base = String(apiBase || '').trim().replace(/\/$/, '').replace(/\/systemone$/i, '');
  return openaiChatCompletionsUrl(base);
}

/**
 * Images only when the provider takes them: the Browser Kitten route decides server-side;
 * a BYOK provider needs a known or declared image input for that exact base + model.
 * @param {object} settings loadLlmSettings() shape
 */
export function executorVision(settings = {}) {
  const jev = settings?.jev;
  if (!jev?.apiKey || !jev?.apiBase) return false;
  if (isCloudApiUrl(executorChatUrl(jev.apiBase))) return true;
  const record = (Array.isArray(settings.providers) ? settings.providers : []).find((p) => p?.id === settings.jevProviderId);
  try {
    const caps = resolveChatMediaCapabilities({ model: jev.model, apiBase: jev.apiBase, chatMediaOverrides: record?.chatMediaOverrides }, []);
    return caps?.inputs?.image?.state === 'supported';
  } catch {
    return false;
  }
}

/**
 * One executor decision over chat/completions. Cloud records route by x-bk-purpose: executor.
 * @param {{apiKey?:string,apiBase?:string,model?:string}|null} config
 * @param {object} payload runDelegateLoop decide payload
 * @param {{fetchImpl?:typeof fetch, signal?:AbortSignal}} [opts]
 */
export async function fetchExecutorStep(config, payload, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const apiKey = String(config?.apiKey || '').trim();
  const model = String(config?.model || '').trim();
  const url = executorChatUrl(config?.apiBase);
  if (!apiKey || !url) return { ok: false, code: 'NEED_JEV', error: 'No active System1 provider. Add one in Settings, or act with ref yourself.' };
  if (!model) return { ok: false, code: 'NEED_MODEL', error: 'System1 model id is required on the active provider.' };
  const { image, ...facts } = payload || {};
  const text = JSON.stringify(facts);
  const content = image?.data
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${image.mediaType || 'image/jpeg'};base64,${image.data}` } }]
    : text;
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  if (isCloudApiUrl(url)) {
    headers[BK_PURPOSE_HEADER] = 'executor';
    const client = bkClientHeaderValue();
    if (client) headers[BK_CLIENT_HEADER] = client;
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: 'system', content: EXECUTOR_SYSTEM }, { role: 'user', content }]
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, code: 'SYS_ABORTED', error: 'Execution aborted.' };
    return { ok: false, code: 'JEV_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
  }
  if (!response?.ok) return { ok: false, code: 'JEV_UNAVAILABLE', error: `Executor HTTP ${response?.status || 0}` };
  let json;
  try {
    json = await response.json();
  } catch {
    return { ok: true, text: '' };
  }
  const message = json?.choices?.[0]?.message;
  const raw = message?.content;
  const textOut = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
  return { ok: true, text: textOut };
}
