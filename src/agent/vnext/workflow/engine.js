import {
  workflowError, resolveData, resolveStepData, resolveTarget, safeUrl, WRITE_OPS, CONTROL_OPS,
  evaluateWhen, assertCollectionItems, extractScrape, scopeFromRun, WORKFLOW_CAPS, walkSteps,
  parseWorkflowCsv, serializeWorkflowCsv
} from './definition.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
function output(result) {
  if (result?.ok === false) throw workflowError(result.code || 'WORKFLOW_HOST', result.error || 'Browser operation failed.', { outcome: result.outcome });
  return result?.result ?? result;
}
function equal(actual, check) {
  return Object.hasOwn(check, 'equals') ? JSON.stringify(actual) === JSON.stringify(check.equals) : String(actual ?? '').includes(String(check.contains));
}
function guestPath(path) {
  const value = String(path || '');
  if (!/^\/(scratch|artifacts|context)\//.test(value) || value.includes('..')) throw workflowError('WORKFLOW_INPUT', 'Upload path must be a guest FS path.');
  return value;
}
export function checkSnapshot(snapshot, check, step, value) {
  if (check.type === 'result') return equal(value && Object.hasOwn(value, 'result') ? value.result : value, check);
  if (check.type === 'url') return equal(snapshot.url || snapshot.page?.url || '', check);
  if (snapshot.frames && (check.target || step.target)?.frameUrl && !snapshot.frames.some(f => f.url === (check.target || step.target).frameUrl)) throw workflowError('WORKFLOW_FRAME_MISSING', 'The recorded frame is not available.');
  if (check.type === 'text' && !(check.target || step.target)) return equal(snapshot.text || '', check);
  try {
    const row = resolveTarget(snapshot, check.target || step.target);
    if (check.type === 'visible') return true;
    if (check.type === 'absent') return false;
    return equal(check.type === 'value' ? row.value : row.text ?? row.name, check);
  } catch (error) {
    if (error.code === 'WORKFLOW_TARGET_MISSING') return check.type === 'absent';
    throw error;
  }
}
export async function verifyStep(step, run, host, signal, value) {
  const check = resolveData(step.check, run.input, run.outputs, scopeFromRun(run));
  if (!check) {
    if (['open', 'focus'].includes(step.op)) {
      const deadline = Date.now() + (step.timeoutMs || 10000);
      do {
        signal.throwIfAborted();
        const live = output(await host.tabs());
        const tab = (Array.isArray(live) ? live : live.tabs || []).find(t => t.id === run.bindings[step.tab]);
        if (tab && (step.op === 'focus' ? tab.active === true : tab.url === step.url)) return { ok: true, type: 'host', tabId: tab.id, url: tab.url, active: tab.active, checkedAt: Date.now() };
        if (Date.now() >= deadline) break;
        await sleep(150, signal);
      } while (true);
      throw workflowError('WORKFLOW_CHECK_FAILED', 'The tab did not reach the requested state.');
    }
    return { ok: true, type: step.op === 'manual' ? 'user' : 'host' };
  }
  const deadline = Date.now() + (step.timeoutMs || 10000);
  do {
    signal.throwIfAborted();
    let passed; let receipt;
    if (check.type === 'file') passed = await host.fileExists(check.path);
    else if (check.type === 'download') { receipt = await host.download(check, run.attempt?.startedAt || run.startedAt); passed = receipt === true || receipt?.ok === true; }
    else if (check.type === 'result') passed = checkSnapshot({}, check, step, value);
    else {
      const snapshot = output(await host.observe(run.bindings[check.tab || step.tab], check.target || step.target));
      passed = checkSnapshot(snapshot, check, step, value);
    }
    if (passed) return { ok: true, type: 'host', check, ...(receipt?.evidence ? { receipt: receipt.evidence } : {}), checkedAt: Date.now() };
    if (step.op === 'check' || Date.now() >= deadline) break;
    await sleep(150, signal);
  } while (true);
  throw workflowError('WORKFLOW_CHECK_FAILED', `Check failed: ${step.title}`, { check });
}

function tabProducers(definition) {
  const producers = new Map();
  let index = 0;
  walkSteps(definition?.workflow?.steps || [], step => {
    if (step.opensTab) producers.set(step.opensTab, index);
    if (step.op === 'open') producers.set(step.tab, index);
    index += 1;
  });
  return producers;
}

export async function bindWorkflowTabs(run, host, selections = {}) {
  const tabs = output(await host.tabs());
  const list = Array.isArray(tabs) ? tabs : tabs.tabs || [];
  const bindings = {};
  const producers = tabProducers(run.definition);
  for (const alias of run.definition.workflow.tabs) {
    const producer = producers.get(alias.id);
    if (producer != null && producer >= run.nextStep && !(producer === run.nextStep && run.attempt?.writes && ['dispatching', 'checking'].includes(run.attempt.phase))) continue;
    const explicit = selections[alias.id];
    if (explicit != null) {
      const found = list.find(tab => tab.id === Number(explicit));
      if (!found || !safeUrl(found.url)) throw workflowError('WORKFLOW_TAB_MISSING', `Tab is not available: ${alias.title}`);
      bindings[alias.id] = found.id; continue;
    }
    const previous = list.find(tab => tab.id === run.bindings?.[alias.id]);
    const matches = list.filter(tab => alias.url && tab.url === alias.url);
    if (!run.recovering && previous) bindings[alias.id] = previous.id;
    else if (matches.length === 1) bindings[alias.id] = matches[0].id;
    else if (matches.length > 1) throw workflowError('WORKFLOW_TAB_AMBIGUOUS', `Choose the tab for ${alias.title}.`, { alias: alias.id, candidates: matches });
    else throw workflowError('WORKFLOW_TAB_MISSING', `Choose or open the tab for ${alias.title}.`, { alias: alias.id, candidates: list });
  }
  return bindings;
}

function canFallback(attempt, error) {
  if (attempt?.writes && attempt.phase === 'dispatching') return false;
  if (attempt?.writes && attempt.phase === 'checking' && error?.outcome === 'unknown') return false;
  return true;
}

async function bindOpenedTab(step, run, host, signal, beforeTabs, save) {
  if (!step.opensTab) return;
  const oldIds = new Set((Array.isArray(beforeTabs) ? beforeTabs : beforeTabs.tabs || []).map(tab => tab.id));
  const deadline = Date.now() + (step.timeoutMs || 10000);
  let found;
  do {
    const tabs = output(await host.tabs());
    const hits = (Array.isArray(tabs) ? tabs : tabs.tabs || []).filter(tab => !oldIds.has(tab.id) && tab.openerTabId === run.bindings[step.tab]);
    if (hits.length > 1) throw workflowError('WORKFLOW_TAB_AMBIGUOUS', 'More than one new tab was opened.');
    if (hits.length === 1) { found = hits[0]; break; }
    await sleep(150, signal);
  } while (Date.now() < deadline);
  if (!found) throw workflowError('WORKFLOW_TAB_MISSING', 'The expected new tab did not appear.');
  await save({ bindings: { ...run.bindings, [step.opensTab]: found.id } });
}

async function dispatchLeaf(step, resolved, state, host, signal, save) {
  const run = () => state.run;
  let result; let snapshot; let target;
  if ((resolved.target || step.op === 'scroll') && !['wait', 'check', 'csvImport', 'csvExport', 'setVar'].includes(step.op)) {
    snapshot = output(await host.observe(run().bindings[step.tab], resolved.target || { css: 'html' }));
    target = resolveTarget(snapshot, resolved.target || { css: 'html' });
  }
  const beforeTabs = step.opensTab ? output(await host.tabs()) : null;
  const attempt = run().attempt;
  if (attempt.writes) { attempt.phase = 'dispatching'; await save({ attempt, attempts: [...run().attempts.slice(0, -1), attempt] }); }
  switch (step.op) {
    case 'open': {
      if (!safeUrl(resolved.url)) throw workflowError('WORKFLOW_INPUT', 'Invalid navigation URL.');
      const tab = output(await host.sys('tabs.open', { url: resolved.url, active: true }, attempt.id));
      if (!tab.id) throw workflowError('WORKFLOW_TAB_MISSING', 'Opened tab was not returned.');
      await save({ bindings: { ...run().bindings, [step.tab]: tab.id } }); result = tab; break;
    }
    case 'focus': result = output(await host.sys('tabs.focus', { tabId: run().bindings[step.tab] }, attempt.id)); break;
    case 'navigate':
      if (!safeUrl(resolved.url)) throw workflowError('WORKFLOW_INPUT', 'Invalid navigation URL.');
      result = output(await host.sys('tabs.navigate', { tabId: run().bindings[step.tab], url: resolved.url }, attempt.id)); break;
    case 'click': case 'fill': case 'select': case 'press': case 'scroll':
    case 'hover': case 'dblclick': case 'contextmenu': case 'toggle': {
      snapshot ||= output(await host.observe(run().bindings[step.tab]));
      result = output(await host.action({
        op: step.op, tabId: run().bindings[step.tab], ref: target?.ref, rev: snapshot.rev,
        value: resolved.value ?? resolved.checked, key: step.key, deltaY: step.deltaY,
        operationId: attempt.id, requestId: attempt.id
      })); break;
    }
    case 'upload': {
      snapshot ||= output(await host.observe(run().bindings[step.tab]));
      result = output(await host.action({
        op: 'upload', tabId: run().bindings[step.tab], ref: target?.ref, rev: snapshot.rev,
        path: guestPath(resolved.path || resolved.value), operationId: attempt.id, requestId: attempt.id
      })); break;
    }
    case 'read': result = { text: target.text ?? target.name, value: target.value, key: target.key || target.testId || target.id || '' }; break;
    case 'scrape': {
      const spec = { kind: resolved.kind || 'links', columns: resolved.columns, itemKey: resolved.itemKey, target: resolved.target };
      result = host.scrape
        ? output(await host.scrape(run().bindings[step.tab], spec))
        : extractScrape(output(await host.observe(run().bindings[step.tab], resolved.target)), spec);
      if (result.items) extractScrape({ items: result.items }, spec);
      break;
    }
    case 'paginate': {
      snapshot ||= output(await host.observe(run().bindings[step.tab]));
      result = output(await host.action({
        op: 'click', tabId: run().bindings[step.tab], ref: target?.ref, rev: snapshot.rev,
        operationId: attempt.id, requestId: attempt.id
      }));
      result = { ...(result && typeof result === 'object' ? result : {}), mode: resolved.mode || 'next', page: (run().outputs[step.id]?.page || 0) + 1 };
      break;
    }
    case 'setVar': {
      const name = resolved.name || step.name;
      const vars = { ...(run().vars || {}), [name]: resolved.value };
      await save({ vars }); result = { name, value: resolved.value }; break;
    }
    case 'csvImport': {
      const parsed = parseWorkflowCsv(resolved.value);
      await save({ table: parsed }); result = { columns: parsed.columns, count: parsed.rows.length }; break;
    }
    case 'csvExport': {
      const csv = serializeWorkflowCsv(run().table || { columns: [], rows: [] });
      if (!host.writeFile) throw workflowError('WORKFLOW_HOST', 'csvExport requires a guest filesystem.');
      await host.writeFile(resolved.path || step.path, csv);
      result = { path: resolved.path || step.path, count: (run().table?.rows || []).length }; break;
    }
    case 'tool': result = await host.tool(structuredClone(step.tool), resolved.args || {}, run().bindings[step.tab], attempt.id); output(result); break;
    case 'wait': case 'check': result = {}; break;
    default: throw workflowError('WORKFLOW_INVALID', `Unsupported step: ${step.op}`);
  }
  await host.checkpoint?.();
  attempt.phase = 'checking'; attempt.result = result ?? null;
  await save({ attempt, attempts: [...run().attempts.slice(0, -1), attempt] });
  await bindOpenedTab(step, run(), host, signal, beforeTabs, save);
  const evidence = await verifyStep(resolved, run(), host, signal, result);
  attempt.phase = 'verified'; attempt.evidence = evidence;
  await save({ attempt: null, attempts: [...run().attempts.slice(0, -1), attempt], outputs: { ...run().outputs, [step.id]: result ?? null } });
  return result;
}

async function runLeaf(step, state, host, control, save, index) {
  const run = () => state.run;
  if (step.op === 'manual') {
    await save({ status: 'needs_human', nextStep: Number.isInteger(index) ? index : run().nextStep, error: { code: 'WORKFLOW_MANUAL', message: step.title } });
    return { paused: true };
  }
  if (step.tab && step.op !== 'open' && !run().bindings[step.tab]) throw workflowError('WORKFLOW_TAB_MISSING', `No tab bound to ${step.tab}`, { alias: step.tab });
  const resolved = resolveStepData(step, run().input, run().outputs, scopeFromRun(run()));
  const attempt = { id: `wfop_${crypto.randomUUID()}`, stepId: step.id, index: Number.isInteger(index) ? index : run().nextStep, phase: 'prepared', startedAt: Date.now(), writes: WRITE_OPS.has(step.op) };
  await save({ nextStep: Number.isInteger(index) ? index : run().nextStep, attempt, attempts: [...run().attempts, attempt] });
  try {
    await dispatchLeaf(step, resolved, state, host, control.controller.signal, save);
  } catch (error) {
    const onError = step.onError;
    if (onError?.action === 'retry' && (onError.retries || 0) > 0 && canFallback(run().attempt, error)) {
      const next = { ...step, onError: { ...onError, retries: onError.retries - 1 } };
      await save({ attempt: null });
      return runLeaf(next, state, host, control, save, index);
    }
    if (onError?.action === 'fallback' && canFallback(run().attempt, error)) {
      const failed = { ...run().attempt, phase: 'failed', error: { code: error.code, message: error.message } };
      await save({ attempt: failed, attempts: [...run().attempts.slice(0, -1), failed], outputs: { ...run().outputs, [step.id]: { error: { code: error.code, message: error.message } } } });
      return runSequence(onError.fallback || [], state, host, control, save, { resume: 0 });
    }
    throw error;
  }
  if (control.stopAfter === step.id) {
    await save({ status: 'paused', error: { code: 'WORKFLOW_TRIAL_BOUNDARY', message: 'Trial boundary reached.' } });
    return { paused: true };
  }
  return {};
}

async function runSequence(steps, state, host, control, save, { resume = 0, topLevel = false } = {}) {
  const { signal } = control.controller;
  for (let i = resume; i < steps.length; i++) {
    signal.throwIfAborted();
    const step = steps[i];
    if (topLevel) await save({ nextStep: i });
    if (CONTROL_OPS.has(step.op)) {
      const nested = await runControl(step, state, host, control, save, i);
      if (nested?.paused) return nested;
    } else {
      const leaf = await runLeaf(step, state, host, control, save, topLevel ? i : state.run.nextStep);
      if (leaf?.paused) return leaf;
    }
    if (topLevel) await save({ nextStep: i + 1, loop: null });
  }
  return {};
}

async function runControl(step, state, host, control, save, index) {
  const run = () => state.run;
  const scope = scopeFromRun(run());
  const resolved = resolveStepData(step, run().input, run().outputs, scope);
  if (step.op === 'if') {
    const ok = evaluateWhen(resolved.when || step.when, run().input, run().outputs, scope);
    const branch = ok ? (step.then || []) : (step.else || []);
    await save({ outputs: { ...run().outputs, [step.id]: { branch: ok ? 'then' : 'else' } } });
    return runSequence(branch, state, host, control, save, { resume: 0 });
  }
  if (step.op === 'foreach') {
    const source = step.source || 'collection';
    const items = resolved.collection;
    assertCollectionItems(items, { source });
    const cap = Math.min(step.max || WORKFLOW_CAPS.loop, WORKFLOW_CAPS.loop, items.length);
    const start = run().loop?.stepId === step.id ? Number(run().loop.index) || 0 : 0;
    for (let i = start; i < cap; i++) {
      const row = items[i];
      const loop = { stepId: step.id, index: i, key: plainKey(row, i), row: source === 'elements' ? { ...row, target: row.target } : (plain(row) ? row : { value: row }) };
      await save({ loop, nextStep: index });
      const body = await runSequence(step.steps || [], state, host, control, save, { resume: 0 });
      if (body?.paused) return body;
    }
    await save({ loop: null, outputs: { ...run().outputs, [step.id]: { count: cap, keys: items.slice(0, cap).map((row, i) => plainKey(row, i)) } } });
    return {};
  }
  if (step.op === 'repeat') {
    const times = Number(resolved.times);
    if (!Number.isInteger(times) || times < 0) throw workflowError('WORKFLOW_INPUT', 'repeat times must be an integer.');
    const cap = Math.min(times, step.max || WORKFLOW_CAPS.repeat, WORKFLOW_CAPS.repeat);
    const start = run().loop?.stepId === step.id ? Number(run().loop.index) || 0 : 0;
    for (let i = start; i < cap; i++) {
      await save({ loop: { stepId: step.id, index: i, key: String(i), row: { index: i } }, nextStep: index });
      const body = await runSequence(step.steps || [], state, host, control, save, { resume: 0 });
      if (body?.paused) return body;
    }
    await save({ loop: null, outputs: { ...run().outputs, [step.id]: { count: cap } } });
    return {};
  }
  return {};
}

function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function plainKey(row, index) {
  if (plain(row) && row.key != null) return String(row.key);
  if (typeof row === 'string' || typeof row === 'number') return String(row);
  return String(index);
}

/** Each persisted attempt is a recovery boundary, not a promise of exactly-once. */
export async function executeWorkflow(initial, host, control) {
  const state = { run: initial };
  const save = async patch => { state.run = await host.save({ ...state.run, ...patch }); host.event?.(state.run); return state.run; };
  try {
    await save({ status: 'running', error: null, vars: state.run.vars || structuredClone(state.run.definition.workflow.variables || {}), table: state.run.table || structuredClone(state.run.definition.workflow.table || { columns: [], rows: [] }) });
    const result = await runSequence(state.run.definition.workflow.steps, state, host, control, save, { resume: state.run.nextStep || 0, topLevel: true });
    if (result?.paused) return state.run;
    await save({ status: 'completed', completedAt: Date.now(), loop: null });
  } catch (error) {
    const status = control.cancelled ? 'cancelled' : control.controller.signal.aborted ? 'paused' : 'needs_human';
    await save({ status, error: { code: error?.code || 'WORKFLOW_INTERRUPTED', message: error?.message || 'Execution interrupted.', alias: error?.alias, candidates: error?.candidates }, recovering: true });
  }
  return state.run;
}
