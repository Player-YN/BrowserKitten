import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TASK_BODY_SCROLL_REVEAL_MS,
  markStarlightScrolling,
  markTaskBodyScrolling,
  resolveStarlightScrollport,
  starlightPortFromEvent,
  starlightThumbMetrics
} from '../src/sidepanel/scroll.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function classList(init = []) {
  const set = new Set(init);
  return {
    contains: (n) => set.has(n),
    add: (...ns) => ns.forEach((n) => set.add(n)),
    remove: (...ns) => ns.forEach((n) => set.delete(n))
  };
}

test('open conversation scrollport is .task-body overlay; no nested stream scroll', () => {
  const layout = readFileSync(join(root, 'src/sidepanel/css/layout.css'), 'utf8');
  const openAt = layout.indexOf('.panel.is-thread-open .task-body {');
  assert.ok(openAt >= 0);
  const body = layout.slice(openAt, openAt + 420);
  assert.match(body, /overflow-y:\s*overlay/);
  assert.match(body, /scrollbar-width:\s*none/);
  assert.match(body, /scrollbar-gutter:\s*auto/);
  const streamAt = layout.indexOf('.panel.is-thread-open .task-stream {');
  const stream = layout.slice(streamAt, streamAt + 220);
  assert.match(stream, /overflow:\s*hidden/);
  const panelAt = layout.indexOf('.panel.is-thread-open .panel-scroll {');
  const panel = layout.slice(panelAt, panelAt + 120);
  assert.match(panel, /overflow:\s*hidden/);
});

test('starlight bar is a glowing gradient particle overlay gated by is-scrolling', () => {
  const motion = readFileSync(join(root, 'src/sidepanel/css/motion.css'), 'utf8');
  const starAt = motion.indexOf('Starlight overlay');
  const star = starAt >= 0 ? motion.slice(starAt, motion.indexOf('/* Popover enter')) : motion;
  assert.match(star, /@keyframes starlight-dust/);
  assert.match(star, /@keyframes starlight-twinkle/);
  assert.match(star, /@keyframes starlight-mote-twinkle/);
  assert.match(star, /\.task-body\.is-scrolling/);
  assert.match(star, /\.think-body-wrap\.is-scrolling/);
  assert.match(star, /radial-gradient\(/);
  assert.match(star, /linear-gradient\(/);
  assert.match(star, /box-shadow:/);
  assert.match(star, /--density-scroll-w/);
  assert.match(star, /overflow:\s*hidden/);
  assert.match(star, /width:\s*4px/);
  assert.match(star, /--starlight-thumb-h/);
  assert.doesNotMatch(star, /bottom:\s*4px/);
  assert.doesNotMatch(star, /width:\s*10px/);
  assert.doesNotMatch(star, /width:\s*8px/);
  assert.doesNotMatch(star, /width:\s*30px/);
  assert.doesNotMatch(star, /::before/);
  const moteCount = (star.match(/radial-gradient\(/g) || []).length;
  assert.ok(moteCount >= 5, `expected thumb motes, got ${moteCount}`);
  assert.doesNotMatch(motion, /@keyframes chat-window-breathe/);
  const reduceAt = motion.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduceAt >= 0);
  const reduce = motion.slice(reduceAt);
  assert.match(reduce, /starlight-dust|starlight-twinkle|is-scrolling/s);
  assert.match(reduce, /animation:\s*none/);
});

test('home welcome is not a session-thread card', () => {
  const html = readFileSync(join(root, 'src/sidepanel.html'), 'utf8');
  const welcomeAt = html.indexOf('id="welcome"');
  assert.ok(welcomeAt >= 0);
  const before = html.slice(Math.max(0, welcomeAt - 400), welcomeAt);
  assert.doesNotMatch(before, /class="[^"]*session-thread/);
  assert.match(html, /id="homeComposerSlot"/);
});

test('starlight thumb metrics stay inside the track', () => {
  const mid = starlightThumbMetrics({ scrollHeight: 1000, clientHeight: 200, scrollTop: 400 });
  assert.ok(mid.thumbH >= 32);
  assert.ok(mid.thumbH <= 200);
  assert.ok(mid.thumbTop >= 0);
  assert.ok(mid.thumbTop + mid.thumbH <= 200 + 0.01);
  const top = starlightThumbMetrics({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 });
  assert.equal(top.thumbTop, 0);
});

test('markTaskBodyScrolling shows then hides after the hold', async () => {
  assert.ok(TASK_BODY_SCROLL_REVEAL_MS >= 600 && TASK_BODY_SCROLL_REVEAL_MS <= 800);
  const el = { classList: classList(['task-body']), closest() { return this; }, style: { setProperty() {} }, querySelector() { return null; } };
  assert.equal(markTaskBodyScrolling(el, 25), true);
  assert.equal(el.classList.contains('is-scrolling'), true);
  assert.equal(markTaskBodyScrolling({ classList: classList(['panel-scroll']) }, 25), false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(el.classList.contains('is-scrolling'), false);
});

test('think wrap is the innermost starlight port and clears the outer chat bar', () => {
  const wrap = {
    classList: classList(['think-body-wrap']),
    closest(sel) {
      if (String(sel).includes('think-body-wrap')) return this;
      if (String(sel).includes('task-body')) return body;
      if (String(sel).includes('think-block')) return this;
      return null;
    },
    style: { setProperty() {} },
    querySelector() { return null; }
  };
  const body = {
    classList: classList(['task-body', 'is-scrolling']),
    closest(sel) { return String(sel).includes('task-body') ? this : null; },
    style: { setProperty() {} },
    querySelector(sel) {
      return String(sel).includes('think-body-wrap') && wrap.classList.contains('is-scrolling')
        ? wrap
        : null;
    }
  };
  const inner = {
    closest(sel) {
      if (String(sel).includes('think-body-wrap')) return wrap;
      if (String(sel).includes('task-body')) return body;
      return null;
    }
  };
  assert.equal(resolveStarlightScrollport(inner), wrap);
  assert.equal(resolveStarlightScrollport(body), body);
  const chrome = {
    closest(sel) {
      if (String(sel).includes('think-body-wrap')) return null;
      if (String(sel).includes('think-block') || String(sel).includes('think-body')) return this;
      if (String(sel).includes('task-body')) return body;
      return null;
    }
  };
  assert.equal(resolveStarlightScrollport(chrome), null);
  assert.equal(starlightPortFromEvent({ target: inner, type: 'wheel' }), wrap);
  assert.equal(starlightPortFromEvent({ target: chrome, type: 'wheel' }), null);
  assert.equal(starlightPortFromEvent({ target: body, type: 'scroll' }), body);
  assert.equal(markStarlightScrolling(wrap, 40), true);
  assert.equal(wrap.classList.contains('is-scrolling'), true);
  assert.equal(body.classList.contains('is-scrolling'), false);
  assert.equal(starlightPortFromEvent({ target: body, type: 'scroll' }), null);
});
