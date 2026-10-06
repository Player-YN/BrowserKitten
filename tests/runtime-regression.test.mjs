import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { aoaToCsv, parseDelimited } from '../src/preview/sheetCodec.js';
import { DurableSessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/durableStore.js';
import { createGuestSys } from '../src/agent/vnext/sessionWorkspace/browserSys.js';
import { runCode } from '../src/agent/vnext/adapters/codeRuntime.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createArtifact, updateArtifactContent } from '../src/agent/vnext/sessionWorkspace/artifacts.js';
import { clarifyBelongsToSession } from '../src/sidepanel/sessionIsolation.js';
import { installTestPolicy, seedAutoTicket } from './helpers/policyTestKit.mjs';

// Stages writes until commit, so a transaction error cannot publish partial data.
function memoryIdb() {
  const rows = new Map();
  const db = {
    fail: false, commits: 0,
    transaction() {
      const staged = new Map(rows);
      const tx = { error: null, abort() { tx.error = new Error('aborted'); }, objectStore() {
        return { put(value, key) { staged.set(key, structuredClone(value)); }, delete(key) { staged.delete(key); } };
      } };
      queueMicrotask(() => {
        if (db.fail || tx.error) {
          tx.error ||= new Error('injected disk failure'); tx.onerror?.();
        } else {
          rows.clear(); for (const [k,v] of staged) rows.set(k,v); db.commits++; tx.oncomplete?.();
        }
      });
      return tx;
    }
  };
  return { db, rows };
}

test('IDB fallback keeps bytes, failures are atomic, and later saves recover', async () => {
  const { db, rows } = memoryIdb();
  const store = new DurableSessionWorkspaceStore();
  store._opened = true; store._db = db;
  store.put('meta', 'version', 1);
  store.putBlob('proof', new Uint8Array([1, 2, 3]));
  await store.flush();
  assert.deepEqual(rows.get('workspace-inline-blobs')[0][1].bytes, [1, 2, 3]);
  const committed = structuredClone([...rows]);
  db.fail = true;
  store.put('meta', 'version', 2);
  store.putBlob('proof', new Uint8Array([4, 5]));
  await assert.rejects(store.flush(), /injected disk failure/);
  assert.deepEqual([...rows], committed);
  db.fail = false;
  await store.flush();
  assert.equal(rows.get('col:meta')[0][1], 2);
  assert.deepEqual(rows.get('workspace-inline-blobs')[0][1].bytes, [4, 5]);
});

test('OPFS replacement does not destroy committed bytes when metadata fails', async () => {
  const { db, rows } = memoryIdb();
  const files = new Map();
  const dir = {
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name) { return { async createWritable() { let bytes; return {
      async write(value) { bytes = new Uint8Array(value); },
      async close() { files.set(name, bytes); }
    }; } }; },
    async removeEntry(name) { files.delete(name); }
  };
  const store = new DurableSessionWorkspaceStore();
  store._opened = true; store._db = db; store._opfs = dir;
  store.putBlob('proof', new Uint8Array([1])); await store.flush();
  const oldPath = rows.get('workspace-meta').blobManifest.proof.path.split('/').pop();
  db.fail = true;
  store.putBlob('proof', new Uint8Array([2]));
  await assert.rejects(store.flush());
  assert.deepEqual([...files.get(oldPath)], [1]);
  assert.equal(files.size, 1);
  db.fail = false; await store.flush();
  assert.equal(files.has(oldPath), false);
  assert.equal(files.size, 1);
  assert.deepEqual([...files.values()][0], new Uint8Array([2]));
});

test('docs save writes marked HTML and returns persistence failure', async () => {
  const source = await readFile(new URL('../src/preview/docs.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function saveNow(');
  const end = source.indexOf('async function executeDocsRpc(');
  const code = source.slice(start, end);
  const writes = [];
  const context = vm.createContext({
    sessionId: 's',
    artifactId: 'a',
    fileName: 'doc',
    artifactRevision: 1,
    durableSnapshot: { title: 'Hi', blocks: [{ id: 'b1', type: 'p', text: 'Hello' }] },
    serializeDocHtml: (snap) => `<html>${snap.title}</html>`,
    workspaceRpc: async (_method, params) => {
      writes.push(params);
      return { artifact: { revision: 2 } };
    },
    chrome: { runtime: { sendMessage() {} } }
  });
  vm.runInContext(code, context);
  assert.equal((await context.saveNow()).ok, true);
  assert.equal(writes[0].mimeType, 'text/html');
  assert.match(writes[0].content, /Hi/);
  assert.equal(context.artifactRevision, 2);
  context.workspaceRpc = async () => { throw new Error('disk failure'); };
  const failed = await context.saveNow();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /disk failure/);
});

globalThis.chrome = { debugger: {}, webNavigation: { getFrame: async ({tabId, frameId}) => ({
  frameId, documentId: `doc-${tabId}-${frameId}`, documentLifecycle: 'active', url: 'https://example.com'
}) } };
const { handleWorkspaceSys, readResponseBytes, wrapWaitForSource } = await import('../src/agent/vnext/host/browserSysHost.js');
installTestPolicy({ mode: 'full' });
async function sys(req) {
  const next = { sessionId: req.sessionId || 's', executionId: req.executionId || 'e', ...req };
  Object.assign(next, await seedAutoTicket(next, { channel: 'sys', op: next.op, params: next.params }));
  return handleWorkspaceSys(next);
}

test('screenshot rejects an inactive target without capturing another tab', async () => {
  let captures=0;
  chrome.tabs={get:async id=>({id,windowId:1,url:'https://example.com'}),query:async()=>[{id:2}],
    captureVisibleTab:async()=>{captures++; return 'data:image/png;base64,AA==';}};
  const result=await handleWorkspaceSys({op:'screenshot',params:{tabId:1}});
  assert.equal(result.code,'TAB_NOT_VISIBLE'); assert.equal(captures,0);
});

test('stream limit cancels the reader before consuming the full response', async () => {
  let cancelled=false; let reads=0;
  const response={body:new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}})};
  await assert.rejects(readResponseBytes(response,6),{code:'TOO_LARGE'});
  assert.equal(cancelled,true); assert.ok(reads<=3);
});

test('browser call cancellation reaches fetch, including its body', async () => {
  const original=globalThis.fetch; let seenSignal; let started;
  const ready=new Promise(r=>started=r);
  globalThis.fetch=async(_url,init)=>{seenSignal=init.signal; started(); return {
    body:new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(new Error('aborted')));}})
  };};
  try {
    const envelope={callId:'cancel-test',sessionId:'s',executionId:'e'};
    const pending=handleWorkspaceSys({...envelope,op:'fetch',params:{url:'https://example.com'}});
    await ready;
    await handleWorkspaceSys({...envelope,op:'cancel'});
    assert.equal((await pending).code,'SYS_ABORTED'); assert.equal(seenSignal.aborted,true);
    assert.equal((await handleWorkspaceSys({...envelope,op:'fetch',params:{url:'https://example.com'}})).code,'SYS_ABORTED');
  } finally {globalThis.fetch=original;}
});

test('saveTo writes binary bytes and returns a small file receipt', async () => {
  let written;
  const sys=createGuestSys({fs:{writeFile:async(path,bytes)=>written={path,bytes}},hostSys:async()=>({ok:true,result:{ok:true,base64:'AQID',contentType:'application/octet-stream'}})});
  const receipt=await sys.fetch({url:'https://example.com',saveTo:'/artifacts/data.bin'});
  assert.equal(receipt.base64,undefined); assert.equal(receipt.bytes,3);
  assert.deepEqual([...written.bytes],[1,2,3]); assert.ok(sys.writtenFiles.has('/artifacts/data.bin'));
  await assert.rejects(sys.fetch({saveTo:'/context/data.bin'}),{code:'BAD_INPUT'});
});

test('parallel CDP commands share attachment; another debugger is not treated as ours', async () => {
  installTestPolicy({ mode: 'full' });
  let attaches=0;
  chrome.tabs={get:async id=>({id,url:'https://example.com'})};
  chrome.debugger={attach:async()=>{attaches++;await new Promise(r=>setImmediate(r));},
    sendCommand:async()=>({value:1}),detach:async()=>{},getTargets:async()=>[]};
  const reqs=[];
  for (let i=0;i<2;i+=1) {
    const req={sessionId:'s',executionId:'e',op:'cdp',params:{tabId:73,method:'Page.getLayoutMetrics'}};
    Object.assign(req, await seedAutoTicket(req,{channel:'sys',op:'cdp',params:req.params}));
    reqs.push(req);
  }
  const results=await Promise.all(reqs.map((req)=>handleWorkspaceSys(req)));
  assert.equal(attaches,1); assert.ok(results.every(result=>result.ok));
  await handleWorkspaceSys({op:'cdp',params:{tabId:73,action:'detach'}});
  chrome.debugger.attach=async()=>{throw new Error('Another debugger is already attached to the tab')};
  chrome.debugger.sendCommand=async()=>{throw new Error('Another debugger is already attached to the tab')};
  const busy=await sys({op:'cdp',params:{tabId:74,action:'attach'}});
  assert.equal(busy.code,'CDP_BUSY');
});

test('CDP reclaim works when this extension still owns the pipe', async () => {
  installTestPolicy({ mode: 'full' });
  let probed=0;
  chrome.tabs={get:async id=>({id,url:'https://example.com'})};
  chrome.debugger={
    attach:async()=>{throw new Error('already attached to the tab')},
    sendCommand:async()=>{probed++; return {result:{type:'undefined'}};},
    detach:async()=>{},
    getTargets:async()=>[]
  };
  const result=await sys({op:'cdp',params:{tabId:80,action:'attach'}});
  assert.equal(result.ok,true); assert.equal(probed,1);
  await handleWorkspaceSys({op:'cdp',params:{tabId:80,action:'detach'}});
});

test('CDP targetId is allowlisted; eval does not run on extension pages', async () => {
  chrome.debugger={getTargets:async()=>[{id:'t1',url:'chrome://version',type:'page'}],attach:async()=>{},sendCommand:async()=>({}),detach:async()=>{}};
  const denied=await handleWorkspaceSys({op:'cdp',params:{targetId:'t1',action:'attach'}});
  assert.equal(denied.code,'NEED_PAGE');
  chrome.tabs={get:async id=>({id,url:'chrome-extension://abc/src/preview/sheet.html'})};
  chrome.userScripts={getScripts:async()=>[],execute:async()=>[{result:{ok:true,value:1}}]};
  const evalDenied=await handleWorkspaceSys({op:'eval',params:{tabId:9,code:'return 1'}});
  assert.equal(evalDenied.code,'NEED_PAGE');
  const missing=await handleWorkspaceSys({op:'eval',params:{code:'return 1'}});
  assert.equal(missing.code,'NEED_PAGE');
});

test('abort surfaces SYS_ABORTED, not a numeric DOMException code', async () => {
  const original=globalThis.fetch; let started;
  const ready=new Promise(r=>started=r);
  globalThis.fetch=async(_url,init)=>{
    started();
    return new Promise((_,reject)=>{
      init.signal.addEventListener('abort',()=>reject(new DOMException('The operation was aborted.','AbortError')),{once:true});
    });
  };
  try {
    const envelope={callId:'abort-code',sessionId:'s',executionId:'e'};
    const pending=handleWorkspaceSys({...envelope,op:'fetch',params:{url:'https://example.com'}});
    await ready;
    await handleWorkspaceSys({...envelope,op:'cancel'});
    const result=await pending;
    assert.equal(result.code,'SYS_ABORTED');
    assert.equal(typeof result.code,'string');
  } finally {globalThis.fetch=original;}
});

test('capability probe handles asynchronous permission denial', async () => {
  chrome.userScripts={getScripts:async()=>{throw new Error('not allowed')},execute:async()=>[]};
  const result=await handleWorkspaceSys({op:'capabilities'});
  assert.equal(result.ok,true); assert.equal(result.result.userScripts.available,false);
  assert.match(result.result.userScripts.reason,/Allow User Scripts/);
  delete chrome.userScripts;
});

test('stale artifact edits are rejected, identical retries are safe, guest writes invalidate versions', () => {
  const store=new SessionWorkspaceStore();
  store.put('sessions','s',{sessionId:'s',messages:[]});
  const fs=createSessionGuestFs(store,{sessionId:'s',executionId:'e'});
  const artifact=createArtifact(store,fs,{sessionId:'s',name:'proof.txt',content:'original',mimeType:'text/plain'});
  const updated=updateArtifactContent(store,fs,'s',artifact.artifactId,'first',{expectedRevision:artifact.revision});
  assert.equal(updated.revision,artifact.revision+1);
  assert.throws(()=>updateArtifactContent(store,fs,'s',artifact.artifactId,'stale',{expectedRevision:artifact.revision}),{code:'ARTIFACT_CONFLICT'});
  assert.equal(fs.readFile(updated.primaryPath),'first');
  const retry=updateArtifactContent(store,fs,'s',artifact.artifactId,'first',{expectedRevision:artifact.revision});
  assert.equal(retry.revision,updated.revision);
  fs.writeFile(updated.primaryPath,'guest update');
  assert.throws(()=>updateArtifactContent(store,fs,'s',artifact.artifactId,'stale',{expectedRevision:updated.revision}),{code:'ARTIFACT_CONFLICT'});
  assert.equal(fs.readFile(updated.primaryPath),'guest update');
});

test('plan/clarify chrome never matches another session', () => {
  assert.equal(clarifyBelongsToSession('session-a', 'session-a'), true);
  assert.equal(clarifyBelongsToSession('session-a', 'session-b'), false);
  assert.equal(clarifyBelongsToSession('', 'session-b'), false);
  assert.equal(clarifyBelongsToSession('session-a', ''), false);
  assert.equal(clarifyBelongsToSession('', ''), false);
});

test('guest sleep suspends the QuickJS sandbox without setTimeout, and abort interrupts it', async () => {
  const slept = await runCode({ code: 'const t = Date.now(); await sleep(60); return Date.now() - t;', timeoutMs: 5000, runtime: 'local-quickjs' });
  assert.equal(slept.exitStatus, 0, slept.stderr || slept.error);
  assert.ok(slept.value >= 40, `expected >=40ms, got ${slept.value}`);

  const controller = new AbortController();
  const pending = runCode({ code: 'await sleep(10000); return "done";', timeoutMs: 15000, signal: controller.signal, runtime: 'local-quickjs' });
  setTimeout(() => controller.abort(), 50);
  const aborted = await pending;
  assert.equal(aborted.exitStatus, 1);
  assert.equal(aborted.value, undefined);
});

test('sys.waitFor is a guest ABI call that forwards params to the host', async () => {
  const calls = [];
  const sys = createGuestSys({ hostSys: async (op, params) => { calls.push({ op, params }); return { ok: true, result: { value: { ready: true }, stable: true } }; } });
  const out = await sys.waitFor({ text: 'DONE', tabId: 7, timeoutMs: 40000, stableMs: 800 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'waitFor');
  assert.equal(calls[0].params.text, 'DONE');
  assert.equal(calls[0].params.tabId, 7);
  assert.deepEqual(out.value, { ready: true });
});

test('wrapWaitForSource polls a page predicate until it settles, then times out', async () => {
  globalThis.__wf_start = Date.now();
  const readyCode = wrapWaitForSource({ mode: 'code', params: { code: 'return (Date.now() - globalThis.__wf_start) >= 200 ? { hit: 1 } : null;' }, timeoutMs: 5000, pollMs: 40, stableMs: 0 });
  // eslint-disable-next-line no-eval
  const ready = await eval(readyCode);
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.value, { hit: 1 });
  assert.ok(ready.waitedMs >= 150, `waited ${ready.waitedMs}ms`);

  const timeoutCode = wrapWaitForSource({ mode: 'code', params: { code: 'return null;' }, timeoutMs: 300, pollMs: 40, stableMs: 0 });
  // eslint-disable-next-line no-eval
  const timedOut = await eval(timeoutCode);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'WAIT_TIMEOUT');
});

test('wrapWaitForSource stableMs waits for a changing value to stop moving', async () => {
  globalThis.__wf_tick_end = Date.now() + 200;
  const stableCode = wrapWaitForSource({ mode: 'code', params: { code: 'return { v: Date.now() < globalThis.__wf_tick_end ? Date.now() : "settled" };' }, timeoutMs: 5000, pollMs: 40, stableMs: 160 });
  // eslint-disable-next-line no-eval
  const settled = await eval(stableCode);
  assert.equal(settled.ok, true);
  assert.equal(settled.stable, true);
  assert.deepEqual(settled.value, { v: 'settled' });
});

test('sys.waitFor host op validates input, needs a page, and forwards the page result', async () => {
  const badInput = await handleWorkspaceSys({ op: 'waitFor', params: {} });
  assert.equal(badInput.code, 'BAD_INPUT');

  const noPage = await handleWorkspaceSys({ op: 'waitFor', params: { text: 'x' } });
  assert.equal(noPage.code, 'NEED_PAGE');

  chrome.tabs = { get: async (id) => ({ id, url: 'https://example.com' }) };
  chrome.userScripts = {
    getScripts: async () => [],
    execute: async () => [{ result: { ok: true, value: { answer: 42 }, waitedMs: 123, stable: true }, frameId: 0 }]
  };
  const ok = await handleWorkspaceSys({ op: 'waitFor', params: { text: 'answer', tabId: 5 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result.value, { answer: 42 });
  assert.equal(ok.result.stable, true);

  chrome.userScripts.execute = async () => [{ result: { ok: false, code: 'WAIT_TIMEOUT', error: 'nope' } }];
  const timedOut = await handleWorkspaceSys({ op: 'waitFor', params: { selector: '#missing', tabId: 5 } });
  assert.equal(timedOut.code, 'WAIT_TIMEOUT');
  delete chrome.userScripts;
});

test('TSV save and reopen preserves tabs inside cells and neighboring columns', () => {
  const rows = [
    ['name', 'note', 'count'],
    ['Alice', 'left\tright', '2'],
    ['Bob', '\t', '3'],
    ['Carol', 'a"b\tc\nd', '4'],
  ];
  assert.deepEqual(parseDelimited(aoaToCsv(rows, '\t'), 'tsv'), rows);
  assert.deepEqual(parseDelimited(aoaToCsv(rows), 'csv'), rows);
});
