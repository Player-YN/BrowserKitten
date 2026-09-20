import { contextWindowCacheKey } from '../agent/contextWindowStore.js';

const AUTO_CHECK_KEY = 'browserbot_context_window_auto_check';

export function matchesContextWindowConfig({ provider, providerId, base, model, apiKey }) {
  if (!provider || provider.id !== providerId) return false;
  if (contextWindowCacheKey(base, model) !== contextWindowCacheKey(provider.baseURL, provider.model)) return false;
  if (apiKey && apiKey !== provider.apiKey) return false;
  return true;
}

export function contextWindowStatusLabel(status) {
  if (status?.checking) return 'contextWindowChecking';
  if (status?.source === 'user') return 'contextWindowUser';
  if (status?.source === 'measured') return 'contextWindowMeasured';
  if (status?.source === 'catalog') return 'contextWindowCatalog';
  if (status?.source === 'family') return 'contextWindowFamily';
  return 'contextWindowUnknown';
}

export function contextWindowCheckErrorLabel(kind) {
  if (kind === 'HTTP_401' || kind === 'HTTP_403') return 'contextWindowCheckAuth';
  if (kind === 'HTTP_429') return 'contextWindowCheckRateLimit';
  if (kind === 'CHECK_TIMEOUT' || kind === 'FIRST_BYTE_TIMEOUT') return 'contextWindowCheckTimeout';
  if (kind === 'CHECK_INTERRUPTED') return 'contextWindowCheckDeferred';
  if (kind === 'STREAM_STARTED' || kind === 'HTTP_404' || kind === 'HTTP_405' || kind === 'HTTP_5xx') {
    return 'contextWindowCheckUnavailable';
  }
  return kind ? 'contextWindowCheckUnavailable' : '';
}

function formatWindow(n) {
  const value = Number(n);
  return Number.isFinite(value) && value >= 2048 ? value.toLocaleString() : '';
}

/** Local status for the saved connection. Catalog windows never start a chat probe. */
export function createContextWindowSettings({
  root = document,
  t,
  workspaceRpc,
  loadProvidersState,
  getProviderId,
  storage = globalThis.chrome?.storage,
  schedule = setTimeout,
  unschedule = clearTimeout
}) {
  let timer = null;
  let revision = 0;
  let automatic = true;
  const visible = () => !!root.getElementById('agentSettingsModal')?.open && root.visibilityState !== 'hidden';
  const stop = () => { revision += 1; if (timer != null) unschedule(timer); timer = null; };
  const poll = () => { if (timer != null) unschedule(timer); if (visible()) timer = schedule(() => { timer = null; void refresh(); }, 2000); };
  const el = (id) => root.getElementById(id);

  async function matchesSaved() {
    const state = await loadProvidersState();
    const provider = state.providers?.find((p) => p.id === state.activeProviderId);
    if (!provider) return null;
    if (el('inferenceEditor')?.hidden) return provider;
    return matchesContextWindowConfig({
      provider,
      providerId: getProviderId(),
      base: el('apiBaseInput')?.value,
      model: el('providerModelInput')?.value,
      apiKey: el('apiKeyInput')?.value?.trim()
    }) ? provider : null;
  }

  function message(key, extra = '') {
    const status = el('contextWindowStatus');
    if (status) status.textContent = extra ? `${t(key)} · ${extra}` : t(key);
    if (el('contextWindowRecheck')) el('contextWindowRecheck').disabled = true;
  }

  async function refresh({ start = false, force = false } = {}) {
    if (!visible() || !workspaceRpc || !loadProvidersState) return;
    const ownRevision = ++revision;
    try {
      const provider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!provider) { message('contextWindowSaveFirst'); return; }
      if (start) await workspaceRpc('requestContextWindowCheck', { force });
      const status = await workspaceRpc('getContextWindowStatus', {});
      const latestProvider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!latestProvider) { message('contextWindowSaveFirst'); return; }
      if (provider.id !== latestProvider.id || provider.apiKey !== latestProvider.apiKey ||
          contextWindowCacheKey(provider.baseURL, provider.model) !==
            contextWindowCacheKey(latestProvider.baseURL, latestProvider.model)) {
        message('contextWindowUnknown');
        void refresh();
        return;
      }
      if (status.providerId !== provider.id ||
          contextWindowCacheKey(status.base, status.model) !== contextWindowCacheKey(provider.baseURL, provider.model)) {
        message('contextWindowSaveFirst');
        return;
      }
      automatic = status.autoCheck !== false;
      if (el('contextWindowAutoCheck')) el('contextWindowAutoCheck').checked = automatic;
      const shown = formatWindow(status.window || status.catalogWindow);
      const label = t(contextWindowStatusLabel(status)).replace('{n}', shown || '—');
      let line = `${provider.model} · ${label}`;
      const err = !status.checking && !status.window && status.evidence?.kind
        ? t(contextWindowCheckErrorLabel(status.evidence.kind))
        : '';
      if (err) line += `（${err}）`;
      if (el('contextWindowStatus')) el('contextWindowStatus').textContent = line;
      if (el('contextWindowRecheck')) {
        el('contextWindowRecheck').disabled = !!status.checking || status.source === 'catalog' || status.source === 'user';
      }
      if (status.checking) poll();
    } catch {
      if (ownRevision === revision && visible()) {
        message('contextWindowUnavailable');
        if (el('contextWindowRecheck')) el('contextWindowRecheck').disabled = false;
      }
    }
  }

  function mount() {
    const panel = el('contextWindowStatusPanel');
    if (!panel) return;
    panel.replaceChildren();
    const title = root.createElement('p');
    title.className = 'settings-label';
    title.textContent = t('contextWindowTitle');
    title.title = t('contextWindowCost');
    const status = root.createElement('p');
    status.id = 'contextWindowStatus';
    status.className = 'settings-hint';
    status.setAttribute('aria-live', 'polite');
    const recheck = root.createElement('button');
    recheck.type = 'button';
    recheck.id = 'contextWindowRecheck';
    recheck.className = 'btn btn-secondary settings-mini-btn';
    recheck.textContent = t('contextWindowRecheck');
    recheck.title = t('contextWindowCost');
    recheck.disabled = true;
    recheck.addEventListener('click', () => {
      recheck.disabled = true;
      void refresh({ start: true, force: true });
    });
    const autoLabel = root.createElement('label');
    autoLabel.className = 'settings-check-row';
    autoLabel.title = t('contextWindowCost');
    const auto = root.createElement('input');
    auto.type = 'checkbox';
    auto.id = 'contextWindowAutoCheck';
    auto.checked = automatic;
    auto.title = t('contextWindowCost');
    const copy = root.createElement('span');
    copy.textContent = t('contextWindowAutoCheck');
    autoLabel.append(auto, copy);
    auto.addEventListener('change', () => {
      const enabled = auto.checked;
      auto.disabled = true;
      storage?.local?.set({ [AUTO_CHECK_KEY]: enabled }, () => {
        auto.disabled = false;
        if (globalThis.chrome?.runtime?.lastError) {
          auto.checked = automatic;
          message('contextWindowUnavailable');
          return;
        }
        automatic = enabled;
        void refresh({ start: enabled });
      });
    });
    panel.append(title, status, recheck, autoLabel);
    storage?.local?.get([AUTO_CHECK_KEY], (data) => {
      automatic = data?.[AUTO_CHECK_KEY] !== false;
      auto.checked = automatic;
    });
  }

  for (const id of ['apiBaseInput', 'providerModelInput', 'apiKeyInput']) {
    root.getElementById(id)?.addEventListener('input', () => {
      stop();
      message('contextWindowUnknown');
      void refresh();
    });
  }
  root.getElementById('agentSettingsModal')?.addEventListener('close', stop);
  root.addEventListener('visibilitychange', () => { if (!visible()) stop(); else void refresh(); });
  storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && visible() && Object.keys(changes).some((k) =>
      k === 'browserbot_providers' || k === 'browserbot_active_provider_id' || k === AUTO_CHECK_KEY ||
      k === 'browserbot_context_window_evidence_v1' || k === 'browserbot_model_catalog_cache')) {
      void refresh();
    }
  });

  return {
    load() { mount(); void refresh(); },
    open() { void refresh({ start: true }); },
    sync() { stop(); message('contextWindowUnknown'); void refresh(); }
  };
}
