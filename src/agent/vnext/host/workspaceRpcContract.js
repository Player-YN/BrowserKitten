/** Explicit transport contract. Adding a service method does NOT expose it over RPC. */
const reads = [
  'getChatMediaStatus',
  'getContextWindowStatus',
  'listSessions', 'getSession', 'getActiveExecution', 'listTasks', 'getTask',
  'getWorkspaceState', 'getAccessPolicy', 'getPendingApproval', 'listJournal', 'listJournalAnomalies',
  'exportJournal', 'listSkills', 'getSkillDetail', 'listArtifacts', 'readArtifact',
  'readArtifactPreview', 'downloadArtifact', 'readArtifactChunk',
  'getStorageStats', 'estimateStorage', 'readOutput', 'getTaskResult'
];
const writes = [
  'requestChatMediaCheck',
  'requestContextWindowCheck',
  'updateTask', 'renameSession', 'pruneSessions', 'allocateLabel', 'bindGroups',
  'createGroup', 'renameGroup', 'deleteGroup', 'setActiveGroup', 'pinClipboard',
  'removeClipboardItems', 'clearClipboard', 'removeGroupItem', 'addPageItems',
  'clearCaptureSelection', 'syncTabSelection', 'sendMessage', 'abortExecution',
  'abortCurrentExecution',
  'answerClarify', 'answerApproval', 'setAccessPolicy', 'abortTask', 'upsertSkill', 'importSkill', 'deleteSkill',
  'createArtifact', 'rewriteGuestMedia', 'revertArtifact', 'updateArtifact',
  'deleteArtifact', 'deleteSession', 'sweepOrphans', 'applyStoragePressure',
  'setActiveWorkbook', 'setActiveHtml', 'createBlankArtifact', 'createSheetArtifact',
  'suggestSelectionActions'
];
const previewMethods = new Set([
  'readArtifact', 'readArtifactPreview', 'downloadArtifact', 'readArtifactChunk',
  'updateArtifact', 'rewriteGuestMedia', 'revertArtifact'
]);
const descriptors = Object.create(null);
for (const method of reads) descriptors[method] = Object.freeze({ retrySafe: true, internal: false });
for (const method of writes) descriptors[method] = Object.freeze({ retrySafe: false, internal: false });
for (const method of ['getTaskSchedule', 'getBrowserRuntimeState']) {
  descriptors[method] = Object.freeze({ retrySafe: true, internal: true });
}
descriptors.runDueTasks = Object.freeze({ retrySafe: false, internal: true });
export const WORKSPACE_RPC_METHODS = Object.freeze(descriptors);

export function rpcFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function assertWorkspaceRpc(method, params, caller = 'ui') {
  const entry = Object.hasOwn(WORKSPACE_RPC_METHODS, method) ? WORKSPACE_RPC_METHODS[method] : null;
  if (!entry) throw rpcFailure('RPC_METHOD_DENIED', `Workspace method is not exposed: ${method}`);
  if (!params || typeof params !== 'object' || Array.isArray(params) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(params))) {
    throw rpcFailure('RPC_BAD_PARAMS', 'Workspace params must be an object.');
  }
  if (caller !== 'background' && (entry.internal || !['ui', 'preview'].includes(caller))) {
    throw rpcFailure('RPC_DENIED', 'This caller cannot invoke the workspace method.');
  }
  if (caller === 'preview' && !previewMethods.has(method)) {
    throw rpcFailure('RPC_DENIED', 'Preview pages may only read and save artifacts.');
  }
  return entry;
}

/** URL paths are compared against the extension URL, never an attacker-supplied caller field. */
export function workspaceSenderRole(sender, runtime) {
  if (!sender || sender.id !== runtime.id) return 'untrusted';
  const root = runtime.getURL('');
  const url = String(sender.url || '');
  if (!url) return sender.tab ? 'untrusted' : 'background';
  if (!url.startsWith(root)) return 'untrusted';
  let path;
  try { path = new URL(url).pathname; } catch { return 'untrusted'; }
  if (path === '/src/background.js' && !sender.tab) return 'background';
  if (path === '/src/offscreen/runtime.html' && !sender.tab) return 'offscreen';
  if (path === '/src/sidepanel.html') return 'ui';
  if (/^\/src\/preview\/(sheet|docs|site|artifactPreview)\.html$/.test(path)) return 'preview';
  return 'untrusted';
}

export async function dispatchWorkspaceRpc(service, message, sender, runtime) {
  if (workspaceSenderRole(sender, runtime) !== 'background') {
    throw rpcFailure('RPC_DENIED', 'Workspace execution requires the service worker.');
  }
  const method = String(message.method || '');
  const params = message.params ?? {};
  assertWorkspaceRpc(method, params, 'background');
  if (typeof service[method] !== 'function') throw rpcFailure('RPC_METHOD_DENIED', `Missing service method: ${method}`);
  return service[method](params);
}
