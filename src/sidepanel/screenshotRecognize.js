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
