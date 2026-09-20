/**
 * Durable task status UI. The backend owns task state; this module only renders
 * the active session and rejects late responses after a session switch.
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PROMINENT = new Set(['ready', 'running', 'waiting', 'paused']);
const PAUSABLE = new Set(['ready', 'running', 'waiting']);

function text(value) {
  return String(value ?? '').trim();
}

function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content != null) el.textContent = String(content);
  return el;
}

export function taskBelongsToSession(task, sessionId) {
  const taskSid = text(task?.sessionId);
  const sid = text(sessionId);
  return !!taskSid && !!sid && taskSid === sid;
}

export function shouldCommitTaskResponse(requestSessionId, activeSessionId, generation, currentGeneration) {
  return (
    !!text(requestSessionId) &&
    text(requestSessionId) === text(activeSessionId) &&
    Number(generation) === Number(currentGeneration)
  );
}

export function tasksFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.tasks)) return response.tasks;
  if (Array.isArray(response?.items)) return response.items;
  return [];
}

function taskFromResponse(response) {
  if (response?.task && typeof response.task === 'object') return response.task;
  if (response && typeof response === 'object' && response.taskId) return response;
  return null;
}

export function isTerminalTask(task) {
  return TERMINAL.has(text(task?.status).toLowerCase());
}

export function partitionTaskCards(tasks = []) {
  const active = [];
  const terminal = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = text(task?.status).toLowerCase();
    if (PROMINENT.has(status)) active.push(task);
    else terminal.push(task);
  }
  return { active, terminal };
}

/** No empty "ongoing tasks" chrome when nothing is live. */
export function shouldShowTaskRegion(tasks = []) {
  return partitionTaskCards(tasks).active.length > 0;
}

function statusKey(status) {
  const value = text(status).toLowerCase();
  const known = new Set(['ready', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']);
  return known.has(value) ? `durableTaskStatus_${value}` : 'durableTaskStatus_ready';
}

function stepStatusKey(status) {
  const value = text(status).toLowerCase();
  if (value === 'completed' || value === 'done') return 'durableTaskStepDone';
  if (value === 'running') return 'durableTaskStepRunning';
  if (value === 'failed') return 'durableTaskStepFailed';
  return 'durableTaskStepPending';
}

function formatDate(value, lang) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return text(value);
  try {
    return new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * @param {{
 *   workspaceRpc: (method:string, params:object) => Promise<any>,
 *   t: (key:string) => string,
 *   getLang: () => string,
 *   getSessionId: () => string,
 *   getTaskStream: () => HTMLElement|null,
 *   getThreadBody: (sessionId:string) => HTMLElement|null,
 *   showToast?: (message:string, opts?:object) => void
 * }} deps
 */
export function createTaskStatusUi(deps) {
  let generation = 0;
  let cachedSessionId = '';
  let cachedTasks = [];
  let cachedActiveTaskId = '';
  let host = null;
  let refreshTimer = 0;

  function ensureHost() {
    if (host?.isConnected) return host;
    host = document.createElement('section');
    host.className = 'durable-task-region';
    host.hidden = true;
    host.setAttribute('aria-live', 'polite');
    return host;
  }

  function mount() {
    const sid = text(deps.getSessionId());
    const region = ensureHost();
    const threadBody = deps.getThreadBody(sid);
    if (threadBody) {
      if (threadBody.firstChild !== region) threadBody.insertBefore(region, threadBody.firstChild);
      return region;
    }
    const stream = deps.getTaskStream();
    if (stream && region.parentNode !== stream) stream.insertBefore(region, stream.firstChild);
    return region;
  }

  function labeledLine(labelKey, value, className = '') {
    const row = node('div', `durable-task-line ${className}`.trim());
    row.append(node('span', 'durable-task-line-label', deps.t(labelKey)));
    row.append(node('span', 'durable-task-line-value', value));
    return row;
  }

  function renderSteps(task, card) {
    const steps = Array.isArray(task?.plan?.steps) ? task.plan.steps : [];
    if (!steps.length) return;
    const list = node('ol', 'durable-task-steps');
    for (const step of steps) {
      const status = text(step?.status).toLowerCase() || 'pending';
      const item = node('li', 'durable-task-step');
      item.dataset.state = status;
      item.append(node('span', 'durable-task-step-mark', status === 'completed' || status === 'done' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '!' : '·'));
      item.append(node('span', 'durable-task-step-title', text(step?.title) || deps.t('durableTaskUntitledStep')));
      const sr = node('span', 'sr-only', deps.t(stepStatusKey(status)));
      item.append(sr);
      list.append(item);
    }
    card.append(list);
  }

  function renderEvidence(task, card) {
    const evidence = Array.isArray(task?.evidence) ? task.evidence.map(text).filter(Boolean) : [];
    if (!evidence.length) return;
    const details = node('details', 'durable-task-evidence');
    const summary = node('summary', '', `${deps.t('durableTaskEvidence')} · ${evidence.length}`);
    const list = node('ul', 'durable-task-evidence-list');
    evidence.forEach((item) => list.append(node('li', '', item)));
    details.append(summary, list);
    card.append(details);
  }

  async function act(task, op, button) {
    const sid = text(deps.getSessionId());
    if (!taskBelongsToSession(task, sid) || !text(task?.taskId)) return;
    const card = button.closest('.durable-task-card');
    card?.classList.add('is-updating');
    card?.querySelectorAll('button').forEach((el) => { el.disabled = true; });
    try {
      const response = await deps.workspaceRpc('updateTask', { taskId: task.taskId, op });
      if (text(deps.getSessionId()) !== sid) return;
      let updated = taskFromResponse(response);
      if (!updated) {
        const fetched = await deps.workspaceRpc('getTask', { taskId: task.taskId });
        updated = taskFromResponse(fetched);
      }
      if (updated && taskBelongsToSession(updated, sid)) {
        cachedTasks = cachedTasks.map((item) => item.taskId === updated.taskId ? updated : item);
        render(cachedTasks, sid);
      } else {
        await refresh();
      }
    } catch (error) {
      deps.showToast?.(text(error?.message) || deps.t('durableTaskActionFailed'), { error: true });
      render(cachedTasks, sid);
    }
  }

  function actionButton(task, op, labelKey, className = '') {
    const button = node('button', `durable-task-action ${className}`.trim(), deps.t(labelKey));
    button.type = 'button';
    button.addEventListener('click', () => void act(task, op, button));
    return button;
  }

  function renderCard(task) {
    const status = text(task.status).toLowerCase() || 'ready';
    const card = node('article', 'durable-task-card');
    const isActive = text(task.taskId) && text(task.taskId) === cachedActiveTaskId;
    card.dataset.taskId = text(task.taskId);
    card.dataset.state = status;
    if (isActive) card.classList.add('is-session-active');

    const head = node('div', 'durable-task-head');
    const goal = node('div', 'durable-task-goal', text(task.contract?.goal || task.originalGoal) || deps.t('durableTaskUntitled'));
    const state = node('span', 'durable-task-state', deps.t(isActive ? 'durableTaskActive' : statusKey(status)));
    state.dataset.state = isActive ? 'active' : status;
    head.append(goal, state);
    card.append(head);

    const amendmentCount = Array.isArray(task.amendments) ? task.amendments.length : 0;
    if (amendmentCount) card.append(labeledLine('durableTaskAmendments', String(amendmentCount)));
    renderSteps(task, card);

    const due = formatDate(task.dueAt, deps.getLang());
    if (due) card.append(labeledLine('durableTaskNextWake', due, 'is-wake'));
    const interval = Number(task.intervalMinutes);
    if (Number.isFinite(interval) && interval > 0) {
      card.append(labeledLine('durableTaskRepeats', deps.t('durableTaskEveryMinutes').replace('{n}', String(interval))));
    }
    if (text(task.nextAction)) card.append(labeledLine('durableTaskNextAction', text(task.nextAction)));
    if (text(task.summary)) card.append(labeledLine('durableTaskSummary', text(task.summary)));
    if (text(task.lastError)) card.append(labeledLine('durableTaskError', text(task.lastError), 'is-error'));
    renderEvidence(task, card);

    if (!TERMINAL.has(status)) {
      const actions = node('div', 'durable-task-actions');
      // Resume is only for paused durable tasks — not the pink user bubble 「继续」.
      if (status === 'paused') actions.append(actionButton(task, 'resume', 'durableTaskResume'));
      else if (PAUSABLE.has(status)) actions.append(actionButton(task, 'pause', 'durableTaskPause'));
      if (isActive) actions.append(actionButton(task, 'detach', 'durableTaskDetach'));
      actions.append(actionButton(task, 'cancel', 'durableTaskCancel', 'is-danger'));
      card.append(actions);
    }
    return card;
  }

  function render(tasks = cachedTasks, sessionId = cachedSessionId) {
    const sid = text(sessionId);
    const region = mount();
    if (!region || sid !== text(deps.getSessionId())) return;
    const scoped = (Array.isArray(tasks) ? tasks : []).filter((task) => taskBelongsToSession(task, sid));
    cachedSessionId = sid;
    cachedTasks = scoped;
    region.replaceChildren();
    const { active, terminal } = partitionTaskCards(scoped);
    const show = shouldShowTaskRegion(scoped);
    region.hidden = !show;
    if (!show) return;

    const header = node('div', 'durable-task-region-head');
    header.append(node('span', 'durable-task-region-title', cachedActiveTaskId ? deps.t('durableTaskActive') : deps.t('durableTasksTitle')));
    header.append(node('span', 'durable-task-count', String(active.length)));
    region.append(header);
    if (active.length) {
      const list = node('div', 'durable-task-list');
      active.forEach((task) => list.append(renderCard(task)));
      region.append(list);
    }
    if (terminal.length) {
      const finished = node('details', 'durable-task-finished');
      const summary = node('summary', '', `${deps.t('durableTasksFinished')} · ${terminal.length}`);
      const list = node('div', 'durable-task-list is-finished');
      terminal.forEach((task) => list.append(renderCard(task)));
      finished.append(summary, list);
      region.append(finished);
    }
  }

  async function refresh() {
    const sid = text(deps.getSessionId());
    if (!sid) return;
    const token = ++generation;
    mount();
    try {
      const response = await deps.workspaceRpc('listTasks', { sessionId: sid });
      if (!shouldCommitTaskResponse(sid, deps.getSessionId(), token, generation)) return;
      cachedActiveTaskId = text(response?.activeTaskId);
      render(tasksFromResponse(response), sid);
    } catch (error) {
      if (!shouldCommitTaskResponse(sid, deps.getSessionId(), token, generation)) return;
      console.warn('[durable-tasks] list failed', error);
      cachedSessionId = sid;
      cachedTasks = [];
      cachedActiveTaskId = '';
      render([], sid);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 80);
  }

  function handleWorkspaceEvent(ev = {}) {
    const type = text(ev.type);
    const sid = text(ev.sessionId || ev.task?.sessionId);
    const active = text(deps.getSessionId());
    if (type === 'task-updated' || type === 'task-schedule-changed' || type === 'task-lifecycle') {
      // Older broadcasters may omit sessionId. listTasks stays scoped, so a
      // foreground refresh remains isolated even for that compatibility case.
      if (!sid || sid === active) scheduleRefresh();
      return true;
    }
    if ((type === 'execution-end' || type === 'assistant-final') && (!sid || sid === active)) {
      scheduleRefresh();
    }
    return false;
  }

  return { refresh, render, mount, handleWorkspaceEvent };
}
