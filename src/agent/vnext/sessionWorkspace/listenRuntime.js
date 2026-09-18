/**
 * Offscreen tab audio/video recorder. One session at a time.
 * Must play the captured stream back or Chrome mutes the tab.
 */

function pickMime(MediaRecorderCtor, video = false) {
  const candidates = video
    ? ['video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorderCtor?.isTypeSupported === 'function') {
    for (const mime of candidates) {
      if (MediaRecorderCtor.isTypeSupported(mime)) return mime;
    }
  }
  return video ? 'video/webm' : 'audio/webm';
}

async function blobToBytes(blob) {
  if (!blob) return new Uint8Array(0);
  if (blob instanceof Uint8Array) return blob;
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(0);
}

function stopTracks(stream) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop();
  } catch {
    /* already stopped */
  }
}

/**
 * @param {{
 *   getUserMedia?: (constraints: object) => Promise<MediaStream>,
 *   AudioContext?: typeof AudioContext,
 *   MediaRecorder?: typeof MediaRecorder
 * }} [hooks]
 */
export function createListenRuntime(hooks = {}) {
  /** @type {Map<string, object>} */
  const bySession = new Map();
  const starting = new Map();

  function findByTab(tabId) {
    const id = Number(tabId);
    for (const [sessionId, rec] of bySession) {
      if (Number(rec.tabId) === id) return sessionId;
    }
    return '';
  }

  async function start(input = {}) {
    const sessionId = String(input.sessionId || '');
    if (!sessionId) return { ok: false, code: 'NEED_SESSION', error: 'sessionId required' };
    const streamId = String(input.streamId || '');
    if (!streamId) return { ok: false, code: 'NEED_PAGE', error: 'streamId required' };
    if (bySession.has(sessionId) || starting.has(sessionId)) return { ok: false, code: 'CAPTURE_BUSY', error: 'Finish the existing tab recording first.' };
    const reservation = { ...input, cancelled: false };
    starting.set(sessionId, reservation);
    try {
      const video = input.captureKind === 'video';

      const getUserMedia =
        hooks.getUserMedia ||
        (typeof navigator !== 'undefined'
          ? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
          : null);
      if (typeof getUserMedia !== 'function') {
        return { ok: false, code: 'NEED_PAGE', error: 'getUserMedia unavailable' };
      }

      let stream;
      try {
        stream = await getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          },
          video: video ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 12 } } : false
        });
      } catch (error) {
        return { ok: false, code: 'NEED_PAGE', error: error?.message || String(error) };
      }

      if (reservation.cancelled) { stopTracks(stream); return { ok: false, code: 'ABORTED' }; }

      const AC = hooks.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
      let ctx = null;
      let source = null;
      try {
        if (AC) {
          ctx = new AC();
          if (typeof ctx.createMediaStreamSource === 'function') {
            source = ctx.createMediaStreamSource(stream);
            source.connect(ctx.destination);
          }
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            await ctx.resume().catch(() => {});
          }
        }
      } catch {
        /* playback is best-effort; still record */
      }

      if (reservation.cancelled) {
        stopTracks(stream);
        try { await ctx?.close?.(); } catch { /* already closed */ }
        return { ok: false, code: 'ABORTED' };
      }

      const MR = hooks.MediaRecorder || globalThis.MediaRecorder;
      if (!MR) {
        stopTracks(stream);
        try {
          await ctx?.close?.();
        } catch {
          /* */
        }
        return { ok: false, code: 'NEED_PAGE', error: 'MediaRecorder unavailable' };
      }
      const mimeType = pickMime(MR, video);
      const chunks = [];
      let rec;
      try {
        rec = new MR(stream, { mimeType, ...(video ? { videoBitsPerSecond: 1200000, audioBitsPerSecond: 96000 } : {}) });
        const state = {
          stream, ctx, source, rec, chunks, mimeType,
          captureKind: video ? 'video' : 'audio',
          tabId: Number(input.tabId) || 0,
          executionId: String(input.executionId || ''),
          startedAt: Date.now(), totalBytes: 0, truncated: false, error: null
        };
        rec.ondataavailable = (ev) => {
          if (ev?.data && ev.data.size) { chunks.push(ev.data); state.totalBytes += ev.data.size; }
          if (video && state.totalBytes >= 12 * 1024 * 1024 && rec.state !== 'inactive') {
            state.truncated = true;
            rec.stop(); stopTracks(stream);
          }
        };
        rec.onerror = (ev) => { state.error = ev?.error?.message || 'recording failed'; stopTracks(stream); };
        rec.start(250);
        bySession.set(sessionId, state);
      } catch (error) {
        stopTracks(stream);
        try { await ctx?.close?.(); } catch { /* already closed */ }
        return { ok: false, code: 'CAPTURE_FAILED', error: error?.message || String(error) };
      }
      return { ok: true, sessionId, tabId: Number(input.tabId) || 0 };
    } finally { starting.delete(sessionId); }
  }

  async function stop(input = {}) {
    const sessionId = String(input.sessionId || '');
    const recState = bySession.get(sessionId);
    if (!recState) {
      return { ok: false, code: 'BAD_INPUT', error: 'not listening', hint: 'action op=listen listen=start first' };
    }
    bySession.delete(sessionId);
    const { rec, stream, ctx, chunks, mimeType, tabId } = recState;
    const bytes = await new Promise((resolve) => {
      const finish = async () => {
        try {
          const blob =
            typeof Blob !== 'undefined' ? new Blob(chunks, { type: mimeType || 'audio/webm' }) : chunks[0];
          resolve(input.discard ? new Uint8Array(0) : await blobToBytes(blob));
        } catch {
          resolve(new Uint8Array(0));
        }
      };
      rec.onstop = () => {
        void finish();
      };
      try {
        if (rec.state && rec.state !== 'inactive') rec.stop();
        else void finish();
      } catch {
        void finish();
      }
    });
    stopTracks(stream);
    try {
      await ctx?.close?.();
    } catch {
      /* */
    }
    if (input.discard) return { ok: true, discarded: true, tabId };
    if (recState.error) return { ok: false, code: 'CAPTURE_FAILED', error: recState.error, tabId };
    return {
      ok: true,
      bytes,
      mimeType: mimeType || 'audio/webm',
      captureKind: recState.captureKind,
      truncated: recState.truncated,
      durationMs: Date.now() - recState.startedAt,
      tabId
    };
  }

  async function abort(input = {}) {
    const stopped = [];
    for (const [sid, pending] of starting) {
      if ((input.sessionId && String(input.sessionId) === sid) ||
          (input.tabId != null && Number(input.tabId) === Number(pending.tabId)) ||
          (input.executionId && String(input.executionId) === String(pending.executionId))) pending.cancelled = true;
    }
    if (input.tabId != null && Number(input.tabId) > 0) {
      const sid = findByTab(input.tabId);
      if (sid) stopped.push(await stop({ sessionId: sid, discard: true }));
    }
    if (input.sessionId) {
      if (bySession.has(String(input.sessionId))) {
        stopped.push(await stop({ sessionId: input.sessionId, discard: true }));
      }
    }
    if (input.executionId) {
      const want = String(input.executionId);
      for (const [sid, rec] of [...bySession]) {
        if (String(rec.executionId) === want) {
          stopped.push(await stop({ sessionId: sid, discard: true }));
        }
      }
    }
    return { ok: true, stopped: stopped.length };
  }

  return {
    start,
    stop,
    abort,
    isListening(sessionId) {
      return bySession.has(String(sessionId || ''));
    }
  };
}
