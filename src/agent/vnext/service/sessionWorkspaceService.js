import { WorkflowService } from '../workflow/service.js';
/**
 * Product Session Workspace Service — unified sendMessage path.
 * Durable store (IDB / memory-backend) — not pure ephemeral Maps.
 */

import {
  createSessionWorkspaceRuntime,
  SessionWorkspaceStore
} from '../runSession.product.js';
import {
  createDurableSessionWorkspaceStore,
  DurableSessionWorkspaceStore
} from '../sessionWorkspace/durableStore.js';
import { createSessionGuestFs } from '../sessionWorkspace/fs.js';
import { isWorkspaceContractArtifact } from '../sessionWorkspace/sessionAgentsMd.js';
import {
  bytesFromRpcContent,
  createArtifact as createArtifactRecord,
  deleteArtifact as deleteArtifactRecord,
  READ_ARTIFACT_PREVIEW_DEFAULT,
  READ_ARTIFACT_PREVIEW_HARD_CAP,
  updateArtifactContent,
  revertArtifactContent
} from '../sessionWorkspace/artifacts.js';
import { rewriteGuestImageSrcs } from '../sessionWorkspace/htmlMedia.js';
import { aoaToCsv } from '../../../preview/sheetCodec.js';
import { guessMimeFromName } from '../sessionWorkspace/artifactValidate.js';
import { assertArtifactOwned } from '../sessionWorkspace/auth.js';
import { gcUnreachableWebItems, sweepOrphanScratch } from '../sessionWorkspace/gc.js';
import {
  CLIPBOARD_GROUP_KIND,
  isClipboardGroup,
  ensureClipboardGroup,
  pinClipboardItems,
  groupVisibleToSession,
  readActiveCaptureGroupId,
  writeActiveCaptureGroupId,
  findOrCreateNamedGroup
} from '../sessionWorkspace/groups.js';
import { MediaCapabilityChecks } from '../../mediaCapabilityChecks.js';
import { ContextWindowChecks } from '../../contextWindowProbe.js';
import { MSG_TARGET_BACKGROUND, WORKSPACE_DB_NAME } from '../../../brand.js';
import { createBrowserBotLanguageModel } from '../../provider.js';
import { runSelectionSuggest } from '../sessionWorkspace/selectionSuggest.js';
import {
  findCatalogModel,
  loadCachedModelsForBase,
  resolveContextWindow
} from '../../modelCatalog.js';
import { loadLlmSettings } from '../../llm.js';
import { assertByokForProvider } from '../../byokGate.js';
import { createListenRuntime } from '../sessionWorkspace/listenRuntime.js';
import {
  getDurableSkillStore,
  hydrateDurableSkillsFromChrome,
  importSkillFromUrl,
  mergeSkillCatalog,
  mergeSkillRecord,
  normalizeDurableSkill,
  sanitizeSkillId
} from '../sessionWorkspace/skillStore.js';
import { getSkill, listPackagedSkillCatalog } from '../skills/registry.js';
import { answerClarify, abortSessionClarifies } from '../sessionWorkspace/clarifyGate.js';
import { abortExecutionApprovals } from '../sessionWorkspace/approvalGate.js';
import { callBrowserSys } from '../host/sysClient.js';
import { gatedDispatch, hostAnswerApproval, hostGetPendingApproval } from '../host/operationGate.js';
import { createCallJournal, createMemoryCallJournal, createUnavailableCallJournal, openCallJournal, slimJournalAudit } from '../host/callJournal.js';
import { readEffectiveAccessPolicy } from '../host/accessPolicy.js';
import { createMemoryTicketStorage, installDispatchTicketStorage, dispatchTicketStorageInstalled, putDispatchTicket, dropTicketsForExecution, dropDispatchTicket, listDispatchTickets } from '../host/dispatchTicket.js';
import { hashOperationPayload } from '../host/payloadHash.js';
import { resolveUploadSource, hashUploadBytes } from '../sessionWorkspace/uploadSource.js';
import {
  UPLOAD_BYTES_MAX,
  buildPageActionTransport,
  dispatchStagedUpload
} from '../host/uploadChannel.js';
import { clampWaitTimeout } from '../sessionWorkspace/browserSys.js';
import { classifyCachedMutation } from '../host/pageActionHost.js';
import { applyVerifyToJournalState, verifyPostconditions } from '../host/postcondition.js';
import { createUserStopError, isAbortLike } from '../host/userStop.js';
import {
  allocateLabelN,
  ensureItemLabel,
  formatItemLabel,
  itemHandle,
  normalizeLabelKind
} from '../sessionWorkspace/itemLabel.js';
import { blankArtifactPayload } from '../sessionWorkspace/blankCreate.js';
import { normalizeSessionTitle } from '../sessionWorkspace/taskTitle.js';
import { addPageItems, formatPageAddSummary, isPageItem } from '../sessionWorkspace/pageItems.js';
import {
  claimTask,
  cloneTaskValue,
  deleteTasksForSession,
  dueTasks,
  getTask as readTask,
  hostTaskMutation,
  listTasks as readTasks,
  nextTaskWakeAt,
  recoverInterruptedTasks,
  settleTaskAfterTurn,
  updateTaskControl
} from '../sessionWorkspace/tasks.js';
import { clearActiveTaskId, getActiveTaskId, setActiveTaskId } from '../sessionWorkspace/taskContract.js';
import { appendSessionAudit, readSessionAudit } from '../sessionWorkspace/sessionAudit.js';
import { persistableCapabilityHint } from '../sessionWorkspace/artifactCapability.js';
import { ARTIFACT_CHUNK_SIZE, DOWNLOAD_INLINE_MAX } from '../sessionWorkspace/artifactDownload.js';
import { openPersonalLibraryStore } from '../sessionWorkspace/personalLibraryStore.js';
import { runPersonalLibraryTool } from './personalLibraryRunner.js';
import { libraryError, validatePersonalLibraryDefinition, validatePersonalLibraryInput, personalLibraryManifestPatch, requireLibraryRevision } from './personalLibraryContract.js';
import {
  PERSONAL_LIBRARY_DRAFT_PATH,
  personalLibraryCreationInstructions,
  personalLibraryWorkflowRunContent
} from './personalLibraryCreationInstructions.js';

export class SessionWorkspaceService {
  /**
   * @param {{ store?: SessionWorkspaceStore|DurableSessionWorkspaceStore, callModel?: Function, model?: any }} [opts]
   */
  constructor(opts = {}) {
    const store = opts.store || new SessionWorkspaceStore();
    this.runtime = createSessionWorkspaceRuntime(store);
    this.callModel = opts.callModel || null;
    /** @type {any} AI SDK LanguageModel for ToolLoopAgent */
    this.model = opts.model || null;
    this.activeGroupId = null;
    this.storeKind = store.kind || 'memory';
    /** @type {Map<string, { controller: AbortController, executionId: string|null, sessionId: string, finished?: Promise<void> }>} */
    this._activeBySession = new Map();
    /** @type {Map<string, { tabId: number, rev: string, frames: object[], controls: object[] }>} */
    this._actionSnapCache = new Map();
    /** @type {Map<string, AbortController>} */
    this._activeByExecution = new Map();
    this._taskMutationQueue = Promise.resolve();
    this._taskLaunching = new Set();
    this._resolveTaskPage = typeof opts.resolveTaskPage === 'function' ? opts.resolveTaskPage : null;
    this._peekTabLeaseFn = typeof opts.peekTabLease === 'function' ? opts.peekTabLease : null;
    this._releaseTabLeasesFn = typeof opts.releaseTabLeases === 'function' ? opts.releaseTabLeases : null;
    this._journal = opts.journal
      || (opts.memoryJournal === true ? createCallJournal(createMemoryCallJournal()) : createUnavailableCallJournal());
    this._listenRuntime = opts.listenRuntime || createListenRuntime();
    this.mediaChecks = opts.mediaChecks || new MediaCapabilityChecks();
    this.contextWindowChecks = opts.contextWindowChecks || new ContextWindowChecks();
    // Deliberately lazy: ordinary workspace tests and boot do not require IDB.
    this._personalLibraryStore = opts.personalLibraryStore || null;
    this._personalLibraryStoreOptions = opts.personalLibraryStoreOptions || null;
    this._personalLibraryRunner = opts.personalLibraryRunner || runPersonalLibraryTool;
    this._workflowHost = opts.workflowHost || null;
    this._workflows = new WorkflowService(this);
    this._ensurePolicyAdapters();
    const recovered = recoverInterruptedTasks(store);
    this._startupPersist = recovered.length ? this._persist() : Promise.resolve();
  }

  /**
   * Product factory — opens durable store. LanguageModel is resolved per turn
   * so configuring API after extension load takes effect (do not freeze null model at boot).
   * @param {{ store?: any, callModel?: Function, model?: any, dbName?: string }} [opts]
   */
  static async create(opts = {}) {
    const store =
      opts.store ||
      (await createDurableSessionWorkspaceStore({
        dbName: opts.dbName || WORKSPACE_DB_NAME
      }));
    // Optional eager model for tests; product always re-resolves in sendMessage
    let model = opts.model || null;
    if (!model && !opts.callModel) {
      try {
        const built = await createBrowserBotLanguageModel();
        model = built.model;
      } catch (e) {
        // Boot without key is OK — user may configure later; sendMessage re-tries
        if (e?.code !== 'NO_API_KEY') {
          console.warn('[SessionWorkspaceService] LanguageModel at create:', e?.message || e);
        }
      }
    }
    await hydrateDurableSkillsFromChrome();
    let journal = opts.journal;
    if (!journal) {
      try {
        journal = await openCallJournal({ memory: opts.memoryJournal === true, indexedDB: opts.indexedDB });
      } catch (error) {
        if (opts.memoryJournal === true) {
          journal = createCallJournal(createMemoryCallJournal());
        } else {
          journal = createUnavailableCallJournal();
          console.warn('[SessionWorkspaceService] Call journal unavailable; mutating dispatch is fail-closed.', error?.message || error);
        }
      }
    }
    const service = new SessionWorkspaceService({ ...opts, store, model, callModel: opts.callModel || null, journal });
    await service._startupPersist;
    try {
      await service._journal.recoverOnStartup({
        isExecutionActive: (sid, eid) => {
          const slot = service._activeBySession.get(sid);
          return !!(slot && slot.executionId === eid && !slot.controller.signal.aborted);
        },
        dropTicket: (operationId) => service._dropTicket(operationId),
        listTickets: () => service._listTickets()
      });
    } catch {
      /* journal recover must not block boot */
    }
    return service;
  }

  /**
   * Build LanguageModel from latest chrome.storage provider settings.
   * Called every product sendMessage so post-boot API key changes apply.
   * @returns {Promise<any>}
   */
  /**
   * @param {{ reasoning?: { enabled?: boolean, effort?: string } }} [opts]
   */
  async getChatMediaStatus() {
    return this.mediaChecks.status();
  }

  async requestChatMediaCheck(params = {}) {
    return this.mediaChecks.request({ force: params.force === true });
  }

  async getContextWindowStatus() {
    return this.contextWindowChecks.status();
  }

  async requestContextWindowCheck(params = {}) {
    return this.contextWindowChecks.request({ force: params.force === true });
  }

  async resolveLanguageModel(opts = {}) {
    // Every chat model call (turn, compaction, titles, /learn, selection chips) comes
    // from here: own keys need a paid Browser Kitten plan; credit records pass.
    const settings = opts.settings || await loadLlmSettings();
    if (settings.apiKey) await assertByokForProvider('chat', settings.providerId);
    try {
      const built = await createBrowserBotLanguageModel({
        reasoning: opts.reasoning || null,
        settings,
        mediaCapabilities: opts.mediaCapabilities,
        mediaContext: opts.mediaContext
      });
      this.model = built.model;
      return built.model;
    } catch (e) {
      this.model = null;
      if (e?.code === 'NO_API_KEY') {
        const err = new Error(
          'NO_API_KEY: 请先在设置中配置 API Key 与模型，然后重新发送。'
        );
        err.code = 'NO_API_KEY';
        throw err;
      }
      const err = new Error(
        `LanguageModel unavailable: ${e instanceof Error ? e.message : String(e)}`
      );
      err.cause = e;
      throw err;
    }
  }

  async _persist() {
    const store = this.runtime.store;
    if (store && typeof store.flush === 'function') {
      await store.flush();
    }
  }

  async _ready() {
    await this._startupPersist;
  }

  async _library() {
    if (this._personalLibraryStore) return this._personalLibraryStore;
    if (!this._personalLibraryOpening) {
      this._personalLibraryOpening = openPersonalLibraryStore(this._personalLibraryStoreOptions || {})
        .then(store => (this._personalLibraryStore = store))
        .finally(() => { this._personalLibraryOpening = null; });
    }
    return this._personalLibraryOpening;
  }

  async createWorkflowDraft(params = {}) { await this._ready(); return this._workflows.createDraft(params); }
  async updateWorkflowDraft(params = {}) { await this._ready(); return this._workflows.updateDraft(params); }
  async startWorkflowRun(params = {}) { await this._ready(); return this._workflows.start(params); }
  async getWorkflowRun(params = {}) { await this._ready(); return this._workflows.get(params); }
  async listWorkflowRuns(params = {}) { await this._ready(); return this._workflows.list(params); }
  async resumeWorkflowRun(params = {}) { await this._ready(); return this._workflows.resume(params); }
  async pauseWorkflowRun(params = {}) { await this._ready(); return this._workflows.pause(params); }
  async validateWorkflowTarget(params = {}) { await this._ready(); return this._workflows.validateTarget(params); }
  async startWorkflowRecording(params = {}) { await this._ready(); return this._workflows.startRecording(params); }
  async controlWorkflowRecording(params = {}) { await this._ready(); return this._workflows.controlRecording(params); }
  async getWorkflowRecording(params = {}) { await this._ready(); return this._workflows.recording(params); }
  async interruptWorkflowRecording(params = {}) { await this._ready(); return this._workflows.interruptRecording(params); }
  async ingestWorkflowRecordingEvent(params = {}) { await this._ready(); return this._workflows.ingest(params); }
  async listWorkflowTabs() { return this._workflows.host('tabs'); }
  async importWorkflowTable(params = {}) { await this._ready(); return this._workflows.importTable(params); }
  async exportWorkflowTable(params = {}) { await this._ready(); return this._workflows.exportTable(params); }
  async getWorkflowSchedule() { await this._ready(); return this._workflows.getSchedule(); }
  async runDueWorkflows(params = {}) { await this._ready(); return this._workflows.runDue(params); }

  async listPersonalLibrary({ kind } = {}) { return (await this._library()).list({ kind }); }
  async getPersonalLibraryEntry({ entryId, revision } = {}) { return (await this._library()).get({ entryId, revision }); }
  async listPersonalLibraryRevisions({ entryId } = {}) {
    return { revisions: await (await this._library()).listRevisions({ entryId }) };
  }

  async getPersonalLibraryDraft({ draftId } = {}) {
    if (!draftId) throw libraryError('LIBRARY_BAD_INPUT', 'draftId is required.');
    const draft = await (await this._library()).getDraft({ draftId });
    if (!draft) throw libraryError('LIBRARY_NOT_FOUND', 'Draft not found.');
    return { draft, sessionId: draft.sessionId || null };
  }

  async getPersonalLibraryDraftBySession({ sessionId } = {}) {
    if (!sessionId) return { draft: null, sessionId: null };
    const drafts = await (await this._library()).listDrafts({ sessionId: String(sessionId) });
    return { draft: drafts[0] || null, sessionId: String(sessionId) };
  }

  async startLibraryCreation({ kind, entryId, lang } = {}) {
    await this._ready();
    const library = await this._library();
    const existing = entryId ? await library.get({ entryId }) : null;
    if (entryId && !existing) throw libraryError('LIBRARY_NOT_FOUND', 'Library entry not found.');
    const normalizedKind = existing?.kind || kind;
    if (!['tool', 'workflow'].includes(normalizedKind)) throw libraryError('LIBRARY_BAD_INPUT', 'kind must be tool or workflow.');
    const english = String(lang || '').startsWith('en');
    const title = existing ? (english ? `Edit ${existing.name}` : `修改 ${existing.name}`)
      : (english ? `Create ${normalizedKind}` : `创建${normalizedKind === 'tool' ? '工具' : 'Workflow'}`);
    const session = this.runtime.createSession({ title });
    const draft = await library.createDraft(existing
      ? { sessionId: session.sessionId, baseEntryId: existing.entryId, baseRevision: existing.revision }
      : { sessionId: session.sessionId, kind: normalizedKind, parameters: {} });
    this.runtime.store.put('sessions', session.sessionId, {
      ...session,
      personalLibraryInstructions: personalLibraryCreationInstructions({ kind: normalizedKind, draftId: draft.draftId, entry: existing })
    });
    if (existing) {
      const { kind, name, description, parameters, runtimeVersion, code, instructions, workflow } = existing;
      const manifest = { draftId: draft.draftId, kind, name, description, parameters, runtimeVersion,
        ...(kind === 'tool' ? { code } : workflow ? { workflow } : { instructions }) };
      createSessionGuestFs(this.runtime.store, { sessionId: session.sessionId }).writeFile(
        PERSONAL_LIBRARY_DRAFT_PATH, JSON.stringify(manifest, null, 2), { mimeType: 'application/json' });
    }
    await this._persist();
    const content = existing
      ? (english ? `I want to update ${existing.name}. Please help me refine it.` : `我想修改“${existing.name}”，请先帮我梳理需求。`)
      : (english ? `I want to create a ${normalizedKind}. Please help me define it.` : `我想创建一个${normalizedKind === 'tool' ? '工具' : '工作流'}，请先和我确认需求。`);
    this._broadcastUiEvent({ type: 'personal-library-draft', sessionId: session.sessionId, draft });
    return { sessionId: session.sessionId, draftId: draft.draftId, draft, content, title };
  }

  async refreshLibraryDraft({ draftId } = {}) {
    await this._ready();
    const { draft, sessionId } = await this.getPersonalLibraryDraft({ draftId });
    if (!this.runtime.store.has('sessions', sessionId)) throw libraryError('LIBRARY_NOT_FOUND', 'The creation conversation was deleted.');
    if (this._activeBySession.has(sessionId)) throw libraryError('SESSION_BUSY', 'Wait for the current execution before reviewing the draft.');
    await this.runtime.store.hydrateSessionBlobs?.(sessionId);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId });
    if (!fs.exists(PERSONAL_LIBRARY_DRAFT_PATH)) throw libraryError('LIBRARY_DRAFT_NOT_READY', 'The agent has not written a draft yet.');
    const bytes = fs.readFileBytes(PERSONAL_LIBRARY_DRAFT_PATH);
    if (bytes.byteLength > 1024 * 1024) throw libraryError('LIBRARY_BAD_DRAFT', 'Draft is too large.');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw libraryError('LIBRARY_BAD_DRAFT', 'Draft must be valid JSON.'); }
    const patch = personalLibraryManifestPatch(manifest, draft);
    const changed = Object.entries(patch).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(draft[key]));
    const saved = changed ? await (await this._library()).updateDraft({ draftId, patch, expectedRevision: draft.revision }) : draft;
    this._broadcastUiEvent({ type: 'personal-library-draft', sessionId, draft: saved });
    return { draft: saved, validation: { ok: true } };
  }

  async publishLibraryDraft({ draftId, expectedRevision } = {}) {
    const { draft } = await this.getPersonalLibraryDraft({ draftId });
    requireLibraryRevision(expectedRevision, draft.revision);
    if (!this.runtime.store.has('sessions', draft.sessionId)) throw libraryError('LIBRARY_NOT_FOUND', 'The creation conversation was deleted.');
    validatePersonalLibraryDefinition(draft);
    // Publish only the reviewed snapshot, never an unreviewed newer file.
    const entry = await (await this._library()).publishDraft({ draftId, expectedRevision });
    this._broadcastUiEvent({ type: 'personal-library-published', sessionId: draft.sessionId, draftId, entry });
    return entry;
  }

  async deletePersonalLibraryEntry(params = {}) { return (await this._library()).deleteEntry(params); }
  async revertPersonalLibraryRevision(params = {}) { return (await this._library()).revertRevision(params); }
  async exportPersonalLibrary() { return (await this._library()).exportBundle(); }
  async importPersonalLibrary({ bundle, conflict } = {}) { return (await this._library()).importBundle(bundle, { conflict }); }

  async _prepareLibraryWorkflow(entry, { input = {}, activeTab = null, lang } = {}) {
    await this._ready();
    validatePersonalLibraryDefinition(entry);
    if (entry.workflow) throw libraryError('WORKFLOW_INVALID', 'Use the deterministic workflow runner for automations.');
    const parameters = validatePersonalLibraryInput(entry.parameters, input);
    const english = String(lang || '').startsWith('en');
    const title = english ? `Run ${entry.name}` : `运行 ${entry.name}`;
    const session = this.runtime.createSession({ title });
    this.runtime.store.put('sessions', session.sessionId, {
      ...session, personalLibraryInstructions: personalLibraryWorkflowRunContent(entry, parameters)
    });
    await this._persist();
    return { kind: 'workflow', sessionId: session.sessionId, entryId: entry.entryId, revision: entry.revision,
      activeTab, title, content: english ? `Run ${entry.name}.` : `运行“${entry.name}”。` };
  }

  async startLibraryWorkflow({ entryId, ...options } = {}) {
    const entry = await this.getPersonalLibraryEntry({ entryId });
    if (!entry || entry.kind !== 'workflow') throw libraryError('LIBRARY_NOT_FOUND', 'Workflow not found.');
    return this._prepareLibraryWorkflow(entry, options);
  }

  async runLibraryDraft({ draftId, expectedRevision, ...options } = {}) {
    const { draft, sessionId } = await this.getPersonalLibraryDraft({ draftId });
    requireLibraryRevision(expectedRevision, draft.revision);
    validatePersonalLibraryDefinition(draft);
    if (!this.runtime.store.has('sessions', sessionId)) throw libraryError('LIBRARY_NOT_FOUND', 'The creation conversation was deleted.');
    if (draft.workflow) return this.startWorkflowRun({ draftId, expectedRevision, ...options });
    if (draft.kind === 'workflow') return this._prepareLibraryWorkflow(draft, options);
    return this._runLibraryTool(draft, { ...options, sessionId, testDraftId: draftId });
  }

  async runPersonalLibraryTool({ entryId, ...options } = {}) {
    const entry = await this.getPersonalLibraryEntry({ entryId });
    if (!entry || entry.kind !== 'tool') throw libraryError('LIBRARY_NOT_FOUND', 'Tool not found.');
    return this._runLibraryTool(entry, options);
  }

  async _runLibraryTool(entry, { input = {}, activeTab = null, sessionId = 'default', testDraftId } = {}) {
    await this._ready();
    validatePersonalLibraryDefinition(entry);
    const parameters = validatePersonalLibraryInput(entry.parameters, input);
    this.ensureSession(sessionId);
    // No await between checking and reserving: competing runs cannot both start.
    if (this._activeBySession.has(sessionId)) throw libraryError('SESSION_BUSY', 'This session already has an active execution.');
    const controller = new AbortController();
    let settleSlot;
    const finished = new Promise(resolve => { settleSlot = resolve; });
    const execution = this.runtime.beginExecution(sessionId, { abortSignal: controller.signal });
    this._activeBySession.set(sessionId, { controller, executionId: execution.executionId, sessionId, finished });
    this._activeByExecution.set(execution.executionId, controller);
    this._broadcastUiEvent({ type: 'execution-start', sessionId, executionId: execution.executionId, executionKind: 'personal-tool', libraryEntryId: entry.entryId });
    let status = 'failed';
    let fs;
    try {
      await this.runtime.store.hydrateSessionBlobs?.(sessionId);
      controller.signal.throwIfAborted();
      fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: execution.executionId });
      const output = await this._personalLibraryRunner(entry, {
        store: this.runtime.store, fs, sessionId, controller, activeTab,
        hostSys: (op, params, context) => this._gatedSys(op, {
          ...(params && typeof params === 'object' ? params : {}),
          defaultTabId: params?.defaultTabId ?? params?.tabId ?? activeTab?.tabId ?? activeTab?.id
        }, context, sessionId, controller.signal), input: parameters
      });
      status = controller.signal.aborted ? 'aborted' : output.ok ? 'settled' : 'failed';
      if (testDraftId) fs.writeFile('/artifacts/library-test-result.json', JSON.stringify({
        draftId: testDraftId, revision: entry.revision, at: Date.now(), status, ...output
      }, null, 2), { mimeType: 'application/json' });
      if (output.artifacts?.length) this._broadcastUiEvent({ type: 'artifact_shelf_updated', sessionId });
      return { ...output, ok: status === 'settled', sessionId, executionId: execution.executionId, entryId: entry.entryId, revision: entry.revision };
    } catch (error) {
      status = controller.signal.aborted ? 'aborted' : 'failed';
      if (testDraftId && fs) fs.writeFile('/artifacts/library-test-result.json', JSON.stringify({
        draftId: testDraftId, revision: entry.revision, at: Date.now(), status, error: error?.message || String(error)
      }), { mimeType: 'application/json' });
      throw error;
    } finally {
      // Revoke dispatch before releasing ownership; status is captured first.
      controller.abort();
      try {
        await Promise.allSettled([
          this._releaseTabLeases(sessionId, execution.executionId),
          this._cleanupExecutionPolicy(sessionId, execution.executionId)
        ]);
        this.runtime.settleExecution(execution, status);
        try { await this._persist(); }
        catch (error) {
          status = 'failed';
          this.runtime.settleExecution(execution, status);
          throw error;
        }
      } finally {
        this._activeByExecution.delete(execution.executionId);
        if (this._activeBySession.get(sessionId)?.controller === controller) this._activeBySession.delete(sessionId);
        settleSlot();
        this._broadcastUiEvent({ type: 'execution-end', sessionId, executionId: execution.executionId, status, executionKind: 'personal-tool', libraryEntryId: entry.entryId });
      }
    }
  }

  _withTaskLock(fn) {
    const run = this._taskMutationQueue.catch(() => {}).then(fn);
    this._taskMutationQueue = run.catch(() => {});
    return run;
  }

  _taskMetaSnapshot() {
    const rows = [];
    for (const key of this.runtime.store.keys('meta')) {
      if (!String(key).startsWith('task:')) continue;
      rows.push([key, cloneTaskValue(this.runtime.store.get('meta', key))]);
    }
    return rows;
  }

  async _commitTaskMutation(mutator, { broadcast = true } = {}) {
    return this._withTaskLock(async () => {
      await this._ready();
      const before = this._taskMetaSnapshot();
      let result;
      try {
        result = await mutator();
        await this._persist();
      } catch (error) {
        for (const key of this.runtime.store.keys('meta')) {
          if (String(key).startsWith('task:')) this.runtime.store.delete('meta', key);
        }
        for (const [key, value] of before) this.runtime.store.put('meta', key, value);
        throw error;
      }
      const task = result?.task || (result?.taskId ? result : null);
      if (broadcast && task) this._broadcastTaskChanged(task);
      return result;
    });
  }

  _broadcastTaskChanged(task) {
    this._broadcastUiEvent({ type: 'task-updated', sessionId: task.sessionId, task });
    this._broadcastUiEvent({
      type: 'task-schedule-changed',
      sessionId: task.sessionId,
      taskId: task.taskId,
      nextWakeAt: nextTaskWakeAt(this.runtime.store)
    });
  }

  async _releaseClaimFailure(task, error) {
    const code = error?.code;
    this._broadcastUiEvent({
      type: 'error',
      sessionId: task?.sessionId,
      name: 'Error',
      message: error?.message || 'Task is not available for this turn.',
      code: code || 'TASK_CLAIM_FAILED'
    });
    if (!task?.taskId) return null;
    // BUSY/TERMINAL: this turn must not run the task. Do not mark failed,
    // and do not steal a live owner or rewrite a finished record.
    if (code === 'TASK_BUSY' || code === 'TASK_TERMINAL') {
      const current = readTask(this.runtime.store, task.taskId);
      if (current) this._broadcastTaskChanged(current);
      return current;
    }
    try {
      return await this._commitTaskMutation(() =>
        updateTaskControl(this.runtime.store, task.taskId, 'pause')
      );
    } catch {
      return readTask(this.runtime.store, task.taskId);
    }
  }

  /**
   * Offscreen → Sidepanel live events (thinking / tokens). Fire-and-forget:
   * chrome.storage is unavailable here; chrome.runtime messaging is the bridge.
   */
  _snapshotActiveExecution(sessionId) {
    const sid = String(sessionId || '');
    const slot = sid ? this._activeBySession.get(sid) : null;
    if (!slot) return null;
    return {
      sessionId: sid,
      executionId: slot.executionId || null,
      status: 'running'
    };
  }

  async _awaitSessionIdle(sessionId, ms = 8000) {
    const slot = this._activeBySession.get(sessionId);
    if (!slot?.finished) return;
    let timer = 0;
    try {
      await Promise.race([
        slot.finished,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('idle-timeout')), ms);
        })
      ]);
    } catch {
      /* aborted turn or timeout — caller still deletes */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _broadcastUiEvent(event) {
    try {
      const sid = event?.sessionId;
      if (
        sid &&
        !this.runtime.store.has('sessions', sid) &&
        !this._activeBySession.has(sid)
      ) {
        return;
      }
      if (sid && this.runtime?.store) {
        try {
          const row = appendSessionAudit(this.runtime.store, sid, event);
          if (row && row.type !== 'execution-start') {
            void this._persist().catch(() => { /* audit is best-effort; operation commits are awaited separately */ });
          }
        } catch {
          /* audit must not fail the turn */
        }
      }
      if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
        return;
      }
      const payload = {
        action: 'session_workspace_event',
        event: stripWorkspaceUiEvent(event)
      };
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* no UI listener (tests / SW-only) */
    }
  }

  ensureSession(sessionId = 'default') {
    const s = this.runtime.ensureSession(sessionId);
    this.activeGroupId = readActiveCaptureGroupId(this.runtime.store);
    return s;
  }

  _ensurePolicyAdapters() {
    const hasSession = typeof chrome !== 'undefined' && !!chrome.storage?.session;
    const hasLocal = typeof chrome !== 'undefined' && !!chrome.storage?.local;
    if (hasSession && hasLocal) return;
    if (dispatchTicketStorageInstalled()) return;
    installDispatchTicketStorage(createMemoryTicketStorage());
  }

  async _readPolicy() {
    return readEffectiveAccessPolicy();
  }

  async _putTicket(ticket) {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      return putDispatchTicket(ticket);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const res = await chrome.runtime.sendMessage({
        target: MSG_TARGET_BACKGROUND,
        action: 'workspace_ticket_put',
        ticket
      });
      if (!res?.ok) {
        throw Object.assign(new Error(res?.error || 'ticket put failed'), { code: res?.code || 'TICKET_REQUIRED' });
      }
      return res.ticket;
    }
    return putDispatchTicket(ticket);
  }

  async _dropTicket(operationId) {
    const id = String(operationId || '');
    if (!id) return false;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        return dropDispatchTicket(id);
      }
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        await chrome.runtime.sendMessage({
          target: MSG_TARGET_BACKGROUND,
          action: 'workspace_ticket_drop',
          operationId: id
        });
        return true;
      }
      return dropDispatchTicket(id);
    } catch {
      return false;
    }
  }

  async _dropTickets(sessionId, executionId) {
    const sid = String(sessionId || '');
    const eid = String(executionId || '');
    if (!sid || !eid) return 0;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        return dropTicketsForExecution(sid, eid);
      }
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await chrome.runtime.sendMessage({
          target: MSG_TARGET_BACKGROUND,
          action: 'workspace_ticket_drop',
          sessionId: sid,
          executionId: eid
        });
        return Number(res?.result) || 0;
      }
      return dropTicketsForExecution(sid, eid);
    } catch {
      return 0;
    }
  }

  async _listTickets() {
    try {
      return await listDispatchTickets();
    } catch {
      return [];
    }
  }

  async _cleanupExecutionPolicy(sessionId, executionId) {
    const sid = String(sessionId || '');
    const eid = String(executionId || '');
    abortExecutionApprovals(sid, eid);
    await this._dropTickets(sid, eid);
    if (!this._journal || this._journal.kind === 'unavailable') return;
    try {
      const rows = await this._journal.listBySession(sid);
      for (const row of rows) {
        if (eid && String(row.executionId || '') !== eid) continue;
        if (row.state === 'awaiting_approval') {
          await this._journal.update(row.operationId, {
            state: 'failed',
            outcome: 'denied',
            error: { code: 'APPROVAL_EXPIRED', message: 'Execution ended before approval.' }
          });
        } else if (row.state === 'authorized') {
          await this._journal.update(row.operationId, {
            state: 'failed',
            outcome: 'unknown',
            error: { code: 'SYS_OUTCOME_UNKNOWN', message: 'Execution ended after authorize before confirmed dispatch.' }
          });
          await this._dropTicket(row.operationId);
        }
      }
    } catch {
      /* cleanup must not block abort */
    }
  }

  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const err = new Error('Execution aborted.');
      err.code = 'SYS_ABORTED';
      throw err;
    }
  }

  async _pageAction(message, signal) {
    this._throwIfAborted(signal);
    const out = await chrome.runtime.sendMessage({
      target: MSG_TARGET_BACKGROUND,
      action: 'workspace_page_action',
      ...message
    });
    this._throwIfAborted(signal);
    this._rememberActionSnapshot(message?.sessionId, out);
    return out;
  }

  _rememberActionSnapshot(sessionId, out) {
    const sid = String(sessionId || '');
    if (!sid || !out || out.ok === false || !out.rev || !Array.isArray(out.controls)) return;
    this._actionSnapCache.set(sid, {
      tabId: Number(out.tabId),
      rev: String(out.rev),
      frames: Array.isArray(out.frames) ? out.frames : [],
      controls: out.controls
    });
  }

  async _resolveActionIntent(payload, sessionId, executionId, signal) {
    const op = String(payload?.op || '');
    const MUTATIONS = new Set(['click', 'fill', 'fill_form', 'select', 'press', 'scroll', 'upload', 'pointer']);
    if (!MUTATIONS.has(op)) return { ok: true, skipped: true };
    this._throwIfAborted(signal);
    let rev = payload.rev;
    let snap = null;
    if (!rev) {
      snap = await this._pageAction(buildPageActionTransport(payload, {
        op: 'snapshot',
        sessionId,
        executionId,
        tabId: payload.tabId
      }), signal);
      if (!snap?.ok) return snap;
      rev = snap.rev;
    }
    const cached = this._actionSnapCache.get(sessionId);
    if (rev && cached && cached.rev === String(rev) && Number(cached.tabId) === Number(payload.tabId)) {
      const local = await classifyCachedMutation({ ...payload, targetOp: op, rev, tabId: payload.tabId }, cached);
      if (local && local.ok !== false) return { ...local, rev };
    }
    this._throwIfAborted(signal);
    const resolved = await this._pageAction(buildPageActionTransport(payload, {
      op: 'resolve_intent',
      targetOp: op,
      rev,
      sessionId,
      executionId,
      tabId: payload.tabId
    }), signal);
    this._throwIfAborted(signal);
    if (!resolved?.ok) return resolved;
    return { ...resolved, rev };
  }

  _verifyActionFacts(out, req) {
    return {
      url: out?.after?.url || out?.url || '',
      text: out?.after?.text || out?.text || '',
      controls: Array.isArray(out?.controls) ? out.controls : [],
      snapshotOk: !out?.observationError && Array.isArray(out?.controls),
      status: out?.status ?? out?.result?.status,
      revision: out?.revision ?? out?.artifact?.revision,
      sha256: out?.sha256,
      download: out?.download || out?.result?.download
    };
  }

  async _verifySysFacts(out, req) {
    const facts = {
      status: out?.status ?? out?.result?.status,
      bodyHash: out?.bodyHash || out?.result?.bodyHash,
      url: out?.url || req.url,
      snapshotOk: false
    };
    if (req.op === 'upload') {
      facts.filesCount = out?.result?.filesCount ?? out?.filesCount;
      facts.siteAccepted = 'unknown';
    }
    if (req.op === 'download') {
      const downloadId = out?.result?.downloadId ?? out?.downloadId;
      if (downloadId && typeof chrome !== 'undefined' && chrome.downloads?.search) {
        try {
          const [item] = await chrome.downloads.search({ id: downloadId });
          facts.download = item
            ? { state: item.state, bytes: item.fileSize, hash: item.etag || item.finalUrl || '' }
            : null;
        } catch {
          facts.download = downloadId ? { state: 'in_progress' } : null;
        }
      } else if (downloadId) {
        facts.download = { state: 'in_progress' };
      }
    }
    return facts;
  }

  async _resolveUploadDocument(params = {}, sessionId, signal) {
    const tabId = params.tabId ?? params.defaultTabId;
    let documentId = params.documentId || '';
    let frameUrl = params.url || params.expectedUrl || params.frameUrl || '';
    if (documentId && frameUrl) return { documentId, frameUrl, tabId };
    if (!tabId) return { documentId, frameUrl, tabId };
    try {
      const framesOut = await callBrowserSys({
        sessionId,
        executionId: this._activeBySession.get(sessionId)?.executionId,
        signal,
        op: 'tabs.frames',
        params: { tabId, defaultTabId: tabId }
      });
      const list = framesOut?.result || framesOut;
      const rows = Array.isArray(list) ? list : [];
      const frame = rows.find((row) => Number(row.frameId) === Number(params.frameId ?? 0)) || rows[0];
      if (frame) {
        documentId = documentId || frame.documentId || '';
        frameUrl = frameUrl || frame.url || '';
      }
    } catch {
      /* documentId stays optional; SW will resolve again */
    }
    return { documentId, frameUrl, tabId };
  }

  async _prepareUploadParams(params, sessionId, signal) {
    const executionId = this._activeBySession.get(sessionId)?.executionId;
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId });
    const source = await resolveUploadSource({
      store: this.runtime.store,
      fs,
      sessionId,
      path: params.path,
      itemId: params.itemId,
      artifactId: params.artifactId,
      filename: params.filename,
      mimeType: params.mimeType,
      signal
    });
    if (!source.ok) return source;
    if (source.bytes.byteLength > UPLOAD_BYTES_MAX) {
      return { ok: false, code: 'TOO_LARGE', error: `upload exceeds ${UPLOAD_BYTES_MAX} bytes` };
    }
    const bytesHash = await hashUploadBytes(source.bytes);
    const target = await this._resolveUploadDocument(params, sessionId, signal);
    return {
      ok: true,
      params: {
        ...params,
        path: source.path,
        filename: source.filename,
        mimeType: source.mimeType,
        bytesHash,
        bytes: source.bytes,
        documentId: params.documentId || target.documentId,
        url: params.url || target.frameUrl,
        itemId: source.itemId || params.itemId,
        artifactId: source.artifactId || params.artifactId
      }
    };
  }

  async _gatedPageAction(payload, sessionId, signal) {
    if (payload?.op === 'upload') {
      const prepared = await this._prepareUploadParams(payload, sessionId, signal);
      if (!prepared.ok) return prepared;
      payload = { ...payload, ...prepared.params };
    }
    const executionId = payload?.executionId || this._activeBySession.get(sessionId)?.executionId;
    let resolved;
    try {
      resolved = await this._resolveActionIntent(payload, sessionId, executionId, signal);
    } catch (error) {
      if (error?.code === 'SYS_ABORTED' || signal?.aborted) {
        return { ok: false, code: 'SYS_ABORTED', error: error?.message || 'Execution aborted.', outcome: 'aborted' };
      }
      throw error;
    }
    if (resolved && resolved.ok === false) return resolved;
    if (signal?.aborted) {
      return { ok: false, code: 'SYS_ABORTED', error: 'Execution aborted.', outcome: 'aborted' };
    }
    const classified = resolved?.classified;
    const payloadHash = resolved?.payloadHash;
    const control = resolved?.control;
    return gatedDispatch(
      {
        channel: 'action',
        ...payload,
        sessionId,
        executionId,
        op: payload?.op,
        ref: resolved?.ref || payload?.ref,
        name: resolved?.name || payload?.name,
        url: control?.frameUrl || resolved?.frameUrl || payload?.url,
        frameUrl: control?.frameUrl || resolved?.frameUrl,
        documentId: control?.documentId || resolved?.documentId || payload?.documentId,
        tabId: payload?.tabId,
        batchSize: resolved?.batchSize || resolved?.frames?.length || 0,
        frames: resolved?.frames,
        control,
        classified,
        payloadHash,
        rev: resolved?.rev || payload?.rev,
        expectedText: payload?.expectedText || payload?.postText,
        expectedUrl: payload?.expectedUrl || payload?.postUrl,
        expectAbsent: payload?.expectAbsent || payload?.postAbsent,
        expectVisible: payload?.expectVisible || payload?.postVisible,
        path: payload?.path,
        bytesHash: payload?.bytesHash,
        itemId: payload?.itemId,
        artifactId: payload?.artifactId,
        uploadMethod: payload?.method,
        bytes: payload?.bytes
      },
      {
        journal: this._journal,
        signal,
        broadcast: (ev) => this._broadcastUiEvent(ev),
        putTicket: (ticket) => this._putTicket(ticket),
        dropTicket: (operationId) => this._dropTicket(operationId),
        readPolicy: () => this._readPolicy(),
        verifyFacts: (out, req) => this._verifyActionFacts(out, req),
        send: (req) => {
          const deliver = (body) =>
            this._pageAction({
              ...body,
              sessionId,
              executionId: req.executionId || executionId,
              tabId: req.tabId ?? payload?.tabId,
              documentId: req.documentId || resolved?.documentId,
              url: req.url || resolved?.frameUrl || payload?.url,
              ticketNonce: req.ticketNonce,
              payloadHash: req.payloadHash,
              operationId: req.operationId
            }, signal);
          if (payload?.op === 'upload' && req.bytes) {
            return dispatchStagedUpload(req, {
              sendStage: (msg) =>
                callBrowserSys({
                  sessionId,
                  executionId: req.executionId || executionId,
                  signal,
                  op: 'upload.stage',
                  params: msg.params
                }),
              sendApply: (applyParams) => deliver(applyParams)
            });
          }
          return deliver(req);
        }
      }
    );
  }

  async _gatedSys(op, params, context, sessionId, signal) {
    if (op === 'waitFor') {
      const clock = context?.deadline;
      if (clock && typeof clock.extendToCover === 'function') {
        clock.extendToCover(clampWaitTimeout(params?.timeoutMs) + 2000);
      }
    }
    if (op === 'upload') {
      const prepared = await this._prepareUploadParams(params, sessionId, context?.signal || signal);
      if (!prepared.ok) return prepared;
      params = prepared.params;
    }
    const executionId = this._activeBySession.get(sessionId)?.executionId;
    const deadlineAt = context?.deadline && typeof context.deadline.expiresAt === 'number'
      ? context.deadline.expiresAt
      : context?.deadline;
    return gatedDispatch(
      {
        channel: 'sys',
        operationId: context?.operationId,
        requestId: context?.requestId,
        op,
        sysOp: op,
        sessionId,
        executionId,
        tabId: params?.tabId ?? params?.defaultTabId,
        documentId: params?.documentId,
        url: params?.url,
        frameUrl: params?.frameUrl || params?.url,
        method: op === 'upload' ? undefined : (params?.init?.method || params?.method),
        uploadMethod: op === 'upload' ? params?.method : undefined,
        path: params?.path,
        bytesHash: params?.bytesHash,
        itemId: params?.itemId,
        artifactId: params?.artifactId,
        code: params?.code,
        init: params?.init,
        filename: params?.filename,
        params,
        unprovable: op === 'fetch' && /POST|PUT|PATCH/i.test(String(params?.init?.method || params?.method || '')) && !params?.postUrl
      },
      {
        journal: this._journal,
        signal: context?.signal || signal,
        broadcast: (ev) => this._broadcastUiEvent(ev),
        putTicket: (ticket) => this._putTicket(ticket),
        readPolicy: () => this._readPolicy(),
        verifyFacts: (out, req) => this._verifySysFacts(out, req),
        send: (req) => {
          const apply = (applyParams) =>
            callBrowserSys({
              sessionId,
              executionId,
              signal: context?.signal || signal,
              deadline: deadlineAt,
              op,
              params: {
                ...(applyParams && typeof applyParams === 'object' ? applyParams : {}),
                defaultTabId: applyParams?.defaultTabId ?? applyParams?.tabId
              },
              operationId: req.operationId,
              payloadHash: req.payloadHash,
              ticketNonce: req.ticketNonce
            });
          if (op === 'upload' && params?.bytes) {
            return dispatchStagedUpload(params, {
              sendStage: (msg) =>
                callBrowserSys({
                  sessionId,
                  executionId,
                  signal: context?.signal || signal,
                  deadline: deadlineAt,
                  op: 'upload.stage',
                  params: msg.params
                }),
              sendApply: (applyParams) => apply(applyParams)
            });
          }
          return apply(params);
        }
      }
    );
  }

  /**
   * Capture target is ambient (one picker for all tasks). Bind stays per-session.
   */
  _writeSessionActiveGroup(sessionId, groupId) {
    this.activeGroupId = writeActiveCaptureGroupId(this.runtime.store, groupId);
    const s = this.runtime.store.get('sessions', sessionId);
    if (!s) return;
    if (s.activeGroupId === this.activeGroupId) return;
    this.runtime.store.put('sessions', sessionId, {
      ...s,
      activeGroupId: this.activeGroupId,
      updatedAt: Date.now()
    });
  }

  /** Ambient capture target — same group across tasks. */
  _sessionActiveGroupId(_sessionId) {
    return readActiveCaptureGroupId(this.runtime.store);
  }

  /**
   * Runtime-owned session list (source of truth for conversation metadata).
   */
  async listSessions() {
    const ids = this.runtime.store.keys('sessions');
    return ids.map((id) => {
      const s = this.runtime.store.get('sessions', id);
      const live = this._snapshotActiveExecution(id);
      return {
        sessionId: id,
        title: s?.title || s?.name || id,
        titleLocked: !!s?.titleLocked,
        messageCount: Array.isArray(s?.messages) ? s.messages.length : 0,
        updatedAt: s?.updatedAt || s?.createdAt || 0,
        createdAt: s?.createdAt || 0,
        running: !!live,
        executionId: live?.executionId || null
      };
    });
  }

  async getSession({ sessionId = 'default' } = {}) {
    this.ensureSession(sessionId);
    const s = this.runtime.getSession(sessionId);
    return {
      sessionId,
      title: s?.title || s?.name || sessionId,
      titleLocked: !!s?.titleLocked,
      messages: Array.isArray(s?.messages) ? s.messages : [],
      updatedAt: s?.updatedAt || 0,
      createdAt: s?.createdAt || 0,
      shelf: s?.shelf && typeof s.shelf === 'object' ? s.shelf : null,
      activeExecution: this._snapshotActiveExecution(sessionId),
      activeTaskId: getActiveTaskId(this.runtime.store, sessionId),
      audit: readSessionAudit(this.runtime.store, sessionId)
    };
  }

  /** Sidepanel: is this session's ToolLoopAgent still leased? */
  async getActiveExecution({ sessionId } = {}) {
    return { sessionId: sessionId || '', activeExecution: this._snapshotActiveExecution(sessionId) };
  }

  async listTasks({ sessionId } = {}) {
    await this._ready();
    return {
      tasks: readTasks(this.runtime.store, { sessionId }),
      activeTaskId: sessionId ? getActiveTaskId(this.runtime.store, sessionId) : null
    };
  }

  async getTask({ taskId } = {}) {
    await this._ready();
    const task = readTask(this.runtime.store, taskId);
    if (!task) throw Object.assign(new Error(`Unknown task ${taskId || ''}.`), { code: 'TASK_NOT_FOUND' });
    return { task };
  }

  async updateTask({ taskId, op } = {}) {
    const before = readTask(this.runtime.store, taskId);
    if (!before) throw Object.assign(new Error(`Unknown task ${taskId || ''}.`), { code: 'TASK_NOT_FOUND' });
    const task = await this._commitTaskMutation(() => updateTaskControl(this.runtime.store, taskId, op));
    if ((op === 'pause' || op === 'cancel' || op === 'detach') && before.ownership?.executionId) {
      await this.abortExecution({ sessionId: before.sessionId, executionId: before.ownership.executionId });
    }
    if (op === 'resume') this._launchTask(task);
    return { task, activeTaskId: getActiveTaskId(this.runtime.store, before.sessionId) };
  }

  async getBrowserRuntimeState() {
    await this._ready();
    return { activeExecutions: [...this._activeBySession.values()].map(slot => ({
      sessionId: slot.sessionId, executionId: slot.executionId || null,
      aborted: slot.controller.signal.aborted
    })) };
  }

  async getTaskSchedule() {
    await this._ready();
    const next = nextTaskWakeAt(this.runtime.store);
    return { nextWakeAt: next ? Date.parse(next) : null };
  }

  async runDueTasks({ now = Date.now() } = {}) {
    await this._ready();
    const launched = [];
    const skipped = [];
    for (const task of dueTasks(this.runtime.store, now)) {
      if (this._activeBySession.has(task.sessionId) || this._taskLaunching.has(task.taskId)) {
        skipped.push({ taskId: task.taskId, reason: 'busy' });
        continue;
      }
      const tabId = Number(task.targetPage?.tabId ?? task.targetPage?.id);
      if (Number.isFinite(tabId) && tabId > 0) {
        const lease = await this._peekTabLease(tabId);
        if (this._foreignTabLease(lease, task.sessionId)) {
          skipped.push({
            taskId: task.taskId,
            reason: 'tab_leased',
            tabId,
            holderSessionId: lease.sessionId
          });
          continue;
        }
      }
      this._launchTask(task);
      launched.push(task.taskId);
    }
    return { ok: true, launched, skipped };
  }

  _foreignTabLease(lease, sessionId) {
    const holder = String(lease?.sessionId || '');
    const sid = String(sessionId || '');
    return !!(lease && holder && holder !== sid);
  }

  async _peekTabLease(tabId) {
    if (typeof this._peekTabLeaseFn === 'function') return this._peekTabLeaseFn(tabId);
    if (typeof globalThis.chrome?.runtime?.sendMessage !== 'function') return null;
    const res = await chrome.runtime.sendMessage({
      target: MSG_TARGET_BACKGROUND, action: 'workspace_tab_lease_peek', tabId
    });
    if (!res?.ok) throw Object.assign(new Error(res?.error || 'Cannot verify browser ownership.'), {
      code: res?.code || 'LEASE_STORE_UNAVAILABLE'
    });
    return res.lease || null;
  }

  async _releaseTabLeases(sessionId, executionId) {
    if (!sessionId || !executionId) return;
    try {
      if (typeof this._releaseTabLeasesFn === 'function') {
        await this._releaseTabLeasesFn(sessionId, executionId);
      } else if (typeof globalThis.chrome?.runtime?.sendMessage === 'function') {
        const res = await chrome.runtime.sendMessage({
          target: MSG_TARGET_BACKGROUND, action: 'workspace_tab_lease_release', sessionId, executionId
        });
        if (!res?.ok) throw new Error(res?.error || 'Browser resource release was not acknowledged.');
      }
      this._broadcastUiEvent({
        type: 'lease',
        op: 'release',
        sessionId,
        executionId
      });
    } catch (error) {
      // Retained locks are repaired against active executions on the next SW startup.
      console.warn('[browser] execution cleanup incomplete', error);
    }
  }

  _launchTask(task) {
    if (!task?.taskId || this._taskLaunching.has(task.taskId)) return false;
    this._taskLaunching.add(task.taskId);
    void this._runTask(task).catch(error => console.warn('[tasks] launch failed', error))
      .finally(() => this._taskLaunching.delete(task.taskId));
    return true;
  }

  async _runTask(task) {
    let target = { ok: true, tab: null };
    if (task.targetPage) {
      try {
        target = this._resolveTaskPage
          ? await this._resolveTaskPage(task.targetPage)
          : await chrome.runtime.sendMessage({
              target: MSG_TARGET_BACKGROUND,
              action: 'workspace_task_resolve_page',
              page: task.targetPage
            });
      } catch (error) {
        target = { ok: false, code: 'TASK_TARGET_MISSING', error: error?.message || String(error) };
      }
    }
    if (!target?.ok) {
      await this._commitTaskMutation(() =>
        settleTaskAfterTurn(this.runtime.store, {
          taskId: task.taskId,
          executionId: '',
          error: true,
          aborted: true,
          summary: target.error || 'The saved task page is unavailable.',
          nextAction: 'Open exactly one tab at the saved URL, then resume the task.'
        })
      );
      return;
    }
    if (this._activeBySession.has(task.sessionId)) return;
    const resolvedId = Number(target.tab?.tabId ?? target.tab?.id);
    if (Number.isFinite(resolvedId) && resolvedId > 0) {
      const lease = await this._peekTabLease(resolvedId);
      if (this._foreignTabLease(lease, task.sessionId)) return;
    }
    try {
      await this.sendMessage({
        sessionId: task.sessionId,
        taskId: task.taskId,
        taskRun: true,
        scheduledRun: task.scheduled === true,
        taskContinuation: true,
        activeTab: target.tab
      });
    } catch (error) {
      if (error?.code !== 'SESSION_BUSY') console.warn('[tasks] run failed', error);
    }
  }

  async renameSession({ sessionId = 'default', title, lockTitle = true } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw new Error('renameSession: sessionId required');
    if (!this.runtime.store.has('sessions', sid)) {
      throw new Error(`renameSession: unknown session ${sid}`);
    }
    const s = this.runtime.store.get('sessions', sid);
    if (!s) throw new Error(`renameSession: unknown session ${sid}`);
    const name = normalizeSessionTitle(title);
    if (!name) throw new Error('renameSession: empty title');
    if (!lockTitle && s.titleLocked) {
      return this.getSession({ sessionId: sid });
    }
    this.runtime.store.put('sessions', sid, {
      ...s,
      title: name,
      name,
      titleLocked: lockTitle ? true : !!s.titleLocked,
      updatedAt: Date.now()
    });
    await this._persist();
    return this.getSession({ sessionId: sid });
  }

  /**
   * Prune sessions not in keepIds — cascade delete durable state (no orphans).
   * Used when UI enforces a max session cap.
   */
  async pruneSessions({ keepSessionIds = [] } = {}) {
    const keep = new Set((keepSessionIds || []).map(String));
    const deleted = [];
    for (const id of [...this.runtime.store.keys('sessions')]) {
      if (keep.has(String(id))) continue;
      await this.abortExecution({ sessionId: id });
      await this._awaitSessionIdle(id);
      deleteTasksForSession(this.runtime.store, id);
      abortExecutionApprovals(id);
      try {
        await this._dropTickets(id, this._activeBySession.get(id)?.executionId);
        const leftover = await this._journal.listBySession(id);
        for (const row of leftover) await this._dropTicket(row.operationId);
        await this._journal.deleteSession(id);
      } catch {
        /* ignore */
      }
      this.runtime.deleteSession(id);
      deleted.push(id);
    }
    await this._persist();
    return { deleted, kept: [...keep] };
  }

  /**
   * Product workspace snapshot for Sidepanel selection chrome + bind UI.
   * Default compact=false: returns group items (text/src/…) so selection chips
   * survive refresh. Pass compact=true only for bulk/index RPCs that omit items.
   */
  async getWorkspaceState({ sessionId = 'default', compact = false } = {}) {
    this.ensureSession(sessionId);
    ensureClipboardGroup(this.runtime.store, sessionId);
    let labeledAny = false;
    const boundIds = this.runtime.store.get('sessionBindings', sessionId) || [];
    const groups = this.runtime.store.keys('groups').map((id) => {
      const g = this.runtime.store.get('groups', id);
      if (!g) return null;
      const members = this.runtime.store.get('groupMembers', id) || [];
      /** @type {any[]} */
      let items = [];
      if (!compact) {
        items = members
          .map((mid) => {
            const item = this.runtime.store.get('items', mid);
            if (!item) return null;
            const capture = item.capture || {};
            const source = capture.source || {};
            const preview = capture.preview && typeof capture.preview === 'object'
              ? {
                  tagName: capture.preview.tagName || '',
                  textSnippet: String(capture.preview.textSnippet || '').slice(0, 200),
                  src: capture.preview.src || ''
                }
              : undefined;
            const { item: labeled, assigned } = ensureItemLabel(this.runtime.store, item, {
              groupId: id
            });
            if (assigned) labeledAny = true;
            return {
              webItemId: labeled.webItemId,
              kind: labeled.kindHint,
              kindHint: labeled.kindHint,
              labelKind: labeled.labelKind || '',
              labelN: labeled.labelN || 0,
              handle: labeled.labelN
                ? itemHandle(labeled.labelKind, labeled.labelN)
                : '',
              text: capture.text || preview?.textSnippet || '',
              textRaw: capture.textRaw || '',
              src: capture.src || preview?.src || '',
              href: capture.href || capture.url || '',
              title: capture.title || source.title || '',
              favicon: capture.favicon || source.favicon || '',
              addedBy: source.addedBy || '',
              selector: capture.selector || capture.locator?.css || '',
              tabId: source.tabId ?? capture.tabId,
              url: capture.url || source.url || capture.href || '',
              pageUrl: capture.url || capture.href || source.url || '',
              preview,
              scope: capture.scope || '',
              facets: capture.facets || undefined,
              locatorFingerprint: capture.locatorFingerprint || capture.locator?.fingerprint || undefined,
              locator: capture.locator || undefined,
              source: {
                clipboard: source.clipboard === true,
                tabId: source.tabId ?? capture.tabId,
                frameId: source.frameId ?? capture.frameId ?? 0,
                documentId: source.documentId ?? capture.documentId ?? '',
                url: source.url || capture.url || '',
                origin: source.origin || '',
                pageTitle: source.pageTitle || capture.title || ''
              },
              frameId: source.frameId ?? capture.frameId ?? 0,
              documentId: source.documentId ?? capture.documentId ?? ''
            };
          })
          .filter(Boolean);
      }
      return {
        groupId: g.groupId,
        name: g.name,
        kind: g.kind || (isClipboardGroup(g) ? CLIPBOARD_GROUP_KIND : ''),
        ownerSessionId: g.ownerSessionId || g.sessionId || '',
        itemCount: members.length,
        items
      };
    }).filter((row) => {
      if (!row) return false;
      const raw = this.runtime.store.get('groups', row.groupId);
      return groupVisibleToSession(raw, sessionId, boundIds);
    });
    groups.sort((a, b) => {
      const ac = a.kind === CLIPBOARD_GROUP_KIND ? 0 : 1;
      const bc = b.kind === CLIPBOARD_GROUP_KIND ? 0 : 1;
      return ac - bc;
    });
    const bound = boundIds;
    const artifacts = this.runtime.listArtifacts(sessionId);
    if (labeledAny) await this._persist();
    const sess = this.runtime.store.get('sessions', sessionId) || {};
    return {
      sessionId,
      groups,
      activeGroupId: readActiveCaptureGroupId(this.runtime.store),
      boundGroupIds: bound,
      artifacts,
      artifactCount: artifacts.length,
      storeKind: this.storeKind,
      compact: !!compact,
      visitedPages: Array.isArray(sess.visitedPages) ? sess.visitedPages : [],
      activeExecution: this._snapshotActiveExecution(sessionId),
      pendingApproval: await hostGetPendingApproval(this._journal, sessionId)
    };
  }

  async getPendingApproval({ sessionId = 'default' } = {}) {
    return { pending: await hostGetPendingApproval(this._journal, sessionId) };
  }

  async answerApproval(params = {}) {
    return hostAnswerApproval(this._journal, params);
  }

  async listJournalAnomalies({ sessionId = 'default' } = {}) {
    if (!this._journal || this._journal.kind === 'unavailable') {
      const err = new Error('Call journal is unavailable');
      err.code = 'JOURNAL_UNAVAILABLE';
      throw err;
    }
    const rows = await this._journal.listAnomalies(sessionId, 50);
    return { operations: rows };
  }

  async listJournal({ sessionId = 'default' } = {}) {
    if (!this._journal || this._journal.kind === 'unavailable') {
      const err = new Error('Call journal is unavailable');
      err.code = 'JOURNAL_UNAVAILABLE';
      throw err;
    }
    const operations = await this._journal.listBySession(sessionId);
    return { sessionId, operations };
  }

  async exportJournal({ sessionId = 'default' } = {}) {
    if (!this._journal || this._journal.kind === 'unavailable') {
      const err = new Error('Call journal is unavailable');
      err.code = 'JOURNAL_UNAVAILABLE';
      throw err;
    }
    return this._journal.exportSession(sessionId);
  }

  async allocateLabel({ sessionId = 'default', kind = 'image', groupId } = {}) {
    this.ensureSession(sessionId);
    const k = normalizeLabelKind(kind) || 'image';
    const gid = String(groupId || this._sessionActiveGroupId(sessionId) || '');
    const n = allocateLabelN(this.runtime.store, k, gid);
    await this._persist();
    return {
      kind: k,
      n,
      handle: itemHandle(k, n),
      label: formatItemLabel(k, n, 'zh')
    };
  }

  async bindGroups({ sessionId = 'default', groupIds = [] }) {
    this.ensureSession(sessionId);
    this.runtime.bindGroups(sessionId, groupIds);
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async createGroup({ name, sessionId = 'default', bind = false } = {}) {
    this.ensureSession(sessionId);
    const g = this.runtime.createGroup({ name, sessionId });
    this._writeSessionActiveGroup(sessionId, g.groupId);
    // bind defaults false: selection groups stay ambient until the user binds
    if (bind) {
      const ids = new Set(this.runtime.store.get('sessionBindings', sessionId) || []);
      ids.add(g.groupId);
      this.runtime.bindGroups(sessionId, [...ids]);
    }
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async renameGroup({ groupId, name, sessionId = 'default' }) {
    this.runtime.renameGroup(groupId, name);
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async deleteGroup({ groupId, sessionId = 'default' }) {
    this.runtime.deleteGroup(groupId);
    for (const id of this.runtime.store.keys('sessions')) {
      const s = this.runtime.store.get('sessions', id);
      if (s?.activeGroupId === groupId) {
        this.runtime.store.put('sessions', id, {
          ...s,
          activeGroupId: null,
          updatedAt: Date.now()
        });
      }
    }
    if (this.activeGroupId === groupId) this.activeGroupId = null;
    if (readActiveCaptureGroupId(this.runtime.store) === groupId) {
      writeActiveCaptureGroupId(this.runtime.store, null);
    }
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async setActiveGroup({ groupId, sessionId = 'default' }) {
    if (groupId && !this.runtime.store.has('groups', groupId)) {
      throw new Error(`unknown group ${groupId}`);
    }
    this.ensureSession(sessionId);
    const rec = groupId ? this.runtime.store.get('groups', groupId) : null;
    if (isClipboardGroup(rec)) {
      this._writeSessionActiveGroup(sessionId, null);
      await this._persist();
      return this.getWorkspaceState({ sessionId });
    }
    this._writeSessionActiveGroup(sessionId, groupId || null);
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async pinClipboard({ sessionId = 'default', items = [] } = {}) {
    this.ensureSession(sessionId);
    pinClipboardItems(this.runtime.store, items, sessionId);
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async removeClipboardItems({ sessionId = 'default', webItemIds = [] } = {}) {
    this.ensureSession(sessionId);
    const g = ensureClipboardGroup(this.runtime.store, sessionId);
    const ids = Array.isArray(webItemIds) ? webItemIds.map(String) : [];
    for (const id of ids) {
      this.runtime.removeWebItem(g.groupId, id);
    }
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async clearClipboard({ sessionId = 'default' } = {}) {
    this.ensureSession(sessionId);
    const g = ensureClipboardGroup(this.runtime.store, sessionId);
    const members = [...(this.runtime.store.get('groupMembers', g.groupId) || [])];
    for (const id of members) {
      this.runtime.removeWebItem(g.groupId, id);
    }
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async removeGroupItem({ sessionId = 'default', groupId, webItemId }) {
    this.runtime.removeWebItem(groupId, webItemId);
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  /**
   * User/UI only: add first-class URL items (页面N) to a capture group.
   * Model tools must never call this.
   */
  async addPageItems({
    sessionId = 'default',
    groupId,
    text = '',
    pages = [],
    url = '',
    title = '',
    favicon = '',
    addedBy = 'paste'
  } = {}) {
    this.ensureSession(sessionId);
    let gid = String(groupId || this._sessionActiveGroupId(sessionId) || '');
    const rec = gid ? this.runtime.store.get('groups', gid) : null;
    if (!gid || isClipboardGroup(rec)) {
      const g = this.runtime.createGroup({ sessionId });
      gid = g.groupId;
      this._writeSessionActiveGroup(sessionId, gid);
    }
    const raw =
      Array.isArray(pages) && pages.length
        ? pages
        : url
          ? [{ url, title, favicon, addedBy }]
          : text;
    const result = addPageItems(this.runtime.store, gid, raw, { addedBy });
    await this._persist();
    const state = await this.getWorkspaceState({ sessionId });
    return {
      ...state,
      pageAdd: {
        groupId: gid,
        addedCount: result.addedCount,
        duplicates: result.duplicates,
        capped: result.capped,
        focusedId: result.focusedId,
        notice: result.notice,
        summary: formatPageAddSummary(result, 'zh'),
        pageCount: result.pageCount
      }
    };
  }

  /** User hit 清空选中: drop every page-capture item in the active group. Clipboard group is untouched. */
  async clearCaptureSelection({ sessionId = 'default' } = {}) {
    this.ensureSession(sessionId);
    const groupId = this._sessionActiveGroupId(sessionId);
    const rec = groupId ? this.runtime.store.get('groups', groupId) : null;
    if (!groupId || isClipboardGroup(rec)) {
      return this.getWorkspaceState({ sessionId });
    }
    const members = [...(this.runtime.store.get('groupMembers', groupId) || [])];
    for (const id of members) {
      this.runtime.removeWebItem(groupId, id);
    }
    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  async syncTabSelection({
    sessionId = 'default',
    tabId,
    frameId = 0,
    documentId = '',
    url,
    origin,
    pageTitle,
    elements = [],
    cleared = false
  } = {}) {
    this.ensureSession(sessionId);
    // Prefer per-session active group (audit H-9)
    let groupId = this._sessionActiveGroupId(sessionId);
    const activeRec = groupId ? this.runtime.store.get('groups', groupId) : null;
    if (isClipboardGroup(activeRec)) groupId = null;
    if (!groupId) {
      const g = this.runtime.createGroup({ sessionId });
      groupId = g.groupId;
    }
    this._writeSessionActiveGroup(sessionId, groupId);

    const { selectionIdentityKey, updateWebItem, addWebItem, removeWebItem, pinClipboardItems, isClipboardTextPick } =
      await import('../sessionWorkspace/groups.js');
    const { gcUnreachableWebItems } = await import('../sessionWorkspace/gc.js');

    const members = /** @type {string[]} */ (
      this.runtime.store.get('groupMembers', groupId) || []
    );
    const currentFrameId = Number.isFinite(Number(frameId)) ? Number(frameId) : 0;
    const currentDocumentId = String(documentId || '');
    const sameFrame = (capture = {}) =>
      String(capture.source?.tabId ?? capture.tabId ?? '') === String(tabId ?? '') &&
      Number(capture.source?.frameId ?? capture.frameId ?? 0) === currentFrameId;
    // A navigation gives the frame a new document identity. Keep captures from
    // its old document rather than treating an empty new selection as deletion.
    const sameDocument = (capture = {}) =>
      String(capture.source?.documentId ?? capture.documentId ?? '') === currentDocumentId;
    /** @type {Map<string, string>} identityKey → webItemId for this document */
    const byKey = new Map();
    for (const id of members) {
      const item = this.runtime.store.get('items', id);
      if (!item) continue;
      if (isPageItem(item)) continue;
      if (!sameFrame(item.capture) || !sameDocument(item.capture)) continue;
      // Recompute instead of trusting a persisted key: captures created before
      // frame/document identity used the old key shape, but still represent the
      // main frame of this legacy document and must update in place.
      const key = selectionIdentityKey(item.capture || {});
      byKey.set(key, id);
    }

    const seenKeys = new Set();
    const clipboardItems = [];
    for (const raw of elements || []) {
      if (
        isClipboardTextPick({
          tag: raw.tag || raw.tagName || '',
          src: raw.src || '',
          href: raw.href || '',
          text: raw.text || raw.textSnippet || '',
          kind: raw.kind || raw.kindHint || '',
          kindHint: raw.kind || raw.kindHint || ''
        })
      ) {
        const text = String(raw.textRaw || raw.facets?.text || raw.text || raw.textSnippet || '');
        if (text.trim()) {
          clipboardItems.push({
            text,
            ...(raw.textRaw || raw.facets?.text ? { textRaw: text } : {}),
            kind: raw.kind || raw.kindHint || 'text',
            source: { tabId, frameId: currentFrameId, documentId: currentDocumentId, url, pageTitle }
          });
        }
        continue;
      }
      const capture = {
        source: { tabId, frameId: currentFrameId, documentId: currentDocumentId, url, origin, pageTitle },
        locator: {
          css: raw.selector || raw.css || '',
          ...(raw.locatorFingerprint ? { fingerprint: raw.locatorFingerprint, strict: true } : {})
        },
        text: raw.text || raw.textSnippet || '',
        textRaw: raw.textRaw || raw.facets?.text || '',
        src: raw.src || undefined,
        preview: {
          tagName: raw.tag || raw.tagName || '',
          textSnippet: String(raw.text || '').slice(0, 200),
          src: raw.src || undefined
        },
        kindHint: raw.kind || raw.kindHint || undefined,
        href: raw.href || undefined,
        selector: raw.selector,
        scope: raw.scope || undefined,
        facets: raw.facets || undefined,
        locatorFingerprint: raw.locatorFingerprint || undefined
      };
      const key = selectionIdentityKey(capture);
      capture.identityKey = key;
      seenKeys.add(key);
      let item;
      if (byKey.has(key)) {
        // Stable id: update in place (no orphan churn)
        item = updateWebItem(this.runtime.store, byKey.get(key), capture);
      } else {
        item = addWebItem(this.runtime.store, groupId, capture);
      }
      item = ensureItemLabel(this.runtime.store, item, { groupId }).item;
      if (raw.src && String(raw.src).startsWith('data:image')) {
        try {
          const decoded = decodeDataUrl(raw.src);
          this.runtime.store.putBlob(`blob:${item.webItemId}`, decoded.bytes, {
            mimeType: decoded.mimeType
          });
        } catch {
          /* ignore */
        }
      }
    }

    // Drop tab items whose identity disappeared from the new selection.
    // Empty list after a page reload is not a user clear — keep bound items.
    if (cleared === true || (Array.isArray(elements) && elements.length > 0)) {
      for (const [key, id] of byKey) {
        if (seenKeys.has(key)) continue;
        removeWebItem(this.runtime.store, groupId, id);
      }
    }
    gcUnreachableWebItems(this.runtime.store);
    if (clipboardItems.length) pinClipboardItems(this.runtime.store, clipboardItems, sessionId);

    await this._persist();
    return this.getWorkspaceState({ sessionId });
  }

  /**
   * Unified product entry — every user message runs general agent.
   */
  async sendMessage({
    sessionId = 'default',
    content,
    role = 'user',
    callModel = null,
    model = null,
    attachments = [],
    mentions = [],
    activeTab = null,
    fetchImpl = undefined,
    onEvent = null,
    reasoning = null,
    taskId = null,
    taskRun = false,
    scheduledRun = false,
    taskContinuation = false
  } = {}) {
    await this._ready();
    this.ensureSession(sessionId);
    if (this._activeBySession.has(sessionId)) {
      throw Object.assign(new Error('This session already has an active execution.'), { code: 'SESSION_BUSY' });
    }
    let durableTask = null;
    let releasedTask = null;
    const controller = new AbortController();
    let settleSlot = () => {};
    const finished = new Promise(resolve => { settleSlot = resolve; });
    this._activeBySession.set(sessionId, {
      controller, executionId: null, sessionId, taskId: null, finished
    });
    try {
    // Explicit resume/alarm binds by id. A host-owned activeTaskId binds
    // ordinary follow-up messages as supplemental context until detach/complete.
    if (role === 'user' && taskRun && taskId) {
      const prepared = await this._commitTaskMutation(() => {
        const existing = readTask(this.runtime.store, taskId);
        if (!existing) throw Object.assign(new Error(`Unknown task ${taskId}.`), { code: 'TASK_NOT_FOUND' });
        if (existing.sessionId !== sessionId) {
          throw Object.assign(new Error('Task does not belong to this session.'), { code: 'TASK_SESSION_MISMATCH' });
        }
        setActiveTaskId(this.runtime.store, sessionId, existing.taskId);
        return { task: existing, created: false };
      });
      durableTask = prepared.task;
    } else if (role === 'user' && !taskRun) {
      const activeId = getActiveTaskId(this.runtime.store, sessionId);
      if (activeId) {
        const existing = readTask(this.runtime.store, activeId);
        if (
          existing &&
          existing.sessionId === sessionId &&
          !['completed', 'failed', 'cancelled'].includes(existing.status)
        ) {
          durableTask = existing;
        } else {
          clearActiveTaskId(this.runtime.store, sessionId, activeId);
        }
      }
    }
    if (role === 'user' && Array.isArray(attachments) && attachments.length) {
      // Attachments: create/bind group so inspect can authorize + multimodal works
      let gid = this._sessionActiveGroupId(sessionId);
      if (!gid) {
        const g = findOrCreateNamedGroup(this.runtime.store, 'Attachments');
        gid = g.groupId;
      }
      this._writeSessionActiveGroup(sessionId, gid);
      for (const att of attachments) {
        const srcKind = String(att.source || '').toLowerCase();
        const isShot =
          srcKind === 'screenshot' ||
          srcKind === 'hotkey' ||
          srcKind === 'button' ||
          srcKind === 'paste';
        const kindHint = isShot ? 'screenshot' : att.isImage ? 'image' : 'text';
        const item = this.runtime.addWebItem(gid, {
          text: att.textContent || att.name || 'attachment',
          src: att.isImage ? att.dataUrl : undefined,
          kindHint,
          preview: { textSnippet: att.name || 'file', mimeType: att.type },
          name: att.name,
          labelKind: att.labelKind,
          labelN: att.labelN,
          sourceKind: isShot ? 'screenshot' : srcKind || 'attachment'
        });
        ensureItemLabel(this.runtime.store, item, {
          source: isShot ? 'screenshot' : '',
          kind: att.labelKind,
          n: att.labelN,
          groupId: gid
        });
        if (att.isImage && att.dataUrl) {
          try {
            const decoded = decodeDataUrl(att.dataUrl);
            this.runtime.store.putBlob(`blob:${item.webItemId}`, decoded.bytes, {
              mimeType: decoded.mimeType || att.type || 'image/png'
            });
          } catch {
            /* ignore */
          }
        }
      }
      // Bind Attachments group to this session
      const bound = new Set(this.runtime.store.get('sessionBindings', sessionId) || []);
      bound.add(gid);
      this.runtime.bindGroups(sessionId, [...bound]);
    }

    const currentSlot = this._activeBySession.get(sessionId);
    if (currentSlot) currentSlot.taskId = durableTask?.taskId || null;
      // Connection settings remain fixed for the turn; each hop refreshes cached evidence only.
      const settings = await loadLlmSettings();
      const cached = await loadCachedModelsForBase(settings.apiBase);
      const hit = findCatalogModel(cached.models || [], settings.model);
      let evidence = null;
      let override;
      try {
        const read = await this.contextWindowChecks.read(settings, cached.models || []);
        evidence = read.record;
        override = read.override;
      } catch { /* compacting still has the catalog/family/default path */ }
      const contextWindow = resolveContextWindow(settings.model, hit, { evidence, override });
      // First-send kick must not delay the turn or learn from a failed user hop.
      void this.contextWindowChecks.request().catch(() => {});
      const mediaContext = await this.mediaChecks.context(settings, cached.models || []);
      const mediaCapabilities = mediaContext.current;
      const injectedCallModel = callModel || this.callModel || null;
      const resolvedModel = injectedCallModel ? (model || null) :
        await this.resolveLanguageModel({ reasoning, settings, mediaCapabilities, mediaContext });

      let taskYielded = false;
      const previousDueAt = durableTask?.dueAt || null;
      const result = await this.runtime.sendMessage({
        sessionId,
        content,
        role,
        mentions: Array.isArray(mentions) ? mentions : [],
        activeTab:
          activeTab && typeof activeTab === 'object' && activeTab.url ? activeTab : null,
        model: resolvedModel || undefined,
        modelId: resolvedModel?.modelId,
        contextWindow,
        callModel: injectedCallModel || undefined,
        hostCanvas: (payload) =>
          chrome.runtime.sendMessage({
            target: MSG_TARGET_BACKGROUND,
            action: 'canvas_host',
            sessionId,
            ...payload
          }),
        hostPageCapture: (payload) =>
          chrome.runtime.sendMessage({
            target: MSG_TARGET_BACKGROUND,
            action: 'workspace_capture_page_blueprint',
            sessionId,
            tabId: payload?.tabId ?? activeTab?.tabId ?? activeTab?.id,
            url: payload?.url || activeTab?.url
          }),
        hostPageAction: (payload) =>
          this._gatedPageAction(
            {
              ...payload,
              tabId: payload?.tabId ?? activeTab?.tabId ?? activeTab?.id,
              url: payload?.url || activeTab?.url
            },
            sessionId,
            controller.signal
          ),
        listenRuntime: this._listenRuntime,
        settings,
        mediaCapabilities,
        mediaContext,
        hostFindTab: (url) =>
          chrome.runtime.sendMessage({
            target: MSG_TARGET_BACKGROUND,
            action: 'workspace_find_tab',
            sessionId,
            url
          }),
        hostSys: (op, params, context = {}) =>
          this._gatedSys(
            op,
            {
              ...(params && typeof params === 'object' ? params : {}),
              defaultTabId: params?.defaultTabId ?? params?.tabId ?? activeTab?.tabId ?? activeTab?.id
            },
            context,
            sessionId,
            controller.signal
          ),
        taskContext: durableTask,
        taskRun: !!(taskRun && durableTask),
        taskContinuation: taskContinuation === true,
        getTaskContext: () => {
          const id = durableTask?.taskId || getActiveTaskId(this.runtime.store, sessionId);
          return id ? readTask(this.runtime.store, id) : null;
        },
        hostTask: (input) =>
          this._commitTaskMutation(() => {
            const slot = this._activeBySession.get(sessionId);
            const out = hostTaskMutation(this.runtime.store, {
              taskId: durableTask?.taskId,
              sessionId,
              executionId: slot?.executionId,
              input,
              targetPage: activeTab
            });
            if (out?.task && (input?.op === 'start' || input?.op === 'amend')) {
              durableTask = out.task;
              if (slot) slot.taskId = out.task.taskId;
            }
            if (out.yield) taskYielded = true;
            this._broadcastUiEvent({
              type: 'task-lifecycle',
              sessionId,
              executionId: slot?.executionId,
              taskId: out?.task?.taskId || durableTask?.taskId,
              op: String(input?.op || ''),
              status: out?.task?.status,
              nextAction: out?.task?.nextAction,
              dueAt: out?.task?.dueAt,
              ok: out?.ok !== false
            });
            return out;
          }),
        taskShouldYield: () => {
          if (taskYielded || !durableTask?.taskId) return taskYielded;
          const current = readTask(this.runtime.store, durableTask.taskId);
          if (!current) return true;
          const slotExecutionId = this._activeBySession.get(sessionId)?.executionId || null;
          return (
            ['waiting', 'paused', 'completed', 'failed', 'cancelled'].includes(current.status) ||
            (current.status === 'running' && current.ownership?.executionId !== slotExecutionId)
          );
        },
        signal: controller.signal,
        fetchImpl,
        onExecutionBegin: async ({ executionId }) => {
          this._activeByExecution.set(executionId, controller);
          const slot = this._activeBySession.get(sessionId);
          if (slot) slot.executionId = executionId;
          if (durableTask?.taskId) {
            try {
              durableTask = await this._commitTaskMutation(() =>
                claimTask(this.runtime.store, durableTask.taskId, executionId)
              );
              this._broadcastUiEvent({
                type: 'task-lifecycle',
                op: 'claim',
                sessionId,
                executionId,
                taskId: durableTask?.taskId,
                status: durableTask?.status
              });
            } catch (error) {
              releasedTask = await this._releaseClaimFailure(durableTask, error);
              durableTask = null;
              return { skipAgent: true, error };
            }
          }
          this._broadcastUiEvent({
            type: 'execution-start',
            sessionId,
            executionId
          });
        },
        onEvent: (ev) => {
          this._broadcastUiEvent({ sessionId, ...ev });
          if (typeof onEvent === 'function') {
            try {
              onEvent(ev);
            } catch {
              /* test/host listener must not fail the turn */
            }
          }
        }
      });
      if (result?.skipAgent) {
        await this._persist();
        return {
          ...result,
          task: releasedTask,
          taskClaimError: result.taskClaimError || result.error || null,
          taskYielded: false
        };
      }
      if (durableTask?.taskId) {
        durableTask = await this._commitTaskMutation(() => {
          const current = readTask(this.runtime.store, durableTask.taskId);
          if (!current) return null;
          return settleTaskAfterTurn(this.runtime.store, {
            taskId: durableTask.taskId,
            executionId: result.executionId,
            scheduledRun,
            previousDueAt,
            summary: result.finalText
          });
        });
      }
      await this._persist();
      return { ...result, task: durableTask, taskYielded: result.taskYielded || taskYielded };
    } catch (error) {
      if (durableTask?.taskId) {
        try {
          const executionId = this._activeBySession.get(sessionId)?.executionId || '';
          const aborted = controller.signal.aborted || isAbortLike(error);
          durableTask = await this._commitTaskMutation(() =>
            settleTaskAfterTurn(this.runtime.store, {
              taskId: durableTask.taskId,
              executionId,
              error: true,
              aborted,
              summary: aborted
                ? 'Previous execution ended before its outcome was recorded.'
                : error?.message || 'Execution failed.',
              nextAction: aborted
                ? 'Outcome unknown; inspect the current state before resuming.'
                : undefined
            })
          );
        } catch {
          /* preserve the original execution error */
        }
      }
      throw error;
    } finally {
      try {
        const endingId = this._activeBySession.get(sessionId)?.executionId;
        await this._listenRuntime?.abort({ sessionId, executionId: endingId });
        await this._releaseTabLeases(sessionId, endingId);
        await this._cleanupExecutionPolicy(sessionId, endingId);
      } catch {
        /* */
      }
      try {
        settleSlot();
      } catch {
        /* */
      }
      if (this._activeBySession.get(sessionId)?.controller === controller) this._activeBySession.delete(sessionId);
      for (const [eid, c] of [...this._activeByExecution.entries()]) {
        if (c === controller) this._activeByExecution.delete(eid);
      }
    }
  }

  /**
   * Real abort — cancels in-flight model/tool/code for session or execution.
   * When executionId is provided, only that exact slot is cancelled so a late
   * abort cannot kill a newer execution in the same session.
   */
  async abortExecution({ sessionId, executionId } = {}) {
    const slots = [...this._activeBySession.values()].filter(slot =>
      (!sessionId || slot.sessionId === sessionId) && (!executionId || slot.executionId === executionId));
    for (const slot of slots) {
      this._broadcastUiEvent({
        type: 'abort',
        sessionId: slot.sessionId,
        executionId: slot.executionId || null,
        reason: 'user_stop',
        kind: 'exact',
        matched: true
      });
      slot.controller.abort(createUserStopError());
      abortSessionClarifies(slot.sessionId);
      await this._listenRuntime?.abort({ sessionId: slot.sessionId, executionId: slot.executionId });
      await this._cleanupExecutionPolicy(slot.sessionId, slot.executionId);
    }
    if (executionId && slots.length === 0) {
      this._broadcastUiEvent({
        type: 'abort',
        sessionId: sessionId || '',
        executionId,
        reason: 'user_stop',
        kind: 'exact',
        matched: false
      });
    }
    if (!sessionId && !executionId) abortSessionClarifies();
    await Promise.all(slots.map(slot => this._releaseTabLeases(slot.sessionId, slot.executionId)));
    return { ok: true, aborted: slots.length > 0, deprecated: false };
  }

  /**
   * UI Stop: resolve the live slot for this session, then exact-abort it.
   * Does not depend on a caller-supplied executionId (stale / null safe).
   */
  async abortCurrentExecution({ sessionId } = {}) {
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, aborted: false, code: 'NO_SESSION' };
    const slot = this._activeBySession.get(sid);
    if (!slot) {
      this._broadcastUiEvent({
        type: 'abort',
        sessionId: sid,
        executionId: null,
        reason: 'user_stop',
        kind: 'current',
        aborted: false
      });
      return { ok: true, aborted: false, sessionId: sid, executionId: null };
    }
    const executionId = slot.executionId || null;
    this._broadcastUiEvent({
      type: 'abort',
      sessionId: sid,
      executionId,
      reason: 'user_stop',
      kind: 'current',
      matched: true
    });
    slot.controller.abort(createUserStopError());
    abortSessionClarifies(sid);
    await this._cleanupExecutionPolicy(sid, slot.executionId);
    await this._releaseTabLeases(sid, slot.executionId);
    return { ok: true, aborted: true, sessionId: sid, executionId };
  }

  /** Sidepanel: user answered the clarify card. Resumes the paused tool loop. */
  async answerClarify(params = {}) {
    return answerClarify(params);
  }

  /** Product Stop hook (Sidepanel). */
  async abortTask({ sessionId, executionId } = {}) {
    if (executionId) {
      return this.abortExecution({
        sessionId: sessionId || undefined,
        executionId
      });
    }
    if (sessionId) return this.abortCurrentExecution({ sessionId });
    return this.abortExecution({});
  }

  async listSkills() {
    const durable = await getDurableSkillStore().list();
    return mergeSkillCatalog(listPackagedSkillCatalog(), durable);
  }

  async getSkillDetail({ id } = {}) {
    const packed = getSkill(id);
    const durable = await getDurableSkillStore().get(id);
    const rec = mergeSkillRecord(packed, durable);
    if (!rec) throw new Error(`unknown skill ${id}`);
    const instructions =
      typeof rec.instructions === 'function' ? rec.instructions() : rec.instructions || '';
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      instructions,
      origin: rec.origin || 'packaged',
      sourceUrl: rec.sourceUrl || '',
      resources: Object.keys(rec.resources || {}).map((path) => ({
        path,
        guestPath: `/scratch/skills/${rec.id}/${path}`,
        preview: String(rec.resources[path] || '').slice(0, 400)
      })),
      guestRoot: `/scratch/skills/${rec.id}`
    };
  }

  async upsertSkill(params = {}) {
    const id = sanitizeSkillId(params.id || params.name);
    const existing = id ? await getDurableSkillStore().get(id) : null;
    const saved = await getDurableSkillStore().upsert(
      normalizeDurableSkill({
        ...(existing || {}),
        ...params,
        resources:
          params.resources && Object.keys(params.resources).length
            ? params.resources
            : existing?.resources,
        sourceUrl: params.sourceUrl || existing?.sourceUrl || '',
        origin: params.origin || existing?.origin || 'authored'
      })
    );
    return { ok: true, skill: { id: saved.id, name: saved.name, description: saved.description, origin: saved.origin } };
  }

  async importSkill({ url } = {}) {
    const imported = await importSkillFromUrl(url);
    if (!imported.ok) return imported;
    const saved = await getDurableSkillStore().upsert(imported.skill);
    return { ok: true, skill: { id: saved.id, name: saved.name, description: saved.description, origin: saved.origin } };
  }

  async deleteSkill({ id } = {}) {
    await getDurableSkillStore().remove(id);
    return { ok: true, id };
  }

  async listArtifacts({ sessionId = 'default' } = {}) {
    this.ensureSession(sessionId);
    return this.runtime.listArtifacts(sessionId);
  }

  async _loadArtifactBytes(sessionId, artifactId) {
    this.ensureSession(sessionId);
    const gate = assertArtifactOwned(this.runtime.store, sessionId, artifactId);
    if (!gate.ok) {
      throw new Error(gate.error || `artifact not found: ${artifactId}`);
    }
    let rec = gate.record;
    if (typeof this.runtime.store.hydrateSessionBlobs === 'function') {
      await this.runtime.store.hydrateSessionBlobs(sessionId);
    }
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    let bytes = null;
    const hostPath = fs._hostPath(rec.primaryPath);
    const nodeKey = fs._nodeKey(hostPath);
    if (typeof this.runtime.store.getBlobAsync === 'function') {
      const blob = await this.runtime.store.getBlobAsync(nodeKey);
      if (blob?.bytes) bytes = blob.bytes;
    }
    if (!bytes) bytes = fs.readFileBytes(rec.primaryPath);
    rec = persistCapabilityFromBytes(this.runtime.store, rec, bytes);
    return { rec, bytes: bytes || new Uint8Array(0) };
  }

  /** Bounded preview / classify. Never a download path. */
  async readArtifactPreview({ sessionId = 'default', artifactId, maxBytes } = {}) {
    try {
      const { rec, bytes } = await this._loadArtifactBytes(sessionId, artifactId);
      const asked = maxBytes != null ? Number(maxBytes) : READ_ARTIFACT_PREVIEW_DEFAULT;
      const limit = Math.max(
        0,
        Math.min(READ_ARTIFACT_PREVIEW_HARD_CAP, Number.isFinite(asked) ? asked : READ_ARTIFACT_PREVIEW_DEFAULT)
      );
      const total = bytes.byteLength;
      const truncated = total > limit;
      const slice = truncated ? bytes.subarray(0, limit) : bytes;
      const textLike = /^text\/|json|xml|javascript|markdown|csv/i.test(rec.mimeType || '');
      return {
        artifact: rec,
        content: textLike ? new TextDecoder().decode(slice) : '',
        byteLength: total,
        prefixBytes: slice.byteLength,
        truncated,
        preview: true,
        complete: !truncated,
        mimeType: rec.mimeType || 'application/octet-stream',
        base64: bytesToBase64(slice)
      };
    } catch (e) {
      throw new Error(
        `artifact content unreadable: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Original bytes. Never returns a silent prefix. */
  async downloadArtifact({ sessionId = 'default', artifactId } = {}) {
    try {
      const { rec, bytes } = await this._loadArtifactBytes(sessionId, artifactId);
      const textLike = /^text\/|json|xml|javascript|markdown|csv/i.test(rec.mimeType || '');
      if (bytes.byteLength > DOWNLOAD_INLINE_MAX) {
        return {
          artifact: rec,
          content: '',
          byteLength: bytes.byteLength,
          prefixBytes: 0,
          truncated: false,
          preview: false,
          complete: true,
          useChunks: true,
          chunkSize: ARTIFACT_CHUNK_SIZE,
          mimeType: rec.mimeType || 'application/octet-stream'
        };
      }
      return {
        artifact: rec,
        content: textLike ? new TextDecoder().decode(bytes) : '',
        byteLength: bytes.byteLength,
        prefixBytes: bytes.byteLength,
        truncated: false,
        preview: false,
        complete: true,
        mimeType: rec.mimeType || 'application/octet-stream',
        base64: bytesToBase64(bytes)
      };
    } catch (e) {
      throw new Error(
        `artifact content unreadable: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async readArtifactChunk({ sessionId = 'default', artifactId, offset = 0, length } = {}) {
    const { rec, bytes } = await this._loadArtifactBytes(sessionId, artifactId);
    const start = Math.max(0, Number(offset) || 0);
    const want = length != null ? Number(length) : ARTIFACT_CHUNK_SIZE;
    const take = Math.max(0, Number.isFinite(want) ? want : ARTIFACT_CHUNK_SIZE);
    const slice = bytes.subarray(start, start + take);
    return {
      artifactId: rec.artifactId,
      offset: start,
      length: slice.byteLength,
      byteLength: bytes.byteLength,
      truncated: false,
      complete: false,
      preview: false,
      base64: bytesToBase64(slice)
    };
  }

  /** `maxBytes` / preview=true → bounded preview. Otherwise complete original bytes. */
  async readArtifact({ sessionId = 'default', artifactId, maxBytes, preview } = {}) {
    if (preview === true || maxBytes != null) {
      return this.readArtifactPreview({ sessionId, artifactId, maxBytes });
    }
    return this.downloadArtifact({ sessionId, artifactId });
  }

  async createArtifact({ sessionId = 'default', name, content, mimeType, path, base64 } = {}) {
    this.ensureSession(sessionId);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const rec = createArtifactRecord(this.runtime.store, fs, {
      sessionId,
      name: name || 'stage.html',
      content: bytesFromRpcContent({ content, base64 }),
      mimeType,
      path
    });
    await this._persist();
    return { ok: true, artifact: rec };
  }

  async rewriteGuestMedia({ sessionId = 'default', html } = {}) {
    this.ensureSession(sessionId);
    if (typeof this.runtime.store.hydrateSessionBlobs === 'function') {
      await this.runtime.store.hydrateSessionBlobs(sessionId);
    }
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    return { html: rewriteGuestImageSrcs(html, fs, this.runtime.store, sessionId) };
  }

  async revertArtifact({ sessionId = 'default', artifactId } = {}) {
    this.ensureSession(sessionId);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const out = revertArtifactContent(this.runtime.store, fs, sessionId, artifactId);
    if (!out.ok) {
      const err = new Error(out.error || 'revert failed');
      err.code = out.code;
      throw err;
    }
    await this._persist();
    return out;
  }

  /**
   * User/preview save (UI RPC). A reversible local write: no Access Policy gate,
   * no dispatch ticket (the SW never consumes one for a local artifact write).
   * A stale expectedRevision throws ARTIFACT_CONFLICT so the RPC reports failure.
   */
  async updateArtifact({ sessionId = 'default', artifactId, content, mimeType, base64, name, expectedRevision } = {}) {
    this.ensureSession(sessionId);
    const bytes = bytesFromRpcContent({ content, base64 });
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const rec = updateArtifactContent(this.runtime.store, fs, sessionId, artifactId, bytes, { mimeType, name, expectedRevision });
    await this._persist();
    return { ok: true, artifact: rec, revision: rec.revision };
  }

  async deleteArtifact({ sessionId = 'default', artifactId } = {}) {
    this.ensureSession(sessionId);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const result = deleteArtifactRecord(this.runtime.store, fs, sessionId, artifactId);
    if (!result.deleted) {
      throw new Error(result.error || 'delete failed');
    }
    await this._persist();
    return {
      ...result,
      artifacts: this.runtime.listArtifacts(sessionId),
      artifactCount: this.runtime.listArtifacts(sessionId).length
    };
  }

  /**
   * Storage visibility for Session shelf (not OPFS paths).
   * Counts all package files under session artifacts, not only primary size.
   */
  async getStorageStats({ sessionId = 'default' } = {}) {
    this.ensureSession(sessionId);
    const arts = this.runtime.listArtifacts(sessionId).filter((a) => !isWorkspaceContractArtifact(a));
    let artifactBytes = 0;
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    for (const a of arts) {
      const packagePrefix = `/artifacts/${a.packageDir}`;
      for (const guest of fs.list(packagePrefix)) {
        try {
          const b = fs.readFileBytes(guest);
          artifactBytes += b.byteLength;
        } catch {
          artifactBytes += Number(a.size) || 0;
        }
      }
    }
    let blobBytes = 0;
    for (const bk of this.runtime.store.blobs.keys()) {
      if (String(bk).includes(`/${sessionId}/`)) {
        const b = this.runtime.store.getBlob(bk);
        if (b) blobBytes += b.bytes.byteLength;
      }
    }
    let fileCount = 0;
    for (const hp of this.runtime.store.keys('fsNodes')) {
      const node = this.runtime.store.get('fsNodes', hp);
      if (!node || node.sessionId !== sessionId) continue;
      if (node.kind === 'dir') continue;
      const guest = String(node.guestPath || '');
      if (!guest.startsWith('/artifacts')) continue;
      if (guest === '/artifacts/AGENTS.md' || guest === '/artifacts/Memory.md' || guest === '/artifacts/STATUS.md') continue;
      fileCount += 1;
    }
    return {
      sessionId,
      artifactCount: arts.length,
      fileCount,
      artifactBytes,
      blobBytes,
      storeKind: this.storeKind
    };
  }

  async deleteSession({ sessionId }) {
    if (!sessionId) throw new Error('deleteSession: sessionId required');
    // Same kill path as Stop — then wait so sendMessage cannot recreate the row
    await this.abortExecution({ sessionId });
    await this._awaitSessionIdle(sessionId);
    deleteTasksForSession(this.runtime.store, sessionId);
    abortExecutionApprovals(sessionId);
    try {
      await this._dropTickets(sessionId, this._activeBySession.get(sessionId)?.executionId);
      const leftover = await this._journal.listBySession(sessionId);
      for (const row of leftover) await this._dropTicket(row.operationId);
      await this._journal.deleteSession(sessionId);
    } catch {
      /* journal GC must not block session delete */
    }
    const result = this.runtime.deleteSession(sessionId);
    await this._persist();
    return result;
  }

  /** Startup / manual orphan scratch cleanup */
  async sweepOrphans() {
    const r = sweepOrphanScratch(this.runtime.store);
    gcUnreachableWebItems(this.runtime.store);
    await this._persist();
    return r;
  }

  /**
   * Audit P1.10 — storage pressure: estimate (when available) + soft disposable GC.
   * Never deletes durable artifacts.
   */
  async applyStoragePressure({ level = 'soft' } = {}) {
    const { applyStoragePressure } = await import('../sessionWorkspace/gc.js');
    const before = await this.estimateStorage();
    const result = applyStoragePressure(this.runtime.store, { level });
    sweepOrphanScratch(this.runtime.store);
    await this._persist();
    const after = await this.estimateStorage();
    return { ...result, before, after, artifactsPreserved: result.artifactsPreserved };
  }

  async estimateStorage() {
    let quota = null;
    let usage = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        quota = est.quota ?? null;
        usage = est.usage ?? null;
      }
    } catch {
      /* ignore */
    }
    let blobBytes = 0;
    for (const bk of this.runtime.store.blobs.keys()) {
      const b = this.runtime.store.getBlob(bk);
      if (b) blobBytes += b.bytes.byteLength;
    }
    return {
      quota,
      usage,
      blobBytes,
      pressure:
        quota && usage != null && quota > 0 ? usage / quota : blobBytes > 50 * 1024 * 1024 ? 1 : 0
    };
  }

  async setActiveWorkbook({ sessionId = 'default', artifactId, overview } = {}) {
    this.ensureSession(sessionId);
    const s = this.runtime.store.get('sessions', sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    this.runtime.store.put('sessions', sessionId, {
      ...s,
      activeWorkbook: {
        artifactId: String(artifactId || s.activeWorkbook?.artifactId || ''),
        overview: overview || s.activeWorkbook?.overview || null,
        updatedAt: Date.now()
      },
      updatedAt: Date.now()
    });
    return { ok: true };
  }

  async setActiveHtml({ sessionId = 'default', artifactId, overview } = {}) {
    this.ensureSession(sessionId);
    const s = this.runtime.store.get('sessions', sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    const selections = Array.isArray(overview?.selections)
      ? overview.selections.map((sel) => ({
          plateId: sel.plateId || sel.sheet || '',
          slotId: sel.nodeId || sel.slotId || sel.a1 || '',
          nodeId: sel.nodeId || sel.slotId || '',
          sheet: sel.sheet || sel.plateId || '',
          a1: sel.a1 || sel.slotId || sel.nodeId || '',
          tag: sel.tag || '',
          kind: sel.kind || sel.type || '',
          type: sel.type || sel.kind || '',
          text: sel.text || ''
        }))
      : [];
    this.runtime.store.put('sessions', sessionId, {
      ...s,
      activeHtml: {
        artifactId: String(artifactId || s.activeHtml?.artifactId || ''),
        overview: overview || s.activeHtml?.overview || null,
        selections,
        updatedAt: Date.now()
      },
      updatedAt: Date.now()
    });
    return { ok: true };
  }

  /**
   * Sidepanel 新建 strip — user-initiated blank Design / Slides / Sheet / Doc / Site.
   * Sheet reuses createSheetArtifact (createWorkbook host path).
   */
  async createBlankArtifact({ sessionId = 'default', kind } = {}) {
    this.ensureSession(sessionId);
    if (kind === 'sheet') {
      return { ok: false, code: 'BAD_INPUT', error: 'unknown blank kind: sheet' };
    }
    const spec = blankArtifactPayload(kind);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const rec = createArtifactRecord(this.runtime.store, fs, {
      sessionId,
      name: spec.name,
      content: spec.content,
      mimeType: spec.mimeType,
      folder: spec.folder
    });
    await this._persist();
    return { ok: true, artifact: rec, kind: spec.kind };
  }

  async createSheetArtifact({ sessionId = 'default', name, sheets, kind = 'csv' } = {}) {
    this.ensureSession(sessionId);
    const fs = createSessionGuestFs(this.runtime.store, { sessionId, executionId: null });
    const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', rows: [['列1', '列2', '列3']] }];
    const delim = kind === 'tsv' ? '\t' : ',';
    const body = aoaToCsv(list[0].rows || [], delim);
    let fileName = String(name || 'workbook.csv').replace(/[^\w.\u4e00-\u9fff-]+/g, '_');
    if (!/\.(csv|tsv)$/i.test(fileName)) fileName += kind === 'tsv' ? '.tsv' : '.csv';
    const mimeType = guessMimeFromName(fileName.toLowerCase());
    const rec = createArtifactRecord(this.runtime.store, fs, {
      sessionId,
      name: fileName,
      content: body,
      mimeType
    });
    await this.setActiveWorkbook({
      sessionId,
      artifactId: rec.artifactId,
      overview: {
        name: fileName,
        kind: kind === 'tsv' ? 'tsv' : 'csv',
        sheets: list.map((s) => ({
          name: s.name || 'Sheet1',
          rowCount: (s.rows || []).length,
          columnCount: (s.rows?.[0] || []).length,
          headers: (s.rows?.[0] || []).map((h) => String(h ?? ''))
        }))
      }
    });
    await this._persist();
    return { ok: true, artifact: rec };
  }

  /**
   * Welcome chips after selection settles. One generateText, no tools, not sendMessage.
   */
  async suggestSelectionActions({ sessionId = 'default', selection = {}, lang = 'zh' } = {}) {
    this.ensureSession(sessionId);
    if (this._activeBySession.has(sessionId)) {
      return { chips: [], skipped: 'busy' };
    }
    const model = await this.resolveLanguageModel();
    const chips = await runSelectionSuggest({
      model,
      selection: { ...selection, lang: selection.lang || lang }
    });
    return { chips };
  }

  /** @deprecated — use artifacts */
  async readOutput() {
    return { ok: false, error: 'use session artifacts', deprecated: true };
  }

  /** @deprecated */
  async getTaskResult() {
    return { status: 'unknown', result: null, deprecated: true };
  }

  get supportsLegacyFreezeCommit() {
    return false;
  }
}

const UI_EVENT_DROP_KEYS = new Set(['dataUrl', 'base64', 'bytes', 'imageBase64']);
const UI_EVENT_CLIP_KEYS = new Set(['preview', 'playbook', 'html']);
const UI_EVENT_CLIP_CHARS = 800;

function slimWorkspaceUiValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > UI_EVENT_CLIP_CHARS ? `${value.slice(0, UI_EVENT_CLIP_CHARS)}…` : value;
  }
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 24).map((v) => slimWorkspaceUiValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (UI_EVENT_DROP_KEYS.has(k)) continue;
      if (UI_EVENT_CLIP_KEYS.has(k) && typeof v === 'string') {
        out[k] = slimWorkspaceUiValue(v);
        continue;
      }
      if ((k === 'preview' || k === 'content') && typeof v === 'string' && depth >= 1) {
        out[k] = slimWorkspaceUiValue(v);
        continue;
      }
      const slim = slimWorkspaceUiValue(v, depth + 1);
      if (slim !== undefined) out[k] = slim;
    }
    return out;
  }
  return undefined;
}

/** Chrome runtime messages cannot carry megabyte data URLs; artifacts stay on the shelf. */
export function stripWorkspaceUiEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const out = {};
  for (const [k, v] of Object.entries(event)) {
    if (UI_EVENT_DROP_KEYS.has(k)) continue;
    if (k === 'result' || k === 'args' || k === 'output' || k === 'input') {
      out[k] = slimWorkspaceUiValue(v, 1);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('invalid data url');
  const mimeType = m[1] || 'application/octet-stream';
  const payload = m[3] || '';
  if (m[2]) {
    if (typeof Buffer !== 'undefined') {
      return { bytes: new Uint8Array(Buffer.from(payload, 'base64')), mimeType };
    }
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mimeType };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
}

function persistCapabilityFromBytes(store, rec, bytes) {
  if (!store || !rec?.artifactId) return rec;
  const hint = persistableCapabilityHint({
    name: rec.name,
    mimeType: rec.mimeType,
    bytes,
    contentKind: rec.contentKind,
    capability: rec.capability
  });
  if (!hint.proven) return rec;
  if (rec.capability?.proven === true && rec.contentKind === hint.contentKind) return rec;
  const next = { ...rec, contentKind: hint.contentKind, capability: hint };
  store.put('artifacts', rec.artifactId, next);
  return next;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
