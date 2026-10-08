#!/usr/bin/env node
// Manual end-to-end eval of the REAL Browser Kitten extension. Not part of `node --test` / CI.
//
//   node tests/eval/run-eval.cjs <playwright-core path> [--tasks id,id] [--repeat N]
//        [--flag key=value ...] [--label name] [--mock] [--tap] [--headed] [--list]
//
// Provider config comes from env only (never from argv, never written to the report):
//   BK_EVAL_API_BASE / BK_EVAL_API_KEY / BK_EVAL_MODEL          chat model (OpenAI-compatible)
//   BK_EVAL_JEV_BASE / BK_EVAL_JEV_KEY / BK_EVAL_JEV_MODEL      optional System1 (purpose: jev)
//   BK_EVAL_CLOUD_TOKEN + BK_EVAL_CLOUD_ORIGIN                  credits records (staging) instead
// --mock starts tests/eval/mock-model.cjs and points the chat provider at it.
// --tap routes the BYOK chat (and System1) base through a local counting proxy for exact HTTP call counts and sizes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createFixtureServer } = require('./fixtures.cjs');
const { TASKS } = require('./tasks.cjs');
const { summarize, renderMarkdown } = require('./report.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { pw: null, tasks: null, repeat: 1, flags: {}, label: 'run', mock: false, tap: false, headed: false, list: false };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith('--')) out.pw = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    const val = () => { if (!rest.length) throw new Error(`${a} needs a value`); return rest.shift(); };
    if (a === '--tasks') out.tasks = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--repeat') out.repeat = Math.max(1, parseInt(val(), 10) || 1);
    else if (a === '--label') out.label = val().replace(/[^\w.-]+/g, '_');
    else if (a === '--flag') {
      const kv = val(); const i = kv.indexOf('=');
      if (i < 1) throw new Error(`--flag expects key=value, got ${kv}`);
      let v = kv.slice(i + 1);
      try { v = JSON.parse(v); } catch { /* keep string */ }
      out.flags[kv.slice(0, i)] = v;
    } else if (a === '--mock') out.mock = true;
    else if (a === '--tap') out.tap = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--list') out.list = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redactUrl = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return String(u || ''); } };

/** Slim a broadcast workspace event to the fields the metrics need (no results, no free text). */
const SLIM_EVENT = `(m) => {
  const e = m.event || {};
  const o = { t: Date.now(), type: e.type, sessionId: e.sessionId };
  for (const k of ['name','ok','code','finishReason','toolCallId','latencyMs','modelId','op','status','clarifyId','reason','message','error']) if (e[k] != null) o[k] = typeof e[k] === 'string' ? e[k].slice(0, 200) : e[k];
  if (e.usage && typeof e.usage === 'object') o.usage = e.usage;
  if (e.args && typeof e.args === 'object' && e.args.op) o.argsOp = String(e.args.op);
  if (e.name === 'run' || e.type === 'tool-call') o.tool = e.name;
  if (e.type === 'clarify') o.questions = (e.questions || []).map((q) => String(q.question || '').slice(0, 120));
  if (e.type === 'clarify' && e.kind) o.kind = e.kind;
  return o;
}`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.list) {
    for (const t of TASKS) console.log(`${t.id.padEnd(16)} ${t.category.padEnd(22)} ${t.prompt}`);
    return;
  }
  if (!args.pw) throw new Error('First argument must be the path to playwright-core (or playwright).');
  const { chromium } = require(path.resolve(args.pw));
  const selected = args.tasks ? args.tasks.map((id) => TASKS.find((t) => t.id === id) || (() => { throw new Error(`unknown task ${id}`); })()) : TASKS;
  const loadRoot = process.env.BROWSERBOT_LOAD_ROOT ? path.resolve(process.env.BROWSERBOT_LOAD_ROOT) : repoRoot;

  // ---- model backend -------------------------------------------------------
  let mock = null;
  const cfg = {
    chat: { base: process.env.BK_EVAL_API_BASE, key: process.env.BK_EVAL_API_KEY, model: process.env.BK_EVAL_MODEL },
    jev: { base: process.env.BK_EVAL_JEV_BASE, key: process.env.BK_EVAL_JEV_KEY, model: process.env.BK_EVAL_JEV_MODEL },
    cloud: { token: process.env.BK_EVAL_CLOUD_TOKEN, origin: process.env.BK_EVAL_CLOUD_ORIGIN }
  };
  if (args.mock) {
    mock = require('./mock-model.cjs').createMockModel();
    const base = await mock.start();
    cfg.chat = { base: `${base}/v1`, key: 'mock-key-not-a-secret', model: 'mock-eval-1' };
    cfg.jev = { base: `${base}/v1`, key: 'mock-key-not-a-secret', model: 'mock-jev-1' };
    cfg.cloud = {};
  }
  const useCloud = !!(cfg.cloud.token && cfg.cloud.origin);
  const origChat = { ...cfg.chat };
  const taps = [];
  let counter = mock;
  if (args.tap && !mock) {
    if (useCloud) console.warn('--tap is ignored for credits (cloud) mode; HTTP counts will come from workspace events only.');
    else {
      const { createTap } = require('./tap-proxy.cjs');
      const wrap = async (c) => { const t = createTap(c.base); c.base = await t.start(); taps.push(t); return t; };
      const chatTap = await wrap(cfg.chat);
      const jevTap = cfg.jev.base && cfg.jev.key && cfg.jev.model ? (cfg.jev.base === process.env.BK_EVAL_API_BASE ? chatTap : await wrap(cfg.jev)) : null;
      counter = { mark: () => ({ c: chatTap.mark(), j: jevTap && jevTap !== chatTap ? jevTap.mark() : 0 }),
        since: (m) => { const a = chatTap.since(m.c); if (jevTap && jevTap !== chatTap) { const b = jevTap.since(m.j); a.system1 += b.system1; a.requestBytes += b.requestBytes; a.responseBytes += b.responseBytes; } return a; } };
    }
  }
  if (!useCloud && !(cfg.chat.base && cfg.chat.key && cfg.chat.model)) {
    throw new Error('Set BK_EVAL_API_BASE, BK_EVAL_API_KEY and BK_EVAL_MODEL (or BK_EVAL_CLOUD_TOKEN + BK_EVAL_CLOUD_ORIGIN), or pass --mock.');
  }

  // ---- fixtures + browser --------------------------------------------------
  const fixtures = createFixtureServer();
  const fxBase = await fixtures.start();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbot-eval-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: !args.headed && process.env.BROWSERBOT_HEADLESS !== 'false',
    ...(process.env.BROWSERBOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.BROWSERBOT_CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${loadRoot}`, `--load-extension=${loadRoot}`]
  });

  const results = [];
  let control;
  let extensionId = '';
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {
      throw new Error('Extension service worker did not start (extension loading blocked?).');
    });
    extensionId = new URL(worker.url()).hostname;
    if (process.env.BK_EVAL_DEBUG_SW) worker.on('console', (m) => console.log('[sw]', m.text().slice(0, 1500)));
    if (process.env.BK_EVAL_DEBUG_SW) context.on('page', (pg) => pg.on('console', (m) => console.log('[pg]', pg.url().slice(-30), m.text().slice(0, 1500))));
    if (process.env.BK_EVAL_DEBUG_SW) { for (const pg of context.pages()) { console.log('[existing page]', pg.url()); pg.on('console', (m) => console.log('[pg]', pg.url().slice(-30), m.text().slice(0, 1500))); } }
    control = await context.newPage();
    control.on('pageerror', () => {});
    await control.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
    await control.waitForFunction(() => typeof chrome !== 'undefined' && !!chrome.runtime?.id);
    await control.evaluate(`(() => { window.__ev = []; chrome.runtime.onMessage.addListener((m) => { if (m && m.action === 'session_workspace_event') window.__ev.push((${SLIM_EVENT})(m)); }); })()`);

    // ---- provider + flags through the product's own storage helpers -------
    await control.evaluate(async ({ cfg, useCloud, flags }) => {
      const llm = await import('./agent/llm.js');
      if (Object.keys(flags).length) await chrome.storage.local.set(flags);
      if (useCloud) {
        const acct = await import('./agent/cloudAccount.js');
        const { CLOUD_ORIGIN_OVERRIDE_KEY } = await import('./agent/cloudModels.js');
        const { loadWebAcquireSettings } = await import('./agent/webAcquireSettings.js');
        await chrome.storage.local.set({ [CLOUD_ORIGIN_OVERRIDE_KEY]: cfg.cloud.origin });
        const plan = acct.planCloudSignIn(await llm.loadProvidersState(), await loadWebAcquireSettings(), cfg.cloud.token, null, cfg.cloud.origin);
        await llm.saveProvidersState(plan.providers, plan.activeProviderId, plan.activeImageProviderId, plan.activeSttProviderId, plan.activeJevProviderId);
        await chrome.storage.local.set({ [acct.CLOUD_ACCOUNT_KEY]: { token: cfg.cloud.token, deviceId: 'eval', origin: cfg.cloud.origin, filled: {}, connectedAt: Date.now() } });
        return;
      }
      const createdAt = Date.now();
      const providers = [{ id: 'eval_chat', name: 'eval-chat', baseURL: cfg.chat.base, apiKey: cfg.chat.key, model: cfg.chat.model, purpose: 'chat', protocol: 'openai-compatible', createdAt }];
      let jevId;
      if (cfg.jev.base && cfg.jev.key && cfg.jev.model) {
        providers.push({ id: 'eval_jev', name: 'eval-jev', baseURL: cfg.jev.base, apiKey: cfg.jev.key, model: cfg.jev.model, purpose: 'jev', createdAt });
        jevId = 'eval_jev';
      }
      await llm.saveProvidersState(providers, 'eval_chat', undefined, undefined, jevId);
    }, { cfg, useCloud, flags: args.flags });
    const effective = await control.evaluate(async () => {
      const llm = await import('./agent/llm.js');
      const st = await llm.loadProvidersState();
      const s = await llm.loadLlmSettings();
      return { activeChat: st.active ? { name: st.active.name, base: st.active.baseURL, model: st.active.model } : null,
        activeJev: st.activeJev ? { base: st.activeJev.baseURL, model: st.activeJev.model } : null, settingsModel: s.model, settingsBase: s.apiBase };
    });
    if (!effective.activeChat) throw new Error('Provider configuration did not take effect.');

    // ---- run -------------------------------------------------------------
    for (let rep = 1; rep <= args.repeat; rep++) {
      for (const task of selected) {
        const r = await runTask({ context, control, fixtures, fxBase, task, rep, mock: args.mock ? mock : null, counter });
        results.push(r);
        console.log(`${r.success ? 'PASS' : 'FAIL'}  ${task.id.padEnd(16)} rep${rep}  ${(r.wallMs / 1000).toFixed(1)}s  model=${r.metrics.modelCalls} tools=${r.metrics.toolCalls} tok=${r.metrics.promptTokens}/${r.metrics.completionTokens}  ${r.success ? '' : r.reason}`);
      }
    }

    const meta = {
      label: args.label, startedAt: new Date().toISOString(), repeat: args.repeat, flags: args.flags,
      mock: args.mock, backend: useCloud ? { kind: 'cloud', origin: cfg.cloud.origin } : { kind: 'byok', base: redactUrl(origChat.base), tap: args.tap && !args.mock, model: cfg.chat.model, system1: !!effective.activeJev },
      loadRoot, extensionId, commit: safeGit(['rev-parse', '--short', 'HEAD']), dirty: !!safeGit(['status', '--porcelain']),
      extensionVersion: JSON.parse(fs.readFileSync(path.join(loadRoot, 'manifest.json'), 'utf8')).version,
      effectiveProvider: { ...effective, activeChat: effective.activeChat && { ...effective.activeChat, base: redactUrl(origChat.base) } }
    };
    const report = { meta, summary: summarize(results), runs: results };
    const outDir = path.join(repoRoot, 'output', 'eval');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(outDir, `${stamp}-${args.label}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    const md = renderMarkdown(report);
    fs.writeFileSync(`${base}.md`, md);
    console.log(`\n${md}\nWrote ${path.relative(repoRoot, base)}.json / .md`);
    process.exitCode = 0;
  } finally {
    await context.close().catch(() => {});
    await fixtures.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    for (const t of taps) await t.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function safeGit(a) { try { return execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } }

async function runTask({ context, control, fixtures, fxBase, task, rep, mock, counter }) {
  const sessionId = `eval-${task.id}-${rep}-${Date.now().toString(36)}`;
  fixtures.reset();
  await control.evaluate(() => { window.__ev.length = 0; });
  const countStart = counter ? counter.mark() : null;
  const page = await context.newPage();
  const startUrl = fxBase + task.start;
  await page.goto(startUrl, { waitUntil: 'load' });
  await page.bringToFront();
  const info = await control.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === url);
    return t ? { tabId: t.id, url: t.url, title: t.title, origin: new URL(t.url).origin } : null;
  }, startUrl);
  if (!info) throw new Error('Could not resolve the tab id of the start page.');
  if (mock) mock.setTask(task.id);

  const t0 = Date.now();
  await control.evaluate(async ({ sessionId, prompt, info }) => {
    const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
    window.__run = { done: false, startedAt: Date.now() };
    workspaceRpc('sendMessage', { sessionId, content: prompt, role: 'user', mentions: [], attachments: [], activeTab: info })
      .then((r) => { window.__run = { done: true, endedAt: Date.now(), startedAt: window.__run.startedAt, ok: true, finalText: String(r?.finalText || r?.assistant?.content || ''), usage: r?.assistant?.usage || r?.usage || null, timing: r?.assistant?.timing || null, mode: r?.mode || null }; })
      .catch((e) => { window.__run = { done: true, endedAt: Date.now(), startedAt: window.__run.startedAt, ok: false, code: e?.code || 'ERROR', message: String(e?.message || e).slice(0, 300) }; });
  }, { sessionId, prompt: task.prompt, info });

  // Settle detection: the sendMessage RPC resolves only when the execution settles (answer, abort, error).
  // We also answer clarify/plan prompts (no human is present) and enforce the wall-time budget.
  let outcome = 'settled';
  let clarifyAnswered = 0;
  const answered = new Set();
  let run = null;
  for (;;) {
    run = await control.evaluate(() => window.__run);
    if (run.done) break;
    if (Date.now() - t0 > task.maxMs) {
      outcome = 'timeout';
      await control.evaluate(async (sessionId) => {
        const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
        await workspaceRpc('abortCurrentExecution', { sessionId }).catch(() => {});
      }, sessionId);
      const grace = Date.now() + 30000;
      while (Date.now() < grace) { run = await control.evaluate(() => window.__run); if (run.done) break; await sleep(300); }
      if (!run.done) outcome = 'timeout-hung';
      break;
    }
    const pending = await control.evaluate((sid) => window.__ev.filter((e) => e.type === 'clarify' && e.sessionId === sid), sessionId);
    for (const c of pending) {
      if (answered.has(c.clarifyId)) continue;
      answered.add(c.clarifyId); clarifyAnswered++;
      await control.evaluate(async ({ sessionId, clarifyId, kind }) => {
        const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
        const answers = kind === 'plan' ? { approved: true, decision: 'approve', startDurableTask: false } : { answer: 'No one is available to answer. Proceed with your best judgment.' };
        await workspaceRpc('answerClarify', { sessionId, clarifyId, answers }).catch(() => {});
      }, { sessionId, clarifyId: c.clarifyId, kind: c.kind || 'question' });
    }
    await sleep(150);
  }
  const wallMs = run.endedAt && run.startedAt ? run.endedAt - run.startedAt : Date.now() - t0;

  // Judge from fixture state. Let in-flight page requests land first.
  await sleep(500);
  const events = await control.evaluate((sid) => window.__ev.filter((e) => !e.sessionId || e.sessionId === sid), sessionId);
  if (process.env.BK_EVAL_DEBUG_EVENTS) console.log(events.map((e) => e.type).join(','), JSON.stringify(events.find((e) => e.type === 'model-end')));
  const answer = run.finalText || '';
  let verdict;
  try { verdict = task.check({ state: JSON.parse(JSON.stringify(fixtures.state)), answer }); }
  catch (e) { verdict = { pass: false, reason: `checker threw: ${e.message}` }; }
  const metrics = computeMetrics({ events, run, http: counter ? counter.since(countStart) : null });
  const pagesOpened = context.pages().filter((p) => p !== control).length;

  await control.evaluate(async (sessionId) => {
    const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
    await workspaceRpc('deleteSession', { sessionId }).catch(() => {});
  }, sessionId);
  for (const p of context.pages()) if (p !== control) await p.close().catch(() => {});

  return {
    task: task.id, category: task.category, rep, success: !!verdict.pass && outcome === 'settled', reason: outcome !== 'settled' ? outcome : verdict.reason,
    checkerPass: !!verdict.pass, outcome, wallMs, rpcError: run.ok === false ? { code: run.code, message: run.message } : null,
    clarifications: clarifyAnswered, pagesAtEnd: pagesOpened, answer: answer.slice(0, 400), metrics
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function computeMetrics({ events, run, http }) {
  const m = { modelCalls: 0, toolCalls: 0, toolErrors: 0, tools: {}, actionOps: {}, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
    tokenSource: 'none', system1Calls: 0, errorCodes: {}, eventCounts: {}, http: null };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let usageSeen = 0;
  for (const e of events) {
    bump(m.eventCounts, e.type || 'unknown');
    if (e.type === 'model-end') {
      m.modelCalls++;
      const u = e.usage || {};
      const inTok = num(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens);
      const outTok = num(u.outputTokens ?? u.completionTokens ?? u.completion_tokens);
      if (inTok || outTok) usageSeen++;
      m.promptTokens += inTok; m.completionTokens += outTok;
      m.cachedTokens += num(u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? u.cache_read_input_tokens);
    } else if (e.type === 'tool-call') {
      m.toolCalls++; bump(m.tools, e.name || 'tool');
      if (e.name === 'action') bump(m.actionOps, e.argsOp || 'unknown');
    } else if (e.type === 'tool-result') {
      if (e.ok === false) { m.toolErrors++; if (e.code) bump(m.errorCodes, e.code); }
    } else if (e.type === 'error') bump(m.errorCodes, e.code || 'ERROR');
  }
  if (run && run.ok === false && run.code) bump(m.errorCodes, `rpc:${run.code}`);
  m.tokenSource = usageSeen ? 'api-per-step' : 'none';
  if (!usageSeen && run?.usage && (num(run.usage.promptTokens) || num(run.usage.completionTokens))) {
    m.promptTokens = num(run.usage.promptTokens); m.completionTokens = num(run.usage.completionTokens); m.tokenSource = `turn-total:${run.usage.source || '?'}`;
  }
  if (http) { m.http = http; m.system1Calls = http.system1; }
  return m;
}

main().catch((e) => { console.error(`eval failed: ${e.message}`); process.exitCode = 1; });
