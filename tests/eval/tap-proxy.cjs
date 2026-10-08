// Transparent counting proxy in front of a real model endpoint (--tap). Playwright cannot see requests made by the
// extension's offscreen document, so this gives exact HTTP call counts and sizes without touching the product.
// Headers (including the Authorization key) are forwarded from memory and never logged or stored.
const http = require('node:http');

function createTap(realBase) {
  const target = new URL(realBase);
  const prefix = target.pathname.replace(/\/$/, '');
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const rec = { t: Date.now(), path: req.url.split('?')[0].slice(prefix.length) || '/', method: req.method, reqBytes: body.length, resBytes: 0, status: 0, ttfbMs: 0, totalMs: 0, hasTools: false };
      try { rec.hasTools = Array.isArray(JSON.parse(body.toString('utf8') || '{}').tools); } catch { /* not JSON */ }
      calls.push(rec);
      const started = Date.now();
      try {
        const headers = { ...req.headers, host: target.host };
        delete headers['content-length']; delete headers['accept-encoding'];
        const upstream = await fetch(`${target.origin}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        rec.status = upstream.status; rec.ttfbMs = Date.now() - started;
        const out = {};
        upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
        res.writeHead(upstream.status, out);
        if (upstream.body) for await (const chunk of upstream.body) { rec.resBytes += chunk.length; res.write(chunk); }
        res.end();
      } catch (e) {
        rec.status = rec.status || 599;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `tap upstream failure: ${e.message}` }));
      } finally { rec.totalMs = Date.now() - started; }
    });
  });
  return {
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}${prefix}`;
    },
    mark() { return calls.length; },
    since(m) {
      const rows = calls.slice(m);
      const isS1 = (r) => /\/systemone$/.test(r.path);
      const chat = rows.filter((r) => !isS1(r) && r.method === 'POST');
      return {
        agentCalls: chat.filter((r) => r.hasTools).length, auxCalls: chat.filter((r) => !r.hasTools).length, system1: rows.filter(isS1).length,
        requestBytes: rows.reduce((s, r) => s + r.reqBytes, 0), responseBytes: rows.reduce((s, r) => s + r.resBytes, 0),
        ttfbMsMean: chat.length ? chat.reduce((s, r) => s + r.ttfbMs, 0) / chat.length : 0, httpErrors: rows.filter((r) => r.status >= 400).length
      };
    },
    close() { return new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
  };
}
module.exports = { createTap };
