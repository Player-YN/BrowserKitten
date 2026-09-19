/**
 * action op=listen — host grant/streamId, then offscreen record + existing STT.
 */

import { routeMediaInput } from './mediaInput.js';
import { resolveChatMediaCapabilities, canSendChatMedia } from '../../chatMedia.js';
import { clampListenSeconds, clampRecordSeconds, normalizeListenVerb } from '../host/tabListen.js';

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
  const video = env.captureKind === 'video';
  const path = `/scratch/sources/${video ? 'record' : 'listen'}_${Date.now().toString(36)}.webm`;
  fs.writeFile(path, stopped.bytes || new Uint8Array(0), {
    mimeType: stopped.mimeType || 'audio/webm'
  });
  return routeMediaInput(env, {
    ok: true,
    ...(video ? { op: 'record', captureKind: 'video', scope: 'visible tab picture and tab audio', durationMs: stopped.durationMs, truncated: stopped.truncated === true } : { listen: verb }),
    listening: false,
    path,
    mediaType: stopped.mimeType || 'audio/webm',
    bytes: stopped.bytes?.byteLength || 0,
    tabId: hostOut.tabId,
    audible: hostOut.audible === true
  });
}

/**
 * @param {object} env
 * @param {object} input
 * @param {number|undefined} tabId
 */
export async function executeListenAction(env, input = {}, tabId) {
  const video = input.op === 'record';
  const verb = video ? 'clip' : normalizeListenVerb(input.listen);
  if (video) {
    const caps = env.mediaContext ? await env.mediaContext.wait('video', env.signal) :
      env.mediaCapabilities || resolveChatMediaCapabilities(env.settings);
    if (!canSendChatMedia(caps, 'video/webm')) {
      return { ok: false, op: 'record', code: 'VIDEO_INPUT_UNAVAILABLE',
        hint: 'Current model/transport cannot receive video. Use snapshot for visual facts, listen for audio, or fetch an existing file for STT (speech only). Do not probe chat.' };
    }
  }
  env = { ...env, captureKind: video ? 'video' : 'audio' };
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
    op: video ? 'record' : 'listen',
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
          captureKind: env.captureKind,
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
    executionId: env.execution?.executionId,
    captureKind: env.captureKind
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

  const seconds = video ? clampRecordSeconds(input.seconds ?? hostOut.seconds) : clampListenSeconds(input.seconds ?? hostOut.seconds);
  const wait = typeof env.sleep === 'function' ? env.sleep : sleepMs;
  try {
    await wait(seconds * 1000, env.signal);
  } catch (error) {
    await runtime.abort({ sessionId: env.sessionId });
    return { ok: false, code: error?.code || 'ABORTED', error: error?.message || 'aborted' };
  }
  return finalizeListen(env, hostOut, 'clip');
}
