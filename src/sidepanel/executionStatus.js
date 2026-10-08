/**
 * Pure reducer for Bot-visible run status and the compact action summary.
 * Host / tool facts only. Thought, reasoning, and streamed model prose never
 * become current / next. The one exception to "no prose in the summary" is
 * `progress-note`: commentary from a step that ended in tool calls, kept as a
 * `kind: 'note'` timeline row between activity rows. It never sets current.
 */

import { ACTIVITY_ICONS } from './icons.js';

const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);
const PROMINENT_TASK = new Set(['ready', 'running', 'waiting', 'paused']);
const NARRATIVE = new Set(['thought', 'thought-open', 'text', 'reasoning']);
const SUMMARY_CAP = 24;
const NOTE_CAP = 60;
const NOTE_TEXT_CAP = 600;
const NAME_CAP = 48;

function text(value, cap = 240) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

function zh(lang) {
  return String(lang || 'zh').toLowerCase().startsWith('zh');
}

function toolName(ev) {
  return text(ev?.name || ev?.tool || ev?.toolName, 40);
}

function toolArgs(ev) {
  const raw = ev?.args ?? ev?.input ?? {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function toolResult(ev) {
  const raw = ev?.result ?? ev?.output ?? {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function resultCode(ev, result = toolResult(ev)) {
  return text(ev?.code || result.code || ev?.result?.code, 64);
}

export function waitingNext(lang = 'zh') {
  return {
    text: zh(lang) ? '等待模型决定' : 'Waiting for the model',
    source: 'none'
  };
}

export function undeclaredNext(lang = 'zh') {
  return {
    text: zh(lang) ? '下一步尚未声明' : 'Next step not declared',
    source: 'none'
  };
}

export function formatAimingText(count, lang = 'zh') {
  const n = Math.max(0, Number(count) || 0);
  if (zh(lang)) return n > 0 ? `全页可访问 · 已瞄准 ${n} 项` : '全页可访问';
  return n > 0 ? `Full page accessible · ${n} item${n === 1 ? '' : 's'} aimed` : 'Full page accessible';
}

export function countAimedItems({ groups = [], boundIds = [], mentions = [], selectedCount = 0 } = {}) {
  const bound = new Set((boundIds || []).map((id) => String(id)));
  let n = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!bound.has(String(g.groupId || g.id || ''))) continue;
    if (Array.isArray(g.items)) n += g.items.length;
    else n += Number(g.itemCount) || 0;
  }
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (!m || (m.kind !== 'item' && m.kind !== 'page')) continue;
    n += 1;
  }
  if (!n && Number(selectedCount) > 0) n = Number(selectedCount);
  return n;
}

export function nextFromTask(task) {
  if (!task || typeof task !== 'object') return null;
  const nextAction = text(task.nextAction, 200);
  if (nextAction) return { text: nextAction, source: 'task.nextAction' };
  return null;
}

export function compactStatusTask(task) {
  if (!task || typeof task !== 'object' || !text(task.taskId || task.originalGoal)) return null;
  const status = text(task.status).toLowerCase() || 'ready';
  return {
    taskId: text(task.taskId, 160),
    status,
    originalGoal: text(task.originalGoal, 200),
    nextAction: text(task.nextAction, 200),
    dueAt: text(task.dueAt, 80),
    summary: text(task.summary, 200),
    prominent: PROMINENT_TASK.has(status),
    terminal: TERMINAL_TASK.has(status)
  };
}

export function shouldShowDurableTaskCard(task) {
  const compact = compactStatusTask(task);
  return !!(compact && compact.prominent);
}

function firstNamed(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstNamed(item);
      if (hit) return hit;
    }
    return '';
  }
  if (typeof value === 'object') {
    return value.name || value.path || value.title || value.filename || value.file || '';
  }
  return '';
}

function firstFileKey(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return '';
  const keys = Object.keys(files);
  return keys[0] || '';
}

function objectName(args, result) {
  const raw =
    args?.name ||
    args?.path ||
    args?.title ||
    args?.filename ||
    args?.file ||
    args?.entry ||
    args?.entryFile ||
    result?.name ||
    result?.path ||
    result?.title ||
    result?.filename ||
    args?.artifactId ||
    result?.artifactId ||
    firstNamed(result?.artifacts) ||
    firstNamed(result?.writtenFiles) ||
    firstNamed(result?.written) ||
    firstNamed(result?.files) ||
    firstFileKey(args?.files) ||
    '';
  const s = text(raw, NAME_CAP);
  if (!s) return '';
  const base = s.split('/').filter(Boolean).pop() || s;
  return text(base, NAME_CAP);
}

function pair(running, done) {
  return { running, done };
}

function runBrief(op, object, isZh) {
  if (object) {
    return isZh ? pair(`正在写 ${object}`, `已写 ${object}`) : pair(`Writing ${object}`, `Wrote ${object}`);
  }
  if (op === 'write_artifact' || op === 'update_artifact' || op === 'write_package_file' || op === 'persist') {
    return isZh ? pair('正在写入文件', '已写入文件') : pair('Writing a file', 'Wrote a file');
  }
  if (op === 'write_scratch') {
    return isZh ? pair('正在写临时文件', '已写临时文件') : pair('Writing a scratch file', 'Wrote a scratch file');
  }
  if (op === 'sheet' || op === 'createWorkbook') {
    return isZh ? pair('正在登记表格', '已登记表格') : pair('Registering a sheet', 'Registered a sheet');
  }
  if (op === 'doc' || op === 'createDocument') {
    return isZh ? pair('正在登记文档', '已登记文档') : pair('Registering a document', 'Registered a document');
  }
  if (op === 'html' || op === 'site') {
    return isZh ? pair('正在登记网站', '已登记网站') : pair('Registering a site', 'Registered a site');
  }
  if (op === 'ingestPdf') {
    return isZh ? pair('正在导入 PDF', '已导入 PDF') : pair('Ingesting a PDF', 'Ingested a PDF');
  }
  if (op === 'skill') {
    return isZh ? pair('正在处理 skill', '已处理 skill') : pair('Handling a skill', 'Handled a skill');
  }
  if (op === 'shelf') {
    return isZh ? pair('正在整理货架', '已整理货架') : pair('Updating the shelf', 'Updated the shelf');
  }
  if (op === 'read') {
    return isZh ? pair('正在读取访客文件', '已读取访客文件') : pair('Reading a guest file', 'Read a guest file');
  }
  return isZh ? pair('正在运行访客代码', '已运行访客代码') : pair('Running guest code', 'Ran guest code');
}

export function settleToolCurrent(current, lang = 'zh', ok = true) {
  if (!current) return null;
  if (ok) {
    return { ...current, text: current.doneText || current.text, status: 'success' };
  }
  const isZh = zh(lang);
  const fail = isZh
    ? current.object
      ? `未能完成 ${current.object}`
      : String(current.text || '').replace(/^正在/, '未能') || '未成功'
    : current.object
      ? `Failed: ${current.object}`
      : `Failed: ${current.text || 'tool'}`;
  return { ...current, text: text(fail, 160), status: 'error' };
}

export function currentFromToolCall(name, args = {}, lang = 'zh') {
  const isZh = zh(lang);
  const object = objectName(args, {});
  const op = text(args.op || args.act || args.action, 40);
  const view = text(args.view, 40);
  let running = '';
  let done = '';
  if (name === 'action') {
    if (op === 'click') {
      running = isZh ? `正在点击${object ? ` ${object}` : ''}` : `Clicking${object ? ` ${object}` : ''}`;
      done = isZh ? `已点击${object ? ` ${object}` : ''}` : `Clicked${object ? ` ${object}` : ''}`;
    } else if (op === 'fill' || op === 'fill_form') {
      running = isZh ? `正在填写${object ? ` ${object}` : ''}` : `Filling${object ? ` ${object}` : ''}`;
      done = isZh ? `已填写${object ? ` ${object}` : ''}` : `Filled${object ? ` ${object}` : ''}`;
    } else if (op === 'select') {
      running = isZh ? `正在选择${object ? ` ${object}` : ''}` : `Selecting${object ? ` ${object}` : ''}`;
      done = isZh ? `已选择${object ? ` ${object}` : ''}` : `Selected${object ? ` ${object}` : ''}`;
    } else if (op === 'press') {
      const key = args.key ? ` ${text(args.key, 16)}` : '';
      running = isZh ? `正在按键${key}` : `Pressing${key}`;
      done = isZh ? `已按键${key}` : `Pressed${key}`;
    } else if (op === 'scroll') {
      running = isZh ? '正在滚动页面' : 'Scrolling the page';
      done = isZh ? '已滚动页面' : 'Scrolled the page';
    } else if (op === 'wait') {
      running = isZh ? '正在等待页面' : 'Waiting on the page';
      done = isZh ? '已等待页面' : 'Waited on the page';
    } else if (op === 'snapshot') {
      running = isZh ? '正在读取当前标签' : 'Reading the current tab';
      done = isZh ? '已读取当前标签' : 'Read the current tab';
    } else if (op === 'upload') {
      running = isZh ? '正在上传文件' : 'Uploading a file';
      done = isZh ? '已上传文件' : 'Uploaded a file';
    } else {
      running = isZh ? '正在操作页面' : 'Acting on the page';
      done = isZh ? '已操作页面' : 'Acted on the page';
    }
  } else if (name === 'run') {
    const labels = runBrief(op, object, isZh);
    running = labels.running;
    done = labels.done;
  } else if (name === 'inspect') {
    if (view === 'sys') {
      running = isZh ? '正在查阅 sys 目录' : 'Reading the sys catalog';
      done = isZh ? '已查阅 sys 目录' : 'Read the sys catalog';
    } else if (view === 'html') {
      running = isZh ? '正在读取页面 HTML' : 'Reading page HTML';
      done = isZh ? '已读取页面 HTML' : 'Read page HTML';
    } else if (view === 'artifacts' || view === 'files') {
      running = isZh ? '正在查看文件' : 'Looking at files';
      done = isZh ? '已查看文件' : 'Looked at files';
    } else if (view === 'skill' || view === 'skills') {
      running = isZh ? '正在查阅做法' : 'Reading a playbook';
      done = isZh ? '已查阅做法' : 'Read a playbook';
    } else {
      running = isZh ? '正在读取会话内容' : 'Reading session context';
      done = isZh ? '已读取会话内容' : 'Read session context';
    }
  } else if (name === 'acquire') {
    if (op === 'search' || args.action === 'search') {
      running = isZh ? '正在检索公开网' : 'Searching the public web';
      done = isZh ? '已检索公开网' : 'Searched the public web';
    } else if (op === 'fetch' || args.action === 'fetch') {
      running = isZh ? '正在获取文件' : 'Fetching a file';
      done = isZh ? '已获取文件' : 'Fetched a file';
    } else if (args.action === 'image') {
      running = isZh ? '正在生成图片' : 'Generating an image';
      done = isZh ? '已生成图片' : 'Generated an image';
    } else {
      running = isZh ? '正在获取内容' : 'Acquiring content';
      done = isZh ? '已获取内容' : 'Acquired content';
    }
  } else if (name === 'web') {
    running = op === 'read' ? (isZh ? '正在读取网站' : 'Reading the site') : isZh ? '正在写网站' : 'Writing the site';
    done = op === 'read' ? (isZh ? '已读取网站' : 'Read the site') : isZh ? '已写网站' : 'Wrote the site';
  } else if (name === 'sheet') {
    running = op === 'read' ? (isZh ? '正在读取表格' : 'Reading the sheet') : isZh ? '正在写表格' : 'Writing the sheet';
    done = op === 'read' ? (isZh ? '已读取表格' : 'Read the sheet') : isZh ? '已写表格' : 'Wrote the sheet';
  } else if (name === 'doc') {
    running = op === 'read' ? (isZh ? '正在读取文档' : 'Reading the document') : isZh ? '正在写文档' : 'Writing the document';
    done = op === 'read' ? (isZh ? '已读取文档' : 'Read the document') : isZh ? '已写文档' : 'Wrote the document';
  } else if (name === 'task') {
    if (op === 'wait') {
      running = isZh ? '正在登记等待' : 'Scheduling a wait';
      done = isZh ? '已登记等待' : 'Scheduled a wait';
    } else if (op === 'complete') {
      running = isZh ? '正在完成任务' : 'Completing the task';
      done = isZh ? '已完成任务' : 'Completed the task';
    } else if (op === 'schedule') {
      running = isZh ? '正在安排定时任务' : 'Scheduling a task';
      done = isZh ? '已安排定时任务' : 'Scheduled a task';
    } else if (op === 'plan' || op === 'checkpoint') {
      running = isZh ? '正在更新任务进度' : 'Updating task progress';
      done = isZh ? '已更新任务进度' : 'Updated task progress';
    } else {
      running = isZh ? '正在查看任务' : 'Inspecting the task';
      done = isZh ? '已查看任务' : 'Inspected the task';
    }
  } else if (name === 'clarify') {
    running = isZh ? '正在询问用户' : 'Asking the user';
    done = isZh ? '已询问用户' : 'Asked the user';
  } else {
    running = isZh ? `正在调用 ${name || '工具'}` : `Calling ${name || 'tool'}`;
    done = isZh ? `已调用 ${name || '工具'}` : `Called ${name || 'tool'}`;
  }
  return {
    text: text(running, 160),
    doneText: text(done, 160),
    object,
    source: 'tool-call',
    tool: name,
    op,
    view,
    status: 'running'
  };
}

const PAGE_READ_TEXT = /读取当前标签|已读取当前标签|Reading the current tab|Read the current tab/;

/** Snapshot / tab HTML peek — status noise, not the live action brief. */
export function isPageReadStatus(current) {
  if (!current || typeof current !== 'object') return false;
  if (current.tool === 'action' && current.op === 'snapshot') return true;
  if (current.tool === 'inspect' && current.view === 'html') return true;
  return PAGE_READ_TEXT.test(String(current.text || current.doneText || ''));
}

function rememberLiveAction(state) {
  if (!state || typeof state !== 'object') return state;
  const cur = state.current;
  if (cur?.text && !isPageReadStatus(cur) && (cur.source === 'host' || cur.status === 'running')) {
    if (state.lastLiveAction === cur.text) return state;
    return { ...state, lastLiveAction: cur.text };
  }
  return state;
}

/**
 * One-line live 摘要: last host-fact current action.
 * Persists between tool hops (page-read / settled success do not blank it).
 * Never next, lease, policy, page-read, or 「成功 页面·…」 rows.
 */
export function liveActionBrief(state) {
  const current = state?.current;
  if (current?.source === 'host' && current.text) return current.text;
  if (current?.text && !isPageReadStatus(current) && current.status === 'running') return current.text;
  if (disclosureMode(state) === 'sticky' && current?.text && !isPageReadStatus(current)) {
    return current.text;
  }
  const remembered = text(state?.lastLiveAction, 160);
  if (remembered && disclosureMode(state) !== 'hidden') return remembered;
  return '';
}

/** Keep the last painted sentence when the reducer has a page-read / gap hop. */
export function persistLiveActionBrief(state, lastPainted = '') {
  return liveActionBrief(state) || text(lastPainted, 160);
}

function summaryKind(name, args) {
  if (name === 'action') return 'action';
  if (name === 'web') return 'web';
  if (name === 'sheet') return 'sheet';
  if (name === 'doc') return 'doc';
  if (name === 'task') return 'task';
  if (name === 'clarify') return 'wait';
  if (name === 'run') {
    const op = text(args.op || args.act, 40);
    if (
      op === 'write_artifact' ||
      op === 'update_artifact' ||
      op === 'write_package_file' ||
      op === 'persist' ||
      op === 'write_scratch'
    ) {
      return 'write';
    }
    return 'run';
  }
  if ((name === 'sheet' || name === 'doc' || name === 'web') && text(args.act || args.op) === 'write') {
    return 'write';
  }
  if (name === 'acquire' && (args.action === 'image' || args.op === 'image')) return 'write';
  if (name === 'inspect' || name === 'acquire') return 'read';
  return 'read';
}

function summaryLabel(kind, current, lang) {
  if (current?.text) return current.text.replace(/^正在/, '').trim() || current.text;
  const isZh = zh(lang);
  if (kind === 'page') return isZh ? '页面操作' : 'Page action';
  if (kind === 'write') return isZh ? '写入文件' : 'Write file';
  if (kind === 'wait') return isZh ? '等待 / 任务' : 'Wait / task';
  return isZh ? '读取 / 外网' : 'Read / network';
}

export function isNoteRow(row) {
  return row?.kind === 'note';
}

/** Activity rows cap at SUMMARY_CAP; notes are capped separately and kept. */
function pushSummary(summary, row) {
  const next = Array.isArray(summary) ? summary.slice() : [];
  next.push(row);
  const notes = next.filter(isNoteRow).length;
  const acts = next.length - notes;
  let dropActs = Math.max(0, acts - SUMMARY_CAP);
  let dropNotes = Math.max(0, notes - NOTE_CAP);
  if (!dropActs && !dropNotes) return next;
  return next.filter((r) => {
    if (isNoteRow(r) ? dropNotes > 0 && dropNotes-- : dropActs > 0 && dropActs--) return false;
    return true;
  });
}

function noteText(value) {
  const t = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > NOTE_TEXT_CAP ? `${t.slice(0, NOTE_TEXT_CAP).trimEnd()}…` : t;
}

export function progressNoteRowId(ev = {}) {
  return `note-${Math.max(0, Number(ev.stepIndex) || 0)}-${Math.max(0, Number(ev.toolIndex) || 0)}`;
}

function markRecovered(summary, code) {
  const next = Array.isArray(summary) ? summary.slice() : [];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].code === code && (next[i].status === 'error' || next[i].status === 'failed')) {
      next[i] = { ...next[i], status: 'recovered' };
      break;
    }
  }
  return next;
}

export function createExecutionStatus(seed = {}) {
  return {
    phase: 'idle',
    current: null,
    next: null,
    targetPage: seed.targetPage || null,
    aiming: { pageAccess: true, count: Math.max(0, Number(seed.aimedCount) || 0) },
    lease: null,
    task: null,
    summary: [],
    executionId: null,
    sessionId: text(seed.sessionId, 80),
    pendingTools: 0,
    activeTools: [],
    clarifyOpen: false,
    approvalOpen: false,
    policyBlocked: null,
    aborted: false,
    startedAt: 0,
    endedAt: 0,
    artifactCount: 0,
    noteCount: 0,
    lastLiveAction: text(seed.lastLiveAction, 160)
  };
}

function cloneActive(list) {
  return Array.isArray(list) ? list.map((row) => ({ ...row, current: row.current ? { ...row.current } : null })) : [];
}

function currentFromActive(active) {
  if (!active.length) return null;
  return active[active.length - 1].current || null;
}

const RUN_REGISTER_OPS = new Set([
  'write_artifact',
  'update_artifact',
  'write_package_file',
  'persist',
  'sheet',
  'createWorkbook',
  'doc',
  'createDocument',
  'html',
  'site',
  'ingestPdf'
]);

function resultHasArtifact(result) {
  if (!result || typeof result !== 'object') return false;
  if (text(result.artifactId, 80)) return true;
  if (result.registered === true) return true;
  if (Array.isArray(result.artifacts) && result.artifacts.length > 0) return true;
  return false;
}

/**
 * Session artifacts only (sheet/doc/web/files/media).
 * `run` / inspect / page-read are tool activity, not deliverables.
 */
export function countsDeliverable(name, args = {}, result = {}) {
  const tool = text(name, 40);
  if (!tool) return false;
  if (tool === 'inspect' || tool === 'action' || tool === 'clarify' || tool === 'task') return false;
  const op = text(args.op || args.act || args.action, 40);
  const view = text(args.view, 40);
  if (isPageReadStatus({ tool, op, view, text: '' })) return false;
  if (resultHasArtifact(result)) return true;
  if (tool === 'acquire' && (args.action === 'image' || args.op === 'image')) return true;
  if (tool === 'run') {
    if (op === 'write_scratch' || op === 'read' || op === 'skill' || op === 'shelf') return false;
    return RUN_REGISTER_OPS.has(op);
  }
  if ((tool === 'sheet' || tool === 'doc' || tool === 'web') && op === 'write') return true;
  return false;
}

function callId(ev, fallback = '') {
  return text(ev?.toolCallId || ev?.id, 80) || fallback;
}

function resolveNext(state, _lang, extras = {}) {
  if (extras.next?.source === 'task.nextAction' && extras.next.text) return extras.next;
  return nextFromTask(state.task);
}

function applyLease(state, ev) {
  const result = toolResult(ev);
  const code = resultCode(ev, result);
  const op = text(ev.op || ev.kind || ev.leaseOp, 24);
  if (op === 'release' || op === 'clear' || ev.clearLease === true) {
    return { ...state, lease: null };
  }
  if (op === 'acquire' || op === 'owned') {
    return {
      ...state,
      lease: {
        kind: 'owned',
        tabId: ev.tabId ?? result.tabId ?? state.lease?.tabId ?? '',
        title: text(ev.title || result.title, 120),
        holderSessionId: ''
      }
    };
  }
  if (code === 'TAB_LEASED' || op === 'conflict') {
    return {
      ...state,
      lease: {
        kind: 'conflict',
        code: 'TAB_LEASED',
        tabId: ev.tabId ?? result.tabId ?? '',
        title: text(ev.title || result.title, 120),
        holderSessionId: text(ev.holderSessionId || result.holderSessionId, 80)
      }
    };
  }
  return state;
}

function applyTask(state, task, lang) {
  const compact = compactStatusTask(task);
  let phase = state.phase;
  if (compact?.status === 'waiting' && phase !== 'running') phase = 'waiting_timer';
  else if (compact?.status === 'paused' && phase !== 'running') phase = 'paused';
  else if (compact?.status === 'completed' && phase === 'idle') phase = 'completed';
  return {
    ...state,
    task: compact,
    next: nextFromTask(compact),
    phase
  };
}

/**
 * @param {ReturnType<typeof createExecutionStatus>} state
 * @param {object} ev
 * @param {{ lang?: string, aimedCount?: number, targetPage?: object|null, task?: object|null }} [ctx]
 */
export function applyExecutionStatus(state, ev, ctx = {}) {
  return rememberLiveAction(reduceExecutionStatus(state, ev, ctx));
}

function reduceExecutionStatus(state, ev, ctx = {}) {
  const lang = ctx.lang || 'zh';
  const prev = state && typeof state === 'object' ? state : createExecutionStatus({ lang });
  let next = {
    ...prev,
    summary: Array.isArray(prev.summary) ? prev.summary.slice() : [],
    activeTools: cloneActive(prev.activeTools),
    aiming: {
      pageAccess: true,
      count: ctx.aimedCount != null ? Math.max(0, Number(ctx.aimedCount) || 0) : prev.aiming?.count || 0
    },
    targetPage: ctx.targetPage !== undefined ? ctx.targetPage : prev.targetPage
  };
  if (ctx.task !== undefined) next = applyTask(next, ctx.task, lang);

  const type = text(ev?.type);
  if (!type || NARRATIVE.has(type)) {
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'aiming') {
    next.aiming.count = Math.max(0, Number(ev.count ?? ctx.aimedCount) || 0);
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'page' || type === 'target-page') {
    const page = ev.page || ev.targetPage || ev;
    next.targetPage =
      page && (page.title || page.url)
        ? { title: text(page.title, 80), url: text(page.url, 200) }
        : null;
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'lease' || type === 'tab-lease') {
    next = applyLease(next, ev);
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'clear-lease') {
    next.lease = null;
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'task-updated' || type === 'task-lifecycle' || type === 'task-schedule-changed') {
    const task = ev.task || ctx.task || next.task;
    if (type === 'task-lifecycle' && text(ev.nextAction) && !nextFromTask(task)) {
      next.next = { text: text(ev.nextAction, 200), source: 'task.nextAction' };
    }
    next = applyTask(next, task, lang);
    if (text(ev.op) === 'wait' && ev.ok !== false) next.phase = next.phase === 'running' ? 'running' : 'waiting_timer';
    if (text(ev.op) === 'complete' && ev.ok === true) {
      next.phase = next.pendingTools > 0 ? next.phase : 'completed';
    }
    return next;
  }

  if (type === 'execution-start') {
    next.phase = 'running';
    next.aborted = false;
    next.clarifyOpen = false;
    next.approvalOpen = false;
    next.policyBlocked = null;
    next.pendingTools = 0;
    next.activeTools = [];
    next.current = null;
    next.lastLiveAction = '';
    next.summary = [];
    next.artifactCount = 0;
    next.noteCount = 0;
    next.startedAt = Number(ev.startedAt) || Date.now();
    next.endedAt = 0;
    next.executionId = text(ev.executionId, 80) || next.executionId;
    next.sessionId = text(ev.sessionId, 80) || next.sessionId;
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'abort') {
    next.aborted = ev.matched !== false && ev.aborted !== false;
    if (next.aborted) {
      next.phase = 'stopped';
      next.current = null;
      next.pendingTools = 0;
      next.activeTools = [];
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'clarify') {
    next.clarifyOpen = true;
    next.phase = 'waiting_user';
    next.current = currentFromToolCall('clarify', {}, lang);
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'clarify-done') {
    next.clarifyOpen = false;
    next.current = null;
    if (next.pendingTools > 0 || ev.aborted !== true) next.phase = next.aborted ? 'stopped' : 'running';
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'stale-ref') {
    if (ev.recovered === true) {
      next.summary = markRecovered(next.summary, 'STALE_REF');
    } else {
      next.summary = pushSummary(next.summary, {
        id: `stale-${next.summary.length}`,
        kind: 'error',
        label: zh(lang) ? '引用过期' : 'Stale control ref',
        object: text(ev.name, NAME_CAP),
        status: 'error',
        code: 'STALE_REF'
      });
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'action-outcome') {
    const code = text(ev.code, 64);
    if (code === 'TAB_LEASED') next = applyLease(next, { ...ev, op: 'conflict' });
    if (code === 'STALE_REF' && ev.recovered !== true) {
      next.summary = pushSummary(next.summary, {
        id: `stale-${next.summary.length}`,
        kind: 'error',
        label: zh(lang) ? '引用过期' : 'Stale control ref',
        object: text(ev.name, NAME_CAP),
        status: 'error',
        code: 'STALE_REF'
      });
    }
    if (ev.recovered === true || (text(ev.op) === 'snapshot' && ev.ok !== false)) {
      next.summary = markRecovered(next.summary, 'STALE_REF');
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'progress-note') {
    // Model commentary: a timeline row only. current / next / phase unchanged.
    const body = noteText(ev.text);
    const id = progressNoteRowId(ev);
    if (body && !next.summary.some((row) => row.id === id)) {
      next.summary = pushSummary(next.summary, {
        id,
        kind: 'note',
        label: body,
        status: 'note',
        at: Number(ev.at) || 0
      });
      next.noteCount = Math.max(0, Number(next.noteCount) || 0) + 1;
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'tool-call') {
    const name = toolName(ev);
    const args = toolArgs(ev);
    const current = currentFromToolCall(name, args, lang);
    const kind = summaryKind(name, args);
    const id = callId(ev, `call-${next.summary.length}`);
    const already = next.activeTools.find((row) => row.id && row.id === id);
    if (!already) {
      next.activeTools.push({ id, name, current });
    } else {
      already.current = current;
      already.name = name;
    }
    next.pendingTools = next.activeTools.length;
    next.phase = name === 'clarify' ? 'waiting_user' : 'running';
    next.current = current;
    if (!next.summary.some((row) => row.id === id && row.status === 'running')) {
      next.summary = pushSummary(next.summary, {
        id,
        kind,
        label: summaryLabel(kind, current, lang),
        object: current.object,
        status: 'running',
        tool: name,
        code: '',
        at: Number(ev.at) || (ev.replay ? 0 : Date.now())
      });
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'tool-execution-end') {
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'tool-result') {
    const name = toolName(ev);
    const args = toolArgs(ev);
    const result = toolResult(ev);
    const code = resultCode(ev, result);
    const ok = ev.ok !== false && result.ok !== false && !code;
    const recoveredCodes = new Set(['STALE_REF', 'TAB_LEASED', 'NEED_EXPLICIT_TAB', 'RPC_OUTCOME_UNKNOWN']);
    const id = callId(ev);
    let idx = -1;
    if (id) idx = next.activeTools.findIndex((row) => row.id === id);
    else {
      for (let i = next.activeTools.length - 1; i >= 0; i -= 1) {
        if (next.activeTools[i].name === name) {
          idx = i;
          break;
        }
      }
    }
    const priorCurrent = idx >= 0 ? next.activeTools[idx]?.current : null;
    if (idx >= 0) next.activeTools.splice(idx, 1);
    next.pendingTools = next.activeTools.length;
    const refinedArgs = {
      op: priorCurrent?.op || args.op || args.act || args.action || '',
      name: priorCurrent?.object || '',
      ...args,
      name: args.name || objectName(args, result) || priorCurrent?.object,
      path: args.path || result.path || firstNamed(result.writtenFiles) || firstNamed(result.artifacts),
      title: args.title || result.title || result.name
    };
    const refined = currentFromToolCall(name, refinedArgs, lang);
    next.summary = next.summary.map((row) => {
      if (id && row.id === id && row.status === 'running') {
        const nextLabel =
          refined.object && refined.object !== row.object
            ? summaryLabel(row.kind, refined, lang)
            : row.label;
        return {
          ...row,
          kind: row.kind === 'run' && countsDeliverable(name, refinedArgs, result) ? 'write' : row.kind,
          status: ok ? 'success' : 'error',
          code: code || row.code,
          object: refined.object || row.object,
          label: nextLabel || row.label
        };
      }
      return row;
    });
    if (code === 'TAB_LEASED') next = applyLease(next, ev);
    if (code === 'STALE_REF') {
      next.summary = pushSummary(next.summary, {
        id: `stale-${next.summary.length}`,
        kind: 'error',
        label: zh(lang) ? '引用过期' : 'Stale control ref',
        object: objectName(args, result),
        status: 'error',
        code: 'STALE_REF'
      });
    }
    if (name === 'action' && text(args.op) === 'snapshot' && ev.ok !== false && result.ok !== false) {
      next.summary = markRecovered(next.summary, 'STALE_REF');
    }
    if (name === 'task') {
      next = applyTask(next, result.task || ev.task || next.task, lang);
      if (text(args.op) === 'wait' && ev.ok !== false && result.ok !== false) {
        next.phase = 'waiting_timer';
      }
      if (text(args.op) === 'complete' && ev.ok !== false && result.ok !== false) {
        next.phase = 'completed';
      }
    }
    if (name === 'clarify' && ev.ok !== false) next.phase = 'waiting_user';
    if (ok && countsDeliverable(name, args, result)) {
      next.artifactCount = Math.max(0, Number(next.artifactCount) || 0) + 1;
    }
    const settled = settleToolCurrent(refined, lang, ok);
    const stillRunning = currentFromActive(next.activeTools);
    if (stillRunning) next.current = stillRunning;
    else if (next.phase === 'running' || next.phase === 'verifying' || next.phase === 'waiting_timer') {
      next.current = settled;
    } else if (next.current?.source !== 'host') {
      next.current = settled || next.current;
    }
    if (code && recoveredCodes.has(code) === false && ev.ok === false) {
      next.summary = pushSummary(next.summary, {
        id: `err-${next.summary.length}`,
        kind: 'error',
        label: text(result.error || ev.error || code, 80),
        object: objectName(args, result),
        status: 'error',
        code
      });
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'error') {
    const code = resultCode(ev);
    if (code === 'TAB_LEASED') next = applyLease(next, ev);
    if (code === 'STALE_REF') {
      next.summary = pushSummary(next.summary, {
        id: `stale-${next.summary.length}`,
        kind: 'error',
        label: zh(lang) ? '引用过期' : 'Stale control ref',
        object: '',
        status: 'error',
        code: 'STALE_REF'
      });
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'policy-blocked') {
    next.approvalOpen = false;
    next.policyBlocked = ev.kind || 'payment-handoff';
    if (next.phase === 'idle') next.phase = 'running';
    next.current = {
      text: text(ev.summary, 160) || (zh(lang) ? '请你接管付款' : 'Please take over payment'),
      source: 'host'
    };
    next.summary = pushSummary(next.summary, {
      id: `blocked-${text(ev.operationId, 40) || next.summary.length}`,
      kind: 'error',
      label: text(ev.summary, 80) || (zh(lang) ? '请你接管付款' : 'Please take over payment'),
      object: text(ev.detail, NAME_CAP),
      status: 'error',
      code: ev.code || 'PAYMENT_DENIED'
    });
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'approval-required') {
    next.approvalOpen = ev.decisionRequired !== false;
    next.phase = 'awaiting_approval';
    next.current = {
      text: text(ev.summary, 160) || (zh(lang) ? '等待你确认' : 'Waiting for your confirmation'),
      source: 'host'
    };
    next.summary = pushSummary(next.summary, {
      id: `approval-${text(ev.approvalId || ev.operationId, 40) || next.summary.length}`,
      kind: ev.risk === 'delete' ? 'error' : 'wait',
      label: text(ev.summary, 80) || (zh(lang) ? '等待确认' : 'Awaiting approval'),
      object: text(ev.detail, NAME_CAP),
      status: 'waiting',
      code: 'APPROVAL_REQUIRED'
    });
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'approval-done') {
    next.approvalOpen = ev.stillPending === true;
    if (next.phase === 'awaiting_approval' && ev.stillPending !== true) {
      next.phase = next.aborted ? 'stopped' : 'running';
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'journal' || type === 'policy') {
    const state = text(ev.state, 40);
    if (state === 'unknown') {
      next.phase = 'unknown';
      next.current = { text: zh(lang) ? '结果未知，未重试' : 'Outcome unknown; not retried', source: 'host' };
    } else if (state === 'needs_human') {
      next.phase = 'needs_human';
      next.current = { text: zh(lang) ? '需要你查看后再继续' : 'Needs you to inspect before continuing', source: 'host' };
    } else if (state === 'verifying') {
      next.phase = 'verifying';
      next.current = { text: zh(lang) ? '正在核对是否已生效' : 'Checking whether it took effect', source: 'host' };
    }
    if (ev.code || state === 'unknown' || state === 'needs_human') {
      next.summary = pushSummary(next.summary, {
        id: `journal-${text(ev.operationId, 40) || next.summary.length}`,
        kind: 'error',
        label: text(ev.code || state, 80),
        object: text(ev.risk, NAME_CAP),
        status: state === 'unknown' ? 'unknown' : state === 'needs_human' ? 'needs_human' : 'error',
        code: text(ev.code, 64)
      });
    }
    next.next = resolveNext(next, lang);
    return next;
  }

  if (type === 'assistant-final' || type === 'execution-end') {
    const status = text(ev.status).toLowerCase();
    if (type === 'assistant-final') next = dropEchoedNoteRow(next, ev.content);
    const pendingHuman = next.approvalOpen === true || !!next.policyBlocked || next.clarifyOpen === true;
    // assistant-final is "the model finished talking", not "the human interrupt is gone".
    if (type === 'assistant-final' && pendingHuman) {
      next.pendingTools = 0;
      next.activeTools = [];
      if (next.approvalOpen) next.phase = 'awaiting_approval';
      else if (next.clarifyOpen) next.phase = 'waiting_user';
      else if (next.policyBlocked && (next.phase === 'idle' || next.phase === 'completed')) next.phase = 'running';
      next.next = resolveNext(next, lang);
      return next;
    }
    next.pendingTools = 0;
    next.activeTools = [];
    next.current = null;
    next.clarifyOpen = false;
    next.approvalOpen = false;
    next.policyBlocked = null;
    next.endedAt = Number(ev.endedAt) || Date.now();
    if (next.aborted || status === 'aborted' || status === 'cancelled' || status === 'canceled' || ev.code === 'user_stop') {
      next.phase = 'stopped';
    } else if (status === 'failed' || type === 'error') next.phase = 'failed';
    else if (next.task?.status === 'waiting') next.phase = 'waiting_timer';
    else if (next.task?.status === 'paused') next.phase = 'paused';
    else if (next.task?.status === 'completed' || status === 'completed' || type === 'assistant-final') {
      next.phase = 'completed';
    } else next.phase = 'completed';
    next.next = resolveNext(next, lang);
    return next;
  }

  next.next = resolveNext(next, lang);
  return next;
}

/** A task-yield stop can report the last note's prose as the answer. */
function dropEchoedNoteRow(state, content) {
  const fin = noteText(content);
  const last = state.summary[state.summary.length - 1];
  if (!fin || !isNoteRow(last) || noteText(last.label) !== fin) return state;
  return {
    ...state,
    summary: state.summary.slice(0, -1),
    noteCount: Math.max(0, (Number(state.noteCount) || 0) - 1)
  };
}

export function summaryCollapseKey(row) {
  if (isNoteRow(row)) return `note\0${row.id || ''}\0${row.label || ''}`;
  return [row?.kind || '', row?.label || '', row?.object || '', row?.tool || ''].join('\0');
}

export function collapseConsecutiveSummary(summary) {
  const list = Array.isArray(summary) ? summary : [];
  const out = [];
  for (const row of list) {
    if (!row) continue;
    const last = out[out.length - 1];
    if (last && summaryCollapseKey(last) === summaryCollapseKey(row)) {
      last.count = (Number(last.count) || 1) + 1;
      last.status = row.status || last.status;
      last.id = row.id || last.id;
      last.code = row.code || last.code;
      if (row.object) last.object = row.object;
    } else {
      out.push({ ...row, count: Math.max(1, Number(row.count) || 1) });
    }
  }
  return out;
}

/** Small muted stroke marks. currentColor. Not brand copy. */
export const ACTIVITY_ICON = ACTIVITY_ICONS;

export function activityIconKind(row = {}) {
  const kind = String(row.kind || '');
  const tool = String(row.tool || '');
  const view = String(row.view || '');
  const op = String(row.op || '');
  const status = String(row.status || '');
  if (kind === 'error' || status === 'error' || status === 'failed') return 'error';
  if (kind === 'think' || tool === 'thought' || row.source === 'thought') return 'think';
  if (kind === 'wait' || tool === 'task' || tool === 'clarify') return 'wait';
  if (kind === 'write' || tool === 'sheet' || tool === 'doc') return 'write';
  if (kind === 'run' || tool === 'run') return 'run';
  if (kind === 'action' || kind === 'web' || tool === 'action' || tool === 'web') return 'browser';
  if (tool === 'acquire') return op === 'image' || kind === 'write' ? 'write' : 'browser';
  if (kind === 'read' || tool === 'inspect' || view === 'skill' || view === 'skills' || view === 'sys') return 'read';
  return 'run';
}

export function formatActivityRow(row, t) {
  if (isNoteRow(row)) return { iconKind: 'note', icon: '', label: noteText(row.label), note: true };
  const iconKind = activityIconKind(row);
  return {
    iconKind,
    icon: ACTIVITY_ICON[iconKind] || ACTIVITY_ICON.run,
    label: formatSummaryRowText(row, t)
  };
}

function iconKindFromBrief(text) {
  const s = String(text || '');
  if (/处理…|Working…|思考|Thinking/i.test(s)) return 'think';
  if (/运行访客|Running guest|调用 |Calling /i.test(s)) return 'run';
  if (/查阅|读取会话|Reading a playbook|Reading the sys|Reading session|Looked /i.test(s)) return 'read';
  if (/点击|填写|页面|网站|Clicking|Filling|Acting|Scrolling|Browser/i.test(s)) return 'browser';
  if (/写入|写 |Write|Wrote|登记|Register/i.test(s)) return 'write';
  if (/等待|确认|Waiting|approval/i.test(s)) return 'wait';
  return 'think';
}

export function liveActivityVisual(state, text, t) {
  const label = String(text || '').trim();
  const fallback = typeof t === 'function' ? t('liveProgress') : '';
  const current = state?.current;
  let iconKind = 'think';
  if (current?.source === 'host' && current.text) {
    iconKind = /确认|approval|Waiting for your confirmation|接管付款|take over payment/i.test(current.text)
      ? 'wait'
      : iconKindFromBrief(current.text);
  } else if (current?.tool && !isPageReadStatus(current)) {
    iconKind = activityIconKind({
      kind: current.tool === 'run' && RUN_REGISTER_OPS.has(String(current.op || '')) ? 'write' : '',
      tool: current.tool,
      view: current.view,
      op: current.op,
      status: current.status
    });
  } else if (label && label !== fallback) {
    iconKind = iconKindFromBrief(state?.lastLiveAction || label);
  }
  return {
    iconKind,
    icon: ACTIVITY_ICON[iconKind] || ACTIVITY_ICON.think,
    label: label || fallback
  };
}

export function formatSummaryRowText(row, t) {
  const kindKey = `botKind_${row?.kind || ''}`;
  const kindLabel = typeof t === 'function' ? t(kindKey) : '';
  const kind = kindLabel && kindLabel !== kindKey ? kindLabel : '';
  const object = text(row?.object, NAME_CAP);
  const rawLabel = text(row?.label, 160);
  const count = Math.max(1, Number(row?.count) || 1);
  let main = rawLabel;
  if (object && main && !main.includes(object)) main = `${main} · ${object}`;
  else if (object && !main) main = object;
  const writeKind = kind && /写|Write/i.test(kind);
  const writeDup = writeKind && /写|Write|deliverable/i.test(main);
  const kindAlready = kind && (main === kind || main.startsWith(`${kind} ·`) || main.startsWith(kind));
  if (kind && main && !kindAlready && !writeDup) main = `${kind} · ${main}`;
  else if (!main) main = kind;
  const genericWrite = /^(写入文件|Write file)$/i.test(rawLabel);
  if (count > 1) {
    const stem = genericWrite || (!object && writeDup) ? kind || main : main || kind;
    return `${stem}×${count}`;
  }
  return main || kind || rawLabel;
}

/**
 * Timeline projection: every progress note stays; activity rows keep the
 * last `limit` (after collapsing consecutive repeats). Order is preserved.
 */
export function visibleSummaryRows(summary, limit = 8) {
  const list = collapseConsecutiveSummary(summary);
  let budget = Math.max(0, Number(limit) || 0);
  const keep = new Array(list.length).fill(false);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isNoteRow(list[i])) keep[i] = true;
    else if (budget > 0) {
      keep[i] = true;
      budget -= 1;
    }
  }
  return list.filter((_, i) => keep[i]);
}

/**
 * Shine the latest activity label, never the think-bar header or a note.
 * Fallback line shimmers only when there is not yet any timeline row.
 */
export function latestActivityShine(state) {
  const rows = visibleSummaryRows(state?.summary, 8);
  const last = rows[rows.length - 1] || null;
  const act = [...rows].reverse().find((row) => !isNoteRow(row)) || null;
  return {
    shineOn: last ? 'latest-row' : 'fallback',
    rowId: act ? String(act.id || '') : '',
    thinkHeaderShimmer: false
  };
}

/** Local wall-clock HH:MM for expanded timeline rows; '' when unknown. */
export function formatRowTime(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function phaseLabelKey(phase) {
  const known = new Set(['idle', 'running', 'waiting_user', 'waiting_timer', 'paused', 'completed', 'failed', 'stopped', 'awaiting_approval', 'verifying', 'unknown', 'needs_human']);
  return known.has(String(phase || '')) ? `botPhase_${phase}` : 'botPhase_idle';
}

export const TURN_MEMORY_CAP = 8;
export const PULSE_COMPLETE_MS = 800;
const NARRATIVE_HYDRATE = NARRATIVE;

export function disclosureMode(state) {
  if (!state || typeof state !== 'object') return 'hidden';
  if (state.approvalOpen || state.phase === 'awaiting_approval') return 'sticky';
  if (state.policyBlocked) return 'sticky';
  if (state.clarifyOpen || state.phase === 'waiting_user') return 'sticky';
  if (state.lease?.kind === 'conflict') return 'sticky';
  if (state.phase === 'paused' || state.phase === 'needs_human' || state.phase === 'unknown') {
    return 'sticky';
  }
  if (state.phase === 'running' || state.phase === 'waiting_timer' || state.phase === 'verifying') return 'live';
  if (state.phase === 'stopped' || state.phase === 'completed' || state.phase === 'failed') return 'folded';
  return 'hidden';
}

/** Complete / stop / fail / cancel: fold every activity row immediately. */
export function shouldFoldDisclosureImmediately(state, extra = {}) {
  if (extra.immediate === true) return true;
  const mode = extra.mode || disclosureMode(state);
  if (mode !== 'folded') return false;
  const phase = String(state?.phase || extra.phase || '');
  return phase === 'completed' || phase === 'stopped' || phase === 'failed';
}

export function projectGlobalPhase(state) {
  if (!state) return 'idle';
  if (disclosureMode(state) === 'sticky') return state.phase;
  if (state.phase === 'completed' || state.phase === 'stopped' || state.phase === 'failed') return 'idle';
  return state.phase;
}

export function shouldShowGlobalStatusWall(state) {
  void state;
  return false;
}

export function shouldKeepApprovalVisible(state, eventType) {
  const type = String(eventType || '');
  if (type === 'approval-done') return false;
  if (type === 'execution-end') return false;
  if (state?.approvalOpen || state?.policyBlocked || state?.phase === 'awaiting_approval') return true;
  return false;
}

/**
 * Turn duration in the UI language: "5 秒" / "8 分 5 秒" / "1 小时 3 分" (zh),
 * "5s" / "8m 5s" / "1h 3m" (en). Without a translator, the en form.
 */
export function formatDisclosureDuration(ms, t) {
  const tr = (key, fallback) => {
    const out = typeof t === 'function' ? t(key) : '';
    return out && out !== key ? out : fallback;
  };
  const sec = tr('tdDurSec', '{n}s');
  const min = tr('tdDurMin', '{n}m');
  const hour = tr('tdDurHour', '{n}h');
  const join = tr('tdDurJoin', ' ');
  const fill = (tpl, n) => String(tpl).replace('{n}', String(n));
  const totalSec = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (totalSec < 60) return fill(sec, totalSec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h) return m ? fill(hour, h) + join + fill(min, m) : fill(hour, h);
  return s ? fill(min, m) + join + fill(sec, s) : fill(min, m);
}

export function formatFoldLine({ phase, durationMs, artifactCount, noteCount } = {}, t) {
  const p = String(phase || '');
  const word =
    p === 'stopped' ? t('tdFoldStopped') : p === 'failed' ? t('tdFoldFailed') : t('tdFoldDone');
  const parts = [word, formatDisclosureDuration(durationMs, t)];
  const notes = Math.max(0, Number(noteCount) || 0);
  if (notes) {
    parts.push(notes === 1 ? t('tdNoteOne') : String(t('tdNoteMany') || '').replace('{n}', String(notes)));
  }
  const n = Math.max(0, Number(artifactCount) || 0);
  if (n) {
    parts.push(n === 1 ? t('tdDeliverableOne') : String(t('tdDeliverableMany') || '').replace('{n}', String(n)));
  }
  return parts.join(' · ');
}

export function foldStubFromState(state, t, extras = {}) {
  const started = Number(state?.startedAt || extras.startedAt || 0);
  const ended = Number(state?.endedAt || extras.endedAt || 0) || Date.now();
  const durationMs = Math.max(0, ended - (started || ended));
  const mode = disclosureMode(state);
  return {
    executionId: text(state?.executionId || extras.executionId, 80),
    messageId: text(extras.messageId, 80),
    turnIndex: Number(extras.turnIndex) || 0,
    mode: mode === 'sticky' ? 'sticky' : mode === 'live' ? 'live' : 'folded',
    line: formatFoldLine(
      { phase: state?.phase, durationMs, artifactCount: state?.artifactCount, noteCount: state?.noteCount },
      t
    ),
    durationMs,
    artifactCount: Math.max(0, Number(state?.artifactCount) || 0),
    noteCount: Math.max(0, Number(state?.noteCount) || 0),
    hydrated: false
  };
}

/**
 * Rebuild a settled turn's timeline from its persisted assistant record:
 * notes (`progress`, anchored by toolIndex) interleaved with replayed
 * toolCalls. Returns null when the record has no progress notes, so older
 * turns keep their previous bare restore.
 * @param {object} m assistant record from getSession
 */
export function statusFromAssistantRecord(m, ctx = {}) {
  const notes = Array.isArray(m?.progress) ? m.progress.filter((n) => n && String(n.text || '').trim()) : [];
  if (!notes.length) return null;
  const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  const endedAt = Number(m.endedAt || m.createdAt) || 0;
  const startedAt = Number(m.startedAt) || (endedAt && Number(m.latencyMs) ? endedAt - Number(m.latencyMs) : endedAt);
  const executionId = text(m.executionId || m.messageId, 80);
  const events = [{ type: 'execution-start', executionId, startedAt: startedAt || 1 }];
  const sorted = notes.slice().sort((a, b) => (Number(a.toolIndex) || 0) - (Number(b.toolIndex) || 0));
  let ni = 0;
  const flushNotes = (upto) => {
    while (ni < sorted.length && (Number(sorted[ni].toolIndex) || 0) <= upto) {
      events.push({ type: 'progress-note', ...sorted[ni] });
      ni += 1;
    }
  };
  calls.forEach((call, i) => {
    flushNotes(i);
    const id = text(call?.toolCallId, 80) || `replay-${i}`;
    const name = call?.toolName || call?.name || 'tool';
    const args = call?.args ?? call?.input ?? {};
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    events.push({ type: 'tool-call', toolCallId: id, name, args, replay: true });
    events.push({ type: 'tool-result', toolCallId: id, name, args, result, ok: result.ok !== false, replay: true });
  });
  flushNotes(Number.MAX_SAFE_INTEGER);
  const status = text(m.status).toLowerCase();
  events.push({
    type: 'execution-end',
    status: status === 'aborted' ? 'aborted' : status === 'failed' ? 'failed' : 'completed',
    endedAt: endedAt || startedAt || 1
  });
  let state = createExecutionStatus(ctx);
  for (const ev of events) state = applyExecutionStatus(state, ev, ctx);
  return state;
}

export function projectStatusForSessionStash(state) {
  if (!state || typeof state !== 'object') return createExecutionStatus();
  if (disclosureMode(state) === 'sticky') return state;
  if (state.phase === 'completed' || state.phase === 'stopped' || state.phase === 'failed') {
    return { ...state, phase: 'idle', current: null };
  }
  return state;
}

export function hydrateStatusFromEvents(events, ctx = {}) {
  let state = createExecutionStatus(ctx);
  for (const ev of Array.isArray(events) ? events : []) {
    const type = text(ev?.type);
    if (!type || NARRATIVE_HYDRATE.has(type)) continue;
    state = applyExecutionStatus(state, ev, ctx);
  }
  return state;
}

export function rememberEndedProjection(full, stubs, executionId, slice) {
  const id = text(executionId, 80);
  const fullMap = full instanceof Map ? full : new Map();
  const stubMap = stubs instanceof Map ? stubs : new Map();
  if (!id) return { full: fullMap, stubs: stubMap };
  stubMap.set(id, {
    executionId: id,
    mode: slice?.mode || 'folded',
    line: slice?.line || '',
    durationMs: Number(slice?.durationMs) || 0,
    artifactCount: Number(slice?.artifactCount) || 0,
    hydrated: true
  });
  if (fullMap.has(id)) fullMap.delete(id);
  fullMap.set(id, { ...(slice || {}), executionId: id, hydrated: true });
  while (fullMap.size > TURN_MEMORY_CAP) {
    const drop = fullMap.keys().next().value;
    fullMap.delete(drop);
    const stub = stubMap.get(drop);
    if (stub) stub.hydrated = false;
  }
  return { full: fullMap, stubs: stubMap };
}

/**
 * Reopened panel mid-turn: events that repaint the running turn's notes from
 * getSession().liveProgress. Notes already in `state` are skipped by row id.
 * @param {object} state current execution status
 * @param {{ executionId?: string, startedAt?: number, notes?: object[] }|null} slot
 */
export function seedEventsFromLiveProgress(state, slot, sessionId = '') {
  const executionId = text(slot?.executionId, 80);
  const notes = Array.isArray(slot?.notes) ? slot.notes : [];
  if (!executionId || !notes.length) return [];
  const out = [];
  const same = text(state?.executionId, 80) === executionId;
  if (!same) {
    out.push({ type: 'execution-start', sessionId, executionId, startedAt: Number(slot.startedAt) || 0 });
  }
  const have = new Set(
    same && Array.isArray(state?.summary) ? state.summary.filter(isNoteRow).map((row) => row.id) : []
  );
  for (const note of notes) {
    const ev = { type: 'progress-note', sessionId, executionId, ...note };
    if (!have.has(progressNoteRowId(ev))) out.push(ev);
  }
  return out.length > (same ? 0 : 1) ? out : [];
}
