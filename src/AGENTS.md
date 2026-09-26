# src — Chrome 宿主面

本目录是扩展的可执行面。产品分层见根 [AGENTS.md](../AGENTS.md)。模型循环与工具契约见 [agent/AGENTS.md](agent/AGENTS.md)。画布页见 [preview/AGENTS.md](preview/AGENTS.md)。侧栏模块见 [sidepanel/README.md](sidepanel/README.md)。

Service worker 会被 Chrome 杀掉。会话仓库、AI SDK、`run` 沙箱客户端都放在 **offscreen**，不放 SW。

## 进程入口

| 面 | 路径 | 现状 |
|----|------|------|
| Service worker | `background.js` | `manifest.background.type=module`。标签 / 下载 / 预览页 / office RPC / offscreen 转发 / **`workspace_page_action` 跨 frame 扇出** / **`workspace_sys`** / **tab 租约（storage.session）** / **`chrome.alarms` 唤醒 due task** |
| Offscreen | `offscreen/runtime.html` + `runtime.js` | `SessionWorkspaceService.create()`；收 `workspace_rpc_execute`。内嵌 sandbox iframe，**不**把 workspace boot 闸在 handshake 上 |
| Content script | `content_script.js` | `matches: <all_urls>`，`run_at: document_idle`，**`all_frames: true`**。点选选区 + 每 frame 的 action。经典脚本（IIFE），`executeScript` 可再注入 |
| Sidepanel | `sidepanel.html` + `sidepanel.js` | 对话 UI。`workspaceRpc` → background。编排器仍是 `sidepanel.js` |
| Sandbox | `sandbox/runtime.html` | `manifest.sandbox`；无 `chrome.*`。`run` 的访客代码 + FS / `sys` postMessage |
| Preview | `preview/` | 扩展页标签：docs / site / artifactPreview / print |

`icons/` 在仓库根，不在 `src/`。`web_accessible_resources` 目前只有 `src/agent/vnext/sessionWorkspace/pickContext.js`（content script 动态 `import`）。

CSP：`extension_pages` 允许 `'wasm-unsafe-eval'`（QuickJS）；sandbox 另加 `'unsafe-eval'`。

## 消息总线

约定：`target` + `action`。Offscreen / SW 用 `browserbot-*`；部分截图/选区消息仍用 `browserbot_*`。

```text
侧栏 / 预览页
  chrome.runtime.sendMessage { target: browserbot-background, action, … }
    workspace_rpc          → ensureBrowserBotOffscreen + 契约检查（仅只读调用最多重试 8 次；写入不重试）
    workspace_page_action  → handleWorkspacePageAction → 各 frame content_script
    sheet_host             → 工作簿 RPC（文件，不另开表格引擎页）
    canvas_host            → 无设计画布，返回 NO_CANVAS
    workspace_fetch / workspace_sys / workspace_capture_* / workspace_find_tab / …
    workspace_tab_lease_peek|release / workspace_task_resolve_page
    storage_local_get|set  → chrome.storage.local 代理
    workspace_get_llm_settings / workspace_get_active_page

offscreen → SW
  session_workspace_event  → 侧栏刷新（execution-start/end、流式、artifact_preview、task-updated、task-schedule-changed、…）

content_script → SW
  点选选区、browserbot_region_selected、截图、toast
```

Offscreen URL：`src/offscreen/runtime.html`。SW `ensureBrowserBotOffscreen()`。

`workspace_sys` 只接受本扩展 offscreen URL 的 sender；调用携带 callId/sessionId/executionId/deadline，取消走同一消息入口。`workspace_rpc` 只在接收端连接尚未建立时重试；响应丢失不代表未执行，不自动重放可能有副作用的请求。

### `workspace_rpc`

```text
sidepanel  workspaceRpc(method, params)     # vnext/host/workspaceClient.js
  → { target: browserbot-background, action: workspace_rpc }
  → background.forwardWorkspaceRpc
  → { target: browserbot-offscreen, action: workspace_rpc_execute }
  → SessionWorkspaceService[method]
```

`method` 必须在 `workspaceRpcContract.js` 的显式清单内；按 Chrome 原生 sender 区分侧栏、预览与内部调度。`getTaskSchedule` / `runDueTasks` / `getBrowserRuntimeState` 只给 SW；offscreen 拒绝侧栏绕过 SW 直调。新增公开 async 方法不自动暴露。侧栏和四种预览共用 `workspaceClient.js`，完整参数语义仍由领域方法验证。

## Selector 与对话引用

点选是网页内容入口，同时支持直接下载/复制/导出和 Bot 引用。侧栏抽屉「收集到」选择新内容的资料组；输入框「参考」管理本会话绑定，两者独立。SelectionGroup 保存资料，既不是 live `action` 的前置条件，也不代表网页操作授权。文字先收进扩展剪贴板，再由用户点击复制到系统剪贴板。展示命名调整不改变 Group/WebItem/sessionBindings 的 RPC 或存储合同。

点选候选只从指针 hit stack 派生，不能用整页媒体矩形越过实际遮挡。默认一击采集首项；悬停边缘的可点击范围标签可直接采集图片、链接、卡片、单元格/行/表等关联范围，标签自身不参与点选，Esc 仍退出。新捕获携带 `scope`、`facets`、保留段落和缩进的 `textRaw`、严格 `locatorFingerprint`，以及 `source.tabId/frameId/documentId/url`；恢复必须按 frame/document 定向并核验身份，不能把新项静默重定到相似节点。

卡片 `facets` 保存其本体文字以及最多 8 个媒体、8 个链接的关系，可靠字段才写入；它不是完整页面抓取。点选保存内容与来源，不授予 live `action` 权限。`locatorFingerprint` 只用于恢复或采集时拒绝错误重定；live action 仍必须走既有 opaque ref/rev 和宿主权限链。

## `action` 运输

```text
SessionWorkspaceService.sendMessage
  hostPageAction(payload)
  → { target: browserbot-background, action: workspace_page_action }
  → handleWorkspacePageAction
  → chrome.tabs.sendMessage({ action: workspace_page_action, … }, { frameId })
  → content_script 本 frame 执行
```

模型参数与错误码在 [agent/AGENTS.md](agent/AGENTS.md)「`action` 契约」。宿主行为：

Background：

- `chrome.webNavigation.getAllFrames` 列 frame；跳过 `chrome://` / `chrome-extension://` / `edge://` / `devtools://` / `view-source:`。
- 缺脚本的 frame：`chrome.scripting.executeScript` 注入 `src/content_script.js`（回退 `content_script.js`）。
- 各 frame 本地 `aN` 编成不透明 `f{frameId}.aN`。
- `pageActionHost.js` 从 background 抽出；同 tab 的 action 排队。`documentTarget.js` 为快照保存 frameId/documentId/URL，用随机不透明 rev，SW 重启后必须重新 snapshot。
- `action` 的全部 mutate（包括 name-only 和 bare press）需要 rev；每次派发前核对文档，消息用 `tabs.sendMessage` 的 documentId 定向。导航、history/fragment 变化使旧快照失效。
- 页面操作先成功写入 storage.session 的租约；`tabs.close` 同样占锁。`sys.cdp` 的 targetId 先归一到 page tabId，不能绕过锁。`sys.tabs.current` 不再 fallback 当前焦点；缺省只允许已注入的本轮 defaultTabId。
- `execution-end`、finally、abort 通过 `browserExecution.js` 精确释放 sessionId+executionId：先撤销后续派发，再取消 sys/断开 CDP，最后放锁。SW 首次执行前与 offscreen 活动执行对账，恢复失败不继续派发。浏览器重启/扩展重载会清空 storage.session 租约与 session 政策覆盖。
- `action` mutate 与关键 `sys` 副作用走双门：offscreen `gatedDispatch`（分类 + journal + 审批 + one-shot ticket）后，SW `consumeDispatchTicket` 再分类一次。已知付款即使有 ticket 也不派发。Guarded 的 raw eval/CDP 在 SW 再拦一次。
- `sys.eval/waitFor/fetch(as:page)` 使用 documentIds 定向，可以传 documentId/expectedUrl。`sys.upload` / `action op=upload` 共用 SW `uploadChannel.js`：字节经 `chrome.scripting.executeScript({ world:'MAIN', func, args })` 分块注入，默认 `DataTransfer` + `input.files` setter + 手派 `input`/`change`，找不到 file input 再脚本 drop。`auto` 不 attach CDP。回执带 `methodUsed`、`trusted:false`、`siteAccepted:'unknown'`，不声称站点已接受。未知写入回执要先观察再决定，不能自动重放；确认动作后的观察失败单列 observationError。
- 预览页 workLock 仍是同 session 画布 UI 锁，不与 live tab 租约合并。
- 合并 snapshot 后 `controls` 再截到 80 条。
- `fill_form` 按 `frameId` 拆开发送，出现失败/未知回执停止后续 frame；返回已知的部分结果，不伪装为原子事务。
- `wait` + `text`（无 `ref`）对所有 frame 并行等，任一命中即停。
- `name` 回退：内部 `op: resolve_name`（不在模型 schema 里）。
- 限制页（`chrome://`、`edge://`、`about:`、`devtools://`、`view-source:`、Web Store、扩展页）→ `NEED_PAGE`。

Content script：

- 本 frame snapshot：可交互节点 cap **80**（`ACTION_SNAPSHOT_CAP`）；本地 ref 为 `a1`…。
- 公开 op：`snapshot` / `fill_form` / `click` / `fill` / `select` / `press` / `scroll` / `wait`；`upload` 不在 content script 里赋文件（SW MAIN-world 注入）。另有内部 `resolve_name` / `mark_upload`。`fill` 对 file input 仍 `FILE_INPUT`；`click` 打到 file input 回 `FILE_CHOOSER`。
- `resolveActionTarget` 另有 `css` 路径；模型工具参数未暴露该字段。
- `wait`：无 `text`/`ref` 时睡 `ms`（默认 300，上限 5000）。
- `press` 无目标时打到主 frame（`frameId` 0）的 `activeElement`。

## 预览标签（SW 打开）

`background.js` 按 artifact 打开 `chrome-extension://…/src/preview/*.html?sessionId&artifactId`，并用 tab 缓存 + `*_tab_ready` 握手。`sheet_host` 是工作簿文件 RPC，不另开表格引擎页。`canvas_host` 返回 `NO_CANVAS`。种类 → 页面映射见 [preview/AGENTS.md](preview/AGENTS.md)。

会话相关预览标签可进 `tabGroups`（`browserTabGroups` / `attachTabToSessionGroup`）。

## 持久化（宿主键）

| 存哪 | 键 / 库 | 用途 |
|------|---------|------|
| IndexedDB + OPFS | `browserbot-session-workspace-v1` | 会话 / group / artifact / fsNodes / `meta`（含可选 `task:*`）（offscreen） |
| `chrome.storage.local` | `browserbot_providers`、`browserbot_active_provider_id` | BYOK |
| 同上 | `browserbot_chat_media_evidence_v1`、`browserbot_chat_media_auto_check` | 连接范围的媒体校验证据与自动校验开关；offscreen 调度，SW 监听配置变更触发，普通发送只读 |
| 同上 | `browserbot_context_window_evidence_v1`、`browserbot_context_window_auto_check` | 精确 base+model 的上下文窗口探测结果与自动探测开关；目录已有窗口则不 chat-probe；发送只读、不 await |
| 同上 | `browserbot_web_acquire` | acquire 搜索/抓取设置 |
| 同上 | `browserbot_cloud_account` | Browser Kitten 账户：设备令牌、登录时代填了哪些 web 槽位（`cloudAccount.js`）。不含套餐/积分，那由服务端每次判定 |
| 同上 | `browserbot_theme_mode`（兼 `browserbot_theme`） | 侧栏主题 |
| 同上 | `browserbot_user_skills` | 用户固化 skill（`agent/skills.js`，侧栏） |

## 其它宿主事实

- 权限与命令见根 AGENTS.md / `manifest.json`。`userScripts` 给 `sys.eval` / page `fetch`；`debugger` 给 `sys.cdp`。Chrome 135+ 的 `userScripts.execute` 需要扩展卡片 **允许运行用户脚本**（或更早的开发者模式）。CDP 挂上时 Chrome 会显示调试横幅；F12 已打开会 `CDP_BUSY`。`eval` / page `fetch` / `cdp` 不注入扩展预览页。`sys` 是系统调用表，不是产品功能列表（[agent/AGENTS.md](agent/AGENTS.md)）。
- 区域截图：Alt+Shift+C → content script 框选 → SW `captureVisibleTab` 裁剪 → 剪贴板 + 对话附件。
- `llm_proxy_fetch`：侧栏/设置探测模型时走 SW，避免页面 CORS。

### 媒体观察

`action snapshot` 附 `mediaElements`（最多 6 项，含 frame/document 的媒体播放和源线索）；它只提示可用证据，不自动选择路径。`action op=record` 经 SW tabCapture → offscreen 录制可见标签画面+声音（默认 8 秒，最大 30 秒），只在当前模型可接收原生视频时执行。`browserbot_record_grant:{sessionId}:{tabId}` 是独立侧栏视频授权，听音 grant 不覆盖它。两种采集共用生命周期清理，但 listen 保持 `video:false`。详见 [CHAT_MEDIA_INPUT.md](../docs/CHAT_MEDIA_INPUT.md)。

## 顺序 Workflow 宿主

`workflowHost.js` 接收仅 offscreen 可用的 `workspace_workflow_host`；该入口只提供录制运输、标签/下载读取及 UI 高亮，不增加回放执行通道。真实内容事件由 SW 验证 sender 的 tab/frame/document 身份，再转内部 RPC；网页与 preview 不能发布或运行流程。显式录制范围包含已加入标签及 opener 子标签。重启/运输或存储失败暂停录制，不能静默遗漏后声称完整。页面回放依旧走 pageActionHost；针对 Workflow 的窄目标 snapshot 保持原 ref/rev/documentId 校验，滚动距离也参与派发哈希。详见 [Workflow 合同](../docs/WORKFLOW_V1.md)。
