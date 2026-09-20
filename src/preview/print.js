/**
 * A′ PDF path: load draft → print-ready HTML → window.print() (Save as PDF).
 * Extension-only; no Pandoc / no extra install.
 */
import { loadDraft } from '../agent/draftStore.js';
import { draftToPrintHtml } from '../agent/documentRender.js';

function qs(name) {
  try {
    return new URL(location.href).searchParams.get(name) || '';
  } catch {
    return '';
  }
}

async function main() {
  const status = document.getElementById('status');
  const draftId = qs('draftId');
  const src = qs('src');
  const autoprint = qs('autoprint') === '1';

  document.getElementById('btnClose')?.addEventListener('click', () => window.close());
  document.getElementById('btnPrint')?.addEventListener('click', () => doPrint());

  if (src === 'plates') {
    let html = '';
    try {
      html = localStorage.getItem('browserbot_print_html') || sessionStorage.getItem('browserbot_print_html') || '';
    } catch {
      html = '';
    }
    if (!html) {
      if (status) status.textContent = '没有可打印的海报 / 幻灯片';
      return;
    }
    mountPrintHtml(html, status, '海报 / 幻灯片');
    if (autoprint) setTimeout(() => doPrint(), 400);
    return;
  }

  if (!draftId) {
    if (status) status.textContent = '缺少 draftId';
    return;
  }

  const draft = await loadDraft(draftId);
  if (!draft) {
    if (status) status.textContent = '草稿不存在或已清除';
    return;
  }

  const html = draftToPrintHtml(draft);
  mountPrintHtml(html, status, `${draft.title || draftId} · v${draft.version}`);
  if (autoprint) setTimeout(() => doPrint(), 400);
}

function mountPrintHtml(html, status, label) {
  const wrap = document.getElementById('frame-wrap');
  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'print-content');
  wrap?.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    if (status) status.textContent = '无法创建打印帧';
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  if (status) status.textContent = `已就绪 · ${label || ''} · 点击按钮或等待自动打印`;
  window.__pwPrintFrame = iframe;
}

function doPrint() {
  const iframe = window.__pwPrintFrame;
  try {
    if (iframe?.contentWindow) {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      return;
    }
  } catch (_) {}
  window.print();
}

main().catch((e) => {
  const status = document.getElementById('status');
  if (status) status.textContent = String(e?.message || e);
});
