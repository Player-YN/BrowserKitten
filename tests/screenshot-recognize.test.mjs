import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shouldOfferScreenshotActions,
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

test('post-capture chips exist in the composer shell and have bilingual labels', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /id="screenshotActionRow"/);
  assert.match(html, /data-shot-action="ocr"/);
  assert.match(html, /data-shot-action="qr"/);
  assert.match(html, /data-shot-action="copy"/);
  const keys = [
    'shotActions', 'shotOcr', 'shotQr', 'shotCopy', 'shotOcrNeedKey', 'shotQrNeedApi', 'shotCopied'
  ];
  for (const key of keys) {
    assert.equal(typeof I18N.zh[key], 'string', `zh missing ${key}`);
    assert.equal(typeof I18N.en[key], 'string', `en missing ${key}`);
  }
});
