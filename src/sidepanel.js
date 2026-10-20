// Bundled agent entry (Vercel AI SDK + tools). Rebuild: npm run build:agent
import {
  loadLlmSettings,
  loadProvidersState,
  setActiveProviderId,
  setActiveProviderModel,
  setActiveProviderImageModel,
  upsertProvider,
  deleteProvider,
  generateProviderId,
  PROVIDER_PRESETS,
  DEFAULT_BASE,
  OPENROUTER_API_BASE,
  DEFAULT_IMAGE_PROTOCOL,
  DEFAULT_IMAGE_PATH,
  DEFAULT_IMAGE_MODEL,
  defaultImageConfig
} from './agent/llm.js';
import {
  loadWebAcquireSettings,
  saveWebAcquireSettings
} from './agent/webAcquireSettings.js';
// Product Session Workspace Runtime lives in the offscreen document.
import { workspaceRpc } from './agent/vnext/host/workspaceClient.js';
import {
  classifyLabelKind,
  formatItemLabel
} from './agent/vnext/sessionWorkspace/itemLabel.js';
import { hrefLooksDownloadable, clipClipboardText, isClipboardTextPick } from './agent/vnext/sessionWorkspace/pickContext.js';
import { SESSION_TITLE_MAX } from './agent/vnext/sessionWorkspace/taskTitle.js';
import {
  buildMentionCandidates,
  nestMentionCandidates,
  normalizeComposerMentions,
  abbrevTabTitle,
  WORKSPACE_MENTION_ID,
  PAGES_MENTION_ID
} from './sidepanel/composerMentions.js';
import { buildSkillCandidates } from './sidepanel/composerSkills.js';
import {
  isInjectableTabUrl,
  normalizePageRef,
  classifyWorkTab,
  isPawWorkTabUrl,
  workTabListenLabel,
  pageRefId
} from './agent/vnext/sessionWorkspace/pageContext.js';
import {
  shouldApplySessionBroadcast,
  sessionThreadShouldHide,
  clarifyBelongsToSession,
  mergeSessionTranscriptMessages,
  pendingThreadMessages
} from './sidepanel/sessionIsolation.js';
import { readActiveExecution, isExecutionLive } from './sidepanel/executionSync.js';
import {
  nextGroupName,
  groupNameKey,
  isClipboardGroup,
  CLIPBOARD_GROUP_KIND
} from './agent/vnext/sessionWorkspace/groups.js';
import {
  createLiveProgressState,
  applyLiveProgress
} from './agent/vnext/sessionWorkspace/liveProgress.js';
import { buildZipStore } from './agent/vnext/sessionWorkspace/pptxExport.js';
import {
  buildShelfView,
  folderCollapsedByDefault,
  shelfFolderLabel
} from './agent/vnext/sessionWorkspace/artifactShelf.js';
import {
  loadUserSkills,
  upsertUserSkill,
  deleteUserSkill,
  findSkill,
  skillFromRunSnapshot
} from './agent/skills.js';
import {
  DEFAULT_CAPTURE_SHORTCUT,
  STORAGE_PENDING_SCREENSHOT,
  MSG as CAPTURE_MSG,
  isKnownTextOnlyChatModel,
  notMultimodalMessage,
  attachmentFromDataUrl,
  copyDataUrlToClipboard,
  hasImageAttachments,
  loadCaptureShortcut,
  saveCaptureShortcut
} from './screenshot.js';
import { createSmoothStreamRenderer } from './smoothStream.js';
import {
  DEV_TRAJECTORY_STORAGE_KEY,
  ensureSessionTrajectory,
  setSessionHumanStatus,
  serializeBehaviorTrajectory,
  trajectoryToDownloadJson,
  trajectoryDownloadFilename,
  normalizeHumanStatus
} from './agent/trajectory.js';
import { SYSTEM_PROMPT_VERSION } from './agent/vnext/sessionWorkspace/prompt.js';
import {
  cacheModelsForBase,
  loadCachedModelsForBase,
  refreshAndCacheModels,
  probeOpenAICompatibleApi,
  shrinkModelList,
  chatModelsFromList,
  imageModelsFromList,
  fetchImageGenModels,
  findCatalogModel,
  resolveContextWindow,
  effortLevelsForReasoning,
  GATEWAY_REASONING_EFFORTS,
  pushRecentModel,
  buildProviderPickerGroups,
  formatModelChipLabel,
  filterPickerGroup,
  shortModelId,
  applyProviderProbeResult
} from './agent/modelCatalog.js';
import {
  pinItems as pinClipboardItemsToStore,
  listItems as listClipboardItemsFromStore,
  removeIds as removeClipboardIdsFromStore,
  clear as clearClipboardStore
} from './agent/clipboardStore.js';
import {
  loadDraft,
  purgeDraft,
  listDrafts,
  saveDraft
} from './agent/draftStore.js';
import { renderDocumentFromDraft, RENDER_FORMATS } from './agent/documentRender.js';
import { getArtifact, bytesToDataUrl } from './agent/artifacts.js';
import { $, escapeHtml, sanitizeModelHtml, truncateUi } from './sidepanel/dom.js';
import { parseOfficeMarkdown } from './markdown/officeMarkdown.js';
import {
  cycleThemeMode,
  hydrateThemeFromStorage,
  getResolvedTheme
} from './sidepanel/theme.js';
import { applySendStopUi } from './sidepanel/sendStop.js';
import { enhanceComposerIcons, enhanceTopbarIcons, pawSvg, ICONS } from './sidepanel/icons.js';
import {
  registerHoverDrawer,
  wireDrawerEscape,
  setDrawerPinned,
  closeDrawer,
  holdDrawerOpen
} from './sidepanel/hoverDrawer.js';
import {
  openDialog,
  closeDialog,
  wireDialogChrome
} from './sidepanel/dialog.js';
import {
  setupSidepanelWheelRelay,
  setupTaskStreamScrollAffordances
} from './sidepanel/scroll.js';
import { I18N, createT } from './sidepanel/i18n.js';
import { formatTabLeaseMessage, tabLeasePayload } from './sidepanel/tabLeaseUi.js';
import { createTrajectoryUi } from './sidepanel/trajectoryUi.js';
import { wirePopoverMenu } from './sidepanel/popoverMenu.js';
import { setupPanelDensity } from './sidepanel/density.js';
import { createTaskStatusUi } from './sidepanel/taskStatus.js';
// Single-agent only — no worker spawn/cancel/message tools.

/** Product path is vNext-only. Legacy tool-loop has no UI entry. */
const RUNTIME_MODE_STORAGE_KEY = 'pagewand_runtime_mode'; // legacy key ignored if present

let isPickerActive = false;
let selectedElementsSummary = [];
let userCustomShortcut = 'Alt+S';
let selectedModel = 'deepseek-v4-flash';
/** Active image-gen model id on the current provider; empty when image API is off. */
let selectedImageModel = '';
/** OpenRouter reasoning.effort; `none` = thinking off */
let reasoningEffort = 'none';
/** @type {import('./agent/modelCatalog.js').ModelEntry[]} */
let catalogModels = [];
/** Resolved theme mirror (source of truth: sidepanel/theme.js) */
let currentTheme = 'dark';
let sessions = [{ id: 'session-1', name: '任务 1', messages: [] }];
let activeSessionId = 'session-1';
let currentLang = 'zh';
let pendingAttachments = [];
let isBackendOnline = false;
let isAgentRunning = false;
/** @type {AbortController|null} */
let currentAgentAbort = null;
/** @type {Map<string, object>} */
const sessionUi = new Map();

function emptySheetSel(sid) {
  return {
    sessionId: String(sid || ''),
    artifactId: '',
    name: '',
    kind: '',
    source: '',
    selections: []
  };
}

function emptySessionUi(sid) {
  return {
    liveTask: null,
    liveTurnThink: null,
    liveTurnThinkFromStream: false,
    liveTurnWrap: null,
    liveTurnAnswerText: '',
    liveTurnAnswerEl: null,
    liveProgressState: null,
    liveTurnProgressEl: null,
    abort: null,
    executionId: null,
    running: false,
    composerHtml: '',
    attachments: [],
    selectedArtifactIds: [],
    sheetSel: emptySheetSel(sid),
    pendingClarify: null,
    liveTurnSealed: false,
    liveTurnRenderTimer: 0,
    promptQueue: []
  };
}

function uiState(sid) {
  const id = String(sid || '');
  if (!id) return emptySessionUi('');
  if (!sessionUi.has(id)) sessionUi.set(id, emptySessionUi(id));
  return sessionUi.get(id);
}

function isCurrentSessionRunning() {
  return !!uiState(getWorkspaceSessionId()).running;
}

/** Session whose live globals are currently applied (foreground, or withSessionLive target). */
let liveSessionOverride = '';
function getLiveSessionId() {
  return String(liveSessionOverride || getWorkspaceSessionId());
}

function snapshotLiveGlobals() {
  return {
    liveTask,
    liveTurnThink,
    liveTurnThinkFromStream,
    liveTurnWrap,
    liveTurnAnswerText,
    liveTurnAnswerEl,
    liveProgressState,
    liveTurnProgressEl,
    currentAgentAbort,
    currentWorkspaceTaskId,
    liveTurnSealed
  };
}

function applyLiveGlobals(g = {}) {
  liveTask = g.liveTask || null;
  liveTurnThink = g.liveTurnThink || null;
  liveTurnThinkFromStream = g.liveTurnThinkFromStream === true;
  liveTurnWrap = g.liveTurnWrap || null;
  liveTurnAnswerText = g.liveTurnAnswerText || '';
  liveTurnAnswerEl = g.liveTurnAnswerEl || null;
  liveProgressState = g.liveProgressState || null;
  liveTurnProgressEl = g.liveTurnProgressEl || null;
  currentAgentAbort = g.currentAgentAbort || g.abort || null;
  currentWorkspaceTaskId = g.currentWorkspaceTaskId || g.executionId || null;
  liveTurnSealed = g.liveTurnSealed === true;
}

function stashLiveToSession(sid) {
  const id = String(sid || '');
  if (!id) return;
  const u = uiState(id);
  Object.assign(u, snapshotLiveGlobals());
  u.abort = currentAgentAbort;
  u.executionId = currentWorkspaceTaskId;
  try {
    u.composerHtml = composerEl()?.innerHTML || '';
  } catch {
    u.composerHtml = u.composerHtml || '';
  }
  u.attachments = Array.isArray(pendingAttachments) ? pendingAttachments.slice() : [];
  u.selectedArtifactIds = [...selectedArtifactIds];
  u.sheetSel = { ...sheetSelState, sessionId: id };
  if (clarifyLiveState && clarifyBelongsToSession(clarifyLiveState.sessionId || id, id)) {
    u.pendingClarify = {
      type: 'clarify',
      sessionId: id,
      clarifyId: clarifyLiveState.clarifyId,
      questions: clarifyLiveState.questions,
      ...(clarifyLiveState.kind ? { kind: clarifyLiveState.kind } : {}),
      ...(clarifyLiveState.plan ? { plan: clarifyLiveState.plan } : {})
    };
  }
}

function loadLiveFromSession(sid) {
  const u = uiState(sid);
  applyLiveGlobals(u);
  pendingAttachments = Array.isArray(u.attachments) ? u.attachments.slice() : [];
  selectedArtifactIds.clear();
  for (const id of u.selectedArtifactIds || []) selectedArtifactIds.add(id);
  sheetSelState = u.sheetSel && typeof u.sheetSel === 'object'
    ? { ...emptySheetSel(sid), ...u.sheetSel, sessionId: sid }
    : emptySheetSel(sid);
}

function hideForeignSessionThreads(activeId) {
  const keep = String(activeId || '');
  const liveEl = uiState(keep).liveTask?.el || null;
  const stream = $('taskStream');
  stream?.querySelectorAll('.session-thread, .task-card').forEach((el) => {
    const sid = String(el.dataset.sessionId || '');
    if (el === liveEl) {
      el.hidden = false;
      if (keep && !sid) el.dataset.sessionId = keep;
      return;
    }
    el.hidden = sessionThreadShouldHide(sid, keep);
  });
  for (const [id, u] of sessionUi) {
    if (u.liveTask?.el) u.liveTask.el.hidden = id !== keep;
  }
}

function mountSessionThreadEl(el, sessionId) {
  if (!el) return null;
  const sid = String(sessionId || '');
  const stream = $('taskStream');
  if (sid) el.dataset.sessionId = sid;
  if (stream && !el.isConnected) stream.appendChild(el);
  el.hidden = false;
  return el;
}

function dedupeSessionThreads(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const stream = $('taskStream');
  const nodes = [...(stream?.querySelectorAll('.session-thread, .task-card') || [])].filter(
    (el) => String(el.dataset.sessionId || '') === sid
  );
  const preferred = uiState(sid).liveTask?.el;
  const keep = preferred || nodes[nodes.length - 1] || null;
  for (const n of nodes) {
    if (keep && n !== keep) n.remove();
  }
  if (keep) mountSessionThreadEl(keep, sid);
  return keep;
}

function withSessionLive(sid, fn) {
  const target = String(sid || '');
  if (!target || target === getWorkspaceSessionId()) return fn();
  const saved = snapshotLiveGlobals();
  const prevLive = liveSessionOverride;
  liveSessionOverride = target;
  loadLiveFromSession(target);
  try {
    return fn();
  } finally {
    stashLiveToSession(target);
    applyLiveGlobals(saved);
    liveSessionOverride = prevLive;
  }
}
/** Answer token when Stop aborts a pending ask_user gate */
const ASK_USER_STOP_ANSWER = '__STOP__';
/**
 * Run-scoped ask_user gates (P0-6). Keyed by runKey; one gate per live session.
 * @type {Map<string, { resolve: (answer: string) => void, host: HTMLElement|null, gateId: string }>}
 */
const pendingAskUserGates = new Map();
/** Legacy singleton resolver — stream-rendered interactive popcards also use this */
let pendingAskUserResolve = null;
let lastAgentRunMeta = null;
let devTrajectoryExportEnabled = true;
let scriptTrustThisSession = false;
const SCRIPT_CONFIRM_TIMEOUT_MS = 120000;
let currentActivePageMeta = null;
/** @type {{ url: string, title: string, origin: string, host: string }|null} */
let lastActivePage = null;
/** Live http(s) tabs from SW (`workspace_list_open_tabs`). Not visitedPages. */
let openMentionPages = [];
let crossTabStore = new Map();
let workspaceGroupState = { groups: [], activeGroupId: null, boundGroupIds: [] };
/** Composer submit mode: default chat; toggle switches the up-arrow to run. */
let composerSubmitMode = 'chat';
let currentWorkspaceTaskId = null;
let lastArtifactEvent = null;
let pendingArtifactPreview = null;
const ARTIFACT_PREVIEW_SAMPLE_CHARS = 3500;
const ARTIFACT_PREVIEW_SAMPLE_LINES = 48;
let lastGeneratedImage = null;
let lastCaptureAttachKey = '';
let lastCaptureAttachAt = 0;

/**
 * Settings form state (single active provider). Declared at module top to avoid TDZ
 * when async openers / late listeners touch it during boot.
 * @type {{
 *   providerId: string|null,
 *   providerName: string,
 *   hasStoredKey: boolean,
 *   keyTail: string,
 *   createdAt: number|null
 * }}
 */
let settingsConfigUi = {
  providerId: null,
  providerName: 'DeepSeek',
  hasStoredKey: false,
  keyTail: '',
  createdAt: null
};
/** Which inference provider the image editor is attached to. */
let settingsImageUi = { providerId: null, hasStoredKey: false, keyTail: '' };
/** Web-acquire editor vendor: tavily | brave | firecrawl */
let settingsWebUi = { kind: 'tavily' };

/** @deprecated legacy name kept as alias so old partial code paths never TDZ */
const settingsProviderUi = settingsConfigUi;

/** Lightweight catalog stub (full UI removed; refresh still may touch baseURL) */
const chatModelCatalogUi = {
  models: [],
  recent: [],
  favorites: [],
  query: '',
  fetching: false,
  lastFetchedAt: null,
  baseURL: ''
};

/** @type {{id:number,title:string,state:string,bodyHTML:string}[]} */
let historyRecords = [];
/** History list starts collapsed; user expands to see past tasks. */
let historyListExpanded = false;
/** @type {{ draftId?: string, artifactId?: string, format?: string, name?: string, version?: number, rendered?: boolean }|null} */
let activeDraftUi = null;
/** Coalesce concurrent open_draft_preview for the same draft (materialize + onDraftReady). */
/** @type {Map<string, Promise<{ok?: boolean, message?: string, coalesced?: boolean, tabId?: number, reused?: boolean}>>} */
const previewOpenInflight = new Map();
let liveTask = null;
/** @type {{ bytes: number, fileCount: number }} */
let lastWorkspaceStats = { bytes: 0, fileCount: 0 };
/** Per-turn thinking block (one per agent reply; previous turns stay in the stream) */
let liveTurnThink = null;
/** Wrapper for this turn's think + final answer */
let liveTurnWrap = null;
/** Per-turn assistant bubble (promoteFinalAnswer used to overwrite the first one) */
let liveTurnAnswerEl = null;
let liveTurnAnswerText = '';
/** True after a stream thought / thought-open — empty finish may keep a sealed bar. */
let liveTurnThinkFromStream = false;
/** True after finishLiveTurnUi — late thought events must not spawn a second 思考中. */
let liveTurnSealed = false;
let liveTurnRenderTimer = 0;
/** Ephemeral host progress row (tools/pixels) — not a chat bubble */
let liveTurnProgressEl = null;
let liveProgressState = createLiveProgressState();
let viewingHistoryId = null;
let taskSeq = 0;
let clipDrawerOpen = false;
/** @type {Set<string>} */
let clipSelectedIds = new Set();
/** Popover controller for clipboard export — must be top-level before boot (avoid TDZ). */
/** @type {{ close: () => void, isOpen: () => boolean, usesNative: boolean } | null} */
let clipExportPopover = null;
let toastTimer = null;
let autoPinnedTextKeys = new Set();

const MULTIMODAL_MODELS = ['gemini-2.5-flash', 'claude-3.5-sonnet', 'gpt-4o', 'gpt-4.1', 'claude-4-sonnet'];

/** i18n: tables in sidepanel/i18n.js; this file owns currentLang */
const t = createT(() => currentLang);

/** Trajectory download UI — domain module; deps resolve at call time */
const trajectoryUi = createTrajectoryUi({
  t,
  getLang: () => currentLang,
  isExportEnabled: () => devTrajectoryExportEnabled,
  getSessions: () => sessions,
  getActiveSessionId: () => activeSessionId,
  showToast: (msg, opts) => showSidepanelToast(msg, opts),
  scrollTaskStream: () => scrollTaskStream(),
  ensureSessionTrajectory,
  trajectoryToDownloadJson,
  serializeBehaviorTrajectory,
  fetchWorkspaceSession: (sessionId) => workspaceRpc('getSession', { sessionId }),
  getConstitutionVersion: () => SYSTEM_PROMPT_VERSION
});
const mountTaskTrajectoryButton = trajectoryUi.mountTaskTrajectoryButton;
const downloadTaskTrajectory = trajectoryUi.downloadTaskTrajectory;

const taskStatusUi = createTaskStatusUi({
  workspaceRpc,
  t,
  getLang: () => currentLang,
  getSessionId: () => activeSessionId,
  getTaskStream: () => $('taskStream'),
  getThreadBody: (sessionId) => {
    const sid = String(sessionId || '');
    const threads = document.querySelectorAll(
      '#taskStream .session-thread:not(.is-history-view):not([hidden])'
    );
    for (const thread of threads) {
      if (String(thread.dataset.sessionId || '') === sid) return thread.querySelector('.task-body');
    }
    return null;
  },
  showToast: (message, opts) => showSidepanelToast(message, opts)
});

function bootSidePanel() {
  initSidePanel();
}

function initSidePanel() {
  const safe = (name, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`[PageWand] ${name} failed`, e);
    }
  };

  loadSavedPreferences();
  loadPersistentSessions();
  safe('setupCoreEventListeners', setupCoreEventListeners);
  safe('setupAgentSettingsModal', setupAgentSettingsModal);
  safe('setupTrajectoryExportModal', setupTrajectoryExportModal);
  safe('setupSkillsSettings', setupSkillsSettings);
  safe('setupArtifactPreviewModal', setupArtifactPreviewModal);
  safe('setupImageGenPreviewModal', setupImageGenPreviewModal);
  safe('setupScreenshotCapture', setupScreenshotCapture);
  safe('setupAttachmentListeners', setupAttachmentListeners);
  safe('enhanceComposerIcons', () => {
    enhanceComposerIcons();
    enhanceTopbarIcons();
    // Seed idle send vector icon immediately
    setAgentRunningUi(false);
  });
  safe('setupHoverDrawers', setupHoverDrawers);
  safe('wireSelOverflowListeners', wireSelOverflowListeners);
  safe('wireDrawerEscape', wireDrawerEscape);
  safe('wireMoreSheetEscape', wireMoreSheetEscape);
  safe('setupSidepanelWheelRelay', setupSidepanelWheelRelay);
  safe('setupTaskStreamScrollAffordances', setupTaskStreamScrollAffordances);
  safe('setupPanelDensity', () => setupPanelDensity($('panel') || document.querySelector('.panel')));
  safe('wireSessionRail', wireSessionRail);
  syncPickerStateFromActiveTab();
  updateActivePageListeningBanner();
  void refreshOpenMentionPages();
  safe('setupAutoResizeTextarea', setupAutoResizeTextarea);
  refreshAgentStatusBadge();
  void refreshImageGenChip();
  applyI18n();
  renderSelectionUI();
  void refreshWorkspaceGroupState();
  renderClipboardUI();
  renderSessionDropdown();
  renderHistoryList();
  void taskStatusUi.refresh();
  void refreshUnfinishedDraftsList();
  checkBackendHealth();
  // Home empty: center composer (MaxAI-style) when no live task
  safe('homeEmptyMode', () => {
    if ($('welcome') || (!liveTask && historyRecords.length === 0)) {
      if (!$('welcome')) showWelcome();
      else setHomeEmptyMode(true);
    }
  });
  chrome.tabs.onActivated?.addListener(() => {
    updateActivePageListeningBanner();
    syncPickerStateFromActiveTab();
    void refreshOpenMentionPages();
  });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === 'complete') updateActivePageListeningBanner();
    if (changeInfo.url || changeInfo.title || changeInfo.status || changeInfo.discarded != null) {
      void refreshOpenMentionPages();
    }
  });
  chrome.tabs.onCreated?.addListener(() => {
    void refreshOpenMentionPages();
  });
  chrome.tabs.onRemoved?.addListener(() => {
    void refreshOpenMentionPages();
  });
  chrome.tabs.onReplaced?.addListener(() => {
    void refreshOpenMentionPages();
  });
}

/** Hover-intent medium panels (selection / clipboard / history / drafts) — max one open */
function setupHoverDrawers() {
  // Whole selection-bar is one hover zone (toolbar + expand body + clip tools).
  // Root-only leave ⇒ moving pick → 下图 → 剪贴板 does not collapse.
  const selectionBar = $('selectionBar');
  const selToolbar = $('selToolbar') || selectionBar?.querySelector?.('.sel-toolbar');
  if (selectionBar) {
    registerHoverDrawer('selection', {
      root: selectionBar,
      trigger: /** @type {HTMLElement} */ (selToolbar || selectionBar),
      body: $('selExpandBody') || selectionBar.querySelector('[data-drawer-body]'),
      group: 'selection',
      exclusive: true,
      // Progressive: only expand when there is selection chrome or clipboard pins
      canOpen: () => {
        const hasClip = getClipboardPins().length > 0;
        const hasSel = (selectedElementsSummary || []).length > 0;
        return hasSel || hasClip;
      },
      onOpen: () => {
        selectionBar.classList.add('is-drawer-open');
        selectionBar.setAttribute('aria-expanded', 'true');
        // Clipboard co-wakes with selection panel (no separate pill)
        if (getClipboardPins().length > 0) {
          clipDrawerOpen = true;
        }
        renderQuickTools();
      },
      onClose: () => {
        selectionBar.classList.remove('is-drawer-open');
        selectionBar.setAttribute('aria-expanded', 'false');
        clipDrawerOpen = false;
        closeExportMenu();
        const clipEl = $('clipDrawer');
        clipEl?.classList.remove('is-drawer-open');
        renderQuickTools();
      }
    });
  }
  const historyBar = $('historyBar');
  const historyHeader = $('historyHeaderToggle');
  if (historyBar && historyHeader) {
    registerHoverDrawer('history', {
      root: historyBar,
      trigger: historyHeader,
      onOpen: () => {
        historyListExpanded = true;
        historyBar.classList.add('is-drawer-open');
        renderHistoryList();
      },
      onClose: () => {
        historyListExpanded = false;
        historyBar.classList.remove('is-drawer-open');
        renderHistoryList();
      }
    });
  }
  const draftsBar = $('draftsBar');
  if (draftsBar) {
    const draftsHeader = draftsBar.querySelector('.drafts-header') || draftsBar;
    registerHoverDrawer('drafts', {
      root: draftsBar,
      trigger: /** @type {HTMLElement} */ (draftsHeader),
      onOpen: () => {
        draftsBar.classList.add('is-drawer-open');
      },
      onClose: () => {
        draftsBar.classList.remove('is-drawer-open');
      }
    });
  }
}

// ── i18n / theme / status ──
function currentReasoningPayload() {
  if (!reasoningEffort || reasoningEffort === 'none') return { enabled: false };
  const levels = currentModelEffortLevels();
  if (levels && levels.includes(reasoningEffort)) {
    return { enabled: true, effort: reasoningEffort };
  }
  return { enabled: true };
}

function effortDisplayName(effort) {
  const keys = {
    none: 'effortNone',
    minimal: 'effortMinimal',
    low: 'effortLow',
    medium: 'effortMedium',
    high: 'effortHigh',
    xhigh: 'effortXhigh',
    max: 'effortMax'
  };
  return t(keys[effort] || '') || effort;
}

function currentModelEffortLevels() {
  const hit = findCatalogModel(catalogModels, selectedModel);
  return effortLevelsForReasoning(hit?.reasoning);
}

function snapReasoningEffort(levels) {
  if (!Array.isArray(levels) || !levels.length) return;
  if (levels.includes(reasoningEffort)) return;
  reasoningEffort = levels.includes('none') ? 'none' : levels[0];
  chrome.storage.local.set({ pagewand_reasoning_effort: reasoningEffort });
}

function selectReasoningEffort(effort, levels) {
  const steps = Array.isArray(levels) ? levels : currentModelEffortLevels() || [];
  if (!steps.includes(effort) || effort === reasoningEffort) {
    updateReasoningEffortSlider(steps);
    return;
  }
  reasoningEffort = effort;
  chrome.storage.local.set({ pagewand_reasoning_effort: reasoningEffort });
  updateReasoningEffortSlider(steps);
}

function effortIndex(levels) {
  const i = levels.indexOf(reasoningEffort);
  return i < 0 ? 0 : i;
}

function effortTier(levels) {
  const idx = effortIndex(levels);
  if (idx <= 0 || levels[idx] === 'none') return 'none';
  if (idx === levels.length - 1) return 'max';
  return 'mid';
}

function updateReasoningEffortSlider(levels) {
  const label = $('thinkEffortLabel');
  const trigger = $('modelSelectTrigger');
  const n = levels.length;
  const idx = effortIndex(levels);
  const t = n <= 1 ? 1 : idx / (n - 1);
  const tier = effortTier(levels);
  const name = effortDisplayName(levels[idx]);
  if (label) label.textContent = name;
  if (trigger) {
    trigger.dataset.tier = tier;
    const modelName = modelSelectLabelText($('modelSelect'));
    trigger.title = `${modelName} · ${name}`;
  }
  const slider = $('thinkEffortPop');
  const fill = slider?.querySelector('.think-effort-fill');
  const thumb = slider?.querySelector('.think-effort-thumb');
  if (slider) {
    slider.hidden = false;
    slider.dataset.stops = String(n);
    slider.dataset.tier = tier;
    slider.setAttribute('aria-valuenow', String(idx));
    slider.setAttribute('aria-valuetext', name);
    slider.setAttribute('aria-valuemax', String(Math.max(0, n - 1)));
  }
  if (fill) fill.style.width = `${Math.round(t * 100)}%`;
  if (thumb) thumb.style.left = `calc(8px + ${t} * (100% - 16px))`;
}

function bindReasoningEffortSlider(host) {
  const slider = host?.id === 'thinkEffortPop' ? host : host?.querySelector?.('#thinkEffortPop, .think-effort-slider');
  if (!slider || slider.dataset.bound === '1') return;
  slider.dataset.bound = '1';
  let dragging = false;
  const steps = () => $('thinkEffort')?._effortLevels || [];
  const pick = (clientX) => {
    const levels = steps();
    if (!levels.length) return;
    const rect = slider.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const i = Math.round(u * (levels.length - 1));
    selectReasoningEffort(levels[i], levels);
  };
  slider.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    thinkEffortIgnoreCloseUntil = Date.now() + 800;
    slider.setPointerCapture?.(e.pointerId);
    pick(e.clientX);
    e.preventDefault();
    e.stopPropagation();
  });
  slider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pick(e.clientX);
  });
  const end = () => {
    dragging = false;
  };
  slider.addEventListener('pointerup', end);
  slider.addEventListener('pointercancel', end);
  slider.addEventListener('keydown', (e) => {
    const levels = steps();
    if (!levels.length) return;
    const idx = effortIndex(levels);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectReasoningEffort(levels[Math.min(levels.length - 1, idx + 1)], levels);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectReasoningEffort(levels[Math.max(0, idx - 1)], levels);
    } else if (e.key === 'Home') {
      e.preventDefault();
      selectReasoningEffort(levels[0], levels);
    } else if (e.key === 'End') {
      e.preventDefault();
      selectReasoningEffort(levels[levels.length - 1], levels);
    }
  });
}

function renderReasoningEffortChips() {
  const root = $('thinkEffort');
  const slider = $('thinkEffortPop');
  const dots = $('thinkEffortDots');
  if (!root || !slider) return;
  const levels = currentModelEffortLevels();
  snapReasoningEffort(levels);
  root._effortLevels = levels;
  const n = levels.length;
  if (dots && dots.childElementCount !== n) {
    dots.innerHTML = levels.map(() => '<i class="think-effort-dot"></i>').join('');
  }
  updateReasoningEffortSlider(levels);
  bindReasoningEffortSlider(slider);
}

let thinkEffortIgnoreCloseUntil = 0;

function setThinkEffortOpen(_open) {
  /* Effort lives inside the model menu; no standalone popover. */
}

function syncReasoningSwitch() {
  renderReasoningEffortChips();
}

async function refreshReasoningCatalog(force = false) {
  try {
    const settings = await loadLlmSettings();
    const base = settings?.apiBase || '';
    if (!base) return;
    if (!force && !catalogModels.length) {
      const cached = await loadCachedModelsForBase(base);
      if (cached.models.length) catalogModels = cached.models;
    }
    const key = String(settings.apiKey || '').trim();
    if (!key) {
      syncReasoningSwitch();
      return;
    }
    const stale =
      force ||
      !catalogModels.length ||
      !catalogModels.some((m) => m.reasoning);
    if (stale) {
      catalogModels = await refreshAndCacheModels(base, key);
    }
  } catch (err) {
    console.warn('[reasoning] catalog probe failed', err);
  }
  syncReasoningSwitch();
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (I18N[currentLang]?.[key] != null) el.textContent = I18N[currentLang][key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (I18N[currentLang]?.[key] != null) el.placeholder = I18N[currentLang][key];
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (I18N[currentLang]?.[key] != null) el.setAttribute('aria-label', I18N[currentLang][key]);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (I18N[currentLang]?.[key] != null) el.title = I18N[currentLang][key];
  });
  const langBtn = $('langToggle');
  if (langBtn) langBtn.textContent = currentLang === 'zh' ? 'EN' : '中';
  updatePickerButtonState(isPickerActive);
  setStatus(isAgentRunning ? 'running' : 'ready');
  syncReasoningSwitch();
  restartComposerTypewriter();
  taskStatusUi.render();
}

let composerTypewriterTimer = 0;

function composerTypeLines() {
  const lines = I18N[currentLang]?.composerTypeLines;
  if (Array.isArray(lines) && lines.length) return lines.map((s) => String(s));
  const one = I18N[currentLang]?.inputPlaceholder || '选中，说要什么';
  return [one];
}

function syncComposerTypewriterVisibility() {
  const input = composerEl();
  const el = $('composerTypewriter');
  if (!el) return;
  const busy = !!(input && (document.activeElement === input || composerHasContent(input)));
  el.classList.toggle('is-off', busy);
}

function restartComposerTypewriter() {
  const el = $('composerTypewriter');
  if (composerTypewriterTimer) {
    window.clearTimeout(composerTypewriterTimer);
    composerTypewriterTimer = 0;
  }
  if (!el) return;
  const lines = composerTypeLines();
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    el.textContent = lines[0] || '';
    syncComposerTypewriterVisibility();
    return;
  }
  let line = 0;
  let i = 0;
  let phase = 'type';
  const tick = () => {
    const phrase = lines[line % lines.length] || '';
    if (phase === 'type') {
      i += 1;
      el.innerHTML = `${escapeHtml(phrase.slice(0, i))}<span class="tw-caret"></span>`;
      if (i >= phrase.length) {
        phase = 'hold';
        composerTypewriterTimer = window.setTimeout(tick, 2600);
        return;
      }
      composerTypewriterTimer = window.setTimeout(tick, 46);
      return;
    }
    if (phase === 'hold') {
      phase = 'clear';
      composerTypewriterTimer = window.setTimeout(tick, 180);
      return;
    }
    el.innerHTML = '<span class="tw-caret"></span>';
    i = 0;
    line += 1;
    phase = 'type';
    composerTypewriterTimer = window.setTimeout(tick, 420);
  };
  el.innerHTML = '<span class="tw-caret"></span>';
  syncComposerTypewriterVisibility();
  composerTypewriterTimer = window.setTimeout(tick, 200);
}

function composerEl() {
  return $('input');
}

function composerPlainText(el = composerEl()) {
  if (!el) return '';
  let s = '';
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      s += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList?.contains('composer-mention')) {
      const kind = node.getAttribute('data-kind') || '';
      if (kind === 'link') {
        s += String(node.getAttribute('data-url') || node.getAttribute('data-label') || '').trim();
        return;
      }
      const label = node.getAttribute('data-label') || String(node.textContent || '').replace(/^[@/]/, '');
      s += kind === 'skill' || kind === 'command' ? `/${label}` : `@${label}`;
      return;
    }
    if (node.tagName === 'BR') {
      s += '\n';
      return;
    }
    if (node.tagName === 'DIV' && node !== el) {
      if (s && !s.endsWith('\n')) s += '\n';
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return s.replace(/\u00a0/g, ' ');
}

function mentionPageCandidates() {
  const out = [];
  const seenTab = new Set();
  for (const p of openMentionPages) {
    const tabId = Number(p?.tabId);
    if (!Number.isFinite(tabId) || tabId <= 0 || seenTab.has(tabId)) continue;
    const ref = normalizePageRef(p);
    if (!ref) continue;
    seenTab.add(tabId);
    out.push({
      ...ref,
      tabId,
      current: p.current === true
    });
  }
  return out;
}

function applyOpenMentionPages(pages) {
  const next = Array.isArray(pages) ? pages : [];
  const sig = (list) =>
    list
      .map((p) => `${Number(p.tabId) || 0}|${p.url || ''}|${p.title || ''}|${p.current ? 1 : 0}`)
      .join('\n');
  const changed = sig(openMentionPages) !== sig(next);
  openMentionPages = next;
  if (changed) {
    pruneStalePageMentionChips();
    if (mentionPaletteOpen) renderMentionPalette(mentionPaletteQuery, mentionPaletteRange);
  }
  return changed;
}

async function refreshOpenMentionPages() {
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'pawwork-background',
      action: 'workspace_list_open_tabs'
    });
    if (res?.ok && Array.isArray(res.pages)) applyOpenMentionPages(res.pages);
  } catch {
    /* SW waking */
  }
}

function liveMentionTabIds() {
  return new Set(
    openMentionPages.map((p) => Number(p.tabId)).filter((id) => Number.isFinite(id) && id > 0)
  );
}

function liveMentionUrls() {
  return new Set(openMentionPages.map((p) => String(p.url || '')).filter(Boolean));
}

function isLivePageMention(m) {
  if (!m || m.kind !== 'page') return true;
  const tabId = Number(m.tabId);
  if (Number.isFinite(tabId) && tabId > 0) return liveMentionTabIds().has(tabId);
  const url = String(m.url || '').trim();
  return url ? liveMentionUrls().has(url) : false;
}

function pruneStalePageMentionChips(el = composerEl()) {
  if (!el) return;
  const liveTabs = liveMentionTabIds();
  const liveUrls = liveMentionUrls();
  for (const node of [...el.querySelectorAll('.composer-mention')]) {
    if (node.getAttribute('data-kind') !== 'page') continue;
    const tabId = Number(node.getAttribute('data-tab-id'));
    if (Number.isFinite(tabId) && tabId > 0) {
      if (!liveTabs.has(tabId)) node.remove();
      continue;
    }
    const url = String(node.getAttribute('data-url') || '').trim();
    if (!url || !liveUrls.has(url)) node.remove();
  }
}

function filterLivePageMentions(mentions) {
  return (Array.isArray(mentions) ? mentions : []).filter(isLivePageMention);
}

function composerMentionsFromDom(el = composerEl()) {
  if (!el) return [];
  return normalizeComposerMentions(
    [...el.querySelectorAll('.composer-mention')].map((node) => ({
      kind: node.getAttribute('data-kind') || 'group',
      id: node.getAttribute('data-id') || '',
      groupId: node.getAttribute('data-group-id') || '',
      label: node.getAttribute('data-label') || '',
      handle: node.getAttribute('data-handle') || '',
      url: node.getAttribute('data-url') || '',
      tabId: node.getAttribute('data-tab-id') || ''
    }))
  );
}

function composerHasContent(el = composerEl()) {
  if (!el) return false;
  if (el.querySelector('.composer-mention')) return true;
  return String(composerPlainText(el)).trim().length > 0;
}

function syncComposerEmptyClass(el = composerEl()) {
  if (!el) return;
  el.classList.toggle('is-empty', !composerHasContent(el));
}

function resizeComposerField(el = composerEl()) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
}

function clearComposer(el = composerEl()) {
  if (!el) return;
  el.replaceChildren();
  el.style.height = 'auto';
  syncComposerEmptyClass(el);
}

function setComposerPlainText(text, el = composerEl()) {
  if (!el) return;
  el.textContent = text || '';
  syncComposerEmptyClass(el);
  resizeComposerField(el);
}

function cloneComposerNodes(el = composerEl()) {
  if (!el) return [];
  return [...el.childNodes].map((n) => n.cloneNode(true));
}

const COMPOSER_MAX_CHARS = 4000;
let mentionPaletteOpen = false;
let mentionPaletteIndex = 0;
let mentionPaletteItems = [];
let mentionPaletteExpanded = new Set();
let mentionPaletteQuery = '';
let mentionPaletteRange = null;
let mentionComposing = false;
let skillPickerCatalog = [];
let skillPickerCatalogAt = 0;
let skillPaletteSeq = 0;
let skillSettingsSelectedId = '';
let skillSettingsIsNew = false;
let skillSettingsCatalog = [];
const SKILL_PICKER_TTL_MS = 20_000;

function closeMentionPalette() {
  const pal = $('mentionPalette');
  const input = composerEl();
  mentionPaletteOpen = false;
  mentionPaletteItems = [];
  mentionPaletteIndex = 0;
  mentionPaletteExpanded = new Set();
  mentionPaletteQuery = '';
  mentionPaletteRange = null;
  if (pal) {
    pal.hidden = true;
    pal.innerHTML = '';
  }
  input?.setAttribute('aria-expanded', 'false');
}

function getAtQueryContext() {
  const input = composerEl();
  const sel = window.getSelection();
  if (!input || !sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const { anchorNode, anchorOffset } = sel;
  if (!anchorNode || !input.contains(anchorNode)) return null;
  if (anchorNode.nodeType === Node.ELEMENT_NODE && anchorNode.classList?.contains('composer-mention')) {
    return null;
  }
  let textNode = null;
  let offset = 0;
  if (anchorNode.nodeType === Node.TEXT_NODE) {
    textNode = anchorNode;
    offset = anchorOffset;
  } else if (anchorNode === input) {
    const child = input.childNodes[Math.max(0, anchorOffset - 1)];
    if (child?.nodeType === Node.TEXT_NODE) {
      textNode = child;
      offset = child.nodeValue?.length || 0;
    } else {
      return null;
    }
  } else {
    return null;
  }
  const before = String(textNode.nodeValue || '').slice(0, offset);
  // @ always opens the picker (no preceding-boundary). / still needs start or whitespace.
  const atMatch = before.match(/@([^\s@/]*)$/);
  const slashMatch = !atMatch ? before.match(/(^|[\s\u00a0])\/([^\s@/]*)$/) : null;
  if (!atMatch && !slashMatch) return null;
  const trigger = atMatch ? '@' : '/';
  const query = atMatch ? atMatch[1] : slashMatch[2];
  const atStart = atMatch ? atMatch.index : slashMatch.index + slashMatch[1].length;
  const range = document.createRange();
  range.setStart(textNode, atStart);
  range.setEnd(textNode, offset);
  return { trigger, query, range };
}

function positionMentionPalette(menu, range) {
  if (!menu) return;
  let rect = null;
  try {
    rect = range?.getBoundingClientRect?.();
  } catch {
    rect = null;
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    rect = composerEl()?.getBoundingClientRect();
  }
  if (!rect) return;
  const menuW = 220;
  let left = rect.left;
  const maxLeft = Math.max(8, window.innerWidth - menuW - 8);
  left = Math.min(Math.max(8, left), maxLeft);
  menu.style.position = 'fixed';
  menu.style.left = `${left}px`;
  menu.style.minWidth = `${menuW}px`;
  menu.style.zIndex = '10060';
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const preferUp = spaceBelow < 140;
  menu.style.top = preferUp ? `${Math.max(8, rect.top - 8)}px` : `${rect.bottom + 6}px`;
  requestAnimationFrame(() => {
    const m = menu.getBoundingClientRect();
    if (preferUp || m.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - m.height - 6)}px`;
    }
  });
}

function mentionSectionExpanded(groupId, query, itemCount) {
  const q = String(query || '').trim();
  if (q && itemCount > 0) return true;
  return mentionPaletteExpanded.has(String(groupId || ''));
}

function toggleMentionSection(groupId) {
  const id = String(groupId || '');
  if (!id) return;
  if (mentionPaletteExpanded.has(id)) mentionPaletteExpanded.delete(id);
  else mentionPaletteExpanded.add(id);
  const keep = mentionPaletteItems[mentionPaletteIndex];
  renderMentionPalette(mentionPaletteQuery, mentionPaletteRange);
  if (keep) {
    const next = mentionPaletteItems.findIndex(
      (c) => c.kind === keep.kind && c.id === keep.id
    );
    if (next >= 0) {
      mentionPaletteIndex = next;
      moveMentionPalette(0);
    }
  }
}

function renderMentionPalette(query, range) {
  const pal = $('mentionPalette');
  const input = composerEl();
  if (!pal || !input) return;
  const en = currentLang === 'en';
  mentionPaletteQuery = query || '';
  mentionPaletteRange = range || mentionPaletteRange;
  const flat = buildMentionCandidates(
    workspaceGroupState.groups || [],
    workspaceGroupState.boundGroupIds || [],
    query,
    currentLang,
    sessionArtifacts,
    mentionPageCandidates()
  );
  const sections = nestMentionCandidates(flat);
  pal.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'mention-palette-list';
  list.setAttribute('role', 'presentation');
  mentionPaletteItems = [];
  if (!sections.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-palette-empty';
    empty.textContent = (workspaceGroupState.groups || []).length || sessionArtifacts.length || mentionPageCandidates().length
      ? en
        ? 'No match'
        : '没有匹配的选区、文件或页面'
      : en
        ? 'Nothing to mention yet — select on the page, open a site, or add a workspace file'
        : '还没有可选区、当前页或工作区文件';
    list.appendChild(empty);
  } else {
    for (const sec of sections) {
      const group = sec.group;
      const items = sec.items || [];
      const gid = String(group?.id || group?.groupId || '');
      const expanded = mentionSectionExpanded(gid, query, items.length);
      const section = document.createElement('div');
      section.className = 'mention-palette-section' + (expanded ? ' is-open' : '');
      section.setAttribute('data-group-id', gid);

      const head = document.createElement('div');
      head.className = 'mention-palette-head';

      const chevron = document.createElement('button');
      chevron.type = 'button';
      chevron.className = 'mention-palette-chevron';
      chevron.tabIndex = -1;
      chevron.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      chevron.setAttribute(
        'aria-label',
        expanded
          ? en
            ? 'Collapse group'
            : '收起组'
          : en
            ? 'Expand group'
            : '展开组'
      );
      chevron.disabled = items.length === 0;
      chevron.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6 4l4 4-4 4" /></svg>';
      chevron.addEventListener('mousedown', (e) => e.preventDefault());
      chevron.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!items.length) return;
        toggleMentionSection(gid);
      });

      const gIndex = mentionPaletteItems.length;
      const gBtn = document.createElement('button');
      gBtn.type = 'button';
      gBtn.className =
        'mention-palette-item is-group' + (gIndex === mentionPaletteIndex ? ' is-active' : '');
      gBtn.setAttribute('role', 'option');
      gBtn.setAttribute('aria-selected', gIndex === mentionPaletteIndex ? 'true' : 'false');
      const gLabel = document.createElement('span');
      gLabel.className = 'mention-palette-label';
      gLabel.textContent = group?.label || (en ? 'Group' : '组');
      const gMeta = document.createElement('span');
      gMeta.className = 'mention-palette-meta';
      gMeta.textContent = String(group?.itemCount || items.length || 0);
      gBtn.appendChild(gLabel);
      gBtn.appendChild(gMeta);
      gBtn.addEventListener('mousedown', (e) => e.preventDefault());
      gBtn.addEventListener('click', () => {
        if (group?.kind === 'workspace' || group?.id === WORKSPACE_MENTION_ID) {
          toggleMentionSection(gid);
          return;
        }
        if (group) void insertComposerMention(group);
      });
      mentionPaletteItems.push(group);
      head.appendChild(chevron);
      head.appendChild(gBtn);
      section.appendChild(head);

      const sub = document.createElement('div');
      sub.className = 'mention-palette-sub';
      if (!expanded) sub.hidden = true;
      if (!items.length) {
        const vacant = document.createElement('div');
        vacant.className = 'mention-palette-empty';
        vacant.textContent = en ? 'Empty group' : '组内还没有元素';
        sub.appendChild(vacant);
      } else {
        for (const c of items) {
          const iIndex = mentionPaletteItems.length;
          const isCurrentPage = c.kind === 'page' && c.current === true;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'mention-palette-item is-item' +
            (iIndex === mentionPaletteIndex ? ' is-active' : '') +
            (isCurrentPage ? ' is-current-page' : '');
          btn.setAttribute('role', 'option');
          btn.setAttribute('aria-selected', iIndex === mentionPaletteIndex ? 'true' : 'false');
          if (isCurrentPage) btn.setAttribute('aria-current', 'true');
          const label = document.createElement('span');
          label.className = 'mention-palette-label';
          label.textContent = c.label;
          if (c.kind === 'page') {
            const tip = [c.title || c.label, c.url].filter(Boolean).join('\n');
            if (tip) {
              btn.title = tip;
              label.title = c.title || c.label;
            }
          }
          const meta = document.createElement('span');
          meta.className = 'mention-palette-meta';
          meta.textContent =
            c.kind === 'artifact' ? c.kicker || '' : c.bound ? '' : en ? 'bind' : '将绑定';
          btn.appendChild(label);
          if (isCurrentPage) {
            const now = document.createElement('span');
            now.className = 'mention-palette-now';
            now.textContent = c.kicker || (en ? 'Now' : '当前');
            btn.appendChild(now);
          }
          btn.appendChild(meta);
          btn.addEventListener('mousedown', (e) => e.preventDefault());
          btn.addEventListener('click', () => {
            void insertComposerMention(c);
          });
          mentionPaletteItems.push(c);
          sub.appendChild(btn);
        }
      }
      section.appendChild(sub);
      list.appendChild(section);
    }
    if (mentionPaletteIndex >= mentionPaletteItems.length) mentionPaletteIndex = 0;
  }
  pal.appendChild(list);
  pal.hidden = false;
  pal.style.minWidth = '';
  pal.setAttribute('aria-label', t('mentionPaletteAria'));
  mentionPaletteOpen = true;
  setSessionBindMenuOpen(false);
  input.setAttribute('aria-expanded', 'true');
  if (!pal.parentElement || pal.parentElement !== document.body) {
    document.body.appendChild(pal);
  }
  positionMentionPalette(pal, range || mentionPaletteRange);
}

function invalidateSkillCatalogCache() {
  skillPickerCatalog = [];
  skillPickerCatalogAt = 0;
}

function skillOriginLabel(origin) {
  if (origin === 'overlay') return t('skillOriginOverlay');
  if (origin === 'github') return t('skillOriginGithub');
  if (origin === 'authored' || origin === 'local') return t('skillOriginAuthored');
  return t('skillOriginPackaged');
}

async function loadSkillCatalogForPicker() {
  const now = Date.now();
  if (skillPickerCatalog.length && now - skillPickerCatalogAt < SKILL_PICKER_TTL_MS) {
    return skillPickerCatalog;
  }
  try {
    const list = await workspaceRpc('listSkills');
    skillPickerCatalog = Array.isArray(list) ? list : [];
    skillPickerCatalogAt = now;
  } catch {
    skillPickerCatalog = [];
  }
  return skillPickerCatalog;
}

async function renderSkillPalette(query, range) {
  const pal = $('mentionPalette');
  const input = composerEl();
  if (!pal || !input) return;
  const seq = ++skillPaletteSeq;
  mentionPaletteQuery = query || '';
  mentionPaletteRange = range || mentionPaletteRange;
  const catalog = await loadSkillCatalogForPicker();
  if (seq !== skillPaletteSeq) return;
  const ctx = getAtQueryContext();
  if (!ctx || ctx.trigger !== '/') return;
  const items = buildSkillCandidates(catalog, ctx.query, currentLang);
  pal.innerHTML = '';
  pal.setAttribute('aria-label', t('skillPickerAria'));
  const list = document.createElement('div');
  list.className = 'mention-palette-list';
  list.setAttribute('role', 'presentation');
  mentionPaletteItems = [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-palette-empty';
    empty.textContent = t('skillPickerEmpty');
    list.appendChild(empty);
  } else {
    for (const c of items) {
      const iIndex = mentionPaletteItems.length;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'mention-palette-item is-item' + (iIndex === mentionPaletteIndex ? ' is-active' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', iIndex === mentionPaletteIndex ? 'true' : 'false');
      const label = document.createElement('span');
      label.className = 'mention-palette-label';
      label.textContent = c.label;
      btn.appendChild(label);
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        void insertComposerMention(c);
      });
      mentionPaletteItems.push(c);
      list.appendChild(btn);
    }
    if (mentionPaletteIndex >= mentionPaletteItems.length) mentionPaletteIndex = 0;
  }
  pal.appendChild(list);
  pal.hidden = false;
  mentionPaletteOpen = true;
  setSessionBindMenuOpen(false);
  input.setAttribute('aria-expanded', 'true');
  if (!pal.parentElement || pal.parentElement !== document.body) {
    document.body.appendChild(pal);
  }
  positionMentionPalette(pal, ctx.range || mentionPaletteRange);
  pal.style.minWidth = '';
}

function syncMentionPaletteFromCaret() {
  if (mentionComposing) return;
  const ctx = getAtQueryContext();
  if (!ctx) {
    closeMentionPalette();
    return;
  }
  if (ctx.trigger === '/') {
    void renderSkillPalette(ctx.query, ctx.range);
    return;
  }
  renderMentionPalette(ctx.query, ctx.range);
  void refreshOpenMentionPages();
}

function createMentionToken(candidate) {
  const chip = document.createElement('span');
  chip.className = 'composer-mention';
  chip.contentEditable = 'false';
  chip.setAttribute('data-kind', candidate.kind);
  chip.setAttribute('data-id', candidate.id);
  chip.setAttribute('data-group-id', candidate.groupId || '');
  chip.setAttribute('data-label', candidate.label || '');
  chip.setAttribute('data-handle', candidate.handle || '');
  if (candidate.itemKind) chip.setAttribute('data-item-kind', candidate.itemKind);
  if ((candidate.kind === 'page' || candidate.kind === 'link') && candidate.url) {
    chip.setAttribute('data-url', candidate.url);
  }
  if (candidate.kind === 'page' && Number(candidate.tabId) > 0) {
    chip.setAttribute('data-tab-id', String(candidate.tabId));
  }
  chip.textContent =
    candidate.kind === 'skill' || candidate.kind === 'command'
      ? `/${candidate.label}`
      : candidate.kind === 'link'
        ? String(candidate.label || 'link')
        : `@${candidate.label}`;
  if (candidate.kind === 'link' && candidate.url) chip.title = String(candidate.url);
  if (candidate.kind === 'artifact' && candidate.id) {
    chip.title = currentLang === 'en' ? 'Open workspace file' : '打开工作区文件';
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void previewSessionArtifact(candidate.id);
    });
  }
  return chip;
}

function insertComposerNodesAtCaret(nodes) {
  const input = composerEl();
  if (!input || !nodes?.length) return;
  input.focus();
  const sel = window.getSelection();
  let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !input.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
  }
  range.deleteContents();
  for (const node of nodes) {
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
  }
  const space = document.createTextNode('\u00a0');
  range.insertNode(space);
  range.setStartAfter(space);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
  syncComposerEmptyClass(input);
  resizeComposerField(input);
}

function normalizePastedHttpUrl(raw) {
  const s = String(raw || '').trim().replace(/[),.;]+$/g, '');
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : /^www\./i.test(s) ? `https://${s}` : '';
  if (!withScheme) return '';
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

function pastedUrlList(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const found = [];
  const re = /https?:\/\/[^\s<>"'`]+/gi;
  let m;
  while ((m = re.exec(t))) {
    const href = normalizePastedHttpUrl(m[0]);
    if (href) found.push(href);
  }
  if (!found.length) {
    const one = normalizePastedHttpUrl(t);
    if (one) found.push(one);
  }
  if (!found.length) return [];
  const leftover = t
    .replace(/https?:\/\/[^\s<>"'`]+/gi, ' ')
    .replace(/^www\.\S+/i, ' ')
    .replace(/[\s,;]+/g, '');
  return leftover ? [] : [...new Set(found)];
}

function pageCandidateForPastedUrl(url) {
  const href = normalizePastedHttpUrl(url);
  if (!href) return null;
  const live = mentionPageCandidates().find((p) => {
    const a = String(p.url || '').split('#')[0];
    const b = href.split('#')[0];
    return a === b || String(p.url || '') === href;
  });
  if (live) {
    return {
      kind: 'page',
      id: pageRefId(live) || `page:tab:${live.tabId}`,
      groupId: PAGES_MENTION_ID,
      label: abbrevTabTitle(live.title, live.host || live.origin),
      url: live.url || href,
      tabId: live.tabId
    };
  }
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    host = '';
  }
  return {
    kind: 'link',
    id: (`link:${href}`).slice(0, 96),
    label: abbrevTabTitle('', host) || host || (currentLang === 'en' ? 'Link' : '链接'),
    url: href
  };
}

async function insertPastedUrlChips(urls) {
  await refreshOpenMentionPages();
  const chips = [];
  for (const url of urls) {
    const cand = pageCandidateForPastedUrl(url);
    if (cand) chips.push(createMentionToken(cand));
  }
  insertComposerNodesAtCaret(chips);
}

function insertPastedScreenshotChip(att) {
  if (!att) return;
  const label = String(att.name || att.handle || (currentLang === 'en' ? 'Screenshot' : '截图'));
  insertComposerNodesAtCaret([
    createMentionToken({
      kind: 'screenshot',
      id: `shot:${att.labelN || att.handle || label}`,
      label,
      handle: att.handle || ''
    })
  ]);
}

async function bindMentionGroups(mentions) {
  const ids = [
    ...new Set(
      (mentions || [])
        .filter(
          (m) =>
            m &&
            m.kind !== 'artifact' &&
            m.kind !== 'workspace' &&
            m.kind !== 'page' &&
            m.kind !== 'pages' &&
            m.kind !== 'link' &&
            m.kind !== 'screenshot' &&
            m.kind !== 'skill' &&
            m.kind !== 'command' &&
            m.groupId !== PAGES_MENTION_ID
        )
        .map((m) => String(m.groupId || ''))
        .filter((id) => id && id !== WORKSPACE_MENTION_ID)
    )
  ];
  if (!ids.length) return;
  const current = new Set((workspaceGroupState.boundGroupIds || []).map(String));
  let changed = false;
  for (const id of ids) {
    if (!current.has(id)) {
      current.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  workspaceGroupState = await workspaceRpc('bindGroups', {
    sessionId: getWorkspaceSessionId(),
    groupIds: [...current]
  });
  renderWorkspaceGroupControls();
}

async function insertComposerMention(candidate) {
  const input = composerEl();
  const ctx = getAtQueryContext();
  if (!input || !candidate?.id) return;
  if (candidate.kind === 'page') {
    await refreshOpenMentionPages();
    if (!isLivePageMention({ kind: 'page', tabId: candidate.tabId, url: candidate.url })) {
      if (mentionPaletteOpen) renderMentionPalette(mentionPaletteQuery, mentionPaletteRange);
      return;
    }
  }
  input.focus();
  const chip = createMentionToken(candidate);
  const space = document.createTextNode('\u00a0');
  if (ctx?.range) {
    ctx.range.deleteContents();
    ctx.range.insertNode(chip);
    chip.after(space);
  } else {
    input.appendChild(chip);
    input.appendChild(space);
  }
  const after = document.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(after);
  closeMentionPalette();
  syncComposerEmptyClass(input);
  resizeComposerField(input);
  syncComposerTypewriterVisibility();
  if (
    candidate.kind !== 'artifact' &&
    candidate.kind !== 'workspace' &&
    candidate.kind !== 'page' &&
    candidate.kind !== 'pages' &&
    candidate.kind !== 'skill'
  ) {
    try {
      await bindMentionGroups([candidate]);
    } catch {
      /* bind is authorize; mention token still stands */
    }
  }
}

function moveMentionPalette(delta) {
  if (!mentionPaletteItems.length) return;
  mentionPaletteIndex =
    (mentionPaletteIndex + delta + mentionPaletteItems.length) % mentionPaletteItems.length;
  const pal = $('mentionPalette');
  pal?.querySelectorAll('.mention-palette-item').forEach((el, i) => {
    el.classList.toggle('is-active', i === mentionPaletteIndex);
    el.setAttribute('aria-selected', i === mentionPaletteIndex ? 'true' : 'false');
    if (i === mentionPaletteIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

function setAppLanguage(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
  chrome.storage.local.set({ app_lang: currentLang });
  applyI18n();
  applyComposerSubmitMode(composerSubmitMode);
  renderSelectionUI();
  renderSheetSelRow();
  void refreshWorkspaceGroupState();
  renderClipboardUI();
  renderHistoryList();
}

function setStatus(mode) {
  const pill = $('statusPill');
  const label = $('statusLabel');
  if (pill) pill.dataset.state = mode;
  if (label) label.textContent = mode === 'running' ? t('statusRunning') : t('statusReady');
}

function setAgentRunningUi(running) {
  applySendStopUi(running, {
    lang: currentLang,
    setStatus,
    onRunningChange: (r) => {
      isAgentRunning = r;
    }
  });
  // Compress selection chrome while agent runs (density)
  document.getElementById('selectionBar')?.classList.toggle('is-running-compact', !!running);
  // Stop replaces send; mode toggle hides while running
  document.getElementById('panel')?.classList.toggle('is-agent-running', !!running);
  if (!running) {
    const sid = getWorkspaceSessionId();
    if (
      clarifyLiveState &&
      clarifyBelongsToSession(clarifyLiveState.sessionId || sid, sid) &&
      clarifyLiveState.kind !== 'plan'
    ) {
      hideClarifyLive(sid);
    }
    applyComposerSubmitMode(composerSubmitMode);
  }
}

/**
 * Re-hydrate Stop / thinking from offscreen abort registry (not in-memory send flags).
 * Live lease → spinner + Stop bound to that sessionId+executionId.
 * No lease → seal leftover “思考中”, hide Stop.
 */
function applyWorkspaceExecutionSnapshot(sessionId, payload, { rpcFailed = false } = {}) {
  const sid = String(sessionId || '');
  if (!sid) return;
  const payloadSid = payload && typeof payload === 'object' ? String(payload.sessionId || '') : '';
  if (!rpcFailed && payloadSid && payloadSid !== sid) return;
  const live = rpcFailed ? null : readActiveExecution(payload);
  const u = uiState(sid);
  const foreground = getWorkspaceSessionId() === sid;
  if (live === undefined) {
    if (foreground) setAgentRunningUi(!!u.running);
    renderSessionRailList();
    return;
  }

  if (isExecutionLive(live)) {
    // Stale getWorkspaceState from another session must not paint this one.
    if (live.sessionId && live.sessionId !== sid) {
      renderSessionRailList();
      return;
    }
    u.running = true;
    if (live.executionId) {
      u.executionId = live.executionId;
      if (foreground) currentWorkspaceTaskId = live.executionId;
    }
    if (foreground) {
      setAgentRunningUi(true);
      withSessionLive(sid, () => {
        liveTurnSealed = false;
        if (liveTask?.body) ensureLiveTurnThink();
      });
    }
    renderSessionRailList();
    return;
  }

  const hadSpinner = !!(
    u.liveTask?.el?.querySelector?.('.think-block.is-live') ||
    (foreground && liveTurnWrap?.querySelector?.('.think-block.is-live'))
  );
  u.running = false;
  if (foreground) {
    currentAgentAbort = null;
    setAgentRunningUi(false);
  }
  withSessionLive(sid, () => {
    const spinning =
      liveTurnWrap?.querySelector?.('.think-block.is-live') ||
      liveTask?.el?.querySelector?.('.think-block.is-live');
    if (spinning || hadSpinner) {
      finishLiveThinkBlocks();
      if (rpcFailed && !String(liveTurnAnswerText || '').trim()) {
        const msg =
          currentLang === 'en'
            ? '**Error:** The agent runtime disconnected. This session is no longer running.'
            : '**错误:** 后台已断开，这一轮已不在运行。';
        promoteFinalAnswer(msg, { force: true });
      }
    }
  });
  renderSessionRailList();
}

async function refreshExecutionFromWorkspace(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return;
  try {
    const full = await workspaceRpc('getSession', { sessionId: sid });
    applyWorkspaceExecutionSnapshot(sid, full);
  } catch {
    applyWorkspaceExecutionSnapshot(sid, null, { rpcFailed: true });
  }
}

/**
 * Single up-arrow send: default = chat.
 * Hover send + mouse wheel switches chat ↔ run (same button, run = purple).
 * @param {'chat'|'run'} mode
 */
function applyComposerSubmitMode(mode) {
  // Decorative only — product path is always unified sendMessage (Session agent).
  composerSubmitMode = mode === 'run' ? 'run' : 'chat';
  const isRun = composerSubmitMode === 'run';
  const sendBtn = $('sendBtn');
  if (sendBtn) {
    sendBtn.dataset.mode = composerSubmitMode;
    sendBtn.dataset.submit = composerSubmitMode;
    sendBtn.classList.toggle('is-run-mode', isRun);
    const title =
      currentLang === 'en'
        ? isRun
          ? 'Send (emphasis) · scroll wheel for quiet send'
          : 'Send · hover + scroll wheel for emphasis style'
        : isRun
          ? '发送（强调样式）· 悬停滚轮切回普通发送'
          : '发送 · 悬停滚轮切换强调样式';
    sendBtn.title = title;
    sendBtn.setAttribute('aria-label', title);
  }
}

/**
 * Hard-stop agent + worker + any open confirm gates.
 * AbortSignal alone is not enough while tools await user confirm.
 */
function stopAgentRun(reason = 'user_stop') {
  const sid = getWorkspaceSessionId();
  uiState(sid).promptQueue = [];
  renderPromptQueueHint();
  // Product Session abort — host cancels in-flight model/tools/code
  void workspaceRpc('abortTask', {
    sessionId: sid,
    executionId: uiState(sid).executionId || currentWorkspaceTaskId || undefined
  }).catch((err) => {
    console.warn('[workspace] abortTask failed', err);
  });
  try {
    if (currentAgentAbort && !currentAgentAbort.signal.aborted) {
      currentAgentAbort.abort(reason);
    }
  } catch (_) {}
  // P0-6: settle pending ask_user so tool promise unblocks and run can abort
  try {
    settlePendingAskUserForSession(getWorkspaceSessionId(), ASK_USER_STOP_ANSWER);
  } catch (_) {}
  // Broadcast cancel_run to active tab (submit bar / page waits)
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) return;
      try {
        chrome.tabs.sendMessage(tabId, {
          action: 'cancel_run',
          runId: activeSessionId || null,
          reason: String(reason || 'user_stop')
        });
      } catch (_) {}
    });
  } catch (_) {}
  hideClarifyLive(getWorkspaceSessionId());
  // Dismiss free-text ask_user modal if still open (promise already settled above)
  try {
    const modal = document.getElementById('appModalOverlay');
    if (modal && modal.open) {
      document.getElementById('modalCancelBtn')?.click();
    }
  } catch (_) {}
  // No toast here — task stream shows one "已停止" note when run settles
}

/**
 * Heuristic: pure chat / capability Q — not a work task.
 * @param {string} prompt
 * @returns {boolean}
 */
function looksLikeChatOnly(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return false;
  if (p.length > 120) return false;
  return /^(你好|您好|嗨|哈喽|hi\b|hello\b|hey\b|你是谁|你能做|你会什么|你可以做什么|能做什么|有什么功能|介绍一下|what can you|who are you|help\??$)/i.test(
    p
  );
}

function stateLabel(s) {
  const map = {
    chat: 'stateChat',
    shape: 'stateShape',
    running: 'stateRunning',
    done: 'stateDone',
    verified: 'stateVerified',
    failed: 'stateFailed'
  };
  return t(map[s] || 'stateChat');
}

function mapTaskUiState(agentStatus) {
  if (agentStatus === 'running') return 'running';
  if (agentStatus === 'verified') return 'verified';
  if (agentStatus === 'failed') return 'failed';
  if (agentStatus === 'claimed_done') return 'done';
  return 'chat';
}

/**
 * Open draft preview via service worker (dedicated HTML tab). Coalesces races.
 * @param {string} draftId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ok?: boolean, message?: string, coalesced?: boolean, tabId?: number, reused?: boolean}>}
 */
async function openDraftPreviewTab(draftId, opts = {}) {
  if (!draftId) return { ok: false, message: 'no draftId' };
  const id = String(draftId);
  if (!opts.force) {
    const pending = previewOpenInflight.get(id);
    if (pending) return pending;
  }
  const p = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'open_draft_preview',
        draftId: id,
        sessionId: getWorkspaceSessionId(),
        title: activeSessionName(),
        focus: opts.focus === true,
        reason: opts.reason || (opts.focus === true ? 'user' : 'preview')
      });
      return res || { ok: false };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    } finally {
      // Keep entry briefly so materialize onDraftReady + openDraftPreview coalesce
      setTimeout(() => {
        if (previewOpenInflight.get(id) === p) previewOpenInflight.delete(id);
      }, 900);
    }
  })();
  previewOpenInflight.set(id, p);
  return p;
}

/**
 * Draft ready card: preview / format / confirm download (no auto-download).
 * @param {object} info
 */
function showDraftReadyCard(info) {
  if (!info) return;
  const draftId = info.draftId || info.id;
  if (draftId) {
    activeDraftUi = {
      draftId,
      artifactId: info.artifactId || activeDraftUi?.artifactId,
      format: info.format || info.targetFormat || activeDraftUi?.format || 'md',
      name: info.name || info.title || activeDraftUi?.name,
      version: info.version != null ? info.version : activeDraftUi?.version,
      rendered: !!info.rendered || !!info.artifactId
    };
  } else if (info.artifactId) {
    activeDraftUi = {
      ...(activeDraftUi || {}),
      artifactId: info.artifactId,
      format: info.format || activeDraftUi?.format || 'md',
      name: info.name || activeDraftUi?.name,
      rendered: true
    };
  }

  const host = liveTask?.body || $('taskStream');
  if (!host) return;
  let card = host.querySelector('.draft-ready-card');
  if (!card) {
    card = document.createElement('div');
    card.className = 'draft-ready-card';
    host.appendChild(card);
  }
  const d = activeDraftUi || {};
  card.innerHTML = `
    <div class="draft-ready-title">草稿已就绪 · 刷新预览不丢</div>
    <div class="draft-ready-meta">
      ${d.draftId ? `draft <code>${escapeHtml(d.draftId)}</code>` : ''}
      ${d.version != null ? ` · v${d.version}` : ''}
      ${d.artifactId ? ` · artifact <code>${escapeHtml(d.artifactId)}</code>` : ''}
    </div>
    <label class="draft-ready-label">导出格式
      <select class="draft-format-select" id="draftFormatSelect">
        ${RENDER_FORMATS.map((f) => {
          const label =
            f === 'pdf'
              ? 'pdf（打印→另存为PDF）'
              : f === 'pptx'
                ? 'pptx（HTML幻灯）'
                : f;
          return `<option value="${f}" ${f === (d.format || 'md') ? 'selected' : ''}>${label}</option>`;
        }).join('')}
      </select>
    </label>
    <div class="draft-ready-actions">
      <button type="button" class="draft-btn ghost" data-act="preview">打开预览</button>
      <button type="button" class="draft-btn ghost" data-act="render">生成文件</button>
      <button type="button" class="draft-btn primary" data-act="download" id="draftPrimaryDl">确认并下载</button>
    </div>
    <p class="draft-ready-hint">预览页可微调块（编辑/排序/插入）· 最终格式在此或预览工具栏选择 · PDF=系统打印另存 · 下载成功后可清除草稿 · 勿在对话粘贴整页 HTML</p>
  `;
  const syncPrimary = () => {
    const fmt = document.getElementById('draftFormatSelect')?.value || 'md';
    const btn = card.querySelector('[data-act="download"]');
    if (btn) {
      btn.textContent =
        fmt === 'pdf'
          ? currentLang === 'en'
            ? 'Print → Save as PDF'
            : '打印为 PDF'
          : currentLang === 'en'
            ? 'Confirm & download'
            : '确认并下载';
    }
  };
  syncPrimary();
  card.querySelector('#draftFormatSelect')?.addEventListener('change', syncPrimary);
  card.querySelector('[data-act="preview"]')?.addEventListener('click', () => {
    if (!d.draftId) return;
    void openDraftPreviewTab(d.draftId, { force: true, focus: true, reason: 'user' });
  });
  card.querySelector('[data-act="render"]')?.addEventListener('click', () => {
    void confirmRenderDraft(false);
  });
  card.querySelector('[data-act="download"]')?.addEventListener('click', () => {
    void confirmRenderDraft(true);
  });
  scrollTaskStream();
  void refreshUnfinishedDraftsList();
}

/**
 * Render active draft and optionally download; purge draft after successful download.
 * Path: format select → renderDocumentFromDraft → download → purgeDraft + broadcast purged.
 * @param {boolean} andDownload
 */
async function confirmRenderDraft(andDownload) {
  const d = activeDraftUi;
  if (!d?.draftId && !d?.artifactId) {
    showSidepanelToast(currentLang === 'en' ? 'No draft' : '没有草稿', { error: true });
    return;
  }
  const fmt =
    document.getElementById('draftFormatSelect')?.value || d.format || 'md';
  try {
    let artifactId = d.artifactId;
    let name = d.name;
    if (d.draftId) {
      const draft = await loadDraft(d.draftId);
      if (!draft) {
        showSidepanelToast(currentLang === 'en' ? 'Draft gone' : '草稿已失效', { error: true });
        void refreshUnfinishedDraftsList();
        return;
      }
      const result = await renderDocumentFromDraft(draft, {
        format: fmt,
        runId: draft.runId || 'sidepanel',
        name: draft.title || name || 'pagewand'
      });
      if (result.status !== 'ok') {
        showSidepanelToast(result.message || 'Render failed', { error: true });
        return;
      }
      artifactId = result.artifactId;
      name = result.name;
      activeDraftUi = {
        ...d,
        artifactId,
        name,
        format: fmt,
        rendered: true,
        delivery: result.delivery,
        printHtml: result.printHtml
      };
      await saveDraft(d.draftId, { status: 'ready_for_export', targetFormat: fmt, bumpVersion: false });

      // A′ PDF: open print HTML tab → system print → Save as PDF
      if (andDownload && (fmt === 'pdf' || result.delivery === 'browser_print')) {
        await openPrintPdfTab({
          draftId: d.draftId,
          html: result.printHtml,
          title: draft.title || name
        });
        showSidepanelToast(
          currentLang === 'en'
            ? 'Print dialog: choose Save as PDF'
            : '请在打印对话框中选择「另存为 PDF」'
        );
        // Do not purge until user finished print — soft: keep draft; optional delayed purge skip
        showDraftReadyCard(activeDraftUi);
        return;
      }
    }
    if (!andDownload) {
      if (fmt === 'pdf') {
        showSidepanelToast(
          currentLang === 'en'
            ? 'PDF uses print HTML — click Print → Save as PDF'
            : 'PDF 将用打印页生成 — 点「打印为 PDF」'
        );
      } else {
        showSidepanelToast(
          currentLang === 'en'
            ? `Rendered ${name || artifactId}`
            : `已生成 ${name || artifactId}`
        );
      }
      showDraftReadyCard(activeDraftUi);
      return;
    }
    const rec = getArtifact(artifactId);
    if (!rec?.bytes) {
      showSidepanelToast(currentLang === 'en' ? 'Artifact missing' : '文件不存在', { error: true });
      return;
    }
    const url = bytesToDataUrl(rec.bytes, rec.mime || 'application/octet-stream');
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename: rec.name || name || 'download.bin', conflictAction: 'uniquify' },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        }
      );
    });
    showSidepanelToast(currentLang === 'en' ? 'Download started' : '已开始下载');
    if (d.draftId) await purgeDraftAfterDownload(d.draftId);
  } catch (e) {
    showSidepanelToast(e?.message || String(e), { error: true });
  }
}

/**
 * A′ PDF: open a tab with print-ready HTML and trigger window.print().
 * @param {{ draftId?: string, html?: string, title?: string }} opts
 */
async function openPrintPdfTab(opts = {}) {
  const draftId = opts.draftId;
  if (draftId) {
    // Prefer extension print page (module + storage)
    const url = chrome.runtime.getURL(
      `src/preview/print.html?draftId=${encodeURIComponent(draftId)}&autoprint=1`
    );
    await chrome.tabs.create({ url, active: true });
    return;
  }
  if (opts.html) {
    const blob = new Blob([opts.html], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    await chrome.tabs.create({ url: blobUrl, active: true });
  }
}

async function purgeDraftAfterDownload(draftId) {
  if (!draftId) return;
  try {
    await purgeDraft(draftId);
    chrome.runtime
      .sendMessage({ action: 'broadcast_draft_purged', draftId })
      .catch(() => {});
    if (activeDraftUi?.draftId === draftId) activeDraftUi = null;
    document.querySelectorAll('.draft-ready-card').forEach((el) => {
      el.innerHTML = `<div class="draft-ready-title">已下载 · 草稿已清除</div>
        <p class="draft-ready-hint">Draft purged after successful download.</p>`;
    });
    void refreshUnfinishedDraftsList();
  } catch (_) {
    void refreshUnfinishedDraftsList();
  }
}

/**
 * T11: preview/agent saved → draft_updated bumps card version (no full reload).
 * @param {{ action?: string, draftId?: string, version?: number }} request
 * @returns {boolean} handled
 */
function handleDraftRuntimeMessage(request) {
  if (!request || !request.action) return false;
  if (request.action === 'draft_updated' && request.draftId) {
    void (async () => {
      const draftId = String(request.draftId);
      let version = request.version;
      let name;
      let format;
      try {
        const draft = await loadDraft(draftId);
        if (draft) {
          if (version == null) version = draft.version;
          name = draft.title;
          format = draft.targetFormat;
        }
      } catch (_) {}
      if (activeDraftUi?.draftId === draftId) {
        showDraftReadyCard({
          ...activeDraftUi,
          draftId,
          version: version != null ? version : activeDraftUi.version,
          name: name || activeDraftUi.name,
          format: format || activeDraftUi.format
        });
      } else {
        void refreshUnfinishedDraftsList();
      }
    })();
    return true;
  }
  if (request.action === 'draft_purged' && request.draftId) {
    const draftId = String(request.draftId);
    if (activeDraftUi?.draftId === draftId) {
      activeDraftUi = null;
      document.querySelectorAll('.draft-ready-card').forEach((el) => {
        el.innerHTML = `<div class="draft-ready-title">已下载 · 草稿已清除</div>
          <p class="draft-ready-hint">Draft purged after successful download.</p>`;
      });
    }
    void refreshUnfinishedDraftsList();
    return true;
  }
  return false;
}

/**
 * T13: list unfinished drafts; 「继续」 opens SW preview + refreshes card.
 */
async function refreshUnfinishedDraftsList() {
  const bar = $('draftsBar');
  const list = $('draftsList');
  const countEl = $('draftsCount');
  if (!bar || !list) return;
  let drafts = [];
  try {
    drafts = await listDrafts();
  } catch (_) {
    drafts = [];
  }
  drafts = (Array.isArray(drafts) ? drafts : []).filter(
    (d) => d && d.draftId && d.status !== 'purged' && d.status !== 'delivered'
  );
  if (countEl) countEl.textContent = String(drafts.length);
  if (!drafts.length) {
    // Must take zero layout space (author CSS display:flex can override UA [hidden])
    bar.hidden = true;
    bar.setAttribute('hidden', '');
    bar.classList.remove('is-drawer-open');
    list.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.removeAttribute('hidden');
  list.innerHTML = '';
  drafts.slice(0, 12).forEach((d) => {
    const row = document.createElement('div');
    row.className = 'drafts-row';
    row.setAttribute('role', 'listitem');
    const title = d.title || d.draftId;
    const metaParts = [`v${d.version != null ? d.version : 1}`];
    if (d.targetFormat) metaParts.push(String(d.targetFormat));
    if (d.status && d.status !== 'editing') metaParts.push(String(d.status));
    row.innerHTML = `
      <div class="drafts-row-main">
        <span class="drafts-row-title"></span>
        <span class="drafts-row-meta"></span>
      </div>
      <button type="button" class="draft-btn ghost drafts-open-btn">继续</button>
    `;
    row.querySelector('.drafts-row-title').textContent = title;
    row.querySelector('.drafts-row-meta').textContent = metaParts.join(' · ');
    row.querySelector('.drafts-open-btn')?.addEventListener('click', () => {
      void openUnfinishedDraft(d.draftId);
    });
    list.appendChild(row);
  });
}

/**
 * Open an unfinished draft: refresh card + dedicated preview tab via SW.
 * @param {string} draftId
 */
async function openUnfinishedDraft(draftId) {
  if (!draftId) return;
  try {
    const draft = await loadDraft(draftId);
    if (!draft) {
      showSidepanelToast(
        currentLang === 'en' ? 'Draft gone' : '草稿已失效',
        { error: true }
      );
      void refreshUnfinishedDraftsList();
      return;
    }
    showDraftReadyCard({
      draftId: draft.draftId,
      version: draft.version,
      name: draft.title,
      format: draft.targetFormat || 'md',
      title: draft.title
    });
    const res = await openDraftPreviewTab(draft.draftId, { force: true, focus: true, reason: 'user' });
    if (res && res.ok === false) {
      showSidepanelToast(
        res.message || (currentLang === 'en' ? 'Preview open failed' : '预览打开失败'),
        { error: true }
      );
    }
  } catch (e) {
    showSidepanelToast(e?.message || String(e), { error: true });
  }
}

/**
 * Format duration as compact M/S (e.g. "2M 05S", "45S") — no full words.
 * @param {number} ms
 * @returns {string}
 */
function formatDurationMS(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (totalSec < 60) return `${totalSec}S`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}M ${String(s).padStart(2, '0')}S`;
}

function loadSavedPreferences() {
  chrome.storage.local.get(
    [
      'selected_model',
      'pagewand_theme',
      'pagewand_theme_mode',
      'app_lang',
      'pagewand_reasoning',
      'pagewand_reasoning_effort',
      'pagewand_use_browser_runtime',
      'pagewand_allow_python_fallback',
      RUNTIME_MODE_STORAGE_KEY,
      DEV_TRAJECTORY_STORAGE_KEY
    ],
    (result) => {
      if (result.selected_model) selectedModel = result.selected_model;
      loadLlmSettings()
        .then((s) => {
          if (s?.model) ensureModelOption(s.model);
          selectedImageModel = s?.image?.enabled ? String(s.image.model || '') : '';
          renderModelSelectMenu();
        })
        .catch(() => {});
      hydrateThemeFromStorage(result);
      currentTheme = getResolvedTheme();
      ensureModelOption(selectedModel);
      if (result.app_lang) setAppLanguage(result.app_lang);
      if (
        result.pagewand_reasoning_effort === 'none' ||
        GATEWAY_REASONING_EFFORTS.includes(result.pagewand_reasoning_effort)
      ) {
        reasoningEffort = result.pagewand_reasoning_effort;
      }
      syncReasoningSwitch();
      void refreshReasoningCatalog(false);
      devTrajectoryExportEnabled = result[DEV_TRAJECTORY_STORAGE_KEY] !== false;
      updateDevTrajectoryUi();
      refreshAgentStatusBadge();
    }
  );
}

function updateDevTrajectoryUi() {
  const display = devTrajectoryExportEnabled ? '' : 'none';
  const barBtn = $('downloadTrajectoryBtn');
  const footerBtn = $('downloadTrajectoryFooterBtn');
  if (barBtn) barBtn.style.display = display;
  if (footerBtn) footerBtn.style.display = display;
  document.querySelectorAll('.session-traj-btn').forEach((btn) => {
    btn.hidden = !devTrajectoryExportEnabled;
  });
}

function updateMultimodalBadgeState() {
  /* no-op in new shell */
}

async function checkBackendHealth() {
  // No local Python/daemon — product is extension-only + BYOK cloud LLM
  isBackendOnline = false;
  refreshAgentStatusBadge();
}

async function refreshAgentStatusBadge() {
  const statusEl = $('statusLabel');
  if (!statusEl || isAgentRunning) return;
  try {
    const settings = await loadLlmSettings();
    if (!settings.apiKey) {
      statusEl.textContent = currentLang === 'en' ? 'Need API Key' : '需配置 Key';
      statusEl.title = 'Open ⚙️ Settings to add provider + API key (BYOK · cloud API)';
    } else {
      statusEl.textContent = t('statusReady');
      statusEl.title = settings.providerName
        ? `${settings.providerName} · ${settings.model || ''}`
        : 'Paw Work vNext ready (extension runtime · cloud LLM)';
    }
  } catch {
    statusEl.textContent = t('statusReady');
  }
}

function setupAutoResizeTextarea() {
  const field = composerEl();
  if (!field) return;
  field.addEventListener('input', () => resizeComposerField(field));
}

function showQuickToast(msg) {
  const quickToast = $('quickToast');
  if (!quickToast) {
    showSidepanelToast(msg);
    return;
  }
  quickToast.textContent = msg;
  quickToast.hidden = false;
  quickToast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    quickToast.classList.remove('show');
    setTimeout(() => {
      quickToast.hidden = true;
    }, 200);
  }, 1800);
}

function showSidepanelToast(msg, { error = false, ms = 2600 } = {}) {
  let el = $('sidepanelToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sidepanelToast';
    el.className = 'sidepanel-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = String(msg || '');
  el.classList.toggle('toast-error', !!error);
  el.classList.add('visible');
  clearTimeout(showSidepanelToast._t);
  showSidepanelToast._t = setTimeout(() => el.classList.remove('visible'), ms);
}

function classifyElementKind(el) {
  if (!el || typeof el !== 'object') return 'text';
  return classifyLabelKind({
    ...el,
    tag: el.tag || el.tagName,
    src: el.src || el.url,
    href: el.href,
    text: el.text || el.textContent,
    kindHint: el.labelKind || el.kindHint || el.kind
  });
}

function selectionCountsFrom(elements) {
  let text = 0;
  let images = 0;
  let tables = 0;
  let links = 0;
  let vectors = 0;
  let files = 0;
  let videos = 0;
  let covers = 0;
  let pages = 0;
  (elements || []).forEach((el) => {
    const k = classifyElementKind(el);
    const href = String(el.href || '').trim();
    const hasPageHref = /^https?:/i.test(href) && !hrefLooksDownloadable(href);
    if (k === 'page') { /* counted below */ }
    else if (k === 'text') text += 1;
    else if (k === 'image') {
      images += 1;
      if (hasPageHref) links += 1;
    } else if (k === 'table') tables += 1;
    else if (k === 'link') {
      links += 1;
      if (hrefLooksDownloadable(el.href || el.src || '')) files += 1;
    } else if (k === 'vector') vectors += 1;
    else if (k === 'video') {
      videos += 1;
      covers += 1;
    }
    if (k === 'page') pages += 1;
  });
  return { text, images, tables, links, vectors, files, videos, covers, pages, total: (elements || []).length };
}

function itemLabelLang() {
  return currentLang === 'en' ? 'en' : 'zh';
}

function elementLabel(el, index) {
  const stickyKind = el.labelKind || classifyLabelKind(el);
  const n = Math.floor(Number(el.labelN) || 0);
  if (stickyKind === 'text') {
    const text = String(el.text || el.preview?.textSnippet || '').trim();
    if (text) return truncateUi(text, 32);
    return n ? formatItemLabel('text', n, itemLabelLang()) : t('kindText');
  }
  if (n > 0 && stickyKind) return formatItemLabel(stickyKind, n, itemLabelLang());
  const kind = classifyElementKind(el);
  if (kind === 'image') return formatItemLabel('image', index + 1, itemLabelLang());
  if (kind === 'table') return formatItemLabel('table', index + 1, itemLabelLang());
  if (kind === 'video') return formatItemLabel('video', index + 1, itemLabelLang());
  if (kind === 'link') return formatItemLabel('link', index + 1, itemLabelLang());
  if (kind === 'vector') return formatItemLabel('vector', index + 1, itemLabelLang());
  const text = String(el.text || '').trim();
  if (text) return truncateUi(text, 32);
  return formatItemLabel('text', index + 1, itemLabelLang());
}

function clipboardGroupFromState(state = workspaceGroupState) {
  const groups = Array.isArray(state?.groups) ? state.groups : [];
  return groups.find((g) => isClipboardGroup(g) || g.kind === CLIPBOARD_GROUP_KIND) || null;
}

function groupDisplayName(group) {
  if (isClipboardGroup(group) || group?.kind === CLIPBOARD_GROUP_KIND) {
    return currentLang === 'en' ? 'Clipboard' : '剪切板';
  }
  return String(group?.name || '').trim();
}

function captureGroupsFromState(state = workspaceGroupState) {
  const groups = Array.isArray(state?.groups) ? state.groups : [];
  return groups.filter((g) => !isClipboardGroup(g) && g.kind !== CLIPBOARD_GROUP_KIND);
}

function isSelectionChipKind(kind) {
  return kind !== 'text';
}

function getClipboardPins() {
  const g = clipboardGroupFromState();
  if (g && Array.isArray(g.items) && g.items.length) {
    const fromGroup = g.items
      .map((it) => ({
        id: String(it.webItemId || it.id || ''),
        text: String(it.text || it.preview?.textSnippet || ''),
        kind: it.kindHint || it.kind || 'text',
        pinned: true
      }))
      .filter((p) => p.id && p.text);
    if (fromGroup.length) return fromGroup;
  }
  return listClipboardItemsFromStore();
}

function pinTextsToClipboard(texts, { openDrawer = true, toast = true } = {}) {
  const toPin = (Array.isArray(texts) ? texts : [texts])
    .map((x) => (typeof x === 'string' ? { text: x } : x))
    .filter((x) => x && String(x.text || '').trim())
    .map((x) => ({ ...x, text: clipClipboardText(String(x.text)) })); // full text; host max only if MV3 would OOM
  if (!toPin.length) return [];
  const existing = new Set(getClipboardPins().map((p) => p.text));
  const fresh = toPin.filter((x) => !existing.has(String(x.text).trim()));
  if (!fresh.length) {
    if (toast) showQuickToast(t('toastClipDup'));
    if (openDrawer && getClipboardPins().length) {
      clipDrawerOpen = true;
      const bar = $('selectionBar');
      if (bar) {
        bar.classList.add('is-drawer-open');
        bar.setAttribute('aria-expanded', 'true');
      }
      renderClipboardUI();
      renderQuickTools();
    }
    return [];
  }
  pinClipboardItemsToStore(fresh);
  const clipG = clipboardGroupFromState();
  if (clipG && Array.isArray(workspaceGroupState.groups)) {
    const extras = fresh.map((f, i) => ({
      webItemId: f.id || `clip_tmp_${Date.now()}_${i}`,
      text: f.text,
      kindHint: f.kind || 'text',
      kind: f.kind || 'text'
    }));
    workspaceGroupState = {
      ...workspaceGroupState,
      groups: workspaceGroupState.groups.map((gr) => {
        if (gr.groupId !== clipG.groupId) return gr;
        const items = [...(gr.items || []), ...extras];
        return { ...gr, items, itemCount: items.length };
      })
    };
  }
  void workspaceRpc('pinClipboard', {
    sessionId: getWorkspaceSessionId(),
    items: fresh
  })
    .then((st) => {
      if (st && Array.isArray(st.groups)) workspaceGroupState = st;
      renderWorkspaceGroupControls();
      renderClipboardUI();
      renderQuickTools();
    })
    .catch(() => {
      /* local pins remain until workspace wakes */
    });
  if (toast) showQuickToast(t('toastClipAdd'));
  if (openDrawer) {
    clipDrawerOpen = true;
    const bar = $('selectionBar');
    if (bar) {
      bar.classList.add('is-drawer-open');
      bar.setAttribute('aria-expanded', 'true');
    }
  }
  renderClipboardUI();
  renderQuickTools();
  return fresh;
}

function persistClipboardRemove(ids) {
  removeClipboardIdsFromStore(ids);
  const set = new Set((ids || []).map(String));
  const clipG = clipboardGroupFromState();
  if (clipG && Array.isArray(workspaceGroupState.groups)) {
    workspaceGroupState = {
      ...workspaceGroupState,
      groups: workspaceGroupState.groups.map((gr) => {
        if (gr.groupId !== clipG.groupId) return gr;
        const items = (gr.items || []).filter((it) => !set.has(String(it.webItemId || it.id)));
        return { ...gr, items, itemCount: items.length };
      })
    };
  }
  void workspaceRpc('removeClipboardItems', {
    sessionId: getWorkspaceSessionId(),
    webItemIds: ids
  })
    .then((st) => {
      if (st && Array.isArray(st.groups)) workspaceGroupState = st;
      renderWorkspaceGroupControls();
      renderClipboardUI();
      renderQuickTools();
    })
    .catch(() => {});
}

function persistClipboardClear() {
  clearClipboardStore();
  dropPastedComposerAttachments();
  const clipG = clipboardGroupFromState();
  if (clipG && Array.isArray(workspaceGroupState.groups)) {
    workspaceGroupState = {
      ...workspaceGroupState,
      groups: workspaceGroupState.groups.map((gr) =>
        gr.groupId === clipG.groupId ? { ...gr, items: [], itemCount: 0 } : gr
      )
    };
  }
  void workspaceRpc('clearClipboard', { sessionId: getWorkspaceSessionId() })
    .then((st) => {
      if (st && Array.isArray(st.groups)) workspaceGroupState = st;
      renderWorkspaceGroupControls();
      renderClipboardUI();
      renderQuickTools();
    })
    .catch(() => {});
}

function copyTextToSystem(text) {
  const body = String(text || '');
  if (!body) return Promise.reject(new Error('empty'));
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(body);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = body;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function closeExportMenu() {
  if (clipExportPopover) {
    clipExportPopover.close();
  }
  const menu = $('clipExportMenu');
  if (menu) {
    menu.hidden = true;
    menu.classList.remove('is-open');
  }
  const exportBtn = $('clipExportBtn');
  if (exportBtn) exportBtn.setAttribute('aria-expanded', 'false');
}

function updateClipBulkActions() {
  const n = clipSelectedIds.size;
  const delBtn = $('clipDeleteSelectedBtn');
  const copyBtn = $('clipCopySelectedBtn');
  if (delBtn) {
    delBtn.hidden = n === 0;
    delBtn.textContent = n > 0 ? `${t('clipDeleteSelected')} (${n})` : t('clipDeleteSelected');
  }
  if (copyBtn) {
    copyBtn.hidden = n === 0;
    copyBtn.textContent = n > 0 ? `${t('clipCopySelected')} (${n})` : t('clipCopySelected');
  }
}

function renderClipboardUI() {
  const clipDrawer = $('clipDrawer');
  const clipList = $('clipList');
  const badgeClip = $('badgeClip');
  if (!clipDrawer || !clipList) return;
  const items = getClipboardPins();
  const selOpen = !!$('selectionBar')?.classList.contains('is-drawer-open');
  if (items.length === 0) {
    clipDrawerOpen = false;
    clipSelectedIds.clear();
    clipDrawer.hidden = true;
    clipDrawer.classList.remove('is-drawer-open');
    if (badgeClip) {
      badgeClip.hidden = true;
      badgeClip.textContent = '0';
    }
    closeExportMenu();
    return;
  }
  if (badgeClip) {
    badgeClip.hidden = false;
    badgeClip.textContent = String(items.length);
  }
  // Always co-show with selection expand (lives inside sel-expand-body)
  const show = selOpen;
  clipDrawerOpen = show;
  clipDrawer.hidden = !show;
  clipDrawer.classList.toggle('is-drawer-open', show);
  if (!show) closeExportMenu();
  clipSelectedIds = new Set([...clipSelectedIds].filter((id) => items.some((c) => c.id === id)));
  clipList.innerHTML = '';
  items.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'clip-item' + (clipSelectedIds.has(c.id) ? ' is-checked' : '');
    li.title = t('clipHint');
    li.innerHTML = `
      <input type="checkbox" class="clip-check" aria-label="select" ${clipSelectedIds.has(c.id) ? 'checked' : ''} />
      <span class="clip-item-text"></span>
      <button type="button" class="clip-item-x" title="删除" aria-label="delete">×</button>
    `;
    const textEl = li.querySelector('.clip-item-text');
    textEl.textContent = c.text;
    textEl.title = c.text;
    const check = li.querySelector('.clip-check');
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) clipSelectedIds.add(c.id);
      else clipSelectedIds.delete(c.id);
      li.classList.toggle('is-checked', check.checked);
      updateClipBulkActions();
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('.clip-check') || e.target.closest('.clip-item-x')) return;
      copyTextToSystem(c.text)
        .then(() => {
          li.classList.add('is-copied');
          showQuickToast(t('toastCopied'));
          setTimeout(() => li.classList.remove('is-copied'), 600);
        })
        .catch(() => showQuickToast(t('toastCopyFail')));
    });
    li.querySelector('.clip-item-x').addEventListener('click', (e) => {
      e.stopPropagation();
      void animateLeave(li).then(() => {
        persistClipboardRemove([c.id]);
        clipSelectedIds.delete(c.id);
        renderClipboardUI();
        renderQuickTools();
        showQuickToast(t('toastRemoved'));
      });
    });
    clipList.appendChild(li);
  });
  updateClipBulkActions();
  updateSelChipsOverflow();
}

function renderQuickTools() {
  const selExtra = $('selExtra');
  const quickTools = $('quickTools');
  const toolDlImg = $('toolDlImg');
  if (!selExtra || !quickTools) return;
  const counts = selectionCountsFrom(selectedElementsSummary);
  const nImg = counts.images;
  const nTable = counts.tables;
  const nLink = counts.links;
  const nFile = counts.files;
  const nSvg = counts.vectors;
  const nCover = counts.covers || 0;
  const nClip = getClipboardPins().length;
  const showHarvest = nImg > 0 || nTable > 0 || nLink > 0 || nFile > 0 || nSvg > 0 || nCover > 0;
  const showClip = nClip > 0;
  $('selectionBar')?.classList.toggle('has-clip', showClip);
  const selOpen = !!$('selectionBar')?.classList.contains('is-drawer-open');
  selExtra.hidden = !(showHarvest || showClip);
  const setTool = (id, n) => {
    const btn = $(id);
    if (!btn) return;
    btn.hidden = n <= 0;
    btn.disabled = n <= 0;
  };
  setTool('toolDlImg', nImg);
  setTool('toolExportTable', nTable);
  setTool('toolCopyLink', nLink);
  setTool('toolDlFile', nFile);
  setTool('toolDlSvg', nSvg);
  setTool('toolCoverLink', nCover);
  quickTools.hidden = !showHarvest;
  const badgeImg = $('badgeImg');
  const badgeClip = $('badgeClip');
  if (badgeImg) badgeImg.textContent = String(nImg);
  const badgeTable = $('badgeTable');
  const badgeLink = $('badgeLink');
  const badgeFile = $('badgeFile');
  const badgeSvg = $('badgeSvg');
  if (badgeTable) badgeTable.textContent = String(nTable);
  if (badgeLink) badgeLink.textContent = String(nLink);
  if (badgeFile) badgeFile.textContent = String(nFile);
  if (badgeSvg) badgeSvg.textContent = String(nSvg);
  const badgeCover = $('badgeCover');
  if (badgeCover) badgeCover.textContent = String(nCover);
  if (badgeClip) {
    badgeClip.textContent = String(nClip);
    badgeClip.hidden = nClip === 0;
  }
  if (nClip === 0) {
    clipDrawerOpen = false;
  } else if (selOpen) {
    clipDrawerOpen = true;
  }
  renderClipboardUI();
  try {
    syncHomeWorkSurfaceLayout();
  } catch (_) {}
}

function autoPinSelectionTexts(elements) {
  const fresh = [];
  (elements || []).forEach((el) => {
    if (classifyElementKind(el) !== 'text') return;
    const text = String(el.text || '').trim();
    if (!text) return;
    const key = text.slice(0, 200);
    if (autoPinnedTextKeys.has(key)) return;
    const existing = getClipboardPins().some((p) => String(p.text || '').trim() === text);
    if (existing) {
      autoPinnedTextKeys.add(key);
      return;
    }
    autoPinnedTextKeys.add(key);
    fresh.push({ text, kind: 'text' });
  });
  if (!fresh.length) return;
  pinTextsToClipboard(fresh, { openDrawer: true, toast: false });
}

function selectedClipboardItems() {
  const all = getClipboardPins();
  if (!clipSelectedIds.size) return all;
  const picked = all.filter((c) => clipSelectedIds.has(c.id));
  return picked.length ? picked : all;
}

function exportClipboard(fmt) {
  const items = selectedClipboardItems();
  if (!items.length) {
    showQuickToast(t('toastExportEmpty'));
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const n = items.length;
  let body = '';
  let mime = 'text/plain;charset=utf-8';
  let ext = 'txt';
  let fmtLabel = fmt;
  if (fmt === 'md') {
    const lines = ['# Clipboard export', '', `- items: ${n}`, ''];
    items.forEach((c, i) => {
      lines.push(`## ${i + 1}`, '', c.text, '');
    });
    body = lines.join('\n');
    mime = 'text/markdown;charset=utf-8';
    ext = 'md';
    fmtLabel = 'Markdown';
  } else if (fmt === 'csv') {
    const rows = ['"text"'].concat(items.map((c) => `"${String(c.text).replace(/"/g, '""')}"`));
    body = '\uFEFF' + rows.join('\n');
    mime = 'text/csv;charset=utf-8';
    ext = 'csv';
    fmtLabel = 'CSV';
  } else if (fmt === 'json') {
    body = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: n,
        items: items.map((c, i) => ({ index: i + 1, text: c.text }))
      },
      null,
      2
    );
    mime = 'application/json;charset=utf-8';
    ext = 'json';
    fmtLabel = 'JSON';
  } else if (fmt === 'html') {
    const blocks = items
      .map((c) => `<p>${escapeHtml(String(c.text || '')).replace(/\n/g, '<br>')}</p>`)
      .join('\n');
    body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clipboard</title></head><body>\n${blocks}\n</body></html>`;
    mime = 'text/html;charset=utf-8';
    ext = 'html';
    fmtLabel = 'HTML';
  } else {
    body = items.map((c) => c.text).join('\n\n-----\n\n');
    ext = 'txt';
    fmtLabel = 'TXT';
  }
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pagewand-clipboard-${stamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  closeExportMenu();
  showQuickToast(t('toastExportDone').replace('{fmt}', fmtLabel).replace('{n}', String(n)));
}

function renderSelectionUI() {
  const skipChipRebuild = !!skipSelectionChipRebuild;
  const elements = selectedElementsSummary || [];
  const { text: nText, images: nImg, tables: nTable, links: nLink, vectors: nVec, videos: nVid, pages: nPage } =
    selectionCountsFrom(elements);
  const chipEmpty = elements.every((el) => !isSelectionChipKind(classifyElementKind(el)));
  const selectionBar = $('selectionBar');
  const selSummary = $('selSummary');
  const clearSelBtn = $('clearSelBtn');
  const selChips = $('selChips');
  const hasClip = getClipboardPins().length > 0;
  // Text goes to the clipboard drawer, not the chip row. Collapse only when
  // there are no visual chips and no clipboard pins.
  const barren = chipEmpty && !hasClip;
  if (selectionBar) {
    selectionBar.classList.toggle('is-empty', barren);
    selectionBar.classList.toggle('is-sel-empty', chipEmpty);
  }
  if (selSummary) selSummary.hidden = chipEmpty;
  if (clearSelBtn) clearSelBtn.hidden = chipEmpty;
  // Nothing to show → force-collapse expand (no empty giant panel)
  if (barren && selectionBar?.classList.contains('is-drawer-open')) {
    const pin = $('pinSelBtn');
    if (!pin?.classList.contains('is-pinned')) {
      selectionBar.classList.remove('is-drawer-open');
      selectionBar.setAttribute('aria-expanded', 'false');
      clipDrawerOpen = false;
      $('selExpandBody')?.classList.remove('is-drawer-body-open');
    }
  }
  const pinSelBtn = $('pinSelBtn');
  if (pinSelBtn) {
    // Show pin when there is selection chrome or clipboard content to keep expanded
    pinSelBtn.hidden = barren;
    const pinned = pinSelBtn.classList.contains('is-pinned');
    const label = pinned ? t('pinSelActive') : t('pinSel');
    pinSelBtn.title = label;
    pinSelBtn.setAttribute('aria-label', label);
    pinSelBtn.setAttribute('data-title-unpinned', t('pinSel'));
    pinSelBtn.setAttribute('data-title-pinned', t('pinSelActive'));
  }
  // Welcome suggestions: guide-only when empty; else 3s-after-pick debounce
  try {
    scheduleSelectionSuggestions();
  } catch (_) {}
  // First selection → work surface (dock composer, hide hero logo) like post-send
  try {
    syncHomeWorkSurfaceLayout();
  } catch (_) {}
  // Visual chips or a clipboard pin: keep the panel awake after the last click
  if (!chipEmpty || hasClip || nText > 0) {
    try {
      holdDrawerOpen('selection', 2000);
    } catch (_) {}
  }

  [
    ['text', 0, 'countText'],
    ['image', nImg, 'countImage'],
    ['table', nTable, 'countTable'],
    ['link', nLink, 'countLink'],
    ['page', nPage, 'countPage'],
    ['vector', nVec, 'countVector'],
    ['video', nVid, 'countVideo']
  ].forEach(([kind, n, id]) => {
    const el = document.querySelector(`.sel-count[data-kind="${kind}"]`);
    const b = $(id);
    if (b) b.textContent = String(n);
    if (el) {
      el.hidden = n === 0;
      el.classList.toggle('has-count', n > 0);
    }
  });

  if (!selChips) {
    renderQuickTools();
    return;
  }
  if (!skipChipRebuild) selChips.innerHTML = '';
  selChips.hidden = chipEmpty;
  if (chipEmpty) {
    // No visual chips; clipboard / 下图 may still live in the expand body
    renderQuickTools();
    updateSelChipsOverflow();
    return;
  }

  if (skipChipRebuild) {
    renderQuickTools();
    updateSelChipsOverflow();
    return;
  }
  elements.forEach((item, index) => {
    const kind = classifyElementKind(item);
    if (!isSelectionChipKind(kind)) return;
    const chip = document.createElement('span');
    chip.className = 'sel-chip has-remove';
    chip.dataset.kind = kind === 'other' ? 'text' : kind;
    const label = elementLabel(item, index);
    chip.title = label;
    let main = '';
    if (kind === 'image') {
      main = `<span class="thumb" aria-hidden="true"></span><span class="label">${escapeHtml(label)}</span>`;
    } else if (kind === 'table') {
      main = `<span class="kind-mark">${escapeHtml(t('kindTable'))}</span><span class="label">${escapeHtml(label)}</span>`;
    } else if (kind === 'video') {
      main = `<span class="kind-mark">${currentLang === 'en' ? 'Video' : '视频'}</span><span class="label">${escapeHtml(label)}</span>`;
    } else if (kind === 'link') {
      main = `<span class="kind-mark">${currentLang === 'en' ? 'Link' : '链接'}</span><span class="label">${escapeHtml(label)}</span>`;
    } else if (kind === 'page') {
      const pageUrl = String(item.pageUrl || item.url || item.href || '').trim();
      chip.title = pageUrl || label;
      main = `<span class="kind-mark">${escapeHtml(t('kindPage'))}</span><span class="label">${escapeHtml(label)}</span>`;
    } else if (kind === 'vector') {
      main = `<span class="kind-mark">SVG</span><span class="label">${escapeHtml(label)}</span>`;
    } else {
      main = `<span class="kind-mark">${escapeHtml(t('kindText'))}</span><span class="label">${escapeHtml(label)}</span>`;
    }
    chip.innerHTML = `${main}<button type="button" class="chip-x" aria-label="remove">×</button>`;
    chip.querySelector('.chip-x').addEventListener('click', (e) => {
      e.stopPropagation();
      void animateLeave(chip).then(() => {
      chip.remove();
      selectedElementsSummary = (selectedElementsSummary || []).filter((it) => {
        if (item.webItemId) return it.webItemId !== item.webItemId;
        return it !== item;
      });
      if (item.webItemId && workspaceGroupState.activeGroupId) {
        if (item.tabId && typeof item.tabId === 'number' && item.selector) {
          chrome.tabs
            .sendMessage(item.tabId, { action: 'workspace_remove_selector', selector: item.selector })
            .catch(() => {});
        }
        void workspaceRpc('removeGroupItem', {
          sessionId: getWorkspaceSessionId(),
          groupId: workspaceGroupState.activeGroupId,
          webItemId: item.webItemId
        }).then((state) => {
          workspaceGroupState = state;
          renderWorkspaceGroupControls();
          skipSelectionChipRebuild = true;
          return refreshWorkspaceGroupState();
        }).finally(() => {
          skipSelectionChipRebuild = false;
        }).catch(() => {});
      }
      if (!item.webItemId && item.tabId && typeof item.tabId === 'number' && item.localIndex != null) {
        chrome.tabs.sendMessage(item.tabId, { action: 'remove_single_element', index: item.localIndex }).catch(() => {});
      }
      skipSelectionChipRebuild = true;
      renderSelectionUI();
      skipSelectionChipRebuild = false;
      });
    });
    chip.addEventListener('click', async (e) => {
      if (e.target.closest('.chip-x')) return;
      await revealCapturedElement(item);
    });
    if (item.webItemId && item.webItemId === focusedPageItemId) {
      chip.classList.add('is-flash');
      chip.addEventListener('animationend', () => chip.classList.remove('is-flash'), { once: true });
    }
    selChips.appendChild(chip);
  });
  if (focusedPageItemId) {
    window.setTimeout(() => {
      focusedPageItemId = '';
    }, 360);
  }
  renderQuickTools();
  updateSelChipsOverflow();
}

function animateLeave(els) {
  const nodes = (Array.isArray(els) ? els : [els]).filter(Boolean);
  if (!nodes.length) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = nodes.length;
    const finish = () => {
      pending -= 1;
      if (pending <= 0) resolve();
    };
    nodes.forEach((el) => {
      el.classList.add('is-leaving');
      const onEnd = (ev) => {
        if (ev.target !== el) return;
        el.removeEventListener('transitionend', onEnd);
        finish();
      };
      el.addEventListener('transitionend', onEnd);
    });
    window.setTimeout(resolve, 260);
  });
}

function markEdgeFade(el) {
  if (!el) return;
  el.classList.toggle('is-overflowing', el.scrollHeight > el.clientHeight + 2);
}

function updateSelChipsOverflow() {
  markEdgeFade($('selChips'));
  markEdgeFade(document.querySelector('.clip-drawer-body'));
  markEdgeFade($('panelScroll'));
  markEdgeFade(document.querySelector('#taskStream .session-thread:not([hidden]) .task-body'));
}

let skipSelectionChipRebuild = false;
let focusedPageItemId = '';

function wireSelOverflowListeners() {
  $('selChips')?.addEventListener('scroll', updateSelChipsOverflow, { passive: true });
  document.querySelector('.clip-drawer-body')?.addEventListener('scroll', updateSelChipsOverflow, { passive: true });
  $('panelScroll')?.addEventListener('scroll', updateSelChipsOverflow, { passive: true });
}

function capturedItemUrl(item) {
  return String(item?.url || item?.source?.url || '').trim();
}

function capturedItemTabId(item) {
  const raw = item?.tabId ?? item?.source?.tabId;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizePageViewUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}${u.search}${u.hash}`;
  } catch {
    return String(raw || '');
  }
}

function pageViewsMatch(a, b) {
  const left = normalizePageViewUrl(a);
  const right = normalizePageViewUrl(b);
  if (!left || !right) return false;
  return left === right;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabContentScript(tabId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status && tab.status !== 'complete' && Date.now() - start < timeoutMs - 200) {
        await sleepMs(120);
        continue;
      }
      await ensureContentScriptActive(tabId);
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return true;
    } catch (_) {
      await sleepMs(160);
    }
  }
  return false;
}

/**
 * Activate the capture tab, navigate back to the stored view if needed (Gmail
 * hash / SPA route), then ask the content script to rebind and scroll.
 */
async function revealCapturedElement(item) {
  const wantUrl = capturedItemUrl(item);
  let tabId = capturedItemTabId(item);
  try {
    if (tabId != null) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
        tabId = null;
      }
    }
    if (tabId == null && wantUrl) {
      const created = await chrome.tabs.create({ url: wantUrl, active: true });
      tabId = created?.id ?? null;
    }
    if (tabId == null) return;

    const tab = await chrome.tabs.get(tabId);
    const currentUrl = tab?.url || '';
    const needNav = !!(wantUrl && !pageViewsMatch(currentUrl, wantUrl));
    if (needNav) {
      await chrome.tabs.update(tabId, { active: true, url: wantUrl });
    } else {
      await chrome.tabs.update(tabId, { active: true });
    }
    const ready = await waitForTabContentScript(tabId, needNav ? 10000 : 4000);
    if (!ready) {
      showQuickToast(currentLang === 'en' ? 'Could not open that page' : '无法打开该元素所在页面');
      return;
    }
    // SPA views (Gmail categories) paint after the document is already complete.
    if (needNav) await sleepMs(280);
    const payload = {
      action: 'reveal_selection',
      selector: item.selector || item.locator?.css || '',
      src: item.src || item.preview?.src || '',
      text: item.text || item.preview?.textSnippet || '',
      tag: item.tag || item.tagName || item.preview?.tagName || '',
      localIndex: item.localIndex
    };
    const res = await chrome.tabs.sendMessage(tabId, payload);
    if (res?.status === 'not_found') {
      showQuickToast(
        currentLang === 'en'
          ? 'Opened the page, but that element is not in view'
          : '已打开所在页面，但该元素不在当前视图'
      );
    }
  } catch (err) {
    console.warn('[selection] reveal failed', err);
    showQuickToast(currentLang === 'en' ? 'Could not jump to that element' : '无法跳转到该元素');
  }
}

function renderCrossTabElementsUI() {
  const allElements = getFlattenedCrossTabElements();
  selectedElementsSummary = allElements;
  autoPinSelectionTexts(allElements);
  renderSelectionUI();
}

function updateChatSelectionChip() {
  /* retired — counts live in selection bar */
}

function updateSelectedElementsUI() {
  renderCrossTabElementsUI();
}

function updatePickerButtonState(active) {
  isPickerActive = !!active;
  const pickBtn = $('pickBtn');
  const pickBtnLabel = $('pickBtnLabel');
  const selectionBar = $('selectionBar');
  if (pickBtn) {
    pickBtn.classList.toggle('is-active', isPickerActive);
    pickBtn.setAttribute('aria-pressed', isPickerActive ? 'true' : 'false');
    const pickLabel = isPickerActive ? t('pickBtnActive') : t('pickBtn');
    pickBtn.setAttribute('aria-label', pickLabel);
    pickBtn.title = pickLabel;
  }
  if (pickBtnLabel) pickBtnLabel.textContent = isPickerActive ? t('pickBtnActive') : t('pickBtn');
  if (selectionBar) selectionBar.classList.toggle('is-picking', isPickerActive);
  renderSelectionUI();
}

function isPawSheetTabUrl(url) {
  const u = String(url || '');
  return /\/src\/preview\/sheet\.html(?:\?|$)/i.test(u) || /\/src\/preview\/artifactPreview\.html(?:\?|$)/i.test(u);
}

function pickerBlockedToast(url) {
  if (isPawSheetTabUrl(url)) {
    return currentLang === 'en'
      ? 'Paw is for web pages. Click cells in the sheet — they show above the composer.'
      : '伸爪用在网页上。格子请直接在表格里点，选区会出现在输入框上方。';
  }
  return currentLang === 'en'
    ? 'Cannot use Paw on this page.'
    : '当前页面无法伸爪（系统页或扩展页）。';
}

async function togglePickerMode() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showSidepanelToast(
        currentLang === 'en'
          ? 'Open and focus a normal web tab first.'
          : '请先打开并点一下普通网页标签，再伸爪。',
        { error: true }
      );
      return;
    }
    const url = tab.url || tab.pendingUrl || '';
    if (isPawWorkTabUrl(url)) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'toggle_picker' });
      if (response && response.active !== undefined) updatePickerButtonState(response.active);
      else updatePickerButtonState(!isPickerActive);
      return;
    }
    if (isUnscriptableTabUrl(url)) {
      showSidepanelToast(pickerBlockedToast(url), { error: true });
      return;
    }
    const injected = await ensureContentScriptActive(tab.id);
    if (!injected) {
      showSidepanelToast(
        currentLang === 'en'
          ? 'Paw failed — refresh the web page after Reload.'
          : '伸爪失败：请刷新那个网页后再试（刚 Reload 扩展必须刷新页面）。',
        { error: true }
      );
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'toggle_picker' });
    if (response && response.active !== undefined) updatePickerButtonState(response.active);
    else updatePickerButtonState(!isPickerActive);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (isUnscriptableInjectError(e) || /Receiving end does not exist/i.test(msg)) {
      showSidepanelToast(
        currentLang === 'en'
          ? 'Paw failed — focus a web tab and refresh it.'
          : '伸爪失败：请点到普通网页并刷新后再试。',
        { error: true }
      );
      return;
    }
    console.warn('toggle picker failed', e);
    showSidepanelToast(currentLang === 'en' ? 'Paw failed — refresh the page' : '伸爪失败，请刷新页面后重试', {
      error: true
    });
  }
}

/**
 * Exit pick mode when user returns to the side panel to type a message.
 * Idempotent: no-op if picker is already off.
 */
async function exitPickerModeIfActive() {
  if (!isPickerActive) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        const url = tab.url || tab.pendingUrl || '';
        if (!isPawWorkTabUrl(url)) await ensureContentScriptActive(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'stop_picker' });
        if (res && res.active !== undefined) {
          updatePickerButtonState(!!res.active);
          return;
        }
      } catch (_) {
        // Content script may be gone — still clear UI state
      }
    }
  } catch (_) {}
  updatePickerButtonState(false);
}

async function clearSelection() {
  const chips = [...($('selChips')?.querySelectorAll('.sel-chip') || [])];
  await animateLeave(chips);
  selectedElementsSummary = [];
  crossTabStore.clear();
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { action: 'clear_selection' }).catch(() => {});
    }
  } catch (_) {}
  try {
    workspaceGroupState = await workspaceRpc('clearCaptureSelection', {
      sessionId: getWorkspaceSessionId()
    });
  } catch (err) {
    console.warn('[workspace] clearCaptureSelection failed', err);
  }
  renderWorkspaceGroupControls();
  renderCrossTabElementsUI();
  renderSelectionUI();
  // Page chips only — leftover clipboard stays hoverable / open
  try {
    syncHomeWorkSurfaceLayout();
  } catch (_) {}
}

// ── Whole-panel scroll (single scrollport #panelScroll) ──
/**
 * Product: never auto-jump the viewport while the agent streams / thinks.
 * Callers that still invoke this are no-ops unless `{ force: true }` (rare, intentional).
 * @param {{ force?: boolean }} [opts]
 */
function scrollTaskStream(opts = {}) {
  if (!opts?.force) return;
  const root = getConversationScrollRoot();
  if (!root) return;
  requestAnimationFrame(() => {
    root.scrollTop = root.scrollHeight;
  });
}

/** Meta finish.summary for trajectory — not the chat bubble */
function looksLikeFinishMetaSummary(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  // Long structured replies are never audit meta
  if (t.length > 500 && (t.includes('\n\n') || t.includes('**') || /^[-*]\s/m.test(t))) {
    return false;
  }
  if (t.length > 900) return false;
  if (
    /已回答用户|未做任何页面|任务已完成|not_required|能力范围的询问|verification\s*[:=]|audit\s*only|short\s*audit/i.test(
      t
    )
  ) {
    if (
    /\n\n|\*\*|你好[！!]|Hello[,!]|我是 PageWand|我是爪爪|I am PageWand|Paw Work|以下是|Here's what/i.test(
      t
    )
  ) {
      return t.length < 120;
    }
    return true;
  }
  if (t.length < 80 && /^(done|ok|finished|完成|已完成|成功)[.。!！]?$/i.test(t)) return true;
  return false;
}

/**
 * Choose what the user sees after a run.
 * Streamed assistant prose / trajectory assistantText ≫ finish.summary meta.
 * Thinking/tools stay hidden in the collapsible block.
 */
function pickUserFacingAnswer({
  assistantText,
  trajectoryAssistant,
  streamedProse,
  finishSummary,
  thoughtBuffer,
  failed,
  lang
}) {
  const candidates = [streamedProse, assistantText, trajectoryAssistant]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  for (const c of candidates) {
    if (!looksLikeFinishMetaSummary(c)) return c;
  }
  // Prefer any real-length prose over meta even if heuristic is uncertain
  for (const c of candidates) {
    if (c.length > 120) return c;
  }

  // Pull prose from thought dump: first long Chinese/English block that looks like the reply
  const buf = String(thoughtBuffer || '');
  const m = buf.match(
    /((?:你好|您好|Hi|Hello|我是 PageWand|I am PageWand)[\s\S]{40,8000}?)(?:\n→\s*finish|\n✓\s*finish|\n—\s*Step|\n\[metrics\]|$)/i
  );
  if (m?.[1] && !looksLikeFinishMetaSummary(m[1])) return m[1].trim();

  // Strip tool lines from buffer and take remaining long text blocks
  const stripped = buf
    .replace(/^→\s+\w+.*$/gm, '')
    .replace(/^✓\s+\w+.*$/gm, '')
    .replace(/^—\s*Step.*$/gm, '')
    .replace(/^\[(?:kernel|metrics|skill|finish-gate)\].*$/gm, '')
    .trim();
  if (stripped.length > 80 && !looksLikeFinishMetaSummary(stripped)) {
    return stripped.slice(0, 12000);
  }

  const fs = String(finishSummary || '').trim();
  if (fs && !looksLikeFinishMetaSummary(fs)) return fs;
  // Last resort: any candidate (better than empty) — but label is not upgraded to "success"
  if (candidates[0] && !looksLikeFinishMetaSummary(candidates[0])) return candidates[0];
  if (candidates.find((c) => c.length > 40)) return candidates.find((c) => c.length > 40);
  if (fs && !looksLikeFinishMetaSummary(fs)) return fs;
  // Do NOT surface pure audit meta as the bubble when we can say Done
  if (failed) return lang === 'en' ? '**Task failed.**' : '**任务失败。**';
  if (candidates[0] && !looksLikeFinishMetaSummary(candidates[0])) return candidates[0];
  return lang === 'en' ? '**Done.**' : '**任务已完成。**';
}

/**
 * FLIP animate elements from pre-mutation rects to post layout.
 * @param {Array<{ el: HTMLElement, first: DOMRect }>} shots
 * @param {number} durationMs
 */
function flipPlay(shots, durationMs = 420) {
  if (!shots?.length) return;
  const reduce =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  for (const { el, first } of shots) {
    if (!el || !first) continue;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = last.width ? first.width / last.width : 1;
    const sy = last.height ? first.height / last.height : 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) {
      continue;
    }
    el.classList.add('is-docking-motion');
    try {
      const anim = el.animate(
        [
          {
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            transformOrigin: 'top left'
          },
          { transform: 'none', transformOrigin: 'top left' }
        ],
        {
          duration: durationMs,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both'
        }
      );
      anim.finished
        .catch(() => {})
        .finally(() => {
          el.classList.remove('is-docking-motion');
        });
    } catch (_) {
      el.classList.remove('is-docking-motion');
    }
  }
}

function dockComposerToFooter(composer, panel) {
  const scroll = $('panelScroll');
  if (!composer || !panel) return;
  if (composer.parentElement === panel && scroll && composer.previousElementSibling === scroll) {
    return; // already docked
  }
  if (scroll?.nextSibling) {
    panel.insertBefore(composer, scroll.nextSibling);
  } else {
    panel.appendChild(composer);
  }
}

/**
 * Home empty layout: portal composer into centered slot (MaxAI-style).
 * Pick/screenshot stay under topbar; first message FLIP-docks composer to footer.
 */
function setHomeEmptyMode(on, opts = {}) {
  const panel = $('panel') || document.querySelector('.panel');
  const composer = document.querySelector('footer.composer') || document.querySelector('.composer');
  const selectionBar = $('selectionBar');
  if (!panel || !composer) return;

  const wasHome = panel.classList.contains('is-home-empty');
  const animate = opts.animate !== false;

  if (on) {
    panel.classList.add('is-home-empty');
    const slot = $('homeComposerSlot');
    if (slot && composer.parentElement !== slot) {
      // Entering home: optional reverse FLIP (usually no need on cold boot)
      slot.appendChild(composer);
    }
    try {
      const sid = getWorkspaceSessionId();
      if (bindHintDismissed.has(sid)) {
        bindHintDismissed.delete(sid);
        persistBindHintDismissed();
      }
      syncBindGroupHint();
    } catch (_) {}
    return;
  }

  // Leaving home → dock footer; motion when we were actually home-empty
  if (!wasHome) {
    panel.classList.remove('is-home-empty');
    dockComposerToFooter(composer, panel);
    try { syncBindGroupHint(); } catch (_) {}
    return;
  }

  const shots = [];
  if (animate) {
    try {
      shots.push({ el: composer, first: composer.getBoundingClientRect() });
      if (selectionBar) {
        shots.push({ el: selectionBar, first: selectionBar.getBoundingClientRect() });
      }
    } catch (_) {}
  }

  // Remove welcome first only if caller already did; mode flag + reparent here
  panel.classList.remove('is-home-empty');
  dockComposerToFooter(composer, panel);

  // Force layout so FLIP "last" is correct
  void panel.offsetHeight;
  if (animate && shots.length) {
    flipPlay(shots, 440);
  }
  try { syncBindGroupHint(); } catch (_) {}
}

function hideWelcome(opts = {}) {
  const panel = $('panel') || document.querySelector('.panel');
  const wasHome = !!panel?.classList.contains('is-home-empty');
  // Dock composer out of #homeComposerSlot BEFORE removing welcome (or composer is removed too)
  setHomeEmptyMode(false, { animate: opts.animate !== false && wasHome });
  panel?.classList.remove('is-home-working');
  const welcome = $('welcome');
  if (welcome && welcome.parentNode) welcome.remove();
}

/**
 * Work surface (same spirit as post-send layout):
 * first page selection → hide hero logo, dock composer to bottom.
 * Clear ALL selected elements → restore centered Logo home only when clipboard is also empty.
 */
function hasHomeWorkSurface() {
  return (selectedElementsSummary || []).length > 0 || getClipboardPins().length > 0;
}

function syncHomeWorkSurfaceLayout() {
  const panel = $('panel') || document.querySelector('.panel');
  if (!panel) return;
  // Live task already left welcome via hideWelcome
  if (liveTask) {
    panel.classList.remove('is-home-working');
    return;
  }
  const welcome = $('welcome');
  const working = hasHomeWorkSurface();
  if (working) {
    panel.classList.add('is-home-working');
    // Same as first message: dock input to footer (FLIP if leaving centered home)
    if (panel.classList.contains('is-home-empty')) {
      setHomeEmptyMode(false, { animate: true });
    } else {
      dockComposerToFooter(
        document.querySelector('footer.composer') || document.querySelector('.composer'),
        panel
      );
    }
    if (welcome) {
      welcome.classList.add('is-work-surface');
      const mark = welcome.querySelector('.home-mark');
      if (mark) {
        mark.hidden = false; // keep as watermark (not removed)
        mark.classList.add('is-watermark');
        mark.setAttribute('aria-hidden', 'true');
      }
    }
  } else {
    // —— Return to Logo home ——
    panel.classList.remove('is-home-working');
    // Clearing page selection must not tear down leftover clipboard.
    if (getClipboardPins().length === 0) {
      try {
        setDrawerPinned('selection', false);
        closeDrawer('selection', { force: true });
      } catch (_) {}
    }
    if (!welcome) {
      if (!liveTask && historyRecords.length === 0) showWelcome();
      else return;
    }
    const w = $('welcome');
    if (!w) return;
    w.classList.remove('is-work-surface');
    const mark = w.querySelector('.home-mark');
    if (mark) {
      mark.hidden = false;
      mark.classList.remove('is-watermark');
      mark.setAttribute('aria-hidden', 'true');
    }
    // Restore hero home (logo + centered composer)
    setHomeEmptyMode(true, { animate: true });
    try {
      enhanceTopbarIcons();
    } catch (_) {}
    try {
      renderHintChips(getGuideOnlyHints());
    } catch (_) {}
  }
}

function formatWorkspaceMb(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  if (mb <= 0) return '0 MB';
  if (mb < 0.01) return '<0.01 MB';
  if (mb < 10) return `${mb.toFixed(2)} MB`;
  return `${mb.toFixed(1)} MB`;
}

function applyWorkspaceStatsToHeaders() {
  const size = formatWorkspaceMb(lastWorkspaceStats.bytes);
  const n = Math.max(0, Number(lastWorkspaceStats.fileCount) || 0);
  const label = t('workspaceStats').replace('{size}', size).replace('{n}', String(n));
  const tip = t('workspaceStatsTitle');
  document.querySelectorAll('[data-session-stats]').forEach((el) => {
    el.textContent = label;
    el.title = tip;
    if (!el.dataset.artifactOpenBound) {
      el.dataset.artifactOpenBound = '1';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      const open = () => {
        setArtifactRailOpen(true);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
  });
}

function activeSessionName() {
  const sess = sessions.find((s) => s.id === activeSessionId);
  const raw = String(sess?.name || '').trim();
  if (raw) return raw;
  return currentLang === 'en' ? 'Task' : '任务';
}

function nextLocalTaskName() {
  let max = 0;
  for (const s of sessions) {
    const m = String(s.name || '').match(/(?:任务|Task|会话|Session)\s*(\d+)/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  return currentLang === 'en' ? `Task ${n}` : `任务 ${n}`;
}

function getConversationScrollRoot() {
  return (
    document.querySelector('#taskStream .session-thread:not([hidden]) .task-body') ||
    $('panelScroll') ||
    $('taskStream')
  );
}

/** Chat-window chrome: session name in the thread header; pin layout class. */
function syncConversationChrome() {
  const panel = $('panel') || document.querySelector('.panel');
  const open = !!document.querySelector(
    '#taskStream .session-thread:not([hidden]), #taskStream .task-card:not([hidden])'
  );
  panel?.classList.toggle('is-thread-open', open);
  const name = activeSessionName();
  document.querySelectorAll('#taskStream .task-title').forEach((el) => {
    el.textContent = name;
    el.title = name;
  });
  applyWorkspaceStatsToHeaders();
}

function showWelcome() {
  const taskStream = $('taskStream');
  if (!taskStream) return;
  const sid = getWorkspaceSessionId();
  taskStream.querySelectorAll('.viewing-banner').forEach((n) => n.remove());
  // Park this session's thread; never destroy other sessions' live cards.
  taskStream.querySelectorAll('.session-thread, .task-card').forEach((n) => {
    if (String(n.dataset.sessionId || '') === sid) n.hidden = true;
  });
  hideForeignSessionThreads(sid);
  liveTask = null;
  viewingHistoryId = null;
  rebuildTurnJumpRail();
  const panel = $('panel') || document.querySelector('.panel');
  panel?.classList.remove('is-home-working');
  syncConversationChrome();
  if ($('welcome')) {
    const w0 = $('welcome');
    w0.classList.remove('is-work-surface');
    const mark0 = w0.querySelector('.home-mark');
    if (mark0) {
      mark0.hidden = false;
      mark0.classList.remove('is-watermark');
    }
    setHomeEmptyMode(true);
    return;
  }
  const w = document.createElement('div');
  w.className = 'welcome';
  w.id = 'welcome';
  w.innerHTML = `
    <div class="home-center" id="homeCenter">
      <div class="home-mark home-mark-paw" aria-hidden="true"></div>
      <div class="home-composer-slot" id="homeComposerSlot"></div>
      <div class="hint-chips" id="hintChips"></div>
    </div>
  `;
  taskStream.appendChild(w);
  renderHintChips(getGuideOnlyHints());
  setHomeEmptyMode(true);
  applyI18n();
  try {
    enhanceTopbarIcons();
  } catch (_) {}
}

/** @returns {{ label: string, prompt: string }[]} */
function getGuideOnlyHints() {
  return [
    {
      label: t('guideChipLabel'),
      prompt: t('guideChipPrompt')
    }
  ];
}

function summarizeSelectionForSuggest(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const counts = selectionCountsFrom(list);
  const clips = getClipboardPins()
    .slice(0, 4)
    .map((p) => String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean);
  const pageUrl = String(list.find((el) => el.pageUrl || el.url)?.pageUrl || list.find((el) => el.url)?.url || '').slice(
    0,
    180
  );
  const items = list.slice(0, 10).map((el, i) => {
    const kind = classifyElementKind(el);
    return {
      kind,
      label: String(elementLabel(el, i) || '').slice(0, 40),
      text: String(el.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      src: String(el.src || '').slice(0, 120)
    };
  });
  return {
    lang: currentLang,
    pageUrl,
    counts: {
      text: counts.text,
      images: counts.images,
      tables: counts.tables,
      links: counts.links,
      pages: counts.pages,
      total: counts.total
    },
    items,
    clipboard: clips
  };
}

/**
 * Fallback chips when the model is unavailable. Prefer suggestSelectionActions.
 * @param {any[]} elements
 * @returns {{ label: string, prompt: string }[]}
 */
function buildSelectionHints(elements) {
  const list = Array.isArray(elements) ? elements : [];
  if (!list.length) return getGuideOnlyHints();
  const { text: nText, images: nImg, tables: nTable, total } = selectionCountsFrom(list);
  /** @type {{ label: string, prompt: string }[]} */
  const out = [];
  const en = currentLang === 'en';
  if (nImg > 0) {
    out.push({
      label: en ? `Download ${nImg} image(s)` : `下载选中的 ${nImg} 张图`,
      prompt: en
        ? `Download the ${nImg} currently selected image(s) to my computer.`
        : `请下载当前选中的 ${nImg} 张图片到本机。`
    });
    out.push({
      label: en ? 'Extract image URLs' : '提取图片链接',
      prompt: en
        ? 'List the URLs of the selected images.'
        : '列出当前选中图片的 URL 链接。'
    });
    if (nImg >= 2) {
      out.push({
        label: en ? 'Compose into one image' : '合成一张图',
        prompt: en
          ? `Compose the ${nImg} selected images into one cohesive picture. Keep the main subjects recognizable.`
          : `把当前选中的 ${nImg} 张图合成一张完整的图，主体保持可辨认。`
      });
    }
  }
  if (nText > 0) {
    out.push({
      label: en ? 'Extract selected text' : '提取选中文本',
      prompt: en
        ? 'Extract and clean the selected text for me.'
        : '提取并整理当前选中的文本。'
    });
  }
  if (nTable > 0) {
    out.push({
      label: en ? 'Export table as CSV' : '导出表格为 CSV',
      prompt: en
        ? 'Export the selected table(s) as CSV.'
        : '把选中的表格导出为 CSV。'
    });
  }
  if (total > 0 && out.length < 2) {
    out.push({
      label: en ? `Work with ${total} selected` : `处理选中的 ${total} 项`,
      prompt: en
        ? `Help me work with the ${total} elements I selected on this page.`
        : `帮我处理当前页面上选中的 ${total} 个元素。`
    });
  }
  // Cap at 4 chips
  return out.slice(0, 4);
}

/** @type {ReturnType<typeof setTimeout>|null} */
let suggestionDebounceTimer = null;
/** Generation generation token — discard stale renders */
let suggestionGenToken = 0;

/**
 * Render hint chips into #hintChips (welcome only).
 * @param {{ label: string, prompt: string }[]} items
 */
function renderHintChips(items) {
  const host =
    document.getElementById('hintChips') ||
    document.querySelector('#welcome .hint-chips');
  if (!host) return;
  host.innerHTML = '';
  const list = Array.isArray(items) && items.length ? items : getGuideOnlyHints();
  list.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hint-chip';
    btn.textContent = item.label;
    btn.setAttribute('data-prompt', item.prompt);
    btn.addEventListener('click', () => {
      if (isCurrentSessionRunning()) return;
      const input = composerEl();
      if (input) {
        setComposerPlainText(item.prompt, input);
        submitUserPrompt();
      }
    });
    host.appendChild(btn);
  });
}

/**
 * Debounced suggestion refresh after selection settles (3s idle).
 * Continuous picks reset the timer; new gen discards previous chips.
 */
function scheduleSelectionSuggestions() {
  const welcome = $('welcome');
  if (!welcome) return; // only on empty-state welcome
  if (suggestionDebounceTimer) {
    clearTimeout(suggestionDebounceTimer);
    suggestionDebounceTimer = null;
  }
  const token = ++suggestionGenToken;
  const elements = selectedElementsSummary || [];
  if (!elements.length) {
    renderHintChips(getGuideOnlyHints());
    return;
  }
  // Show loading placeholder while waiting for idle + model infer
  const host = document.getElementById('hintChips');
  if (host) {
    host.innerHTML = `<span class="hint-chips-pending">${
      currentLang === 'en' ? 'Suggestions after you stop selecting…' : '伸爪结束后将生成建议…'
    }</span>`;
  }
  suggestionDebounceTimer = setTimeout(() => {
    suggestionDebounceTimer = null;
    if (token !== suggestionGenToken) return;
    void inferSelectionHintChips(token);
  }, 3000);
}

async function inferSelectionHintChips(token) {
  if (token !== suggestionGenToken) return;
  const now = selectedElementsSummary || [];
  if (!now.length) {
    renderHintChips(getGuideOnlyHints());
    return;
  }
  const host = document.getElementById('hintChips');
  if (host) {
    host.innerHTML = `<span class="hint-chips-pending">${
      currentLang === 'en' ? 'Inferring from your selection…' : '正在根据选区推断…'
    }</span>`;
  }
  if (isCurrentSessionRunning()) {
    renderHintChips(buildSelectionHints(now));
    return;
  }
  try {
    const res = await workspaceRpc('suggestSelectionActions', {
      sessionId: getWorkspaceSessionId(),
      lang: currentLang,
      selection: summarizeSelectionForSuggest(now)
    });
    if (token !== suggestionGenToken) return;
    const chips = Array.isArray(res?.chips) ? res.chips : [];
    if (chips.length) {
      renderHintChips(chips);
      return;
    }
  } catch (_) {
    /* no key / timeout / offscreen — rule chips */
  }
  if (token !== suggestionGenToken) return;
  renderHintChips(buildSelectionHints(now));
}

function snapshotTask(task) {
  return {
    id: task.id,
    title: task.title,
    state: task.stateEl?.getAttribute('data-state') || 'done',
    bodyHTML: task.body?.innerHTML || '',
    runId: task.runId || null,
    thoughtText: task.thoughtText || '',
    finalContent: task.finalContent || '',
    taskState: task.taskState || null
  };
}

function archiveLiveTaskIfAny() {
  if (!liveTask || !liveTask.el) return;
  const rec = snapshotTask(liveTask);
  historyRecords = [rec, ...historyRecords.filter((r) => r.id !== rec.id)];
  if (historyRecords.length > 40) historyRecords = historyRecords.slice(0, 40);
  liveTask.el.remove();
  liveTask = null;
  renderHistoryList();
}

function renderHistoryList() {
  // Legacy in-thread history bar stays hidden; tasks render in left session rail.
  const historyBar = $('historyBar');
  if (historyBar) historyBar.hidden = true;

  const foot = $('sessionRailFoot');
  const tasks = $('sessionRailTasks');
  if (!foot || !tasks) return;
  tasks.innerHTML = '';
  if (!historyRecords.length) {
    foot.hidden = true;
    return;
  }
  foot.hidden = false;
  historyRecords.slice(0, 12).forEach((rec) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'session-rail-task' + (viewingHistoryId === rec.id ? ' is-selected' : '');
    row.title = rec.title || rec.id;
    row.textContent = rec.title || rec.id;
    row.addEventListener('click', () => openHistoryRecord(rec.id));
    tasks.appendChild(row);
  });
}

/**
 * Re-bind think-block expand toggles after restoring HTML from history.
 * History view must keep thinking expandable (user request).
 * @param {ParentNode} root
 */
function rebindHistoryThinkBlocks(root) {
  if (!root) return;
  root.querySelectorAll('.think-block').forEach((block) => {
    const toggle = block.querySelector('.think-toggle');
    if (!toggle || toggle.dataset.thinkBound || toggle.dataset.historyBound) return;
    toggle.dataset.historyBound = '1';
    toggle.disabled = false;
    // Restore from snapshot classes
    let expanded = block.classList.contains('is-expanded');
    const sync = () => {
      block.classList.toggle('is-expanded', expanded);
      block.classList.toggle('is-collapsed', !expanded);
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const chev = block.querySelector('.think-chevron');
      if (chev) chev.textContent = expanded ? '▾' : '▸';
    };
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      expanded = !expanded;
      sync();
    });
    sync();
  });
}

function openHistoryRecord(id) {
  if (isCurrentSessionRunning()) return;
  const rec = historyRecords.find((r) => r.id === id);
  if (!rec) return;
  const taskStream = $('taskStream');
  if (!taskStream) return;
  if (liveTask?.el) liveTask.el.hidden = true;
  viewingHistoryId = id;
  const sid = getWorkspaceSessionId();
  taskStream.querySelectorAll('.session-thread, .task-card, .viewing-banner').forEach((n) => {
    if (liveTask && n === liveTask.el) return;
    const nid = String(n.dataset.sessionId || '');
    if (nid && nid !== sid) {
      n.hidden = true;
      return;
    }
    if (n.classList.contains('viewing-banner') || n.classList.contains('is-history-view')) n.remove();
    else n.hidden = true;
  });
  hideWelcome();
  const banner = document.createElement('div');
  banner.className = 'viewing-banner';
  banner.innerHTML = `<span class="viewing-text"></span><button type="button" class="back-latest"></button>`;
  banner.querySelector('.viewing-text').textContent = t('viewingPast');
  const back = banner.querySelector('.back-latest');
  back.textContent = t('backToLatest');
  back.addEventListener('click', () => closeHistoryView());
  taskStream.appendChild(banner);
  const card = document.createElement('article');
  card.className = 'session-thread task-card is-history-view';
  card.innerHTML = `
    <div class="task-header">
      <div class="task-header-left">
        <div class="task-title"></div>
      </div>
      <span class="task-workspace-stats" data-session-stats></span>
    </div>
    <div class="task-body">${rec.bodyHTML}</div>
  `;
  card.querySelector('.task-title').textContent = activeSessionName();
  // Disable action buttons (script re-run etc.) but keep think toggles + trajectory download
  card.querySelectorAll('button').forEach((b) => {
    if (b.classList.contains('think-toggle')) return;
    if (b.classList.contains('task-traj-btn') || b.classList.contains('session-traj-btn') || b.classList.contains('back-latest')) return;
    b.disabled = true;
  });
  mountSessionTrajectoryButton({ el: card });
  // Per-task trajectory download in history view (same mount helper as live)
  if (rec.runId) {
    const fakeTask = {
      body: card.querySelector('.task-body'),
      title: rec.title,
      thoughtText: rec.thoughtText || ''
    };
    mountTaskTrajectoryButton(fakeTask, rec.runId, {
      thoughtText: rec.thoughtText || '',
      title: rec.title || ''
    });
  }
  rebindHistoryThinkBlocks(card);
  taskStream.appendChild(card);
  renderHistoryList();
  syncConversationChrome();
  getConversationScrollRoot().scrollTop = 0;
}

function closeHistoryView() {
  viewingHistoryId = null;
  const taskStream = $('taskStream');
  taskStream?.querySelectorAll('.session-thread.is-history-view, .task-card.is-history-view, .viewing-banner').forEach((n) => n.remove());
  if (liveTask?.el) {
    liveTask.el.hidden = false;
    syncConversationChrome();
    scrollTaskStream();
  } else if (historyRecords.length === 0) {
    showWelcome();
  } else {
    syncConversationChrome();
  }
  renderHistoryList();
}

async function clearAllHistory() {
  if (isCurrentSessionRunning()) return;
  const okHist = await confirmInApp(t('clearHistoryConfirm'));
  if (!okHist) return;
  historyRecords = [];
  viewingHistoryId = null;
  const clearSid = getWorkspaceSessionId();
  if (liveTask?.el && liveTask.sessionId === clearSid) {
    liveTask.el.remove();
    liveTask = null;
    uiState(clearSid).liveTask = null;
  }
  $('taskStream')?.querySelectorAll('.session-thread, .task-card, .viewing-banner').forEach((n) => {
    const nid = String(n.dataset.sessionId || '');
    if (nid && nid !== clearSid) return;
    n.remove();
  });
  showWelcome();
  renderHistoryList();
}

/**
 * @param {string} title
 * @param {{ kind?: 'task'|'chat', continueExisting?: boolean }} [opts]
 */
function createTaskCard(title, opts = {}) {
  viewingHistoryId = null;
  const taskStream = $('taskStream');
  if (!taskStream) return null;
  const sid = String(opts.sessionId || getWorkspaceSessionId());
  const parked = uiState(sid).liveTask;
  taskStream.querySelectorAll('.session-thread.is-history-view, .task-card.is-history-view, .viewing-banner').forEach((n) => n.remove());

  // Multi-turn: reuse open live task (header stays the session name)
  if (opts.continueExisting && parked?.el && parked.sessionId === sid) {
    mountSessionThreadEl(parked.el, sid);
    liveTask = parked;
    parked.setState('running');
    parked.el.classList.add('is-active');
    if (opts.kind === 'task' && parked.kind === 'chat') {
      parked.kind = 'task';
      parked.el.dataset.kind = 'task';
    }
    if (getWorkspaceSessionId() === sid) {
      hideForeignSessionThreads(sid);
      syncConversationChrome();
      scrollTaskStream();
    } else {
      parked.el.hidden = true;
    }
    return parked;
  }

  // New task: workers from previous task do not follow
  try {
    // dual-agent abandonWorkers removed
  } catch (_) {}

  if (parked?.el && parked.sessionId === sid) {
    archiveLiveTaskIfAny();
  }
  if (getWorkspaceSessionId() === sid) hideWelcome();
  taskSeq += 1;
  const id = taskSeq;
  const kind = opts.kind === 'chat' ? 'chat' : 'task';
  const card = document.createElement('article');
  card.className = 'session-thread task-card is-active';
  card.dataset.taskId = String(id);
  card.dataset.kind = kind;
  card.dataset.sessionId = sid;
  card.innerHTML = `
    <div class="task-header">
      <div class="task-header-left">
        <div class="task-title"></div>
      </div>
      <span class="task-workspace-stats" data-session-stats></span>
    </div>
    <div class="task-body"></div>
  `;
  card.querySelector('.task-title').textContent = activeSessionName();
  taskStream.appendChild(card);
  if (getWorkspaceSessionId() === sid) {
    hideForeignSessionThreads(sid);
    syncConversationChrome();
    scrollTaskStream();
  } else {
    card.hidden = true;
  }
  mountSessionTrajectoryButton({ el: card });
  const handle = {
    id,
    sessionId: sid,
    title,
    kind,
    messages: [],
    workers: [],
    el: card,
    body: card.querySelector('.task-body'),
    stateEl: null,
    setState(s) {
      // Product: never show success/failed chips on the card.
      // is-active = live conversation chrome (flow border), not "agent running".
      this._state = s;
      card.classList.add('is-active');
    },
    append(node) {
      this.body.appendChild(node);
      scrollTaskStream();
      return node;
    }
  };
  liveTask = handle;
  uiState(sid).liveTask = handle;
  taskStatusUi.mount();
  renderHistoryList();
  return handle;
}

function thinkDoneLabel(duration = '', effort = reasoningEffort) {
  if (!effort || effort === 'none') {
    return t('thinkingNoneDone');
  }
  return t('thinkingDone')
    .replace('{level}', effortDisplayName(effort))
    .replace('{duration}', duration)
    .replace('{sec}', duration)
    .replace('{n}', '')
    .replace(/\s+/g, ' ')
    .trim();
}

function thinkLiveLabel(duration = '', expanded = false, effort = reasoningEffort) {
  if (!effort || effort === 'none') {
    return t('thinkingNoneLive').replace('{duration}', duration);
  }
  const key = expanded ? 'thinkingLiveProgress' : 'thinkingLiveCollapsed';
  return t(key)
    .replace('{level}', effortDisplayName(effort))
    .replace('{duration}', duration)
    .replace('{n}', '');
}

function isThinkPlaceholderText(raw) {
  return /等待模型思考|Waiting for model reasoning/i.test(String(raw || '')) && !/→ |✓ |✗ /.test(String(raw || ''));
}

function createThinkBlockEl() {
  const block = document.createElement('div');
  block.className = 'think-block is-collapsed';
  block.innerHTML = `
    <button type="button" class="think-toggle" aria-expanded="false">
      <span class="think-toggle-left">
        <span class="think-dot" aria-hidden="true"></span>
        <span class="think-summary"></span>
      </span>
      <span class="think-chevron" aria-hidden="true">▸</span>
    </button>
    <div class="think-body-wrap">
      <div class="think-body"></div>
    </div>
  `;
  return block;
}

function wireThinkToggle(block) {
  const toggle = block.querySelector('.think-toggle');
  if (!toggle || toggle.dataset.thinkBound) return;
  toggle.dataset.thinkBound = '1';
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const expanded = !block.classList.contains('is-expanded');
    block.classList.toggle('is-expanded', expanded);
    block.classList.toggle('is-collapsed', !expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const chev = block.querySelector('.think-chevron');
    if (chev) chev.textContent = expanded ? '▾' : '▸';
  });
}

/** Restored / sealed think bar — same chrome as live, stays in the message stream. */
function renderSealedThinkBlock(thoughtText) {
  const block = createThinkBlockEl();
  const summary = block.querySelector('.think-summary');
  const body = block.querySelector('.think-body');
  if (summary) summary.textContent = thinkDoneLabel('');
  if (body) body.textContent = String(thoughtText || '').trim();
  wireThinkToggle(block);
  return block;
}

function appendAssistantTurn(task, { thought = '', content = '' } = {}) {
  if (!task) return null;
  const wrap = document.createElement('div');
  wrap.className = 'agent-turn';
  const thoughtText = String(thought || '').trim();
  if (thoughtText) wrap.appendChild(renderSealedThinkBlock(thoughtText));
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant msg-final';
  const body = document.createElement('div');
  body.className = 'md-body';
  bubble.appendChild(body);
  wrap.appendChild(bubble);
  task.append(wrap);
  try {
    renderRichTextContent(body, String(content || ''));
  } catch {
    body.textContent = String(content || '');
  }
  return wrap;
}

function makeCollapsibleThinking(existingEl) {
  if (existingEl instanceof HTMLElement && existingEl._pawThink) {
    existingEl._pawThink.resume?.();
    return existingEl._pawThink;
  }
  const block = existingEl instanceof HTMLElement ? existingEl : createThinkBlockEl();
  block.classList.add('is-live');
  const turnEffort = reasoningEffort;
  block.dataset.effort = turnEffort;
  const summary = block.querySelector('.think-summary');
  const body = block.querySelector('.think-body');
  const toggle = block.querySelector('.think-toggle');
  if (!existingEl && summary) summary.textContent = thinkLiveLabel('', false, turnEffort);
  let expanded = block.classList.contains('is-expanded');
  const startedAt = Number(block.dataset.thinkStartedAt) || performance.now();
  block.dataset.thinkStartedAt = String(startedAt);
  /** @type {ReturnType<typeof setInterval>|null} */
  let tickTimer = null;
  function syncChrome() {
    block.classList.toggle('is-expanded', expanded);
    block.classList.toggle('is-collapsed', !expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    block.querySelector('.think-chevron').textContent = expanded ? '▾' : '▸';
  }
  function refreshLiveSummary() {
    if (!block.classList.contains('is-live')) return;
    const duration = formatDurationMS(performance.now() - startedAt);
    summary.textContent = thinkLiveLabel(duration, expanded, turnEffort);
  }
  tickTimer = setInterval(refreshLiveSummary, 500);
  refreshLiveSummary();
  if (!toggle.dataset.thinkBound) {
    toggle.dataset.thinkBound = '1';
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      syncChrome();
      refreshLiveSummary();
      if (expanded) {
        requestAnimationFrame(() => {
          try {
            toggle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          } catch (_) {}
        });
      }
    });
  }
  const renderer = createSmoothStreamRenderer(body, { charsPerFrame: 480, fadeChunks: true });
  const ctl = {
    el: block,
    body,
    push(text) {
      renderer.push(text);
    },
    pushLine(text) {
      renderer.pushLine(text);
    },
    getText() {
      return renderer.getText();
    },
    clear() {
      renderer.clear();
    },
    finish() {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      renderer.flush();
      block.classList.remove('is-live');
      expanded = false;
      syncChrome();
      const duration = formatDurationMS(performance.now() - startedAt);
      summary.textContent = thinkDoneLabel(duration, turnEffort);
    },
    resume() {
      block.classList.add('is-live');
      if (!tickTimer) tickTimer = setInterval(refreshLiveSummary, 500);
      refreshLiveSummary();
    },
    destroy() {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      renderer.destroy();
    }
  };
  block._pawThink = ctl;
  return ctl;
}

function makeEventChip(text, live) {
  const span = document.createElement('span');
  span.className = 'event-chip' + (live ? ' is-live' : '');
  span.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="txt"></span>`;
  span.querySelector('.txt').textContent = text;
  return span;
}

function renderSessionDropdown() {
  const sel = $('sessionSelect');
  if (sel) {
    sel.innerHTML = '';
    sessions.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      if (s.id === activeSessionId) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  renderSessionRailList();
  syncConversationChrome();
}

/** Left session rail list (primary session switcher UI). */
function renderSessionRailList() {
  const list = $('sessionRailList');
  if (!list) return;
  list.innerHTML = '';
  sessions.forEach((s) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    li.dataset.sessionId = s.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-rail-item' + (s.id === activeSessionId ? ' is-active' : '');
    btn.setAttribute('role', 'listitem');
    btn.dataset.sessionId = s.id;
    btn.title = s.name || s.id;
    const name = document.createElement('span');
    name.className = 'session-rail-item-name';
    name.textContent = s.name || s.id;
    btn.appendChild(name);
    if (uiState(s.id).running) {
      btn.classList.add('is-running');
      const mark = document.createElement('span');
      mark.className = 'session-rail-running';
      mark.setAttribute('aria-label', currentLang === 'en' ? 'Running' : '进行中');
      btn.appendChild(mark);
    }
    btn.addEventListener('click', () => {
      if (s.id !== activeSessionId) switchSession(s.id);
      renderSessionRailList();
    });
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'session-rail-item-rename-btn';
    rename.setAttribute('aria-label', t('renameSession') || (currentLang === 'en' ? 'Rename' : '重命名'));
    rename.title = t('renameSession') || (currentLang === 'en' ? 'Rename' : '重命名');
    rename.innerHTML = ICONS.pencil;
    rename.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      beginSessionRailRename(s.id);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'session-rail-item-close';
    close.setAttribute('aria-label', currentLang === 'en' ? 'Delete task' : '删除任务');
    close.title = currentLang === 'en' ? 'Delete this task workspace' : '删除此任务工作区';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void deleteSessionById(s.id, s.name);
    });
    li.appendChild(btn);
    li.appendChild(rename);
    li.appendChild(close);
    list.appendChild(li);
  });
}

function sessionRailRow(sessionId) {
  const list = $('sessionRailList');
  if (!list) return null;
  const sid = String(sessionId || '');
  return (
    list.querySelector(`li[data-session-id="${CSS.escape(sid)}"]`) ||
    list.querySelector(`.session-rail-item[data-session-id="${CSS.escape(sid)}"]`)?.closest('li')
  );
}

function paintSessionRailName(row, name) {
  if (!row) return;
  const label = String(name || '');
  const nameEl = row.querySelector('.session-rail-item-name');
  if (nameEl) nameEl.textContent = label;
  const itemBtn = row.querySelector('.session-rail-item');
  if (itemBtn) itemBtn.title = label;
}

function endSessionRailRenameUi(row, name) {
  if (!row) return;
  row.classList.remove('is-renaming');
  row.querySelector('.session-rail-item-rename')?.remove();
  const itemBtn = row.querySelector('.session-rail-item');
  if (itemBtn) itemBtn.hidden = false;
  paintSessionRailName(row, name);
}

function beginSessionRailRename(sessionId) {
  const sid = String(sessionId || '');
  const sess = sessions.find((s) => String(s.id) === sid);
  if (!sess) return;
  const row = sessionRailRow(sid);
  if (!row || row.classList.contains('is-renaming')) return;
  const prev = String(sess.name || '').trim();
  const itemBtn = row.querySelector('.session-rail-item');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rail-item-rename';
  input.maxLength = SESSION_TITLE_MAX;
  input.value = prev;
  input.placeholder = t('sessionNamePlaceholder') || (currentLang === 'en' ? 'Session name' : '会话名称');
  input.setAttribute('aria-label', t('renameSession') || (currentLang === 'en' ? 'Rename' : '重命名'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  row.classList.add('is-renaming');
  if (itemBtn) itemBtn.hidden = true;
  const renameBtn = row.querySelector('.session-rail-item-rename-btn');
  if (renameBtn) row.insertBefore(input, renameBtn);
  else row.insertBefore(input, row.firstChild);

  let settled = false;
  const finish = (nextName, persist) => {
    if (settled) return;
    settled = true;
    input.removeEventListener('blur', onBlur);
    const name = persist ? nextName : prev;
    endSessionRailRenameUi(row, name);
    if (persist && name !== prev) {
      applyUserSessionRename(sid, name, row);
    }
  };
  const onBlur = () => {
    const next = input.value.trim().slice(0, SESSION_TITLE_MAX);
    finish(next || prev, true);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = input.value.trim().slice(0, SESSION_TITLE_MAX);
      finish(next || prev, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(prev, false);
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('blur', onBlur);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function applyUserSessionRename(sessionId, name, rowEl) {
  const sid = String(sessionId || '');
  const sess = sessions.find((s) => String(s.id) === sid);
  if (!sess) return;
  sess.name = name;
  sess.titleLocked = true;
  paintSessionRailName(rowEl || sessionRailRow(sid), name);
  if (sid === String(activeSessionId)) syncConversationChrome();
  void persistSessionTitle(sid, name);
}

function persistSessionTitle(sessionId, name) {
  void workspaceRpc('getSession', { sessionId })
    .then(() =>
      workspaceRpc('renameSession', {
        sessionId,
        title: name,
        lockTitle: true
      })
    )
    .catch(() => {});
  savePersistentSessions({ skipActiveWriteThrough: true });
}

function restoreFocusOutside(region, fallback) {
  if (!region) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !region.contains(active)) return;
  try {
    active.blur();
  } catch {
    /* ignore */
  }
  if (
    fallback instanceof HTMLElement &&
    fallback.isConnected &&
    !region.contains(fallback)
  ) {
    try {
      fallback.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

function setAriaRegionOpen(region, open, restoreFocus) {
  if (!region) return;
  const next = !!open;
  if (!next) restoreFocusOutside(region, restoreFocus);
  region.hidden = !next;
  region.setAttribute('aria-hidden', next ? 'false' : 'true');
  region.inert = !next;
}

function setSessionRailOpen(open) {
  const panel = $('panel');
  const rail = $('sessionRail');
  const scrim = $('sessionRailScrim');
  const fab = $('sessionEdgeFab');
  if (!panel || !rail) return;
  const next = !!open;
  panel.classList.toggle('session-rail-open', next);
  setAriaRegionOpen(rail, next, fab);
  if (scrim) {
    scrim.hidden = !next;
  }
  if (fab) fab.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) {
    setArtifactRailOpen(false);
    renderSessionRailList();
    renderHistoryList();
  }
}

function wireSessionRail() {
  const panel = $('panel');
  const edge = $('sessionEdge');
  const fab = $('sessionEdgeFab');
  const scrim = $('sessionRailScrim');
  const closeBtn = $('sessionRailCloseBtn');
  const newBtn = $('sessionRailNewBtn');
  if (!panel || !edge || !fab) return;
  const edgeIcon = fab.querySelector('.session-edge-fab-icon');
  if (edgeIcon && !edgeIcon.querySelector('svg')) {
    edgeIcon.innerHTML = pawSvg(14, { className: 'paw-svg session-edge-paw' });
  }

  let peekTimer = null;
  /** Pin Y only on edge enter — do not follow mouse while hovering. */
  const placeFabAtY = (clientY) => {
    const rect = panel.getBoundingClientRect();
    const y = Math.min(Math.max(clientY - rect.top, 28), rect.height - 28);
    fab.style.top = `${y}px`;
  };
  edge.addEventListener('mouseenter', (e) => {
    if (panel.classList.contains('session-rail-open')) return;
    placeFabAtY(e.clientY);
    panel.classList.add('session-rail-peek');
    clearTimeout(peekTimer);
  });
  edge.addEventListener('mouseleave', () => {
    peekTimer = setTimeout(() => panel.classList.remove('session-rail-peek'), 180);
  });
  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    setSessionRailOpen(true);
    panel.classList.remove('session-rail-peek');
  });
  closeBtn?.addEventListener('click', () => setSessionRailOpen(false));
  scrim?.addEventListener('click', () => setSessionRailOpen(false));
  newBtn?.addEventListener('click', () => {
    createNewSession();
    renderSessionRailList();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('session-rail-open')) {
      setSessionRailOpen(false);
    }
  });
}

function renderActiveSessionMessages() {
  void hydrateActiveSessionThread();
}

/**
 * Rebuild the visible thread from Runtime session messages.
 * Switching / reopening the sidepanel must not look empty when IDB still has turns.
 */
function countThreadRoleBubbles(task) {
  const body = task?.body || task?.el?.querySelector?.('.task-body');
  if (!body) return { user: 0, assistant: 0 };
  return {
    user: body.querySelectorAll('.msg.user').length,
    assistant: body.querySelectorAll('.msg.assistant').length
  };
}

function appendPendingThreadMessages(task, messages) {
  if (!task?.body) return 0;
  const pending = pendingThreadMessages(messages, countThreadRoleBubbles(task));
  for (const m of pending) {
    if (m.role === 'user') appendUserTurnBubble(task, String(m.content || ''));
    else if (m.role === 'assistant') {
      appendAssistantTurn(task, {
        thought: m.thought || '',
        content: String(m.content || '')
      });
    }
  }
  return pending.length;
}

function recordLocalAssistantMessage(sid, { content, thought, toolCalls } = {}) {
  const text = String(content || '').trim();
  if (!text) return;
  const sess = sessions.find((s) => String(s.id) === String(sid));
  if (!sess) return;
  if (!Array.isArray(sess.messages)) sess.messages = [];
  const last = sess.messages[sess.messages.length - 1];
  if (last?.role === 'assistant' && String(last.content || '').trim() === text) return;
  sess.messages.push({
    role: 'assistant',
    content: text,
    thought: String(thought || ''),
    traces: toolCalls || [],
    ts: Date.now()
  });
  savePersistentSessions();
}

function showParkedSessionThread(sid, task) {
  if (!task?.el) return;
  hideWelcome();
  mountSessionThreadEl(task.el, sid);
  liveTask = task;
  uiState(sid).liveTask = task;
  dedupeSessionThreads(sid);
  hideForeignSessionThreads(sid);
  mountSessionTrajectoryButton(task);
  rebuildTurnJumpRail();
}

async function hydrateActiveSessionThread() {
  const sess = sessions.find((s) => s.id === activeSessionId);
  if (!sess) {
    showWelcome();
    return;
  }
  const sid = String(sess.id);
  const parked = uiState(sid).liveTask;
  if (parked?.el) showParkedSessionThread(sid, parked);
  let messages = mergeSessionTranscriptMessages([], Array.isArray(sess.messages) ? sess.messages.slice() : []);
  let full = null;
  let rpcFailed = false;
  try {
    full = await workspaceRpc('getSession', { sessionId: sid });
    if (getWorkspaceSessionId() !== sid) return;
    messages = mergeSessionTranscriptMessages(
      Array.isArray(full?.messages) ? full.messages : [],
      sess.messages || []
    ).map((m) => ({
      role: m.role,
      content: m.content,
      thought: m.thought || '',
      ts: m.createdAt || m.ts || Date.now(),
      path: m.path,
      toolCalls: m.toolCalls,
      traces: m.traces
    }));
    if (messages.length) sess.messages = messages;
    if (full?.title) sess.name = full.title;
  } catch {
    rpcFailed = true;
  }
  if (getWorkspaceSessionId() !== sid) return;
  try {
    const live = uiState(sid).liveTask;
    if (live?.el) {
      showParkedSessionThread(sid, live);
      appendPendingThreadMessages(live, messages);
      return;
    }
    if (!messages.length) {
      if (liveTask?.el && liveTask.sessionId === sid) {
        liveTask.el.hidden = true;
      }
      liveTask = null;
      showWelcome();
      hideForeignSessionThreads(sid);
      return;
    }

    hideWelcome();
    const existing = dedupeSessionThreads(sid);
    if (existing) {
      liveTask = uiState(sid).liveTask || {
        el: existing,
        sessionId: sid,
        body: existing.querySelector('.task-body'),
        setState() {},
        append(node) {
          this.body?.appendChild(node);
          return node;
        }
      };
      uiState(sid).liveTask = liveTask;
      existing.hidden = false;
      hideForeignSessionThreads(sid);
      appendPendingThreadMessages(liveTask, messages);
      mountSessionTrajectoryButton(liveTask);
      rebuildTurnJumpRail();
      return;
    }
    const firstUser = messages.find((m) => m.role === 'user');
    const title = truncateUi(String(sess.name || firstUser?.content || sess.id), 48);
    const task = createTaskCard(title, { kind: 'chat', continueExisting: false, sessionId: sid });
    if (!task) return;
    hideForeignSessionThreads(sid);
    for (const m of messages) {
      if (m.role === 'user') {
        appendUserTurnBubble(task, String(m.content || ''));
      } else if (m.role === 'assistant') {
        appendAssistantTurn(task, {
          thought: m.thought || '',
          content: String(m.content || '')
        });
      }
    }
    mountSessionTrajectoryButton(task);
    rebuildTurnJumpRail();
  } finally {
    if (getWorkspaceSessionId() === sid) {
      applyWorkspaceExecutionSnapshot(sid, full, { rpcFailed });
      taskStatusUi.mount();
    }
  }
}

function appendUserTurnBubble(task, text, nodes) {
  if (!task) return null;
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  if (Array.isArray(nodes) && nodes.length) {
    nodes.forEach((n) => userMsg.appendChild(n));
  } else {
    userMsg.textContent = String(text || '');
  }
  const n = (task.el?.querySelectorAll('.msg.user').length || 0) + 1;
  userMsg.id = `turn-${n}`;
  userMsg.dataset.turnIndex = String(n);
  task.append(userMsg);
  rebuildTurnJumpRail();
  return userMsg;
}

function rebuildTurnJumpRail() {
  const rail = $('turnJumpRail');
  if (!rail) return;
  const thread =
    document.querySelector('#taskStream .session-thread:not([hidden])') ||
    document.querySelector('#taskStream .task-card:not([hidden])');
  const users = [...(thread?.querySelectorAll('.msg.user') || [])];
  if (users.length < 2) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }
  rail.hidden = false;
  rail.innerHTML = '';
  users.forEach((el, i) => {
    if (!el.id) el.id = `turn-${i + 1}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'turn-jump-item';
    btn.dataset.turnTarget = el.id;
    const label = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    const tip = document.createElement('span');
    tip.className = 'turn-jump-tip';
    tip.textContent = truncateUi(label, 10);
    btn.appendChild(tip);
    btn.setAttribute('aria-label', `跳转到：${truncateUi(label, 24)}`);
    btn.addEventListener('click', () => scrollPanelToTurn(el.id));
    rail.appendChild(btn);
  });
  syncTurnJumpActive();
  wireTurnJumpScroll();
}

let turnJumpScrollBound = false;
function wireTurnJumpScroll() {
  if (turnJumpScrollBound) return;
  turnJumpScrollBound = true;
  document.addEventListener(
    'scroll',
    () => {
      syncTurnJumpActive();
    },
    { passive: true, capture: true }
  );
}

function syncTurnJumpActive() {
  const root = getConversationScrollRoot();
  const rail = $('turnJumpRail');
  if (!root || !rail || rail.hidden) return;
  const thread =
    document.querySelector('#taskStream .session-thread:not([hidden])') ||
    document.querySelector('#taskStream .task-card:not([hidden])');
  const users = [...(thread?.querySelectorAll('.msg.user') || [])];
  if (!users.length) return;
  const top = root.getBoundingClientRect().top + 16;
  let current = users[0];
  for (const el of users) {
    if (el.getBoundingClientRect().top <= top + 8) current = el;
  }
  rail.querySelectorAll('.turn-jump-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.turnTarget === current.id);
  });
}

function scrollPanelToTurn(turnId) {
  const el = document.getElementById(turnId);
  const root = getConversationScrollRoot();
  if (!el || !root) return;
  const top =
    el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12;
  root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  document.querySelectorAll('.turn-jump-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.turnTarget === turnId);
  });
}

function mountSessionTrajectoryButton(task) {
  if (!task?.el) return;
  const header = task.el.querySelector('.task-header');
  if (!header) return;
  let btn = header.querySelector('.session-traj-btn');
  if (!devTrajectoryExportEnabled) {
    btn?.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-traj-btn';
    header.appendChild(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTrajectoryExportModal();
    });
  }
  btn.textContent = currentLang === 'en' ? 'Traj' : '轨迹';
  btn.title =
    currentLang === 'en'
      ? 'Dev: download this task tool path'
      : '开发：下载本任务的工具与行为路径';
}

function applySessionTitle(title, sessionId) {
  const name = String(title || '').trim();
  if (!name) return;
  const sid = String(sessionId || activeSessionId || '');
  const sess = sessions.find((s) => String(s.id) === sid);
  if (sess?.titleLocked) return;
  const editing = sessionRailRow(sid);
  if (editing?.classList.contains('is-renaming')) return;
  if (sess) sess.name = name;
  savePersistentSessions();
  const row = sessionRailRow(sid);
  if (row) {
    paintSessionRailName(row, name);
    if (sid === String(activeSessionId)) {
      const item = row.querySelector('.session-rail-item');
      if (item) item.classList.add('is-active');
    }
    syncConversationChrome();
    return;
  }
  renderSessionDropdown();
  renderSessionRailList();
  syncConversationChrome();
}

function createNewSession() {
  const prev = getWorkspaceSessionId();
  stashLiveToSession(prev);
  if (liveTask?.el) liveTask.el.hidden = true;
  const id = `session-${Date.now()}`;
  const name = nextLocalTaskName();
  sessions.push({ id, name, messages: [] });
  activeSessionId = id;
  historyRecords = [];
  liveTask = null;
  liveTurnThink = null;
  currentAgentAbort = null;
  currentWorkspaceTaskId = null;
  pendingAttachments = [];
  selectedArtifactIds.clear();
  try {
    composerEl()?.replaceChildren();
  } catch {
    /* */
  }
  savePersistentSessions({ skipActiveWriteThrough: true });
  void workspaceRpc('getSession', { sessionId: id })
    .then(() =>
      workspaceRpc('renameSession', { sessionId: id, title: name, lockTitle: false })
    )
    .catch(() => {});
  renderSessionDropdown();
  showWelcome();
  renderHistoryList();
  void taskStatusUi.refresh();
  void refreshArtifactShelf();
  void refreshWorkspaceGroupState();
  applyContextUsage({});
  sheetSelState = emptySheetSel(id);
  renderSheetSelRow();
  parkClarifyLive();
  hideForeignSessionThreads(id);
  setAgentRunningUi(false);
  void loadActiveGroupOntoPage();
  renderAttachmentPreviews();
}

function renameActiveSession() {
  beginSessionRailRename(activeSessionId);
}

async function deleteActiveSession() {
  const sess = sessions.find((s) => s.id === getWorkspaceSessionId());
  await deleteSessionById(getWorkspaceSessionId(), sess?.name);
}

/**
 * Delete one session workspace (messages, artifacts, scratch, bindings).
 * SelectionGroups / WebItems are not deleted.
 */
async function deleteSessionById(sessionId, sessionName) {
  const doomedId = String(sessionId || '');
  if (!doomedId) return;
  const label = String(sessionName || '').trim() || doomedId;
  const ok = await confirmInApp(
    currentLang === 'en'
      ? `Delete task “${label}”? Messages and workspace files will be removed. Selection groups are kept.`
      : `删除任务「${label}」？消息和工作区文件将被清除，Selection Group 会保留。`,
    currentLang === 'en' ? 'Delete task' : '删除任务',
    { danger: true }
  );
  if (!ok) return;
  try {
    await workspaceRpc('abortTask', {
      sessionId: doomedId,
      executionId: uiState(doomedId).executionId || undefined
    });
  } catch (err) {
    console.warn('[workspace] abortTask before delete failed', err);
  }
  try {
    await workspaceRpc('deleteSession', { sessionId: doomedId });
  } catch (err) {
    console.warn('[workspace] deleteSession failed', err);
  }
  uiState(doomedId).running = false;
  const wasActive = String(activeSessionId) === doomedId;
  sessions = sessions.filter((s) => String(s.id) !== doomedId);
  if (!sessions.length) {
    const id = `session-${Date.now()}`;
    sessions = [
      {
        id,
        name: currentLang === 'en' ? 'Task 1' : '任务 1',
        messages: []
      }
    ];
    void workspaceRpc('getSession', { sessionId: id }).catch(() => {});
  }
  try {
    settlePendingAskUserForSession(doomedId, ASK_USER_STOP_ANSWER);
  } catch (_) {}
  sessionUi.delete(doomedId);
  if (wasActive) {
    activeSessionId = sessions[0].id;
    historyRecords = [];
    if (liveTask?.el) {
      liveTask.el.remove();
      liveTask = null;
    }
    void hydrateActiveSessionThread();
  }
  savePersistentSessions();
  renderSessionDropdown();
  renderHistoryList();
  void taskStatusUi.refresh();
  void refreshWorkspaceGroupState();
  void refreshArtifactShelf();
}

function switchSession(sessionId) {
  if (!sessions.some((s) => s.id === sessionId)) return;
  const prev = getWorkspaceSessionId();
  if (prev === sessionId) return;
  stashLiveToSession(prev);
  if (liveTask?.el) liveTask.el.hidden = true;
  activeSessionId = sessionId;
  loadLiveFromSession(sessionId);
  void taskStatusUi.refresh();
  void hydrateActiveSessionThread().then(() => {
    if (getWorkspaceSessionId() !== sessionId) return;
    hideForeignSessionThreads(sessionId);
    restoreClarifyForSession(sessionId);
  });
  hideForeignSessionThreads(sessionId);
  parkClarifyLive();
  historyRecords = [];
  savePersistentSessions();
  try {
    const input = composerEl();
    if (input) {
      input.innerHTML = uiState(sessionId).composerHtml || '';
      syncComposerEmptyClass(input);
    }
  } catch {
    /* */
  }
  renderAttachmentPreviews();
  renderPromptQueueHint();
  renderSessionDropdown();
  renderHistoryList();
  void refreshWorkspaceGroupState().then(() => loadActiveGroupOntoPage());
  void refreshArtifactShelf();
  const sess = sessions.find((s) => s.id === sessionId);
  applyContextUsage(sess?.contextUsage || {});
  sheetSelState = { ...emptySheetSel(sessionId), ...(uiState(sessionId).sheetSel || {}), sessionId };
  renderSheetSelRow();
  setAgentRunningUi(!!uiState(sessionId).running);
  if (uiState(sessionId).running) {
    liveTurnSealed = false;
    if (liveTask?.body) ensureLiveTurnThink();
  }
  restoreClarifyForSession(sessionId);
}

function openMoreSheet() {
  const sheet = $('moreSheet');
  const backdrop = $('sheetBackdrop');
  const moreBtn = $('moreBtn');
  if (sheet) sheet.hidden = false;
  if (backdrop) backdrop.hidden = false;
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'true');
  // Focus first actionable control in the sheet
  requestAnimationFrame(() => {
    const first =
      sheet?.querySelector?.(
        'button:not([hidden]):not([disabled]), select:not([disabled]), [href], input:not([disabled])'
      ) || sheet;
    try {
      first?.focus?.({ preventScroll: true });
    } catch (_) {}
  });
}

function closeMoreSheet({ restoreFocus = true } = {}) {
  const sheet = $('moreSheet');
  const backdrop = $('sheetBackdrop');
  const moreBtn = $('moreBtn');
  const focusInside =
    sheet &&
    document.activeElement instanceof HTMLElement &&
    sheet.contains(document.activeElement);
  if (focusInside) {
    try {
      document.activeElement.blur();
    } catch (_) {}
  }
  if (sheet) sheet.hidden = true;
  if (backdrop) backdrop.hidden = true;
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus && moreBtn) {
    requestAnimationFrame(() => {
      try {
        moreBtn.focus({ preventScroll: true });
      } catch (_) {}
    });
  }
}

/** Esc closes more sheet (and restores focus to ⋯) */
function wireMoreSheetEscape() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const sheet = $('moreSheet');
    if (!sheet || sheet.hidden) return;
    // Native dialogs handle their own Esc
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    closeMoreSheet({ restoreFocus: true });
  });
}

function isFileDragEvent(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const types = dt.types ? Array.from(dt.types) : [];
  if (types.includes('Files') || types.includes('application/x-moz-file')) return true;
  if (dt.items && [...dt.items].some((it) => it && it.kind === 'file')) return true;
  // Desktop → Chrome side panel: types are often empty until drop.
  if (types.length === 0) return true;
  return false;
}

function filesFromDropEvent(e) {
  const fromList = Array.from(e.dataTransfer?.files || []).filter(Boolean);
  if (fromList.length) return fromList;
  const items = e.dataTransfer?.items;
  if (!items) return [];
  const out = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

function fileDropHintText() {
  return t('fileDropHint');
}

function fileDropZoneFromEvent(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const nodes = path.length ? path : [e.target];
  for (const n of nodes) {
    if (!(n instanceof Element)) continue;
    if (n.closest?.('.more-sheet, dialog, .sheet-backdrop, .session-rail, .artifact-rail')) {
      return null;
    }
    const composer = n.closest?.('.composer, .composer-inner, .composer-field, #input');
    if (composer && !composer.closest?.('#homeComposerSlot, .welcome')) {
      return null;
    }
    if (
      n.closest?.(
        '.thread-workspace, .task-stream, .task-body, .welcome, #panelScroll, #taskStream, #homeComposerSlot'
      )
    ) {
      return $('panel');
    }
  }
  return null;
}

function setFileDropActive(on) {
  const panel = $('panel') || document.querySelector('.panel');
  const overlay = $('fileDropOverlay');
  const label = $('fileDropOverlayLabel');
  if (label) label.textContent = fileDropHintText();
  if (overlay) {
    overlay.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  panel?.classList.toggle('is-file-drop', !!on);
}

/**
 * One surface drop: the conversation / home canvas. Composer is not a drop target.
 * Overlay is position:absolute on .panel — it must not reflow home layout.
 */
function setupFileDropOnPanel() {
  const panel = $('panel') || document.querySelector('.panel');
  if (!panel || panel.dataset.pwFileDrop === '1') return;
  panel.dataset.pwFileDrop = '1';

  panel.addEventListener(
    'dragenter',
    (e) => {
      if (!isFileDragEvent(e)) return;
      const zone = fileDropZoneFromEvent(e);
      if (!zone) {
        setFileDropActive(false);
        return;
      }
      e.preventDefault();
      setFileDropActive(true);
    },
    true
  );
  panel.addEventListener(
    'dragover',
    (e) => {
      if (!isFileDragEvent(e)) return;
      const zone = fileDropZoneFromEvent(e);
      if (!zone) {
        setFileDropActive(false);
        return;
      }
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch {
        /* ignore */
      }
      setFileDropActive(true);
    },
    true
  );
  panel.addEventListener(
    'dragleave',
    (e) => {
      const next = e.relatedTarget;
      if (next instanceof Node && panel.contains(next)) return;
      setFileDropActive(false);
    },
    true
  );
  panel.addEventListener(
    'drop',
    (e) => {
      const files = filesFromDropEvent(e);
      const zone = fileDropZoneFromEvent(e);
      setFileDropActive(false);
      if (!files.length || !zone) return;
      e.preventDefault();
      e.stopPropagation();
      processInputFiles(files);
    },
    true
  );
}

function setupAttachmentListeners() {
  const attachBtn = $('attachFileBtn');
  const fileInput = $('fileInput');
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) processInputFiles(fileInput.files);
      fileInput.value = '';
    });
  }
  setupFileDropOnPanel();
  const input = composerEl();
  if (input) {
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      const files = [];
      if (items) {
        for (const it of items) {
          if (it.kind === 'file') {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        const images = [];
        const others = [];
        for (const f of files) {
          if (classifyUploadFile(f) === 'image') images.push(f);
          else others.push(f);
        }
        if (images.length) attachPastedImages(images);
        if (others.length) processInputFiles(others);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      const urls = pastedUrlList(text);
      if (urls.length) {
        e.preventDefault();
        void insertPastedUrlChips(urls);
        return;
      }
      if (text != null) {
        e.preventDefault();
        document.execCommand('insertText', false, text);
      }
    });
    input.addEventListener('input', () => {
      syncPastedScreenshotChips();
    });
  }
}

function bytesToBase64(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function classifyUploadFile(file) {
  const name = String(file?.name || '');
  const type = String(file?.type || '');
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return 'image';
  if (
    type.startsWith('text/') ||
    /json|xml|javascript|markdown/.test(type) ||
    /\.(txt|md|csv|tsv|json|js|mjs|py|html|htm|css|log|svg)$/i.test(name)
  ) {
    return 'text';
  }
  return 'binary';
}

async function persistUploadToWorkspace(file, bytes, mimeType) {
  const sessionId = getWorkspaceSessionId();
  if (!sessionId || !bytes || !bytes.byteLength) return;
  await workspaceRpc('createArtifact', {
    sessionId,
    name: file.name || 'upload',
    mimeType: mimeType || file.type || '',
    base64: bytesToBase64(bytes)
  });
  await refreshArtifactShelf();
  pulseArtifactBadge();
}

function processInputFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  let queued = 0;
  list.forEach((file) => {
    const kind = classifyUploadFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result || []);
      const mime =
        file.type ||
        (kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream');
      if (kind === 'image') {
        pendingAttachments.push({
          name: file.name,
          type: mime,
          isImage: true,
          dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
          source: 'drop'
        });
      } else if (kind === 'text') {
        pendingAttachments.push({
          name: file.name,
          type: mime,
          isImage: false,
          textContent: new TextDecoder().decode(bytes),
          source: 'drop'
        });
      } else {
        pendingAttachments.push({
          name: file.name,
          type: mime,
          isImage: false,
          textContent: currentLang === 'en' ? `[file] ${file.name}` : `【文件】${file.name}`,
          source: 'drop'
        });
      }
      renderAttachmentPreviews();
      void persistUploadToWorkspace(file, bytes, mime).catch((err) => {
        console.warn('[workspace] persist upload failed', err);
      });
      queued += 1;
      if (queued === list.length) {
        showSidepanelToast(
          currentLang === 'en'
            ? `Added ${list.length} file${list.length > 1 ? 's' : ''} to workspace`
            : `已加入工作区 · ${list.length} 个文件`
        );
      }
    };
    reader.onerror = () => {
      showSidepanelToast(
        currentLang === 'en' ? `Could not read ${file.name}` : `无法读取 ${file.name}`
      );
    };
    reader.readAsArrayBuffer(file);
  });
}

function isPastedComposerAttachment(att) {
  return String(att?.source || '').toLowerCase() === 'paste';
}

function dropPastedComposerAttachments() {
  const next = pendingAttachments.filter((a) => !isPastedComposerAttachment(a));
  if (next.length === pendingAttachments.length) return;
  pendingAttachments = next;
  renderAttachmentPreviews();
}

function syncPastedScreenshotChips() {
  const el = composerEl();
  if (!el) return;
  const labels = new Set(
    [...el.querySelectorAll('.composer-mention[data-kind="screenshot"]')].map(
      (n) => n.getAttribute('data-label') || n.getAttribute('data-handle') || ''
    )
  );
  const next = pendingAttachments.filter((a) => {
    if (String(a?.source || '').toLowerCase() !== 'paste' || a.labelKind !== 'screenshot') return true;
    return labels.has(String(a.name || '')) || labels.has(String(a.handle || ''));
  });
  if (next.length === pendingAttachments.length) return;
  pendingAttachments = next;
  renderAttachmentPreviews();
}

/** Clipboard paste images → 截图N chips only. No /artifacts write. */
function attachPastedImages(files) {
  const list = Array.from(files || []).filter(Boolean);
  for (const file of list) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      if (!result.startsWith('data:')) return;
      void attachScreenshotToChat({
        dataUrl: result,
        name: file.name,
        clipboardOk: true,
        source: 'paste'
      });
    };
    reader.onerror = () => {
      showSidepanelToast(
        currentLang === 'en' ? `Could not read ${file.name}` : `无法读取 ${file.name}`
      );
    };
    reader.readAsDataURL(file);
  }
}

function inferDataUrlMime(dataUrl) {
  const match = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
  return match?.[1] || 'application/octet-stream';
}

function renderAttachmentPreviews() {
  const bar = $('attachmentPreviewBar');
  if (!bar) return;
  const inlinePasteShots = new Set(
    [...(composerEl()?.querySelectorAll('.composer-mention[data-kind="screenshot"]') || [])].map(
      (n) => n.getAttribute('data-label') || ''
    )
  );
  const visible = pendingAttachments.filter((att) => {
    if (String(att?.source || '').toLowerCase() !== 'paste' || att.labelKind !== 'screenshot') return true;
    return !inlinePasteShots.has(String(att.name || ''));
  });
  if (!visible.length) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.innerHTML = '';
  visible.forEach((att) => {
    const i = pendingAttachments.indexOf(att);
    const chip = document.createElement('span');
    const shown =
      att.labelKind && att.labelN
        ? formatItemLabel(att.labelKind, att.labelN, itemLabelLang())
        : att.name;
    const src = String(att.source || '').toLowerCase();
    const isShotChip =
      att.isImage &&
      (att.labelKind === 'screenshot' ||
        src === 'paste' ||
        src === 'screenshot' ||
        src === 'hotkey' ||
        src === 'button');
    if (isShotChip) {
      chip.className = 'sel-chip has-remove';
      chip.dataset.kind = 'image';
      chip.innerHTML = `<span class="thumb" aria-hidden="true"></span><span class="label">${escapeHtml(truncateUi(shown, 18))}</span><button type="button" class="chip-x" aria-label="remove">×</button>`;
      const thumb = chip.querySelector('.thumb');
      if (thumb && att.dataUrl) {
        thumb.style.backgroundImage = `url("${att.dataUrl}")`;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
      }
      chip.querySelector('.chip-x').addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderAttachmentPreviews();
      });
    } else {
      chip.className = 'attachment-chip';
      chip.innerHTML = `<span>${att.isImage ? '🖼️' : '📄'} ${escapeHtml(truncateUi(shown, 18))}</span><button type="button" aria-label="remove">×</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderAttachmentPreviews();
      });
    }
    bar.appendChild(chip);
  });
}

// ── Submit + Agent run ──
/**
 * Promote assistant answer into the live task card (Session Workspace unified path).
 * @param {string} md
 * @param {{ force?: boolean }} [opts]
 */
function ensureLiveTurnAnswerBubble() {
  const task = liveTask;
  if (!task?.body) return null;
  if (liveTurnAnswerEl?.isConnected) return liveTurnAnswerEl;
  if (!liveTurnWrap?.isConnected) {
    liveTurnWrap = document.createElement('div');
    liveTurnWrap.className = 'agent-turn';
    task.append(liveTurnWrap);
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant msg-final is-streaming';
  const body = document.createElement('div');
  body.className = 'md-body';
  bubble.appendChild(body);
  liveTurnWrap.appendChild(bubble);
  liveTurnAnswerEl = bubble;
  scrollTaskStream();
  return bubble;
}

function renderLiveTurnAnswer(md, { final = false } = {}) {
  const content = streamEventText(md);
  if (!content && !final) return;
  if (content === '[object Object]') return;
  const bubble = ensureLiveTurnAnswerBubble();
  if (!bubble) return;
  const body = bubble.querySelector('.md-body') || bubble;
  if (!final && body.dataset.pwAnswer === content) return;
  body.dataset.pwAnswer = content;
  try {
    renderRichTextContent(body, content);
  } catch {
    body.textContent = content;
  }
  if (final) bubble.classList.remove('is-streaming');
  scrollTaskStream();
}

function clearLiveTurnRenderTimer(sid = getLiveSessionId()) {
  if (liveTurnRenderTimer) {
    clearTimeout(liveTurnRenderTimer);
    liveTurnRenderTimer = 0;
  }
  const u = uiState(sid);
  if (u.liveTurnRenderTimer) {
    clearTimeout(u.liveTurnRenderTimer);
    u.liveTurnRenderTimer = 0;
  }
}

function scheduleLiveTurnAnswerRender() {
  const sid = getLiveSessionId();
  const u = uiState(sid);
  if (u.liveTurnRenderTimer) return;
  u.liveTurnRenderTimer = window.setTimeout(() => {
    u.liveTurnRenderTimer = 0;
    withSessionLive(sid, () => {
      if (liveTurnAnswerText) renderLiveTurnAnswer(liveTurnAnswerText);
    });
  }, 48);
}

function beginLiveTurnUi() {
  finishLiveTurnUi('', { discardEmpty: true });
  liveTurnSealed = false;
  if (!liveTask?.body) return;
  liveTurnWrap = document.createElement('div');
  liveTurnWrap.className = 'agent-turn';
  liveTask.append(liveTurnWrap);
  liveTurnThink = null;
  liveTurnThinkFromStream = false;
  liveTurnAnswerText = '';
  liveProgressState = createLiveProgressState();
  hideLiveTurnProgress();
  // Countdown is host chrome for the turn, not a reasoning-delta. OpenRouter /
  // stream failures otherwise leave an empty card until the RPC rejects.
  ensureLiveTurnThink();
}

function hideLiveTurnProgress() {
  liveTurnProgressEl?.remove();
  liveTurnProgressEl = null;
}

function ensureLiveTurnProgress() {
  if (liveTurnProgressEl?.isConnected) return liveTurnProgressEl;
  if (!liveTask?.body) return null;
  if (!liveTurnWrap?.isConnected) {
    liveTurnWrap = document.createElement('div');
    liveTurnWrap.className = 'agent-turn';
    liveTask.append(liveTurnWrap);
  }
  const el = document.createElement('div');
  el.className = 'live-progress';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<span class="live-progress-orb" aria-hidden="true"></span><span class="live-progress-text"></span>';
  const answer = liveTurnAnswerEl;
  if (answer?.isConnected) liveTurnWrap.insertBefore(el, answer);
  else liveTurnWrap.appendChild(el);
  liveTurnProgressEl = el;
  return el;
}

function renderLiveTurnProgress() {
  const st = liveProgressState;
  if (!st?.visible || !st.label) {
    hideLiveTurnProgress();
    return;
  }
  const el = ensureLiveTurnProgress();
  if (!el) return;
  const text = el.querySelector('.live-progress-text');
  if (text && text.textContent !== st.label) {
    text.textContent = st.label;
    el.classList.remove('is-tick');
    void el.offsetWidth;
    el.classList.add('is-tick');
  }
  scrollTaskStream();
}

function retractUnsealedLiveAnswer() {
  if (liveTurnSealed) return;
  clearLiveTurnRenderTimer();
  liveTurnAnswerText = '';
  if (liveTurnAnswerEl?.isConnected) liveTurnAnswerEl.remove();
  liveTurnAnswerEl = null;
}

function holderSessionName(holderSessionId) {
  const sid = String(holderSessionId || '').trim();
  if (!sid) return '';
  const sess = sessions.find((s) => String(s.id) === sid);
  return String(sess?.name || sess?.title || sid);
}

function humanizeTabLeaseEvent(ev) {
  const payload = tabLeasePayload(ev);
  if (!payload) return '';
  return formatTabLeaseMessage(t, payload, holderSessionName(payload.holderSessionId));
}

function ingestLiveProgressEvent(ev) {
  const type = String(ev?.type || '');
  if (
    liveTurnSealed &&
    type !== 'execution-end' &&
    type !== 'assistant-final' &&
    type !== 'execution-start'
  ) {
    return;
  }
  if (type === 'tool-call') retractUnsealedLiveAnswer();
  liveProgressState = applyLiveProgress(liveProgressState, ev, currentLang);
  const st = liveProgressState;
  if (st.answerFlush || st.answerChunk) {
    hideLiveTurnProgress();
    if (st.answerFlush) {
      if (!liveTurnAnswerText) liveTurnAnswerText = st.answerFlush;
      else if (!liveTurnAnswerText.endsWith(st.answerFlush) && !st.answerFlush.startsWith(liveTurnAnswerText)) {
        liveTurnAnswerText = st.answerFlush;
      }
    } else {
      liveTurnAnswerText += st.answerChunk;
    }
    scheduleLiveTurnAnswerRender();
    return;
  }
  renderLiveTurnProgress();
}

function ensureLiveTurnThink() {
  if (!liveTask?.body) return null;
  if (!liveTurnWrap?.isConnected) {
    liveTurnWrap = document.createElement('div');
    liveTurnWrap.className = 'agent-turn';
    liveTask.append(liveTurnWrap);
  }
  // One accordion per user turn. Tool-loop step 2 must not spawn a second "思考中".
  // Switch-back may find a finished controller (stale idle snapshot sealed it);
  // if we are asking for live think, reopen the same bar instead of 「已思考」.
  if (liveTurnThink?.el?.isConnected) {
    liveTurnThink.resume?.();
    return liveTurnThink;
  }
  const existing = liveTurnWrap.querySelector('.think-block');
  if (existing) {
    liveTurnThink = liveTurnThink?.el === existing ? liveTurnThink : makeCollapsibleThinking(existing);
    liveTurnThink.resume?.();
    return liveTurnThink;
  }
  liveTurnThink = makeCollapsibleThinking();
  const before = liveTurnWrap.querySelector('.live-progress, .msg');
  if (before) liveTurnWrap.insertBefore(liveTurnThink.el, before);
  else liveTurnWrap.appendChild(liveTurnThink.el);
  return liveTurnThink;
}

function clearThinkPlaceholder() {
  if (!liveTurnThink || typeof liveTurnThink.getText !== 'function') return;
  const raw = liveTurnThink.getText() || '';
  if (isThinkPlaceholderText(raw)) {
    liveTurnThink.clear?.();
  }
}

/**
 * Live events from offscreen ToolLoopAgent.stream (thinking / tokens / tools).
 */
function streamEventText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value === '[object Object]' ? '' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function applyContextUsage(ev = {}) {
  const ring = $('contextRing');
  if (!ring) return;
  const hit = findCatalogModel(catalogModels, selectedModel);
  const windowN =
    Number(ev.contextWindow) > 2048
      ? Math.round(Number(ev.contextWindow))
      : resolveContextWindow(selectedModel, hit);
  const tokens = Math.max(0, Number(ev.promptTokens) || 0);
  const ratioRaw =
    ev.ratio != null && Number.isFinite(Number(ev.ratio))
      ? Number(ev.ratio)
      : tokens / windowN;
  const ratio = Math.max(0, Math.min(1, ratioRaw));
  const pct = Math.round(ratio * 100);
  const compacting = ev.compacting === true || ev.type === 'compacting';
  ring.style.setProperty('--context-ratio', String(ratio));
  ring.dataset.ratio = String(pct);
  ring.setAttribute('aria-valuenow', String(pct));
  ring.classList.toggle('is-compacting', compacting);
  ring.classList.toggle('is-warm', !compacting && ratio >= 0.8);
  document.querySelector('footer.composer')?.classList.toggle('is-compacting-context', compacting);
  const label = $('contextRingLabel');
  if (label) {
    label.hidden = !compacting;
    label.textContent = t('compacting');
  }
  const tip = compacting
    ? t('compacting')
    : t('contextUsageDetail')
        .replace('{used}', tokens.toLocaleString())
        .replace('{window}', windowN.toLocaleString())
        .replace('{pct}', String(pct));
  ring.title = tip;
  ring.setAttribute('aria-label', tip);
}

/** Live clarify overlay — ephemeral chrome, never persisted in the bubble. */
let clarifyLiveState = null;

function clarifyHostForSession(sessionId) {
  const sid = String(sessionId || '');
  if (sid) {
    const inThread = uiState(sid).liveTask?.el?.querySelector?.('.clarify-live');
    if (inThread) return inThread;
  }
  const live = document.getElementById('clarifyLive');
  if (!live) return null;
  if (!sid || String(live.dataset.sessionId || '') === sid) return live;
  return null;
}

function taskForClarifySession(sessionId) {
  const sid = String(sessionId || '');
  if (liveTask && (!sid || String(liveTask.sessionId || '') === sid)) return liveTask;
  return sid ? uiState(sid).liveTask : null;
}

/** Leave the card in its parked thread. Do not transplant it onto the next session. */
function parkClarifyLive() {
  const host = document.getElementById('clarifyLive');
  if (host) host.removeAttribute('id');
  clarifyLiveState = null;
  clearClarifyingChrome();
}

function hideClarifyLive(sessionId) {
  const sid = String(sessionId || clarifyLiveState?.sessionId || getLiveSessionId() || '');
  const host = clarifyHostForSession(sid);
  if (host && !host.classList.contains('is-sealed')) host.remove();
  if (!clarifyLiveState || !sid || clarifyBelongsToSession(clarifyLiveState.sessionId, sid)) {
    clarifyLiveState = null;
  }
  if (!sid || sid === getWorkspaceSessionId()) clearClarifyingChrome();
}

function restoreClarifyForSession(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || sid !== getWorkspaceSessionId()) return;
  const u = uiState(sid);
  const existing = u.liveTask?.el?.querySelector?.('.clarify-live');
  if (existing) {
    if (!existing.classList.contains('is-sealed')) {
      existing.id = 'clarifyLive';
      const pending = u.pendingClarify;
      clarifyLiveState = {
        sessionId: sid,
        clarifyId: String(pending?.clarifyId || existing.dataset.clarifyId || ''),
        questions: Array.isArray(pending?.questions) ? pending.questions : [],
        picks: Array.isArray(pending?.picks) ? pending.picks : [],
        ...(pending?.kind === 'plan' || existing.classList.contains('is-plan')
          ? { kind: 'plan', plan: pending?.plan }
          : {})
      };
      u.liveTask.el.classList.add('is-clarifying');
      document.querySelector('footer.composer')?.classList.add('is-clarifying');
      $('panel')?.classList.add('is-clarifying');
    }
    u.pendingClarify = null;
    return;
  }
  const pending = u.pendingClarify;
  if (!pending) return;
  if (pending.sessionId && !clarifyBelongsToSession(pending.sessionId, sid)) {
    u.pendingClarify = null;
    return;
  }
  if (!taskForClarifySession(sid)?.body) return;
  u.pendingClarify = null;
  showClarifyLive({ ...pending, sessionId: sid });
}

function submitClarifyAnswers(answers) {
  const id = clarifyLiveState?.clarifyId;
  const sid = String(clarifyLiveState?.sessionId || getWorkspaceSessionId());
  hideClarifyLive(sid);
  if (!id) return;
  void workspaceRpc('answerClarify', {
    sessionId: sid,
    clarifyId: id,
    answers
  }).catch((err) => {
    console.warn('[clarify] answer failed', err);
  });
}

function submitPlanDecision(approved) {
  const answers = {
    approved: approved === true,
    decision: approved === true ? 'approve' : 'decline'
  };
  const id = clarifyLiveState?.clarifyId;
  const sid = String(clarifyLiveState?.sessionId || getWorkspaceSessionId());
  sealPlanPanel(approved === true ? 'approved' : 'declined');
  if (!id) return;
  void workspaceRpc('answerClarify', {
    sessionId: sid,
    clarifyId: id,
    answers
  }).catch((err) => {
    console.warn('[plan] answer failed', err);
  });
}

function submitPlanRevise(rawNotes) {
  const notes = String(rawNotes || '').trim();
  if (!notes) return;
  const answers = {
    approved: false,
    decision: 'revise',
    notes
  };
  const id = clarifyLiveState?.clarifyId;
  const sid = String(clarifyLiveState?.sessionId || getWorkspaceSessionId());
  sealPlanPanel('revise', notes);
  if (!id) return;
  void workspaceRpc('answerClarify', {
    sessionId: sid,
    clarifyId: id,
    answers
  }).catch((err) => {
    console.warn('[plan] revise failed', err);
  });
}

function openPlanReviseCompose(host) {
  if (!host) return;
  const actions = host.querySelector('.plan-panel-actions');
  if (actions) actions.hidden = true;
  let compose = host.querySelector('.plan-revise-compose');
  if (compose) {
    compose.hidden = false;
    compose.querySelector('.plan-revise-notes')?.focus();
    return;
  }
  compose = document.createElement('div');
  compose.className = 'plan-revise-compose';
  compose.innerHTML = `
    <label class="plan-revise-label" for="planReviseNotes">${escapeHtml(t('planReviseNotesLabel'))}</label>
    <textarea id="planReviseNotes" class="plan-revise-notes" rows="3" maxlength="2000" placeholder="${escapeHtml(t('planReviseNotesPh'))}"></textarea>
    <div class="plan-panel-actions is-revise">
      <button type="button" class="plan-decline-btn plan-revise-cancel">${escapeHtml(t('planReviseCancel'))}</button>
      <button type="button" class="plan-approve-btn plan-revise-submit" disabled>${escapeHtml(t('planReviseSubmit'))}</button>
    </div>
  `;
  host.querySelector('.plan-panel')?.appendChild(compose);
  const ta = compose.querySelector('.plan-revise-notes');
  const submit = compose.querySelector('.plan-revise-submit');
  const sync = () => {
    if (submit) submit.disabled = !String(ta?.value || '').trim();
  };
  ta?.addEventListener('input', sync);
  compose.querySelector('.plan-revise-cancel')?.addEventListener('click', () => {
    compose.hidden = true;
    if (actions) actions.hidden = false;
  });
  submit?.addEventListener('click', () => submitPlanRevise(ta?.value));
  sync();
  ta?.focus();
}

function normalizePlanStepForUi(raw) {
  if (typeof raw === 'string') {
    const title = raw.trim();
    return title ? { title, detail: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.text || raw.step || '').trim();
  const detail = String(raw.detail || raw.why || raw.description || '').trim();
  if (!title) return null;
  return { title, detail };
}

function planStepRowHtml(step, index) {
  const n = index + 1;
  const title = escapeHtml(step.title);
  const detail = String(step.detail || '').trim();
  if (!detail) {
    return `<div class="plan-step is-plain">
      <span class="plan-step-n">${n}</span>
      <span class="plan-step-title">${title}</span>
    </div>`;
  }
  return `<details class="plan-step">
    <summary class="plan-step-summary">
      <span class="plan-step-n">${n}</span>
      <span class="plan-step-title">${title}</span>
      <span class="plan-step-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6 4l4 4-4 4" /></svg></span>
    </summary>
    <div class="plan-step-detail">${escapeHtml(detail)}</div>
  </details>`;
}

function clearClarifyingChrome() {
  document.querySelector('.session-thread.is-active')?.classList.remove('is-clarifying');
  document.querySelector('footer.composer')?.classList.remove('is-clarifying');
  $('panel')?.classList.remove('is-clarifying');
}

function sealPlanPanel(decision, notes = '') {
  const sid = String(clarifyLiveState?.sessionId || getLiveSessionId() || '');
  const host = clarifyHostForSession(sid);
  if (!host?.classList.contains('is-plan')) {
    hideClarifyLive(sid);
    return;
  }
  const kind =
    decision === true || decision === 'approved'
      ? 'approved'
      : decision === 'revise'
        ? 'revise'
        : 'declined';
  host.removeAttribute('id');
  host.classList.add('is-sealed');
  host.classList.toggle('is-approved', kind === 'approved');
  host.classList.toggle('is-declined', kind === 'declined');
  host.classList.toggle('is-revise', kind === 'revise');
  host.querySelector('.clarify-live-banner')?.remove();
  host.querySelectorAll('.plan-panel-actions').forEach((el) => el.remove());
  host.querySelector('.plan-revise-compose')?.remove();
  const kicker = host.querySelector('.plan-panel-kicker');
  const label =
    kind === 'approved' ? t('planApproved') : kind === 'revise' ? t('planRevised') : t('planDeclined');
  if (kicker) kicker.textContent = label;
  host.setAttribute('aria-label', label);
  const trimmed = String(notes || '').trim();
  if (kind === 'revise' && trimmed) {
    const receipt = document.createElement('div');
    receipt.className = 'plan-revise-receipt';
    receipt.innerHTML = `
      <div class="plan-revise-receipt-kicker">${escapeHtml(t('planReviseNotesLabel'))}</div>
      <p class="plan-revise-receipt-notes">${escapeHtml(trimmed)}</p>
    `;
    host.querySelector('.plan-panel')?.appendChild(receipt);
  }
  clarifyLiveState = null;
  clearClarifyingChrome();
}

function showPlanLive(ev) {
  const sid = String(ev?.sessionId || getLiveSessionId() || '');
  if (!sid) return;
  hideClarifyLive(sid);
  hideLiveTurnProgress();
  const raw = ev?.plan && typeof ev.plan === 'object' ? ev.plan : null;
  const title = String(raw?.title || '').trim();
  const steps = Array.isArray(raw?.steps)
    ? raw.steps.map(normalizePlanStepForUi).filter(Boolean)
    : [];
  if (!title || !steps.length) return;
  const task = taskForClarifySession(sid);
  const body = task?.body;
  if (!body || (task.sessionId && !clarifyBelongsToSession(task.sessionId, sid))) return;

  const host = document.createElement('div');
  if (sid === getWorkspaceSessionId()) host.id = 'clarifyLive';
  host.className = 'clarify-live is-plan';
  host.dataset.sessionId = sid;
  host.dataset.clarifyId = String(ev.clarifyId || '');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', t('planning') || 'Plan');

  const banner = document.createElement('div');
  banner.className = 'clarify-live-banner';
  banner.innerHTML = `<span class="clarify-live-orb" aria-hidden="true"></span><span class="clarify-live-banner-text">${escapeHtml(t('planning'))}</span>`;
  host.appendChild(banner);

  const summary = String(raw.summary || '').trim();
  const panel = document.createElement('div');
  panel.className = 'plan-panel';
  panel.innerHTML = `
    <div class="plan-panel-head">
      <div class="plan-panel-kicker">${escapeHtml(t('planAwaiting'))}</div>
      <div class="plan-panel-title">${escapeHtml(title)}</div>
      ${summary ? `<p class="plan-panel-summary">${escapeHtml(summary)}</p>` : ''}
    </div>
    <div class="plan-panel-steps">${steps.map(planStepRowHtml).join('')}</div>
    <div class="plan-panel-actions">
      <button type="button" class="plan-decline-btn">${escapeHtml(t('planDecline'))}</button>
      <button type="button" class="plan-revise-btn">${escapeHtml(t('planRevise'))}</button>
      <button type="button" class="plan-approve-btn">${escapeHtml(t('planApprove'))}</button>
    </div>
  `;
  host.appendChild(panel);

  body.appendChild(host);
  task.el?.classList.add('is-clarifying');
  if (sid === getWorkspaceSessionId()) {
    document.querySelector('footer.composer')?.classList.add('is-clarifying');
    $('panel')?.classList.add('is-clarifying');
    clarifyLiveState = {
      sessionId: sid,
      clarifyId: String(ev.clarifyId || ''),
      questions: [],
      picks: [],
      kind: 'plan',
      plan: { title, summary, steps }
    };
  } else {
    uiState(sid).pendingClarify = {
      type: 'clarify',
      sessionId: sid,
      clarifyId: String(ev.clarifyId || ''),
      kind: 'plan',
      plan: { title, summary, steps }
    };
  }
  scrollTaskStream();

  host.querySelector('.plan-approve-btn')?.addEventListener('click', () => submitPlanDecision(true));
  host.querySelector('.plan-decline-btn')?.addEventListener('click', () => submitPlanDecision(false));
  host.querySelector('.plan-revise-btn')?.addEventListener('click', () => openPlanReviseCompose(host));
}

function showClarifyLive(ev) {
  if (ev?.kind === 'plan' || ev?.plan) {
    showPlanLive(ev);
    return;
  }
  const sid = String(ev?.sessionId || getLiveSessionId() || '');
  if (!sid) return;
  hideClarifyLive(sid);
  hideLiveTurnProgress();
  const questions = Array.isArray(ev?.questions) ? ev.questions : [];
  if (!questions.length) return;
  const task = taskForClarifySession(sid);
  const body = task?.body;
  if (!body || (task.sessionId && !clarifyBelongsToSession(task.sessionId, sid))) return;

  const host = document.createElement('div');
  if (sid === getWorkspaceSessionId()) host.id = 'clarifyLive';
  host.className = 'clarify-live';
  host.dataset.sessionId = sid;
  host.dataset.clarifyId = String(ev.clarifyId || '');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', t('clarifying') || 'Clarifying');

  const banner = document.createElement('div');
  banner.className = 'clarify-live-banner';
  banner.innerHTML = `<span class="clarify-live-orb" aria-hidden="true"></span><span class="clarify-live-banner-text">${escapeHtml(t('clarifying'))}</span>`;
  host.appendChild(banner);

  const picks = questions.map(() => ({ labels: [], other: '' }));
  const multi = questions.length > 1 || questions.some((q) => q.multiSelect);

  questions.forEach((q, qi) => {
    const card = document.createElement('div');
    card.className = 'pop-card-container clarify-card';
    const header = String(q.header || '').trim();
    const title = String(q.question || '').trim();
    const opts = Array.isArray(q.options) ? q.options : [];
    const optHtml = opts
      .map((opt) => {
        const label = typeof opt === 'string' ? opt : String(opt?.label || '');
        const desc = typeof opt === 'object' ? String(opt?.description || '') : '';
        if (!label) return '';
        return `<button type="button" class="pop-card-option-btn" data-q="${qi}" data-option="${escapeHtml(label)}">
          <span class="opt-text">${escapeHtml(label)}</span>
          ${desc ? `<span class="opt-desc">${escapeHtml(desc)}</span>` : ''}
        </button>`;
      })
      .join('');
    card.innerHTML = `
      ${header ? `<div class="clarify-card-kicker">${escapeHtml(header)}</div>` : ''}
      <div class="pop-card-header">
        <span class="pop-card-title">${escapeHtml(title)}</span>
      </div>
      <div class="pop-card-options-grid">${optHtml}</div>
      <div class="pop-card-custom-row">
        <input type="text" class="pop-card-custom-input" data-q="${qi}" placeholder="${escapeHtml(t('clarifyOtherPh'))}" aria-label="${escapeHtml(t('clarifyOther'))}" />
        ${multi ? '' : `<button type="button" class="pop-card-custom-submit" data-q="${qi}">${escapeHtml(t('clarifyOther'))}</button>`}
      </div>
    `;
    host.appendChild(card);
  });

  if (multi) {
    const row = document.createElement('div');
    row.className = 'clarify-live-actions';
    row.innerHTML = `<button type="button" class="clarify-continue-btn" disabled>${escapeHtml(t('clarifyContinue'))}</button>`;
    host.appendChild(row);
  }

  body.appendChild(host);
  task.el?.classList.add('is-clarifying');
  if (sid === getWorkspaceSessionId()) {
    document.querySelector('footer.composer')?.classList.add('is-clarifying');
    $('panel')?.classList.add('is-clarifying');
    clarifyLiveState = { sessionId: sid, clarifyId: String(ev.clarifyId || ''), questions, picks };
  } else {
    uiState(sid).pendingClarify = {
      type: 'clarify',
      sessionId: sid,
      clarifyId: String(ev.clarifyId || ''),
      questions,
      picks
    };
  }
  scrollTaskStream();

  const continueBtn = host.querySelector('.clarify-continue-btn');
  const syncContinue = () => {
    if (!continueBtn) return;
    const ready = picks.every((p, i) => {
      if (questions[i]?.multiSelect) return p.labels.length > 0 || p.other.trim();
      return p.labels.length > 0 || p.other.trim();
    });
    continueBtn.disabled = !ready;
  };

  const collect = () => {
    const answers = {};
    questions.forEach((q, i) => {
      const p = picks[i];
      const key = String(q.question || '');
      if (p.other.trim()) answers[key] = p.other.trim();
      else if (q.multiSelect) answers[key] = p.labels.slice();
      else answers[key] = p.labels[0] || '';
    });
    return answers;
  };

  host.querySelectorAll('.pop-card-option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qi = Number(btn.getAttribute('data-q'));
      const label = btn.getAttribute('data-option') || '';
      const q = questions[qi];
      const p = picks[qi];
      if (!p || !q) return;
      p.other = '';
      const input = host.querySelector(`.pop-card-custom-input[data-q="${qi}"]`);
      if (input) input.value = '';
      if (q.multiSelect) {
        const ix = p.labels.indexOf(label);
        if (ix >= 0) p.labels.splice(ix, 1);
        else p.labels.push(label);
        host.querySelectorAll(`.pop-card-option-btn[data-q="${qi}"]`).forEach((b) => {
          b.classList.toggle('is-selected', p.labels.includes(b.getAttribute('data-option') || ''));
        });
        syncContinue();
        return;
      }
      p.labels = [label];
      if (!multi) submitClarifyAnswers(collect());
      else {
        host.querySelectorAll(`.pop-card-option-btn[data-q="${qi}"]`).forEach((b) => {
          b.classList.toggle('is-selected', b.getAttribute('data-option') === label);
        });
        syncContinue();
      }
    });
  });

  host.querySelectorAll('.pop-card-custom-input').forEach((input) => {
    const sendOther = () => {
      const qi = Number(input.getAttribute('data-q'));
      const v = String(input.value || '').trim();
      if (!v) return;
      const p = picks[qi];
      if (!p) return;
      p.other = v;
      p.labels = [];
      host.querySelectorAll(`.pop-card-option-btn[data-q="${qi}"]`).forEach((b) => b.classList.remove('is-selected'));
      if (!multi) submitClarifyAnswers(collect());
      else syncContinue();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendOther();
      }
    });
    input.addEventListener('input', () => {
      const qi = Number(input.getAttribute('data-q'));
      if (picks[qi]) picks[qi].other = String(input.value || '').trim();
      syncContinue();
    });
  });
  host.querySelectorAll('.pop-card-custom-submit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qi = Number(btn.getAttribute('data-q'));
      const input = host.querySelector(`.pop-card-custom-input[data-q="${qi}"]`);
      const v = String(input?.value || '').trim();
      if (!v) return;
      picks[qi].other = v;
      picks[qi].labels = [];
      submitClarifyAnswers(collect());
    });
  });
  continueBtn?.addEventListener('click', () => {
    if (continueBtn.disabled) return;
    submitClarifyAnswers(collect());
  });
}

function handleSessionWorkspaceEvent(request) {
  if (request?.action !== 'session_workspace_event') return false;
  const ev = request.event || request;
  const sid = String(ev.sessionId || request.sessionId || '');
  const foreground = getWorkspaceSessionId();

  if (taskStatusUi.handleWorkspaceEvent(ev)) return true;

  if (ev?.type === 'session-title') {
    applySessionTitle(ev.title || ev.sessionTitle, sid || foreground);
    return true;
  }
  if (ev?.type === 'artifact_preview' || ev?.type === 'artifact_shelf_updated') {
    if (!sid || sid === foreground) void refreshArtifactShelf();
    return true;
  }
  if (ev?.type === 'context-usage' || ev?.type === 'compacting') {
    if (sid && sid !== foreground) {
      const sess = sessions.find((s) => String(s.id) === sid);
      if (sess) sess.contextUsage = ev;
      return true;
    }
    applyContextUsage(ev);
    return true;
  }
  if (ev?.type === 'compact-done') {
    if (sid && sid !== foreground) return true;
    const ring = $('contextRing');
    ring?.classList.remove('is-compacting');
    const label = $('contextRingLabel');
    if (label) label.hidden = true;
    document.querySelector('footer.composer')?.classList.remove('is-compacting-context');
    return true;
  }
  if (!sid) return true;

  if (ev.type === 'execution-start') {
    uiState(sid).running = true;
    uiState(sid).executionId = ev.executionId || uiState(sid).executionId;
    if (sid === foreground) {
      currentWorkspaceTaskId = ev.executionId || currentWorkspaceTaskId;
      setAgentRunningUi(true);
    }
    renderSessionRailList();
  }

  const applyLive = () => {
    if (ev?.type === 'clarify') {
      showClarifyLive({ ...ev, sessionId: sid });
      return;
    }
    if (ev?.type === 'clarify-done') {
      uiState(sid).pendingClarify = null;
      const host = clarifyHostForSession(sid);
      if (host?.classList.contains('is-plan')) {
        // Plan cards seal in place on their own thread; do not transplant or vanish.
        if (sid === foreground && !host.classList.contains('is-sealed')) {
          const decision =
            ev.decision === 'revise' ? 'revise' : ev.approved === true || ev.decision === 'approve' ? 'approved' : 'declined';
          if (clarifyLiveState && clarifyBelongsToSession(clarifyLiveState.sessionId, sid)) {
            sealPlanPanel(decision, ev.notes || '');
          }
        }
        return;
      }
      if (sid !== foreground) return;
      hideClarifyLive(sid);
      return;
    }
    if (ev.executionId) currentWorkspaceTaskId = ev.executionId;
    if (ev.type === 'image_generated') {
      handleImageGeneratedEvent(ev);
      return;
    }
    if (ev.type === 'assistant-final' || ev.type === 'execution-end') {
      settleLiveTurnFromTerminalEvent(ev);
      uiState(sid).running = false;
      if (sid === getWorkspaceSessionId()) setAgentRunningUi(false);
      renderSessionRailList();
      return;
    }
    if (ev.type === 'error') {
      const leaseNote = humanizeTabLeaseEvent(ev);
      const msg = leaseNote || streamEventText(ev.message) || String(ev.message || '').trim();
      if (msg && !liveTurnSealed) {
        const prefix = currentLang === 'en' ? '**Error:** ' : '**错误:** ';
        const painted = msg.startsWith('**') ? msg : `${prefix}${msg}`;
        liveTurnAnswerText = painted;
        renderLiveTurnAnswer(painted);
      }
      if (leaseNote) showQuickToast(leaseNote);
      ingestLiveProgressEvent(ev);
    } else if (ev.type === 'thought' || ev.type === 'thought-open') {
      if (liveTurnSealed || !uiState(sid).running) return;
      liveTurnThinkFromStream = true;
      const text = streamEventText(ev.text) || streamEventText(ev.chunk);
      ensureLiveTurnThink();
      if (text) {
        clearThinkPlaceholder();
        liveTurnThink?.push(text);
      }
    } else if (ev.type === 'text') {
      ingestLiveProgressEvent(ev);
    } else if (
      ev.type === 'tool-call' ||
      ev.type === 'tool-result' ||
      ev.type === 'tool-execution-end' ||
      ev.type === 'pixels' ||
      ev.type === 'image_request' ||
      ev.type === 'image' ||
      ev.type === 'image_error' ||
      ev.type === 'execution-start' ||
      ev.type === 'model-start' ||
      ev.type === 'model-end'
    ) {
      const leaseNote = ev.type === 'tool-result' ? humanizeTabLeaseEvent(ev) : '';
      if (leaseNote) {
        showQuickToast(leaseNote);
        if (!liveTurnSealed) {
          const prefix = currentLang === 'en' ? '**Notice:** ' : '**提示:** ';
          liveTurnAnswerText = `${prefix}${leaseNote}`;
          renderLiveTurnAnswer(liveTurnAnswerText);
        }
      }
      ingestLiveProgressEvent(ev);
    }
  };

  if (sid !== foreground) {
    withSessionLive(sid, applyLive);
    return true;
  }
  applyLive();
  return true;
}

function isMessageChannelError(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /message channel closed|asynchronous response|Receiving end does not exist|Could not establish connection|The message port closed|no response \(offscreen/i.test(
    msg
  );
}

async function recoverSendMessageResult(sessionId, startedAt) {
  const streamed = String(uiState(sessionId).liveTurnAnswerText || liveTurnAnswerText || '').trim();
  try {
    const full = await workspaceRpc('getSession', { sessionId });
    const msgs = Array.isArray(full?.messages) ? full.messages : [];
    const last = [...msgs].reverse().find((m) => {
      if (m?.role !== 'assistant') return false;
      const ts = Number(m.createdAt || m.ts || 0);
      return !startedAt || ts >= startedAt - 2000 || !ts;
    });
    const text = String(last?.content || '').trim();
    if (text) {
      return {
        finalText: text,
        thought: last.thought || '',
        toolCalls: last.toolCalls || [],
        sessionTitle: full?.title,
        recovered: true
      };
    }
  } catch {
    /* fall through to streamed text */
  }
  if (streamed) return { finalText: streamed, recovered: true };
  return null;
}

function finishLiveThinkBlocks(root) {
  try {
    liveTurnThink?.finish?.();
  } catch (_) {}
  const wrap = root || liveTurnWrap || liveTask?.body;
  wrap?.querySelectorAll?.('.think-block.is-live').forEach((el) => {
    try {
      el._pawThink?.finish?.();
    } catch (_) {}
    el.classList.remove('is-live');
    const summary = el.querySelector('.think-summary');
    if (summary && /思考中|Thinking/i.test(summary.textContent || '')) {
      summary.textContent = thinkDoneLabel('', el.dataset.effort || reasoningEffort);
    }
  });
}

/**
 * Fail-safe: execution-end / assistant-final always seals thinking + host lamps
 * for this task, even if a tool-result (正在获取文件) never arrived.
 */
function settleLiveTurnFromTerminalEvent(ev = {}) {
  ingestLiveProgressEvent({
    type: ev.type === 'assistant-final' ? 'assistant-final' : 'execution-end',
    content: ev.content
  });
  hideLiveTurnProgress();
  liveProgressState = createLiveProgressState();
  finishLiveThinkBlocks();
  const text = streamEventText(ev.content) || String(liveTurnAnswerText || '').trim();
  const sealed = promoteFinalAnswer(text, { force: true }) || {};
  const sid = getLiveSessionId();
  if (text || sealed.content) {
    recordLocalAssistantMessage(sid, {
      content: sealed.content || text,
      thought: sealed.thought || ''
    });
  }
  return sealed;
}

function finishLiveTurnUi(md, opts = {}) {
  liveTurnSealed = true;
  hideClarifyLive(getLiveSessionId());
  hideLiveTurnProgress();
  liveProgressState = createLiveProgressState();
  if (md && typeof md === 'object' && !Array.isArray(md)) {
    opts = { ...opts, ...md };
    md = '';
  }
  clearLiveTurnRenderTimer(getLiveSessionId());
  let thought = '';
  if (liveTurnThink) {
    const raw = typeof liveTurnThink.getText === 'function' ? liveTurnThink.getText() : '';
    const onlyPlaceholder = isThinkPlaceholderText(raw);
    thought = onlyPlaceholder ? '' : String(raw || '').trim();
    if (!thought && !liveTurnThinkFromStream) {
      try {
        liveTurnThink.clear?.();
      } catch (_) {}
      try {
        liveTurnThink.el?.remove();
      } catch (_) {}
    } else {
      if (!thought) {
        thought =
          currentLang === 'en'
            ? 'The model thought, but this effort level did not return a visible trace.'
            : '模型已思考，但这一档没有返回可展开的思考正文。';
        try {
          liveTurnThink.clear?.();
          liveTurnThink.push?.(thought);
        } catch (_) {}
      }
    }
    try {
      liveTurnThink.finish();
    } catch (_) {}
    try {
      liveTurnThink.destroy?.();
    } catch (_) {}
    liveTurnThink = null;
  }
  const thinkRoot = liveTurnWrap || liveTask?.body;
  thinkRoot?.querySelectorAll('.think-block.is-live').forEach((el) => {
    el.classList.remove('is-live');
    const summary = el.querySelector('.think-summary');
    if (summary && /思考中|Thinking/i.test(summary.textContent || '')) {
      summary.textContent = thinkDoneLabel('', el.dataset.effort || reasoningEffort);
    }
  });
  const content = streamEventText(md) || String(liveTurnAnswerText || '').trim();
  if (content) {
    renderLiveTurnAnswer(content, { final: true });
  } else if (opts.discardEmpty && liveTurnAnswerEl && !liveTurnAnswerEl.textContent?.trim()) {
    liveTurnAnswerEl.remove();
  }
  if (liveTurnAnswerEl) liveTurnAnswerEl.classList.remove('is-streaming');
  liveTurnAnswerEl = null;
  liveTurnAnswerText = '';
  liveTurnWrap = null;
  return { thought, content };
}

/**
 * Promote assistant answer into a NEW bubble for this turn (never overwrite prior turns).
 * @param {string} md
 * @param {{ force?: boolean }} [opts]
 */
function lastSealedAssistantContent() {
  const body = liveTurnWrap || liveTask?.body;
  const last = body ? [...body.querySelectorAll('.msg.assistant.msg-final')].pop() : null;
  if (!last) return '';
  return String(last.querySelector('.md-body')?.dataset?.pwAnswer || last.textContent || '').trim();
}

function promoteFinalAnswer(md, opts = {}) {
  const content = String(md || '').trim();
  if (liveTurnSealed && (lastSealedAssistantContent() || liveTurnWrap?.querySelector('.msg.assistant, .think-block'))) {
    return { thought: '', content: lastSealedAssistantContent() || content };
  }
  if (!content && !opts.force) return { thought: '', content: '' };
  return finishLiveTurnUi(content);
}

/**
 * @param {string} status
 */
function applyTaskUiStatus(status) {
  if (liveTask && typeof liveTask.setState === 'function') {
    liveTask.setState(mapTaskUiState(status));
  }
}

function renderPromptQueueHint() {
  const el = document.getElementById('promptQueueHint');
  if (!el) return;
  const n = (uiState(getWorkspaceSessionId()).promptQueue || []).length;
  el.hidden = n <= 0;
  el.textContent = n > 0 ? String(t('promptQueueN') || '').replace('{n}', String(n)) : '';
}

function enqueueComposerTurn(sessionId) {
  const promptInput = composerEl();
  if (!promptInput) return false;
  const mentions = filterLivePageMentions(composerMentionsFromDom(promptInput));
  const prompt = composerPlainText(promptInput).trim();
  const attachments = [...pendingAttachments];
  if (!prompt && attachments.length === 0) return false;
  const st = uiState(sessionId);
  if (!Array.isArray(st.promptQueue)) st.promptQueue = [];
  st.promptQueue.push({
    prompt,
    mentions,
    attachments,
    composerNodes: cloneComposerNodes(promptInput)
  });
  closeMentionPalette();
  clearComposer(promptInput);
  syncComposerTypewriterVisibility();
  if (getWorkspaceSessionId() === sessionId) {
    pendingAttachments = [];
    renderAttachmentPreviews();
  }
  renderPromptQueueHint();
  showQuickToast(t('promptQueued'));
  return true;
}

function flushPromptQueue(sessionId) {
  const st = uiState(sessionId);
  if (!st || st.running) return;
  const next = Array.isArray(st.promptQueue) ? st.promptQueue.shift() : null;
  renderPromptQueueHint();
  if (!next) return;
  void submitUserPrompt('chat', { ...next, sessionId });
}

async function submitUserPrompt(mode = 'chat', queuedTurn = null) {
  const runSessionId = queuedTurn?.sessionId || getWorkspaceSessionId();
  const promptInput = composerEl();
  let mentions;
  let prompt;
  let currentAttach;
  let composerNodes;
  if (queuedTurn) {
    mentions = queuedTurn.mentions || [];
    prompt = String(queuedTurn.prompt || '').trim();
    currentAttach = Array.isArray(queuedTurn.attachments) ? queuedTurn.attachments : [];
    composerNodes = queuedTurn.composerNodes;
    if (!prompt && currentAttach.length === 0) {
      flushPromptQueue(runSessionId);
      return;
    }
  } else {
    if (!promptInput) return;
    await refreshOpenMentionPages();
    mentions = filterLivePageMentions(composerMentionsFromDom(promptInput));
    prompt = composerPlainText(promptInput).trim();
    if (!prompt && pendingAttachments.length === 0) return;
    if (uiState(runSessionId).running) {
      enqueueComposerTurn(runSessionId);
      return;
    }
    currentAttach = [...pendingAttachments];
    composerNodes = cloneComposerNodes(promptInput);
  }
  // mode/composerSubmitMode is decorative only — architecture is always sendMessage

  await refreshSelectedElementsFromActiveTab();
  if (hasImageAttachments(currentAttach)) {
    const modelToCheck = $('modelSelect')?.value || selectedModel || '';
    // Known text-only: informational only. Never block or strip attachments.
    // Unknown / vision families (incl. x-ai/grok-4.6) send as-is; provider errors surface at runtime.
    if (isKnownTextOnlyChatModel(modelToCheck)) {
      showSidepanelToast(notMultimodalMessage(currentLang, modelToCheck), { ms: 4200 });
    }
  }

  await refreshOpenMentionPages();
  mentions = filterLivePageMentions(mentions);

  if (!queuedTurn && promptInput) {
    closeMentionPalette();
    clearComposer(promptInput);
    syncComposerTypewriterVisibility();
  }

  let userDisplayPrompt = prompt;
  if (currentAttach.length > 0) {
    const attachNames = currentAttach.map((a) => `${a.isImage ? '🖼️' : '📄'} ${a.name}`).join(', ');
    userDisplayPrompt =
      (prompt ? prompt + '\n' : '') + `*[attachments (${currentAttach.length}): ${attachNames}]*`;
  }

  let activeSess = sessions.find((s) => s.id === runSessionId) || sessions.find((s) => s.id === activeSessionId) || sessions[0];
  // Attachments ride with sendMessage; Session Workspace owns durable context.
  const fullUserContent = prompt || '分析我上传的附件内容';
  activeSess.messages.push({ role: 'user', content: fullUserContent, ts: Date.now() });
  ensureSessionTrajectory(activeSess);
  savePersistentSessions();

  const title = truncateUi(prompt || '附件分析', 48);

  // One live thread per session UI card; composer color is decorative only.
  const parkedTask = uiState(runSessionId).liveTask;
  const canContinue =
    !!parkedTask?.el && parkedTask.sessionId === runSessionId && !viewingHistoryId;

  const task = createTaskCard(title, {
    kind: 'chat',
    continueExisting: canContinue,
    sessionId: runSessionId
  });
  if (!task) return;

  if (!Array.isArray(task.messages)) task.messages = [];
  task.messages.push({ role: 'user', content: fullUserContent, ts: Date.now() });

  appendUserTurnBubble(task, userDisplayPrompt, composerNodes);

  try {
    await bindMentionGroups(mentions);
  } catch {
    /* send still proceeds; host only sees bound groups */
  }
  await refreshWorkspaceGroupState();
  uiState(runSessionId).running = true;
  uiState(runSessionId).abort = new AbortController();
  if (getWorkspaceSessionId() === runSessionId) {
    currentAgentAbort = uiState(runSessionId).abort;
    setAgentRunningUi(true);
  }
  renderSessionRailList();
  withSessionLive(runSessionId, () => beginLiveTurnUi());
  const turnStartedAt = Date.now();
  try {
    let workspaceResult;
    try {
      workspaceResult = await workspaceRpc('sendMessage', {
      sessionId: runSessionId,
      content: fullUserContent,
      role: 'user',
      mentions,
      activeTab: lastActivePage
        ? {
            url: lastActivePage.url,
            title: lastActivePage.title,
            origin: lastActivePage.origin,
            tabId: lastActivePage.tabId || lastActivePage.id || undefined
          }
        : null,
      reasoning: currentReasoningPayload(),
      attachments: currentAttach.map((att) => ({
        name: att.name,
        type: att.type || (att.isImage ? inferDataUrlMime(att.dataUrl) : 'text/plain'),
        isImage: Boolean(att.isImage),
        dataUrl: att.isImage ? att.dataUrl : undefined,
        textContent: att.isImage ? undefined : String(att.textContent || ''),
        source: att.source || 'attachment',
        labelKind: att.labelKind,
        labelN: att.labelN
      }))
    });
    } catch (rpcErr) {
      if (!isMessageChannelError(rpcErr)) throw rpcErr;
      workspaceResult = await recoverSendMessageResult(runSessionId, turnStartedAt);
      if (!workspaceResult) throw rpcErr;
    }
    const paintDone = () => {
      if (workspaceResult?.executionId) {
        currentWorkspaceTaskId = workspaceResult.executionId;
        uiState(runSessionId).executionId = workspaceResult.executionId;
      }
      if (workspaceResult?.sessionTitle) {
        applySessionTitle(workspaceResult.sessionTitle, runSessionId);
      }
      if (workspaceResult?.contextUsage) {
        const sess = sessions.find((s) => s.id === runSessionId);
        if (sess) sess.contextUsage = workspaceResult.contextUsage;
        if (getWorkspaceSessionId() === runSessionId) applyContextUsage(workspaceResult.contextUsage);
      }
      uiState(runSessionId).attachments = [];
      if (getWorkspaceSessionId() === runSessionId) {
        pendingAttachments = [];
        renderAttachmentPreviews();
      }
      const finalText =
        String(workspaceResult?.finalText || workspaceResult?.assistant?.content || '').trim() ||
        (currentLang === 'en' ? '(empty reply)' : '（空回复）');
      const sealed = promoteFinalAnswer(finalText, { force: true }) || {};
      const thoughtText = String(sealed.thought || workspaceResult?.thought || '').trim();
      applyTaskUiStatus('verified');
      if (task) {
        task.finalContent = finalText;
        if (!Array.isArray(task.messages)) task.messages = [];
        task.messages.push({
          role: 'assistant',
          content: finalText,
          thought: thoughtText,
          ts: Date.now(),
          taskStatus: 'verified',
          mode: 'session-agent',
          toolCalls: workspaceResult?.toolCalls || []
        });
      }
      recordLocalAssistantMessage(runSessionId, {
        content: finalText,
        thought: thoughtText,
        toolCalls: workspaceResult?.toolCalls || []
      });
    };
    withSessionLive(runSessionId, paintDone);
    if (getWorkspaceSessionId() === runSessionId) void refreshArtifactShelf();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = /abort/i.test(msg);
    const channel = isMessageChannelError(err);
    if (channel) {
      try {
        const probe = await workspaceRpc('getSession', { sessionId: runSessionId });
        if (isExecutionLive(readActiveExecution(probe))) {
          return;
        }
      } catch {
        /* treat as dead below */
      }
    }
    const finalStatusText = aborted
      ? currentLang === 'en'
        ? 'Stopped.'
        : '已停止。'
      : channel
        ? currentLang === 'en'
          ? 'The turn finished, but the side panel lost the long RPC. Check 交付物 for files, then send a follow-up if needed.'
          : '这一轮已经跑完，但侧栏和后台的长连接断了。请先看交付物里的文件，需要的话再发一句继续。'
        : currentLang === 'en'
        ? `**Error:** ${msg}`
        : `**错误:** ${msg}`;
    withSessionLive(runSessionId, () => {
      applyTaskUiStatus('failed');
      promoteFinalAnswer(finalStatusText, { force: true });
    });
  } finally {
    await refreshExecutionFromWorkspace(runSessionId);
    if (!uiState(runSessionId).running) {
      uiState(runSessionId).abort = null;
      if (getWorkspaceSessionId() === runSessionId) currentAgentAbort = null;
      flushPromptQueue(runSessionId);
    }
    renderSessionRailList();
    void refreshArtifactShelf();
  }
}


/** Compat: skill re-run and legacy callers — always unified Session sendMessage. */
async function runBrowserAgentTurn({ prompt, task, skipSend = false, preloadedResult = null }) {
  const runSessionId = getWorkspaceSessionId();
  uiState(runSessionId).running = true;
  if (getWorkspaceSessionId() === runSessionId) setAgentRunningUi(true);
  renderSessionRailList();
  withSessionLive(runSessionId, () => beginLiveTurnUi());
  try {
    const workspaceResult =
      preloadedResult ||
      (skipSend
        ? null
        : await workspaceRpc('sendMessage', {
            sessionId: runSessionId,
            content: prompt,
            role: 'user',
            reasoning: currentReasoningPayload()
          }));
    const finalText =
      String(workspaceResult?.finalText || workspaceResult?.assistant?.content || '').trim() ||
      '(empty)';
    withSessionLive(runSessionId, () => {
      applyTaskUiStatus('verified');
      const sealed = promoteFinalAnswer(finalText, { force: true }) || {};
      if (task) {
        task.finalContent = finalText;
        if (!Array.isArray(task.messages)) task.messages = [];
        task.messages.push({
          role: 'assistant',
          content: finalText,
          thought: sealed.thought || '',
          ts: Date.now(),
          mode: 'session-agent'
        });
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    withSessionLive(runSessionId, () => {
      applyTaskUiStatus('failed');
      promoteFinalAnswer(msg, { force: true });
    });
  } finally {
    await refreshExecutionFromWorkspace(runSessionId);
    renderSessionRailList();
  }
}

function decodeBase64Chunk(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readWorkspaceOutputDataUrl(taskId, path, mediaType) {
  const chunks = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const file = await workspaceRpc('readOutput', {
      taskId,
      path,
      offset,
      length: 512 * 1024
    });
    const part = decodeBase64Chunk(file.base64 || '');
    chunks.push(part);
    total += part.byteLength;
    offset = Number(file.nextOffset) || total;
    if (file.done) break;
    if (!part.byteLength) throw new Error(`Output read stalled for ${path}`);
  }
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const part of chunks) {
    bytes.set(part, cursor);
    cursor += part.byteLength;
  }
  return bytesToDataUrl(bytes, mediaType);
}


/**
 * Resolve every pending ask_user gate (run-scoped Map + legacy singleton).
 * @param {string} [answer]
 */
function settleAllPendingAskUser(answer = ASK_USER_STOP_ANSWER) {
  settlePendingAskUserForSession('', answer);
}

function settlePendingAskUserForSession(sessionId, answer = ASK_USER_STOP_ANSWER) {
  const sid = String(sessionId || '');
  const ans = answer == null ? ASK_USER_STOP_ANSWER : String(answer);
  const stoppedLabel =
    ans === ASK_USER_STOP_ANSWER
      ? currentLang === 'en'
        ? 'Stopped'
        : '已停止'
      : ans;
  const keep = [];
  for (const [key, gate] of pendingAskUserGates) {
    const gateSid = String(gate?.sessionId || '');
    if (sid && gateSid && gateSid !== sid) {
      keep.push([key, gate]);
      continue;
    }
    try {
      if (gate?.host && !gate.host.querySelector?.('.pop-card-answered')) {
        settlePopCardHost(gate.host, stoppedLabel);
      }
    } catch (_) {}
    try {
      gate?.resolve?.(ans);
    } catch (_) {}
  }
  pendingAskUserGates.clear();
  for (const [key, gate] of keep) pendingAskUserGates.set(key, gate);
  if (typeof pendingAskUserResolve === 'function') {
    const belongs = !sid || !keep.length;
    if (belongs && pendingAskUserGates.size === 0) {
      const fn = pendingAskUserResolve;
      pendingAskUserResolve = null;
      try {
        fn(ans);
      } catch (_) {}
    }
  }
  try {
    document.querySelectorAll('.agent-ask-user-host').forEach((host) => {
      const threadSid = host.closest('.session-thread')?.dataset.sessionId || '';
      if (sid && threadSid && threadSid !== sid) return;
      const card = host.querySelector?.('.pop-card-container');
      if (!card || card.classList.contains('is-answered')) return;
      if (host.querySelector('.pop-card-option-btn')) {
        settlePopCardHost(host, stoppedLabel);
      }
    });
  } catch (_) {}
}

/**
 * Register a pending ask_user resolve under a run key.
 * @param {string} runKey
 * @param {{ resolve: (a: string) => void, host?: HTMLElement|null, gateId?: string }} gate
 */
function registerPendingAskUser(runKey, gate) {
  const key = String(runKey || 'default');
  const prev = pendingAskUserGates.get(key);
  if (prev && prev.resolve !== gate.resolve) {
    try {
      prev.resolve(ASK_USER_STOP_ANSWER);
    } catch (_) {}
  }
  pendingAskUserGates.set(key, {
    resolve: gate.resolve,
    host: gate.host || null,
    gateId: gate.gateId || key,
    sessionId: String(gate.sessionId || getLiveSessionId())
  });
  // Mirror singleton so stream-rendered popcards can settle the same wait
  pendingAskUserResolve = (answer) => {
    const g = pendingAskUserGates.get(key);
    pendingAskUserGates.delete(key);
    pendingAskUserResolve = null;
    try {
      (g?.resolve || gate.resolve)(answer);
    } catch (_) {}
  };
}

/**
 * Unregister without resolving (caller already resolved).
 * @param {string} runKey
 */
function clearPendingAskUser(runKey) {
  const key = String(runKey || 'default');
  pendingAskUserGates.delete(key);
  pendingAskUserResolve = null;
}

/**
 * Collapse a pop-card host to a one-line answered receipt and remove interactivity.
 * @param {HTMLElement} host
 * @param {string} answer
 */
function settlePopCardHost(host, answer) {
  if (!host) return;
  const card = host.querySelector('.pop-card-container') || host;
  card.classList.add('is-answered');
  const label = String(answer || '').trim() || '…';
  card.innerHTML = `<div class="pop-card-answered">✓ ${escapeHtml(truncateUi(label, 120))}</div>`;
  // Soft fade out after a beat so the thread stays clean
  setTimeout(() => {
    try {
      host.style.transition = 'opacity 0.35s ease, max-height 0.35s ease';
      host.style.opacity = '0.55';
    } catch (_) {}
  }, 400);
}

/**
 * ask_user UI — options → popcard; free text → modal.
 * Races AbortSignal from currentAgentAbort (or opts.signal) so Stop unblocks the tool.
 * @param {HTMLElement} container
 * @param {string} question
 * @param {string[]} [options]
 * @param {{ runKey?: string, signal?: AbortSignal|null }} [opts]
 * @returns {Promise<string>}
 */
function askUserViaPopcard(container, question, options = [], opts = {}) {
  const runKey =
    (opts && opts.runKey) ||
    (liveTask && liveTask.id != null ? `task_${liveTask.id}` : null) ||
    `ask_${Date.now()}`;
  const signal =
    (opts && opts.signal) ||
    (currentAgentAbort && currentAgentAbort.signal) ||
    null;

  return new Promise((resolve) => {
    let settled = false;
    /** @type {HTMLElement|null} */
    let popHost = null;
    let abortHandler = null;

    const finish = (answer) => {
      if (settled) return;
      settled = true;
      if (abortHandler && signal) {
        try {
          signal.removeEventListener('abort', abortHandler);
        } catch (_) {}
      }
      clearPendingAskUser(runKey);
      resolve(answer == null ? '' : String(answer));
    };

    // Already stopped before UI opens
    if (signal?.aborted) {
      finish(ASK_USER_STOP_ANSWER);
      return;
    }

    registerPendingAskUser(runKey, {
      resolve: finish,
      host: null,
      gateId: runKey
    });

    abortHandler = () => {
      const stoppedLabel = currentLang === 'en' ? 'Stopped' : '已停止';
      try {
        if (popHost) settlePopCardHost(popHost, stoppedLabel);
      } catch (_) {}
      finish(ASK_USER_STOP_ANSWER);
    };
    try {
      signal?.addEventListener('abort', abortHandler, { once: true });
    } catch (_) {}

    if (Array.isArray(options) && options.length > 0) {
      const cardData = { question, options };
      const fence = '```popcard\n' + JSON.stringify(cardData, null, 2) + '\n```';
      popHost = document.createElement('div');
      popHost.className = 'agent-ask-user-host';
      container.appendChild(popHost);
      // Update gate with host for Stop UI settle
      registerPendingAskUser(runKey, {
        resolve: finish,
        host: popHost,
        gateId: runKey
      });
      renderPopCardsInMessage(popHost, fence, { interactive: false });
      popHost.querySelectorAll('.pop-card-option-btn').forEach((btn) => {
        const clone = btn.cloneNode(true);
        btn.parentNode.replaceChild(clone, btn);
        clone.addEventListener('click', () => {
          const optVal = clone.getAttribute('data-option') || clone.innerText;
          settlePopCardHost(popHost, optVal);
          finish(optVal);
        });
      });
      const customInput = popHost.querySelector('.pop-card-custom-input');
      const customSubmit = popHost.querySelector('.pop-card-custom-submit');
      if (customSubmit && customInput) {
        const handler = () => {
          const v = customInput.value.trim();
          if (!v) return;
          settlePopCardHost(popHost, v);
          finish(v);
        };
        customSubmit.onclick = handler;
        customInput.onkeydown = (e) => {
          if (e.key === 'Enter') handler();
        };
      }
    } else {
      showCustomModal({
        title: question || (currentLang === 'en' ? 'Please clarify' : '请补充说明'),
        placeholder: currentLang === 'en' ? 'Your answer…' : '输入您的回答...',
        initialValue: '',
        onConfirm: (val) => {
          finish(val || '');
        },
        onCancel: () => {
          // Stop may also click cancel after settle — finish is idempotent
          if (!settled) finish('(user skipped)');
        }
      });
    }
  });
}

function submitCustomPrompt(promptText) {
  const promptInput = composerEl();
  if (promptInput) {
    setComposerPlainText(promptText, promptInput);
    submitUserPrompt();
  }
}

function setupCoreEventListeners() {
  $('pickBtn')?.addEventListener('click', () => togglePickerMode());
  $('clearSelBtn')?.addEventListener('click', () => clearSelection());
  // Custom Group Select (capture target) + session bind bar under dialog
  wireGroupSelectUi();
  wireSessionContextBar();
  wireModelSelectUi();
  // Single up-arrow send; hover + wheel flips chat ↔ run (purple when run)
  const sendBtnEl = $('sendBtn');
  sendBtnEl?.addEventListener('click', () => {
    if (isCurrentSessionRunning()) return;
    void submitUserPrompt(composerSubmitMode);
  });
  sendBtnEl?.addEventListener(
    'wheel',
    (e) => {
      if (isCurrentSessionRunning()) return;
      e.preventDefault();
      e.stopPropagation();
      // Scroll up → run (purple); scroll down → chat (accent)
      if (e.deltaY < 0) applyComposerSubmitMode('run');
      else if (e.deltaY > 0) applyComposerSubmitMode('chat');
    },
    { passive: false }
  );
  $('stopBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isCurrentSessionRunning() && !currentAgentAbort) return;
    stopAgentRun('user_stop');
  });
  // While pick mode is on: focusing / clicking the composer exits pick so typing is normal
  const chatInput = composerEl();
  if (chatInput) {
    syncComposerEmptyClass(chatInput);
    chatInput.addEventListener('compositionstart', () => {
      mentionComposing = true;
    });
    chatInput.addEventListener('compositionend', () => {
      mentionComposing = false;
      syncComposerEmptyClass(chatInput);
      syncComposerTypewriterVisibility();
      syncMentionPaletteFromCaret();
    });
    chatInput.addEventListener('beforeinput', (e) => {
      if (e.inputType && String(e.inputType).startsWith('delete')) return;
      const incoming = e.data != null ? String(e.data) : '';
      if (composerPlainText(chatInput).length + incoming.length > COMPOSER_MAX_CHARS) {
        e.preventDefault();
      }
    });
    chatInput.addEventListener('input', (e) => {
      syncComposerEmptyClass(chatInput);
      syncComposerTypewriterVisibility();
      if (e.isComposing || mentionComposing) return;
      syncMentionPaletteFromCaret();
    });
    const exitPickOnCompose = () => {
      void exitPickerModeIfActive();
    };
    chatInput.addEventListener('focus', () => {
      exitPickOnCompose();
      syncComposerTypewriterVisibility();
    });
    chatInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (document.activeElement === chatInput) return;
        if ($('mentionPalette')?.contains(document.activeElement)) return;
        closeMentionPalette();
        syncComposerTypewriterVisibility();
      }, 120);
    });
    chatInput.addEventListener('pointerdown', () => {
      exitPickOnCompose();
      $('composerTypewriter')?.classList.add('is-off');
    });
    chatInput.addEventListener('click', () => {
      exitPickOnCompose();
      if (!mentionComposing) syncMentionPaletteFromCaret();
    });
    chatInput.addEventListener('keyup', (e) => {
      if (mentionComposing || e.isComposing) return;
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      if (
        mentionPaletteOpen &&
        ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape'].includes(e.key)
      ) {
        return;
      }
      syncMentionPaletteFromCaret();
    });
    chatInput.addEventListener('keydown', (e) => {
      if (mentionPaletteOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveMentionPalette(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveMentionPalette(-1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const pick = mentionPaletteItems[mentionPaletteIndex];
          if ((pick?.kind === 'group' || pick?.kind === 'workspace') && pick.id) {
            mentionPaletteExpanded.add(String(pick.id));
            renderMentionPalette(mentionPaletteQuery, mentionPaletteRange);
          }
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const pick = mentionPaletteItems[mentionPaletteIndex];
          const gid = pick?.kind === 'group' ? pick.id : pick?.groupId;
          if (gid) {
            mentionPaletteExpanded.delete(String(gid));
            renderMentionPalette(mentionPaletteQuery, mentionPaletteRange);
          }
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const pick = mentionPaletteItems[mentionPaletteIndex];
          if (pick?.kind === 'workspace') {
            toggleMentionSection(String(pick.id || WORKSPACE_MENTION_ID));
            return;
          }
          if (pick) void insertComposerMention(pick);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMentionPalette();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isCurrentSessionRunning()) {
          stopAgentRun('user_stop');
          return;
        }
        const mode = e.ctrlKey || e.metaKey ? 'run' : composerSubmitMode;
        void submitUserPrompt(mode);
      }
    });
  }
  document.addEventListener('mousedown', (e) => {
    const pal = $('mentionPalette');
    if (!mentionPaletteOpen || !pal) return;
    if (pal.contains(e.target) || composerEl()?.contains(e.target)) return;
    closeMentionPalette();
  });
  applyComposerSubmitMode(composerSubmitMode);
  $('langToggle')?.addEventListener('click', () => {
    setAppLanguage(currentLang === 'zh' ? 'en' : 'zh');
  });
  $('themeToggleBtn')?.addEventListener('click', () => {
    cycleThemeMode();
    currentTheme = getResolvedTheme();
  });
  $('gearBtn')?.addEventListener('click', () => openAgentSettingsModal());
  // More sheet consolidates lang / theme / settings (topbar only keeps ⋯)
  $('moreLangBtn')?.addEventListener('click', () => {
    setAppLanguage(currentLang === 'zh' ? 'en' : 'zh');
    const b = $('moreLangBtn');
    if (b) b.textContent = currentLang === 'zh' ? '语言 · 中文' : 'Language · EN';
  });
  $('moreThemeBtn')?.addEventListener('click', () => {
    cycleThemeMode();
    currentTheme = getResolvedTheme();
    const b = $('moreThemeBtn');
    if (b) {
      b.textContent =
        currentTheme === 'light'
          ? currentLang === 'en'
            ? 'Theme · Light'
            : '主题 · 浅色'
          : currentLang === 'en'
            ? 'Theme · Dark'
            : '主题 · 深色';
    }
  });
  $('moreSettingsBtn')?.addEventListener('click', () => {
    closeMoreSheet();
    openAgentSettingsModal();
  });
  $('moreSkillsBtn')?.addEventListener('click', () => {
    closeMoreSheet();
    openSkillsSettingsModal();
  });

  $('pageListenBtn')?.addEventListener('click', () => {
    void updateActivePageListeningBanner();
  });
  $('moreBtn')?.addEventListener('click', () => openMoreSheet());
  $('sheetClose')?.addEventListener('click', () => closeMoreSheet());
  $('sheetBackdrop')?.addEventListener('click', () => closeMoreSheet());
  $('clearHistoryBtn')?.addEventListener('click', () => clearAllHistory());
  $('historyToggleBtn')?.addEventListener('click', () => {
    historyListExpanded = !historyListExpanded;
    renderHistoryList();
  });
  // Clicking the history title also toggles expand/collapse
  $('historyHeaderToggle')?.addEventListener('click', (e) => {
    if (e.target?.closest?.('#clearHistoryBtn') || e.target?.closest?.('#historyToggleBtn')) return;
    historyListExpanded = !historyListExpanded;
    renderHistoryList();
  });

  $('toolDlImg')?.addEventListener('click', () => {
    void executeCrossTabImageDownload().then(() => {
      const n = selectionCountsFrom(selectedElementsSummary).images;
      if (n > 0) showQuickToast(t('toastDlImg').replace('{n}', String(n)));
    });
  });
  $('toolExportTable')?.addEventListener('click', () => {
    void sendActiveTabHarvest('util_export_table_csv').then((res) => {
      const n = Number(res?.count) || selectionCountsFrom(selectedElementsSummary).tables;
      if (n > 0) showQuickToast(t('toastExportTable').replace('{n}', String(n)));
      else showQuickToast(t('toastHarvestEmpty'));
    });
  });
  $('toolCopyLink')?.addEventListener('click', () => {
    const local = selectedHarvestHrefs();
    if (local.length) {
      copyTextToSystem(local.join('\n'))
        .then(() => showQuickToast(t('toastCopyLink').replace('{n}', String(local.length))))
        .catch(() => showQuickToast(t('toastCopyFail')));
      return;
    }
    void sendActiveTabHarvest('util_copy_links').then((res) => {
      const n = Number(res?.count) || 0;
      if (n > 0) showQuickToast(t('toastCopyLink').replace('{n}', String(n)));
      else showQuickToast(t('toastHarvestEmpty'));
    });
  });
  $('toolDlFile')?.addEventListener('click', () => {
    const files = selectedHarvestHrefs().filter((h) => hrefLooksDownloadable(h));
    if (files.length && chrome?.downloads?.download) {
      files.forEach((url, i) => {
        chrome.downloads.download({ url, filename: undefined, conflictAction: 'uniquify' }).catch(() => {});
      });
      showQuickToast(t('toastDlFile').replace('{n}', String(files.length)));
      return;
    }
    void sendActiveTabHarvest('util_download_link_files').then((res) => {
      const n = Number(res?.count) || 0;
      if (n > 0) showQuickToast(t('toastDlFile').replace('{n}', String(n)));
      else showQuickToast(t('toastHarvestEmpty'));
    });
  });
  $('toolDlSvg')?.addEventListener('click', () => {
    void sendActiveTabHarvest('util_download_svgs').then((res) => {
      const n = Number(res?.count) || 0;
      if (n > 0) showQuickToast(t('toastDlSvg').replace('{n}', String(n)));
      else showQuickToast(t('toastHarvestEmpty'));
    });
  });
  $('toolCoverLink')?.addEventListener('click', () => {
    void sendActiveTabHarvest('util_export_cover_links').then((res) => {
      const n = Number(res?.count) || 0;
      if (n > 0) showQuickToast(t('toastCoverLink').replace('{n}', String(n)));
      else showQuickToast(t('toastHarvestEmpty'));
    });
  });
  // toolClip pill removed — clipboard co-opens with selection hover
  // pinSelBtn: data-drawer-pin handled by hoverDrawer (keeps panel open, not clipboard)
  $('clearClipBtn')?.addEventListener('click', () => {
    const items = [...($('clipList')?.querySelectorAll('.clip-item') || [])];
    void animateLeave(items).then(() => {
      persistClipboardClear();
      clipSelectedIds.clear();
      autoPinnedTextKeys.clear();
      renderClipboardUI();
      renderQuickTools();
      showQuickToast(t('toastClipCleared'));
    });
  });
  $('clipCopySelectedBtn')?.addEventListener('click', () => {
    const picked = selectedClipboardItems().filter((c) => clipSelectedIds.has(c.id));
    if (!picked.length) return;
    const body = picked.map((c) => String(c.text || '')).join('\n\n');
    copyTextToSystem(body)
      .then(() => {
        showQuickToast(t('toastClipMultiCopy').replace('{n}', String(picked.length)));
      })
      .catch(() => showQuickToast(t('toastCopyFail')));
  });
  $('clipDeleteSelectedBtn')?.addEventListener('click', () => {
    const ids = [...clipSelectedIds];
    if (!ids.length) return;
    const items = [...($('clipList')?.querySelectorAll('.clip-item.is-checked') || [])];
    void animateLeave(items).then(() => {
      persistClipboardRemove(ids);
      clipSelectedIds.clear();
      renderClipboardUI();
      renderQuickTools();
      showQuickToast(t('toastClipMultiDel').replace('{n}', String(ids.length)));
    });
  });
  // Clipboard export menu: JS hidden-toggle by default (native popover opt-in only)
  clipExportPopover = wirePopoverMenu({
    trigger: $('clipExportBtn'),
    menu: $('clipExportMenu'),
    useNative: false
  });
  document.querySelectorAll('.clip-export-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      exportClipboard(btn.getAttribute('data-fmt') || 'txt');
      closeExportMenu();
    });
  });
  // Esc / drawer close also covered by wirePopoverMenu + closeExportMenu on clip close

  $('newSessionBtn')?.addEventListener('click', () => createNewSession());
  $('renameSessionBtn')?.addEventListener('click', () => renameActiveSession());
  $('deleteSessionBtn')?.addEventListener('click', () => void deleteActiveSession());
  $('sessionSelect')?.addEventListener('change', (e) => switchSession(e.target.value));
  wireArtifactMenu();
  $('exportMdBtn')?.addEventListener('click', () => exportCurrentSessionMarkdown());
  $('thinkEffortPop')?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  $('modelSelect')?.addEventListener('change', (e) => {
    selectedModel = e.target.value;
    chrome.storage.local.set({ selected_model: selectedModel });
    void persistComposerModel(selectedModel);
    syncReasoningSwitch();
    void refreshReasoningCatalog(false);
    refreshAgentStatusBadge();
  });
  $('captureScreenshotBtn')?.addEventListener('click', () => {
    void requestUserScreenshot('button');
  });

  // Initial welcome chips (guide only); selection-driven chips via scheduleSelectionSuggestions
  try {
    renderHintChips(getGuideOnlyHints());
  } catch (_) {}
  // welcomePickBtn removed (topbar pick is the single entry)

  $('draftsRefreshBtn')?.addEventListener('click', () => {
    void refreshUnfinishedDraftsList();
  });

  $('sheetSelClear')?.addEventListener('click', () => {
    void sheetSelRpc('clearSelections');
    sheetSelState.selections = [];
    const sid = getWorkspaceSessionId();
    uiState(sid).sheetSel = { ...sheetSelState, sessionId: sid };
    renderSheetSelRow();
  });
  $('canvasSelClear')?.addEventListener('click', () => {
    sheetSelState.selections = [];
    const sid = getWorkspaceSessionId();
    uiState(sid).sheetSel = { ...sheetSelState, sessionId: sid };
    renderSheetSelRow();
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === 'sheet_tab_state' || request?.action === 'html_tab_state') {
      applySheetSelState(request);
      return false;
    }
    if (request?.action === 'artifact_written') {
      void refreshArtifactShelf().then(() => pulseArtifactBadge());
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'workspace_open_tabs_changed' && Array.isArray(request.pages)) {
      applyOpenMentionPages(request.pages);
      sendResponse?.({ ok: true });
      return false;
    }
    if (handleSessionWorkspaceEvent(request)) {
      sendResponse?.({ ok: true });
      return true;
    }
    // T11: preview save / agent revise → refresh draft card version
    if (handleDraftRuntimeMessage(request)) {
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'clipboard_text_picked') {
      const text = clipClipboardText(String(request.text || ''));
      if (text.trim()) pinTextsToClipboard([{ text, kind: 'text' }], { openDrawer: true, toast: true });
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'elements_updated' || request?.type === 'elements_updated') {
      handleElementsUpdatedMessage(request, sender);
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'page_url_into_group') {
      const href = String(request.url || request.href || '').trim();
      if (href) {
        void addUrlsToActiveGroup({
          url: href,
          title: request.title || '',
          addedBy: 'page-click'
        });
      }
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'content_script_ready') {
      const tabId = sender?.tab?.id;
      if (tabId != null) void restoreBoundHighlightsToTab(tabId, request.url || sender?.tab?.url || '');
      sendResponse?.({ ok: true });
      return true;
    }
    if (request?.action === 'picker_state' || request?.action === 'picker_state_changed') {
      if (request.active !== undefined) updatePickerButtonState(!!request.active);
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });

  void refreshUnfinishedDraftsList();
}

async function syncPickerStateFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const url = tab.url || tab.pendingUrl || '';
    if (isPawWorkTabUrl(url)) {
      const res = await chrome.tabs.sendMessage(tab.id, { action: 'get_picker_state' });
      if (res && res.active !== undefined) updatePickerButtonState(res.active);
      else updatePickerButtonState(false);
      return;
    }
    await ensureContentScriptActive(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'get_picker_state' });
    if (res && res.active !== undefined) updatePickerButtonState(res.active);
  } catch (_) {
    /* ignore */
  }
}

/* ===== PRODUCTION HELPERS BELOW (modal IDs preserved) ===== */


/* ===== Web Workspace group bridge ===== */
function getWorkspaceSessionId() {
  return activeSessionId != null ? String(activeSessionId) : 'default';
}

/** @type {Array<object>} */
let sessionArtifacts = [];
let artifactRailFilter = 'all';
const artifactRailCollapsed = new Map();
/** @type {Set<string>} */
const selectedArtifactIds = new Set();

/** Live Univer ranges or HTML canvas slots above the composer. Hint only — not a bind gate. */
let sheetSelState = emptySheetSel('');
/** Last painted chip fingerprint — skip rebuild when Univer rebroadcasts the same ranges. */
let lastSheetSelFp = '';
/** sheet name → expanded (default true) */
const sheetSelOpen = new Map();
/** plateId → expanded (default true) */
const canvasSelOpen = new Map();

function sheetSelKey(sel) {
  return `${sel?.sheet || 'Sheet1'}!${sel?.a1 || ''}`;
}

function canvasSelKey(sel) {
  return `${sel?.plateId || sel?.sheet || ''}#${sel?.slotId || ''}`;
}

/** Excel A1 / A1:C3 — not canvas slot ids like headline. */
function isExcelA1Range(value) {
  const s = String(value || '').replace(/\$/g, '').trim();
  return /^[A-Za-z]{1,3}\d{1,7}(?::[A-Za-z]{1,3}\d{1,7})?$/.test(s);
}

function isHtmlCanvasPayload(payload = {}, selections = []) {
  if (payload.action === 'html_tab_state') return true;
  if (payload.action === 'sheet_tab_state') return false;
  if (payload.source === 'html') return true;
  if (payload.source === 'sheet') return false;
  return (selections || []).some((s) => {
    const hasSlot = !!(s?.plateId || s?.slotId || s?.nodeId);
    const a1 = s?.a1 || s?.range || s?.slotId || '';
    return hasSlot && !isExcelA1Range(a1);
  });
}

function sheetSelIsCanvas(state = sheetSelState) {
  if (state?.source === 'html') return true;
  if (state?.source === 'sheet') return false;
  return isHtmlCanvasPayload({}, state?.selections || []);
}

function sheetSelItemKey(sel, canvas) {
  return canvas ? canvasSelKey(sel) : sheetSelKey(sel);
}

function sheetSelItemKeys(state = sheetSelState) {
  const canvas = sheetSelIsCanvas(state);
  return (state?.selections || []).map((s) => sheetSelItemKey(s, canvas));
}

function sheetSelFingerprint(state = sheetSelState) {
  return [
    String(state?.sessionId || ''),
    String(state?.artifactId || ''),
    sheetSelIsCanvas(state) ? 'html' : 'sheet',
    String(state?.kind || ''),
    sheetSelItemKeys(state).join('\n')
  ].join('\0');
}

function pulseSheetSelChip(chip, key, pulseKeys) {
  if (!chip || !key || !pulseKeys?.has?.(key)) return;
  chip.classList.add('is-flash');
  chip.addEventListener('animationend', () => chip.classList.remove('is-flash'), { once: true });
}

function canvasShellLabel(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'site' || k === 'web') return t('canvasSelSite');
  if (k === 'deck' || k === 'slides' || k === 'poster' || k === 'design' || k === 'json-canvas') {
    return t('canvasSelShell');
  }
  return t('canvasSelShell');
}

function canvasSlotGlyph(sel) {
  const k = String(sel?.slotKind || sel?.kind || '').toLowerCase();
  if (k === 'image' || k === 'img' || k === 'picture' || k === 'photo' || k === '图') {
    return t('canvasSelKindImage');
  }
  return t('canvasSelKindText');
}

function canvasSlotName(sel) {
  const text = String(sel?.text || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 18);
  return String(sel?.nodeId || sel?.slotId || sel?.a1 || '').trim();
}

function applySheetSelState(payload = {}) {
  const sid = String(payload.sessionId || '');
  const overview = payload.overview && typeof payload.overview === 'object' ? payload.overview : {};
  const raw = Array.isArray(overview.selections)
    ? overview.selections
    : Array.isArray(payload.selections)
      ? payload.selections
      : overview.selection
        ? [overview.selection]
        : [];
  const mapped = raw
    .map((s) => {
      if (!s) return null;
      if (typeof s === 'string') {
        const bang = s.lastIndexOf('!');
        return bang > 0
          ? { sheet: s.slice(0, bang), a1: s.slice(bang + 1) }
          : { sheet: 'Sheet1', a1: s };
      }
      const plateId = String(s.plateId || '');
      const slotId = String(s.nodeId || s.slotId || '');
      const sheet = String(s.sheet || plateId || 'Sheet1');
      const a1 = String(s.a1 || s.range || slotId || '');
      const text = String(s.text || s.label || '').replace(/\s+/g, ' ').trim();
      const slotKind = String(s.kind || s.slotKind || s.tag || s.type || '').toLowerCase();
      if (!a1 && !slotId) return null;
      return { sheet, a1, plateId, slotId, nodeId: slotId, text, slotKind };
    })
    .filter(Boolean);
  const html = isHtmlCanvasPayload(payload, mapped);
  const selections = html
    ? mapped.filter((s) => String(s.slotId || '').trim())
    : mapped.filter((s) => String(s.a1 || '').trim());
  const next = {
    sessionId: sid,
    artifactId: String(payload.artifactId || overview.artifactId || ''),
    name: String(overview.name || ''),
    kind: String(overview.kind || overview.shell || payload.kind || ''),
    source: html ? 'html' : 'sheet',
    selections
  };
  if (sid) uiState(sid).sheetSel = next;
  if (!shouldApplySessionBroadcast(sid, getWorkspaceSessionId())) return;
  const prevKeys = new Set(sheetSelItemKeys(sheetSelState));
  const nextFp = sheetSelFingerprint(next);
  sheetSelState = next;
  if (nextFp === lastSheetSelFp) return;
  const pulseKeys = new Set(sheetSelItemKeys(next).filter((k) => k && !prevKeys.has(k)));
  renderSheetSelRow({ pulseKeys });
}

function sheetSelGroupsFrom(list) {
  const order = [];
  const bySheet = new Map();
  for (const sel of list || []) {
    const name = String(sel.sheet || 'Sheet1');
    if (!bySheet.has(name)) {
      bySheet.set(name, []);
      order.push(name);
    }
    bySheet.get(name).push(sel);
  }
  return order.map((sheet) => ({ sheet, items: bySheet.get(sheet) || [] }));
}

function hideCanvasSelRow() {
  const row = $('canvasSelRow');
  const host = $('canvasSelGroups');
  const clearBtn = $('canvasSelClear');
  if (row) row.hidden = true;
  if (clearBtn) clearBtn.hidden = true;
  if (host) host.replaceChildren();
}

function hideSheetSelRow() {
  const row = $('sheetSelRow');
  const host = $('sheetSelGroups');
  const clearBtn = $('sheetSelClear');
  if (row) row.hidden = true;
  if (clearBtn) clearBtn.hidden = true;
  if (host) host.replaceChildren();
}

function renderSheetSelRow(opts = {}) {
  lastSheetSelFp = sheetSelFingerprint(sheetSelState);
  if (sheetSelIsCanvas()) {
    renderCanvasSelRow(opts);
    return;
  }
  hideCanvasSelRow();
  const row = $('sheetSelRow');
  const host = $('sheetSelGroups');
  const clearBtn = $('sheetSelClear');
  if (!row || !host) return;
  const list = sheetSelState.selections || [];
  host.replaceChildren();
  if (!list.length) {
    row.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    sheetSelOpen.clear();
    return;
  }
  row.hidden = false;
  row.title = t('sheetSelHint');
  if (clearBtn) {
    clearBtn.hidden = false;
    clearBtn.textContent = t('sheetSelClear');
  }
  const live = new Set();
  for (const group of sheetSelGroupsFrom(list)) {
    live.add(group.sheet);
    if (!sheetSelOpen.has(group.sheet)) sheetSelOpen.set(group.sheet, true);
    const expanded = sheetSelOpen.get(group.sheet) !== false;
    const wrap = document.createElement('div');
    wrap.className = 'sheet-sel-group' + (expanded ? '' : ' is-collapsed');
    wrap.dataset.sheet = group.sheet;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sheet-sel-group-toggle';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.title = group.sheet;
    const caret = document.createElement('span');
    caret.className = 'sheet-sel-group-caret';
    caret.textContent = expanded ? '▾' : '▸';
    const nameEl = document.createElement('span');
    nameEl.className = 'sheet-sel-group-name';
    nameEl.textContent = group.sheet;
    const countEl = document.createElement('span');
    countEl.className = 'sheet-sel-group-count';
    countEl.textContent = String(group.items.length);
    toggle.append(caret, nameEl, countEl);
    toggle.addEventListener('click', () => {
      sheetSelOpen.set(group.sheet, !expanded);
      renderSheetSelRow();
    });

    const body = document.createElement('div');
    body.className = 'sheet-sel-group-body';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'sheet-sel-nav';
    prevBtn.dataset.dir = '-1';
    prevBtn.textContent = '‹';
    prevBtn.hidden = true;
    const chips = document.createElement('div');
    chips.className = 'sheet-sel-chips';
    chips.setAttribute('role', 'list');
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'sheet-sel-nav';
    nextBtn.dataset.dir = '1';
    nextBtn.textContent = '›';
    nextBtn.hidden = true;

    for (const sel of group.items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sheet-sel-chip';
      chip.setAttribute('role', 'listitem');
      chip.dataset.sheet = sel.sheet;
      chip.dataset.a1 = sel.a1;
      chip.title = `${sel.sheet}!${sel.a1}`;
      const label = document.createElement('span');
      label.className = 'sheet-sel-chip-label';
      label.textContent = sel.a1;
      chip.appendChild(label);
      const x = document.createElement('span');
      x.className = 'sheet-sel-chip-x';
      x.setAttribute('aria-label', t('sheetSelClear'));
      x.textContent = '×';
      chip.appendChild(x);
      pulseSheetSelChip(chip, sheetSelKey(sel), opts.pulseKeys);
      chip.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target)?.closest?.('.sheet-sel-chip-x')) {
          e.preventDefault();
          e.stopPropagation();
          void sheetSelRpc('dropSelection', { sheet: sel.sheet, a1: sel.a1 });
          sheetSelState.selections = list.filter((s) => sheetSelKey(s) !== sheetSelKey(sel));
          renderSheetSelRow();
          return;
        }
        void sheetSelRpc('focusRange', { sheet: sel.sheet, a1: sel.a1 });
      });
      chips.appendChild(chip);
    }

    const step = (dir) => {
      const delta = Math.max(48, Math.floor(chips.clientWidth * 0.75)) * dir;
      chips.scrollLeft += delta;
      updateSheetSelGroupOverflow(wrap);
    };
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    body.append(prevBtn, chips, nextBtn);
    wrap.append(toggle, body);
    host.appendChild(wrap);
    if (expanded) requestAnimationFrame(() => updateSheetSelGroupOverflow(wrap));
  }
  for (const name of [...sheetSelOpen.keys()]) {
    if (!live.has(name)) sheetSelOpen.delete(name);
  }
}

function canvasSelGroupsFrom(list) {
  const order = [];
  const byPlate = new Map();
  for (const sel of list || []) {
    const name = String(sel.plateId || sel.sheet || '');
    if (!byPlate.has(name)) {
      byPlate.set(name, []);
      order.push(name);
    }
    byPlate.get(name).push(sel);
  }
  return order.map((plate) => ({ plate, items: byPlate.get(plate) || [] }));
}

function renderCanvasSelRow(opts = {}) {
  lastSheetSelFp = sheetSelFingerprint(sheetSelState);
  hideSheetSelRow();
  const row = $('canvasSelRow');
  const host = $('canvasSelGroups');
  const clearBtn = $('canvasSelClear');
  if (!row || !host) return;
  const list = (sheetSelState.selections || []).filter((s) =>
    String(s.slotId || s.nodeId || '').trim()
  );
  host.replaceChildren();
  if (!list.length) {
    row.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    canvasSelOpen.clear();
    return;
  }
  const shell = canvasShellLabel(sheetSelState.kind);
  const siteKind = /^(site|web)$/i.test(String(sheetSelState.kind || ''));
  row.hidden = false;
  row.title =
    siteKind && list.length > 1
      ? t('siteSelCount').replace('{count}', String(list.length))
      : t('canvasSelHint');
  if (clearBtn) {
    clearBtn.hidden = false;
    clearBtn.textContent = t('canvasSelClear');
  }
  const groups = canvasSelGroupsFrom(list);
  const live = new Set();
  for (const group of groups) {
    live.add(group.plate);
    if (!canvasSelOpen.has(group.plate)) canvasSelOpen.set(group.plate, true);
    const expanded = canvasSelOpen.get(group.plate) !== false;
    const wrap = document.createElement('div');
    wrap.className = 'sheet-sel-group' + (expanded ? '' : ' is-collapsed');
    wrap.dataset.plate = group.plate;
    const groupName = groups.length === 1 ? shell : group.plate || shell;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sheet-sel-group-toggle';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.title = groupName;
    const caret = document.createElement('span');
    caret.className = 'sheet-sel-group-caret';
    caret.textContent = expanded ? '▾' : '▸';
    const nameEl = document.createElement('span');
    nameEl.className = 'sheet-sel-group-name';
    nameEl.textContent = groupName;
    const countEl = document.createElement('span');
    countEl.className = 'sheet-sel-group-count';
    countEl.textContent = String(group.items.length);
    toggle.append(caret, nameEl, countEl);
    toggle.addEventListener('click', () => {
      canvasSelOpen.set(group.plate, !expanded);
      renderCanvasSelRow();
    });

    const body = document.createElement('div');
    body.className = 'sheet-sel-group-body';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'sheet-sel-nav';
    prevBtn.dataset.dir = '-1';
    prevBtn.textContent = '‹';
    prevBtn.hidden = true;
    const chips = document.createElement('div');
    chips.className = 'sheet-sel-chips';
    chips.setAttribute('role', 'list');
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'sheet-sel-nav';
    nextBtn.dataset.dir = '1';
    nextBtn.textContent = '›';
    nextBtn.hidden = true;

    for (const sel of group.items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sheet-sel-chip';
      chip.setAttribute('role', 'listitem');
      chip.dataset.plateId = sel.plateId || '';
      chip.dataset.slotId = sel.slotId || '';
      const slotName = canvasSlotName(sel);
      chip.title = slotName;
      const glyph = document.createElement('span');
      glyph.className = 'canvas-sel-glyph';
      glyph.textContent = canvasSlotGlyph(sel);
      const label = document.createElement('span');
      label.className = 'sheet-sel-chip-label';
      label.textContent = slotName;
      chip.append(glyph, label);
      const x = document.createElement('span');
      x.className = 'sheet-sel-chip-x';
      x.setAttribute('aria-label', t('canvasSelClear'));
      x.textContent = '×';
      chip.appendChild(x);
      pulseSheetSelChip(chip, canvasSelKey(sel), opts.pulseKeys);
      chip.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target)?.closest?.('.sheet-sel-chip-x')) {
          e.preventDefault();
          e.stopPropagation();
          sheetSelState.selections = list.filter((s) => canvasSelKey(s) !== canvasSelKey(sel));
          const sid = getWorkspaceSessionId();
          uiState(sid).sheetSel = { ...sheetSelState, sessionId: sid };
          renderCanvasSelRow();
        }
      });
      chips.appendChild(chip);
    }

    const step = (dir) => {
      const delta = Math.max(48, Math.floor(chips.clientWidth * 0.75)) * dir;
      chips.scrollLeft += delta;
      updateSheetSelGroupOverflow(wrap);
    };
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    body.append(prevBtn, chips, nextBtn);
    wrap.append(toggle, body);
    host.appendChild(wrap);
    if (expanded) requestAnimationFrame(() => updateSheetSelGroupOverflow(wrap));
  }
  for (const name of [...canvasSelOpen.keys()]) {
    if (!live.has(name)) canvasSelOpen.delete(name);
  }
}

function updateSheetSelGroupOverflow(wrap) {
  if (!wrap || wrap.classList.contains('is-collapsed')) return;
  const chips = wrap.querySelector('.sheet-sel-chips');
  const prev = wrap.querySelector('.sheet-sel-nav[data-dir="-1"]');
  const next = wrap.querySelector('.sheet-sel-nav[data-dir="1"]');
  if (!chips || !prev || !next) return;
  const overflow = chips.scrollWidth > chips.clientWidth + 2;
  prev.hidden = !overflow;
  next.hidden = !overflow;
  prev.disabled = chips.scrollLeft <= 2;
  next.disabled = chips.scrollLeft + chips.clientWidth >= chips.scrollWidth - 2;
}

async function sheetSelRpc(method, extra = {}) {
  if (sheetSelIsCanvas()) return;
  const artifactId = String(sheetSelState.artifactId || '');
  if (!artifactId) return;
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'pawwork-background',
      action: 'sheet_host',
      sessionId: getWorkspaceSessionId(),
      artifactId,
      method,
      ...extra
    });
    const overview = res?.result?.overview || res?.overview;
    if (overview) {
      applySheetSelState({
        action: 'sheet_tab_state',
        sessionId: getWorkspaceSessionId(),
        artifactId,
        overview: { ...overview, artifactId }
      });
    }
    return res;
  } catch (err) {
    console.warn('[sheet-sel]', method, err);
  }
}

function artifactFolderUiLabel(folderId, shelf) {
  const custom = shelf?.labels?.[folderId];
  if (custom) return String(custom);
  const keys = {
    images: 'artifactFolderImages',
    design: 'artifactFolderDesign',
    slides: 'artifactFolderSlides',
    sheets: 'artifactFolderSheets',
    docs: 'artifactFolderDocs',
    sites: 'artifactFolderSites',
    files: 'artifactFolderFiles'
  };
  return keys[folderId] ? t(keys[folderId]) : shelfFolderLabel(folderId, currentLang === 'en' ? 'en' : 'zh', shelf?.labels);
}

function artifactFolderCollapsed(sessionId, folderId) {
  const key = `${sessionId}:${folderId}`;
  if (artifactRailCollapsed.has(key)) return artifactRailCollapsed.get(key);
  return folderCollapsedByDefault(folderId);
}

function renderArtifactShelfRow(a) {
  const li = document.createElement('li');
  li.className = 'artifact-shelf-item';
  li.dataset.artifactId = a.artifactId;
  li.setAttribute('role', 'listitem');
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'artifact-rail-check' + (selectedArtifactIds.has(a.artifactId) ? ' is-checked' : '');
  check.setAttribute('aria-pressed', selectedArtifactIds.has(a.artifactId) ? 'true' : 'false');
  check.setAttribute('aria-label', t('artifactSelectHint'));
  check.textContent = selectedArtifactIds.has(a.artifactId) ? '✓' : '';
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedArtifactIds.has(a.artifactId)) selectedArtifactIds.delete(a.artifactId);
    else selectedArtifactIds.add(a.artifactId);
    void refreshArtifactShelf();
  });
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'artifact-shelf-name';
  name.textContent = a.displayLabel || a.name || a.artifactId;
  name.title = a.primaryPath || a.name || t('artifactPreview');
  name.addEventListener('click', () => void previewSessionArtifact(a.artifactId));
  const actions = document.createElement('div');
  actions.className = 'artifact-shelf-actions';
  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'artifact-shelf-btn';
  dlBtn.textContent = '↓';
  dlBtn.title = t('artifactDownload');
  dlBtn.addEventListener('click', () => void downloadSessionArtifact(a.artifactId));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'artifact-shelf-btn artifact-shelf-btn-danger';
  delBtn.textContent = '×';
  delBtn.title = t('artifactDelete');
  delBtn.addEventListener('click', () => void deleteSessionArtifact(a.artifactId));
  actions.append(dlBtn, delBtn);
  li.append(check, name, actions);
  return li;
}

function renderArtifactShelfFolder(folder, sessionId, shelf) {
  const wrap = document.createElement('li');
  wrap.className = 'artifact-shelf-folder';
  wrap.dataset.folderId = folder.id;
  const collapsed = artifactFolderCollapsed(sessionId, folder.id);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'artifact-shelf-folder-toggle';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const chevron = document.createElement('span');
  chevron.textContent = collapsed ? '▸' : '▾';
  const title = document.createElement('span');
  title.textContent = artifactFolderUiLabel(folder.id, shelf);
  const count = document.createElement('span');
  count.className = 'artifact-shelf-folder-count';
  count.textContent = String(folder.items.length);
  toggle.append(chevron, title, count);
  const inner = document.createElement('ul');
  inner.className = 'artifact-shelf-folder-items';
  inner.hidden = collapsed;
  for (const a of folder.items) inner.appendChild(renderArtifactShelfRow(a));
  toggle.addEventListener('click', () => {
    artifactRailCollapsed.set(`${sessionId}:${folder.id}`, !collapsed);
    void refreshArtifactShelf();
  });
  wrap.append(toggle, inner);
  return wrap;
}

/**
 * T13 — Session artifact shelf: list / count / storage / preview / download / delete.
 * Bound to SessionWorkspaceService via workspaceRpc (not OPFS paths).
 */
async function refreshArtifactShelf() {
  const listEl = $('artifactShelfList');
  const countEl = $('artifactShelfCount');
  const emptyEl = $('sessionArtifactEmpty');
  const btn = $('sessionArtifactBtn');
  const root = $('sessionArtifactAdd');
  if (!listEl) return;
  try {
    const sessionId = getWorkspaceSessionId();
    const [arts, stats, sess] = await Promise.all([
      workspaceRpc('listArtifacts', { sessionId }),
      workspaceRpc('getStorageStats', { sessionId }).catch(() => null),
      workspaceRpc('getSession', { sessionId }).catch(() => null)
    ]);
    sessionArtifacts = Array.isArray(arts) ? arts : [];
    const live = new Set(sessionArtifacts.map((a) => a.artifactId));
    for (const id of [...selectedArtifactIds]) {
      if (!live.has(id)) selectedArtifactIds.delete(id);
    }
    const n = sessionArtifacts.length;
    if (root) root.hidden = false;
    if (countEl) {
      countEl.textContent = String(n);
      countEl.hidden = n === 0;
    }
    if (btn) btn.classList.toggle('has-items', n > 0);
    if (emptyEl) {
      emptyEl.hidden = n > 0;
      emptyEl.textContent = t('artifactEmpty');
    }
    lastWorkspaceStats = {
      bytes: Math.max(Number(stats?.blobBytes || 0), Number(stats?.artifactBytes || 0)),
      fileCount: Number(stats?.fileCount != null ? stats.fileCount : n) || 0
    };
    applyWorkspaceStatsToHeaders();
    listEl.innerHTML = '';
    const folders = buildShelfView(sessionArtifacts, sess?.shelf || null);
    const shelfMeta = sess?.shelf || null;
    const nav = $('artifactRailNav');
    if (nav) {
      nav.innerHTML = '';
      if (!folders.length) {
        nav.hidden = true;
      } else {
        nav.hidden = false;
        const chips = [{ id: 'all', label: t('artifactFolderAll'), n: 0 }, ...folders.map((f) => ({
          id: f.id,
          label: artifactFolderUiLabel(f.id, shelfMeta),
          n: f.items.length
        }))];
        if (artifactRailFilter !== 'all' && !folders.some((f) => f.id === artifactRailFilter)) {
          artifactRailFilter = 'all';
        }
        for (const chip of chips) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'artifact-rail-nav-chip' + (artifactRailFilter === chip.id ? ' is-on' : '');
          btn.textContent = chip.id === 'all' ? chip.label : `${chip.label} ${chip.n}`;
          btn.addEventListener('click', () => {
            artifactRailFilter = chip.id;
            if (chip.id !== 'all') {
              artifactRailCollapsed.set(`${sessionId}:${chip.id}`, false);
            }
            void refreshArtifactShelf();
          });
          nav.appendChild(btn);
        }
      }
    }
    const shown = artifactRailFilter === 'all' ? folders : folders.filter((f) => f.id === artifactRailFilter);
    for (const folder of shown) {
      listEl.appendChild(renderArtifactShelfFolder(folder, sessionId, shelfMeta));
    }
    const zipSel = $('artifactRailZipSelected');
    const any = selectedArtifactIds.size > 0;
    if (zipSel) zipSel.disabled = !any;
  } catch (err) {
    console.warn('[workspace] artifact shelf refresh failed', err);
    applyWorkspaceStatsToHeaders();
  }
}

function pulseArtifactBadge() {
  const countEl = $('artifactShelfCount');
  const btn = $('sessionArtifactBtn');
  countEl?.classList.remove('is-pulse');
  btn?.classList.remove('is-pulse');
  void countEl?.offsetWidth;
  countEl?.classList.add('is-pulse');
  btn?.classList.add('is-pulse');
  window.setTimeout(() => {
    countEl?.classList.remove('is-pulse');
    btn?.classList.remove('is-pulse');
  }, 900);
}

async function openArtifactPreviewIds(ids) {
  const artifactIds = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!artifactIds.length) {
    showQuickToast(currentLang === 'en' ? 'Select files first' : '请先勾选工作区文件');
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'open_artifact_preview',
      sessionId: getWorkspaceSessionId(),
      artifactIds,
      focus: true,
      reason: 'user',
      title: activeSessionName()
    });
    if (res && res.ok === false) {
      showQuickToast(res.message || (currentLang === 'en' ? 'Could not open preview' : '无法打开预览'));
    }
  } catch (err) {
    showQuickToast(err instanceof Error ? err.message : String(err));
  }
}

function previewSessionArtifact(artifactId) {
  return openArtifactPreviewIds([artifactId]);
}

async function zipSelectedArtifacts() {
  const ids = [...selectedArtifactIds];
  if (!ids.length) return;
  try {
    const files = [];
    for (const artifactId of ids) {
      const res = await workspaceRpc('readArtifact', {
        sessionId: getWorkspaceSessionId(),
        artifactId
      });
      const name = String(res?.artifact?.name || `${artifactId}.bin`).replace(/[\\/]/g, '_');
      const raw = decodeArtifactBase64(res?.base64);
      files.push({ name, data: raw.byteLength ? raw : new TextEncoder().encode(res?.content || '') });
    }
    const zip = buildZipStore(files);
    const blob = new Blob([zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'artifacts.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showQuickToast(err instanceof Error ? err.message : String(err));
  }
}

function escapeHtmlLite(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function decodeArtifactBase64(b64) {
  const s = String(b64 || '');
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function downloadSessionArtifact(artifactId) {
  try {
    const res = await workspaceRpc('readArtifact', {
      sessionId: getWorkspaceSessionId(),
      artifactId
    });
    const name = res?.artifact?.name || `${artifactId}.bin`;
    const mime = res?.mimeType || 'application/octet-stream';
    const raw = decodeArtifactBase64(res?.base64);
    const blob = raw.byteLength
      ? new Blob([raw], { type: mime })
      : new Blob([res?.content || ''], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showQuickToast(err instanceof Error ? err.message : String(err));
  }
}

async function deleteSessionArtifact(artifactId) {
  try {
    await workspaceRpc('deleteArtifact', {
      sessionId: getWorkspaceSessionId(),
      artifactId
    });
    await refreshArtifactShelf();
    showQuickToast(currentLang === 'en' ? 'Removed from workspace' : '已从工作区删除');
  } catch (err) {
    showQuickToast(err instanceof Error ? err.message : String(err));
  }
}

async function refreshWorkspaceGroupState() {
  const sid = getWorkspaceSessionId();
  try {
    // compact:false (service default) — items required for selection chips
    const state = await workspaceRpc('getWorkspaceState', {
      sessionId: sid,
      compact: false
    });
    if (getWorkspaceSessionId() !== sid) return;
    workspaceGroupState = state;
    applyWorkspaceExecutionSnapshot(sid, workspaceGroupState);
    renderWorkspaceGroupControls();
    const active = workspaceGroupState.groups?.find((g) => g.groupId === workspaceGroupState.activeGroupId);
    // Always mirror active group membership into selection chrome (empty group = empty chips, not "no group")
    if (workspaceGroupState.activeGroupId && active && !isClipboardGroup(active) && active.kind !== CLIPBOARD_GROUP_KIND) {
      selectedElementsSummary = Array.isArray(active.items)
        ? active.items.map((item, index) => ({ ...item, index }))
        : [];
      renderSelectionUI();
    } else if (!workspaceGroupState.activeGroupId) {
      // Capture target unset — don't wipe UI if user is mid-chat; only clear selection summary
      selectedElementsSummary = [];
      renderSelectionUI();
    }
    void refreshArtifactShelf();
    renderClipboardUI();
    renderQuickTools();
  } catch (error) {
    console.warn('[workspace] state refresh failed', error);
  }
}

/**
 * Top toolbar: active Group for capture (where new selections go).
 * Composer meta: one Group bubble opens an upward bind list (no stacking chips).
 */
function renderWorkspaceGroupControls() {
  const allGroups = Array.isArray(workspaceGroupState.groups) ? workspaceGroupState.groups : [];
  const groups = captureGroupsFromState();
  const bound = new Set(workspaceGroupState.boundGroupIds || []);
  // Active group is independent of whether it currently has items
  const activeId = workspaceGroupState.activeGroupId || null;
  const preferNone = !activeId;
  const activeGroup = groups.find((g) => g.groupId === activeId) || null;

  // Hidden native select mirror
  const activeSelect = $('activeGroupSelect');
  if (activeSelect) {
    activeSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = currentLang === 'en' ? 'No group' : '未选择组';
    none.selected = preferNone;
    activeSelect.appendChild(none);
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.groupId;
      option.textContent = `${group.name} (${group.itemCount || 0})`;
      option.selected = !preferNone && group.groupId === activeId;
      activeSelect.appendChild(option);
    }
  }

  // Custom Group Select trigger label
  const labelEl = $('groupSelectLabel');
  if (labelEl) {
    if (preferNone || !activeGroup) {
      labelEl.textContent = currentLang === 'en' ? 'No group' : '未选择组';
    } else {
      const n = activeGroup.itemCount || 0;
      labelEl.textContent = n > 0 ? `${activeGroup.name} · ${n}` : activeGroup.name;
    }
  }

  // Custom dropdown rows
  const list = $('groupSelectList');
  if (list) {
    list.innerHTML = '';
    // "No group" row
    const noneRow = document.createElement('button');
    noneRow.type = 'button';
    noneRow.className = 'group-select-item' + (preferNone ? ' is-active' : '');
    noneRow.setAttribute('role', 'option');
    noneRow.setAttribute('aria-selected', preferNone ? 'true' : 'false');
    noneRow.dataset.groupId = '';
    noneRow.innerHTML = `<span class="group-select-item-name">${currentLang === 'en' ? 'No group' : '未选择组'}</span>`;
    noneRow.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void selectActiveGroup('');
    });
    list.appendChild(noneRow);

    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'group-select-item' + (!preferNone && group.groupId === activeId ? ' is-active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', !preferNone && group.groupId === activeId ? 'true' : 'false');
      row.dataset.groupId = group.groupId;

      // Pencil rename — left of name (sketch-style control)
      const ren = document.createElement('button');
      ren.type = 'button';
      ren.className = 'group-select-item-rename';
      ren.title = currentLang === 'en' ? 'Rename group' : '重命名组';
      ren.setAttribute('aria-label', currentLang === 'en' ? `Rename ${group.name}` : `重命名 ${group.name}`);
      ren.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      ren.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void renameGroupById(group.groupId, group.name);
      });

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'group-select-item-main';
      main.innerHTML = `<span class="group-select-item-name">${escapeHtml(group.name)}</span><span class="group-select-item-count">${group.itemCount || 0}</span>`;
      main.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void selectActiveGroup(group.groupId);
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'group-select-item-del';
      del.title = currentLang === 'en' ? 'Delete group' : '删除组';
      del.setAttribute('aria-label', currentLang === 'en' ? `Delete ${group.name}` : `删除 ${group.name}`);
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteGroupById(group.groupId, group.name);
      });

      row.appendChild(ren);
      row.appendChild(main);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  // Bound groups live inside the upward Group list (no stacking chips)
  const boundChips = $('boundGroupsChips');
  if (boundChips) {
    boundChips.innerHTML = '';
    boundChips.hidden = true;
  }

  const bindBtn = $('sessionBindAddBtn');
  if (bindBtn) {
    const n = bound.size;
    bindBtn.textContent = n > 0 ? `${t('bindGroupLabel')} · ${n}` : t('bindGroupLabel');
    bindBtn.classList.toggle('has-bound', n > 0);
    bindBtn.title = t('bindGroupTitle');
  }
  syncBindGroupHint();

  const addMenu = $('sessionBindAddMenu');
  if (addMenu) {
    addMenu.innerHTML = '';
    const listEl = document.createElement('div');
    listEl.className = 'session-bind-add-list';
    listEl.setAttribute('role', 'listbox');
    if (!allGroups.length) {
      const empty = document.createElement('div');
      empty.className = 'session-bind-add-empty';
      empty.textContent = currentLang === 'en' ? 'No groups yet' : '还没有 Group';
      listEl.appendChild(empty);
    } else {
      const clip = allGroups.filter((g) => isClipboardGroup(g) || g.kind === CLIPBOARD_GROUP_KIND);
      const rest = allGroups.filter((g) => !isClipboardGroup(g) && g.kind !== CLIPBOARD_GROUP_KIND);
      const boundRest = rest.filter((g) => bound.has(g.groupId));
      const unboundRest = rest.filter((g) => !bound.has(g.groupId));
      for (const group of [...clip, ...boundRest, ...unboundRest]) {
        const isBound = bound.has(group.groupId);
        const isClip = isClipboardGroup(group) || group.kind === CLIPBOARD_GROUP_KIND;
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className =
          'session-bind-add-item' + (isBound ? ' is-bound' : '') + (isClip ? ' is-clipboard' : '');
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', isBound ? 'true' : 'false');
        const kicker = isClip
          ? `<span class="session-bind-kicker">${escapeHtml(t('clipboardGroupKicker'))}</span>`
          : '';
        opt.innerHTML = `<span class="session-bind-check" aria-hidden="true">${isBound ? '✓' : ''}</span><span>${escapeHtml(groupDisplayName(group))}</span>${kicker}<span class="session-bind-add-count">${group.itemCount || 0}</span>`;
        opt.addEventListener('click', async () => {
          const next = new Set(workspaceGroupState.boundGroupIds || []);
          if (next.has(group.groupId)) next.delete(group.groupId);
          else next.add(group.groupId);
          workspaceGroupState = await workspaceRpc('bindGroups', {
            sessionId: getWorkspaceSessionId(),
            groupIds: [...next]
          });
          renderWorkspaceGroupControls();
          setSessionBindMenuOpen(true);
        });
        listEl.appendChild(opt);
      }
    }
    addMenu.appendChild(listEl);
    if (!addMenu.hidden) {
      const anchor = $('sessionBindAddBtn');
      if (anchor) positionFloatingMenu(addMenu, anchor, { preferUp: true });
    }
  }

  const boundSelect = $('boundGroupsSelect');
  if (boundSelect) {
    boundSelect.innerHTML = '';
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.groupId;
      option.textContent = `${group.name} (${group.itemCount || 0})`;
      option.selected = bound.has(group.groupId);
      boundSelect.appendChild(option);
    }
  }
}

async function selectActiveGroup(groupId) {
  setGroupSelectOpen(false);
  const rec = (workspaceGroupState.groups || []).find((g) => g.groupId === groupId);
  if (rec && (isClipboardGroup(rec) || rec.kind === CLIPBOARD_GROUP_KIND)) return;
  if (!groupId) {
    workspaceGroupState = { ...workspaceGroupState, activeGroupId: null };
    selectedElementsSummary = [];
    renderWorkspaceGroupControls();
    renderSelectionUI();
    await loadActiveGroupOntoPage();
    return;
  }
  await workspaceRpc('setActiveGroup', { groupId, sessionId: getWorkspaceSessionId() });
  await refreshWorkspaceGroupState();
  await loadActiveGroupOntoPage();
}

function existingGroupNames(excludeGroupId) {
  const skip = excludeGroupId ? String(excludeGroupId) : '';
  return captureGroupsFromState()
    .filter((g) => !skip || String(g.groupId) !== skip)
    .map((g) => g.name);
}

function groupNameConflict(name, excludeGroupId) {
  const key = groupNameKey(name);
  if (!key) return t('groupNameEmpty');
  if (key === 'clipboard' || key === '剪切板') return t('groupNameTaken');
  const taken = existingGroupNames(excludeGroupId).some((n) => groupNameKey(n) === key);
  return taken ? t('groupNameTaken') : null;
}

async function createCaptureGroup() {
  try {
    await refreshWorkspaceGroupState();
  } catch (_) {
    /* use last snapshot */
  }
  const defaultName = nextGroupName(existingGroupNames());
  const name = await promptInApp(
    currentLang === 'en' ? 'New group name' : '新建 Group 名称',
    defaultName,
    defaultName,
    (val) => groupNameConflict(val)
  );
  if (!name) return;
  try {
    // Capture-target group only — session bind is explicit under the dialog
    workspaceGroupState = await workspaceRpc('createGroup', {
      name,
      sessionId: getWorkspaceSessionId(),
      bind: false
    });
  } catch (err) {
    showSidepanelToast(
      /DUPLICATE_GROUP_NAME/i.test(String(err?.message || err))
        ? t('groupNameTaken')
        : err?.message || String(err),
      { error: true }
    );
    return;
  }
  setGroupSelectOpen(false);
  renderWorkspaceGroupControls();
  await refreshWorkspaceGroupState();
  await loadActiveGroupOntoPage();
}

async function renameGroupById(groupId, currentName) {
  if (!groupId) return;
  const name = await promptInApp(
    currentLang === 'en' ? 'Rename group' : '重命名 Group',
    currentName || '',
    currentName || '',
    (val) => groupNameConflict(val, groupId)
  );
  if (!name || !String(name).trim()) return;
  if (groupNameKey(name) === groupNameKey(currentName)) return;
  try {
    workspaceGroupState = await workspaceRpc('renameGroup', {
      groupId,
      name: String(name).trim(),
      sessionId: getWorkspaceSessionId()
    });
  } catch (err) {
    showSidepanelToast(
      /DUPLICATE_GROUP_NAME/i.test(String(err?.message || err))
        ? t('groupNameTaken')
        : /GROUP_NAME_REQUIRED/i.test(String(err?.message || err))
          ? t('groupNameEmpty')
          : err?.message || String(err),
      { error: true }
    );
    return;
  }
  // Keep menu open so user can continue editing groups
  renderWorkspaceGroupControls();
  await refreshWorkspaceGroupState();
  // Re-open menu if render closed it
  const menu = $('groupSelectMenu');
  if (menu?.hidden) setGroupSelectOpen(true);
}

async function deleteGroupById(groupId, name) {
  if (!groupId) return;
  const rec = (workspaceGroupState.groups || []).find((g) => g.groupId === groupId);
  if (rec && (isClipboardGroup(rec) || rec.kind === CLIPBOARD_GROUP_KIND)) return;
  const ok = await confirmInApp(
    currentLang === 'en'
      ? `Delete group “${name || groupId}”? This cannot be undone.`
      : `删除 Group「${name || groupId}」？此操作无法撤销。`,
    currentLang === 'en' ? 'Delete group' : '删除 Group',
    { danger: true }
  );
  if (!ok) return;
  setGroupSelectOpen(false);
  workspaceGroupState = await workspaceRpc('deleteGroup', {
    groupId,
    sessionId: getWorkspaceSessionId()
  });
  renderWorkspaceGroupControls();
  await refreshWorkspaceGroupState();
}

function positionFloatingMenu(menu, anchor, opts = {}) {
  if (!menu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menuW = Math.max(rect.width, 180);
  let left = rect.left;
  const preferUp = !!opts.preferUp;
  let top = preferUp ? Math.max(8, rect.top - 8) : rect.bottom + 6;
  const maxLeft = Math.max(8, window.innerWidth - menuW - 8);
  left = Math.min(Math.max(8, left), maxLeft);
  menu.style.position = 'fixed';
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.minWidth = `${menuW}px`;
  menu.style.zIndex = '10050';
  if (preferUp) {
    menu.style.maxHeight = `${Math.min(280, Math.max(96, rect.top - 16))}px`;
  }
  requestAnimationFrame(() => {
    const m = menu.getBoundingClientRect();
    if (preferUp || m.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - m.height - 6)}px`;
    }
  });
}

function setGroupSelectOpen(open) {
  const menu = $('groupSelectMenu');
  const trigger = $('groupSelectTrigger');
  const root = $('groupSelect');
  if (!menu || !trigger) return;
  const next = !!open;
  menu.hidden = !next;
  trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
  root?.classList.toggle('is-open', next);
  if (next) {
    setSessionBindMenuOpen(false);
    setModelSelectOpen(false);
    setArtifactRailOpen(false);
    setThinkEffortOpen(false);
    // Escape scroll clipping of #panelScroll / selection-bar
    if (menu.parentElement !== document.body) {
      document.body.appendChild(menu);
    }
    positionFloatingMenu(menu, trigger);
  } else if (menu.parentElement === document.body && root) {
    root.appendChild(menu);
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.minWidth = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
  }
}

function setSessionBindMenuOpen(open) {
  const menu = $('sessionBindAddMenu');
  const btn = $('sessionBindAddBtn');
  const root = $('sessionBindAdd');
  if (!menu || !btn) return;
  const next = !!open;
  menu.hidden = !next;
  btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  root?.classList.toggle('is-open', next);
  if (next) {
    setGroupSelectOpen(false);
    setModelSelectOpen(false);
    setArtifactRailOpen(false);
    setThinkEffortOpen(false);
    closeMentionPalette();
    if (menu.parentElement !== document.body) {
      document.body.appendChild(menu);
    }
    positionFloatingMenu(menu, btn, { preferUp: true });
  } else if (menu.parentElement === document.body && root) {
    root.appendChild(menu);
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.minWidth = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
  }
}

function setArtifactRailOpen(open) {
  const panel = $('panel');
  const rail = $('artifactRail');
  const scrim = $('artifactRailScrim');
  const btn = $('sessionArtifactBtn');
  if (!panel || !rail) return;
  const next = !!open;
  panel.classList.toggle('artifact-rail-open', next);
  setAriaRegionOpen(rail, next, btn);
  if (scrim) scrim.hidden = !next;
  if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) {
    setSessionRailOpen(false);
    setGroupSelectOpen(false);
    setModelSelectOpen(false);
    setSessionBindMenuOpen(false);
    setThinkEffortOpen(false);
    void refreshArtifactShelf();
  }
}

async function createBlankArtifactAndOpen(kind) {
  const sessionId = getWorkspaceSessionId();
  const buttons = document.querySelectorAll('[data-blank-kind]');
  for (const el of buttons) el.disabled = true;
  try {
    const res = await workspaceRpc('createBlankArtifact', { sessionId, kind });
    const artifactId = String(res?.artifact?.artifactId || '');
    await refreshArtifactShelf();
    pulseArtifactBadge();
    if (artifactId) await openArtifactPreviewIds([artifactId]);
  } catch (err) {
    showQuickToast(err instanceof Error ? err.message : String(err));
  } finally {
    for (const el of buttons) el.disabled = false;
  }
}

function wireArtifactMenu() {
  const btn = $('sessionArtifactBtn');
  const scrim = $('artifactRailScrim');
  const closeBtn = $('artifactRailCloseBtn');
  const zipSel = $('artifactRailZipSelected');
  const toggle = (e) => {
    e.stopPropagation();
    const rail = $('artifactRail');
    setArtifactRailOpen(!!rail?.hidden);
  };
  btn?.addEventListener('click', toggle);
  closeBtn?.addEventListener('click', () => setArtifactRailOpen(false));
  scrim?.addEventListener('click', () => setArtifactRailOpen(false));
  zipSel?.addEventListener('click', () => void zipSelectedArtifacts());
  document.querySelectorAll('[data-blank-kind]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      void createBlankArtifactAndOpen(el.getAttribute('data-blank-kind'));
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('panel')?.classList.contains('artifact-rail-open')) {
      setArtifactRailOpen(false);
    }
  });
}

async function applyPageAddState(state) {
  const pageAdd = state?.pageAdd || {};
  if (pageAdd.focusedId) focusedPageItemId = pageAdd.focusedId;
  workspaceGroupState = state;
  renderWorkspaceGroupControls();
  const active = workspaceGroupState.groups?.find((g) => g.groupId === workspaceGroupState.activeGroupId);
  if (workspaceGroupState.activeGroupId && active && !isClipboardGroup(active) && active.kind !== CLIPBOARD_GROUP_KIND) {
    selectedElementsSummary = Array.isArray(active.items)
      ? active.items.map((item, index) => ({ ...item, index }))
      : [];
  }
  renderSelectionUI();
  if (pageAdd.notice) showQuickToast(pageAdd.notice);
  else if (pageAdd.summary) showQuickToast(pageAdd.summary);
}

async function addUrlsToActiveGroup(payload) {
  const state = await workspaceRpc('addPageItems', {
    sessionId: getWorkspaceSessionId(),
    groupId: workspaceGroupState.activeGroupId || undefined,
    ...payload
  });
  await applyPageAddState(state);
  return state;
}

function wireGroupSelectUi() {
  const trigger = $('groupSelectTrigger');
  const createBtn = $('groupSelectCreate');
  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('groupSelectMenu');
      setGroupSelectOpen(!!menu?.hidden);
    });
  }
  // create button is re-bound each render if innerHTML wiped — wire via delegation
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t?.id === 'groupSelectCreate' || t?.closest?.('#groupSelectCreate')) {
      e.preventDefault();
      e.stopPropagation();
      void createCaptureGroup();
      return;
    }
    const root = $('groupSelect');
    const menu = $('groupSelectMenu');
    const inTrigger = root?.contains(e.target);
    const inMenu = menu && !menu.hidden && menu.contains(e.target);
    if (!inTrigger && !inMenu) setGroupSelectOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setGroupSelectOpen(false);
  });
  // Reposition while open (scroll / resize)
  window.addEventListener(
    'resize',
    () => {
      const menu = $('groupSelectMenu');
      const trigger = $('groupSelectTrigger');
      if (menu && !menu.hidden && trigger) positionFloatingMenu(menu, trigger);
      const bindMenu = $('sessionBindAddMenu');
      const bindBtn = $('sessionBindAddBtn');
      if (bindMenu && !bindMenu.hidden && bindBtn) {
        positionFloatingMenu(bindMenu, bindBtn, { preferUp: true });
      }
      const modelMenu = $('modelSelectMenu');
      const modelBtn = $('modelSelectTrigger');
      if (modelMenu && !modelMenu.hidden && modelBtn) {
        positionFloatingMenu(modelMenu, modelBtn, { preferUp: true });
      }
      const modelSub = $('modelSelectSubmenu');
      if (modelSub && !modelSub.hidden && modelBtn) {
        positionFloatingMenu(modelSub, modelBtn, { preferUp: true });
      }
      placeBindGroupHint();
    },
    { passive: true }
  );
}

const bindHintDismissed = new Set();

function loadBindHintDismissed() {
  try {
    chrome.storage.local.get(['pagewand_bind_hint_dismissed'], (r) => {
      const o = r?.pagewand_bind_hint_dismissed || {};
      for (const k of Object.keys(o)) {
        if (o[k]) bindHintDismissed.add(k);
      }
      syncBindGroupHint();
    });
  } catch (_) {
    syncBindGroupHint();
  }
}

function persistBindHintDismissed() {
  const o = {};
  for (const id of bindHintDismissed) o[id] = true;
  try {
    chrome.storage.local.set({ pagewand_bind_hint_dismissed: o });
  } catch (_) {}
}

function mountBindGroupHint() {
  const hint = $('bindGroupHint');
  const host = $('sessionBindAdd');
  if (!hint || !host) return;
  if (hint.parentElement !== host) host.appendChild(hint);
  hint.style.left = '';
  hint.style.top = '';
}

function placeBindGroupHint() {
  mountBindGroupHint();
}

function syncBindGroupHint() {
  const hint = $('bindGroupHint');
  if (!hint) return;
  const panel = $('panel') || document.querySelector('.panel');
  const composer = document.querySelector('footer.composer') || document.querySelector('.composer');
  const atHome = !!panel?.classList.contains('is-home-empty');
  const sid = getWorkspaceSessionId();
  const n = (workspaceGroupState.boundGroupIds || []).length;
  if (n > 0) {
    if (bindHintDismissed.has(sid)) {
      bindHintDismissed.delete(sid);
      persistBindHintDismissed();
    }
    hint.hidden = true;
    composer?.classList.remove('has-bind-hint');
    return;
  }
  if (atHome) {
    hint.hidden = true;
    composer?.classList.remove('has-bind-hint');
    return;
  }
  hint.hidden = bindHintDismissed.has(sid);
  if (!hint.hidden) {
    mountBindGroupHint();
    composer?.classList.add('has-bind-hint');
  } else {
    composer?.classList.remove('has-bind-hint');
  }
}

function dismissBindGroupHint() {
  bindHintDismissed.add(getWorkspaceSessionId());
  persistBindHintDismissed();
  syncBindGroupHint();
}

function wireSessionContextBar() {
  $('bindGroupHintClose')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissBindGroupHint();
  });
  loadBindHintDismissed();
  const addBtn = $('sessionBindAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('sessionBindAddMenu');
      setSessionBindMenuOpen(!!menu?.hidden);
    });
  }
  document.addEventListener('click', (e) => {
    const root = $('sessionBindAdd');
    const menu = $('sessionBindAddMenu');
    const inBtn = root?.contains(e.target);
    const inMenu = menu && !menu.hidden && menu.contains(e.target);
    if (!inBtn && !inMenu) setSessionBindMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSessionBindMenuOpen(false);
  });
}

async function syncTabSelectionToWorkspace(request, sender) {
  const tabId = sender?.tab?.id ?? request?.tabId;
  if (tabId == null) return;
  const url = request?.url || sender?.tab?.url || '';
  let origin = '';
  try { origin = url ? new URL(url).origin : ''; } catch {}
  try {
    workspaceGroupState = await workspaceRpc('syncTabSelection', {
      sessionId: getWorkspaceSessionId(),
      tabId,
      url,
      origin,
      pageTitle: request?.pageTitle || sender?.tab?.title || '',
      elements: Array.isArray(request?.elements) ? request.elements : [],
      cleared: request?.cleared === true
    });
    renderWorkspaceGroupControls();
    const active = workspaceGroupState.groups?.find((g) => g.groupId === workspaceGroupState.activeGroupId);
    const items = Array.isArray(active?.items) ? active.items : [];
    selectedElementsSummary = items.map((item, index) => ({ ...item, index }));
    renderSelectionUI();
    if (tabId != null && items.length) void pushSelectionLabelsToTab(tabId, items);
  } catch (error) {
    console.warn('[workspace] selection sync failed', error);
  }
}

function selectionDisplayLabel(item) {
  const kind = item?.labelKind || classifyLabelKind(item);
  const n = Math.floor(Number(item?.labelN) || 0);
  if (n > 0 && kind) return formatItemLabel(kind, n, itemLabelLang());
  return '';
}

function pageLabelPayload(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      selector: it.selector || it.locator?.css || '',
      src: it.src || it.preview?.src || '',
      displayLabel: selectionDisplayLabel(it),
      labelKind: it.labelKind || '',
      labelN: it.labelN || 0
    }))
    .filter((l) => l.displayLabel);
}

async function pushSelectionLabelsToTab(tabId, items) {
  if (tabId == null) return;
  const labels = pageLabelPayload(items);
  if (!labels.length) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'apply_selection_labels', labels });
  } catch (_) {}
}

function pageItemsForActiveGroup(tabId, pageUrl, state = workspaceGroupState) {
  const gid = state?.activeGroupId;
  const group = (state?.groups || []).find((g) => g.groupId === gid);
  if (isClipboardGroup(group) || group?.kind === CLIPBOARD_GROUP_KIND) {
    return { group, items: [] };
  }
  const items = [];
  for (const it of group?.items || []) {
    const itemUrl = it.url || it.source?.url || '';
    const itemTab = it.tabId ?? it.source?.tabId;
    if (it.labelKind === 'page' || it.kindHint === 'page' || it.kind === 'page' || it.addedBy) {
      continue;
    }
    const sameTab = itemTab != null && String(itemTab) === String(tabId);
    const sameView = itemUrl && pageUrl && pageViewsMatch(itemUrl, pageUrl);
    if (!sameTab && !sameView) continue;
    items.push({
      selector: it.selector || it.locator?.css || '',
      src: it.src || it.preview?.src || '',
      text: it.text || it.preview?.textSnippet || '',
      tag: it.preview?.tagName || it.tag || it.kindHint || '',
      displayLabel: selectionDisplayLabel(it),
      labelKind: it.labelKind || '',
      labelN: it.labelN || 0
    });
  }
  return { group, items };
}

/**
 * Page picker store = active capture group only.
 * Switching/creating a group must replace leftovers, never merge group1 into group2.
 */
async function loadActiveGroupOntoPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    if (isUnscriptableTabUrl(tab.url || tab.pendingUrl || '')) return;
    const injected = await ensureContentScriptActive(tab.id);
    if (!injected) return;
    const { group, items } = pageItemsForActiveGroup(tab.id, tab.url || '');
    await chrome.tabs.sendMessage(tab.id, {
      action: 'restore_selection',
      items,
      replace: true,
      silent: true
    });
    if (tab.id != null) {
      if (items.length) {
        let domain = '网页';
        try {
          domain = tab.url ? new URL(tab.url).hostname : domain;
        } catch (_) {}
        crossTabStore.set(tab.id, {
          tabId: tab.id,
          domain,
          pageTitle: tab.title || '',
          elements: items.map((el) => ({
            selector: el.selector,
            tag: el.tag,
            text: el.text || '',
            src: el.src || ''
          }))
        });
      } else {
        crossTabStore.delete(tab.id);
      }
    }
    void pushSelectionLabelsToTab(tab.id, group?.items || []);
  } catch (err) {
    console.debug('[selection] load active group onto page skipped', err?.message || err);
  }
}

/* ===== selection bridge ===== */
function isUnscriptableTabUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  if (/^(chrome|chrome-extension|chrome-error|edge|about|devtools|view-source):/i.test(u)) return true;
  if (/chromewebstore\.google\.com/i.test(u) || /chrome\.google\.com\/webstore/i.test(u)) return true;
  return false;
}

function isUnscriptableInjectError(err) {
  const msg = String(err?.message || err || '');
  return /Cannot access a chrome:\/\/ URL|cannot be scripted|The extensions gallery cannot be scripted|Extension context invalidated|Cannot access contents of the url|Frame with ID \d+ was removed/i.test(
    msg
  );
}

async function restoreBoundHighlightsToTab(tabId, pageUrl) {
  if (tabId == null) return false;
  let url = String(pageUrl || '');
  try {
    const tab = await chrome.tabs.get(tabId);
    url = url || tab?.url || tab?.pendingUrl || '';
  } catch (err) {
    if (isUnscriptableInjectError(err)) return false;
  }
  if (isUnscriptableTabUrl(url)) return false;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const state = await workspaceRpc('getWorkspaceState', {
        sessionId: getWorkspaceSessionId(),
        compact: false
      });
      workspaceGroupState = state;
      const { items } = pageItemsForActiveGroup(tabId, url, state);
      const injected = await ensureContentScriptActive(tabId);
      if (!injected) return false;
      const res = await chrome.tabs.sendMessage(tabId, {
        action: 'restore_selection',
        items,
        replace: true,
        silent: true
      });
      void pushSelectionLabelsToTab(tabId, items);
      return (res?.added || 0) > 0 || (res?.count || 0) > 0 || items.length === 0;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '');
      if (isUnscriptableInjectError(err) || isUnscriptableTabUrl(url)) return false;
      const transient =
        /offscreen not ready|Receiving end|establish connection|message port closed|unavailable|context invalidated|RPC result is unknown|RPC_OUTCOME_UNKNOWN/i.test(
          msg
        );
      if (!transient || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  if (lastErr) {
    const msg = String(lastErr?.message || lastErr || '');
    if (
      isUnscriptableInjectError(lastErr) ||
      /offscreen not ready|Receiving end|establish connection|message port closed|Cannot access a chrome|RPC result is unknown|RPC_OUTCOME_UNKNOWN/i.test(msg)
    ) {
      console.debug('[selection] restore bound highlights skipped', msg);
    } else {
      console.warn('[selection] restore bound highlights failed', lastErr);
    }
  }
  return false;
}

function handleElementsUpdatedMessage(request, sender) {
  const tabId = (sender && sender.tab) ? sender.tab.id : null;
  const incoming = Array.isArray(request.elements) ? request.elements : [];
  const leftoverText = incoming.filter((el) => isClipboardTextPick(el));
  const captureEls = incoming.filter((el) => !isClipboardTextPick(el));
  if (leftoverText.length) {
    pinTextsToClipboard(
      leftoverText.map((el) => ({ text: String(el.text || ''), kind: 'text' })),
      { openDrawer: true, toast: false }
    );
  }
  const empty = !request.count || request.count === 0;
  if (empty && request.cleared !== true && tabId != null) {
    void restoreBoundHighlightsToTab(tabId, request.url || sender?.tab?.url || '').then((ok) => {
      if (!ok) {
        /* keep workspace items; do not sync empty wipe */
        renderWorkspaceGroupControls();
      }
    });
    if (tabId != null) crossTabStore.delete(tabId);
    renderCrossTabElementsUI();
    return;
  }
  void syncTabSelectionToWorkspace(request, sender);
  const domain = request.domain || ((sender && sender.tab && sender.tab.url) ? new URL(sender.tab.url).hostname : '网页');
  const pageTitle = request.pageTitle || ((sender && sender.tab) ? sender.tab.title : '');
  if (!request.count || request.count === 0 || !captureEls.length) {
    if (tabId != null) crossTabStore.delete(tabId);
  } else {
    crossTabStore.set(tabId, {
      tabId, domain, pageTitle, elements: captureEls
    });
  }
  renderCrossTabElementsUI();
}

function getFlattenedCrossTabElements() {
  const flattened = [];
  for (const [tabId, data] of crossTabStore.entries()) {
    if (data.elements && data.elements.length > 0) {
      data.elements.forEach((item, localIdx) => {
        flattened.push({
          ...item,
          tabId: data.tabId,
          domain: data.domain,
          pageTitle: data.pageTitle,
          localIndex: localIdx
        });
      });
    }
  }
  return flattened;
}

function normalizeSelectionForAgent(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  return elements.map((el, i) => {
    const tag = String(el?.tag || el?.tagName || '').toLowerCase().replace(/[<>]/g, '');
    const text = String(el?.text || el?.textContent || '').trim();
    const src = String(el?.src || el?.url || el?.href || '').trim();
    const selector = String(el?.selector || '').trim();
    const out = { index: typeof el?.index === 'number' ? el.index : i, tag, selector, text, src };
    if (el?.tabId != null) out.tabId = el.tabId;
    if (el?.domain) out.domain = el.domain;
    return out;
  });
}

async function refreshSelectedElementsFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return selectedElementsSummary;
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
      return selectedElementsSummary;
    }
    await ensureContentScriptActive(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'agent_get_selection' });
    if (!res || !Array.isArray(res.elements)) return selectedElementsSummary;
    let domain = '网页';
    try { domain = tab.url ? new URL(tab.url).hostname : domain; } catch (_) {}
    if (!res.count || res.elements.length === 0) {
      crossTabStore.delete(tab.id);
    } else {
      crossTabStore.set(tab.id, {
        tabId: tab.id,
        domain,
        pageTitle: tab.title || '',
        elements: res.elements.map((el) => ({
          selector: el.selector, tag: el.tag, text: el.text || '', src: el.src || ''
        }))
      });
    }
    renderCrossTabElementsUI();
    await syncTabSelectionToWorkspace({
      pageTitle: tab.title || '',
      elements: res.elements || [],
      count: res.count || 0
    }, { tab });
  } catch (e) {
    console.log('Selection refresh omitted:', e?.message || e);
  }
  return selectedElementsSummary;
}

async function syncSelectionUiAfterAgentSelect(resultRaw) {
  try {
    await refreshSelectedElementsFromActiveTab();
    let parsed = resultRaw;
    if (typeof resultRaw === 'string') {
      try { parsed = JSON.parse(resultRaw); } catch (_) { return selectedElementsSummary; }
    }
    if (!parsed || typeof parsed !== 'object') return selectedElementsSummary;
    if (parsed.status && parsed.status !== 'ok') return selectedElementsSummary;
    const toolElements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const toolCount = typeof parsed.count === 'number' ? parsed.count : toolElements.length;
    if (selectedElementsSummary.length > 0 || toolCount === 0) return selectedElementsSummary;
    if (toolElements.length === 0) return selectedElementsSummary;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return selectedElementsSummary;
    let domain = '网页';
    try { domain = tab.url ? new URL(tab.url).hostname : domain; } catch (_) {}
    crossTabStore.set(tab.id, {
      tabId: tab.id, domain, pageTitle: tab.title || '',
      elements: toolElements.map((el) => ({
        selector: el.selector, tag: el.tag, text: el.text || '', src: el.src || ''
      }))
    });
    renderCrossTabElementsUI();
  } catch (e) {
    console.log('A2 selection UI sync omitted:', e?.message || e);
  }
  return selectedElementsSummary;
}


function confirmInApp(message, title, opts = {}) {
  return new Promise((resolve) => {
    showCustomModal({
      mode: 'confirm',
      title: title || (currentLang === 'en' ? 'Confirm' : '请确认'),
      message,
      danger: !!opts.danger,
      confirmLabel: opts.confirmLabel || (opts.danger
        ? (currentLang === 'en' ? 'Delete' : '删除')
        : ''),
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    });
  });
}

function promptInApp(title, initialValue, placeholder, validate) {
  return new Promise((resolve) => {
    showCustomModal({
      mode: 'prompt',
      title,
      initialValue,
      placeholder,
      validate,
      onConfirm: (val) => resolve(val || null),
      onCancel: () => resolve(null)
    });
  });
}

function showCustomModal({
  title,
  placeholder,
  initialValue,
  message,
  mode,
  danger,
  confirmLabel,
  cancelLabel,
  validate,
  onConfirm,
  onCancel
}) {
  /** @type {HTMLDialogElement|null} */
  const overlay = /** @type {HTMLDialogElement|null} */ (
    document.getElementById('appModalOverlay')
  );
  const titleEl = document.getElementById('modalTitle');
  const inputEl = document.getElementById('modalInput');
  const messageEl = document.getElementById('modalMessage');
  const closeBtn = document.getElementById('modalCloseBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const confirmBtn = document.getElementById('modalConfirmBtn');

  if (!overlay || !titleEl || !inputEl || !confirmBtn || !cancelBtn) {
    console.warn('[PageWand] app modal missing');
    return;
  }

  const isConfirm = mode === 'confirm';
  titleEl.innerText = title || (currentLang === 'en' ? 'Confirm' : '请确认');
  inputEl.placeholder = placeholder || '';
  inputEl.value = initialValue || '';
  inputEl.hidden = isConfirm;
  inputEl.tabIndex = isConfirm ? -1 : 0;
  if (messageEl) {
    messageEl.hidden = !message;
    messageEl.textContent = message || '';
  }
  overlay.classList.toggle('is-confirm', isConfirm);
  overlay.classList.toggle('is-danger', !!danger);
  if (isConfirm && message) overlay.setAttribute('aria-describedby', 'modalMessage');
  else overlay.removeAttribute('aria-describedby');
  confirmBtn.classList.toggle('btn-danger', !!danger);
  confirmBtn.classList.toggle('btn-primary', !danger);
  confirmBtn.textContent =
    confirmLabel || (currentLang === 'en' ? 'Confirm' : '确认');
  cancelBtn.textContent = cancelLabel || (currentLang === 'en' ? 'Cancel' : '取消');

  let settled = false;

  const cleanup = () => {
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', handleCancel);
    closeBtn?.removeEventListener('click', handleCancel);
    inputEl.removeEventListener('keydown', handleKeyDown);
    overlay.removeEventListener('cancel', handleDialogCancel);
    overlay.removeEventListener('close', handleDialogClose);
  };

  const handleConfirm = () => {
    if (settled) return;
    const val = isConfirm ? true : inputEl.value.trim();
    if (!isConfirm && typeof validate === 'function') {
      let err = null;
      try {
        err = validate(val);
      } catch (e) {
        err = e?.message || String(e);
      }
      if (err) {
        showSidepanelToast(String(err), { error: true });
        inputEl.focus();
        inputEl.select?.();
        return;
      }
    }
    settled = true;
    if (onConfirm) onConfirm(val);
    cleanup();
    if (overlay.open) closeDialog(overlay);
  };

  const handleCancel = () => {
    if (!settled && onCancel) {
      settled = true;
      onCancel();
    } else {
      settled = true;
    }
    cleanup();
    if (overlay.open) closeDialog(overlay);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  const handleDialogCancel = (e) => {
    // Esc — settle as cancel then allow close
    e.preventDefault();
    handleCancel();
  };

  const handleDialogClose = () => {
    if (!settled) {
      settled = true;
      if (onCancel) onCancel();
    }
    cleanup();
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', handleCancel);
  closeBtn?.addEventListener('click', handleCancel);
  inputEl.addEventListener('keydown', handleKeyDown);
  overlay.addEventListener('cancel', handleDialogCancel);
  overlay.addEventListener('close', handleDialogClose);

  if (!overlay.dataset.pwBackdropBound) {
    overlay.dataset.pwBackdropBound = '1';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && overlay.open) {
        document.getElementById('modalCancelBtn')?.click();
      }
    });
  }

  openDialog(overlay, { focus: isConfirm ? confirmBtn : inputEl });
}

/* ===== PART: content_ensure ===== */

/* Dynamic Content Script Injection Safeguard */
async function ensureContentScriptActive(tabId) {
  if (tabId == null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isUnscriptableTabUrl(tab?.url || tab?.pendingUrl || '')) return false;
  } catch (err) {
    if (isUnscriptableInjectError(err)) return false;
    return false;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (e) {
    if (isUnscriptableInjectError(e)) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content_script.js']
      });
      await new Promise((r) => setTimeout(r, 100));
      return true;
    } catch (err) {
      if (isUnscriptableInjectError(err) || /Cannot access a chrome:\/\//i.test(String(err?.message || err))) {
        return false;
      }
      console.debug('[PageWand] content script inject skipped', err?.message || err);
      return false;
    }
  }
}

/* Storage Quota Safeguard: Max 15 Sessions */
function loadPersistentSessions() {
  // Audit C-6: Runtime is durable SoT; chrome.storage is UI cache only.
  chrome.storage.local.get(
    ['pagewand_session_ui_cache', 'pagewand_sessions', 'pagewand_active_session_id'],
    async (result) => {
      const cached = result.pagewand_session_ui_cache || result.pagewand_sessions || [];
      if (Array.isArray(cached) && cached.length > 0) {
        sessions = cached;
      }
      if (result.pagewand_active_session_id) {
        activeSessionId = result.pagewand_active_session_id;
      }
      try {
        const remote = await workspaceRpc('listSessions', {});
        if (Array.isArray(remote) && remote.length) {
          /** @type {Map<string, any>} */
          const byId = new Map();
          for (const r of remote) {
            const id = r.sessionId || r.id;
            if (!id) continue;
            let messages = [];
            let contextUsage = null;
            try {
              const full = await workspaceRpc('getSession', { sessionId: id });
              if (Array.isArray(full?.messages)) {
                messages = full.messages.map((m) => ({
                  role: m.role,
                  content: m.content,
                  thought: m.thought || '',
                  ts: m.createdAt || m.ts || Date.now()
                }));
              }
              contextUsage = full?.contextUsage || null;
              applyWorkspaceExecutionSnapshot(id, full);
            } catch {
              const hit = cached.find((s) => s.id === id);
              messages = hit?.messages || [];
              contextUsage = hit?.contextUsage || null;
            }
            byId.set(id, {
              id,
              name: r.title || r.name || id,
              titleLocked: !!(full?.titleLocked || r.titleLocked),
              messages,
              contextUsage
            });
          }
          // Keep pure UI-only sessions not yet on runtime only if no remote
          sessions = [...byId.values()];
          if (!sessions.some((s) => s.id === activeSessionId) && sessions[0]) {
            activeSessionId = sessions[0].id;
          }
        }
      } catch {
        /* service not ready — temporary cache */
      }
      renderSessionDropdown();
      renderActiveSessionMessages();
      const active = sessions.find((s) => s.id === activeSessionId);
      applyContextUsage(active?.contextUsage || {});
    }
  );
}

/**
 * UI projection cache only (audit C-6).
 * Durable conversation/artifacts live in SessionWorkspaceService / IDB+OPFS.
 * chrome.storage holds a thin UI cache — never the sole owner of messages/artifacts.
 */
function savePersistentSessions(opts = {}) {
  if (sessions.length > 15) {
    const dropped = sessions.slice(0, sessions.length - 15);
    sessions = sessions.slice(sessions.length - 15);
    const keepIds = sessions.map((s) => s.id);
    void workspaceRpc('pruneSessions', { keepSessionIds: keepIds }).catch(() => {});
    for (const s of dropped) {
      void workspaceRpc('deleteSession', { sessionId: s.id }).catch(() => {});
    }
  }
  // Write-through: keep Runtime title in sync for the active session
  const active = sessions.find((s) => s.id === activeSessionId);
  if (!opts.skipActiveWriteThrough && active?.name) {
    void workspaceRpc('renameSession', {
      sessionId: active.id,
      title: active.name,
      lockTitle: !!active.titleLocked
    }).catch(() => {});
  }
  // Thin UI cache (not durable artifact/conversation truth)
  const cache = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    titleLocked: !!s.titleLocked,
    // Cap cached messages for storage quota; Runtime holds full history
    messages: Array.isArray(s.messages) ? s.messages.slice(-40) : []
  }));
  chrome.storage.local.set({
    pagewand_session_ui_cache: cache,
    pagewand_sessions: cache, // legacy key for one-release migrate
    pagewand_active_session_id: activeSessionId
  });
}


/* ===== PART: page_banner ===== */

/**
 * Compact page-listen trust indicator (green/red). Label is hostname when on a page.
 */
function setPageListenState(state, host = '') {
  const btn = document.getElementById('pageListenBtn');
  const label = document.getElementById('pageListenLabel');
  if (!btn) return;
  btn.dataset.listen = state; // ok | editor | bad | pending
  const tip =
    state === 'ok'
      ? lastActivePage?.url
        ? `${lastActivePage.title || host} · ${lastActivePage.url}`
        : currentLang === 'en'
          ? `On page · ${host || 'web'}`
          : `当前页 · ${host || '网页'}`
      : state === 'editor'
        ? currentLang === 'en'
          ? `Editing · ${host || 'canvas'}`
          : `编辑中 · ${host || '画布'}`
        : state === 'bad'
        ? currentLang === 'en'
          ? 'Not on a web page — open a normal tab'
          : '未在普通网页 — 打开一个网站后再说「这页」'
        : currentLang === 'en'
          ? 'Connecting…'
          : '连接中…';
  btn.title = tip;
  btn.setAttribute('aria-label', tip);
  if (label) {
    const shown = String(host || '').trim();
    label.textContent =
      state === 'ok'
        ? shown || (currentLang === 'en' ? 'On page' : '当前页')
        : state === 'editor'
          ? shown || (currentLang === 'en' ? 'Editor' : '编辑器')
          : state === 'bad'
            ? currentLang === 'en'
              ? 'No page'
              : '未在网页'
            : '…';
  }
}

async function updateActivePageListeningBanner() {
  try {
    const domainEl = document.getElementById('activePageDomain');
    const titleEl = document.getElementById('activePageTitle');
    setPageListenState('pending');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const workKind = classifyWorkTab(tab?.url || tab?.pendingUrl || '');
    if (workKind) {
      const label = workTabListenLabel(workKind, currentLang);
      lastActivePage = {
        url: String(tab.url || ''),
        title: String(tab.title || label),
        host: label,
        origin: 'paw-work',
        workKind,
        tabId: tab.id
      };
      if (domainEl) domainEl.textContent = label;
      if (titleEl) titleEl.textContent = tab.title || label;
      setPageListenState('editor', label);
      return;
    }
    if (!tab?.id || !isInjectableTabUrl(tab.url)) {
      if (domainEl) domainEl.textContent = '—';
      if (titleEl) titleEl.textContent = t('activePageNoTab');
      lastActivePage = null;
      setPageListenState('bad');
      return;
    }

    const ref = normalizePageRef({ url: tab.url, title: tab.title || '' });
    lastActivePage = ref ? { ...ref, tabId: tab.id } : null;
    let domain = ref?.host || 'Unknown';
    const title = tab.title || domain;
    if (titleEl) titleEl.textContent = title;
    if (domainEl) domainEl.textContent = domain;
    setPageListenState('ok', domain);

    await ensureContentScriptActive(tab.id);

    chrome.tabs.sendMessage(tab.id, { action: 'scan_full_page_dom' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        return;
      }
      currentActivePageMeta = response;
      if (response?.url && isInjectableTabUrl(response.url)) {
        lastActivePage = {
          ...(normalizePageRef({
            url: response.url,
            title: response.title || title
          }) || lastActivePage || {}),
          tabId: tab.id
        };
        setPageListenState('ok', lastActivePage?.host || domain);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || '');
    if (!/error page|cannot be scripted|cannot access/i.test(msg)) {
      console.warn('Failed to update active page listening banner:', err);
    }
    lastActivePage = null;
    setPageListenState('bad');
  }
}

/* ===== PART: image_dl ===== */

async function showActivePageToast(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return false;
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
      return false;
    }
    await ensureContentScriptActive(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: 'show_custom_toast', msg });
    return true;
  } catch (err) {
    console.warn('[PageWand] Page toast failed:', err);
    return false;
  }
}

async function sendActiveTabHarvest(action) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, count: 0 };
    await ensureContentScriptActive(tab.id);
    return await chrome.tabs.sendMessage(tab.id, { action });
  } catch (err) {
    console.warn('[harvest]', action, err);
    return { ok: false, count: 0, error: err?.message || String(err) };
  }
}

function selectedHarvestHrefs() {
  return [
    ...new Set(
      (selectedElementsSummary || [])
        .map((el) => String(el.href || '').trim())
        .filter((h) => h && h !== '#' && !/^javascript:/i.test(h) && /^(https?:|\/)/i.test(h))
    )
  ];
}

async function executeCrossTabImageDownload() {
  const allElements = getFlattenedCrossTabElements();
  // Only download images from user-selected elements — never whole-page scrape
  if (!allElements || allElements.length === 0) {
    // Page toast (same UX as picker / content_script) — not a sidepanel modal
    await showActivePageToast('⚠️ 请先伸爪选中要下载的图片或包含图片的区域');
    return;
  }

  const tabGroups = {};
  allElements.forEach(item => {
    const tid = item.tabId || 'active';
    if (!tabGroups[tid]) tabGroups[tid] = [];
    tabGroups[tid].push(item);
  });

  let allImageUrls = [];
  let finalDataUrls = [];

  for (const tidStr of Object.keys(tabGroups)) {
    const groupItems = tabGroups[tidStr];
    let tabIdNum = parseInt(tidStr);
    if (isNaN(tabIdNum)) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabIdNum = tab ? tab.id : null;
    }

    if (tabIdNum) {
      try {
        await ensureContentScriptActive(tabIdNum);
        const res = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabIdNum, { action: 'extract_tab_image_urls', elements: groupItems }, (response) => {
            if (chrome.runtime.lastError || !response) resolve(null);
            else resolve(response);
          });
        });
        const tabUrls = (res && res.urls) ? [...new Set(res.urls.filter(Boolean))] : [];
        if (tabUrls.length > 0) {
          allImageUrls.push(...tabUrls);
          // Convert in tab page context (fetchUrlAsDataUrlInTabContext is content-script only)
          const fetchRes = await new Promise((resolve) => {
            chrome.tabs.sendMessage(
              tabIdNum,
              { action: 'fetch_urls_as_data_urls', urls: tabUrls },
              (response) => {
                if (chrome.runtime.lastError || !response) resolve(null);
                else resolve(response);
              }
            );
          });
          if (fetchRes && Array.isArray(fetchRes.dataUrls)) {
            finalDataUrls.push(...fetchRes.dataUrls.filter(Boolean));
          }
        }
      } catch (e) {
        console.warn('Cross tab image extract/fetch failed for tab:', tabIdNum, e);
      }
    }
  }

  allImageUrls = [...new Set(allImageUrls.filter(Boolean))];

  if (allImageUrls.length === 0) {
    await showActivePageToast('⚠️ 选中的元素中未找到可下载图片');
    return;
  }

  finalDataUrls = [...new Set(finalDataUrls.filter(Boolean))];

  if (finalDataUrls.length === 0) {
    await showActivePageToast('⚠️ 图片提取失败，请重试');
    return;
  }

  chrome.runtime.sendMessage({
    action: 'trigger_native_downloads',
    urls: finalDataUrls
  });
}

/* ===== PART: status_d3 ===== */


/** @typedef {'running'|'claimed_done'|'verified'|'failed'} AgentTaskUiStatus */

const AGENT_TASK_STATUS_LABELS = {
  zh: {
    running: '运行中',
    claimed_done: '已声明完成',
    verified: '已校验',
    failed: '失败'
  },
  en: {
    running: 'Running',
    claimed_done: 'Claimed done',
    verified: 'Verified',
    failed: 'Failed'
  }
};

/**
 * Human-readable label for D3 status triad.
 * @param {AgentTaskUiStatus|string} status
 * @returns {string}
 */
function agentTaskStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  const dict = AGENT_TASK_STATUS_LABELS[currentLang] || AGENT_TASK_STATUS_LABELS.zh;
  return dict[key] || dict.claimed_done || String(status || '');
}

/**
 * Map runtime finishVerification / verifyStatus / outcome → UI triad.
 * @param {{
 *   finishVerification?: string|null,
 *   verifyStatus?: string|null,
 *   aborted?: boolean,
 *   error?: boolean|string|null,
 *   agentFinished?: boolean
 * }} src
 * @returns {AgentTaskUiStatus}
 */
function resolveAgentTaskUiStatus(src = {}) {
  if (src.error || src.aborted) return 'failed';
  const term = String(src.terminalStatus || src.status || '')
    .trim()
    .toLowerCase();
  if (term.startsWith('incomplete') || term === 'incomplete') return 'failed';
  if (term === 'failed' || term === 'error' || term === 'aborted') return 'failed';
  const fv = String(src.finishVerification || src.verifyStatus || '')
    .trim()
    .toLowerCase();
  if (fv === 'incomplete' || fv === 'failed' || fv === 'error' || fv === 'blocked') {
    return 'failed';
  }
  if (fv === 'verified') return 'verified';
  if (fv === 'unverified' || fv === 'claimed_done') return 'claimed_done';
  if (fv === 'not_required') return 'claimed_done';
  if (src.agentFinished) return 'claimed_done';
  // No successful finish → do not claim done
  return 'failed';
}

/* ===== PART: artifact ===== */


/** Pending modal payload while confirm UI is open */


/**
 * @param {string} [mime]
 * @param {string} [name]
 * @returns {boolean}
 */
function isTextLikeArtifact(mime, name) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (
    m.startsWith('text/') ||
    m.includes('json') ||
    m.includes('csv') ||
    m.includes('xml') ||
    m.includes('javascript') ||
    m.includes('markdown') ||
    m === 'application/json' ||
    m === 'application/xml'
  ) {
    return true;
  }
  return /\.(txt|md|csv|tsv|json|xml|html?|js|css|log|yml|yaml)$/i.test(n);
}

/**
 * Decode a data: URL into a UTF-8 text sample (capped).
 * @param {string} dataUrl
 * @param {number} [maxChars]
 * @returns {string}
 */
function decodeDataUrlTextSample(dataUrl, maxChars = ARTIFACT_PREVIEW_SAMPLE_CHARS) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return '';
    const header = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    let raw = '';
    if (/;base64/i.test(header)) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } else {
      raw = decodeURIComponent(body);
    }
    if (!raw) return '';
    const lines = raw.split(/\r?\n/);
    const clipped =
      lines.length > ARTIFACT_PREVIEW_SAMPLE_LINES
        ? lines.slice(0, ARTIFACT_PREVIEW_SAMPLE_LINES).join('\n') +
          `\n… (${lines.length - ARTIFACT_PREVIEW_SAMPLE_LINES} more lines)`
        : raw;
    if (clipped.length > maxChars) {
      return clipped.slice(0, maxChars) + '\n…';
    }
    return clipped;
  } catch (e) {
    console.warn('[C4] decode sample failed', e);
    return '';
  }
}

/**
 * Format byte size for toast / meta.
 * @param {number} [n]
 * @returns {string}
 */
function formatArtifactSize(n) {
  const size = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Trigger download from a data URL (event_only path after user confirms).
 * @param {string} dataUrl
 * @param {string} [filename]
 */
function downloadFromDataUrl(dataUrl, filename) {
  const name = (filename && String(filename).trim()) || 'download.bin';
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (e) {
    console.warn('[C4] downloadFromDataUrl failed', e);
    return false;
  }
}

function closeArtifactPreviewModal() {
  const overlay = document.getElementById('artifactPreviewOverlay');
  if (!overlay) return;
  try {
    if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  } catch (_) {}
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.display = 'none';
  pendingArtifactPreview = null;
  const sampleEl = document.getElementById('artifactPreviewSample');
  if (sampleEl) sampleEl.textContent = '';
}

/**
 * @param {object} ev - artifact_download | artifact_ready payload
 * @param {{ requireConfirm?: boolean, alreadyDownloaded?: boolean }} [opts]
 */
function showArtifactPreviewModal(ev, opts = {}) {
  const requireConfirm = opts.requireConfirm !== false && !opts.alreadyDownloaded;
  const alreadyDownloaded = !!opts.alreadyDownloaded;
  const name = (ev?.name && String(ev.name)) || 'artifact';
  const mime = (ev?.mime && String(ev.mime)) || 'application/octet-stream';
  const size = typeof ev?.size === 'number' ? ev.size : 0;
  const kind = ev?.kind ? String(ev.kind) : '';
  const dataUrl = typeof ev?.dataUrl === 'string' ? ev.dataUrl : '';
  let sample =
    (ev?.sampleText && String(ev.sampleText)) ||
    (dataUrl && isTextLikeArtifact(mime, name) ? decodeDataUrlTextSample(dataUrl) : '');

  if (!sample) {
    if (dataUrl && /^data:image\//i.test(dataUrl)) {
      sample =
        currentLang === 'en'
          ? '(Binary image payload — confirm to download)'
          : '（图片二进制 · 确认后下载）';
    } else if (!isTextLikeArtifact(mime, name)) {
      sample =
        currentLang === 'en'
          ? `(Binary / non-text artifact · ${mime || 'unknown type'})\nConfirm to download.`
          : `（二进制/非文本产物 · ${mime || '未知类型'}）\n确认后下载。`;
    } else {
      sample =
        currentLang === 'en'
          ? '(No inline sample available)'
          : '（暂无内联样例内容）';
    }
  }

  pendingArtifactPreview = {
    ...ev,
    name,
    mime,
    size,
    kind,
    dataUrl,
    sampleText: sample,
    requireConfirm,
    alreadyDownloaded
  };

  const overlay = document.getElementById('artifactPreviewOverlay');
  const titleEl = document.getElementById('artifactPreviewTitle');
  const metaEl = document.getElementById('artifactPreviewMeta');
  const sampleEl = document.getElementById('artifactPreviewSample');
  const confirmBtn = document.getElementById('artifactPreviewConfirmBtn');
  const cancelBtn = document.getElementById('artifactPreviewCancelBtn');

  if (titleEl) {
    titleEl.textContent = currentLang === 'en' ? 'Artifact preview' : '产物预览';
  }
  if (metaEl) {
    const parts = [name, mime, formatArtifactSize(size)];
    if (kind) parts.push(kind);
    if (ev?.artifactId) parts.push(`id:${String(ev.artifactId).slice(0, 24)}`);
    if (alreadyDownloaded) {
      parts.push(currentLang === 'en' ? 'already downloaded' : '已下载');
    }
    metaEl.textContent = parts.join(' · ');
  }
  if (sampleEl) sampleEl.textContent = sample;

  if (confirmBtn) {
    if (alreadyDownloaded && dataUrl) {
      confirmBtn.textContent = currentLang === 'en' ? 'Download again' : '重新下载';
      confirmBtn.style.display = '';
    } else if (requireConfirm && dataUrl) {
      confirmBtn.textContent = currentLang === 'en' ? 'Confirm download' : '确认下载';
      confirmBtn.style.display = '';
    } else if (requireConfirm && !dataUrl) {
      confirmBtn.style.display = 'none';
    } else {
      confirmBtn.textContent = currentLang === 'en' ? 'Close' : '关闭';
      confirmBtn.style.display = '';
    }
  }
  if (cancelBtn) {
    cancelBtn.textContent =
      alreadyDownloaded || !requireConfirm
        ? currentLang === 'en'
          ? 'Close'
          : '关闭'
        : currentLang === 'en'
          ? 'Cancel'
          : '取消';
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => overlay.classList.add('active'));
  }
}

function setupArtifactPreviewModal() {
  const overlay = document.getElementById('artifactPreviewOverlay');
  if (!overlay || overlay.dataset.bound) return;
  overlay.dataset.bound = '1';

  const onClose = () => closeArtifactPreviewModal();
  document.getElementById('artifactPreviewCloseBtn')?.addEventListener('click', onClose);
  document.getElementById('artifactPreviewCancelBtn')?.addEventListener('click', onClose);
  document.getElementById('artifactPreviewConfirmBtn')?.addEventListener('click', () => {
    const pend = pendingArtifactPreview;
    if (!pend) {
      closeArtifactPreviewModal();
      return;
    }
    if (pend.dataUrl) {
      const ok = downloadFromDataUrl(pend.dataUrl, pend.name);
      showSidepanelToast(
        ok
          ? currentLang === 'en'
            ? `Download started · ${pend.name}`
            : `已开始下载 · ${pend.name}`
          : currentLang === 'en'
            ? 'Download failed'
            : '下载失败',
        { error: !ok }
      );
    } else {
      showSidepanelToast(
        currentLang === 'en' ? 'No download payload' : '无下载数据',
        { error: true }
      );
    }
    closeArtifactPreviewModal();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeArtifactPreviewModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      closeArtifactPreviewModal();
    }
  });
}

/**
 * C4 — Handle artifact_download / artifact_ready from agent onEvent.
 * - Already downloaded (anchor/chrome/hook): toast + optional preview of last artifact
 * - event_only / not yet downloaded with dataUrl: preview modal → confirm → download
 * @param {object} ev
 */
function handleArtifactDownloadEvent(ev) {
  if (!ev || (ev.type !== 'artifact_download' && ev.type !== 'artifact_ready')) return;

  const method = ev.method != null ? String(ev.method) : '';
  const name = (ev.name && String(ev.name)) || 'artifact';
  const sizeLabel = formatArtifactSize(ev.size);
  const dataUrl = typeof ev.dataUrl === 'string' ? ev.dataUrl : '';
  const alreadyDownloaded =
    ev.downloaded === true ||
    (method && method !== 'event_only') ||
    // artifact_ready without method may mean "ready for confirm" only
    (ev.type === 'artifact_download' && method && method !== 'event_only');

  let sampleText = '';
  if (dataUrl && isTextLikeArtifact(ev.mime, name)) {
    sampleText = decodeDataUrlTextSample(dataUrl);
  }

  lastArtifactEvent = {
    ...ev,
    name,
    sampleText: sampleText || undefined,
    ts: Date.now()
  };

  // Path A: host already triggered download → toast; keep lastArtifactEvent for optional re-preview
  if (alreadyDownloaded && method !== 'event_only') {
    showSidepanelToast(
      currentLang === 'en'
        ? `Downloaded · ${name} (${sizeLabel})`
        : `已下载 · ${name}（${sizeLabel}）`,
      { ms: 2800 }
    );
    // Optional preview only when inline sample/dataUrl is available (not forced)
    if (sampleText || (dataUrl && isTextLikeArtifact(ev.mime, name))) {
      // Defer slightly so toast is visible first; user can dismiss preview
      setTimeout(() => {
        if (lastArtifactEvent && lastArtifactEvent.name === name) {
          showArtifactPreviewModal(
            { ...lastArtifactEvent, name, sampleText: sampleText || lastArtifactEvent.sampleText },
            { alreadyDownloaded: true, requireConfirm: false }
          );
        }
      }, 400);
    }
    return;
  }

  // Path B: delegated to UI (event_only / artifact_ready) — confirm then download
  if (dataUrl) {
    showArtifactPreviewModal(
      { ...ev, name, sampleText },
      { requireConfirm: true, alreadyDownloaded: false }
    );
    showSidepanelToast(
      currentLang === 'en'
        ? `Artifact ready · ${name} — confirm to download`
        : `产物就绪 · ${name} — 请确认下载`,
      { ms: 3200 }
    );
    return;
  }

  // No payload to download from UI
  showSidepanelToast(
    currentLang === 'en'
      ? `Artifact event · ${name} (${sizeLabel})${ev.message ? ' · ' + String(ev.message).slice(0, 80) : ''}`
      : `产物事件 · ${name}（${sizeLabel}）${ev.message ? ' · ' + String(ev.message).slice(0, 80) : ''}`,
    { ms: 3000 }
  );
}


/* ===== PART: image_gen ===== */

/* ── IG-5: Generated image preview + download (glassmorphism, no alert) ── */


/**
 * Sanitize download filename; prefer pagewand-gen-*.png/jpg per IG-5 contract.
 * @param {string} [name]
 * @param {string} [dataUrl]
 * @returns {string}
 */
function resolveImageGenDownloadName(name, dataUrl) {
  let ext = 'png';
  if (typeof dataUrl === 'string') {
    if (/^data:image\/jpe?g/i.test(dataUrl)) ext = 'jpg';
    else if (/^data:image\/webp/i.test(dataUrl)) ext = 'webp';
    else if (/^data:image\/gif/i.test(dataUrl)) ext = 'gif';
  }
  let n = (name && String(name).trim()) || '';
  // Reject path-like / oversized names
  if (!n || /[/\\]/.test(n) || n.length > 120) {
    return `pagewand-gen-${Date.now()}.${ext}`;
  }
  // Force contract prefix pagewand-gen-*
  if (!/^pagewand-gen-/i.test(n)) {
    const base = n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const hasExt = /\.(png|jpe?g|webp|gif)$/i.test(base);
    return hasExt ? `pagewand-gen-${Date.now()}-${base}` : `pagewand-gen-${Date.now()}.${ext}`;
  }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(n)) {
    n = `${n}.${ext}`;
  }
  return n;
}

/**
 * Trigger browser download for a generated image (dataUrl preferred).
 * @param {string} [dataUrl]
 * @param {string} [url]
 * @param {string} [downloadName]
 */
function downloadGeneratedImageFile(dataUrl, url, downloadName) {
  const name = resolveImageGenDownloadName(downloadName, dataUrl);
  try {
    if (dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return name;
    }
    if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      // Prefer fetch→blob so downloadName is honored; fall back to tab open
      fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
        .then((blob) => {
          const obj = URL.createObjectURL(blob);
          const a2 = document.createElement('a');
          a2.href = obj;
          a2.download = name;
          document.body.appendChild(a2);
          a2.click();
          a2.remove();
          setTimeout(() => URL.revokeObjectURL(obj), 2000);
        })
        .catch(() => {
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      return name;
    }
  } catch (e) {
    console.warn('[IG-5] download failed', e);
  }
  return name;
}

/**
 * Optional: push generated image into pending chat attachments for follow-up i2i.
 * @param {{ dataUrl?: string, url?: string, downloadName?: string }} payload
 * @returns {boolean}
 */
function attachGeneratedImageToPending(payload) {
  const dataUrl = payload?.dataUrl;
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    showSidepanelToast(
      currentLang === 'en'
        ? 'No inline image to attach (URL-only). Download instead.'
        : '无内联图片可加入附件（仅 URL），请先下载。',
      { error: true }
    );
    return false;
  }
  const name = resolveImageGenDownloadName(payload.downloadName, dataUrl);
  try {
    const att = attachmentFromDataUrl(dataUrl, {
      name,
      source: 'image_generated'
    });
    att.id = `gen-${Date.now()}`;
    const dup = pendingAttachments.find((a) => a.isImage && a.dataUrl === att.dataUrl);
    if (dup) {
      showSidepanelToast(
        currentLang === 'en' ? 'Already in chat attachments' : '已在聊天附件中'
      );
      return true;
    }
    pendingAttachments.push(att);
    renderAttachmentPreviews();
    showSidepanelToast(
      currentLang === 'en' ? 'Added to chat attachments' : '已加入聊天附件'
    );
    return true;
  } catch (e) {
    console.warn('[IG-5] attach failed', e);
    showSidepanelToast(
      currentLang === 'en' ? 'Failed to attach image' : '加入附件失败',
      { error: true }
    );
    return false;
  }
}

function closeImageGenPreviewModal() {
  const overlay = document.getElementById('imageGenPreviewOverlay');
  if (!overlay) return;
  try {
    if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  } catch (_) {}
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.display = 'none';
  const img = document.getElementById('imageGenPreviewImg');
  if (img) {
    img.removeAttribute('src');
    img.alt = '';
  }
}

function setupImageGenPreviewModal() {
  const overlay = document.getElementById('imageGenPreviewOverlay');
  if (!overlay || overlay.dataset.bound) return;
  overlay.dataset.bound = '1';

  document.getElementById('imageGenPreviewCloseBtn')?.addEventListener('click', closeImageGenPreviewModal);
  document.getElementById('imageGenPreviewDoneBtn')?.addEventListener('click', closeImageGenPreviewModal);
  document.getElementById('imageGenDownloadBtn')?.addEventListener('click', () => {
    if (!lastGeneratedImage) return;
    downloadGeneratedImageFile(
      lastGeneratedImage.dataUrl,
      lastGeneratedImage.url,
      lastGeneratedImage.downloadName
    );
    showSidepanelToast(currentLang === 'en' ? 'Download started' : '已开始下载');
  });
  document.getElementById('imageGenAttachBtn')?.addEventListener('click', () => {
    if (!lastGeneratedImage) return;
    attachGeneratedImageToPending(lastGeneratedImage);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeImageGenPreviewModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      closeImageGenPreviewModal();
    }
  });
}

/**
 * Show glassmorphism preview for a successfully generated image.
 * @param {{ dataUrl?: string, url?: string, downloadName?: string, width?: number, height?: number, mode?: string, status?: string, message?: string }} ev
 */
function showImageGenPreview(ev) {
  const dataUrl = typeof ev?.dataUrl === 'string' ? ev.dataUrl : '';
  const url = typeof ev?.url === 'string' ? ev.url : '';
  const src = dataUrl || url;
  if (!src) return;

  const downloadName = resolveImageGenDownloadName(ev.downloadName, dataUrl || undefined);
  lastGeneratedImage = {
    dataUrl: dataUrl || undefined,
    url: url || undefined,
    downloadName,
    width: typeof ev.width === 'number' ? ev.width : undefined,
    height: typeof ev.height === 'number' ? ev.height : undefined,
    mode: ev.mode,
    status: ev.status
  };

  const overlay = document.getElementById('imageGenPreviewOverlay');
  const img = document.getElementById('imageGenPreviewImg');
  const meta = document.getElementById('imageGenPreviewMeta');
  const title = document.getElementById('imageGenPreviewTitle');
  if (title) {
    title.textContent =
      currentLang === 'en' ? 'Generated image' : '生成的图片';
  }
  if (img) {
    img.src = src;
    img.alt = downloadName;
  }
  if (meta) {
    const parts = [];
    if (ev.mode) parts.push(String(ev.mode).toUpperCase());
    if (typeof ev.width === 'number' && typeof ev.height === 'number') {
      parts.push(`${ev.width}×${ev.height}`);
    }
    parts.push(downloadName);
    if (ev.message && String(ev.message).trim()) {
      parts.push(String(ev.message).trim().slice(0, 120));
    }
    meta.textContent = parts.join(' · ');
  }
  // Localize footer buttons if present
  const attachBtn = document.getElementById('imageGenAttachBtn');
  const dlBtn = document.getElementById('imageGenDownloadBtn');
  const doneBtn = document.getElementById('imageGenPreviewDoneBtn');
  if (attachBtn) attachBtn.textContent = currentLang === 'en' ? 'Add to chat' : '加入附件';
  if (dlBtn) dlBtn.textContent = currentLang === 'en' ? 'Download' : '下载';
  if (doneBtn) doneBtn.textContent = currentLang === 'en' ? 'Done' : '完成';

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => overlay.classList.add('active'));
  }
}

/**
 * Handle agent stream event `image_generated` from generate_image tool (IG-4 → IG-5).
 * Success + dataUrl/url → auto download + glass preview. Errors → toast only (no alert).
 * @param {object} ev
 */
function handleImageGeneratedEvent(ev) {
  if (!ev || ev.type !== 'image_generated') return;
  const status = ev.status || (ev.dataUrl || ev.url || ev.artifactId ? 'success' : 'error');
  const landed = !!(ev.artifactId || ev.path || ev.dataUrl || ev.url);

  if (status !== 'success' || !landed) {
    const msg =
      (ev.message && String(ev.message).trim()) ||
      (currentLang === 'en' ? 'Image generation failed' : '图像生成失败');
    showSidepanelToast(msg, { error: true, ms: 3600 });
    return;
  }

  const downloadName = resolveImageGenDownloadName(ev.downloadName, ev.dataUrl || undefined);
  void refreshArtifactShelf().then(() => {
    pulseArtifactBadge();
    if (sessionArtifacts.length) setArtifactRailOpen(true);
  });
  if (ev.dataUrl || ev.url) {
    showImageGenPreview({ ...ev, downloadName });
  }
  showSidepanelToast(
    currentLang === 'en'
      ? `Saved to 交付物 · ${downloadName}`
      : `已写入交付物 · ${downloadName}`,
    { ms: 2800 }
  );
}


/* ===== PART: trajectory (mount/download → sidepanel/trajectoryUi.js) ===== */

function setupTrajectoryExportModal() {
  const overlay = document.getElementById('trajectoryExportOverlay');
  if (!overlay || overlay.dataset.bound) return;
  overlay.dataset.bound = '1';

  /** @type {HTMLElement|null} */
  let returnFocus = null;

  const close = () => {
    try {
      if (overlay.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    } catch (_) {}
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
    const el = returnFocus;
    returnFocus = null;
    if (el && document.contains(el)) {
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
        } catch (_) {}
      });
    }
  };

  document.getElementById('trajectoryExportCloseBtn')?.addEventListener('click', close);
  document.getElementById('trajectoryExportCancelBtn')?.addEventListener('click', close);
  document.getElementById('trajectoryExportConfirmBtn')?.addEventListener('click', () => {
    const status = document.getElementById('trajectoryHumanStatusSelect')?.value || 'unknown';
    const note = document.getElementById('trajectoryHumanStatusNote')?.value || '';
    const persist = !!document.getElementById('trajectoryPersistHumanStatus')?.checked;
    close();
    downloadCurrentConversationTrajectory({
      humanStatus: status,
      humanStatusNote: note,
      persistHumanStatus: persist
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (overlay.getAttribute('aria-hidden') === 'true' || overlay.style.display === 'none') return;
    if (!overlay.classList.contains('active')) return;
    e.preventDefault();
    close();
  });

  // Expose return-focus setter for openTrajectoryExportModal
  /** @type {any} */
  const o = overlay;
  o._pwSetReturnFocus = (el) => {
    returnFocus = el instanceof HTMLElement ? el : null;
  };
}

function openTrajectoryExportModal() {
  if (!devTrajectoryExportEnabled) {
    showSidepanelToast(
      currentLang === 'en'
        ? 'Trajectory export disabled in Settings'
        : '轨迹导出未启用 — 请在 ⚙️ 设置中开启',
      { error: true }
    );
    return;
  }
  const activeSess = sessions.find((s) => s.id === activeSessionId);
  if (!activeSess) {
    showSidepanelToast(currentLang === 'en' ? 'No active task' : '无当前任务', {
      error: true
    });
    return;
  }
  ensureSessionTrajectory(activeSess);
  const overlay = document.getElementById('trajectoryExportOverlay');
  const statusSel = document.getElementById('trajectoryHumanStatusSelect');
  const noteEl = document.getElementById('trajectoryHumanStatusNote');
  if (statusSel) {
    statusSel.value = normalizeHumanStatus(activeSess.trajectory?.humanStatus || 'unknown');
  }
  if (noteEl) {
    noteEl.value = activeSess.trajectory?.humanStatusNote || '';
  }
  if (!overlay) {
    // Fallback: download without modal
    downloadCurrentConversationTrajectory({ humanStatus: 'unknown' });
    return;
  }
  /** @type {any} */
  const o = overlay;
  if (typeof o._pwSetReturnFocus === 'function') {
    o._pwSetReturnFocus(
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
  }
  overlay.style.display = 'flex';
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    overlay.classList.add('active');
    try {
      statusSel?.focus?.({ preventScroll: true });
    } catch (_) {}
  });
}

/**
 * Download the model's tool + host behavior path for this task.
 * Reads workspace messages (path / toolCalls / wire), not the chat bubble log.
 */
async function downloadCurrentConversationTrajectory({
  humanStatus = 'unknown',
  humanStatusNote = '',
  persistHumanStatus = true
} = {}) {
  try {
    const activeSess = sessions.find((s) => s.id === activeSessionId);
    if (!activeSess) {
      showSidepanelToast(currentLang === 'en' ? 'No task' : '无任务', { error: true });
      return;
    }
    ensureSessionTrajectory(activeSess);

    if (persistHumanStatus) {
      setSessionHumanStatus(activeSess, humanStatus, humanStatusNote);
      savePersistentSessions();
    }

    let workspace = null;
    try {
      workspace = await workspaceRpc('getSession', { sessionId: String(activeSess.id) });
    } catch (e) {
      console.warn('[PageWand] trajectory getSession failed', e);
    }
    const messages = mergeSessionTranscriptMessages(workspace?.messages, activeSess.messages);

    const doc = serializeBehaviorTrajectory({
      session: {
        sessionId: activeSess.id || activeSessionId,
        title: workspace?.title || activeSess.name || '',
        messages
      },
      messages,
      humanStatus,
      humanStatusNote,
      humanStatusSetAt: persistHumanStatus ? new Date().toISOString() : undefined
    });
    const json = trajectoryToDownloadJson(doc);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = trajectoryDownloadFilename(activeSess.id || activeSessionId);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const s = doc.summary || {};
    showSidepanelToast(
      currentLang === 'en'
        ? `Trajectory downloaded (${s.turns || 0} turns, ${s.tools || 0} tools, ${s.host || 0} host)`
        : `轨迹已下载（${s.turns || 0} 轮 · ${s.tools || 0} 次工具 · ${s.host || 0} 次宿主）`
    );
  } catch (e) {
    console.error('[PageWand] trajectory export failed', e);
    showSidepanelToast(
      (currentLang === 'en' ? 'Export failed: ' : '导出失败: ') + (e?.message || e),
      { error: true }
    );
  }
}

/* Export Current Session Transcript to Markdown File */
function exportCurrentSessionMarkdown() {
  const activeSess = sessions.find(s => s.id === activeSessionId);
  if (!activeSess || !activeSess.messages || activeSess.messages.length === 0) {
    showCustomModal({ title: '提示', placeholder: '', initialValue: '⚠️ 当前任务暂无可导出的聊天记录', onConfirm: () => {} });
    return;
  }

  let mdContent = `# 爪爪 · 完全解放版 任务记录: ${activeSess.name}\n\n`;
  mdContent += `> 导出时间: ${new Date().toLocaleString()}\n\n`;

  activeSess.messages.forEach((msg, idx) => {
    if (msg.role === 'user') {
      mdContent += `### 👤 用户:\n${msg.content}\n\n`;
    } else {
      if (msg.thought) {
        mdContent += `<details><summary>🧠 Agent 思考流</summary>\n\n\`\`\`\n${msg.thought}\n\`\`\`\n</details>\n\n`;
      }
      mdContent += `### 爪爪:\n${msg.content}\n\n`;
    }
  });

  const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PawWork_Session_${activeSess.name.replace(/[^\w\u4e00-\u9fa5]/g, '_')}_${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


/* ===== PART: settings_block ===== */
// settingsConfigUi / settingsProviderUi / chatModelCatalogUi are declared at module top.

/**
 * Ensure toolbar modelSelect has an option for free-text model ids.
 * @param {string} modelId
 */
function ensureModelOption(modelId) {
  const select = document.getElementById('modelSelect');
  if (!select || !modelId) return;
  const exists = [...select.options].some((o) => o.value === modelId);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = modelId;
    opt.textContent = modelId;
    select.appendChild(opt);
  }
  select.value = modelId;
  selectedModel = modelId;
  updateMultimodalBadgeState(modelId);
  renderModelSelectMenu();
}

function modelSelectLabelText(select) {
  const opt = select?.selectedOptions?.[0];
  return String(opt?.textContent || select?.value || selectedModel || '').trim();
}

function renderModelSelectMenu() {
  const select = $('modelSelect');
  const menu = $('modelSelectMenu');
  const label = $('modelSelectLabel');
  if (!select || !menu) return;
  const chatName = modelSelectLabelText(select);
  const name = formatModelChipLabel(select.value || selectedModel || chatName, selectedImageModel);
  if (label) label.textContent = name || chatName;
  const current = $('modelSelectCurrentName');
  if (current) current.textContent = name || chatName;
  const trigger = $('modelSelectTrigger');
  if (trigger) {
    trigger.title = selectedImageModel
      ? `${chatName} · ${selectedImageModel}`
      : chatName;
  }
  renderReasoningEffortChips();
}

async function persistComposerModel(modelId, providerId) {
  const id = String(modelId || '').trim();
  if (!id) return;
  try {
    await setActiveProviderModel(id, { providerId: providerId || undefined });
  } catch (_) {
    try {
      await chrome.storage.local.set({ selected_model: id });
    } catch {
      /* ignore */
    }
  }
  try {
    await pushRecentModel(id);
  } catch (_) {}
}

async function pickComposerModel(modelId, providerId) {
  const id = String(modelId || '').trim();
  if (!id) return;
  if (providerId) {
    try {
      await setActiveProviderId(providerId);
    } catch (_) {}
  }
  await persistComposerModel(id, providerId);
  try {
    const settings = await loadLlmSettings();
    selectedImageModel = settings?.image?.enabled ? String(settings.image.model || '') : '';
  } catch (_) {}
  ensureModelOption(id);
  const select = $('modelSelect');
  if (select && select.value !== id) {
    select.value = id;
    selectedModel = id;
    renderModelSelectMenu();
    void refreshReasoningCatalog(false);
  } else {
    selectedModel = id;
    renderModelSelectMenu();
    void refreshReasoningCatalog(false);
  }
  refreshAgentStatusBadge();
  setModelSubmenuOpen(false);
}

async function persistComposerImageModel(modelId, providerId) {
  const id = String(modelId || '').trim();
  if (!id) return;
  try {
    await setActiveProviderImageModel(id, { providerId: providerId || undefined });
  } catch (_) {}
}

async function pickComposerImageModel(modelId, providerId) {
  const id = String(modelId || '').trim();
  if (!id) return;
  await persistComposerImageModel(id, providerId);
  let activeId = null;
  try {
    const state = await loadProvidersState();
    activeId = state.activeProviderId || null;
  } catch (_) {}
  if (!providerId || providerId === activeId) {
    selectedImageModel = id;
  }
  renderModelSelectMenu();
  refreshAgentStatusBadge();
  setModelSubmenuOpen(false);
}

async function modelsForProvider(provider) {
  const chatBase = String(provider?.baseURL || '').replace(/\/$/, '');
  const imageBaseExplicit =
    typeof provider?.image?.baseURL === 'string' && provider.image.baseURL.trim()
      ? provider.image.baseURL.trim().replace(/\/$/, '')
      : '';
  const imageBase = imageBaseExplicit || chatBase;
  const chatCached = chatBase ? await loadCachedModelsForBase(chatBase) : { models: [] };
  const imageCached =
    provider?.image?.enabled && imageBase
      ? imageBase === chatBase
        ? chatCached
        : await loadCachedModelsForBase(imageBase)
      : { models: [] };
  const groups = buildProviderPickerGroups(provider, {
    chat: chatModelsFromList(Array.isArray(chatCached.models) ? chatCached.models : []),
    image: imageModelsFromList(Array.isArray(imageCached.models) ? imageCached.models : [])
  });
  return {
    chat: groups.chat,
    image: groups.image,
    chatTotal: groups.chat.length,
    imageTotal: groups.image.length
  };
}

/** Accordion: which inference API is expanded in the composer picker. null = active provider. */
let modelPickerOpenId = null;
/** In-memory 推理 / 生图 collapse. Default expand when that list exists. */
const modelPickerPaneOpen = { chat: true, image: true };
/** Per-list search. Chat query never filters 生图, and vice versa. */
const modelPickerPaneQuery = { chat: '', image: '' };
/** In-row picker probe. One provider at a time. */
const modelPickerProbe = { id: '', busy: false, error: '' };

function wireModelPaneSearch(search) {
  if (!search || search.dataset.wired) return;
  search.dataset.wired = '1';
  search.addEventListener('click', (e) => e.stopPropagation());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setModelSubmenuOpen(false);
      setModelSelectOpen(true);
      return;
    }
    e.stopPropagation();
  });
}

async function renderModelPickerList() {
  const list = $('modelSelectList');
  const select = $('modelSelect');
  if (!list) return;
  list.innerHTML = '';
  let providers = [];
  let activeProviderId = null;
  try {
    const state = await loadProvidersState();
    providers = Array.isArray(state.providers) ? state.providers : [];
    activeProviderId = state.activeProviderId || null;
  } catch (_) {}
  const addItem = (host, id, label, providerId, kind) => {
    const mid = String(id || '').trim();
    if (!mid) return;
    const isImage = kind === 'image';
    const sameProvider = !providerId || providerId === activeProviderId;
    const isActive = isImage
      ? sameProvider && mid === selectedImageModel
      : sameProvider && mid === (select?.value || selectedModel);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-select-item' + (isActive ? ' is-active' : '');
    btn.setAttribute('role', 'option');
    btn.dataset.value = mid;
    btn.dataset.kind = isImage ? 'image' : 'chat';
    btn.textContent = label || mid;
    btn.title = mid;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isImage) void pickComposerImageModel(mid, providerId);
      else void pickComposerModel(mid, providerId);
    });
    const li = document.createElement('li');
    li.appendChild(btn);
    host.appendChild(li);
  };
  const addPane = (host, kind, title, items, providerId, currentId) => {
    if (!items.length) return;
    const paneOpen = modelPickerPaneOpen[kind] !== false;
    const pane = document.createElement('section');
    pane.className = 'model-select-pane' + (paneOpen ? ' is-open' : '');
    pane.dataset.kind = kind;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'model-select-pane-toggle';
    head.setAttribute('aria-expanded', paneOpen ? 'true' : 'false');
    const caret = document.createElement('span');
    caret.className = 'model-select-pane-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = paneOpen ? '▾' : '▸';
    const lab = document.createElement('span');
    lab.className = 'model-select-pane-label';
    lab.textContent = title;
    head.append(caret, lab);
    const currentShort = shortModelId(currentId);
    if (currentShort) {
      const cur = document.createElement('span');
      cur.className = 'model-select-pane-current';
      cur.textContent = currentShort;
      cur.title = String(currentId || '');
      head.appendChild(cur);
    }

    const body = document.createElement('div');
    body.className = 'model-select-pane-body';
    body.hidden = !paneOpen;

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'model-select-search model-select-pane-search';
    search.dataset.kind = kind;
    search.setAttribute(
      'placeholder',
      t(kind === 'image' ? 'modelPickerSearchImage' : 'modelPickerSearchChat')
    );
    search.setAttribute('autocomplete', 'off');
    search.setAttribute(
      'aria-label',
      t(kind === 'image' ? 'modelPickerSearchImage' : 'modelPickerSearchChat')
    );
    search.value = modelPickerPaneQuery[kind] || '';
    wireModelPaneSearch(search);

    const ul = document.createElement('ul');
    ul.className = 'model-select-pane-list';
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('aria-label', title);
    const empty = document.createElement('div');
    empty.className = 'model-select-empty model-select-pane-empty';
    empty.hidden = true;

    const paintList = () => {
      const q = String(search.value || '').trim();
      modelPickerPaneQuery[kind] = q;
      const preferIds = [currentId].filter(Boolean);
      if (kind === 'image') {
        if (selectedImageModel) preferIds.push(selectedImageModel);
      } else if (selectedModel) {
        preferIds.push(selectedModel);
      }
      const shrunk = filterPickerGroup(items, q, {
        limit: q ? 24 : 40,
        preferIds
      });
      ul.innerHTML = '';
      const seen = new Set();
      for (const m of shrunk.items) {
        const mid = String(m?.id || '').trim();
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        addItem(ul, mid, m.name || mid, providerId, kind);
      }
      const none = !shrunk.items.length;
      empty.hidden = !none;
      empty.textContent = q ? t('modelPickerNoMatch') : t('modelPickerEmpty');
      ul.hidden = none;
    };
    search.addEventListener('input', paintList);
    paintList();

    head.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !pane.classList.contains('is-open');
      modelPickerPaneOpen[kind] = next;
      pane.classList.toggle('is-open', next);
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      caret.textContent = next ? '▾' : '▸';
      body.hidden = !next;
      if (!next && body.contains(document.activeElement)) head.focus();
    });

    body.append(search, ul, empty);
    pane.append(head, body);
    host.appendChild(pane);
  };
  let any = false;
  const rows = providers.length ? providers : [{ id: '', name: '', model: select?.value || selectedModel }];
  const accordion = rows.length > 1;
  const openId =
    modelPickerOpenId === null ? activeProviderId || rows[0]?.id || '' : modelPickerOpenId;
  for (const p of rows) {
    const pack = await modelsForProvider(p);
    const expanded = accordion ? p.id === openId : true;
    const n = (pack.chatTotal || pack.chat.length) + (pack.image.length ? pack.imageTotal : 0);
    const wrap = document.createElement('div');
    wrap.className = 'model-select-provider';
    wrap.dataset.providerId = p.id || '';

    const row = document.createElement('div');
    row.className = 'model-select-group-row';

    if (p.id && accordion) {
      const groupBtn = document.createElement('button');
      groupBtn.type = 'button';
      groupBtn.className =
        'model-select-group' +
        (expanded ? ' is-open' : '') +
        (p.id === activeProviderId ? ' is-active' : '');
      const caret = document.createElement('span');
      caret.className = 'model-select-group-caret';
      caret.textContent = expanded ? '▾' : '▸';
      const lab = document.createElement('span');
      lab.className = 'model-select-group-label';
      lab.textContent = `${p.name || p.id || 'API'} · ${n}`;
      groupBtn.append(caret, lab);
      groupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modelPickerOpenId = p.id === openId ? '' : p.id;
        void renderModelPickerList();
      });
      row.appendChild(groupBtn);
    } else if (p.id) {
      const lab = document.createElement('div');
      lab.className = 'model-select-group is-static' + (p.id === activeProviderId ? ' is-active' : '');
      const name = document.createElement('span');
      name.className = 'model-select-group-label';
      name.textContent = `${p.name || p.id || 'API'} · ${n}`;
      lab.appendChild(name);
      row.appendChild(lab);
    }

    if (p.id) {
      const probeBtn = document.createElement('button');
      probeBtn.type = 'button';
      probeBtn.className = 'model-select-probe';
      const probing = modelPickerProbe.busy && modelPickerProbe.id === p.id;
      probeBtn.disabled = probing;
      probeBtn.setAttribute('aria-label', t('modelPickerProbe'));
      probeBtn.title = t('modelPickerProbeHint');
      probeBtn.textContent = probing ? t('modelPickerProbing') : t('modelPickerProbe');
      probeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onPickerProbeProvider(p);
      });
      probeBtn.addEventListener('keydown', (e) => e.stopPropagation());
      row.appendChild(probeBtn);
    }
    if (row.childElementCount) wrap.appendChild(row);

    if (modelPickerProbe.error && modelPickerProbe.id === p.id && !modelPickerProbe.busy) {
      const err = document.createElement('p');
      err.className = 'model-select-probe-err';
      err.textContent = t('apiProbeFail').replace('{err}', modelPickerProbe.error);
      wrap.appendChild(err);
    }

    list.appendChild(wrap);
    if (!expanded) continue;
    const body = document.createElement('div');
    body.className = 'model-select-group-body';
    const sameProvider = !p.id || p.id === activeProviderId;
    const chatCurrent = sameProvider ? select?.value || selectedModel || p.model : p.model;
    const imageCurrent = sameProvider ? selectedImageModel || p.image?.model : p.image?.model;
    addPane(body, 'chat', t('modelPickerChat'), pack.chat, p.id, chatCurrent);
    addPane(body, 'image', t('modelPickerImage'), pack.image, p.id, imageCurrent);
    if (body.childElementCount) wrap.appendChild(body);
    any = any || pack.chat.length > 0 || pack.image.length > 0;
  }
  if (!any) {
    const empty = document.createElement('div');
    empty.className = 'model-select-empty';
    empty.textContent = t('modelPickerEmpty');
    list.appendChild(empty);
    const fallback = select?.value || selectedModel;
    if (fallback) {
      const body = document.createElement('div');
      body.className = 'model-select-group-body';
      addPane(body, 'chat', t('modelPickerChat'), [{ id: fallback, name: fallback }], activeProviderId, fallback);
      list.appendChild(body);
    }
  }
}

function paintPickerProbeRow(providerId, { busy, error } = {}) {
  const wrap = document.querySelector(
    `#modelSelectList .model-select-provider[data-provider-id="${CSS.escape(String(providerId || ''))}"]`
  );
  if (!wrap) return;
  const btn = wrap.querySelector('.model-select-probe');
  if (btn) {
    btn.disabled = !!busy;
    btn.textContent = busy ? t('modelPickerProbing') : t('modelPickerProbe');
  }
  let err = wrap.querySelector('.model-select-probe-err');
  const msg = !busy && error ? t('apiProbeFail').replace('{err}', error) : '';
  if (msg) {
    if (!err) {
      err = document.createElement('p');
      err.className = 'model-select-probe-err';
      wrap.insertBefore(err, wrap.querySelector('.model-select-group-body'));
    }
    err.textContent = msg;
  } else if (err) {
    err.remove();
  }
}

async function onPickerProbeProvider(provider) {
  const id = String(provider?.id || '').trim();
  if (!id || modelPickerProbe.busy) return;
  modelPickerProbe.id = id;
  modelPickerProbe.busy = true;
  modelPickerProbe.error = '';
  modelPickerOpenId = id;
  paintPickerProbeRow(id, { busy: true });
  const result = await probeAndPersistProviderCatalog(provider);
  modelPickerProbe.busy = false;
  if (result.ok) {
    modelPickerProbe.error = '';
    if (settingsConfigUi.providerId === id) {
      settingsProbedModels = result.chat;
      catalogModels = result.chat;
      settingsProbedImageModels = result.image;
      fillModelDatalist(result.chat);
      renderSettingsModelCatalog();
      renderSettingsImageCatalog();
      paintProbeResult({ ok: true, count: result.chat.length });
      syncReasoningSwitch();
    }
    await renderModelPickerList();
    return;
  }
  const err = String(result.error || 'error');
  modelPickerProbe.error = err;
  paintPickerProbeRow(id, { error: err });
}

function setModelSubmenuOpen(open) {
  const sub = $('modelSelectSubmenu');
  const btn = $('modelSelectTrigger');
  const root = $('modelSelectRoot');
  if (!sub || !btn) return;
  const next = !!open;
  if (next) {
    setModelSelectOpen(false);
    modelPickerPaneQuery.chat = '';
    modelPickerPaneQuery.image = '';
    if (selectedImageModel) modelPickerPaneOpen.image = true;
    void renderModelPickerList().then(() => {
      if (sub.hidden) return;
      positionFloatingMenu(sub, btn, { preferUp: true });
      sub.querySelector('.model-select-pane.is-open .model-select-pane-search')?.focus();
    });
    sub.hidden = false;
    root?.classList.add('is-picking');
    if (sub.parentElement !== document.body) document.body.appendChild(sub);
    positionFloatingMenu(sub, btn, { preferUp: true });
  } else {
    sub.hidden = true;
    root?.classList.remove('is-picking');
    if (sub.parentElement === document.body && root) {
      root.appendChild(sub);
      sub.style.position = '';
      sub.style.left = '';
      sub.style.top = '';
      sub.style.minWidth = '';
      sub.style.zIndex = '';
      sub.style.maxHeight = '';
    }
  }
}

function setModelSelectOpen(open) {
  const menu = $('modelSelectMenu');
  const btn = $('modelSelectTrigger');
  const root = $('modelSelectRoot');
  if (!menu || !btn) return;
  const next = !!open;
  if (next) renderModelSelectMenu();
  menu.hidden = !next;
  btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  root?.classList.toggle('is-open', next);
  if (next) {
    setModelSubmenuOpen(false);
    setGroupSelectOpen(false);
    setSessionBindMenuOpen(false);
    setArtifactRailOpen(false);
    if (menu.parentElement !== document.body) {
      document.body.appendChild(menu);
    }
    positionFloatingMenu(menu, btn, { preferUp: true });
  } else if (menu.parentElement === document.body && root) {
    root.appendChild(menu);
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.minWidth = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
  }
}

function wireModelSelectUi() {
  const trigger = $('modelSelectTrigger');
  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('modelSelectMenu');
      const sub = $('modelSelectSubmenu');
      if (sub && !sub.hidden) {
        setModelSubmenuOpen(false);
        return;
      }
      setModelSelectOpen(!!menu?.hidden);
    });
  }
  $('modelSelectOpenList')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setModelSubmenuOpen(true);
  });
  $('modelSelectBack')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setModelSubmenuOpen(false);
    setModelSelectOpen(true);
  });
  document.addEventListener('click', (e) => {
    const root = $('modelSelectRoot');
    const menu = $('modelSelectMenu');
    const sub = $('modelSelectSubmenu');
    const t = e.target;
    const inBtn = root?.contains(t);
    const inMenu = menu && !menu.hidden && menu.contains(t);
    const inSub = sub && !sub.hidden && sub.contains(t);
    if (!inBtn && !inMenu && !inSub) {
      setModelSelectOpen(false);
      setModelSubmenuOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const sub = $('modelSelectSubmenu');
    if (sub && !sub.hidden) {
      setModelSubmenuOpen(false);
      setModelSelectOpen(true);
      return;
    }
    setModelSelectOpen(false);
  });
  renderModelSelectMenu();
}

/**
 * Sync toolbar + selectedModel from active provider after settings changes.
 */
async function syncToolbarFromActiveProvider() {
  try {
    const settings = await loadLlmSettings();
    if (settings?.model) {
      ensureModelOption(settings.model);
      chrome.storage.local.set({ selected_model: settings.model });
    }
    selectedImageModel = settings?.image?.enabled ? String(settings.image.model || '') : '';
    renderModelSelectMenu();
  } catch (_) {}
}

/**
 * Image Base URL / Key stay visible (inherit-if-empty). Refresh the status chip.
 */
function syncImageSectionVisibility() {
  const custom = document.getElementById('imageCustomApiFields');
  if (custom) custom.hidden = false;
  refreshImageGenChip();
}

function refreshImageGenStatusLine(imageCount = 0) {
  const line = document.getElementById('imageGenStatusLine');
  if (!line) return;
  const en = currentLang === 'en';
  if (!imageCount) {
    line.textContent = en
      ? 'No image API yet. Attach one to a chat vendor, or use a separate Base / Key.'
      : '未添加生图 API。可挂在某个推理供应商上，或使用独立 Base / Key。';
    return;
  }
  line.textContent = en
    ? 'Tap a card to edit. Image gen follows the attached chat vendor.'
    : '点卡片编辑。生图挂在对应推理供应商上。';
}

async function refreshImageGenChip() {
  const btn = document.getElementById('imageGenChipBtn');
  if (!btn) return;
  let enabled = !!document.getElementById('providerImageEnabledCheck')?.checked;
  let model = document.getElementById('providerImageModelInput')?.value?.trim() || '';
  if (!document.getElementById('agentSettingsModal')?.open) {
    try {
      const settings = await loadLlmSettings();
      enabled = !!settings?.image?.enabled;
      model = settings?.image?.model || model;
    } catch {
      /* keep form values */
    }
  }
  btn.classList.toggle('is-on', enabled);
  btn.textContent = enabled
    ? currentLang === 'en'
      ? `Img · ${(model || 'on').split('/').pop()}`
      : `生图 · ${(model || '开').split('/').pop()}`
    : currentLang === 'en'
      ? 'Img · off'
      : '生图 · 关';
  btn.title = enabled
    ? currentLang === 'en'
      ? 'Image generation on — click to configure'
      : '生图已启用 · 点击修改模型'
    : currentLang === 'en'
      ? 'Image generation off — click to enable OpenRouter'
      : '生图未启用 · 点击配置 OpenRouter';
}

/**
 * One-tap image presets. OpenRouter is the product default (MiniMax keys expire).
 * @param {'openrouter'|'minimax'} presetId
 */
function applyImagePreset(presetId) {
  const enabled = document.getElementById('providerImageEnabledCheck');
  const protocol = document.getElementById('providerImageProtocolInput');
  const model = document.getElementById('providerImageModelInput');
  const path = document.getElementById('providerImagePathInput');
  const imgBase = document.getElementById('providerImageBaseInput');
  const imgKey = document.getElementById('providerImageKeyInput');
  const chatBase = document.getElementById('apiBaseInput')?.value?.trim() || '';

  if (enabled) enabled.checked = true;

  if (presetId === 'openrouter') {
    if (protocol) protocol.value = 'openrouter-image';
    if (model) model.value = 'google/gemini-2.5-flash-image';
    if (path) path.value = '/images';
    if (imgKey && !settingsImageUi.hasStoredKey) imgKey.placeholder = 'inherit chat / 与推理相同';
    if (imgBase) imgBase.value = OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1';
  } else if (presetId === 'openai') {
    if (protocol) protocol.value = 'openai-image';
    if (model) model.value = 'gpt-image-1';
    if (path) path.value = '/images/generations';
    if (imgKey && !settingsImageUi.hasStoredKey) imgKey.placeholder = 'inherit chat / 与推理相同';
    if (imgBase && !/api\.openai\.com/i.test(chatBase)) {
      imgBase.value = 'https://api.openai.com/v1';
    }
  } else if (presetId === 'openai-compatible') {
    if (protocol) protocol.value = 'openai-image';
    if (path) path.value = '/images/generations';
    if (imgKey && !settingsImageUi.hasStoredKey) imgKey.placeholder = 'inherit chat / 与推理相同';
  } else if (presetId === 'minimax') {
    if (protocol) protocol.value = 'minimax-image';
    if (model) model.value = DEFAULT_IMAGE_MODEL || 'image-01';
    if (path) path.value = DEFAULT_IMAGE_PATH || '/image_generation';
    if (imgKey && !settingsImageUi.hasStoredKey) imgKey.placeholder = 'eyJ... / API key';
  }
  document.querySelectorAll('#imagePresetRow [data-image-preset]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-image-preset') === presetId);
  });
  syncImageSectionVisibility();
}

/**
 * Mark active preset chip (visual only).
 * @param {string|null} presetId
 */
function setActivePresetChip(presetId) {
  document.querySelectorAll('#inferencePresetRow .provider-preset-chip').forEach((btn) => {
    const id = btn.getAttribute('data-preset');
    btn.classList.toggle('active', !!presetId && id === presetId);
  });
}

/**
 * Guess which preset matches current form values (for chip highlight).
 * @param {{ baseURL?: string, model?: string, name?: string }} p
 */
function guessPresetId(p) {
  const base = (p?.baseURL || '').replace(/\/$/, '').toLowerCase();
  const model = (p?.model || '').toLowerCase();
  const name = (p?.name || '').toLowerCase();
  const presets = PROVIDER_PRESETS || [];
  for (const pr of presets) {
    if (!pr.baseURL) continue;
    const pb = pr.baseURL.replace(/\/$/, '').toLowerCase();
    if (base && base === pb) return pr.id;
  }
  if (name.includes('deepseek') || model.includes('deepseek')) return 'deepseek';
  if (name.includes('openrouter') || model.includes('/')) return 'openrouter';
  if (name.includes('minimax') || model.includes('minimax')) return 'minimax';
  if (name.includes('openai') || model.startsWith('gpt-')) return 'openai';
  if (!base) return 'openai-compatible';
  return null;
}

/**
 * Fill the simple two-block form from active provider (or defaults).
 * @param {object|null} provider
 * @param {{ isNew?: boolean }} [opts]
 */
function fillSettingsForm(provider, opts = {}) {
  const isNew = !!opts.isNew;
  const baseInput = document.getElementById('apiBaseInput');
  const keyInput = document.getElementById('apiKeyInput');
  const modelInput = document.getElementById('providerModelInput');
  const imgEnabled = document.getElementById('providerImageEnabledCheck');
  const imgBase = document.getElementById('providerImageBaseInput');
  const imgKey = document.getElementById('providerImageKeyInput');
  const imgModel = document.getElementById('providerImageModelInput');
  const imgPath = document.getElementById('providerImagePathInput');
  const imgProtocol = document.getElementById('providerImageProtocolInput');
  const hint = document.getElementById('settingsApiHint');

  const baseURL =
    provider?.baseURL ||
    (!isNew ? DEFAULT_BASE : '') ||
    DEFAULT_BASE ||
    'https://api.deepseek.com/v1';
  const model = provider?.model || 'deepseek-v4-flash';

  if (baseInput) baseInput.value = provider?.baseURL != null ? provider.baseURL : isNew ? '' : baseURL;
  if (modelInput) modelInput.value = provider?.model != null ? provider.model : isNew ? '' : model;

  settingsConfigUi.providerId = provider?.id || null;
  settingsConfigUi.providerName = provider?.name || 'Provider';
  settingsConfigUi.createdAt = provider?.createdAt || null;
  settingsConfigUi.hasStoredKey = !!(provider?.apiKey);
  settingsConfigUi.keyTail = provider?.apiKey ? String(provider.apiKey).slice(-4) : '';

  if (keyInput) {
    keyInput.value = '';
    if (settingsConfigUi.hasStoredKey) {
      keyInput.placeholder = `已配置 (…${settingsConfigUi.keyTail}) — 留空则保持不变`;
    } else {
      keyInput.placeholder = 'sk-...（尚未配置）';
    }
  }
  // Image: empty baseURL / apiKey inherit chat; OpenRouter template prefills the known origin
  const img =
    provider?.image && typeof provider.image === 'object'
      ? provider.image
      : typeof defaultImageConfig === 'function'
        ? defaultImageConfig()
        : {
            enabled: false,
            protocol: DEFAULT_IMAGE_PROTOCOL || 'minimax-image',
            path: DEFAULT_IMAGE_PATH || '/image_generation',
            model: DEFAULT_IMAGE_MODEL || 'image-01'
          };

  const imageBaseStored =
    typeof img.baseURL === 'string' && img.baseURL.trim() ? img.baseURL.trim().replace(/\/$/, '') : '';

  settingsImageUi.hasStoredKey = !!(img.apiKey);
  settingsImageUi.keyTail = img.apiKey ? String(img.apiKey).slice(-4) : '';

  if (imgEnabled) imgEnabled.checked = !!img.enabled;
  const looksOr =
    /openrouter/i.test(String(img.protocol || '')) ||
    /openrouter\.ai/i.test(imageBaseStored) ||
    /openrouter\.ai/i.test(String(provider?.baseURL || ''));
  if (imgBase) {
    imgBase.value =
      imageBaseStored ||
      (looksOr ? OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1' : '');
    imgBase.placeholder = 'inherit chat / 与推理相同';
  }
  if (imgKey) {
    imgKey.value = '';
    imgKey.placeholder = settingsImageUi.hasStoredKey
      ? `已配置 (…${settingsImageUi.keyTail}) — 留空则保持不变`
      : 'inherit chat / 与推理相同';
  }
  if (imgProtocol) {
    imgProtocol.value = img.protocol || (looksOr ? 'openrouter-image' : DEFAULT_IMAGE_PROTOCOL || 'openrouter-image');
  }
  if (imgModel) {
    imgModel.value =
      img.model || (looksOr ? 'google/gemini-2.5-flash-image' : DEFAULT_IMAGE_MODEL || 'image-01');
    imgModel.placeholder = looksOr ? 'google/gemini-2.5-flash-image' : DEFAULT_IMAGE_MODEL || 'image-01';
  }
  if (imgPath) {
    imgPath.value = img.path || (looksOr ? '/images' : DEFAULT_IMAGE_PATH || '/image_generation');
    imgPath.placeholder = looksOr ? '/images' : DEFAULT_IMAGE_PATH || '/image_generation';
  }

  syncImageSectionVisibility();
  setActivePresetChip(guessPresetId(provider || { baseURL: baseInput?.value, model: modelInput?.value }));

  if (hint) {
    hint.textContent = settingsLangEn()
      ? 'Key stays on this device. Probe the API to list models; switching models does not re-bind Base / Key.'
      : 'Key 仅存本机。探测 API 可列出模型；同一 Key 下切换模型不必重填 Base / Key。';
  }
  void hydrateSettingsModelCatalog(provider);
}

/**
 * Apply a PROVIDER_PRESETS template into the form (no storage write).
 * @param {string} presetId
 */
function applyInferencePreset(presetId) {
  const id = presetId === 'custom' ? 'openai-compatible' : presetId;
  const preset = (PROVIDER_PRESETS || []).find((p) => p.id === id);
  if (!preset) return;

  const baseInput = document.getElementById('apiBaseInput');
  const keyInput = document.getElementById('apiKeyInput');
  const modelInput = document.getElementById('providerModelInput');

  if (baseInput) baseInput.value = preset.baseURL || '';
  if (modelInput) modelInput.value = preset.model || '';
  settingsConfigUi.providerName = preset.name || settingsConfigUi.providerName || 'Provider';

  if (keyInput) {
    // Keep empty value (don't wipe stored key semantics on save); update placeholder only
    if (preset.apiKeyPlaceholder && !settingsConfigUi.hasStoredKey) {
      keyInput.placeholder = preset.apiKeyPlaceholder;
    } else if (preset.apiKeyPlaceholder && settingsConfigUi.hasStoredKey) {
      keyInput.placeholder = `已配置 (…${settingsConfigUi.keyTail}) — 留空则保持不变`;
    } else if (!settingsConfigUi.hasStoredKey) {
      keyInput.placeholder = 'sk-...';
    }
  }

  // Soft-suggest image defaults from the chat template (do not force enable)
  if (preset.image && typeof preset.image === 'object') {
    const imgModel = document.getElementById('providerImageModelInput');
    const imgPath = document.getElementById('providerImagePathInput');
    const imgBase = document.getElementById('providerImageBaseInput');
    const imgProtocol = document.getElementById('providerImageProtocolInput');
    if (imgModel && (!imgModel.value || preset.id === 'minimax' || preset.id === 'openrouter')) {
      imgModel.value = preset.image.model || DEFAULT_IMAGE_MODEL || 'image-01';
    }
    if (imgPath && preset.image.path) {
      imgPath.value = preset.image.path;
    }
    if (imgProtocol && preset.image.protocol) {
      imgProtocol.value = preset.image.protocol;
    }
    if (imgBase && preset.image.baseURL) {
      imgBase.value = String(preset.image.baseURL).replace(/\/$/, '');
    }
  }

  setActivePresetChip(id);

  // Focus API key so user can type immediately
  if (keyInput) {
    keyInput.focus();
    try {
      keyInput.select();
    } catch (_) {}
  }

  const hint = document.getElementById('settingsApiHint');
  if (hint) {
    hint.textContent = `已填入 ${preset.name || id} 模板。请填写 API Key 后点「保存配置」。`;
  }
}

/**
 * Resolve API key for model refresh: form input, else stored active key.
 * @returns {string}
 */
function resolveEditorApiKey() {
  const typed = document.getElementById('apiKeyInput')?.value?.trim() || '';
  if (typed) return typed;
  // load from in-memory ui after open (we don't keep full key in DOM)
  // Callers that need key for /models should have typed it or we re-load storage.
  return '';
}

/**
 * Optional: GET /models and fill datalist suggestions only (no giant catalog).
 */
let settingsProbedModels = [];
let settingsProbedImageModels = [];

function paintProbeResult(result) {
  const el = document.getElementById('apiProbeResult');
  if (!el) return;
  if (!result) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-ok', 'is-err');
    return;
  }
  el.hidden = false;
  el.classList.toggle('is-ok', result.ok === true);
  el.classList.toggle('is-err', result.ok !== true);
  if (result.ok) {
    const n = Number(result.count) || 0;
    el.textContent = t('apiProbeOk').replace('{n}', String(n));
    if (result.fromCache) {
      el.textContent += settingsLangEn() ? ' (cached)' : '（已缓存）';
    }
  } else {
    el.textContent = t('apiProbeFail').replace('{err}', String(result.error || 'error'));
  }
}

function fillModelDatalist(models) {
  const dl = document.getElementById('providerModelSuggestions');
  if (!dl) return;
  const current = document.getElementById('providerModelInput')?.value?.trim() || '';
  const keep = [];
  const seen = new Set();
  const push = (id) => {
    const s = String(id || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    keep.push(s);
  };
  if (current) push(current);
  for (const m of models || []) push(m.id || m);
  dl.innerHTML = '';
  for (const id of keep.slice(0, 80)) {
    const opt = document.createElement('option');
    opt.value = id;
    dl.appendChild(opt);
  }
}

function renderSettingsModelCatalog() {
  const box = document.getElementById('providerModelCatalog');
  const filter = document.getElementById('providerModelFilter');
  const current = document.getElementById('providerModelInput')?.value?.trim() || '';
  const models = Array.isArray(settingsProbedModels) ? settingsProbedModels : [];
  if (!box) return;
  if (!models.length) {
    box.hidden = true;
    if (filter) filter.hidden = true;
    return;
  }
  if (filter) filter.hidden = false;
  box.hidden = false;
  const query = String(filter?.value || '').trim();
  const shrunk = shrinkModelList(models, { query, limit: 40, preferIds: [current] });
  box.replaceChildren();
  for (const m of shrunk.items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'api-model-catalog-item' + (m.id === current ? ' is-on' : '');
    btn.setAttribute('role', 'option');
    btn.textContent = m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id;
    btn.title = m.id;
    btn.addEventListener('click', () => {
      const input = document.getElementById('providerModelInput');
      if (input) input.value = m.id;
      void persistComposerModel(m.id, settingsConfigUi.providerId);
      ensureModelOption(m.id);
      renderSettingsModelCatalog();
    });
    box.appendChild(btn);
  }
  if (shrunk.truncated) {
    const more = document.createElement('div');
    more.className = 'api-model-catalog-more';
    more.textContent = settingsLangEn()
      ? `${shrunk.total} models · showing ${shrunk.items.length}. Type to filter.`
      : `共 ${shrunk.total} 个 · 显示 ${shrunk.items.length} 个，输入关键字筛选。`;
    box.appendChild(more);
  }
}

async function hydrateSettingsModelCatalog(provider) {
  const base = String(provider?.baseURL || document.getElementById('apiBaseInput')?.value || '').trim();
  if (!base) {
    settingsProbedModels = [];
    renderSettingsModelCatalog();
    paintProbeResult(provider?.lastProbe || null);
    return;
  }
  try {
    const cached = await loadCachedModelsForBase(base);
    if (cached.models.length) {
      const chat = chatModelsFromList(cached.models);
      settingsProbedModels = chat.length ? chat : cached.models;
      catalogModels = settingsProbedModels;
      fillModelDatalist(settingsProbedModels);
      renderSettingsModelCatalog();
      settingsProbedImageModels = imageModelsFromList(cached.models);
      renderSettingsImageCatalog();
      paintProbeResult({
        ok: true,
        count: settingsProbedModels.length,
        fromCache: true
      });
      if (settingsProbedImageModels.length) {
        paintImageProbeResult({
          ok: true,
          count: settingsProbedImageModels.length,
          fromCache: true
        });
      }
      return;
    }
  } catch (_) {}
  settingsProbedModels = [];
  renderSettingsModelCatalog();
  paintProbeResult(provider?.lastProbe || null);
}

async function persistProbeOnProvider(probe, providerId = settingsConfigUi.providerId) {
  const id = providerId;
  if (!id || !probe) return;
  try {
    const state = await loadProvidersState();
    const host = (state.providers || []).find((p) => p.id === id);
    if (!host) return;
    const applied = applyProviderProbeResult(host, probe);
    await upsertProvider(
      {
        ...host,
        lastProbe: applied.lastProbe
      },
      { makeActive: false }
    );
  } catch (_) {}
}

/**
 * Shared BYOK GET /models probe. Settings and composer picker both call this.
 * Writes catalog cache + lastProbe. Does not change current model ids.
 *
 * @param {{ id?: string, baseURL?: string, apiKey?: string, image?: object }} provider
 * @returns {Promise<{ ok: boolean, models: any[], chat: any[], image: any[], count: number, error?: string, endpoint?: string }>}
 */
async function probeAndPersistProviderCatalog(provider) {
  const baseURL = String(provider?.baseURL || '').trim().replace(/\/$/, '');
  const apiKey = String(provider?.apiKey || '').trim();
  const empty = { ok: false, models: [], chat: [], image: [], count: 0 };
  if (!baseURL) {
    return {
      ...empty,
      error: settingsLangEn() ? 'Enter Base URL first.' : '请先填写 Base URL。'
    };
  }
  if (/image_generation/i.test(baseURL)) {
    return {
      ...empty,
      error: settingsLangEn()
        ? 'Base URL cannot be an image_generation path.'
        : 'Base URL 不能是 image_generation 路径。'
    };
  }
  if (!apiKey) {
    return {
      ...empty,
      error: settingsLangEn() ? 'API key required.' : '需要 API Key。'
    };
  }

  const probe = await probeOpenAICompatibleApi(baseURL, apiKey);
  const applied = applyProviderProbeResult(provider, probe);
  if (probe.ok) {
    try {
      await cacheModelsForBase(baseURL, probe.models);
    } catch (_) {}
    const imageBase = String(provider?.image?.baseURL || '').trim().replace(/\/$/, '');
    if (provider?.image?.enabled && imageBase && imageBase !== baseURL) {
      const imageKey = String(provider.image.apiKey || apiKey).trim();
      if (imageKey) {
        try {
          const images = await fetchImageGenModels(imageBase, imageKey);
          if (images.length) {
            try {
              await cacheModelsForBase(imageBase, images);
            } catch (_) {}
            applied.catalog.image = images;
          }
        } catch (_) {}
      }
    }
    await persistProbeOnProvider({ ...probe, count: applied.catalog.chat.length }, provider?.id);
    return {
      ok: true,
      endpoint: probe.endpoint,
      models: probe.models,
      chat: applied.catalog.chat,
      image: applied.catalog.image,
      count: applied.catalog.chat.length
    };
  }
  await persistProbeOnProvider(probe, provider?.id);
  return { ...probe, chat: [], image: [] };
}

async function onRefreshChatModelsClick() {
  const baseURL = document.getElementById('apiBaseInput')?.value?.trim() || '';
  const hintEl = document.getElementById('settingsApiHint');
  const btn = document.getElementById('providerModelRefreshBtn');
  if (!baseURL) {
    paintProbeResult({ ok: false, error: settingsLangEn() ? 'Enter Base URL first.' : '请先填写 Base URL。' });
    if (hintEl) hintEl.textContent = settingsLangEn() ? 'Enter Base URL, then probe.' : '请先填写 Base URL，再探测 API。';
    document.getElementById('apiBaseInput')?.focus();
    return;
  }
  if (/image_generation/i.test(baseURL)) {
    paintProbeResult({
      ok: false,
      error: settingsLangEn()
        ? 'Base URL cannot be an image_generation path.'
        : 'Base URL 不能是 image_generation 路径。'
    });
    return;
  }

  let apiKey = resolveEditorApiKey();
  if (!apiKey && settingsConfigUi.providerId) {
    try {
      const state = await loadProvidersState();
      const p = (state.providers || []).find((x) => x.id === settingsConfigUi.providerId);
      apiKey = (p?.apiKey && String(p.apiKey)) || '';
    } catch (_) {}
  }
  if (!apiKey) {
    paintProbeResult({
      ok: false,
      error: settingsLangEn() ? 'API key required.' : '需要 API Key。'
    });
    if (hintEl) hintEl.textContent = settingsLangEn() ? 'Need an API key to probe /models.' : '需要 API Key 才能探测 /models。';
    document.getElementById('apiKeyInput')?.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = settingsLangEn() ? 'Probing…' : '探测中…';
  }
  paintProbeResult(null);
  if (hintEl) hintEl.textContent = 'GET /models …';

  let image = undefined;
  try {
    const state = await loadProvidersState();
    const host = (state.providers || []).find((x) => x.id === settingsConfigUi.providerId);
    image = host?.image;
  } catch (_) {}
  const probe = await probeAndPersistProviderCatalog({
    id: settingsConfigUi.providerId,
    baseURL,
    apiKey,
    image
  });
  try {
    if (probe.ok) {
      settingsProbedModels = probe.chat.length ? probe.chat : probe.models.filter((m) => !m.image);
      catalogModels = settingsProbedModels;
      fillModelDatalist(settingsProbedModels);
      renderSettingsModelCatalog();
      settingsProbedImageModels = probe.image;
      renderSettingsImageCatalog();
      paintProbeResult({ ...probe, count: settingsProbedModels.length });
      const modelInput = document.getElementById('providerModelInput');
      if (modelInput && !modelInput.value.trim() && probe.models[0]?.id) {
        modelInput.value = probe.models[0].id;
      }
      syncReasoningSwitch();
      await refreshVendorBoards();
      if (hintEl) {
        hintEl.textContent = settingsLangEn()
          ? 'Same key: switch model id above or in the composer. No need to re-enter Base / Key.'
          : '同一 Key 下在上方或聊天框切换模型即可，不必重填 Base / Key。';
      }
    } else {
      settingsProbedModels = [];
      renderSettingsModelCatalog();
      paintProbeResult(probe);
      if (hintEl) hintEl.textContent = probe.error || 'probe failed';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('apiProbeBtn');
    }
  }
}

function paintImageProbeResult(result) {
  const el = document.getElementById('imageProbeResult');
  if (!el) return;
  if (!result) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-ok', 'is-err');
    return;
  }
  el.hidden = false;
  el.classList.toggle('is-ok', result.ok === true);
  el.classList.toggle('is-err', result.ok !== true);
  if (result.ok && result.count > 0) {
    el.textContent = t('apiProbeImageOk').replace('{n}', String(result.count));
    if (result.fromCache) el.textContent += settingsLangEn() ? ' (cached)' : '（已缓存）';
  } else if (result.ok) {
    el.textContent = t('apiProbeImageNone');
  } else {
    el.textContent = t('apiProbeFail').replace('{err}', String(result.error || 'error'));
  }
}

function renderSettingsImageCatalog() {
  const box = document.getElementById('providerImageCatalog');
  const filter = document.getElementById('providerImageModelFilter');
  const current = document.getElementById('providerImageModelInput')?.value?.trim() || '';
  const models = Array.isArray(settingsProbedImageModels) ? settingsProbedImageModels : [];
  if (!box) return;
  if (!models.length) {
    box.hidden = true;
    if (filter) filter.hidden = true;
    return;
  }
  if (filter) filter.hidden = false;
  box.hidden = false;
  const query = String(filter?.value || '').trim();
  const shrunk = shrinkModelList(models, { query, limit: 40, preferIds: [current] });
  box.replaceChildren();
  for (const m of shrunk.items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'api-model-catalog-item' + (m.id === current ? ' is-on' : '');
    btn.textContent = m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id;
    btn.title = m.id;
    btn.addEventListener('click', () => {
      const input = document.getElementById('providerImageModelInput');
      if (input) input.value = m.id;
      renderSettingsImageCatalog();
      refreshImageGenChip();
    });
    box.appendChild(btn);
  }
  if (shrunk.truncated) {
    const more = document.createElement('div');
    more.className = 'api-model-catalog-more';
    more.textContent = settingsLangEn()
      ? `${shrunk.total} image models · showing ${shrunk.items.length}`
      : `共 ${shrunk.total} 个生图模型 · 显示 ${shrunk.items.length} 个`;
    box.appendChild(more);
  }
}

async function resolveImageProbeCreds() {
  let baseURL = document.getElementById('providerImageBaseInput')?.value?.trim() || '';
  let apiKey = document.getElementById('providerImageKeyInput')?.value?.trim() || '';
  const hostId =
    settingsImageUi.providerId || settingsConfigUi.providerId;
  if ((!baseURL || !apiKey) && hostId) {
    try {
      const state = await loadProvidersState();
      const p = (state.providers || []).find((x) => x.id === hostId);
      if (!baseURL) {
        baseURL = String(p?.image?.baseURL || p?.baseURL || '');
      }
      if (!apiKey) {
        apiKey = String(p?.image?.apiKey || p?.apiKey || '');
      }
    } catch (_) {}
  }
  if (!baseURL) {
    baseURL = document.getElementById('apiBaseInput')?.value?.trim() || '';
  }
  if (!apiKey) {
    apiKey = resolveEditorApiKey();
  }
  return { baseURL: String(baseURL || '').replace(/\/$/, ''), apiKey };
}

async function hydrateSettingsImageCatalog(provider) {
  const { baseURL } = await resolveImageProbeCreds();
  const base = baseURL || String(provider?.image?.baseURL || provider?.baseURL || '').trim();
  if (!base) {
    settingsProbedImageModels = [];
    renderSettingsImageCatalog();
    paintImageProbeResult(null);
    return;
  }
  try {
    const cached = await loadCachedModelsForBase(base);
    const images = imageModelsFromList(cached.models || []);
    if (images.length) {
      settingsProbedImageModels = images;
      const dl = document.getElementById('providerImageModelSuggestions');
      if (dl) {
        dl.innerHTML = '';
        for (const m of images.slice(0, 40)) {
          const opt = document.createElement('option');
          opt.value = m.id;
          dl.appendChild(opt);
        }
      }
      renderSettingsImageCatalog();
      paintImageProbeResult({ ok: true, count: images.length, fromCache: true });
      return;
    }
  } catch (_) {}
  settingsProbedImageModels = [];
  renderSettingsImageCatalog();
  paintImageProbeResult(null);
}

async function onProbeImageModelsClick() {
  const btn = document.getElementById('providerImageProbeBtn');
  const { baseURL, apiKey } = await resolveImageProbeCreds();
  if (!baseURL) {
    paintImageProbeResult({
      ok: false,
      error: settingsLangEn() ? 'Need a Base URL (same as chat, or custom).' : '请填写 Base URL（可与推理相同）。'
    });
    return;
  }
  if (!apiKey) {
    paintImageProbeResult({
      ok: false,
      error: settingsLangEn() ? 'API key required.' : '需要 API Key。'
    });
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = settingsLangEn() ? 'Probing…' : '探测中…';
  }
  let probe;
  try {
    const images = await fetchImageGenModels(baseURL, apiKey);
    probe = { ok: true, models: images, count: images.length };
  } catch (e) {
    probe = { ok: false, models: [], count: 0, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    if (probe.ok) {
      try {
        await cacheModelsForBase(baseURL, probe.models);
      } catch (_) {}
      const images = imageModelsFromList(probe.models).length
        ? imageModelsFromList(probe.models)
        : probe.models.filter((m) => m && m.id);
      settingsProbedImageModels = images;
      const dl = document.getElementById('providerImageModelSuggestions');
      if (dl) {
        dl.innerHTML = '';
        for (const m of images.slice(0, 40)) {
          const opt = document.createElement('option');
          opt.value = m.id;
          dl.appendChild(opt);
        }
      }
      renderSettingsImageCatalog();
      paintImageProbeResult({
        ok: true,
        count: images.length
      });
      const input = document.getElementById('providerImageModelInput');
      if (input && !input.value.trim() && images[0]?.id) input.value = images[0].id;
    } else {
      settingsProbedImageModels = [];
      renderSettingsImageCatalog();
      paintImageProbeResult(probe);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('apiProbeImageBtn');
    }
  }
}

function settingsLangEn() {
  return currentLang === 'en';
}

function vendorHostFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function maskKeyTail(key) {
  const s = String(key || '');
  return s.length >= 4 ? `…${s.slice(-4)}` : '';
}

function imageVendorName(provider) {
  const img = provider?.image && typeof provider.image === 'object' ? provider.image : {};
  const proto = String(img.protocol || '');
  const base = String(img.baseURL || provider?.baseURL || '');
  if (/openrouter/i.test(proto) || /openrouter/i.test(base)) return 'OpenRouter';
  if (/minimax/i.test(proto) || /minimax/i.test(base) || /minimaxi/i.test(base)) return 'MiniMax';
  return provider?.name || 'Image';
}

function setEditorOpen(editorId, addBtnId, open) {
  const ed = document.getElementById(editorId);
  const add = document.getElementById(addBtnId);
  if (ed) ed.hidden = !open;
  if (add) add.hidden = !!open;
}

function setInferenceEditorOpen(open) {
  setEditorOpen('inferenceEditor', 'addInferenceBtn', open);
}

function setImageEditorOpen(open) {
  setEditorOpen('imageEditor', 'addImageBtn', open);
}

function setWebEditorOpen(open) {
  setEditorOpen('webAcquireEditor', 'addWebAcquireBtn', open);
}

function renderVendorCard({ name, meta, active, onSelect, onDelete }) {
  const card = document.createElement('div');
  card.className = 'api-vendor-card' + (active ? ' is-active' : '');
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'api-vendor-card-main';
  const nameEl = document.createElement('div');
  nameEl.className = 'api-vendor-name';
  const title = document.createElement('span');
  title.textContent = name;
  nameEl.appendChild(title);
  if (active) {
    const badge = document.createElement('span');
    badge.className = 'api-vendor-badge';
    badge.textContent = settingsLangEn() ? 'In use' : '使用中';
    nameEl.appendChild(badge);
  }
  const metaEl = document.createElement('div');
  metaEl.className = 'api-vendor-meta';
  metaEl.textContent = meta;
  main.append(nameEl, metaEl);
  main.addEventListener('click', onSelect);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'api-vendor-delete';
  del.setAttribute('aria-label', settingsLangEn() ? 'Delete' : '删除');
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete();
  });
  card.append(main);
  if (onDelete) card.append(del);
  return card;
}

function confirmDeleteVendor(name, onYes) {
  const label = String(name || '');
  const ok = window.confirm(
    settingsLangEn()
      ? `Remove ${label}? This only deletes the local key.`
      : `删除「${label}」？仅清除本机保存的 Key。`
  );
  if (ok) void onYes();
}

function renderInferenceVendorList(state) {
  const list = document.getElementById('inferenceVendorList');
  const hint = document.getElementById('inferenceEmptyHint');
  if (!list) return;
  list.innerHTML = '';
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  const activeId = state?.activeProviderId || null;
  if (hint) {
    hint.textContent = providers.length
      ? settingsLangEn()
        ? 'Tap a card to use and edit it.'
        : '点卡片设为当前使用并编辑。'
      : settingsLangEn()
        ? 'No chat API yet. Add a vendor below.'
        : '尚未添加推理 API。';
  }
  for (const p of providers) {
    const host = vendorHostFromUrl(p.baseURL);
    const key = maskKeyTail(p.apiKey);
    const n = p.lastProbe?.ok ? p.lastProbe.count : 0;
    const modelsBit =
      n > 0
        ? settingsLangEn()
          ? `${n} models`
          : `${n} 个模型`
        : '';
    const bits = [p.model || '', modelsBit, host, key].filter(Boolean);
    list.appendChild(
      renderVendorCard({
        name: p.name || 'Provider',
        meta: bits.join(' · '),
        active: p.id === activeId,
        onSelect: () => {
          void (async () => {
            try {
              await setActiveProviderId(p.id);
            } catch (_) {}
            await syncToolbarFromActiveProvider();
            refreshAgentStatusBadge();
            openInferenceEditor(p);
            const next = await loadProvidersState();
            renderInferenceVendorList(next);
            renderImageVendorList(next);
          })();
        },
        onDelete: () => confirmDeleteVendor(p.name || p.model || 'API', () => deleteInferenceVendor(p.id))
      })
    );
  }
}

function renderImageVendorList(state) {
  const list = document.getElementById('imageVendorList');
  if (!list) return;
  list.innerHTML = '';
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  const activeId = state?.activeProviderId || null;
  const images = providers.filter((p) => p?.image?.enabled);
  refreshImageGenStatusLine(images.length);
  for (const p of images) {
    const model = p.image?.model || '';
    const host = vendorHostFromUrl(p.image?.baseURL || p.baseURL);
    const imageBase = String(p.image?.baseURL || '').replace(/\/$/, '');
    const chatBase = String(p.baseURL || '').replace(/\/$/, '');
    const same = !imageBase || imageBase === chatBase;
    const bits = [
      model,
      host,
      same
        ? settingsLangEn()
          ? `via ${p.name || 'chat'}`
          : `随 ${p.name || '推理'}`
        : settingsLangEn()
          ? 'separate API'
          : '独立 API'
    ].filter(Boolean);
    list.appendChild(
      renderVendorCard({
        name: imageVendorName(p),
        meta: bits.join(' · '),
        active: p.id === activeId,
        onSelect: () => openImageEditor(p),
        onDelete: () =>
          confirmDeleteVendor(imageVendorName(p), () => deleteImageVendor(p.id))
      })
    );
  }
}

async function renderWebVendorList() {
  const list = document.getElementById('webVendorList');
  if (!list) return;
  list.innerHTML = '';
  const cfg = await loadWebAcquireSettings();
  const en = settingsLangEn();
  const line = document.getElementById('webAcquireStatusLine');
  const vendors = [
    {
      kind: 'parallel', name: 'Parallel',
      meta: en ? 'Free search · no account or key' : '免费搜索 · 无需账号或 Key',
      active: cfg.searchProvider === 'parallel'
    },
    {
      kind: 'disabled', name: en ? 'Search off' : '关闭公开网搜索',
      meta: en ? 'Keep page access and fetch available' : '仍可访问绑定页与抓取 URL',
      active: cfg.searchProvider === 'disabled'
    }
  ];
  if (cfg.tavilyKey) {
    vendors.push({
      kind: 'tavily',
      name: 'Tavily',
      meta: `${maskKeyTail(cfg.tavilyKey)} · search`,
      active: cfg.searchProvider === 'tavily'
    });
  }
  if (cfg.braveKey) {
    vendors.push({
      kind: 'brave',
      name: 'Brave Search',
      meta: `${maskKeyTail(cfg.braveKey)} · search`,
      active: cfg.searchProvider === 'brave'
    });
  }
  if (cfg.firecrawlKey) {
    vendors.push({
      kind: 'firecrawl',
      name: 'Firecrawl',
      meta: `${maskKeyTail(cfg.firecrawlKey)} · fetch scrape`,
      active: false
    });
  }
  if (line) {
    line.textContent = en
      ? 'Tap a search card to use it. Parallel sends search queries to search.parallel.ai. Firecrawl upgrades fetch scrape.'
      : '点搜索卡片设为当前使用。Parallel 会将搜索词发送至 search.parallel.ai。Firecrawl 增强 fetch 抽取。';
  }
  for (const v of vendors) {
    list.appendChild(
      renderVendorCard({
        name: v.name,
        meta: v.meta,
        active: v.active,
        onSelect: () => {
          void (async () => {
            if (v.kind === 'parallel' || v.kind === 'disabled') {
              await saveWebAcquireSettings({ searchProvider: v.kind });
              setWebEditorOpen(false);
              await renderWebVendorList();
              return;
            }
            if (v.kind === 'tavily' || v.kind === 'brave') {
              await saveWebAcquireSettings({ searchProvider: v.kind });
              await renderWebVendorList();
            }
            openWebEditor(v.kind);
          })();
        },
        onDelete: v.kind === 'parallel' || v.kind === 'disabled'
          ? null : () => confirmDeleteVendor(v.name, () => deleteWebVendor(v.kind))
      })
    );
  }
}

async function refreshVendorBoards() {
  const state = await loadProvidersState();
  renderInferenceVendorList(state);
  renderImageVendorList(state);
  await fillWebAcquireForm();
  await renderWebVendorList();
  refreshAgentStatusBadge();
  void refreshImageGenChip();
  void refreshSkillSettingsList();
}

function openInferenceEditor(provider) {
  setImageEditorOpen(false);
  setWebEditorOpen(false);
  if (provider) {
    fillSettingsForm(provider);
  } else {
    fillSettingsForm(
      {
        id: null,
        name: 'DeepSeek',
        baseURL: DEFAULT_BASE || 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        apiKey: ''
      },
      { isNew: true }
    );
    applyInferencePreset('deepseek');
  }
  setInferenceEditorOpen(true);
  document.getElementById('apiKeyInput')?.focus();
}

function openImageEditor(provider) {
  if (!provider) return;
  setInferenceEditorOpen(false);
  setWebEditorOpen(false);
  settingsImageUi.providerId = provider.id || null;
  fillSettingsForm(provider);
  const enabled = document.getElementById('providerImageEnabledCheck');
  if (enabled) enabled.checked = true;
  if (!provider.image?.enabled && !provider.image?.model) {
    applyImagePreset('openrouter');
  } else {
    syncImageSectionVisibility();
  }
  setImageEditorOpen(true);
  void hydrateSettingsImageCatalog(provider);
}

function setWebEditorKind(kind) {
  const next = kind === 'brave' ? 'brave' : kind === 'firecrawl' ? 'firecrawl' : 'tavily';
  settingsWebUi.kind = next;
  const sel = document.getElementById('webSearchProviderSelect');
  if (sel && next !== 'firecrawl') sel.value = next;
  document.querySelectorAll('#webVendorPresetRow [data-web-preset]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-web-preset') === next);
  });
  const tavilyRow = document.getElementById('tavilyKeyRow');
  const braveRow = document.getElementById('braveKeyRow');
  const fireRow = document.getElementById('firecrawlKeyRow');
  if (tavilyRow) tavilyRow.hidden = next !== 'tavily';
  if (braveRow) braveRow.hidden = next !== 'brave';
  if (fireRow) fireRow.hidden = next !== 'firecrawl';
}

function openWebEditor(kind) {
  setInferenceEditorOpen(false);
  setImageEditorOpen(false);
  setWebEditorKind(kind || 'tavily');
  setWebEditorOpen(true);
  const focusId =
    settingsWebUi.kind === 'brave'
      ? 'braveKeyInput'
      : settingsWebUi.kind === 'firecrawl'
        ? 'firecrawlKeyInput'
        : 'tavilyKeyInput';
  document.getElementById(focusId)?.focus();
}

async function saveInferenceEditor(opts = {}) {
  const form = readSettingsForm();
  const hint = document.getElementById('settingsApiHint');
  if (!form.baseURL) {
    if (hint) hint.textContent = '请填写推理模型 Base URL（如 https://api.deepseek.com/v1）。';
    document.getElementById('apiBaseInput')?.focus();
    return false;
  }
  if (/image_generation/i.test(form.baseURL)) {
    if (hint) {
      hint.textContent =
        '推理 Base URL 不应包含 image_generation。请使用 Chat Completions 根路径。';
    }
    document.getElementById('apiBaseInput')?.focus();
    return false;
  }
  const id = settingsConfigUi.providerId || generateProviderId();
  try {
    await upsertProvider(
      {
        id,
        name: form.name || 'Provider',
        baseURL: form.baseURL,
        apiKey: form.apiKey,
        model: form.model,
        createdAt: settingsConfigUi.createdAt || Date.now()
      },
      { makeActive: true }
    );
    settingsConfigUi.providerId = id;
    if (form.apiKey) {
      settingsConfigUi.hasStoredKey = true;
      settingsConfigUi.keyTail = form.apiKey.slice(-4);
    }
    if (form.model) {
      try {
        await pushRecentModel(form.model);
      } catch (_) {}
    }
    await syncToolbarFromActiveProvider();
    if (!opts.keepOpen) setInferenceEditorOpen(false);
    await refreshVendorBoards();
    if (hint) hint.textContent = settingsLangEn() ? 'Saved.' : '✓ 已保存';
    return true;
  } catch (e) {
    if (hint) hint.textContent = (settingsLangEn() ? 'Save failed: ' : '保存失败: ') + (e?.message || e);
    return false;
  }
}

async function saveImageEditor(opts = {}) {
  const enabled = document.getElementById('providerImageEnabledCheck');
  if (enabled) enabled.checked = true;
  const form = readSettingsForm();
  const state = await loadProvidersState();
  const hostId =
    settingsImageUi.providerId || settingsConfigUi.providerId || state.activeProviderId;
  const host = (state.providers || []).find((p) => p.id === hostId) || state.active;
  if (!host) {
    showSidepanelToast(
      settingsLangEn() ? 'Add a chat API first.' : '请先添加推理 API。',
      { error: true }
    );
    return false;
  }
  const nextImage = { ...(form.image || {}), enabled: true };
  const prevKey = host.image && typeof host.image.apiKey === 'string' ? host.image.apiKey.trim() : '';
  if (!nextImage.apiKey && prevKey) nextImage.apiKey = prevKey;
  if (!nextImage.apiKey && !host.apiKey) {
    showSidepanelToast(
      settingsLangEn()
        ? 'Enter an image API key, or add a chat key to inherit.'
        : '请填写图像 API Key，或先保存推理 Key 以便继承。',
      { error: true }
    );
    document.getElementById('providerImageKeyInput')?.focus();
    return false;
  }
  try {
    await upsertProvider(
      {
        ...host,
        image: nextImage
      },
      { makeActive: false }
    );
    if (!opts.keepOpen) setImageEditorOpen(false);
    await refreshVendorBoards();
    return true;
  } catch (e) {
    showSidepanelToast(
      (settingsLangEn() ? 'Save failed: ' : '保存失败: ') + (e?.message || e),
      { error: true }
    );
    return false;
  }
}

async function deleteInferenceVendor(providerId) {
  try {
    await deleteProvider(providerId);
    if (settingsConfigUi.providerId === providerId) {
      settingsConfigUi.providerId = null;
      setInferenceEditorOpen(false);
    }
    if (settingsImageUi.providerId === providerId) {
      settingsImageUi.providerId = null;
      setImageEditorOpen(false);
    }
    await syncToolbarFromActiveProvider();
    await refreshVendorBoards();
  } catch (e) {
    showSidepanelToast(
      (settingsLangEn() ? 'Delete failed: ' : '删除失败: ') + (e?.message || e),
      { error: true }
    );
  }
}

async function deleteImageVendor(providerId) {
  try {
    const state = await loadProvidersState();
    const host = (state.providers || []).find((p) => p.id === providerId);
    if (!host) return;
    const image = host.image && typeof host.image === 'object' ? { ...host.image, enabled: false } : { enabled: false };
    await upsertProvider({ ...host, image }, { makeActive: false });
    if (settingsImageUi.providerId === providerId) setImageEditorOpen(false);
    await refreshVendorBoards();
  } catch (e) {
    showSidepanelToast(
      (settingsLangEn() ? 'Delete failed: ' : '删除失败: ') + (e?.message || e),
      { error: true }
    );
  }
}

async function deleteWebVendor(kind) {
  try {
    const cfg = await loadWebAcquireSettings();
    const patch = {};
    if (kind === 'tavily') patch.tavilyKey = '';
    if (kind === 'brave') patch.braveKey = '';
    if (kind === 'firecrawl') patch.firecrawlKey = '';
    if (kind === 'tavily' && cfg.searchProvider === 'tavily' && cfg.braveKey) {
      patch.searchProvider = 'brave';
    } else if (kind === 'brave' && cfg.searchProvider === 'brave' && cfg.tavilyKey) {
      patch.searchProvider = 'tavily';
    }
    await saveWebAcquireSettings(patch);
    if (settingsWebUi.kind === kind) setWebEditorOpen(false);
    await refreshVendorBoards();
  } catch (e) {
    showSidepanelToast(
      (settingsLangEn() ? 'Delete failed: ' : '删除失败: ') + (e?.message || e),
      { error: true }
    );
  }
}

/**
 * Load providers into vendor cards. First visit with none opens the add form.
 */
async function refreshSettingsForm() {
  setInferenceEditorOpen(false);
  setImageEditorOpen(false);
  setWebEditorOpen(false);
  setSkillEditorOpen(false);
  await refreshVendorBoards();
  const state = await loadProvidersState();
  if (!(state.providers || []).length) {
    openInferenceEditor(null);
  }
}

/**
 * Read both API sections from the form.
 * @returns {{
 *   name: string,
 *   baseURL: string,
 *   apiKey: string,
 *   model: string,
 *   image: object
 * }}
 */
function readSettingsForm() {
  const baseURL = document.getElementById('apiBaseInput')?.value?.trim() || '';
  const apiKey = document.getElementById('apiKeyInput')?.value?.trim() || '';
  const model = document.getElementById('providerModelInput')?.value?.trim() || '';
  const name = settingsConfigUi.providerName || 'Provider';

  const imageEnabled = !!document.getElementById('providerImageEnabledCheck')?.checked;
  const protocolRaw = document.getElementById('providerImageProtocolInput')?.value?.trim();
  const openrouter = protocolRaw === 'openrouter-image' || !protocolRaw;
  let imageModel =
    document.getElementById('providerImageModelInput')?.value?.trim() || '';
  if (imageEnabled && !imageModel) {
    imageModel = openrouter
      ? 'google/gemini-2.5-flash-image'
      : DEFAULT_IMAGE_MODEL || 'image-01';
  }
  const imagePathRaw = document.getElementById('providerImagePathInput')?.value?.trim() || '';
  const imagePath =
    imagePathRaw ||
    (openrouter ? '/images' : DEFAULT_IMAGE_PATH || '/image_generation');
  const imageBaseRaw = document.getElementById('providerImageBaseInput')?.value?.trim() || '';
  const imageKeyRaw = document.getElementById('providerImageKeyInput')?.value?.trim() || '';

  /** @type {Record<string, unknown>} */
  const imageOverrides = {
    enabled: imageEnabled,
    protocol: protocolRaw || DEFAULT_IMAGE_PROTOCOL || 'openrouter-image',
    path: imagePath,
    model: imageModel || DEFAULT_IMAGE_MODEL || 'google/gemini-2.5-flash-image'
  };
  if (imageEnabled && imageBaseRaw) {
    imageOverrides.baseURL = imageBaseRaw.replace(/\/$/, '');
  }
  if (imageEnabled && imageKeyRaw) {
    imageOverrides.apiKey = imageKeyRaw;
  }

  const image =
    typeof defaultImageConfig === 'function'
      ? defaultImageConfig(imageOverrides)
      : imageOverrides;

  if (!imageEnabled) {
    if (image && 'baseURL' in image) delete image.baseURL;
    if (image && 'apiKey' in image) delete image.apiKey;
  }

  return { name, baseURL, apiKey, model, image };
}

function maskKeyPlaceholder(key, emptyPh) {
  const s = String(key || '');
  if (s.length >= 4) return `已配置 (…${s.slice(-4)}) — 留空则保持不变`;
  return emptyPh;
}

async function fillWebAcquireForm() {
  const cfg = await loadWebAcquireSettings();
  const sel = document.getElementById('webSearchProviderSelect');
  if (sel) sel.value = cfg.searchProvider || 'tavily';
  const tavily = document.getElementById('tavilyKeyInput');
  const brave = document.getElementById('braveKeyInput');
  const fire = document.getElementById('firecrawlKeyInput');
  if (tavily) {
    tavily.value = '';
    tavily.placeholder = maskKeyPlaceholder(cfg.tavilyKey, 'tvly-...');
  }
  if (brave) {
    brave.value = '';
    brave.placeholder = maskKeyPlaceholder(cfg.braveKey, 'BSA...');
  }
  if (fire) {
    fire.value = '';
    fire.placeholder = maskKeyPlaceholder(cfg.firecrawlKey, 'fc-...');
  }
}

async function saveWebAcquireFromForm() {
  const cfg = await loadWebAcquireSettings();
  const kind = settingsWebUi.kind || 'tavily';
  const patch = {};
  if (kind === 'tavily') {
    const typed = document.getElementById('tavilyKeyInput')?.value?.trim() || '';
    if (typed) {
      patch.tavilyKey = typed;
      patch.searchProvider = 'tavily';
    } else if (!cfg.tavilyKey) {
      showSidepanelToast(settingsLangEn() ? 'Enter a Tavily API key.' : '请填写 Tavily API Key。', {
        error: true
      });
      document.getElementById('tavilyKeyInput')?.focus();
      return false;
    } else {
      patch.searchProvider = 'tavily';
    }
  } else if (kind === 'brave') {
    const typed = document.getElementById('braveKeyInput')?.value?.trim() || '';
    if (typed) {
      patch.braveKey = typed;
      patch.searchProvider = 'brave';
    } else if (!cfg.braveKey) {
      showSidepanelToast(settingsLangEn() ? 'Enter a Brave API key.' : '请填写 Brave API Key。', {
        error: true
      });
      document.getElementById('braveKeyInput')?.focus();
      return false;
    } else {
      patch.searchProvider = 'brave';
    }
  } else {
    const typed = document.getElementById('firecrawlKeyInput')?.value?.trim() || '';
    if (typed) {
      patch.firecrawlKey = typed;
    } else if (!cfg.firecrawlKey) {
      showSidepanelToast(
        settingsLangEn() ? 'Enter a Firecrawl API key.' : '请填写 Firecrawl API Key。',
        { error: true }
      );
      document.getElementById('firecrawlKeyInput')?.focus();
      return false;
    }
  }
  await saveWebAcquireSettings(patch);
  await fillWebAcquireForm();
  await renderWebVendorList();
  return true;
}

async function saveDebugSettings() {
  const devTraj = !!document.getElementById('devTrajectoryExportCheck')?.checked;
  devTrajectoryExportEnabled = devTraj;
  updateDevTrajectoryUi();
  /** @type {Record<string, unknown>} */
  const toStore = {
    pagewand_use_browser_runtime: true,
    pagewand_allow_python_fallback: false,
    [RUNTIME_MODE_STORAGE_KEY]: 'vnext',
    [DEV_TRAJECTORY_STORAGE_KEY]: devTraj
  };
  const captureLabel = document.getElementById('captureShortcutLabel')?.dataset?.shortcut;
  if (captureLabel) toStore.pagewand_capture_shortcut = captureLabel;
  await new Promise((resolve) => {
    chrome.storage.local.set(toStore, () => resolve());
  });
}

/**
 * Persist any open editors + debug toggles.
 * @returns {Promise<boolean>} true if saved
 */
async function saveAllSettings() {
  const infEd = document.getElementById('inferenceEditor');
  const imgEd = document.getElementById('imageEditor');
  const webEd = document.getElementById('webAcquireEditor');
  try {
    if (infEd && !infEd.hidden) {
      const ok = await saveInferenceEditor({ keepOpen: true });
      if (!ok) return false;
    }
    if (imgEd && !imgEd.hidden) {
      const ok = await saveImageEditor({ keepOpen: true });
      if (!ok) return false;
    }
    if (webEd && !webEd.hidden) {
      const ok = await saveWebAcquireFromForm();
      if (!ok) return false;
    }
    await saveDebugSettings();
    await refreshVendorBoards();
    return true;
  } catch (e) {
    const hint = document.getElementById('settingsApiHint');
    if (hint) hint.textContent = (settingsLangEn() ? 'Save failed: ' : '保存失败: ') + (e?.message || e);
    return false;
  }
}

function setupAgentSettingsModal() {
  const closeBtn = document.getElementById('settingsModalCloseBtn');
  const cancelBtn = document.getElementById('settingsCancelBtn');
  const saveBtn = document.getElementById('settingsSaveBtn');
  /** @type {HTMLDialogElement|null} */
  const modal = /** @type {HTMLDialogElement|null} */ (
    document.getElementById('agentSettingsModal')
  );
  const captureShortcutOpenBtn = document.getElementById('captureShortcutOpenBtn');

  const close = () => {
    if (!modal) return;
    closeDialog(modal);
  };

  if (modal) {
    wireDialogChrome(modal, {
      closeSelectors: [],
      closeOnBackdrop: true
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (captureShortcutOpenBtn) {
    captureShortcutOpenBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const ok = await saveAllSettings();
      if (ok) close();
    });
  }

  document.getElementById('addInferenceBtn')?.addEventListener('click', () => {
    openInferenceEditor(null);
  });
  document.getElementById('cancelInferenceEditorBtn')?.addEventListener('click', () => {
    setInferenceEditorOpen(false);
  });
  document.getElementById('saveInferenceEditorBtn')?.addEventListener('click', () => {
    void saveInferenceEditor();
  });

  document.getElementById('addImageBtn')?.addEventListener('click', () => {
    void (async () => {
      const state = await loadProvidersState();
      const host = state.active || (state.providers || [])[0] || null;
      if (!host) {
        showSidepanelToast(
          settingsLangEn() ? 'Add a chat API first.' : '请先添加推理 API。',
          { error: true }
        );
        openInferenceEditor(null);
        return;
      }
      openImageEditor(host);
    })();
  });
  document.getElementById('cancelImageEditorBtn')?.addEventListener('click', () => {
    setImageEditorOpen(false);
  });
  document.getElementById('saveImageEditorBtn')?.addEventListener('click', () => {
    void saveImageEditor();
  });

  document.getElementById('addWebAcquireBtn')?.addEventListener('click', () => {
    openWebEditor('tavily');
  });
  document.getElementById('cancelWebAcquireBtn')?.addEventListener('click', () => {
    setWebEditorOpen(false);
  });
  document.getElementById('saveWebAcquireBtn')?.addEventListener('click', () => {
    void (async () => {
      const ok = await saveWebAcquireFromForm();
      if (ok) setWebEditorOpen(false);
    })();
  });

  const presetRow = document.getElementById('inferencePresetRow');
  if (presetRow) {
    presetRow.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('.provider-preset-chip');
      if (!btn || !presetRow.contains(btn)) return;
      const presetId = btn.getAttribute('data-preset');
      if (presetId) applyInferencePreset(presetId);
    });
  }

  document.getElementById('providerModelRefreshBtn')?.addEventListener('click', () => {
    void onRefreshChatModelsClick();
  });
  const modelFilter = document.getElementById('providerModelFilter');
  if (modelFilter && !modelFilter.dataset.wired) {
    modelFilter.dataset.wired = '1';
    modelFilter.addEventListener('input', () => renderSettingsModelCatalog());
  }

  document.getElementById('providerImageProbeBtn')?.addEventListener('click', () => {
    void onProbeImageModelsClick();
  });
  const imageFilter = document.getElementById('providerImageModelFilter');
  if (imageFilter && !imageFilter.dataset.wired) {
    imageFilter.dataset.wired = '1';
    imageFilter.addEventListener('input', () => renderSettingsImageCatalog());
  }

  const imagePresetRow = document.getElementById('imagePresetRow');
  if (imagePresetRow) {
    imagePresetRow.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-image-preset]');
      if (!btn || !imagePresetRow.contains(btn)) return;
      const id = btn.getAttribute('data-image-preset');
      if (id && id !== 'off') applyImagePreset(id);
    });
  }

  const webPresetRow = document.getElementById('webVendorPresetRow');
  if (webPresetRow) {
    webPresetRow.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-web-preset]');
      if (!btn || !webPresetRow.contains(btn)) return;
      const id = btn.getAttribute('data-web-preset');
      if (id) setWebEditorKind(id);
    });
  }
}

function openAgentSettingsModal() {
  /** @type {HTMLDialogElement|null} */
  const modal = /** @type {HTMLDialogElement|null} */ (
    document.getElementById('agentSettingsModal')
  );
  if (!modal) return;

  const returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.getElementById('gearBtn');

  chrome.storage.local.get(
    [
      'pagewand_use_browser_runtime',
      'pagewand_allow_python_fallback',
      'pagewand_capture_shortcut',
      RUNTIME_MODE_STORAGE_KEY,
      DEV_TRAJECTORY_STORAGE_KEY
    ],
    async (res) => {
      const devTrajCheck = document.getElementById('devTrajectoryExportCheck');
      if (devTrajCheck) {
        devTrajCheck.checked = res[DEV_TRAJECTORY_STORAGE_KEY] !== false;
      }
      await refreshCaptureShortcutSettingsUi(res.pagewand_capture_shortcut);

      try {
        await refreshSettingsForm();
      } catch (e) {
        console.warn('[PageWand] settings form load failed', e);
        fillSettingsForm(
          {
            id: null,
            name: 'DeepSeek',
            baseURL: DEFAULT_BASE || 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-flash',
            apiKey: ''
          },
          { isNew: false }
        );
      }


      const infEd = document.getElementById('inferenceEditor');
      const firstField =
        infEd && !infEd.hidden
          ? document.getElementById('apiKeyInput') || document.getElementById('apiBaseInput')
          : document.getElementById('addInferenceBtn') ||
            document.getElementById('settingsSaveBtn') ||
            modal;
      openDialog(modal, {
        returnFocus: returnFocus instanceof HTMLElement ? returnFocus : null,
        focus: firstField instanceof HTMLElement ? firstField : null
      });
    }
  );
}

/* ===== PART: screenshot ===== */

// ── CAPTURE_WP: screenshot → clipboard + pending chat attach ───────────────
async function refreshCaptureShortcutSettingsUi(storedShortcut) {
  const labelEl = document.getElementById('captureShortcutLabel');
  let shortcut = storedShortcut || (await loadCaptureShortcut()) || DEFAULT_CAPTURE_SHORTCUT;
  try {
    if (chrome.commands?.getAll) {
      const cmds = await chrome.commands.getAll();
      const cap = cmds.find((c) => c.name === 'capture-screenshot');
      if (cap?.shortcut) shortcut = cap.shortcut;
    }
  } catch (_) {}
  if (labelEl) {
    labelEl.innerText = shortcut;
    labelEl.dataset.shortcut = shortcut;
  }
  await saveCaptureShortcut(shortcut);
}

/** CAPTURE_WP: dedupe concurrent hotkey + message + pending-stash attach */

/**
 * Attach a screenshot dataURL into pending chat attachments; best-effort clipboard.
 * @param {{ dataUrl: string, name?: string, clipboardOk?: boolean, source?: string }} payload
 */
const screenshotAttachInflight = new Set();

function screenshotAttachKey(dataUrl) {
  const s = String(dataUrl || '');
  return `${s.length}:${s.slice(0, 80)}${s.slice(-40)}`;
}

async function nextStickyLabel(kind, groupId) {
  let storeNext = 1;
  try {
    const r = await workspaceRpc('allocateLabel', {
      sessionId: getWorkspaceSessionId(),
      kind,
      groupId: groupId || workspaceGroupState.activeGroupId || undefined
    });
    if (r?.n) storeNext = Math.max(1, Math.floor(Number(r.n)) || 1);
  } catch (_) {}
  let pendingMax = 0;
  for (const a of pendingAttachments) {
    if (a.labelKind !== kind) continue;
    const n = Math.floor(Number(a.labelN) || 0);
    if (n > pendingMax) pendingMax = n;
  }
  const n = Math.max(storeNext, pendingMax + 1);
  return { kind, n, handle: `${kind}${n}` };
}

async function attachScreenshotToChat(payload) {
  if (!payload?.dataUrl) return;
  const attachKey = screenshotAttachKey(payload.dataUrl);
  const now = Date.now();
  if (
    screenshotAttachInflight.has(attachKey) ||
    (attachKey === lastCaptureAttachKey && now - lastCaptureAttachAt < 3000)
  ) {
    chrome.storage.local.remove(STORAGE_PENDING_SCREENSHOT);
    return;
  }
  if (pendingAttachments.some((a) => a.isImage && a.dataUrl === payload.dataUrl)) {
    chrome.storage.local.remove(STORAGE_PENDING_SCREENSHOT);
    return;
  }
  screenshotAttachInflight.add(attachKey);
  lastCaptureAttachKey = attachKey;
  lastCaptureAttachAt = now;
  try {
    const att = attachmentFromDataUrl(payload.dataUrl, {
      name: 'screenshot.png',
      source: payload.source || 'screenshot'
    });
    const lab = await nextStickyLabel(
      'screenshot',
      payload.source === 'paste' ? clipboardGroupFromState()?.groupId : undefined
    );
    att.name = formatItemLabel('screenshot', lab.n, itemLabelLang());
    att.labelKind = 'screenshot';
    att.labelN = lab.n;
    pendingAttachments.push(att);
    renderAttachmentPreviews();
    if (payload.source === 'paste') insertPastedScreenshotChip(att);
    // If SW clipboard inject failed, retry from Side Panel document
    if (!payload.clipboardOk) {
      try {
        await copyDataUrlToClipboard(payload.dataUrl);
      } catch (e) {
        console.warn('[CAPTURE_WP] sidepanel clipboard retry failed', e);
      }
    }
    // Clear pending stash so we do not re-attach on next open
    chrome.storage.local.remove(STORAGE_PENDING_SCREENSHOT);
  } catch (err) {
    lastCaptureAttachKey = '';
    lastCaptureAttachAt = 0;
    console.error('[CAPTURE_WP] attach failed', err);
    showCustomModal({
      title: currentLang === 'en' ? 'Screenshot' : '截图',
      placeholder: '',
      initialValue:
        currentLang === 'en'
          ? `Failed to attach screenshot: ${err?.message || err}`
          : `截图附件失败: ${err?.message || err}`,
      onConfirm: () => {}
    });
  } finally {
    screenshotAttachInflight.delete(attachKey);
  }
}

async function requestUserScreenshot(source = 'button') {
  try {
    const result = await chrome.runtime.sendMessage({
      action: CAPTURE_MSG.CAPTURE_REQUEST,
      source
    });
    if (result?.deduped) return;
    // User pressed Esc / right-click / tiny drag during region select
    if (result?.cancelled) return;
    if (result?.ok && result.dataUrl) {
      await attachScreenshotToChat({
        dataUrl: result.dataUrl,
        name: result.name,
        clipboardOk: result.clipboardOk,
        source
      });
      return;
    }
    const errMsg = result?.error || 'unknown error';
    showCustomModal({
      title: currentLang === 'en' ? 'Screenshot' : '截图',
      placeholder: '',
      initialValue:
        currentLang === 'en'
          ? `Capture failed: ${errMsg}`
          : `截图失败: ${errMsg}`,
      onConfirm: () => {}
    });
  } catch (err) {
    showCustomModal({
      title: currentLang === 'en' ? 'Screenshot' : '截图',
      placeholder: '',
      initialValue:
        currentLang === 'en'
          ? `Capture failed: ${err?.message || err}`
          : `截图失败: ${err?.message || err}`,
      onConfirm: () => {}
    });
  }
}

function setupScreenshotCapture() {
  // Capture button in toolbar / chat area
  const captureBtn = document.getElementById('captureScreenshotBtn');
  if (captureBtn) {
    captureBtn.addEventListener('click', () => requestUserScreenshot('button'));
  }

  // Live broadcast from background (hotkey while sidepanel open)
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action === 'screenshot_captured' && request.dataUrl) {
      attachScreenshotToChat({
        dataUrl: request.dataUrl,
        name: request.name,
        clipboardOk: request.clipboardOk,
        source: request.source || 'hotkey'
      }).then(() => sendResponse({ received: true }));
      return true;
    }
    return false;
  });

  // Pick up stash if panel opened after hotkey
  chrome.storage.local.get([STORAGE_PENDING_SCREENSHOT], (res) => {
    const pending = res?.[STORAGE_PENDING_SCREENSHOT];
    if (!pending?.dataUrl) return;
    // Only auto-attach fresh captures (< 2 min)
    if (pending.ts && Date.now() - pending.ts > 120000) {
      chrome.storage.local.remove(STORAGE_PENDING_SCREENSHOT);
      return;
    }
    attachScreenshotToChat({
      dataUrl: pending.dataUrl,
      name: pending.name,
      clipboardOk: pending.clipboardOk,
      source: pending.source || 'pending'
    });
  });

  // Keep settings label fresh
  loadCaptureShortcut().then((s) => {
    const labelEl = document.getElementById('captureShortcutLabel');
    if (labelEl && !labelEl.innerText?.trim()) labelEl.innerText = s;
  });
}

/* ===== PART: rich_text ===== */

function extractJsCodeFromMarkdown(mdText) {
  const codeBlockRegex = /```(?:javascript|js)?\n([\s\S]*?)```/i;
  const match = codeBlockRegex.exec(mdText);
  return match ? match[1].trim() : '';
}

function renderRichTextContent(container, markdownText) {
  if (typeof markdownText !== 'string') {
    markdownText = markdownText == null ? '' : '';
  }
  const cleanMarkdown = markdownText.replace(/```popcard\n[\s\S]*?```/gi, '');

  try {
    let html = parseOfficeMarkdown(cleanMarkdown);
    html = html.replace(
      /<pre><code class="language-(javascript|js)">([\s\S]*?)<\/code><\/pre>/g,
      '<details class="pagewand-code-details"><summary>查看脚本</summary><pre><code class="language-javascript">$2</code></pre></details>'
    );
    container.innerHTML = sanitizeModelHtml(html);
  } catch (e) {
    console.warn('Markdown parse fallback:', e);
    container.innerHTML = escapeHtml(cleanMarkdown).replace(/\n/g, '<br>');
  }

  renderPopCardsInMessage(container, markdownText);

  scrollTaskStream();
}

/**
 * @param {HTMLElement} container
 * @param {string} markdownText
 * @param {{ interactive?: boolean }} [opts] interactive=false when askUser rebinds handlers
 */
function renderPopCardsInMessage(container, markdownText, opts = {}) {
  const interactive = opts.interactive !== false;
  const popcardRegex = /```popcard\n([\s\S]*?)```/gi;
  let match;
  while ((match = popcardRegex.exec(markdownText)) !== null) {
    try {
      const cardData = JSON.parse(match[1]);
      if (cardData && cardData.question && Array.isArray(cardData.options)) {
        if (container.querySelector(`[data-popcard-question="${escapeHtml(cardData.question)}"]`)) {
          continue; // Avoid duplicate rendering
        }

        const popCardEl = document.createElement('div');
        popCardEl.className = 'pop-card-container';
        popCardEl.setAttribute('data-popcard-question', escapeHtml(cardData.question));

        let optionsHtml = cardData.options.map((opt) => `
          <button type="button" class="pop-card-option-btn" data-option="${escapeHtml(opt)}">
            <span class="opt-text">${escapeHtml(opt)}</span>
          </button>
        `).join('');

        popCardEl.innerHTML = `
          <div class="pop-card-header">
            <span class="pop-card-icon">💡</span>
            <span class="pop-card-title">${escapeHtml(cardData.question)}</span>
          </div>
          <div class="pop-card-options-grid">
            ${optionsHtml}
          </div>
          <div class="pop-card-custom-row">
            <input type="text" class="pop-card-custom-input" placeholder="✍️ 其它 (可自定义回答)..." />
            <button type="button" class="pop-card-custom-submit">发送</button>
          </div>
        `;

        if (interactive) {
          // Stream-rendered popcards: choose answer → settle UI → continue as task follow-up
          popCardEl.querySelectorAll('.pop-card-option-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const optVal = btn.getAttribute('data-option') || btn.innerText;
              settlePopCardHost(popCardEl.parentElement || popCardEl, optVal);
              if (pendingAskUserResolve) {
                const fn = pendingAskUserResolve;
                pendingAskUserResolve = null;
                fn(optVal);
              } else {
                // Not mid ask_user — treat as follow-up message in same task
                submitCustomPrompt(optVal);
              }
            });
          });

          const customInput = popCardEl.querySelector('.pop-card-custom-input');
          const customSubmit = popCardEl.querySelector('.pop-card-custom-submit');
          const handleCustomSubmit = () => {
            const customVal = customInput?.value?.trim();
            if (!customVal) return;
            settlePopCardHost(popCardEl.parentElement || popCardEl, customVal);
            if (pendingAskUserResolve) {
              const fn = pendingAskUserResolve;
              pendingAskUserResolve = null;
              fn(customVal);
            } else {
              submitCustomPrompt(customVal);
            }
          };
          customSubmit?.addEventListener('click', handleCustomSubmit);
          customInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleCustomSubmit();
          });
        }

        container.appendChild(popCardEl);
      }
    } catch (e) {
      console.warn('PopCard JSON parse error:', e);
    }
  }
}

function setSkillEditorOpen(open) {
  setEditorOpen('skillSettingsEditor', 'skillAddBtn', open);
  if (!open) {
    skillSettingsIsNew = false;
    skillSettingsSelectedId = '';
  }
}

async function refreshSkillSettingsList() {
  const list = document.getElementById('skillSettingsList');
  if (!list) return;
  let catalog = [];
  try {
    catalog = await workspaceRpc('listSkills');
  } catch (e) {
    list.innerHTML = '';
    const hint = document.getElementById('skillImportHint');
    if (hint) {
      hint.hidden = false;
      hint.textContent = String(e?.message || e);
    }
    return;
  }
  skillSettingsCatalog = Array.isArray(catalog) ? catalog : [];
  skillPickerCatalog = skillSettingsCatalog;
  skillPickerCatalogAt = Date.now();
  list.innerHTML = '';
  for (const s of skillSettingsCatalog) {
    const origin = s.origin || 'packaged';
    const card = document.createElement('div');
    card.className =
      'api-vendor-card' +
      (s.id === skillSettingsSelectedId && !skillSettingsIsNew ? ' is-active' : '');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'api-vendor-card-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'api-vendor-name';
    const title = document.createElement('span');
    title.textContent = s.name || s.id;
    nameEl.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'api-vendor-badge';
    badge.textContent = skillOriginLabel(origin);
    nameEl.appendChild(badge);
    const metaEl = document.createElement('div');
    metaEl.className = 'api-vendor-meta';
    metaEl.textContent = s.description || s.id;
    main.append(nameEl, metaEl);
    main.addEventListener('click', () => {
      void openSkillEditor(s.id);
    });
    card.appendChild(main);
    if (origin !== 'packaged') {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'api-vendor-delete';
      del.setAttribute('aria-label', t('skillDelete'));
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void removeSkillLocal(s.id);
      });
      card.appendChild(del);
    }
    list.appendChild(card);
  }
}

function fillSkillResources(detail) {
  const ul = document.getElementById('skillEditResources');
  const src = document.getElementById('skillEditSource');
  if (src) {
    if (detail?.sourceUrl) {
      src.hidden = false;
      src.textContent = detail.sourceUrl;
    } else if (detail?.guestRoot) {
      src.hidden = false;
      src.textContent = t('skillGuestHint').replace('{path}', detail.guestRoot);
    } else {
      src.hidden = true;
      src.textContent = '';
    }
  }
  if (!ul) return;
  ul.innerHTML = '';
  const resources = Array.isArray(detail?.resources) ? detail.resources : [];
  if (!resources.length) {
    ul.hidden = false;
    const li = document.createElement('li');
    li.textContent = t('skillResourcesNone');
    ul.appendChild(li);
    return;
  }
  ul.hidden = false;
  for (const r of resources) {
    const li = document.createElement('li');
    const path = document.createElement('span');
    path.className = 'skill-resource-path';
    path.textContent = r.path;
    const guest = document.createElement('span');
    guest.className = 'skill-resource-guest';
    guest.textContent = r.guestPath || '';
    li.append(path, guest);
    ul.appendChild(li);
  }
}

async function openSkillEditor(id) {
  skillSettingsIsNew = false;
  skillSettingsSelectedId = String(id || '');
  setSkillEditorOpen(true);
  const idEl = document.getElementById('skillEditId');
  const nameEl = document.getElementById('skillEditName');
  const descEl = document.getElementById('skillEditDesc');
  const instEl = document.getElementById('skillEditInst');
  if (idEl) {
    idEl.value = skillSettingsSelectedId;
    idEl.readOnly = true;
  }
  try {
    const detail = await workspaceRpc('getSkillDetail', { id: skillSettingsSelectedId });
    if (nameEl) nameEl.value = detail.name || '';
    if (descEl) descEl.value = detail.description || '';
    if (instEl) instEl.value = detail.instructions || '';
    fillSkillResources(detail);
    const origin = detail.origin || 'packaged';
    const resetBtn = document.getElementById('skillResetBtn');
    const deleteBtn = document.getElementById('skillDeleteBtn');
    if (resetBtn) resetBtn.hidden = origin !== 'overlay';
    if (deleteBtn) deleteBtn.hidden = origin === 'packaged' || origin === 'overlay';
    await refreshSkillSettingsList();
  } catch (e) {
    showSidepanelToast(String(e?.message || e), { error: true });
  }
}

function openNewSkillEditor() {
  skillSettingsIsNew = true;
  skillSettingsSelectedId = '';
  const idEl = document.getElementById('skillEditId');
  const nameEl = document.getElementById('skillEditName');
  const descEl = document.getElementById('skillEditDesc');
  const instEl = document.getElementById('skillEditInst');
  if (idEl) {
    idEl.value = '';
    idEl.readOnly = false;
  }
  if (nameEl) nameEl.value = '';
  if (descEl) descEl.value = '';
  if (instEl) instEl.value = '';
  fillSkillResources({ resources: [] });
  const resetBtn = document.getElementById('skillResetBtn');
  const deleteBtn = document.getElementById('skillDeleteBtn');
  if (resetBtn) resetBtn.hidden = true;
  if (deleteBtn) deleteBtn.hidden = true;
  setSkillEditorOpen(true);
  void refreshSkillSettingsList();
  idEl?.focus();
}

async function saveSkillFromEditor() {
  const idEl = document.getElementById('skillEditId');
  const nameEl = document.getElementById('skillEditName');
  const descEl = document.getElementById('skillEditDesc');
  const instEl = document.getElementById('skillEditInst');
  const id = String(idEl?.value || '').trim();
  const description = String(descEl?.value || '').trim();
  if (!id || !description) {
    showSidepanelToast(t('skillNeedIdDesc'), { error: true });
    return false;
  }
  const current = skillSettingsCatalog.find((s) => s.id === id);
  let origin = 'authored';
  if (!skillSettingsIsNew && current) {
    origin = current.origin === 'packaged' ? 'overlay' : current.origin || 'authored';
  }
  try {
    const saved = await workspaceRpc('upsertSkill', {
      id,
      name: String(nameEl?.value || id).trim(),
      description,
      instructions: String(instEl?.value || ''),
      origin
    });
    invalidateSkillCatalogCache();
    skillSettingsIsNew = false;
    skillSettingsSelectedId = saved?.skill?.id || id;
    showSidepanelToast(`${t('skillSave')} · ${skillSettingsSelectedId}`);
    await openSkillEditor(skillSettingsSelectedId);
    return true;
  } catch (e) {
    showSidepanelToast(String(e?.message || e), { error: true });
    return false;
  }
}

async function removeSkillLocal(id) {
  const label = String(id || '');
  if (!label) return;
  const ok = window.confirm(
    currentLang === 'en' ? `Remove local overlay for ${label}?` : `删除「${label}」的本机条？`
  );
  if (!ok) return;
  try {
    await workspaceRpc('deleteSkill', { id: label });
    invalidateSkillCatalogCache();
    if (skillSettingsSelectedId === label) {
      skillSettingsSelectedId = '';
      setSkillEditorOpen(false);
    }
    await refreshSkillSettingsList();
  } catch (e) {
    showSidepanelToast(String(e?.message || e), { error: true });
  }
}

async function importSkillFromSettings() {
  const input = document.getElementById('skillImportUrl');
  const hint = document.getElementById('skillImportHint');
  const url = String(input?.value || '').trim();
  if (!url) return;
  if (hint) {
    hint.hidden = false;
    hint.textContent = '…';
  }
  try {
    const res = await workspaceRpc('importSkill', { url });
    if (!res?.ok) {
      const msg = res?.error || 'import failed';
      if (hint) hint.textContent = msg;
      showSidepanelToast(msg, { error: true });
      return;
    }
    invalidateSkillCatalogCache();
    if (hint) hint.textContent = res.skill?.id || 'ok';
    if (input) input.value = '';
    await openSkillEditor(res.skill.id);
  } catch (e) {
    const msg = String(e?.message || e);
    if (hint) hint.textContent = msg;
    showSidepanelToast(msg, { error: true });
  }
}

function openSkillsSettingsModal() {
  /** @type {HTMLDialogElement|null} */
  const modal = /** @type {HTMLDialogElement|null} */ (
    document.getElementById('skillsSettingsModal')
  );
  if (!modal) return;
  const returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.getElementById('moreSkillsBtn') || document.getElementById('moreBtn');
  void refreshSkillSettingsList();
  const focus =
    document.getElementById('skillImportUrl') ||
    document.getElementById('skillAddBtn') ||
    document.getElementById('skillsModalDoneBtn');
  openDialog(modal, {
    returnFocus: returnFocus instanceof HTMLElement ? returnFocus : null,
    focus: focus instanceof HTMLElement ? focus : null
  });
}

function setupSkillsSettings() {
  const modal = /** @type {HTMLDialogElement|null} */ (
    document.getElementById('skillsSettingsModal')
  );
  if (modal) {
    wireDialogChrome(modal, {
      closeSelectors: ['#skillsModalCloseBtn', '#skillsModalDoneBtn'],
      closeOnBackdrop: true
    });
  }
  document.getElementById('skillImportBtn')?.addEventListener('click', () => {
    void importSkillFromSettings();
  });
  document.getElementById('skillImportUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void importSkillFromSettings();
    }
  });
  document.getElementById('skillAddBtn')?.addEventListener('click', () => {
    openNewSkillEditor();
  });
  document.getElementById('skillSaveBtn')?.addEventListener('click', () => {
    void saveSkillFromEditor();
  });
  document.getElementById('skillResetBtn')?.addEventListener('click', () => {
    if (skillSettingsSelectedId) void removeSkillLocal(skillSettingsSelectedId);
  });
  document.getElementById('skillDeleteBtn')?.addEventListener('click', () => {
    if (skillSettingsSelectedId) void removeSkillLocal(skillSettingsSelectedId);
  });
}

/* ===== PART: skills ===== */

/**
 * Skills catalog modal — list local user skills; one-click re-run via Agent.
 * (setupSkillCatalogModal was missing after settings rewrite and crashed boot.)
 */
function setupSkillCatalogModal() {
  const catalogBtn = document.getElementById('skillCatalogBtn');
  const modalEl = document.getElementById('skillCatalogModal');
  const closeBtn = document.getElementById('skillModalCloseBtn');
  const gridEl = document.getElementById('skillCardsGrid');
  if (!modalEl || !gridEl) return;

  /** @type {HTMLElement|null} */
  let returnFocus = null;

  const close = () => {
    try {
      if (modalEl.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    } catch (_) {}
    modalEl.classList.remove('active');
    setTimeout(() => {
      modalEl.style.display = 'none';
    }, 150);
    const el = returnFocus || catalogBtn;
    returnFocus = null;
    if (el && document.contains(el)) {
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
        } catch (_) {}
      });
    }
  };

  const open = async () => {
    returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : catalogBtn;
    closeMoreSheet({ restoreFocus: false });
    await renderSkillCatalogGrid();
    modalEl.style.display = 'flex';
    setTimeout(() => {
      modalEl.classList.add('active');
      try {
        closeBtn?.focus?.({ preventScroll: true });
      } catch (_) {}
    }, 10);
  };

  if (catalogBtn) {
    catalogBtn.addEventListener('click', () => {
      void open();
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', close);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalEl.style.display === 'none' || !modalEl.classList.contains('active')) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    close();
  });
}

/**
 * Render user skills into #skillCardsGrid.
 */
async function renderSkillCatalogGrid() {
  const gridEl = document.getElementById('skillCardsGrid');
  if (!gridEl) return;

  let skills = [];
  try {
    skills = await loadUserSkills();
  } catch (e) {
    console.warn('[PageWand] loadUserSkills failed', e);
  }

  if (!skills.length) {
    gridEl.innerHTML =
      '<p class="settings-hint" style="margin:8px 0">暂无已保存的 Skill。可通过技能创建流程或 Agent 工具写入。</p>';
    return;
  }

  gridEl.innerHTML = '';
  for (const skill of skills) {
    const item = document.createElement('div');
    item.className = 'skill-card-item';
    item.dataset.skillId = skill.id;

    const main = document.createElement('div');
    main.style.minWidth = '0';
    main.style.flex = '1';

    const title = document.createElement('div');
    title.className = 'skill-card-title';
    title.textContent = skill.name || 'Untitled Skill';

    const desc = document.createElement('div');
    desc.className = 'skill-card-desc';
    desc.textContent =
      skill.description ||
      (skill.promptTemplate ? String(skill.promptTemplate).slice(0, 100) : '（无描述）');

    main.appendChild(title);
    main.appendChild(desc);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.flexShrink = '0';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'skill-load-btn';
    runBtn.textContent = '一键运行';
    runBtn.title = '走多步 Agent Runtime（消耗 API）';
    runBtn.addEventListener('click', async () => {
      const modalEl = document.getElementById('skillCatalogModal');
      if (modalEl) {
        modalEl.classList.remove('active');
        modalEl.style.display = 'none';
      }
      await runUserSkillById(skill.id);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'skill-load-btn';
    delBtn.textContent = '删除';
    delBtn.title = '删除此 Skill';
    delBtn.style.opacity = '0.75';
    delBtn.addEventListener('click', async () => {
      try {
        await deleteUserSkill(skill.id);
        await renderSkillCatalogGrid();
      } catch (err) {
        showCustomModal({
          title: '删除失败',
          placeholder: '',
          initialValue: err?.message || String(err),
          onConfirm: () => {}
        });
      }
    });

    actions.appendChild(runBtn);
    actions.appendChild(delBtn);
    item.appendChild(main);
    item.appendChild(actions);
    gridEl.appendChild(item);
  }
}

/**
 * Resolve stable task-body host for action controls (never mount only inside .md-body).
 * @param {{ body?: HTMLElement, el?: HTMLElement }|HTMLElement|null} taskOrEl
 * @returns {HTMLElement|null}
 */
function resolveTaskActionsHost(taskOrEl) {
  if (!taskOrEl) return null;
  if (taskOrEl.body instanceof HTMLElement) return taskOrEl.body;
  if (!(taskOrEl instanceof HTMLElement)) return null;
  if (taskOrEl.classList.contains('task-body')) return taskOrEl;
  if (taskOrEl.classList.contains('md-body')) {
    return taskOrEl.closest('.task-body') || taskOrEl.parentElement;
  }
  return taskOrEl.closest?.('.task-body') || taskOrEl;
}

function openSaveSkillModal(runMeta) {
  const meta = runMeta || lastAgentRunMeta;
  if (!meta) {
    showCustomModal({
      title: '提示',
      placeholder: '',
      initialValue: '暂无成功运行记录可固化。请先完成一次 Browser Agent 任务。',
      onConfirm: () => {}
    });
    return;
  }

  const prefillName = deriveSkillNameUi(meta.prompt);
  const prefillDesc = (meta.finalText || meta.prompt || '').replace(/\s+/g, ' ').slice(0, 120);

  // Two-field flow: name first, then description via second modal or combined input
  showCustomModal({
    title: '💾 固化为 Skill — 名称',
    placeholder: '技能名称，如：商品图打包下载',
    initialValue: prefillName,
    onConfirm: (name) => {
      if (!name || !name.trim()) return;
      showCustomModal({
        title: '💾 固化为 Skill — 描述',
        placeholder: '简短描述这个技能做什么…',
        initialValue: prefillDesc,
        onConfirm: async (description) => {
          try {
            const skill = skillFromRunSnapshot({
              name: name.trim(),
              description: (description || '').trim(),
              prompt: meta.prompt,
              pageMeta: meta.pageMeta,
              extractedCode: meta.extractedCode,
              traces: meta.traces,
              sessionId: meta.sessionId
            });
            const saved = await upsertUserSkill(skill);
            showCustomModal({
              title: '已保存',
              placeholder: '',
              initialValue: `✅ Skill「${saved.name}」已保存。\n打开 🧩 技能库 可一键重跑（仍走多步 Agent，会消耗 API）。`,
              onConfirm: () => {}
            });
          } catch (err) {
            showCustomModal({
              title: '保存失败',
              placeholder: '',
              initialValue: err.message || String(err),
              onConfirm: () => {}
            });
          }
        }
      });
    }
  });
}

function deriveSkillNameUi(prompt) {
  const p = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!p) return '我的 Skill';
  return p.length > 36 ? p.slice(0, 36) + '…' : p;
}

/**
 * One-click re-run: full multi-step Agent with skill recipe (primary).
 */
async function runUserSkillById(skillId) {
  if (isCurrentSessionRunning()) return;
  const skills = await loadUserSkills();
  const skill = findSkill(skills, skillId);
  if (!skill) {
    showCustomModal({
      title: '提示',
      placeholder: '',
      initialValue: '未找到该 Skill。',
      onConfirm: () => {}
    });
    return;
  }

  await refreshSelectedElementsFromActiveTab();

  const promptText = skill.promptTemplate || skill.name;
  const display = `🧩 Skill: ${skill.name}\n${promptText}`;
  let activeSess = sessions.find((s) => s.id === activeSessionId) || sessions[0];
  activeSess.messages.push({
    role: 'user',
    content: `[Skill re-run: ${skill.name}]\n${promptText}`,
    ts: Date.now()
  });
  savePersistentSessions();

  const task = createTaskCard(truncateUi(skill.name || promptText, 48));
  if (!task) return;
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.textContent = display;
  task.append(userMsg);

  const historyMessages = (activeSess.messages || []).slice(-10).map((m) => ({
    role: m.role,
    content: m.content || ''
  }));
  await refreshWorkspaceGroupState();
  // Single sendMessage → general agent (do not double-send)
  await runBrowserAgentTurn({
    prompt: `[Skill: ${skill.name}]\n${promptText}`,
    activeSess,
    task,
    skill
  });
}


/** Legacy helpers adapted to task-first shell */
function appendUserMessageUI(text) {
  const task = createTaskCard(truncateUi(String(text || ''), 48));
  if (!task) return null;
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  userMsg.textContent = text;
  task.append(userMsg);
  return task;
}

function appendAssistantMessageUI(thoughtText, markdownContent, extractedCode, taskStatus) {
  const task = liveTask || createTaskCard('…');
  if (!task) return;
  appendAssistantTurn(task, {
    thought: thoughtText || '',
    content: markdownContent || ''
  });
  task.setState(mapTaskUiState(taskStatus || 'claimed_done'));
}

function createAssistantMessagePlaceholder() {
  // Compatibility shim: returns a fake host; prefer createTaskCard + runBrowserAgentTurn({task})
  const task = createTaskCard('…');
  const host = document.createElement('div');
  host.className = 'message assistant';
  host.innerHTML = `<div class="message-content"><div class="thought-box-container"></div><div class="main-text-content"></div></div>`;
  if (task) task.append(host);
  return host;
}

function renderThoughtContent(container, thoughtText) {
  if (!container) return;
  container.innerHTML = `<div class="think-block is-collapsed"><div class="think-body" style="padding:8px;white-space:pre-wrap;font-size:11.5px;color:var(--text-muted)">${escapeHtml(thoughtText || '')}</div></div>`;
}

async function triggerPackageZip() {
  showCustomModal({
    title: 'Unavailable',
    placeholder: '',
    initialValue:
      '本地 Python 打包已移除。产品为 Chrome 扩展 only + 云端 BYOK LLM，无需 :8000 服务。',
    onConfirm: () => {}
  });
}

async function loadFilesForProject(_projectName) {
  /* removed: local Python file server */
}

// Boot AFTER all let/const bindings (sidepanel is a large module; early boot caused TDZ on clipExportPopover).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootSidePanel);
} else {
  queueMicrotask(() => bootSidePanel());
}
