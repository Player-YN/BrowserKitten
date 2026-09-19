/**
 * Product offscreen runtime — Session Workspace Service (unified sendMessage).
 */
import './silenceSdkWarnings.js';
import { SessionWorkspaceService } from '../agent/vnext/service/sessionWorkspaceService.js';
import { createSandboxCodeClient } from '../agent/vnext/adapters/sandboxClient.js';
import { formatRpcError } from '../agent/vnext/host/rpcError.js';
import { dispatchWorkspaceRpc } from '../agent/vnext/host/workspaceRpcContract.js';
import { isAbortLike } from '../agent/vnext/host/userStop.js';

const sandboxFrame = document.getElementById('pawwork-code-sandbox');
const sandboxClient = createSandboxCodeClient(sandboxFrame);
globalThis.__PAWWORK_CODE_SANDBOX_RUN__ = (opts) => sandboxClient.run(opts);

// Workspace store/RPC must not wait on the code sandbox. getWorkspaceState /
// syncTabSelection only need IDB. Gating boot on sandbox.ready made a missed
// handshake take down selection chrome for 15s+ forever.
let servicePromise = SessionWorkspaceService.create();
// The first workspace request never awaits discovery or media check network traffic.
void servicePromise.then(service => {
  service.requestChatMediaCheck();
  service.requestContextWindowCheck();
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'pawwork-offscreen' && message?.action === 'tab_listen_abort') {
    void (async () => {
      try {
        const service = await servicePromise;
        await service._listenRuntime?.abort({
          tabId: message.tabId,
          sessionId: message.sessionId,
          executionId: message.executionId
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
  if (message?.target !== 'pawwork-offscreen' || message?.action !== 'workspace_rpc_execute') return false;
  void (async () => {
    try {
      const service = await servicePromise;
      const result = await dispatchWorkspaceRpc(service, message, _sender, chrome.runtime);
      sendResponse({ ok: true, result });
    } catch (error) {
      try {
        sendResponse({ ok: false, error: formatRpcError(error), code: error?.code || 'WORKSPACE_FAILED',
          actualRevision: error?.actualRevision });
      } catch {
        /* port already closed */
      }
      if (!isAbortLike(error)) throw error;
    }
  })().catch((error) => {
    if (isAbortLike(error)) return;
    console.error('[offscreen] workspace rpc', error);
  });
  return true;
});
