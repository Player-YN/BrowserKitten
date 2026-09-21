/**
 * Session Workspace Runtime — public API surface.
 */

export { SessionWorkspaceStore } from './store.js';
export {
  DurableSessionWorkspaceStore,
  createDurableSessionWorkspaceStore,
  __resetDurableMemoryBackends
} from './durableStore.js';
export { createSessionGuestFs, normalizeGuest } from './fs.js';
export {
  createGroup,
  renameGroup,
  nextGroupName,
  normalizeGroupName,
  groupNameKey,
  CLIPBOARD_GROUP_KIND,
  CLIPBOARD_GROUP_NAME,
  isClipboardGroup,
  isReservedClipboardName,
  ensureClipboardGroup,
  pinClipboardItems,
  clearClipboardGroup,
  isClipboardTextPick,
  groupVisibleToSession,
  readActiveCaptureGroupId,
  writeActiveCaptureGroupId,
  findOrCreateNamedGroup,
  addWebItem,
  updateWebItem,
  removeWebItem,
  deleteGroup,
  bindGroupsToSession,
  getBoundGroupsCompact,
  listGroupItems,
  selectionIdentityKey
} from './groups.js';
export { beginExecution, acquireLease, settleExecution, isWebItemLeased } from './execution.js';
export {
  createArtifact,
  updateArtifactContent,
  revertArtifactContent,
  listArtifacts,
  getArtifactIndexCompact,
  deleteArtifact,
  writePackageFile,
  registerWrittenArtifacts,
  bytesFromBase64,
  bytesFromRpcContent,
  safeArtifactFileName
} from './artifacts.js';
export {
  buildShelfView,
  compactShelfSnapshot,
  inferArtifactShelfFolder,
  setArtifactFolder,
  setShelfMeta,
  shelfFolderLabel,
  folderCollapsedByDefault
} from './artifactShelf.js';
export { blankArtifactPayload, BLANK_KINDS } from './blankCreate.js';
export {
  gcUnreachableWebItems,
  applyStoragePressure,
  deleteSessionCascade,
  sweepOrphanScratch
} from './gc.js';
export {
  assertGroupReadable,
  assertItemReadable,
  assertArtifactOwned,
  isGroupBoundToSession,
  isItemBoundToSession
} from './auth.js';
export { validateArtifactBytes } from './artifactValidate.js';
export {
  classifyOpenArtifact,
  previewEntryForKind,
  previewEntryForItem,
  looksLikeZipBytes,
  looksLikePdfBytes,
  isUtf8OpenKind
} from './openClassify.js';
export {
  capabilityForItem,
  resolveArtifactCapability,
  previewViewForItem,
  inspectorMeta,
  PRIMARY_FAMILIES
} from './artifactCapability.js';
export { sendMessage } from './sendMessage.js';
export {
  serializeBehaviorTrajectory,
  mergeBehaviorPath,
  pathFromToolCalls,
  pathFromWire,
  pickRoutedModelId,
  splitTurnTiming,
  recordBehaviorEvent,
  compactTurnContext,
  BEHAVIOR_TRAJECTORY_SCHEMA,
  MAX_THOUGHT_CHARS,
  MAX_TURN_THOUGHT_CHARS
} from './behaviorPath.js';
export { createSession, getSession, deleteSession, ensureSession } from './sessionApi.js';
export {
  SESSION_TITLE_MAX,
  normalizeSessionTitle,
  isPlaceholderTaskTitle,
  nextTaskTitle,
  shrinkPromptTitle,
  generateTaskTitle
} from './taskTitle.js';
export { buildSessionAgentInstructions, buildWorldStateBlock, SYSTEM_PROMPT_VERSION } from './prompt.js';
export {
  SESSION_AGENTS_PATH,
  SESSION_MEMORY_PATH,
  SESSION_STATUS_PATH,
  ensureSessionAgentsMd,
  ensureSessionWorkspaceFiles,
  formatAgentsMdInstructions,
  formatMemoryMdInstructions,
  readSessionAgentsMd,
  readSessionMemoryMd
} from './sessionAgentsMd.js';
export {
  appendSessionAudit,
  readSessionAudit,
  SESSION_AUDIT_SCHEMA,
  TRAJECTORY_THOUGHT_WARNING
} from './sessionAudit.js';
export {
  normalizePageRef,
  resolveFocusPage,
  rememberVisitedPage,
  listVisitedPages,
  isInjectableTabUrl,
  classifyWorkTab,
  isBrowserBotTabUrl,
  workTabListenLabel,
  PAGES_MENTION_ID
} from './pageContext.js';
export {
  buildWireFromTurn,
  replayWireMessages,
  attachWorldToLastUser,
  createWireRecorder,
  projectJsonForWire,
  projectWireForDownload,
  WIRE_MAX_ARRAY
} from './wireTranscript.js';
export {
  COMPACT_RATIO,
  shouldCompact,
  findCompactCutIndex,
  findCompactCutByBudget,
  messagesAfterCompact,
  compactPrefixMessages,
  extractiveCompactText,
  packFoldedTurnsForSummary,
  generateCompactText,
  runSessionCompact,
  freezeSessionGoal,
  formatSessionGoalInstructions,
  isGreetingOrFiller,
  firstRequestLikeUserText,
  contextUsageRatio,
  estimateTextTokens,
  estimateMessagesTokens
} from './contextCompact.js';
export {
  classifyArtifactSelection,
  seedPlatesFromArtifacts,
  platesToMarkedHtml,
  isImageArtifact,
  isMarkedPreviewHtml
} from './artifactStage.js';
export { platesToPptxBytes, buildZipStore, PPTX_CONTENT_TYPE } from './pptxExport.js';
export { exportPlates, EXPORT_FORMATS, platesToDocxBytes } from './artifactExport.js';
export { platesToPrintHtml, detectHtmlKind } from './printHtml.js';
export {
  resolveHtmlUpsertTarget,
  alignBoxes,
  isArtboardKind,
  htmlKindFromMarkup
} from './htmlArtboard.js';
export { createSessionTools, toOpenAiToolsArray, createCodeFsBridge } from './tools.js';
export { createGuestSys, wrapSysFromCall, SYS_HELP, SYS_OPS, SYS_MODEL_HINT } from './browserSys.js';
export {
  inventoryFromSession,
  classifyCanvasKind,
  KERNEL_TOOL_NAMES,
  OFFICE_TOOL_NAMES,
  SESSION_TOOL_NAMES
} from './canvasInventory.js';
export { scheduleActiveToolNames, scheduleSessionTools, makeOfficePrepareStep } from './toolSchedule.js';
export { createOfficeTools } from './officeTools.js';
export {
  sessionToolToModelOutput,
  PREVIEW_MAX_FRAMES
} from './canvasPreview.js';
export {
  stampSiteHtml,
  listSiteNodes,
  applySiteCommands,
  pinnedSiteIds,
  nextSitePinIds,
  siteSelectionsFromIds,
  formatSiteSelLabel
} from './siteApply.js';
export { sanitizeSiteHtml, siteHtmlLooksExecutable } from './siteSanitize.js';
export {
  SITE_MOTION_CAPABILITY,
  SITE_MOTION_CLAMPS,
  SITE_MOTION_ATTRS,
  SITE_MOTION_UNSUPPORTED,
  clampMotionNumber,
  parseTimeMs,
  nextCarouselIndex
} from './siteMotionSchema.js';
export { annotateSiteMotionBlueprint, detectUnsupported } from './siteMotionBlueprint.js';
export { htmlWritePolicy, looksLikeVisualCanvasPayload } from './htmlWritePolicy.js';
export {
  SITE_QA_VERSION,
  SITE_QA_CODES,
  assessSiteClone,
  compactSiteQaReport
} from './siteQa.js';
export { pageTextByCodePoint, pageBytes } from './textPage.js';
export {
  normalizePageBlueprint,
  compactBlueprintSummary,
  storePageBlueprint
} from './pageBlueprint.js';
export {
  SITE_CLONE_LIMITS,
  AMBIGUOUS_SITE,
  stripActiveContent,
  compileSiteClone,
  runSiteClone,
  resolveSiteCloneTarget,
  WEB_CLONE_DESCRIPTION
} from './siteClone.js';
export {
  AMBIGUOUS_CANVAS,
  AMBIGUOUS_WORKBOOK,
  resolveVisualCreateTarget,
  resolveWorkbookCreateTarget,
  rememberVisualCreation,
  clearVisualCreationLedger,
  normalizeSceneKind,
  normalizeCreationKind
} from './visualCreationLedger.js';
export {
  hydrateSheetImageCommands,
  hydrateOfficeImageCommands,
  expandOmittedImageCommands,
  resolveOfficeAsset
} from './sheetImageHydrate.js';
export {
  createMemorySkillStore,
  getDurableSkillStore,
  setDurableSkillStore,
  mergeSkillCatalog,
  skillRecordFromMarkdown,
  importSkillFromUrl,
  githubSkillUrls,
  normalizeDurableSkill,
  writeSkillPackToGuest,
  sanitizeSkillId
} from './skillStore.js';
export { listCapabilities, invoke as invokeCapability } from './capabilityCatalog.js';
export {
  waitForClarifyAnswer,
  answerClarify,
  abortSessionClarifies,
  normalizeClarifyQuestions,
  newClarifyId,
  pendingClarifyCount
} from './clarifyGate.js';
export {
  normalizePlan,
  normalizePlanStep,
  isPlanApproved,
  classifyPlanDecision,
  wantsDurableTaskFromPlan,
  planRevisionNotes,
  userRequestedPlan,
  formatFrozenPlanInstructions,
  pinFrozenPlan,
  unpinFrozenPlan
} from './planContract.js';
export {
  normalizeContractDraft,
  contractFingerprint,
  getActiveTaskId,
  setActiveTaskId,
  clearActiveTaskId
} from './taskContract.js';
export {
  userRequestedLearn,
  extractLearnableTurn,
  sanitizeLearnTrajectory,
  runLearnTurn,
  learnedReuseBlocked,
  persistLearnedSkill
} from './learnFromTrajectory.js';
export { ensureItemPixels, itemBlobKey } from './itemPixels.js';
export {
  classifyLabelKind,
  formatItemLabel,
  itemHandle,
  itemAliases,
  normalizeItemHandle,
  allocateLabelN,
  maxLiveLabelN,
  findItemGroupId,
  ensureItemLabel,
  listBoundItemIndex,
  resolveBoundItemRef
} from './itemLabel.js';
export {
  PAGE_ITEM_CAP,
  PAGE_KIND,
  addPageItems,
  parseHttpUrls,
  normalizePageUrl,
  pageUrlOf,
  isPageItem,
  resolvePageUrlAlias,
  resolveAcquireFetch,
  formatPageAddSummary,
  truncateDisplayUrl
} from './pageItems.js';
export { createLiveProgressState, applyLiveProgress, clipCommentary } from './liveProgress.js';
export {
  runSessionToolLoopAgent,
  wrapSessionToolsForSdk,
  createCallModelLanguageModel,
  repairSessionToolCall
} from './sessionAgent.js';

import { SessionWorkspaceStore } from './store.js';
import { createSession, ensureSession, deleteSession, getSession } from './sessionApi.js';
import { sendMessage } from './sendMessage.js';
import {
  createGroup,
  renameGroup,
  addWebItem,
  updateWebItem,
  bindGroupsToSession,
  getBoundGroupsCompact,
  listGroupItems,
  deleteGroup,
  removeWebItem,
  selectionIdentityKey,
  ensureClipboardGroup,
  pinClipboardItems,
  clearClipboardGroup
} from './groups.js';
import { addPageItems } from './pageItems.js';
import { createSessionGuestFs } from './fs.js';
import {
  createArtifact,
  updateArtifactContent,
  revertArtifactContent,
  listArtifacts,
  getArtifactIndexCompact,
  deleteArtifact
} from './artifacts.js';
import { gcUnreachableWebItems, applyStoragePressure, sweepOrphanScratch } from './gc.js';
import { beginExecution, settleExecution, acquireLease } from './execution.js';

/**
 * Convenience runtime facade for product + tests.
 */
export function createSessionWorkspaceRuntime(store = new SessionWorkspaceStore()) {
  return {
    store,
    createSession: (opts) => createSession(store, opts),
    ensureSession: (sessionId) => ensureSession(store, sessionId),
    getSession: (sessionId) => getSession(store, sessionId),
    deleteSession: (sessionId) => deleteSession(store, sessionId),
    sendMessage: (input) => sendMessage(store, input),
    createGroup: (opts) => createGroup(store, opts),
    renameGroup: (groupId, name) => renameGroup(store, groupId, name),
    ensureClipboardGroup: (sessionId) => ensureClipboardGroup(store, sessionId),
    pinClipboardItems: (items, sessionId) => pinClipboardItems(store, items, sessionId),
    clearClipboardGroup: (sessionId) => clearClipboardGroup(store, sessionId),
    addWebItem: (groupId, capture) => addWebItem(store, groupId, capture),
    addPageItems: (groupId, raw, opts) => addPageItems(store, groupId, raw, opts),
    updateWebItem: (webItemId, capture) => updateWebItem(store, webItemId, capture),
    selectionIdentityKey,
    removeWebItem: (groupId, webItemId) => {
      const r = removeWebItem(store, groupId, webItemId);
      gcUnreachableWebItems(store);
      return r;
    },
    deleteGroup: (groupId) => {
      const r = deleteGroup(store, groupId);
      gcUnreachableWebItems(store);
      return r;
    },
    bindGroups: (sessionId, groupIds) => bindGroupsToSession(store, sessionId, groupIds),
    getBoundGroupsCompact: (sessionId) => getBoundGroupsCompact(store, sessionId),
    listGroupItems: (groupId) => listGroupItems(store, groupId),
    guestFs: (sessionId, executionId) => createSessionGuestFs(store, { sessionId, executionId }),
    createArtifact: (fs, input) => createArtifact(store, fs, input),
    updateArtifact: (fs, sessionId, artifactId, content, opts) =>
      updateArtifactContent(store, fs, sessionId, artifactId, content, opts),
    revertArtifact: (fs, sessionId, artifactId) =>
      revertArtifactContent(store, fs, sessionId, artifactId),
    listArtifacts: (sessionId) => listArtifacts(store, sessionId),
    getArtifactIndexCompact: (sessionId, opts) => getArtifactIndexCompact(store, sessionId, opts),
    deleteArtifact: (fs, sessionId, artifactId) => deleteArtifact(store, fs, sessionId, artifactId),
    gcUnreachableWebItems: () => gcUnreachableWebItems(store),
    sweepOrphanScratch: () => sweepOrphanScratch(store),
    applyStoragePressure: (opts) => applyStoragePressure(store, opts),
    beginExecution: (sessionId, opts) => beginExecution(store, sessionId, opts),
    settleExecution: (ctx, status) => settleExecution(store, ctx, status),
    acquireLease: (ctx, ids) => acquireLease(store, ctx, ids),
    exportSnapshot: () => store.exportSnapshot(),
    importSnapshot: (snap) => store.importSnapshot(snap)
  };
}
