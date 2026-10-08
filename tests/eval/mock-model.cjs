// Deterministic OpenAI-compatible chat server used to self-test the harness without a real key.
// It speaks /v1/chat/completions (stream and non-stream) and /v1/models. A "script" per task turns the
// conversation so far (tool results in the request) into the next assistant message: a tool call or text.
// Counters are exact because every model HTTP call lands here.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const scripts = require('./mock-scripts.cjs');

function createMockModel() {
  let taskId = null;
  const counters = { chat: 0, system1: 0, models: 0, bytesIn: 0, titles: 0, bytesOut: 0 };
  const dumpDir = process.env.BK_MOCK_DUMP || '';
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      counters.bytesIn += Buffer.byteLength(raw);
      if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
        counters.models++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-eval-1', object: 'model', context_window: 128000 }] }));
      }
      if (req.method === 'POST' && /\/systemone$/.test(url.pathname)) {
        counters.system1++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'mock has no System1' }));
      }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) { res.writeHead(404); return res.end('{}'); }
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (dumpDir) fs.writeFileSync(path.join(dumpDir, `req-${String(++seq).padStart(3, '0')}.json`), raw);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      let reply;
      if (!hasTools) { counters.titles++; reply = { text: 'Eval task' }; }
      else { counters.chat++; try { reply = scripts.next(taskId, body.messages || []); } catch (e) { console.error('[mock] script error:', e.message); reply = { text: `mock script error: ${e.message}` }; } }
      respond(res, body, reply);
    });
  });

  function respond(res, body, reply) {
    const promptChars = JSON.stringify(body.messages || []).length;
    const usage = { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(JSON.stringify(reply).length / 4) + 3,
      prompt_tokens_details: { cached_tokens: 0 } };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const toolCalls = (reply.calls || []).map((c, i) => ({ index: i, id: `call_${Date.now().toString(36)}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: 'mock-eval-1', choices: [{ index: 0, delta, finish_reason: finish }] });
      send(chunk({ role: 'assistant', content: '' }));
      if (reply.text) send(chunk({ content: reply.text }));
      if (toolCalls.length) send(chunk({ tool_calls: toolCalls }));
      send(chunk({}, toolCalls.length ? 'tool_calls' : 'stop'));
      send({ id, object: 'chat.completion.chunk', created, model: 'mock-eval-1', choices: [], usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: 'mock-eval-1', usage,
      choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: reply.text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...t }) => t) } : {}) } }] }));
  }

  return {
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    setTask(id) { taskId = id; },
    mark() { return { ...counters }; },
    since(m) { return { agentCalls: counters.chat - m.chat, auxCalls: counters.titles - m.titles, system1: counters.system1 - m.system1, requestBytes: counters.bytesIn - m.bytesIn, responseBytes: 0, ttfbMsMean: 0, httpErrors: 0 }; },
    close() { return new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
  };
}

module.exports = { createMockModel };

if (require.main === module) {
  // Standalone: `node tests/eval/mock-model.cjs` prints a base URL usable as BK_EVAL_API_BASE (model: mock-eval-1).
  const m = createMockModel();
  m.start().then((base) => console.log(`${base}/v1`));
}
