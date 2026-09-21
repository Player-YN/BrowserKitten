import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAccessPolicyUi } from '../src/sidepanel/accessPolicyUi.js';

const source = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; }
  appendChild(child) { this.children.push(child); }
  set innerHTML(value) { assert.equal(value, ''); this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
}
function attachmentUi() {
  const bar = new Element();
  const inline = new Set();
  const attachments = [];
  const ctx = vm.createContext({
    $: () => bar,
    composerEl: () => ({ querySelectorAll: () => [...inline].map(label => ({ getAttribute: () => label })) }),
    pendingAttachments: attachments,
    document: { createElement: tag => new Element(tag) },
    currentLang: 'en',
    itemLabelLang: () => 'en',
    formatItemLabel: (kind, n) => `${kind}${n}`,
  });
  vm.runInContext(section('function renderAttachmentPreviews()', '// ── Submit + Agent run'), ctx);
  return { bar, inline, attachments, ctx };
}

test('attachments belong to the composer shell and travel with either composer dock', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let found = 0;
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*?)>/gi)) {
    const [, close, name, attrs] = match;
    if (close) { stack.pop(); continue; }
    if (/\bid="attachmentPreviewBar"/.test(attrs)) {
      found++;
      assert.ok(stack.some(n => n.name === 'footer' && /class="composer"/.test(n.attrs)));
      assert.match(stack.at(-1).attrs, /class="composer-inner"/);
    }
    if (!['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(name) && !attrs.endsWith('/')) {
      stack.push({ name, attrs });
    }
  }
  assert.equal(found, 1);
});

test('uploaded images have thumbnails; removal preserves the other outgoing attachments', () => {
  const { bar, attachments, ctx } = attachmentUi();
  attachments.push({ name: 'capture.png', isImage: true, dataUrl: 'data:image/png;base64,AA==', source: 'drop' }, { name: 'notes.txt' });
  ctx.renderAttachmentPreviews();
  assert.equal(bar.hidden, false);
  assert.equal(bar.children[0].children[0].src, attachments[0].dataUrl);
  assert.equal(bar.children[0].children[1].textContent, 'capture.png');
  bar.children[0].children.at(-1).listeners.click();
  assert.deepEqual(attachments.map(a => a.name), ['notes.txt']);
  assert.equal(bar.children.length, 1);
  bar.children[0].children.at(-1).listeners.click();
  assert.equal(bar.hidden, true);
  assert.equal(bar.children.length, 0);
});

test('pasted screenshot renders once inline; capture-button screenshots remain in the shell preview', async () => {
  const { bar, inline, attachments, ctx } = attachmentUi();
  Object.assign(ctx, {
    screenshotAttachInflight: new Set(), lastCaptureAttachKey: '', lastCaptureAttachAt: 0,
    screenshotAttachKey: value => value,
    chrome: { storage: { local: { remove() {} } } }, STORAGE_PENDING_SCREENSHOT: 'pending',
    attachmentFromDataUrl: (dataUrl, props) => ({ ...props, dataUrl, isImage: true }),
    nextStickyLabel: async () => ({ n: attachments.length + 1 }),
    clipboardGroupFromState: () => null,
    insertPastedScreenshotChip: att => inline.add(att.name),
    showCustomModal: () => assert.fail('attachment failed'), console,
  });
  vm.runInContext(section('async function attachScreenshotToChat(payload)', 'async function requestUserScreenshot('), ctx);
  await ctx.attachScreenshotToChat({ source: 'paste', dataUrl: 'data:image/png;base64,AA==', clipboardOk: true });
  assert.equal(attachments.length, 1);
  assert.deepEqual([...inline], ['screenshot1']);
  assert.equal(bar.hidden, true);
  await ctx.attachScreenshotToChat({ source: 'button', dataUrl: 'data:image/png;base64,BB==', clipboardOk: true });
  assert.equal(attachments.length, 2);
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].children[0].src, attachments[1].dataUrl);
  // The index is from the outgoing list, not the filtered preview list.
  bar.children[0].children.at(-1).listeners.click();
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].source, 'paste');
});

test('access mode updates the accessible label without replacing the shield icon', () => {
  const label = new Element('span');
  const icon = new Element('svg');
  const chip = new Element('button');
  chip.dataset = {};
  chip.children = [icon, label];
  chip.querySelector = () => label;
  const ui = createAccessPolicyUi({ getChip: () => chip, t: key => key });
  ui.setPolicy({ mode: 'full', source: 'session' });
  assert.deepEqual(chip.children, [icon, label]);
  assert.equal(label.textContent, 'accessChipFull · accessChipSession');
  assert.match(chip.attributes['aria-label'], /accessChipFull.*accessFullHint/);
  assert.equal(chip.dataset.mode, 'full');
  ui.setPolicy({ mode: 'guarded', source: 'profile' });
  assert.equal(chip.dataset.mode, 'guarded');
  assert.equal(label.textContent, 'accessChipGuarded');
});
