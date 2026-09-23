// Content script: 点选 picker + live-page `action` (snapshot/mutate) per frame.
// Page JS evaluation is not here — guest `sys.eval` / page fetch go through SW userScripts.
// Classic script: executeScript injects this as a non-module. Wrap in IIFE so
// re-inject after Reload does not redeclare top-level const.

(function contentBoot() {
  let extId = '';
  try {
    extId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || '';
  } catch {
    return;
  }
  if (!extId) return;
  if (window.__PAGEWAND_CS_ID === extId) return;
  window.__PAGEWAND_CS_ID = extId;
  window.__PAGEWAND_CONTENT_SCRIPT_INITIALIZED__ = true;

  let pickMod = null;
  const pickReady = import(chrome.runtime.getURL('src/agent/vnext/sessionWorkspace/pickContext.js'))
    .then((m) => {
      pickMod = m;
      return m;
    })
    .catch((err) => {
      console.warn('[BrowserBot] pickContext load failed', err);
      pickMod = {
        pierceAndSnap: (doc, x, y) => {
          const el = doc.elementFromPoint?.(x, y);
          return el ? { element: el, kind: 'text' } : null;
        },
        pierceAndSnapWithCandidates: (doc, x, y) => {
          const el = doc.elementFromPoint?.(x, y);
          return el ? { element: el, kind: 'text', candidates: [] } : null;
        },
        classifyContextKind: () => 'text',
        isClipboardTextPick: (desc) => String(desc?.kind || desc?.kindHint || 'text') === 'text',
        clipClipboardText: (s) => String(s || ''),
        contextSrcOf: (el) => String(el?.currentSrc || el?.src || ''),
        contextDirectHrefOf: (el) => String(el?.closest?.('a[href]')?.href || el?.href || ''),
        contextAltOf: () => '',
        contextTextPreservingBlocks: (el) => String(el?.innerText || el?.textContent || ''),
        contextHrefOf: (el) => String(el?.href || ''),
        srcLooksImage: () => false
      };
      return pickMod;
    });

  function pick() {
    return pickMod;
  }

  function pierceAndSnap(doc, x, y) {
    const api = pick();
    if (api?.pierceAndSnap) return api.pierceAndSnap(doc, x, y);
    const el = doc.elementFromPoint?.(x, y);
    return el ? { element: el, kind: 'text' } : null;
  }

  function pierceAndSnapWithCandidates(doc, x, y) {
    const api = pick();
    if (api?.pierceAndSnapWithCandidates) return api.pierceAndSnapWithCandidates(doc, x, y);
    return pierceAndSnap(doc, x, y);
  }

  function classifyContextKind(desc, opts) {
    const api = pick();
    if (api?.classifyContextKind) return api.classifyContextKind(desc, opts);
    return 'text';
  }

  function isClipboardTextPick(desc, opts) {
    const api = pick();
    if (api?.isClipboardTextPick) return api.isClipboardTextPick(desc, opts);
    const hint = String(desc?.kind || desc?.kindHint || 'text').toLowerCase();
    return hint === 'text' || hint === 'txt';
  }

  function clipClipboardText(value) {
    const api = pick();
    if (api?.clipClipboardText) return api.clipClipboardText(value);
    return String(value || '');
  }

  function contextSrcOf(el) {
    const api = pick();
    if (api?.contextSrcOf) return api.contextSrcOf(el);
    return String(el?.currentSrc || el?.src || '');
  }

  function contextHrefOf(el) {
    const api = pick();
    if (api?.contextHrefOf) return api.contextHrefOf(el);
    return String(el?.href || '');
  }

  function contextDirectHrefOf(el) { return pick()?.contextDirectHrefOf?.(el) || contextHrefOf(el); }
  function contextAltOf(el) { return pick()?.contextAltOf?.(el) || ''; }
  function contextTextPreservingBlocks(el) { return pick()?.contextTextPreservingBlocks?.(el) || String(el?.innerText || el?.textContent || ''); }

  function srcLooksImage(src) {
    const api = pick();
    if (api?.srcLooksImage) return api.srcLooksImage(src);
    return false;
  }

  function extensionAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function extSend(msg) {
    if (!extensionAlive()) return;
    try {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime?.lastError;
      });
    } catch {
      /* Reload orphaned this content script; do not throw into the page. */
    }
  }

  let pickerActive = false;
  let hoveredElement = null;
  let selectedElements = []; // [{ element, selector, tag, text, src }]
  let linkOptBubble = null;
  let scopeOptionBubble = null;
  let hoveredCandidates = [];
  let pickerLang = 'zh';

  let userCustomShortcut = 'Alt+S'; // Default custom key combo

  chrome.storage.local.get(['custom_shortcut'], (result) => {
    if (result.custom_shortcut) {
      userCustomShortcut = result.custom_shortcut;
    }
  });
  chrome.storage.local.get(['app_lang'], (result) => {
    const value = String(result.app_lang || '');
    if (value.toLowerCase().startsWith('en')) pickerLang = 'en';
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.custom_shortcut && changes.custom_shortcut.newValue) {
      userCustomShortcut = changes.custom_shortcut.newValue;
      showToast(`⚙️ 连点快捷键已更新为: ${userCustomShortcut}`);
    }
    if (changes.app_lang?.newValue) pickerLang = String(changes.app_lang.newValue).toLowerCase().startsWith('en') ? 'en' : 'zh';
  });

  // Inject BrowserBot Global SDK for DeepSeek AI Agent Scripts (Content Script Isolated World)
  window.BrowserBot = {
    getSelectedElements: () => selectedElements.map(item => item.element).filter(Boolean),
    downloadImages: (targets, count) => {
      let targetCount = typeof count === 'number' ? count : (typeof targets === 'number' ? targets : 0);
      if (targets && Array.isArray(targets) && targets.length > 0) {
        let urls = [];
        targets.forEach(t => {
          if (typeof t === 'string') urls.push(t);
          else if (t && t.nodeType === 1) urls.push(...extractImageUrlsFromContainer(t));
        });
        urls = [...new Set(urls.filter(Boolean))];
        if (targetCount > 0 && urls.length > targetCount) {
          urls = urls.sort(() => 0.5 - Math.random()).slice(0, targetCount);
        }
        if (urls.length > 0) {
          showToast(`⚡ 正在提取并打包 ${urls.length} 张图片...`);
          Promise.all(urls.map(u => fetchUrlAsDataUrlInTabContext(u))).then(finalDataUrls => {
            extSend({ action: 'trigger_native_downloads', urls: finalDataUrls.filter(Boolean) });
          });
          return;
        }
      }
      downloadSelectedImages(targetCount);
    },
    highlight: (targets, color = '#fef08a') => {
      const els = (targets && targets.length > 0) ? targets : selectedElements.map(item => item.element);
      els.forEach(el => {
        if (!el || !el.style) return;
        el.style.backgroundColor = color;
        el.style.border = '3px solid #eab308';
        el.style.boxShadow = '0 0 16px rgba(234, 179, 8, 0.6)';
        el.style.transition = 'all 0.3s ease';
      });
      showToast(`✨ 已高亮 ${els.length} 个节点`);
    },
    applyDiscount: (targets, rate = 0.8) => {
      const els = (targets && targets.length > 0) ? targets : selectedElements.map(item => item.element);
      els.forEach(el => {
        if (!el) return;
        const text = el.innerText || el.textContent || '';
        const match = text.match(/(\$|¥|HK\$|NT\$)?\s*(\d+(\.\d+)?)/);
        if (match) {
          const oldPrice = parseFloat(match[2]);
          const newPrice = (oldPrice * rate).toFixed(2);
          el.innerHTML = `<span style="text-decoration:line-through;color:#94a3b8;font-size:0.85em;margin-right:4px;">${match[0]}</span><span style="color:#e11d48;font-weight:bold;font-size:1.1em;">$ ${newPrice}</span>`;
        }
      });
      showToast(`✨ 已为 ${els.length} 个价格节点计算折扣`);
    },
    exportCSV: () => exportSelectedToCSV(),
    extractArticle: (opts) => extractArticleFromPage(opts || {}),
    exportStructuredData: (opts) => exportStructuredDataFromPage(opts || {}),
    getDomSnapshot: (opts) => buildLiveDomSnapshot(opts || {})
  };

  const styleId = 'browserbot-highlight-styles';
  if (!document.getElementById(styleId)) {
    const styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.textContent = `
      .browserbot-hovered { outline: 2.5px dashed #6366f1 !important; outline-offset: 2px !important; cursor: crosshair !important; transition: outline 0.08s ease-in-out !important; }
      .browserbot-selected { outline: 3px solid #8b5cf6 !important; outline-offset: 2px !important; background-color: rgba(139, 92, 246, 0.28) !important; box-shadow: 0 0 14px rgba(139, 92, 246, 0.5) !important; transition: all 0.15s ease-in-out !important; }
      .browserbot-tag-focused { outline: 3.5px dashed #f97316 !important; outline-offset: 3px !important; background-color: rgba(249, 115, 22, 0.38) !important; box-shadow: 0 0 22px rgba(249, 115, 22, 0.9) !important; z-index: 99999 !important; transition: all 0.1s ease-in-out !important; }
      @keyframes browserbot-scope-breathe {
        0%, 100% {
          outline-color: rgba(99, 102, 241, 0.45) !important;
          box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.25) !important;
        }
        50% {
          outline-color: rgba(99, 102, 241, 0.95) !important;
          box-shadow: 0 0 22px 4px rgba(99, 102, 241, 0.45) !important;
        }
      }
      .browserbot-scope-preview {
        outline: 3px solid rgba(99, 102, 241, 0.85) !important;
        outline-offset: 3px !important;
        background-color: rgba(99, 102, 241, 0.12) !important;
        border-radius: 4px !important;
        animation: browserbot-scope-breathe 1.6s ease-in-out infinite !important;
        z-index: 99998 !important;
        transition: background-color 0.2s ease !important;
      }
      body.browserbot-picking-mode, body.browserbot-picking-mode * { cursor: crosshair !important; }
      .browserbot-toast-container { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 8px; z-index: 999999; pointer-events: none; }
      .browserbot-toast { background: #0f172a; color: #f8fafc; border: 1.5px solid #8b5cf6; padding: 10px 18px; border-radius: 8px; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; font-weight: 600; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4); pointer-events: auto; animation: toastIn 0.2s ease-out; transition: all 0.2s ease; }
      .browserbot-exit-float-btn { position: fixed; top: 16px; right: 16px; background: #f43f5e; color: #ffffff; border: 2px solid #ffffff; padding: 8px 16px; border-radius: 20px; font-family: system-ui, -apple-system, sans-serif; font-size: 12px; font-weight: 700; box-shadow: 0 8px 20px rgba(244, 63, 94, 0.4); z-index: 9999999; cursor: pointer; display: flex; align-items: center; gap: 6px; animation: toastIn 0.2s ease-out; }
      .browserbot-exit-float-btn:hover { background: #e11d48; transform: scale(1.05); }
      @keyframes toastIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

      /* In-page form submit confirmation (agent invoke gate — not side panel) */
      #browserbot-confirm-bar {
        position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
        z-index: 2147483646; max-width: min(560px, calc(100vw - 32px)); width: max-content;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        pointer-events: auto; animation: toastIn 0.2s ease-out;
      }
      #browserbot-confirm-bar .browserbot-confirm-inner {
        display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px;
        background: #0f172a; color: #f8fafc;
        border: 1.5px solid #a78bfa; border-radius: 12px;
        padding: 12px 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      }
      #browserbot-confirm-bar .browserbot-confirm-text { font-size: 13px; font-weight: 600; line-height: 1.4; flex: 1 1 180px; }
      #browserbot-confirm-bar .browserbot-confirm-detail { font-size: 11px; font-weight: 500; color: #cbd5e1; margin-top: 2px; }
      #browserbot-confirm-bar .browserbot-confirm-actions { display: flex; gap: 8px; flex-shrink: 0; }
      #browserbot-confirm-bar button {
        cursor: pointer; border-radius: 8px; font-size: 13px; font-weight: 700;
        padding: 8px 14px; border: 1.5px solid transparent; font-family: inherit;
      }
      #browserbot-confirm-bar button[data-pw-confirm="cancel"] {
        background: transparent; color: #e2e8f0; border-color: #475569;
      }
      #browserbot-confirm-bar button[data-pw-confirm="cancel"]:hover { background: #1e293b; }
      #browserbot-confirm-bar button[data-pw-confirm="ok"] {
        background: #7c3aed; color: #fff; border-color: #a78bfa;
      }
      #browserbot-confirm-bar button[data-pw-confirm="ok"]:hover { background: #6d28d9; }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ── Region screenshot picker (Win+Shift+S style) ─────────────────────────
  let regionCaptureActive = false;
  let regionReviewActive = false;
  let regionReviewBusy = false;
  let regionReviewDataUrl = '';
  let regionReviewFullDataUrl = '';
  let regionReviewCropPromise = null;
  let regionReviewRect = null;
  let regionFreezeViewport = null;
  let regionUiLang = 'zh';
  let regionRoot = null;
  let regionStart = null; // { x, y }
  let regionDragging = false;
  let regionIgnoreNextClick = false;
  let regionReviewPointerWired = false;

  function ensureRegionStyles() {
    if (document.getElementById('browserbot-region-styles')) return;
    const el = document.createElement('style');
    el.id = 'browserbot-region-styles';
    el.textContent = `
      #browserbot-region-root {
        position: fixed; inset: 0; z-index: 2147483646;
        cursor: crosshair !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      #browserbot-region-root, #browserbot-region-root * {
        cursor: crosshair !important;
        box-sizing: border-box;
      }
      #browserbot-region-freeze {
        position: absolute;
        inset: 0;
        z-index: 1;
        background-color: #050506;
        background-repeat: no-repeat;
        background-position: 0 0;
        background-size: 100% 100%;
        pointer-events: none;
      }
      #browserbot-region-dim {
        position: absolute; inset: 0; z-index: 2;
        background: rgba(5, 5, 6, 0.55);
        pointer-events: none;
      }
      #browserbot-region-box {
        position: absolute;
        border: 2px solid #ff6a00;
        background: transparent;
        box-shadow: 0 0 0 9999px rgba(5, 5, 6, 0.55);
        display: none;
        pointer-events: none;
        z-index: 3;
      }
      #browserbot-region-box.browserbot-region-active { display: block; }
      #browserbot-region-size {
        position: absolute; left: 0; top: -26px;
        background: #111113; color: #f4f3ef;
        border: 1px solid #ff6a00; border-radius: 4px;
        font-size: 11px; font-weight: 600;
        padding: 2px 8px; white-space: nowrap;
        pointer-events: none;
      }
      #browserbot-region-hint {
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: #111113; color: #f4f3ef;
        border: 1px solid #2a2a2e; border-radius: 999px;
        padding: 10px 18px; font-size: 13px; font-weight: 650;
        z-index: 4; pointer-events: none;
        white-space: nowrap;
      }
      #browserbot-region-root.browserbot-region-review {
        overflow: hidden;
        cursor: default !important;
      }
      #browserbot-region-root.browserbot-region-review,
      #browserbot-region-root.browserbot-region-review * {
        cursor: default !important;
      }
      #browserbot-region-root.browserbot-region-review [data-shot-action] {
        cursor: pointer !important;
      }
      #browserbot-region-toolbar {
        position: fixed;
        z-index: 10;
        isolation: isolate;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px;
        background: #111113;
        color: #f4f3ef;
        border: 1px solid #2a2a2e;
        border-radius: 10px;
        font-size: 12px;
        pointer-events: auto;
      }
      #browserbot-region-toolbar button {
        appearance: none;
        cursor: pointer !important;
        height: 30px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #3a3a3e;
        background: #1c1c1e;
        color: #f4f3ef;
        font: inherit;
        font-weight: 650;
      }
      #browserbot-region-toolbar button[data-shot-action="copy"] {
        background: #f4f3ef;
        color: #050506;
        border-color: #f4f3ef;
      }
      #browserbot-region-toolbar button:focus-visible {
        outline: 2px solid #ff6a00;
        outline-offset: 1px;
      }
      #browserbot-region-toolbar button:disabled,
      #browserbot-region-toolbar button.is-busy {
        opacity: 0.55;
        cursor: wait !important;
      }
    `;
    (document.head || document.documentElement).appendChild(el);
  }

  function regionReviewCopy(lang) {
    const en = lang === 'en';
    return {
      hintSelect: en ? 'Drag to select · Esc / right-click to cancel' : '拖拽选择截图区域 · Esc / 右键 取消',
      hintReview: en ? 'Choose what to do · Esc to close' : '选择如何处理这张截图 · Esc 关闭',
      ocr: 'OCR',
      qr: en ? 'QR' : '二维码',
      copy: en ? 'Copy' : '复制',
      ocrBusy: en ? 'Reading…' : '识别中…',
      qrBusy: en ? 'Scanning…' : '扫描中…',
      copied: en ? 'Copied to clipboard' : '已复制到剪贴板',
      textCopied: en ? 'Text copied' : '已复制文字',
      qrCopied: en ? 'QR copied' : '已复制二维码',
      ocrEmpty: en ? 'No text found' : '没有识别到文字',
      qrEmpty: en ? 'No QR code found' : '没有识别到二维码',
      ocrNeedKey: en
        ? 'OCR uses the current chat model. Add an inference key in Settings first.'
        : 'OCR 使用当前对话模型，请先在设置里填推理 Key',
      ocrFail: en ? 'Could not read text' : '识别失败',
      qrNeedApi: en ? 'Local QR scanning is not available here' : '此环境没有本地扫码能力'
    };
  }

  function refreshRegionLang() {
    try {
      chrome.storage.local.get(['app_lang'], (res) => {
        regionUiLang = res?.app_lang === 'en' ? 'en' : 'zh';
      });
    } catch (_) {}
  }

  function detachRegionSelectListeners() {
    document.removeEventListener('mousedown', onRegionMouseDown, true);
    document.removeEventListener('mousemove', onRegionMouseMove, true);
    document.removeEventListener('mouseup', onRegionMouseUp, true);
    document.removeEventListener('keydown', onRegionKeyDown, true);
    window.removeEventListener('blur', onRegionWindowBlur, true);
    document.removeEventListener('keydown', onRegionReviewKeyDown, true);
  }

  function stopRegionCaptureUi(reason) {
    if (!regionCaptureActive && !regionReviewActive && !regionRoot) return;
    regionCaptureActive = false;
    regionReviewActive = false;
    regionReviewBusy = false;
    regionReviewDataUrl = '';
    regionReviewFullDataUrl = '';
    regionReviewCropPromise = null;
    regionReviewRect = null;
    regionFreezeViewport = null;
    regionDragging = false;
    regionStart = null;
    regionIgnoreNextClick = false;
    regionReviewPointerWired = false;
    detachRegionSelectListeners();
    if (regionRoot) {
      try { regionRoot.remove(); } catch (_) {}
      regionRoot = null;
    }
  }

  function finishRegionCancel() {
    if (regionReviewActive) {
      stopRegionCaptureUi('review-cancel');
      return;
    }
    if (!regionCaptureActive) return;
    stopRegionCaptureUi('cancel');
    try {
      extSend({ action: 'browserbot_region_cancelled' });
    } catch (_) {}
  }

  function regionViewport() {
    return regionFreezeViewport || {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };
  }

  function finishRegionSelect(rect) {
    enterRegionReview(rect);
    const vp = regionViewport();
    extSend({
      action: 'browserbot_region_selected',
      region: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: vp.width,
        viewportHeight: vp.height,
        dpr: vp.dpr
      }
    });
  }

  function clampRegion(x0, y0, x1, y1) {
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const right = Math.min(window.innerWidth, Math.max(x0, x1));
    const bottom = Math.min(window.innerHeight, Math.max(y0, y1));
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    };
  }

  function updateRegionBox(rect) {
    if (!regionRoot) return;
    const box = regionRoot.querySelector('#browserbot-region-box');
    const dim = regionRoot.querySelector('#browserbot-region-dim');
    const sizeEl = regionRoot.querySelector('#browserbot-region-size');
    if (!box) return;
    if (!rect || rect.width < 1 || rect.height < 1) {
      box.classList.remove('browserbot-region-active');
      if (dim) dim.style.opacity = '1';
      return;
    }
    if (dim) dim.style.opacity = '0'; // box-shadow provides the dim cut-out
    box.classList.add('browserbot-region-active');
    box.style.left = rect.x + 'px';
    box.style.top = rect.y + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    if (sizeEl) {
      sizeEl.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
      // Keep size label inside viewport
      sizeEl.style.top = rect.y < 28 ? '4px' : '-26px';
      sizeEl.style.left = '0';
    }
  }

  function onRegionMouseDown(e) {
    if (!regionCaptureActive) return;
    if (e.button !== 0) {
      // Right / middle click cancel
      e.preventDefault();
      e.stopPropagation();
      finishRegionCancel();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    regionDragging = true;
    regionStart = { x: e.clientX, y: e.clientY };
    updateRegionBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  }

  function onRegionMouseMove(e) {
    if (!regionCaptureActive || !regionDragging || !regionStart) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = clampRegion(regionStart.x, regionStart.y, e.clientX, e.clientY);
    updateRegionBox(rect);
  }

  function onRegionMouseUp(e) {
    if (!regionCaptureActive || !regionDragging || !regionStart) return;
    e.preventDefault();
    e.stopPropagation();
    regionDragging = false;
    const rect = clampRegion(regionStart.x, regionStart.y, e.clientX, e.clientY);
    regionStart = null;
    // Too small = treat as cancel (like accidental click)
    if (rect.width < 4 || rect.height < 4) {
      finishRegionCancel();
      return;
    }
    finishRegionSelect(rect);
  }

  function onRegionKeyDown(e) {
    if (!regionCaptureActive) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      finishRegionCancel();
    }
  }

  function onRegionWindowBlur() {
    if (regionCaptureActive) finishRegionCancel();
  }

  function onRegionReviewKeyDown(e) {
    if (!regionReviewActive) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      stopRegionCaptureUi('review-esc');
    }
  }

  function placeReviewChrome(rect, viewport, chrome = {}) {
    const barW = Number(chrome.width) > 0 ? Number(chrome.width) : 220;
    const barH = Number(chrome.height) > 0 ? Number(chrome.height) : 40;
    const gap = Number(chrome.gap) >= 0 ? Number(chrome.gap) : 8;
    const vw = Number(viewport?.width) || 0;
    const vh = Number(viewport?.height) || 0;
    const rx = Number(rect?.x) || 0;
    const ry = Number(rect?.y) || 0;
    const rh = Number(rect?.height) || 0;
    const margin = 8;
    let left = rx;
    if (vw) {
      const maxLeft = Math.max(margin, vw - barW - margin);
      left = Math.min(Math.max(margin, left), maxLeft);
    } else if (left < margin) {
      left = margin;
    }
    const below = ry + rh + gap;
    const above = ry - barH - gap;
    const minTop = margin;
    const maxTop = vh ? Math.max(minTop, vh - barH - margin) : below;
    let top = below;
    if (vh && below + barH > vh - margin) {
      top = above >= minTop ? above : maxTop;
    }
    if (vh) top = Math.min(Math.max(minTop, top), maxTop);
    else if (top < minTop) top = minTop;
    return { left, top };
  }

  function placeRegionToolbar(rect) {
    const bar = regionRoot?.querySelector('#browserbot-region-toolbar');
    if (!bar || !rect) return;
    const barW = bar.offsetWidth || 220;
    const barH = bar.offsetHeight || 42;
    const pos = placeReviewChrome(rect, { width: window.innerWidth, height: window.innerHeight }, {
      width: barW,
      height: barH,
      gap: 8
    });
    bar.style.left = pos.left + 'px';
    bar.style.top = pos.top + 'px';
  }

  function setRegionReviewBusy(action, busy) {
    regionReviewBusy = busy;
    if (!regionRoot) return;
    const copy = regionReviewCopy(regionUiLang);
    regionRoot.querySelectorAll('[data-shot-action]').forEach((btn) => {
      const kind = btn.getAttribute('data-shot-action');
      const active = kind === action;
      btn.disabled = busy;
      btn.classList.toggle('is-busy', busy && active);
      if (active) {
        btn.textContent = busy
          ? (kind === 'ocr' ? copy.ocrBusy : copy.qrBusy)
          : (kind === 'ocr' ? copy.ocr : kind === 'qr' ? copy.qr : copy.copy);
      }
    });
  }

  function cropDataUrlToRegion(dataUrl, region) {
    return new Promise((resolve, reject) => {
      if (!dataUrl || !region) {
        reject(new Error('missing crop source'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const vw = region.viewportWidth > 0 ? region.viewportWidth : window.innerWidth;
          const vh = region.viewportHeight > 0 ? region.viewportHeight : window.innerHeight;
          const scaleX = img.naturalWidth / vw;
          const scaleY = img.naturalHeight / vh;
          let sx = Math.round(region.x * scaleX);
          let sy = Math.round(region.y * scaleY);
          let sw = Math.round(region.width * scaleX);
          let sh = Math.round(region.height * scaleY);
          sx = Math.max(0, Math.min(sx, img.naturalWidth - 1));
          sy = Math.max(0, Math.min(sy, img.naturalHeight - 1));
          sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
          sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));
          const canvas = document.createElement('canvas');
          canvas.width = sw;
          canvas.height = sh;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('2d context unavailable'));
            return;
          }
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('decode failed'));
      img.src = dataUrl;
    });
  }

  async function ensureRegionCrop() {
    if (regionReviewDataUrl) return regionReviewDataUrl;
    if (regionReviewCropPromise) return regionReviewCropPromise;
    if (!regionReviewFullDataUrl || !regionReviewRect) return '';
    const vp = regionViewport();
    const cropRegion = {
      ...regionReviewRect,
      viewportWidth: regionReviewRect.viewportWidth || vp.width,
      viewportHeight: regionReviewRect.viewportHeight || vp.height,
      dpr: regionReviewRect.dpr || vp.dpr
    };
    regionReviewCropPromise = cropDataUrlToRegion(regionReviewFullDataUrl, cropRegion)
      .then((url) => {
        regionReviewDataUrl = url;
        return url;
      })
      .finally(() => {
        regionReviewCropPromise = null;
      });
    return regionReviewCropPromise;
  }

  async function copyRegionImage() {
    const dataUrl = await ensureRegionCrop();
    if (!dataUrl || !navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const type = blob.type || 'image/png';
    await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
    return true;
  }

  async function copyRegionText(text) {
    const body = String(text || '').trim();
    if (!body) return false;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(body);
      return true;
    }
    return false;
  }

  async function handleRegionReviewAction(action) {
    if (!regionReviewActive || regionReviewBusy) return;
    const copy = regionReviewCopy(regionUiLang);
    try {
      await ensureRegionCrop();
    } catch (_) {
      showToast(copy.ocrFail);
      stopRegionCaptureUi('review-crop-fail');
      return;
    }
    if (!regionReviewDataUrl) {
      showToast(copy.ocrFail);
      stopRegionCaptureUi('review-no-crop');
      return;
    }
    if (action === 'copy') {
      try {
        await copyRegionImage();
        showToast(copy.copied);
      } catch (_) {
        showToast(copy.ocrFail);
      }
      stopRegionCaptureUi('review-copy');
      return;
    }
    if (action === 'qr') {
      setRegionReviewBusy('qr', true);
      try {
        if (typeof BarcodeDetector !== 'function') {
          showToast(copy.qrNeedApi);
          return;
        }
        const bitmap = await createImageBitmap(await (await fetch(regionReviewDataUrl)).blob());
        const detector = new BarcodeDetector({ formats: ['qr_code', 'aztec', 'data_matrix', 'pdf417'] });
        const values = [...new Set((await detector.detect(bitmap)).map((item) => String(item?.rawValue || '').trim()).filter(Boolean))];
        if (!values.length) {
          showToast(copy.qrEmpty);
          return;
        }
        await copyRegionText(values.join('\n'));
        showToast(copy.qrCopied);
      } catch (_) {
        showToast(copy.qrEmpty);
      } finally {
        setRegionReviewBusy('qr', false);
        stopRegionCaptureUi('review-qr');
      }
      return;
    }
    if (action !== 'ocr') {
      stopRegionCaptureUi('review-unknown');
      return;
    }
    setRegionReviewBusy('ocr', true);
    try {
      let found = null;
      if (typeof TextDetector === 'function') {
        try {
          const bitmap = await createImageBitmap(await (await fetch(regionReviewDataUrl)).blob());
          const text = [...new Set((await new TextDetector().detect(bitmap)).map((item) => String(item?.rawValue || '').trim()).filter(Boolean))].join('\n');
          if (text) found = { ok: true, text };
        } catch (_) {}
      }
      if (!found) {
        found = await chrome.runtime.sendMessage({
          action: 'browserbot_screenshot_ocr',
          dataUrl: regionReviewDataUrl,
          lang: regionUiLang
        });
      }
      if (found?.code === 'NEED_KEY') {
        showToast(copy.ocrNeedKey);
        return;
      }
      if (!found?.ok || !found.text) {
        showToast(found?.code === 'EMPTY' ? copy.ocrEmpty : copy.ocrFail);
        return;
      }
      await copyRegionText(found.text);
      extSend({
        action: 'clipboard_text_picked',
        text: found.text,
        textRaw: found.text,
        url: window.location.href,
        pageTitle: document.title,
        sourceKind: 'screenshot-ocr',
        openDrawer: true,
        toast: false
      });
      showToast(copy.textCopied);
    } catch (_) {
      showToast(copy.ocrFail);
    } finally {
      setRegionReviewBusy('ocr', false);
      stopRegionCaptureUi('review-ocr');
    }
  }

  function ensureRegionToolbar() {
    if (!regionRoot || regionRoot.querySelector('#browserbot-region-toolbar')) return;
    const copy = regionReviewCopy(regionUiLang);
    const bar = document.createElement('div');
    bar.id = 'browserbot-region-toolbar';
    bar.innerHTML =
      `<button type="button" data-shot-action="ocr">${copy.ocr}</button>` +
      `<button type="button" data-shot-action="qr">${copy.qr}</button>` +
      `<button type="button" data-shot-action="copy">${copy.copy}</button>`;
    regionRoot.appendChild(bar);
  }

  function onRegionReviewClick(e) {
    if (!regionReviewActive) return;
    if (regionIgnoreNextClick) {
      regionIgnoreNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const btn = e.target.closest?.('[data-shot-action]');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      void handleRegionReviewAction(btn.getAttribute('data-shot-action'));
      return;
    }
    if (e.target.closest?.('#browserbot-region-toolbar')) return;
    stopRegionCaptureUi('review-dismiss');
  }

  function onRegionReviewContext(e) {
    if (!regionReviewActive) return;
    e.preventDefault();
    e.stopPropagation();
    stopRegionCaptureUi('review-right');
  }

  function wireRegionReviewPointer() {
    if (regionReviewPointerWired || !regionRoot) return;
    regionReviewPointerWired = true;
    regionRoot.addEventListener('click', onRegionReviewClick);
    regionRoot.addEventListener('contextmenu', onRegionReviewContext);
  }

  function enterRegionReview(rect) {
    if (!regionRoot || !rect) return;
    regionCaptureActive = false;
    regionReviewActive = true;
    regionReviewBusy = false;
    regionDragging = false;
    regionStart = null;
    regionReviewRect = {
      ...rect,
      viewportWidth: regionViewport().width,
      viewportHeight: regionViewport().height,
      dpr: regionViewport().dpr
    };
    detachRegionSelectListeners();
    const hint = regionRoot.querySelector('#browserbot-region-hint');
    if (hint) hint.hidden = true;
    const dim = regionRoot.querySelector('#browserbot-region-dim');
    if (dim) dim.style.opacity = '0';
    updateRegionBox(rect);
    regionRoot.classList.add('browserbot-region-review');
    ensureRegionToolbar();
    placeRegionToolbar(rect);
    regionIgnoreNextClick = true;
    document.addEventListener('keydown', onRegionReviewKeyDown, true);
    wireRegionReviewPointer();
    requestAnimationFrame(() => placeRegionToolbar(rect));
    void ensureRegionCrop().catch(() => {});
  }

  function showRegionReview(payload) {
    const rect = payload?.region || regionReviewRect;
    if (regionRoot && regionReviewFullDataUrl && rect && rect.width >= 1 && rect.height >= 1) {
      enterRegionReview(rect);
      return { status: 'reviewing' };
    }
    stopRegionCaptureUi('bad-review');
    return { status: 'error' };
  }

  function startRegionCaptureUi(payload) {
    if (window !== window.top) {
      return { status: 'ignored', reason: 'not-top' };
    }
    const fullDataUrl = payload?.fullDataUrl || '';
    if (!fullDataUrl || typeof fullDataUrl !== 'string' || !fullDataUrl.startsWith('data:image')) {
      return { status: 'error', message: 'missing freeze bitmap' };
    }
    const mount = document.body || document.documentElement;
    if (!mount) return { status: 'error', message: 'no document body' };

    refreshRegionLang();
    ensureRegionStyles();
    stopRegionCaptureUi('restart');

    const copy = regionReviewCopy(regionUiLang);
    regionRoot = document.createElement('div');
    regionRoot.id = 'browserbot-region-root';
    regionRoot.setAttribute('data-browserbot', 'region-capture');
    regionRoot.innerHTML =
      '<div id="browserbot-region-freeze"></div>' +
      '<div id="browserbot-region-dim"></div>' +
      '<div id="browserbot-region-box"><span id="browserbot-region-size"></span></div>' +
      `<div id="browserbot-region-hint">${copy.hintSelect}</div>`;
    const freeze = regionRoot.querySelector('#browserbot-region-freeze');
    freeze.style.backgroundImage = `url("${fullDataUrl}")`;
    mount.appendChild(regionRoot);

    regionReviewFullDataUrl = fullDataUrl;
    regionReviewDataUrl = '';
    regionReviewRect = null;
    regionFreezeViewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    };
    regionCaptureActive = true;
    regionReviewActive = false;
    regionDragging = false;
    regionStart = null;
    regionIgnoreNextClick = false;

    document.addEventListener('mousedown', onRegionMouseDown, true);
    document.addEventListener('mousemove', onRegionMouseMove, true);
    document.addEventListener('mouseup', onRegionMouseUp, true);
    document.addEventListener('keydown', onRegionKeyDown, true);
    window.addEventListener('blur', onRegionWindowBlur, true);

    return { status: 'started' };
  }

  function cleanDOMText(rawText) {
    if (!rawText) return '';
    return rawText.replace(/data:image\/[a-zA-Z]+;base64,[^"'\s]+/g, '[BASE64_IMAGE]').replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '').replace(/\s+/g, ' ').trim();
  }

  function showToast(msg) {
    let container = document.querySelector('.browserbot-toast-container');
    if (!container) { container = document.createElement('div'); container.className = 'browserbot-toast-container'; document.body.appendChild(container); }
    const toast = document.createElement('div'); toast.className = 'browserbot-toast'; toast.innerText = msg; container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-10px)'; setTimeout(() => toast.remove(), 200); }, 3000);
  }

  function showExitFloatButton() {
    removeExitFloatButton();
    const btn = document.createElement('button'); btn.className = 'browserbot-exit-float-btn'; btn.innerHTML = `退出点选 (Esc)`;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stopPicker(); notifyPickerState(); showToast('已退出点选'); });
    document.body.appendChild(btn);
  }
  function removeExitFloatButton() { const existing = document.querySelector('.browserbot-exit-float-btn'); if (existing) existing.remove(); }

  function matchCustomShortcut(e, shortcutStr) {
    if (!shortcutStr) return false;
    const parts = shortcutStr.split('+').map(p => p.trim().toLowerCase());
    const hasAlt = parts.includes('alt'), hasCtrl = parts.includes('ctrl') || parts.includes('control'), hasShift = parts.includes('shift');
    const keyPart = parts.find(p => !['alt', 'ctrl', 'control', 'shift'].includes(p));
    if (hasAlt !== e.altKey || hasCtrl !== e.ctrlKey || hasShift !== e.shiftKey) return false;
    if (keyPart && (e.key.toLowerCase() === keyPart || e.code.toLowerCase() === `key${keyPart}`)) return true;
    return false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerActive) {
      if (linkOptBubble) { hideLinkOptionBubble(); return; }
      stopPicker(); notifyPickerState(); showToast('已退出点选'); return;
    }
    if (userCustomShortcut && matchCustomShortcut(e, userCustomShortcut)) {
      e.preventDefault(); e.stopPropagation();
      if (pickerActive) { stopPicker(); showToast('已退出点选'); }
      else { startPicker(); showToast('已开启点选'); }
      notifyPickerState();
    }
  }, true);

  function queryDeepAll(root, selector) {
    const out = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      if (selector) { try { out.push(...node.querySelectorAll(selector)); } catch { /* invalid selector */ } }
      let all = [];
      try { all = node.querySelectorAll('*'); } catch { all = []; }
      for (const el of all) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }
  function composeShadowPath(el) {
    const hosts = [];
    let node = el;
    while (node) {
      const root = node.getRootNode?.();
      if (root && root !== document && root.host) {
        const host = root.host;
        hosts.unshift(host.getAttribute?.('data-testid') ? `[data-testid="${host.getAttribute('data-testid')}"]` : host.id ? `#${host.id}` : host.tagName.toLowerCase());
        node = host;
      } else break;
    }
    return hosts.length ? hosts.join(' >> ') : '';
  }
  function generateSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      const rawId = String(el.id);
      const idSel = /^[A-Za-z_][\w-]*$/.test(rawId) ? `#${rawId}` : '';
      if (idSel) {
        try {
          if (document.querySelectorAll(idSel).length === 1) return idSel;
        } catch {
          /* duplicate or invalid */
        }
      }
    }
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('browserbot-'));
      if (classes.length > 0) selector += `.${classes.slice(0, 2).join('.')}`;
    }
    let parent = el.parentElement;
    if (parent && parent.nodeType === 1) {
      const siblings = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      if (siblings.length > 1) { const index = siblings.indexOf(el) + 1; selector += `:nth-of-type(${index})`; }
      const parentSelector = generateSelector(parent);
      if (parentSelector) selector = `${parentSelector} > ${selector}`;
    }
    return selector;
  }

  function locatorFingerprint(el, rawText, src, href) {
    return {
      tag: String(el?.tagName || '').toLowerCase(),
      src: String(src || ''), href: String(href || ''),
      text: String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    };
  }

  function captureFacets(el, rawText) {
    const media = [], links = [];
    const addMedia = (node) => {
      const src = contextSrcOf(node);
      if (src && !media.some((row) => row.src === src)) media.push({ src, alt: contextAltOf(node), href: contextDirectHrefOf(node) });
    };
    const addLink = (node) => {
      const href = contextDirectHrefOf(node);
      if (href && !links.some((row) => row.href === href)) links.push({ href, text: cleanDOMText(node.innerText || node.textContent || '').slice(0, 160) });
    };
    addMedia(el); addLink(el);
    try {
      for (const node of Array.from(el.querySelectorAll?.('img, picture, video, svg') || []).slice(0, 8)) addMedia(node);
      for (const node of Array.from(el.querySelectorAll?.('a[href]') || []).slice(0, 8)) addLink(node);
    } catch { /* descendants are optional */ }
    return { text: rawText, media, links };
  }

  function handleMouseMove(e) {
    if (!pickerActive) return;
    if (e.target?.closest?.('.browserbot-scope-option-bubble')) return;
    const snapped = pierceAndSnapWithCandidates(document, e.clientX, e.clientY);
    const element = snapped?.element || document.elementFromPoint(e.clientX, e.clientY);
    if (!element || element.classList.contains('browserbot-exit-float-btn')) return;
    if (hoveredElement === element && scopeOptionBubble) return;
    if (hoveredElement && hoveredElement !== element) hoveredElement.classList.remove('browserbot-hovered');
    hoveredElement = element;
    if (!hoveredElement.classList.contains('browserbot-selected')) hoveredElement.classList.add('browserbot-hovered');
    hoveredCandidates = snapped?.candidates || [];
    showScopeOptionBubble(e, hoveredCandidates);
  }

  function captureCandidate(element, snapped, e) {
    if (!element || element.classList.contains('browserbot-exit-float-btn')) return;
    e.preventDefault(); e.stopPropagation();

    const existingIndex = selectedElements.findIndex((item) => item.element === element);
    if (existingIndex !== -1) {
      element.classList.remove('browserbot-selected');
      element.classList.remove('browserbot-hovered');
      selectedElements.splice(existingIndex, 1);
    } else {
      const href = contextHrefOf(element);
      const src = contextSrcOf(element);
      const rawText = contextTextPreservingBlocks(element);
      const fullText = cleanDOMText(rawText);
      const kind = snapped?.kind || classifyContextKind({
        tag: element.tagName.toLowerCase(),
        src,
        href,
        text: fullText
      });
      if (
        isClipboardTextPick({
          kind,
          kindHint: kind,
          tag: element.tagName.toLowerCase(),
          src,
          href,
          text: fullText
        })
      ) {
        const text = clipClipboardText(fullText);
        if (text) {
          extSend({
            action: 'clipboard_text_picked',
            text,
            textRaw: rawText,
            url: window.location.href,
            pageTitle: document.title
          });
          element.classList.remove('browserbot-hovered');
          element.classList.add('browserbot-selected');
          setTimeout(() => {
            try {
              element.classList.remove('browserbot-selected');
            } catch (_) {}
          }, 280);
        }
        return;
      }
      element.classList.remove('browserbot-hovered');
      element.classList.add('browserbot-selected');
      selectedElements.push({
        element: element,
        selector: generateSelector(element),
        tag: element.tagName.toLowerCase(),
        text: fullText,
        src,
        href,
        kind,
        scope: snapped?.scope || 'element',
        facets: captureFacets(element, rawText),
        locatorFingerprint: locatorFingerprint(element, rawText, src, href),
        /** Authorization anchor source: human wand click */
        source: 'user'
      });
      if (href && /^https?:/i.test(href)) {
        showLinkOptionBubble(e, element, href);
      }
    }
    refreshHighlightClasses(); notifySidePanel();
  }

  function handleClick(e) {
    if (!pickerActive || e.target?.closest?.('.browserbot-link-opt-bubble')) return;
    hideLinkOptionBubble();
    const snapped = pierceAndSnapWithCandidates(document, e.clientX, e.clientY);
    captureCandidate(snapped?.element, snapped, e);
  }

  function hideLinkOptionBubble() {
    if (linkOptBubble && linkOptBubble.parentNode) linkOptBubble.remove();
    linkOptBubble = null;
  }

  function hideScopeOptionBubble() {
    document.querySelectorAll('.browserbot-scope-preview').forEach((el) => el.classList.remove('browserbot-scope-preview'));
    if (scopeOptionBubble?.parentNode) scopeOptionBubble.remove();
    scopeOptionBubble = null;
  }

  function showScopeOptionBubble(e, candidates) {
    hideScopeOptionBubble();
    const choices = (candidates || []).filter((c) => c?.element && c.element !== hoveredElement);
    if (!choices.length) return;
    const bubble = document.createElement('div');
    bubble.className = 'browserbot-link-opt-bubble browserbot-scope-option-bubble';
    Object.assign(bubble.style, { position: 'fixed', left: `${Math.max(4, Math.min(window.innerWidth - 220, e.clientX + 8))}px`, top: `${Math.max(4, Math.min(window.innerHeight - 38, e.clientY + 8))}px`, zIndex: '999999', background: '#334155', color: '#fff', padding: '4px', borderRadius: '5px', display: 'flex', gap: '3px', pointerEvents: 'auto' });
    for (const candidate of choices) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = scopeOptionLabel(candidate);
      Object.assign(button.style, { border: 0, borderRadius: '3px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px', fontWeight: '700', padding: '3px 6px' });
      button.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        if (hoveredElement) hoveredElement.classList.remove('browserbot-hovered');
        hoveredElement = candidate.element;
        hoveredElement.classList.add('browserbot-hovered');
        captureCandidate(candidate.element, candidate, event);
        hideScopeOptionBubble();
      });
      button.addEventListener('mouseenter', () => candidate.element.classList.add('browserbot-scope-preview'));
      button.addEventListener('mouseleave', () => candidate.element.classList.remove('browserbot-scope-preview'));
      button.addEventListener('focus', () => candidate.element.classList.add('browserbot-scope-preview'));
      button.addEventListener('blur', () => candidate.element.classList.remove('browserbot-scope-preview'));
      bubble.appendChild(button);
    }
    bubble.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    document.body.appendChild(bubble); scopeOptionBubble = bubble;
  }

  function scopeOptionLabel(candidate) {
    if (pickerLang !== 'en') return candidate.label || '选择范围';
    return ({ cell: 'Cell', row: 'This row', table: 'Whole table', media: 'Image', link: 'Link', paragraph: 'This paragraph', card: 'Whole card', button: 'Button', element: 'Text' })[candidate.scope] || 'Select';
  }

  function styleLinkOptChip(el, extra = {}) {
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.border = 'none';
    el.style.background = 'transparent';
    el.style.color = '#ffffff';
    el.style.fontSize = '11px';
    el.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    el.style.fontWeight = 'bold';
    el.style.padding = '4px 8px';
    el.style.borderRadius = '3px';
    el.style.cursor = 'pointer';
    el.style.textAlign = 'left';
    el.style.lineHeight = '1.3';
    Object.assign(el.style, extra);
  }

  function showLinkOptionBubble(e, element, href) {
    hideLinkOptionBubble();
    const bubble = document.createElement('div');
    bubble.className = 'browserbot-link-opt-bubble';
    bubble.style.position = 'absolute';
    bubble.style.left = `${Math.max(4, window.scrollX + (e.clientX || 0) + 8)}px`;
    bubble.style.top = `${Math.max(4, window.scrollY + (e.clientY || 0) + 8)}px`;
    bubble.style.zIndex = '999999';
    bubble.style.background = '#8b5cf6';
    bubble.style.color = '#ffffff';
    bubble.style.fontSize = '11px';
    bubble.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    bubble.style.fontWeight = 'bold';
    bubble.style.padding = '4px';
    bubble.style.borderRadius = '4px';
    bubble.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.35)';
    bubble.style.display = 'flex';
    bubble.style.flexDirection = 'column';
    bubble.style.gap = '2px';
    bubble.style.minWidth = '96px';
    bubble.style.pointerEvents = 'auto';

    const mk = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      styleLinkOptChip(btn);
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(255, 255, 255, 0.25)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
      });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
        hideLinkOptionBubble();
      });
      return btn;
    };

    const title = cleanDOMText((element.innerText || element.textContent || '').substring(0, 160));
    bubble.appendChild(mk('下载图片', () => {
      const urls = extractImageUrlsFromContainer(element);
      if (!urls.length && /\.(jpe?g|png|gif|webp|svg|avif|bmp)(\?|#|$)/i.test(href)) urls.push(href);
      if (!urls.length) {
        showToast('⚠️ 选中的元素中未找到可下载图片（可点选点选 img 或图片容器）');
        return;
      }
      urls.forEach((u, i) => clickDownload(`image_${i + 1}_${Date.now()}`, u));
      showToast(`📷 正在下载选中的 ${urls.length} 张图片...`);
    }));
    bubble.appendChild(mk('复制链接', () => {
      const done = () => showToast('✅ 已复制 1 条链接');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(href).then(done).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = href;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          done();
        });
      } else {
        showToast('✅ 已复制 1 条链接');
      }
    }));
    bubble.appendChild(mk('链接入组', () => {
      extSend({
        action: 'page_url_into_group',
        url: href,
        title,
        addedBy: 'page-click'
      });
      showToast('已加入当前组');
    }));

    bubble.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    document.body.appendChild(bubble);
    linkOptBubble = bubble;
  }

  function refreshHighlightClasses() {
    document.querySelectorAll('.browserbot-element-badge').forEach(b => b.remove());
    const keep = new Set(selectedElements.map((item) => item.element).filter(Boolean));
    document.querySelectorAll('.browserbot-selected').forEach((el) => {
      if (!keep.has(el)) el.classList.remove('browserbot-selected');
    });

    selectedElements.forEach((item, idx) => {
      if (item && item.element) {
        item.element.classList.add('browserbot-selected');
        item.element.classList.remove('browserbot-hovered');

        try {
          const rect = item.element.getBoundingClientRect();
          const badge = document.createElement('div');
          badge.className = 'browserbot-element-badge';
          const labelSpan = document.createElement('span');
          labelSpan.textContent = badgeLabel(item);
          const xBtn = document.createElement('span');
          xBtn.className = 'browserbot-badge-x';
          xBtn.title = '点击取消选中该元素';
          xBtn.textContent = '✖';
          badge.append(labelSpan, xBtn);

          badge.style.position = 'absolute';
          badge.style.top = `${Math.max(4, window.scrollY + rect.top - 24)}px`;
          badge.style.left = `${Math.max(4, window.scrollX + rect.left)}px`;
          badge.style.zIndex = '999998';
          badge.style.background = '#8b5cf6';
          badge.style.color = '#ffffff';
          badge.style.fontSize = '11px';
          badge.style.fontFamily = 'system-ui, -apple-system, sans-serif';
          badge.style.fontWeight = 'bold';
          badge.style.padding = '2px 8px';
          badge.style.borderRadius = '4px';
          badge.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.35)';
          badge.style.display = 'inline-flex';
          badge.style.alignItems = 'center';
          badge.style.gap = '6px';
          badge.style.pointerEvents = 'auto';

          xBtn.style.cursor = 'pointer';
          xBtn.style.background = 'rgba(255, 255, 255, 0.25)';
          xBtn.style.padding = '1px 5px';
          xBtn.style.borderRadius = '3px';
          xBtn.style.lineHeight = '1';
          xBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            removeSingleElementByIndex(idx);
          });

          document.body.appendChild(badge);
        } catch (e) {
          console.warn('Failed to attach element badge:', e);
        }
      }
    });
  }

  function fallbackBadgeLabel(item) {
    const kind = classifySelectionKind(item);
    if (kind === 'image') return '图片';
    if (kind === 'table') return '表格';
    if (kind === 'text') return '文字';
    if (kind === 'video') return '视频';
    if (kind === 'link') return '链接';
    if (kind === 'vector') return '矢量';
    if (kind === 'screenshot') return '截图';
    return '文字';
  }

  function badgeLabel(item) {
    const s = String(item?.displayLabel || '').trim();
    return s || fallbackBadgeLabel(item);
  }

  function matchWorkspaceLabel(item, labels) {
    const list = Array.isArray(labels) ? labels : [];
    const sel = String(item?.selector || '');
    if (sel) {
      const bySel = list.find((l) => String(l.selector || '') === sel);
      if (bySel) return bySel;
    }
    const src = srcIdentity(item?.src || '');
    if (!src) return null;
    const bySrc = list.filter((l) => srcIdentity(l.src || '') === src);
    return bySrc.length === 1 ? bySrc[0] : null;
  }

  function applyWorkspaceLabels(labels) {
    const list = Array.isArray(labels) ? labels : [];
    if (!list.length || !selectedElements.length) return 0;
    let n = 0;
    for (const item of selectedElements) {
      const hit = matchWorkspaceLabel(item, list);
      if (!hit) continue;
      const next = String(hit.displayLabel || '').trim();
      if (!next) continue;
      item.displayLabel = next;
      if (hit.labelKind) item.labelKind = hit.labelKind;
      if (hit.labelN) item.labelN = hit.labelN;
      n += 1;
    }
    if (n) refreshHighlightClasses();
    return n;
  }

  function notifyPickerState() { extSend({ action: 'picker_state_changed', active: pickerActive }); }
  function notifySidePanel(extra = {}) {
    extSend({
      action: 'elements_updated',
      url: window.location.href,
      domain: window.location.hostname,
      pageTitle: document.title,
      count: selectedElements.length,
      cleared: extra.cleared === true,
      elements: selectedElements.map(item => ({
        selector: item.selector,
        tag: item.tag,
        text: item.text,
        src: item.src,
        href: item.href || '',
        kind: item.kind || classifySelectionKind(item),
        scope: item.scope || 'element',
        facets: item.facets || undefined,
        locatorFingerprint: item.locatorFingerprint || undefined,
        source: item.source || 'user'
      })),
      userCount: selectedElements.filter((i) => (i.source || 'user') === 'user').length,
      modelCount: selectedElements.filter((i) => i.source === 'model').length
    });
  }

  /**
   * Agent-driven picker selection (same store as user wand clicks).
   * mode: replace (default) | append
   */
  function agentSelectElementsFromRequest(request) {
    const mode = String(request.mode || 'replace').toLowerCase() === 'append' ? 'append' : 'replace';
    const max = Math.min(
      100,
      Math.max(1, typeof request.max === 'number' ? request.max : 80)
    );
    let selectorList = [];
    if (Array.isArray(request.selectors)) {
      selectorList = request.selectors.map((s) => String(s || '').trim()).filter(Boolean);
    }
    if (request.selector && String(request.selector).trim()) {
      selectorList.push(String(request.selector).trim());
    }
    selectorList = [...new Set(selectorList)].slice(0, 40);

    if (selectorList.length === 0) {
      return {
        status: 'error',
        message: 'Provide selector or selectors[] (CSS). Same selection store as user wand.',
        count: selectedElements.length
      };
    }

    if (mode === 'replace') {
      selectedElements.forEach((item) => {
        try {
          item.element?.classList?.remove('browserbot-selected', 'browserbot-hovered');
        } catch (_) {}
      });
      selectedElements = [];
      document.querySelectorAll('.browserbot-element-badge').forEach((b) => b.remove());
    }

    const added = [];
    const seen = new Set(
      selectedElements.map((item) => item.element).filter(Boolean)
    );

    for (const sel of selectorList) {
      if (selectedElements.length >= max) break;
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        return {
          status: 'error',
          message: `Invalid selector: ${sel} (${e.message || e})`,
          count: selectedElements.length
        };
      }
      for (const el of nodes) {
        if (selectedElements.length >= max) break;
        if (!el || el.nodeType !== 1) continue;
        if (seen.has(el)) continue;
        // Skip our own UI chrome
    if (
      el.id === 'browserbot-region-root' ||
      el.closest?.('#browserbot-region-root, .browserbot-link-opt-bubble') ||
      el.classList?.contains('browserbot-exit-float-btn') ||
      el.classList?.contains('browserbot-element-badge') ||
      el.classList?.contains('browserbot-link-opt-bubble')
    ) {
          continue;
        }
        seen.add(el);
        el.classList.add('browserbot-selected');
        el.classList.remove('browserbot-hovered');
        const entry = {
          element: el,
          selector: generateSelector(el),
          tag: el.tagName.toLowerCase(),
          text: cleanDOMText((el.innerText || el.textContent || '').substring(0, 500)),
          src: el.src || el.getAttribute?.('src') || '',
          /** Model append — not a user authorization anchor */
          source: 'model'
        };
        selectedElements.push(entry);
        added.push({
          selector: entry.selector,
          tag: entry.tag,
          text: (entry.text || '').slice(0, 80),
          src: (entry.src || '').slice(0, 120),
          source: 'model'
        });
      }
    }

    refreshHighlightClasses();
    notifySidePanel();

    const userCount = selectedElements.filter((i) => (i.source || 'user') === 'user').length;
    const modelCount = selectedElements.filter((i) => i.source === 'model').length;

    return {
      status: 'ok',
      mode,
      added: added.length,
      count: selectedElements.length,
      userCount,
      modelCount,
      elements: selectedElements.slice(0, 40).map((item, i) => ({
        index: i,
        selector: item.selector,
        tag: item.tag,
        text: (item.text || '').slice(0, 120),
        src: (item.src || '').slice(0, 160),
        source: item.source || 'user'
      })),
      message:
        added.length > 0
          ? `Selected ${added.length} model element(s); total ${selectedElements.length} (user:${userCount} model:${modelCount}). Prefer ScopeGrant for bulk authorization.`
          : `No new elements matched; total selection ${selectedElements.length}.`
    };
  }

  function blockPickerNavigation(e) {
    if (!pickerActive) return;
    if (e.target?.closest?.('.browserbot-exit-float-btn, .browserbot-element-badge, .browserbot-link-opt-bubble')) return;
    if (e.type !== 'mouseup') e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  function blockPickerKeyNav(e) {
    if (!pickerActive) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (t && t.closest && t.closest('a, [href], area, [role="link"]')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function startPicker() {
    if (workflowRecorder.active) { showToast('请先暂停录制 / Pause recording first'); return; }
    void pickReady;
    pickerActive = true; document.body.classList.add('browserbot-picking-mode');
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousedown', blockPickerNavigation, true);
    document.addEventListener('mouseup', blockPickerNavigation, true);
    document.addEventListener('auxclick', blockPickerNavigation, true);
    document.addEventListener('submit', blockPickerNavigation, true);
    document.addEventListener('keydown', blockPickerKeyNav, true);
    showExitFloatButton(); showToast('已开启点选 · 在页面上点击元素（不会跳转）');
  }
  function stopPicker() {
    pickerActive = false; document.body.classList.remove('browserbot-picking-mode');
    hideScopeOptionBubble();
    if (hoveredElement) { hoveredElement.classList.remove('browserbot-hovered'); hoveredElement = null; }
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('mousedown', blockPickerNavigation, true);
    document.removeEventListener('mouseup', blockPickerNavigation, true);
    document.removeEventListener('auxclick', blockPickerNavigation, true);
    document.removeEventListener('submit', blockPickerNavigation, true);
    document.removeEventListener('keydown', blockPickerKeyNav, true);
    hideLinkOptionBubble();
    removeExitFloatButton();
  }

  /** Elements currently wearing scope-preview breathing outline (proposal, not selection). */
  let scopePreviewElements = [];

  function clearScopePreview() {
    document.querySelectorAll('.browserbot-scope-preview').forEach((el) => {
      el.classList.remove('browserbot-scope-preview');
    });
    scopePreviewElements = [];
  }

  /**
   * Highlight proposed work targets with breathing outline; scroll first into view.
   * Does NOT mutate user selection anchors.
   * @param {{ candidates?: Array<{selector?: string, text?: string}>, selector?: string, reason?: string }} req
   */
  function showScopePreview(req) {
    clearScopePreview();
    const found = [];
    const list = Array.isArray(req?.candidates) ? req.candidates : [];
    for (const c of list) {
      let el = null;
      if (c?.selector) {
        try {
          el = document.querySelector(c.selector);
        } catch (_) {
          el = null;
        }
      }
      if (!el && c?.text) {
        // Best-effort text match among visible elements
        const needle = String(c.text).trim().slice(0, 40);
        if (needle) {
          const all = document.querySelectorAll('a, li, article, div, section, h1, h2, h3, h4, span');
          for (const node of all) {
            const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.includes(needle)) {
              el = node;
              break;
            }
          }
        }
      }
      if (el && !found.includes(el)) found.push(el);
    }
    if (!found.length && req?.selector) {
      try {
        document.querySelectorAll(req.selector).forEach((el) => {
          if (found.length < 40 && !found.includes(el)) found.push(el);
        });
      } catch (_) {}
    }
    found.forEach((el) => el.classList.add('browserbot-scope-preview'));
    scopePreviewElements = found;
    if (found[0] && typeof found[0].scrollIntoView === 'function') {
      try {
        found[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } catch (_) {
        try {
          found[0].scrollIntoView(true);
        } catch (__) {}
      }
    }
    if (found.length) {
      showToast(
        `✨ Agent 想处理这 ${found.length} 项 · 请在侧栏同意或拒绝` +
          (req?.reason ? ` · ${String(req.reason).slice(0, 40)}` : '')
      );
    }
  }

  function clearSelection() {
    document.querySelectorAll('.browserbot-selected, .browserbot-hovered, .browserbot-tag-focused').forEach(el => { el.classList.remove('browserbot-selected'); el.classList.remove('browserbot-hovered'); el.classList.remove('browserbot-tag-focused'); });
    document.querySelectorAll('.browserbot-element-badge').forEach(b => b.remove());
    selectedElements = []; hoveredElement = null; notifySidePanel({ cleared: true }); showToast('🧹 已清除选中状态');
  }

  function removeSingleElementByIndex(index) {
    if (index >= 0 && index < selectedElements.length) {
      const item = selectedElements[index];
      if (item && item.element) {
        item.element.classList.remove('browserbot-selected');
        item.element.classList.remove('browserbot-hovered');
        item.element.classList.remove('browserbot-tag-focused');
      }
      selectedElements.splice(index, 1);
      refreshHighlightClasses();
      notifySidePanel();
    }
  }

  function setElementTagHoverFocus(index, isHovered) {
    if (index >= 0 && index < selectedElements.length) {
      const item = selectedElements[index];
      if (item && item.element) {
        if (isHovered) item.element.classList.add('browserbot-tag-focused');
        else item.element.classList.remove('browserbot-tag-focused');
      }
    }
  }

  function isLiveElement(el) {
    return !!(el && el.nodeType === 1 && el.isConnected !== false);
  }

  function srcIdentity(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    try {
      const x = new URL(s, location.href);
      return `${x.origin}${x.pathname}`;
    } catch {
      return s.split('?')[0];
    }
  }

  function findElementForItem(item) {
    if (!item) return null;
    const fingerprint = item.locatorFingerprint || item.locator?.fingerprint;
    if (fingerprint) {
      const selector = String(item.selector || item.locator?.css || '').trim();
      const candidate = isLiveElement(item.element) ? item.element : null;
      if (!selector && !candidate) return null;
      try {
        const el = candidate || document.querySelector(selector);
        if (!isLiveElement(el)) return null;
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const src = String(contextSrcOf(el) || '');
        const href = String(contextHrefOf(el) || '');
        const has = (key) => Object.prototype.hasOwnProperty.call(fingerprint, key);
        const same = (!has('tag') || String(el.tagName || '').toLowerCase() === String(fingerprint.tag).toLowerCase()) &&
          (!has('src') || src === String(fingerprint.src)) &&
          (!has('href') || href === String(fingerprint.href)) &&
          (!has('text') || text === String(fingerprint.text));
        return same ? el : null;
      } catch { return null; }
    }
    if (isLiveElement(item.element)) return item.element;
    const wantSrc = srcIdentity(item.src || item.preview?.src || '');
    if (wantSrc) {
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (!isLiveElement(img)) continue;
        const cands = [img.currentSrc, img.src, img.getAttribute('src')];
        if (cands.some((c) => c && srcIdentity(c) === wantSrc)) return img;
      }
    }
    const selector = String(item.selector || '').trim();
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (isLiveElement(el)) {
          if (!wantSrc) return el;
          const cands = [el.currentSrc, el.src, el.getAttribute?.('src')];
          if (cands.some((c) => c && srcIdentity(c) === wantSrc)) return el;
        }
      } catch (_) {}
    }
    const needle = String(item.text || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    if (needle) {
      const tag = String(item.tag || '').toLowerCase().replace(/[<>]/g, '');
      let nodes;
      try {
        nodes = tag ? document.querySelectorAll(tag) : document.querySelectorAll('table, tr, td, a, li, article, div, section, span');
      } catch (_) {
        nodes = document.querySelectorAll('table, tr, td, a, li, article, div, section, span');
      }
      for (const node of nodes) {
        if (!isLiveElement(node)) continue;
        const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.includes(needle)) return node;
      }
    }
    return null;
  }

  function rebindDetachedSelections() {
    if (!selectedElements.length) return 0;
    let rebound = 0;
    selectedElements.forEach((item) => {
      if (isLiveElement(item.element)) return;
      const el = findElementForItem(item);
      if (el) {
        item.element = el;
        rebound += 1;
      }
    });
    if (rebound) refreshHighlightClasses();
    return rebound;
  }

  function focusElementOnPage(el) {
    if (!isLiveElement(el) || typeof el.scrollIntoView !== 'function') return false;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_) {
      try { el.scrollIntoView(true); } catch (__) {}
    }
    el.classList.add('browserbot-tag-focused');
    setTimeout(() => el.classList.remove('browserbot-tag-focused'), 2000);
    return true;
  }

  function scrollToElementByIndex(index) {
    rebindDetachedSelections();
    if (index >= 0 && index < selectedElements.length) {
      const item = selectedElements[index];
      if (item && focusElementOnPage(item.element)) return true;
    }
    return false;
  }

  function revealItemNow(req = {}) {
    rebindDetachedSelections();
    if (req.localIndex != null && scrollToElementByIndex(req.localIndex)) return true;
    const selector = String(req.selector || '');
    let index = -1;
    if (selector) {
      index = selectedElements.findIndex((item) => String(item.selector || '') === selector);
    }
    if (index >= 0 && scrollToElementByIndex(index)) return true;
    const el = findElementForItem({
      selector,
      text: req.text || '',
      tag: req.tag || ''
    });
    return !!(el && focusElementOnPage(el));
  }

  async function revealSelectionWithRetry(req = {}, timeoutMs = 6500) {
    const start = Date.now();
    if (revealItemNow(req)) return 'scrolled';
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 220));
      if (revealItemNow(req)) return 'scrolled';
    }
    showToast('⚠️ 该元素不在当前页面视图中');
    return 'not_found';
  }

  let rebindDetachedTimer = 0;
  function scheduleRebindDetachedSelections() {
    if (!selectedElements.length) return;
    if (rebindDetachedTimer) window.clearTimeout(rebindDetachedTimer);
    rebindDetachedTimer = window.setTimeout(() => {
      rebindDetachedTimer = 0;
      rebindDetachedSelections();
    }, 280);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRebindDetachedSelections();
  });
  window.addEventListener('hashchange', () => scheduleRebindDetachedSelections());
  window.addEventListener('popstate', () => scheduleRebindDetachedSelections());
  try {
    const rebindMo = new MutationObserver(() => {
      if (!selectedElements.length) return;
      if (selectedElements.every((item) => isLiveElement(item.element))) return;
      scheduleRebindDetachedSelections();
    });
    rebindMo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  function copySelectedTextToClipboard() {
    if (selectedElements.length === 0) { showToast('⚠️ 未选中任何元素'); return; }
    const combinedText = selectedElements.map((item) => `[${badgeLabel(item)}]\n${item.text.replace(/\n/g, ' ')}`).join('\n\n---\n\n');
    try {
      const textarea = document.createElement('textarea'); textarea.value = combinedText;
      textarea.style.position = 'fixed'; textarea.style.left = '-9999px'; document.body.appendChild(textarea);
      textarea.select(); document.execCommand('copy'); document.body.removeChild(textarea);
      showToast(`✅ 已成功复制 ${selectedElements.length} 个元素的文本到剪贴板！`);
    } catch (err) {
      navigator.clipboard.writeText(combinedText).then(() => showToast(`✅ 已复制文本`)).catch(e => showToast(`❌ 复制失败`));
    }
  }

  function parseBestSrcset(srcset, opts = {}) {
    const api = pick();
    if (api?.pickBestSrcsetUrl) return api.pickBestSrcsetUrl(srcset, opts);
    if (!srcset) return null;
    const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    if (opts.preferAvif) {
      const avif = parts.filter((u) => /\.avif(\?|#|$)/i.test(u));
      const pool = avif.length ? avif : parts;
      return pool.length ? pool[pool.length - 1] : null;
    }
    const nonAvif = parts.filter((u) => !/\.avif(\?|#|$)/i.test(u));
    const pool = nonAvif.length ? nonAvif : parts;
    return pool.length ? pool[pool.length - 1] : null;
  }

  async function getCanvasDataUrlWithCrossOrigin(url, mode) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = mode;
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 500; canvas.height = img.naturalHeight || 500;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl && dataUrl.length > 50 ? dataUrl : null);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function fetchUrlAsDataUrlInTabContext(rawUrl) {
    if (!rawUrl) return null;
    if (rawUrl.startsWith('data:image')) return rawUrl;

    let absUrl;
    try { absUrl = new URL(rawUrl, window.location.href).href; } catch (e) { return rawUrl; }

    try {
      const res1 = await fetch(absUrl, { mode: 'cors', credentials: 'omit' });
      if (res1.ok && res1.headers.get('content-type')?.includes('image')) {
        const blob = await res1.blob();
        if (blob.size > 100) return await new Promise(r => { const reader = new FileReader(); reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
      }
    } catch (e) {}

    try {
      const res2 = await fetch(absUrl, { mode: 'cors', credentials: 'include' });
      if (res2.ok && res2.headers.get('content-type')?.includes('image')) {
        const blob = await res2.blob();
        if (blob.size > 100) return await new Promise(r => { const reader = new FileReader(); reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
      }
    } catch (e) {}

    const c1 = await getCanvasDataUrlWithCrossOrigin(absUrl, "anonymous");
    if (c1) return c1;

    const c2 = await getCanvasDataUrlWithCrossOrigin(absUrl, "use-credentials");
    if (c2) return c2;

    return absUrl;
  }

  function isStrictImageFileUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      if (!lower.includes('/upload') && !lower.includes('format=auto') && !/\.(jpg|jpeg|png|webp|gif|avif|svg)(\?.*)?$/i.test(lower)) {
        return false;
      }
    }

    if (lower.includes('data:image/gif;base64,r0lgodlhaqabaiaaaaaaap///yh5baeaaaaalaaaaaabaaeaaaibraa7')) return false;

    if (lower.includes('white_heart') || lower.includes('wishlist') || lower.includes('clock.svg') || lower.includes('phone_icon') || lower.includes('down_arrow') || lower.includes('favorite.svg')) {
      return false;
    }

    return true;
  }

  function harvestAllUrlsFromNode(node) {
    if (!node || node.nodeType !== 1) return [];
    const urls = [];

    const attrs = [
      'data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url',
      'data-original-src', 'data-actualsrc', 'data-hi-res-src', 'src', 'currentSrc'
    ];

    attrs.forEach(attr => {
      let val = node.getAttribute ? node.getAttribute(attr) : node[attr];
      if (val && typeof val === 'string' && val.length > 5) {
        urls.push(val);
      }
    });

    if (node.tagName.toLowerCase() === 'a' && node.href) {
      if (/\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(node.href)) {
        urls.push(node.href);
      }
    }

    const srcset = node.getAttribute ? (node.getAttribute('srcset') || node.getAttribute('data-srcset')) : null;
    if (srcset) {
      const best = parseBestSrcset(srcset);
      if (best) urls.push(best);
    }

    try {
      const bgImg = window.getComputedStyle(node).backgroundImage;
      if (bgImg && bgImg.startsWith('url(')) {
        const match = bgImg.match(/url\(['"]?(.*?)['"]?\)/);
        if (match && match[1]) urls.push(match[1]);
      }
    } catch (e) {}

    return urls.filter(u => isStrictImageFileUrl(u));
  }

  function primaryImageUrlFromElement(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'picture') {
      const img = el.querySelector('img');
      return img ? primaryImageUrlFromElement(img) : '';
    }
    if (tag === 'img') {
      const srcsetBest = parseBestSrcset(el.getAttribute?.('srcset') || el.getAttribute?.('data-srcset') || '');
      const attrSrc = el.getAttribute?.('src') || el.src || el.getAttribute?.('data-src') || '';
      const current = el.currentSrc || '';
      const ranked = [srcsetBest, attrSrc, current].filter(Boolean);
      const raw = ranked.find((u) => !/\.avif(\?|#|$)/i.test(u)) || ranked[0] || '';
      if (!raw) return '';
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    }
    return '';
  }

  function extractImageUrlsFromContainer(rootEl) {
    if (!rootEl || rootEl.nodeType !== 1) return [];

    try { rootEl.scrollIntoView({ behavior: 'auto', block: 'nearest' }); } catch(e){}

    const tag = rootEl.tagName.toLowerCase();
    if (tag === 'svg') {
      const svgStr = new XMLSerializer().serializeToString(rootEl);
      return ['data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr)];
    }

    if (tag === 'img' || tag === 'picture') {
      const one = primaryImageUrlFromElement(rootEl);
      return one && isStrictImageFileUrl(one) ? [one] : [];
    }

    const urls = [];
    const seen = new Set();
    const nodes = [rootEl, ...rootEl.querySelectorAll('img, picture')];
    for (const node of nodes) {
      const u = primaryImageUrlFromElement(node);
      if (!u || !isStrictImageFileUrl(u)) continue;
      const key = srcIdentity(u);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(u);
    }
    return urls;
  }

  /**
   * Download images only from user-selected elements.
   * Never scans the whole page — empty selection is a no-op with a toast.
   */
  async function downloadSelectedImages(requestedCount = 0) {
    if (!selectedElements.length) {
      showToast('⚠️ 请先点选图片或包含图片的区域');
      return { status: 'no_selection', count: 0 };
    }

    let rawUrls = [];
    selectedElements.forEach((item) => {
      const kind = item.kind || classifySelectionKind(item);
      if (kind === 'video') return;
      if (item && item.element) {
        rawUrls.push(...extractImageUrlsFromContainer(item.element));
      }
    });
    rawUrls = [...new Set(rawUrls.filter(Boolean))];

    if (rawUrls.length === 0) {
      showToast('⚠️ 选中的元素中未找到可下载图片（可点选点选 img 或图片容器）');
      return { status: 'no_images_in_selection', count: 0 };
    }

    if (requestedCount > 0 && rawUrls.length > requestedCount) {
      rawUrls = rawUrls.slice(0, requestedCount);
    }

    showToast(`⚡ 正在从选中区域提取 ${rawUrls.length} 张图片...`);

    const dataUrlPromises = rawUrls.map(u => fetchUrlAsDataUrlInTabContext(u));
    const finalDataUrls = (await Promise.all(dataUrlPromises)).filter(Boolean);

    if (finalDataUrls.length === 0) {
      showToast('⚠️ 图片提取失败，请重试');
      return { status: 'extract_failed', count: 0 };
    }

    if (finalDataUrls.length < 5) {
      showToast(`📷 正在下载选中的 ${finalDataUrls.length} 张图片...`);
    } else {
      showToast(`📦 选中 ${finalDataUrls.length} 张图片，正在打包下载...`);
    }

    extSend({
      action: 'trigger_native_downloads',
      urls: finalDataUrls
    });
    return { status: 'ok', count: finalDataUrls.length };
  }

  function exportSelectedToCSV() {
    if (selectedElements.length === 0) { showToast('⚠️ 未选中任何元素'); return; }
    let csvRows = ['"Index","Tag","Selector","Text"'];
    selectedElements.forEach((item, idx) => {
      const cleanText = (item.text || '').replace(/"/g, '""').replace(/\n/g, ' ');
      const cleanSelector = (item.selector || '').replace(/"/g, '""');
      csvRows.push(`"${idx + 1}","${item.tag}","${cleanSelector}","${cleanText}"`);
    });
    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csvRows.join('\n'));
    const a = document.createElement('a'); a.href = csvContent; a.download = `browserbot_extracted_data_${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); showToast(`📊 成功导出 ${selectedElements.length} 条数据到 CSV！`);
  }

  function harvestCsvCell(value) {
    const api = pick();
    if (api?.csvCell) return api.csvCell(value);
    const t = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  function harvestMatrixToCsv(rows) {
    const api = pick();
    if (api?.matrixToCsv) return api.matrixToCsv(rows);
    return (rows || []).map((row) => (row || []).map(harvestCsvCell).join(',')).join('\n');
  }

  function harvestHrefDownloadable(href) {
    const api = pick();
    if (api?.hrefLooksDownloadable) return api.hrefLooksDownloadable(href);
    return /\.(pdf|zip|rar|7z|gz|tgz|xlsx?|docx?|pptx?|csv|json|xml|txt|md|rtf|epub)(\?|#|$)/i.test(String(href || ''));
  }

  function clickDownload(filename, href) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function tableElToMatrix(table) {
    const tag = String(table?.tagName || '').toLowerCase();
    if (tag === 'td' || tag === 'th') return [[String(table.innerText || table.textContent || '').replace(/\u00a0/g, ' ').trim()]];
    const rows = tag === 'tr' ? [table] : Array.from(table.querySelectorAll('tr'));
    return rows.map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((cell) =>
        String(cell.innerText || cell.textContent || '')
          .replace(/\u00a0/g, ' ')
          .trim()
      )
    ).filter((row) => row.some((c) => c));
  }

  function selectedTableElements() {
    return selectedElements
      .map((item) => {
        const el = item.element;
        if (!el) return null;
        const tag = String(el.tagName || item.tag || '').toLowerCase();
        if (item.scope === 'cell' || item.scope === 'row' || tag === 'table') return el;
        return el.closest?.('table') || el.querySelector?.('table') || null;
      })
      .filter(Boolean);
  }

  function exportSelectedTablesCsv() {
    const tables = [...new Set(selectedTableElements())];
    if (!tables.length) {
      showToast('⚠️ 选区里没有表格');
      return { status: 'empty', count: 0 };
    }
    tables.forEach((table, i) => {
      const csv = harvestMatrixToCsv(tableElToMatrix(table));
      const href = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);
      clickDownload(`table_${i + 1}_${Date.now()}.csv`, href);
    });
    showToast(`📊 已导出 ${tables.length} 张表`);
    return { status: 'ok', count: tables.length };
  }

  function selectedLinkHrefs() {
    const hrefs = [];
    for (const item of selectedElements) {
      const kind = item.kind || classifySelectionKind(item);
      const href = String(item.href || contextHrefOf(item.element) || item.element?.href || '').trim();
      if (kind === 'link' || href) {
        if (href && href !== '#' && !/^javascript:/i.test(href)) hrefs.push(href);
      }
    }
    return [...new Set(hrefs)];
  }

  function copySelectedLinks() {
    const hrefs = selectedLinkHrefs();
    if (!hrefs.length) {
      showToast('⚠️ 选区里没有链接');
      return { status: 'empty', count: 0 };
    }
    const body = hrefs.join('\n');
    const done = () => showToast(`✅ 已复制 ${hrefs.length} 条链接`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(body).then(done).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = body;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = body;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    }
    return { status: 'ok', count: hrefs.length, hrefs };
  }

  function downloadSelectedLinkFiles() {
    const files = selectedLinkHrefs().filter((h) => harvestHrefDownloadable(h));
    if (!files.length) {
      showToast('⚠️ 没有可下载的文件链接');
      return { status: 'empty', count: 0 };
    }
    extSend({ action: 'trigger_native_downloads', urls: files });
    showToast(`⬇️ 开始下载 ${files.length} 个文件`);
    return { status: 'ok', count: files.length };
  }

  function selectedSvgElements() {
    return selectedElements
      .map((item) => {
        const el = item.element;
        if (!el) return null;
        const tag = String(el.tagName || item.tag || '').toLowerCase();
        if (tag === 'svg') return el;
        return el.querySelector?.('svg') || (el.closest?.('svg') ?? null);
      })
      .filter(Boolean);
  }

  function downloadSelectedSvgs() {
    const nodes = [...new Set(selectedSvgElements())];
    if (!nodes.length) {
      showToast('⚠️ 选区里没有 SVG');
      return { status: 'empty', count: 0 };
    }
    nodes.forEach((svg, i) => {
      try {
        if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        const xml = new XMLSerializer().serializeToString(svg);
        const href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        clickDownload(`vector_${i + 1}_${Date.now()}.svg`, href);
      } catch (err) {
        console.warn('svg serialize failed', err);
      }
    });
    showToast(`🧩 已下载 ${nodes.length} 个 SVG`);
    return { status: 'ok', count: nodes.length };
  }

  function httpPageUrl(href) {
    const h = String(href || '').trim();
    if (!h || h === '#' || /^javascript:/i.test(h)) return '';
    try {
      return new URL(h, location.href).href;
    } catch {
      return '';
    }
  }

  function coverPageUrl(el) {
    if (!el) return location.href;
    const fromA = httpPageUrl(el.closest?.('a[href]')?.href || el.href);
    if (fromA && !/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm)(\?|#|$)/i.test(fromA)) return fromA;
    return location.href;
  }

  function displayPosterUrl(el, preferAvif = false) {
    if (!el || el.nodeType !== 1) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'picture') {
      const img = el.querySelector('img');
      return img ? displayPosterUrl(img, preferAvif) : '';
    }
    if (tag === 'img') {
      const srcset = el.getAttribute?.('srcset') || el.getAttribute?.('data-srcset') || '';
      const fromSet = parseBestSrcset(srcset, { preferAvif }) || '';
      const raw = preferAvif
        ? fromSet || el.currentSrc || el.src || el.getAttribute?.('src') || el.getAttribute?.('data-src') || ''
        : el.currentSrc ||
          el.src ||
          el.getAttribute?.('src') ||
          el.getAttribute?.('data-src') ||
          fromSet ||
          '';
      if (!raw) return '';
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    }
    return '';
  }

  function posterUrlForElement(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'video') {
      const img = el.parentElement?.querySelector?.('img');
      if (img) {
        const fromImg = displayPosterUrl(img, true);
        if (fromImg) return fromImg;
      }
      const poster = String(el.poster || '').trim();
      if (poster) {
        try {
          return new URL(poster, location.href).href;
        } catch {
          return poster;
        }
      }
      return '';
    }
    if (tag === 'img' || tag === 'picture') return displayPosterUrl(el, true);
    const img = el.querySelector?.('img');
    if (img) return displayPosterUrl(img, true);
    const video = el.querySelector?.('video');
    if (video?.poster) {
      try {
        return new URL(video.poster, location.href).href;
      } catch {
        return String(video.poster);
      }
    }
    return '';
  }

  function escapeHtmlAttr(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  async function fetchCoverAsDataUrl(rawUrl) {
    if (!rawUrl) return '';
    if (/^data:image\//i.test(rawUrl)) return rawUrl;
    let absUrl = rawUrl;
    try {
      absUrl = new URL(rawUrl, location.href).href;
    } catch {
      /* keep */
    }
    const blobToData = (blob) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.readAsDataURL(blob);
      });
    const tryFetch = async (init) => {
      const res = await fetch(absUrl, init);
      if (!res.ok) return '';
      const blob = await res.blob();
      if (blob.size < 80) return '';
      return blobToData(blob);
    };
    try {
      const a = await tryFetch({ mode: 'cors', credentials: 'omit' });
      if (a) return a;
    } catch {
      /* continue */
    }
    try {
      const b = await tryFetch({ mode: 'cors', credentials: 'include' });
      if (b) return b;
    } catch {
      /* continue */
    }
    const via = await fetchUrlAsDataUrlInTabContext(absUrl);
    return typeof via === 'string' && via ? via : absUrl;
  }

  async function exportSelectedCoverLinks() {
    const cards = [];
    for (const item of selectedElements) {
      const el = item.element;
      if (!isLiveElement(el)) continue;
      const kind = item.kind || classifySelectionKind(item);
      if (kind !== 'video' && kind !== 'image' && tagOfSafe(el) !== 'video' && tagOfSafe(el) !== 'img') continue;
      const pageUrl = httpPageUrl(item.href) || coverPageUrl(el);
      let poster = posterUrlForElement(el) || item.src || '';
      if (!poster && kind !== 'video' && kind !== 'image') continue;
      if (poster) {
        try {
          const data = await fetchCoverAsDataUrl(poster);
          if (typeof data === 'string' && data) poster = data;
        } catch {
          /* keep url */
        }
      }
      if (!poster && !pageUrl) continue;
      const title =
        String(el.getAttribute?.('alt') || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '')
          .trim()
          .slice(0, 80) || document.title || pageUrl;
      cards.push({ pageUrl, poster, title });
    }
    if (!cards.length) {
      showToast('⚠️ 没有可导出的视频封面');
      return { status: 'empty', count: 0 };
    }
    const fragment = cards
      .map((c) => {
        const img = c.poster
          ? `<img src="${escapeHtmlAttr(c.poster)}" alt="${escapeHtmlAttr(c.title)}" />`
          : `<span>${escapeHtmlAttr(c.title)}</span>`;
        const cap = c.pageUrl
          ? `<div><a href="${escapeHtmlAttr(c.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(c.pageUrl)}</a></div>`
          : '';
        return `<figure><a href="${escapeHtmlAttr(c.pageUrl)}" target="_blank" rel="noopener noreferrer">${img}</a>${cap}</figure>`;
      })
      .join('\n');
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>视频封面</title>
<style>
  body { margin: 24px; font: 14px/1.45 system-ui, sans-serif; background: #111; color: #eee; }
  figure { display: inline-block; margin: 0 20px 24px 0; vertical-align: top; max-width: min(480px, 100%); }
  figure a { color: #9b8cff; text-decoration: none; }
  figure a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
  figure div { margin-top: 8px; font-size: 12px; word-break: break-all; }
</style>
</head>
<body>
${fragment}
</body>
</html>`;
    clickDownload(`video-covers_${Date.now()}.html`, 'data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const plain = cards.map((c) => `${c.title}\n${c.pageUrl}`).join('\n\n');
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([fragment], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' })
          })
        ]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain);
      }
    } catch {
      /* download still succeeded */
    }
    showToast(`🎬 已导出 ${cards.length} 个封面到文档（含链接）`);
    return { status: 'ok', count: cards.length };
  }

  function tagOfSafe(el) {
    return String(el?.tagName || '').toLowerCase();
  }

  /* ── Selection live extract / multi-format export (agent tools) ── */

  /** Full live text from DOM when element still connected; else stored preview. */
  function getLiveSelectionText(item) {
    if (!item) return '';
    const el = item.element;
    if (el && el.isConnected !== false) {
      try {
        const live = el.innerText || el.textContent || '';
        if (live) return live;
      } catch (_) { /* detached mid-read */ }
    }
    return item.text || '';
  }

  /** Live src when element still connected; else stored src. */
  function getLiveSelectionSrc(item) {
    if (!item) return '';
    const el = item.element;
    if (el && el.isConnected !== false) {
      try {
        const live = el.src || el.getAttribute?.('src') || el.currentSrc || '';
        if (live) return String(live);
        // <picture> / background-ish: first nested img
        if (String(item.tag || el.tagName || '').toLowerCase() === 'picture') {
          const img = el.querySelector?.('img');
          const nested = img && (img.src || img.getAttribute?.('src') || '');
          if (nested) return String(nested);
        }
      } catch (_) { /* ignore */ }
    }
    return item.src || '';
  }

  function selectionSrcLooksImage(src) {
    if (srcLooksImage(src)) return true;
    if (!src || typeof src !== 'string') return false;
    if (/\/(image|images|img|media|photo|photos|thumb|thumbs)\//i.test(src) && !/\.html?/i.test(src)) {
      return true;
    }
    return false;
  }

  /**
   * Kind: image (img/picture or image-like src) → table (table/td/th/tr) → text (has text) → other
   */
  function classifySelectionKind(item) {
    if (item?.kind) return classifyContextKind({ kindHint: item.kind, tag: item.tag, src: item.src, href: item.href, text: item.text });
    const tag = String(item?.tag || item?.element?.tagName || '').toLowerCase();
    const src = getLiveSelectionSrc(item);
    const href = item?.href || item?.element?.href || '';
    const text = getLiveSelectionText(item);
    return classifyContextKind({ tag, src, href, text });
  }

  /**
   * Filter + order selectedElements into { item, index, kind } entries.
   * kinds / indices only applied when non-empty arrays.
   */
  function resolveSelectionEntries(opts = {}) {
    const kindsFilter =
      Array.isArray(opts.kinds) && opts.kinds.length
        ? new Set(opts.kinds.map((k) => String(k).toLowerCase()))
        : null;
    const indicesFilter =
      Array.isArray(opts.indices) && opts.indices.length
        ? new Set(
            opts.indices
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n >= 0)
          )
        : null;
    const order = String(opts.order || 'as_is').toLowerCase() === 'reverse' ? 'reverse' : 'as_is';

    let entries = selectedElements.map((item, index) => ({
      item,
      index,
      kind: classifySelectionKind(item)
    }));
    if (indicesFilter) entries = entries.filter((e) => indicesFilter.has(e.index));
    if (kindsFilter) entries = entries.filter((e) => kindsFilter.has(e.kind));
    if (order === 'reverse') entries = entries.slice().reverse();
    return { entries, order };
  }

  /**
   * Clean agent payload: full live text/src (capped), no long CSS dumps.
   * includeSelector default false.
   */
  function agentExtractSelection(request = {}) {
    const totalSelected = selectedElements.length;
    if (totalSelected === 0) {
      return {
        status: 'empty',
        count: 0,
        totalSelected: 0,
        items: [],
        message: 'No elements selected'
      };
    }

    let maxCharsPerItem =
      typeof request.maxCharsPerItem === 'number' && Number.isFinite(request.maxCharsPerItem)
        ? request.maxCharsPerItem
        : 20000;
    maxCharsPerItem = Math.min(Math.max(1, Math.floor(maxCharsPerItem)), 100000);

    let maxTotalChars =
      typeof request.maxTotalChars === 'number' && Number.isFinite(request.maxTotalChars)
        ? request.maxTotalChars
        : 200000;
    maxTotalChars = Math.max(1, Math.floor(maxTotalChars));

    const includeSelector = !!request.includeSelector;
    const { entries } = resolveSelectionEntries({
      kinds: request.kinds,
      indices: request.indices,
      order: 'as_is'
    });

    if (!entries.length) {
      return {
        status: 'empty',
        count: 0,
        totalSelected,
        items: [],
        message: 'No selected elements matched filters'
      };
    }

    const items = [];
    let usedChars = 0;
    let truncatedTotal = false;

    for (const { item, index, kind } of entries) {
      if (usedChars >= maxTotalChars) {
        truncatedTotal = true;
        break;
      }

      const tag = String(item.tag || item.element?.tagName || '').toLowerCase();
      const fullText = getLiveSelectionText(item);
      const fullSrc = getLiveSelectionSrc(item);
      const out = { index, kind, tag };

      if (fullSrc) out.src = String(fullSrc).slice(0, 4000);

      if (fullText) {
        const textLen = fullText.length;
        out.text_len = textLen;
        const budget = Math.min(maxCharsPerItem, maxTotalChars - usedChars);
        if (budget <= 0) {
          truncatedTotal = true;
          break;
        }
        if (textLen > budget) {
          out.text = fullText.slice(0, budget);
          out.truncated = true;
          usedChars += budget;
          if (usedChars >= maxTotalChars) truncatedTotal = true;
        } else {
          out.text = fullText;
          out.truncated = false;
          usedChars += textLen;
        }
      }

      if (includeSelector && item.selector) {
        out.selector = String(item.selector).slice(0, 120);
      }

      items.push(out);

      // If this item ate the remaining budget and more entries remain, flag total truncation
      if (usedChars >= maxTotalChars && items.length < entries.length) {
        truncatedTotal = true;
        break;
      }
    }

    const result = {
      status: items.length ? 'ok' : 'empty',
      count: items.length,
      totalSelected,
      items,
      message: items.length
        ? `Extracted ${items.length} of ${totalSelected} selected element(s)`
        : 'No selected elements matched filters'
    };
    if (truncatedTotal) result.truncatedTotal = true;
    return result;
  }

  function buildSelectionMarkdown(cleanItems, order) {
    const lines = [
      '# BrowserBot selection export',
      `- order: ${order}`,
      `- items: ${cleanItems.length}`,
      `- url: ${location.href}`,
      `- exportedAt: ${new Date().toISOString()}`,
      ''
    ];
    cleanItems.forEach((it, i) => {
      lines.push(`## ${i + 1}`);
      lines.push(`- kind: ${it.kind}`);
      lines.push(`- tag: ${it.tag}`);
      if (it.src) lines.push(`- src: ${it.src}`);
      lines.push('');
      if (it.text) lines.push(it.text);
      else if (it.src) lines.push(it.src);
      else lines.push(`(empty ${it.kind})`);
      lines.push('');
    });
    return lines.join('\n');
  }

  function buildSelectionTxt(cleanItems) {
    return cleanItems
      .map((it) => {
        const parts = [];
        if (it.text) parts.push(it.text);
        if (it.src) parts.push(it.src);
        return parts.length ? parts.join('\n') : `[${it.kind}] <${it.tag}>`;
      })
      .join('\n\n---\n\n');
  }

  function buildSelectionCsv(cleanItems) {
    const header = ['Index', 'Kind', 'Tag', 'Text', 'Src'].map(pwCsvEscape).join(',');
    const rows = cleanItems.map((it) =>
      [
        String(it.index),
        it.kind || '',
        it.tag || '',
        it.text || '',
        it.src || ''
      ]
        .map(pwCsvEscape)
        .join(',')
    );
    return `\uFEFF${[header, ...rows].join('\n')}`;
  }

  function buildSelectionJson(cleanItems) {
    const arr = cleanItems.map((it) => {
      const o = { index: it.index, kind: it.kind, tag: it.tag };
      if (it.text) o.text = it.text;
      if (it.src) o.src = it.src;
      return o;
    });
    return JSON.stringify(arr, null, 2);
  }

  /**
   * Export selection as md|txt|csv|json with order / kind filters; optional browser download.
   * Response stays short when downloaded (no full body).
   */
  function agentExportSelection(request = {}) {
    const fmtRaw = String(request.format || 'md').toLowerCase();
    const format = ['md', 'txt', 'csv', 'json'].includes(fmtRaw) ? fmtRaw : 'md';
    const order = String(request.order || 'as_is').toLowerCase() === 'reverse' ? 'reverse' : 'as_is';
    const download = request.download !== false;
    const totalSelected = selectedElements.length;

    if (totalSelected === 0) {
      return {
        status: 'empty',
        format,
        order,
        itemCount: 0,
        downloaded: false,
        filename: null,
        message: 'No elements selected'
      };
    }

    const { entries } = resolveSelectionEntries({
      kinds: request.kinds,
      indices: request.indices,
      order
    });

    if (!entries.length) {
      return {
        status: 'empty',
        format,
        order,
        itemCount: 0,
        downloaded: false,
        filename: null,
        message: 'No selected elements matched filters'
      };
    }

    const cleanItems = entries.map(({ item, index, kind }) => {
      const text = getLiveSelectionText(item);
      const src = getLiveSelectionSrc(item);
      return {
        index,
        kind,
        tag: String(item.tag || item.element?.tagName || '').toLowerCase(),
        text: text || '',
        src: src || ''
      };
    });

    let content;
    let mime;
    try {
      if (format === 'md') {
        content = buildSelectionMarkdown(cleanItems, order);
        mime = 'text/markdown;charset=utf-8';
      } else if (format === 'txt') {
        content = buildSelectionTxt(cleanItems);
        mime = 'text/plain;charset=utf-8';
      } else if (format === 'csv') {
        content = buildSelectionCsv(cleanItems);
        mime = 'text/csv;charset=utf-8';
      } else {
        content = buildSelectionJson(cleanItems);
        mime = 'application/json;charset=utf-8';
      }
    } catch (e) {
      return {
        status: 'error',
        format,
        order,
        itemCount: cleanItems.length,
        downloaded: false,
        filename: null,
        message: e?.message || String(e)
      };
    }

    let filename =
      typeof request.filename === 'string' && request.filename.trim()
        ? request.filename.trim().replace(/[\\/:*?"<>|]/g, '_')
        : `browserbot_selection_${Date.now()}.${format}`;
    // Ensure extension if user omitted it
    if (typeof request.filename === 'string' && request.filename.trim() && !/\.\w{1,8}$/.test(filename)) {
      filename = `${filename}.${format}`;
    }

    let byteLength = content.length;
    try {
      byteLength = new Blob([content]).size;
    } catch (_) { /* length fallback */ }

    if (download) {
      try {
        pwTriggerDownload(content, filename, mime);
      } catch (e) {
        return {
          status: 'error',
          format,
          order,
          itemCount: cleanItems.length,
          downloaded: false,
          filename: null,
          byteLength,
          message: e?.message || String(e)
        };
      }
      showToast(`📄 已导出 ${cleanItems.length} 项 → ${filename}`);
      return {
        status: 'ok',
        format,
        order,
        itemCount: cleanItems.length,
        downloaded: true,
        filename,
        byteLength,
        message: `Exported ${cleanItems.length} item(s) as ${format}`
      };
    }

    return {
      status: 'ok',
      format,
      order,
      itemCount: cleanItems.length,
      downloaded: false,
      filename: null,
      byteLength,
      message: `Built ${cleanItems.length} item(s) as ${format} (no download)`,
      contentPreview: content.slice(0, 500)
    };
  }

  /* ── Browser data tools: article / structured export / DOM snapshot (no Playwright) ── */

  const PW_NOISE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME',
    'NOSCRIPT', 'BUTTON', 'SVG', 'CANVAS', 'TEMPLATE', 'INPUT', 'SELECT', 'TEXTAREA'
  ]);
  const PW_NOISE_RE = /ad-|ads-|sidebar|comment|nav|menu|widget|popup|share|cookie|banner/i;

  function pwIsNoiseEl(el) {
    if (!el || el.nodeType !== 1) return true;
    if (PW_NOISE_TAGS.has(el.tagName)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    const id = el.id || '';
    return PW_NOISE_RE.test(cls) || PW_NOISE_RE.test(id);
  }

  function pwPlain(el) {
    if (!el) return '';
    return cleanDOMText(el.innerText || el.textContent || '');
  }

  function extractArticleFromPage(opts = {}) {
    const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 12000;
    const url = window.location.href;
    let title = '';
    const h1 = document.querySelector('h1');
    if (h1) title = pwPlain(h1).slice(0, 300);
    if (!title) title = (document.title || '').slice(0, 300);

    // Score containers by paragraph character mass (Readability-style)
    const paragraphs = Array.from(document.querySelectorAll('p')).filter((p) => {
      if (pwIsNoiseEl(p)) return false;
      let walk = p.parentElement;
      for (let d = 0; d < 5 && walk; d++) {
        if (pwIsNoiseEl(walk)) return false;
        walk = walk.parentElement;
      }
      return pwPlain(p).length >= 20;
    });

    const scores = new Map();
    paragraphs.forEach((p) => {
      const parent = p.parentElement;
      if (!parent || pwIsNoiseEl(parent)) return;
      const len = pwPlain(p).length;
      scores.set(parent, (scores.get(parent) || 0) + len);
    });

    let best = null;
    let bestScore = 0;
    scores.forEach((score, el) => {
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    if (!best) {
      best =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.body;
    }

    const mdParts = [];
    if (title) mdParts.push(`# ${title}`, '');
    if (url) mdParts.push(`**Source:** ${url}`, '');

    const pushBlock = (el) => {
      if (!el || el.nodeType !== 1 || pwIsNoiseEl(el)) return;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const t = pwPlain(el);
        if (t) mdParts.push(`${'#'.repeat(parseInt(tag[1], 10))} ${t}`, '');
        return;
      }
      if (tag === 'p') {
        const t = pwPlain(el);
        if (t) mdParts.push(t, '');
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        Array.from(el.children).forEach((li) => {
          if (li.tagName === 'LI') {
            const t = pwPlain(li);
            if (t) mdParts.push(`- ${t}`);
          }
        });
        mdParts.push('');
        return;
      }
      if (tag === 'blockquote') {
        const t = pwPlain(el);
        if (t) mdParts.push(...t.split('\n').map((l) => `> ${l}`), '');
        return;
      }
      if (tag === 'a') {
        const t = pwPlain(el);
        const href = el.getAttribute('href') || '';
        if (t && href && !href.startsWith('javascript:')) mdParts.push(`[${t}](${href})`);
        else if (t) mdParts.push(t);
        return;
      }
      if (tag === 'img') {
        const src = el.currentSrc || el.src || el.getAttribute('src') || '';
        if (src && !src.startsWith('data:')) mdParts.push(`![${el.alt || 'image'}](${src})`, '');
        return;
      }
      // Generic: walk children for article-like containers
      if (['div', 'section', 'article', 'main', 'td', 'span'].includes(tag)) {
        Array.from(el.children).forEach(pushBlock);
      }
    };

    if (best) {
      Array.from(best.children).forEach(pushBlock);
      // If container is leaf-ish
      if (mdParts.length <= 3) {
        const fallback = pwPlain(best);
        if (fallback) mdParts.push(fallback);
      }
    }

    let markdown = mdParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (markdown.length < 80) {
      const bodyText = pwPlain(document.body).slice(0, maxChars);
      markdown = [title ? `# ${title}` : '', url ? `**Source:** ${url}` : '', bodyText]
        .filter(Boolean)
        .join('\n\n');
    }

    let truncated = false;
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars) + '\n\n…[truncated]';
      truncated = true;
    }

    return {
      status: 'ok',
      source: 'page',
      title,
      url,
      charCount: markdown.length,
      truncated,
      paragraphCount: paragraphs.length,
      score: bestScore,
      markdown
    };
  }

  function pwCsvEscape(value) {
    if (value == null) return '';
    const s = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function pwRowsToCsv(rows) {
    if (!rows || !rows.length) return '\uFEFF';
    const fields = [];
    const seen = new Set();
    rows.forEach((row) => {
      Object.keys(row || {}).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          fields.push(k);
        }
      });
    });
    const lines = [fields.map(pwCsvEscape).join(',')];
    rows.forEach((row) => {
      lines.push(fields.map((f) => pwCsvEscape(row[f])).join(','));
    });
    return `\uFEFF${lines.join('\n')}`;
  }

  function pwTriggerDownload(content, filename, mime) {
    const href = `data:${mime},${encodeURIComponent(content)}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function parseLiveTables(maxRows = 500) {
    const tables = Array.from(document.querySelectorAll('table'));
    const out = [];
    tables.forEach((table, tableIndex) => {
      const headers = Array.from(table.querySelectorAll('th'))
        .map((th) => pwPlain(th).slice(0, 120))
        .filter(Boolean)
        .slice(0, 40);
      const rows = [];
      Array.from(table.querySelectorAll('tr')).forEach((tr) => {
        if (rows.length >= maxRows) return;
        const cells = Array.from(tr.querySelectorAll('td'));
        if (!cells.length) return;
        const row = {};
        cells.slice(0, 40).forEach((cell, i) => {
          const key = headers[i] || `Column_${i + 1}`;
          row[key] = pwPlain(cell).slice(0, 500);
        });
        if (Object.keys(row).length) rows.push(row);
      });
      if (rows.length) {
        out.push({
          source: 'table',
          tableIndex,
          headers: headers.length ? headers : Object.keys(rows[0]),
          rows
        });
      }
    });
    return out;
  }

  function parseLiveCards(maxRows = 500) {
    const selectors = [
      '[class*="card"]',
      '[class*="item"]',
      '[class*="product"]',
      '[class*="result"]',
      '[class*="listing"]',
      'li.product',
      'article'
    ];
    const candidates = [];
    const seenEls = new Set();
    selectors.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (seenEls.has(el) || pwIsNoiseEl(el)) return;
          // Skip huge page shells
          if (el === document.body || el === document.documentElement) return;
          const text = pwPlain(el);
          if (text.length < 15 || text.length > 2000) return;
          // Prefer leaf-ish cards (not parents of other cards)
          seenEls.add(el);
          candidates.push(el);
        });
      } catch (_) {}
    });

    // Drop parents that contain other candidates
    const filtered = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));

    // Cluster by similar structure (same parent + similar child count)
    const byParent = new Map();
    filtered.forEach((el) => {
      const p = el.parentElement;
      if (!p) return;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(el);
    });

    let bestGroup = [];
    byParent.forEach((group) => {
      if (group.length > bestGroup.length) bestGroup = group;
    });
    if (bestGroup.length < 2) bestGroup = filtered.slice(0, maxRows);

    const rows = [];
    const seen = new Set();
    bestGroup.slice(0, maxRows).forEach((el) => {
      const row = {};
      const titleEl = el.querySelector('h1,h2,h3,h4,a,[class*="title"]');
      const priceEl = el.querySelector('[class*="price"],[class*="Price"]');
      const linkEl = el.querySelector('a[href]');
      if (titleEl) row.Title = pwPlain(titleEl).slice(0, 200);
      if (priceEl) row.Price = pwPlain(priceEl).slice(0, 80);
      if (linkEl) {
        try {
          row.Link = new URL(linkEl.getAttribute('href'), location.href).href.slice(0, 500);
        } catch (_) {
          row.Link = (linkEl.getAttribute('href') || '').slice(0, 500);
        }
      }
      const bits = pwPlain(el)
        .split(/\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1)
        .slice(0, 8);
      bits.forEach((t, i) => {
        if (!row[`Field_${i + 1}`]) row[`Field_${i + 1}`] = t.slice(0, 300);
      });
      if (!Object.keys(row).length) return;
      const sig = JSON.stringify(row);
      if (seen.has(sig)) return;
      seen.add(sig);
      rows.push(row);
    });
    return rows;
  }

  function selectionToStructuredRows() {
    return selectedElements.map((item, i) => ({
      Index: String(i + 1),
      Tag: item.tag || '',
      Selector: item.selector || '',
      Text: (item.text || '').slice(0, 500),
      Src: (item.src || '').slice(0, 500)
    }));
  }

  function exportStructuredDataFromPage(opts = {}) {
    const format = String(opts.format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const prefer = opts.prefer || 'auto';
    const maxRows = typeof opts.maxRows === 'number' ? Math.min(Math.max(1, opts.maxRows), 500) : 500;
    const download = opts.download !== false;

    let rows = [];
    let source = 'none';
    let headers = [];
    let tableCount = 0;
    let cardCount = 0;

    if (prefer === 'selection' || (prefer === 'auto' && selectedElements.length > 0)) {
      rows = selectionToStructuredRows().slice(0, maxRows);
      source = 'selection';
      headers = rows[0] ? Object.keys(rows[0]) : [];
    }

    if (rows.length === 0 && prefer !== 'cards' && prefer !== 'selection') {
      const tables = parseLiveTables(maxRows);
      tableCount = tables.length;
      let best = null;
      tables.forEach((t) => {
        if (!best || t.rows.length > best.rows.length) best = t;
      });
      if (best && (prefer === 'table' || best.rows.length >= 1)) {
        rows = best.rows.slice(0, maxRows);
        source = 'table';
        headers = best.headers || [];
      }
    }

    if (rows.length === 0 && prefer !== 'table' && prefer !== 'selection') {
      const cards = parseLiveCards(maxRows);
      cardCount = cards.length;
      if (cards.length) {
        rows = cards.slice(0, maxRows);
        source = 'cards';
        headers = rows[0] ? Object.keys(rows[0]) : [];
      }
    }

    // If selection was empty-ish and auto preferred tables already tried — last chance cards
    if (rows.length === 0 && prefer === 'auto') {
      const tables = parseLiveTables(maxRows);
      tableCount = tables.length;
      if (tables[0]) {
        rows = tables[0].rows.slice(0, maxRows);
        source = 'table';
        headers = tables[0].headers || [];
      }
    }

    if (!rows.length) {
      showToast('⚠️ 未找到可导出的表格或列表数据');
      return {
        status: 'empty',
        source: 'none',
        format,
        rowCount: 0,
        tableCount,
        cardCount,
        downloaded: false,
        headers: [],
        previewRows: [],
        message: 'No tables, card lists, or selection to export'
      };
    }

    let content;
    let mime;
    let filename;
    if (format === 'json') {
      content = JSON.stringify(rows, null, 2);
      mime = 'application/json;charset=utf-8';
      filename = `browserbot_data_${Date.now()}.json`;
    } else {
      content = pwRowsToCsv(rows);
      mime = 'text/csv;charset=utf-8';
      filename = `browserbot_data_${Date.now()}.csv`;
    }

    if (download) {
      pwTriggerDownload(content, filename, mime);
      showToast(`📊 已导出 ${rows.length} 行 → ${filename}`);
    }

    return {
      status: 'ok',
      source,
      format,
      rowCount: rows.length,
      tableCount,
      cardCount,
      downloaded: !!download,
      filename: download ? filename : null,
      headers: headers.slice(0, 20),
      previewRows: rows.slice(0, 5),
      message: `Exported ${rows.length} rows from ${source} as ${format}`
    };
  }

  function buildLiveDomSnapshot(opts = {}) {
    const includeSamples = opts.includeSamples !== false;
    const url = window.location.href;
    const domain = window.location.hostname;
    const title = document.title || '';
    const lang = (document.documentElement.lang || '').slice(0, 20);

    const forms = Array.from(document.querySelectorAll('form')).slice(0, 8).map((form) => {
      const fields = [];
      Array.from(form.querySelectorAll('input, select, textarea')).forEach((field) => {
        if (fields.length >= 12) return;
        const type = (field.getAttribute('type') || field.tagName.toLowerCase()).toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button') return;
        let label = '';
        if (field.id) {
          try {
            const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(field.id) : field.id.replace(/"/g, '');
            const lab = document.querySelector(`label[for="${esc}"]`);
            if (lab) label = pwPlain(lab).slice(0, 80);
          } catch (_) {}
        }
        if (!label && field.getAttribute('aria-label')) label = field.getAttribute('aria-label').slice(0, 80);
        if (!label && field.placeholder) label = String(field.placeholder).slice(0, 80);
        fields.push({
          name: (field.name || field.id || '').slice(0, 80),
          type: type.slice(0, 40),
          label,
          required: !!field.required
        });
      });
      return {
        name: (form.getAttribute('name') || '').slice(0, 80),
        id: (form.id || '').slice(0, 80),
        action: (form.getAttribute('action') || '').slice(0, 200),
        method: (form.getAttribute('method') || 'get').slice(0, 10),
        fieldCount: fields.length,
        fields
      };
    });

    const tables = Array.from(document.querySelectorAll('table')).slice(0, 8).map((table, index) => {
      const headers = Array.from(table.querySelectorAll('th'))
        .map((th) => pwPlain(th).slice(0, 60))
        .filter(Boolean)
        .slice(0, 12);
      const rows = table.querySelectorAll('tr').length;
      const firstRow = table.querySelector('tr');
      const cols = firstRow ? firstRow.querySelectorAll('th,td').length : 0;
      const captionEl = table.querySelector('caption');
      return {
        index,
        rows,
        cols,
        headers,
        caption: captionEl ? pwPlain(captionEl).slice(0, 120) : ''
      };
    });

    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .slice(0, 12)
      .map((el) => ({
        level: parseInt(el.tagName[1], 10),
        text: pwPlain(el).slice(0, 100)
      }))
      .filter((h) => h.text);

    const articleRoot =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]');
    let mainText = '';
    if (articleRoot) {
      mainText = pwPlain(articleRoot).slice(0, 600);
    } else {
      const ps = Array.from(document.querySelectorAll('p'))
        .map((p) => pwPlain(p))
        .filter((t) => t.length > 40)
        .slice(0, 6);
      mainText = ps.join(' ').slice(0, 600);
    }

    const landmarks = [];
    if (document.querySelector('main,[role="main"]')) landmarks.push('main');
    if (document.querySelector('nav')) landmarks.push('nav');
    if (document.querySelector('article')) landmarks.push('article');
    if (document.querySelector('aside')) landmarks.push('aside');
    if (document.querySelector('header')) landmarks.push('header');
    if (document.querySelector('footer')) landmarks.push('footer');

    const sampleButtons = includeSamples
      ? Array.from(document.querySelectorAll('button, a.btn, input[type="submit"]'))
          .slice(0, 10)
          .map((el) => ({
            text: pwPlain(el).slice(0, 60) || (el.value || '').slice(0, 60),
            selector: generateSelector(el)
          }))
          .filter((b) => b.text)
      : [];

    const sampleLinks = includeSamples
      ? Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 10)
          .map((el) => ({
            text: pwPlain(el).slice(0, 60),
            href: (el.href || '').slice(0, 200)
          }))
          .filter((l) => l.text && l.href && !l.href.startsWith('javascript:'))
      : [];

    const linkCount = document.querySelectorAll('a[href]').length;
    const buttonCount = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length;
    const imageCount = document.querySelectorAll('img').length;
    const inputCount = document.querySelectorAll('input, select, textarea').length;

    return {
      status: 'ok',
      url,
      domain,
      title,
      lang,
      metrics: {
        formCount: document.querySelectorAll('form').length,
        tableCount: document.querySelectorAll('table').length,
        linkCount,
        buttonCount,
        imageCount,
        inputCount,
        textApproxChars: mainText.length
      },
      forms,
      tables,
      headings,
      mainTextExcerpt: mainText,
      landmarks,
      sampleButtons,
      sampleLinks,
      selectionCount: selectedElements.length,
      hasArticle: !!document.querySelector('article, main, [role="main"]'),
      hasTable: tables.length > 0,
      hasForm: forms.length > 0
    };
  }

  const BLUEPRINT_HTML_MAX = 1500000;
  const BLUEPRINT_CSS_MAX = 400000;
  const BLUEPRINT_COMPUTED_MAX = 120;
  const BLUEPRINT_STYLE_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'inset',
    'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'flex-grow', 'flex-shrink',
    'grid', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
    'gap', 'row-gap', 'column-gap',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'font', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'color', 'background', 'background-color', 'background-image', 'background-size', 'background-position',
    'border', 'border-radius', 'box-shadow',
    'transform', 'object-fit', 'overflow', 'opacity', 'z-index',
    'animation', 'animation-name', 'transition', 'transition-property', 'transition-duration'
  ];

  /**
   * Whole-page blueprint for host clone. Full useful length (not the 16KB selection cap).
   * No live DOM handles. Scripts stay in outerHTML; host strips them.
   */
  function capturePageBlueprint() {
    const url = String(location.href || '');
    const baseHref = document.querySelector('base')?.href || url;
    const htmlRaw = document.documentElement ? String(document.documentElement.outerHTML || '') : '';
    const html = htmlRaw.length > BLUEPRINT_HTML_MAX ? htmlRaw.slice(0, BLUEPRINT_HTML_MAX) : htmlRaw;
    const warnings = [];
    if (htmlRaw.length > BLUEPRINT_HTML_MAX) warnings.push('html-truncated');
    const stylesheets = collectBlueprintStylesheets(warnings);
    const computed = collectBlueprintComputed();
    const motion = collectBlueprintMotion(stylesheets);
    const assets = collectBlueprintAssets(stylesheets);
    return {
      ok: true,
      url,
      baseUrl: baseHref,
      baseHref,
      title: String(document.title || '').slice(0, 240),
      lang: String(document.documentElement?.lang || '').slice(0, 32),
      locale: String(document.documentElement?.lang || navigator.language || '').slice(0, 32),
      viewport: {
        width: window.innerWidth || 0,
        height: window.innerHeight || 0,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      scroll: {
        width: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)
      },
      html,
      stylesheets,
      computed,
      motion,
      assets,
      warnings
    };
  }

  function collectBlueprintStylesheets(warnings) {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('style')) {
      const cssText = String(el.textContent || '').slice(0, BLUEPRINT_CSS_MAX);
      out.push({
        href: '',
        origin: location.origin,
        media: String(el.media || ''),
        inline: true,
        readable: true,
        cssText
      });
    }
    const sheets = Array.from(document.styleSheets || []);
    for (const sheet of sheets) {
      const href = String(sheet.href || '');
      if (href && seen.has(href)) continue;
      if (href) seen.add(href);
      let cssText = '';
      let readable = false;
      try {
        cssText = Array.from(sheet.cssRules || []).map((r) => r.cssText).join('\n').slice(0, BLUEPRINT_CSS_MAX);
        readable = cssText.length > 0;
      } catch {
        readable = false;
        if (href) warnings.push('css-cross-origin');
      }
      if (!href && readable) {
        /* inline sheet already captured from <style> */
        continue;
      }
      let origin = location.origin;
      try {
        if (href) origin = new URL(href).origin;
      } catch {
        /* keep */
      }
      out.push({
        href,
        origin,
        media: String(sheet.media?.mediaText || ''),
        inline: !href,
        readable,
        cssText
      });
    }
    try {
      const adopted = document.adoptedStyleSheets || [];
      for (const sheet of adopted) {
        let cssText = '';
        try {
          cssText = Array.from(sheet.cssRules || []).map((r) => r.cssText).join('\n').slice(0, BLUEPRINT_CSS_MAX);
        } catch {
          cssText = '';
        }
        if (cssText) {
          out.push({
            href: '',
            origin: location.origin,
            media: '',
            inline: true,
            readable: true,
            cssText
          });
        }
      }
    } catch {
      /* adoptedStyleSheets optional */
    }
    return out.slice(0, 32);
  }

  function collectBlueprintComputed() {
    const out = [];
    const sel = 'html,body,header,nav,main,aside,footer,section,article,h1,h2,h3,h4,.hero,.card,.rail,img';
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch {
      nodes = [];
    }
    for (const el of nodes) {
      if (out.length >= BLUEPRINT_COMPUTED_MAX) break;
      if (!el || el.nodeType !== 1) continue;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if ((rect.width || 0) < 2 && (rect.height || 0) < 2) continue;
      let cs;
      try {
        cs = window.getComputedStyle(el);
      } catch {
        continue;
      }
      const styles = {};
      for (const prop of BLUEPRINT_STYLE_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v) styles[prop] = v;
      }
      out.push({
        tag: String(el.tagName || '').toLowerCase(),
        className: String(el.className || '').slice(0, 120),
        selector: blueprintSelector(el),
        styles
      });
    }
    return out;
  }

  function blueprintSelector(el) {
    const tag = String(el.tagName || '').toLowerCase();
    const id = el.id ? `#${String(el.id).replace(/[^\w-]/g, '')}` : '';
    const cls = String(el.className || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((c) => `.${c.replace(/[^\w-]/g, '')}`)
      .join('');
    return `${tag}${id}${cls}`.slice(0, 160);
  }

  function collectBlueprintMotion(stylesheets) {
    const keyframes = [];
    const seen = new Set();
    for (const sheet of stylesheets || []) {
      const text = String(sheet.cssText || '');
      const re = /@keyframes\s+([A-Za-z_-][\w-]*)/gi;
      let m;
      while ((m = re.exec(text))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const block = text.slice(m.index, m.index + 2000);
        const end = block.indexOf('}', block.indexOf('{') + 1);
        keyframes.push({ name: m[1], cssText: end > 0 ? block.slice(0, end + 1) : `@keyframes ${m[1]}` });
        if (keyframes.length >= 40) break;
      }
    }
    const transitions = [];
    const animations = [];
    try {
      const sample = document.querySelectorAll('header, nav, main, aside, footer, section, article, .hero, .card, a, button, img');
      for (const el of sample) {
        if (transitions.length + animations.length >= 40) break;
        const cs = window.getComputedStyle(el);
        const tr = cs.transition || cs.getPropertyValue('transition');
        const an = cs.animation || cs.getPropertyValue('animation');
        if (tr && tr !== 'none' && tr !== 'all 0s ease 0s') {
          transitions.push({
            selector: blueprintSelector(el),
            value: String(tr).slice(0, 240)
          });
        }
        if (an && an !== 'none') {
          animations.push({
            selector: blueprintSelector(el),
            name: cs.animationName || '',
            value: String(an).slice(0, 240)
          });
        }
      }
    } catch {
      /* computed motion optional */
    }
    return { keyframes, transitions: transitions.slice(0, 40), animations: animations.slice(0, 40) };
  }

  function collectBlueprintAssets(stylesheets) {
    const images = [];
    const backgrounds = [];
    const posters = [];
    const fonts = [];
    const push = (arr, u) => {
      const s = String(u || '').trim();
      if (!s || s.startsWith('data:') || arr.includes(s)) return;
      arr.push(s);
    };
    for (const img of document.querySelectorAll('img')) {
      push(images, img.currentSrc || img.src || img.getAttribute('src'));
    }
    for (const vid of document.querySelectorAll('video[poster]')) {
      push(posters, vid.getAttribute('poster'));
    }
    const css = (stylesheets || []).map((s) => s.cssText || '').join('\n');
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    while ((m = urlRe.exec(css))) {
      const u = m[2];
      if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u)) push(fonts, u);
      else push(backgrounds, u);
    }
    return { images, backgrounds, posters, fonts };
  }

  /* Playwright-Style Full-Page DOM Element Awareness & Categorizer Scanner */
  function scanFullPageDOMContext() {
    try {
      const url = window.location.href;
      const domain = window.location.hostname;
      const title = document.title || '';

      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(el => cleanDOMText(el.innerText || el.textContent || '').substring(0, 60)).filter(Boolean);
      const paragraphsCount = document.querySelectorAll('p, article, section').length;

      let visualContainersCount = 0;
      const visualSelectors = [];
      const divElements = Array.from(document.querySelectorAll('div, section, article, header, nav, aside, footer')).slice(0, 150);
      divElements.forEach(el => {
        const style = window.getComputedStyle(el);
        if ((style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') || style.backgroundImage !== 'none' || style.boxShadow !== 'none' || style.backdropFilter !== 'none') {
          visualContainersCount++;
          if (visualSelectors.length < 5) visualSelectors.push(generateSelector(el));
        }
      });

      const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')).slice(0, 10).map(el => ({
        selector: generateSelector(el),
        text: cleanDOMText(el.innerText || el.value || '').substring(0, 40)
      })).filter(item => item.text);
      const inputsCount = document.querySelectorAll('input, select, textarea').length;
      const imagesCount = document.querySelectorAll('img, picture, svg').length;
      const topImages = Array.from(document.querySelectorAll('img')).slice(0, 5).map(img => img.src || img.getAttribute('src')).filter(Boolean);

      const domSummaryText = `${paragraphsCount + visualContainersCount + buttons.length + imagesCount} 节点 (文本:${paragraphsCount}, 容器:${visualContainersCount}, 按钮:${buttons.length + inputsCount}, 媒体:${imagesCount})`;

      return {
        url,
        domain,
        title,
        metrics: {
          textCount: paragraphsCount,
          visualContainerCount: visualContainersCount,
          buttonCount: buttons.length + inputsCount,
          imageCount: imagesCount
        },
        summaryText: domSummaryText,
        headings,
        visualSelectors,
        sampleButtons: buttons,
        sampleImages: topImages
      };
    } catch (e) {
      return {
        url: window.location.href,
        domain: window.location.hostname,
        title: document.title,
        metrics: { textCount: 0, visualContainerCount: 0, buttonCount: 0, imageCount: 0 },
        summaryText: '节点扫描完成',
        headings: [], visualSelectors: [], sampleButtons: [], sampleImages: []
      };
    }
  }

  function resolveTargetsFromSelectors(selectors) {
    if (Array.isArray(selectors) && selectors.length > 0) {
      const els = [];
      selectors.forEach((sel) => {
        try {
          const found = document.querySelectorAll(sel);
          found.forEach((el) => els.push(el));
        } catch (e) {}
      });
      if (els.length > 0) return els;
    }
    return selectedElements.map((item) => item.element).filter(Boolean);
  }


  /* ── Intent-level meta tools (DOM) ── */

  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function isFormControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function getElementValue(el) {
    if (!el) return undefined;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return el.value;
    if (el.isContentEditable) return el.textContent || '';
    return undefined;
  }

  function summarizeElement(el) {
    const tag = (el.tagName || '').toLowerCase();
    const text = cleanDOMText((el.innerText || el.textContent || '').substring(0, 120));
    const summary = {
      tag,
      selector: generateSelector(el),
      text: text.substring(0, 80),
      visible: isElementVisible(el)
    };
    if (isFormControl(el)) {
      const v = getElementValue(el);
      if (v !== undefined) summary.value = String(v).substring(0, 200);
      if (tag === 'input' && el.type) summary.inputType = el.type;
      if (tag === 'input' || tag === 'textarea') summary.checked = !!el.checked;
    }
    return summary;
  }

  /**
   * Resolve targets: selector if given → else selectedElements → else empty + error.
   * @returns {{ elements: Element[], error?: string, source: string }}
   */
  function resolveAgentTargets(opts = {}) {
    const selector = opts.selector != null ? String(opts.selector).trim() : '';
    const useSelection = opts.use_selection !== false && opts.useSelection !== false;
    if (selector) {
      try {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length === 0) {
          return { elements: [], error: 'No elements match selector: ' + selector, source: 'selector' };
        }
        return { elements: found, source: 'selector' };
      } catch (e) {
        return { elements: [], error: 'Invalid selector: ' + (e.message || String(e)), source: 'selector' };
      }
    }
    if (useSelection && selectedElements.length > 0) {
      const els = selectedElements.map((item) => item.element).filter((el) => el && el.isConnected !== false);
      if (els.length === 0) {
        return { elements: [], error: 'Selection is empty or detached; provide a CSS selector', source: 'selection' };
      }
      return { elements: els, source: 'selection' };
    }
    return {
      elements: [],
      error: 'No target: provide selector or select elements with the Browser Kitten picker',
      source: 'none'
    };
  }

  function dispatchValueEvents(el, value) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
    if (value !== undefined) {
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
      } catch (_) {}
    }
  }

  function setNativeInputValue(el, value) {
    const valueStr = value == null ? '' : String(value);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, valueStr);
    else el.value = valueStr;
    dispatchValueEvents(el, valueStr);
  }

  function agentFindElements(opts = {}) {
    const selector = opts.selector != null ? String(opts.selector).trim() : '';
    const textQuery = opts.text != null ? String(opts.text).trim() : '';
    const tagFilter = opts.tag != null ? String(opts.tag).trim().toLowerCase() : '';
    const useSelection = !!opts.use_selection || !!opts.useSelection;
    let max = typeof opts.max === 'number' ? Math.floor(opts.max) : 20;
    if (!Number.isFinite(max) || max < 1) max = 20;
    max = Math.min(max, 40);

    if (!selector && !textQuery && !useSelection && !tagFilter) {
      return {
        status: 'error',
        message: 'Provide selector, text, tag, and/or use_selection',
        count: 0,
        elements: []
      };
    }

    let candidates = [];
    if (useSelection && selectedElements.length > 0) {
      candidates = selectedElements.map((item) => item.element).filter(Boolean);
    } else if (selector) {
      try {
        candidates = Array.from(document.querySelectorAll(selector));
      } catch (e) {
        return { status: 'error', message: 'Invalid selector: ' + (e.message || String(e)), count: 0, elements: [] };
      }
    } else {
      // text and/or tag over whole document (broad but capped later)
      const rootSel = tagFilter || '*';
      try {
        candidates = Array.from(document.querySelectorAll(rootSel));
      } catch (e) {
        candidates = Array.from(document.body ? document.body.querySelectorAll('*') : []);
      }
    }

    const textLower = textQuery.toLowerCase();
    const matched = [];
    for (const el of candidates) {
      if (!el || el.nodeType !== 1) continue;
      // Skip BrowserBot UI chrome
      if (el.closest && (el.closest('.browserbot-toast-container') || el.closest('.browserbot-exit-float-btn') || el.closest('#browserbot-confirm-bar') || el.id === 'browserbot-region-root')) continue;
      if (tagFilter) {
        if ((el.tagName || '').toLowerCase() !== tagFilter) continue;
      }
      if (textLower) {
        const t = (el.innerText || el.textContent || el.value || '').toLowerCase();
        if (!t.includes(textLower)) continue;
      }
      matched.push(el);
      if (matched.length >= max) break;
    }

    return {
      status: 'ok',
      count: matched.length,
      elements: matched.map(summarizeElement)
    };
  }

  function agentSetValue(opts = {}) {
    const value = opts.value;
    if (value === undefined || value === null) {
      return { status: 'error', message: 'value is required' };
    }
    const valueStr = String(value);
    const mode = (opts.mode || 'auto').toLowerCase();
    const all = !!opts.all;
    let maxAll = 10;
    if (typeof opts.max === 'number') maxAll = Math.min(Math.max(1, Math.floor(opts.max)), 10);

    const resolved = resolveAgentTargets(opts);
    if (resolved.error && resolved.elements.length === 0) {
      return { status: 'error', message: resolved.error };
    }

    const targets = all ? resolved.elements.slice(0, maxAll) : resolved.elements.slice(0, 1);
    if (targets.length === 0) {
      return { status: 'error', message: resolved.error || 'No target elements' };
    }

    const results = [];
    for (const el of targets) {
      const tag = (el.tagName || '').toLowerCase();
      let usedMode = mode;
      try {
        if (mode === 'text') {
          el.textContent = valueStr;
          usedMode = 'text';
        } else if (mode === 'value') {
          if (tag === 'input' || tag === 'textarea') setNativeInputValue(el, valueStr);
          else if ('value' in el) el.value = valueStr;
          else el.textContent = valueStr;
          usedMode = 'value';
          if (tag !== 'input' && tag !== 'textarea') dispatchValueEvents(el, valueStr);
          results.push({ status: 'ok', mode: usedMode, ...summarizeElement(el) });
          continue;
        } else {
          // auto
          if (tag === 'input' || tag === 'textarea') {
            setNativeInputValue(el, valueStr);
            usedMode = 'value';
            results.push({ status: 'ok', mode: usedMode, ...summarizeElement(el) });
            continue;
          } else if (tag === 'select') {
            el.value = valueStr;
            usedMode = 'value';
          } else if (el.isContentEditable) {
            el.textContent = valueStr;
            usedMode = 'text';
          } else if ('value' in el) {
            el.value = valueStr;
            usedMode = 'value';
          } else {
            el.textContent = valueStr;
            usedMode = 'text';
          }
        }
        dispatchValueEvents(el);
        results.push({ status: 'ok', mode: usedMode, ...summarizeElement(el) });
      } catch (e) {
        results.push({ status: 'error', message: e.message || String(e), selector: generateSelector(el) });
      }
    }

    return {
      status: results.every((r) => r.status === 'ok') ? 'ok' : 'partial',
      count: results.length,
      source: resolved.source,
      results
    };
  }


  /** Heuristic: submit control or clear submit CTA (primary: type=submit / form submitter). */
  function dismissSubmitConfirmBar(reason) {
    const bar = document.getElementById('browserbot-confirm-bar');
    if (bar) {
      try { bar.remove(); } catch (_) {}
    }
    if (typeof confirmResolve === 'function') {
      const r = confirmResolve;
      confirmResolve = null;
      try { r({ confirmed: false, reason: reason || 'dismissed' }); } catch (_) {}
    }
  }

  /**
   * In-page toast-like bar: 确认提交 / 取消. NOT side panel.
   * @returns {Promise<{confirmed: boolean, reason: string}>}
   */
  function matchWaitCondition(opts) {
    const condition = String(opts.condition || 'present').toLowerCase();
    const selector = opts.selector != null ? String(opts.selector).trim() : '';
    const textQuery = opts.text != null ? String(opts.text).trim() : '';
    const textLower = textQuery.toLowerCase();

    let els = [];
    if (selector) {
      try {
        els = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        els = [];
      }
    } else if (textQuery) {
      const all = Array.from(document.body ? document.body.querySelectorAll('*') : []);
      for (const el of all) {
        if (!el || el.nodeType !== 1) continue;
        const t = (el.innerText || el.textContent || '').toLowerCase();
        if (t.includes(textLower)) {
          // Prefer leaf-ish matches: skip if only one child that also matches fully
          els.push(el);
          if (els.length >= 20) break;
        }
      }
    } else {
      return { ok: false, error: 'wait_for needs selector and/or text' };
    }

    if (textQuery && selector) {
      els = els.filter((el) => {
        const t = (el.innerText || el.textContent || el.value || '').toLowerCase();
        return t.includes(textLower);
      });
    }

    const anyVisible = els.some(isElementVisible);
    const anyPresent = els.length > 0;

    let satisfied = false;
    if (condition === 'present') satisfied = anyPresent;
    else if (condition === 'absent') satisfied = !anyPresent;
    else if (condition === 'visible') satisfied = anyVisible;
    else return { ok: false, error: 'Invalid condition: ' + condition + '. Use present|absent|visible' };

    return {
      ok: true,
      satisfied,
      matchCount: els.length,
      match: els[0] ? summarizeElement(els[0]) : null
    };
  }

  function agentWaitFor(opts = {}) {
    let timeoutMs = typeof opts.timeout_ms === 'number' ? Math.floor(opts.timeout_ms) : 8000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = 8000;
    timeoutMs = Math.min(timeoutMs, 30000);
    let pollMs = typeof opts.poll_ms === 'number' ? Math.floor(opts.poll_ms) : 200;
    if (!Number.isFinite(pollMs) || pollMs < 50) pollMs = 200;
    pollMs = Math.min(pollMs, 2000);

    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const waited_ms = Date.now() - started;
        const check = matchWaitCondition(opts);
        if (!check.ok) {
          resolve({ status: 'error', message: check.error, waited_ms });
          return;
        }
        if (check.satisfied) {
          resolve({
            status: 'ok',
            condition: String(opts.condition || 'present'),
            waited_ms,
            match: check.match,
            matchCount: check.matchCount
          });
          return;
        }
        if (waited_ms >= timeoutMs) {
          resolve({
            status: 'timeout',
            condition: String(opts.condition || 'present'),
            waited_ms,
            match: check.match,
            matchCount: check.matchCount,
            message: 'Timed out after ' + waited_ms + 'ms'
          });
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  /**
   * Meta verify: DOM condition on a CSS selector (exists | count_gte | text_includes).
   * Read-only; returns count + optional text sample for the agent runtime to evaluate.
   */
  function agentVerifyDom(opts = {}) {
    const selector = opts.selector != null ? String(opts.selector).trim() : '';
    if (!selector) {
      return { status: 'error', message: 'selector is required', count: 0 };
    }
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(selector));
    } catch (e) {
      return {
        status: 'error',
        message: 'Invalid selector: ' + (e.message || String(e)),
        count: 0,
        error: 'Invalid selector: ' + (e.message || String(e))
      };
    }
    // Skip BrowserBot UI chrome
    els = els.filter((el) => {
      if (!el || el.nodeType !== 1) return false;
      if (
        el.closest &&
        (el.closest('.browserbot-toast-container') ||
          el.closest('.browserbot-exit-float-btn') ||
          el.closest('#browserbot-confirm-bar') ||
          el.id === 'browserbot-region-root')
      ) {
        return false;
      }
      return true;
    });
    const texts = els.slice(0, 20).map((el) => {
      try {
        return String(el.innerText || el.textContent || el.value || '').slice(0, 400);
      } catch (_) {
        return '';
      }
    });
    const text = texts.join('\n').slice(0, 2000);
    return {
      status: 'ok',
      selector,
      count: els.length,
      text,
      texts,
      sample: els[0] ? summarizeElement(els[0]) : null
    };
  }

  function agentScrollIntoView(opts = {}) {
    let block = String(opts.block || 'nearest').toLowerCase();
    if (!['nearest', 'center', 'start', 'end'].includes(block)) block = 'nearest';
    const all = !!opts.all;
    const resolved = resolveAgentTargets(opts);
    if (resolved.error && resolved.elements.length === 0) {
      return { status: 'error', message: resolved.error };
    }
    const targets = all ? resolved.elements.slice(0, 10) : resolved.elements.slice(0, 1);
    if (targets.length === 0) {
      return { status: 'error', message: resolved.error || 'No target elements' };
    }
    const results = [];
    for (const el of targets) {
      try {
        el.scrollIntoView({ block, inline: 'nearest', behavior: 'smooth' });
        results.push({ status: 'ok', block, ...summarizeElement(el) });
      } catch (e) {
        try {
          el.scrollIntoView(block === 'start' || block === 'center');
          results.push({ status: 'ok', block, ...summarizeElement(el) });
        } catch (e2) {
          results.push({ status: 'error', message: e2.message || String(e2), selector: generateSelector(el) });
        }
      }
    }
    return {
      status: results.every((r) => r.status === 'ok') ? 'ok' : 'partial',
      count: results.length,
      source: resolved.source,
      results
    };
  }

  /* ── Unified live-page action (session tool `action`) ──
   * Structural loop: snapshot → opaque local ref (a12) → mutate.
   * Background prefixes f{frameId}. and owns the tab-level rev.
   */

  const ACTION_SNAPSHOT_CAP = 80;
  const ACTION_SELECT_OPTION_CAP = 40;
  const ACTION_WAIT_DEFAULT_MS = 300;
  const ACTION_WAIT_MAX_MS = 5000;
  const ACTION_WAIT_POLL_MS = 150;
  const pawActionEls = new Map();
  const ACTION_INTERACTIVE_SEL = [
    'input',
    'select',
    'textarea',
    'button',
    'a[href]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[contenteditable=""], [contenteditable="true"]',
    '[tabindex]'
  ].join(',');
  const ACTION_KEY_MAP = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 }
  };

  function isActionChrome(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = el.id != null ? String(el.id) : '';
    if (id && (id === 'browserbot-region-root' || id.indexOf('browserbot-') === 0)) return true;
    if (el.classList) {
      for (const c of el.classList) {
        if (String(c).indexOf('browserbot-') === 0) return true;
      }
    }
    try {
      if (el.closest && el.closest('[id^="browserbot-"], [class*="browserbot-"]')) return true;
    } catch (_) {}
    return false;
  }

  function isTabindexOnlyCandidate(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'a') return false;
    if (el.isContentEditable) return false;
    const role = String(el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'combobox' || role === 'textbox') return false;
    return true;
  }

  function collectDeepInteractive(cap = ACTION_SNAPSHOT_CAP) {
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || el.nodeType !== 1 || seen.has(el) || isActionChrome(el)) return;
      seen.add(el);
      out.push(el);
    };
    try { Array.from(document.querySelectorAll(ACTION_INTERACTIVE_SEL)).forEach(add); } catch { /* invalid */ }
    try { queryDeepAll(document, ACTION_INTERACTIVE_SEL).forEach(add); } catch { /* invalid */ }
    return out.slice(0, cap);
  }
  function collectActionInteractive() {
    const seen = new Set();
    const visible = [];
    const hidden = [];
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(ACTION_INTERACTIVE_SEL));
    } catch (_) {
      nodes = [];
    }
    for (const el of nodes) {
      if (!el || el.nodeType !== 1 || seen.has(el) || isActionChrome(el)) continue;
      if (isTabindexOnlyCandidate(el)) {
        const ti = el.getAttribute('tabindex');
        if (ti == null || ti === '') continue;
        if (!isElementVisible(el)) continue;
      }
      seen.add(el);
      (isElementVisible(el) ? visible : hidden).push(el);
    }
    return visible.concat(hidden).slice(0, ACTION_SNAPSHOT_CAP);
  }

  function actionControlType(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') return String(el.type || 'text').toLowerCase();
    return '';
  }

  function actionMaskedValue(el) {
    const tag = (el.tagName || '').toLowerCase();
    const type = actionControlType(el);
    if (type === 'password') return '***';
    if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
    const v = getElementValue(el);
    if (v === undefined || v === null) return '';
    return String(v).slice(0, 200);
  }

  function actionSelectOptions(el) {
    if (!el || (el.tagName || '').toLowerCase() !== 'select') return undefined;
    return Array.from(el.options || []).slice(0, ACTION_SELECT_OPTION_CAP).map((opt) => ({
      value: String(opt.value || ''),
      text: String(opt.textContent || '').trim().slice(0, 80)
    }));
  }

  function actionNorm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function actionAccessibleName(el) {
    const nearby = resolveNearbyLabel(el);
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const bits = [nearby && nearby.label_text, aria, el.placeholder];
    for (const b of bits) {
      const t = cleanDOMText(b || '');
      if (t) return t.slice(0, 80);
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'option') {
      const t = cleanDOMText(el.innerText || el.textContent || '');
      if (t) return t.slice(0, 80);
    }
    return '';
  }

  function actionRole(el) {
    const explicit = String(el.getAttribute && el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    const tag = (el.tagName || '').toLowerCase();
    const type = actionControlType(el);
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'file') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag || 'generic';
  }

  function actionRegion(el) {
    try {
      const fs = el.closest && el.closest('fieldset');
      if (fs) {
        const legend = fs.querySelector(':scope > legend') || fs.querySelector('legend');
        const t = cleanDOMText((legend && (legend.innerText || legend.textContent)) || '');
        if (t) return t.slice(0, 80);
      }
      let cur = el;
      for (let i = 0; i < 8 && cur && cur !== document.documentElement; i++) {
        let sib = cur.previousElementSibling;
        while (sib) {
          const tag = (sib.tagName || '').toLowerCase();
          if (/^h[1-6]$/.test(tag) || String(sib.getAttribute('role') || '') === 'heading') {
            const t = cleanDOMText(sib.innerText || sib.textContent || '');
            if (t) return t.slice(0, 80);
          }
          sib = sib.previousElementSibling;
        }
        cur = cur.parentElement;
      }
    } catch (_) {}
    return undefined;
  }

  function actionPaymentHints(el) {
    const hints = {};
    try {
      const root = el.closest('form') || el.parentElement;
      if (!root) return undefined;
      const text = String(root.innerText || '').slice(0, 2000);
      if (/[¥$€£]|USD|CNY|RMB/.test(text)) hints.currency = true;
      const inputs = root.querySelectorAll ? root.querySelectorAll('input') : [];
      for (const input of inputs) {
        const type = String(input.type || '').toLowerCase();
        const name = String(input.name || input.autocomplete || '').toLowerCase();
        if (type === 'password' || /cc-|card|cvv|cvc|cardnumber/.test(name)) {
          hints.secrets = 'payment';
          break;
        }
      }
    } catch (_) {}
    return hints.currency || hints.secrets ? hints : undefined;
  }

  function summarizeActionControl(el, ref) {
    const type = actionControlType(el);
    const name = actionAccessibleName(el);
    const region = actionRegion(el);
    const row = {
      ref,
      role: actionRole(el),
      name: name || undefined,
      type: type || undefined,
      value: actionMaskedValue(el),
      required: !!el.required,
      frameUrl: location.href
    };
    if (el.disabled) row.disabled = true;
    if (!isElementVisible(el)) row.visible = false;
    if (region) row.region = region;
    const hints = actionPaymentHints(el);
    if (hints) row.hints = hints;
    const options = actionSelectOptions(el);
    if (options) row.options = options;
    return row;
  }

  function actionAfter(el, extra) {
    if (!el) return extra || {};
    const out = {
      ref: extra && extra.ref,
      role: actionRole(el),
      name: actionAccessibleName(el) || undefined,
      type: actionControlType(el) || undefined,
      value: actionMaskedValue(el),
      visible: isElementVisible(el)
    };
    if (extra && typeof extra === 'object') Object.assign(out, extra);
    return out;
  }

  function takeActionSnapshot(workflowTarget, workflowObserve = false) {
    let els = workflowObserve || workflowTarget ? collectDeepInteractive(200) : collectActionInteractive();
    if (workflowTarget) {
      let candidates = [];
      const seed = workflowTarget.css || (workflowTarget.id ? '[id]' : workflowTarget.testId ? '[data-testid]' : workflowTarget.tag || ACTION_INTERACTIVE_SEL);
      try { candidates = [...document.querySelectorAll(seed), ...queryDeepAll(document, seed)]; } catch { /* invalid selector produces no match */ }
      els = candidates.filter(el => !isActionChrome(el) && Object.entries(workflowTarget).every(([key, value]) => {
        if (!value || key === 'css') return !value || key !== 'css' || generateSelector(el) === value || workflowLocator(el).css === value;
        const row = { ...workflowLocator(el), css: workflowTarget.css || generateSelector(el), frameUrl: location.href };
        return String(row[key] || '') === value;
      })).slice(0, 81);
    }
    pawActionEls.clear();
    const controls = [];
    els.forEach((el, i) => {
      const ref = 'a' + (i + 1);
      pawActionEls.set(ref, el);
      controls.push({ ...summarizeActionControl(el, ref), ...(workflowTarget ? { ...workflowLocator(el), css: workflowTarget.css || generateSelector(el), value: workflowSensitive(el) ? '***' : String(getElementValue(el) ?? '').slice(0, 20000), text: String(el.innerText || el.textContent || '').slice(0, 4000) } : {}) });
    });
    let canvasCount = 0;
    try { canvasCount = document.querySelectorAll('canvas').length; } catch (_) {}
    // Small evidence inventory, not media bytes or a host-selected workflow.
    const mediaElements = [];
    try {
      for (const el of Array.from(document.querySelectorAll('video,audio')).slice(0, 6)) {
        const src = String(el.currentSrc || el.src || '');
        mediaElements.push({
          kind: el.tagName.toLowerCase(), visible: isElementVisible(el),
          paused: el.paused, ended: el.ended, readyState: el.readyState,
          currentTime: Number.isFinite(el.currentTime) ? Math.round(el.currentTime * 10) / 10 : null,
          duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null,
          sourceKind: /^https?:/.test(src) ? 'http-candidate' : src.startsWith('blob:') || el.srcObject ? 'stream' : 'unknown',
          ...(/^https?:/.test(src) && src.length <= 2000 ? { src } : {})
        });
      }
    } catch (_) {}
    return {
      ok: true,
      op: 'snapshot',
      frameUrl: location.href,
      title: document.title,
      count: controls.length,
      ...(workflowObserve ? { text: String(document.body?.innerText || '').slice(0, 100000) } : {}),
      controls,
      canvasCount,
      mediaElements
    };
  }

  function parseLocalActionRef(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return '';
    const stripped = raw.replace(/^f\d+\./i, '');
    const m = stripped.match(/^(a\d+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function ensureActionMap() {
    if (pawActionEls.size === 0) takeActionSnapshot();
  }

  function findActionsByName(query) {
    const q = actionNorm(query);
    if (!q) return { exact: [], fuzzy: [] };
    ensureActionMap();
    const exact = [];
    const fuzzy = [];
    for (const [ref, el] of pawActionEls) {
      if (!el || el.isConnected === false) continue;
      const name = actionNorm(actionAccessibleName(el));
      if (!name) continue;
      if (name === q) exact.push({ ref, el });
      else if (name.indexOf(q) >= 0 || (q.indexOf(name) >= 0 && name.length >= 2)) {
        fuzzy.push({ ref, el });
      }
    }
    return { exact, fuzzy };
  }

  function pickActionsByName(query) {
    const { exact, fuzzy } = findActionsByName(query);
    if (exact.length === 1) return { hits: exact };
    if (exact.length > 1) return { hits: exact, ambiguous: true };
    if (fuzzy.length === 1) return { hits: fuzzy };
    if (fuzzy.length > 1) return { hits: fuzzy, ambiguous: true };
    return { hits: [] };
  }

  function hasActionTargetHint(opts) {
    if (opts == null) return false;
    if (opts.ref != null && String(opts.ref).trim() !== '') return true;
    if (opts.name != null && String(opts.name).trim() !== '') return true;
    if (opts.label != null && String(opts.label).trim() !== '') return true;
    if (opts.css != null && String(opts.css).trim() !== '') return true;
    return false;
  }

  function resolveActionTarget(opts) {
    const local = parseLocalActionRef(opts && opts.ref);
    if (local) {
      ensureActionMap();
      const el = pawActionEls.get(local);
      if (el && el.isConnected !== false) {
        return { el, source: 'ref', ref: local };
      }
      const fallbackName = opts && (opts.name != null ? opts.name : opts.label);
      if (fallbackName != null && String(fallbackName).trim() !== '') {
        const picked = pickActionsByName(fallbackName);
        if (picked.ambiguous) {
          return {
            el: null,
            error: 'name matches multiple controls',
            code: 'AMBIGUOUS',
            matches: picked.hits.map((h) => ({ ref: h.ref, name: actionAccessibleName(h.el) }))
          };
        }
        if (picked.hits.length === 1) {
          return { el: picked.hits[0].el, source: 'name', ref: picked.hits[0].ref, stale: true };
        }
      }
      return { el: null, error: 'ref is missing or detached — snapshot again', code: 'STALE_REF', ref: local };
    }
    const name = opts && (opts.name != null ? opts.name : opts.label);
    if (name != null && String(name).trim() !== '') {
      const picked = pickActionsByName(name);
      if (picked.ambiguous) {
        return {
          el: null,
          error: 'name matches multiple controls',
          code: 'AMBIGUOUS',
          matches: picked.hits.map((h) => ({ ref: h.ref, name: actionAccessibleName(h.el) }))
        };
      }
      if (!picked.hits.length) {
        return { el: null, error: 'no control matches name', code: 'NO_TARGET' };
      }
      return { el: picked.hits[0].el, source: 'name', ref: picked.hits[0].ref };
    }
    const css = opts && opts.css != null ? String(opts.css).trim() : '';
    if (css) {
      try {
        const found = Array.from(document.querySelectorAll(css)).filter((el) => !isActionChrome(el));
        if (!found.length) {
          return { el: null, error: 'no elements match css', code: 'NO_TARGET' };
        }
        const visible = found.find(isElementVisible);
        return { el: visible || found[0], source: 'css' };
      } catch (e) {
        return { el: null, error: 'invalid css selector: ' + (e.message || String(e)), code: 'BAD_INPUT' };
      }
    }
    return { el: null, error: 'need ref or name', code: 'NO_TARGET' };
  }

  function parseCheckedToken(value) {
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === 'on' || s === '1' || s === 'yes' || s === 'checked') return true;
    if (s === 'false' || s === 'off' || s === '0' || s === 'no' || s === 'unchecked') return false;
    return null;
  }

  function isOptionLikeNode(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    const role = String(el.getAttribute('role') || '').toLowerCase();
    return tag === 'option' || role === 'option' || role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox';
  }

  function scrollActionTarget(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {
      try { el.scrollIntoView(true); } catch (_) {}
    }
  }

  function visualDomBlock(el) {
    if (!el || el.nodeType !== 1) return '';
    if (String(el.tagName || '').toLowerCase() === 'canvas') return 'canvas';
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (_) { return ''; }
    if (!rect || rect.width < 1 || rect.height < 1) return '';
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > (window.innerWidth || 0) || y > (window.innerHeight || 0)) return '';
    let hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (_) { return ''; }
    if (!hit || hit.nodeType !== 1) return '';
    const hitTag = String(hit.tagName || '').toLowerCase();
    if (hitTag === 'canvas' && hit !== el && !el.contains(hit)) return 'canvas';
    if (hit === el || el.contains(hit) || hit.contains(el)) return '';
    return 'occluded';
  }

  function visualDomFailure(el) {
    const block = visualDomBlock(el);
    if (block === 'canvas') {
      return { ok: false, code: 'NO_TARGET', hit: 'canvas', error: 'Top hit is a canvas. Use pointer method=cdp.' };
    }
    if (block === 'occluded') {
      return { ok: false, code: 'NO_TARGET', occluded: true, error: 'elementFromPoint did not hit the target ref.' };
    }
    return null;
  }

  function clickActionTarget(el) {
    const tag = (el.tagName || '').toLowerCase();
    const type = actionControlType(el);
    if (tag === 'input' && type === 'file') {
      return { ok: false, code: 'FILE_CHOOSER', error: 'native file chooser; use action op=upload with path' };
    }
    scrollActionTarget(el);
    try { el.focus({ preventScroll: true }); } catch (_) {}
    try { el.click(); } catch (_) {}
    return { ok: true };
  }

  function fillActionTarget(el, value) {
    const tag = (el.tagName || '').toLowerCase();
    const type = actionControlType(el);
    if (tag === 'input' && type === 'file') {
      return { ok: false, error: 'file inputs cannot be filled; use action op=upload with path', code: 'FILE_INPUT' };
    }
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      const token = parseCheckedToken(value);
      if (token !== null) el.checked = token;
      else if (type === 'radio') el.checked = String(el.value) === String(value);
      else el.checked = true;
      dispatchValueEvents(el, value);
      return { ok: true };
    }
    if (tag === 'input' || tag === 'textarea') {
      setNativeInputValue(el, value);
      return { ok: true };
    }
    if (tag === 'select') {
      const hit = matchSelectOption(el, value);
      if (!hit) return { ok: false, error: 'no matching option', code: 'NO_TARGET' };
      el.value = hit.value;
      dispatchValueEvents(el, hit.value);
      return { ok: true };
    }
    if (el.isContentEditable) {
      el.textContent = value == null ? '' : String(value);
      dispatchValueEvents(el, value);
      return { ok: true };
    }
    if ('value' in el) {
      el.value = value == null ? '' : String(value);
      dispatchValueEvents(el, value);
      return { ok: true };
    }
    return { ok: false, error: 'target is not fillable', code: 'NO_TARGET' };
  }

  function matchSelectOption(el, value) {
    const want = String(value);
    const wantLower = want.toLowerCase();
    const opts = Array.from(el.options || []);
    return (
      opts.find((o) => String(o.value) === want) ||
      opts.find((o) => String(o.textContent || '').trim() === want) ||
      opts.find((o) => String(o.textContent || '').trim().toLowerCase().indexOf(wantLower) >= 0)
    );
  }

  function findOptionLikeByValue(root, value) {
    const want = String(value).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!want) return null;
    const scope = root && root.querySelectorAll ? root : document;
    let nodes = [];
    try {
      nodes = Array.from(scope.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], option'));
    } catch (_) {
      nodes = [];
    }
    for (const el of nodes) {
      if (isActionChrome(el)) continue;
      const text = String(el.innerText || el.textContent || el.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const val = String(el.getAttribute('value') || el.value || '').toLowerCase();
      if (text === want || val === want || text.indexOf(want) >= 0) return el;
    }
    const picked = pickActionsByName(value);
    return picked.hits.length === 1 ? picked.hits[0].el : null;
  }

  function pressActionKey(el, keyRaw) {
    const raw = String(keyRaw || '').trim();
    if (!raw) return { ok: false, error: 'key is required', code: 'BAD_INPUT' };
    const mapped = ACTION_KEY_MAP[raw.toLowerCase()] || {
      key: raw.length === 1 ? raw : raw,
      code: raw.length === 1 ? 'Key' + raw.toUpperCase() : raw,
      keyCode: raw.length === 1 ? raw.toUpperCase().charCodeAt(0) : 0
    };
    const target = el && el.nodeType === 1 ? el : document.activeElement || document.body;
    try { target.focus({ preventScroll: true }); } catch (_) {}
    const common = {
      key: mapped.key,
      code: mapped.code,
      keyCode: mapped.keyCode,
      which: mapped.keyCode,
      bubbles: true,
      cancelable: true
    };
    try { target.dispatchEvent(new KeyboardEvent('keydown', common)); } catch (_) {}
    try { target.dispatchEvent(new KeyboardEvent('keyup', common)); } catch (_) {}
    return { ok: true, after: actionAfter(target, { key: mapped.key }) };
  }

  function waitActionCondition(request) {
    let ms = Number(request.ms);
    if (!Number.isFinite(ms) || ms < 0) ms = ACTION_WAIT_MAX_MS;
    ms = Math.min(Math.round(ms), ACTION_WAIT_MAX_MS);
    const local = parseLocalActionRef(request.ref);
    const text = request.text != null ? String(request.text).trim() : '';
    if (!local && !text) {
      const sleep = Number.isFinite(Number(request.ms))
        ? Math.min(Math.max(0, Math.round(Number(request.ms))), ACTION_WAIT_MAX_MS)
        : ACTION_WAIT_DEFAULT_MS;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, op: 'wait', waited: sleep }), sleep);
      });
    }
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const waited = Date.now() - started;
        if (local) {
          ensureActionMap();
          const el = pawActionEls.get(local);
          if (el && el.isConnected !== false && isElementVisible(el)) {
            resolve({ ok: true, op: 'wait', waited, after: actionAfter(el, { ref: local }) });
            return;
          }
        } else {
          const check = matchWaitCondition({ text, condition: 'visible' });
          if (check && check.ok && check.satisfied) {
            resolve({
              ok: true,
              op: 'wait',
              waited,
              after: check.match || { text }
            });
            return;
          }
        }
        if (waited >= ms) {
          resolve({
            ok: false,
            error: 'wait timed out',
            code: 'NO_TARGET',
            waited
          });
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  function runFillFormFields(fields) {
    const results = [];
    let allOk = true;
    for (const field of Array.isArray(fields) ? fields : []) {
      if (!field || typeof field !== 'object') {
        allOk = false;
        results.push({ ok: false, error: 'invalid field', code: 'BAD_INPUT' });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(field, 'value')) {
        allOk = false;
        results.push({ ok: false, ref: field.ref, error: 'value is required', code: 'BAD_INPUT' });
        continue;
      }
      const resolved = resolveActionTarget(field);
      if (!resolved.el) {
        allOk = false;
        results.push({
          ok: false,
          ref: resolved.ref || parseLocalActionRef(field.ref) || undefined,
          error: resolved.error || 'no target',
          code: resolved.code || 'NO_TARGET',
          matches: resolved.matches
        });
        continue;
      }
      const filled = fillActionTarget(resolved.el, field.value);
      if (!filled.ok) {
        allOk = false;
        results.push({
          ok: false,
          ref: resolved.ref,
          error: filled.error,
          code: filled.code || 'NO_TARGET'
        });
        continue;
      }
      results.push({
        ok: true,
        ref: resolved.ref,
        after: actionAfter(resolved.el, { ref: resolved.ref, source: resolved.source })
      });
    }
    return { ok: allOk, op: 'fill_form', results };
  }

  function runWorkspacePageAction(request) {
    const op = String(request && request.op || '').trim().toLowerCase();
    if (!op) return { ok: false, error: 'op is required', code: 'BAD_INPUT' };

    if (op === 'wait') return waitActionCondition(request);

    if (op === 'snapshot') return takeActionSnapshot(request.workflowTarget, request.workflowObserve);
    if (op === 'scrape') return scrapeWorkflow(request);

    if (op === 'pointer') {
      const x = Number(request.x);
      const y = Number(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) {
        return { ok: false, code: 'BAD_INPUT', error: 'pointer requires x and y in 0–1 viewport units' };
      }
      const px = x * (window.innerWidth || 1);
      const py = y * (window.innerHeight || 1);
      let el = null;
      try { el = document.elementFromPoint(px, py); } catch (_) {}
      if (!el || el.nodeType !== 1) {
        return { ok: false, code: 'NO_TARGET', error: 'no element at viewport point', x, y };
      }
      if (String(el.tagName || '').toLowerCase() === 'canvas') {
        return {
          ok: false,
          code: 'NO_TARGET',
          hit: 'canvas',
          x,
          y,
          error: 'method=point cannot click inside a canvas.',
          hint: 'Use action op=pointer with method=cdp and the same 0–1 x,y.'
        };
      }
      const clicked = clickActionTarget(el);
      if (clicked && clicked.ok === false) return clicked;
      return { ok: true, op, methodUsed: 'point', x, y, after: actionAfter(el, { source: 'point' }) };
    }

    if (op === 'resolve_name') {
      const query = request.name != null ? request.name : request.label;
      const { exact, fuzzy } = findActionsByName(query);
      const list = exact.length ? exact : fuzzy;
      return {
        ok: true,
        op: 'resolve_name',
        matches: list.map((h) => ({
          ref: h.ref,
          name: actionAccessibleName(h.el)
        }))
      };
    }

    if (op === 'fill_form') {
      return runFillFormFields(request.fields);
    }

    if (op === 'press' && !hasActionTargetHint(request)) {
      const pressed = pressActionKey(document.activeElement || document.body, request.key);
      return pressed.ok ? { ok: true, op, ...pressed } : pressed;
    }

    const resolved = resolveActionTarget(request);
    if (!resolved.el) {
      return {
        ok: false,
        error: resolved.error || 'no target',
        code: resolved.code || 'NO_TARGET',
        matches: resolved.matches
      };
    }
    const el = resolved.el;
    const afterExtra = { source: resolved.source, ref: resolved.ref };

    if (op === 'click') {
      const blocked = visualDomFailure(el);
      if (blocked) return blocked;
      const clicked = clickActionTarget(el);
      if (clicked && clicked.ok === false) return clicked;
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }

    if (op === 'hover') {
      scrollActionTarget(el);
      try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window })); } catch { /* */ }
      try { el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window })); } catch { /* */ }
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }
    if (op === 'dblclick') {
      scrollActionTarget(el);
      try { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); } catch { /* */ }
      try { el.click(); } catch { /* */ }
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }
    if (op === 'contextmenu') {
      scrollActionTarget(el);
      try { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 })); } catch { /* */ }
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }
    if (op === 'toggle') {
      const type = actionControlType(el);
      if (type !== 'checkbox' && type !== 'radio' && actionRole(el) !== 'checkbox' && actionRole(el) !== 'radio') {
        return { ok: false, code: 'NO_TARGET', error: 'toggle requires a checkbox or radio' };
      }
      const token = request.value === true || request.value === 'true' || request.checked === true;
      if (el.checked !== token) {
        const clicked = clickActionTarget(el);
        if (clicked && clicked.ok === false) return clicked;
      }
      el.checked = token;
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }

    if (op === 'mark_upload') {
      const token = String(request.token || '').replace(/[^\w.-]/g, '');
      if (!token) return { ok: false, code: 'BAD_INPUT', error: 'mark_upload token required' };
      el.setAttribute('data-paw-upload', token);
      return {
        ok: true,
        op,
        tag: (el.tagName || '').toLowerCase(),
        type: actionControlType(el),
        hidden: typeof isElementVisible === 'function' ? !isElementVisible(el) : false
      };
    }

    if (op === 'scroll') {
      if (request.deltaY != null) {
        if (!Number.isFinite(request.deltaY) || Math.abs(request.deltaY) > 100000) return { ok: false, code: 'BAD_INPUT', error: 'Invalid scroll distance.' };
        el.scrollBy({ top: request.deltaY, behavior: 'instant' });
      } else scrollActionTarget(el);
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }

    if (op === 'fill') {
      const blocked = visualDomFailure(el);
      if (blocked) return blocked;
      if (!Object.prototype.hasOwnProperty.call(request, 'value')) {
        return { ok: false, error: 'value is required', code: 'BAD_INPUT' };
      }
      const filled = fillActionTarget(el, request.value);
      if (!filled.ok) return filled;
      return { ok: true, op, after: actionAfter(el, afterExtra) };
    }

    if (op === 'select') {
      if (!Object.prototype.hasOwnProperty.call(request, 'value') && !isOptionLikeNode(el)) {
        return { ok: false, error: 'value is required', code: 'BAD_INPUT' };
      }
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'select') {
        const hit = matchSelectOption(el, request.value);
        if (!hit) return { ok: false, error: 'no matching option', code: 'NO_TARGET' };
        el.value = hit.value;
        dispatchValueEvents(el, hit.value);
        return { ok: true, op, after: actionAfter(el, { ...afterExtra, selected: hit.value }) };
      }
      if (isOptionLikeNode(el)) {
        clickActionTarget(el);
        return { ok: true, op, after: actionAfter(el, afterExtra) };
      }
      const opt = findOptionLikeByValue(el.parentElement || document, request.value);
      if (!opt) return { ok: false, error: 'no matching option-like node', code: 'NO_TARGET' };
      clickActionTarget(opt);
      return { ok: true, op, after: actionAfter(opt, { source: 'option' }) };
    }

    if (op === 'press') {
      const pressed = pressActionKey(el, request.key);
      return pressed.ok ? { ok: true, op, ...pressed } : pressed;
    }

    return { ok: false, error: 'unknown op ' + op, code: 'BAD_INPUT' };
  }

  /* ── Anchor semantics: nearby labels + role guess (agent tools) ── */

  /**
   * Guess field role from label-ish text (zh + en keywords).
   * @returns {'phone'|'email'|'price'|'title'|'name'|'unknown'}
   */
  function guessRoleFromLabelText(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return 'unknown';
    if (
      /电话|手机|联系电话|手机号|tel\b|phone|mobile|cellphone|cell\b/.test(t) ||
      /\b(tel|phone|mobile)\b/.test(t)
    ) {
      return 'phone';
    }
    if (/邮箱|电子邮件|e-?mail|\bmail\b|email/.test(t)) return 'email';
    if (/价格|价钱|金额|售价|单价|报价|price|cost|amount|fee|¥|\$|usd|cny|rmb/.test(t)) {
      return 'price';
    }
    if (/标题|题目|主题|headline|subject|\btitle\b/.test(t)) return 'title';
    if (/姓名|名字|名称|全名|first\s*name|last\s*name|full\s*name|\bname\b|username|昵称/.test(t)) {
      return 'name';
    }
    return 'unknown';
  }

  function confidenceFromLabelSources(sources, roleGuess) {
    const set = new Set(Array.isArray(sources) ? sources : []);
    let base = 0.12;
    if (set.has('label_for') || set.has('label_wrap')) base = 0.9;
    else if (set.has('aria-label') || set.has('aria-labelledby')) base = 0.82;
    else if (set.has('table_header')) base = 0.72;
    else if (set.has('placeholder') || set.has('title')) base = 0.55;
    else if (set.has('name')) base = 0.48;
    else if (set.has('prev_sibling')) base = 0.38;
    if (roleGuess && roleGuess !== 'unknown') base = Math.min(0.98, base + 0.06);
    return Math.round(base * 100) / 100;
  }

  /**
   * Plain text of a label element without the control's own value/text pollution.
   */
  function labelElementText(labelEl, controlEl) {
    if (!labelEl) return '';
    try {
      // Prefer clone so we can strip nested controls' values from the label string
      const clone = labelEl.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
      const t = cleanDOMText(clone.innerText || clone.textContent || '');
      if (t) return t.slice(0, 80);
    } catch (_) { /* fall through */ }
    return cleanDOMText(labelEl.innerText || labelEl.textContent || '').slice(0, 80);
  }

  function previousSiblingLabelText(el) {
    if (!el) return '';
    // Prefer previous element sibling text
    let sib = el.previousElementSibling;
    if (sib) {
      const tag = (sib.tagName || '').toLowerCase();
      if (tag === 'label' || tag === 'span' || tag === 'div' || tag === 'p' || tag === 'td' || tag === 'th' || tag === 'strong' || tag === 'b' || tag === 'em') {
        const t = cleanDOMText(sib.innerText || sib.textContent || '').slice(0, 80);
        if (t) return t;
      }
    }
    // Walk previous text nodes
    let node = el.previousSibling;
    let acc = '';
    while (node) {
      if (node.nodeType === 3) {
        acc = (node.textContent || '') + acc;
      } else if (node.nodeType === 1) {
        break;
      }
      node = node.previousSibling;
    }
    return cleanDOMText(acc).slice(0, 80);
  }

  function tableHeaderForTd(el) {
    if (!el || (el.tagName || '').toLowerCase() !== 'td') return '';
    const tr = el.parentElement;
    if (!tr || (tr.tagName || '').toLowerCase() !== 'tr') return '';
    const cells = Array.from(tr.children).filter(
      (c) => {
        const t = (c.tagName || '').toLowerCase();
        return t === 'td' || t === 'th';
      }
    );
    const colIndex = cells.indexOf(el);
    if (colIndex < 0) return '';
    const table = el.closest('table');
    if (!table) return '';
    // thead th same column
    const theadRow = table.querySelector('thead tr');
    if (theadRow) {
      const ths = Array.from(theadRow.children).filter((c) => {
        const t = (c.tagName || '').toLowerCase();
        return t === 'th' || t === 'td';
      });
      if (ths[colIndex]) {
        const t = cleanDOMText(ths[colIndex].innerText || ths[colIndex].textContent || '').slice(0, 80);
        if (t) return t;
      }
    }
    // first row th
    const firstRow = table.querySelector('tr');
    if (firstRow && firstRow !== tr) {
      const ths = Array.from(firstRow.children).filter((c) => {
        const t = (c.tagName || '').toLowerCase();
        return t === 'th' || t === 'td';
      });
      const cell = ths[colIndex];
      if (cell && (cell.tagName || '').toLowerCase() === 'th') {
        const t = cleanDOMText(cell.innerText || cell.textContent || '').slice(0, 80);
        if (t) return t;
      }
    }
    // scope="col" headers via cellIndex (handles colspan lightly via sequential index)
    const allTh = table.querySelectorAll('th[scope="col"], thead th');
    if (allTh[colIndex]) {
      const t = cleanDOMText(allTh[colIndex].innerText || allTh[colIndex].textContent || '').slice(0, 80);
      if (t) return t;
    }
    return '';
  }

  /**
   * Pure DOM: resolve a human-readable label near `el`.
   * @returns {{ label_text: string, sources: string[], role_guess: string }}
   */
  function resolveNearbyLabel(el) {
    if (!el || el.nodeType !== 1) {
      return { label_text: '', sources: [], role_guess: 'unknown' };
    }

    const candidates = []; // { source, text } in priority order

    // 1. label[for=id]
    if (el.id) {
      try {
        const esc =
          typeof CSS !== 'undefined' && CSS.escape
            ? CSS.escape(el.id)
            : String(el.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const lab = document.querySelector(`label[for="${esc}"]`);
        if (lab) {
          const t = labelElementText(lab, el);
          if (t) candidates.push({ source: 'label_for', text: t });
        }
      } catch (_) { /* ignore invalid id */ }
    }

    // 2. wrapping label
    try {
      const wrap = el.closest && el.closest('label');
      if (wrap) {
        const t = labelElementText(wrap, el);
        if (t) candidates.push({ source: 'label_wrap', text: t });
      }
    } catch (_) {}

    // 3. aria-label
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel && String(ariaLabel).trim()) {
      candidates.push({ source: 'aria-label', text: cleanDOMText(ariaLabel).slice(0, 80) });
    }

    // 4. aria-labelledby
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy && String(labelledBy).trim()) {
      const parts = String(labelledBy)
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          try {
            const node = document.getElementById(id);
            return node ? cleanDOMText(node.innerText || node.textContent || '') : '';
          } catch (_) {
            return '';
          }
        })
        .filter(Boolean);
      const joined = cleanDOMText(parts.join(' ')).slice(0, 80);
      if (joined) candidates.push({ source: 'aria-labelledby', text: joined });
    }

    // 5. placeholder
    const placeholder =
      (el.placeholder != null && String(el.placeholder)) ||
      (el.getAttribute && el.getAttribute('placeholder')) ||
      '';
    if (placeholder && String(placeholder).trim()) {
      candidates.push({ source: 'placeholder', text: cleanDOMText(placeholder).slice(0, 80) });
    }

    // 6. title
    const titleAttr =
      (el.title != null && String(el.title)) ||
      (el.getAttribute && el.getAttribute('title')) ||
      '';
    if (titleAttr && String(titleAttr).trim()) {
      candidates.push({ source: 'title', text: cleanDOMText(titleAttr).slice(0, 80) });
    }

    // 7. name
    const nameAttr =
      (el.name != null && String(el.name)) ||
      (el.getAttribute && el.getAttribute('name')) ||
      '';
    if (nameAttr && String(nameAttr).trim()) {
      // Humanize name=user_email → user email
      const human = cleanDOMText(String(nameAttr).replace(/[_-]+/g, ' ')).slice(0, 80);
      if (human) candidates.push({ source: 'name', text: human });
    }

    // 8. previous sibling text
    const prev = previousSiblingLabelText(el);
    if (prev) candidates.push({ source: 'prev_sibling', text: prev });

    // 9. table header for td
    const thText = tableHeaderForTd(el);
    if (thText) candidates.push({ source: 'table_header', text: thText });

    const sources = [];
    const seen = new Set();
    for (const c of candidates) {
      if (!c.text || seen.has(c.source)) continue;
      seen.add(c.source);
      sources.push(c.source);
    }

    const label_text = candidates.length ? candidates[0].text : '';
    const role_guess = guessRoleFromLabelText(label_text);

    return { label_text, sources, role_guess };
  }

  /**
   * Resolve nearby label / role for selected anchors.
   * Request: { indices?: number[], max?: number }
   */
  function agentResolveAnchorSemantics(request = {}) {
    const totalSelected = selectedElements.length;
    if (totalSelected === 0) {
      return { status: 'empty', count: 0, items: [] };
    }

    let max =
      typeof request.max === 'number' && Number.isFinite(request.max)
        ? Math.floor(request.max)
        : 40;
    max = Math.min(Math.max(1, max), 40);

    let indices;
    if (Array.isArray(request.indices) && request.indices.length) {
      indices = request.indices
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0 && n < totalSelected);
      // de-dupe preserve order
      const seenIdx = new Set();
      indices = indices.filter((i) => {
        if (seenIdx.has(i)) return false;
        seenIdx.add(i);
        return true;
      });
    } else {
      indices = selectedElements.map((_, i) => i);
    }
    indices = indices.slice(0, max);

    const items = [];
    for (const index of indices) {
      const item = selectedElements[index];
      if (!item) continue;

      const el = item.element;
      const connected = !!(el && el.isConnected !== false);
      const tag = String(item.tag || (el && el.tagName) || '').toLowerCase();
      const kind = classifySelectionKind(item);
      const selector = item.selector ? String(item.selector).slice(0, 120) : undefined;

      let label_text = '';
      let role_guess = 'unknown';
      let confidence = 0.1;
      const nearby = {};
      let text_preview = '';

      if (connected) {
        let resolved;
        try {
          resolved = resolveNearbyLabel(el);
        } catch (_) {
          resolved = { label_text: '', sources: [], role_guess: 'unknown' };
        }
        label_text = resolved.label_text || '';
        role_guess = resolved.role_guess || 'unknown';
        confidence = confidenceFromLabelSources(resolved.sources, role_guess);

        try {
          const before = previousSiblingLabelText(el);
          if (before) nearby.before = before.slice(0, 80);
        } catch (_) {}
        try {
          const ph =
            (el.placeholder != null && String(el.placeholder)) ||
            (el.getAttribute && el.getAttribute('placeholder')) ||
            '';
          if (ph && String(ph).trim()) nearby.placeholder = cleanDOMText(ph).slice(0, 80);
        } catch (_) {}
        try {
          const nm =
            (el.name != null && String(el.name)) ||
            (el.getAttribute && el.getAttribute('name')) ||
            '';
          if (nm && String(nm).trim()) nearby.name = String(nm).slice(0, 80);
        } catch (_) {}

        try {
          const live =
            el.value != null && String(el.value).trim()
              ? String(el.value)
              : el.innerText || el.textContent || '';
          text_preview = cleanDOMText(live).slice(0, 80);
        } catch (_) {
          text_preview = cleanDOMText(item.text || '').slice(0, 80);
        }
      } else {
        // Detached: fall back to stored selection text
        text_preview = cleanDOMText(String(item.text || '')).slice(0, 80);
        label_text = text_preview;
        role_guess = guessRoleFromLabelText(label_text);
        confidence = role_guess !== 'unknown' ? 0.25 : 0.1;
      }

      const out = {
        index,
        tag,
        kind,
        label_text: String(label_text || '').slice(0, 80),
        role_guess: role_guess || 'unknown',
        confidence,
        nearby,
        text_preview: String(text_preview || '').slice(0, 80)
      };
      if (selector) out.selector = selector;
      items.push(out);
    }

    if (!items.length) {
      return { status: 'empty', count: 0, items: [] };
    }
    return { status: 'ok', count: items.length, items };
  }

  async function captureWorkspaceItem(request) {
    const selector = String(request?.selector || '').trim();
    const wantSrc = String(request?.src || '').trim();
    const fingerprint = request?.locatorFingerprint || request?.locator?.fingerprint;
    let el = null;
    if (selector) {
      try { el = document.querySelector(selector); } catch (error) { /* try src */ }
    }
    if (fingerprint) {
      if (!isLiveElement(el)) return { ok: false, code: 'STALE_SELECTION', error: 'captured element is no longer available' };
      const actual = locatorFingerprint(el, contextTextPreservingBlocks(el), contextSrcOf(el), contextHrefOf(el));
      const has = (key) => Object.prototype.hasOwnProperty.call(fingerprint, key);
      const exact = (!has('tag') || actual.tag === String(fingerprint.tag).toLowerCase()) &&
        (!has('src') || actual.src === String(fingerprint.src)) &&
        (!has('href') || actual.href === String(fingerprint.href)) &&
        (!has('text') || actual.text === String(fingerprint.text));
      if (!exact) return { ok: false, code: 'STALE_SELECTION', error: 'captured element identity changed' };
    } else if (!isLiveElement(el) || (wantSrc && srcIdentity(el.currentSrc || el.src) !== srcIdentity(wantSrc))) {
      const bySrc = findElementForItem({ src: wantSrc, selector });
      if (bySrc) el = bySrc;
    }
    if (!el && !wantSrc) return { ok: false, error: 'selected element is no longer available' };
    const tag = String(el?.tagName || (wantSrc ? 'img' : '')).toLowerCase();
    const text = el ? cleanDOMText((el.innerText || el.textContent || '').slice(0, 12000)) : '';
    const captureBytes = request?.captureBytes === true;
    if (el && tag === 'canvas') {
      try { return { ok: true, tag, text, dataUrl: el.toDataURL('image/png') }; }
      catch (error) { return { ok: false, error: error?.message || 'canvas capture failed' }; }
    }
    if (el && tag === 'svg') {
      try {
        const svg = new XMLSerializer().serializeToString(el);
        return { ok: true, tag, text, dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
      } catch (error) { return { ok: false, error: error?.message || 'svg capture failed' }; }
    }
    const src =
      wantSrc ||
      (el && (el.currentSrc || el.src || el.getAttribute?.('src'))) ||
      '';
    const href = el?.href || el?.getAttribute?.('href') || null;
    const kind = classifyContextKind({ tag, src, href, text });
    const context = {
      html: el ? String(el.outerHTML || '').slice(0, 16000) : '',
      parentText: el ? cleanDOMText((el.parentElement?.innerText || '').slice(0, 4000)) : '',
      href,
      src: src || null,
      alt: el?.getAttribute?.('alt') || null,
      kind
    };
    const wantImageBytes =
      kind === 'image' ||
      kind === 'vector' ||
      kind === 'screenshot' ||
      srcLooksImage(src);
    if (wantImageBytes && (tag === 'img' || src || String(src).startsWith('blob:'))) {
      if (!captureBytes && !String(src).startsWith('blob:') && !String(src).startsWith('data:')) {
        return { ok: true, tag, text, src, kind, context };
      }
      const dataUrl = await fetchUrlAsDataUrlInTabContext(src);
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) return { ok: true, tag, text, src, kind, dataUrl, context };
      return { ok: false, error: 'image bytes unavailable in page context', src, text, kind, context };
    }
    if (!el) return { ok: false, error: 'selected element is no longer available' };
    return {
      ok: true,
      tag,
      text,
      kind,
      href,
      src: src || null,
      context
    };
  }

  // Explicit, trusted-user recording. No password/OTP/payment values cross the bus.
  const workflowRecorder = { active: false, id: null, pending: null, timer: null, inflight: new Set() };
  function workflowSensitive(el) {
    return el?.type === 'password' || /password|passwd|token|secret|one.?time|otp|cvv|cvc|card|cc-|payment|api.?key/i.test([el?.name, el?.id, el?.autocomplete, el?.getAttribute?.('aria-label')].join(' '));
  }
  function looksGeneratedId(id) {
    return /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || /^(ember|react|gwt)-?\d/i.test(id) || String(id).length > 64;
  }
  function workflowLocator(el) {
    const all = collectDeepInteractive(200);
    const unique = pred => all.filter(pred).length === 1;
    const out = { tag: String(el.tagName || '').toLowerCase(), role: actionRole(el), name: actionAccessibleName(el) || '', type: actionControlType(el) || '' };
    const testId = el.getAttribute?.('data-testid');
    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const shadowPath = composeShadowPath(el);
    if (shadowPath) out.shadowPath = shadowPath;
    const region = actionRegion(el); if (region) out.region = region;
    if (el.href) out.key = String(el.href);
    if (testId && unique(e => e.getAttribute?.('data-testid') === testId)) { out.testId = testId; return out; }
    if (el.id && !looksGeneratedId(el.id) && unique(e => e.id === el.id)) { out.id = el.id; return out; }
    if (out.role && out.name && unique(e => actionRole(e) === out.role && actionAccessibleName(e) === out.name)) return out;
    if (out.name && unique(e => actionAccessibleName(e) === out.name)) return out;
    if (text && unique(e => String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) === text)) { out.text = text; return out; }
    if (testId) out.testId = testId;
    else if (el.id) out.id = el.id;
    else if (!out.name) out.css = generateSelector(el);
    if (text && !out.name) out.text = text;
    return out;
  }
  function scrapeWorkflow(request) {
    const kind = String(request.kind || 'links');
    const itemKey = request.itemKey || (kind === 'links' ? 'href' : 'text');
    const columns = Array.isArray(request.columns) ? request.columns.map(col => typeof col === 'string' ? { name: col, attr: col } : col) : [];
    const scopeEls = request.target ? (takeActionSnapshot(request.target, true).controls || []).map(row => pawActionEls.get(row.ref)).filter(Boolean) : collectDeepInteractive(200);
    const items = [];
    const push = (el, extra) => {
      const loc = workflowLocator(el);
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const href = el.href || el.getAttribute?.('href') || '';
      const row = { ...extra, text, href, name: loc.name || '', testId: loc.testId || '', id: loc.id || '', target: loc, frameUrl: location.href };
      row.key = String(row[itemKey] || loc.testId || loc.id || loc.name || href || text || '');
      if (row.key) items.push(row);
    };
    if (kind === 'table') {
      const table = scopeEls.find(el => (el.tagName || '').toLowerCase() === 'table') || document.querySelector('table');
      if (!table) return { ok: true, op: 'scrape', items: [], count: 0, kind };
      const headers = Array.from(table.querySelectorAll('th')).map(th => String(th.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const names = headers.length ? headers.map((name, i) => /^[a-zA-Z]/.test(name) ? name.replace(/\W+/g, '_') : `col${i + 1}`) : columns.map(c => c.name);
      for (const tr of Array.from(table.querySelectorAll('tr')).slice(0, 500)) {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (!cells.length) continue;
        const extra = {};
        cells.forEach((td, i) => { extra[names[i] || `col${i + 1}`] = String(td.innerText || '').replace(/\s+/g, ' ').trim(); });
        const link = tr.querySelector('a[href]');
        extra.href = link?.href || '';
        extra.text = String(tr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        push(link || cells[0], extra);
      }
    } else if (kind === 'links') {
      const roots = scopeEls.length ? scopeEls : [document];
      const seen = new Set();
      for (const root of roots) {
        const links = root.matches?.('a[href]') ? [root] : [...(root.querySelectorAll?.('a[href]') || []), ...queryDeepAll(root, 'a[href]')];
        for (const a of links) {
          if (seen.has(a) || isActionChrome(a)) continue;
          seen.add(a);
          push(a, { href: a.href, text: String(a.innerText || '').replace(/\s+/g, ' ').trim() });
        }
      }
    } else {
      for (const el of scopeEls) {
        const extra = {};
        for (const col of columns) extra[col.name] = el.getAttribute?.(col.attr || col.name) || (col.attr === 'text' ? String(el.innerText || '').trim() : '');
        if (!columns.length) extra.text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
        push(el, extra);
      }
    }
    return { ok: true, op: 'scrape', items: items.slice(0, 500), count: Math.min(items.length, 500), kind };
  }
  function workflowEmit(event) {
    if (!workflowRecorder.active) return;
    const delivery = chrome.runtime.sendMessage({ target: 'browserbot-background', action: 'workflow_record_event', recordingId: workflowRecorder.id, event });
    workflowRecorder.inflight.add(delivery);
    delivery.catch(() => {}).finally(() => workflowRecorder.inflight.delete(delivery));
    return delivery;
  }
  function flushWorkflowInput() {
    clearTimeout(workflowRecorder.timer);
    if (workflowRecorder.pending) workflowEmit(workflowRecorder.pending);
    workflowRecorder.pending = null;
  }
  function configureWorkflowRecording(config) {
    if (workflowRecorder.active) flushWorkflowInput();
    workflowRecorder.active = config?.status === 'recording'; workflowRecorder.id = config?.id || null;
    if (workflowRecorder.active && pickerActive) { stopPicker(); notifyPickerState(); }
  }
  document.addEventListener('input', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    const el = event.target;
    if (workflowSensitive(el)) { workflowEmit({ type: 'sensitive' }); return; }
    if (el.type === 'file') { workflowEmit({ type: 'unsupported', unresolvedReason: 'UPLOAD_PATH' }); return; }
    if (el.isContentEditable) { workflowEmit({ type: 'unsupported' }); return; }
    const next = { type: el.tagName === 'SELECT' ? 'select' : 'fill', target: workflowLocator(el), value: String(el.value ?? '') };
    if (workflowRecorder.pending && JSON.stringify(workflowRecorder.pending.target) !== JSON.stringify(next.target)) flushWorkflowInput();
    workflowRecorder.pending = next;
    clearTimeout(workflowRecorder.timer); workflowRecorder.timer = setTimeout(flushWorkflowInput, 400);
  }, true);
  document.addEventListener('change', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    if (event.target.type === 'file') workflowEmit({ type: 'unsupported', unresolvedReason: 'UPLOAD_PATH' });
    else if (['checkbox', 'radio'].includes(event.target.type)) { flushWorkflowInput(); workflowEmit({ type: 'toggle', target: workflowLocator(event.target), checked: event.target.checked === true }); }
    else if (workflowSensitive(event.target)) workflowEmit({ type: 'sensitive' });
    else if (workflowRecorder.pending) flushWorkflowInput();
    else if (event.target.tagName === 'SELECT') workflowEmit({ type: 'select', target: workflowLocator(event.target), value: String(event.target.value ?? '') });
  }, true);
  document.addEventListener('click', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    flushWorkflowInput();
    const el = event.target.closest?.(ACTION_INTERACTIVE_SEL) || event.target;
    if (workflowSensitive(el)) { workflowEmit({ type: 'sensitive' }); return; }
    // Text-field focus is represented by the ensuing fill, not an extra click.
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !['checkbox','radio','button','submit'].includes(el.type)) return;
    if (event.detail === 2) return;
    if (['checkbox', 'radio'].includes(el.type)) { workflowEmit({ type: 'toggle', target: workflowLocator(el), checked: el.checked === true }); return; }
    workflowEmit({ type: 'click', target: workflowLocator(el) });
  }, true);
  document.addEventListener('dblclick', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    flushWorkflowInput();
    const el = event.target.closest?.(ACTION_INTERACTIVE_SEL) || event.target;
    if (workflowSensitive(el)) { workflowEmit({ type: 'sensitive' }); return; }
    workflowEmit({ type: 'dblclick', target: workflowLocator(el) });
  }, true);
  document.addEventListener('contextmenu', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    flushWorkflowInput();
    const el = event.target.closest?.(ACTION_INTERACTIVE_SEL) || event.target;
    if (workflowSensitive(el)) { workflowEmit({ type: 'sensitive' }); return; }
    workflowEmit({ type: 'contextmenu', target: workflowLocator(el) });
  }, true);
  let workflowHoverTimer = null; let workflowHoverEl = null;
  document.addEventListener('mouseover', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    const el = event.target.closest?.(ACTION_INTERACTIVE_SEL) || event.target;
    if (workflowSensitive(el) || workflowHoverEl === el) return;
    clearTimeout(workflowHoverTimer);
    workflowHoverEl = el;
    workflowHoverTimer = setTimeout(() => { if (workflowRecorder.active && workflowHoverEl === el) workflowEmit({ type: 'hover', target: workflowLocator(el) }); }, 500);
  }, true);
  document.addEventListener('keydown', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target) || workflowSensitive(event.target)) return;
    if (!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(event.key)) return;
    flushWorkflowInput(); workflowEmit({ type: 'press', key: event.key, target: workflowLocator(event.target) });
  }, true);
  let workflowScroll = 0;
  document.addEventListener('wheel', event => {
    if (!workflowRecorder.active || !event.isTrusted || isActionChrome(event.target)) return;
    workflowScroll += event.deltaY;
    clearTimeout(workflowRecorder.scrollTimer);
    workflowRecorder.scrollTimer = setTimeout(() => { workflowEmit({ type: 'scroll', deltaY: Math.round(workflowScroll), target: workflowLocator(document.scrollingElement || document.body) }); workflowScroll = 0; }, 200);
  }, { capture: true, passive: true });
  for (const type of ['drop', 'dragstart']) document.addEventListener(type, event => { if (workflowRecorder.active && event.isTrusted) workflowEmit({ type: 'unsupported', unresolvedReason: 'DRAG_UNSUPPORTED' }); }, true);
  window.addEventListener('pagehide', flushWorkflowInput);
  chrome.runtime.sendMessage({ target: 'browserbot-background', action: 'workflow_record_status' }).then(result => configureWorkflowRecording(result?.recording)).catch(() => {});

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'workflow_recording_config') { configureWorkflowRecording(request.recording); sendResponse({ ok: true }); }
    else if (request.action === 'workflow_probe') { sendResponse(takeActionSnapshot(request.target || {})); }
    else if (request.action === 'workflow_record_flush') { flushWorkflowInput(); clearTimeout(workflowRecorder.scrollTimer); if (workflowScroll) { workflowEmit({ type: 'scroll', deltaY: Math.round(workflowScroll), target: workflowLocator(document.scrollingElement || document.body) }); workflowScroll = 0; } Promise.all([...workflowRecorder.inflight]).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error?.message || String(error) })); return true; }
    else if (request.action === 'workflow_highlight') {
      const snap = takeActionSnapshot(request.target);
      if (snap.controls.length !== 1) sendResponse({ ok: false, code: 'WORKFLOW_AMBIGUOUS', error: 'Target must match exactly one element.' });
      else { const el = pawActionEls.get(snap.controls[0].ref); const old = el.style.outline; el.style.outline = '3px solid #fb923c'; el.scrollIntoView({ block: 'center' }); setTimeout(() => { el.style.outline = old; }, 1500); sendResponse({ ok: true }); }
    }
    else if (request.action === 'ping') sendResponse({ status: 'pong', active: pickerActive });
    else if (request.action === 'cancel_run' || request.action === 'browserbot_cancel_run') {
      // Stop path: dismiss in-page submit confirm and any pending waits
      try {
        const bar = document.getElementById('browserbot-confirm-bar');
        if (bar) {
          bar.querySelector('[data-pw-confirm="cancel"]')?.click();
          bar.remove();
        }
      } catch (_) {}
      try {
        if (typeof window.__browserbotCancelPendingWaits === 'function') {
          window.__browserbotCancelPendingWaits(request.runId || null);
        }
      } catch (_) {}
      sendResponse({ status: 'cancelled', runId: request.runId || null });
    }
    else if (request.action === 'workspace_capture_item') {
      captureWorkspaceItem(request)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    else if (request.action === 'workspace_capture_page_blueprint') {
      try {
        sendResponse(capturePageBlueprint());
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    }
    else if (request.action === 'workspace_page_action') {
      const out = runWorkspacePageAction(request);
      if (out && typeof out.then === 'function') {
        out
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), code: 'BAD_INPUT' }));
        return true;
      }
      try {
        sendResponse(out);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error), code: 'BAD_INPUT' });
      }
    }
    else if (request.action === 'get_picker_state') sendResponse({ active: pickerActive, count: selectedElements.length });
    else if (request.action === 'scan_full_page_dom') { sendResponse(scanFullPageDOMContext()); }
    else if (request.action === 'show_custom_toast') { showToast(request.msg); sendResponse({ status: 'toast_shown' }); }
    else if (request.action === 'browserbot_start_region_capture') {
      sendResponse(startRegionCaptureUi(request));
    } else if (request.action === 'browserbot_region_review') {
      sendResponse(showRegionReview(request));
    } else if (request.action === 'browserbot_region_review_failed') {
      stopRegionCaptureUi('fail');
      sendResponse({ status: 'dismissed' });
    } else if (request.action === 'browserbot_cancel_region_capture') {
      if (regionCaptureActive || regionReviewActive) finishRegionCancel();
      else stopRegionCaptureUi('cancel');
      sendResponse({ status: 'cancelled' });
    }
    else if (request.action === 'toggle_picker') { pickerActive ? stopPicker() : startPicker(); notifyPickerState(); sendResponse({ status: 'toggled', active: pickerActive }); }
    else if (request.action === 'stop_picker' || request.action === 'set_picker') {
      // Explicit stop / set — used when side panel wants to exit pick without toggle race
      const wantActive = request.action === 'set_picker' ? !!request.active : false;
      if (wantActive) {
        if (!pickerActive) startPicker();
      } else if (pickerActive) {
        stopPicker();
      }
      notifyPickerState();
      sendResponse({ status: 'ok', active: pickerActive });
    }
    else if (request.action === 'apply_selection_labels') {
      const n = applyWorkspaceLabels(request.labels);
      sendResponse({ status: 'ok', updated: n });
    }
    else if (request.action === 'restore_selection') {
      const items = Array.isArray(request.items) ? request.items : [];
      const replace = request.replace !== false;
      const silent = request.silent === true;
      if (replace) {
        document.querySelectorAll('.browserbot-selected, .browserbot-hovered, .browserbot-tag-focused').forEach((el) => {
          el.classList.remove('browserbot-selected');
          el.classList.remove('browserbot-hovered');
          el.classList.remove('browserbot-tag-focused');
        });
        document.querySelectorAll('.browserbot-element-badge').forEach((b) => b.remove());
        selectedElements = [];
        hoveredElement = null;
      }
      let n = 0;
      for (const raw of items) {
        const el = findElementForItem(raw);
        if (!isLiveElement(el)) continue;
        if (selectedElements.some((s) => s.element === el)) continue;
        selectedElements.push({
          element: el,
          selector: raw.selector || generateSelector(el),
          tag: raw.tag || el.tagName.toLowerCase(),
          text: raw.text || cleanDOMText((el.innerText || el.textContent || '').substring(0, 500)),
          src: raw.src || el.currentSrc || el.src || '',
          href: raw.href || el.href || '',
          kind: raw.kind || raw.labelKind || classifyContextKind({
            tag: raw.tag || el.tagName.toLowerCase(),
            src: raw.src || '',
            href: raw.href || '',
            text: raw.text || ''
          }),
          scope: raw.scope || 'element',
          facets: raw.facets,
          locatorFingerprint: raw.locatorFingerprint || raw.locator?.fingerprint,
          source: 'restore',
          displayLabel: String(raw.displayLabel || '').trim(),
          labelKind: raw.labelKind || '',
          labelN: raw.labelN || 0
        });
        n += 1;
      }
      refreshHighlightClasses();
      if (!silent) notifySidePanel(replace && items.length === 0 ? { cleared: true } : {});
      sendResponse({
        status: selectedElements.length ? 'restored' : 'empty',
        count: selectedElements.length,
        added: n
      });
    }
    else if (request.action === 'clear_selection') { clearSelection(); sendResponse({ status: 'cleared' }); }
    else if (request.action === 'remove_single_element') { removeSingleElementByIndex(request.index); sendResponse({ status: 'removed' }); }
    else if (request.action === 'workspace_remove_selector') {
      const selector = String(request.selector || '');
      const index = selectedElements.findIndex((item) => String(item.selector || '') === selector);
      if (index >= 0) removeSingleElementByIndex(index);
      sendResponse({ status: index >= 0 ? 'removed' : 'not_found' });
    }
    else if (request.action === 'workspace_scroll_selector' || request.action === 'reveal_selection') {
      void revealSelectionWithRetry(request).then((status) => {
        try { sendResponse({ status }); } catch (_) {}
      });
      return true;
    }
    else if (request.action === 'tag_hover_focus') { setElementTagHoverFocus(request.index, request.isHovered); sendResponse({ status: 'hovered' }); }
    else if (request.action === 'scroll_to_element') {
      const ok = scrollToElementByIndex(request.index);
      sendResponse({ status: ok ? 'scrolled' : 'not_found' });
    }
    else if (request.action === 'util_copy_text') { copySelectedTextToClipboard(); sendResponse({ status: 'copied' }); }
    else if (request.action === 'util_download_images') { downloadSelectedImages(); sendResponse({ status: 'downloaded' }); }
    else if (request.action === 'util_export_csv') { exportSelectedToCSV(); sendResponse({ status: 'exported' }); }
    else if (request.action === 'util_export_table_csv') { sendResponse(exportSelectedTablesCsv()); }
    else if (request.action === 'util_copy_links') { sendResponse(copySelectedLinks()); }
    else if (request.action === 'util_download_link_files') { sendResponse(downloadSelectedLinkFiles()); }
    else if (request.action === 'util_download_svgs') { sendResponse(downloadSelectedSvgs()); }
    else if (request.action === 'util_export_cover_links') {
      exportSelectedCoverLinks()
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ status: 'error', count: 0, error: err?.message || String(err) }));
      return true;
    }
    else if (request.action === 'extract_tab_image_urls') {
      let urls = [];
      if (request.elements && request.elements.length > 0) {
        request.elements.forEach(item => {
          if (item && item.selector) {
            try {
              const el = document.querySelector(item.selector);
              if (el) urls.push(...extractImageUrlsFromContainer(el));
            } catch (e) {}
          }
        });
      }
      urls = [...new Set(urls.filter(Boolean))];
      sendResponse({ status: 'success', urls });
    }
    else if (request.action === 'fetch_urls_as_data_urls') {
      // Convert image URLs to data URLs in page context (sidepanel cannot call fetchUrlAsDataUrlInTabContext)
      const urls = Array.isArray(request.urls) ? request.urls.filter(Boolean) : [];
      if (urls.length === 0) {
        sendResponse({ status: 'success', dataUrls: [] });
      } else {
        Promise.all(urls.map(u => fetchUrlAsDataUrlInTabContext(u)))
          .then((dataUrls) => {
            sendResponse({ status: 'success', dataUrls: (dataUrls || []).filter(Boolean) });
          })
          .catch((err) => {
            console.warn('fetch_urls_as_data_urls failed:', err);
            sendResponse({ status: 'error', dataUrls: [], message: err && err.message ? err.message : String(err) });
          });
        return true; // keep message channel open for async sendResponse
      }
    }
    /* ── Browser Agent Runtime tool bridges ── */
    else if (request.action === 'agent_get_selection') {
      sendResponse({
        count: selectedElements.length,
        userCount: selectedElements.filter((i) => (i.source || 'user') === 'user').length,
        modelCount: selectedElements.filter((i) => i.source === 'model').length,
        elements: selectedElements.slice(0, 1000).map((item, i) => ({
          index: i,
          selector: item.selector,
          tag: item.tag,
          text: (item.text || '').substring(0, 200),
          src: (item.src || '').substring(0, 200),
          source: item.source || 'user'
        }))
      });
    } else if (request.action === 'agent_extract_selection') {
      try {
        sendResponse(agentExtractSelection(request));
      } catch (e) {
        sendResponse({
          status: 'empty',
          count: 0,
          totalSelected: selectedElements.length,
          items: [],
          message: e?.message || String(e)
        });
      }
    } else if (request.action === 'agent_export_selection') {
      try {
        sendResponse(agentExportSelection(request));
      } catch (e) {
        sendResponse({
          status: 'error',
          format: request.format || 'md',
          order: request.order || 'as_is',
          itemCount: 0,
          downloaded: false,
          filename: null,
          message: e?.message || String(e)
        });
      }
    } else if (request.action === 'agent_select_elements') {
      try {
        sendResponse(agentSelectElementsFromRequest(request));
      } catch (e) {
        sendResponse({ status: 'error', message: e?.message || String(e), count: selectedElements.length });
      }
    } else if (request.action === 'agent_get_page_context') {
      sendResponse(scanFullPageDOMContext());
    } else if (request.action === 'agent_highlight') {
      const targets = resolveTargetsFromSelectors(request.selectors);
      window.BrowserBot.highlight(targets, request.color || '#fef08a');
      sendResponse({ status: 'ok', count: targets.length, color: request.color || '#fef08a' });
    } else if (request.action === 'agent_export_csv') {
      exportSelectedToCSV();
      sendResponse({ status: 'exported', count: selectedElements.length });
    } else if (request.action === 'agent_extract_article') {
      try {
        sendResponse(extractArticleFromPage({ maxChars: request.maxChars }));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e) });
      }
    } else if (request.action === 'agent_export_structured_data') {
      try {
        sendResponse(
          exportStructuredDataFromPage({
            format: request.format,
            prefer: request.prefer,
            maxRows: request.maxRows,
            download: request.download
          })
        );
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e) });
      }
    } else if (request.action === 'agent_get_dom_snapshot') {
      try {
        sendResponse(buildLiveDomSnapshot({ includeSamples: request.includeSamples !== false }));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e) });
      }
    } else if (request.action === 'agent_download_images') {
      const count = typeof request.count === 'number' ? request.count : 0;
      downloadSelectedImages(count);
      sendResponse({ status: 'download_triggered', count });
      return true; // downloadSelectedImages is async; response already sent synchronously OK
    } else if (request.action === 'agent_find_elements') {
      try {
        sendResponse(agentFindElements(request));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e), count: 0, elements: [] });
      }
    } else if (request.action === 'agent_set_value') {
      try {
        sendResponse(agentSetValue(request));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e) });
      }
    } else if (request.action === 'agent_wait_for') {
      agentWaitFor(request)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ status: 'error', message: e.message || String(e) }));
      return true; // async poll
    } else if (request.action === 'agent_scroll_into_view') {
      try {
        sendResponse(agentScrollIntoView(request));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e) });
      }
    } else if (request.action === 'agent_verify_dom') {
      try {
        sendResponse(agentVerifyDom(request));
      } catch (e) {
        sendResponse({ status: 'error', message: e.message || String(e), count: 0 });
      }
    } else if (request.action === 'agent_resolve_anchor_semantics') {
      try {
        sendResponse(agentResolveAnchorSemantics(request));
      } catch (e) {
        sendResponse({
          status: 'empty',
          count: 0,
          items: [],
          message: e?.message || String(e)
        });
      }
    }
  });

  extSend({
    action: 'content_script_ready',
    url: window.location.href,
    pageTitle: document.title
  });
})();
