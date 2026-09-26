import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_MODE, clearLegacyAccessPolicy, readEffectiveAccessPolicy } from '../src/agent/vnext/host/accessPolicy.js';
import { classifyRisk, decideAccess, policyErrorCode } from '../src/agent/vnext/host/riskClassify.js';
import { STORAGE_ACCESS_POLICY, STORAGE_ACCESS_POLICY_SESSION } from '../src/brand.js';

test('there is one access mode and nothing can switch it', async () => {
  assert.equal(ACCESS_MODE, 'full');
  assert.equal((await readEffectiveAccessPolicy()).mode, 'full');
  const src = readFileSync(new URL('../src/agent/vnext/host/accessPolicy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /export (async )?function write/);
});

test('the only hard rules: known payment is denied, known delete asks once, the rest runs', () => {
  const pay = classifyRisk({ channel: 'action', op: 'click', name: 'Place order', frameUrl: 'https://checkout.stripe.com/pay' });
  assert.equal(decideAccess(pay), 'deny');
  assert.equal(policyErrorCode('deny', pay), 'PAYMENT_DENIED');

  const del = classifyRisk({ channel: 'action', op: 'click', name: 'Delete account' });
  assert.equal(del.risk, 'delete');
  assert.equal(decideAccess(del), 'approve');

  for (const auto of [
    classifyRisk({ channel: 'action', op: 'click' }), // unknown
    classifyRisk({ channel: 'sys', op: 'eval', code: 'return 1' }), // raw page code
    classifyRisk({ channel: 'sys', op: 'cdp', action: 'attach' }) // raw CDP
  ]) {
    assert.equal(decideAccess(auto), 'auto', auto.risk);
  }
});

test('startup removes the old Guarded / Full storage keys', async () => {
  const bag = (seed) => {
    const m = new Map(Object.entries(seed));
    return { remove: async (k) => m.delete(k), _m: m };
  };
  const local = bag({ [STORAGE_ACCESS_POLICY]: { mode: 'guarded' }, other: 1 });
  const session = bag({ [STORAGE_ACCESS_POLICY_SESSION]: { mode: 'full' } });
  await clearLegacyAccessPolicy({ local, session });
  assert.deepEqual([...local._m.keys()], ['other']);
  assert.equal(session._m.size, 0);
  await clearLegacyAccessPolicy({ local: {}, session: null });
});
