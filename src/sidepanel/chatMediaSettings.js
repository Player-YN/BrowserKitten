import { mediaModelKey, normalizeMediaOverrides } from '../agent/chatMedia.js';

/** Local editor draft. Every change is keyed by both base URL and exact model id. */
export function createChatMediaSettings({ root = document, t }) {
  let overrides = {};
  const fields = ['image', 'audio', 'video', 'transport'];
  const key = () => mediaModelKey(root.getElementById('apiBaseInput')?.value, root.getElementById('providerModelInput')?.value);
  const sync = () => {
    const value = overrides[key()] || {};
    for (const field of fields) {
      const el = root.getElementById(`chatMedia-${field}`);
      if (el) el.value = field === 'transport' ? (value[field] || 'auto') : typeof value[field] === 'boolean' ? String(value[field]) : 'auto';
    }
  };
  function mount() {
    const host = root.getElementById('chatMediaSettings');
    if (!host) return;
    host.replaceChildren();
    const summary = root.createElement('summary');
    summary.textContent = t('chatMediaTitle');
    host.append(summary);
    const hint = root.createElement('p');
    hint.className = 'settings-hint'; hint.textContent = t('chatMediaHint'); host.append(hint);
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
      });
      host.append(label, select);
    }
    sync();
  }
  for (const id of ['apiBaseInput', 'providerModelInput']) root.getElementById(id)?.addEventListener('input', sync);
  return {
    load(provider) { overrides = normalizeMediaOverrides(provider?.chatMediaOverrides); mount(); },
    sync,
    read() { return normalizeMediaOverrides(overrides); }
  };
}
