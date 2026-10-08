// Per-task scripts for the mock model. next(taskId, messages) -> { text } | { calls: [{name,args}] }
// A script is a list of steps; step i runs after i tool results. A step reads the latest snapshot
// (controls + rev) out of the tool results already in the conversation, like a real model would.
function toolTexts(messages) {
  return messages.filter((m) => m.role === 'tool').map((m) => {
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p.text || p.value?.toString?.() || JSON.stringify(p))).join('\n');
    return JSON.stringify(c);
  });
}
function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { /* may have trailing prose */ }
  for (let end = b; end > a; end = text.lastIndexOf('}', end - 1)) { try { return JSON.parse(text.slice(a, end + 1)); } catch { /* shrink */ } }
  return null;
}
function context(messages) {
  const texts = toolTexts(messages);
  let controls = [], rev = '';
  for (const t of texts) {
    const j = parseJson(t);
    if (!j) continue;
    if (Array.isArray(j.controls)) controls = j.controls;
    if (j.rev) rev = j.rev;
  }
  const control = (re, role) => {
    const hit = controls.find((c) => re.test(c.name || '') && (!role || c.role === role));
    if (!hit) throw new Error(`mock: no control matching ${re} (${controls.length} controls)`);
    return hit;
  };
  const find = (re, role) => control(re, role).ref;
  return { n: texts.length, texts, controls, rev, find, control };
}
const snap = () => ({ name: 'action', args: { op: 'snapshot' } });
const act = (c, op, re, extra = {}, role) => {
  const ctl = c.control(re, role);
  // name is sent next to ref on purpose: ref-only mutations currently hit APPROVAL_MISMATCH (see README).
  return { name: 'action', args: { op, ref: ctl.ref, ...(process.env.BK_MOCK_REF_ONLY ? {} : { name: ctl.name }), rev: c.rev, ...extra } };
};

const SCRIPTS = {
  'shop-cheapest': [
    () => snap(),
    (c) => act(c, 'fill', /^Search products$/, { value: 'USB' }),
    (c) => act(c, 'click', /^Search$/, {}, 'button'),
    () => snap(),
    (c) => act(c, 'click', /Add USB Flash Drive 64GB/),
    () => ({ text: 'Added the cheapest USB item (USB Flash Drive 64GB, $7.49) to the cart.' })
  ],
  'signup-form': [
    () => snap(),
    (c) => {
      const f = (re, value) => { const k = c.control(re); return { ref: k.ref, name: k.name, value }; };
      return { name: 'action', args: { op: 'fill_form', rev: c.rev, fields: [
        f(/Full name/, 'Li Wei'), f(/^Email/, 'liwei@example.com'), f(/^Password/, 'Kitten2026x'), f(/Confirm password/, 'Kitten2026x')] } };
    },
    (c) => act(c, 'select', /Country/, { value: 'Japan' }),
    (c) => act(c, 'click', /agree to the Terms/, {}, 'checkbox'),
    (c) => act(c, 'click', /^Create account$/, {}, 'button'),
    () => ({ text: 'Submitted the sign-up form.' })
  ],
  'survey': [
    () => snap(),
    (c) => act(c, 'click', /Desktop app/),
    (c) => act(c, 'click', /^4 stars$/),
    (c) => act(c, 'fill', /^Comments$/, { value: 'Great speed, would recommend' }, 'textbox'),
    (c) => act(c, 'click', /^Submit feedback$/, {}, 'button'),
    () => ({ text: 'Feedback submitted.' })
  ],
  'cookie-modal': [
    () => snap(),
    (c) => act(c, 'click', /Reject non-essential/, {}, 'button'),
    (c) => act(c, 'click', /^Subscribe to newsletter$/, {}, 'button'),
    () => snap(),
    (c) => act(c, 'fill', /^Email/, { value: 'kitten@example.com' }),
    (c) => act(c, 'click', /^Subscribe$/, {}, 'button'),
    () => ({ text: 'Declined non-essential cookies and subscribed kitten@example.com.' })
  ],
  // Plain div menu: the items only exist as heuristic `generic-clickable` controls.
  'admin-menu': [
    () => snap(),
    (c) => act(c, 'click', /^System/, {}, 'generic-clickable'),
    () => snap(),
    (c) => act(c, 'click', /^Preferences/, {}, 'generic-clickable'),
    () => snap(),
    (c) => act(c, 'click', /^Notifications$/, {}, 'generic-clickable'),
    () => snap(),
    (c) => act(c, 'click', /^Email digest$/, {}, 'switch'),
    (c) => act(c, 'click', /^Save changes$/, {}, 'button'),
    () => ({ text: 'Turned on Email digest and saved.' })
  ],
  // Clicks through the DOM path and then claims success. The page only accepts trusted events, so the
  // harness must score this as a failure no matter what the model says. (No script for date-picker etc:
  // unscripted tasks answer "no script" and must also score as failures.)
  'trusted-click': [
    () => snap(),
    (c) => act(c, 'click', /real user click/, {}, 'button'),
    () => ({ text: 'The device has been activated.' })
  ]
};

const INFER = [['shop-cheapest', /USB/], ['signup-form', /Li Wei/], ['survey', /问卷/], ['cookie-modal', /newsletter/i], ['trusted-click', /Activate device/], ['admin-menu', /Email digest/]];
function inferTask(messages) {
  const text = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const hit = INFER.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

function next(taskId, messages) {
  taskId = taskId || inferTask(messages);
  const steps = SCRIPTS[taskId];
  if (!steps) return { text: 'mock: no script for this task' };
  const c = context(messages);
  const step = steps[Math.min(c.n, steps.length - 1)];
  return c.n >= steps.length ? { text: 'Done.' } : normalize(step(c));
}
function normalize(out) { return out.calls || out.text !== undefined ? out : { calls: [out] }; }

module.exports = { next, SCRIPTS };
