import { PARALLEL_USER_AGENT } from '../primitives/parallelSearch.js';

// Chrome strips User-Agent from fetch(). A session rule tags only our MCP calls.
const RULE_ID = 920001;
let ready;

export function ensureParallelSearchHeaders(sender) {
  const runtime = chrome.runtime;
  const allowed = ['src/offscreen/runtime.html', 'src/sidepanel.html'].map(path => runtime.getURL(path));
  let senderUrl;
  try { senderUrl = new URL(sender?.url); senderUrl.search = ''; senderUrl.hash = ''; } catch {}
  if (sender?.id !== runtime.id || !allowed.includes(senderUrl?.href)) {
    return Promise.resolve({ ok: false, code: 'AUTH_DENIED', error: 'Parallel header setup requires an extension runtime page' });
  }
  if (!ready) {
    ready = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: PARALLEL_USER_AGENT }] },
        condition: {
          regexFilter: '^https://search\\.parallel\\.ai/mcp$',
          initiatorDomains: [runtime.id],
          resourceTypes: ['xmlhttprequest']
        }
      }]
    }).then(() => ({ ok: true })).catch(error => {
      ready = null;
      return { ok: false, error: `Parallel request header setup failed: ${error.message}` };
    });
  }
  return ready;
}
