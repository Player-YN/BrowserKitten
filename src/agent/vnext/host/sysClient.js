/** One browser call, with an identity independent of the message port. */
export async function callBrowserSys({ op, params, sessionId, executionId, signal, deadline, operationId, payloadHash, ticketNonce }) {
  signal?.throwIfAborted();
  const callId = crypto.randomUUID();
  const envelope = {
    target: 'browserbot-background',
    action: 'workspace_sys',
    sessionId,
    executionId,
    callId,
    operationId,
    payloadHash,
    ticketNonce
  };
  const cancel = () => {
    void chrome.runtime.sendMessage({ ...envelope, op: 'cancel' }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await chrome.runtime.sendMessage({ ...envelope, op, params, deadline });
    if (result && typeof result.ok === 'boolean') return result;
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', callId, outcome: 'unknown',
      error: 'Browser response missing; inspect state before retrying.' };
  } catch (error) {
    return { ok: false, code: 'SYS_OUTCOME_UNKNOWN', callId, outcome: 'unknown',
      error: `Browser response lost; do not replay automatically. ${error?.message || error}` };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
