/**
 * Local screenshot recognition: Chrome Shape Detection for QR/barcodes,
 * optional TextDetector, plus a BYOK vision OCR request builder.
 * No new vendor APIs — vision uses the existing chat provider slot.
 */

const QR_FORMATS = ['qr_code', 'aztec', 'data_matrix', 'pdf417'];

export function isImageDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && dataUrl.startsWith('data:image');
}

export function chatCompletionsUrl(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (!base) return '';
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

export function visionOcrPrompt(lang = 'zh') {
  return lang === 'en'
    ? 'Transcribe every visible character in this image. Reply with the text only — no preface, labels, or markdown fences.'
    : '只转录这张图里所有可见文字。只回复正文，不要前言、标题或代码围栏。';
}

export function buildVisionOcrBody({ model, dataUrl, lang = 'zh' } = {}) {
  return {
    model: String(model || '').trim(),
    temperature: 0,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: visionOcrPrompt(lang) },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };
}

export function textFromChatCompletion(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || part?.content || '';
      })
      .join('')
      .trim();
  }
  return '';
}

export async function bitmapFromDataUrl(dataUrl, deps = {}) {
  if (!isImageDataUrl(dataUrl)) throw new Error('Invalid image dataURL');
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const createBitmap = deps.createBitmap || globalThis.createImageBitmap;
  if (typeof fetchImpl !== 'function' || typeof createBitmap !== 'function') {
    throw new Error('Image bitmap APIs unavailable');
  }
  const res = await fetchImpl(dataUrl);
  const blob = await res.blob();
  return createBitmap(blob);
}

async function supportedBarcodeFormats(Detector) {
  try {
    if (typeof Detector.getSupportedFormats === 'function') {
      const supported = await Detector.getSupportedFormats();
      const list = QR_FORMATS.filter((f) => supported.includes(f));
      if (list.length) return list;
    }
  } catch {
    /* default to qr_code */
  }
  return ['qr_code'];
}

function rawDetectionValues(items) {
  return [
    ...new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => String(item?.rawValue || item?.rawvalue || '').trim())
        .filter(Boolean)
    )
  ];
}

export async function detectBarcodesFromDataUrl(dataUrl, deps = {}) {
  const Detector = deps.BarcodeDetector || globalThis.BarcodeDetector;
  if (typeof Detector !== 'function') {
    return { ok: false, code: 'NO_BARCODE_DETECTOR', values: [], text: '' };
  }
  try {
    const bitmap = await bitmapFromDataUrl(dataUrl, deps);
    const detector = new Detector({ formats: await supportedBarcodeFormats(Detector) });
    const values = rawDetectionValues(await detector.detect(bitmap));
    return values.length
      ? { ok: true, source: 'local', values, text: values.join('\n') }
      : { ok: false, code: 'EMPTY', values: [], text: '' };
  } catch (err) {
    return { ok: false, code: 'DETECT_FAILED', values: [], text: '', error: err?.message || String(err) };
  }
}

export async function detectLocalTextFromDataUrl(dataUrl, deps = {}) {
  const Detector = deps.TextDetector || globalThis.TextDetector;
  if (typeof Detector !== 'function') {
    return { ok: false, code: 'NO_TEXT_DETECTOR', text: '' };
  }
  try {
    const bitmap = await bitmapFromDataUrl(dataUrl, deps);
    const detector = new Detector();
    const text = rawDetectionValues(await detector.detect(bitmap)).join('\n');
    return text
      ? { ok: true, source: 'local', text }
      : { ok: false, code: 'EMPTY', text: '' };
  } catch (err) {
    return { ok: false, code: 'DETECT_FAILED', text: '', error: err?.message || String(err) };
  }
}

export function shouldOfferScreenshotActions(source) {
  const src = String(source || '').toLowerCase();
  return src !== 'paste';
}

/** Capture stays on the page overlay. Only an explicit paste enters the composer. */
export function shouldAttachScreenshotToComposer(source) {
  return String(source || '').toLowerCase() === 'paste';
}

export function clipboardTargetForShotAction(action) {
  if (action === 'copy') return 'image';
  if (action === 'ocr' || action === 'qr') return 'text';
  return null;
}

/** Only OCR pins into the session clipboard and expands the hover clip drawer. */
export function shouldOpenClipDrawerForShotAction(action) {
  return action === 'ocr';
}

/**
 * After any review action (success, empty, or fail) the freeze overlay exits.
 * OCR with text also pins and opens the side-panel clip drawer.
 */
export function regionReviewFinishPolicy(action, result = {}) {
  const text = String(result?.text || '').trim();
  return {
    dismiss: true,
    copyTarget: clipboardTargetForShotAction(action),
    pinAndOpenClipDrawer: action === 'ocr' && !!text
  };
}

export function screenshotOcrPinMessage(text, extra = {}) {
  const body = String(text || '').trim();
  if (!body) return null;
  return {
    action: 'clipboard_text_picked',
    text: body,
    textRaw: String(extra.textRaw || body),
    url: extra.url || '',
    pageTitle: extra.pageTitle || '',
    sourceKind: 'screenshot-ocr',
    openDrawer: true,
    toast: false
  };
}

export function regionReviewCopy(lang = 'zh') {
  const en = lang === 'en';
  return {
    hintSelect: en
      ? 'Drag to select · Esc / right-click to cancel'
      : '拖拽选择截图区域 · Esc / 右键 取消',
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

/**
 * Pin the action bar next to the frozen crop.
 * Prefer immediately below the rect, then above. If neither fits (near-full
 * viewport / bottom-edge selection), overlap the bottom of the rect so the
 * bar stays fully on screen. Visibility beats “always strictly below”.
 * @param {{ x:number, y:number, width:number, height:number }} rect
 * @param {{ width:number, height:number }} viewport
 * @param {{ width?:number, height?:number, gap?:number }} [chrome]
 * @returns {{ left:number, top:number, placement:'below'|'above'|'overlap' }}
 */
export function placeReviewChrome(rect, viewport, chrome = {}) {
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
  let placement = 'below';
  if (vh && below + barH > vh - margin) {
    if (above >= minTop) {
      top = above;
      placement = 'above';
    } else {
      top = maxTop;
      placement = 'overlap';
    }
  }
  if (vh) top = Math.min(Math.max(minTop, top), maxTop);
  else if (top < minTop) top = minTop;

  return { left, top, placement };
}

export async function runScreenshotOcr(dataUrl, deps = {}) {
  const local = await detectLocalTextFromDataUrl(dataUrl, deps);
  if (local.ok && local.text) return local;
  const settings = deps.settings || (deps.loadSettings ? await deps.loadSettings() : null);
  if (!String(settings?.apiKey || '').trim()) {
    return { ok: false, code: 'NEED_KEY', text: '' };
  }
  if (typeof deps.byokAllowed === 'function' && !(await deps.byokAllowed(settings))) {
    return { ok: false, code: 'BYOK_REQUIRES_PLAN', text: '' };
  }
  const url = chatCompletionsUrl(settings.apiBase || settings.baseURL);
  if (!url) return { ok: false, code: 'VISION_FAILED', text: '' };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'VISION_FAILED', text: '' };
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        buildVisionOcrBody({
          model: settings.model,
          dataUrl,
          lang: deps.lang || 'zh'
        })
      )
    });
    const json = typeof res?.json === 'function' ? await res.json() : res?.json || {};
    if (!res?.ok) {
      return {
        ok: false,
        code: 'VISION_FAILED',
        text: '',
        error: json?.error?.message || res?.error || `HTTP ${res?.status || ''}`
      };
    }
    const text = textFromChatCompletion(json);
    return text ? { ok: true, source: 'vision', text } : { ok: false, code: 'EMPTY', text: '' };
  } catch (err) {
    return { ok: false, code: 'VISION_FAILED', text: '', error: err?.message || String(err) };
  }
}
