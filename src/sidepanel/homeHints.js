/**
 * Fixed homepage chips. Short labels; click fills the composer with a
 * short natural question and sends. No playbook, no hidden brief.
 * create-personal-tool = 油猴脚本-style 工具; create-workflow = RPA
 * (自动点击 / 自动填写); use-browser-kitten = Session Agent on a live tab.
 */

export const HOME_HINT_IDS = Object.freeze([
  'create-personal-tool',
  'create-workflow',
  'use-browser-kitten'
]);

const HINT_KEYS = Object.freeze({
  'create-personal-tool': { label: 'teachCreateToolLabel', prompt: 'teachCreateToolPrompt' },
  'create-workflow': { label: 'teachCreateWorkflowLabel', prompt: 'teachCreateWorkflowPrompt' },
  'use-browser-kitten': { label: 'teachUseProductLabel', prompt: 'teachUseProductPrompt' }
});

/**
 * @param {(key: string) => string} t
 * @returns {{ id: string, label: string, prompt: string }[]}
 */
export function getHomeHints(t) {
  const tr = typeof t === 'function' ? t : (key) => key;
  return HOME_HINT_IDS.map((id) => {
    const keys = HINT_KEYS[id];
    return { id, label: tr(keys.label), prompt: tr(keys.prompt) };
  });
}
