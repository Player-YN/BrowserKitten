/**
 * Task-scoped trajectory download control (outside .md-body so re-renders cannot swallow clicks).
 * Orchestrator injects session/lang/toast deps via createTrajectoryUi().
 */

import { TRAJECTORY_SCHEMA } from '../brand.js';
import { mergeSessionTranscriptMessages } from './sessionIsolation.js';

/**
 * @typedef {object} TrajectoryUiDeps
 * @property {(key: string) => string} t
 * @property {() => string} getLang
 * @property {() => boolean} isExportEnabled
 * @property {() => Array<{id?: string, trajectory?: {runs?: any[]}, messages?: any[]}>} getSessions
 * @property {() => string} getActiveSessionId
 * @property {(msg: string, opts?: {error?: boolean, ms?: number}) => void} showToast
 * @property {() => void} [scrollTaskStream]
 * @property {(session: object) => void} ensureSessionTrajectory
 * @property {(doc: object) => string} trajectoryToDownloadJson
 * @property {(opts: object) => object} [serializeBehaviorTrajectory]
 * @property {(sessionId: string) => Promise<object>} [fetchWorkspaceSession]
 * @property {() => string|number|undefined} [getConstitutionVersion]
 * @property {(json: string, filename: string, doc: object) => void} [saveFile]
 */

/**
 * @param {TrajectoryUiDeps} deps
 */
export function createTrajectoryUi(deps) {
  /**
   * @param {{ el?: HTMLElement, body?: HTMLElement, thoughtText?: string, title?: string }} task
   * @param {string} runId
   * @param {{ thoughtText?: string, title?: string }} [extra]
   */
  function mountTaskTrajectoryButton(task, runId, extra = {}) {
    if (!task || !runId) return;
    const host = task.body || task.el?.querySelector?.('.task-body');
    if (!host) return;

    let row = host.querySelector('.task-traj-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'task-traj-row';
      host.appendChild(row);
    }
    let btn = row.querySelector('.task-traj-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-traj-btn';
      row.appendChild(btn);
    }
    btn.disabled = false;
    btn.textContent = deps.t('downloadTaskTrajectory');
    btn.title = deps.t('trajectoryThoughtWarn');
    btn.dataset.runId = String(runId);
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadTaskTrajectory(btn.dataset.runId || runId, {
        thoughtText: extra.thoughtText || task.thoughtText || '',
        title: extra.title || task.title || ''
      });
    };
    row.querySelector('.task-traj-warn')?.remove();
    deps.scrollTaskStream?.();
  }

  /**
   * @param {string} runId
   * @param {{ thoughtText?: string, title?: string }} [extra]
   */
  async function downloadTaskTrajectory(runId, extra = {}) {
    const currentLang = deps.getLang?.() || 'zh';
    if (!deps.isExportEnabled?.()) {
      deps.showToast(
        currentLang === 'en'
          ? 'Trajectory export disabled in Settings'
          : '轨迹导出未启用 — 请在 ⚙️ 设置中开启「开发者：启用轨迹导出」',
        { error: true }
      );
      return;
    }
    const sessions = deps.getSessions?.() || [];
    const activeSessionId = deps.getActiveSessionId?.();
    const activeSess = sessions.find((s) => s.id === activeSessionId);
    if (!activeSess) {
      deps.showToast(currentLang === 'en' ? 'No task' : '无任务', { error: true });
      return;
    }
    try {
      deps.ensureSessionTrajectory?.(activeSess);
      let workspace = null;
      try {
        workspace = await deps.fetchWorkspaceSession?.(String(activeSess.id));
      } catch {
        /* fall back to cached messages */
      }
      const messages = mergeSessionTranscriptMessages(workspace?.messages, activeSess.messages);
      const serialize =
        deps.serializeBehaviorTrajectory ||
        ((opts) => ({
          schema: TRAJECTORY_SCHEMA,
          kind: 'audit',
          exportedAt: new Date().toISOString(),
          conversation: {
            sessionId: opts.session?.sessionId || '',
            title: opts.session?.title || extra.title || ''
          },
          turns: []
        }));
      const doc = serialize({
        session: {
          sessionId: activeSess.id || activeSessionId,
          title: workspace?.title || extra.title || activeSess.name || '',
          messages
        },
        messages,
        sessionAudit: workspace?.audit
      });
      const json = deps.trajectoryToDownloadJson(doc);
      const sid = String(activeSess.id || runId || 'session').replace(/[^\w.-]+/g, '_').slice(0, 40);
      const filename = `browserbot-trajectory-${sid}.json`;
      const thoughtWarn = deps.t('trajectoryThoughtWarn');
      if (thoughtWarn) deps.showToast(thoughtWarn);
      const s = doc.summary || {};
      const doneMsg =
        currentLang === 'en'
          ? `Trajectory downloaded (${s.turns || 0} turns, ${s.tools || 0} tools)`
          : `轨迹已下载（${s.turns || 0} 轮 · ${s.tools || 0} 次工具）`;
      if (typeof deps.saveFile === 'function') {
        deps.saveFile(json, filename, doc);
        deps.showToast(doneMsg);
        return;
      }
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });

      const dataUrl =
        'data:application/json;charset=utf-8,' + encodeURIComponent(json);
      if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download(
          { url: dataUrl, filename, saveAs: true, conflictAction: 'uniquify' },
          (id) => {
            if (chrome.runtime.lastError) {
              try {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                deps.showToast(doneMsg);
              } catch (e2) {
                deps.showToast(
                  (currentLang === 'en' ? 'Download failed: ' : '下载失败: ') +
                    (chrome.runtime.lastError.message || e2?.message || e2),
                  { error: true }
                );
              }
            } else {
              deps.showToast(doneMsg);
            }
          }
        );
        return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      deps.showToast(doneMsg);
    } catch (e) {
      console.warn('[BrowserBot] task trajectory download failed', e);
      deps.showToast(
        currentLang === 'en' ? 'Download failed' : '下载失败: ' + (e?.message || e),
        { error: true }
      );
    }
  }

  return {
    mountTaskTrajectoryButton,
    downloadTaskTrajectory
  };
}
