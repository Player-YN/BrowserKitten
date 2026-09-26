import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { I18N } from '../src/sidepanel/i18n.js';
import { noticeCardModel } from '../src/sidepanel/noticeCards.js';
import { isPageScriptsOffError } from '../src/sidepanel/pageScripts.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the welcome tab opens on first install only', () => {
  const bg = read('src/background.js');
  assert.match(bg, /details\?\.reason !== 'install'\) return;\s*\n\s*void chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\('src\/welcome\.html'\)/);
});

test('welcome page files exist and every label is translated', () => {
  const html = read('src/welcome.html');
  for (const ref of [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1])) {
    assert.ok(existsSync(new URL(`../src/${ref}`, import.meta.url)), `missing ${ref}`);
  }
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15);
  for (const lang of ['zh', 'en']) for (const k of keys) assert.ok(I18N[lang][k], `${lang} ${k}`);
});

test('a task that needs page scripts gets a card with the right next step', () => {
  const t = (k) => I18N.en[k];
  assert.equal(noticeCardModel({ kind: 'scripts', state: 'off' }, { t }).actions[0].id, 'enable-scripts');
  assert.equal(noticeCardModel({ kind: 'scripts', state: 'needs-toggle' }, { t }).actions[0].id, 'open-details');
  assert.equal(isPageScriptsOffError({ ok: false, code: 'PERMISSION_REQUIRED', permission: 'userScripts', error: 'Page scripts are off.' }), true);
  assert.equal(isPageScriptsOffError('SYS_DENIED: userScripts is off. Chrome 138+: extension details'), true);
  assert.equal(isPageScriptsOffError({ ok: false, code: 'PERMISSION_REQUIRED', permission: 'tabCapture' }), false);
  assert.equal(isPageScriptsOffError(null), false);
});
