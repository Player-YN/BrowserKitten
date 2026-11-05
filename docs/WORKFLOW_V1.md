# Workflow 合同：可录制的浏览器自动化

Workflow 是用户持有、可版本化、可重复运行的流程定义。当前个人库包含两类 Workflow：

- **自动化**：`workflow.version: 2` 的结构化流程，由 offscreen 执行器运行，不解析模型、不需要 Key。支持录制、循环、抓取、分支、CSV 与（浏览器仍打开时的）定时新运行。
- **Agent 任务**：已有 `instructions` 文字 Playbook，继续创建普通 Agent 对话。

工具是独立的 QuickJS 脚本。自动化可以把工具作为一个步骤，但不解释工具内部控制流。模型只能通过制作对话修改草稿；发布必须由侧栏的「添加／更新」执行。当前步骤 schema 没有 Agent 节点；宿主未提供页面 CustomEvent / webhook 发布入口或原生 OS 控制接口。

## 模块与职责

`agent/vnext/workflow/definition.js` 冻结数据合同及校验，`recording.js` 合并录制事件，`engine.js` 调度步骤（含循环与分支），`service.js` 管理草稿、执行槽位、恢复、CSV 与到期新运行。侧栏的 `workflowUi.js` 负责录制、步骤编辑、表 / 变量 / 定时字段、显式发布和运行监控。

`host/workflowHost.js` 只负责录制运输、标签清单、目标高亮与下载核查。`host/workflowScheduler.js` 用 `chrome.alarms` 唤醒 **新的** 已发布运行。回放页面操作仍经 `_gatedPageAction` / `pageActionHost`，工具仍经 QuickJS / `_gatedSys`，复用既有权限、journal、ticket、documentId 和标签租约。录制、保存、发布、定时都不会提高浏览器权限。资料组不参与授权。

## 定义合同

流程包含 `version`（必须为 **2**）、`tabs`、`steps`，以及可选的 `variables`、`table`、`schedule`。标签保存 `{id,title,url?,opener?}`；`id` 是流程内别名。定义禁止真实 tabId、临时 ref/rev、documentId。每个步骤有稳定 `id`、`title`、`op`；页面步骤引用 `tab` 别名。

支持的操作：`open / focus / navigate / click / fill / select / press / scroll / read / wait / check / tool / manual`，以及 `hover / dblclick / contextmenu / toggle / upload / scrape / paginate / foreach / repeat / if / setVar / csvImport / csvExport`。

目标包含 role/name/type/region/id/testId/css/tag/frameUrl/key/shadowPath/text 的组合。录制时按 Playwright 风格优先生成 testid、id、role+name、name、text，最后才是 CSS。**回放仍是唯一匹配**：所有指定约束都必须匹配；零个或多个候选均停止。iframe 用 `frameUrl`；Shadow DOM 用 `shadowPath`。循环元素的身份必须是稳定键（testid / id / name / text / href / key），**禁止把 CSS nth-child 当作身份**。

参数仅使用 JSON 字面量或 `{"$ref":"input.customer"}`、`{"$ref":"steps.readName.text"}`、`{"$ref":"loop.row.title"}`、`{"$ref":"vars.total"}`、`{"$ref":"table.rows"}`。不求值表达式，没有 mustache / JS。输入 schema 沿用个人工具库的基本类型子集；集合来自流程表、抓取结果、字面量数组或 `table` 覆盖，不是个人库数组参数。

检查类型为 URL、元素出现/消失、文字、字段值、下载完成、工具返回值、文件存在。打开/聚焦/读取/手动/循环与分支/变量/CSV 导入/抓取默认不强制检查；其他自动写操作必须配置成功检查。宿主点击回执不能替代检查。

### 循环、分支与失败处理

- `foreach`：遍历显式集合（`table.rows`、先前 `scrape.items`、字面量数组）。`source: "elements"` 时每一项必须带稳定 `key` 与唯一 `target`。循环体用 `loop.row` / `loop.index` / `loop.key`。`max` 上限 200。
- `repeat`：重复 N 次，上限 100。
- `if`：对先前输出或检查做 `equals` / `contains` / 真值判断，然后走 `then` / `else`。
- 每步可选 `onError`：`retry`（最多 5 次）/ `stop` / `fallback`。**未知派发（phase 仍为 `dispatching`）不能 fallback 或继续**；fallback 分支里的写操作仍走 journal。

### 抓取、分页与交互

- `scrape`：`kind` 为 `table` / `links` / `attributes`；输出 `{items,count}`，键必须唯一。
- `paginate`：`next` 或 `loadMore` 作为一等步骤，并带成功检查（通常是 next 消失、URL 或页数）。
- `hover` / `dblclick` / `contextmenu` / `toggle` / `upload`：经既有 page action。`upload` 只接受 guest FS 路径（`/scratch` `/artifacts` `/context`）。
- **拖拽**：现有 page action 只有视口 `pointer` 点按，没有 drag 原语。录制生成带 `unresolvedReason: DRAG_UNSUPPORTED` 的手动步骤，不静默跳过。不要用 raw CDP 当工作流逃逸舱口。

密码、OTP、支付字段仍是手动步骤，定义里不存密钥。

### 容量

最多 **40** 个标签别名、**400** 个步骤（含嵌套）、单流程定义 **4 MB**、循环 **200** 项、抓取 **500** 行、分页 **50** 页、重复 **100** 次。达到录制限制会暂停并生成待处理项，不把截断内容当作完整流程。

### 定时

`schedule: { enabled, everyMinutes, input? }`。`chrome.alarms` 仅在浏览器 / 扩展仍存活时，为已发布流程启动 **一次新的 WorkflowRun**。崩溃中的运行仍需人工核查，**绝不** Automa 式 `reuseLastState` / 盲重放。页面 CustomEvent 与绕过 Access Policy 的 webhook 都不能发布或启动流程。

## 录制与编辑

用户显式开始录制；顶部持续显示状态及暂停、加入当前标签、停止控制。点选模式与录制互斥。初始标签和它打开的子标签按 opener 加入范围，其他现有标签必须显式加入。

内容脚本仅处理真实用户事件，并穿透 iframe 与 shadow root 生成定位。SW 根据原生 sender 补齐标签、frame、document 身份。连续输入合并为最终填写；点击/Enter 引发的导航合并为该步骤的检查。悬停（短停留）、双击、右键、复选框记入对应操作。文件选择与拖拽生成待处理手动步骤。识别为密码、验证码、令牌或支付字段的输入生成手动处理步骤，不传输或保存值。

暂停/停止先排空各 frame 的输入缓冲，再保存草稿。SW 重启、运输失败、存储失败会暂停并报告录制缺口。录制结束不会执行或发布。步骤编辑器支持循环 / 分支 / 抓取 / 检查、流程表 CSV、变量和定时字段。试运行到所选步骤具有真实副作用，并经过正常审批。

## 执行、暂停与恢复

每次运行新建执行会话及独立 WorkflowRun，固定定义版本、输入、表快照和工具快照。记录 nextStep、循环游标、标签临时映射、attempts、当前 attempt、输出与检查证据。sidepanel 不持有执行器。

步骤在派发前保存 `prepared`、`dispatching`；取得结果后保存 `checking`，成功检查后保存 `verified`。宿主调用使用 attempt ID 作为 operationId。写前记录失败时不派发。

- 暂停停止后续推进，可恢复；取消是终态。
- 浏览器、扩展或 offscreen 重启后，未结束运行需要用户核查，绝不自动续跑，定时器也只开新运行。
- 恢复先重新匹配/选择标签，然后重新观察目标和前置条件。
- 已完成步骤不重放。当前已派发但未知的步骤只能先验证结果、由用户确认完成、显式重试或取消。
- 用户确认记录为 `evidence.type: user`。没有可验证后置条件的未知操作不能“重新验证”后自动越过。

WorkflowRun 与 journal 在不同库中，不能原子提交；通过 attempt/operationId/requestId 关联核查，不承诺 exactly-once。

## 持久化与兼容

个人库 IDB 仍是 `browserbot-personal-library-v1`。正式定义必须是 `workflow.version: 2`。JSON 导出包含正式定义、历史及完整固定依赖，不含录制/运行记录、标签临时映射、cookies 或登录状态。没有云端服务。

## Node 与 Chrome 验收

Node：`node --test tests/*.test.mjs`。workflow 测试覆盖定义、循环、抓取、分支、唯一目标、CSV、上传、悬停、shadow/iframe 字段、定时开新运行而非续跑，以及既有录制/恢复/权限回归。

Chrome 实机验收由用户执行。建议：录制列表→详情；编辑 foreach / scrape / if；导入 CSV 跑 N 行；定时在浏览器打开时启动新运行；制造重名目标确认不停在第一项；崩溃后需人工核查。
