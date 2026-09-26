import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));

test('no mode switch anywhere in the side panel; approval UI and host gate modules remain', async () => {
  const html = readFileSync(join(root, 'src/sidepanel.html'), 'utf8');
  for (const id of ['accessPolicyChip', 'accessFullDialog', 'accessRememberProfile']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.equal(existsSync(join(root, 'src/sidepanel/accessPolicyUi.js')), false);
  const i18n = readFileSync(join(root, 'src/sidepanel/i18n.js'), 'utf8');
  assert.doesNotMatch(i18n, /accessChipGuarded|accessFullHint/);
  for (const key of ['approvalPaymentWait', 'approvalApprove']) assert.match(i18n, new RegExp(`${key}:`));
  const panel = readFileSync(join(root, 'src/sidepanel.js'), 'utf8');
  assert.doesNotMatch(panel, /setAccessPolicy|createAccessPolicyUi/);
  assert.match(panel, /createApprovalUi/);
  const rpc = readFileSync(join(root, 'src/agent/vnext/host/workspaceRpcContract.js'), 'utf8');
  assert.doesNotMatch(rpc, /AccessPolicy/);
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');
  assert.doesNotMatch(bg, /workspace_policy_(get|set)/);
  assert.match(bg, /workspace_ticket_put/);
  assert.match(bg, /workspace_ticket_drop/);
  assert.match(bg, /STORAGE_BRIDGE_DENIED = new Set\(\[DISPATCH_TICKETS_KEY\]\)/);

  for (const spec of [
    '../src/agent/vnext/host/riskClassify.js',
    '../src/agent/vnext/host/accessPolicy.js',
    '../src/agent/vnext/host/dispatchTicket.js',
    '../src/agent/vnext/host/callJournal.js',
    '../src/agent/vnext/host/postcondition.js',
    '../src/agent/vnext/host/operationGate.js',
    '../src/agent/vnext/sessionWorkspace/approvalGate.js',
    '../src/sidepanel/approvalUi.js'
  ]) {
    assert.equal(typeof (await import(spec)), 'object');
  }
});
