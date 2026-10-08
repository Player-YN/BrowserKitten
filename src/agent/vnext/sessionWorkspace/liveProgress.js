/**
 * Live progress for the current agent turn.
 * Host tool events are a fallback lamp. Model text before/during tools is
 * commentary (not the final bubble). Final text only after stop + no pending tools.
 * The user-visible copy of that commentary is the host `progress-note` event
 * (progressNotes.js → turn timeline); this reducer never paints it.
 */

const COMMENTARY_MAX = 160;

export function createLiveProgressState() {
  return {
    visible: false,
    label: '',
    itemTotal: 0,
    itemSeen: 0,
    seenItemIds: [],
    phase: 'unknown',
    buffer: '',
    pendingTools: 0,
    answerChunk: '',
    answerFlush: ''
  };
}

function zh(lang) {
  return String(lang || 'zh').toLowerCase().startsWith('zh');
}

function inspectView(args) {
  return String(args?.view || 'groups');
}

function finishIsToolCalls(fr) {
  const s = typeof fr === 'string' ? fr : fr && typeof fr === 'object' ? fr.unified || fr.reason || '' : '';
  return /tool-call/i.test(String(s));
}

/** First 1–2 sentences for the progress row. */
export function clipCommentary(text, max = COMMENTARY_MAX) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const parts = t.split(/(?<=[。！？.!?])\s+/).filter(Boolean);
  let out = parts.slice(0, 2).join(parts[0] && /[。！？]$/.test(parts[0]) ? '' : ' ');
  if (out.length > max) out = `${out.slice(0, max).trim()}…`;
  return out;
}

function withClearAnswers(next) {
  next.answerChunk = '';
  next.answerFlush = '';
  return next;
}

function applyHostLamp(next, ev, isZh) {
  // Host current/next now live on turn disclosure. Keep bookkeeping only.
  next.visible = false;
  void isZh;
  const type = String(ev?.type || '');
  if (type === 'tool-call') {
    const name = String(ev.name || ev.tool || '');
    const args = ev.args || ev.input || {};
    if (name === 'clarify') {
      next.visible = false;
      next.phase = 'unknown';
      return next;
    }
    if (name === 'inspect') {
      const view = inspectView(args);
      if (view === 'item') {
        const id = String(args.itemId || '');
        if (id && !next.seenItemIds.includes(id)) {
          next.seenItemIds.push(id);
          next.itemSeen = next.seenItemIds.length;
        } else if (!id) {
          next.itemSeen = Math.max(1, next.itemSeen + 1);
        }
        const n = Math.max(1, next.itemSeen);
        const tot = next.itemTotal;
        next.label =
          tot > 0
            ? isZh
              ? `正在查看第 ${n}/${tot} 张`
              : `Reading image ${n} of ${tot}`
            : isZh
              ? `正在查看第 ${n} 张`
              : `Reading image ${n}`;
        next.visible = false;
        return next;
      }
      if (view === 'group' || view === 'groups') {
        next.label = isZh ? '正在查看已瞄准的内容' : 'Looking at aimed items';
        next.visible = false;
        return next;
      }
      if (view === 'skill' || view === 'skills') {
        next.label = isZh ? '正在查阅做法' : 'Reading a playbook';
        next.visible = false;
        return next;
      }
      if (view === 'artifacts' || view === 'files') {
        next.label = isZh ? '正在查看文件' : 'Looking at files';
        next.visible = false;
        return next;
      }
    }
    if (name === 'acquire') {
      const action = String(args.action || '');
      if (action === 'image') next.label = isZh ? '正在生成图片' : 'Generating image';
      else if (action === 'fetch') next.label = isZh ? '正在获取文件' : 'Fetching a file';
      else if (action === 'search') next.label = isZh ? '正在检索公开网' : 'Searching the public web';
      else if (action === 'map') next.label = isZh ? '正在列出站点页面' : 'Listing site URLs';
      else if (action === 'crawl') next.label = isZh ? '正在抓取站点页面' : 'Crawling a few site pages';
      else next.label = isZh ? '正在获取内容' : 'Acquiring content';
      next.visible = false;
      return next;
    }
    if (name === 'run') {
      const object = String(args.name || args.path || args.title || args.entry || args.entryFile || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split('/')
        .filter(Boolean)
        .pop();
      const op = String(args.op || '');
      if (object) next.label = isZh ? `正在写 ${object}` : `Writing ${object}`;
      else if (op === 'write_artifact' || op === 'update_artifact' || op === 'write_package_file') {
        next.label = isZh ? '正在写入文件' : 'Writing a file';
      } else if (op === 'write_scratch') next.label = isZh ? '正在写临时文件' : 'Writing a scratch file';
      else if (op === 'sheet' || op === 'createWorkbook') next.label = isZh ? '正在登记表格' : 'Registering a sheet';
      else if (op === 'doc' || op === 'createDocument') next.label = isZh ? '正在登记文档' : 'Registering a document';
      else next.label = isZh ? '正在运行访客代码' : 'Running guest code';
      next.visible = false;
      return next;
    }
    if (name === 'action') {
      const op = String(args.op || '');
      const object = String(args.name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
      if (op === 'click' || op === 'pointer') next.label = isZh ? `正在点击${object ? ` ${object}` : ''}` : `Clicking${object ? ` ${object}` : ''}`;
      else if (op === 'fill' || op === 'fill_form') next.label = isZh ? `正在填写${object ? ` ${object}` : ''}` : `Filling${object ? ` ${object}` : ''}`;
      else if (op === 'snapshot') next.label = isZh ? '正在读取当前标签' : 'Reading the current tab';
      else if (op === 'listen') next.label = isZh ? '正在听当前标签' : 'Listening to the tab';
      else if (op === 'wait') next.label = isZh ? '正在等待页面' : 'Waiting on the page';
      else if (op === 'upload') next.label = isZh ? '正在上传文件' : 'Uploading a file';
      else next.label = isZh ? '正在操作页面' : 'Acting on the page';
      next.visible = false;
      return next;
    }
    if (name === 'web') {
      next.label = String(args.act || '') === 'read' ? (isZh ? '正在读取网站' : 'Reading the site') : isZh ? '正在写网站' : 'Writing the site';
      next.visible = false;
      return next;
    }
    if (name === 'sheet') {
      next.label = String(args.act || '') === 'read' ? (isZh ? '正在读取表格' : 'Reading the sheet') : isZh ? '正在写表格' : 'Writing the sheet';
      next.visible = false;
      return next;
    }
    if (name === 'doc') {
      next.label = String(args.act || '') === 'read' ? (isZh ? '正在读取文档' : 'Reading the document') : isZh ? '正在写文档' : 'Writing the document';
      next.visible = false;
      return next;
    }
    if (name === 'task') {
      const op = String(args.op || '');
      if (op === 'wait') next.label = isZh ? '正在登记等待' : 'Scheduling a wait';
      else if (op === 'complete') next.label = isZh ? '正在完成任务' : 'Completing the task';
      else next.label = isZh ? '正在更新任务' : 'Updating the task';
      next.visible = false;
      return next;
    }
    return next;
  }

  if (type === 'tool-result') {
    const name = String(ev.name || ev.tool || '');
    const result = ev.result || ev.output || {};
    if (name === 'inspect' && result.view === 'group') {
      const total = Number(result.total);
      if (Number.isFinite(total) && total > 0) {
        next.itemTotal = total;
        if (!(next.phase === 'commentary' && next.buffer.trim())) {
          next.label = isZh
            ? `已瞄准 ${total} 项，正在查看`
            : `${total} aimed items, reading…`;
          next.visible = false;
        }
      }
    }
    return next;
  }

  if (type === 'pixels') {
    if (next.phase === 'commentary' && next.buffer.trim()) return next;
    const n = Math.max(next.itemSeen, 1);
    const tot = next.itemTotal;
    next.label =
      tot > 0
        ? isZh
          ? `正在读取第 ${n}/${tot} 张`
          : `Loading image ${n} of ${tot}`
        : isZh
          ? '正在读取图片'
          : 'Reading image pixels';
    next.visible = false;
    return next;
  }

  if (type === 'image_request') {
    if (next.phase === 'commentary' && next.buffer.trim()) return next;
    next.label = isZh ? '正在生成图片' : 'Generating image';
    next.visible = false;
    return next;
  }

  if (type === 'image') {
    if (next.phase === 'commentary' && next.buffer.trim()) return next;
    next.label = isZh ? '图片已写入文件' : 'Image saved to files';
    next.visible = false;
    return next;
  }

  if (type === 'image_error') {
    next.label = isZh ? '生成图片未成功' : 'Image generation failed';
    next.visible = false;
    return next;
  }

  return next;
}

function useCommentaryLabel(next) {
  const clipped = clipCommentary(next.buffer);
  if (clipped) {
    next.label = clipped;
    next.visible = false;
  }
  return next;
}

/**
 * @param {ReturnType<typeof createLiveProgressState>} state
 * @param {object} ev
 * @param {string} [lang]
 * @returns {ReturnType<typeof createLiveProgressState>}
 */
export function applyLiveProgress(state, ev, lang = 'zh') {
  const prev = state && typeof state === 'object' ? state : createLiveProgressState();
  const next = withClearAnswers({
    visible: prev.visible,
    label: prev.label,
    itemTotal: prev.itemTotal || 0,
    itemSeen: prev.itemSeen || 0,
    seenItemIds: Array.isArray(prev.seenItemIds) ? [...prev.seenItemIds] : [],
    phase: prev.phase || 'unknown',
    buffer: prev.buffer || '',
    pendingTools: Number(prev.pendingTools) || 0
  });
  const type = String(ev?.type || '');
  const isZh = zh(lang);

  if (type === 'execution-start') return createLiveProgressState();
  // Terminal settle: drop stale host lamps (e.g. 正在获取文件) even if tool-result was lost.
  if (type === 'execution-end') return createLiveProgressState();
  if (type === 'error') {
    next.visible = false;
    next.phase = 'unknown';
    next.label = ev.message ? String(ev.message).slice(0, COMMENTARY_MAX) : next.label;
    return next;
  }
  if (type === 'clarify' || type === 'clarify-done' || type === 'assistant-final') {
    next.visible = false;
    next.phase = 'unknown';
    next.buffer = '';
    next.pendingTools = 0;
    return next;
  }

  if (type === 'model-start') {
    next.buffer = '';
    if (next.pendingTools === 0) next.phase = 'unknown';
    return next;
  }

  if (type === 'text') {
    const chunk = String(ev.chunk || ev.text || '');
    if (!chunk || chunk === '[object Object]') return next;
    next.buffer += chunk;
    if (next.phase === 'final') {
      next.answerChunk = chunk;
      next.visible = false;
      return next;
    }
    // Mid-turn prose is the progress row only. Promoting it to a bubble
    // before model-end makes the same text appear twice when tools follow.
    next.phase = next.pendingTools > 0 || next.phase === 'commentary' ? 'commentary' : 'unknown';
    return next;
  }

  if (type === 'tool-call') {
    next.pendingTools += 1;
    next.phase = 'commentary';
    applyHostLamp(next, ev, isZh);
    return next;
  }

  if (type === 'tool-result' || type === 'tool-execution-end') {
    next.pendingTools = Math.max(0, next.pendingTools - 1);
    applyHostLamp(next, ev, isZh);
    if (next.pendingTools === 0 && String(ev.name || ev.tool || '') === 'acquire') {
      next.visible = false;
    }
    return next;
  }

  if (type === 'model-end') {
    if (finishIsToolCalls(ev.finishReason)) {
      next.phase = 'commentary';
      return next;
    }
    if (next.pendingTools === 0) {
      next.phase = 'final';
      if (next.buffer.trim()) next.answerFlush = next.buffer;
      next.visible = false;
      next.buffer = '';
      return next;
    }
    return next;
  }

  return applyHostLamp(next, ev, isZh);
}
