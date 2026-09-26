import { loadLlmSettings } from './llm.js';
import { byokAllowedForProvider } from './byokGate.js';
import { loadCachedModelsForBase } from './modelCatalog.js';
import { resolveChatMediaCapabilities } from './chatMedia.js';
import { MEDIA_AUTO_KEY, MEDIA_CACHE_KEY, mediaStorageGet, mediaStorageSet, mediaConnectionKey, evidenceDue } from './mediaCapabilityStore.js';
import { createMediaCheckSample, scoreMediaCheck } from './mediaCheckSamples.js';
import { classifyMediaRejection } from './mediaRejection.js';

const FORMATS = { image: 'image/jpeg', audio: 'audio/wav', video: 'video/webm' };
const OFFICIAL_IMAGE_HOSTS = ['api.openai.com', 'api.deepseek.com', 'generativelanguage.googleapis.com'];

export function checkTransport(caps, kind) {
  // Automatic calibration requires an identified profile, including for image samples.
  // Official Chat Completions hosts accept standard image_url without a media-wire profile.
  if (kind === 'image') {
    if (['openai-audio', 'openrouter'].includes(caps.transport)) return true;
    try { return OFFICIAL_IMAGE_HOSTS.includes(new URL(caps.base).hostname); }
    catch { return false; }
  }
  return (kind === 'audio' && ['openai-audio', 'openrouter'].includes(caps.transport)) ||
    (kind === 'video' && caps.transport === 'openrouter');
}

export async function runMediaCheck({ settings, caps, kind, signal, sampleFactory = createMediaCheckSample }) {
  let sample;
  try { sample = await sampleFactory(kind, signal); }
  catch (error) { throw Object.assign(new Error('SAMPLE_UNAVAILABLE'), { code: 'SAMPLE_UNAVAILABLE' }); }
  signal.throwIfAborted();
  const { createBrowserBotLanguageModel } = await import('./provider.js');
  const trialCaps = structuredClone(caps);
  trialCaps.inputs[kind] = { state: 'supported', source: 'check-only' };
  const built = await createBrowserBotLanguageModel({ settings, mediaCapabilities: trialCaps, noRetry: true });
  // doGenerate is a single SDK transport call, without generateText/ToolLoopAgent retries.
  const result = await built.model.doGenerate({
    abortSignal: signal, maxOutputTokens: 1024,
    prompt: [
      { role: 'user', content: [{ type: 'text', text: sample.prompt }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'media-check', toolName: 'acquire', input: { action: 'fetch' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'media-check', toolName: 'acquire',
        output: { type: 'content', value: [{ type: 'text', text: '{"source":"synthetic capability sample"}' }, sample.part] } }] }
    ]
  });
  return scoreMediaCheck(kind, sample, (result.content || []).filter(p => p.type === 'text').map(p => p.text).join(''));
}

/** One manager per offscreen runtime. Ordinary sends only call context(), never request(). */
export class MediaCapabilityChecks {
  constructor({ getSettings = loadLlmSettings, getModels = loadCachedModelsForBase,
    get = mediaStorageGet, set = mediaStorageSet, run = runMediaCheck, now = Date.now,
    timeoutMs = 20000, byokAllowed = byokAllowedForProvider } = {}) {
    Object.assign(this, { getSettings, getModels, get, set, run, now, timeoutMs, byokAllowed });
    this.tail = Promise.resolve(); this.writes = Promise.resolve(); this.job = null; this.sequence = 0;
  }
  async identify(settings, models) {
    const caps = resolveChatMediaCapabilities(settings, models);
    return { caps, key: await mediaConnectionKey(settings, caps) };
  }
  async read(settings, models) {
    const { key } = await this.identify(settings, models);
    const saved = await this.get([MEDIA_CACHE_KEY]);
    const evidence = saved[MEDIA_CACHE_KEY]?.[key] || {};
    return { key, evidence, caps: resolveChatMediaCapabilities(settings, models, evidence, this.now()) };
  }
  async update(key, kind, record) {
    const write = this.writes.then(async () => {
      const data = await this.get([MEDIA_CACHE_KEY]);
      const cache = data[MEDIA_CACHE_KEY] || {};
      const previous = cache[key]?.[kind];
      if (record.state !== 'supported') record = { ...record, previous: previous?.state === 'supported' ? previous : previous?.previous };
      const rejections = { ...previous?.rejections };
      for (const format of record.formats || []) {
        if (record.state === 'unsupported') rejections[format] = record.checkedAt;
        if (record.state === 'supported') delete rejections[format];
      }
      record = { ...record, rejections };
      cache[key] = { ...cache[key], [kind]: record };
      // Bounded metadata storage, preserving the connection being updated.
      const entries = Object.entries(cache).sort((a, b) => Math.max(...Object.values(b[1]).map(r => r.checkedAt || 0)) - Math.max(...Object.values(a[1]).map(r => r.checkedAt || 0)));
      await this.set({ [MEDIA_CACHE_KEY]: Object.fromEntries(entries.slice(0, 100)) });
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async status() {
    const settings = await this.getSettings();
    const models = (await this.getModels(settings.apiBase)).models || [];
    const result = await this.read(settings, models);
    const prefs = await this.get([MEDIA_AUTO_KEY]);
    return { providerId: settings.providerId, model: settings.model, base: result.caps.base,
      capabilities: result.caps, autoCheck: prefs[MEDIA_AUTO_KEY] !== false,
      checking: this.job?.key === result.key && !this.job.done ? this.job.kind || 'queued' : null };
  }
  async request({ force = false } = {}) {
    const seq = ++this.sequence;
    const settings = await this.getSettings();
    const models = (await this.getModels(settings.apiBase)).models || [];
    const { key, caps } = await this.read(settings, models);
    const prefs = await this.get([MEDIA_AUTO_KEY]);
    // A probe against the user's own key is BYOK use: skipped silently without a plan.
    const byokOk = !settings.apiKey || await this.byokAllowed('probe', settings.providerId);
    if (seq !== this.sequence) return { queued: false };
    if (!settings.apiKey || (!force && prefs[MEDIA_AUTO_KEY] === false)) {
      this.job?.controller.abort(); return { queued: false };
    }
    if (!byokOk) {
      this.job?.controller.abort(); return { queued: false, reason: 'BYOK_REQUIRES_PLAN' };
    }
    const configTag = JSON.stringify(settings.chatMediaOverrides || {});
    if (this.job?.key === key && this.job.configTag === configTag && !this.job.done && !this.job.controller.signal.aborted) return { queued: true };
    this.job?.controller.abort();
    const job = { key, configTag, controller: new AbortController(), done: false, kind: null };
    this.job = job;
    // Work begins outside the RPC response; all jobs share a single serial lane.
    job.promise = this.tail.then(() => this.perform(job, settings, models, caps, force))
      .catch(() => {}) // storage failures leave prior evidence intact; never break startup/settings
      .finally(() => { job.done = true; job.kind = null; });
    this.tail = job.promise;
    return { queued: true };
  }
  async stillCurrent(job) {
    if (job.controller.signal.aborted) return false;
    const settings = await this.getSettings();
    const models = (await this.getModels(settings.apiBase)).models || [];
    return (await this.identify(settings, models)).key === job.key &&
      JSON.stringify(settings.chatMediaOverrides || {}) === job.configTag;
  }
  async perform(job, settings, models, caps, force) {
    for (const kind of Object.keys(FORMATS)) {
      if (!(await this.stillCurrent(job))) return;
      const latestModels = (await this.getModels(settings.apiBase)).models || models;
      const { evidence, caps: fresh } = await this.read(settings, latestModels);
      if (!checkTransport(caps, kind) || fresh.inputs[kind].source === 'user') continue;
      if (!force && !evidenceDue(evidence[kind], this.now())) continue;
      if (!force && ['catalog', 'builtin'].includes(fresh.inputs[kind].source) && evidence[kind]?.state !== 'unsupported') continue;
      job.kind = kind;
      // Persist before dispatch: a crashed offscreen must not repeatedly charge on boot.
      await this.update(job.key, kind, { state: 'unknown', error: 'CHECK_INTERRUPTED', checkedAt: this.now(), formats: [FORMATS[kind]] });
      const controller = new AbortController();
      const abort = () => controller.abort(job.controller.signal.reason);
      job.controller.signal.addEventListener('abort', abort, { once: true });
      if (job.controller.signal.aborted) abort();
      let result, stop = false, timer;
      try {
        controller.signal.throwIfAborted();
        const work = this.run({ settings, caps: fresh, kind, signal: controller.signal });
        const timed = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('CHECK_TIMEOUT')); }, this.timeoutMs);
        });
        result = await Promise.race([work, timed]);
      } catch (error) {
        const status = error?.statusCode || error?.status;
        const rejected = classifyMediaRejection(status, error?.responseBody || error?.message, [FORMATS[kind]]);
        stop = (!status && error?.code !== 'SAMPLE_UNAVAILABLE') || status === 401 || status === 403 || status === 429 || status >= 500;
        result = { state: rejected ? 'unsupported' : 'unknown', error: rejected ? 'FORMAT_REJECTED' :
          status ? `HTTP_${status}` : controller.signal.aborted ? 'CHECK_TIMEOUT' : 'CHECK_UNAVAILABLE' };
      } finally {
        clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort);
      }
      if (!(await this.stillCurrent(job))) return;
      await this.update(job.key, kind, { ...result, checkedAt: this.now(), formats: [FORMATS[kind]] });
      if (stop) {
        // Cool down the rest of the batch as well, so restart does not retry a bad credential.
        for (const remaining of Object.keys(FORMATS).slice(Object.keys(FORMATS).indexOf(kind) + 1)) {
          await this.update(job.key, remaining, { state: 'unknown', error: 'CHECK_DEFERRED', checkedAt: this.now(), formats: [FORMATS[remaining]] });
        }
        break;
      }
    }
  }
  async context(settings, models) {
    let first;
    try { first = await this.read(settings, models); }
    catch { first = await this.identify(settings, models); }
    const manager = this;
    let current = first.caps;
    return {
      get current() { return current; },
      async refresh() {
        try {
          const latest = (await manager.getModels(settings.apiBase)).models;
          current = (await manager.read(settings, Array.isArray(latest) && latest.length ? latest : models)).caps;
        } catch { /* retain the last snapshot if storage is temporarily unavailable */ }
        return current;
      },
      async wait(kind, signal) {
        const job = manager.job;
        if (current.inputs[kind]?.state !== 'unknown' || !job || job.key !== first.key || job.done || job.kind !== kind) return current;
        let timer, cancel;
        try {
          await Promise.race([job.promise, new Promise(resolve => {
            timer = setTimeout(resolve, 2000); cancel = resolve;
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) resolve();
          })]);
        } finally { clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
        return this.refresh();
      },
      async reject(mime) {
        await manager.update(first.key, mime.split('/')[0], { state: 'unsupported', error: 'FORMAT_REJECTED', formats: [mime], checkedAt: manager.now() });
      }
    };
  }
}
