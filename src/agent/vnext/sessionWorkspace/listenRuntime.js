/**
 * Offscreen tab-audio recorder. One session at a time.
 * Must play the captured stream back or Chrome mutes the tab.
 */

function pickMime(MediaRecorderCtor) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorderCtor?.isTypeSupported === 'function') {
    for (const mime of candidates) {
      if (MediaRecorderCtor.isTypeSupported(mime)) return mime;
    }
  }
  return 'audio/webm';
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
    if (bySession.has(sessionId)) await stop({ sessionId, discard: true });

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
        video: false
      });
    } catch (error) {
      return { ok: false, code: 'NEED_PAGE', error: error?.message || String(error) };
    }

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
    const mimeType = pickMime(MR);
    const rec = new MR(stream, { mimeType });
    const chunks = [];
    rec.ondataavailable = (ev) => {
      if (ev?.data && ev.data.size) chunks.push(ev.data);
    };
    rec.start(250);
    bySession.set(sessionId, {
      stream,
      ctx,
      source,
      rec,
      chunks,
      mimeType,
      tabId: Number(input.tabId) || 0,
      executionId: String(input.executionId || '')
    });
    return { ok: true, sessionId, tabId: Number(input.tabId) || 0 };
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
    return {
      ok: true,
      bytes,
      mimeType: mimeType || 'audio/webm',
      tabId
    };
  }

  async function abort(input = {}) {
    const stopped = [];
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
