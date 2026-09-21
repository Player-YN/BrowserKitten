const OPS = ['open', 'focus', 'navigate', 'click', 'fill', 'select', 'press', 'scroll', 'read', 'wait', 'check', 'tool', 'manual',
  'hover', 'dblclick', 'contextmenu', 'toggle', 'upload', 'scrape', 'paginate', 'foreach', 'repeat', 'if', 'setVar', 'csvImport', 'csvExport'];

const COPY = {
  zh: { title: 'Workflow 自动化', blank: '空白新建', record: '录制当前标签', name: '名称', tabs: '标签别名', steps: '步骤', addStep: '添加步骤', params: '参数 JSON Schema', tools: '固定工具快照', save: '保存草稿', publish: '添加／更新', trial: '试运行到这里', run: '运行', close: '关闭', pause: '暂停', resume: '继续', cancel: '取消运行', retry: '明确重试', verify: '重新验证', complete: '确认完成', highlight: '高亮目标', del: '删除', up: '上移', down: '下移', recording: '正在录制', recPause: '暂停录制', recResume: '继续录制', addTab: '加入当前标签', stopRec: '停止录制', input: '运行输入 JSON', bindings: '标签绑定 JSON', monitor: '运行监控', status: '状态', step: '下一步', error: '错误', checks: '检查', saved: '草稿已保存', published: '已发布', schemaError: 'JSON 格式无效', target: '目标 JSON', value: '值 / 数据 JSON', check: '检查 JSON', args: '参数 JSON', tab: '标签', op: '操作', stepTitle: '步骤标题', recordingStopped: '录制已停止', rebind: '运行需要重新绑定标签别名后继续。', automation: '自动化', table: '流程表（CSV）', importCsv: '导入 CSV', exportCsv: '导出 CSV', schedule: '定时启动', everyMin: '间隔（分钟）', enabled: '浏览器打开时按间隔启动新运行', collection: '集合 / $ref JSON', body: '循环体 JSON', branchThen: 'then 分支 JSON', branchElse: 'else 分支 JSON', when: '条件 JSON', onError: '失败处理 JSON', path: '访客路径', kind: '抓取类型', itemKey: '稳定键', times: '重复次数', vars: '变量 JSON' },
  en: { title: 'Workflow automation', blank: 'Blank automation', record: 'Record current tab', name: 'Name', tabs: 'Tab aliases', steps: 'Steps', addStep: 'Add step', params: 'Parameters JSON Schema', tools: 'Pinned tool snapshots', save: 'Save draft', publish: 'Add / Update', trial: 'Trial through here', run: 'Run', close: 'Close', pause: 'Pause', resume: 'Resume', cancel: 'Cancel run', retry: 'Explicit retry', verify: 'Verify again', complete: 'Confirm completed', highlight: 'Highlight target', del: 'Delete', up: 'Move up', down: 'Move down', recording: 'Recording', recPause: 'Pause recording', recResume: 'Resume recording', addTab: 'Add current tab', stopRec: 'Stop recording', input: 'Run input JSON', bindings: 'Tab bindings JSON', monitor: 'Run monitor', status: 'Status', step: 'Next step', error: 'Error', checks: 'Checks', saved: 'Draft saved', published: 'Published', schemaError: 'Invalid JSON', target: 'Target JSON', value: 'Value / data JSON', check: 'Check JSON', args: 'Arguments JSON', tab: 'Tab', op: 'Operation', stepTitle: 'Step title', recordingStopped: 'Recording stopped', rebind: 'Rebind tab aliases, then resume the run.', automation: 'Automation', table: 'Workflow table (CSV)', importCsv: 'Import CSV', exportCsv: 'Export CSV', schedule: 'Schedule', everyMin: 'Every (minutes)', enabled: 'Start a new run on this interval while the browser is open', collection: 'Collection / $ref JSON', body: 'Loop body JSON', branchThen: 'then branch JSON', branchElse: 'else branch JSON', when: 'Condition JSON', onError: 'On-error JSON', path: 'Guest path', kind: 'Scrape kind', itemKey: 'Stable key', times: 'Repeat times', vars: 'Variables JSON' }
};

function json(value, fallback = '') { return value == null ? fallback : JSON.stringify(value, null, 2); }
function parse(text, fallback) { const value = String(text || '').trim(); return value ? JSON.parse(value) : fallback; }
function serializeLocalCsv(table = {}) {
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const cell = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replace(/"/g, '""')}"` : String(value ?? '');
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(name => cell(row?.[name])).join(','))].join('\n');
}
function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function definitionOf(draft) {
  return structuredClone(draft?.workflow || draft?.definition || { version: 2, tabs: [], steps: [], variables: {}, table: { columns: [], rows: [] } });
}
export const workflowRecordId = record => record?.id || null;
export const workflowRunDefinition = run => structuredClone(run?.definition?.workflow || { version: 2, tabs: [], steps: [], variables: {}, table: { columns: [], rows: [] } });
export const workflowTrialBoundary = step => typeof step?.id === 'string' ? step.id : undefined;
export const workflowRecordingRequest = (recording, action, tabId) => ({ recordingId: workflowRecordId(recording), action, ...(tabId != null ? { tabId } : {}) });
export function workflowBindableAliases(workflow, nextStep = 0, includeCurrentProducer = false) {
  const produced = new Set((workflow?.steps || []).flatMap((step, index) => index > nextStep || (index === nextStep && !includeCurrentProducer) ? [step.opensTab, step.op === 'open' ? step.tab : null].filter(Boolean) : []));
  return (workflow?.tabs || []).filter(alias => !produced.has(alias.id));
}

/** Structured workflow editor/runner. Runtime persistence and validation stay behind RPC. */
export function createWorkflowUi(opts = {}) {
  const doc = opts.document || document;
  const $ = opts.$ || (id => doc.getElementById(id));
  const rpc = opts.rpc;
  let dialog; let body; let draft = null; let definition = null; let entry = null;
  let recording = null; let run = null; let refreshPending = null; let refreshKey = null; let selectedStep = 0; let tools = []; const invalidEditors = new Set();
  let statusBar; let runPanel;
  const lang = () => opts.getLang?.() === 'en' ? 'en' : 'zh';
  const c = key => COPY[lang()][key] || key;
  const report = error => opts.onError?.(error);
  const activeTab = () => opts.getActiveTab?.();
  const editorLabel = (zh, en) => lang() === 'en' ? en : zh;
  const guardRender = action => { if (invalidEditors.size) throw new Error(c('schemaError')); action(); };
  const button = (label, action, className = '') => {
    const el = doc.createElement('button'); el.type = 'button'; el.textContent = label; el.className = className;
    el.addEventListener('click', async () => { if (el.disabled) return; el.disabled = true; try { await action(); } catch (e) { report(e); } finally { el.disabled = false; } });
    return el;
  };
  const field = (label, value, oninput, multiline = false) => {
    const wrap = doc.createElement('label'); const cap = doc.createElement('span'); cap.textContent = label;
    const input = doc.createElement(multiline ? 'textarea' : 'input'); input.value = value ?? ''; input.addEventListener('input', () => oninput(input.value));
    wrap.append(cap, input); return { wrap, input };
  };
  function ensureDialog() {
    if (dialog) return;
    dialog = doc.createElement('dialog'); dialog.className = 'personal-library-dialog workflow-dialog';
    const head = doc.createElement('header'); head.className = 'personal-library-head';
    const title = doc.createElement('h2'); title.textContent = c('title'); head.append(title, button(c('close'), close));
    body = doc.createElement('div'); body.className = 'workflow-body'; dialog.append(head, body); doc.body.appendChild(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    statusBar = doc.createElement('section'); statusBar.className = 'workflow-status-bar'; statusBar.hidden = true;
    const anchor = $('personalLibraryDraftCard');
    if (anchor?.parentNode?.insertBefore) anchor.parentNode.insertBefore(statusBar, anchor); else doc.body.appendChild(statusBar);
  }
  function close() { dialog?.close(); renderStatusBar(); }
  async function patchDraft(patch) {
    const result = await rpc('updateWorkflowDraft', { draftId: draft.draftId, expectedRevision: draft.revision, patch });
    draft = result.draft; definition = definitionOf(draft); opts.onDraft?.(draft); render(); return draft;
  }
  function collectEditor() {
    return { name: draft.name || '', parameters: draft.parameters || { type: 'object', properties: {} }, workflow: definition };
  }
  async function save() { if (invalidEditors.size) throw new Error(c('schemaError')); await patchDraft(collectEditor()); opts.toast?.(c('saved')); }
  async function publish() {
    await save();
    await rpc('publishLibraryDraft', { draftId: draft.draftId, expectedRevision: draft.revision });
    opts.toast?.(c('published')); recording = null; renderStatusBar(); await opts.onPublished?.(); close();
  }
  async function start(stopAfter) {
    await save();
    const input = await askJson(c('input'), '{}'); if (input == null) return;
    const bindings = await collectBindings(definition, {}, 0); if (bindings == null) return;
    const result = await rpc('startWorkflowRun', { draftId: draft.draftId, expectedRevision: draft.revision, input, bindings, ...(typeof stopAfter === 'string' ? { stopAfter } : {}) });
    recording = null; run = result.run; dialog?.close(); renderStatusBar(); await opts.onRunSession?.(result.sessionId, draft.name); await resync();
  }
  async function askJson(title, initial) {
    const text = await opts.prompt?.(title, initial);
    if (text == null) return null;
    try { return parse(text, {}); } catch { throw new Error(c('schemaError')); }
  }
  async function collectBindings(workflow, current = {}, nextStep = 0, includeCurrentProducer = false) {
    const live = await rpc('listWorkflowTabs', {}); const tabs = Array.isArray(live) ? live : live?.tabs || [];
    const aliases = workflowBindableAliases(workflow, nextStep, includeCurrentProducer);
    if (!aliases.length) return {};
    return new Promise(resolve => {
      const dlg = doc.createElement('dialog'); dlg.className = 'personal-library-dialog workflow-binding-dialog';
      const form = doc.createElement('form'); const heading = doc.createElement('h3'); heading.textContent = c('bindings'); form.append(heading);
      const selects = new Map();
      aliases.forEach(alias => {
        const label = doc.createElement('label'); label.append(doc.createTextNode(alias.title || alias.id)); const select = doc.createElement('select');
        const blank = doc.createElement('option'); blank.value = ''; blank.textContent = '—'; select.append(blank);
        tabs.forEach(tab => { const option = doc.createElement('option'); option.value = String(tab.id); option.textContent = `${tab.title || tab.url || tab.id} · ${tab.url || ''}`; select.append(option); });
        const matches = tabs.filter(tab => alias.url && tab.url === alias.url); select.value = current[alias.id] != null ? String(current[alias.id]) : matches.length === 1 ? String(matches[0].id) : '';
        label.append(select); form.append(label); selects.set(alias.id, select);
      });
      const actions = doc.createElement('div'); actions.className = 'workflow-actions';
      const finish = value => { dlg.close(); dlg.remove(); resolve(value); };
      dlg.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      form.addEventListener('submit', event => event.preventDefault());
      actions.append(button(c('cancel'), () => finish(null)), button(c('resume'), () => { const out = {}; for (const [id, select] of selects) if (select.value) out[id] = Number(select.value); finish(out); }, 'primary')); form.append(actions); dlg.append(form); doc.body.append(dlg); dlg.showModal();
    });
  }
  function updateStatus() {
    renderStatusBar();
    if (dialog?.open && runPanel?.isConnected) { const old = runPanel; renderRun(old.parentNode); old.remove(); }
  }
  function applyRun(next) {
    if (!next || next.id !== run?.id || next.revision < run.revision) return false;
    run = next; updateStatus(); return true;
  }
  function applyRecording(next) {
    if (!next || next.id !== recording?.id || next.revision < recording.revision) return false;
    const wasLocked = recording.status !== 'stopped';
    recording = next;
    if (wasLocked) definition = structuredClone(next.definition.workflow);
    renderStatusBar();
    // A live recording owns its editor. Run progress must never redraw an
    // editable draft or replace partially entered JSON.
    if (wasLocked && dialog?.open) render();
    return true;
  }
  function handleEvent(event) {
    if (event?.type === 'workflow-run') return applyRun(event.run);
    if (event?.type === 'workflow-recording') {
      const accepted = applyRecording(event.recording);
      if (accepted && event.draft?.draftId === draft?.draftId && event.draft.revision > draft.revision) {
        // Control events carry the committed draft revision; preserve any local
        // edits while keeping the next save's compare-and-swap token current.
        draft = { ...draft, revision: event.draft.revision };
      }
      return accepted;
    }
    return false;
  }
  // One read after attaching, and on focus/visibility regain, catches events
  // sent before the RPC response or while this sidepanel was disconnected.
  function resync() {
    const key = `${run?.id || ''}:${recording?.id || ''}`;
    if (refreshPending) return refreshKey === key ? refreshPending : refreshPending.then(() => resync());
    refreshKey = key;
    refreshPending = (async () => {
      const runId = run?.id; const recordingId = recording?.id;
      if (runId) applyRun(await rpc('getWorkflowRun', { runId }));
      if (recordingId) applyRecording(await rpc('getWorkflowRecording', { recordingId }));
    })().finally(() => { refreshPending = null; });
    return refreshPending;
  }
  const onReturn = () => { if (doc.visibilityState !== 'hidden') void resync().catch(report); };
  doc.addEventListener?.('visibilitychange', onReturn);
  doc.defaultView?.addEventListener('focus', onReturn);
  async function runDecision(decision, cancel = false) {
    if (!run) return;
    if (decision === 'pause') run = await rpc('pauseWorkflowRun', { runId: workflowRecordId(run), cancel });
    else {
      const uncertainProducer = Boolean(run.recovering && run.attempt?.writes && ['dispatching', 'checking'].includes(run.attempt.phase));
      const bindings = await collectBindings(run.definition.workflow, run.bindings || {}, run.nextStep || 0, uncertainProducer); if (bindings === null) return;
      run = await rpc('resumeWorkflowRun', { runId: workflowRecordId(run), expectedRevision: run.revision, bindings, decision });
    }
    dialog?.close(); renderStatusBar(); await opts.onRunSession?.(run.sessionId, run.definition?.name); await resync();
  }
  async function refreshRecording() {
    if (!recording) return;
    const id = recording.id;
    const next = await rpc('getWorkflowRecording', { recordingId: id });
    if (!next || recording?.id !== id) return;
    const result = await rpc('getPersonalLibraryDraft', { draftId: next.draftId });
    if (recording?.id !== id) return;
    if (recording.status !== 'stopped') draft = result?.draft || draft;
    applyRecording(next);
  }
  async function recordingAction(action) {
    const tab = action === 'addTab' ? await activeTab() : null;
    const result = await rpc('controlWorkflowRecording', workflowRecordingRequest(recording, action, tab?.tabId));
    if (recording?.id !== result.recording.id) return;
    if (result.draft) draft = result.draft;
    const accepted = applyRecording(result.recording);
    if (accepted && result.draft) definition = definitionOf(draft);
    if (action === 'stop') opts.toast?.(c('recordingStopped'));
    renderStatusBar(); if (dialog?.open) render();
  }
  function renderRecording(parent) {
    if (!recording) return;
    const bar = doc.createElement('section'); bar.className = 'workflow-recording';
    const label = doc.createElement('strong'); label.textContent = `${c('recording')} · ${recording.status || 'active'}`; bar.append(label);
    if (recording.status !== 'stopped') { const paused = recording.status === 'paused'; bar.append(button(c(paused ? 'recResume' : 'recPause'), () => recordingAction(paused ? 'resume' : 'pause')), button(c('addTab'), () => recordingAction('addTab')), button(c('stopRec'), () => recordingAction('stop')), button('↻', refreshRecording)); } parent.appendChild(bar);
  }
  function renderStatusBar() {
    if (!statusBar) return; statusBar.replaceChildren(); statusBar.hidden = !(recording || run);
    if (recording) {
      const text = doc.createElement('strong'); text.textContent = `${c('recording')} · ${recording.status}${recording.error?.message ? ` · ${recording.error.message}` : ''}`; statusBar.append(text);
      if (recording.status !== 'stopped') { const paused = recording.status === 'paused'; statusBar.append(button(c(paused ? 'recResume' : 'recPause'), () => recordingAction(paused ? 'resume' : 'pause')), button(c('addTab'), () => recordingAction('addTab')), button(c('stopRec'), () => recordingAction('stop'))); }
      statusBar.append(button(lang() === 'en' ? 'Edit' : '编辑', async () => { await resync(); if (!dialog.open) dialog.showModal(); render(); }));
    } else if (run) {
      const text = doc.createElement('strong'); text.textContent = `${run.definition?.name || c('title')} · ${run.status}`; statusBar.append(text, button(c('monitor'), async () => { await resync(); if (!dialog.open) dialog.showModal(); render(); }));
    }
  }
  function renderStep(step, index, parent) {
    const card = doc.createElement('article'); card.className = `workflow-step${selectedStep === index ? ' is-selected' : ''}`;
    card.addEventListener('click', () => { selectedStep = index; });
    const grid = doc.createElement('div'); grid.className = 'workflow-step-grid';
    const op = doc.createElement('select'); OPS.forEach(value => { const option = doc.createElement('option'); option.value = value; option.textContent = value; op.append(option); }); op.value = step.op || 'click'; op.onchange = () => { if (invalidEditors.size) { op.value = step.op; return report(new Error(c('schemaError'))); } step.op = op.value; render(); };
    const tab = doc.createElement('select'); (definition.tabs || []).forEach(item => { const option = doc.createElement('option'); option.value = item.id; option.textContent = item.title || item.id; tab.append(option); }); tab.value = step.tab || ''; tab.onchange = () => { step.tab = tab.value; };
    const title = field(c('stepTitle'), step.title || '', value => { step.title = value; });
    grid.append(op, tab, title.wrap); card.append(grid);
    const target = field(c('target'), json(step.target), raw => { try { step.target = parse(raw, undefined); invalidEditors.delete(target.input); target.input.setCustomValidity(''); } catch { invalidEditors.add(target.input); target.input.setCustomValidity(c('schemaError')); } }, true);
    const value = field(c('value'), json(step.value, typeof step.value === 'string' ? step.value : ''), raw => { try { step.value = parse(raw, raw); value.input.setCustomValidity(''); } catch { step.value = raw; } }, true);
    const check = field(c('check'), json(step.check), raw => { try { step.check = parse(raw, undefined); invalidEditors.delete(check.input); check.input.setCustomValidity(''); } catch { invalidEditors.add(check.input); check.input.setCustomValidity(c('schemaError')); } }, true);
    const args = field(c('args'), json(step.args), raw => { try { step.args = parse(raw, undefined); invalidEditors.delete(args.input); args.input.setCustomValidity(''); } catch { invalidEditors.add(args.input); args.input.setCustomValidity(c('schemaError')); } }, true);
            const extras = doc.createElement('div'); extras.className = 'workflow-step-grid workflow-step-extras';
    const simple = (label, key, type = 'text') => { const item = field(label, step[key] ?? '', raw => { if (type === 'number') step[key] = raw === '' ? undefined : Number(raw); else step[key] = raw || undefined; }); item.input.type = type; return item; };
    const url = field('URL / {$ref}', typeof step.url === 'object' ? json(step.url) : step.url || '', raw => { try { step.url = raw.trim().startsWith('{') ? parse(raw, undefined) : raw || undefined; invalidEditors.delete(url.input); url.input.setCustomValidity(''); } catch { invalidEditors.add(url.input); url.input.setCustomValidity(c('schemaError')); } }); const key = simple(editorLabel('按键', 'Key'), 'key'); const delta = simple(editorLabel('滚动距离', 'Scroll distance'), 'deltaY', 'number'); const timeout = simple(editorLabel('等待上限（毫秒）', 'Timeout (ms)'), 'timeoutMs', 'number'); const opens = simple(editorLabel('打开标签别名', 'Opens tab alias'), 'opensTab');
    const path = field(c('path'), typeof step.path === 'object' ? json(step.path) : step.path || '', raw => { try { step.path = raw.trim().startsWith('{') ? parse(raw, undefined) : raw || undefined; invalidEditors.delete(path.input); path.input.setCustomValidity(''); } catch { invalidEditors.add(path.input); path.input.setCustomValidity(c('schemaError')); } });
    const kind = simple(c('kind'), 'kind'); const itemKey = simple(c('itemKey'), 'itemKey'); const times = simple(c('times'), 'times', 'number');
    const unresolved = doc.createElement('label'); const unresolvedInput = doc.createElement('input'); unresolvedInput.type = 'checkbox'; unresolvedInput.checked = step.unresolved === true; unresolvedInput.onchange = () => { if (unresolvedInput.checked) step.unresolved = true; else delete step.unresolved; }; unresolved.append(unresolvedInput, doc.createTextNode(editorLabel('待处理', 'Unresolved')));
    const collection = field(c('collection'), json(step.collection), raw => { try { step.collection = parse(raw, undefined); invalidEditors.delete(collection.input); collection.input.setCustomValidity(''); } catch { invalidEditors.add(collection.input); collection.input.setCustomValidity(c('schemaError')); } }, true);
    const when = field(c('when'), json(step.when), raw => { try { step.when = parse(raw, undefined); invalidEditors.delete(when.input); when.input.setCustomValidity(''); } catch { invalidEditors.add(when.input); when.input.setCustomValidity(c('schemaError')); } }, true);
    const body = field(c('body'), json(step.steps, '[]'), raw => { try { step.steps = parse(raw, []); invalidEditors.delete(body.input); body.input.setCustomValidity(''); } catch { invalidEditors.add(body.input); body.input.setCustomValidity(c('schemaError')); } }, true);
    const thenF = field(c('branchThen'), json(step.then, '[]'), raw => { try { step.then = parse(raw, []); invalidEditors.delete(thenF.input); thenF.input.setCustomValidity(''); } catch { invalidEditors.add(thenF.input); thenF.input.setCustomValidity(c('schemaError')); } }, true);
    const elseF = field(c('branchElse'), json(step.else, '[]'), raw => { try { step.else = parse(raw, []); invalidEditors.delete(elseF.input); elseF.input.setCustomValidity(''); } catch { invalidEditors.add(elseF.input); elseF.input.setCustomValidity(c('schemaError')); } }, true);
    const onError = field(c('onError'), json(step.onError), raw => { try { step.onError = parse(raw, undefined); invalidEditors.delete(onError.input); onError.input.setCustomValidity(''); } catch { invalidEditors.add(onError.input); onError.input.setCustomValidity(c('schemaError')); } }, true);
    extras.append(url.wrap, key.wrap, delta.wrap, timeout.wrap, opens.wrap, path.wrap, kind.wrap, itemKey.wrap, times.wrap, unresolved); card.append(target.wrap, value.wrap, check.wrap, args.wrap, collection.wrap, when.wrap, body.wrap, thenF.wrap, elseF.wrap, onError.wrap, extras);
    const actions = doc.createElement('div'); actions.className = 'workflow-actions';
    actions.append(button(c('up'), () => guardRender(() => { if (index) { [definition.steps[index - 1], definition.steps[index]] = [step, definition.steps[index - 1]]; selectedStep = index - 1; render(); } })), button(c('down'), () => guardRender(() => { if (index < definition.steps.length - 1) { [definition.steps[index + 1], definition.steps[index]] = [step, definition.steps[index + 1]]; selectedStep = index + 1; render(); } })), button(c('del'), () => guardRender(() => { definition.steps.splice(index, 1); selectedStep = Math.max(0, index - 1); render(); })), button(c('highlight'), async () => { const tabs = await rpc('listWorkflowTabs', {}); const alias = definition.tabs.find(row => row.id === step.tab); const matches = tabs.filter(row => alias?.url && row.url === alias.url); let tabId = run?.bindings?.[step.tab] || (matches.length === 1 ? matches[0].id : null); if (!tabId) { const picked = await collectBindings({ version: 2, tabs: alias ? [alias] : [], steps: [] }, {}, 0); tabId = picked?.[step.tab]; } if (tabId) await rpc('validateWorkflowTarget', { tabId, target: step.target }); }), button(c('trial'), () => start(workflowTrialBoundary(step))));
    card.append(actions); parent.appendChild(card);
  }
  function renderRun(parent) {
    if (!run) return;
    const box = doc.createElement('section'); runPanel = box; box.className = 'workflow-run'; const heading = doc.createElement('strong'); heading.textContent = c('monitor'); box.append(heading);
    const attempts = (run.attempts || []).slice(-5).map(item => `${item.stepId || '?'} · ${item.phase || '?'}${item.evidence ? ` · ${JSON.stringify(item.evidence)}` : ''}`).join('\n');
    const pre = doc.createElement('pre'); pre.textContent = [`${c('status')}: ${run.status}`, `${c('step')}: ${run.nextStep ?? 0}/${run.definition?.workflow?.steps?.length ?? definition.steps.length}`, attempts, run.attempt ? `current: ${run.attempt.stepId} · ${run.attempt.phase}` : '', run.error ? `${c('error')}: ${typeof run.error === 'string' ? run.error : `${run.error.code || ''} ${run.error.message || ''}`}` : '', run.status === 'needs_human' ? c('rebind') : ''].filter(Boolean).join('\n'); box.append(pre);
    const actions = doc.createElement('div'); actions.className = 'workflow-actions';
    if (run.status === 'running') actions.append(button(c('pause'), () => runDecision('pause')), button(c('cancel'), () => runDecision('pause', true)));
    if (['paused', 'needs_human'].includes(run.status)) actions.append(button(c('resume'), () => runDecision('verify')), button(c('verify'), () => runDecision('verify')), button(c('retry'), () => runDecision('retry')), button(c('complete'), () => runDecision('complete')), button(c('cancel'), () => runDecision('pause', true)));
    box.append(actions); parent.appendChild(box);
  }
  function render() {
    if (!body || !draft || !definition) return; body.replaceChildren(); renderRecording(body);
    const name = field(c('name'), draft.name || '', value => { draft.name = value; }); body.append(name.wrap);
    const tabs = doc.createElement('section'); tabs.className = 'workflow-tabs'; const title = doc.createElement('strong'); title.textContent = c('tabs'); tabs.append(title);
    (definition.tabs || []).forEach((item, index) => { const row = doc.createElement('div'); row.className = 'workflow-tab-row'; const id = field('ID', item.id, () => {}); id.input.readOnly = true; const label = field(c('name'), item.title || '', value => { item.title = value; }); const url = field('URL', item.url || '', value => { item.url = value || undefined; }); const opener = field(editorLabel('来源标签', 'Opener'), item.opener || '', value => { item.opener = value || undefined; }); row.append(id.wrap, label.wrap, url.wrap, opener.wrap, button(c('del'), () => guardRender(() => { definition.tabs.splice(index, 1); definition.steps = definition.steps.filter(step => step.tab !== item.id && step.opensTab !== item.id && step.check?.tab !== item.id); render(); }))); tabs.append(row); });
    tabs.append(button('+', () => guardRender(() => { definition.tabs.push({ id: uid('tab'), title: `Tab ${definition.tabs.length + 1}` }); render(); }))); body.append(tabs);
    const steps = doc.createElement('section'); const stepHead = doc.createElement('div'); stepHead.className = 'workflow-section-head'; const st = doc.createElement('strong'); st.textContent = c('steps'); stepHead.append(st, button(c('addStep'), () => guardRender(() => { definition.steps.push({ id: uid('step'), title: '', op: 'click', tab: definition.tabs[0]?.id || '' }); selectedStep = definition.steps.length - 1; render(); }))); steps.append(stepHead); definition.steps.forEach((step, index) => renderStep(step, index, steps)); body.append(steps);
    const tableBox = doc.createElement('section'); tableBox.className = 'workflow-table';
    const tableHead = doc.createElement('strong'); tableHead.textContent = c('table'); tableBox.append(tableHead);
    const csv = field('CSV', serializeLocalCsv(definition.table), raw => { definition._csvDraft = raw; }, true);
    tableBox.append(csv.wrap, button(c('importCsv'), async () => {
      const text = definition._csvDraft ?? serializeLocalCsv(definition.table);
      const result = await rpc('importWorkflowTable', { draftId: draft.draftId, expectedRevision: draft.revision, csv: text });
      draft = result.draft; definition = definitionOf(draft); render();
    }), button(c('exportCsv'), async () => {
      const result = await rpc('exportWorkflowTable', { draftId: draft.draftId });
      await opts.prompt?.(c('exportCsv'), result.csv || '');
    }));
    body.append(tableBox);
    const vars = field(c('vars'), json(definition.variables || {}), raw => { try { definition.variables = parse(raw, {}); invalidEditors.delete(vars.input); vars.input.setCustomValidity(''); } catch { invalidEditors.add(vars.input); vars.input.setCustomValidity(c('schemaError')); } }, true);
    body.append(vars.wrap);
    const scheduleBox = doc.createElement('section'); scheduleBox.className = 'workflow-schedule';
    const schTitle = doc.createElement('strong'); schTitle.textContent = c('schedule'); scheduleBox.append(schTitle);
    definition.schedule ||= { enabled: false, everyMinutes: 60 };
    const enabled = doc.createElement('label'); const en = doc.createElement('input'); en.type = 'checkbox'; en.checked = definition.schedule.enabled === true; en.onchange = () => { definition.schedule.enabled = en.checked; };
    enabled.append(en, doc.createTextNode(c('enabled'))); scheduleBox.append(enabled);
    const every = field(c('everyMin'), String(definition.schedule.everyMinutes || 60), raw => { definition.schedule.everyMinutes = Number(raw) || undefined; }); scheduleBox.append(every.wrap);
    body.append(scheduleBox);
    const parameters = field(c('params'), json(draft.parameters || { type: 'object', properties: {} }), raw => { try { draft.parameters = parse(raw, {}); invalidEditors.delete(parameters.input); parameters.input.setCustomValidity(''); } catch { invalidEditors.add(parameters.input); parameters.input.setCustomValidity(c('schemaError')); } }, true); body.append(parameters.wrap);
    if (tools.length) { const toolBox = doc.createElement('fieldset'); const legend = doc.createElement('legend'); legend.textContent = c('tools'); toolBox.append(legend); tools.forEach(tool => { const label = doc.createElement('label'); const input = doc.createElement('input'); input.type = 'checkbox'; input.checked = definition.steps.some(step => step.op === 'tool' && step.tool?.entryId === tool.entryId); input.onchange = () => { if (invalidEditors.size) { input.checked = !input.checked; return report(new Error(c('schemaError'))); } if (input.checked) definition.steps.push({ id: uid('step'), title: tool.name, op: 'tool', tab: definition.tabs[0]?.id || '', tool: structuredClone(tool), args: {} }); else definition.steps = definition.steps.filter(step => !(step.op === 'tool' && step.tool?.entryId === tool.entryId)); render(); }; label.append(input, doc.createTextNode(`${tool.name} · v${tool.revision}`)); toolBox.append(label); }); body.append(toolBox); }
    if (draft.draftId) { const footer = doc.createElement('footer'); footer.className = 'workflow-footer'; footer.append(button(c('save'), save), button(c('run'), () => start()), button(c('publish'), publish, 'primary'), button(editorLabel('与 Agent 讨论', 'Discuss with Agent'), async () => { await save(); dialog.close(); await opts.onRunSession?.(draft.sessionId, draft.name); }), button(editorLabel('读取对话修改', 'Read conversation changes'), async () => { if (invalidEditors.size) throw new Error(c('schemaError')); const reviewed = await rpc('refreshLibraryDraft', { draftId: draft.draftId }); draft = reviewed.draft; definition = definitionOf(draft); render(); })); body.append(footer); }
    renderRun(body);
    if (recording && recording.status !== 'stopped') body.querySelectorAll('input,textarea,select,.workflow-step button,.workflow-footer button,.workflow-tabs > button,.workflow-tab-row button').forEach(node => { node.disabled = true; });
  }
  async function open({ source = 'blank', published = null } = {}) {
    ensureDialog(); invalidEditors.clear(); entry = published;
    const list = await rpc('listPersonalLibrary', {}); tools = (Array.isArray(list) ? list : list?.entries || []).filter(item => item.kind === 'tool');
    if (source === 'record') {
      const tab = await activeTab(); const result = await rpc('startWorkflowRecording', { tabId: tab?.tabId, lang: lang() }); recording = result.recording; draft = result.draft;
    } else {
      const result = await rpc('createWorkflowDraft', { ...(published?.name ? { name: published.name } : {}), ...(published?.entryId ? { entryId: published.entryId } : {}), lang: lang() }); draft = result.draft; recording = null;
    }
    definition = recording?.definition?.workflow ? structuredClone(recording.definition.workflow) : definitionOf(draft); run = null; selectedStep = 0; renderStatusBar(); render();
    if (recording) { dialog.close(); await resync(); } else if (!dialog.open) dialog.showModal();
  }
  async function openDraft(existing) {
    ensureDialog(); invalidEditors.clear(); draft = structuredClone(existing); recording = null; run = null; definition = definitionOf(draft);
    const list = await rpc('listPersonalLibrary', {}); tools = (Array.isArray(list) ? list : list?.entries || []).filter(item => item.kind === 'tool');
    selectedStep = 0; renderStatusBar(); render(); if (!dialog.open) dialog.showModal();
  }
  async function runPublished(published, input = {}) {
    ensureDialog(); invalidEditors.clear(); entry = published; draft = structuredClone(published); definition = definitionOf(published); recording = null;
    const bindings = await collectBindings(published.workflow, {}, 0); if (bindings == null) return;
    const result = await rpc('startWorkflowRun', { entryId: published.entryId, input, bindings });
    run = result.run; dialog?.close(); renderStatusBar(); await opts.onRunSession?.(result.sessionId, published.name); await resync();
  }
  async function monitorExisting(row) {
    recording = null;
    run = await rpc('getWorkflowRun', { runId: row.id });
    definition = workflowRunDefinition(run);
    draft = { name: row.name || run.name || c('title'), parameters: run.parameters || { type: 'object', properties: {} }, workflow: definition };
    render(); if (!dialog.open) dialog.showModal(); await resync();
  }
  async function chooseCreate() {
    ensureDialog(); body.replaceChildren();
    const chooser = doc.createElement('div'); chooser.className = 'workflow-chooser'; chooser.append(button(c('blank'), () => open({ source: 'blank' })), button(c('record'), () => open({ source: 'record' })), button(lang() === 'en' ? 'Agent task' : 'Agent 任务', async () => { close(); await opts.onCreateAgent?.(); })); body.append(chooser); if (!dialog.open) dialog.showModal();
    const rows = await rpc('listWorkflowRuns', {});
    if (Array.isArray(rows) && rows.length) {
      const recent = doc.createElement('section'); recent.className = 'workflow-run';
      const title = doc.createElement('strong'); title.textContent = lang() === 'en' ? 'Recent runs' : '最近运行'; recent.append(title);
      rows.slice(0, 8).forEach(row => recent.append(button(`${row.definition?.name || row.id} · ${row.status}`, () => monitorExisting(row)))); body.append(recent);
    }
  }
  async function restore() {
    ensureDialog(); const latest = await rpc('getWorkflowRecording', {}); if (!latest) return null;
    recording = latest;
    if (latest.draftId) { const result = await rpc('getPersonalLibraryDraft', { draftId: latest.draftId }); draft = result?.draft || null; }
    definition = structuredClone(latest.definition?.workflow || definitionOf(draft)); renderStatusBar(); if (latest.status !== 'stopped') await resync(); return latest;
  }
  return { open, openDraft, chooseCreate, runPublished, close, restore, handleEvent, resync, refresh: () => recording ? refreshRecording() : null };
}
