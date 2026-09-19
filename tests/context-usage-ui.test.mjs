import test from 'node:test';
import assert from 'node:assert/strict';

import { I18N } from '../src/sidepanel/i18n.js';
import {
  contextPartRows,
  createContextUsageUi,
  estimateContextParts,
  formatContextChip,
  formatContextHeadline,
  paintContextUsage,
  projectContextUsage,
  SESSION_TOOL_COUNT
} from '../src/sidepanel/contextUsageUi.js';

function zh(key) {
  return I18N.zh[key] || key;
}
function en(key) {
  return I18N.en[key] || key;
}

test('does not invent an exact percent without provider usage', () => {
  const empty = projectContextUsage({ contextWindow: 256000, lastUsage: {}, messages: [] });
  assert.notEqual(empty.source, 'api');
  assert.equal(empty.estimated, true);
  assert.notEqual(empty.pct, 42);
  const chip = formatContextChip(empty, zh);
  assert.equal(/42/.test(chip), false);
  if (empty.showPercent) assert.equal(empty.source, 'estimate');
});

test('legacy promptTokens without source are labeled estimate, not api', () => {
  const p = projectContextUsage({
    contextWindow: 128000,
    lastUsage: { promptTokens: 64000 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(p.source, 'estimate');
  assert.equal(p.used, 64000);
  assert.equal(p.showPercent, true);
  assert.match(formatContextHeadline(p, zh), /估计/);
  assert.match(formatContextHeadline(p, en), /estimate/i);
  assert.match(formatContextChip(p, zh), /~/);
});

test('api usage is not replaced by a local guess', () => {
  const p = projectContextUsage({
    contextWindow: 256000,
    lastUsage: { source: 'api', promptTokens: 12800 },
    messages: [{ role: 'user', content: 'hello '.repeat(8000) }]
  });
  assert.equal(p.source, 'api');
  assert.equal(p.used, 12800);
  assert.equal(p.estimated, false);
  assert.equal(p.pct, 5);
  assert.equal(/估计|estimate/i.test(formatContextHeadline(p, zh)), false);
  assert.match(formatContextChip(p, zh), /5%/);
});

test('local estimate uses real message and catalog sizes, not a fake 42', () => {
  const parts = estimateContextParts({
    messages: [{ role: 'user', content: '请把这两页做成表格' }],
    skills: [{ id: 'site-tool-reuse', name: 'Site tool reuse', description: 'reuse' }],
    artifacts: [{ artifactId: 'a1' }, { artifactId: 'a2' }],
    tabCount: 3,
    aimedCount: 1
  });
  assert.equal(parts.toolCount, SESSION_TOOL_COUNT);
  assert.equal(parts.skillCount, 1);
  assert.equal(parts.artifactCount, 2);
  assert.equal(parts.tabCount, 3);
  assert.ok(parts.conversation > 0);
  assert.ok(parts.prefix > 0);
  const p = projectContextUsage({
    contextWindow: 128000,
    lastUsage: { source: 'none', promptTokens: 0 },
    messages: [{ role: 'user', content: '请把这两页做成表格' }],
    skills: [{ id: 'site-tool-reuse', name: 'Site tool reuse' }]
  });
  assert.equal(p.source, 'estimate');
  assert.equal(p.used, p.parts.totalEstimate);
  assert.notEqual(p.pct, 42);
  const rows = contextPartRows(p, zh);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['prefix', 'tools', 'skills', 'world', 'conversation']
  );
  assert.match(rows.find((r) => r.key === 'tools').meta, /9/);
});

test('composer trigger is icon-only: copy goes to aria-label, not a visible title', () => {
  const prevDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ className: '', dataset: {}, textContent: '', append() {} })
  };
  try {
    const p = projectContextUsage({
      contextWindow: 256000,
      lastUsage: { source: 'api', promptTokens: 2560 }
    });
    const button = {
      title: '上下文',
      dataset: {},
      classList: { toggle() {} },
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) {
        delete this.attrs[name];
        if (name === 'title') this.title = '';
      }
    };
    const parts = { replaceChildren() {}, append() {} };
    paintContextUsage({
      chip: { textContent: '' },
      button,
      ring: {
        style: { setProperty() {} },
        dataset: {},
        classList: { toggle() {} },
        setAttribute() {},
        removeAttribute() {}
      },
      ringLabel: { hidden: true, textContent: '' },
      headline: { textContent: '' },
      bar: { hidden: true, style: { setProperty() {} } },
      barFill: {},
      parts,
      note: { hidden: true, textContent: '' }
    }, p, zh);
    assert.equal(button.title, '');
    assert.match(button.attrs['aria-label'], /1%/);
    assert.match(formatContextChip(p, zh), /1%/);
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('open popover leaves the composer so chat history cannot cover it', () => {
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const listeners = [];
  function el(id) {
    return {
      id,
      hidden: true,
      parentElement: null,
      dataset: {},
      style: {},
      classList: {
        add() {},
        remove() {},
        toggle() {}
      },
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute() {},
      addEventListener() {},
      contains(node) { return node === this; },
      getBoundingClientRect() { return { top: 420, right: 300, bottom: 442, left: 278, width: 22, height: 22 }; },
      focus() {}
    };
  }
  const home = el('composerContext');
  const button = el('contextUsageBtn');
  const popover = el('contextUsagePopover');
  home.appendChild = () => { popover.parentElement = home; };
  home.appendChild(popover);
  const body = {
    appendChild(node) {
      node.parentElement = body;
      return node;
    }
  };
  globalThis.window = {
    innerHeight: 800,
    innerWidth: 360,
    addEventListener() {},
    matchMedia() { return { matches: false }; }
  };
  globalThis.document = {
    body,
    getElementById(id) {
      if (id === 'composerContext') return home;
      return null;
    },
    querySelector: () => null,
    addEventListener(type, fn) { listeners.push([type, fn]); },
    createElement: () => ({ className: '', dataset: {}, textContent: '', append() {} })
  };
  try {
    const ui = createContextUsageUi({
      t: zh,
      getButton: () => button,
      getPopover: () => popover,
      gather: () => ({ contextWindow: 128000, lastUsage: {}, messages: [] })
    });
    ui.open();
    assert.equal(popover.parentElement, body);
    assert.equal(popover.hidden, false);
    assert.equal(popover.style.position, 'fixed');
    assert.equal(popover.style.zIndex, '10050');
    ui.close();
    assert.equal(popover.parentElement, home);
    assert.equal(popover.hidden, true);
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('unknown model window is omitted instead of a fake 128K', () => {
  const p = projectContextUsage({
    contextWindow: 0,
    lastUsage: { source: 'estimate', promptTokens: 1200, contextWindow: 128000 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(p.window, 0);
  assert.match(formatContextHeadline(p, en), /About .+ tokens \(estimate\)/);
  assert.doesNotMatch(formatContextHeadline(p, en), /128/);
});

test('catalog window is shown when gather resolved it', () => {
  const p = projectContextUsage({
    contextWindow: 200000,
    lastUsage: { source: 'estimate', promptTokens: 1000, contextWindow: 128000 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(p.window, 200000);
  assert.match(formatContextHeadline(p, en), /200[,.]?000/);
});

test('popover: OpenRouter catalog, unknown, and measured windows', () => {
  const openrouter = projectContextUsage({
    contextWindow: 128000,
    lastUsage: { source: 'estimate', promptTokens: 12800 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(openrouter.window, 128000);
  assert.match(formatContextHeadline(openrouter, en), /128[,.]?000/);
  assert.match(formatContextHeadline(openrouter, zh), /128[,.]?000/);

  const unknown = projectContextUsage({
    contextWindow: 0,
    lastUsage: { source: 'estimate', promptTokens: 1200 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(unknown.window, 0);
  assert.match(formatContextHeadline(unknown, en), /About .+ tokens \(estimate\)/);
  assert.doesNotMatch(formatContextHeadline(unknown, en), /128[,.]?000/);
  assert.doesNotMatch(formatContextHeadline(unknown, zh), /128/);

  const measured = projectContextUsage({
    contextWindow: 131072,
    lastUsage: { source: 'estimate', promptTokens: 13107 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(measured.window, 131072);
  assert.match(formatContextHeadline(measured, en), /131[,.]?072/);
});

test('unknown usage headline does not claim a full bar', () => {
  const p = projectContextUsage({
    lastUsage: { source: 'none', promptTokens: 0 },
    messages: [],
    prefixText: ''
  });
  assert.equal(p.source, 'unknown');
  assert.equal(p.showPercent, false);
  assert.equal(p.pct, null);
  assert.equal(formatContextChip(p, en), 'Context');
  assert.equal(formatContextHeadline(p, en), 'No exact model token count yet');
});
