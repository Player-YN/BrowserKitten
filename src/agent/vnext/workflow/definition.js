/** Versioned, data-only sequential workflow. No expressions or stored live handles. */
export const WORKFLOW_VERSION = 1;
export const STEP_OPS = ['open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'read', 'wait', 'check', 'tool', 'manual'];
export const CHECK_TYPES = ['url', 'visible', 'absent', 'text', 'value', 'download', 'result', 'file'];
export const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export function workflowError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function requireThat(ok, message) { if (!ok) throw workflowError('WORKFLOW_INVALID', message); }
function keys(object, allowed) { requireThat(plain(object) && Object.keys(object).every(k => allowed.includes(k)), `Unknown fields: ${Object.keys(object || {}).filter(k => !allowed.includes(k)).join(', ')}`); }
export function identifier(value) { return typeof value === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value); }
export function safeUrl(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password && ![...url.searchParams.keys()].some(k => /(?:^|[_-])(token|password|secret|authorization|api[_-]?key|session|code|signature)(?:$|[_-])|^(?:accessToken|refreshToken|apiKey|sessionId)$/i.test(k)); } catch { return false; }
}
export function sanitizeRecordedUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/(?:^|[_-])(token|password|secret|authorization|api[_-]?key|session|code|signature)(?:$|[_-])|^(?:accessToken|refreshToken|apiKey|sessionId)$/i.test(key)) url.searchParams.delete(key);
    if (/token|password|secret|authorization|api[_-]?key|session|code|signature/i.test(url.hash)) url.hash = '';
    return url.href;
  } catch { return ''; }
}
export function validateTarget(target) {
  keys(target, ['role', 'name', 'type', 'region', 'id', 'testId', 'css', 'tag', 'frameUrl']);
  requireThat(Object.values(target).every(v => typeof v === 'string' && v.length <= 2000), 'Target fields must be short strings.');
  requireThat(Boolean(target.name || target.id || target.testId || target.css), 'Target needs a name or stable locator.');
  requireThat(!target.frameUrl || safeUrl(target.frameUrl), 'Invalid frame URL.');
  return target;
}
function data(value, inputs, prior) {
  if (plain(value) && Object.hasOwn(value, '$ref')) {
    keys(value, ['$ref']);
    const parts = String(value.$ref).split('.');
    requireThat(parts.every(identifier), 'Invalid data reference.');
    requireThat(parts[0] === 'input' ? parts.length === 2 && Object.hasOwn(inputs, parts[1]) : parts[0] === 'steps' && parts.length >= 2 && prior.has(parts[1]), 'Reference must use a declared input or an earlier step.');
  } else if (plain(value)) { for (const [key, item] of Object.entries(value)) { requireThat(!['__proto__', 'prototype', 'constructor'].includes(key), 'Reserved data key.'); data(item, inputs, prior); } }
  else if (Array.isArray(value)) value.forEach(v => data(v, inputs, prior));
  else requireThat(value == null || ['string', 'number', 'boolean'].includes(typeof value), 'Only JSON data is supported.');
}
export function resolveData(value, input, outputs) {
  if (plain(value) && Object.hasOwn(value, '$ref')) {
    const parts = String(value.$ref).split('.');
    let result = parts.shift() === 'input' ? input : outputs;
    for (const key of parts) {
      if (!identifier(key) || result == null || !Object.hasOwn(Object(result), key)) throw workflowError('WORKFLOW_INPUT', `Missing data: ${value.$ref}`);
      result = result[key];
    }
    return structuredClone(result);
  }
  if (Array.isArray(value)) return value.map(v => resolveData(v, input, outputs));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveData(v, input, outputs)]));
  return value;
}
export function validateWorkflow(definition, { partial = false, parameters = {} } = {}) {
  keys(definition, ['version', 'tabs', 'steps']);
  requireThat(definition.version === WORKFLOW_VERSION && Array.isArray(definition.tabs) && Array.isArray(definition.steps), 'Unsupported workflow format.');
  requireThat(definition.tabs.length <= 20 && definition.steps.length <= 100 && (partial || definition.steps.length > 0), 'Workflow requires 1–100 steps and at most 20 tabs.');
  const aliases = new Set();
  for (const tab of definition.tabs) {
    keys(tab, ['id', 'title', 'url', 'opener']);
    requireThat(identifier(tab.id) && !aliases.has(tab.id) && typeof tab.title === 'string', 'Invalid or duplicate tab alias.');
    requireThat(!tab.url || safeUrl(tab.url), 'Tab URL must be HTTP(S), without credentials or sensitive query parameters.');
    if (tab.opener) requireThat(aliases.has(tab.opener), 'A tab opener must be declared earlier.');
    aliases.add(tab.id);
  }
  const prior = new Set();
  for (const step of definition.steps) {
    keys(step, ['id', 'title', 'op', 'tab', 'target', 'value', 'key', 'deltaY', 'url', 'check', 'timeoutMs', 'tool', 'args', 'opensTab', 'unresolved']);
    requireThat(identifier(step.id) && !prior.has(step.id) && STEP_OPS.includes(step.op) && typeof step.title === 'string', 'Invalid or duplicate step.');
    requireThat(!step.tab || aliases.has(step.tab), 'Unknown tab alias.');
    if (!['tool', 'manual'].includes(step.op)) requireThat(aliases.has(step.tab), 'Browser steps require a tab alias.');
    if (step.target) validateTarget(step.target);
    if (['click', 'fill', 'select', 'press', 'read'].includes(step.op) && !partial) requireThat(!!step.target, 'This step requires a target.');
    if (step.opensTab) requireThat(step.op === 'click' && aliases.has(step.opensTab) && step.opensTab !== step.tab, 'Only a click may produce another tab alias.');
    if (step.timeoutMs != null) requireThat(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 100 && step.timeoutMs <= 120000, 'Timeout must be 100–120000 ms.');
    if (step.deltaY != null) requireThat(Number.isFinite(step.deltaY) && Math.abs(step.deltaY) <= 100000, 'Invalid scroll distance.');
    if (step.op === 'press' && (!partial || step.key)) requireThat(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'].includes(step.key), 'Unsupported key.');
    if (['open', 'navigate'].includes(step.op) && (!partial || step.url)) requireThat(plain(step.url) || safeUrl(step.url), 'Navigation requires a safe URL or input reference.');
    for (const key of ['value', 'url', 'args']) if (step[key] !== undefined) data(step[key], parameters.properties || {}, prior);
    if (step.check) {
      keys(step.check, ['type', 'tab', 'target', 'equals', 'contains', 'path']);
      requireThat(!step.check.tab || aliases.has(step.check.tab), 'Unknown check tab alias.');
      requireThat(CHECK_TYPES.includes(step.check.type), 'Unsupported result check.');
      if (step.check.target) validateTarget(step.check.target);
      if (['visible', 'absent', 'value'].includes(step.check.type)) requireThat(!!(step.check.target || step.target), 'Check requires a target.');
      if (['url', 'text', 'value', 'result'].includes(step.check.type)) requireThat(Object.hasOwn(step.check, 'equals') || Object.hasOwn(step.check, 'contains'), 'Check requires an expected value.');
      if (step.check.type === 'download') requireThat((typeof step.check.equals === 'string' && step.check.equals.trim()) || (typeof step.check.contains === 'string' && step.check.contains.trim()), 'Download check requires a filename or URL filter.');
      if (step.check.type === 'file') requireThat(typeof step.check.path === 'string' && step.check.path.startsWith('/artifacts/') && !step.check.path.includes('..'), 'File check requires an artifact path.');
      data(step.check.equals, parameters.properties || {}, prior); data(step.check.contains, parameters.properties || {}, prior);
    }
    if (step.op === 'tool' && (!partial || step.tool)) {
      const tool = step.tool;
      requireThat(plain(tool) && tool.kind === 'tool' && typeof tool.code === 'string' && !!tool.code.trim() && typeof tool.entryId === 'string' && Number.isInteger(tool.revision) && tool.revision > 0 && tool.runtimeVersion === 'browserbot-library-v1', 'A tool step requires its full pinned definition and revision.');
      requireThat(Object.keys(tool).every(k => ['entryId','revision','kind','name','description','code','parameters','runtimeVersion','scope','allowedHosts','createdAt','updatedAt'].includes(k)), 'Unsupported tool snapshot fields.');
    }
    if (!partial) {
      requireThat(!step.unresolved, 'Resolve all recording gaps before publishing.');
      requireThat(['open', 'focus', 'manual', 'read'].includes(step.op) || !!step.check, 'Each action needs a success check.');
    }
    prior.add(step.id);
  }
  requireThat(JSON.stringify(definition).length <= 2_000_000, 'Workflow is too large.');
  return structuredClone(definition);
}

/** Match all recorded constraints; never silently take the first duplicate. */
export function resolveTarget(snapshot, target) {
  validateTarget(target);
  const matches = (snapshot.controls || []).filter(row => Object.entries(target).every(([key, value]) => !value || String(row[key] ?? '') === value));
  if (matches.length !== 1) throw workflowError(matches.length ? 'WORKFLOW_AMBIGUOUS' : 'WORKFLOW_TARGET_MISSING', matches.length ? 'More than one element matches the target.' : 'Target was not found.', { matches: matches.map(row => ({ ref: row.ref, name: row.name, frameId: row.frameId })) });
  if (matches[0].disabled || matches[0].visible === false) throw workflowError('WORKFLOW_TARGET_MISSING', 'The target is not available.');
  return matches[0];
}
