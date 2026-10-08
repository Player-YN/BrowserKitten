import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, RISK_READ } from '../src/agent/vnext/host/riskClassify.js';
import {
  handleWorkspaceTabListen,
  putListenGrant,
  dropListenGrantsForTab,
  listenGrantKey,
  clampListenSeconds,
  DEFAULT_LISTEN_SECONDS,
  MAX_LISTEN_SECONDS
} from '../src/agent/vnext/host/tabListen.js';
import { createListenRuntime } from '../src/agent/vnext/sessionWorkspace/listenRuntime.js';
import { executeListenAction } from '../src/agent/vnext/sessionWorkspace/listenAction.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { attachToolFailureHint } from '../src/agent/vnext/sessionWorkspace/toolReceipt.js';
import { SYSTEM_PROMPT_VERSION, buildSessionAgentInstructions } from '../src/agent/vnext/sessionWorkspace/prompt.js';

function memorySessionStorage(initial = {}) {
  const bag = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    },
    async set(values) {
      Object.assign(bag, values);
    },
    async remove(keys) {
      for (const k of keys) delete bag[k];
    },
    bag
  };
}

function chromeLike({ tabId = 7, visible = true, audible = true, streamId = 'stream-1' } = {}) {
  return {
    tabs: {
      async get(id) {
        return { id, windowId: 1, audible, title: 'Video' };
      },
      async query(q) {
        if (!visible) return [{ id: tabId + 1, windowId: q.windowId }];
        return [{ id: tabId, windowId: q.windowId }];
      }
    },
    tabCapture: {
      async getMediaStreamId() {
        return streamId;
      }
    }
  };
}

function fakeRecorderHooks() {
  class FakeAudioContext {
    state = 'running';
    createMediaStreamSource() {
      return { connect() {} };
    }
    async close() {}
  }
  class FakeRecorder {
    constructor(_stream, opts = {}) {
      this.mimeType = opts.mimeType || 'audio/webm';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])]) });
      this.onstop?.();
    }
  }
  return {
    AudioContext: FakeAudioContext,
    MediaRecorder: FakeRecorder,
    async getUserMedia() {
      return { getTracks: () => [{ stop() {} }] };
    }
  };
}

function sessionEnv(extra = {}) {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  fs.mkdirp('/scratch/sources');
  return {
    store,
    fs,
    sessionId: 's',
    execution: { executionId: 'e' },
    ...extra
  };
}

test('listen is ACTION_READ and schema includes listen', () => {
  const classified = classifyRisk({ channel: 'action', op: 'listen', tabId: 7 });
  assert.equal(classified.risk, RISK_READ);
  assert.equal(classified.reason, 'action:listen');
  const tools = createSessionTools(sessionEnv());
  assert.ok(tools.action.parameters.properties.op.enum.includes('listen'));
  assert.ok(tools.action.description.length <= 700);
  assert.match(tools.action.description, /listen/);
});

test('prompt mentions listen', () => {
  assert.equal(SYSTEM_PROMPT_VERSION, 'v26-system1-clicks');
  assert.match(buildSessionAgentInstructions(), /op=listen/);
});

test('no grant returns NEED_CAPTURE_GRANT with side-panel hint', async () => {
  const out = await handleWorkspaceTabListen(
    { sessionId: 's', tabId: 7, listen: 'start' },
    { chromeLike: chromeLike(), sessionStorage: memorySessionStorage() }
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEED_CAPTURE_GRANT');
  const hinted = attachToolFailureHint(out);
  assert.match(hinted.hint, /side-panel|listen=start/i);
});

test('invisible tab is TAB_NOT_VISIBLE', async () => {
  const storage = memorySessionStorage();
  await putListenGrant(storage, 's', 7);
  const out = await handleWorkspaceTabListen(
    { sessionId: 's', tabId: 7, listen: 'clip' },
    { chromeLike: chromeLike({ visible: false }), sessionStorage: storage }
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TAB_NOT_VISIBLE');
});

test('granted clip returns streamId and audible', async () => {
  const storage = memorySessionStorage();
  await putListenGrant(storage, 's', 7);
  const out = await handleWorkspaceTabListen(
    { sessionId: 's', tabId: 7, listen: 'clip', seconds: 9 },
    { chromeLike: chromeLike({ audible: false }), sessionStorage: storage }
  );
  assert.equal(out.ok, true);
  assert.equal(out.streamId, 'stream-1');
  assert.equal(out.audible, false);
  assert.equal(out.seconds, 9);
});

test('clip writes webm and transcribes when STT is configured', async () => {
  const env = sessionEnv({
    listenRuntime: createListenRuntime(fakeRecorderHooks()),
    sleep: async () => {},
    settings: {
      stt: { apiKey: 'sk-stt', apiBase: 'https://api.openai.com/v1', model: 'whisper-1' }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: 'heard you' })
    }),
    hostPageAction: async () => ({
      ok: true,
      listen: 'clip',
      tabId: 7,
      streamId: 'sid',
      audible: true,
      seconds: 1
    })
  });
  const out = await executeListenAction(env, { listen: 'clip', seconds: 1 }, 7);
  assert.equal(out.ok, true);
  assert.equal(out.listen, 'clip');
  assert.match(out.path, /^\/scratch\/sources\/listen_/);
  assert.equal(out.text, 'heard you');
  assert.ok(env.fs.exists(out.path));
});

test('clip without STT keeps the audio path and NEED_STT', async () => {
  const env = sessionEnv({
    listenRuntime: createListenRuntime(fakeRecorderHooks()),
    sleep: async () => {},
    settings: {},
    hostPageAction: async () => ({
      ok: true,
      listen: 'clip',
      tabId: 7,
      streamId: 'sid',
      audible: true
    })
  });
  const out = await executeListenAction(env, { listen: 'clip' }, 7);
  assert.equal(out.ok, true);
  assert.equal(out.stt.code, 'NEED_STT');
  assert.match(out.path, /listen_/);
});

test('abort or tab close stops the recorder', async () => {
  const runtime = createListenRuntime(fakeRecorderHooks());
  const started = await runtime.start({ sessionId: 's', streamId: 'sid', tabId: 7, executionId: 'e' });
  assert.equal(started.ok, true);
  assert.equal(runtime.isListening('s'), true);
  await runtime.abort({ tabId: 7 });
  assert.equal(runtime.isListening('s'), false);
});

test('closing the tab drops the session grant', async () => {
  const storage = memorySessionStorage();
  await putListenGrant(storage, 's', 7);
  assert.equal(storage.bag[listenGrantKey('s', 7)].tabId, 7);
  const n = await dropListenGrantsForTab(storage, 7);
  assert.equal(n, 1);
  assert.equal(storage.bag[listenGrantKey('s', 7)], undefined);
});

test('seconds are clamped and acquire transcribe is unchanged', () => {
  assert.equal(clampListenSeconds(0), DEFAULT_LISTEN_SECONDS);
  assert.equal(clampListenSeconds(999), MAX_LISTEN_SECONDS);
  const tools = createSessionTools(sessionEnv());
  assert.ok(tools.acquire.parameters.properties.action.enum.includes('transcribe'));
});

test('record is read-only, uses an independent video grant and clamps to a short clip', async () => {
  const storage = memorySessionStorage();
  await putListenGrant(storage, 's', 7); // audio consent must not become screen consent
  const request = { op: 'record', sessionId: 's', tabId: 7, seconds: 999 };
  const deps = { chromeLike: chromeLike(), sessionStorage: storage };
  const denied = await handleWorkspaceTabListen(request, deps);
  assert.equal(denied.code, 'NEED_CAPTURE_GRANT');
  assert.equal(denied.captureKind, 'video');
  await putListenGrant(storage, 's', 7, 'video');
  const allowed = await handleWorkspaceTabListen(request, deps);
  assert.equal(allowed.ok, true); assert.equal(allowed.seconds, 30);
  assert.equal(allowed.captureKind, 'video');
  const defaults = await handleWorkspaceTabListen({ ...request, seconds: undefined }, deps);
  assert.equal(defaults.seconds, 8);
  assert.equal(classifyRisk({ channel: 'action', op: 'record' }).risk, RISK_READ);
  assert.equal(await dropListenGrantsForTab(storage, 7), 2);
});

test('record captures video + audio, delivers WebM to current model, and releases tracks', async () => {
  const { resolveChatMediaCapabilities } = await import('../src/agent/chatMedia.js');
  const settings = { apiBase: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' };
  const hooks = fakeRecorderHooks();
  let constraints, stopped = 0, waited = 0, request;
  hooks.getUserMedia = async (input) => { constraints = input; return { getTracks: () => [{ stop() { stopped++; } }] }; };
  const env = sessionEnv({ settings, mediaCapabilities: resolveChatMediaCapabilities(settings),
    listenRuntime: createListenRuntime(hooks),
    hostPageAction: async (input) => { request = input; return { ok: true, streamId: 's', tabId: 7 }; },
    sleep: async ms => { waited = ms; }
  });
  const tools = createSessionTools(env);
  assert.ok(tools.action.parameters.properties.op.enum.includes('record'));
  assert.ok(tools.action.description.length <= 700);
  const result = await tools.action.execute({ op: 'record', tabId: 7 });
  assert.equal(request.op, 'record');
  assert.equal(waited, 8000);
  assert.equal(constraints.video.mandatory.chromeMediaSource, 'tab');
  assert.equal(constraints.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(constraints.video.mandatory.maxFrameRate, 12);
  assert.equal(result.media.route, 'native');
  assert.equal(result.media.kind, 'video');
  assert.match(result.modelParts[0].mediaType, /^video\/webm/);
  assert.match(result.path, /record_/);
  assert.equal(stopped, 1);
  const facts = JSON.parse(tools.action.toModelOutput({ output: result }).value[0].text);
  assert.equal(facts.op, 'record');
  assert.match(facts.scope, /tab picture/);
});

test('record rejects unknown native video before capture; audio remains audio-only', async () => {
  let calls = 0, constraints;
  const blocked = await executeListenAction(sessionEnv({ hostPageAction: async () => { calls++; } }), { op: 'record' }, 7);
  assert.equal(blocked.code, 'VIDEO_INPUT_UNAVAILABLE'); assert.equal(calls, 0);
  const hooks = fakeRecorderHooks();
  hooks.getUserMedia = async c => { constraints = c; return { getTracks: () => [] }; };
  const runtime = createListenRuntime(hooks);
  await runtime.start({ sessionId: 's', streamId: 's' });
  assert.equal(constraints.video, false);
  await runtime.abort({ sessionId: 's' });
});

test('pending capture is reserved, cancelled on abort, and cannot leak tracks', async () => {
  let resolveStream, stops = 0;
  const hooks = fakeRecorderHooks();
  hooks.getUserMedia = () => new Promise(resolve => { resolveStream = resolve; });
  const runtime = createListenRuntime(hooks);
  const first = runtime.start({ sessionId: 's', streamId: 's', captureKind: 'video', tabId: 7 });
  const second = await runtime.start({ sessionId: 's', streamId: 's' });
  assert.equal(second.code, 'CAPTURE_BUSY');
  await runtime.abort({ tabId: 7 });
  resolveStream({ getTracks: () => [{ stop() { stops++; } }] });
  assert.equal((await first).code, 'ABORTED');
  assert.equal(stops, 1);
  assert.equal(runtime.isListening('s'), false);
});

test('snapshot media clues reach the model and prompt chooses evidence without video keywords', () => {
  const tools = createSessionTools(sessionEnv());
  const mediaElements = [{ kind: 'video', sourceKind: 'stream', paused: false, frameId: 2 }];
  const facts = tools.action.toModelOutput({ output: { ok: true, op: 'snapshot', mediaElements } }).value;
  assert.deepEqual(facts.mediaElements, mediaElements);
  const prompt = buildSessionAgentInstructions();
  assert.match(prompt, /不以用户是否说“看视频”为前提/);
  assert.match(prompt, /动作先后、动画故障/);
  assert.match(prompt, /op=record/);
});
