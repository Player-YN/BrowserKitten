/** Manifest-sandboxed guest host. No chrome.* — FS and sys are postMessage RPCs. */
import { SANDBOX_CHANNEL } from '../brand.js';
import { runCode } from '../agent/vnext/adapters/codeRuntime.js';
import { createRunDeadline } from '../agent/vnext/sessionWorkspace/runDeadline.js';

const CHANNEL = SANDBOX_CHANNEL;
const fsPending = new Map();
const sysPending = new Map();
const controllers = new Map();
const clocks = new Map();
let requestSeq = 0;

function callHostFs(runId, method, args) {
  const requestId = `${runId}:${++requestSeq}`;
  return new Promise((resolve, reject) => {
    fsPending.set(requestId, { resolve, reject });
    parent.postMessage({ channel: CHANNEL, type: 'fs-request', runId, requestId, method, args }, '*');
  });
}

function callHostSys(runId, op, params) {
  const requestId = `${runId}:${++requestSeq}`;
  return new Promise((resolve, reject) => {
    sysPending.set(requestId, { resolve, reject });
    parent.postMessage({ channel: CHANNEL, type: 'sys-request', runId, requestId, op, params }, '*');
  });
}

function createFs(runId) {
  return {
    readFile: (...args) => callHostFs(runId, 'readFile', args),
    writeFile: (...args) => callHostFs(runId, 'writeFile', args),
    readdir: (...args) => callHostFs(runId, 'readdir', args),
    mkdir: (...args) => callHostFs(runId, 'mkdir', args),
    stat: (...args) => callHostFs(runId, 'stat', args),
    exists: (...args) => callHostFs(runId, 'exists', args),
    remove: (...args) => callHostFs(runId, 'remove', args),
    rm: (...args) => callHostFs(runId, 'remove', args)
  };
}

function createSys(runId) {
  return {
    call: (op, params) => callHostSys(runId, op, params)
  };
}

window.addEventListener('message', async (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (!msg || msg.channel !== CHANNEL) return;

  if (msg.type === 'fs-response') {
    const pending = fsPending.get(msg.requestId);
    if (!pending) return;
    fsPending.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(new Error(msg.error || 'filesystem request failed'));
    return;
  }

  if (msg.type === 'sys-response') {
    const pending = sysPending.get(msg.requestId);
    if (!pending) return;
    sysPending.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(Object.assign(new Error(msg.error || 'sys request failed'), { code: msg.code || 'SYS_FAILED' }));
    return;
  }

  if (msg.type === 'abort') {
    controllers.get(msg.runId)?.abort();
    return;
  }

  if (msg.type === 'extend-deadline') {
    const clock = clocks.get(msg.runId);
    if (clock && Number.isFinite(msg.expiresAt)) {
      clock.extendToCover(Number(msg.expiresAt) - Date.now());
    }
    return;
  }

  if (msg.type !== 'run') return;
  const controller = new AbortController();
  controllers.set(msg.runId, controller);
  const deadline = createRunDeadline(msg.payload?.timeoutMs);
  if (Number.isFinite(msg.payload?.expiresAt)) {
    deadline.extendToCover(Number(msg.payload.expiresAt) - Date.now());
  }
  clocks.set(msg.runId, deadline);
  try {
    const result = await runCode({
      code: msg.payload?.code || '',
      entry: msg.payload?.entry || undefined,
      entryFile: msg.payload?.entryFile || undefined,
      files: msg.payload?.files || undefined,
      timeoutMs: msg.payload?.timeoutMs,
      deadline,
      memoryLimitBytes: msg.payload?.memoryLimitBytes,
      signal: controller.signal,
      fs: createFs(msg.runId),
      sys: createSys(msg.runId),
      runtime: 'local-quickjs'
    });
    parent.postMessage({ channel: CHANNEL, type: 'run-result', runId: msg.runId, ok: true, result }, '*');
  } catch (error) {
    parent.postMessage({
      channel: CHANNEL,
      type: 'run-result',
      runId: msg.runId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, '*');
  } finally {
    controllers.delete(msg.runId);
    clocks.delete(msg.runId);
    for (const pendingMap of [fsPending, sysPending]) {
      for (const [id, pending] of pendingMap) {
        if (!id.startsWith(`${msg.runId}:`)) continue;
        pendingMap.delete(id);
        pending.reject(Object.assign(new Error('run finished'), { code: 'SYS_ABORTED' }));
      }
    }
  }
});

function announceReady() {
  try {
    parent.postMessage({ channel: CHANNEL, type: 'ready' }, '*');
  } catch (_) {}
}
announceReady();
const readyPulse = setInterval(announceReady, 250);
window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (msg && msg.channel === CHANNEL && msg.type === 'ready-ack') {
    clearInterval(readyPulse);
  }
});
