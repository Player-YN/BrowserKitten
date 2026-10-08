// Task set. `check({ state, answer, pages })` is judged from fixture-server state
// (and, for pure-extraction tasks, the final answer text); never from a claim of success.
const { CHEAPEST_USB, pageTotal, fmt } = require('./fixtures.cjs');

const ok = (pass, reason) => ({ pass: !!pass, reason: reason || (pass ? 'ok' : 'failed') });
const digits = (s) => String(s || '').replace(/[,\s]/g, '');

const TASKS = [
  {
    id: 'shop-cheapest', category: 'search+cart', lang: 'zh', start: '/shop', maxMs: 180000,
    prompt: '在这个页面搜索 "USB"，把搜索结果里价格最便宜的一件商品加入购物车（只加一件）。',
    check: ({ state }) => ok(state.cart.length === 1 && state.cart[0] === CHEAPEST_USB, `cart=${JSON.stringify(state.cart)} want [${CHEAPEST_USB}]`)
  },
  {
    id: 'signup-form', category: 'form+validation', lang: 'en', start: '/signup', maxMs: 180000,
    prompt: 'Sign me up on this page: name Li Wei, email liwei@example.com, password Kitten2026x (use the same for confirmation), country Japan, and accept the terms. Submit the form.',
    check: ({ state }) => {
      const s = state.signups[state.signups.length - 1];
      return ok(s && s.name === 'Li Wei' && s.email === 'liwei@example.com' && s.password === 'Kitten2026x' && s.confirm === 'Kitten2026x' && s.country === 'Japan' && s.agree === true, `signup=${JSON.stringify(s)}`);
    }
  },
  {
    id: 'date-picker', category: 'custom widget', lang: 'en', start: '/date', maxMs: 240000,
    prompt: 'Book check-in for December 18, 2026 on this page and confirm the booking.',
    check: ({ state }) => ok(state.bookings.length >= 1 && state.bookings[state.bookings.length - 1].checkin === '2026-12-18', `bookings=${JSON.stringify(state.bookings)}`)
  },
  {
    id: 'admin-menu', category: 'nested navigation', lang: 'zh', start: '/admin', maxMs: 240000,
    prompt: '在后台依次进入 System > Preferences > Notifications，把 "Email digest" 开关打开，然后点 Save changes 保存。',
    check: ({ state }) => ok(state.settings && state.settings.emailDigest === true, `settings=${JSON.stringify(state.settings)}`)
  },
  {
    id: 'orders-page3', category: 'extraction', lang: 'zh', start: '/orders?page=1', maxMs: 180000,
    prompt: '这个订单列表有好几页。请告诉我第 3 页底部的 "Page total" 合计金额是多少。',
    check: ({ answer }) => ok(digits(answer).includes(digits(fmt(pageTotal(3)))), `want ${fmt(pageTotal(3))} in answer`)
  },
  {
    id: 'iframe-form', category: 'iframe cross-origin', lang: 'zh', start: '/frame', maxMs: 240000,
    prompt: '页面里的联系表单（在 iframe 里）：姓名填 王小明，电话填 13800138000，主题选 Billing，然后点 Send message。',
    check: ({ state }) => {
      const f = state.frame[state.frame.length - 1];
      return ok(f && f.name === '王小明' && f.phone === '13800138000' && f.topic === 'Billing', `frame=${JSON.stringify(f)}`);
    }
  },
  {
    id: 'cookie-modal', category: 'banner+modal', lang: 'en', start: '/cookie', maxMs: 180000,
    prompt: 'Decline the non-essential cookies, then subscribe to the newsletter with the email kitten@example.com.',
    check: ({ state }) => ok(state.cookie === 'reject' && state.subscribed.includes('kitten@example.com'), `cookie=${state.cookie} subscribed=${JSON.stringify(state.subscribed)}`)
  },
  {
    id: 'trusted-click', category: 'isTrusted gate', lang: 'en', start: '/trusted', maxMs: 240000,
    prompt: 'Click the "Activate device" button on this page and make sure the device actually gets activated.',
    check: ({ state }) => ok(state.trusted.includes(true), `trusted events=${JSON.stringify(state.trusted)}`)
  },
  {
    id: 'canvas-red', category: 'canvas / visual', lang: 'zh', start: '/canvas', maxMs: 240000,
    prompt: '点击页面画布里的红色方块。',
    check: ({ state }) => ok(state.canvas[state.canvas.length - 1] === 'red', `canvas clicks=${JSON.stringify(state.canvas)}`)
  },
  {
    id: 'long-scroll', category: 'scroll+copy', lang: 'en', start: '/long', maxMs: 240000,
    prompt: 'This page has a reference code written near the bottom. Find it, type it into the "Reference code" box at the top, and press Verify.',
    check: ({ state }) => ok(state.verified[state.verified.length - 1] === 'KT-7391', `verified=${JSON.stringify(state.verified)}`)
  },
  {
    id: 'two-tab', category: 'multi-tab', lang: 'zh', start: '/tabs', maxMs: 300000,
    prompt: '点开 "View partner offer" 链接，读出合作方页面上的优惠码，回到结账页把它填进 Coupon code 并点 Apply coupon。',
    check: ({ state }) => ok(state.coupons[state.coupons.length - 1] === 'SAVE-4821', `coupons=${JSON.stringify(state.coupons)}`)
  },
  {
    id: 'survey', category: 'radio+rating+text', lang: 'zh', start: '/survey', maxMs: 240000,
    prompt: '帮我填这个反馈问卷：产品选 Desktop app，评分给 4 星，评论写 "Great speed, would recommend"，然后提交。',
    check: ({ state }) => {
      const s = state.surveys[state.surveys.length - 1];
      return ok(s && s.product === 'Desktop' && s.rating === 4 && /great speed, would recommend/i.test(s.comment || ''), `survey=${JSON.stringify(s)}`);
    }
  }
];

module.exports = { TASKS };
