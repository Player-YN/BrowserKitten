/**
 * Account notices shown as a card in the conversation, right after the turn that hit
 * them, instead of a bar that pushes the panel down. One card per kind at a time; a
 * new send clears them.
 *
 *   credits  402 CREDITS_EXHAUSTED  → buy a booster / see plans
 *   limit    429 USAGE_LIMIT        → weekly cap: when it frees up, boosters still work
 *   byok     own key without a plan → see plans (or sign in)
 *   upgrade  426                    → update the extension
 *   paused   503 SERVICE_PAUSED     → the operator's message
 *   scripts  a task needed page scripts → turn them on / open the details page
 */

/**
 * What a card says and offers. Pure, for tests.
 * @param {{ kind: string, resetAt?: string, message?: string }} notice
 * @param {{ t: (key: string) => string, signedIn: boolean, formatDate: (iso: string) => string }} ctx
 * @returns {{ kind: string, title: string, body: string, actions: { id: string, label: string, primary?: boolean }[] } | null}
 */
export function noticeCardModel(notice, ctx) {
  const { t } = ctx;
  if (!notice) return null;
  switch (notice.kind) {
    case 'credits':
      return {
        kind: 'credits',
        title: t('noticeCreditsTitle'),
        body: t('noticeCreditsBody'),
        actions: [
          { id: 'booster', label: t('noticeBuyBooster'), primary: true },
          { id: 'plans', label: t('byokSeePlans') }
        ]
      };
    case 'limit': {
      const when = notice.resetAt ? ctx.formatDate(notice.resetAt) : '';
      return {
        kind: 'limit',
        title: t('noticeLimitTitle'),
        body: (when ? t('noticeLimitBodyAt').replace('{when}', when) : t('noticeLimitBody')),
        actions: [
          { id: 'booster', label: t('noticeBuyBooster'), primary: true },
          { id: 'plans', label: t('byokSeePlans') }
        ]
      };
    }
    case 'byok':
      return {
        kind: 'byok',
        title: t('byokPlanNeeded'),
        body: t('noticeByokBody'),
        actions: ctx.signedIn
          ? [{ id: 'plans', label: t('byokSeePlans'), primary: true }]
          : [
              { id: 'sign-in', label: t('cloudSignIn'), primary: true },
              { id: 'plans', label: t('byokSeePlans') }
            ]
      };
    case 'upgrade':
      return {
        kind: 'upgrade',
        title: t('cloudUpgradeNeeded'),
        body: t('noticeUpgradeBody'),
        actions: [{ id: 'update', label: t('cloudUpdateNow'), primary: true }]
      };
    case 'scripts':
      return notice.state === 'needs-toggle'
        ? {
            kind: 'scripts',
            title: t('noticeScriptsTitle'),
            body: t('advancedScriptsNeedsToggle'),
            actions: [{ id: 'open-details', label: t('advancedOpenDetails'), primary: true }]
          }
        : {
            kind: 'scripts',
            title: t('noticeScriptsTitle'),
            body: t('noticeScriptsBody'),
            actions: [{ id: 'enable-scripts', label: t('advancedScriptsEnable'), primary: true }]
          };
    case 'paused':
      return {
        kind: 'paused',
        title: t('noticePausedTitle'),
        body: notice.message || t('cloudPausedDefault'),
        actions: []
      };
    default:
      return null;
  }
}

/**
 * Render a card at the end of the conversation.
 * @param {HTMLElement} stream  the conversation container
 * @param {ReturnType<typeof noticeCardModel>} model
 * @param {(actionId: string, card: HTMLElement) => void} onAction
 * @param {string} dismissLabel
 */
export function showNoticeCard(stream, model, onAction, dismissLabel) {
  if (!stream || !model) return null;
  stream.querySelector(`.notice-card[data-kind="${model.kind}"]`)?.remove();
  const card = document.createElement('section');
  card.className = 'notice-card';
  card.dataset.kind = model.kind;
  card.setAttribute('role', 'status');
  const title = document.createElement('p');
  title.className = 'notice-card-title';
  title.textContent = model.title;
  const body = document.createElement('p');
  body.className = 'notice-card-body';
  body.textContent = model.body;
  const row = document.createElement('div');
  row.className = 'notice-card-actions';
  for (const a of model.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${a.primary ? 'btn-primary' : 'btn-secondary'} notice-card-btn`;
    btn.textContent = a.label;
    btn.addEventListener('click', () => onAction(a.id, card));
    row.appendChild(btn);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notice-card-close';
  close.setAttribute('aria-label', dismissLabel);
  close.textContent = '×';
  close.addEventListener('click', () => card.remove());
  card.append(close, title, body);
  if (model.actions.length) card.appendChild(row);
  stream.appendChild(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return card;
}

export function clearNoticeCards(stream) {
  stream?.querySelectorAll('.notice-card').forEach((el) => el.remove());
}
