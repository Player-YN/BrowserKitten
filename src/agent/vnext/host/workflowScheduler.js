/** Chrome wakeups only; a due alarm starts a NEW published run and never resumes one. */
import { WORKFLOW_RECONCILE_ALARM, WORKFLOW_WAKE_ALARM } from '../../../brand.js';

export { WORKFLOW_WAKE_ALARM, WORKFLOW_RECONCILE_ALARM };

export function createWorkflowScheduler({ alarms, rpc, now = Date.now, onError = console.warn } = {}) {
  let pending = false;
  let dispatch = false;
  let running = null;

  async function syncAlarms() {
    const schedule = await rpc('getWorkflowSchedule', {});
    const rawDue = schedule?.nextWakeAt;
    const due = typeof rawDue === 'string' && !/^\d+$/.test(rawDue) ? Date.parse(rawDue) : Number(rawDue);
    if (!Number.isFinite(due) || due <= 0) {
      await alarms.clear(WORKFLOW_WAKE_ALARM);
      await alarms.clear(WORKFLOW_RECONCILE_ALARM);
      return;
    }
    const when = Math.max(now() + 30_000, due);
    const existing = await alarms.get(WORKFLOW_WAKE_ALARM);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
      await alarms.create(WORKFLOW_WAKE_ALARM, { when });
    }
    if (!(await alarms.get(WORKFLOW_RECONCILE_ALARM))) {
      await alarms.create(WORKFLOW_RECONCILE_ALARM, { periodInMinutes: 1 });
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
          if (shouldDispatch) await rpc('runDueWorkflows', { now: now() });
          await syncAlarms();
        } catch (error) {
          onError('[workflow] wakeup reconciliation failed', error);
          try {
            if (!(await alarms.get(WORKFLOW_RECONCILE_ALARM))) {
              await alarms.create(WORKFLOW_RECONCILE_ALARM, { periodInMinutes: 1 });
            }
          } catch (alarmError) { onError('[workflow] recovery alarm failed', alarmError); }
          pending = false;
          dispatch = false;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function onAlarm(alarm) {
    if (alarm?.name !== WORKFLOW_WAKE_ALARM && alarm?.name !== WORKFLOW_RECONCILE_ALARM) return;
    return reconcile({ runDue: true });
  }

  return { reconcile, onAlarm };
}
