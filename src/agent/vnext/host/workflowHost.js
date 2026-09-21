import { resolveTarget, sanitizeRecordedUrl, validateTarget, workflowError } from '../workflow/definition.js';

export const WORKFLOW_RECORDING_STORAGE_KEY = 'browserbot_workflow_recording_host_v1';

const RECORD_TYPES = new Set(['click', 'fill', 'select', 'press', 'scroll', 'sensitive', 'unsupported']);
const RECORD_STATUSES = new Set(['recording', 'paused', 'stopped']);
const SENSITIVE_TARGET = /(?:pass(?:word|code)?|secret|token|api.?key|auth(?:orization)?|otp|one.?time|verification.?code|cvv|cvc|card.?number|ssn|social.?security|pin)/i;
const integer = value => Number.isInteger(Number(value)) && Number(value) >= 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function hostError(code, message) { return workflowError(code, message); }
function tabId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw hostError('WORKFLOW_INVALID', 'A valid tab id is required.');
  return id;
}
function short(value, max = 2000) { return String(value ?? '').slice(0, max); }
function cleanTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = {};
  for (const key of ['role', 'name', 'type', 'region', 'id', 'testId', 'css', 'tag', 'frameUrl']) {
    if (typeof value[key] === 'string' && value[key]) target[key] = short(value[key]);
  }
  try { return validateTarget(target); } catch { return undefined; }
}

/** Never retain arbitrary page metadata or values for sensitive controls. */
export function sanitizeWorkflowRecordingEvent(value) {
  let type = short(value?.type, 32);
  if (!RECORD_TYPES.has(type)) return null;
  const rawTarget = value?.target && typeof value.target === 'object' ? value.target : {};
  const sensitiveTarget = Object.entries(rawTarget).some(([key, item]) =>
    ['type', 'name', 'id', 'testId', 'role', 'region', 'css'].includes(key) && SENSITIVE_TARGET.test(String(item || ''))
  );
  if (value?.sensitive === true || sensitiveTarget) type = 'sensitive';
  if (type === 'sensitive') return { type: 'sensitive' };
  const event = { type };
  const target = cleanTarget(value.target);
  if (target) event.target = target;
  if (type === 'fill' || type === 'select') event.value = short(value.value, 10000);
  if (type === 'press' && ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'].includes(value.key)) event.key = value.key;
  if (type === 'scroll' && Number.isFinite(Number(value.deltaY))) event.deltaY = Math.max(-100000, Math.min(100000, Number(value.deltaY)));
  return event;
}

function publicRecording(recording) {
  if (!recording) return null;
  return { id: recording.id, status: recording.status, sequence: recording.sequence };
}

export function createWorkflowHost({ chromeLike = globalThis.chrome, rpc, ensureContentScripts, now = () => Date.now() } = {}) {
  const session = chromeLike?.storage?.session;
  if (!session?.get || !session?.set) throw new Error('workflow host requires storage.session');
  let state = null;
  let ready = null;
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.catch(() => {}).then(fn); queue = next.catch(() => {}); return next; };

  async function persist(next) {
    try { await session.set({ [WORKFLOW_RECORDING_STORAGE_KEY]: next }); }
    catch (error) {
      if (state?.recording?.status === 'recording') {
        state = { ...state, recording: { ...state.recording, status: 'paused' } };
        await broadcastConfig(state);
        await interruptRecording(state.recording.id, 'WORKFLOW_RECORDING_STORAGE_FAILED').catch(() => {});
      }
      throw error;
    }
    state = next;
    return next;
  }
  async function load() {
    if (!ready) ready = (async () => {
      const bag = await session.get([WORKFLOW_RECORDING_STORAGE_KEY]);
      const saved = bag?.[WORKFLOW_RECORDING_STORAGE_KEY];
      // Older host snapshots also stored an enrollment map. Aliases are the
      // authority; ignore that derived cache when reopening the worker.
      if (saved) delete saved.enrolled;
      let broadcasted = false;
      if (saved?.recording?.status === 'recording') {
        // storage.session survives a worker restart. A fresh worker must never resume capture.
        state = await persist({ ...saved, recording: { ...saved.recording, status: 'paused' } });
        await broadcastConfig(state);
        broadcasted = true;
        await interruptRecording(saved.recording.id, 'WORKFLOW_RESTARTED');
      } else state = saved || null;
      if (state && !broadcasted) await broadcastConfig(state);
      return state;
    })();
    await ready;
    return state;
  }
  function enrolled(actualTabId, current = state) {
    return own(current?.recording?.tabAliases, String(actualTabId));
  }
  async function sendConfig(actualTabId, current = state) {
    const id = tabId(actualTabId);
    if (ensureContentScripts) await ensureContentScripts(id);
    return chromeLike.tabs.sendMessage(id, {
      action: 'workflow_recording_config',
      recording: enrolled(id, current) ? publicRecording(current?.recording) : null
    });
  }
  async function broadcastConfig(current = state) {
    return Promise.allSettled(Object.keys(current?.recording?.tabAliases || {}).map(id => sendConfig(Number(id), current)));
  }
  async function forward(event, recordingId = state?.recording?.id) {
    if (!recordingId || typeof rpc !== 'function') return;
    const response = await rpc({ method: 'ingestWorkflowRecordingEvent', params: { recordingId, event } });
    if (response && response.ok === false) throw hostError(response.code || 'WORKFLOW_HOST', response.error || 'Recording event was rejected.');
    const result = response?.result ?? response;
    if (result?.status === 'paused' && state?.recording?.status === 'recording') {
      await persist({ ...state, recording: { ...state.recording, status: 'paused' } });
      await broadcastConfig(state);
    }
    return result;
  }
  async function interruptRecording(recordingId, reason) {
    if (!recordingId || typeof rpc !== 'function') return;
    const response = await rpc({ method: 'interruptWorkflowRecording', params: { recordingId, reason } });
    if (response && response.ok === false) throw hostError(response.code || 'WORKFLOW_HOST', response.error || 'Recording interruption was rejected.');
  }
  async function faultRecording(error) {
    if (!state?.recording || state.recording.status !== 'recording') return;
    const next = structuredClone(state);
    next.recording.status = 'paused';
    next.fault = { code: error?.code || 'WORKFLOW_RECORDING_GAP', message: short(error?.message || error, 1000), at: now() };
    await persist(next);
    await broadcastConfig(next);
    await interruptRecording(next.recording.id, next.fault.code);
  }
  async function configure(recording) {
    if (!recording || typeof recording.id !== 'string' || !RECORD_STATUSES.has(recording.status) || !integer(recording.sequence)) {
      throw hostError('WORKFLOW_INVALID', 'Invalid recording configuration.');
    }
    const aliases = {};
    for (const [rawId, alias] of Object.entries(recording.tabAliases || {})) {
      const id = tabId(rawId);
      if (typeof alias !== 'string' || !alias) throw hostError('WORKFLOW_INVALID', 'Invalid recording tab alias.');
      aliases[id] = short(alias, 64);
    }
    const previous = await load();
    const next = {
      recording: { id: recording.id, status: recording.status, sequence: Number(recording.sequence), tabAliases: aliases },
      configuredAt: now()
    };
    // Configuration is refused when persistence fails; pages keep the last known state.
    await persist(next);
    const allTabs = new Set([...Object.keys(previous?.recording?.tabAliases || {}), ...Object.keys(next.recording.tabAliases)]);
    const deliveries = await Promise.allSettled([...allTabs].map(id => sendConfig(Number(id), next)));
    const failed = deliveries.filter(row => row.status === 'rejected');
    if (recording.status === 'recording' && failed.length) {
      const error = hostError('WORKFLOW_RECORDING_GAP', `Recording could not reach ${failed.length} enrolled page(s).`);
      await faultRecording(error);
      throw error;
    }
    return publicRecording(next.recording);
  }
  async function tabs() {
    const rows = await chromeLike.tabs.query({});
    return rows.filter(row => Number.isInteger(row.id)).map(row => ({
      id: row.id, url: short(row.url), title: short(row.title), active: row.active === true, windowId: row.windowId,
      ...(Number.isInteger(row.openerTabId) ? { openerTabId: row.openerTabId } : {})
    }));
  }
  async function downloads({ check, since }) {
    if (check?.type !== 'download' || (!own(check, 'contains') && !own(check, 'equals'))) {
      throw hostError('WORKFLOW_INVALID', 'Download checks require contains or equals.');
    }
    const after = Number(since);
    if (!Number.isFinite(after) || after <= 0) throw hostError('WORKFLOW_INVALID', 'Download checks require an attempt start time.');
    const rows = await chromeLike.downloads.search({ state: 'complete', startedAfter: new Date(after).toISOString() });
    const expected = short(own(check, 'equals') ? check.equals : check.contains, 4000);
    if (!expected) throw hostError('WORKFLOW_INVALID', 'Download filter cannot be empty.');
    const exact = own(check, 'equals');
    const hit = (rows || []).find(row => {
      const completed = Date.parse(row.endTime || row.startTime || '');
      if (!Number.isFinite(completed) || completed < after || row.state !== 'complete') return false;
      const candidates = [row.filename, row.url, row.finalUrl].map(x => String(x || ''));
      return candidates.some(candidate => exact ? candidate === expected : candidate.includes(expected));
    });
    return hit ? { ok: true, evidence: { type: 'download', id: hit.id, filename: short(hit.filename, 4000), at: Date.parse(hit.endTime || hit.startTime) } } : { ok: false };
  }
  async function highlight({ tabId: rawTabId, target }) {
    const id = tabId(rawTabId); validateTarget(target);
    if (ensureContentScripts) await ensureContentScripts(id);
    let frames = [{ frameId: 0 }];
    if (chromeLike.webNavigation?.getAllFrames) frames = await chromeLike.webNavigation.getAllFrames({ tabId: id }) || frames;
    if (target.frameUrl) frames = frames.filter(frame => sanitizeRecordedUrl(frame.url) === sanitizeRecordedUrl(target.frameUrl));
    const observed = [];
    for (const frame of frames) {
      try {
        const options = { frameId: frame.frameId };
        if (frame.documentId) options.documentId = frame.documentId;
        const response = await chromeLike.tabs.sendMessage(id, { action: 'workflow_probe', target }, options);
        for (const control of response?.controls || []) observed.push({ ...control, frameId: frame.frameId, frameUrl: sanitizeRecordedUrl(frame.url || response.frameUrl || ''), documentId: frame.documentId || response.documentId || '' });
      } catch { /* inaccessible frame */ }
    }
    const match = resolveTarget({ controls: observed }, target);
    const options = { frameId: match.frameId };
    if (match.documentId) options.documentId = match.documentId;
    const result = await chromeLike.tabs.sendMessage(id, { action: 'workflow_highlight', target }, options);
    if (!result?.ok) throw hostError(result?.code || 'WORKFLOW_TARGET_MISSING', result?.error || 'Target could not be highlighted.');
    return { ...result, frameId: match.frameId, documentId: match.documentId || undefined };
  }
  async function flushRecording({ recordingId } = {}) {
    await load();
    if (!state?.recording || state.recording.id !== recordingId || state.recording.status !== 'recording') return { flushed: false };
    // Deliberately do not hold the host serial queue while asking content to
    // flush: content waits for each workflow_record_event response, and those
    // events must be able to enter this queue before the flush can resolve.
    const sends = [];
    for (const rawId of Object.keys(state.recording?.tabAliases || {})) {
      const id = Number(rawId);
      if (ensureContentScripts) await ensureContentScripts(id);
      let frames = [{ frameId: 0 }];
      if (chromeLike.webNavigation?.getAllFrames) frames = await chromeLike.webNavigation.getAllFrames({ tabId: id }) || frames;
      for (const frame of frames) {
        const frameUrl = sanitizeRecordedUrl(frame?.url || '');
        if (frame?.url && !frameUrl) continue;
        sends.push((async () => {
          const options = { frameId: Number(frame.frameId || 0) };
          if (frame.documentId) options.documentId = frame.documentId;
          const result = await chromeLike.tabs.sendMessage(id, { action: 'workflow_record_flush', recordingId }, options);
          if (result?.ok === false) throw hostError(result.code || 'WORKFLOW_RECORDING_GAP', result.error || 'Page recording flush failed.');
        })());
      }
    }
    const deliveries = await Promise.allSettled(sends);
    const failed = deliveries.filter(row => row.status === 'rejected');
    if (failed.length) {
      const error = hostError('WORKFLOW_RECORDING_GAP', `Recording flush failed in ${failed.length} page(s).`);
      await serial(() => faultRecording(error));
      throw error;
    }
    await serial(async () => {});
    return { flushed: true };
  }
  async function handle(op, params = {}) {
    if (op === 'tabs') return tabs();
    if (op === 'recording.configure') return serial(() => configure(params.recording));
    if (op === 'recording.flush') return flushRecording(params);
    if (op === 'downloads') return downloads(params);
    if (op === 'highlight') return highlight(params);
    throw hostError('WORKFLOW_HOST', `Unsupported workflow host operation: ${op}`);
  }
  async function status(sender) {
    await load();
    if (sender?.id !== chromeLike.runtime.id) return { recording: null };
    const id = sender?.tab?.id;
    return { recording: enrolled(id) ? publicRecording(state.recording) : null };
  }
  async function recordMessage(request, sender) {
    return serial(async () => {
      await load();
      const id = sender?.tab?.id;
      if (sender?.id !== chromeLike.runtime.id || !Number.isInteger(id) || !enrolled(id) || state.recording.status !== 'recording' || request.recordingId !== state.recording.id) return { ignored: true };
      const frameId = Number(sender.frameId);
      const documentId = short(sender.documentId, 256);
      const frameUrl = sanitizeRecordedUrl(sender.url || '');
      if (!Number.isInteger(frameId) || frameId < 0 || !documentId || !frameUrl) return { ignored: true };
      const event = sanitizeWorkflowRecordingEvent(request.event);
      if (!event) return { ignored: true };
      const url = sanitizeRecordedUrl(sender.tab.url || frameUrl);
      const next = structuredClone(state);
      next.recording.sequence += 1;
      const enriched = { ...event, tabId: id, frameId, documentId, url, ...(frameId ? { frameUrl } : {}), at: now(), sequence: next.recording.sequence };
      await persist(next);
      try { await forward(enriched); }
      catch (error) { await faultRecording(error); throw error; }
      return { ok: true, sequence: enriched.sequence };
    });
  }
  async function tabCreated(tab) {
    return serial(async () => {
      await load();
      if (state?.recording?.status !== 'recording' || !enrolled(tab?.openerTabId)) return;
      const id = tab?.id;
      if (!Number.isInteger(id)) return;
      const next = structuredClone(state);
      const used = Object.values(next.recording.tabAliases || {});
      next.recording.tabAliases[String(id)] = `tab${used.length + 1}`;
      next.recording.sequence += 1;
      const event = { type: 'newTab', tabId: tab.openerTabId, newTabId: id, url: sanitizeRecordedUrl(tab.url || tab.pendingUrl || ''), title: short(tab.title), at: now(), sequence: next.recording.sequence };
      await persist(next);
      // onCreated may still describe about:blank. The manifest content script
      // asks workflow_record_status once the child document is ready. Injecting
      // synchronously here would falsely interrupt ordinary popup recording.
      try { await forward(event); }
      catch (error) { await faultRecording(error); throw error; }
    });
  }
  async function navigation(details) {
    if (details?.frameId !== 0) return;
    return serial(async () => {
      await load(); if (state?.recording?.status !== 'recording' || !enrolled(details.tabId)) return;
      const url = sanitizeRecordedUrl(details.url); if (!url) return;
      const next = structuredClone(state); next.recording.sequence += 1;
      const event = { type: 'navigation', tabId: details.tabId, url, at: now(), sequence: next.recording.sequence };
      await persist(next);
      try { await forward(event); } catch (error) { await faultRecording(error); throw error; }
    });
  }
  async function activated(info) {
    return serial(async () => {
      await load(); if (state?.recording?.status !== 'recording' || !enrolled(info?.tabId)) return;
      const next = structuredClone(state); next.recording.sequence += 1;
      const event = { type: 'focus', tabId: info.tabId, at: now(), sequence: next.recording.sequence };
      await persist(next);
      try { await forward(event); } catch (error) { await faultRecording(error); throw error; }
    });
  }
  return { handle, status, recordMessage, tabCreated, navigation, activated, load };
}
