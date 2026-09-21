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
  return 'contextWindowUnknown';
}

/** Family guesses are compacting fallbacks, never a displayed measurement. */
export function contextWindowPresentable(status) {
  return !status?.checking && ['user', 'measured', 'catalog'].includes(status?.source);
}

export function contextWindowIconState(status) {
  if (status?.checking) return 'checking';
  if (status?.source === 'measured') return 'measured';
  if (status?.source === 'user' || status?.source === 'catalog') return 'supported';
  return 'unknown';
}

export function contextWindowDisplay(status) {
  const presentable = contextWindowPresentable(status);
  const raw = presentable ? Number(status.window || status.catalogWindow) : NaN;
  return {
    state: contextWindowIconState(status),
    label: contextWindowStatusLabel(status),
    window: Number.isFinite(raw) && raw >= 2048 ? Math.round(raw) : null
  };
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

/** Compact card text: 256k, not a token-usage count. */
export function formatWindowCompact(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 2048) return '';
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    const text = Number.isInteger(m) ? String(m) : String(Math.round(m * 10) / 10);
    return `${text}M`;
  }
  return `${Math.round(value / 1000)}k`;
}

export function contextWindowCompactLabel(status, t) {
  if (status?.checking) return t('contextWindowChecking');
  const view = contextWindowDisplay(status);
  const shown = formatWindowCompact(view.window);
  if (!shown) return t('contextWindowShortUnknown');
  if (status?.source === 'measured') return t('contextWindowShortMeasured').replace('{n}', shown);
  if (status?.source === 'user') return t('contextWindowShortUser').replace('{n}', shown);
  if (status?.source === 'catalog') return t('contextWindowShortCatalog').replace('{n}', shown);
  return t('contextWindowShortUnknown');
}

export function contextWindowSourceHint(status) {
  if (status?.checking) return 'contextWindowCost';
  if (status?.source === 'measured') return 'contextWindowHintMeasured';
  if (status?.source === 'catalog') return 'contextWindowHintCatalog';
  if (status?.source === 'user') return 'contextWindowHintUser';
  return 'contextWindowHintUnknown';
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
  let busyListener = null;
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
    return matchesContextWindowConfig({
      provider,
      providerId: getProviderId(),
      base: el('apiBaseInput')?.value,
      model: el('providerModelInput')?.value,
      apiKey: el('apiKeyInput')?.value?.trim()
    }) ? provider : null;
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
  function paint(title, state = 'unknown', compact = '') {
    const status = el('contextWindowStatus');
    if (!status) return;
    status.replaceChildren();
    status.className = 'capability-status is-compact';
    status.title = title || '';
    setData(status, 'state', state);
    status.setAttribute('aria-label', title || '');
    const icon = root.createElement('span');
    icon.className = `capability-icon capability-window is-${state}`;
    setData(icon, 'kind', 'window');
    setData(icon, 'state', state);
    icon.title = title || '';
    icon.setAttribute('aria-label', title || '');
    const text = root.createElement('span');
    text.className = 'capability-compact';
    text.textContent = compact || title || '';
    text.title = title || '';
    status.append(icon, text);
  }
  function message(key, extra = '') {
    const title = extra ? `${t(key)} · ${extra}` : t(key);
    paint(title, 'unknown', title);
    setBusy(false);
  }

  async function refresh({ start = false, force = false } = {}) {
    if (!visible() || !workspaceRpc || !loadProvidersState) return;
    const ownRevision = ++revision;
    try {
      const provider = await matchesSaved();
      if (ownRevision !== revision || !visible()) return;
      if (!provider) { message('contextWindowSaveFirst'); return; }
      if (start) {
        setBusy(true);
        await workspaceRpc('requestContextWindowCheck', { force });
      }
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
      const view = contextWindowDisplay(status);
      const shown = formatWindow(view.window);
      const label = t(view.label).replace('{n}', shown || '—');
      const hint = t(contextWindowSourceHint(status));
      const err = !status.checking && !view.window && status.evidence?.kind
        ? t(contextWindowCheckErrorLabel(status.evidence.kind))
        : '';
      const title = err ? `${label} · ${err} · ${hint}` : `${label} · ${hint}`;
      paint(title, view.state, contextWindowCompactLabel(status, t));
      setBusy(!!status.checking);
      if (status.checking) poll();
    } catch {
      if (ownRevision === revision && visible()) {
        message('contextWindowUnavailable');
        setBusy(false);
      }
    }
  }

  function mount() {
    const panel = el('contextWindowStatusPanel');
    if (!panel) return;
    panel.replaceChildren();
    const status = root.createElement('div');
    status.id = 'contextWindowStatus';
    status.className = 'capability-status is-compact';
    status.setAttribute('aria-live', 'polite');
    panel.append(status);
    const autoHost = el('inferenceAutoCheckHost');
    if (autoHost) {
      el('contextWindowAutoCheck')?.closest?.('label')?.remove();
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
      autoHost.append(autoLabel);
      storage?.local?.get([AUTO_CHECK_KEY], (data) => {
        automatic = data?.[AUTO_CHECK_KEY] !== false;
        auto.checked = automatic;
      });
    }
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
    probe(opts = {}) { return refresh({ start: true, force: opts.force !== false }); },
    setBusyListener(fn) { busyListener = typeof fn === 'function' ? fn : null; },
    sync() { stop(); message('contextWindowUnknown'); void refresh(); }
  };
}
