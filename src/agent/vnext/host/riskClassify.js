/**
 * Host risk classifier. Model-supplied risk / intent / confidence are ignored.
 *
 * Existing stack = aim lock + document identity + tab mutex + canvas optimistic
 * lock + honest lost receipts + progress notes + after-the-fact audit.
 * Missing until this module + journal: host-enforced capability policy and
 * delete approval; write-ahead operation journal + independent postconditions.
 * Never treat task.evidence / audit / action ok / model prose as verified.
 * Never treat lease / execution / UNKNOWN codes as a journal.
 */

export const RISK_READ = 'read';
export const RISK_REVERSIBLE = 'reversible-write';
export const RISK_COMMIT = 'external-commit';
export const RISK_DELETE = 'delete';
export const RISK_PAYMENT = 'payment';
export const RISK_RAW = 'raw-escape';

export const CONF_KNOWN = 'known';
export const CONF_AMBIGUOUS = 'ambiguous';
export const CONF_UNKNOWN = 'unknown';

export const CDP_READ_METHODS = Object.freeze([
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  'Page.captureScreenshot',
  'Runtime.getProperties',
  'Network.getResponseBody'
]);

const PAYMENT_NAMES = [
  '支付',
  '付款',
  '立即支付',
  '确认支付',
  '去付款',
  '微信支付',
  '支付宝',
  '买单',
  '结账并支付',
  'pay now',
  'pay now.',
  'buy now',
  'place order',
  'complete purchase',
  'confirm payment',
  'add card',
  'add credit card',
  'submit payment',
  'checkout and pay'
];

const DELETE_NAMES = [
  '删除',
  '彻底删除',
  '删除该',
  '移到回收站',
  '清空',
  '移除',
  '解除',
  '注销账号',
  '关闭账号',
  'delete permanently',
  'move to trash',
  'unsubscribe',
  'delete',
  'remove'
];

const SEND_NAMES = ['发送', '发表', '发布', '回复', 'tweet', 'post', 'send', 'publish', 'submit'];

const CART_NAMES = ['加入购物车', '加入購物車', 'add to cart', 'add to bag', '立即购买', '立即購買'];

const PAYMENT_URL_RE =
  /checkout|payments?|billing|wallet|\/cart\/pay|alipay|paypal|stripe|checkout\.shopify|\.pay\.|\/pay(?:ment)?s?(?:\/|$)/i;

const PAYMENT_HOST_RE =
  /(^|\.)(paypal\.|stripe\.|checkout\.shopify|alipay\.|alipayobjects\.|pay\.weixin|checkout\.)/i;

const ACTION_READ = new Set(['snapshot', 'wait', 'resolve_name', 'resolve_intent', 'listen', 'record', 'scrape']);
const ACTION_FILL = new Set(['fill', 'fill_form', 'select', 'scroll', 'toggle']);
const ACTION_MUTATE = new Set(['click', 'fill', 'fill_form', 'select', 'press', 'scroll', 'upload', 'pointer', 'hover', 'dblclick', 'contextmenu', 'toggle']);

const SYS_READ = new Set([
  'help',
  'capabilities',
  'tabs.list',
  'tabs.current',
  'tabs.frames',
  'screenshot'
]);
const SYS_NAV = new Set(['tabs.open', 'tabs.navigate', 'tabs.reload']);

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.\u3002]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return norm(value).replace(/[\s_\-]/g, '');
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatches(name, list) {
  const n = norm(name);
  if (!n) return '';
  for (const item of list) {
    const t = norm(item);
    if (!t) continue;
    if (n === t) return item;
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (n.includes(t)) return item;
      continue;
    }
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(t)}(?:$|[^a-z0-9])`, 'i');
    if (re.test(n)) return item;
  }
  return '';
}

function urlText(url) {
  return String(url || '');
}

function looksCheckoutUrl(url) {
  const raw = urlText(url);
  if (!raw) return false;
  try {
    const parsed = new URL(raw, 'https://example.invalid');
    return PAYMENT_URL_RE.test(`${parsed.hostname}${parsed.pathname}`) || PAYMENT_HOST_RE.test(parsed.hostname);
  } catch {
    return PAYMENT_URL_RE.test(raw);
  }
}

function paymentHost(url) {
  const raw = urlText(url);
  try {
    const parsed = new URL(raw, 'https://example.invalid');
    return PAYMENT_HOST_RE.test(parsed.hostname) || /paypal\.com|stripe\.com|alipay\.com|checkout\.shopify/i.test(parsed.hostname);
  } catch {
    return /paypal|stripe|alipay|checkout\.shopify/i.test(raw);
  }
}

function controlName(input = {}) {
  return String(
    input.control?.name ||
      input.control?.label ||
      input.name ||
      input.label ||
      input.activeName ||
      ''
  );
}

function controlType(input = {}) {
  return String(input.control?.type || input.type || '').toLowerCase();
}

function controlRole(input = {}) {
  return String(input.control?.role || input.role || '').toLowerCase();
}

function hints(input = {}) {
  return input.control?.hints && typeof input.control.hints === 'object' ? input.control.hints : input.hints || {};
}

function verdict(partial) {
  return {
    risk: RISK_READ,
    confidence: CONF_KNOWN,
    reason: '',
    summary: '',
    signals: [],
    effectConfidence: CONF_KNOWN,
    target: {},
    ...partial,
    target: {
      tabId: partial.target?.tabId ?? partial.tabId,
      frameId: partial.target?.frameId ?? partial.frameId,
      documentId: partial.target?.documentId ?? partial.documentId,
      url: partial.target?.url ?? partial.url,
      ref: partial.target?.ref ?? partial.ref,
      name: partial.target?.name ?? partial.name
    }
  };
}

function ignoreModelClaims(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const { risk: _r, confidence: _c, intent: _i, safe: _s, ...rest } = input;
  return rest;
}

export function deriveRawEscape(mode, risk) {
  if (risk !== RISK_RAW) return 'n/a';
  return mode === 'full' ? 'allow' : 'deny';
}

export function decideAccess(mode, classified) {
  const risk = classified?.risk;
  const confidence = classified?.confidence;
  const effective = mode === 'full' ? 'full' : 'guarded';
  if (risk === RISK_PAYMENT && confidence === CONF_KNOWN) return 'deny';
  if (risk === RISK_DELETE && confidence === CONF_KNOWN) return 'approve';
  if (risk === RISK_RAW) return effective === 'full' ? 'auto' : 'deny';
  if ((confidence === CONF_AMBIGUOUS || confidence === CONF_UNKNOWN) && risk !== RISK_READ) {
    return effective === 'full' ? 'auto' : 'approve';
  }
  return 'auto';
}

export function policyErrorCode(decision, classified) {
  if (classified?.risk === RISK_PAYMENT && classified.confidence === CONF_KNOWN) return 'PAYMENT_DENIED';
  if (classified?.risk === RISK_RAW && decision === 'deny') return 'RAW_ESCAPE_DENIED';
  if (decision === 'deny') return 'POLICY_DENIED';
  return '';
}

function actionTargetUrl(input = {}) {
  return urlText(
    input.control?.frameUrl ||
      input.frameUrl ||
      input.control?.url ||
      input.target?.frameUrl ||
      input.url ||
      input.target?.url
  );
}

function classifyAction(input = {}) {
  const op = String(input.op || '').trim().toLowerCase();
  const name = controlName(input);
  const url = actionTargetUrl(input);
  const type = controlType(input);
  const role = controlRole(input);
  const key = String(input.key || '').toLowerCase();
  const hint = hints(input);
  const signals = [];
  const base = {
    tabId: input.tabId,
    frameId: input.frameId ?? input.control?.frameId,
    documentId: input.documentId,
    url,
    ref: input.ref || input.control?.ref,
    name
  };

  if (ACTION_READ.has(op) || !op) {
    const listen = op === 'listen';
    const record = op === 'record';
    return verdict({
      risk: RISK_READ,
      reason: record ? 'action:record' : listen ? 'action:listen' : op === 'wait' ? 'action:wait' : 'action:snapshot',
      summary: record ? '录制当前标签画面与声音' : listen ? '听取当前标签声音' : op === 'wait' ? '读取页面等待条件' : '读取页面快照',
      signals: record ? ['action-read', 'action-record'] : listen ? ['action-read', 'action-listen'] : ['action-read'],
      target: base
    });
  }

  if (paymentHost(url) && ACTION_MUTATE.has(op)) {
    return verdict({
      risk: RISK_PAYMENT,
      confidence: CONF_KNOWN,
      reason: 'url:payment-host',
      summary: `已知支付页上的 ${op}（${name || '未命名控件'}）`,
      signals: ['payment-host'],
      target: base
    });
  }

  const payHit = nameMatches(name, PAYMENT_NAMES);
  if (payHit) {
    return verdict({
      risk: RISK_PAYMENT,
      confidence: CONF_KNOWN,
      reason: `btn:${payHit}`,
      summary: `已知付款控件「${name}」`,
      signals: ['payment-name'],
      target: base
    });
  }

  const cartHit = nameMatches(name, CART_NAMES);
  if (cartHit) {
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: `btn:${cartHit}`,
      summary: `加入购物车 / 未到支付「${name}」`,
      signals: ['cart-not-payment'],
      target: base
    });
  }

  if (type === 'submit' && (looksCheckoutUrl(url) || hint.currency === true && hint.secrets === 'payment')) {
    signals.push(looksCheckoutUrl(url) ? 'url:checkout' : 'hints:payment');
    return verdict({
      risk: RISK_PAYMENT,
      confidence: CONF_KNOWN,
      reason: looksCheckoutUrl(url) ? 'url:checkout' : 'hints:payment',
      summary: `结账页提交「${name || 'submit'}」`,
      signals,
      target: base
    });
  }

  const delHit = nameMatches(name, DELETE_NAMES);
  if (delHit) {
    return verdict({
      risk: RISK_DELETE,
      confidence: CONF_KNOWN,
      reason: `btn:${delHit}`,
      summary: `已知删除控件「${name}」`,
      signals: ['delete-name'],
      target: base
    });
  }

  if ((/discard|destroy/i.test(name) && (role === 'button' || type === 'submit' || /danger|destructive/.test(String(input.control?.region || ''))))) {
    return verdict({
      risk: RISK_DELETE,
      confidence: CONF_KNOWN,
      reason: 'btn:discard',
      summary: `危险删除「${name}」`,
      signals: ['delete-danger'],
      target: base
    });
  }

  if (op === 'pointer') {
    const pointerMethod = String(input.method || '').toLowerCase();
    const cdp = pointerMethod === 'cdp';
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_UNKNOWN,
      reason: cdp ? 'action:pointer:cdp' : 'action:pointer:point',
      summary: cdp ? '视口坐标 CDP 鼠标' : '视口坐标脚本点击',
      signals: [cdp ? 'pointer-cdp' : 'pointer-point'],
      target: base
    });
  }

  if (op === 'upload') {
    const uploadMethod = String(input.uploadMethod || input.method || input.params?.method || 'auto').toLowerCase();
    if (uploadMethod === 'cdp') {
      return verdict({
        risk: RISK_RAW,
        confidence: CONF_KNOWN,
        effectConfidence: CONF_UNKNOWN,
        reason: 'action:upload:cdp',
        summary: '上传走显式 CDP（调试条）',
        signals: ['upload-cdp'],
        target: base
      });
    }
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: 'action:upload',
      summary: `上传文件到页面「${name || 'file input'}」`,
      signals: ['action-upload'],
      target: base
    });
  }

  if (ACTION_FILL.has(op)) {
    return verdict({
      risk: RISK_REVERSIBLE,
      reason: `action:${op}`,
      summary: op === 'scroll' ? '滚动页面' : `填写 / 选择「${name || '控件'}」`,
      signals: ['action-fill'],
      target: base
    });
  }

  const sendHit = nameMatches(name, SEND_NAMES);
  if (sendHit) {
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: `btn:${sendHit}`,
      summary: `发送 / 发布「${name}」`,
      signals: ['send-name'],
      target: base
    });
  }

  if (op === 'press') {
    const enter = key === 'enter' || key === 'return';
    if (enter && /textbox|searchbox|combobox|textarea|input/.test(role) && !payHit) {
      return verdict({
        risk: RISK_COMMIT,
        confidence: CONF_KNOWN,
        reason: 'press:composer',
        summary: `在输入框按 Enter（${name || 'composer'}）`,
        signals: ['press-composer'],
        target: base
      });
    }
    if (enter && !name) {
      return verdict({
        risk: RISK_COMMIT,
        confidence: CONF_UNKNOWN,
        reason: 'press:enter-unfocused',
        summary: '无焦点名的 Enter，可能提交表单',
        signals: ['press-unknown'],
        target: base
      });
    }
    if (enter && nameMatches(name, ['确认', 'ok', 'okay', '确定', '提交'])) {
      return verdict({
        risk: RISK_COMMIT,
        confidence: CONF_AMBIGUOUS,
        reason: 'press:confirm',
        summary: `看不清的确认「${name}」`,
        signals: ['press-confirm'],
        target: base
      });
    }
    return verdict({
      risk: RISK_REVERSIBLE,
      reason: `action:press:${key || 'key'}`,
      summary: `按键 ${input.key || ''}`.trim(),
      signals: ['action-press'],
      target: base
    });
  }

  if (op === 'click' || op === 'fill_form') {
    if (!name) {
      return verdict({
        risk: RISK_COMMIT,
        confidence: CONF_UNKNOWN,
        reason: 'click:unnamed',
        summary: '未命名按钮点击',
        signals: ['click-unknown'],
        target: base
      });
    }
    if (nameMatches(name, ['确认', 'ok', 'okay', '确定', '提交', 'confirm'])) {
      return verdict({
        risk: RISK_COMMIT,
        confidence: CONF_AMBIGUOUS,
        reason: 'btn:confirm',
        summary: `看不清的确认「${name}」`,
        signals: ['click-confirm'],
        target: base
      });
    }
    return verdict({
      risk: RISK_REVERSIBLE,
      reason: `action:${op}`,
      summary: `点击「${name}」`,
      signals: ['click-named'],
      target: base
    });
  }

  return verdict({
    risk: RISK_COMMIT,
    confidence: CONF_UNKNOWN,
    reason: `action:${op || 'unknown'}`,
    summary: '未识别的页面操作',
    signals: ['action-unknown'],
    target: base
  });
}

function classifyFetch(input = {}) {
  const method = String(input.method || input.init?.method || 'GET').toUpperCase();
  const url = urlText(input.url);
  const body = String(input.bodyText || input.init?.body || '');
  const hay = `${url} ${body}`.slice(0, 4000);
  if (['GET', 'HEAD'].includes(method)) {
    return verdict({
      risk: RISK_READ,
      reason: `sys:fetch:${method}`,
      summary: `${method} ${url || ''}`.trim(),
      signals: ['fetch-read'],
      url
    });
  }
  if (nameMatches(hay, PAYMENT_NAMES) || looksCheckoutUrl(url)) {
    return verdict({
      risk: RISK_PAYMENT,
      confidence: CONF_KNOWN,
      reason: looksCheckoutUrl(url) ? 'url:checkout' : 'body:payment',
      summary: `已知付款网络请求 ${method}`,
      signals: ['fetch-payment'],
      url
    });
  }
  if (nameMatches(hay, DELETE_NAMES) || /\/delete|\/remove|\/destroy|\/trash/i.test(url)) {
    return verdict({
      risk: RISK_DELETE,
      confidence: CONF_KNOWN,
      reason: 'sys:fetch:delete',
      summary: `删除向网络请求 ${method}`,
      signals: ['fetch-delete'],
      url
    });
  }
  return verdict({
    risk: RISK_COMMIT,
    confidence: CONF_KNOWN,
    reason: `sys:fetch:${method}`,
    summary: `${method} ${url || ''}`.trim(),
    signals: ['fetch-write'],
    url
  });
}

function classifyCdp(input = {}) {
  const action = String(input.action || (input.method ? 'send' : '')).toLowerCase();
  const method = String(input.method || '');
  if (action === 'events' || action === 'targets' || action === 'detach') {
    return verdict({
      risk: RISK_READ,
      reason: `sys:cdp:${action}`,
      summary: `CDP ${action}`,
      signals: ['cdp-read']
    });
  }
  if (method === 'Page.navigate' || method === 'Page.reload') {
    return verdict({
      risk: RISK_READ,
      reason: 'nav',
      summary: `导航 ${method}`,
      signals: ['cdp-nav']
    });
  }
  if (method === 'Debugger.getScriptSource') {
    return verdict({
      risk: RISK_RAW,
      confidence: CONF_KNOWN,
      effectConfidence: CONF_UNKNOWN,
      reason: 'sys:cdp:source',
      summary: 'CDP 读取脚本源码（按 raw 处理）',
      signals: ['cdp-source']
    });
  }
  if (CDP_READ_METHODS.includes(method) && method !== 'Runtime.evaluate') {
    return verdict({
      risk: RISK_READ,
      reason: `sys:cdp:${method}`,
      summary: `CDP 只读 ${method}`,
      signals: ['cdp-read-method']
    });
  }
  return verdict({
    risk: RISK_RAW,
    confidence: CONF_KNOWN,
    effectConfidence: CONF_UNKNOWN,
    reason: method ? `sys:cdp:${method}` : `sys:cdp:${action || 'send'}`,
    summary: method ? `可变 CDP ${method}` : '可变 CDP',
    signals: ['cdp-raw']
  });
}

function classifySys(input = {}) {
  const op = String(input.sysOp || input.op || '').trim();
  const url = urlText(input.url);
  if (SYS_READ.has(op)) {
    return verdict({
      risk: RISK_READ,
      reason: `sys:${op}`,
      summary: `读取 ${op}`,
      signals: ['sys-read'],
      url
    });
  }
  if (SYS_NAV.has(op)) {
    return verdict({
      risk: RISK_READ,
      reason: 'nav',
      summary: op === 'tabs.open' ? `打开 ${url || '标签'}` : `导航 ${op}`,
      signals: ['sys-nav'],
      url
    });
  }
  if (op === 'tabs.focus') {
    return verdict({
      risk: RISK_REVERSIBLE,
      reason: 'sys:tabs.focus',
      summary: '切换标签焦点',
      signals: ['sys-focus']
    });
  }
  if (op === 'tabs.close') {
    return verdict({
      risk: RISK_DELETE,
      confidence: CONF_KNOWN,
      reason: 'sys:tabs.close',
      summary: '关闭标签',
      signals: ['sys-close']
    });
  }
  if (op === 'upload') {
    if (paymentHost(url)) {
      return verdict({
        risk: RISK_PAYMENT,
        confidence: CONF_KNOWN,
        reason: 'url:payment-host',
        summary: `已知支付页上的 upload`,
        signals: ['payment-host', 'sys-upload'],
        url
      });
    }
    const uploadMethod = String(input.uploadMethod || input.method || input.params?.method || 'auto').toLowerCase();
    if (uploadMethod === 'cdp') {
      return verdict({
        risk: RISK_RAW,
        confidence: CONF_KNOWN,
        effectConfidence: CONF_UNKNOWN,
        reason: 'sys:upload:cdp',
        summary: 'sys.upload 显式 CDP（调试条）',
        signals: ['upload-cdp'],
        url
      });
    }
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: 'sys:upload',
      summary: `上传 ${input.path || input.filename || 'file'}`.trim(),
      signals: ['sys-upload'],
      url
    });
  }
  if (op === 'download') {
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: 'sys:download',
      summary: `下载 ${url || input.filename || ''}`.trim(),
      signals: ['sys-download'],
      url
    });
  }
  if (op === 'fetch') return classifyFetch(input);
  if (op === 'eval') {
    return verdict({
      risk: RISK_RAW,
      confidence: CONF_KNOWN,
      effectConfidence: CONF_UNKNOWN,
      reason: 'sys:eval',
      summary: '页面脚本 sys.eval',
      signals: ['sys-eval']
    });
  }
  if (op === 'waitFor') {
    if (input.code != null && String(input.code).trim()) {
      return verdict({
        risk: RISK_RAW,
        confidence: CONF_KNOWN,
        effectConfidence: CONF_UNKNOWN,
        reason: 'sys:waitFor:code',
        summary: 'waitFor 代码谓词（可有副作用）',
        signals: ['sys-wait-code']
      });
    }
    return verdict({
      risk: RISK_READ,
      reason: 'sys:waitFor',
      summary: '等待选择器或文本',
      signals: ['sys-wait']
    });
  }
  if (op === 'cdp') return classifyCdp(input);
  return verdict({
    risk: RISK_COMMIT,
    confidence: CONF_UNKNOWN,
    reason: `sys:${op || 'unknown'}`,
    summary: `未识别 sys ${op}`,
    signals: ['sys-unknown']
  });
}

function classifyArtifact(input = {}) {
  return verdict({
    risk: RISK_REVERSIBLE,
    reason: 'artifact:save',
    summary: `保存文件 ${input.artifactId || ''}`.trim(),
    signals: ['artifact-save'],
    target: { artifactId: input.artifactId }
  });
}

export function classifyRisk(raw = {}) {
  const input = ignoreModelClaims(raw);
  const channel = String(input.channel || (input.sysOp || input.sys?.op ? 'sys' : input.artifactId ? 'artifact' : 'action'));
  if (channel === 'sys') return classifySys({ ...input, sysOp: input.sysOp || input.op, op: input.sysOp || input.op });
  if (channel === 'artifact' || channel === 'download' && input.artifactId) return classifyArtifact(input);
  if (channel === 'download') {
    return verdict({
      risk: RISK_COMMIT,
      confidence: CONF_KNOWN,
      reason: 'sys:download',
      summary: '下载文件',
      signals: ['download']
    });
  }
  return classifyAction(input);
}

export const CLASSIFIED_SOURCE_SW = 'sw-resolve-intent';

const RISK_RANK = Object.freeze({
  [RISK_READ]: 0,
  [RISK_REVERSIBLE]: 1,
  [RISK_COMMIT]: 2,
  [RISK_RAW]: 3,
  [RISK_DELETE]: 4,
  [RISK_PAYMENT]: 5
});

export function riskRank(risk) {
  return RISK_RANK[String(risk || '')] ?? 0;
}

/** Highest-risk frame wins. One verdict for the whole batch; never first-field-only. */
export function mergeBatchClassification(items = [], frames = []) {
  const list = (Array.isArray(items) ? items : []).filter((row) => row && row.risk);
  if (!list.length) {
    return {
      risk: RISK_COMMIT,
      confidence: CONF_UNKNOWN,
      reason: 'batch:empty',
      summary: '无法分类的批量填写',
      signals: ['batch-empty'],
      source: CLASSIFIED_SOURCE_SW,
      target: { frames: [] }
    };
  }
  let top = list[0];
  for (const item of list) {
    const rank = riskRank(item.risk);
    const topRank = riskRank(top.risk);
    if (rank > topRank) top = item;
    else if (rank === topRank && item.confidence === CONF_KNOWN && top.confidence !== CONF_KNOWN) top = item;
  }
  const uniqueFrames = [];
  const seen = new Set();
  for (const frame of Array.isArray(frames) ? frames : []) {
    const key = `${frame.frameId ?? ''}::${frame.frameUrl || frame.control?.frameUrl || ''}::${frame.documentId || frame.control?.documentId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFrames.push({
      frameId: frame.frameId ?? frame.control?.frameId ?? null,
      frameUrl: frame.frameUrl || frame.control?.frameUrl || '',
      documentId: frame.documentId || frame.control?.documentId || '',
      risk: frame.classified?.risk || '',
      confidence: frame.classified?.confidence || '',
      name: frame.control?.name || frame.name || ''
    });
  }
  return {
    ...top,
    source: CLASSIFIED_SOURCE_SW,
    reason: uniqueFrames.length > 1 ? `batch:${top.reason}` : top.reason,
    summary: uniqueFrames.length > 1
      ? `${top.summary}（${uniqueFrames.length} 个 frame，最高风险 ${top.risk}）`
      : top.summary,
    signals: [...new Set(['batch', ...(top.signals || []), ...list.flatMap((row) => row.signals || [])])],
    target: {
      ...(top.target || {}),
      frames: uniqueFrames
    }
  };
}

export function adoptTrustedClassified(candidate, fallbackInput) {
  if (candidate && candidate.risk && candidate.source === CLASSIFIED_SOURCE_SW) return candidate;
  return classifyRisk(fallbackInput || {});
}

export function needsDispatchTicket(classified) {
  return classified?.risk && classified.risk !== RISK_READ;
}

/** Fields a ticket must bind. Omit only when the op has no such identity. */
export function ticketBindingFields(input = {}) {
  const channel = String(input.channel || (input.sysOp || input.sys?.op ? 'sys' : 'action'));
  const op = String(input.sysOp || input.op || '');
  const pageFetch = op === 'fetch' && String(input.as || input.params?.as || '') === 'page';
  const fields = {
    sessionId: true,
    executionId: true,
    payloadHash: true,
    nonce: true,
    tabId: false,
    documentId: false
  };
  if (channel === 'action') {
    fields.tabId = true;
    const batch = Number(input.batchSize) > 1
      || (Array.isArray(input.frames) && input.frames.length > 1)
      || (Array.isArray(input.target?.frames) && input.target.frames.length > 1);
    fields.documentId = !batch;
    return fields;
  }
  if (op === 'eval' || op === 'waitFor' || pageFetch) {
    fields.tabId = true;
    fields.documentId = !!String(input.params?.documentId || '');
    return fields;
  }
  if (op === 'upload') {
    fields.tabId = true;
    fields.documentId = !!String(input.documentId || input.params?.documentId || '');
    return fields;
  }
  if (['tabs.close', 'tabs.focus', 'tabs.navigate', 'tabs.reload', 'cdp', 'screenshot'].includes(op)) {
    fields.tabId = true;
  }
  return fields;
}

export function hostDecisionSummary(classified) {
  return String(classified?.summary || classified?.reason || classified?.risk || '');
}
