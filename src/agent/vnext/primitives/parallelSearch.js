/** Small HTTP MCP client for anonymous Parallel Search. Each call owns its connection. */
import { assertPublicHttpUrl } from './netGuard.js';

export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';
export const PARALLEL_USER_AGENT = 'BrowserKitten/1.0 (+https://github.com/Player-YN/BrowserKitten)';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30000;

function waitWithSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function readReply(response, id) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Parallel MCP response too large');
      text += decoder.decode(value, { stream: true });
      if (sse) {
        text = text.replace(/\r\n/g, '\n');
        let end;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const event = text.slice(0, end);
          text = text.slice(end + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const reply = JSON.parse(data);
          if (reply.id === id) return reply;
        }
      }
    }
    if (sse) throw new Error('Parallel MCP stream ended without a reply');
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function searchParallel({ query, fetchImpl, signal, sessionId }) {
  if (!sessionId) throw new Error('Parallel search needs a conversation identifier');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Parallel search timed out')), SEARCH_TIMEOUT_MS);
  let connectionId;

  async function request(method, params, id) {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(PARALLEL_SEARCH_URL, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': PARALLEL_USER_AGENT,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(connectionId ? { 'Mcp-Session-Id': connectionId } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
      signal: controller.signal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Parallel MCP HTTP ${response.status}${response.status === 429 ? ': search quota reached; try again later' : ''}`);
    }
    if (id === undefined) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (method === 'initialize') connectionId = response.headers.get('mcp-session-id') || undefined;
    const reply = await readReply(response, id);
    if (reply.jsonrpc !== '2.0' || reply.id !== id) throw new Error('Invalid Parallel MCP reply');
    if (reply.error) throw new Error(`Parallel MCP: ${String(reply.error.message || 'request failed').slice(0, 200)}`);
    if (!reply.result) throw new Error('Missing Parallel MCP result');
    return reply.result;
  }

  try {
    if (globalThis.chrome?.runtime?.id) {
      const setup = await waitWithSignal(chrome.runtime.sendMessage({
        target: 'pawwork-background', action: 'workspace_parallel_search_headers'
      }), controller.signal);
      if (!setup?.ok) throw new Error(setup?.error || 'Parallel request header setup unavailable');
    }
    const initialized = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'BrowserKitten', version: '1.0' }
    }, 1);
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported Parallel MCP protocol version');
    await request('notifications/initialized');
    const discovery = await request('tools/list', {}, 2);
    if (!discovery.tools?.some(tool => tool.name === 'web_search')) throw new Error('Parallel MCP search tool unavailable');
    const output = await request('tools/call', {
      name: 'web_search',
      arguments: { objective: query, search_queries: [query], session_id: sessionId }
    }, 3);
    if (output.isError) {
      const message = output.content?.find(part => part.type === 'text')?.text || 'search failed';
      throw new Error(`Parallel search: ${message.slice(0, 200)}`);
    }
    const data = output.structuredContent || JSON.parse(output.content?.find(part => part.type === 'text')?.text || '{}');
    if (!Array.isArray(data.results)) throw new Error('Invalid Parallel search results');
    return data.results.filter(hit => assertPublicHttpUrl(hit.url).ok).map(hit => ({
      url: hit.url,
      title: hit.title || hit.url,
      content: Array.isArray(hit.excerpts) ? hit.excerpts.join('\n\n') : ''
    }));
  } finally {
    // The MCP connection is separate from the durable research conversation.
    if (connectionId && !controller.signal.aborted) {
      await fetchImpl(PARALLEL_SEARCH_URL, {
        method: 'DELETE', credentials: 'omit', redirect: 'error',
        headers: {
          'Mcp-Session-Id': connectionId,
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'User-Agent': PARALLEL_USER_AGENT
        },
        signal: controller.signal
      }).then(response => response.body?.cancel()).catch(() => {});
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
