import { mediaModelKey, normalizeMediaOverrides } from '../agent/chatMedia.js';

const AUTO_CHECK_KEY = 'browserbot_chat_media_auto_check';

/** Never display an active connection's evidence as evidence for an unsaved draft. */
export function matchesChatMediaConfig({ provider, providerId, base, model, apiKey, overrides }) {
  if (!provider || provider.id !== providerId) return false;
  if (mediaModelKey(base, model) !== mediaModelKey(provider.baseURL, provider.model)) return false;
  if (apiKey && apiKey !== provider.apiKey) return false;
  const key = mediaModelKey(base, model);
  return JSON.stringify(normalizeMediaOverrides(overrides)[key] || {}) ===
    JSON.stringify(normalizeMediaOverrides(provider.chatMediaOverrides)[key] || {});
}

export function mediaStatusLabel(input, checking, kind) {
  if (checking === kind || checking === 'queued') return 'chatMediaChecking';
  if (input?.rejectedFormats?.length) return 'chatMediaRejected';
  if (input?.source === 'user') return input.state === 'supported' ? 'chatMediaUserYes' : 'chatMediaNo';
  if (input?.state === 'supported') return input.source === 'verified' ? (input.stale ? 'chatMediaVerifiedStale' : 'chatMediaVerified') : 'chatMediaDeclared';
  if (input?.state === 'unsupported') return 'chatMediaNo';
  return 'chatMediaUnknown';
}

export function mediaIconState(label) {
  if (label === 'chatMediaChecking') return 'checking';
  if (label === 'chatMediaUnknown') return 'unknown';
  if (label === 'chatMediaNo' || label === 'chatMediaRejected') return 'unsupported';
  return 'supported';
}

export function mediaCheckErrorLabel(error) {
  if (error === 'ANSWER_MISMATCH') return 'chatMediaCheckAnswerMismatch';
  if (error === 'HTTP_401' || error === 'HTTP_403') return 'chatMediaCheckAuth';
  if (error === 'HTTP_429') return 'chatMediaCheckRateLimit';
  if (error === 'CHECK_TIMEOUT') return 'chatMediaCheckTimeout';
  if (error === 'CHECK_INTERRUPTED' || error === 'CHECK_DEFERRED') return 'chatMediaCheckDeferred';
  return 'chatMediaCheckUnavailable';
}

/** Local editor draft. Every change is keyed by both base URL and exact model id. */
export function createChatMediaSettings({ root = document, t, workspaceRpc, loadProvidersState, getProviderId,
  storage = globalThis.chrome?.storage, schedule = setTimeout, unschedule = clearTimeout }) {
  let overrides = {};
  let timer = null, revision = 0;
  let automatic = true;
  const fields = ['image', 'audio', 'video', 'transport'];
  const visible = () => !!root.getElementById('agentSettingsModal')?.open && root.visibilityState !== 'hidden';
  const stop = () => { revision += 1; if (timer != null) unschedule(timer); timer = null; };
  const poll = () => { if (timer != null) unschedule(timer); if (visible()) timer = schedule(() => { timer = null; void refresh(); }, 2000); };
  const el = (id) => root.getElementById(id);
  async function matchesSaved() {
    const state = await loadProvidersState();
    const provider = state.providers?.find((p) => p.id === state.activeProviderId);
    if (!provider) return null;
    if (el('inferenceEditor')?.hidden) return provider;
    return matchesChatMediaConfig({ provider, providerId: getProviderId(),
      base: el('apiBaseInput')?.value, model: el('providerModelInput')?.value,
      apiKey: el('apiKeyInput')?.value?.trim(), overrides }) ? provider : null;
  }
  function setData(node, key, value) {
    if (!node) return;
    // HTMLElement.dataset is a getter-only DOMStringMap — never assign the object.
    if (node.dataset) node.dataset[key] = value;
    else node.setAttribute?.(`data-${key}`, value);
  }
  function paint(title, icons = [], state = 'unknown') {
    const status = el('chatMediaStatus');
    if (!status) return;
    status.replaceChildren();
    status.className = 'capability-status';
    status.title = title || '';
    setData(status, 'state', state);
    status.setAttribute('aria-label', title || '');
    for (const icon of icons) {
      const node = root.createElement('span');
      node.className = `capability-icon is-${icon.state}`;
      setData(node, 'kind', icon.kind);
      setData(node, 'state', icon.state);
      node.title = icon.title;
      node.setAttribute('aria-label', icon.title);
      status.append(node);
    }
  }
  function message(key) {
    paint(t(key));
    if (el('chatMediaRecheck')) el('chatMediaRecheck').disabled = true;
  }
  async function refresh({ start = false, force = false } = {}) {
    if (!visible() || !workspaceRpc || !loadProvidersState) return;
    const ownRevision = ++revision;
    try {
      const provider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!provider) { message('chatMediaSaveFirst'); return; }
      if (start) await workspaceRpc('requestChatMediaCheck', { force });
      const status = await workspaceRpc('getChatMediaStatus', {});
      const latestProvider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!latestProvider) { message('chatMediaSaveFirst'); return; }
      // A saved key can change while the RPC is in flight without changing model/base.
      if (provider.id !== latestProvider.id || provider.apiKey !== latestProvider.apiKey ||
          mediaModelKey(provider.baseURL, provider.model) !== mediaModelKey(latestProvider.baseURL, latestProvider.model) ||
          !matchesChatMediaConfig({ provider: latestProvider, providerId: provider.id, base: provider.baseURL,
            model: provider.model, apiKey: provider.apiKey, overrides: provider.chatMediaOverrides })) {
        message('chatMediaUnknown'); void refresh(); return;
      }
      if (status.providerId !== provider.id || mediaModelKey(status.base, status.model) !== mediaModelKey(provider.baseURL, provider.model)) {
        message('chatMediaSaveFirst'); return;
      }
      automatic = status.autoCheck !== false;
      if (el('chatMediaAutoCheck')) el('chatMediaAutoCheck').checked = automatic;
      const caps = status.capabilities || {};
      const icons = ['image', 'audio', 'video'].map((kind) => {
        const input = caps.inputs?.[kind];
        const label = mediaStatusLabel(input, status.checking, kind);
        const parts = [t(`chatMedia_${kind}`), t(label)];
        if (!status.checking && input?.lastCheck?.state === 'unknown' && input.lastCheck.error) {
          parts.push(t(mediaCheckErrorLabel(input.lastCheck.error)));
        }
        if ((kind === 'audio' || kind === 'video') && caps.transport === 'none') parts.push(t('chatMediaNeedProtocol'));
        if (kind === 'video' && input?.state === 'supported' && caps.videoAudio !== 'verified') {
          parts.push(t('chatMediaVideoAudioUnknown'));
        }
        return { kind, state: mediaIconState(label), title: parts.join(' · ') };
      });
      paint(icons.map((icon) => icon.title).join('\n'), icons, status.checking ? 'checking' : icons[0]?.state || 'unknown');
      if (el('chatMediaRecheck')) el('chatMediaRecheck').disabled = !!status.checking;
      if (status.checking) poll();
    } catch {
      if (ownRevision === revision && visible()) {
        message('chatMediaUnavailable');
        if (el('chatMediaRecheck')) el('chatMediaRecheck').disabled = false;
      }
    }
  }
  const key = () => mediaModelKey(root.getElementById('apiBaseInput')?.value, root.getElementById('providerModelInput')?.value);
  const sync = () => {
    const value = overrides[key()] || {};
    for (const field of fields) {
      const el = root.getElementById(`chatMedia-${field}`);
      if (el) el.value = field === 'transport' ? (value[field] || 'auto') : typeof value[field] === 'boolean' ? String(value[field]) : 'auto';
    }
    stop();
    message('chatMediaUnknown');
    void refresh();
  };
  function mount() {
    const panel = el('chatMediaStatusPanel');
    if (panel) {
      panel.replaceChildren();
      const title = root.createElement('p'); title.className = 'settings-label'; title.textContent = t('chatMediaTitle');
      title.title = t('chatMediaHint');
      const status = root.createElement('div');
      status.id = 'chatMediaStatus';
      status.className = 'capability-status';
      status.setAttribute('aria-live', 'polite');
      const recheck = root.createElement('button'); recheck.type = 'button'; recheck.id = 'chatMediaRecheck';
      recheck.className = 'btn btn-secondary settings-mini-btn'; recheck.textContent = t('chatMediaRecheck'); recheck.disabled = true;
      recheck.title = t('chatMediaHint');
      recheck.addEventListener('click', () => { recheck.disabled = true; void refresh({ start: true, force: true }); });
      const autoLabel = root.createElement('label'); autoLabel.className = 'settings-check-row';
      autoLabel.title = t('chatMediaCost');
      const auto = root.createElement('input'); auto.type = 'checkbox'; auto.id = 'chatMediaAutoCheck'; auto.checked = automatic;
      auto.title = t('chatMediaCost');
      const copy = root.createElement('span'); copy.textContent = t('chatMediaAutoCheck'); autoLabel.append(auto, copy);
      auto.addEventListener('change', () => {
        const enabled = auto.checked; auto.disabled = true;
        storage?.local?.set({ [AUTO_CHECK_KEY]: enabled }, () => {
          auto.disabled = false;
          if (globalThis.chrome?.runtime?.lastError) { auto.checked = automatic; message('chatMediaUnavailable'); return; }
          automatic = enabled;
          void refresh({ start: enabled });
        });
      });
      panel.append(title, status, recheck, autoLabel);
      storage?.local?.get([AUTO_CHECK_KEY], data => { automatic = data?.[AUTO_CHECK_KEY] !== false; auto.checked = automatic; });
    }
    const host = root.getElementById('chatMediaSettings');
    if (!host) return;
    host.replaceChildren();
    const summary = root.createElement('summary');
    summary.textContent = t('chatMediaAdvanced');
    summary.title = t('chatMediaHint');
    host.append(summary);
    for (const field of fields) {
      const label = root.createElement('label');
      label.className = 'settings-label'; label.htmlFor = `chatMedia-${field}`;
      label.textContent = t(`chatMedia_${field}`);
      const select = root.createElement('select');
      select.id = label.htmlFor; select.className = 'modal-input';
      const options = field === 'transport'
        ? [['auto', t('chatMediaAuto')], ['openai-audio', 'OpenAI / Gemini (input_audio)'], ['openrouter', 'OpenRouter (input_audio + video_url)']]
        : [['auto', t('chatMediaAuto')], ['true', t('chatMediaYes')], ['false', t('chatMediaNo')]];
      for (const [value, text] of options) {
        const option = root.createElement('option'); option.value = value; option.textContent = text; select.append(option);
      }
      select.addEventListener('change', () => {
        const value = { ...(overrides[key()] || {}) };
        if (select.value === 'auto') delete value[field];
        else value[field] = field === 'transport' ? select.value : select.value === 'true';
        overrides[key()] = value;
        stop();
        void refresh();
      });
      host.append(label, select);
    }
    sync();
  }
  for (const id of ['apiBaseInput', 'providerModelInput', 'apiKeyInput']) root.getElementById(id)?.addEventListener('input', sync);
  root.getElementById('agentSettingsModal')?.addEventListener('close', stop);
  root.addEventListener('visibilitychange', () => { if (!visible()) stop(); else void refresh(); });
  storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && visible() && Object.keys(changes).some(k => k === 'browserbot_providers' || k === 'browserbot_active_provider_id' || k === AUTO_CHECK_KEY || k.startsWith('browserbot_chat_media_evidence'))) void refresh();
  });
  return {
    load(provider) { overrides = normalizeMediaOverrides(provider?.chatMediaOverrides); mount(); },
    open() { void refresh({ start: true }); },
    sync,
    read() { return normalizeMediaOverrides(overrides); }
  };
}
