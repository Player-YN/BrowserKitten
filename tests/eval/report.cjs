// Aggregation + markdown rendering. Pure functions so they can be unit-checked without a browser.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function summarize(runs) {
  const group = (rows) => ({
    runs: rows.length,
    successRate: rows.length ? rows.filter((r) => r.success).length / rows.length : 0,
    wallMsMedian: median(rows.map((r) => r.wallMs)), wallMsMean: mean(rows.map((r) => r.wallMs)),
    modelCallsMean: mean(rows.map((r) => r.metrics.modelCalls)), toolCallsMean: mean(rows.map((r) => r.metrics.toolCalls)),
    promptTokensMean: mean(rows.map((r) => r.metrics.promptTokens)), completionTokensMean: mean(rows.map((r) => r.metrics.completionTokens)),
    cachedTokensMean: mean(rows.map((r) => r.metrics.cachedTokens)), system1CallsMean: mean(rows.map((r) => r.metrics.system1Calls)),
    httpRequestKBMean: mean(rows.map((r) => (r.metrics.http ? r.metrics.http.requestBytes / 1024 : 0))),
    toolErrorsMean: mean(rows.map((r) => r.metrics.toolErrors))
  });
  const byTask = {};
  for (const id of [...new Set(runs.map((r) => r.task))]) byTask[id] = group(runs.filter((r) => r.task === id));
  return { overall: group(runs), byTask };
}

const sec = (ms) => (ms / 1000).toFixed(1);
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

function renderMarkdown(report) {
  const { meta, summary, runs } = report;
  const o = summary.overall;
  const lines = [];
  lines.push(`# Browser Kitten eval: ${meta.label}`, '');
  lines.push(`- when: ${meta.startedAt}  commit: ${meta.commit}${meta.dirty ? ' (dirty)' : ''}  extension: ${meta.extensionVersion}${meta.mock ? '  **MOCK MODEL**' : ''}`);
  lines.push(`- backend: ${JSON.stringify(meta.backend)}  flags: ${JSON.stringify(meta.flags)}  repeat: ${meta.repeat}`, '');
  lines.push(`**Success ${(o.successRate * 100).toFixed(0)}%** (${runs.filter((r) => r.success).length}/${o.runs})  |  time median ${sec(o.wallMsMedian)}s, mean ${sec(o.wallMsMean)}s  |  model calls/run ${f1(o.modelCallsMean)}  |  tool calls/run ${f1(o.toolCallsMean)}  |  tokens/run in ${k(o.promptTokensMean)} (cached ${k(o.cachedTokensMean)}) out ${k(o.completionTokensMean)}  |  System1 calls/run ${f1(o.system1CallsMean)}`, '');
  lines.push('| task | success | median s | mean s | model calls | tool calls | tool errs | tokens in | cached | tokens out | S1 calls |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [id, g] of Object.entries(summary.byTask)) {
    lines.push(`| ${id} | ${(g.successRate * 100).toFixed(0)}% (${Math.round(g.successRate * g.runs)}/${g.runs}) | ${sec(g.wallMsMedian)} | ${sec(g.wallMsMean)} | ${f1(g.modelCallsMean)} | ${f1(g.toolCallsMean)} | ${f1(g.toolErrorsMean)} | ${k(g.promptTokensMean)} | ${k(g.cachedTokensMean)} | ${k(g.completionTokensMean)} | ${f1(g.system1CallsMean)} |`);
  }
  const bad = runs.filter((r) => !r.success);
  if (bad.length) {
    lines.push('', '## Failures', '');
    for (const r of bad) lines.push(`- ${r.task} rep${r.rep}: ${r.reason}${r.rpcError ? ` (rpc ${r.rpcError.code})` : ''}${Object.keys(r.metrics.errorCodes).length ? ` codes=${JSON.stringify(r.metrics.errorCodes)}` : ''}`);
  }
  lines.push('', '_Exact: success (fixture state), wall time, model-call and tool-call counts from workspace events, per-step API usage when the provider reports it. Approximate: tokens when only turn totals exist, request bytes (POST body only)._');
  return lines.join('\n');
}

module.exports = { summarize, renderMarkdown, median, mean };
