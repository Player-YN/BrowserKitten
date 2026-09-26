import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import {
  resolveSttRuntimeConfig,
  transcribeSessionAudio
} from '../src/agent/vnext/sessionWorkspace/transcribe.js';
import { I18N } from '../src/sidepanel/i18n.js';
import { readFileSync } from 'node:fs';

const STT_I18N = [
  'settingsSttTitle',
  'sttEmptyHint',
  'addSttBtn',
  'saveSttBtn',
  'settingsSttModel',
  'apiProbeSttBtn',
  'apiProbeSttOk',
  'apiProbeSttNone',
  'apiProbeSttBtnHint',
  'modelPickerSearchStt'
];

function sessionEnv() {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  fs.mkdirp('/scratch/sources');
  return { store, fs, sessionId: 's', execution: { executionId: 'e' } };
}

test('settings HTML and both i18n tables include the transcription card', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /id="settingsSttCard"/);
  assert.match(html, /id="sttEditor"/);
  assert.match(html, /id="sttPresetCombobox"[^>]*data-preset-kind="stt"/);
  for (const key of STT_I18N) {
    assert.equal(typeof I18N.zh[key], 'string', `zh missing ${key}`);
    assert.equal(typeof I18N.en[key], 'string', `en missing ${key}`);
  }
});

test('resolveSttRuntimeConfig stays independent of chat settings', () => {
  const none = resolveSttRuntimeConfig({ apiKey: 'sk-chat', apiBase: 'https://api.deepseek.com/v1' });
  assert.equal(none.enabled, false);
  const on = resolveSttRuntimeConfig({
    apiKey: 'sk-chat',
    stt: { apiKey: 'sk-stt', apiBase: 'https://api.openai.com/v1', model: 'whisper-1' }
  });
  assert.equal(on.enabled, true);
  assert.equal(on.apiKey, 'sk-stt');
  assert.equal(on.model, 'whisper-1');
});

test('transcribe needs a configured STT API', async () => {
  const env = sessionEnv();
  const result = await transcribeSessionAudio({
    ...env,
    path: '/scratch/sources/clip.mp3',
    settings: {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NEED_STT');
});

test('transcribe posts multipart /audio/transcriptions and writes /scratch', async () => {
  const env = sessionEnv();
  env.fs.writeFile('/scratch/sources/clip.mp3', new Uint8Array([1, 2, 3, 4]), {
    mimeType: 'audio/mpeg'
  });
  let posted = null;
  const result = await transcribeSessionAudio({
    ...env,
    path: '/scratch/sources/clip.mp3',
    settings: {
      stt: { apiKey: 'sk-stt', apiBase: 'https://api.openai.com/v1', model: 'whisper-1' }
    },
    fetchImpl: async (url, init) => {
      posted = { url: String(url), method: init.method, body: init.body };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: 'hello from audio' })
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'transcribe');
  assert.equal(result.text, 'hello from audio');
  assert.match(result.path, /^\/scratch\/sources\/transcript_/);
  assert.equal(env.fs.readFile(result.path), 'hello from audio');
  assert.match(posted.url, /\/audio\/transcriptions$/);
  assert.equal(posted.method, 'POST');
  assert.ok(posted.body instanceof FormData);
  assert.equal(posted.body.get('model'), 'whisper-1');
});

test('acquire exposes transcribe and uses the STT settings object', async () => {
  const env = sessionEnv();
  const tools = createSessionTools({
    ...env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: 'from acquire' })
    })
  });
  assert.deepEqual(tools.acquire.parameters.properties.action.enum, [
    'search',
    'fetch',
    'map',
    'crawl',
    'note',
    'image',
    'transcribe'
  ]);
  assert.match(tools.acquire.description, /transcribe/);
  env.fs.writeFile('/scratch/sources/clip.wav', new Uint8Array([9, 8, 7]), { mimeType: 'audio/wav' });
  const result = await tools.acquire.execute({
    action: 'transcribe',
    path: '/scratch/sources/clip.wav'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NEED_STT');

  const toolsWithStt = createSessionTools({
    ...env,
    settings: {
      stt: { apiKey: 'sk-stt', apiBase: 'https://stt.example/v1', model: 'whisper-1' }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: 'from acquire' })
    })
  });
  const ok = await toolsWithStt.acquire.execute({
    action: 'transcribe',
    path: '/scratch/sources/clip.wav'
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'from acquire');
});
