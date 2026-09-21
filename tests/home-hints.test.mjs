import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N, translate } from '../src/sidepanel/i18n.js';
import { HOME_HINT_IDS, getHomeHints } from '../src/sidepanel/homeHints.js';
import { listPackagedSkillCatalog } from '../src/agent/vnext/skills/registry.js';

const DUMP = /inspect view=skill|教学模式|TEACHING MODE|教学开场|skillId=/i;
const MAX_SENT = 140;

const QUESTIONS = Object.freeze({
  zh: {
    'create-personal-tool': '我想做一个可以反复跑的油猴式脚本，什么时候该做成工具、怎么开始？',
    'create-workflow': '我想做一套自动点击、自动填写的 RPA，什么时候用 workflow、怎么开始？',
    'use-browser-kitten':
      'Browser Kitten 这个 Agent 能怎么帮我在已登录的页面上把任务做完？比如直接操作浏览器，或临时写代码改页。'
  },
  en: {
    'create-personal-tool':
      'I want a Tampermonkey-style script I can rerun. When should I save it as a tool, and how do I start?',
    'create-workflow':
      'I want RPA that auto-clicks and auto-fills. When should I use a workflow, and how do I start?',
    'use-browser-kitten':
      'How can this Browser Kitten Agent finish my work on a logged-in page — operate the browser, or write throwaway code to change it?'
  }
});

test('home chips send a short natural question, not a teaching dump', () => {
  assert.deepEqual([...HOME_HINT_IDS], [
    'create-personal-tool',
    'create-workflow',
    'use-browser-kitten'
  ]);
  for (const lang of ['zh', 'en']) {
    const hints = getHomeHints((key) => translate(lang, key));
    assert.equal(hints.length, 3);
    hints.forEach((hint, i) => {
      assert.equal(hint.id, HOME_HINT_IDS[i]);
      assert.ok(hint.label.length > 0);
      assert.notEqual(hint.prompt, hint.label);
      assert.ok(hint.prompt.length < MAX_SENT, `${lang} ${hint.id} sent text too long (${hint.prompt.length})`);
      assert.doesNotMatch(hint.prompt, DUMP);
      assert.equal(hint.prompt, QUESTIONS[lang][hint.id]);
    });
  }
  assert.equal(I18N.zh.teachCreateToolLabel, '如何创造一个新工具？');
  assert.equal(I18N.zh.teachCreateWorkflowLabel, '如何创造一个新 workflow？');
  assert.equal(I18N.zh.teachUseProductLabel, '如何使用 BrowserKitten？');
});

test('homepage HTML first paint has the three chips', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  const chips = [...html.matchAll(/data-hint-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chips, [...HOME_HINT_IDS]);
  assert.match(html, /data-i18n="teachCreateToolLabel"/);
  assert.match(html, /data-i18n="teachCreateWorkflowLabel"/);
  assert.match(html, /data-i18n="teachUseProductLabel"/);
  assert.doesNotMatch(html, /guideChipLabel|怎么用 Browser Kitten/);
});

test('sidepanel wires home hints through the existing fill-and-send chip path', () => {
  const source = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ getHomeHints \} from '\.\/sidepanel\/homeHints\.js'/);
  assert.match(source, /function getGuideOnlyHints\(\) \{\s*return getHomeHints\(t\);/s);
  assert.match(source, /setComposerPlainText\(item\.prompt, input\)/);
  assert.match(source, /submitUserPrompt\(\)/);
  assert.match(source, /data-hint-id/);
  assert.doesNotMatch(source, /inspect view=skill|pendingHomeSkill|teachingFlag/);
});

test('onboarding chips are not packed skills', () => {
  const catalog = listPackagedSkillCatalog();
  const ids = new Set(catalog.map((s) => s.id));
  for (const id of HOME_HINT_IDS) {
    assert.equal(ids.has(id), false, `${id} must not be a packaged skill`);
  }
  assert.doesNotMatch(
    readFileSync(new URL('../src/agent/vnext/skills/registry.js', import.meta.url), 'utf8'),
    /create-personal-tool|create-workflow|use-browser-kitten/
  );
});

test('tool question is 油猴脚本 / userscript, not a click tour', () => {
  for (const lang of ['zh', 'en']) {
    const prompt = translate(lang, 'teachCreateToolPrompt');
    assert.match(prompt, lang === 'zh' ? /油猴/ : /Tampermonkey|userscript/i);
    assert.match(prompt, lang === 'zh' ? /反复跑/ : /rerun/i);
    assert.doesNotMatch(prompt, DUMP);
    assert.doesNotMatch(prompt, /OCR|二维码|\bQR\b|Alt\+Shift|#personalToolsBtn/i);
  }
});

test('workflow question is RPA auto-click / auto-fill', () => {
  for (const lang of ['zh', 'en']) {
    const prompt = translate(lang, 'teachCreateWorkflowPrompt');
    assert.match(prompt, /RPA/);
    assert.match(prompt, /自动点击|auto-click/i);
    assert.match(prompt, /自动填写|auto-fill/i);
    assert.doesNotMatch(prompt, DUMP);
    assert.doesNotMatch(prompt, /OCR|二维码|\bQR\b|Alt\+Shift|#personalLibrary/i);
  }
});

test('use question is finishing a task on a logged-in page', () => {
  for (const lang of ['zh', 'en']) {
    const prompt = translate(lang, 'teachUseProductPrompt');
    assert.match(prompt, /Agent/);
    assert.match(prompt, /已登录|logged-in/i);
    assert.match(prompt, /操作浏览器|operate the browser/i);
    assert.match(prompt, /临时写代码|throwaway code/i);
    assert.doesNotMatch(prompt, DUMP);
    assert.doesNotMatch(prompt, /OCR|二维码|\bQR\b|screenshot|截图/i);
  }
});
