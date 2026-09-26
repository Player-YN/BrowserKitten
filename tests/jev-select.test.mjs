import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCandidates,
  uniqueNameMatch,
  arrivalMet,
  parseJevChoice,
  publicChooseReceipt,
  runChooseLoop,
  fetchJevChoice,
  jevSystemOneUrl,
  interpretJevProbeResponse,
  probeJevSystemOne,
  buildJevProbeBody,
  JEV_PROBE_CHOICES
} from '../src/agent/vnext/host/jevSelect.js';
import { isChatProvider, isJevProvider, normalizeProvider } from '../src/agent/llm.js';
import { slimAuditEvent } from '../src/agent/vnext/sessionWorkspace/sessionAudit.js';

test('named controls are candidates and captcha or canvas rows are not', () => {
  const rows = chooseCandidates([
    { ref: 'f0.a1', name: '下一页', role: 'button' },
    { ref: 'f0.a2', name: '', role: 'button' },
    { ref: 'f0.a3', name: '获取验证码', role: 'button' },
    { ref: 'f0.a4', name: '画布', role: 'canvas' },
    { ref: 'f0.a5', name: '投递', role: 'button', visible: false }
  ]);
  assert.deepEqual(rows.map((row) => row.ref), ['f0.a1']);
});

test('a unique name match skips Jev; several names do not', () => {
  const candidates = [
    { ref: 'f0.a1', name: '稍后再说', role: 'button' },
    { ref: 'f0.a2', name: '立即体验', role: 'button' }
  ];
  assert.equal(uniqueNameMatch('稍后再说', candidates)?.ref, 'f0.a1');
  assert.equal(uniqueNameMatch('关闭', candidates), null);
});

test('Jev choice outside the candidate list is an abstain and the receipt drops scores', () => {
  const refs = new Set(['f0.a1']);
  assert.deepEqual(parseJevChoice({ answers: { pick: { choice: 'f0.a9', probability: 0.9 } } }, refs), { abstain: true });
  assert.deepEqual(parseJevChoice({ answers: { pick: { choice: 'f0.a1', probability: 0.4 } } }, refs), { ref: 'f0.a1' });
  const receipt = publicChooseReceipt({
    ok: true,
    reason: 'arrived',
    steps: [{ subgoal: '下一页', name: '下一页', ref: 'f0.a1', via: 'OpenCode Zen', verified: true, url: 'https://example.com/p', documentId: 'd1', probability: 0.2 }]
  });
  assert.equal(receipt.hint.includes('Do not repeat'), true);
  assert.equal('probability' in receipt.steps[0], false);
  assert.equal(receipt.steps[0].verified, true);
  assert.equal(receipt.steps[0].via, 'OpenCode Zen');
});

test('verify failure stops and does not click again', async () => {
  let acts = 0;
  const receipt = await runChooseLoop({
    subgoal: '下一页',
    until: 'https://example.com/done',
    maxSteps: 4,
    observe: async () => ({
      page: { url: 'https://example.com/list', documentId: 'doc' },
      controls: [{ ref: 'f0.a1', name: '下一页', role: 'button' }]
    }),
    select: async () => { throw new Error('Jev should not be called for a unique name'); },
    act: async () => {
      acts += 1;
      return { ok: true };
    }
  });
  assert.equal(acts, 1);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'verify_failed');
  assert.equal(receipt.steps[0].via, 'name');
});

test('several candidates are sent to Jev and arrival stops the loop', async () => {
  const seen = [];
  let hop = 0;
  const receipt = await runChooseLoop({
    subgoal: '打开职位',
    until: '投递',
    maxSteps: 4,
    jevVia: 'OpenCode Zen',
    observe: async () => {
      hop += 1;
      if (hop === 1) {
        return {
          page: { url: 'https://example.com/jobs', documentId: 'd1' },
          controls: [
            { ref: 'f0.a1', name: '职位甲', role: 'link' },
            { ref: 'f0.a2', name: '职位乙', role: 'link' }
          ]
        };
      }
      return {
        page: { url: 'https://example.com/job', documentId: 'd2' },
        controls: [{ ref: 'f0.a3', name: '投递', role: 'button' }]
      };
    },
    select: async (payload) => {
      seen.push(payload.candidates.map((row) => row.ref));
      return { ref: 'f0.a1' };
    },
    act: async () => ({ ok: true })
  });
  assert.deepEqual(seen, [['f0.a1', 'f0.a2']]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.reason, 'arrived');
  assert.equal(receipt.steps[0].via, 'OpenCode Zen');
});

test('missing Jev returns NEED_JEV without pretending a click happened', async () => {
  let acts = 0;
  const receipt = await runChooseLoop({
    subgoal: '打开职位',
    maxSteps: 2,
    observe: async () => ({
      page: { url: 'https://example.com/jobs', documentId: 'd1' },
      controls: [
        { ref: 'f0.a1', name: '职位甲', role: 'link' },
        { ref: 'f0.a2', name: '职位乙', role: 'link' }
      ]
    }),
    select: async () => ({ code: 'NEED_JEV', error: 'No active Jev provider.' }),
    act: async () => {
      acts += 1;
      return { ok: true };
    }
  });
  assert.equal(acts, 0);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'NEED_JEV');
  assert.equal(receipt.steps.length, 0);
});

test('systemone URL rules: /v1 appends /systemone; already /systemone stays; other prefixes get /v1/systemone', () => {
  assert.equal(jevSystemOneUrl('https://opencode.ai/zen/v1'), 'https://opencode.ai/zen/v1/systemone');
  assert.equal(jevSystemOneUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/systemone');
  assert.equal(jevSystemOneUrl('https://api.typesafe.ai/v1/systemone'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jevSystemOneUrl('https://gateway.example.com'), 'https://gateway.example.com/v1/systemone');
  assert.equal(jevSystemOneUrl('https://gateway.example.com/v1/'), 'https://gateway.example.com/v1/systemone');
});

test('Jev posts to the active provider systemone URL and a jev-only record is not a chat model', async () => {
  let posted = '';
  let body = null;
  const missing = await fetchJevChoice({}, { subgoal: '下一页', candidates: [] }, async () => { throw new Error('no fetch'); });
  assert.equal(missing.code, 'NEED_JEV');
  await fetchJevChoice(
    { apiKey: 'sk-or', apiBase: 'https://openrouter.ai/api/v1', model: 'typesafe/jev-1.13' },
    { subgoal: '下一页', candidates: [{ ref: 'f0.a1', name: '下一页', role: 'button' }] },
    async (url, init) => {
      posted = url;
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: { pick: { choice: 'f0.a1', probability: 0.8 } } }) };
    }
  );
  assert.equal(posted, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(body.model, 'typesafe/jev-1.13');
  const jev = normalizeProvider({ id: 'j1', purpose: 'jev', name: 'Jev', baseURL: 'https://opencode.ai/zen/v1', apiKey: 'k', model: 'jev-1.13' });
  assert.equal(isJevProvider(jev), true);
  assert.equal(isChatProvider(jev), false);
});

test('custom gateway posts its own model id; empty model is NEED_MODEL and never rewritten to jev-1.13', async () => {
  let body = null;
  const ok = await fetchJevChoice(
    { apiKey: 'k', apiBase: 'https://gateway.example.com/v1', model: 'acme/jev-custom' },
    { subgoal: '下一页', candidates: [{ ref: 'f0.a1', name: '下一页', role: 'button' }] },
    async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: { pick: { choice: 'f0.a1', probability: 0.7 } } }) };
    }
  );
  assert.equal(ok.ok, true);
  assert.equal(body.model, 'acme/jev-custom');

  const emptyProbe = await probeJevSystemOne(
    { apiKey: 'k', apiBase: 'https://gateway.example.com/v1', model: '' },
    async () => {
      throw new Error('must not fetch when model is empty');
    }
  );
  assert.equal(emptyProbe.ok, false);
  assert.equal(emptyProbe.code, 'NEED_MODEL');

  const emptyChoose = await fetchJevChoice(
    { apiKey: 'k', apiBase: 'https://gateway.example.com/v1' },
    { subgoal: '下一页', candidates: [{ ref: 'f0.a1', name: '下一页', role: 'button' }] },
    async () => {
      throw new Error('must not fetch when model is empty');
    }
  );
  assert.equal(emptyChoose.ok, false);
  assert.equal(emptyChoose.code, 'NEED_MODEL');

  assert.equal(buildJevProbeBody({ model: '' }).model, '');
  assert.equal(buildJevProbeBody({}).model, '');
  assert.notEqual(buildJevProbeBody({}).model, 'jev-1.13');
});

test('local Laya model id is posted to systemone as-is and is never replaced with jev-1.13', async () => {
  let url = '';
  let body = null;
  const ok = await fetchJevChoice(
    { apiKey: 'local', apiBase: 'http://localhost:8000/v1', model: 'Laya' },
    { subgoal: '下一页', candidates: [{ ref: 'f0.a1', name: '下一页', role: 'button' }] },
    async (postedUrl, init) => {
      url = postedUrl;
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: { pick: { choice: 'f0.a1', probability: 0.8 } } }) };
    }
  );
  assert.equal(ok.ok, true);
  assert.equal(url, 'http://localhost:8000/v1/systemone');
  assert.equal(body.model, 'Laya');
  assert.equal(JSON.stringify(body).includes('jev-1.13'), false);

  let probeBody = null;
  const probe = await probeJevSystemOne(
    { apiKey: 'local', apiBase: 'http://127.0.0.1:9000/v1', model: 'laya' },
    async (postedUrl, init) => {
      assert.equal(postedUrl, 'http://127.0.0.1:9000/v1/systemone');
      probeBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: { pick: { choice: 'yes', probability: 1 } } }) };
    }
  );
  assert.equal(probe.ok, true);
  assert.equal(probeBody.model, 'laya');
  assert.notEqual(probeBody.model, 'jev-1.13');
});

test('probe succeeds only when answers.pick.choice is one of the fixed options; /models shape fails', async () => {
  assert.equal(interpretJevProbeResponse({ answers: { pick: { choice: 'yes' } } }).ok, true);
  assert.equal(interpretJevProbeResponse({ answers: { pick: { choice: 'no' } } }).ok, true);
  assert.equal(interpretJevProbeResponse({ data: [{ id: 'jev-1.13' }] }).ok, false);
  assert.equal(interpretJevProbeResponse({ answers: { pick: { choice: 'maybe' } } }).ok, false);
  assert.ok('yes' in JEV_PROBE_CHOICES && 'no' in JEV_PROBE_CHOICES);

  let posted = '';
  let body = null;
  const okProbe = await probeJevSystemOne(
    { apiKey: 'k', apiBase: 'https://opencode.ai/zen/v1', model: 'jev-1.13' },
    async (url, init) => {
      posted = url;
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answers: { pick: { choice: 'yes', probability: 0.9 } } }) };
    }
  );
  assert.equal(okProbe.ok, true);
  assert.equal(posted, 'https://opencode.ai/zen/v1/systemone');
  assert.equal(body.state, 'ping');
  assert.deepEqual(Object.keys(body.questions.pick.criteria).sort(), ['no', 'yes']);

  const modelsShape = await probeJevSystemOne(
    { apiKey: 'k', apiBase: 'https://example.com/v1', model: 'acme/jev' },
    async () => ({ ok: true, json: async () => ({ data: [{ id: 'jev-1.13' }] }) })
  );
  assert.equal(modelsShape.ok, false);
  assert.equal(modelsShape.code, 'NOT_JEV');
});

test('choose steps survive the trajectory audit slim', () => {
  const row = slimAuditEvent({
    type: 'action-outcome',
    op: 'choose',
    ok: true,
    subgoal: '下一页',
    name: '下一页',
    ref: 'f0.a1',
    via: 'OpenCode Zen',
    verified: true,
    url: 'https://example.com/p'
  });
  assert.equal(row.op, 'choose');
  assert.equal(row.subgoal, '下一页');
  assert.equal(row.ref, 'f0.a1');
  assert.equal(row.via, 'OpenCode Zen');
  assert.equal(row.verified, true);
});

test('arrival matches a url fragment or an exact control name', () => {
  assert.equal(arrivalMet('campus/position', { url: 'https://jobs.example/campus/position' }, []), true);
  assert.equal(arrivalMet('投递', { url: 'https://jobs.example/' }, [{ name: '投递' }]), true);
  assert.equal(arrivalMet('投递', { url: 'https://jobs.example/' }, [{ name: '登录' }]), false);
});
