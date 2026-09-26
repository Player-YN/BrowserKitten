/**
 * Page scripts (chrome.userScripts): an optional permission the user grants by click,
 * plus, on Chrome 138+, the per-extension "Allow User Scripts" toggle that only the
 * user can flip on the extension's details page. Shared by the side panel and the
 * welcome page; this only reports state and asks.
 */

/** @returns {Promise<'off'|'needs-toggle'|'on'>} */
export async function pageScriptsState() {
  const granted = await chrome.permissions.contains({ permissions: ['userScripts'] }).catch(() => false);
  if (!granted) return 'off';
  try {
    await chrome.userScripts.getScripts();
    return 'on';
  } catch {
    return 'needs-toggle';
  }
}

/** Call synchronously inside a click handler so Chrome sees the user gesture. */
export function requestPageScripts() {
  return chrome.permissions.request({ permissions: ['userScripts'] }).catch(() => false);
}

/** The details page with the "Allow User Scripts" toggle. */
export function openExtensionDetails() {
  return chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}`, active: true });
}

/** A tool result that failed because page scripts are off, however the guest surfaced it. */
export function isPageScriptsOffError(result) {
  if (!result) return false;
  let text = '';
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  return /PERMISSION_REQUIRED[\s\S]{0,200}userScripts|userScripts[\s\S]{0,200}PERMISSION_REQUIRED|userScripts is off/.test(text);
}
