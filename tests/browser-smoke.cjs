// node tests/browser-smoke.cjs [path-to-playwright-package]
// Uses a disposable, separate Chromium profile; no user browser state is accessed.
// PAW_LOAD_ROOT overrides the unpacked load root, so CI can smoke the packed
// release output instead of the repo root. Evidence always lands in the repo.
const { chromium } = require(process.argv[2] || 'playwright');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const loadRoot = process.env.PAW_LOAD_ROOT ? path.resolve(process.env.PAW_LOAD_ROOT) : root;
  const output = path.join(root, 'output/playwright');
  fs.mkdirSync(output, { recursive: true });
  const evidence = { storage: [], sandbox: [], errors: [], console: [] };
  const server = require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    if (req.url === '/slow') { res.write('partial'); return; }
    res.end('browser-network-ok');
  });
  const context = await chromium.launchPersistentContext(path.join(output, 'smoke-profile'), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${loadRoot}`, `--load-extension=${loadRoot}`]
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    page.on('pageerror', error => evidence.errors.push(error.message));
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) evidence.console.push(msg.text()); });
    await page.goto(`chrome-extension://${id}/src/sidepanel.html`);
    // Offscreen exposes chrome.runtime, not chrome.storage. Verify the real
    // settings bridge and tool loop there, rather than only in the side panel.
    await page.evaluate(async () => {
      const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
      await workspaceRpc('getWorkspaceState', { sessionId: 'search-smoke' });
    });
    const browserCdp = await context.browser().newBrowserCDPSession();
    const targets = (await browserCdp.send('Target.getTargets')).targetInfos;
    const offscreen = targets.find(target => target.url === `chrome-extension://${id}/src/offscreen/runtime.html`);
    if (!offscreen) throw new Error('offscreen runtime did not start');
    const attached = await browserCdp.send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: false });
    let evaluateId = 0;
    async function inOffscreen(expression) {
      const requestId = ++evaluateId;
      const response = new Promise(resolve => {
        const listener = message => {
          if (message.sessionId !== attached.sessionId) return;
          const data = JSON.parse(message.message);
          if (data.id !== requestId) return;
          browserCdp.off('Target.receivedMessageFromTarget', listener);
          resolve(data);
        };
        browserCdp.on('Target.receivedMessageFromTarget', listener);
      });
      await browserCdp.send('Target.sendMessageToTarget', { sessionId: attached.sessionId,
        message: JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
      const result = (await response).result;
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    evidence.searchSettings = [];
    for (const settings of [null, { searchProvider: 'disabled' }, { searchProvider: 'brave', braveKey: 'fixture-brave' },
      { searchProvider: 'tavily', tavilyKey: 'fixture-tavily' }, { firecrawlKey: 'fixture-firecrawl' }]) {
      await page.evaluate(async settings => {
        if (settings) await chrome.storage.local.set({ pagewand_web_acquire: settings });
        else await chrome.storage.local.remove('pagewand_web_acquire');
      }, settings);
      evidence.searchSettings.push(await inOffscreen('(async()=>({storage:typeof chrome.storage,settings:await (await import("../agent/webAcquireSettings.js")).loadWebAcquireSettings()}))()'));
    }
    await page.evaluate(() => chrome.storage.local.remove('pagewand_web_acquire'));
    evidence.searchLoop = await inOffscreen(`(${async function () {
      const { SessionWorkspaceService } = await import('../agent/vnext/service/sessionWorkspaceService.js');
      const service = new SessionWorkspaceService();
      service.ensureSession('search-smoke-loop');
      const requests = [];
      let step = 0; let consumed = false;
      const result = await service.sendMessage({ sessionId: 'search-smoke-loop', content: 'Find browser documentation',
        fetchImpl: async (url, init) => {
          const request = JSON.parse(init.body); requests.push({ url, headers: init.headers, request });
          if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
          const data = request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
            : request.method === 'tools/list' ? { tools: [{ name: 'web_search' }] }
            : { structuredContent: { results: [{ url: 'https://example.com/research', excerpts: ['offscreen-search-evidence'] }] } };
          return Response.json({ jsonrpc: '2.0', id: request.id, result: data });
        },
        callModel: async ({ messages }) => {
          if (step++ === 0) return { toolCalls: [{ id: 'search-fixture', name: 'acquire', args: { action: 'search', query: 'browser documentation' } }] };
          consumed = JSON.stringify(messages).includes('offscreen-search-evidence');
          return { text: 'Search evidence consumed.' };
        }
      });
      return { consumed, requests, result, searchId: service.runtime.store.get('sessions', 'search-smoke-loop').parallelSearchSessionId };
    }})()`);
    await page.evaluate(() => chrome.storage.local.set({ pagewand_web_acquire: { searchProvider: 'disabled' } }));
    evidence.searchDisabled = await inOffscreen(`(${async function () {
      const { SessionWorkspaceService } = await import('../agent/vnext/service/sessionWorkspaceService.js');
      const service = new SessionWorkspaceService(); service.ensureSession('disabled-search-smoke');
      let step = 0; let network = 0; let disabled = false;
      await service.sendMessage({ sessionId: 'disabled-search-smoke', content: 'Try searching',
        fetchImpl: async () => { network++; throw new Error('Search off must not use the network'); },
        callModel: async ({ messages }) => {
          if (step++ === 0) return { toolCalls: [{ id: 'disabled-fixture', name: 'acquire', args: { action: 'search', query: 'must remain private' } }] };
          disabled = JSON.stringify(messages).includes('SEARCH_DISABLED'); return { text: 'Search is off.' };
        }
      });
      return { network, disabled };
    }})()`);
    await page.evaluate(() => chrome.storage.local.remove('pagewand_web_acquire'));
    await browserCdp.send('Target.detachFromTarget', { sessionId: attached.sessionId });
    await browserCdp.detach();
    evidence.storage = await page.evaluate(async () => {
      const { DurableSessionWorkspaceStore } = await import('./agent/vnext/sessionWorkspace/durableStore.js');
      const results = [];
      for (const fallback of [false, true]) {
        const dbName = `smoke-${crypto.randomUUID()}`;
        const store = new DurableSessionWorkspaceStore({ dbName });
        await store.open();
        if (fallback) store._opfs = null;
        store.put('meta', 'proof', { value: 1 });
        store.putBlob('proof', new Uint8Array([4, 5, 6]));
        await store.flush(); store._db.close();
        const restored = new DurableSessionWorkspaceStore({ dbName });
        await restored.open();
        const blob = await restored.getBlobAsync('proof');
        results.push({ fallback, meta: restored.get('meta', 'proof'), bytes: [...blob.bytes] });
        restored._db.close();
        await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = resolve; request.onerror = reject; });
      }
      return results;
    });
    for (const code of ['console.log("guest-ok")', 'try { await sys.eval({code:"return 1"}); } catch(e) { console.log(e.code); }']) {
      evidence.sandbox.push(await page.evaluate(async (code) => {
        const { createSandboxCodeClient } = await import('./agent/vnext/adapters/sandboxClient.js');
        const iframe = document.createElement('iframe');
        iframe.src = chrome.runtime.getURL('src/sandbox/runtime.html');
        document.body.append(iframe);
        const client = createSandboxCodeClient(iframe);
        try {
          return await client.run({ code, timeoutMs: 5000,
            sys: { call: async () => { throw Object.assign(new Error('permission off'), { code: 'SYS_DENIED' }); } }
          });
        } catch (error) { return { error: error.message }; }
        finally { client.dispose(); iframe.remove(); }
      }, code));
    }
    evidence.transfer = await page.evaluate(async () => {
      const { createSandboxCodeClient } = await import('./agent/vnext/adapters/sandboxClient.js');
      const { SessionWorkspaceStore } = await import('./agent/vnext/sessionWorkspace/store.js');
      const { createSessionGuestFs } = await import('./agent/vnext/sessionWorkspace/fs.js');
      const { createSessionTools } = await import('./agent/vnext/sessionWorkspace/tools.js');
      const store = new SessionWorkspaceStore();
      store.put('sessions', 'smoke', { sessionId: 'smoke', messages: [] });
      const fs = createSessionGuestFs(store, { sessionId: 'smoke', executionId: 'e' });
      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('src/sandbox/runtime.html');
      document.body.append(iframe);
      const client = createSandboxCodeClient(iframe);
      globalThis.__PAWWORK_CODE_SANDBOX_RUN__ = opts => client.run(opts);
      try {
        const tools = createSessionTools({ store, fs, sessionId: 'smoke', execution: { executionId: 'e' },
          hostSys: async () => ({ ok: true, result: { ok: true, base64: 'aGVsbG8=', contentType: 'text/plain' } }) });
        const result = await tools.run.execute({ code: 'const r = await sys.fetch({url:"https://example.com",saveTo:"/artifacts/proof.txt"}); console.log(r.path, r.bytes);', timeoutMs: 5000 });
        return { result, content: fs.readFile('/artifacts/proof.txt'), artifactCount: store.keys('artifacts').length };
      } finally { delete globalThis.__PAWWORK_CODE_SANDBOX_RUN__; client.dispose(); iframe.remove(); }
    });
    evidence.senderGate = await page.evaluate(() => chrome.runtime.sendMessage({target:'pawwork-background',action:'workspace_sys',op:'tabs.list'}));
    evidence.versioning = await page.evaluate(async () => {
      const { workspaceRpc } = await import('./agent/vnext/host/workspaceClient.js');
      const sessionId = `smoke-${crypto.randomUUID()}`;
      try {
        const created = await workspaceRpc('createArtifact', { sessionId, name: 'version.txt', content: 'original', mimeType: 'text/plain' });
        const artifactId = created.artifact.artifactId;
        const saved = await workspaceRpc('updateArtifact', { sessionId, artifactId, content: 'first', expectedRevision: created.artifact.revision });
        let conflict;
        try { await workspaceRpc('updateArtifact', { sessionId, artifactId, content: 'stale', expectedRevision: created.artifact.revision }); }
        catch (error) { conflict = error.code; }
        const read = await workspaceRpc('readArtifact', { sessionId, artifactId });
        return { conflict, content: read.content, revision: saved.artifact.revision };
      } finally { await workspaceRpc('deleteSession', { sessionId }); }
    });
    evidence.network = await page.evaluate(async (port) => {
      const { handleWorkspaceSys } = await import('./agent/vnext/host/browserSysHost.js');
      const capabilities = await handleWorkspaceSys({ op: 'capabilities' });
      const result = await handleWorkspaceSys({ op: 'fetch', params: { url: `http://127.0.0.1:${port}/data` } });
      const pending = handleWorkspaceSys({ callId: 'slow', op: 'fetch', deadline: Date.now() + 100, params: { url: `http://127.0.0.1:${port}/slow` } });
      return { capabilities: capabilities.result, data: atob(result.result.base64), timeout: await pending };
    }, server.address().port);
    evidence.sleep = await page.evaluate(async () => {
      const { createSandboxCodeClient } = await import('./agent/vnext/adapters/sandboxClient.js');
      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('src/sandbox/runtime.html');
      document.body.append(iframe);
      const client = createSandboxCodeClient(iframe);
      try {
        return await client.run({ code: 'const t = Date.now(); await sleep(120); return Date.now() - t;', timeoutMs: 5000 });
      } finally { client.dispose(); iframe.remove(); }
    });
    evidence.waitForRouting = await page.evaluate(async () => {
      const { handleWorkspaceSys } = await import('./agent/vnext/host/browserSysHost.js');
      return handleWorkspaceSys({ op: 'waitFor', params: { text: 'x' } });
    });
    const assert = require('node:assert/strict');
    assert.ok(evidence.searchSettings.every(entry => entry.storage === 'undefined'));
    assert.deepEqual(evidence.searchSettings.map(entry => entry.settings.searchProvider), ['parallel', 'disabled', 'brave', 'tavily', 'tavily']);
    assert.equal(evidence.searchSettings[2].settings.braveKey, 'fixture-brave');
    assert.equal(evidence.searchSettings[3].settings.tavilyKey, 'fixture-tavily');
    assert.equal(evidence.searchSettings[4].settings.firecrawlKey, 'fixture-firecrawl');
    assert.equal(evidence.searchLoop.consumed, true);
    assert.equal(evidence.searchLoop.result.finalText, 'Search evidence consumed.');
    assert.equal(evidence.searchLoop.requests.at(-1).request.params.arguments.session_id, evidence.searchLoop.searchId);
    assert.deepEqual(evidence.searchDisabled, { network: 0, disabled: true });
    for (const entry of evidence.storage) assert.deepEqual(entry.bytes, [4,5,6]);
    assert.match(evidence.sandbox[0].stdout || '', /guest-ok/);
    assert.match(evidence.sandbox[1].stdout || '', /SYS_DENIED/);
    assert.equal(evidence.transfer.result.ok, true);
    assert.equal(evidence.transfer.content, 'hello');
    assert.equal(evidence.transfer.artifactCount, 1);
    assert.equal(evidence.senderGate.code, 'SYS_DENIED');
    assert.equal(evidence.network.data, 'browser-network-ok');
    assert.equal(evidence.network.timeout.code, 'SYS_TIMEOUT');
    assert.equal(evidence.versioning.conflict, 'ARTIFACT_CONFLICT');
    assert.equal(evidence.versioning.content, 'first');
    assert.equal(evidence.sleep.exitStatus, 0);
    assert.ok(evidence.sleep.value >= 100, `guest sleep waited ${evidence.sleep.value}ms`);
    assert.equal(evidence.waitForRouting.code, 'NEED_PAGE');
    console.log('Browser storage and sandbox smoke checks passed.');
  } finally {
    fs.writeFileSync(path.join(output, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
