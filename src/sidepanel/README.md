# Side panel modules (vanilla)

产品分层见根 [AGENTS.md](../../AGENTS.md)；宿主 RPC 见 [../AGENTS.md](../AGENTS.md)。

Production UI entry remains **`src/sidepanel.html`** → **`src/sidepanel.js`** (orchestrator).

## 个人工具与 Workflow

顶部两个快捷位置默认打开「工具」与「Workflow」；固定后显示条目名称，点击先收集参数再运行。旁边的「⋯」始终打开个人库，可取消固定或替换常用项。Tool 是保存的本地脚本，运行走 runner RPC，不发模型请求；Workflow 区分「Agent 任务」和「自动化」：前者走普通模型对话；后者由 `workflowUi.js` 录制、编辑、审阅和监控，通过确定性运行 RPC 执行。自动化可在没有 Key 时直接制作。所有新库项都必须从 draft 经用户点击「添加／更新」发布；正式版本在 draft 修改、试运行或失败时继续可用。

快捷入口统一使用 density 高度与圆角 token：点选为黑白反色主按钮，截图、工具、Workflow 和个人库为描边按钮；橙色用于焦点与运行提示。点选、截图、两个常用项和个人库在所有侧栏宽度下保持一行，窄栏通过减小 gap／横向 padding 和单行省略容纳；完整名称保留在 tooltip 和 accessible name。选区摘要和固定／清空控制独立排布；入口网格由 `sidepanel.css` 统一维护。

`personalLibraryUi.js` 只渲染和收集参数，不保存定义、执行脚本或发布版本。它通过注入的 `getPins/setPins` 维护最多两个常用项 ID，并由注入的 `run/create/revert/remove/import/export` 回调进入 sidepanel 编排。`collectPersonalLibraryInput(entry, { document, t })` 是个人库正式条目的参数弹窗入口，支持 runtime 的 JSON Schema 子集（string/number/integer/boolean/enum），取消返回 `null`；service 仍是最终校验者。

草稿状态卡独立于普通对话草稿栏：按当前 session 查询持久 draft，显示制作中／草稿就绪、可审查定义、刷新、试运行及明确发布。独立运行卡显示输出与停止，按 session 隔离；脚本终止事件不收束旧 Agent 对话。接收 draft/published 事件只能刷新或清理卡，不能自动发布。运行 Tool 前关闭库 modal，避免宿主审批卡被遮住。

## CSS load order

Linked from `sidepanel.html` (do not reorder without reason):

| Order | File | Role |
|------:|------|------|
| 1 | `css/tokens.css` | Theme tokens (Quiet Black / Quiet Light; see ../../Design.md) |
| 2 | `css/layout.css` | Height chain, chrome shrink, task-stream scrollport, **container queries** |
| 3 | `css/motion.css` | Starlight scroll overlay, send/stop rings, reduced-motion |
| 4 | `sidepanel.css` | Components / surfaces leftovers |

### Container queries + density (P3)

`.panel` sets `container-type: inline-size` + `container-name: panel`.

| Query / flag | Behavior |
|--------------|----------|
| `@container panel (max-width: 340px)` | Hide `.page-url` and `#turnJumpRail`, stack `.composer-meta`, hide `.brand-sub`; the quick toolbar stays one row; disclosure drops page/access chips; live rows hide unless sticky |
| `@container panel (max-width: 280px)` | Visually hide status label, hide composer hint, live disclosure keeps one current line; fold line wraps |
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
| **`#panelScroll`** | Home / no-thread document scrollport: `flex: 1 1 0%`, `overflow-y: auto` |
| Conversation open | `#panelScroll` `overflow: hidden`; **`.task-body`** is the message scrollport; **`.think-body-wrap`** is its own starlight scrollport |
| Sticky | `.topbar` + `.composer` (outside the scroll root) |
| Same-level blocks in scroll | context, selection, drafts, **`.thread-workspace`** (history + task-stream) — all `overflow: visible`, no nested max-height traps |
| `#taskStream` | document flow only (not a scrollport) |
| History | lives **inside** `.thread-workspace` with the live task |
| Durable task cards | `taskStatus.js`：仅 `ready` / `running` / `waiting` / `paused` 显著；终态（completed/failed/cancelled）折进 `<details>`。无 live task 时不画空「进行中」区 |
| Tab lease copy | `TAB_LEASED` / `NEED_EXPLICIT_TAB` 走 `tabLeaseUi.js` + `i18n.tabLeased` / `needExplicitTab`；文案是停对方或换标签，不引导新 Chrome profile |

`scroll.js` relays wheel onto the active scrollport and applies edge fades. Starlight `.is-scrolling` is per scrollport: `.think-body-wrap` wins over `.task-body` (think-block chrome does not promote to the chat bar). Only the thumb lights (6px chat / 4px think); particles clip to that pill, not a full-height column.

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

`#botStatus` 已降级为隐藏 polite announcer（另有 `#botStatusLive` / `#botStatusAssertive`）。完成后不再在会话顶画完成/目标页/瞄准/任务大卡。运行中的 `.turn-disclosure` 是 Sider 式小图标活动列表：每行左侧 14px 描边图标（思考 lightbulb / 读取 book / 运行 wrench / 页面 wand / 写入 pencil / 等待 clock / 错误 alert，`currentColor` 跟 `--ink`，不用 emoji），右侧短灰字；流光/脉冲只扫**最新一行**活动标签字形（思考条「思考中」有行动行后不再扫字，只留圆点）；先前行保持静止灰字，不卸挂（窄栏仍只留当前行）。不画 next、租约占用、政策 chip、页面 snapshot「读取当前标签」、也不把 inspect/`run`/page-read 算进交付物。无 provider thought 时披露仍占思考块下方同一位置，不造假思考块。完成 / 停止 / 失败 / 取消一律立刻折成一行 `完成|已停止|失败 · {duration} · {n} 个文件`（默认折叠，按需 hydrate；`n` 只计会话 artifact），不留开放的活动列表或「客代码」行。只有等待用户、宿主审批、租约冲突、durable 暂停、needs_human 保持展开。`#accessPolicyChip` 在 composer 浮层常驻，不跟大卡隐藏。审批/付款卡在披露下方，折叠完成墙不得盖住它们。next 仍只来自 `task.nextAction`，且不画进直播摘要。历史摘要按 `executionId` 展开时才 hydrate，同时只开一张，内存完整投影只留 8 轮。思考块合同不变（卡片 chrome），状态不从 thought 推断。Stop 走 `abortCurrentExecution({sessionId})`。选区是可选瞄准，不是权限门。

交付物轨主 chip 是五家族（`docs` / `data` / `web` / `media` / `files`）。`design`/`slides` 不是主 chip，legacy 数据折进其它。打开面与徽标由 `artifactCapability.js` 单一映射驱动；未知文件进检查器，text-like 安全只读，未知 HTML/JS 不在 extension origin 执行。

## Next extractions candidates

- `taskCard.js` (createTaskCard, makeCollapsibleThinking) — conversation turn card, not durable task
- `selection.js` (renderSelectionUI, picker state)
- `task/events.js` (agent stream → DOM)
- `drafts/card.js`
- Optional `a11y.css` if focus/dialog rules grow further


## Selector：页面内容入口

Selector 同时服务直接工具与 Bot 引用。点选负责对象识别、来源与高亮；下载、复制、导出继续走确定性工具；SelectionGroup / WebItem 负责保存资料。用户无需先点选即可发起任务。

- 顶部保留点选、截图和内容摘要；抽屉按对象、直接操作、文字剪贴板呈现，末尾「收集到」管理采集目标资料组。无内容时不显示资料组入口，也不展开空抽屉。
- 输入框旁「参考」管理 sessionBindings，状态只计实际绑定的资料组。切换采集目标不改变引用；引用不代表网页操作授权。内部 ID、RPC 和存储名称不随展示名称迁移。
- 点文字先收集到扩展剪贴板，点击条目才复制到系统剪贴板；两步反馈分别是「已收集」和「已复制」。
- 点选后保留 2 秒短暂展开，悬停打开/关闭仍为 40/480ms；固定展开保持原义。浮到 body 的资料组、导出菜单与键盘焦点属于抽屉交互，期间不自动收起。折叠内容不进入键盘焦点序列。
- 推荐提示属于 Agent 请求，明确提示点击会发送；直接工具按钮不发送对话。推荐触发和现有模型调用策略保持不变。

## Composer and access controls

- `#attachmentPreviewBar` lives **inside `.composer-inner`**, before `.composer-input-row`. Moving the composer between `#homeComposerSlot` and the footer must move previews with it. Attachments never occupy a sibling row outside the composer. Multiple previews may scroll within a 120px limit so they cannot consume the conversation viewport.
- Uploaded/captured images show thumbnails. A pasted screenshot retains its existing inline screenshot mention and pending attachment; insert that mention **before** rendering previews to avoid duplicating the image below it. Removing an attachment still only changes the outgoing pending list.
- There is no access-mode control. The top-left logo and name, and the home logo, are links to BrowserKitten.com with a faint signal glow on hover and focus; the home logo is inert while it is a watermark.
- Composer controls show model, References and artifacts. The reference button shows the bound collection count; its tooltip and `#composerAiming` accessible description report the real binding state. The unbound state has no animated call-to-action border.
- Collection destinations appear only when the selection summary has content; their tooltip and accessible description explain first-pick auto-creation. Active conversations use a neutral border; running status remains in the existing execution indicators.

Selection drawer copy stays in tooltips and accessible labels: no visible gray explanatory paragraphs or “Selected” / “Collect into” prefixes. Counts, item names, collection picker and action labels remain visible.

## 顺序自动化

`workflowUi.js` 不执行页面动作或持有存储。录制状态独立于编辑 modal；开始运行会切到执行会话并关闭 modal，让宿主审批可见。草稿编辑、固定工具版本、步骤检查与恢复边界见 [Workflow 合同](../../docs/WORKFLOW_V1.md)。运行记录不是聊天消息，刷新事件不能自动恢复或发布。

Workflow 状态消费既有 `session_workspace_event` 中的 `workflow-run` / `workflow-recording`，按记录 ID 和 revision 防止串任务与旧响应回退。初次打开及焦点/可见性恢复时补读，取消持续轮询；进度更新只替换监控区域，不重绘可编辑草稿。
