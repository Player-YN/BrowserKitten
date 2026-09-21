import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));

test('sidepanel HTML, i18n, and JS modules reference the new policy surfaces', async () => {
  const html = readFileSync(join(root, 'src/sidepanel.html'), 'utf8');
  for (const id of ['accessPolicyChip', 'accessFullDialog', 'accessRememberProfile']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="settingsAccessCard"/);
  assert.doesNotMatch(html, /id="accessFullToggle"/);
  assert.match(html, /无法保证不会发生未识别的付款或删除/);
  const i18n = readFileSync(join(root, 'src/sidepanel/i18n.js'), 'utf8');
  for (const key of ['accessFullHint', 'approvalPaymentWait', 'approvalApprove', 'accessRememberProfile']) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
  const panel = readFileSync(join(root, 'src/sidepanel.js'), 'utf8');
  assert.match(panel, /createAccessPolicyUi/);
  assert.match(panel, /createApprovalUi/);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.ok(manifest.permissions.includes('storage'));
  const bg = readFileSync(join(root, 'src/background.js'), 'utf8');
  assert.match(bg, /workspace_policy_get/);
  assert.match(bg, /workspace_ticket_put/);
  assert.match(bg, /workspace_ticket_drop/);
  assert.match(bg, /STORAGE_BRIDGE_DENIED/);

  const mods = [
    '../src/agent/vnext/host/riskClassify.js',
    '../src/agent/vnext/host/accessPolicy.js',
    '../src/agent/vnext/host/dispatchTicket.js',
    '../src/agent/vnext/host/callJournal.js',
    '../src/agent/vnext/host/postcondition.js',
    '../src/agent/vnext/host/operationGate.js',
    '../src/agent/vnext/sessionWorkspace/approvalGate.js',
    '../src/sidepanel/accessPolicyUi.js',
    '../src/sidepanel/approvalUi.js'
  ];
  for (const spec of mods) {
    const ns = await import(spec);
    assert.equal(typeof ns, 'object');
  }
});
