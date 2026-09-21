import { sanitizeRecordedUrl, validateTarget } from './definition.js';
const clone = value => structuredClone(value);
const PAGE_EVENTS = new Set(['click', 'fill', 'select', 'press', 'scroll', 'hover', 'dblclick', 'contextmenu', 'toggle']);

/** Takes only SW-authenticated tab/frame identity and content-script data. */
export function applyRecordingEvent(record, event) {
  const next = clone(record); const wf = next.definition.workflow;
  const alias = next.tabAliases[String(event.tabId)];
  if (next.status !== 'recording' || !alias) return next;
  const last = wf.steps.at(-1);
  const stamp = Number(event.at) || Date.now();
  const add = step => { wf.steps.push({ id: `step${++next.sequence}`, title: step.op, ...step }); next.lastEvent = { tab: alias, at: stamp }; };
  if (event.type === 'navigation') {
    const url = sanitizeRecordedUrl(event.url); if (!url) return next;
    const child = next.pendingChildren?.[alias];
    if (child && stamp - child.at < 10000) {
      const tab = wf.tabs.find(t => t.id === alias); if (tab) tab.url = url;
      next.pendingChildren[alias].url = url;
      const producer = wf.steps.find(s => s.id === child.stepId);
      if (producer) { producer.check = { type: 'url', equals: url, tab: alias }; delete producer.unresolved; }
      return next;
    }
    if (['click', 'press', 'dblclick'].includes(last?.op) && next.lastEvent?.tab === alias && stamp - next.lastEvent.at < 5000) {
      last.check = { type: 'url', equals: url }; delete last.unresolved;
    } else if (last?.op === 'navigate' && last.tab === alias && last.url === url) { /* duplicate commit/history callback */ }
    else add({ op: 'navigate', tab: alias, url, check: { type: 'url', equals: url }, title: 'Navigate' });
    return next;
  }
  if (event.type === 'newTab') {
    const newAlias = next.tabAliases[String(event.newTabId)];
    if (last?.op === 'click' && last.tab === alias && stamp - (next.lastEvent?.at || 0) < 5000 && newAlias) {
      last.opensTab = newAlias;
      next.pendingChildren ||= {}; next.pendingChildren[newAlias] = { at: stamp, stepId: last.id };
      const url = sanitizeRecordedUrl(event.url);
      if (url) { last.check = { type: 'url', equals: url, tab: newAlias }; delete last.unresolved; }
    } else add({ op: 'manual', title: 'Unassociated new tab: review this operation', unresolved: true });
    return next;
  }
  if (event.type === 'focus') { if (last?.tab !== alias) add({ op: 'focus', tab: alias, title: 'Switch tab' }); return next; }
  if (event.sensitive || event.type === 'sensitive' || event.type === 'unsupported') {
    const sensitive = event.sensitive || event.type === 'sensitive';
    const reason = String(event.unresolvedReason || event.reason || '');
    const title = sensitive
      ? 'Complete sensitive input manually, then continue'
      : reason === 'DRAG_UNSUPPORTED'
        ? 'Drag is not a host primitive; replace with a manual step'
        : reason === 'UPLOAD_PATH'
          ? 'File upload must use a guest FS path; replace with an upload step'
          : 'Unsupported action: edit or replace this step';
    if (last?.op !== 'manual' || next.lastEvent?.tab !== alias) {
      add({ op: 'manual', title, ...(sensitive ? {} : { unresolved: true, ...(reason ? { unresolvedReason: reason } : {}) }) });
    }
    return next;
  }
  if (next.pendingChildren?.[alias]) delete next.pendingChildren[alias];
  let target;
  try {
    target = clone(event.target); if (event.frameId !== 0) target.frameUrl = sanitizeRecordedUrl(event.frameUrl);
    validateTarget(target);
  } catch { add({ op: 'manual', title: 'Target could not be recorded; edit this step', unresolved: true }); return next; }
  const op = event.type;
  if (!PAGE_EVENTS.has(op)) return next;
  if (op === 'dblclick' && last?.op === 'click' && last.tab === alias && JSON.stringify(last.target) === JSON.stringify(target) && stamp - (next.lastEvent?.at || 0) < 600) {
    last.op = 'dblclick'; last.title = `dblclick · ${target.name || target.id || target.testId || target.tag || ''}`; last.unresolved = true; return next;
  }
  const step = { op, tab: alias, target, title: `${op} · ${target.name || target.id || target.testId || target.tag || ''}` };
  if (op === 'fill' || op === 'select' || op === 'toggle') {
    step.value = op === 'toggle' ? (event.checked === true || event.value === true || event.value === 'true') : String(event.value || '').slice(0, 20000);
    if (op === 'toggle') step.checked = step.value;
    step.check = { type: 'value', equals: String(step.value) };
    if (last?.op === op && last.tab === alias && JSON.stringify(last.target) === JSON.stringify(target)) {
      last.value = step.value; last.check = step.check; if (op === 'toggle') last.checked = step.checked; return next;
    }
  } else if (op === 'press') { step.key = String(event.key || ''); step.unresolved = true; }
  else if (op === 'scroll') { step.deltaY = Number(event.deltaY) || 0; step.unresolved = true; }
  else if (op === 'hover') { step.check = { type: 'visible' }; }
  else step.unresolved = true;
  add(step); return next;
}
