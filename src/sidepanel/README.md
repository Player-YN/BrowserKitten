# Side panel modules (vanilla)

产品分层见根 [AGENTS.md](../../AGENTS.md)；宿主 RPC 见 [../AGENTS.md](../AGENTS.md)。

Production UI entry remains **`src/sidepanel.html`** → **`src/sidepanel.js`** (orchestrator).

## CSS load order

Linked from `sidepanel.html` (do not reorder without reason):

| Order | File | Role |
|------:|------|------|
| 1 | `css/tokens.css` | Theme tokens (black+rose / 汉白玉+amber) |
| 2 | `css/layout.css` | Height chain, chrome shrink, task-stream scrollport, **container queries** |
| 3 | `css/motion.css` | Ambient, send/stop rings, reduced-motion |
| 4 | `sidepanel.css` | Components / surfaces leftovers |

### Container queries + density (P3)

`.panel` sets `container-type: inline-size` + `container-name: panel`.

| Query / flag | Behavior |
|--------------|----------|
| `@container panel (max-width: 340px)` | Hide `.page-url` and `#turnJumpRail`, stack `.composer-meta` / `.sel-toolbar`, hide `.brand-sub`; disclosure drops page/access chips; live rows hide unless sticky |
| `@container panel (max-width: 280px)` | Visually hide status label, hide composer hint, chip short label (`Guarded`/`Full`); live disclosure keeps one current line; fold line wraps |
| `data-density="compact"` on `.panel` | JS mirror when panel width &lt; 320 (`density.js` ResizeObserver); same density tokens as mid-narrow |

Prefer container queries over viewport media for side-panel chrome (width is the panel, not the OS window). Density tokens live in `css/tokens.css` (`--density-*`).

### Popover menus (P3)

Clipboard **Export ▾** (`#clipExportMenu`) uses the **native Popover API** when `HTMLElement.prototype.showPopover` exists (`popoverMenu.js` + light-dismiss + fixed position under trigger). Fallback: existing `hidden` toggle + outside-click. Styles use design tokens; open state is top-layer (no z-index stacking wars). Enter animation `pw-popover-in` is gated by reduced-motion in `motion.css`.

## JS layout

```
src/sidepanel/
  css/tokens.css
  css/layout.css
  css/motion.css
  dom.js             # $, escapeHtml, sanitizeModelHtml, truncateUi
  theme.js           # system | light | dark (+ color-scheme)
  sendStop.js        # send↔stop morph UI
  hoverDrawer.js     # hover-intent FSM (clip/history/drafts)
  icons.js           # SVG composer icons
  scroll.js          # whole-panel #panelScroll wheel + edge fades
  dialog.js          # native <dialog> open/close + return-focus
  popoverMenu.js     # native popover + click-toggle fallback (clip export)
  density.js         # data-density=compact via ResizeObserver
  i18n.js            # I18N tables + createT / getDict / translate
  trajectoryUi.js    # mountTaskTrajectoryButton + downloadTaskTrajectory
  sessionIsolation.js # session-scoped broadcast / plan-card / preview-tab match
  executionSync.js   # parse offscreen activeExecution (live run vs leftover store rows)
  taskStatus.js      # durable task cards; listTasks scoped to active session
  thinkUi.js         # one think bar per turn; Enter/Space + aria-expanded; seal keeps body
  executionStatus.js # host-fact current / next=task.nextAction only; approval/journal phases; disclosureMode
  botStatusUi.js     # hidden announcer; nextStatusCopy meta only when no nextAction
  turnDisclosureUi.js # per-turn instrument under think; fold / hydrate / exclusive open
  contextUsageUi.js  # composer Context ring + hover usage popover (estimate vs api)
  accessPolicyUi.js  # Guarded / Full Access chip + one-time risk dialog
  approvalUi.js      # host delete/ambiguous approval; payment wait has no approve button
  tabLeaseUi.js      # TAB_LEASED / NEED_EXPLICIT_TAB human copy (no new-profile flow)
  README.md
```

`sidepanel.js` still owns `currentLang`, session state, and agent event loop; domain modules take deps/getters.

## Layout contract (whole-panel scroll)

**Product rule:** one scroll for the entire side panel — not nested scrolls per section.
History and the live task share `.thread-workspace` (same block). Sticky: topbar + composer.

Source of truth: **`css/layout.css`**.

| Surface | Rule |
|--------|------|
| `html`, `body`, `.panel` | `height: 100%`, shell `overflow: hidden` |
| **`#panelScroll`** | **Only** vertical scrollport: `flex: 1 1 0%`, `overflow-y: auto` |
| Sticky | `.topbar` + `.composer` (outside the scroll root) |
| Same-level blocks in scroll | context, selection, drafts, **`.thread-workspace`** (history + task-stream) — all `overflow: visible`, no nested max-height traps |
| `#taskStream` | document flow only (not a scrollport) |
| History | lives **inside** `.thread-workspace` with the live task |
| Durable task cards | `taskStatus.js`：仅 `ready` / `running` / `waiting` / `paused` 显著；终态（completed/failed/cancelled）折进 `<details>`。无 live task 时不画空「进行中」区 |
| Tab lease copy | `TAB_LEASED` / `NEED_EXPLICIT_TAB` 走 `tabLeaseUi.js` + `i18n.tabLeased` / `needExplicitTab`；文案是停对方或换标签，不引导新 Chrome profile |

`scroll.js` scrolls `#panelScroll` and applies edge fades to it.

## Control layer

Critical actions (trajectory download, skill save, script quick-run) mount on **`.task-actions` / `.task-traj-row`** inside `.task-body`, **outside** `.md-body`. Markdown re-render (`innerHTML`) must not swallow click handlers.

Trajectory controls live in **`trajectoryUi.js`** (`createTrajectoryUi({ t, getLang, getSessions, … })`).

## Rules

1. Prefer new UI helpers here; keep agent imports in `sidepanel.js` until a full domain split.
2. Target: no single new file > ~400 LOC; orchestrator shrinks over time.
3. Theme storage: `browserbot_theme_mode`. Resolved theme also sets `color-scheme` on `html`/`body`.
4. React scaffold is archived under `archive/ui-react-scaffold/`.
5. i18n: edit strings in `i18n.js`; orchestrator keeps `currentLang` + `applyI18n()`.

Durable task cards（`taskStatus.js`）≠ 对话流里的 live `.task-card`（仍在 `sidepanel.js` 的 `createTaskCard`）。

`/plan` 与 task-start/amend 确认卡在线程里是 `.clarify-live.is-plan`。普通计划卡多一项默认勾选的「同时开启长任务」；task-start/amend 不加这项。批准 / 拒绝 / 提交修改后立刻收成一行 `.plan-receipt`（默认折叠，只留「已批准|未批准|需修改 · 标题」），不把完整步骤留在画面上。展开才能再看摘要和步骤。

对话流里右对齐的粉胶囊是 **用户气泡**（`.msg.user`）。文案刚好是「继续」时也不是控件：durable `resume` 只出现在 `paused` 任务卡上；clarify 的「继续」只在多问题澄清条里。思考条复用逻辑在 `thinkUi.js`（一轮一条，禁止再叠一条「思考中」）。有真实 provider thought 时块必须在：流式与封条后都可展开，默认折叠，`aria-expanded` 与 Enter/Space。行动摘要不能顶替它。`#turnJumpRail` 走右槽，不盖思考条展开箭头。

`#botStatus` 已降级为隐藏 polite announcer（另有 `#botStatusLive` / `#botStatusAssertive`）。完成后不再在会话顶画完成/目标页/瞄准/任务大卡。运行中的 `.turn-disclosure` 是 Sider 式小图标活动列表：每行左侧小灰 emoji（思考 💡 / 读取 📖 / 运行 🔧 / 页面 ✨ / 写入 ✏️），右侧短灰字；流光/脉冲只扫**最新一行**活动标签字形（思考条「思考中」有行动行后不再扫字，只留圆点）；先前行保持静止灰字，不卸挂（窄栏仍只留当前行）。不画 next、租约占用、政策 chip、页面 snapshot「读取当前标签」、也不把 inspect/`run`/page-read 算进交付物。无 provider thought 时披露仍占思考块下方同一位置，不造假思考块。完成 / 停止 / 失败 / 取消一律立刻折成一行 `完成|已停止|失败 · {duration} · {n} 个交付物`（默认折叠，按需 hydrate；`n` 只计会话 artifact），不留开放的活动列表或「客代码」行。只有等待用户、宿主审批、租约冲突、durable 暂停、needs_human 保持展开。`#accessPolicyChip` 在 composer 浮层常驻，不跟大卡隐藏。审批/付款卡在披露下方，折叠完成墙不得盖住它们。next 仍只来自 `task.nextAction`，且不画进直播摘要。历史摘要按 `executionId` 展开时才 hydrate，同时只开一张，内存完整投影只留 8 轮。思考块合同不变（卡片 chrome），状态不从 thought 推断。Stop 走 `abortCurrentExecution({sessionId})`。选区是可选瞄准，不是权限门。

交付物轨主 chip 是五家族（`docs` / `data` / `web` / `media` / `files`）。`design`/`slides` 不是主 chip，legacy 数据折进其它。打开面与徽标由 `artifactCapability.js` 单一映射驱动；未知文件进检查器，text-like 安全只读，未知 HTML/JS 不在 extension origin 执行。

## Next extractions candidates

- `taskCard.js` (createTaskCard, makeCollapsibleThinking) — conversation turn card, not durable task
- `selection.js` (renderSelectionUI, picker state)
- `task/events.js` (agent stream → DOM)
- `drafts/card.js`
- Optional `a11y.css` if focus/dialog rules grow further
