import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { SessionWorkspaceService } from '../src/agent/vnext/service/sessionWorkspaceService.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { defaultWebAcquireSettings, normalizeWebAcquireSettings, loadWebAcquireSettings, saveWebAcquireSettings, searchApiConfigured } from '../src/agent/webAcquireSettings.js';
import { PARALLEL_SEARCH_URL, PARALLEL_USER_AGENT } from '../src/agent/vnext/primitives/parallelSearch.js';

function caller({ store = new SessionWorkspaceStore(), sessionId = 'conversation-a', settings, fetchImpl, signal } = {}) {
  if (!store.has('sessions', sessionId)) store.put('sessions', sessionId, { sessionId, messages: [] });
  const execution = { executionId: `execution-${sessionId}` };
  const fs = createSessionGuestFs(store, { sessionId, executionId: execution.executionId });
  const tools = createSessionTools({ store, fs, sessionId, execution, webAcquire: settings, fetchImpl, signal });
  return { store, fs, tools, search: query => tools.acquire.execute({ action: 'search', query, limit: 2 }) };
}
function reply(id, result) { return Response.json({ jsonrpc: '2.0', id, result }); }
function transport({ calls = [], toolResult, mode = 'json', toolHandler } = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    assert.equal(url, PARALLEL_SEARCH_URL);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['User-Agent'], PARALLEL_USER_AGENT);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.headers['MCP-Protocol-Version'], '2025-03-26');
    if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'web_search' }] });
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'web_search');
    if (toolHandler) return toolHandler(request, init);
    const result = toolResult || { structuredContent: { results: [
      { url: 'https://example.com/a', title: 'Research result', excerpts: ['Useful evidence', 'More detail'] },
      { url: 'https://example.com/a', title: 'Duplicate', excerpts: [] },
      { url: 'javascript:alert(1)', excerpts: ['unsafe'] },
      { url: 'http://127.0.0.1/private', excerpts: ['private'] },
      { url: 'https://example.org/b', excerpts: ['Second source'] },
      { url: 'https://example.net/c', excerpts: ['Beyond limit'] }
    ] } };
    if (mode === 'sse') {
      const text = ': heartbeat\r\n\r\ndata: '+JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })+'\r\n\r\ndata: '+JSON.stringify({ jsonrpc: '2.0', id: request.id, result })+'\r\n\r\n';
      return new Response(new ReadableStream({ start(c) { for (const ch of text) c.enqueue(new TextEncoder().encode(ch)); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return reply(request.id, result);
  };
}

test('fresh no-key settings dispatch MCP search and persist model-readable results', async () => {
  const calls = [];
  const { search, fs } = caller({ fetchImpl: transport({ calls }) });
  const result = await search('browser extension search');
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].snippet, 'Useful evidence More detail');
  assert.equal(result.results[0].url, 'https://example.com/a');
  assert.match(result.path, /^\/scratch\/sources\/search_.*\.json$/);
  const saved = JSON.parse(fs.readFile(result.path));
  assert.equal(saved.provider, 'parallel');
  assert.deepEqual(saved.results, result.results);
  assert.deepEqual(calls.map(c => c.request.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(searchApiConfigured({}), true);
});

test('conversation identifiers survive follow-up, interleaving, quota, retry and restart; new chat differs', async () => {
  const calls = [];
  let quota = true;
  const fetchImpl = transport({ calls, toolHandler(request) {
    if (request.params.arguments.objective === 'quota' && quota) { quota = false; return new Response('', { status: 429 }); }
    return reply(request.id, { structuredContent: { results: [{ url: 'https://example.com', excerpts: ['ok'] }] } });
  } });
  const a = caller({ fetchImpl });
  const b = caller({ store: a.store, sessionId: 'conversation-b', fetchImpl });
  await Promise.all([a.search('first a'), b.search('first b')]);
  // Existing HTTP fetch stays direct and does not create a new MCP conversation.
  const af = caller({ store: a.store, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://example.com/source'); assert.equal(init.credentials, 'omit');
    return new Response('source contents', { headers: { 'content-type': 'text/plain' } });
  } });
  assert.equal((await af.tools.acquire.execute({ action: 'fetch', url: 'https://example.com/source' })).ok, true);
  assert.equal((await a.search('quota')).ok, false);
  assert.equal((await a.search('retry a')).ok, true);
  await b.search('follow-up b');
  const restored = new SessionWorkspaceStore(); restored.importSnapshot(a.store.exportSnapshot());
  await caller({ store: restored, fetchImpl }).search('restored a');
  const fresh = caller({ store: restored, sessionId: 'new-chat', fetchImpl }); await fresh.search('new chat');
  const args = calls.filter(c => c.request.method === 'tools/call').map(c => c.request.params.arguments);
  const idA = args.find(a => a.objective === 'first a').session_id;
  const idB = args.find(a => a.objective === 'first b').session_id;
  assert.match(idA, /^[a-f\d-]{36}$/); assert.notEqual(idA, idB);
  for (const objective of ['quota', 'retry a', 'restored a']) assert.equal(args.find(a => a.objective === objective).session_id, idA);
  assert.equal(args.find(a => a.objective === 'follow-up b').session_id, idB);
  assert.notEqual(args.find(a => a.objective === 'new chat').session_id, idA);
  assert.notEqual(args.find(a => a.objective === 'new chat').session_id, idB);
});

test('saved providers, credential-only legacy settings and explicit overrides never become Parallel', async () => {
  const cases = [
    [{ searchProvider: 'tavily', tavilyKey: 't', tavilyBaseURL: 'https://tavily.example' }, 'https://tavily.example/search'],
    [{ searchProvider: 'brave', braveKey: 'b' }, 'https://api.search.brave.com/res/v1/web/search'],
    [{ tavilyKey: 't' }, 'https://api.tavily.com/search'],
    [{ braveKey: 'b' }, 'https://api.search.brave.com/res/v1/web/search'],
    [{ firecrawlKey: 'f' }, 'https://api.firecrawl.dev/v2/search'],
    [{ searchProvider: 'tavily', firecrawlKey: 'f' }, 'https://api.firecrawl.dev/v2/search']
  ];
  for (const [settings, endpoint] of cases) {
    let count = 0;
    const { search } = caller({ settings, fetchImpl: async (url) => {
      count++; assert.ok(url.startsWith(endpoint));
      return Response.json({ results: [{ url: 'https://example.com', content: 'saved provider' }], web: { results: [{ url: 'https://example.com', description: 'brave' }] }, data: [{ url: 'https://example.com', content: 'firecrawl' }] });
    } });
    assert.equal((await search('saved')).ok, true); assert.equal(count, 1);
  }
  const explicit = caller({ settings: { searchProvider: 'parallel', tavilyKey: 'saved-key' }, fetchImpl: transport() });
  assert.equal((await explicit.search('explicit override')).ok, true);
  for (const settings of [{ searchProvider: 'disabled', tavilyKey: 't' }, { searchProvider: 'unknown' }, { searchProvider: 'tavily' }]) {
    const c = caller({ settings, fetchImpl: () => { throw new Error('network should not run'); } });
    const result = await c.search('off'); assert.equal(result.ok, false);
    assert.ok(['SEARCH_DISABLED', 'SEARCH_NOT_CONFIGURED'].includes(result.code));
    assert.equal(c.store.get('sessions', 'conversation-a').parallelSearchSessionId, undefined);
  }
  for (const settings of [{ searchProvider: 'tavily', tavilyKey: 't' }, { searchProvider: 'brave', braveKey: 'b' }]) {
    let calls = 0;
    const c = caller({ settings, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
    assert.equal((await c.search('failure')).ok, false); assert.equal(calls, 1);
  }
  assert.equal(searchApiConfigured({ searchProvider: 'disabled', tavilyKey: 't' }), false);
  assert.equal(normalizeWebAcquireSettings(defaultWebAcquireSettings()).searchProvider, 'parallel');
});

test('settings load/save preserves keys and a disabled choice; fresh storage is keyless', async () => {
  const previous = globalThis.chrome;
  let data = {};
  globalThis.chrome = { storage: { local: { get: async () => data, set: async value => { data = value; } } } };
  try {
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'parallel');
    await saveWebAcquireSettings({ searchProvider: 'tavily', tavilyKey: 'existing', tavilyBaseURL: 'https://custom.example' });
    await saveWebAcquireSettings({ searchProvider: 'disabled' });
    assert.equal((await loadWebAcquireSettings()).tavilyKey, 'existing');
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'disabled');
    await saveWebAcquireSettings({ firecrawlKey: 'fetch' });
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'disabled');
  } finally { globalThis.chrome = previous; }
});

test('JSON text and chunked SSE MCP tool replies reach result consumption', async () => {
  for (const options of [{ mode: 'sse' }, { toolResult: { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://example.com', excerpts: ['JSON evidence'] }] }) }] } }]) {
    const c = caller({ fetchImpl: transport(options) });
    assert.equal((await c.search('transport')).ok, true);
  }
});

test('MCP errors, invalid replies and oversized results are returned without provider fallback or files', async () => {
  const modes = ['http', 'tool', 'rpc', 'parse', 'shape', 'oversize'];
  for (const mode of modes) {
    let count = 0;
    const fetchImpl = transport({ toolHandler(request) {
      count++;
      if (mode === 'http') return new Response('', { status: 503 });
      if (mode === 'tool') return reply(request.id, { isError: true, content: [{ type: 'text', text: 'backend error' }] });
      if (mode === 'rpc') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'internal error' } });
      if (mode === 'parse') return new Response('not JSON');
      if (mode === 'shape') return reply(request.id, { structuredContent: { other: [] } });
      return new Response('x'.repeat(2 * 1024 * 1024 + 1));
    } });
    const c = caller({ settings: { searchProvider: 'parallel', tavilyKey: 'do-not-fallback' }, fetchImpl });
    const result = await c.search(mode);
    assert.equal(result.ok, false); assert.equal(typeof result.error, 'string'); assert.equal(count, 1);
    assert.equal(result.path, undefined);
  }
});

test('abort before dispatch, cancellation while reading, deadline, missing session and private URLs respect boundaries', async () => {
  const controller = new AbortController(); controller.abort();
  const c = caller({ signal: controller.signal, fetchImpl: () => { throw new Error('should not run'); } });
  assert.equal((await c.search('aborted')).ok, false);
  for (const timeout of [false, true]) {
    const controller = new AbortController(); let started;
    const ready = new Promise(r => { started = r; });
    const originalSetTimeout = globalThis.setTimeout;
    if (timeout) globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 30000 ? 10 : ms, ...args);
    try {
      const fetchImpl = transport({ toolHandler(_request, init) {
        return new Response(new ReadableStream({ start(stream) {
          init.signal.addEventListener('abort', () => stream.error(init.signal.reason)); started();
        } }));
      } });
      const c = caller({ signal: controller.signal, fetchImpl });
      const pending = c.search('slow'); await ready;
      if (!timeout) controller.abort(new Error('user cancelled'));
      const result = await pending;
      assert.equal(result.ok, false); assert.match(result.error, timeout ? /timed out/ : /user cancelled/);
    } finally { globalThis.setTimeout = originalSetTimeout; }
  }
  let network = 0;
  const privateCaller = caller({ fetchImpl: () => { network++; } });
  assert.equal((await privateCaller.tools.acquire.execute({ action: 'fetch', url: 'http://127.0.0.1/secret' })).code, 'NET_DENIED');
  privateCaller.store.delete('sessions', 'conversation-a');
  assert.equal((await privateCaller.search('no session')).code, 'AUTH_DENIED');
  assert.equal(network, 0);
});

test('scripted model uses the production ToolLoopAgent dispatcher and consumes search evidence', async () => {
  const store = new SessionWorkspaceStore();
  const service = new SessionWorkspaceService({ store }); service.ensureSession('model-conversation');
  let step = 0; let consumed = false;
  const result = await service.sendMessage({ sessionId: 'model-conversation', content: 'Research browser extensions', webAcquire: {}, fetchImpl: transport(), callModel: async ({ messages }) => {
    if (step++ === 0) return { toolCalls: [{ id: 'search-1', name: 'acquire', args: { action: 'search', query: 'browser extension research' } }] };
    consumed = JSON.stringify(messages).includes('Useful evidence');
    return { text: 'Research result: https://example.com/a' };
  } });
  assert.equal(consumed, true); assert.equal(step, 2);
  assert.ok(JSON.stringify(result).includes('https://example.com/a'));
});

test('Chrome header setup is scoped to extension runtime pages and reports permission failure', async () => {
  const previous = globalThis.chrome;
  const { ensureParallelSearchHeaders } = await import('../src/agent/vnext/host/parallelSearchHeaders.js');
  let rules; let calls = 0;
  globalThis.chrome = {
    runtime: { id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}` },
    declarativeNetRequest: { updateSessionRules: async value => { calls++; rules = value; } }
  };
  try {
    for (const sender of [{ id: 'other', url: 'chrome-extension://extension-id/src/offscreen/runtime.html' }, { id: 'extension-id', url: 'https://example.com' }]) {
      assert.equal((await ensureParallelSearchHeaders(sender)).code, 'AUTH_DENIED');
    }
    assert.equal(calls, 0);
    assert.equal((await ensureParallelSearchHeaders({ id: 'extension-id', url: 'chrome-extension://extension-id/src/offscreen/runtime.html' })).ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(rules.addRules[0].condition, { regexFilter: '^https://search\\.parallel\\.ai/mcp$', initiatorDomains: ['extension-id'], resourceTypes: ['xmlhttprequest'] });
    assert.equal(rules.addRules[0].action.requestHeaders[0].value, PARALLEL_USER_AGENT);
    chrome.runtime.sendMessage = async () => ({ ok: false, error: 'permission denied' });
    const c = caller({ fetchImpl: () => { throw new Error('network should not run'); } });
    assert.match((await c.search('no permission')).error, /permission denied/);
  } finally { globalThis.chrome = previous; }
});

test('MCP connection headers and close are separate from conversation identity', async () => {
  let connection; let closed = false;
  const base = transport();
  const c = caller({ fetchImpl: async (url, init) => {
    if (init.method === 'DELETE') {
      assert.equal(url, PARALLEL_SEARCH_URL);
      assert.equal(init.headers['Mcp-Session-Id'], 'connection-only');
      assert.equal(init.headers['User-Agent'], PARALLEL_USER_AGENT);
      closed = true; return new Response(null, { status: 204 });
    }
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') {
      const response = await base(url, init);
      response.headers.set('mcp-session-id', 'connection-only'); return response;
    }
    assert.equal(init.headers['Mcp-Session-Id'], 'connection-only');
    if (body.method === 'tools/call') connection = body.params.arguments.session_id;
    return base(url, init);
  } });
  assert.equal((await c.search('connection lifecycle')).ok, true);
  assert.equal(closed, true); assert.notEqual(connection, 'connection-only');
});

test('cancellation also stops waiting for Chrome header setup', async () => {
  const previous = globalThis.chrome;
  const controller = new AbortController();
  globalThis.chrome = { runtime: { id: 'extension-id', sendMessage: () => new Promise(() => {}) } };
  try {
    const c = caller({ signal: controller.signal, fetchImpl: () => { throw new Error('should not run'); } });
    const pending = c.search('waiting for host');
    controller.abort(new Error('cancel host setup'));
    assert.match((await pending).error, /cancel host setup/);
  } finally { globalThis.chrome = previous; }
});

test('offscreen settings use the existing SW storage bridge; read failure disables search and refuses destructive saves', async () => {
  const previous = globalThis.chrome;
  let bag = {};
  const requests = [];
  globalThis.chrome = { runtime: { sendMessage: async request => {
    requests.push(request);
    if (request.action === 'storage_local_get') return { ok: true, result: bag };
    assert.equal(request.action, 'storage_local_set'); bag = request.values; return { ok: true };
  } } };
  try {
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'parallel');
    await saveWebAcquireSettings({ searchProvider: 'brave', braveKey: 'saved-brave' });
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'brave');
    assert.equal((await loadWebAcquireSettings()).braveKey, 'saved-brave');
    await saveWebAcquireSettings({ searchProvider: 'disabled' });
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'disabled');
    assert.equal((await loadWebAcquireSettings()).braveKey, 'saved-brave');
    assert.ok(requests.every(r => r.target === 'pawwork-background'));
    assert.deepEqual(requests[0].keys, ['pagewand_web_acquire']);
    for (const fail of [async () => { throw new Error('bridge unavailable'); }, async () => ({ ok: false }), async () => ({ ok: true })]) {
      chrome.runtime.sendMessage = fail;
      const settings = await loadWebAcquireSettings(); assert.equal(settings.searchProvider, 'disabled');
      const c = caller({ settings, fetchImpl: () => { throw new Error('must stay offline'); } });
      assert.equal((await c.search('offscreen failure')).code, 'SEARCH_DISABLED');
      await assert.rejects(saveWebAcquireSettings({ firecrawlKey: 'new' }));
    }
    globalThis.chrome = { storage: { local: { get: async () => { throw new Error('disk failure'); } } } };
    assert.equal((await loadWebAcquireSettings()).searchProvider, 'disabled');
  } finally { globalThis.chrome = previous; }
});
