# Browser Kitten · Chrome BOT 架构优化与交付说明

日期：2026-09-17  
版本：`1.2.0-bot-candidate`（manifest.version 为 `1.2.0`）  
基线：用户上传的 `BrowserBot.zip` 工作区，包含尚未提交的 Durable Task / tab lease 改动；不是只基于 origin/main 的 v1.1.0。  
状态：已修改源码、补充回归、修复打包；真实 Chrome / 真模型全链路验收未完成。未提交 commit、未推送仓库、未创建官方 release。

## 1. 架构判断：保留执行器，补可靠执行

当前项目已经有浏览器 BOT 的主要骨架：offscreen 中的 Agent、当前登录浏览器中的 action/sys、任务进度对象、alarms 唤醒与用户可干预的侧栏。没有必要为“BOT”再创建第二套执行框架。

这次优化的重点是：同一任务实际在什么页面、由哪次执行、以什么权限操作；失去回执时不误判成功或失败；执行结束后能否正确交还资源。工具数量、面板大小、目录深度不是这轮最主要的瓶颈。

建议保持三块职责：

| 部分 | 负责什么 | 不负责什么 |
|---|---|---|
| Task：任务进度 | goal、plan、evidence、dueAt、暂停/继续/完成 | 不记录每个浏览器调用，不保证副作用 exactly-once |
| Execution：本次执行 | 单 session 执行槽、取消、工具循环、资源归属 | 不跨崩溃续接原始调用栈，不等于永久后台进程 |
| 浏览器宿主 | 校验调用者、占用 tab、核验文档、派发 action/sys、返回事实或未知 | 不替模型认定业务目标已完成，不盲目重试写操作 |

用户审查文档 §1 明确保留的边界，本次均未改：普通 send 不自动建 task；同 session 不并发 turn；不做 call journal、exactly-once 和盲目副作用重放；不增加 hop 上限；不隐藏工具；不加 native companion；不上 CWS；不改 `browserbot_*` 存储键；不要求用户换 Chrome profile。

## 2. 优化后的主要执行路径

```text
侧栏 / 预览页
    │ 共享 workspaceClient：保留冲突信息，写入丢回执 = unknown
    ▼
Service Worker
    │ 原生 sender 身份 + RPC 方法清单 + 调用角色
    ▼
offscreen：SessionWorkspaceService
    │ 同 session 在首个 await 前预占执行槽
    │ Task 仍可选；Agent 仍只有一套
    ▼
Service Worker 浏览器宿主
    │ 首次派发前：恢复 storage.session 租约，与 offscreen 活动执行对账
    │ 页面操作前：核验 execution、占用 tab、检查目标文档
    ├─ action：snapshot → documentId + rev → 派发 → 后续观察
    └─ sys：documentIds 定向执行；CDP 归属本次 execution
    ▼
回执：已知结果 / 明确拒绝 / 结果未知
    │
执行结束：撤销后续派发资格 → 取消可取消调用 / detach CDP → 释放 tab
```

这不是新增微服务，也不改变 Chrome 进程划分。只是让现有进程之间的合同更明确。

## 3. 已落地的修改

### 3.1 RPC：从“公开方法都能调”改为显式清单

原审查文档指出 offscreen 通过公开 async 方法反射分发。现在新增 `workspaceRpcContract.js`：方法名、内部/界面调用范围、可否安全重试均明确登记，增加 service 方法不会自动暴露。

SW 根据 Chrome 原生 sender.id、sender.url、sender.tab 判断角色，不信消息中的自报角色。侧栏不能调用内部 scheduler；预览页仅保留交付物读写需要的方法；offscreen 拒绝界面绕过 SW 直接调用 service。这个清单验证外层参数必须为对象；**没有把所有领域方法改为完整的逐字段 schema**，具体语义仍由原方法验证。

新增 `workspaceRpcTransport.js`：SW→offscreen 的只读方法才允许有限重试。任何写调用在已调用 sendMessage 后丢失回执，都返回 `RPC_OUTCOME_UNKNOWN`，不再自动重投。

侧栏及 sheet/docs/site/artifactPreview 四种预览统一使用 `workspaceClient.js`，处理界面→SW 丢失回执，并保留 `ARTIFACT_CONFLICT` / actualRevision。原本预览页重复的 RPC 包装已删除。

关键路径：
`workspaceRpcContract.js`、`workspaceRpcTransport.js`、`workspaceClient.js`、`src/offscreen/runtime.js`、`src/background.js`、`src/preview/{sheet,docs,site,artifactPreview}.js`。

### 3.2 tab 租约：跨 SW 重启保留，恢复失败不冒险派发

`tabLease.js` 接入 `chrome.storage.session`，键为 `browserbot_browser_leases_v1`。记录 sessionId + executionId + tabId + kinds；操作串行更新，先成功登记再放行。恢复数据损坏、读写失败时拒绝执行，不把“读不到”当成“没人占用”。

SW 第一次处理浏览器调用/调度时，通过 offscreen 内部 `getBrowserRuntimeState` 对账。确认已不存在的执行才清理；无法取得可信运行状态则保留锁并报错，未增加“过了若干秒就抢锁”的逻辑。

`storage.session` 不是磁盘持久化：可跨 SW 生命周期，但浏览器重启、扩展禁用/重载/更新会清空。[1] 任务进度仍在 IDB，二者寿命故意不同。

同一执行允许重入；不同执行不能抢同一 tab；`grant` 不再覆盖已有持有者。关闭 tab 也要占锁；CDP 的 targetId 必须解析到页面 tabId，不能通过另一个标识绕过锁。

边界：这是**同 tab 的执行互斥**，不是同账户、同订单等跨标签业务资源的互斥；也不是浏览器已经受理的每个副作用的恢复日志。

### 3.3 页面身份：不再只相信 tabId、frameId 和 URL

新增 `documentTarget.js`，把 action 快照绑定到各 frame 的 documentId 和 URL；rev 改为不透明随机值，避免 SW 重启后再次生成相同 t1，误接收旧引用。

新增 `pageActionHost.js`，从 background 抽出页面操作运输。当前所有 mutate，包括按 name 点击和不带目标的 press，都必须带最新 rev。真正发送时使用 `tabs.sendMessage(..., { frameId, documentId })` 定向；取不到文档身份直接拒绝，不退回只按 frameId 执行。[2][3]

注册 `onBeforeNavigate`、`onCommitted`、`onHistoryStateUpdated`、`onReferenceFragmentUpdated`，以及 tab 关闭/替换的失效处理。同 URL 的新文档、SPA 路由变化，都不能直接沿用旧快照。

`sys.eval`、`sys.waitFor`、`sys.fetch(as:"page")` 改为 `userScripts.execute` 的 `documentIds` 目标；可传 `documentId`、`expectedUrl` 检查上一次观察。Chrome 135 的该接口已有 documentIds，不需要提高项目最低版本。[4] `sys.tabs.current` 只使用显式 tabId 或本轮 defaultTabId，缺省不再偷偷切到焦点标签。

边界：documentId 保护的是文档身份，不能把同一文档内所有 DOM 变化变成原子事务。sys 调用未提供旧 documentId 时，只保证从本次解析目标到执行使用同一文档，并不证明它仍是模型早先看到的页面。CDP 和任意 sys JS 也没有获得完整 DOM 后置条件验证。

### 3.4 执行结束：统一取消、CDP 清理与放锁

新增 `browserExecution.js`，结束流程精确对应 sessionId + executionId，而不是按 session 宽泛释放。先登记本执行已结束，阻止后到的浏览器调用；再取消 SW 中可取消的 sys 调用、释放所属 debugger attachment，最后交还 tab。

CDP attachment 增加执行归属；结束时主动 detach。SW 内存失效后的 CDP 清理可利用恢复出的租约 kinds 定位页面管道。[5]

同 session 的槽位现在在首个异步准备动作之前登记，堵住两个 send 同时通过 busy 检查的窗口。旧 executionId 的 abort 不能停止同 session 已开始的新 execution。

边界：结束登记是最多保存 2048 个执行身份的延迟消息拦截，不是无界 journal。取消等待和 detach 都不能撤销网页已经收到的提交。若 CDP 的具体浏览器释放行为异常，仍需实机验收；本轮未证明跨崩溃 exactly-once。

### 3.5 结果表达：不把没收到结果写成成功

`sysClient.js` 及共享 RPC 客户端将通信丢失明确返回为 unknown。userScripts 空结果、缺失包装回执、返回文档不匹配，不再冒充 `{ok:true}`。

单个页面写入丢失回执为 `ACTION_OUTCOME_UNKNOWN`；多 frame fill_form 在首次失败/未知处停止继续派发，保留已知部分结果并把 unknown 传播到顶层。它没有变成原子事务。

动作已经有成功回执、但随后 snapshot 因卸载等原因失败时，结果保留动作回执并单列 `observationError`。这样不会诱导模型把“看不到结果”当成“还没执行”，再次提交。

prompt 版本更新为 `v11-browser-execution`，action schema、SYS 帮助与 AGENTS 同步这些规则。

**仍未实现**宿主验证 task complete：task evidence 仍是模型填写，不是宿主独立证实；动作回执不等于业务完成。

### 3.6 发布路径：测试的代码必须真的进入扩展包

原 `pack_extension.py` 仅用 `git ls-files`，会漏掉上传工作区里尚未跟踪的 Task 模块，也会漏掉本次新增模块。现在按当前工作区的 manifest/LICENSE/src/icons 运行目录打包，不依赖 `.git`。

显式过滤隐藏文件、开发文档、常见凭据文件与非运行扩展名，拒绝运行目录中的符号链接；不把 dist/output/整个仓库递归塞进扩展。过滤不是对任意源文件里的秘密进行完整审计。

新增 `verify_extension.py`，检查 manifest 路径、HTML/CSS 资源、字面量本地 JS import 及运行源码与打包文件逐字节一致；CI 加入验证。检查不涵盖所有运行时计算出来的 URL，不能替代浏览器加载。

## 4. 不应该在这轮顺手改变的东西

没有用“同 session 并发”掩盖长任务阻塞，也没有引入第二套 Agent；没有把 workLock 与 tab lease 合并；没有为了小文件数量去拆散所有业务文件。

没有把 alarm 改成后台永不间断的承诺。Chrome 的 alarm 可能延迟，休眠不会被 alarm 唤醒；因此仍只唤醒，Task store 保持权威。[6]

没有以“BOT 必须有 journal”为由突破原约束。没有 call journal 仍可以做有检查点、可暂停、到期尽力唤醒的任务，但必须接受中断处需要观察和确认，而不是宣称自动续接任何副作用。

sidepanel 的大型 UI 文件、三套 skill、快照式持久化仍保留。这些值得治理，但优先级低于先保证不会串页、重复写入和错误放锁。

## 5. 下一阶段建议（本次未实现）

### 第一优先：让“完成”成为可核验事实

为会产生外部结果的 Task 增加结构化完成条件，例如“订单状态变成已提交、订单号符合预期”，宿主读取页面/响应核验，再关联 evidence。保持现有 task 状态及字段迁移兼容，不只是增加 prompt 文案。未知结果先核验，禁止直接重放。

同时把未来/周期任务的授权从 prompt 约束落实为宿主保存的授权范围：允许哪些站点、操作、有效期，哪些不可逆步骤需确认。范围应由用户界面或明确用户动作形成，不能由模型自行签发。本次 sender/RPC 安全边界解决的是“谁能调用”，尚未解决“被授权做哪些业务动作”。

### 第二优先：事件触发任务与可控调度

当前导航监听只用于目标失效，并没有实现“页面出现某结果就唤醒 BOT”。未来可将用户明确授权的导航/页面条件转换成 Task 唤醒条件，同时增加去重、冷却、目标匹配与取消入口；不要在每次导航时无条件启动模型。

保留同 session 单执行。需要长期岗位式任务时，先设计公平排队、超期处理、站点速率限制、可选时间/费用预算，再决定是否改变无限 hop 契约。不要简单加第二执行器造成工作区和账号资源冲突。

### 第三优先：更细的资源约束和长期存储治理

同 tab 租约不等于同账户资源锁。多标签共同修改同一对象时，需要由具体业务定义冲突资源，不能默认锁住整个域名，也不能假装当前实现已覆盖。

工作区很大后再做记录级增量提交、可证明归属的 OPFS 清理、执行审计和按风险分层的浏览器回归。审计可以记录任务状态/验证结果，不必等同于自动重放 call journal。

## 6. 验证记录与真实限制

上传基线：`node --test tests/*.test.mjs` 为 **55/55**。  
优化后：同一命令为 **96/96**，新增 **41** 个测试；原有 55 项继续通过。  
新增回归覆盖显式 RPC、原生 sender 角色模拟、丢回执不重投、跨 SW 租约恢复模拟、存储失败拒绝、旧 abort 隔离、文档变化、action 排队、CDP 所有权与释放、无 Git 打包及漏包/源码漂移检测。

仅对原测试中受 documentId 接口/模块抽取影响的夹具和路径作相应调整，没有删除原语义断言。新增测试主要是 Node + Chrome API 模拟，不能证明真实 Chrome 的全部生命周期时序。

**真机烟测未完成，不算通过。** 本环境 Chromium 144.0.7559.96 的待测 extension service worker 未启动；另行检查 `chrome://extensions/` 返回 `net::ERR_BLOCKED_BY_ADMINISTRATOR`。未修改或绕过管理策略。失败日志与结构化 evidence 见交付源码的 `output/verification/`。不能由这些失败进一步断言候选包在用户 Chrome 上运行成功或失败。

本轮没有调用用户真实模型、没有真实账户写入，没有验证机器休眠/唤醒、Chrome 重启、Univer 完整交互、多站点多 frame 导航、F12/CDP 争用等。交付是完成代码优化的候选版本，不是已实机认证的正式发布。

静态完整性、语法检查与最终测试摘要见 `output/verification/verification.json`；命令日志一并保留。

## 7. 使用与本地验收

先停止运行中的任务并保留原源码目录。补丁以**本次上传的工作区**为基线；不是以 origin/main 为基线。先检查再应用：

```sh
git apply --check /path/to/BrowserBot_ChromeBOT_1.2.0_changes.patch
git apply /path/to/BrowserBot_ChromeBOT_1.2.0_changes.patch
node --test tests/*.test.mjs
python3 scripts/pack_extension.py --zip dist/BrowserKitten_ChromeBOT_1.2.0_extension.zip
python3 scripts/verify_extension.py extension --source .
```

有冲突时不要强行应用；用交付源码与当前工作区对比合并。源码包不带 `.git`、旧产物、原机器路径配置或浏览器 profile。

原扩展的加载根仍是仓库根。要保留原扩展身份和已有数据，优先在原路径更新文件后重新加载，不要先卸载原扩展。运行 ZIP 解压后的根目录有 manifest.json，可作为单独候选测试目录；新路径加载不要默认视为迁移了旧扩展数据。

最低 Chrome 版本仍为 135，未新增权限。User Scripts 的开关按现有产品要求配置；Chrome 138+ 为扩展卡上的 Allow User Scripts。[4] CDP 仍显示浏览器原有调试提示，不隐藏横幅。

已有 Playwright 环境可运行（不引入 npm 构建依赖）：

```sh
BROWSERBOT_LOAD_ROOT=extension node tests/browser-smoke.cjs /path/to/playwright
# 可按本地环境提供已有、允许加载扩展的浏览器路径；不修改组织策略：
BROWSERBOT_CHROMIUM_EXECUTABLE=/path/to/chromium BROWSERBOT_HEADLESS=false \
  BROWSERBOT_LOAD_ROOT=extension node tests/browser-smoke.cjs /path/to/playwright
```

脚本使用临时独立 profile、不读取日常浏览数据；该 profile 仅用于隔离测试，不是产品要求的多任务运行方案。脚本覆盖存储、沙箱、artifact 冲突及部分 RPC 原生边界；下列生命周期情境仍须另外人工验收：

| 情境 | 预期 |
|---|---|
| 普通 send / 主动 schedule | 普通 send 不建任务；明确 schedule 才出现 task |
| A 占有 tab，B 点击/关闭同 tab | B 收到 TAB_LEASED，不应产生该页面副作用 |
| action snapshot 后刷新同 URL / SPA 切页 | 旧 rev 被拒绝，重新 snapshot 后才允许动作 |
| 运行中 SW 被浏览器终止后再触发调用 | 活动执行的锁保留；旧快照必须重取；不自动重放旧写入 |
| 旧 execution 的迟到 abort | 不停止新 execution |
| CDP 执行结束 | 只释放自身 attachment；确认未误伤新执行 |
| RPC 写操作丢回执 | unknown；先检查是否已发生，不直接重发 |
| 后台 Task 唤醒时 session 忙/目标冲突 | 保持原有跳过与后续唤醒语义，不并发启动同 session |

## 8. 依据与来源

项目事实来自上传源码和《Browser Kitten · 进度与架构审查》§1、§2、§4；以源码核对，不将旧文档里的 H# 假设直接当成结论。用户提到但未提供的 09-16 技术盘点、browser-agent 对比原文没有被假定已读取。未来优先级为本次架构判断，不是 Chrome 官方结论。

核对的 Chrome 官方资料：
[1] Storage：Session 的寿命与可见性。
[2] webNavigation：frameId 跨导航不变、documentId 标识文档、history/fragment 事件。
[3] tabs：sendMessage 的 documentId 定向。
[4] userScripts：documentIds / execute 的版本支持及 User Scripts 开关。
[5] debugger：target、attachment、detach。
[6] alarms：休眠、触发延迟与重建。
[7] Messaging：内容脚本消息的信任边界和 sender 检查。

```text
https://developer.chrome.com/docs/extensions/reference/api/storage
https://developer.chrome.com/docs/extensions/reference/api/webNavigation
https://developer.chrome.com/docs/extensions/reference/api/tabs
https://developer.chrome.com/docs/extensions/reference/api/userScripts
https://developer.chrome.com/docs/extensions/reference/api/debugger
https://developer.chrome.com/docs/extensions/reference/api/alarms
https://developer.chrome.com/docs/extensions/develop/concepts/messaging
```
