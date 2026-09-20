import { MSG_TARGET_OFFSCREEN } from '../../../brand.js';
import { assertWorkspaceRpc, rpcFailure } from './workspaceRpcContract.js';

function transient(error) {
  return /Receiving end does not exist|Could not establish connection|message port closed|message channel closed/i.test(String(error?.message || error || ''));
}

/** Only explicit read methods can be retried after sendMessage has been called. */
export function createWorkspaceRpcTransport({ ensureRuntime, send, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 8 }) {
  return async function forward(request) {
    const method = String(request.method || '');
    const params = request.params ?? {};
    const contract = assertWorkspaceRpc(method, params, 'background');
    const payload = { target: MSG_TARGET_OFFSCREEN, action: 'workspace_rpc_execute', method, params };
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // A creation failure happens before dispatch, and is not an unknown write.
      await ensureRuntime();
      try {
        const response = await send(payload);
        if (response && typeof response === 'object' && typeof response.ok === 'boolean') return response;
        lastError = rpcFailure('RPC_OUTCOME_UNKNOWN', 'Workspace result is unknown; inspect state before retrying.');
        if (!contract.retrySafe) throw lastError;
      } catch (error) {
        if (!contract.retrySafe) {
          if (error?.code === 'RPC_OUTCOME_UNKNOWN') throw error;
          throw rpcFailure('RPC_OUTCOME_UNKNOWN', `Workspace delivery or result is unknown; do not replay automatically. ${error?.message || error}`);
        }
        if (!transient(error) && error?.code !== 'RPC_OUTCOME_UNKNOWN') throw error;
        lastError = error;
      }
      if (attempt + 1 < attempts) await sleep(40 * (attempt + 1));
    }
    throw lastError || rpcFailure('RPC_UNAVAILABLE', 'Workspace runtime unavailable.');
  };
}
