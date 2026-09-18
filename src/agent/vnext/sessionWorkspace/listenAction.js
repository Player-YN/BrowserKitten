/**
 * action op=listen — host grant/streamId, then offscreen record + existing STT.
 */

import { transcribeSessionAudio, resolveSttRuntimeConfig } from './transcribe.js';
import { clampListenSeconds, normalizeListenVerb } from '../host/tabListen.js';

function sleepMs(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.code = 'ABORTED';
      reject(err);
      return;
    }
    const t = setTimeout(resolve, wait);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error('aborted');
      err.code = 'ABORTED';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function finalizeListen(env, hostOut, verb) {
  const runtime = env.listenRuntime;
  if (!runtime) return { ok: false, code: 'NEED_PAGE', error: 'listen runtime unavailable' };
  const stopped = await runtime.stop({ sessionId: env.sessionId });
  if (!stopped.ok) return { ...stopped, tabId: hostOut.tabId };
  const fs = env.fs;
  if (!fs) return { ok: false, code: 'NEED_PAGE', error: 'guest fs unavailable' };
  fs.mkdirp('/scratch/sources');
  const path = `/scratch/sources/listen_${Date.now().toString(36)}.webm`;
  fs.writeFile(path, stopped.bytes || new Uint8Array(0), {
    mimeType: stopped.mimeType || 'audio/webm'
  });
  const settings = env.settings || {};
  const cfg = resolveSttRuntimeConfig(settings);
  const base = {
    ok: true,
    listen: verb,
    listening: false,
    path,
    bytes: stopped.bytes?.byteLength || 0,
    tabId: hostOut.tabId,
    audible: hostOut.audible === true
  };
  if (!cfg.enabled) {
    return {
      ...base,
      stt: {
        ok: false,
        code: 'NEED_STT',
        hint: 'add a transcription API in Settings'
      }
    };
  }
  const tr = await transcribeSessionAudio({
    store: env.store,
    fs,
    sessionId: env.sessionId,
    path,
    settings,
    fetchImpl: env.fetchImpl,
    signal: env.signal
  });
  if (!tr.ok) {
    return {
      ...base,
      stt: { ok: false, code: tr.code, error: tr.error, hint: tr.hint }
    };
  }
  return { ...base, text: tr.text, transcriptPath: tr.path, model: tr.model };
}

/**
 * @param {object} env
 * @param {object} input
 * @param {number|undefined} tabId
 */
export async function executeListenAction(env, input = {}, tabId) {
  const verb = normalizeListenVerb(input.listen);
  if (!verb) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      error: 'listen must be start, stop, or clip',
      hint: 'pass listen=start, listen=stop, or listen=clip'
    };
  }
  const host = env.hostPageAction;
  if (typeof host !== 'function') {
    return { ok: false, code: 'NEED_PAGE', error: 'no live page host' };
  }
  const hostOut = await host({
    sessionId: env.sessionId,
    op: 'listen',
    listen: verb,
    seconds: input.seconds,
    tabId,
    url: env.activeTab?.url,
    executionId: env.execution?.executionId
  });
  if (!hostOut || hostOut.ok === false) {
    if (hostOut?.code === 'NEED_CAPTURE_GRANT' && typeof env.onEvent === 'function') {
      try {
        env.onEvent({
          type: 'listen-grant-required',
          sessionId: env.sessionId,
          tabId: hostOut.tabId ?? tabId,
          title: hostOut.title || env.activeTab?.title || ''
        });
      } catch {
        /* UI listener must not fail the tool */
      }
    }
    return hostOut;
  }

  const runtime = env.listenRuntime;
  if (verb === 'stop') {
    if (!runtime?.isListening?.(env.sessionId)) {
      return {
        ok: false,
        code: 'BAD_INPUT',
        error: 'not listening',
        hint: 'action op=listen listen=start first',
        tabId: hostOut.tabId
      };
    }
    return finalizeListen(env, hostOut, 'stop');
  }

  if (!runtime) return { ok: false, code: 'NEED_PAGE', error: 'listen runtime unavailable' };
  const started = await runtime.start({
    streamId: hostOut.streamId,
    tabId: hostOut.tabId,
    sessionId: env.sessionId,
    executionId: env.execution?.executionId
  });
  if (started?.ok === false) return started;
  if (verb === 'start') {
    return {
      ok: true,
      listen: 'start',
      listening: true,
      tabId: hostOut.tabId,
      audible: hostOut.audible === true
    };
  }

  const seconds = clampListenSeconds(input.seconds ?? hostOut.seconds);
  const wait = typeof env.sleep === 'function' ? env.sleep : sleepMs;
  try {
    await wait(seconds * 1000, env.signal);
  } catch (error) {
    await runtime.abort({ sessionId: env.sessionId });
    return { ok: false, code: error?.code || 'ABORTED', error: error?.message || 'aborted' };
  }
  return finalizeListen(env, hostOut, 'clip');
}
