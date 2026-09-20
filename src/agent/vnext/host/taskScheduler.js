/** Chrome wakeups only; durable tasks and dispatch ownership live in offscreen. */
import { TASK_RECONCILE_ALARM, TASK_WAKE_ALARM } from '../../../brand.js';

export { TASK_WAKE_ALARM, TASK_RECONCILE_ALARM };

export function createTaskScheduler({ alarms, rpc, now = Date.now, onError = console.warn }) {
  let pending = false;
  let dispatch = false;
  let running = null;

  async function syncAlarms() {
    const schedule = await rpc('getTaskSchedule', {});
    const rawDue = schedule?.nextWakeAt;
    const due = typeof rawDue === 'string' && !/^\d+$/.test(rawDue)
      ? Date.parse(rawDue) : Number(rawDue);
    if (!Number.isFinite(due) || due <= 0) {
      await alarms.clear(TASK_WAKE_ALARM);
      await alarms.clear(TASK_RECONCILE_ALARM);
      return;
    }
    // A busy session or delayed alarm must not spin the worker in a tight loop.
    const when = Math.max(now() + 30_000, due);
    const existing = await alarms.get(TASK_WAKE_ALARM);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
      await alarms.create(TASK_WAKE_ALARM, { when });
    }
    // Repair missed messages while tasks are scheduled, without keeping a model alive.
    if (!(await alarms.get(TASK_RECONCILE_ALARM))) {
      await alarms.create(TASK_RECONCILE_ALARM, { periodInMinutes: 1 });
    }
  }

  function reconcile({ runDue = false } = {}) {
    if (!alarms) return Promise.resolve();
    pending = true;
    dispatch ||= runDue;
    if (running) return running;
    running = (async () => {
      while (pending) {
        pending = false;
        const shouldDispatch = dispatch;
        dispatch = false;
        try {
          if (shouldDispatch) await rpc('runDueTasks', { now: now() });
          await syncAlarms();
        } catch (error) {
          onError('[tasks] wakeup reconciliation failed', error);
          // A transient offscreen / storage failure must not erase the only wakeup.
          try {
            if (!(await alarms.get(TASK_RECONCILE_ALARM))) {
              await alarms.create(TASK_RECONCILE_ALARM, { periodInMinutes: 1 });
            }
          } catch (alarmError) { onError('[tasks] recovery alarm failed', alarmError); }
          // The next alarm retries. Do not spin on a failed runtime.
          pending = false;
          dispatch = false;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function onAlarm(alarm) {
    if (alarm?.name !== TASK_WAKE_ALARM && alarm?.name !== TASK_RECONCILE_ALARM) return;
    return reconcile({ runDue: true });
  }

  return { reconcile, onAlarm };
}

/** Never substitute the current active tab for a scheduled task's saved target. */
export async function resolveTaskPage(tabs, page) {
  if (!page) return { ok: true, tab: null };
  const url = String(page.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, code: 'TASK_TARGET_MISSING', error: 'Task target must be an available HTTP(S) page.' };
  }
  const id = Number(page.tabId ?? page.id);
  if (Number.isInteger(id) && id > 0) {
    try {
      const tab = await tabs.get(id);
      if (tab?.url === url && (!tab.pendingUrl || tab.pendingUrl === url)) return taskTab(tab);
    } catch { /* Browser restart or closed tab: look for the exact saved URL. */ }
  }
  const matches = (await tabs.query({})).filter(tab =>
    tab.url === url && (!tab.pendingUrl || tab.pendingUrl === url));
  if (matches.length === 1) return taskTab(matches[0]);
  return {
    ok: false,
    code: matches.length ? 'TASK_TARGET_AMBIGUOUS' : 'TASK_TARGET_MISSING',
    error: matches.length ? 'Multiple tabs match the saved task page; choose a target before resuming.'
      : 'The saved task page is unavailable; open it before resuming.'
  };
}

function taskTab(tab) {
  return { ok: true, tab: {
    id: tab.id, tabId: tab.id, url: tab.url, title: String(tab.title || ''), windowId: tab.windowId
  } };
}
