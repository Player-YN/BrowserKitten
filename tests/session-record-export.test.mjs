import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N } from '../src/sidepanel/i18n.js';
import {
  buildSessionRecordMarkdown,
  sessionHeaderDownloadChoices,
  sessionRecordFilename,
  sessionRecordPlainText,
  sessionRecordTurns
} from '../src/sidepanel/sessionRecordExport.js';

const MORE_I18N = [
  'moreAppearance',
  'moreLang',
  'moreTheme',
  'moreSettings',
  'moreSkills',
  'moreSkillsOpen',
  'moreSession',
  'exportSessionMd',
  'exportSessionMdHint',
  'exportSessionEmpty',
  'exportSessionDone',
  'sessionExportBtn',
  'sessionExportBtnTitle'
];

test('session markdown export lives on the chat header, not the more sheet', () => {
  const html = readFileSync(new URL('../src/sidepanel.html', import.meta.url), 'utf8');
  const more = html.slice(html.indexOf('id="moreSheet"'), html.indexOf('id="appModalOverlay"'));
  const side = readFileSync(new URL('../src/sidepanel.js', import.meta.url), 'utf8');
  assert.equal(more.includes('exportMdBtn'), false);
  assert.equal(more.includes('moreSessionTitle'), false);
  assert.equal(more.includes('data-i18n="exportSessionMd"'), false);
  assert.equal(more.includes('moreTrajectory'), false);
  assert.equal(more.includes('🛤️'), false);
  assert.equal(more.includes('导出任务 Markdown'), false);
  assert.equal(more.includes('Skills 技能'), false);
  assert.match(more, /id="moreLangBtn"/);
  assert.match(more, /id="moreThemeBtn"/);
  assert.match(more, /id="moreSettingsBtn"/);
  assert.match(more, /id="moreSkillsBtn"/);
  assert.match(more, /id="sheetClose"/);
  assert.equal(side.includes('exportMdBtn'), false);
  assert.match(side, /sessionHeaderDownloadChoices/);
  assert.match(side, /exportCurrentSessionMarkdown\(/);
  assert.match(side, /openTrajectoryExportModal\(/);
  assert.equal(side.includes('btn.hidden = !devTrajectoryExportEnabled'), false);
  assert.deepEqual(sessionHeaderDownloadChoices(false), ['messages']);
  assert.deepEqual(sessionHeaderDownloadChoices(true), ['messages', 'trajectory']);
  for (const key of MORE_I18N) {
    assert.equal(typeof I18N.zh[key], 'string', `zh missing ${key}`);
    assert.equal(typeof I18N.en[key], 'string', `en missing ${key}`);
  }
  assert.equal(I18N.zh.moreSkills.includes('Skills'), false);
  assert.equal(I18N.zh.moreSession, '会话记录');
  assert.equal(I18N.en.moreSession, 'Conversation');
  assert.equal(I18N.zh.sessionExportBtn, '导出');
  assert.equal(I18N.en.sessionExportBtn, 'Export');
});

test('session record markdown is user/assistant text only', () => {
  const md = buildSessionRecordMarkdown({
    title: '整理机票',
    exportedAt: '2026-09-21 18:00',
    labels: {
      heading: '会话记录',
      exportedAt: '导出时间',
      user: '用户',
      assistant: 'Browser Kitten',
      untitled: '未命名'
    },
    messages: [
      { role: 'user', content: '帮我比价' },
      {
        role: 'assistant',
        content: '这是最终回复',
        thought: 'secret chain of thought',
        path: [{ tool: 'search' }],
        toolCalls: [{ name: 'search' }]
      },
      { role: 'system', content: 'should skip' },
      { role: 'assistant', content: '   ' }
    ]
  });
  assert.match(md, /^# 会话记录: 整理机票/m);
  assert.match(md, /导出时间: 2026-09-21 18:00/);
  assert.match(md, /## 用户\n\n帮我比价/);
  assert.match(md, /## Browser Kitten\n\n这是最终回复/);
  assert.equal(md.includes('secret chain of thought'), false);
  assert.equal(md.includes('search'), false);
  assert.equal(md.includes('should skip'), false);
  assert.equal(sessionRecordTurns([
    { role: 'user', content: '帮我比价' },
    { role: 'assistant', thought: 'only thought' }
  ]), 1);
  assert.equal(sessionRecordPlainText({ content: [{ type: 'text', text: 'hi' }] }), 'hi');
});

test('session record filename uses conversation prefix', () => {
  const now = new Date('2026-09-21T10:00:00');
  assert.equal(sessionRecordFilename('整理机票', 'zh', now), '会话记录_整理机票_2026-09-21.md');
  assert.equal(sessionRecordFilename('Flight / plan', 'en', now), 'conversation_Flight_plan_2026-09-21.md');
});
