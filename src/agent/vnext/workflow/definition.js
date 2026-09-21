/** Versioned, data-only workflow. No expressions, live handles, or nth-child identity. */
export const WORKFLOW_VERSION = 2;
export const WORKFLOW_CAPS = Object.freeze({
  tabs: 40,
  steps: 400,
  bytes: 4_000_000,
  loop: 200,
  scrapeRows: 500,
  pages: 50,
  repeat: 100,
  retries: 5,
  recordingTabs: 40
});
export const STEP_OPS = [
  'open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'read', 'wait', 'check', 'tool', 'manual',
  'hover', 'dblclick', 'contextmenu', 'toggle', 'upload',
  'scrape', 'paginate', 'foreach', 'repeat', 'if',
  'setVar', 'csvImport', 'csvExport'
];
export const PAGE_OPS = ['open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'read', 'wait', 'check',
  'hover', 'dblclick', 'contextmenu', 'toggle', 'upload', 'scrape', 'paginate'];
export const WRITE_OPS = new Set(['open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'tool',
  'hover', 'dblclick', 'contextmenu', 'toggle', 'upload', 'paginate', 'csvExport']);
export const CONTROL_OPS = new Set(['foreach', 'repeat', 'if']);
export const CHECK_TYPES = ['url', 'visible', 'absent', 'text', 'value', 'download', 'result', 'file'];
export const SCRAPE_KINDS = ['table', 'links', 'attributes'];
export const ON_ERROR_ACTIONS = ['retry', 'stop', 'fallback'];
export const TARGET_FIELDS = ['role', 'name', 'type', 'region', 'id', 'testId', 'css', 'tag', 'frameUrl', 'key', 'shadowPath', 'text'];
const STEP_FIELDS = ['id', 'title', 'op', 'tab', 'target', 'value', 'key', 'deltaY', 'url', 'check', 'timeoutMs', 'tool', 'args',
  'opensTab', 'unresolved', 'unresolvedReason', 'steps', 'then', 'else', 'when', 'collection', 'as', 'source', 'times',
  'max', 'kind', 'columns', 'itemKey', 'mode', 'until', 'maxPages', 'path', 'name', 'onError', 'checked'];
const DEF_FIELDS = ['version', 'tabs', 'steps', 'variables', 'table', 'schedule'];

export const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export function workflowError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function requireThat(ok, message) { if (!ok) throw workflowError('WORKFLOW_INVALID', message); }
function keys(object, allowed) { requireThat(plain(object) && Object.keys(object).every(k => allowed.includes(k)), `Unknown fields: ${Object.keys(object || {}).filter(k => !allowed.includes(k)).join(', ')}`); }
export function identifier(value) { return typeof value === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value); }
export function emptyWorkflow() {
  return { version: WORKFLOW_VERSION, tabs: [], steps: [], variables: {}, table: { columns: [], rows: [] } };
}
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
export function cssUsesNth(css) { return /:nth-(?:child|of-type|last-child|last-of-type)\b/i.test(String(css || '')); }
export function targetHasStableKey(target) {
  if (!target) return false;
  return Boolean(target.testId || target.id || target.key || target.name || target.text || (target.role && target.name));
}
export function validateTarget(target) {
  keys(target, TARGET_FIELDS);
  requireThat(Object.values(target).every(v => typeof v === 'string' && v.length <= 2000), 'Target fields must be short strings.');
  requireThat(Boolean(target.name || target.id || target.testId || target.css || target.key || target.text), 'Target needs a name or stable locator.');
  requireThat(!target.frameUrl || safeUrl(target.frameUrl), 'Invalid frame URL.');
  return target;
}

export function walkSteps(steps, visit, ancestors = []) {
  for (const step of steps || []) {
    visit(step, ancestors);
    if (Array.isArray(step.steps)) walkSteps(step.steps, visit, [...ancestors, step]);
    if (Array.isArray(step.then)) walkSteps(step.then, visit, [...ancestors, step]);
    if (Array.isArray(step.else)) walkSteps(step.else, visit, [...ancestors, step]);
    if (Array.isArray(step.onError?.fallback)) walkSteps(step.onError.fallback, visit, [...ancestors, step]);
  }
}
export function countSteps(steps) {
  let n = 0;
  walkSteps(steps, () => { n += 1; });
  return n;
}
export function listStepIds(steps) {
  const ids = [];
  walkSteps(steps, step => ids.push(step.id));
  return ids;
}

function data(value, inputs, prior, ctx = {}) {
  if (plain(value) && Object.hasOwn(value, '$ref')) {
    keys(value, ['$ref']);
    const parts = String(value.$ref).split('.');
    requireThat(parts.every(identifier), 'Invalid data reference.');
    const root = parts[0];
    if (root === 'input') requireThat(parts.length === 2 && Object.hasOwn(inputs, parts[1]), 'Reference must use a declared input or an earlier step.');
    else if (root === 'steps') requireThat(parts.length >= 2 && prior.has(parts[1]), 'Reference must use a declared input or an earlier step.');
    else if (root === 'loop') requireThat(ctx.loopAllowed && (parts[1] === 'row' || parts[1] === 'index' || parts[1] === 'key'), 'Loop references are only valid inside foreach or repeat.');
    else if (root === 'vars') requireThat(parts.length >= 2, 'Variable references need a name.');
    else if (root === 'table') requireThat(parts[1] === 'rows' || parts[1] === 'columns', 'Table references must use table.rows or table.columns.');
    else throw workflowError('WORKFLOW_INVALID', 'Reference must use a declared input or an earlier step.');
  } else if (plain(value)) {
    for (const [key, item] of Object.entries(value)) {
      requireThat(!['__proto__', 'prototype', 'constructor'].includes(key), 'Reserved data key.');
      data(item, inputs, prior, ctx);
    }
  } else if (Array.isArray(value)) value.forEach(v => data(v, inputs, prior, ctx));
  else requireThat(value == null || ['string', 'number', 'boolean'].includes(typeof value), 'Only JSON data is supported.');
}

export function resolveData(value, input, outputs, scope = {}) {
  if (plain(value) && Object.hasOwn(value, '$ref')) {
    const parts = String(value.$ref).split('.');
    const root = parts.shift();
    let result = root === 'input' ? input
      : root === 'steps' ? outputs
        : root === 'loop' ? scope.loop
          : root === 'vars' ? scope.vars
            : root === 'table' ? scope.table
              : undefined;
    for (const key of parts) {
      if (!identifier(key) || result == null || !Object.hasOwn(Object(result), key)) throw workflowError('WORKFLOW_INPUT', `Missing data: ${value.$ref}`);
      result = result[key];
    }
    return structuredClone(result);
  }
  if (Array.isArray(value)) return value.map(v => resolveData(v, input, outputs, scope));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveData(v, input, outputs, scope)]));
  return value;
}

const SKIP_RESOLVE = new Set(['steps', 'then', 'else', 'onError', 'tool']);
export function resolveStepData(step, input, outputs, scope = {}) {
  const out = { ...step };
  for (const [key, value] of Object.entries(step)) {
    if (SKIP_RESOLVE.has(key)) continue;
    out[key] = resolveData(value, input, outputs, scope);
  }
  return out;
}

export function evaluateWhen(when, input, outputs, scope = {}) {
  if (!when) return false;
  if (Object.hasOwn(when, '$ref') && !Object.hasOwn(when, 'left')) {
    const value = resolveData(when, input, outputs, scope);
    return value !== false && value !== 0 && value != null && value !== '';
  }
  const left = resolveData(when.left ?? when, input, outputs, scope);
  if (Object.hasOwn(when, 'equals')) return JSON.stringify(left) === JSON.stringify(resolveData(when.equals, input, outputs, scope));
  if (Object.hasOwn(when, 'contains')) return String(left ?? '').includes(String(resolveData(when.contains, input, outputs, scope)));
  return left !== false && left !== 0 && left != null && left !== '';
}

function splitCsvLine(line) {
  const cells = []; let cell = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}
export function parseWorkflowCsv(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { columns: [], rows: [] };
  const lines = raw.split(/\r?\n/).filter((line, i, all) => line.length || i < all.length - 1);
  const rows = [];
  for (const line of lines) {
    if (!line && !rows.length) continue;
    rows.push(splitCsvLine(line).map(cell => cell.trim()));
  }
  while (rows.length && rows.at(-1).every(cell => cell === '')) rows.pop();
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].map((name, i) => identifier(name) ? name : `col${i + 1}`);
  requireThat(new Set(columns).size === columns.length, 'CSV columns must be unique identifiers.');
  const body = rows.slice(0, WORKFLOW_CAPS.scrapeRows + 1).slice(1).map(cells => {
    const row = {};
    columns.forEach((name, i) => { row[name] = cells[i] ?? ''; });
    return row;
  });
  return { columns, rows: body };
}
export function serializeWorkflowCsv(table = {}) {
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const cell = value => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(name => cell(row?.[name])).join(','))].join('\n');
}

function validateTable(table, partial) {
  if (table == null) return;
  keys(table, ['columns', 'rows']);
  requireThat(Array.isArray(table.columns) && Array.isArray(table.rows), 'Table needs columns and rows.');
  requireThat(table.columns.length <= 40 && table.rows.length <= WORKFLOW_CAPS.scrapeRows, 'Table exceeds the row or column cap.');
  table.columns.forEach(name => requireThat(identifier(name), 'Table columns must be identifiers.'));
  requireThat(new Set(table.columns).size === table.columns.length, 'Table columns must be unique.');
  if (!partial) table.rows.forEach(row => requireThat(plain(row), 'Table rows must be objects.'));
}
function validateSchedule(schedule) {
  if (schedule == null) return;
  keys(schedule, ['enabled', 'everyMinutes', 'input']);
  requireThat(schedule.enabled == null || typeof schedule.enabled === 'boolean', 'Schedule enabled must be boolean.');
  if (schedule.everyMinutes != null) requireThat(Number.isInteger(schedule.everyMinutes) && schedule.everyMinutes >= 1 && schedule.everyMinutes <= 1440, 'Schedule interval must be 1–1440 minutes.');
  if (schedule.input != null) requireThat(plain(schedule.input), 'Schedule input must be an object.');
  if (schedule.enabled) requireThat(Number.isInteger(schedule.everyMinutes), 'An enabled schedule needs everyMinutes.');
}
function validateWhen(when, inputs, prior, ctx) {
  keys(when, ['$ref', 'left', 'equals', 'contains']);
  requireThat(Object.hasOwn(when, '$ref') || Object.hasOwn(when, 'left'), 'A branch needs a data condition.');
  data(when, inputs, prior, ctx);
}
function validateOnError(onError, aliases, inputs, prior, ctx, partial) {
  keys(onError, ['action', 'retries', 'fallback']);
  requireThat(ON_ERROR_ACTIONS.includes(onError.action), 'onError action must be retry, stop, or fallback.');
  if (onError.retries != null) requireThat(Number.isInteger(onError.retries) && onError.retries >= 0 && onError.retries <= WORKFLOW_CAPS.retries, 'Retries must be 0–5.');
  if (onError.action === 'fallback') {
    requireThat(Array.isArray(onError.fallback) && (partial || onError.fallback.length), 'Fallback requires a branch of steps.');
    validateStepList(onError.fallback, aliases, inputs, prior, { ...ctx, loopAllowed: ctx.loopAllowed }, partial);
  }
}

function validateStepList(steps, aliases, inputs, prior, ctx, partial) {
  requireThat(Array.isArray(steps), 'Steps must be an array.');
  for (const step of steps) {
    keys(step, STEP_FIELDS);
    requireThat(identifier(step.id) && !prior.has(step.id) && STEP_OPS.includes(step.op) && typeof step.title === 'string', 'Invalid or duplicate step.');
    requireThat(!step.tab || aliases.has(step.tab), 'Unknown tab alias.');
    if (PAGE_OPS.includes(step.op)) requireThat(aliases.has(step.tab), 'Browser steps require a tab alias.');
    if (step.target) validateTarget(step.target);
    if (['click', 'fill', 'select', 'press', 'read', 'hover', 'dblclick', 'contextmenu', 'toggle', 'upload', 'scrape', 'paginate'].includes(step.op) && !partial) {
      requireThat(!!step.target, 'This step requires a target.');
    }
    if (step.opensTab) requireThat(step.op === 'click' && aliases.has(step.opensTab) && step.opensTab !== step.tab, 'Only a click may produce another tab alias.');
    if (step.timeoutMs != null) requireThat(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 100 && step.timeoutMs <= 120000, 'Timeout must be 100–120000 ms.');
    if (step.deltaY != null) requireThat(Number.isFinite(step.deltaY) && Math.abs(step.deltaY) <= 100000, 'Invalid scroll distance.');
    if (step.op === 'press' && (!partial || step.key)) requireThat(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'].includes(step.key), 'Unsupported key.');
    if (['open', 'navigate'].includes(step.op) && (!partial || step.url)) requireThat(plain(step.url) || safeUrl(step.url), 'Navigation requires a safe URL or input reference.');
    if (step.unresolvedReason != null) requireThat(typeof step.unresolvedReason === 'string' && step.unresolvedReason.length <= 400, 'Unresolved reason must be a short string.');
    const dataCtx = { loopAllowed: ctx.loopAllowed === true };
    for (const key of ['value', 'url', 'args', 'collection', 'path', 'times', 'checked']) if (step[key] !== undefined) data(step[key], inputs, prior, dataCtx);
    if (step.check) {
      keys(step.check, ['type', 'tab', 'target', 'equals', 'contains', 'path']);
      requireThat(!step.check.tab || aliases.has(step.check.tab), 'Unknown check tab alias.');
      requireThat(CHECK_TYPES.includes(step.check.type), 'Unsupported result check.');
      if (step.check.target) validateTarget(step.check.target);
      if (['visible', 'absent', 'value'].includes(step.check.type)) requireThat(!!(step.check.target || step.target), 'Check requires a target.');
      if (['url', 'text', 'value', 'result'].includes(step.check.type)) requireThat(Object.hasOwn(step.check, 'equals') || Object.hasOwn(step.check, 'contains'), 'Check requires an expected value.');
      if (step.check.type === 'download') requireThat((typeof step.check.equals === 'string' && step.check.equals.trim()) || (typeof step.check.contains === 'string' && step.check.contains.trim()), 'Download check requires a filename or URL filter.');
      if (step.check.type === 'file') requireThat(typeof step.check.path === 'string' && step.check.path.startsWith('/artifacts/') && !step.check.path.includes('..'), 'File check requires an artifact path.');
      data(step.check.equals, inputs, prior, dataCtx); data(step.check.contains, inputs, prior, dataCtx);
    }
    if (step.op === 'tool' && (!partial || step.tool)) {
      const tool = step.tool;
      requireThat(plain(tool) && tool.kind === 'tool' && typeof tool.code === 'string' && !!tool.code.trim() && typeof tool.entryId === 'string' && Number.isInteger(tool.revision) && tool.revision > 0 && tool.runtimeVersion === 'browserbot-library-v1', 'A tool step requires its full pinned definition and revision.');
      requireThat(Object.keys(tool).every(k => ['entryId', 'revision', 'kind', 'name', 'description', 'code', 'parameters', 'runtimeVersion', 'scope', 'allowedHosts', 'createdAt', 'updatedAt'].includes(k)), 'Unsupported tool snapshot fields.');
    }
    if (step.op === 'foreach') {
      requireThat(step.collection !== undefined || partial, 'foreach requires a collection.');
      requireThat(!step.source || ['collection', 'elements'].includes(step.source), 'foreach source must be collection or elements.');
      requireThat(!step.as || identifier(step.as), 'foreach alias must be an identifier.');
      if (step.max != null) requireThat(Number.isInteger(step.max) && step.max >= 1 && step.max <= WORKFLOW_CAPS.loop, 'foreach max must be 1–200.');
      requireThat(Array.isArray(step.steps) && (partial || step.steps.length), 'foreach requires a body.');
      validateStepList(step.steps, aliases, inputs, prior, { loopAllowed: true }, partial);
    }
    if (step.op === 'repeat') {
      requireThat(step.times !== undefined || partial, 'repeat requires times.');
      if (step.max != null) requireThat(Number.isInteger(step.max) && step.max >= 1 && step.max <= WORKFLOW_CAPS.repeat, 'repeat max must be 1–100.');
      requireThat(Array.isArray(step.steps) && (partial || step.steps.length), 'repeat requires a body.');
      validateStepList(step.steps, aliases, inputs, prior, { loopAllowed: true }, partial);
    }
    if (step.op === 'if') {
      if (!partial || step.when) { requireThat(plain(step.when), 'if requires a data condition.'); validateWhen(step.when, inputs, prior, dataCtx); }
      requireThat(Array.isArray(step.then) && (partial || step.then.length), 'if requires a then branch.');
      validateStepList(step.then, aliases, inputs, prior, { loopAllowed: ctx.loopAllowed }, partial);
      if (step.else) validateStepList(step.else, aliases, inputs, prior, { loopAllowed: ctx.loopAllowed }, partial);
    }
    if (step.op === 'scrape') {
      requireThat(!step.kind || SCRAPE_KINDS.includes(step.kind), 'scrape kind must be table, links, or attributes.');
      requireThat(!step.itemKey || identifier(step.itemKey), 'scrape itemKey must be an identifier.');
      if (step.columns) {
        requireThat(Array.isArray(step.columns) && step.columns.length && step.columns.length <= 20, 'scrape columns must be a short list.');
        step.columns.forEach(col => {
          if (typeof col === 'string') requireThat(identifier(col), 'scrape column names must be identifiers.');
          else {
            keys(col, ['name', 'attr', 'target']);
            requireThat(identifier(col.name), 'scrape column names must be identifiers.');
            if (col.target) validateTarget(col.target);
          }
        });
      }
    }
    if (step.op === 'paginate') {
      requireThat(!step.mode || ['next', 'loadMore'].includes(step.mode), 'paginate mode must be next or loadMore.');
      if (step.maxPages != null) requireThat(Number.isInteger(step.maxPages) && step.maxPages >= 1 && step.maxPages <= WORKFLOW_CAPS.pages, 'paginate maxPages must be 1–50.');
      if (step.until) {
        keys(step.until, ['type', 'equals', 'contains', 'target']);
        requireThat(['absent', 'pages', 'url', 'text'].includes(step.until.type), 'Unsupported pagination stop.');
        if (step.until.target) validateTarget(step.until.target);
        data(step.until.equals, inputs, prior, dataCtx); data(step.until.contains, inputs, prior, dataCtx);
      }
    }
    if (step.op === 'setVar') requireThat(identifier(step.name) || partial, 'setVar requires a variable name.');
    if (step.op === 'csvExport' && (!partial || step.path)) requireThat(typeof step.path === 'string' && step.path.startsWith('/artifacts/') && !step.path.includes('..'), 'csvExport requires an artifact path.');
    if (step.op === 'upload' && !partial) {
      requireThat(step.path !== undefined || step.value !== undefined, 'upload requires a guest FS path.');
    }
    if (step.onError) validateOnError(step.onError, aliases, inputs, prior, { loopAllowed: ctx.loopAllowed }, partial);
    if (!partial) {
      requireThat(!step.unresolved, 'Resolve all recording gaps before publishing.');
      const exempt = ['open', 'focus', 'manual', 'read', 'foreach', 'repeat', 'if', 'setVar', 'csvImport', 'scrape'];
      requireThat(exempt.includes(step.op) || !!step.check, 'Each action needs a success check.');
    }
    prior.add(step.id);
  }
}

export function validateWorkflow(definition, { partial = false, parameters = {} } = {}) {
  keys(definition, DEF_FIELDS);
  requireThat(definition.version === WORKFLOW_VERSION && Array.isArray(definition.tabs) && Array.isArray(definition.steps), 'Unsupported workflow format.');
  const total = countSteps(definition.steps);
  requireThat(definition.tabs.length <= WORKFLOW_CAPS.tabs && total <= WORKFLOW_CAPS.steps && (partial || definition.steps.length > 0), `Workflow requires 1–${WORKFLOW_CAPS.steps} steps and at most ${WORKFLOW_CAPS.tabs} tabs.`);
  const aliases = new Set();
  for (const tab of definition.tabs) {
    keys(tab, ['id', 'title', 'url', 'opener']);
    requireThat(identifier(tab.id) && !aliases.has(tab.id) && typeof tab.title === 'string', 'Invalid or duplicate tab alias.');
    requireThat(!tab.url || safeUrl(tab.url), 'Tab URL must be HTTP(S), without credentials or sensitive query parameters.');
    if (tab.opener) requireThat(aliases.has(tab.opener), 'A tab opener must be declared earlier.');
    aliases.add(tab.id);
  }
  if (definition.variables != null) {
    requireThat(plain(definition.variables), 'Variables must be an object.');
    for (const [name, value] of Object.entries(definition.variables)) {
      requireThat(identifier(name), 'Variable names must be identifiers.');
      requireThat(value == null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value) || plain(value), 'Only JSON data is supported.');
    }
  }
  validateTable(definition.table, partial);
  validateSchedule(definition.schedule);
  validateStepList(definition.steps, aliases, parameters.properties || {}, new Set(), { loopAllowed: false }, partial);
  requireThat(JSON.stringify(definition).length <= WORKFLOW_CAPS.bytes, 'Workflow is too large.');
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

export function assertCollectionItems(items, { source = 'collection' } = {}) {
  requireThat(Array.isArray(items), 'foreach collection must resolve to an array.');
  requireThat(items.length <= WORKFLOW_CAPS.loop, `foreach is capped at ${WORKFLOW_CAPS.loop} items.`);
  const keysSeen = new Set();
  items.forEach((item, index) => {
    requireThat(item == null || typeof item !== 'object' || !Array.isArray(item) || true, 'foreach items must be JSON values.');
    if (source === 'elements') {
      requireThat(plain(item), 'Element collections must be objects with a stable key.');
      requireThat(typeof item.key === 'string' && item.key, 'Element collections need a stable key; nth-child is not an identity.');
      requireThat(plain(item.target), 'Element collections need a unique target per key.');
      validateTarget(item.target);
      requireThat(targetHasStableKey(item.target), 'Element identity must use testid, id, name, text, or key — not CSS nth-child.');
      requireThat(!cssUsesNth(item.target.css) || targetHasStableKey({ ...item.target, css: '' }), 'nth-child CSS is not a stable loop identity.');
      requireThat(!keysSeen.has(item.key), 'Element collection keys must be unique.');
      keysSeen.add(item.key);
    } else if (plain(item) && item.key != null) {
      requireThat(!keysSeen.has(String(item.key)), 'Collection keys must be unique.');
      keysSeen.add(String(item.key));
    } else if (plain(item) && item.target) {
      validateTarget(item.target);
    }
    void index;
  });
  return items;
}

export function extractScrape(snapshot, spec = {}) {
  if (Array.isArray(snapshot?.items)) return normalizeScrapeItems(snapshot.items, spec);
  const controls = snapshot.controls || snapshot.rows || [];
  const kind = spec.kind || 'links';
  const columns = (spec.columns || []).map(col => typeof col === 'string' ? { name: col, attr: col } : col);
  const itemKey = spec.itemKey || (kind === 'links' ? 'href' : 'text');
  let items = [];
  if (kind === 'table' && Array.isArray(snapshot.table)) {
    items = snapshot.table.map((row, i) => ({ ...row, key: String(row[itemKey] ?? row.key ?? `row-${i}`) }));
  } else if (kind === 'links') {
    items = controls.filter(row => row.role === 'link' || row.tag === 'a' || row.href).map((row, i) => ({
      key: String(row[itemKey] || row.href || row.name || row.text || ''),
      href: row.href || '',
      text: row.text || row.name || '',
      name: row.name || '',
      target: scrapeItemTarget(row)
    })).filter(row => row.key);
  } else {
    items = controls.map((row, i) => {
      const out = { key: String(row[itemKey] || row.testId || row.id || row.name || row.text || ''), target: scrapeItemTarget(row) };
      for (const col of columns) out[col.name] = row[col.attr || col.name] ?? '';
      if (!columns.length) Object.assign(out, { text: row.text || row.name || '', value: row.value, href: row.href || '', name: row.name || '' });
      return out;
    }).filter(row => row.key);
  }
  return normalizeScrapeItems(items.slice(0, WORKFLOW_CAPS.scrapeRows), spec);
}

function scrapeItemTarget(row) {
  const target = {};
  for (const key of ['testId', 'id', 'role', 'name', 'text', 'key', 'type', 'tag', 'frameUrl', 'shadowPath']) {
    if (row[key]) target[key] = String(row[key]);
  }
  if (!targetHasStableKey(target) && row.css && !cssUsesNth(row.css)) target.css = String(row.css);
  if (!target.name && !target.id && !target.testId && !target.css && !target.key && !target.text && row.name) target.name = String(row.name);
  return target;
}

function normalizeScrapeItems(items, spec = {}) {
  const itemKey = spec.itemKey;
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const item = plain(raw) ? { ...raw } : { value: raw, key: String(raw) };
    item.key = String(itemKey && item[itemKey] != null ? item[itemKey] : item.key || '');
    if (!item.key) continue;
    if (seen.has(item.key)) throw workflowError('WORKFLOW_AMBIGUOUS', 'Scrape produced duplicate keys; refine itemKey or locators.');
    if (item.target) {
      validateTarget(item.target);
      if (cssUsesNth(item.target.css) && !targetHasStableKey({ ...item.target, css: '' })) {
        throw workflowError('WORKFLOW_INVALID', 'nth-child CSS is not a stable scrape identity.');
      }
    }
    seen.add(item.key);
    out.push(item);
    if (out.length >= WORKFLOW_CAPS.scrapeRows) break;
  }
  return { items: out, count: out.length, kind: spec.kind || 'links' };
}

export function scopeFromRun(run) {
  return { loop: run.loop || null, vars: run.vars || {}, table: run.table || { columns: [], rows: [] } };
}
