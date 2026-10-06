/** Shared sidepanel/preview client. Losing a write receipt never authorizes replay. */
import { MSG_TARGET_BACKGROUND } from '../../../brand.js';
import { formatRpcError } from './rpcError.js';
import { assertWorkspaceRpc, rpcFailure } from './workspaceRpcContract.js';

/**
 * Artifact writes whose result is never `{ ok: false }` as data: a resolved
 * `{ ok: false, code }` here (e.g. a host gate denial) is a failed write and
 * must not read as "saved". Other methods may return `ok: false` as data.
 */
const OK_FALSE_IS_FAILURE = new Set(['updateArtifact', 'revertArtifact', 'createArtifact', 'deleteArtifact']);

export async function workspaceRpc(method, params = {}) {
  const contract = assertWorkspaceRpc(method, params, 'ui');
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    throw rpcFailure('RPC_UNAVAILABLE', 'Workspace RPC requires an extension context.');
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({ target: MSG_TARGET_BACKGROUND, action: 'workspace_rpc', method, params });
  } catch (error) {
    throw rpcFailure(contract.retrySafe ? 'RPC_UNAVAILABLE' : 'RPC_OUTCOME_UNKNOWN',
      contract.retrySafe ? `Workspace unavailable: ${error?.message || error}` : 'Workspace write result is unknown. Inspect state before retrying.');
  }
  if (!response || typeof response.ok !== 'boolean') {
    throw rpcFailure(contract.retrySafe ? 'RPC_UNAVAILABLE' : 'RPC_OUTCOME_UNKNOWN',
      'Workspace result was not received. Inspect state before retrying a write.');
  }
  if (!response.ok) {
    throw Object.assign(new Error(`workspace RPC failed: ${method}: ${formatRpcError(response.error) || 'unknown'}`), {
      code: response.code || 'WORKSPACE_FAILED', actualRevision: response.actualRevision
    });
  }
  const result = response.result;
  if (OK_FALSE_IS_FAILURE.has(method) && result && typeof result === 'object' && result.ok === false) {
    const { error, ...rest } = result;
    throw Object.assign(new Error(`workspace RPC failed: ${method}: ${error != null ? formatRpcError(error) : (result.code || 'unknown')}`), {
      ...rest, code: result.code || 'WORKSPACE_FAILED'
    });
  }
  return result;
}
