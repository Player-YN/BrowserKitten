# 自定义工具与 Workflow

工具是保存后可直接运行的脚本。运行复用本地 QuickJS 沙箱和现有 `fs` / `sys`，不调用模型、不要求 API Key。Workflow 包括确定性「自动化」与文字「Agent 任务」。自动化顺序执行页面步骤和固定版本工具，不调用模型；文字任务仍新建普通 Agent 对话。完整合同与 Chrome 验收步骤见 [Workflow 第一阶段](WORKFLOW_V1.md)。

## 制作与修改

从侧栏工具库选择新建，打开专用制作对话。Agent 先讨论目标、输入和成功标准，再把完整定义写到 `/artifacts/library-draft.json`。用户刷新草稿、查看内容、试运行，可以继续对话修改。只有点击「添加」才进入正式库。

编辑正式条目会创建独立草稿和制作对话，正式版本继续可用。点击「更新」按已审阅的草稿 revision 发布；并发修改会报版本冲突，不静默覆盖。历史回退产生新 revision。刷新与试运行均不会发布。

工具试运行结果写到制作对话的 `/artifacts/library-test-result.json`，供后续 Agent 排错。Workflow 试运行创建单独的执行对话，制作对话保留草稿。运行只发生在用户点击时；目前没有自动注入页面或后台触发机制。

## 数据与恢复

正式条目、历史版本和已刷新草稿保存在独立 IndexedDB `browserbot-personal-library-v1`。它与聊天/交付物数据库分离，不受删除聊天、清理工作区影响。正式条目保存完整脚本或完整步骤、参数 schema 和运行时版本，不依赖制作对话的临时文件。

正常关闭浏览器、扩展重新加载、相同扩展 ID 的版本更新保留数据库。卸载扩展、清理其站点数据、换浏览器 profile 或扩展 ID 不在此保证内；通过工具库的 JSON 导出/导入恢复正式条目与历史版本。导出不包含聊天和未发布草稿；文件最大 8 MiB。导入默认跳过相同 ID，不覆盖已有条目，不执行脚本。未知格式、运行时或不支持的参数 schema 会拒绝导入。

每次草稿更新、发布、删除、回退或导入，在同一 IDB readwrite 事务里读改写并等待 commit。存储不可用时明确失败，产品不会降级到内存假装保存成功。当前实现是整个个人库状态的一条原子记录，适合个人工具库；尚非大规模增量存储。

## 执行与权限

- 侧栏负责输入、审阅、显式发布、试运行与停止；不持有数据库、不执行脚本。
- Offscreen 的 service 校验草稿身份、参数及版本；为脚本登记执行槽位，经 `_gatedSys` 使用原有宿主政策、journal 和标签租约。失败、取消、完成均清理执行状态，脚本同样与本会话其他回合互斥。
- 工具运行只能使用 QuickJS 的 `input`、`fs`、`sys`，没有 extension `chrome.*`、网页 `document` 或本地 OS API。页面操作经 `sys` 转给宿主。Guarded 仍可能拒绝 raw eval；保存或点击工具不构成额外授权。
- 工具输出继续使用既有 artifact 校验和登记。宿主仍负责外部操作权限；SelectionGroup 仍只管理资料，不是权限记录。
- 文字 Agent 任务将版本快照放入新会话指导。结构化自动化使用独立顺序执行器和 WorkflowRun；每一步检查通过才推进，重启后需要核查续跑。两者都固定定义版本，不自动采用库更新。

参数支持 object 下的 string、number、integer、boolean 字段，以及 title、description、default、enum、required。复杂嵌套 schema 会明确拒绝。`scope` / `allowedHosts` 如存在，仅是适用范围描述，不是站点权限隔离。脚本自包含是制作合同；静态校验不能证明任意脚本永远适应网站变化，应通过试运行验证实际行为。

## 验证

`node --test tests/personal-library-*.test.mjs` 覆盖存储原子性与重开、版本冲突、导入回退、草稿隔离、无模型运行、真实 QuickJS、参数数据编码、取消、失败、RPC 调用角色和 UI 行为。完整回归仍使用 `node --test tests/*.test.mjs`。Chrome 实机的视觉、权限弹窗和重启体验由用户验收。
