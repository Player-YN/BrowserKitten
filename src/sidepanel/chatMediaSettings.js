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

export function mediaCompactMark(state) {
  if (state === 'checking') return '…';
  if (state === 'unsupported') return '✗';
  if (state === 'supported') return '✓';
  return '?';
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
  storage = globalThis.chrome?.storage, schedule = setTimeout, unschedule = clearTimeout, onOverridesChange }) {
  let overrides = {};
  let timer = null, revision = 0;
  let automatic = true;
  let busyListener = null;
  const fields = ['image', 'audio', 'video', 'transport'];
  const visible = () => {
    if (!root.getElementById('agentSettingsModal')?.open || root.visibilityState === 'hidden') return false;
    const host = root.getElementById('inferenceDiagnostics');
    return !(host && host.hidden);
  };
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
  function setBusy(busy) {
    if (typeof busyListener === 'function') busyListener(!!busy);
  }
  function paint(title, icons = [], state = 'unknown') {
    const status = el('chatMediaStatus');
    if (!status) return;
    status.replaceChildren();
    status.className = 'capability-status is-compact';
    status.title = title || '';
    setData(status, 'state', state);
    status.setAttribute('aria-label', title || '');
    if (!icons.length) {
      const text = root.createElement('span');
      text.className = 'capability-compact';
      text.textContent = title || '';
      status.append(text);
      return;
    }
    icons.forEach((icon, index) => {
      if (index) {
        const sep = root.createElement('span');
        sep.className = 'capability-compact-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '/';
        status.append(sep);
      }
      const node = root.createElement('span');
      node.className = `capability-icon is-${icon.state}`;
      setData(node, 'kind', icon.kind);
      setData(node, 'state', icon.state);
      node.title = icon.title;
      node.setAttribute('aria-label', icon.title);
      const mark = root.createElement('span');
      mark.className = 'capability-compact';
      mark.textContent = `${t(`chatMediaShort_${icon.kind}`)} ${mediaCompactMark(icon.state)}`;
      mark.title = icon.title;
      status.append(node, mark);
    });
  }
  function message(key) {
    paint(t(key));
    setBusy(false);
  }
  async function refresh({ start = false, force = false } = {}) {
    if (!visible() || !workspaceRpc || !loadProvidersState) return;
    const ownRevision = ++revision;
    try {
      const provider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!provider) { message('chatMediaSaveFirst'); return; }
      if (start) {
        setBusy(true);
        await workspaceRpc('requestChatMediaCheck', { force });
      }
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
      setBusy(!!status.checking);
      if (status.checking) poll();
    } catch {
      if (ownRevision === revision && visible()) {
        message('chatMediaUnavailable');
        setBusy(false);
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
      const status = root.createElement('div');
      status.id = 'chatMediaStatus';
      status.className = 'capability-status is-compact';
      status.setAttribute('aria-live', 'polite');
      panel.append(status);
    }
    const autoHost = el('inferenceAutoCheckHost');
    if (autoHost) {
      el('chatMediaAutoCheck')?.closest?.('label')?.remove();
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
      autoHost.append(autoLabel);
      storage?.local?.get([AUTO_CHECK_KEY], data => { automatic = data?.[AUTO_CHECK_KEY] !== false; auto.checked = automatic; });
    }
    const host = root.getElementById('chatMediaSettings');
    if (!host) return;
    host.replaceChildren();
    if (String(host.tagName || '').toUpperCase() === 'DETAILS') {
      const summary = root.createElement('summary');
      summary.textContent = t('chatMediaAdvanced');
      summary.title = t('chatMediaHint');
      host.append(summary);
    } else {
      const heading = root.createElement('p');
      heading.className = 'settings-label';
      heading.textContent = t('chatMediaAdvanced');
      heading.title = t('chatMediaHint');
      host.append(heading);
    }
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
        if (typeof onOverridesChange === 'function') void onOverridesChange(normalizeMediaOverrides(overrides));
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
    probe(opts = {}) { return refresh({ start: true, force: opts.force !== false }); },
    setBusyListener(fn) { busyListener = typeof fn === 'function' ? fn : null; },
    sync,
    read() { return normalizeMediaOverrides(overrides); }
  };
}
