/**
 * Unified production path: sendMessage → AI SDK 7 ToolLoopAgent (toolChoice=auto).
 * No Task object, no chat/run mode split, no handwritten tool loop.
 */

import { createMessageId } from './ids.js';
import { createSessionGuestFs } from './fs.js';
import { beginExecution, settleExecution } from './execution.js';
import { getBoundGroupsCompact } from './groups.js';
import { listBoundItemIndex } from './itemLabel.js';
import { getArtifactIndexCompact, listArtifacts } from './artifacts.js';
import { compactShelfSnapshot } from './artifactShelf.js';
import { buildSessionAgentInstructions, buildWorldStateBlock, compactOpenTabOverview } from './prompt.js';
import { formatTaskInstructions } from './taskInstructions.js';
import { userRequestedPlan } from './planContract.js';
import {
  formatAgentsMdInstructions,
  formatMemoryMdInstructions,
  readSessionAgentsMd,
  readSessionMemoryMd,
  sessionAgentsPresent
} from './sessionAgentsMd.js';
import { runLearnTurn, userRequestedLearn } from './learnFromTrajectory.js';
import { createSessionTools } from './tools.js';
import { inventoryFromSession } from './canvasInventory.js';
import { makeOfficePrepareStep, scheduleActiveToolNames } from './toolSchedule.js';
import { formatSkillsForSystemPrompt, listPackagedSkillCatalog } from '../skills/registry.js';
import { getDurableSkillStore, mergeSkillCatalog } from './skillStore.js';
import { formatRpcError } from '../host/rpcError.js';
import { isAbortLike, toAbortError, USER_STOP } from '../host/userStop.js';
import {
  buildWireFromTurn,
  replayWireMessages,
  attachWorldToLastUser,
  projectJsonForWire
} from './wireTranscript.js';
import {
  runSessionToolLoopAgent,
  createCallModelLanguageModel
} from './sessionAgent.js';
import { generateTaskTitle, isPlaceholderTaskTitle } from './taskTitle.js';
import {
  mergeBehaviorPath,
  recordBehaviorEvent,
  compactTurnContext,
  pickRoutedModelId,
  splitTurnTiming
} from './behaviorPath.js';
import {
  COMPACT_RATIO,
  shouldCompact,
  messagesAfterCompact,
  compactPrefixMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  harvestModelUsage,
  contextUsageRatio,
  runSessionCompact,
  pruneSdkToolResults,
  spliceCompactIntoSdkMessages
} from './contextCompact.js';
import { resolveContextWindow } from '../../modelCatalog.js';
import { loadWebAcquireSettings } from '../../webAcquireSettings.js';
import { gateWebAcquire } from '../../byokGate.js';
import { resolveFocusPage, rememberVisitedPage } from './pageContext.js';
import {
  appendProgressNote,
  createProgressTracker,
  dropEchoedFinalNote
} from './progressNotes.js';

/**
 * @param {import('./store.js').SessionWorkspaceStore} store
 * @param {{
 *   sessionId: string,
 *   content: string,
 *   mentions?: Array<{kind?:string,id?:string,groupId?:string,label?:string,handle?:string,url?:string}>,
 *   activeTab?: { url?: string, title?: string, origin?: string }|null,
 *   role?: string,
 *   callModel?: Function,
 *   model?: any,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 *   taskContext?: object|null,
 *   taskRun?: boolean,
 *   taskContinuation?: boolean,
 *   getTaskContext?: () => object|null|Promise<object|null>,
 *   hostTask?: (input: object) => Promise<{ok:boolean,task?:object,yield?:boolean}>,
 *   taskShouldYield?: () => boolean,
 *   onEvent?: (ev: object) => void
 * }} input
 */
export async function sendMessage(store, input) {
  const sessionId = String(input.sessionId || '');
  if (!sessionId) throw new Error('sendMessage: sessionId required');
  if (!store.has('sessions', sessionId)) throw new Error(`sendMessage: unknown session ${sessionId}`);

  const content = String(input.content ?? '');
  const role = input.role || 'user';
  const taskContinuation = input.taskContinuation === true;
  const session = store.get('sessions', sessionId);
  const persistUserMessage = role === 'user' && !taskContinuation;
  const isFirstUser =
    persistUserMessage && !(session.messages || []).some((m) => m?.role === 'user');
  const shouldName =
    isFirstUser &&
    !session.titleLocked &&
    isPlaceholderTaskTitle(session.title || session.name);
  const message = {
    messageId: createMessageId(),
    role,
    content: persistUserMessage ? content : '',
    createdAt: Date.now()
  };
  const messages = persistUserMessage
    ? [...(session.messages || []), message]
    : [...(session.messages || [])];
  if (persistUserMessage) {
    store.put('sessions', sessionId, {
      ...session,
      messages,
      updatedAt: Date.now()
    });
  }

  // Non-user messages: only append
  if (role !== 'user') {
    return {
      message,
      executionId: null,
      finalText: null,
      toolCalls: [],
      steps: [],
      createdTask: false,
      taskYielded: false,
      taskStepLimitReached: false,
      taskStepCount: 0
    };
  }

  const execution = beginExecution(store, sessionId, { abortSignal: input.signal });
  let beginOut = null;
  if (typeof input.onExecutionBegin === 'function') {
    try {
      beginOut = await input.onExecutionBegin({
        executionId: execution.executionId,
        sessionId
      });
    } catch (error) {
      settleExecution(store, execution, 'failed');
      throw error;
    }
  }
  if (beginOut?.skipAgent === true) {
    settleExecution(store, execution, 'settled');
    try {
      if (typeof input.onEvent === 'function') {
        input.onEvent({
          type: 'execution-end',
          sessionId,
          executionId: execution.executionId,
          status: 'settled',
          code: beginOut.error?.code || beginOut.code || '',
          error: beginOut.error || null
        });
      }
    } catch {
      /* UI listener must not fail the turn */
    }
    return {
      message: persistUserMessage ? message : null,
      executionId: execution.executionId,
      finalText: null,
      toolCalls: [],
      steps: [],
      createdTask: false,
      taskYielded: false,
      taskStepLimitReached: false,
      taskStepCount: 0,
      skipAgent: true,
      taskClaimError: beginOut.error || null
    };
  }
  // Cold start: OPFS bytes may not be in memory yet (readArtifact hydrates; agent must too)
  if (typeof store.hydrateSessionBlobs === 'function') {
    try {
      await store.hydrateSessionBlobs(sessionId);
    } catch {
      /* continue; missing blobs surface as ENOENT to tools */
    }
  }
  const fs = createSessionGuestFs(store, { sessionId, executionId: execution.executionId });
  try {
    fs.mkdirp('/artifacts');
    fs.mkdirp('/scratch');
  } catch {
    /* ignore */
  }

  const boundGroups = getBoundGroupsCompact(store, sessionId);
  const artifactIndex = getArtifactIndexCompact(store, sessionId);
  const pages = resolveFocusPage({
    activeTab: input.activeTab,
    mentions: input.mentions
  });
  if (pages.focusPage) rememberVisitedPage(store, sessionId, pages.focusPage);
  if (pages.activeTab && pages.activeTab.url !== pages.focusPage?.url) {
    rememberVisitedPage(store, sessionId, pages.activeTab);
  }
  const sessionNow = store.get('sessions', sessionId) || session;
  const activeHtml = sessionNow.activeHtml || null;
  // Skills: catalog only (id / name / description). Playbooks load via inspect view=skill.
  // System prompt is identity + composition — do not duplicate tool schemas here.
  const durableSkills = await getDurableSkillStore().list();
  const skillCatalog = mergeSkillCatalog(listPackagedSkillCatalog(), durableSkills);
  const skillText = formatSkillsForSystemPrompt({
    sessionId,
    catalog: skillCatalog
  });
  const canvasInv = inventoryFromSession(store, sessionId, fs);
  const boundItems = listBoundItemIndex(store, sessionId);
  let taskContext = input.taskContext || null;
  if (typeof input.getTaskContext === 'function') {
    try {
      taskContext = (await input.getTaskContext()) || null;
    } catch {
      /* task host failures surface through the task tool; chat can still render */
    }
  }
  const taskInstructionText = formatTaskInstructions(taskContext);
  // This is persisted by the service when it creates a Personal Library
  // session. It is never accepted from a UI RPC/sendMessage parameter.
  const libraryInstructionText = String(session?.personalLibraryInstructions || '');
  const system = [
    buildSessionAgentInstructions({
      skillInstructions: skillText
    }),
    libraryInstructionText,
    taskInstructionText
  ]
    .filter(Boolean)
    .join('\n\n');
  const learnRequested = userRequestedLearn({ content, mentions: input.mentions });
  let tabOverview = input.tabOverview != null
    ? compactOpenTabOverview(input.tabOverview)
    : null;
  if (!learnRequested && !tabOverview && typeof input.hostSys === 'function') {
    try {
      const listed = await input.hostSys('tabs.list', {});
      const rows = listed && typeof listed === 'object' && listed.result != null ? listed.result : listed;
      tabOverview = compactOpenTabOverview(rows);
    } catch {
      tabOverview = null;
    }
  }
  const worldBlock = buildWorldStateBlock({
    boundGroups,
    boundItems,
    artifactCount: artifactIndex.artifactCount,
    focusedMentions: Array.isArray(input.mentions) ? input.mentions : [],
    activeWorkbook: sessionNow.activeWorkbook || null,
    activeHtml,
    canvases: canvasInv,
    activeTab: pages.activeTab,
    focusPage: pages.focusPage,
    shelf: compactShelfSnapshot(listArtifacts(store, sessionId), sessionNow.shelf),
    userRequestedPlan: userRequestedPlan({ content, mentions: input.mentions }),
    userRequestedLearn: learnRequested,
    tabOverview,
    taskContinuation,
    taskContext,
    agentsMd: { present: sessionAgentsPresent(store, sessionId) }
  });

  let thoughtBuf = '';
  /** Live tool + host path for trajectory export (not the chat bubble). */
  const pathLog = [];
  // Progress notes belong to this turn. While it runs they live on
  // session.turnProgress (so a reopened panel can repaint them); the settled
  // assistant record carries them as `progress`. Never extra assistant messages.
  let progressNotes = [];
  const progressTracker = createProgressTracker({ startedAt: message.createdAt });
  const persistTurnProgress = () => {
    const s = store.get('sessions', sessionId);
    if (!s) return;
    store.put('sessions', sessionId, {
      ...s,
      turnProgress: {
        executionId: execution.executionId,
        startedAt: Number(message.createdAt) || Date.now(),
        notes: progressNotes
      }
    });
  };
  const upstreamEvent = typeof input.onEvent === 'function' ? input.onEvent : null;
  const onEvent = (raw) => {
    let ev = raw;
    if (ev && typeof ev === 'object' && ev.type === 'progress-note') {
      ev = { ...ev, sessionId, executionId: execution.executionId };
      progressNotes = appendProgressNote(progressNotes, ev);
      progressTracker.markNote(ev);
      try {
        persistTurnProgress();
      } catch {
        /* the settled record still carries the notes */
      }
    }
    if (ev && typeof ev === 'object' && ev.type === 'thought') {
      const piece = ev.text != null ? ev.text : ev.chunk;
      if (typeof piece === 'string' && piece && piece !== '[object Object]') thoughtBuf += piece;
    }
    try {
      recordBehaviorEvent(pathLog, ev);
    } catch {
      /* path recorder must not fail the turn */
    }
    if (upstreamEvent) {
      try {
        upstreamEvent(ev);
      } catch {
        /* UI listener must not fail the turn */
      }
    }
  };

  if (learnRequested) {
    let learnOut;
    try {
      learnOut = await runLearnTurn({
        store,
        sessionId,
        execution,
        signal: execution.abortSignal,
        callModel: input.callModel,
        model: input.model,
        onEvent,
        waitForClarify: input.waitForClarify
      });
    } catch (error) {
      if (isAbortLike(error, execution.abortSignal)) throw error;
      learnOut = {
        ok: false,
        wrote: false,
        code: error?.code || 'LEARN_FAILED',
        finalText: formatRpcError(error)
      };
    }
    const finalText = String(learnOut?.finalText || '');
    const assistant = {
      messageId: createMessageId(),
      role: 'assistant',
      content: finalText,
      status: 'completed',
      toolCalls: [],
      path: pathLog.slice(),
      createdAt: Date.now()
    };
    const sessLearn = store.get('sessions', sessionId);
    store.put('sessions', sessionId, {
      ...sessLearn,
      messages: [...(sessLearn.messages || []), assistant],
      updatedAt: Date.now()
    });
    settleExecution(store, execution, 'settled');
    try {
      onEvent({
        type: 'assistant-final',
        sessionId,
        executionId: execution.executionId,
        content: finalText
      });
      onEvent({
        type: 'execution-end',
        sessionId,
        executionId: execution.executionId,
        status: 'completed'
      });
    } catch {
      /* UI listener must not fail the turn */
    }
    return {
      message,
      assistant,
      executionId: execution.executionId,
      finalText,
      thought: '',
      toolCalls: [],
      steps: [],
      createdTask: false,
      learn: {
        wrote: learnOut?.wrote === true,
        code: learnOut?.code || '',
        merged: learnOut?.merged === true
      },
      taskYielded: false,
      taskStepLimitReached: false,
      taskStepCount: 0
    };
  }

  recordBehaviorEvent(pathLog, {
    type: 'turn-context',
    ...compactTurnContext({
      tools: scheduleActiveToolNames(canvasInv),
      canvases: canvasInv,
      artifactCount: artifactIndex.artifactCount,
      boundGroups,
      boundItemCount: boundItems.length,
      mentions: input.mentions,
      activeWorkbook: sessionNow.activeWorkbook || null,
      activeHtml,
      activeTab: pages.activeTab,
      focusPage: pages.focusPage,
      skills: skillCatalog
    })
  });

  // Own Tavily / Brave / Firecrawl keys need a paid plan; credit slots pass (byokGate.js).
  const webAcquire = await gateWebAcquire(
    input.webAcquire && typeof input.webAcquire === 'object'
      ? input.webAcquire
      : await loadWebAcquireSettings()
  );
  const tools = createSessionTools({
    store,
    execution,
    fs,
    sessionId,
    signal: execution.abortSignal,
    fetchImpl: input.fetchImpl || globalThis.fetch,
    onEvent,
    waitForClarify: input.waitForClarify,
    webAcquire,
    hostCanvas: typeof input.hostCanvas === 'function' ? input.hostCanvas : null,
    hostPageCapture: typeof input.hostPageCapture === 'function' ? input.hostPageCapture : null,
    hostPageAction: typeof input.hostPageAction === 'function' ? input.hostPageAction : null,
    listenRuntime: input.listenRuntime || null,
    settings: input.settings,
    mediaCapabilities: input.mediaCapabilities,
    mediaContext: input.mediaContext,
    hostFindTab: typeof input.hostFindTab === 'function' ? input.hostFindTab : null,
    hostSys: typeof input.hostSys === 'function' ? input.hostSys : null,
    activeTab: input.activeTab || pages.activeTab,
    focusPage: pages.focusPage,
    promptId: message.messageId || execution.executionId,
    taskContext,
    getTaskContext: input.getTaskContext,
    hostTask: input.hostTask,
    taskShouldYield: input.taskShouldYield
  });

  const contextWindow =
    Number(input.contextWindow) > 2048
      ? Math.round(Number(input.contextWindow))
      : resolveContextWindow(input.modelId || input.model?.modelId);
  const emitUsage = (extra = {}) => {
    const sessNow = store.get('sessions', sessionId) || session;
    const usage = sessNow.contextUsage || {};
    const promptTokens = Number(extra.promptTokens ?? usage.promptTokens) || 0;
    const source = extra.source || usage.source || (promptTokens ? 'estimate' : 'none');
    const ev = {
      type: 'context-usage',
      sessionId,
      promptTokens,
      completionTokens: Number(extra.completionTokens ?? usage.completionTokens) || 0,
      contextWindow,
      ratio: contextUsageRatio(promptTokens, contextWindow),
      threshold: COMPACT_RATIO,
      compacting: extra.compacting === true,
      source
    };
    try {
      onEvent(ev);
    } catch {
      /* UI listener must not fail the turn */
    }
    return ev;
  };

  async function maybeCompactHistory(allMessages, promptTokensHint) {
    const sessNow = store.get('sessions', sessionId);
    const compact = sessNow?.compact || null;
    const live = messagesAfterCompact(allMessages, compact);
    const estimated =
      Number(promptTokensHint) ||
      Number(sessNow?.contextUsage?.promptTokens) ||
      estimateTextTokens(system) +
        estimateTextTokens(worldBlock) +
        estimateMessagesTokens(compactPrefixMessages(compact)) +
        estimateMessagesTokens(live);
    if (
      !shouldCompact({
        promptTokens: estimated,
        contextWindow,
        messages: allMessages,
        compact
      })
    ) {
      emitUsage({ promptTokens: estimated, source: 'estimate' });
      return { compact, live, didCompact: false };
    }
    emitUsage({ promptTokens: estimated, compacting: true, source: 'estimate' });
    try {
      onEvent({ type: 'compacting', sessionId, contextWindow, promptTokens: estimated });
    } catch {
      /* ignore */
    }
    const packed = await runSessionCompact({
      store,
      sessionId,
      messages: allMessages,
      contextWindow,
      system,
      worldBlock,
      compact,
      promptTokens: estimated,
      model: await resolveSessionModel(input),
      callModel: input.callModel,
      signal: execution.abortSignal
    });
    try {
      onEvent({
        type: 'compact-done',
        sessionId,
        throughMessageId: packed.throughMessageId || packed.compact?.throughMessageId,
        contextWindow,
        promptTokens: estimated,
        text: packed.compact?.text || ''
      });
    } catch {
      /* ignore */
    }
    emitUsage({
      promptTokens:
        estimateTextTokens(packed.compact?.text) + estimateMessagesTokens(packed.live),
      source: 'estimate'
    });
    return packed;
  }

  /** @type {Promise<string>|null} */
  let titlePromise = null;
  try {
    const packed = await maybeCompactHistory(messages);
    const workspaceTail = [
      formatAgentsMdInstructions(readSessionAgentsMd(store, sessionId)),
      formatMemoryMdInstructions(readSessionMemoryMd(store, sessionId))
    ].filter(Boolean).join('\n\n');
    const history = attachWorldToLastUser(
      [...compactPrefixMessages(packed.compact), ...replayWireMessages(packed.live)],
      [worldBlock, workspaceTail].filter(Boolean).join('\n\n')
    );
    let finalText = '';
    /** @type {Array<object>} */
    let steps = [];
    /** @type {Array<object>} */
    let toolCallsLog = [];
    let mode = 'none';
    /** @type {Array<object>|null} */
    let resultWire = null;
    let resultReasoning = '';
    let resultUsage = { promptTokens: 0, completionTokens: 0 };
    let taskYielded = false;
    let taskStepLimitReached = false;
    let taskStepCount = 0;

    const model = await resolveSessionModel(input);
    const modelMeta = {
      id: String(input.modelId || model?.modelId || ''),
      provider: String(model?.provider || '')
    };
    titlePromise = shouldName
      ? generateTaskTitle({
          model,
          callModel: input.callModel,
          text: content
        })
          .then((named) => {
            if (!named) return named;
            try {
              onEvent({ type: 'session-title', title: named, sessionId });
            } catch {
              /* UI listener must not fail naming */
            }
            return named;
          })
          .catch((e) => {
            if (isAbortLike(e, execution.abortSignal)) return '';
            throw e;
          })
      : null;
    if (model) {
      const result = await runSessionToolLoopAgent({
        model,
        system,
        messages: history,
        tools,
        prepareStep: makeOfficePrepareStep({
          store,
          sessionId,
          fs,
          tools,
          execution,
          instructions: system,
          taskContext,
          getTaskContext: input.getTaskContext,
          mediaContext: input.mediaContext,
          mediaCapabilities: input.mediaCapabilities,
          contextWindow,
          progress: progressTracker,
          onMidLoopCompact: async ({ messages: sdkMessages, promptTokens }) => {
            const sessNow = store.get('sessions', sessionId);
            const mid = await maybeCompactHistory(sessNow?.messages || messages, promptTokens);
            const through = mid.throughMessageId || mid.compact?.throughMessageId;
            const toolBudget = Math.min(20000, Math.floor(contextWindow * 0.2));
            if (mid.didCompact) {
              return {
                messages: spliceCompactIntoSdkMessages(sdkMessages, mid.compact, through, toolBudget),
                throughMessageId: through
              };
            }
            const pruned = pruneSdkToolResults(sdkMessages, toolBudget);
            if (pruned !== sdkMessages) return { messages: pruned };
            return null;
          }
        }),
        taskContext,
        taskRun: input.taskRun === true,
        taskShouldYield: input.taskShouldYield,
        signal: execution.abortSignal,
        onEvent
      });
      finalText = result.finalText || '';
      steps = result.steps || [];
      toolCallsLog = result.toolCalls || [];
      mode = result.mode || 'ToolLoopAgent';
      resultWire = result.wire || null;
      resultReasoning = result.reasoning || '';
      resultUsage = harvestModelUsage(result.usage);
      taskYielded = result.taskYielded === true;
      taskStepLimitReached = result.taskStepLimitReached === true;
      taskStepCount = Number(result.taskStepCount) || 0;
    } else if (input.allowOfflineDirect === true) {
      // Explicit test/offline only — never silent fallback after user configured API
      finalText = defaultDirectAnswer(content, boundGroups, artifactIndex);
      mode = 'offline-direct';
    } else {
      // Product path without LanguageModel: fail loudly (UI shows error)
      const err = new Error(
        'NO_MODEL: 未连接到语言模型。请在设置中配置 API Key 与模型后重试。'
      );
      err.code = 'NO_MODEL';
      throw err;
    }

    const thought = String(resultReasoning || thoughtBuf || '').trim();
    const wire =
      Array.isArray(resultWire) && resultWire.length
        ? resultWire
        : buildWireFromTurn({
            thought,
            toolCalls: toolCallsLog,
            finalText
          });
    const endedAt = Date.now();
    const startedAt = Number(message.createdAt) || endedAt;
    if (!pathLog.some((p) => p.type === 'model') && (modelMeta.id || resultUsage.promptTokens)) {
      const otherMs = pathLog.reduce((n, p) => n + (Number(p.latencyMs) || 0), 0);
      const totalMs = Math.max(0, endedAt - startedAt);
      pathLog.unshift({
        type: 'model',
        name: 'llm',
        model: modelMeta.id,
        provider: modelMeta.provider,
        usage: resultUsage,
        synthetic: true,
        ts: startedAt,
        startedAt,
        endedAt,
        inferenceMs: Math.max(0, totalMs - otherMs),
        latencyMs: Math.max(0, totalMs - otherMs)
      });
    }
    const path = mergeBehaviorPath({
      path: pathLog,
      toolCalls: toolCallsLog,
      wire
    });
    const routedId = pickRoutedModelId(path, modelMeta);
    if (routedId) modelMeta.id = routedId;
    const wallMs = Math.max(0, endedAt - startedAt);
    const timing = splitTurnTiming(path, wallMs);
    const assistant = {
      messageId: createMessageId(),
      role: 'assistant',
      content: finalText,
      thought,
      status: 'completed',
      executionId: execution.executionId,
      progress: dropEchoedFinalNote(progressNotes, finalText),
      // Storage gets the bounded projection; the RPC return keeps the live
      // toolCallsLog for the current turn's UI traces.
      toolCalls: projectJsonForWire(toolCallsLog),
      path,
      wire,
      model: modelMeta,
      usage: resultUsage,
      timing,
      latencyMs: timing.totalMs,
      startedAt,
      endedAt,
      createdAt: endedAt
    };
    const sess2 = store.get('sessions', sessionId);
    let sessionTitle = sess2?.title || sess2?.name || session.title || session.name || '';
    if (titlePromise && !sess2?.titleLocked) {
      try {
        sessionTitle = (await titlePromise) || sessionTitle;
      } catch {
        /* keep placeholder */
      }
    }
    const estimatedTokens =
      estimateTextTokens(system) + estimateTextTokens(worldBlock) + estimateMessagesTokens(history);
    const fromApi = resultUsage.source === 'api' && resultUsage.promptTokens > 0;
    const promptTokens = fromApi ? resultUsage.promptTokens : estimatedTokens;
    const contextUsage = {
      promptTokens,
      completionTokens: resultUsage.completionTokens || 0,
      contextWindow,
      ratio: contextUsageRatio(promptTokens, contextWindow),
      source: fromApi ? 'api' : 'estimate',
      updatedAt: Date.now()
    };
    if (sess2 && store.has('sessions', sessionId)) {
      store.put('sessions', sessionId, {
        ...withoutTurnProgress(sess2),
        title: sessionTitle,
        name: sessionTitle,
        titleLocked: !!sess2?.titleLocked,
        messages: [...(sess2.messages || []), assistant],
        contextUsage,
        updatedAt: Date.now()
      });
    }
    emitUsage({
      promptTokens: contextUsage.promptTokens,
      completionTokens: contextUsage.completionTokens,
      source: contextUsage.source
    });

    settleExecution(store, execution, 'settled');
    try {
      onEvent({
        type: 'assistant-final',
        sessionId,
        executionId: execution.executionId,
        content: finalText
      });
      onEvent({
        type: 'execution-end',
        sessionId,
        executionId: execution.executionId,
        status: 'completed'
      });
    } catch {
      /* UI listener must not fail the turn */
    }

    return {
      message,
      assistant,
      executionId: execution.executionId,
      finalText,
      thought: assistant.thought,
      toolCalls: toolCallsLog,
      steps,
      createdTask: false,
      sessionTitle,
      contextUsage,
      boundGroups,
      artifactCount: getArtifactIndexCompact(store, sessionId).artifactCount,
      systemPromptPreview: system.slice(0, 200),
      sessionMessages: (store.get('sessions', sessionId)?.messages || []).length,
      agentMode: mode,
      taskYielded,
      taskStepLimitReached,
      taskStepCount
    };
  } catch (err) {
    if (titlePromise) void titlePromise.catch(() => {});
    const aborted = isAbortLike(err, execution.abortSignal);
    const endedAt = Date.now();
    const startedAt = Number(message.createdAt) || endedAt;
    try {
      recordBehaviorEvent(pathLog, {
        type: 'error',
        name: aborted ? 'AbortError' : err?.name ? String(err.name) : 'Error',
        message: formatRpcError(err).slice(0, 400),
        code: aborted ? USER_STOP : String(err?.code || 'ERROR')
      });
      recordBehaviorEvent(pathLog, {
        type: 'execution-end',
        sessionId,
        executionId: execution.executionId,
        status: aborted ? 'aborted' : 'failed'
      });
      if (String(err?.code || '') === 'SYS_TIMEOUT') {
        onEvent({
          type: 'deadline',
          sessionId,
          executionId: execution.executionId,
          code: 'SYS_TIMEOUT'
        });
      }
      const sessFail = store.get('sessions', sessionId);
      const path = mergeBehaviorPath({ path: pathLog });
      const failTiming = splitTurnTiming(path, Math.max(0, endedAt - startedAt));
      const failAssistant = {
        messageId: createMessageId(),
        role: 'assistant',
        content: '',
        thought: String(thoughtBuf || '').trim(),
        status: aborted ? 'aborted' : 'failed',
        executionId: execution.executionId,
        progress: progressNotes,
        error: {
          code: aborted ? USER_STOP : String(err?.code || 'ERROR'),
          message: formatRpcError(err).slice(0, 500)
        },
        toolCalls: [],
        path,
        wire: [],
        timing: failTiming,
        latencyMs: failTiming.totalMs,
        startedAt,
        endedAt,
        createdAt: endedAt
      };
      if (sessFail && store.has('sessions', sessionId)) {
        store.put('sessions', sessionId, {
          ...withoutTurnProgress(sessFail),
          messages: [...(sessFail.messages || []), failAssistant],
          updatedAt: Date.now()
        });
      }
    } catch {
      /* audit persist must not hide the original error */
    }
    settleExecution(store, execution, aborted ? 'aborted' : 'failed');
    try {
      onEvent({
        type: 'execution-end',
        sessionId,
        executionId: execution.executionId,
        status: aborted ? 'aborted' : 'failed'
      });
    } catch {
      /* UI listener must not fail the turn */
    }
    if (aborted) {
      const e = toAbortError(err);
      e.executionId = execution.executionId;
      throw e;
    }
    const wrapped = err instanceof Error && err.message && err.message !== '[object Object]'
      ? err
      : new Error(formatRpcError(err));
    if (wrapped !== err && err?.code) wrapped.code = err.code;
    throw wrapped;
  }
}

/** The settled assistant record owns the notes; drop the in-flight slot. */
function withoutTurnProgress(sess) {
  if (!sess || !('turnProgress' in sess)) return sess;
  const { turnProgress: _settled, ...rest } = sess;
  return rest;
}

/**
 * Resolve LanguageModel for ToolLoopAgent.
 * Priority: explicit model → callModel adapter (tests) → null (offline).
 * Product service injects real LanguageModel via createBrowserBotLanguageModel.
 *
 * @param {{ model?: any, callModel?: Function }} input
 */
async function resolveSessionModel(input) {
  if (input.model) return input.model;
  if (typeof input.callModel === 'function') {
    return createCallModelLanguageModel(input.callModel);
  }
  return null;
}

function defaultDirectAnswer(content, boundGroups, artifactIndex) {
  const q = String(content || '').trim();
  if (!q) return '';
  const ambient =
    boundGroups?.length > 0
      ? ` (${boundGroups.length} group(s) bound as ambient context; not auto-inspected)`
      : '';
  const arts =
    artifactIndex?.artifactCount > 0 ? ` Session has ${artifactIndex.artifactCount} artifact(s).` : '';
  return `Acknowledged.${ambient}${arts} ${q.length > 200 ? q.slice(0, 200) + '…' : q}`;
}
