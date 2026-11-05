# Compact 与原始意图：源码审查及修复

2026-09-20。范围：上下文压缩、用户要求持久性、durable task 续跑。未启动浏览器、未调用真实模型 API。

## 判断

原始消息没有因 compact 从存储中被删掉；但旧实现的模型输入存在意图丢失风险，不能把“数据库还在”当成“模型仍记得”。

保留的设计：`session.messages` 全文持久化；80% 窗口触发；至少保留最近两个 user turn；durable task 每步从 store 注入 originalGoal/plan/checkpoint；普通聊天不自动新建 task；有效 activeTaskId 会延续任务上下文；崩溃不盲重放副作用；当前工具清单为八个（以 canvasInventory.js 为准）。

确认的问题及改动：

| 旧路径 | 修复 |
|---|---|
| user 每条截前 400 字，打包后再截前 12000/8000 字；早期工具正文挤掉后续用户要求 | 用户要求优先分配摘要输入预算，按时序输出，最近内容优先；显式标明省略 |
| 每次重新压缩全部历史，旧内容反复占据预算 | 上一份摘要 + 新覆盖的历史 |
| 首份模型概括成为 immutable goal，后续用户显式变更也可能被反压 | 保留历史概括但标明非用户权威；明确纠正/取消/替换优先，局部子任务不自动取消整体目标 |
| 源用户要求只有 UI 可见，压缩后模型只见摘要/tail | 每 hop 从持久化消息派生有界原文，并提供只读 `/context/user-requests.json`；不重复保存全文 |
| 首次 compact 未将 Constraints 保存为提示 | 首次与后续均提取；这些提示仍从属于用户原文 |
| SDK 的 tool-result.output 未被计入正文；裁剪会产生非法 tool message | 按真实 SDK 数据结构估算/缩短，保留 toolCallId/toolName 和合法 output；所有结果共享正文预算，最新/多段结果也会裁剪 |
| wire replay 丢失 persisted messageId，mid-loop 无法定位折叠边界 | replay 保留 source ID；在展开 turn 的最后一个 part 后切，保持 call/result 配对 |
| prepareStep 先构建 instructions 再 compact，第一次 compact 的原文提示晚一跳 | 当跳 compact 后重新读取原文和历史目标提示 |

## 来源与权限

`sessionIntent.js` 直接读取 `session.messages` 中 role=user 的内容，保留 messageId、createdAt、content。澄清卡的实际用户 answers 在 clarify 返回后、工具投影截断前单独原样保存在 session.userClarifications；提问/方案仅作为上下文标注，不自动视为用户要求。任意网页和普通工具结果不能进入这份来源集合。`/context/conversation.json` 另提供带角色的原始对话，用于解析“按你的第二个方案来”等指代。原文 JSON 虚拟文件在每次读取时派生，因此旧安装无需迁移，恢复 store 后即可读取，guest 不能覆盖它，也不能跨 session 读取。

注入预算为 `max(600, min(12000, contextWindow * 0.12))` 字符量级，能容纳时保留全部用户要求；超预算时分配一部分给早期多轮对话，大部分给最近要求，恢复时序。超过预算的内容用首尾摘录并显式标记；完整原文可用 `run` 执行 `JSON.parse(await fs.readFile('/context/user-requests.json'))` 后按 ID/范围筛选输出，避免把整个超长会话重新灌入模型。

“原始用户要求”指多轮用户陈述与澄清选择的可追溯来源，不等于第一句话；模型按多轮上下文整理目标/约束/未决问题，失败时不再取第一条像请求的话充当目标。这不是永久保留最初任务执行优先级：历史记录不改写，但用户可明确更换目标。durable task 仍是显式 taskRun/taskId 才绑定；同 session 的后续话语只有明确涉及该任务时才是修正，普通新话题不改变它。task checkpoint 应保留适用的修正及源消息 ID。

## 官方实践对照

- [OpenAI Codex `compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)：收集真实 user messages，保留源身份，按最新优先在有界预算内重建历史。这支持“摘要之外保留用户原文”，不要求Browser Kitten改用 OpenAI 专用 compact API。
- [Claude Code memory](https://code.claude.com/docs/en/memory)：持久记忆与会话上下文分开；有界索引配合详情按需读取。这里采用会话内原文归档，不引入跨 session 的自动偏好推断。
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)：PreCompact/PostCompact 提供围绕 transcript 和 summary 的保存/恢复时点。Browser Kitten采用宿主每步重注入，当前未接入额外 hook。

## 验证与边界

`tests/context-compact.test.mjs` 覆盖长指令末尾约束、重复 compact 的增量范围、用户显式换目标、首份约束、durable store flush/reopen 原文恢复、只读/会话隔离、真实 SDK token 估计和配对、当跳刷新，以及实际 bundled ToolLoopAgent 多跳接收并延续缩短后的工具结果。模型为本地桩。

信息摘要仍有损；原文保留和优先级提示降低漂移风险，不能证明模型一定理解全部要求。超大单条用户输入、不可删除的工具协议占位、系统提示和工具 schema 本身占满窗口仍可能溢出；本次不声称解决任意长度上下文，也未改变现有任务完成证据的宿主验证边界。

Chrome 手测：长会话给出原目标与末尾约束，触发 compact；增加局部子任务，检查整体目标仍在；明确取消/替换目标，再次 compact；刷新扩展并续跑，验证模型可按消息 ID 读取原文、遵守最新修正。另验证 scheduled task 续跑能保留属于该任务的修正，同时普通新话题不误改它。

当前代码使用确认过的 Durable Task 合同记录任务范围，普通消息原文继续作为用户要求注入。`intentState` 提取与 `sessionGoal` 独立注入已停止消费；原文归档、clarify 持久化和 Compact 预算仍保留。

## Session 意图保持 v1：终点与实现

（历史实现。模块仍在仓库，当前代码不再每条消息提取。）终点曾是持久化、增量修订、每跳加载、结束前语义核对和机制回归；不包含跨 Session 记忆、编辑 UI、向量检索或宿主业务完成证明。

`session.intentState` 保存 revision、items、processedMessageIds、更新时间和固定类别的最近错误。项目使用稳定 ID，区分 objective / constraint / completion / question，状态为 active / cancelled / superseded，可关联已有 taskId，并保存用户/被采纳助手方案的 sourceMessageIds。省略项目不删除，原始消息始终独立保留。宿主检查出处和结构，无法确定性判断语义正确。没有自动按助手的“已完成”声明关闭目标；任务进度仍由 task 管理。

收到新用户输入或 clarify 后，prepareStep 在业务推理前执行一批独立文本提取。使用本轮 chat 模型，不带工具、不写入聊天消息或工具轨迹。最多一次 doGenerate、10 秒、2048 输出 token；内部 no-retry 标记在 provider 发网络请求前删除，网络失败不代理重发。会增加一次模型调用的用量和等待时间，最长约 10 秒，非后台零延迟机制。

输入预算为最多 40000 字符、约 contextWindow 的 35%，保留结构/ID 开销；旧状态最多 160 项、24000 字符，单次最多 40 项变更。超限拒绝该批，不静默丢旧状态。完整的新原文及周围对话按近期优先进入；放不下的输入不标记已处理，带 omission 标记并指向原始档案，模糊引用要求留下 question。原文不截断后冒充完整输入。旧 session 首次继续时走同一路径，无需迁移，也不把 sessionGoal 升级为权威。

更新提交检查原输入指纹和 revision，晚到或过期结果不能覆盖新状态。失败保留旧状态和 pending 原文；同一 execution 同一输入只尝试一次，新 execution 可再尝试。成功位置持久化，重启无新输入不重提取。实际持久化沿用 store 的 flush 和恢复语义。

每跳独立分配约 contextWindow 的 10%、800–12000 字符的意图/待处理原文正文预算（提示框架另计），全部计入现有上下文估算。取消/替代历史仅在 `/context/intent.md` 完整投影中列出；摘录明确标记。普通结束前核对有效完成标准和证据，缺项应说明；这只是语义自检，不触发 task complete、不提升权限。

工具裁剪现在先保留合法 tool-result 协议占位，再在所有结果之间分配共享正文额度，最新单个大结果和多段结果不能各自绕过额度。不可删除的调用身份/占位本身存在最小开销，极小预算下不会为满足数字而删除协议配对；总窗口估计仍包含这部分。

### 验证记录与 Chrome 手测

新增 session-intent.test.mjs 用模拟输出覆盖增量更新、来源校验、取消/替代、超时、失败不重试、过期结果拒绝、恢复、跨会话隔离、同跳 clarify 刷新、缺失引用及 task 归属、超大输入，以及真实 bundled provider 的文本序列化和无重试。模型桩能验证状态机，不能证明真实模型理解质量。

1. 重新加载扩展，新会话先问候，再给出目标；通过 run 读取 `/context/intent.md`，检查问候没有被固定为目标。
2. 让 Agent 提出两个方案，再说“用第二个，保留草稿，不发送”；检查目标和限制引用采纳消息与助手方案。
3. 加入状态询问，然后明确替换/取消一个目标；有效项应更新，其他约束保留，历史项仍可追溯。
4. 通过 clarify 修改范围；下一跳读取文件确认 revision 更新且答案被引用。
5. 制造长会话触发多次 Compact，重新加载扩展后继续；核对意图仍在、新输入才触发提取。
6. 在 offscreen 网络面板检查独立请求：无 tools、输出上限 2048；正常时每批一次，断网/超时时不代理重发，业务路径仍可获得未处理原文。
7. 分别跑普通会话和已有 scheduled task：状态不会自动绑定任务、取消任务或证明完成；检查最终答复是否逐项说明交付证据与剩余事项。

本次不启动浏览器、不调用真实收费 API；上述 Chrome 行为与真实模型语义效果由用户手测。
