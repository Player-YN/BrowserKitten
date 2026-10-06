/**
 * Which guest sys.cdp commands can run script in the page.
 *
 * Those commands get the same opt-in as sys.eval: the optional userScripts permission,
 * granted and usable. Without it the host refuses them with PERMISSION_REQUIRED, so
 * "page scripts need the user's opt-in" stays true when the debugger pipe is open.
 *
 * Allowlist, not denylist. CDP has hundreds of methods and new ones ship with Chrome;
 * many reach script indirectly (breakpoint conditions, rewritten responses, HTML with
 * event handlers, child-target sessions). A denylist would quietly let the next one
 * through. So a method passes without userScripts only if its domain is listed below
 * as observation / trusted input, and it is not one of the listed script-capable
 * exceptions inside those domains. Everything else (Runtime, Debugger, Fetch,
 * unknown domains) is treated as script.
 *
 * Only guest-originated sys.cdp sends go through this. The host's own debugger calls
 * (pointer clicks, layout metrics, CDP upload, the attach-reclaim probe) never do.
 */

const NON_SCRIPT_DOMAINS = new Set([
  'Accessibility',
  'Audits',
  'CSS',
  'CacheStorage',
  'DOM',
  'DOMSnapshot',
  'DOMStorage',
  'Emulation',
  'IO',
  'IndexedDB',
  'Input',
  'LayerTree',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Security',
  'Storage',
  'Target'
]);

/** Runtime calls that read or tidy state and run no page code. */
const NON_SCRIPT_RUNTIME = new Set([
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Runtime.getHeapUsage',
  'Runtime.getIsolateId',
  'Runtime.discardConsoleEntries'
]);

/** Inside an allowed domain, these run or plant script whatever their params. */
const SCRIPT_METHODS = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad',
  'Page.createIsolatedWorld',
  'Page.setDocumentContent',
  'Page.setBypassCSP',
  'DOM.setOuterHTML',
  'Network.setRequestInterception',
  'Network.continueInterceptedRequest',
  'Target.attachToTarget',
  'Target.attachToBrowserTarget',
  'Target.setAutoAttach',
  'Target.sendMessageToTarget',
  'Target.exposeDevToolsProtocol'
]);

const HANDLER_ATTRIBUTE = /^\s*(on[a-z]|srcdoc\b)/i;
const SCRIPT_TEXT = /(^|[\s"'/])(on[a-z]+|srcdoc)\s*=|javascript\s*:/i;

/**
 * @param {string} method CDP method, e.g. "Runtime.evaluate"
 * @param {object} [params] CDP params as the guest sent them
 * @returns {boolean} true when the command needs the userScripts opt-in
 */
export function cdpCommandRunsScript(method, params) {
  const name = String(method || '');
  const p = params && typeof params === 'object' ? params : {};
  const domain = name.split('.')[0];
  if (domain === 'Runtime') return !NON_SCRIPT_RUNTIME.has(name);
  if (!NON_SCRIPT_DOMAINS.has(domain)) return true;
  if (SCRIPT_METHODS.has(name)) return true;
  if (name === 'Page.navigate' || name === 'Target.createTarget') return !isPlainPageUrl(p.url);
  if (name === 'DOM.setAttributeValue') {
    return HANDLER_ATTRIBUTE.test(String(p.name || '')) || /javascript\s*:/i.test(stripControls(p.value));
  }
  if (name === 'DOM.setAttributesAsText') {
    return HANDLER_ATTRIBUTE.test(String(p.name || '')) || SCRIPT_TEXT.test(stripControls(p.text));
  }
  return false;
}

/** http(s) and about:blank only; javascript:, data:, blob: and the rest count as script. */
function isPlainPageUrl(url) {
  const s = stripControls(url).trim();
  if (s === 'about:blank') return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripControls(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '');
}
