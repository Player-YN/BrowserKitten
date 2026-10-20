# 爪爪 · 完全解放版

Chrome MV3 **unpacked** 扩展：把已登录浏览器当成可编程层（live-page `action`，以及 `run` 里的 guest `sys`），并在侧栏里跑一个 **Session Workspace** 通用 agent（表 / 画布 / 文档 / 站点 / 代码沙箱）。

加载根就是 **本文件夹**（根上有 `manifest.json`）——开发和陌生人都加载它。`python scripts/pack_extension.py --zip <路径>` 只在发版时跑：它从已跟踪的 `manifest.json` + `icons/` + `src/` 生成一个不含 `.md` / `tests` 的 `extension/`（**已 gitignore，不入库**）与 Release zip。显示名：`manifest.name` / `action.default_title` = `爪爪 · 完全解放版`。不面向 CWS，改 `src/` 后点 **重新加载**。无 `package.json`，不跑 npm。

产品入口与本地验证：[README.md](README.md)。

## 文档怎么读

| 文件 | 写什么 | 什么时候打开 |
|------|--------|----------------|
| 本文件 | 产品边界、进程分层、领域对象、目录地图 | 任何任务的第一站 |
| [src/AGENTS.md](src/AGENTS.md) | Chrome 宿主：SW / offscreen / 侧栏 / content script / 消息总线 / `action` 运输 | 改扩展壳、RPC、标签、选区 |
| [src/agent/AGENTS.md](src/agent/AGENTS.md) | Session Workspace：store、工具循环、工具契约、skills、guest FS、`sys` ABI | 改模型循环、工具、prompt、持久化领域 |
| [src/preview/AGENTS.md](src/preview/AGENTS.md) | 画布标签页（Univer / site） | 改 sheet / docs / site 预览 |
| [src/sidepanel/README.md](src/sidepanel/README.md) | 侧栏 UI 模块与滚动契约 | 改对话面板布局 / i18n |
| 本文件「未实现的边界」 | 持久化 / `sys` / 长任务的硬边界 | 改这三块方向前 |

事实以仓库代码为准。历史名 **PageWand** 仍出现在 `chrome.storage.local` 键（`pagewand_*`）和部分注释里；消息 `target` 用 `pawwork-*`。

## 技术分层

扩展不是单页应用。Chrome 把代码拆进不同进程；agent 只住在 **offscreen** 里，侧栏只发 RPC。

```text
┌─ 用户网页（任意 http(s)）─────────────────────────────────┐
│  content_script.js  all_frames                             │
│  伸爪选区 · 每 frame 的 action snapshot/mutate               │
└──────────────────────────────▲─────────────────────────────┘
                               │ tabs.sendMessage {frameId}
┌─ Service Worker  src/background.js ────────────────────────┐
│  路由：workspace_rpc / workspace_page_action / workspace_sys │
│        sheet_host / canvas_host / 截图 / 下载 / 预览 / tabGroups │
│        tab 租约（SW 内存）· alarms 唤醒（store 权威）           │
│  SW 会被杀掉 → 不在这里持有会话 store 或跑模型循环           │
└──┬───────────────────────────┬─────────────────────────────┘
   │ workspace_rpc             │ 打开 chrome-extension:// 标签
   ▼                           ▼
┌─ Offscreen  src/offscreen/ ─┐  ┌─ Preview  src/preview/ ──┐
│ SessionWorkspaceService     │  │ sheet / docs / site /    │
│ IDB + OPFS 会话仓库         │  │ artifactPreview          │
│ AI SDK ToolLoopAgent        │  │ Univer / site 运行时     │
│ iframe → sandbox QuickJS    │  └──────────────────────────┘
└──────────────▲──────────────┘
               │ workspaceRpc(method, params)
┌─ Side panel  src/sidepanel.html + sidepanel.js ────────────┐
│  对话 UI、选区、交付物。不跑 agent 循环。                    │
└────────────────────────────────────────────────────────────┘
```

| 层 | 职责 | 不该做 |
|----|------|--------|
| Side panel | 渲染会话、收集用户输入、调 `workspaceRpc` | 持有 Durable store、调模型 |
| Service worker | 权限面：标签、下载、跨 frame 扇出、打开预览页、`workspace_sys` | 长期状态、ToolLoopAgent |
| Offscreen | 产品 runtime：store + `sendMessage` + 工具 | 直接碰 DOM / `chrome.tabs`（经 SW 消息） |
| Content script | 页面选区与 `action` 本 frame 执行 | 会话语义、模型、`sys.eval`（那是 SW `userScripts`） |
| Sandbox | `run` 的访客 JS（无 `chrome.*`；经 `sys` RPC 调 SW） | 读扩展存储、改 SelectionGroup |
| Preview 标签 | 把 artifact 画成可编辑画布 | 模型循环 |

## 一次用户消息

```text
侧栏 send
  → workspaceRpc('sendMessage')
  → SW forwardWorkspaceRpc
  → offscreen SessionWorkspaceService.sendMessage
  → sessionWorkspace/sendMessage.js
       beginExecution
       createSessionTools + inventoryFromSession（瞄准，不藏工具）
       AI SDK 7 ToolLoopAgent（sessionAgent.js，toolChoice=auto）
       工具：inspect / acquire / run / clarify / action / task / sheet / doc / web
       （sys 不是工具；在 run 代码里调，目录：inspect view=sys）
       （普通 send 不建 durable task；task 工具始终在 schema 里）
       settleExecution
  → session_workspace_event 广播回侧栏
```

工具实现与契约：[src/agent/AGENTS.md](src/agent/AGENTS.md)。`action` 出 offscreen 后如何打到页面：[src/AGENTS.md](src/AGENTS.md)「`action` 运输」。

## 领域对象（产品语义）

都在 offscreen 的 `DurableSessionWorkspaceStore` 里（IndexedDB `pawwork-session-workspace-v1` + OPFS blobs）。纯内存 `SessionWorkspaceStore` 只给测试。

| 对象 | 是什么 | 谁改 |
|------|--------|------|
| **Session** | 一轮任务：messages、title、绑定的 group ids | UI RPC + `sendMessage` |
| **Group + WebItem** | 用户拥有的环境上下文（伸爪选区、剪贴板钉、页面条目） | **仅 UI RPC**。工具禁止 mutate SelectionGroup |
| **Artifact** | 会话交付物（表 / Univer 文档 / site HTML / 文件） | 工具 `run` / office 工具 / UI 创建 |
| **Execution** | 单次用户 turn 的租约与 `/scratch`；崩溃后作废 | `sendMessage` |
| **Task** | 可选 durable 进度对象（`meta` 的 `task:*`：plan / evidence / dueAt）。**不是** call journal | 模型 `task` 工具（`schedule` 才新建）；UI `updateTask`；alarms 续跑 |
| **Guest FS** | 访客可见 `/context`（只读）· `/artifacts`（持久）· `/scratch`（本轮） | `run` 沙箱 |
| **sys** | 浏览器机器 ABI（tabs / eval / fetch / **cdp** / download / screenshot）。guest 无 `chrome.*` | `run` → SW `workspace_sys` |

画布种类（inventory 瞄准，工具始终在）：`sheet` · `doc` · `web`（`data-paw-kind=site`）。没有 Design/Slides（tldraw）。

## 加载根树

```text
manifest.json              # MV3：SW / side_panel / content_scripts / sandbox / CSP
icons/                     # 16|32|48|128
scripts/pack_extension.py  # 发版：生成 gitignore 的 extension/ 与 zip
tests/                     # `*.test.mjs` 逻辑回归（纯 Node）· browser-smoke（Playwright，CI 不跑）
src/
  background.js            # Service worker（type: module）
  content_script.js        # <all_urls> all_frames；伸爪 + action
  sidepanel.html|js|css    # 侧栏壳；编排在 sidepanel.js
  sidepanel/               # 侧栏子模块（见该目录 README）
  offscreen/               # 创建 SessionWorkspaceService；嵌 sandbox iframe
  sandbox/                 # QuickJS guest（manifest.sandbox）
  preview/                 # 画布 / 通用预览标签页
  agent/                   # 模型循环与领域（offscreen 主进口）
    llm.js provider.js     # BYOK OpenAI-compatible
    vnext/service/         # SessionWorkspaceService RPC 门面
    vnext/sessionWorkspace/# store、sendMessage、tools、office
    vnext/primitives/      # acquire / run 宿主原语
    vnext/adapters/        # QuickJS、AI SDK vendor loader
    vnext/host/            # workspaceRpc、stop、rpcError、browserSysHost、tabLease、taskScheduler
    vnext/skills/          # playbook（不是工具）
```

`src/preview/vendor/{sheet,docs}-runtime.*` 是已跟踪的 Univer 包，unpacked 加载需要，勿从 `.gitignore` 排除。

## 未实现的边界

这些是当前实现的硬边界，不是待办清单。改持久化 / `sys` / 长任务前先读这节。

- **无 call 级 durable journal**：`callId` 与取消登记在 SW 内存，SW 一死即失。没有跨崩溃 exactly-once，也没有按 call 自动续跑；`Execution` 崩溃后作废。结果未知的网页写入应先读后置状态再决定是否重试，不要盲目重放工具调用。
- **可选 durable task（进度 + alarms，不是 journal）**：记录在 IDB `meta` 的 `task:*`（goal / plan / evidence / dueAt / status）。SW `chrome.alarms` 只按 store 的 `dueAt` 唤醒，**store 是权威**。不是 exactly-once，不是 call journal。普通 `sendMessage` **不建、不绑** task；只有 `taskRun+taskId`（alarm / UI resume）才把本轮绑到已有 task。`completed` 只来自成功的 `task complete`。
- **live 页 tab 租约在 SW 内存**（与 `pageActionRevByTab` 同层，`Map<tabId, { sessionId, executionId, … }>`）：跨 session 对同一 tab 的副作用互斥，不是 journal，SW 一死锁丢。`execution-end` / settle / abort / 关标签释放。同账号多任务靠这把锁；两套 cookie 真并行才是另一个 Chrome profile，产品不引导开新 profile。
- **持久化仍导出内存快照**：大工作区需要改成记录/文件的增量提交。新文件发布前崩溃可能留下未被引用的 OPFS 文件；orphan GC 未实现，不自动清理无法证明归属的文件。`task:*` 跟着 `meta` 快照走，仍然不是增量 journal。
- **OPFS 不可用时**新字节写入 IDB；已有 OPFS 引用不会因暂时不可用被清空。
- **交付物版本不是完整协同编辑**：旧调用方可省略 `expectedRevision`，raw guest 写入推进版本但不携带读版本；没有自动合并，也没有冲突解决界面。
- **`tabId` 标识标签，不标识导航前后的同一文档**：页面引用未纳入 documentId 与导航代次。CDP attachment 没有 session owner、跨 run 复用与释放策略；网络事件是定长数组，不是带游标与丢失计数的日志。
- **截图不是原子快照**：捕获前后校验活动标签，但仍是视口合成，不适合需要严格文档身份的视觉执行。
- **同一 session 的第二次执行返回 busy**，不支持并发 turn。普通回合与 durable-task 回合都**无 hop 上限**；task 停点是 `wait` / `complete` / host yield / abort，不是步数。
- **出不了浏览器**：没有原生 OS 控制、没有本地命令，也没有验证过高保真 Office 往返。若未来需要浏览器外计算，加**可选** native companion，浏览器侧的会话与权限边界仍应保留。

## 日常约定

- 改代码 → `chrome://extensions` 点本扩展 **重新加载**。offscreen / SW 会重建；`action` 的 `rev` 在 SW 内存，重载后需重新 `snapshot`。
- 权限见 `manifest.json`：`sidePanel` `activeTab` `tabs` `scripting` `storage` `declarativeNetRequestWithHostAccess` `alarms` `downloads` `offscreen` `tabGroups` `webNavigation` `userScripts` `debugger`；`host_permissions: <all_urls>`。`declarativeNetRequestWithHostAccess` 仅为本扩展发往 Parallel MCP 的请求设置 User-Agent。`userScripts` / `debugger` 只服务 guest `sys`（[src/AGENTS.md](src/AGENTS.md)）。`alarms` 只唤醒 due task，不是 journal。
- 命令：`toggle-picker` = Alt+Shift+S；`capture-screenshot` = Alt+Shift+C。
- Git：本地 `main`；`origin` = `https://github.com/Player-YN/PawWork_ZhuaZhua.git`。不要改 `git config`。不要 force-push `main`。
- 逻辑回归：`node --test tests/*.test.mjs`（与 CI 同一 glob：`runtime-regression` + `tab-lease` + `task-*`。覆盖磁盘失败恢复与原子性、OPFS 替换失败、慢文档/表格保存、画布重试与冲突、截图目标、流读取限额、fetch 取消、`saveTo`、CDP 并发与权限探测、guest `sleep`、`sys.waitFor`、tab 租约、task 模型/调度/接线/卡片）。
- 实机烟测（手动，CI 不跑）：`node tests/browser-smoke.cjs <playwright路径>`。默认加载根是仓库根；要验**真正发出去的那棵树**，先 `python scripts/pack_extension.py` 再 `PAW_LOAD_ROOT=extension node tests/browser-smoke.cjs <playwright路径>`。独立 Chromium、一次性 profile，不碰你的浏览器状态。覆盖：IDB/OPFS 关闭重开、真实 QuickJS 错误往返、`run`→文件→artifact 登记、非 offscreen `sys` 请求拒绝、真实 localhost fetch 与正文超时、offscreen RPC 版本冲突拒绝。证据在 `output/playwright/`，不入库。
- CI（`.github/workflows/ci.yml`）跑 `node --test tests/*.test.mjs` + pack 形状断言（含「pack 里必须带 TSV 修复」这条防漂移守卫），不装浏览器。
- BYOK：侧栏填 Key → `pagewand_providers`。无 Key 时 offscreen 仍可启动，`sendMessage` 时再解析模型。
