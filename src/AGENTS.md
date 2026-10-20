# src — Chrome 宿主面

本目录是扩展的可执行面。产品分层见根 [AGENTS.md](../AGENTS.md)。模型循环与工具契约见 [agent/AGENTS.md](agent/AGENTS.md)。画布页见 [preview/AGENTS.md](preview/AGENTS.md)。侧栏模块见 [sidepanel/README.md](sidepanel/README.md)。

Service worker 会被 Chrome 杀掉。会话仓库、AI SDK、`run` 沙箱客户端都放在 **offscreen**，不放 SW。

## 进程入口

| 面 | 路径 | 现状 |
|----|------|------|
| Service worker | `background.js` | `manifest.background.type=module`。标签 / 下载 / 预览页 / office RPC / offscreen 转发 / **`workspace_page_action` 跨 frame 扇出** / **`workspace_sys`** / **tab 租约（SW 内存）** / **`chrome.alarms` 唤醒 due task** |
| Offscreen | `offscreen/runtime.html` + `runtime.js` | `SessionWorkspaceService.create()`；收 `workspace_rpc_execute`。内嵌 sandbox iframe，**不**把 workspace boot 闸在 handshake 上 |
| Content script | `content_script.js` | `matches: <all_urls>`，`run_at: document_idle`，**`all_frames: true`**。伸爪选区 + 每 frame 的 action。经典脚本（IIFE），`executeScript` 可再注入 |
| Sidepanel | `sidepanel.html` + `sidepanel.js` | 对话 UI。`workspaceRpc` → background。编排器仍是 `sidepanel.js` |
| Sandbox | `sandbox/runtime.html` | `manifest.sandbox`；无 `chrome.*`。`run` 的访客代码 + FS / `sys` postMessage |
| Preview | `preview/` | 扩展页标签：sheet / docs / site / artifactPreview / print |

`icons/` 在仓库根，不在 `src/`。`web_accessible_resources` 目前只有 `src/agent/vnext/sessionWorkspace/pickContext.js`（content script 动态 `import`）。

CSP：`extension_pages` 允许 `'wasm-unsafe-eval'`（QuickJS / Univer）；sandbox 另加 `'unsafe-eval'`。

## 消息总线

约定：`target` + `action`。Offscreen / SW 用 `pawwork-*`；部分截图/选区消息仍用 `pagewand_*`。

```text
侧栏 / 预览页
  chrome.runtime.sendMessage { target: pawwork-background, action, … }
    workspace_rpc          → ensurePawWorkOffscreen + forward（最多 8 次）
    workspace_page_action  → handleWorkspacePageAction → 各 frame content_script
    sheet_host             → 打开/复用 sheet.html，再 pawwork_sheet_rpc
    canvas_host            → docs.html 同类 RPC（无 Design/Slides）
    workspace_fetch / workspace_sys / workspace_capture_* / workspace_find_tab / …
    workspace_parallel_search_headers → fixed session header rule for this extension's Parallel MCP requests
    workspace_tab_lease_peek|release / workspace_task_resolve_page
    storage_local_get|set  → chrome.storage.local 代理
    workspace_get_llm_settings / workspace_get_active_page

offscreen → SW
  session_workspace_event  → 侧栏刷新（execution-start/end、流式、artifact_preview、task-updated、task-schedule-changed、…）

content_script → SW
  伸爪选区、pagewand_region_selected、截图、toast
```

Offscreen URL：`src/offscreen/runtime.html`。SW `ensurePawWorkOffscreen()`。

`workspace_sys` 只接受本扩展 offscreen URL 的 sender；调用携带 callId/sessionId/executionId/deadline，取消走同一消息入口。`workspace_rpc` 只在接收端连接尚未建立时重试；响应丢失不代表未执行，不自动重放可能有副作用的请求。

### `workspace_rpc`

```text
sidepanel  workspaceRpc(method, params)     # vnext/host/workspaceClient.js
  → { target: pawwork-background, action: workspace_rpc }
  → background.forwardWorkspaceRpc
  → { target: pawwork-offscreen, action: workspace_rpc_execute }
  → SessionWorkspaceService[method]
```

`method` 必须是 service 上的公开 async 方法（不以 `_` 开头）。常见：`sendMessage`、`getWorkspaceState`、`abortExecution`、`answerClarify`、`listTasks` / `getTask` / `updateTask`、group/clipboard/artifact CRUD、`listSkills`。完整列表看 `sessionWorkspaceService.js` 的 `async` 方法。`getTaskSchedule` / `runDueTasks` 给 SW scheduler，不是侧栏主路径。

## `action` 运输

```text
SessionWorkspaceService.sendMessage
  hostPageAction(payload)
  → { target: pawwork-background, action: workspace_page_action }
  → handleWorkspacePageAction
  → chrome.tabs.sendMessage({ action: workspace_page_action, … }, { frameId })
  → content_script 本 frame 执行
```

模型参数与错误码在 [agent/AGENTS.md](agent/AGENTS.md)「`action` 契约」。宿主行为：

Background：

- `chrome.webNavigation.getAllFrames` 列 frame；跳过 `chrome://` / `chrome-extension://` / `edge://` / `devtools://` / `view-source:`。
- 缺脚本的 frame：`chrome.scripting.executeScript` 注入 `src/content_script.js`（回退 `content_script.js`）。
- 各 frame 本地 `aN` 编成不透明 `f{frameId}.aN`。
- `rev` 存在 SW 内存 `pageActionRevByTab`（`t1`, `t2`, …）。SW 重启后需重新 `snapshot`。
- 对 tab 的副作用（`action` snapshot/mutate、`sys.eval`、`sys.waitFor`、`sys.fetch(as:page)`、`sys.tabs.navigate/reload/focus`、`sys.cdp`）先在 SW `tabLeases` 上 `tryAcquire`；他 session 占用 → `TAB_LEASED`。`action` 必须带本轮显式 `tabId`（来自 `activeTab`，不再 fallback 到 Chrome 焦点标签）→ 缺则 `NEED_EXPLICIT_TAB`，且不登记租约。`sys.tabs.open` 成功后 `grantTabLease`。`sys.tabs.list` / `current` / extension-fetch / screenshot / download / `tabs.close` **不**占这把锁。
- 释放：offscreen `execution-end`、`sendMessage` finally、`abortExecution` → `workspace_tab_lease_release` / `releaseTabLeasesByExecution`；`tabs.onRemoved` 释放该 `tabId`。这把锁不是 journal，SW 一死整表丢。预览页 `workLock` 是同 session 画布 UI 锁，不是这把 live-page 租约。
- 合并 snapshot 后 `controls` 再截到 80 条。
- `fill_form` 按 `frameId` 拆开发送。
- `wait` + `text`（无 `ref`）对所有 frame 并行等，任一命中即停。
- `name` 回退：内部 `op: resolve_name`（不在模型 schema 里）。
- 限制页（`chrome://`、`edge://`、`about:`、`devtools://`、`view-source:`、Web Store、扩展页）→ `NEED_PAGE`。

Content script：

- 本 frame snapshot：可交互节点 cap **80**（`ACTION_SNAPSHOT_CAP`）；本地 ref 为 `a1`…。
- 公开 op：`snapshot` / `fill_form` / `click` / `fill` / `select` / `press` / `scroll` / `wait`，另有内部 `resolve_name`。
- `resolveActionTarget` 另有 `css` 路径；模型工具参数未暴露该字段。
- `wait`：无 `text`/`ref` 时睡 `ms`（默认 300，上限 5000）。
- `press` 无目标时打到主 frame（`frameId` 0）的 `activeElement`。

## 预览标签（SW 打开）

`background.js` 按 artifact 打开 `chrome-extension://…/src/preview/*.html?sessionId&artifactId`，并用 tab 缓存 + `*_tab_ready` 握手。office 工具经 `sheet_host` / `canvas_host` 把读写打到已打开的页。种类 → 页面映射见 [preview/AGENTS.md](preview/AGENTS.md)。

会话相关预览标签可进 `tabGroups`（`pawTabGroups` / `attachTabToSessionGroup`）。

## 持久化（宿主键）

| 存哪 | 键 / 库 | 用途 |
|------|---------|------|
| IndexedDB + OPFS | `pawwork-session-workspace-v1` | 会话 / group / artifact / fsNodes / `meta`（含可选 `task:*`）（offscreen） |
| `chrome.storage.local` | `pagewand_providers`、`pagewand_active_provider_id` | BYOK |
| 同上 | `pagewand_web_acquire` | acquire 搜索/抓取设置 |
| 同上 | `pagewand_theme_mode`（兼 `pagewand_theme`） | 侧栏主题 |
| 同上 | `pagewand_user_skills` | 用户固化 skill（`agent/skills.js`，侧栏） |

## 其它宿主事实

- 权限与命令见根 AGENTS.md / `manifest.json`。`userScripts` 给 `sys.eval` / page `fetch`；`debugger` 给 `sys.cdp`。Chrome 135+ 的 `userScripts.execute` 需要扩展卡片 **允许运行用户脚本**（或更早的开发者模式）。CDP 挂上时 Chrome 会显示调试横幅；F12 已打开会 `CDP_BUSY`。`eval` / page `fetch` / `cdp` 不注入扩展预览页。`sys` 是系统调用表，不是产品功能列表（[agent/AGENTS.md](agent/AGENTS.md)）。
- 区域截图：Alt+Shift+C → content script 框选 → SW `captureVisibleTab` 裁剪 → 剪贴板 + 对话附件。
- `llm_proxy_fetch`：侧栏/设置探测模型时走 SW，避免页面 CORS。
