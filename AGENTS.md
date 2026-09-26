# Browser Kitten

Chrome MV3 **unpacked** 扩展：把已登录浏览器当成可编程层（live-page `action`，以及 `run` 里的 guest `sys`），并在侧栏里跑一个 **Session Workspace** 通用 agent（表 / 画布 / 文档 / 站点 / 代码沙箱）。

加载根就是 **本文件夹**（根上有 `manifest.json`）——开发和陌生人都加载它。`python scripts/pack_extension.py --zip <路径>` 只在发版时跑：它从当前工作区的 `manifest.json` + `icons/` + `src/`（不依赖 Git，包含新增模块） 生成一个不含 `.md` / `tests` 的 `extension/`（**已 gitignore，不入库**）与 Release zip。显示名：`manifest.name` / `action.default_title` = `Browser Kitten`。不面向 CWS，改 `src/` 后点 **重新加载**。无 `package.json`，不跑 npm。

产品入口与本地验证：[README.md](README.md)。

侧栏 UI 的视觉与交互规范：[Design.md](Design.md)。新增界面复用其 token、按钮层级与响应式规则。

## 文档怎么读

| 文件 | 写什么 | 什么时候打开 |
|------|--------|----------------|
| 本文件 | 产品边界、进程分层、领域对象、目录地图 | 任何任务的第一站 |
| [src/AGENTS.md](src/AGENTS.md) | Chrome 宿主：SW / offscreen / 侧栏 / content script / 消息总线 / `action` 运输 | 改扩展壳、RPC、标签、选区 |
| [src/agent/AGENTS.md](src/agent/AGENTS.md) | Session Workspace：store、工具循环、工具契约、skills、guest FS、`sys` ABI | 改模型循环、工具、prompt、持久化领域 |
| [src/preview/AGENTS.md](src/preview/AGENTS.md) | 画布标签页（docs / site） | 改 docs / site 预览 |
| [src/sidepanel/README.md](src/sidepanel/README.md) | 侧栏 UI 模块与滚动契约 | 改对话面板布局 / i18n |
| 本文件「未实现的边界」 | 持久化 / `sys` / 长任务的硬边界 | 改这三块方向前 |

事实以仓库代码为准。设置在 `chrome.storage.local` 的 `browserbot_*` 键；进程间消息 `target` 用 `browserbot-*`。

## 技术分层

扩展不是单页应用。Chrome 把代码拆进不同进程；agent 只住在 **offscreen** 里，侧栏只发 RPC。

```text
┌─ 用户网页（任意 http(s)）─────────────────────────────────┐
│  content_script.js  all_frames                             │
│  点选选区 · 每 frame 的 action snapshot/mutate               │
└──────────────────────────────▲─────────────────────────────┘
                               │ tabs.sendMessage {frameId}
┌─ Service Worker  src/background.js ────────────────────────┐
│  路由：workspace_rpc / workspace_page_action / workspace_sys │
│        sheet_host / canvas_host / 截图 / 下载 / 预览 / tabGroups │
│        tab 租约（storage.session）· 政策/ticket 最后一道门     │
│        alarms 唤醒（store 权威）· SW 不持有 journal / 模型循环 │
└──┬───────────────────────────┬─────────────────────────────┘
   │ workspace_rpc             │ 打开 chrome-extension:// 标签
   ▼                           ▼
┌─ Offscreen  src/offscreen/ ─┐  ┌─ Preview  src/preview/ ──┐
│ SessionWorkspaceService     │  │ docs / site /            │
│ IDB + OPFS 会话仓库         │  │ artifactPreview          │
│ AI SDK ToolLoopAgent        │  │ docs / site 预览         │
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
       工具：inspect / acquire / run / clarify / action / task / doc / web
       （sys 不是工具；在 run 代码里调，目录：inspect view=sys）
       （普通 send 不建 durable task；task 工具始终在 schema 里）
       settleExecution
  → session_workspace_event 广播回侧栏
```

工具实现与契约：[src/agent/AGENTS.md](src/agent/AGENTS.md)。`action` 出 offscreen 后如何打到页面：[src/AGENTS.md](src/AGENTS.md)「`action` 运输」。

## 领域对象（产品语义）

都在 offscreen 的 `DurableSessionWorkspaceStore` 里（IndexedDB `browserbot-session-workspace-v1` + OPFS blobs）。纯内存 `SessionWorkspaceStore` 只给测试。

| 对象 | 是什么 | 谁改 |
|------|--------|------|
| **Session** | 一轮任务：messages、title、绑定的 group ids | UI RPC + `sendMessage` |
| **Group + WebItem** | 用户拥有的环境上下文（点选选区、剪贴板钉、页面条目） | **仅 UI RPC**。工具禁止 mutate SelectionGroup |
| **Artifact** | 会话交付物（文档 HTML / site HTML / 文件） | 工具 `run` / office 工具 / UI 创建。UI 按 `docs`/`data`/`web`/`media`/`files` 投影；打开面见 `artifactCapability.js` |
| **Execution** | 单次用户 turn 的租约与 `/scratch`；崩溃后作废 | `sendMessage` |
| **Task** | 可选 durable 进度对象（`meta` 的 `task:*`：plan / evidence / dueAt）。**不是** call journal | 模型 `task` 工具（`schedule` 才新建）；UI `updateTask`；alarms 续跑 |
| **Guest FS** | 访客可见 `/context`（只读）· `/artifacts`（持久）· `/scratch`（本轮） | `run` 沙箱 |
| **sys** | 浏览器机器 ABI（tabs / eval / fetch / **cdp** / download / screenshot）。guest 无 `chrome.*` | `run` → SW `workspace_sys` |

画布种类（inventory 瞄准，工具始终在）：`doc` · `web`（`data-browserbot-kind=site`）。文档预览是标记 HTML。csv / xlsx 按文件打开。

## 加载根树

```text
manifest.json              # MV3：SW / side_panel / content_scripts / sandbox / CSP
icons/                     # 16|32|48|128
scripts/pack_extension.py  # 发版：生成 gitignore 的 extension/ 与 zip
tests/                     # `*.test.mjs` 逻辑回归（纯 Node）· browser-smoke（Playwright，CI 不跑）
src/
  background.js            # Service worker（type: module）
  content_script.js        # <all_urls> all_frames；点选 + action
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
    vnext/host/            # workspaceRpc、browserSysHost、tabLease、taskScheduler、
                           # accessPolicy、riskClassify、dispatchTicket、callJournal、
                           # operationGate、postcondition
    vnext/skills/          # playbook（不是工具）
```

`src/preview/vendor/fflate.js` 已跟踪，打开 docx 时用。

## 未实现的边界

这些是当前实现的硬边界，不是待办清单。改持久化 / `sys` / 长任务前先读这节。

- **Access Policy 是宿主门，不是 prompt，也没有模式开关**（`accessPolicy.js`，旧的 Guarded/Full 存储键启动时删除）。已知付款不派发；已知删除要 one-shot 宿主审批（不是 `clarify`）；其余 known/unknown/raw（含 eval、CDP）**best-effort 自动放行**，文案不得承诺绝不付款/删除。分类器是启发式，raw 可以绕过。journal 行保留 `accessMode` 字段，恒为 `full`。
- **有 call journal，但不是 exactly-once**：独立 IDB `browserbot-call-journal-v1`。产品路径 IDB 打不开或事务失败 → `JOURNAL_UNAVAILABLE`，外部写不 dispatch；内存 journal **只**能 `memoryJournal: true` 测试参数启用，不自动降级。write-ahead：`prepared → awaiting_approval|authorized → dispatched → succeeded|failed|unknown → verified|needs_human`。崩溃卡在 authorized/dispatched 标 failed/unknown 并丢掉残留 ticket，**不盲重放**。SW `callId` 取消表仍是内存。task 是进度，audit 是观察日志，journal 是恢复真相。
- **最小 postcondition 是可扩展合同，不是业务完成证明**：action/delete/download/artifact 有宿主核对；不可证明的 send 只能 `needs_human`，模型自然语言 evidence 不能当 verified。
- **可选 durable task（进度 + alarms，不是 journal）**：记录在 IDB `meta` 的 `task:*`（goal / plan / evidence / dueAt / status）。SW `chrome.alarms` 只按 store 的 `dueAt` 唤醒，**store 是权威**。不是 exactly-once。普通 `sendMessage` **不建、不绑** task；只有 `taskRun+taskId`（alarm / UI resume）才把本轮绑到已有 task。`completed` 只来自成功的 `task complete`。
- **live 页 tab 租约由 SW 管理、写入 `chrome.storage.session`**：先成功登记，后派发页面操作；跨 SW 重启恢复，不跨浏览器重启/扩展重载。首次执行前与 offscreen 的活动执行对账，状态读写失败则拒绝派发，不以超时自动抢锁。结束时先撤销该 execution 的后续派发资格、取消可取消调用、释放所属 CDP，再放租约。它不是 journal，不保证已发出的副作用停止。锁粒度是 tab，不是跨标签的同账号业务资源；预览 workLock 仍独立。
- **持久化仍导出内存快照**：大工作区需要改成记录/文件的增量提交。新文件发布前崩溃可能留下未被引用的 OPFS 文件；orphan GC 未实现，不自动清理无法证明归属的文件。`task:*` 跟着 `meta` 快照走，仍然不是增量 journal。
- **OPFS 不可用时**新字节写入 IDB；已有 OPFS 引用不会因暂时不可用被清空。
- **交付物版本不是完整协同编辑**：旧调用方可省略 `expectedRevision`，raw guest 写入推进版本但不携带读版本；没有自动合并，也没有冲突解决界面。
- **页面目标绑定 documentId**：`action` 快照记录 frame + documentId + URL；所有 mutate 要求不透明 rev。导航/SPA 路由变化使旧快照失效；SW 重启后重新观察。`sys.eval/waitFor/page-fetch` 用 `userScripts.target.documentIds`，可带 `documentId/expectedUrl` 前置条件；不是对同一文档中所有 DOM 变化的原子保护。CDP 按 session + execution 归属并在结束时 detach；网络事件仍不是持久日志。
- **截图不是原子快照**：捕获前后校验活动标签，但仍是视口合成，不适合需要严格文档身份的视觉执行。
- **同一 session 的第二次执行返回 busy**，不支持并发 turn。普通回合与 durable-task 回合都**无 hop 上限**；task 停点是 `wait` / `complete` / host yield / abort，不是步数。
- **出不了浏览器**：没有原生 OS 控制、没有本地命令，也没有验证过高保真 Office 往返。若未来需要浏览器外计算，加**可选** native companion，浏览器侧的会话与权限边界仍应保留。

## 日常约定

- 改代码 → `chrome://extensions` 点本扩展 **重新加载**。offscreen / SW 会重建；`action` 的 `rev` 在 SW 内存，重载后需重新 `snapshot`。
- 权限见 `manifest.json`：`sidePanel` `activeTab` `tabs` `scripting` `storage` `identity` `alarms` `downloads` `offscreen` `tabGroups` `webNavigation` `debugger`；**可选** `userScripts` `tabCapture`；`host_permissions: <all_urls>`。`userScripts` / `debugger` 只服务 guest `sys`（[src/AGENTS.md](src/AGENTS.md)）。可选权限只能由用户点击授予：`tabCapture` 在侧栏听音/录屏授权条的点击里申请，`userScripts` 在设置「高级能力」里申请（Chrome 138+ 还要用户在扩展详情页打开「允许用户脚本」）；未授予时宿主返回 `PERMISSION_REQUIRED` + `permission`。`debugger` 按 Chrome 规定不能设为可选。`identity` 只用于 Browser Kitten 账户登录（`launchWebAuthFlow`）。`alarms` 只唤醒 due task，不是 journal。
- 命令：`toggle-picker` = Alt+Shift+S；`capture-screenshot` = Alt+Shift+C。
- Git：本地 `main`；`origin` = `https://github.com/Player-YN/BrowserKitten.git`。不要改 `git config`。不要 force-push `main`。
- 逻辑回归：`node --test tests/*.test.mjs`（与 CI 同一 glob。覆盖原有磁盘/租约/task/`bot-*`，以及 Access Policy / approval / call journal / postcondition / host last-door）。
- 实机烟测（手动，CI 不跑）：`node tests/browser-smoke.cjs <playwright路径>`。默认加载根是仓库根；要验**真正发出去的那棵树**，先 `python scripts/pack_extension.py` 再 `BROWSERBOT_LOAD_ROOT=extension node tests/browser-smoke.cjs <playwright路径>`。独立 Chromium、一次性 profile，不碰你的浏览器状态。覆盖：IDB/OPFS 关闭重开、真实 QuickJS 错误往返、`run`→文件→artifact 登记、非 offscreen `sys` 请求拒绝、真实 localhost fetch 与正文超时、offscreen RPC 版本冲突拒绝。证据在 `output/playwright/`，不入库。
- CI（`.github/workflows/ci.yml`）跑 `node --test tests/*.test.mjs` + pack 形状断言（含「pack 里必须带 TSV 修复」这条防漂移守卫），不装浏览器。
- BYOK：侧栏填 Key → `browserbot_providers`。无 Key 时 offscreen 仍可启动，`sendMessage` 时再解析模型。
- **BYOK 需要付费套餐**（`src/agent/byokGate.js`）：自己的 Key（非 `bk_cloud_*` 记录、非 base 指向 browserkitten.com 的 Tavily/Firecrawl 槽）只在已登录且套餐为 developer / standard / pro / max 时可用；free/试用只能用积分。BYOK 调用不经我们服务器、不扣积分。缓存 `browserbot_cloud_entitlement = { plan, checkedAt }`：读 `/api/me` 时写，退出登录与 401 时清；72 h 内有效，超过 6 h 先刷新（网络失败按 72 h）。拒绝码 `BYOK_REQUIRES_PLAN`，侧栏通知条给「查看套餐」/「登录」。**unpacked 构建豁免**（manifest 无 `update_url`，Web Store 才会加），商店构建才受限；想在 unpacked 上试门，设 `browserbot_byok_enforce_unpacked = true`。这是客户端门，不是服务器强制。不调模型的路径（个人库工具、结构化 Workflow 回放、用户自己的页面操作）不受限。
- 测试后端：未打包的开发版可以在 `chrome.storage.local` 设 `browserbot_cloud_origin = 'https://staging.browserkitten.com'`，之后的登录走 staging；商店版（manifest 有 `update_url`）永远只连正式环境。登录时选定的地址存进账户记录，之后的请求都用它（`cloudModels.js` `resolveCloudOrigin`）。
- 积分（Browser Kitten 账户）：`src/agent/cloudAccount.js`。登录写入 4 条固定 id 的服务商记录（`bk_cloud_chat|image|stt|jev`，baseURL 指向 `browserkitten.com/api/v1`，apiKey = 设备令牌），Tavily / Firecrawl 为空时才填；不覆盖用户已配的 Key，不抢已可用的活动服务商。登出只撤回这些。套餐与积分每次请求由服务端判定，本地记录不授予任何权益。后端与上架清单见 [docs/COMMERCIAL_LAUNCH.md](docs/COMMERCIAL_LAUNCH.md)。

## Chrome BOT 1.2.0 候选版接线

实现与验收记录见 [docs/CHROME_BOT_OPTIMIZATION.md](docs/CHROME_BOT_OPTIMIZATION.md)。此版本尚未通过真实 Chrome 全链路验收。

- RPC：`workspaceRpcContract.js` 明确允许的方法、调用角色与读取重试属性；不是枚举 service 的公开方法。只读可重试，写入回执丢失为 `RPC_OUTCOME_UNKNOWN`，不自动重投。侧栏与预览共用 `workspaceClient.js`。调用方从 Chrome 原生 sender 判定，不接受消息自称的角色。
- 页面：`pageActionHost.js` 负责文档目标、快照、同 tab action 排队；`documentTarget.js` 负责文档前置校验。不要把这条队列描述为所有任意 sys 代码的串行执行器。
- 生命周期：`browserExecution.js` 统一取消、CDP 清理、租约释放与 SW 启动对账；`tabLease.js` 只由 SW 配置 storage.session 持久适配器。
- 打包：`python scripts/pack_extension.py` 后执行 `python scripts/verify_extension.py extension --source .`，检查字面量本地依赖与源码字节一致性；不代替浏览器测试。
