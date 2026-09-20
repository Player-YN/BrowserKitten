/**
 * ★ ONLY product entry for Session Workspace Runtime agent turns.
 *
 * Sidepanel / host must use this surface (via workspaceRpc → SessionWorkspaceService).
 */

export {
  createSessionWorkspaceRuntime,
  SessionWorkspaceStore,
  DurableSessionWorkspaceStore,
  createDurableSessionWorkspaceStore,
  __resetDurableMemoryBackends,
  sendMessage,
  createSession,
  ensureSession,
  deleteSession,
  SESSION_TITLE_MAX,
  normalizeSessionTitle,
  isPlaceholderTaskTitle,
  nextTaskTitle,
  shrinkPromptTitle,
  generateTaskTitle,
  COMPACT_RATIO,
  shouldCompact,
  findCompactCutIndex,
  findCompactCutByBudget,
  contextUsageRatio,
  bindGroupsToSession,
  getBoundGroupsCompact,
  createGroup,
  renameGroup,
  nextGroupName,
  addWebItem,
  buildSessionAgentInstructions,
  buildWorldStateBlock,
  buildWireFromTurn,
  replayWireMessages,
  attachWorldToLastUser,
  createWireRecorder,
  serializeBehaviorTrajectory,
  mergeBehaviorPath,
  classifyArtifactSelection,
  seedPlatesFromArtifacts,
  platesToMarkedHtml,
  platesToPptxBytes,
  exportPlates,
  answerClarify,
  waitForClarifyAnswer,
  normalizeClarifyQuestions,
  createLiveProgressState,
  applyLiveProgress,
  clipCommentary
} from './sessionWorkspace/index.js';

/**
 * Sanity marker for static gates.
 */
export const PRODUCT_RUNTIME = 'session-workspace';
export const PRODUCT_ENTRY = 'runSession.product.js';
export const PRODUCT_STORE = 'durable-session-workspace';
