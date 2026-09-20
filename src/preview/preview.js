/**
 * Draft preview — dedicated chrome-extension HTML tab.
 * Source of truth: draftStore (chrome.storage.local). Refresh always rehydrates.
 * Interactions: click block (edit/remove/insert-after), click + slot (insert),
 * double-click / Enter inline text edit, ⋮⋮ handle drag reorder.
 */
import {
  loadDraft,
  saveDraft,
  applyDraftOps,
  generateBlockId
} from '../agent/draftStore.js';
import {
  draftToPreviewHtml,
  renderDocumentFromDraft,
  RENDER_FORMATS
} from '../agent/documentRender.js';
import { getArtifact, bytesToDataUrl } from '../agent/artifacts.js';

function qs(name) {
  try {
    return new URL(location.href).searchParams.get(name) || '';
  } catch {
    return '';
  }
}

const draftId = qs('draftId');
/** @type {import('../agent/draftStore.js').BrowserBotDraft|null} */
let currentDraft = null;
/** @type {string|null} */
let selectedBlockId = null;
/** @type {string|null} */
let editingBlockId = null;
/** @type {HTMLElement|null} */
let dragRow = null;
/** @type {string} */
let dragStartOrder = '';
let orderPersistBusy = false;
/** @type {HTMLElement|null} live main for document-level shortcuts */
let liveMainEl = null;

const TOOLBAR_HINT = '⋮⋮ 拖动手柄排序整块 · 双击编辑文字 · 点「+」插入';
const EXPORT_HINT =
  '预览仅用于微调；最终下载格式在导出时选择（md|txt|csv|html|pdf|pptx|zip）。PDF = 系统打印 → 另存为 PDF。';

function setBoot(msg, isError = false) {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.className = isError ? 'error' : '';
  boot.textContent = msg;
  boot.hidden = false;
}

function hideBoot() {
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
}

/**
 * Paint draft HTML into #root without losing module listeners on window/chrome.
 * @param {import('../agent/draftStore.js').BrowserBotDraft} draft
 */
function paint(draft) {
  // Abort any in-progress inline edit when re-painting
  editingBlockId = null;
  dragRow = null;
  dragStartOrder = '';

  currentDraft = draft;
  document.documentElement.dataset.browserbotRole = 'draft-preview';
  document.documentElement.dataset.draftId = draft.draftId;
  document.title = `${draft.title || 'Draft'} · v${draft.version}`;

  const full = draftToPreviewHtml(draft);
  const parser = new DOMParser();
  const doc = parser.parseFromString(full, 'text/html');
  const style = doc.querySelector('style');
  const chromeBar = doc.querySelector('.pw-chrome');
  const main = doc.querySelector('.pw-main');

  // Inject shared styles once
  let styleEl = document.getElementById('pw-preview-style');
  if (!styleEl && style) {
    styleEl = document.createElement('style');
    styleEl.id = 'pw-preview-style';
    styleEl.textContent =
      style.textContent +
      `
      .pw-toolbar {
        position: sticky; top: 44px; z-index: 9;
        display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
        padding: 8px 16px; background: #1e293b; color: #e2e8f0; font-size: 12px;
        border-bottom: 1px solid #334155;
      }
      .pw-toolbar button {
        border: 1px solid #475569; background: #0f172a; color: #e2e8f0;
        border-radius: 8px; padding: 5px 10px; cursor: pointer; font-weight: 600; font-size: 11px;
      }
      .pw-toolbar button:hover { border-color: #818cf8; color: #c7d2fe; }
      .pw-toolbar button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .pw-toolbar .sel { color: #a5b4fc; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pw-toolbar .pw-hint-static { color: #64748b; font-size: 11px; width: 100%; order: 10; }
      .pw-block { cursor: pointer; border-radius: 4px; transition: outline .12s, background .12s; }
      .pw-block:hover { background: rgba(99,102,241,.06); }
      .pw-block.is-selected { outline: 3px solid #8b5cf6; outline-offset: 2px; background: rgba(139,92,246,.08); }
      .pw-block.is-editing {
        cursor: text; outline: 2px solid #818cf8; outline-offset: 2px;
        background: #fffbeb; min-height: 1.2em;
      }
      .pw-block.is-editing:hover { background: #fffbeb; }
      .pw-block-row {
        display: flex; align-items: flex-start; gap: 2px;
        position: relative; margin: 0;
      }
      .pw-block-row > .pw-block { flex: 1; min-width: 0; }
      .pw-block-row--slot .pw-drag-handle { display: none !important; }
      .pw-drag-handle {
        flex: 0 0 auto; align-self: center;
        cursor: grab; user-select: none; -webkit-user-select: none;
        color: #94a3b8; padding: 8px 6px; border-radius: 6px;
        font-size: 14px; line-height: 1; letter-spacing: -1px;
        opacity: 0.25; transition: opacity .12s, background .12s, color .12s;
        touch-action: none;
      }
      .pw-block-row:hover .pw-drag-handle,
      .pw-block-row.is-selected-row .pw-drag-handle { opacity: 0.9; }
      .pw-drag-handle:hover { background: #e2e8f0; color: #475569; }
      .pw-drag-handle:active { cursor: grabbing; }
      .pw-block-row.is-dragging { opacity: 0.45; }
      .pw-block-row.is-dragging .pw-drag-handle { cursor: grabbing; }
      .pw-modal-mask {
        position: fixed; inset: 0; background: rgba(15,23,42,.45); z-index: 100;
        display: flex; align-items: center; justify-content: center; padding: 16px;
      }
      .pw-modal {
        background: #fff; color: #0f172a; border-radius: 12px; padding: 16px;
        width: min(420px, 100%); box-shadow: 0 16px 48px rgba(0,0,0,.25);
      }
      .pw-modal h3 { margin: 0 0 8px; font-size: 15px; }
      .pw-modal textarea, .pw-modal select, .pw-modal input {
        width: 100%; box-sizing: border-box; margin: 6px 0 10px;
        border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; font: inherit;
      }
      .pw-modal .row { display: flex; gap: 8px; justify-content: flex-end; }
      .pw-modal button {
        border-radius: 8px; padding: 7px 12px; border: 1px solid #e2e8f0;
        background: #f8fafc; cursor: pointer; font-weight: 600;
      }
      .pw-modal button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .pw-save-pill {
        font-size: 11px; color: #86efac; margin-left: auto;
      }
    `;
    document.head.appendChild(styleEl);
  } else if (styleEl && style) {
    // keep extended styles
  }

  let root = document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  root.innerHTML = '';

  // chrome bar
  const bar = document.createElement('div');
  bar.className = 'pw-chrome';
  bar.innerHTML = chromeBar
    ? chromeBar.innerHTML
    : `<div><strong>Browser Kitten 草稿预览</strong></div>`;
  root.appendChild(bar);

  // toolbar — refine surface is format-agnostic; export format chosen here / sidepanel
  const tb = document.createElement('div');
  tb.className = 'pw-toolbar';
  const fmtOpts = RENDER_FORMATS.map((f) => {
    const label =
      f === 'pdf' ? 'pdf（打印→另存）' : f === 'pptx' ? 'pptx（HTML幻灯）' : f;
    const selected = f === (draft.targetFormat || 'md') ? ' selected' : '';
    return `<option value="${f}"${selected}>${label}</option>`;
  }).join('');
  tb.innerHTML = `
    <span class="sel" id="pwSelLabel">${TOOLBAR_HINT}</span>
    <button type="button" data-act="insert-after" disabled>在后面插入</button>
    <button type="button" data-act="edit" disabled>编辑文字</button>
    <button type="button" data-act="remove" disabled>删除</button>
    <button type="button" data-act="reload">重新加载</button>
    <label class="pw-export-label" style="display:inline-flex;align-items:center;gap:6px;margin-left:4px">
      <span style="color:#94a3b8">导出</span>
      <select id="pwExportFormat" title="最终格式在导出时选择" style="background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:8px;padding:4px 8px;font-size:11px">
        ${fmtOpts}
      </select>
    </label>
    <button type="button" class="primary" data-act="export-download" title="按所选格式生成并下载 / PDF 走打印">确认导出</button>
    <button type="button" data-act="print-pdf" title="系统打印 → 另存为 PDF">打印为 PDF</button>
    <span class="pw-save-pill" id="pwSavePill">已自动保存 · v${draft.version}</span>
    <span class="pw-hint-static">${TOOLBAR_HINT} · ${EXPORT_HINT}</span>
  `;
  root.appendChild(tb);

  const mainEl = document.createElement('main');
  mainEl.className = 'pw-main';
  mainEl.dataset.browserbotRole = 'draft-preview';
  if (main) mainEl.innerHTML = main.innerHTML;
  // Wrap blocks + inject ⋮⋮ drag handles (preview-only; does not touch documentRender)
  decorateBlocks(mainEl);
  root.appendChild(mainEl);

  hideBoot();
  liveMainEl = mainEl;
  wireInteractions(mainEl, tb);
  if (selectedBlockId) {
    const el = mainEl.querySelector(`[data-block-id="${cssEscape(selectedBlockId)}"]`);
    if (el) {
      el.classList.add('is-selected');
      el.closest('.pw-block-row')?.classList.add('is-selected-row');
      updateToolbar(tb, selectedBlockId);
    } else {
      selectedBlockId = null;
      updateToolbar(tb, null);
    }
  }
}

/**
 * Wrap each .pw-block in a row and prepend a drag handle for non-slot blocks.
 * Slot rows are marked and never draggable; always kept last by drag logic.
 * @param {HTMLElement} mainEl
 */
function decorateBlocks(mainEl) {
  const blocks = [...mainEl.querySelectorAll(':scope > .pw-block')];
  for (const block of blocks) {
    const isSlot =
      block.classList.contains('pw-slot') || block.getAttribute('data-slot') === '1';
    const id = block.getAttribute('data-block-id') || '';

    const row = document.createElement('div');
    row.className = isSlot ? 'pw-block-row pw-block-row--slot' : 'pw-block-row';
    row.dataset.blockId = id;

    if (!isSlot) {
      const handle = document.createElement('span');
      handle.className = 'pw-drag-handle';
      handle.setAttribute('data-drag-handle', '1');
      handle.draggable = true;
      handle.setAttribute('contenteditable', 'false');
      handle.title = '拖动排序';
      handle.setAttribute('aria-label', '拖动排序');
      handle.textContent = '⋮⋮';
      row.appendChild(handle);
    }

    block.parentNode?.insertBefore(row, block);
    row.appendChild(block);
  }
  ensureSlotLast(mainEl);
}

/**
 * @param {HTMLElement} mainEl
 */
function ensureSlotLast(mainEl) {
  const slotRow = mainEl.querySelector('.pw-block-row--slot');
  if (slotRow && slotRow.parentNode === mainEl) {
    mainEl.appendChild(slotRow);
  }
}

/**
 * @param {HTMLElement} mainEl
 * @returns {string}
 */
function orderSignature(mainEl) {
  return [...mainEl.querySelectorAll('.pw-block-row:not(.pw-block-row--slot)')]
    .map((r) => r.dataset.blockId || '')
    .join(',');
}

function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * @param {HTMLElement} blockEl
 * @returns {string}
 */
function readEditableText(blockEl) {
  const clone = blockEl.cloneNode(true);
  if (clone instanceof HTMLElement) {
    clone.querySelectorAll('[data-drag-handle]').forEach((n) => n.remove());
  }
  return String(clone.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * @param {string} blockId
 * @returns {boolean}
 */
function isTextBlock(blockId) {
  const block = currentDraft?.blocks?.find((b) => b.id === blockId);
  return !!block && (block.type === 'heading' || block.type === 'paragraph');
}

/**
 * T1: contenteditable on heading/paragraph.
 * @param {HTMLElement} blockEl
 */
function startInlineEdit(blockEl) {
  if (!blockEl || editingBlockId) return;
  const id = blockEl.getAttribute('data-block-id');
  if (!id || !isTextBlock(id)) return;
  if (blockEl.classList.contains('pw-slot') || blockEl.getAttribute('data-slot') === '1') return;

  const block = currentDraft?.blocks?.find((b) => b.id === id);
  const original = block?.text != null ? String(block.text) : readEditableText(blockEl);

  editingBlockId = id;
  blockEl.dataset.editOriginal = original;
  blockEl.contentEditable = 'true';
  blockEl.classList.add('is-editing');
  blockEl.classList.add('is-selected');
  selectedBlockId = id;
  blockEl.closest('.pw-block-row')?.classList.add('is-selected-row');

  // Focus + place caret at end
  blockEl.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(blockEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch (_) {}
}

/**
 * @param {HTMLElement} blockEl
 * @param {{ cancel?: boolean }} [opts]
 */
async function finishInlineEdit(blockEl, opts = {}) {
  if (!blockEl || !editingBlockId) return;
  const id = editingBlockId;
  if (blockEl.getAttribute('data-block-id') !== id) return;

  const original = blockEl.dataset.editOriginal ?? '';
  const cancel = !!opts.cancel;

  blockEl.contentEditable = 'false';
  blockEl.classList.remove('is-editing');
  delete blockEl.dataset.editOriginal;
  editingBlockId = null;

  if (cancel) {
    // Restore original text (block has no handle child — handle is sibling in row)
    blockEl.textContent = original;
    return;
  }

  const text = readEditableText(blockEl);
  if (text === original) return;

  await applyOps([{ op: 'replace_text', blockId: id, text }]);
}

/**
 * Persist DOM block order (non-slot) + trailing slot.
 * @param {HTMLElement} mainEl
 */
async function persistOrderFromDom(mainEl) {
  if (!currentDraft || orderPersistBusy) return;
  ensureSlotLast(mainEl);
  const ids = [...mainEl.querySelectorAll('.pw-block-row:not(.pw-block-row--slot)')]
    .map((r) => r.dataset.blockId)
    .filter(Boolean);
  const prevIds = (currentDraft.blocks || [])
    .filter((b) => b.type !== 'slot')
    .map((b) => b.id)
    .join(',');
  if (ids.join(',') === prevIds) return;

  const byId = new Map((currentDraft.blocks || []).map((b) => [b.id, b]));
  /** @type {import('../agent/draftStore.js').DraftBlock[]} */
  const next = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (b && b.type !== 'slot') next.push({ ...b });
  }
  const existingSlot = (currentDraft.blocks || []).find((b) => b.type === 'slot');
  next.push(
    existingSlot
      ? { ...existingSlot }
      : {
          id: generateBlockId(),
          type: 'slot',
          slotType: 'append',
          text: '点击此处添加内容 / Click to insert'
        }
  );

  orderPersistBusy = true;
  try {
    await persistBlocks(next);
  } finally {
    orderPersistBusy = false;
  }
}

/**
 * @param {HTMLElement} mainEl
 * @param {HTMLElement} tb
 */
function wireInteractions(mainEl, tb) {
  mainEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    // Let contenteditable receive clicks for caret placement
    if (t.closest?.('.is-editing') || editingBlockId) {
      if (t.closest?.('.is-editing')) return;
    }
    // Drag handle: select parent block only
    if (t.closest?.('[data-drag-handle]')) {
      const row = t.closest('.pw-block-row');
      const block = row?.querySelector('.pw-block');
      if (block) {
        e.preventDefault();
        e.stopPropagation();
        selectBlock(mainEl, tb, block);
      }
      return;
    }

    const block = t.closest?.('.pw-block');
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();

    const id = block.getAttribute('data-block-id');
    const isSlot = block.classList.contains('pw-slot') || block.getAttribute('data-slot') === '1';

    selectBlock(mainEl, tb, block);

    if (isSlot) {
      void promptInsert({ mode: 'slot', slotId: id || undefined });
      return;
    }
  });

  // T1: double-click heading/paragraph → inline edit
  mainEl.addEventListener('dblclick', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest?.('[data-drag-handle]')) return;
    const block = t.closest?.('.pw-block');
    if (!block) return;
    const id = block.getAttribute('data-block-id');
    if (!id || !isTextBlock(id)) return;
    e.preventDefault();
    e.stopPropagation();
    selectBlock(mainEl, tb, block);
    startInlineEdit(block);
  });

  // T1: blur / keys while editing
  mainEl.addEventListener(
    'blur',
    (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (!t.classList?.contains('is-editing')) return;
      // Defer so Ctrl+Enter / Esc handlers can cancel first if needed
      requestAnimationFrame(() => {
        if (editingBlockId && t.getAttribute('data-block-id') === editingBlockId) {
          void finishInlineEdit(t, { cancel: false });
        }
      });
    },
    true
  );

  mainEl.addEventListener(
    'keydown',
    (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.classList?.contains('is-editing') && editingBlockId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          void finishInlineEdit(t, { cancel: true });
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          void finishInlineEdit(t, { cancel: false });
          return;
        }
        return;
      }
    },
    true
  );

  // T2+T3: drag via handle only
  mainEl.addEventListener('dragstart', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const handle = t.closest?.('[data-drag-handle]');
    if (!handle) {
      // Prevent dragging whole text/images accidentally
      if (t.closest?.('.pw-block-row') && !t.closest?.('[data-drag-handle]')) {
        e.preventDefault();
      }
      return;
    }
    if (editingBlockId) {
      e.preventDefault();
      return;
    }
    const row = handle.closest('.pw-block-row');
    if (!row || row.classList.contains('pw-block-row--slot')) {
      e.preventDefault();
      return;
    }
    dragRow = row;
    dragStartOrder = orderSignature(mainEl);
    row.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.blockId || '');
      e.dataTransfer.setData('application/x-browserbot-block', row.dataset.blockId || '');
    } catch (_) {}
  });

  mainEl.addEventListener('dragover', (e) => {
    if (!dragRow) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'move';
    } catch (_) {}

    const over =
      /** @type {HTMLElement|null} */ (e.target)?.closest?.('.pw-block-row') || null;
    if (!over || over === dragRow) return;
    if (over.classList.contains('pw-block-row--slot')) {
      // Always insert before trailing slot
      mainEl.insertBefore(dragRow, over);
      return;
    }
    const rect = over.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    if (before) {
      mainEl.insertBefore(dragRow, over);
    } else {
      mainEl.insertBefore(dragRow, over.nextSibling);
    }
    ensureSlotLast(mainEl);
  });

  mainEl.addEventListener('drop', (e) => {
    if (!dragRow) return;
    e.preventDefault();
    ensureSlotLast(mainEl);
  });

  mainEl.addEventListener('dragend', () => {
    if (!dragRow) return;
    const row = dragRow;
    row.classList.remove('is-dragging');
    ensureSlotLast(mainEl);
    const nextOrder = orderSignature(mainEl);
    dragRow = null;
    if (nextOrder !== dragStartOrder) {
      void persistOrderFromDom(mainEl);
    }
    dragStartOrder = '';
  });

  tb.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.('button[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'reload') {
      void hydrate();
      return;
    }
    // A′: print-ready HTML → system print → Save as PDF (no extra install)
    if (act === 'print-pdf') {
      void openPrintPdfFromPreview();
      return;
    }
    if (act === 'export-download') {
      void exportFromPreviewToolbar(tb);
      return;
    }
    if (!selectedBlockId) return;
    if (act === 'insert-after') {
      void promptInsert({ mode: 'after', afterId: selectedBlockId });
    } else if (act === 'edit') {
      // Prefer inline for text blocks; modal for image / others
      if (isTextBlock(selectedBlockId)) {
        const block = mainEl.querySelector(
          `[data-block-id="${cssEscape(selectedBlockId)}"]`
        );
        if (block instanceof HTMLElement) {
          startInlineEdit(block);
          return;
        }
      }
      void promptEdit(selectedBlockId);
    } else if (act === 'remove') {
      void applyOps([
        { op: 'remove', blockId: selectedBlockId }
      ]);
      selectedBlockId = null;
    }
  });
}

/**
 * A′ print path from preview toolbar.
 */
function openPrintPdfFromPreview() {
  if (!draftId) return;
  const url = chrome.runtime.getURL(
    `src/preview/print.html?draftId=${encodeURIComponent(draftId)}&autoprint=1`
  );
  void chrome.tabs.create({ url, active: true });
}

/**
 * Format-agnostic export from preview toolbar: render_document equivalent + download / print.
 * @param {HTMLElement} tb
 */
async function exportFromPreviewToolbar(tb) {
  if (!draftId || !currentDraft) {
    setBoot('没有可导出的草稿', true);
    return;
  }
  const sel = /** @type {HTMLSelectElement|null} */ (tb.querySelector('#pwExportFormat'));
  const format = String(sel?.value || currentDraft.targetFormat || 'md').toLowerCase();
  const pill = document.getElementById('pwSavePill');
  if (pill) pill.textContent = `导出中 · ${format}…`;
  try {
    // Rehydrate latest before compile
    const draft = (await loadDraft(draftId)) || currentDraft;
    const result = await renderDocumentFromDraft(draft, {
      format,
      runId: draft.runId || 'preview',
      name: draft.title || 'browserbot'
    });
    if (result.status !== 'ok') {
      setBoot(result.message || '导出失败', true);
      if (pill) pill.textContent = '导出失败';
      return;
    }
    await saveDraft(draftId, {
      status: 'ready_for_export',
      targetFormat: format,
      bumpVersion: false
    });

    if (format === 'pdf' || result.delivery === 'browser_print') {
      openPrintPdfFromPreview();
      if (pill) pill.textContent = '请在打印对话框选择「另存为 PDF」';
      return;
    }

    const rec = getArtifact(result.artifactId, draft.runId || 'preview');
    if (!rec?.bytes) {
      setBoot('生成的文件不存在', true);
      if (pill) pill.textContent = '文件缺失';
      return;
    }
    const url = bytesToDataUrl(rec.bytes, rec.mime || 'application/octet-stream');
    const filename = rec.name || result.name || `browserbot.${format}`;
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename, conflictAction: 'uniquify' },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        }
      );
    });
    if (pill) pill.textContent = `已开始下载 · ${filename}`;
    // Soft: keep draft so user can re-export other formats; sidepanel purge is optional
    try {
      chrome.runtime.sendMessage({
        action: 'broadcast_draft_updated',
        draftId,
        version: draft.version
      });
    } catch (_) {}
  } catch (e) {
    setBoot(String(e?.message || e), true);
    if (pill) pill.textContent = '导出失败';
  }
}

/**
 * @param {HTMLElement} mainEl
 * @param {HTMLElement} tb
 * @param {Element} block
 */
function selectBlock(mainEl, tb, block) {
  mainEl.querySelectorAll('.pw-block.is-selected').forEach((n) => n.classList.remove('is-selected'));
  mainEl.querySelectorAll('.pw-block-row.is-selected-row').forEach((n) =>
    n.classList.remove('is-selected-row')
  );
  block.classList.add('is-selected');
  block.closest('.pw-block-row')?.classList.add('is-selected-row');
  selectedBlockId = block.getAttribute('data-block-id');
  updateToolbar(tb, selectedBlockId);
}

/**
 * @param {HTMLElement} tb
 * @param {string|null} blockId
 */
function updateToolbar(tb, blockId) {
  const label = tb.querySelector('#pwSelLabel');
  const block = currentDraft?.blocks?.find((b) => b.id === blockId);
  if (label) {
    if (!blockId || !block) label.textContent = TOOLBAR_HINT;
    else
      label.textContent = `已选 ${block.type}: ${(block.text || block.alt || blockId).slice(0, 48)}`;
  }
  tb.querySelectorAll('button[data-act="insert-after"],button[data-act="edit"],button[data-act="remove"]').forEach(
    (b) => {
      /** @type {HTMLButtonElement} */ (b).disabled = !blockId || block?.type === 'slot';
    }
  );
}

/**
 * @param {{ mode: 'slot'|'after', slotId?: string, afterId?: string }} opts
 */
async function promptInsert(opts) {
  const choice = await modalForm({
    title: '插入新块',
    fields: [
      {
        name: 'type',
        label: '类型',
        type: 'select',
        options: [
          { value: 'paragraph', label: '段落' },
          { value: 'heading', label: '标题' },
          { value: 'image', label: '图片 URL' },
          { value: 'divider', label: '分隔线' }
        ]
      },
      { name: 'text', label: '文字 / 图片 URL', type: 'textarea', placeholder: '输入内容…' }
    ],
    confirmLabel: '插入并保存'
  });
  if (!choice) return;
  const type = choice.type || 'paragraph';
  /** @type {import('../agent/draftStore.js').DraftBlock} */
  const block = {
    id: generateBlockId(),
    type: /** @type {any} */ (type === 'image' ? 'image' : type)
  };
  if (type === 'image') {
    block.src = String(choice.text || '').trim();
    block.alt = 'image';
    if (!block.src) return;
  } else if (type === 'divider') {
    block.type = 'divider';
  } else {
    block.text = String(choice.text || '').trim() || '（空）';
  }

  /** @type {any[]} */
  const ops = [];
  if (opts.mode === 'after' && opts.afterId) {
    ops.push({ op: 'insert', afterId: opts.afterId, block });
  } else if (opts.mode === 'slot' && opts.slotId) {
    // insert before the slot (append)
    ops.push({ op: 'insert', beforeId: opts.slotId, block });
  } else {
    ops.push({ op: 'insert', block });
  }
  await applyOps(ops);
}

/**
 * @param {string} blockId
 */
async function promptEdit(blockId) {
  const block = currentDraft?.blocks?.find((b) => b.id === blockId);
  if (!block || block.type === 'slot' || block.type === 'divider') return;
  if (block.type === 'image') {
    const choice = await modalForm({
      title: '编辑图片',
      fields: [
        {
          name: 'src',
          label: '图片 URL / data URL',
          type: 'textarea',
          value: block.src || ''
        },
        { name: 'alt', label: '说明', type: 'text', value: block.alt || '' }
      ],
      confirmLabel: '保存'
    });
    if (!choice) return;
    const blocks = (currentDraft?.blocks || []).map((b) =>
      b.id === blockId
        ? { ...b, src: String(choice.src || ''), alt: String(choice.alt || '') }
        : b
    );
    await persistBlocks(blocks);
    return;
  }
  const choice = await modalForm({
    title: '编辑文字',
    fields: [
      {
        name: 'text',
        label: '内容',
        type: 'textarea',
        value: block.text || ''
      }
    ],
    confirmLabel: '保存'
  });
  if (!choice) return;
  await applyOps([
    { op: 'replace_text', blockId, text: String(choice.text || '') }
  ]);
}

/**
 * @param {any[]} ops
 */
async function applyOps(ops) {
  if (!currentDraft) return;
  const nextBlocks = applyDraftOps(currentDraft.blocks, ops);
  await persistBlocks(nextBlocks);
}

/**
 * @param {import('../agent/draftStore.js').DraftBlock[]} blocks
 */
async function persistBlocks(blocks) {
  if (!draftId) return;
  const next = await saveDraft(draftId, { blocks, status: 'editing' });
  if (!next) {
    setBoot('保存失败：草稿可能已清除', true);
    return;
  }
  // Notify sidepanel / other previews
  try {
    chrome.runtime.sendMessage({
      action: 'broadcast_draft_updated',
      draftId,
      version: next.version
    });
  } catch (_) {}
  paint(next);
  const pill = document.getElementById('pwSavePill');
  if (pill) {
    pill.textContent = `已自动保存 · v${next.version} · ${new Date().toLocaleTimeString()}`;
  }
}

/**
 * Simple modal form.
 * @param {{
 *   title: string,
 *   fields: Array<{name:string,label:string,type:string,options?:any[],value?:string,placeholder?:string}>,
 *   confirmLabel?: string
 * }} cfg
 * @returns {Promise<Record<string,string>|null>}
 */
function modalForm(cfg) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'pw-modal-mask';
    const fieldsHtml = cfg.fields
      .map((f) => {
        if (f.type === 'select') {
          const opts = (f.options || [])
            .map((o) => `<option value="${o.value}">${o.label}</option>`)
            .join('');
          return `<label>${f.label}<select name="${f.name}">${opts}</select></label>`;
        }
        if (f.type === 'textarea') {
          return `<label>${f.label}<textarea name="${f.name}" rows="4" placeholder="${f.placeholder || ''}">${f.value || ''}</textarea></label>`;
        }
        return `<label>${f.label}<input name="${f.name}" type="text" value="${f.value || ''}" placeholder="${f.placeholder || ''}" /></label>`;
      })
      .join('');
    mask.innerHTML = `<div class="pw-modal" role="dialog">
      <h3>${cfg.title}</h3>
      ${fieldsHtml}
      <div class="row">
        <button type="button" data-x="cancel">取消</button>
        <button type="button" class="primary" data-x="ok">${cfg.confirmLabel || '确定'}</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const close = (val) => {
      mask.remove();
      resolve(val);
    };
    mask.querySelector('[data-x="cancel"]')?.addEventListener('click', () => close(null));
    mask.querySelector('[data-x="ok"]')?.addEventListener('click', () => {
      /** @type {Record<string,string>} */
      const out = {};
      cfg.fields.forEach((f) => {
        const el = /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|null} */ (
          mask.querySelector(`[name="${f.name}"]`)
        );
        out[f.name] = el?.value ?? '';
      });
      close(out);
    });
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(null);
    });
  });
}

async function hydrate() {
  if (!draftId) {
    setBoot('缺少 draftId。请从侧栏「打开预览」进入。', true);
    return;
  }
  setBoot('Loading draft…');
  const draft = await loadDraft(draftId);
  if (!draft) {
    setBoot('草稿不存在（可能已下载清除）。请回侧栏重新 materialize。', true);
    return;
  }
  paint(draft);
}

// T1: Enter when block selected (not editing) → inline edit (once)
document.addEventListener('keydown', (e) => {
  if (editingBlockId) return;
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tag = (/** @type {HTMLElement} */ (e.target))?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (document.querySelector('.pw-modal-mask')) return;
  if (!selectedBlockId || !isTextBlock(selectedBlockId) || !liveMainEl) return;
  const block = liveMainEl.querySelector(
    `[data-block-id="${cssEscape(selectedBlockId)}"]`
  );
  if (!(block instanceof HTMLElement)) return;
  e.preventDefault();
  startInlineEdit(block);
});

// External updates (other tab / agent revise)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'draft_updated' && msg.draftId === draftId) {
    // Avoid loop if we just saved — still rehydrate to stay consistent
    void hydrate();
  }
  if (msg?.action === 'draft_purged' && msg.draftId === draftId) {
    selectedBlockId = null;
    editingBlockId = null;
    currentDraft = null;
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML =
        '<div style="padding:32px;font-family:system-ui;color:#e2e8f0;background:#0f172a;min-height:100vh">草稿已在下载后清除 / Draft purged after download。<br/><small>可以关闭本标签页。</small></div>';
    }
  }
});

hydrate().catch((e) => setBoot(String(e?.message || e), true));
