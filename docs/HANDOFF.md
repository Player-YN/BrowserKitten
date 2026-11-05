# 技术交接索引

当前扩展架构与行为见根 [AGENTS.md](../AGENTS.md)、[Chrome 宿主说明](../src/AGENTS.md)、[Agent runtime 说明](../src/agent/AGENTS.md)。本文件不记录产品定位、定价、市场决策或旧会话的操作授权。

## 当前源码入口

- `src/agent/cloudAccount.js` / `cloudModels.js` / `byokGate.js`：账户、origin、服务商与权益门。接口说明见 [账户接线](COMMERCIAL_LAUNCH.md)。
- `src/agent/vnext/service/sessionWorkspaceService.js`：RPC、执行槽、模型解析、任务启动与宿主门。
- `src/agent/vnext/host/operationGate.js` / `callJournal.js` / `dispatchTicket.js`：分类、审批、write-ahead 与一次性工单。
- `src/agent/vnext/host/pageActionHost.js` / `browserExecution.js` / `tabLease.js`：页面派发、生命周期与租约。
- `src/agent/vnext/sessionWorkspace/delegateExecutor.js`：System1 点击、填选执行。
- `src/agent/vnext/workflow/`：结构化流程定义、录制、回放与恢复。
- `src/sidepanel.js` / `src/sidepanel/`：UI 编排与事件渲染。

Git 操作约定与验证命令见根 AGENTS.md，不从历史文档推断当前远端、部署或服务状态。

## 外部后端的历史账本记录

以下摘自 2026-09-26 交接，仅作为独立后端代码的核验线索；本次没有读取后端源码，不能据此声明当前部署或不变量已经验证。后端的接口、数据策略与并发测试必须在其所在仓库核验。

文件：`server/ledger.js`（核心）、`server/proxy/metered.js`（请求流程）、`server/proxy/chat.js`（流式计费）、`server/billing.js`（Paddle → 积分）、`server/usageLimits.js`（限额）、`server/pricing.js` + `server/catalog.json`（定价）。

**模型**：积分以 grant（批次）形式进来——订阅周期 / 加油包 / 试用；每个请求一条 `bk_usage`（held → settled | released），`allocations` 记录从哪些 grant 扣了多少。只存计量，从不存内容。

**历史记录中的不变量**：
- **不超扣**：同一用户的所有余额变更（reserve / settle / revoke）先拿**按用户的事务级 advisory lock**，完全串行；不同用户互不影响；单一锁序，不可能死锁。
- **余额不为负**：结算超出预扣时最多扣到 0，差额记 `absorbed`（我们承担，Sentry 报警）。
- **幂等**：grant 以 `(source, source_ref)` 唯一，webhook 重放无效；订阅事件按 `occurred_at` 排序，旧事件不覆盖新状态；settle 对非 held 行无操作。
- **退款不复活**：`revokeGrant` 置 `revoked_at`，被撤销的 grant 永远不再接受退还（`forfeited` 记账）。
- **不变量**（`auditLedger`）：每个未撤销的 grant，`amount − remaining = 所有 held/settled 行对它的 allocations 之和`。每小时 cron 跑一次，不一致即 Sentry 报警。
- **结算失败重试 3 次**（指数退避），仍失败则 Sentry 报警（否则 cron 会按全额预扣结算，多扣用户）。

**历史记录中的修复项目**：并发下先读余额后加锁的超扣漏洞；预扣/结算锁序相反导致的死锁；进行中的请求在退款后把积分"退回"已退款的 grant；流式中断只按输出计费、漏算输入（我们亏）；结算写库失败不重试。
