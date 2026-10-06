/**
 * Offscreen orchestration: classify → journal → approval → ticket → SW dispatch.
 * SW still reclassifies and consumes the ticket. Model fields never decide.
 */

import { adoptTrustedClassified, decideAccess, rawEscapeFor, needsDispatchTicket, policyErrorCode, RISK_PAYMENT, CONF_KNOWN } from './riskClassify.js';
import { readEffectiveAccessPolicy, snapshotAccessPolicy } from './accessPolicy.js';
import { hashOperationPayload, newNonce, newOperationId } from './payloadHash.js';
import { dropDispatchTicket, putDispatchTicket } from './dispatchTicket.js';
import { slimJournalAudit } from './callJournal.js';
import {
  abortExecutionApprovals,
  answerApprovalWaiter,
  createApprovalRecord,
  issueApprovalReceipt,
  waitForApproval
} from '../sessionWorkspace/approvalGate.js';
import { applyVerifyToJournalState, defaultPostconditions, verifyPostconditions } from './postcondition.js';

const TICKET_TTL_MS = 5 * 60 * 1000;

function fail(code, message, extra = {}) {
  return { ok: false, code, error: message, outcome: extra.outcome || 'denied', ...extra };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Execution aborted before dispatch.');
    err.code = 'SYS_ABORTED';
    throw err;
  }
}

function classifyInputFromRequest(req) {
  return {
    channel: req.channel,
    op: req.op,
    sysOp: req.sysOp || (req.channel === 'sys' ? req.op : undefined),
    act: req.act,
    ref: req.ref,
    name: req.name || req.label,
    label: req.label,
    key: req.key,
    url: req.control?.frameUrl || req.frameUrl || req.url,
    frameUrl: req.control?.frameUrl || req.frameUrl,
    method: req.method || req.init?.method,
    code: req.code || req.params?.code,
    bodyText: typeof req.init?.body === 'string' ? req.init.body : '',
    control: req.control,
    hints: req.hints || req.control?.hints,
    tabId: req.tabId,
    frameId: req.frameId,
    documentId: req.documentId,
    artifactId: req.artifactId,
    expectedRevision: req.expectedRevision,
    filename: req.filename,
    init: req.init,
    params: req.params,
    path: req.path,
    bytesHash: req.bytesHash,
    itemId: req.itemId,
    artifactId: req.artifactId,
    uploadMethod: req.uploadMethod || (req.op === 'upload' ? req.method : undefined)
  };
}

export async function gatedDispatch(req = {}, deps = {}) {
  const send = deps.send;
  const journal = deps.journal;
  const now = deps.now || Date.now();
  const signal = deps.signal;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const putTicket = typeof deps.putTicket === 'function' ? deps.putTicket : putDispatchTicket;
  const readPolicy = typeof deps.readPolicy === 'function' ? deps.readPolicy : readEffectiveAccessPolicy;

  const classifyInput = classifyInputFromRequest(req);
  const classified = adoptTrustedClassified(req.classified, classifyInput);
  const policy = await readPolicy();
  const snap = snapshotAccessPolicy(policy, now);
  const rawEscape = rawEscapeFor(classified.risk);
  const operationId = String(req.operationId || newOperationId());
  const payloadHash = req.payloadHash || await hashOperationPayload({
    ...classifyInput,
    tabId: req.tabId,
    documentId: req.documentId,
    frameUrl: classifyInput.frameUrl,
    url: classifyInput.frameUrl || classifyInput.url
  });
  const requestId = String(req.requestId || req.callId || req.toolCallId || '');
  const posts = defaultPostconditions({
    ...req,
    channel: req.channel,
    risk: classified.risk,
    op: req.op,
    ref: req.ref,
    artifactId: req.artifactId,
    unprovable: req.unprovable
  });

  const baseRow = {
    operationId,
    requestId,
    sessionId: req.sessionId,
    executionId: req.executionId,
    taskId: req.taskId || null,
    intent: { channel: req.channel || 'action', op: req.op || '', act: req.act || req.method || '' },
    risk: classified.risk,
    confidence: classified.confidence,
    accessMode: policy.mode,
    rawEscape,
    reason: classified.reason,
    target: classified.target,
    batchSize: req.batchSize || classified.target?.frames?.length || 0,
    payloadHash,
    policySnapshot: snap,
    preconditions: req.preconditions || [],
    postconditions: req.postconditions || posts
  };

  const writeJournal = needsDispatchTicket(classified);
  if (writeJournal) {
    if (!journal) return fail('JOURNAL_UNAVAILABLE', 'Call journal is required before a mutating dispatch.', { operationId });
    try {
      const dup = await journal.findDuplicate(req.sessionId, payloadHash, req.documentId);
      if (dup) {
        return fail('DUPLICATE_INTENT', 'Identical succeeded intent was not replayed. Read back first.', {
          operationId: dup.operationId,
          accessMode: policy.mode,
          confidence: classified.confidence
        });
      }
      await journal.commit({ ...baseRow, state: 'prepared' });
    } catch (error) {
      return fail(error?.code || 'JOURNAL_UNAVAILABLE', error?.message || 'journal write failed', { operationId });
    }
  }

  if (classified.risk === RISK_PAYMENT && classified.confidence === CONF_KNOWN) {
    if (writeJournal) {
      await journal.update(operationId, {
        state: 'failed',
        outcome: 'denied',
        error: { code: 'PAYMENT_DENIED', message: 'Known payment is never dispatched.' }
      });
      broadcast({ type: 'policy', sessionId: req.sessionId, ...slimJournalAudit(await journal.get(operationId), { type: 'policy', code: 'PAYMENT_DENIED' }) });
      broadcast({
        type: 'policy-blocked',
        kind: 'payment-handoff',
        sessionId: req.sessionId,
        executionId: req.executionId,
        approvalId: '',
        operationId,
        risk: 'payment',
        summary: '请你接管付款',
        detail: classified.summary,
        decisionRequired: false,
        tabId: req.tabId,
        documentId: req.documentId,
        url: classified.target?.url || req.frameUrl || req.url
      });
    }
    return fail('PAYMENT_DENIED', 'Known payment is never dispatched.', {
      operationId,
      accessMode: policy.mode,
      confidence: classified.confidence,
      rawEscape
    });
  }

  const decision = decideAccess(classified);
  if (decision === 'deny') {
    const code = policyErrorCode(decision, classified) || 'POLICY_DENIED';
    if (writeJournal) {
      await journal.update(operationId, { state: 'failed', outcome: 'denied', error: { code, message: classified.summary } });
      broadcast({ type: 'policy', sessionId: req.sessionId, ...slimJournalAudit(await journal.get(operationId), { type: 'policy', code }) });
    }
    return fail(code, classified.summary || 'Policy denied this operation.', {
      operationId,
      accessMode: policy.mode,
      confidence: classified.confidence,
      rawEscape
    });
  }

  let approvalReceipt = null;
  let ticketNonce = '';
  if (decision === 'approve') {
    if (!journal) return fail('JOURNAL_UNAVAILABLE', 'Approval requires a durable journal.', { operationId });
    const approval = createApprovalRecord({
      operationId,
      sessionId: req.sessionId,
      executionId: req.executionId,
      taskId: req.taskId,
      tabId: req.tabId,
      documentId: req.documentId,
      url: classified.target?.url || req.url,
      risk: classified.risk,
      confidence: classified.confidence,
      summary: classified.summary,
      detail: classified.target?.name || req.name || req.ref || '',
      policySnapshot: snap,
      payloadHash,
      now
    });
    for (const old of await journal.listApprovals(req.sessionId)) {
      if (old.state === 'pending' && old.approvalId !== approval.approvalId) {
        old.state = 'superseded';
        await journal.putApproval(old);
      }
    }
    await journal.putApproval(approval);
    await journal.update(operationId, { state: 'awaiting_approval', approvalId: approval.approvalId });
    broadcast({
      type: 'approval-required',
      sessionId: req.sessionId,
      executionId: req.executionId,
      approvalId: approval.approvalId,
      operationId,
      risk: classified.risk,
      summary: classified.risk === 'delete' ? `等待你确认删除 · ${classified.summary}` : `等待你确认看不清的提交 · ${classified.summary}`,
      detail: approval.detail,
      expiresAt: approval.expiresAt,
      tabId: req.tabId,
      documentId: req.documentId,
      url: approval.url,
      decisionRequired: true
    });
    let answer;
    try {
      answer = await waitForApproval({
        approvalId: approval.approvalId,
        sessionId: req.sessionId,
        executionId: req.executionId,
        signal
      });
    } catch (error) {
      const code = error?.code || 'APPROVAL_EXPIRED';
      await journal.update(operationId, { state: 'failed', outcome: 'denied', error: { code, message: error?.message || 'approval ended' } });
      approval.state = 'expired';
      approval.decidedAt = Date.now();
      await journal.putApproval(approval);
      broadcast({ type: 'approval-done', sessionId: req.sessionId, approvalId: approval.approvalId, operationId, decision: 'expired', code });
      return fail(code, 'Approval expired or execution ended.', { operationId, accessMode: policy.mode, confidence: classified.confidence });
    }
    if (!answer || answer.decision !== 'approve') {
      approval.state = 'denied';
      approval.decidedAt = Date.now();
      await journal.putApproval(approval);
      await journal.update(operationId, {
        state: 'failed',
        outcome: 'denied',
        error: { code: 'APPROVAL_DENIED', message: 'User denied this operation.' }
      });
      broadcast({ type: 'approval-done', sessionId: req.sessionId, approvalId: approval.approvalId, operationId, decision: 'deny', code: 'APPROVAL_DENIED' });
      return fail('APPROVAL_DENIED', 'User denied this operation.', { operationId, accessMode: policy.mode, confidence: classified.confidence });
    }
    approvalReceipt = issueApprovalReceipt(approval, payloadHash);
    approval.state = 'approved';
    approval.decidedAt = Date.now();
    approval.receipt = approvalReceipt;
    await journal.putApproval(approval);
    await journal.update(operationId, { state: 'authorized', approvalId: approval.approvalId, approvalReceipt });
    const stillPending = !!(await hostGetPendingApproval(journal, req.sessionId));
    broadcast({ type: 'approval-done', sessionId: req.sessionId, approvalId: approval.approvalId, operationId, decision: 'approve', stillPending });
  } else if (writeJournal) {
    await journal.update(operationId, { state: 'authorized' });
  }

  if (writeJournal) {
    ticketNonce = approvalReceipt?.nonce || newNonce();
    const ticket = {
      operationId,
      nonce: ticketNonce,
      sessionId: String(req.sessionId || ''),
      executionId: String(req.executionId || ''),
      risk: classified.risk,
      payloadHash,
      tabId: req.tabId,
      documentId: (Number(req.batchSize) > 1 || (classified.target?.frames?.length || 0) > 1)
        ? undefined
        : req.documentId,
      exp: now + TICKET_TTL_MS
    };
    try {
      await putTicket(ticket);
      try {
        throwIfAborted(signal);
      } catch (abortErr) {
        const drop = typeof deps.dropTicket === 'function' ? deps.dropTicket : dropDispatchTicket;
        await drop(operationId);
        await journal.update(operationId, {
          state: 'failed',
          outcome: 'aborted',
          error: { code: 'SYS_ABORTED', message: abortErr.message || 'Aborted after authorize; nothing was dispatched.' }
        });
        return fail('SYS_ABORTED', 'Execution aborted before dispatch.', { operationId, outcome: 'aborted' });
      }
      await journal.update(operationId, { state: 'dispatched' });
    } catch (error) {
      await journal.update(operationId, {
        state: 'failed',
        outcome: 'failed',
        error: { code: error?.code || 'JOURNAL_UNAVAILABLE', message: error?.message || 'ticket/journal failed before dispatch' }
      });
      return fail(error?.code || 'JOURNAL_UNAVAILABLE', 'Write-ahead failed; nothing was dispatched.', { operationId });
    }
  }

  if (typeof send !== 'function') {
    return fail('TICKET_REQUIRED', 'No dispatch function.', { operationId });
  }

  try {
    throwIfAborted(signal);
  } catch (abortErr) {
    if (writeJournal) {
      const drop = typeof deps.dropTicket === 'function' ? deps.dropTicket : dropDispatchTicket;
      await drop(operationId);
      await journal.update(operationId, {
        state: 'failed',
        outcome: 'aborted',
        error: { code: 'SYS_ABORTED', message: abortErr.message || 'Aborted before dispatch.' }
      });
    }
    return fail('SYS_ABORTED', 'Execution aborted before dispatch.', { operationId, outcome: 'aborted' });
  }

  let out;
  try {
    out = await send({
      ...req,
      operationId,
      payloadHash,
      ticketNonce,
      risk: classified.risk
    });
  } catch (error) {
    // A revision conflict is rejected before any write: a definite failure, not unknown.
    const definite = error?.code === 'ARTIFACT_CONFLICT';
    const outcome = definite ? 'failed' : 'unknown';
    if (writeJournal) {
      await journal.update(operationId, {
        state: outcome,
        outcome,
        error: { code: error?.code || 'SYS_OUTCOME_UNKNOWN', message: error?.message || 'dispatch threw' }
      });
    }
    return {
      ok: false,
      code: error?.code || 'SYS_OUTCOME_UNKNOWN',
      error: error?.message || String(error),
      outcome,
      ...(definite && error?.actualRevision != null ? { actualRevision: error.actualRevision } : {}),
      operationId,
      accessMode: policy.mode,
      confidence: classified.confidence
    };
  }

  if (writeJournal) {
    const unknown = out?.outcome === 'unknown' || /OUTCOME_UNKNOWN/.test(String(out?.code || ''));
    const ok = out && out.ok !== false && !unknown;
    await journal.update(operationId, {
      state: unknown ? 'unknown' : ok ? 'succeeded' : 'failed',
      outcome: unknown ? 'unknown' : ok ? 'ok' : 'failed',
      receipt: {
        ok: out?.ok !== false,
        code: out?.code,
        downloadId: out?.result?.downloadId ?? out?.downloadId,
        revision: out?.revision ?? out?.artifact?.revision ?? out?.result?.revision
      },
      error: ok ? undefined : { code: out?.code || 'FAILED', message: out?.error || '' }
    });
    const row = await journal.get(operationId);
    if (ok) {
      let facts = {};
      if (typeof deps.verifyFacts === 'function') {
        try {
          facts = await deps.verifyFacts(out, req, row) || {};
        } catch {
          facts = { snapshotOk: false };
        }
      }
      const result = await verifyPostconditions(row, { facts });
      const next = applyVerifyToJournalState(row, result);
      if (next !== row.state) {
        await journal.update(operationId, { state: next, verification: result });
      }
    }
    broadcast({ type: 'journal', sessionId: req.sessionId, ...slimJournalAudit(await journal.get(operationId)) });
  }

  return {
    ...(out && typeof out === 'object' ? out : { ok: !!out, result: out }),
    operationId,
    accessMode: policy.mode,
    confidence: classified.confidence,
    rawEscape,
    payloadHash
  };
}

export async function hostAnswerApproval(journal, params = {}) {
  const approvalId = String(params.approvalId || '');
  const sessionId = String(params.sessionId || '');
  const rec = await journal.getApproval(approvalId);
  if (!rec) return { ok: false, code: 'NOT_PENDING', error: 'no pending approval' };
  if (rec.sessionId !== sessionId) return { ok: false, code: 'APPROVAL_MISMATCH', error: 'approval belongs to another session' };
  if (params.payloadHash && rec.payloadHash && String(params.payloadHash) !== String(rec.payloadHash)) {
    return { ok: false, code: 'APPROVAL_MISMATCH', error: 'approval payload hash does not match' };
  }
  if (params.tabId != null && rec.tabId != null && Number(params.tabId) !== Number(rec.tabId)) {
    return { ok: false, code: 'APPROVAL_MISMATCH', error: 'approval tab does not match' };
  }
  if (params.documentId && rec.documentId && String(params.documentId) !== String(rec.documentId)) {
    return { ok: false, code: 'APPROVAL_MISMATCH', error: 'approval document does not match' };
  }
  if (rec.state !== 'pending') return { ok: false, code: 'NOT_PENDING', error: `approval is ${rec.state}` };
  if (Date.now() > Number(rec.expiresAt)) {
    rec.state = 'expired';
    rec.decidedAt = Date.now();
    await journal.putApproval(rec);
    if (rec.operationId) {
      try {
        await journal.update(rec.operationId, {
          state: 'failed',
          outcome: 'denied',
          error: { code: 'APPROVAL_EXPIRED', message: 'Approval expired.' }
        });
      } catch {
        /* row may already have moved */
      }
    }
    return { ok: false, code: 'APPROVAL_EXPIRED', error: 'approval expired' };
  }
  return answerApprovalWaiter({ approvalId, sessionId, decision: params.decision });
}

export async function hostGetPendingApproval(journal, sessionId) {
  const list = await journal.listApprovals(sessionId);
  const pending = list
    .filter((rec) => rec.state === 'pending' && Date.now() <= Number(rec.expiresAt))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return pending[0] || null;
}

export { abortExecutionApprovals };
