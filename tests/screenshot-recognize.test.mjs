import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shouldOfferScreenshotActions,
  shouldAttachScreenshotToComposer,
  clipboardTargetForShotAction,
  shouldOpenClipDrawerForShotAction,
  regionReviewFinishPolicy,
  screenshotOcrPinMessage,
  regionReviewCopy,
  placeReviewChrome,
  runScreenshotOcr,
  chatCompletionsUrl,
  visionOcrPrompt,
  buildVisionOcrBody,
  textFromChatCompletion,
  detectBarcodesFromDataUrl,
  detectLocalTextFromDataUrl
} from '../src/sidepanel/screenshotRecognize.js';
import { I18N } from '../src/sidepanel/i18n.js';

const DATA_URL = 'data:image/png;base64,AA==';

function fakeBitmapDeps() {
  return {
    fetchImpl: async () => ({ blob: async () => new Blob(['x']) }),
    createBitmap: async () => ({ width: 8, height: 8 })
  };
}

test('user captures get a chooser; paste does not', () => {
  assert.equal(shouldOfferScreenshotActions('button'), true);
  assert.equal(shouldOfferScreenshotActions('hotkey'), true);
  assert.equal(shouldOfferScreenshotActions('pending'), true);
  assert.equal(shouldOfferScreenshotActions('paste'), false);
});

test('only an explicit paste enters the composer; capture actions copy', () => {
  assert.equal(shouldAttachScreenshotToComposer('paste'), true);
  assert.equal(shouldAttachScreenshotToComposer('button'), false);
  assert.equal(shouldAttachScreenshotToComposer('hotkey'), false);
  assert.equal(shouldAttachScreenshotToComposer('pending'), false);
  assert.equal(clipboardTargetForShotAction('copy'), 'image');
  assert.equal(clipboardTargetForShotAction('ocr'), 'text');
  assert.equal(clipboardTargetForShotAction('qr'), 'text');
  assert.equal(shouldOpenClipDrawerForShotAction('ocr'), true);
  assert.equal(shouldOpenClipDrawerForShotAction('qr'), false);
  assert.equal(shouldOpenClipDrawerForShotAction('copy'), false);
  assert.equal(regionReviewCopy('zh').copy, '复制');
  assert.equal(regionReviewCopy('en').copy, 'Copy');
});

test('any review action dismisses; only OCR with text opens the clip drawer', () => {
  assert.deepEqual(regionReviewFinishPolicy('copy'), {
    dismiss: true, copyTarget: 'image', pinAndOpenClipDrawer: false
  });
  assert.deepEqual(regionReviewFinishPolicy('qr', { ok: true, text: 'https://x' }), {
    dismiss: true, copyTarget: 'text', pinAndOpenClipDrawer: false
  });
  assert.deepEqual(regionReviewFinishPolicy('ocr', { ok: true, text: '发票' }), {
    dismiss: true, copyTarget: 'text', pinAndOpenClipDrawer: true
  });
  assert.deepEqual(regionReviewFinishPolicy('ocr', { ok: false, code: 'EMPTY' }), {
    dismiss: true, copyTarget: 'text', pinAndOpenClipDrawer: false
  });
  assert.deepEqual(regionReviewFinishPolicy('ocr', { ok: false, code: 'NEED_KEY' }), {
    dismiss: true, copyTarget: 'text', pinAndOpenClipDrawer: false
  });
  const pin = screenshotOcrPinMessage('发票 12', { url: 'https://a.test', pageTitle: 'A' });
  assert.equal(pin.action, 'clipboard_text_picked');
  assert.equal(pin.sourceKind, 'screenshot-ocr');
  assert.equal(pin.openDrawer, true);
  assert.equal(pin.toast, false);
  assert.equal(screenshotOcrPinMessage('  '), null);
});

test('review toolbar sits under the crop when there is room, otherwise above', () => {
  assert.deepEqual(
    placeReviewChrome({ x: 40, y: 40, width: 120, height: 80 }, { width: 800, height: 600 }, { width: 200, height: 36, gap: 8 }),
    { left: 40, top: 128, placement: 'below' }
  );
  const tight = placeReviewChrome(
    { x: 20, y: 520, width: 200, height: 60 },
    { width: 400, height: 600 },
    { width: 220, height: 36, gap: 8 }
  );
  assert.equal(tight.top, 476);
  assert.equal(tight.placement, 'above');
  assert.ok(tight.left + 220 <= 400);
});

test('review toolbar stays inside the viewport for a bottom or near-full selection', () => {
  const bar = { width: 220, height: 36, gap: 8 };
  const vp = { width: 800, height: 600 };

  const bottom = placeReviewChrome({ x: 40, y: 560, width: 200, height: 40 }, vp, bar);
  assert.ok(bottom.top >= 8);
  assert.ok(bottom.top + 36 <= 600);
  assert.ok(bottom.left >= 8);
  assert.ok(bottom.left + 220 <= 800);
  assert.equal(bottom.placement, 'above');

  const full = placeReviewChrome({ x: 0, y: 0, width: 800, height: 600 }, vp, bar);
  assert.ok(full.top >= 8);
  assert.ok(full.top + 36 <= 600);
  assert.ok(full.left >= 8);
  assert.ok(full.left + 220 <= 800);
  assert.equal(full.placement, 'overlap');

  const almost = placeReviewChrome({ x: 4, y: 4, width: 792, height: 592 }, vp, bar);
  assert.ok(almost.top >= 8);
  assert.ok(almost.top + 36 <= 600);
  assert.ok(almost.left + 220 <= 800);
  assert.equal(almost.placement, 'overlap');
});

test('vision OCR request stays on the existing chat completions slot', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    chatCompletionsUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );
  const body = buildVisionOcrBody({ model: 'deepseek-v4-flash', dataUrl: DATA_URL, lang: 'zh' });
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.messages[0].content[0].text, visionOcrPrompt('zh'));
  assert.equal(body.messages[0].content[1].image_url.url, DATA_URL);
});

test('chat completion parser keeps only the model text', () => {
  assert.equal(textFromChatCompletion({ choices: [{ message: { content: '  hello  ' } }] }), 'hello');
  assert.equal(
    textFromChatCompletion({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] }),
    'ab'
  );
  assert.equal(textFromChatCompletion({}), '');
});

test('QR uses Chrome BarcodeDetector and does not invent a cloud vendor', async () => {
  class BarcodeDetector {
    static async getSupportedFormats() { return ['qr_code', 'aztec']; }
    async detect() { return [{ rawValue: 'https://kitten.example' }, { rawValue: 'https://kitten.example' }]; }
  }
  const found = await detectBarcodesFromDataUrl(DATA_URL, { BarcodeDetector, ...fakeBitmapDeps() });
  assert.deepEqual(found, { ok: true, source: 'local', values: ['https://kitten.example'], text: 'https://kitten.example' });

  const missing = await detectBarcodesFromDataUrl(DATA_URL, { BarcodeDetector: undefined, ...fakeBitmapDeps() });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_BARCODE_DETECTOR');
});

test('local OCR is optional TextDetector, not a bundled Tesseract', async () => {
  class TextDetector {
    async detect() { return [{ rawValue: '发票 12' }]; }
  }
  const found = await detectLocalTextFromDataUrl(DATA_URL, { TextDetector, ...fakeBitmapDeps() });
  assert.deepEqual(found, { ok: true, source: 'local', text: '发票 12' });

  const missing = await detectLocalTextFromDataUrl(DATA_URL, { TextDetector: undefined, ...fakeBitmapDeps() });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_TEXT_DETECTOR');
});

test('vision OCR falls back to the chat provider and never invents a vendor', async () => {
  const local = await runScreenshotOcr(DATA_URL, {
    TextDetector: class { async detect() { return [{ rawValue: '本地字' }]; } },
    ...fakeBitmapDeps()
  });
  assert.deepEqual(local, { ok: true, source: 'local', text: '本地字' });

  const needKey = await runScreenshotOcr(DATA_URL, {
    TextDetector: undefined,
    settings: { apiKey: '', apiBase: 'https://api.example/v1' },
    ...fakeBitmapDeps()
  });
  assert.equal(needKey.code, 'NEED_KEY');

  const vision = await runScreenshotOcr(DATA_URL, {
    ...fakeBitmapDeps(),
    TextDetector: undefined,
    settings: { apiKey: 'sk-test', apiBase: 'https://api.example/v1', model: 'vision-1' },
    fetchImpl: async (url) => {
      if (String(url).includes('/chat/completions')) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: ' 发票 ' } }] })
        };
      }
      return { blob: async () => new Blob(['x']) };
    }
  });
  assert.deepEqual(vision, { ok: true, source: 'vision', text: '发票' });
});

test('post-capture chooser lives on the page overlay, not in the composer', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="screenshotActionRow"/);
  const page = readFileSync(new URL('../src/content_script.js', import.meta.url), 'utf8');
  assert.match(page, /browserbot-region-review/);
  assert.match(page, /browserbot-region-freeze/);
  assert.match(page, /data-shot-action="copy"/);
  assert.match(page, /data-shot-action="ocr"/);
  assert.match(page, /data-shot-action="qr"/);
  assert.match(page, /regionReviewCopy/);
  assert.match(page, /fullDataUrl/);
  assert.match(page, /sourceKind:\s*['"]screenshot-ocr['"]/);
  assert.match(page, /enterRegionReview/);
  assert.doesNotMatch(page, /regionRoot\.style\.visibility = 'hidden'/);
  assert.doesNotMatch(page, /showRegionReviewResult/);
  assert.match(page, /#ff6a00/);
  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const captureFn = bg.slice(
    bg.indexOf('async function captureVisibleTabForUser'),
    bg.indexOf('function promptRegionSelect')
  );
  const firstCapture = captureFn.indexOf('chrome.tabs.captureVisibleTab');
  const startPicker = captureFn.indexOf('promptRegionSelect');
  assert.ok(firstCapture >= 0 && startPicker >= 0 && firstCapture < startPicker);
  assert.equal(captureFn.split('chrome.tabs.captureVisibleTab').length - 1, 1);
  assert.doesNotMatch(captureFn, /delayMs/);
  assert.doesNotMatch(captureFn, /browserbot_region_review/);
  assert.match(bg, /browserbot_start_region_capture/);
  assert.match(bg, /fullDataUrl/);
  assert.match(bg, /pinScreenshotOcrTextFallback/);
  assert.doesNotMatch(bg, /并附到对话/);
  const keys = [
    'shotActions', 'shotOcr', 'shotQr', 'shotCopy', 'shotOcrNeedKey', 'shotQrNeedApi', 'shotCopied'
  ];
  for (const key of keys) {
    assert.equal(typeof I18N.zh[key], 'string', `zh missing ${key}`);
    assert.equal(typeof I18N.en[key], 'string', `en missing ${key}`);
  }
});
