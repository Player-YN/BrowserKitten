/**
 * Compact “?” shortcuts popover for preview host chrome.
 * Surface-specific list only. Esc closes. Does not steal tab focus.
 */

import { officeUiLang } from './officeLocale.js';

function lang() {
  try {
    const htmlLang = String(document.documentElement?.lang || '');
    if (/^en/i.test(htmlLang)) return 'en';
    if (/^zh/i.test(htmlLang)) return 'zh';
  } catch {
    /* */
  }
  return officeUiLang();
}

function modKey() {
  try {
    if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')) {
      return '⌘';
    }
  } catch {
    /* */
  }
  return 'Ctrl';
}

const COPY = {
  zh: {
    title: '快捷键',
    help: '快捷键',
    zoomIn: '放大画布',
    zoomOut: '缩小画布',
    zoomFit: '适应窗口 / 100%',
    zoomFit100: '缩放到 100%',
    save: '保存到当前文件',
    escape: '取消选择 / 关闭菜单',
    undo: '撤销',
    redo: '重做',
    selectAll: '全选节点',
    deleteSel: '删除已点选节点',
    duplicate: '复制节点',
    nudge: '微移已点选节点',
    pin: '加减点选',
    page: '上一页 / 下一页（PageUp / PageDown；放映时方向键）',
    present: '放映 / 退出放映',
    overview: '胶片条「总览」看全部幻灯片',
    newSlide: '胶片条「+ 幻灯片」插入空白 16:9',
    reorderSlide: '胶片条聚焦时：Alt+Shift+左右箭头调整幻灯片顺序（不占用方向键微移）',
    pagesMenu: '左上角 Page 菜单可新建 / 切换画布分区（不是幻灯片）',
    insertImage: '「插入图片」从工作区选栅格；也可拖到画布或用引擎 Asset',
    sitePick: '侧栏「点选」关闭时浏览（链接可跳转）；打开后点击才点选。',
    designEngine:
      '画板引擎已提供：V 选择 · T 文字 · R 矩形 · O 椭圆 · F 画板 · A 箭头 · L 线 · N 便利贴 · 空格平移 · 方向键微移 · Ctrl+D 复制 · G 编组 · Ctrl+Z 撤销 · Delete 删除 · Ctrl+A 全选 · K 激光笔 · Ctrl+U 插入媒体',
    slidesEngine: '未放映时方向键微移形状；编辑文字时方向键交给输入。默认把当前 16:9 钉在视口（不是只准一页）；总览可漫游。画板工具键仍由引擎处理。',
    sheetEngine:
      '表格引擎已提供：F2 编辑 · Tab · 方向键 · Ctrl+C/X/V · Ctrl+B/I/U · Ctrl+Z 撤销 · Ctrl+A 选择当前区域（不会整本全选）',
    docsEngine: '文档引擎已提供：常见文字编辑、Ctrl+Z 撤销、Ctrl+A 全选。'
  },
  en: {
    title: 'Shortcuts',
    help: 'Shortcuts',
    zoomIn: 'Zoom in (canvas)',
    zoomOut: 'Zoom out (canvas)',
    zoomFit: 'Fit / 100%',
    zoomFit100: 'Zoom to 100%',
    save: 'Save to this file',
    escape: 'Clear selection / close menus',
    undo: 'Undo',
    redo: 'Redo',
    selectAll: 'Select all nodes',
    deleteSel: 'Delete pinned nodes',
    duplicate: 'Duplicate nodes',
    nudge: 'Nudge pinned nodes',
    pin: 'Add/remove pin',
    page: 'Previous / next slide (PageUp / PageDown; arrows while presenting)',
    present: 'Present / exit present',
    overview: 'Filmstrip Overview shows every slide',
    newSlide: 'Filmstrip + adds a blank 16:9 slide',
    reorderSlide: 'With filmstrip focus: Alt+Shift+Left/Right reorders slides (canvas arrows still nudge)',
    pagesMenu: 'Top-left Page menu creates canvas pages (not slides)',
    insertImage: 'Insert image from the workspace; or drop / Asset tool',
    sitePick: 'Pick off = browse (links work). Pick on = pin elements.',
    designEngine:
      'Canvas engine already provides: V select · T text · R rectangle · O ellipse · F frame · A arrow · L line · N note · Space pan · arrows nudge · Ctrl+D duplicate · G group · Ctrl+Z undo · Delete · Ctrl+A select all · K laser · Ctrl+U media',
    slidesEngine: 'While not presenting, arrows nudge shapes. While editing text, arrows stay with the caret. Default view pins the current 16:9 (not a one-page cap); Overview roams. Tool keys stay with the engine.',
    sheetEngine:
      'Sheet engine already provides: F2 edit · Tab · arrows · Ctrl+C/X/V · Ctrl+B/I/U · Ctrl+Z undo · Ctrl+A current region (not the whole workbook)',
    docsEngine: 'Docs engine already provides: ordinary typing, Ctrl+Z undo, Ctrl+A select all.'
  }
};

function t() {
  return COPY[lang()] || COPY.zh;
}

function rowsFor(surface) {
  const c = t();
  const mod = modKey();
  const shared = [
    { keys: [mod, '+'], text: c.zoomIn },
    { keys: [mod, '-'], text: c.zoomOut },
    { keys: [mod, '0'], text: c.zoomFit100 },
    { keys: [mod, 'S'], text: c.save },
    { keys: ['Esc'], text: c.escape }
  ];
  if (surface === 'sheet') {
    return { rows: shared, notes: [c.sheetEngine] };
  }
  if (surface === 'docs') {
    return { rows: shared, notes: [c.docsEngine] };
  }
  if (surface === 'site') {
    return {
      rows: [
        ...shared,
        { keys: [mod, 'Z'], text: c.undo },
        { keys: [mod, 'click'], text: c.pin },
        { keys: [mod, 'A'], text: c.selectAll },
        { keys: ['Delete'], text: c.deleteSel },
        { keys: [mod, 'D'], text: c.duplicate },
        { keys: ['↑ ↓ ← →'], text: c.nudge }
      ],
      notes: [c.sitePick]
    };
  }
  return { rows: shared, notes: [] };
}

function kbd(keys) {
  return keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ensurePop() {
  let pop = document.getElementById('pawHelpPop');
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'pawHelpPop';
  pop.className = 'paw-help-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'false');
  pop.tabIndex = -1;
  document.body.appendChild(pop);
  return pop;
}

function renderPop(surface) {
  const c = t();
  const { rows, notes } = rowsFor(surface);
  const pop = ensurePop();
  pop.setAttribute('aria-label', c.title);
  const items = rows
    .map((row) => `<li><span class="paw-help-keys">${kbd(row.keys)}</span><span>${escapeHtml(row.text)}</span></li>`)
    .join('');
  const noteHtml = notes.map((n) => `<p class="paw-help-note">${escapeHtml(n)}</p>`).join('');
  pop.innerHTML = `<div class="paw-help-pop-title">${escapeHtml(c.title)}</div><ul class="paw-help-list">${items}</ul>${noteHtml}`;
  return pop;
}

function positionPop(pop, btn) {
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${Math.round(r.bottom + 4)}px`;
  const width = 280;
  let left = Math.round(r.right - width);
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  pop.style.left = `${left}px`;
  pop.style.right = 'auto';
}

export function isOfficeHelpOpen() {
  const pop = document.getElementById('pawHelpPop');
  return !!(pop && !pop.hidden);
}

export function closeOfficeHelp() {
  const pop = document.getElementById('pawHelpPop');
  if (!pop || pop.hidden) return false;
  pop.hidden = true;
  const btn = document.querySelector('[data-act="help"]');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  return true;
}

export function openOfficeHelp(surface, btn) {
  const pop = renderPop(surface);
  pop.hidden = false;
  positionPop(pop, btn);
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

export function toggleOfficeHelp(surface, btn) {
  if (isOfficeHelpOpen()) closeOfficeHelp();
  else openOfficeHelp(surface, btn);
}

function ensureButton(surface) {
  let btn = document.getElementById('helpBtn') || document.querySelector('[data-act="help"]');
  if (btn) return btn;
  const actions = document.querySelector('#bar.host-file-strip .host-file-actions');
  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'helpBtn';
  btn.className = 'paw-help-btn';
  btn.setAttribute('data-act', 'help');
  btn.textContent = '?';
  if (actions) {
    actions.appendChild(btn);
    return btn;
  }
  let dock = document.getElementById('pawHelpDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'pawHelpDock';
    dock.className = 'paw-help-dock';
    document.body.appendChild(dock);
  }
  dock.appendChild(btn);
  return btn;
}

function relabel(btn) {
  const label = t().help;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', isOfficeHelpOpen() ? 'true' : 'false');
  btn.tabIndex = 0;
}

/**
 * Mount “?” on the existing host-file-actions row, or a quiet dock on Univer chrome.
 * @param {string} surface sheet | docs | site
 */
export function mountOfficeHelp(surface) {
  const btn = ensureButton(surface);
  relabel(btn);
  if (btn.dataset.pawHelpBound) return btn;
  btn.dataset.pawHelpBound = '1';
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleOfficeHelp(surface, btn);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!isOfficeHelpOpen()) return;
    const pop = document.getElementById('pawHelpPop');
    if (pop?.contains(e.target) || btn.contains(e.target)) return;
    closeOfficeHelp();
  });
  window.addEventListener('resize', () => {
    if (isOfficeHelpOpen()) positionPop(document.getElementById('pawHelpPop'), btn);
  });
  window.__pawCloseOfficeHelp = closeOfficeHelp;
  return btn;
}
