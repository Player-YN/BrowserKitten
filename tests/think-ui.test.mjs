import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyThinkExpanded,
  bindThinkToggle,
  composerShouldShowStop,
  durationFromThinkSummary,
  isThinkExpanded,
  isThinkToggleKey,
  rehydrateThinkBlock,
  resolveLiveDisclosureHost,
  resolveLiveThinkHost,
  sealThinkKeepBody,
  shouldCreateThinkFromEvent,
  thinkBodyText
} from '../src/sidepanel/thinkUi.js';

function classList(init = []) {
  const set = new Set(init);
  return {
    contains: (n) => set.has(n),
    add: (...ns) => ns.forEach((n) => set.add(n)),
    remove: (...ns) => ns.forEach((n) => set.delete(n)),
    toggle(n, force) {
      if (force === true) {
        set.add(n);
        return true;
      }
      if (force === false) {
        set.delete(n);
        return false;
      }
      if (set.has(n)) {
        set.delete(n);
        return false;
      }
      set.add(n);
      return true;
    }
  };
}

function node(className, children = [], text = '') {
  const names = String(className || '').split(/\s+/).filter(Boolean);
  const el = {
    classList: { contains: (name) => names.includes(name) },
    children: [],
    textContent: text,
    parentNode: null
  };
  for (const child of children) {
    child.parentNode = el;
    el.children.push(child);
  }
  return el;
}

test('durationFromThinkSummary keeps live and done clocks', () => {
  assert.equal(durationFromThinkSummary('思考中 · 高 · 36S'), '36S');
  assert.equal(durationFromThinkSummary('已思考 · 高 5S'), '5S');
  assert.equal(durationFromThinkSummary('Thinking · high · 2M 05S'), '2M 05S');
  assert.equal(durationFromThinkSummary('已思考 · 高'), '');
});

test('composer stop stays up while a think bar is live', () => {
  assert.equal(composerShouldShowStop(false, true), true);
  assert.equal(composerShouldShowStop(true, false), true);
  assert.equal(composerShouldShowStop(false, false), false);
});

test('resolveLiveThinkHost reuses the live bar instead of spawning another wrap', () => {
  const liveThink = node('think-block is-live', [node('think-summary', [], '思考中 · 高 · 36S')]);
  const turn = node('agent-turn', [liveThink, node('msg assistant')]);
  const body = node('task-body', [
    node('msg user', [], '能不能把这个 HTML做完整一点的'),
    turn
  ]);
  const host = resolveLiveThinkHost(body, null);
  assert.equal(host.think, liveThink);
  assert.equal(host.wrap, turn);
});

test('resolveLiveThinkHost stays on the last turn after the latest user bubble', () => {
  const first = node('agent-turn', [node('think-block', [node('think-summary', [], '已思考 · 高 5S')])]);
  const secondThink = node('think-block', [node('think-summary', [], '已思考 · 高')]);
  const second = node('agent-turn', [secondThink]);
  const body = node('task-body', [
    node('msg user', [], '先做海报'),
    first,
    node('msg user', [], '继续'),
    second
  ]);
  const host = resolveLiveThinkHost(body, { isConnected: false });
  assert.equal(host.wrap, second);
  assert.equal(host.think, secondThink);
});

test('think toggle keys are Enter and Space', () => {
  assert.equal(isThinkToggleKey('Enter'), true);
  assert.equal(isThinkToggleKey(' '), true);
  assert.equal(isThinkToggleKey('Spacebar'), true);
  assert.equal(isThinkToggleKey('Tab'), false);
});

test('streaming and sealed thought stay expandable with aria-expanded', () => {
  const attrs = {};
  const body = { textContent: 'provider thought while streaming' };
  const toggle = {
    type: 'button',
    tagName: 'BUTTON',
    dataset: {},
    attributes: attrs,
    setAttribute(k, v) {
      attrs[k] = v;
    },
    getAttribute(k) {
      return attrs[k];
    },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  };
  const block = {
    classList: classList(['think-block', 'is-live', 'is-collapsed']),
    querySelector(sel) {
      if (sel === '.think-body') return body;
      if (sel === '.think-toggle') return toggle;
      return null;
    }
  };
  applyThinkExpanded(block, false);
  assert.equal(isThinkExpanded(block), false);
  assert.equal(attrs['aria-expanded'], 'false');
  applyThinkExpanded(block, true);
  assert.equal(isThinkExpanded(block), true);
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(thinkBodyText(block), 'provider thought while streaming');

  const kept = sealThinkKeepBody(block);
  assert.equal(kept, 'provider thought while streaming');
  assert.equal(isThinkExpanded(block), false);
  assert.equal(attrs['aria-expanded'], 'false');
  assert.equal(block.classList.contains('is-live'), false);
  applyThinkExpanded(block, true);
  assert.equal(isThinkExpanded(block), true);
  assert.equal(thinkBodyText(block), 'provider thought while streaming');

  let expanded = false;
  bindThinkToggle(toggle, () => expanded, (next) => {
    expanded = next;
    applyThinkExpanded(block, next);
  });
  toggle.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(expanded, true);
  assert.equal(attrs['aria-expanded'], 'true');
});

test('disclosure host is a sibling slot and never a fake think block', () => {
  const think = node('think-block is-live', [node('think-summary', [], '思考中')]);
  const turn = node('agent-turn', [think, node('msg assistant')]);
  const body = node('task-body', [node('msg user', [], '画一张图'), turn]);
  const host = resolveLiveDisclosureHost(body, turn);
  assert.equal(host.wrap, turn);
  assert.equal(host.think, think);
  assert.equal(shouldCreateThinkFromEvent({ type: 'execution-start' }), false);
});

test('no provider thought does not create a think block', () => {
  assert.equal(shouldCreateThinkFromEvent({ type: 'thought' }), false);
  assert.equal(shouldCreateThinkFromEvent({ type: 'thought-open', text: '   ' }), false);
  assert.equal(shouldCreateThinkFromEvent({ type: 'text', text: 'hello' }), false);
  assert.equal(shouldCreateThinkFromEvent({ type: 'thought', text: 'real provider thought' }), true);
});

test('history think rebinds leftover data-think-bound and keeps Enter/Space', () => {
  const attrs = {};
  const makeToggle = (bound) => ({
    type: 'button',
    tagName: 'BUTTON',
    dataset: bound ? { thinkBound: '1', historyBound: '1' } : {},
    setAttribute(k, v) {
      attrs[k] = v;
    },
    getAttribute(k) {
      return attrs[k];
    },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    cloneNode() {
      return makeToggle(false);
    },
    replaceWith() {}
  });
  const toggle = makeToggle(true);
  const block = {
    classList: classList(['think-block', 'is-collapsed']),
    querySelector(sel) {
      if (sel === '.think-toggle') return toggle;
      return null;
    }
  };
  assert.equal(rehydrateThinkBlock(block, { ariaLabel: 'toggle' }), true);
  assert.equal(attrs['aria-expanded'], 'false');
  applyThinkExpanded(block, true);
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(isThinkToggleKey('Enter'), true);
  assert.equal(isThinkToggleKey(' '), true);
});

test('open think block has no orange LTR sweep; no chat-well rim or composer orbit', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const css = readFileSync(join(root, 'src/sidepanel.css'), 'utf8');
  const liveAt = css.indexOf('.think-block.is-live.is-expanded .think-body-wrap');
  assert.ok(liveAt >= 0);
  const liveBlock = css.slice(liveAt, liveAt + 280);
  assert.doesNotMatch(liveBlock, /stream-shimmer/);
  assert.doesNotMatch(liveBlock, /linear-gradient\(90deg/);
  assert.doesNotMatch(css, /@keyframes composer-orbit-spin/);
  assert.doesNotMatch(css, /\.composer-inner::before/);
  assert.doesNotMatch(css, /@keyframes chat-window-breathe/);
  assert.doesNotMatch(css, /\.session-thread\.is-active::before/);
  const wellAt = css.indexOf('/* ── Session thread: layout host only, no bordered well ── */');
  assert.ok(wellAt >= 0);
  const wellBlock = css.slice(wellAt, wellAt + 420);
  assert.match(wellBlock, /background:\s*transparent/);
  assert.match(wellBlock, /border:\s*none/);
  const sbAt = css.indexOf('.think-body-wrap::-webkit-scrollbar');
  assert.ok(sbAt >= 0);
  assert.match(css.slice(sbAt, sbAt + 120), /width:\s*0/);
});
