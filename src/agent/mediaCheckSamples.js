/** Local synthetic challenges; expected answers never enter the request text. */
import { pcmToWav } from './vnext/sessionWorkspace/mediaInput.js';

const random = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
function tones() {
  const result = Array.from({ length: 8 }, () => random(2) ? 'H' : 'L');
  result[0] = 'L'; result[1] = 'H'; // audible low/high calibration; remaining six are unpredictable
  return result.join('');
}
function samples(sequence, rate = 16000) {
  const data = new Float32Array(sequence.length * rate / 2);
  for (let i = 0; i < data.length; i++) {
    const within = i % (rate / 2), index = Math.floor(i / (rate / 2));
    if (within < rate * 0.3) {
      const envelope = Math.min(1, within / 160, (rate * 0.3 - within) / 160);
      data[i] = 0.3 * envelope * Math.sin(2 * Math.PI * (sequence[index] === 'H' ? 1000 : 300) * i / rate);
    }
  }
  return data;
}
function encode(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
const audioPrompt = 'Return the sequence of eight separated tones as H for high and L for low, in order. The first two establish low then high.';
function canvas() {
  const el = document.createElement('canvas'); el.width = 480; el.height = 240;
  return el;
}
function draw(el, text) {
  const ctx = el.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, el.width, el.height);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 60px monospace'; ctx.textAlign = 'center';
  ctx.textBaseline = 'middle'; ctx.fillText(text, el.width / 2, el.height / 2);
}

export async function createMediaCheckSample(kind, signal) {
  signal.throwIfAborted();
  if (kind === 'image') {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const answer = Array.from({ length: 6 }, () => alphabet[random(alphabet.length)]).join('');
    const el = canvas(); draw(el, answer);
    const data = el.toDataURL('image/jpeg', 0.9).split(',')[1];
    return { part: { type: 'file', mediaType: 'image/jpeg', data }, expected: { image: answer },
      prompt: 'Read the six characters in the image. Reply only with JSON {"image":"characters"}.' };
  }
  const audio = tones();
  const pcm = samples(audio);
  if (kind === 'audio') return {
    part: { type: 'file', mediaType: 'audio/wav', data: encode(pcmToWav([pcm], 16000)) },
    expected: { audio }, prompt: `${audioPrompt} Reply only with JSON {"audio":"sequence"}.`
  };
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = letters.length - 1; i > 0; i--) { const j = random(i + 1); [letters[i], letters[j]] = [letters[j], letters[i]]; }
  const el = canvas(); draw(el, letters[0]);
  const stream = el.captureStream(8);
  const ctx = new AudioContext({ sampleRate: 16000 });
  let recorder, source, timer, rejectRecording;
  const abort = () => {
    clearInterval(timer);
    if (recorder?.state === 'recording') recorder.stop();
    stream.getTracks().forEach(track => track.stop());
    void ctx.close().catch(() => {});
    rejectRecording?.(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const dest = ctx.createMediaStreamDestination();
    const buffer = ctx.createBuffer(1, pcm.length, 16000); buffer.copyToChannel(pcm, 0);
    source = ctx.createBufferSource(); source.buffer = buffer; source.connect(dest);
    dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    await ctx.resume(); signal.throwIfAborted();
    const mimeType = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('SAMPLE_CODEC_UNAVAILABLE');
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 200000 });
    const bytes = await new Promise((resolve, reject) => {
      rejectRecording = reject;
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('SAMPLE_RECORDING_FAILED'));
      recorder.onstop = () => new Blob(chunks).arrayBuffer().then(data => resolve(new Uint8Array(data)), reject);
      recorder.start(); source.start();
      let frame = 0;
      timer = setInterval(() => {
        frame++;
        if (frame === letters.length) { clearInterval(timer); recorder.stop(); }
        else draw(el, letters[frame]);
      }, 700);
    });
    signal.throwIfAborted();
    return { part: { type: 'file', mediaType: 'video/webm', data: encode(bytes) },
      expected: { video: letters.join(''), audio },
      prompt: `Read all six letters in the video in temporal order. For its soundtrack: ${audioPrompt} Reply only with JSON {"video":"letters","audio":"sequence"}.` };
  } finally {
    clearInterval(timer); signal.removeEventListener('abort', abort);
    if (recorder?.state === 'recording') recorder.stop();
    try { source?.stop(); } catch { /* already stopped */ }
    stream.getTracks().forEach(track => track.stop());
    if (ctx.state !== 'closed') await ctx.close();
  }
}

export function scoreMediaCheck(kind, sample, text) {
  let result;
  try { result = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { state: 'unknown', error: 'ANSWER_MISMATCH' }; }
  const match = key => typeof result?.[key] === 'string' && result[key].trim().toUpperCase() === sample.expected[key];
  return { state: match(kind) ? 'supported' : 'unknown',
    ...(match(kind) ? {} : { error: 'ANSWER_MISMATCH' }),
    ...(kind === 'video' ? { videoAudio: match('audio') ? 'verified' : 'unknown' } : {}) };
}
