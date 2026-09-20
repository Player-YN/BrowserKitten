import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT_VERSION,
  buildSessionAgentInstructions,
  buildWorldStateBlock,
  compactOpenTabOverview,
  OPEN_TAB_DOMAIN_CAP
} from '../src/agent/vnext/sessionWorkspace/prompt.js';
import {
  formatSkillsForSystemPrompt,
  getSkill,
  listPackagedSkillCatalog,
  loadSkillInstructions
} from '../src/agent/vnext/skills/registry.js';
import { SessionWorkspaceStore } from '../src/agent/vnext/sessionWorkspace/store.js';
import { createSessionGuestFs } from '../src/agent/vnext/sessionWorkspace/fs.js';
import { createSessionTools } from '../src/agent/vnext/sessionWorkspace/tools.js';

function sessionTools() {
  const store = new SessionWorkspaceStore();
  store.put('sessions', 's', { sessionId: 's', messages: [] });
  const execution = { executionId: 'e' };
  const fs = createSessionGuestFs(store, { sessionId: 's', executionId: 'e' });
  return createSessionTools({ store, execution, fs, sessionId: 's' });
}

test('prefix prefers ready-made site tools and does not dump the skill body', () => {
  assert.equal(SYSTEM_PROMPT_VERSION, 'v22-browser-kitten');
  const prefix = buildSessionAgentInstructions();
  assert.match(prefix, /你是"Browser Kitten"/);
  assert.match(prefix, /不预设某种工具或路径总是更好/);
  assert.match(prefix, /也可以编写代码或组合多种能力/);
  // v13 site-tool-reuse principle sentences are not required in the prefix
  assert.doesNotMatch(prefix, /先募集现成工具/);
  assert.doesNotMatch(prefix, /run 是胶水/);
  assert.doesNotMatch(prefix, /现成站内工具优先/);
  assert.doesNotMatch(prefix, /site-tool-reuse/);
  assert.doesNotMatch(prefix, /If the preferred route fails/);
  assert.doesNotMatch(prefix, /Parameterize/);
  assert.doesNotMatch(prefix, /\[Session world/);
  const spliced = buildSessionAgentInstructions({
    skillInstructions: 'id: site-tool-reuse\ndescription: demo'
  });
  assert.match(spliced, /--- Skills ---/);
  assert.match(spliced, /id: site-tool-reuse/);
  assert.ok(spliced.startsWith(prefix));
});

test('site-tool-reuse is catalog-discoverable and loads only on inspect', async () => {
  const catalog = listPackagedSkillCatalog();
  const row = catalog.find((s) => s.id === 'site-tool-reuse');
  assert.ok(row);
  assert.match(row.description, /already-open|logged-in|live website|discover and compare/i);
  const listed = formatSkillsForSystemPrompt({ catalog });
  assert.match(listed, /id: site-tool-reuse/);
  assert.match(listed, /description:/);
  assert.doesNotMatch(listed, /If the preferred route fails/);
  assert.doesNotMatch(listed, /# Discover/);

  const skill = getSkill('site-tool-reuse');
  const playbook = loadSkillInstructions('site-tool-reuse');
  assert.ok(skill);
  assert.match(playbook, /# Discover/);
  assert.match(playbook, /# Compare then choose/);
  assert.match(playbook, /# Check afterward/);
  assert.match(playbook, /preferred route fails/);
  assert.match(playbook, /discovery stays allowed/);
  assert.doesNotMatch(playbook, /anti-pattern|pitfall|known issue/i);

  const tools = sessionTools();
  const catalogOut = await tools.inspect.execute({ view: 'skill' });
  assert.equal(catalogOut.ok, true);
  assert.ok((catalogOut.catalog || []).some((s) => s.id === 'site-tool-reuse'));
  assert.ok(!(catalogOut.playbook || '').includes('If the preferred route fails'));

  const loaded = await tools.inspect.execute({ view: 'skill', skillId: 'site-tool-reuse' });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.skillId, 'site-tool-reuse');
  assert.match(String(loaded.playbook || ''), /Discover/);
  assert.match(String(loaded.playbook || ''), /discovery stays allowed/);
});

test('open tab overview is tabCount plus at most 10 domains and never titles', () => {
  const tabs = [
    { url: 'https://www.canva.com/design/abc', title: 'SECRET POSTER' },
    { url: 'https://canva.com/folder', title: 'Folder' },
    { url: 'https://remove.bg/', title: 'remove.bg' },
    { url: 'chrome://extensions', title: 'Extensions' },
    { url: 'https://www.figma.com/file/1', title: 'File' },
    { url: 'https://gemini.google.com/app', title: 'Gemini' },
    { url: 'https://chat.openai.com/', title: 'ChatGPT' },
    { url: 'https://www.notion.so/x', title: 'Notes' },
    { url: 'https://docs.google.com/doc', title: 'Doc' },
    { url: 'https://mail.google.com/', title: 'Inbox' },
    { url: 'https://github.com/', title: 'GitHub' },
    { url: 'https://linear.app/', title: 'Linear' },
    { url: 'https://example.com/', title: 'Example' }
  ];
  const overview = compactOpenTabOverview(tabs);
  assert.equal(overview.tabCount, tabs.length);
  assert.ok(overview.domains.length <= OPEN_TAB_DOMAIN_CAP);
  assert.ok(overview.domains.includes('canva.com'));
  assert.ok(!overview.domains.includes('chrome'));
  assert.equal(overview.domains.filter((d) => d === 'canva.com').length, 1);
  const world = buildWorldStateBlock({
    tabOverview: overview,
    boundGroups: [],
    boundItems: []
  });
  assert.match(world, /openTabs=/);
  assert.match(world, /tabCount/);
  assert.doesNotMatch(world, /SECRET POSTER/);
  assert.doesNotMatch(world, /ChatGPT/);
  assert.doesNotMatch(world, /title":/);
});

test('run and action descriptions list channels without a forced primary path', () => {
  const tools = sessionTools();
  assert.doesNotMatch(tools.run.description, /Do not use run for a pure click/);
  assert.doesNotMatch(tools.run.description, /not the default way to do the user job/);
  assert.doesNotMatch(tools.action.description, /Prefer this for in-site/);
  assert.doesNotMatch(tools.action.description, /ready-made page controls beat/);
  assert.match(tools.action.description, /pointer/);
  assert.match(tools.action.description, /sys\.eval/);
  assert.doesNotMatch(tools.action.description, /RAW_ESCAPE_DENIED|NO_TARGET|TAB_LEASED|FILE_CHOOSER/);
  assert.deepEqual(tools.action.parameters.required, ['op']);
  assert.ok(tools.action.parameters.properties.op.enum.includes('upload'));
  assert.ok(tools.action.parameters.properties.op.enum.includes('pointer'));
  assert.ok(tools.action.parameters.properties.tabId);
  assert.doesNotMatch(tools.action.description, /must screenshot first|prefer structure/i);
  assert.ok(tools.run.parameters.properties.code);
});
