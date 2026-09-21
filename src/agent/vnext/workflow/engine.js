import { workflowError, resolveData, resolveTarget, safeUrl } from './definition.js';
const WRITES = new Set(['open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'tool']);
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
  const check = resolveData(step.check, run.input, run.outputs);
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
export async function bindWorkflowTabs(run, host, selections = {}) {
  const tabs = output(await host.tabs());
  const list = Array.isArray(tabs) ? tabs : tabs.tabs || [];
  const bindings = {};
  const producers = new Map(run.definition.workflow.steps.flatMap((step, index) => step.opensTab ? [[step.opensTab, index]] : step.op === 'open' ? [[step.tab, index]] : []));
  for (const alias of run.definition.workflow.tabs) {
    const producer = producers.get(alias.id);
    // Future-produced tabs must be created by their step, even if a matching page is already open.
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

/** Each persisted attempt is a recovery boundary, not a promise of exactly-once. */
export async function executeWorkflow(initial, host, control) {
  let run = initial;
  const save = async patch => { run = await host.save({ ...run, ...patch }); host.event?.(run); return run; };
  const { signal } = control.controller;
  try {
    await save({ status: 'running', error: null });
    for (let index = run.nextStep; index < run.definition.workflow.steps.length; index++) {
      signal.throwIfAborted();
      const step = run.definition.workflow.steps[index];
      if (step.op === 'manual') {
        await save({ status: 'needs_human', nextStep: index, error: { code: 'WORKFLOW_MANUAL', message: step.title } }); return run;
      }
      if (step.tab && step.op !== 'open' && !run.bindings[step.tab]) throw workflowError('WORKFLOW_TAB_MISSING', `No tab bound to ${step.tab}`, { alias: step.tab });
      const resolved = resolveData(step, run.input, run.outputs);
      const attempt = { id: `wfop_${crypto.randomUUID()}`, stepId: step.id, index, phase: 'prepared', startedAt: Date.now(), writes: WRITES.has(step.op) };
      await save({ nextStep: index, attempt, attempts: [...run.attempts, attempt] });
      let result; let snapshot; let target;
      if ((resolved.target || step.op === 'scroll') && !['wait', 'check'].includes(step.op)) {
        snapshot = output(await host.observe(run.bindings[step.tab], resolved.target || { css: 'html' }));
        target = resolveTarget(snapshot, resolved.target || { css: 'html' });
      }
      const beforeTabs = step.opensTab ? output(await host.tabs()) : null;
      // Persist uncertainty before invoking any potentially side-effectful host.
      if (attempt.writes) { attempt.phase = 'dispatching'; await save({ attempt, attempts: [...run.attempts.slice(0, -1), attempt] }); }
      switch (step.op) {
        case 'open': {
          if (!safeUrl(resolved.url)) throw workflowError('WORKFLOW_INPUT', 'Invalid navigation URL.');
          const tab = output(await host.sys('tabs.open', { url: resolved.url, active: true }, attempt.id));
          if (!tab.id) throw workflowError('WORKFLOW_TAB_MISSING', 'Opened tab was not returned.');
          await save({ bindings: { ...run.bindings, [step.tab]: tab.id } }); result = tab; break;
        }
        case 'focus': result = output(await host.sys('tabs.focus', { tabId: run.bindings[step.tab] }, attempt.id)); break;
        case 'navigate':
          if (!safeUrl(resolved.url)) throw workflowError('WORKFLOW_INPUT', 'Invalid navigation URL.');
          result = output(await host.sys('tabs.navigate', { tabId: run.bindings[step.tab], url: resolved.url }, attempt.id)); break;
        case 'click': case 'fill': case 'select': case 'press': case 'scroll': {
          snapshot ||= output(await host.observe(run.bindings[step.tab]));
          result = output(await host.action({ op: step.op, tabId: run.bindings[step.tab], ref: target?.ref, rev: snapshot.rev,
            value: resolved.value, key: step.key, deltaY: step.deltaY, operationId: attempt.id, requestId: attempt.id })); break;
        }
        case 'read': result = { text: target.text ?? target.name, value: target.value }; break;
        case 'tool': result = await host.tool(structuredClone(step.tool), resolved.args || {}, run.bindings[step.tab], attempt.id); output(result); break;
        case 'wait': case 'check': result = {}; break;
      }
      // File outputs must be durable before the run can advance past their producer.
      await host.checkpoint?.();
      attempt.phase = 'checking'; attempt.result = result ?? null;
      await save({ attempt, attempts: [...run.attempts.slice(0, -1), attempt] });
      if (step.opensTab) {
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
      const evidence = await verifyStep(resolved, run, host, signal, result);
      attempt.phase = 'verified'; attempt.evidence = evidence;
      await save({ nextStep: index + 1, attempt: null, attempts: [...run.attempts.slice(0, -1), attempt], outputs: { ...run.outputs, [step.id]: result ?? null } });
      if (control.stopAfter === step.id) { await save({ status: 'paused', error: { code: 'WORKFLOW_TRIAL_BOUNDARY', message: 'Trial boundary reached.' } }); return run; }
    }
    await save({ status: 'completed', completedAt: Date.now() });
  } catch (error) {
    const status = control.cancelled ? 'cancelled' : signal.aborted ? 'paused' : 'needs_human';
    // If saving fails, retain the previous committed dispatching record. Startup
    // recovery will surface uncertainty rather than inventing a completed step.
    await save({ status, error: { code: error?.code || 'WORKFLOW_INTERRUPTED', message: error?.message || 'Execution interrupted.', alias: error?.alias, candidates: error?.candidates }, recovering: true });
  }
  return run;
}
