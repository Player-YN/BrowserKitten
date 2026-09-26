import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N, translate } from '../src/sidepanel/i18n.js';
import { accountInitial, accountView, compactCredits, tasksFor } from '../src/sidepanel/accountMenu.js';
import { STARTER_IDS, isProbeableUrl, pickStarters } from '../src/sidepanel/pageStarters.js';
import { noticeCardModel } from '../src/sidepanel/noticeCards.js';

const tz = (key) => translate('zh', key);
const te = (key) => translate('en', key);

test('the chip shows compact credits and the email initial', () => {
  assert.equal(compactCredits(950), '950');
  assert.equal(compactCredits(1200), '1.2k');
  assert.equal(compactCredits(3000), '3k');
  assert.equal(compactCredits(61240), '61k');
  assert.equal(compactCredits(2_450_000), '2.4M');
  assert.equal(compactCredits(-5), '0');
  assert.equal(accountInitial('tothemoon@gmail.com'), 'T');
  assert.equal(accountInitial(''), '?');
  assert.equal(tasksFor(3000), 10);
  assert.equal(tasksFor(55000), 180);
});

test('account states: signed out, expired, signed in with a weekly meter', () => {
  assert.equal(accountView(null).state, 'unavailable');
  assert.equal(accountView({ signedIn: false }).state, 'signed-out');
  assert.equal(accountView({ signedIn: true, expired: true, email: 'a@b.c' }).state, 'expired');
  const v = accountView({ signedIn: true, email: 'a@b.c', planLabel: 'Standard', credits: 40000, usage: { weekly: 17600 }, limits: { weekly: 22000 } });
  assert.equal(v.state, 'signed-in');
  assert.equal(v.plan, 'Standard');
  assert.deepEqual(v.weekly, { used: 17600, limit: 22000, share: 0.8 });
  assert.equal(accountView({ signedIn: true, plan: 'developer', credits: 0, limits: { weekly: null } }).weekly, null);
});

test('starters fit the page, at most three, always something on a real page', () => {
  const ids = (probe, url) => pickStarters(probe, url, te).map((s) => s.id);
  assert.deepEqual(ids({ tables: 2, inputs: 0, textLength: 800 }, 'https://example.com/prices'), ['table-to-sheet', 'summarize', 'extract-key-facts']);
  assert.deepEqual(ids({ inputs: 6, textLength: 300 }, 'https://jobs.example.com/apply'), ['fill-form', 'summarize', 'extract-key-facts']);
  assert.deepEqual(ids({ listItems: 40, textLength: 900 }, 'https://www.google.com/search?q=crm+tools')[0], 'compare-results');
  assert.deepEqual(ids(null, 'https://news.example.com/a'), ['summarize', 'extract-key-facts']);
  assert.deepEqual(ids(null, 'chrome://extensions'), []);
  assert.equal(isProbeableUrl('https://example.com'), true);
  assert.equal(isProbeableUrl('chrome://settings'), false);
  assert.equal(isProbeableUrl('https://chromewebstore.google.com/detail/x'), false);
});

test('every starter has a label and a prompt in both languages', () => {
  for (const lang of ['zh', 'en']) {
    for (const id of STARTER_IDS) {
      const key = id.replace(/-/g, '_');
      assert.ok(I18N[lang][`starter_${key}_label`], `${lang} ${id} label`);
      assert.ok(I18N[lang][`starter_${key}_prompt`], `${lang} ${id} prompt`);
    }
  }
});

test('notice cards: credits and weekly limit offer a booster, byok offers sign-in only when signed out', () => {
  const ctx = { t: tz, signedIn: true, formatDate: () => '周六 11:00' };
  const credits = noticeCardModel({ kind: 'credits' }, ctx);
  assert.deepEqual(credits.actions.map((a) => a.id), ['booster', 'plans']);
  const limit = noticeCardModel({ kind: 'limit', resetAt: '2026-10-04T03:00:00Z' }, ctx);
  assert.match(limit.body, /周六 11:00/);
  assert.equal(limit.actions[0].id, 'booster');
  assert.equal(noticeCardModel({ kind: 'limit', resetAt: '' }, ctx).body, tz('noticeLimitBody'));
  assert.deepEqual(noticeCardModel({ kind: 'byok' }, ctx).actions.map((a) => a.id), ['plans']);
  assert.deepEqual(noticeCardModel({ kind: 'byok' }, { ...ctx, signedIn: false }).actions.map((a) => a.id), ['sign-in', 'plans']);
  assert.equal(noticeCardModel({ kind: 'paused', message: 'Back at 10:00 UTC' }, ctx).body, 'Back at 10:00 UTC');
  assert.equal(noticeCardModel({ kind: 'upgrade' }, ctx).actions[0].id, 'update');
  assert.equal(noticeCardModel({ kind: 'nope' }, ctx), null);
});

test('panel markup: sign-in and account menu in the top bar, no old credit bars or settings card', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>', html.indexOf('<header class="topbar">')));
  for (const id of ['accountSignInBtn', 'accountChip', 'accountMenu', 'moreBtn']) assert.match(topbar, new RegExp(`id="${id}"`));
  for (const action of ['add-credits', 'manage', 'settings', 'sign-out']) assert.match(topbar, new RegExp(`data-account-action="${action}"`));
  assert.doesNotMatch(html, /id="cloudCreditsBar"|id="cloudNoticeBar"|id="settingsCloudCard"/);
  assert.match(html, /id="pageStarters"/);
});

test('own-key settings sections can be locked, each with a plans link', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  for (const id of ['settingsInferenceCard', 'settingsImageCard', 'settingsSttCard', 'settingsJevCard', 'settingsWebAcquireCard']) {
    const open = html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>`))?.[0] || '';
    assert.match(open, /data-byok-section/, id);
  }
  assert.equal((html.match(/data-byok-plans/g) || []).length, 5);
  const css = readFileSync(new URL('../src/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.is-byok-locked \.api-add-btn/);
});
