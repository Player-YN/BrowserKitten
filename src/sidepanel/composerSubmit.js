/**
 * Composer submit keys and the waiting-prompt queue.
 * Enter inserts a newline. Modified Enter sends or interrupts.
 */

/**
 * @param {{ key?: string, shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean, isComposing?: boolean, keyCode?: number }} event
 * @returns {'ignore'|'newline'|'send'|'send-now'}
 */
export function composerEnterAction(event) {
  if (!event || event.isComposing || event.keyCode === 229) return 'ignore';
  if (event.key !== 'Enter') return 'ignore';
  if (event.metaKey || event.ctrlKey) return event.shiftKey ? 'send-now' : 'send';
  return 'newline';
}

/** Move the matching item to the front. Unknown ids leave the list unchanged. */
export function promoteQueueItem(queue, id) {
  const list = Array.isArray(queue) ? queue.slice() : [];
  const idx = list.findIndex((item) => item && item.id === id);
  if (idx <= 0) return list;
  const [item] = list.splice(idx, 1);
  list.unshift(item);
  return list;
}

export function removeQueueItem(queue, id) {
  return (Array.isArray(queue) ? queue : []).filter((item) => item && item.id !== id);
}
