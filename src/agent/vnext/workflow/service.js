import { createSessionGuestFs } from '../sessionWorkspace/fs.js';
import { validatePersonalLibraryInput, requireLibraryRevision, validatePersonalLibraryDefinition } from '../service/personalLibraryContract.js';
import { PERSONAL_LIBRARY_DRAFT_PATH, personalLibraryCreationInstructions } from '../service/personalLibraryCreationInstructions.js';
import { validateWorkflow, workflowError, sanitizeRecordedUrl } from './definition.js';
import { executeWorkflow, bindWorkflowTabs, verifyStep } from './engine.js';
import { applyRecordingEvent } from './recording.js';
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const detail = error => ({ code: error?.code || 'WORKFLOW_FAILED', message: error?.message || String(error), alias: error?.alias, candidates: error?.candidates });

export class WorkflowService {
  constructor(owner) { this.owner = owner; this.active = new Map(); this.queue = Promise.resolve(); this.ready = null; }
  async library() {
    const lib = await this.owner._library();
    if (!this.ready) this.ready = (async () => {
      for (const row of await lib.listWorkflowRecords()) if (['running', 'recording'].includes(row.status)) {
        await lib.putWorkflowRecord({ record: { ...row, status: 'paused', recovering: true, error: { code: 'WORKFLOW_RESTARTED', message: 'Review page state before resuming.' } }, expectedRevision: row.revision });
      }
    })();
    await this.ready; return lib;
  }
  async host(op, params = {}) {
    if (this.owner._workflowHost) return this.owner._workflowHost(op, params);
    const response = await chrome.runtime.sendMessage({ target: 'browserbot-background', action: 'workspace_workflow_host', op, ...params });
    if (!response?.ok) throw workflowError(response?.code || 'WORKFLOW_HOST', response?.error || 'Workflow host unavailable.');
    return response.result;
  }
  serial(fn) { const task = this.queue.catch(() => {}).then(fn); this.queue = task.catch(() => {}); return task; }
  notify(row, draft) { this.owner._broadcastUiEvent({ ...(draft ? { draft } : {}), type: row.type === 'run' ? 'workflow-run' : 'workflow-recording', sessionId: row.sessionId, [row.type === 'run' ? 'run' : 'recording']: row }); return row; }
  async get({ runId }) { const row = await (await this.library()).getWorkflowRecord({ id: runId }); if (!row) throw workflowError('WORKFLOW_NOT_FOUND', 'Run not found.'); return row; }
  async list() { return (await (await this.library()).listWorkflowRecords({ type: 'run' })).sort((a,b) => b.updatedAt-a.updatedAt); }
  async createDraft({ name = 'Automation', entryId, lang } = {}) {
    const made = await this.owner.startLibraryCreation({ kind: 'workflow', entryId, lang });
    if (entryId && made.draft.workflow) { await this.seed(made.draft); return made; }
    if (entryId) throw workflowError('WORKFLOW_INVALID', 'Use the Agent task editor for a playbook.');
    const lib = await this.library();
    const draft = await lib.updateDraft({ draftId: made.draftId, expectedRevision: made.draft.revision, patch: { name, workflow: { version: 1, tabs: [], steps: [] } } });
    await this.seed(draft); return { ...made, draft };
  }
  async seed(draft) {
    const session = this.owner.runtime.store.get('sessions', draft.sessionId);
    if (!session) throw workflowError('WORKFLOW_NOT_FOUND', 'Creation conversation was deleted.');
    this.owner.runtime.store.put('sessions', draft.sessionId, { ...session, personalLibraryInstructions: personalLibraryCreationInstructions({ kind: 'workflow', draftId: draft.draftId, entry: draft }) });
    const manifest = { draftId: draft.draftId, kind: 'workflow', name: draft.name, description: draft.description || '', parameters: draft.parameters || {}, runtimeVersion: draft.runtimeVersion, workflow: draft.workflow };
    createSessionGuestFs(this.owner.runtime.store, { sessionId: draft.sessionId }).writeFile(PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(manifest, null, 2), { mimeType: 'application/json' });
    await this.owner._persist();
  }
  async updateDraft({ draftId, expectedRevision, patch }) {
    const { draft } = await this.owner.getPersonalLibraryDraft({ draftId }); requireLibraryRevision(expectedRevision, draft.revision);
    if (this.owner._activeBySession.has(draft.sessionId)) throw workflowError('SESSION_BUSY', 'Wait for the creation turn to finish.');
    if (!this.owner.runtime.store.has('sessions', draft.sessionId)) throw workflowError('WORKFLOW_NOT_FOUND', 'Creation conversation was deleted.');
    const next = { ...draft, ...patch };
    validateWorkflow(next.workflow, { partial: true, parameters: next.parameters || {} });
    // Parameters and dependencies are validated by the library on commit.
    const saved = await (await this.library()).updateDraft({ draftId, expectedRevision, patch: { name: next.name, description: next.description, parameters: next.parameters, workflow: next.workflow } });
    await this.seed(saved); return { draft: saved };
  }
  async start({ entryId, draftId, expectedRevision, input = {}, bindings = {}, stopAfter } = {}) {
    const lib = await this.library();
    const definition = draftId ? (await this.owner.getPersonalLibraryDraft({ draftId })).draft : await lib.get({ entryId });
    if (!definition?.workflow) throw workflowError('WORKFLOW_INVALID', 'A structured workflow is required.');
    if (draftId) requireLibraryRevision(expectedRevision, definition.revision);
    validatePersonalLibraryDefinition(definition);
    if (draftId && !this.owner.runtime.store.has('sessions', definition.sessionId)) throw workflowError('WORKFLOW_NOT_FOUND', 'Creation conversation was deleted.');
    if (stopAfter && !definition.workflow.steps.some(step => step.id === stopAfter)) throw workflowError('WORKFLOW_INVALID', 'Unknown trial boundary.');
    const values = validatePersonalLibraryInput(definition.parameters, input);
    const session = this.owner.runtime.createSession({ title: definition.name });
    await this.owner._persist();
    let run = { id: id('workflow'), type: 'run', status: 'paused', sessionId: session.sessionId, definition, input: values, outputs: {}, bindings: {}, nextStep: 0, attempts: [], attempt: null, startedAt: Date.now(), draftId: draftId || null, makerSessionId: draftId ? definition.sessionId : null };
    try { run.bindings = await bindWorkflowTabs(run, { tabs: () => this.host('tabs') }, bindings); }
    catch (error) { run.error = detail(error); run.recovering = true; }
    run = await lib.putWorkflowRecord({ record: run, expectedRevision: 0 });
    this.notify(run);
    if (!run.error) this.launch(run, stopAfter);
    return { run, sessionId: run.sessionId };
  }
  async resume({ runId, expectedRevision, bindings = {}, decision = 'verify', stopAfter } = {}) {
    return this.serial(async () => {
      const lib = await this.library(); let run = await this.get({ runId });
      requireLibraryRevision(expectedRevision, run.revision);
      if (!this.owner.runtime.store.has('sessions', run.sessionId)) throw workflowError('WORKFLOW_NOT_FOUND', 'Execution conversation was deleted; start a new run.');
      if (stopAfter && !run.definition.workflow.steps.some(step => step.id === stopAfter)) throw workflowError('WORKFLOW_INVALID', 'Unknown trial boundary.');
      if (this.active.has(runId) || ['completed','cancelled'].includes(run.status)) throw workflowError('WORKFLOW_BUSY', 'This run cannot resume.');
      if (!['verify', 'complete', 'retry'].includes(decision)) throw workflowError('WORKFLOW_INVALID', 'Unknown recovery decision.');
      run.bindings = await bindWorkflowTabs({ ...run, recovering: true }, { tabs: () => this.host('tabs') }, bindings);
      run.recovering = false;
      const step = run.definition.workflow.steps[run.nextStep];
      if (!step) { run.status = 'completed'; return this.notify(await lib.putWorkflowRecord({ record: run, expectedRevision: run.revision })); }
      if (decision === 'complete') {
        if (!run.attempt && step.op !== 'manual') throw workflowError('WORKFLOW_INVALID', 'There is no uncertain or manual step to confirm.');
        const evidence = { type: 'user', at: Date.now(), message: 'User confirmed completion' };
        run.outputs[step.id] = run.attempt?.result ?? null;
        run.attempts.push({ id: id('confirmation'), stepId: step.id, phase: 'user_confirmed', evidence });
        run.nextStep++; run.attempt = null;
      } else if (run.attempt?.writes && ['dispatching','checking'].includes(run.attempt.phase) && decision !== 'retry') {
        // Verification requires the normal execution lease and fresh observation.
        run.verifyBeforeResume = true;
      } else if (step.op === 'manual' && decision !== 'complete') throw workflowError('WORKFLOW_MANUAL', 'Confirm manual completion before continuing.');
      if (decision === 'retry') {
        run.attempts.push({ id: id('retry'), stepId: step.id, phase: 'user_retry', at: Date.now() }); run.attempt = null;
      }
      run.status = 'paused'; run.error = null;
      run = await lib.putWorkflowRecord({ record: run, expectedRevision: run.revision });
      this.notify(run); this.launch(run, stopAfter); return run;
    });
  }
  async pause({ runId, cancel = false }) {
    const active = this.active.get(runId);
    if (active) { active.control.cancelled = cancel; active.control.controller.abort(workflowError('WORKFLOW_PAUSED', cancel ? 'Cancelled by user.' : 'Paused by user.')); await active.finished; return this.get({ runId }); }
    const run = await this.get({ runId });
    if (['completed', 'cancelled'].includes(run.status)) return run;
    return this.notify(await (await this.library()).putWorkflowRecord({ record: { ...run, status: cancel ? 'cancelled' : 'paused' }, expectedRevision: run.revision }));
  }
  launch(run, stopAfter) {
    const service = this.owner; const sid = run.sessionId;
    if (service._activeBySession.has(sid)) throw workflowError('SESSION_BUSY', 'This conversation is busy.');
    const control = { controller: new AbortController(), cancelled: false, stopAfter };
    const execution = service.runtime.beginExecution(sid, { abortSignal: control.controller.signal });
    let release;
    const finished = new Promise(resolve => { release = resolve; });
    service._activeBySession.set(sid, { sessionId: sid, executionId: execution.executionId, controller: control.controller, finished });
    service._activeByExecution.set(execution.executionId, control.controller);
    this.active.set(run.id, { control, finished });
    service._broadcastUiEvent({ type: 'execution-start', sessionId: sid, executionId: execution.executionId, executionKind: 'workflow' });
    const event = row => this.notify(row);
    const fs = createSessionGuestFs(service.runtime.store, { sessionId: sid, executionId: execution.executionId });
    const host = {
      save: async next => (await this.library()).putWorkflowRecord({ record: next, expectedRevision: next.revision }), event,
      tabs: () => this.host('tabs'),
      observe: (tabId, workflowTarget) => service._gatedPageAction({ op: 'snapshot', tabId, workflowTarget, workflowObserve: true, screenshot: false }, sid, control.controller.signal),
      action: payload => service._gatedPageAction(payload, sid, control.controller.signal),
      sys: (op, params, operationId) => service._gatedSys(op, params, { operationId, requestId: operationId }, sid, control.controller.signal),
      tool: (entry, input, tabId, requestId) => service._personalLibraryRunner(entry, { fs, store: service.runtime.store, sessionId: sid, input, activeTab: { tabId }, controller: control.controller,
        hostSys: (op, params, context) => service._gatedSys(op, params, { ...context, requestId }, sid, control.controller.signal) }),
      checkpoint: () => service._persist(),
      fileExists: path => fs.exists(path),
      download: (check, since) => this.host('downloads', { check, since })
    };
    void (async () => {
      let finalStatus = 'failed';
      try {
        await service.runtime.store.hydrateSessionBlobs?.(sid);
        if (run.verifyBeforeResume) {
          const step = run.definition.workflow.steps[run.nextStep];
          if (!step.check) throw workflowError('WORKFLOW_UNCERTAIN', 'This operation has no recoverable success check; confirm or retry explicitly.');
          const evidence = await verifyStep(step, run, host, control.controller.signal, run.attempt?.result);
          run = await host.save({ ...run, nextStep: run.nextStep + 1, outputs: { ...run.outputs, [step.id]: run.attempt?.result ?? null }, attempts: [...run.attempts, { ...run.attempt, phase: 'verified', evidence }], attempt: null, verifyBeforeResume: false });
        }
        run = await executeWorkflow(run, host, control); finalStatus = run.status === 'completed' ? 'settled' : 'aborted';
      } catch (error) {
        try { run = await host.save({ ...(await this.get({ runId: run.id })), status: 'needs_human', recovering: true, error: detail(error) }); } catch { /* committed attempt remains the recovery authority */ }
        event({ ...run, status: 'needs_human', error: detail(error) });
      } finally {
        control.controller.abort();
        await Promise.allSettled([service._releaseTabLeases(sid, execution.executionId), service._cleanupExecutionPolicy(sid, execution.executionId)]);
        service.runtime.settleExecution(execution, finalStatus);
        try {
          if (run.makerSessionId && service.runtime.store.has('sessions', run.makerSessionId)) createSessionGuestFs(service.runtime.store, { sessionId: run.makerSessionId }).writeFile('/artifacts/workflow-test-result.json', JSON.stringify(run, null, 2), { mimeType: 'application/json' });
          await service._persist();
        } catch (error) {
          run = { ...run, status: 'needs_human', recovering: true, error: detail(error) };
          try { run = await host.save(run); } catch { /* The prior write-ahead record remains authoritative. */ }
        }
        service._activeBySession.delete(sid); service._activeByExecution.delete(execution.executionId); this.active.delete(run.id); release(); event(run);
        service._broadcastUiEvent({ type: 'execution-end', sessionId: sid, executionId: execution.executionId, status: finalStatus, executionKind: 'workflow' });
        service._broadcastUiEvent({ type: 'artifact_shelf_updated', sessionId: sid });
      }
    })();
  }
  async validateTarget({ tabId, target }) { return this.host('highlight', { tabId, target }); }
  async recording({ recordingId } = {}) {
    const lib = await this.library();
    return recordingId ? lib.getWorkflowRecord({ id: recordingId }) : (await lib.listWorkflowRecords({ type: 'recording' })).sort((a,b) => b.updatedAt-a.updatedAt)[0] || null;
  }
  async startRecording({ tabId, lang } = {}) {
    const old = await this.recording(); if (old?.status === 'recording') throw workflowError('WORKFLOW_BUSY', 'A recording is already active.');
    const tabs = await this.host('tabs'); const tab = tabs.find(row => row.id === Number(tabId));
    if (!tab || !sanitizeRecordedUrl(tab.url)) throw workflowError('WORKFLOW_TAB_MISSING', 'Choose an HTTP(S) page to record.');
    const made = await this.createDraft({ name: lang === 'en' ? 'Recorded workflow' : '录制流程', lang });
    const definition = { ...made.draft, workflow: { version: 1, tabs: [{ id: 'tab1', title: tab.title || 'Tab 1', url: sanitizeRecordedUrl(tab.url) }], steps: [] } };
    let record = { id: id('recording'), type: 'recording', status: 'paused', sessionId: made.sessionId, draftId: made.draftId, definition, sequence: 0, tabAliases: { [tab.id]: 'tab1' } };
    record = await (await this.library()).putWorkflowRecord({ record, expectedRevision: 0 });
    record = await (await this.library()).putWorkflowRecord({ record: { ...record, status: 'recording' }, expectedRevision: record.revision });
    try { await this.host('recording.configure', { recording: record }); }
    catch (error) { await (await this.library()).putWorkflowRecord({ record: { ...record, status: 'paused', error: detail(error) }, expectedRevision: record.revision }); throw error; }
    this.notify(record);
    return { recording: record, ...made };
  }
  async controlRecording({ recordingId, action, tabId }) {
    if (!['pause', 'resume', 'stop', 'addTab'].includes(action)) throw workflowError('WORKFLOW_INVALID', 'Unknown recording action.');
    // Drain content inputs before entering the offscreen mutation queue.
    if (['pause', 'stop'].includes(action)) await this.host('recording.flush', { recordingId });
    return this.serial(async () => {
      let record = await this.recording({ recordingId }); if (!record) throw workflowError('WORKFLOW_NOT_FOUND', 'Recording not found.');
      if (record.status === 'stopped') throw workflowError('WORKFLOW_INVALID', 'Recording has ended.');
      if (action === 'addTab') {
        const tab = (await this.host('tabs')).find(row => row.id === Number(tabId));
        if (!tab || !sanitizeRecordedUrl(tab.url)) throw workflowError('WORKFLOW_TAB_MISSING', 'Tab unavailable.');
        if (!record.tabAliases[tab.id]) { const alias = `tab${record.definition.workflow.tabs.length + 1}`; record.tabAliases[tab.id] = alias; record.definition.workflow.tabs.push({ id: alias, title: tab.title || alias, url: sanitizeRecordedUrl(tab.url) }); }
      }
      record.status = action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : action === 'resume' ? 'recording' : record.status;
      record = await (await this.library()).putWorkflowRecord({ record, expectedRevision: record.revision });
      await this.host('recording.configure', { recording: record });
      const current = (await this.owner.getPersonalLibraryDraft({ draftId: record.draftId })).draft;
      const draft = (await this.updateDraft({ draftId: current.draftId, expectedRevision: current.revision, patch: { workflow: record.definition.workflow } })).draft;
      this.notify(record, draft);
      return { recording: record, draft, sessionId: record.sessionId };
    });
  }
  // This endpoint must not acquire the recording queue: SW may be waiting for it
  // while a configuration call from that queue is in flight.
  async interruptRecording({ recordingId, reason }) {
    const lib = await this.library();
    for (let retry = 0; retry < 3; retry++) {
      const row = await lib.getWorkflowRecord({ id: recordingId });
      if (!row || row.status === 'stopped') return row;
      try {
        const steps = row.definition.workflow.steps;
        if (!steps.some(step => step.id === 'recordingGap') && steps.length < 100) steps.push({ id: 'recordingGap', title: 'Recording interrupted: review unrecorded actions before continuing', op: 'manual', unresolved: true });
        const saved = await lib.putWorkflowRecord({ record: { ...row, status: 'paused', recovering: true, error: { code: 'WORKFLOW_RECORDING_INTERRUPTED', message: String(reason || 'Recorder interrupted; review before continuing.').slice(0, 2000) } }, expectedRevision: row.revision });
        this.notify(saved);
        return saved;
      } catch (error) { if (error.code !== 'LIBRARY_CONFLICT' || retry === 2) throw error; }
    }
  }
  async ingest({ recordingId, event }) {
    return this.serial(async () => {
      let record = await this.recording({ recordingId }); if (!record || record.status !== 'recording') return { ignored: true };
      if (event.type === 'newTab' && record.tabAliases[event.tabId] && !record.tabAliases[event.newTabId]) {
        const alias = `tab${record.definition.workflow.tabs.length + 1}`; record.tabAliases[event.newTabId] = alias;
        record.definition.workflow.tabs.push({ id: alias, title: event.title || alias, url: sanitizeRecordedUrl(event.url), opener: record.tabAliases[event.tabId] });
      }
      if (record.definition.workflow.tabs.length > 20 || record.definition.workflow.steps.length >= 99) {
        record.status = 'paused'; record.error = { code: 'WORKFLOW_RECORDING_LIMIT', message: 'Recording limit reached. Review and finish this draft.' };
        record.definition.workflow.tabs = record.definition.workflow.tabs.slice(0, 20);
        record.definition.workflow.steps.push({ id: 'recordingLimit', title: 'Recording limit reached; later actions were not captured', op: 'manual', unresolved: true });
      } else record = applyRecordingEvent(record, event);
      record = await (await this.library()).putWorkflowRecord({ record, expectedRevision: record.revision });
      this.notify(record);
      return record;
    });
  }
}
