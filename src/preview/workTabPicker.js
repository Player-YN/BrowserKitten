/**
 * 点选 on work tabs (Design / Slides / Site / Sheet / Docs).
 * Same message contract as the live-web content script picker.
 */

export function isPickerAction(action) {
  const a = String(action || '');
  return a === 'toggle_picker' || a === 'get_picker_state' || a === 'stop_picker';
}

/**
 * @param {object} msg
 * @param {Function} sendResponse
 * @param {{ getActive: () => boolean, setActive: (on: boolean) => void }} api
 * @returns {boolean} handled
 */
export function handleWorkTabPickerMessage(msg, sendResponse, api) {
  if (!isPickerAction(msg?.action)) return false;
  if (msg.action === 'toggle_picker') api.setActive(!api.getActive());
  else if (msg.action === 'stop_picker') api.setActive(false);
  sendResponse({ active: !!api.getActive() });
  return true;
}

export function reportPickerState(active) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ action: 'picker_state', active: !!active }).catch(() => {});
  } catch {
    /* ignore */
  }
}
