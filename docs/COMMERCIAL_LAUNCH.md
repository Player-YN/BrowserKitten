# 账户、服务商与代理接口接线

本文仅记录本扩展源码的接口行为。后端实现位于独立仓库，本文件不声明其部署状态、套餐定价或服务端数据保存策略。

## 登录与退出

实现：`src/agent/cloudAccount.js`、`cloudModels.js`。

`chrome.identity.launchWebAuthFlow` 打开所选 origin 的连接页，校验 OAuth state 后用一次性 code 请求 `POST /api/device/exchange`。账户记录 `browserbot_cloud_account` 保存设备令牌、deviceId、origin、filled 与 connectedAt。`GET /api/me` 获取权益、用量和 hosted 能力；`GET /api/v1/models` 检查对话服务可用性。

`planCloudSignIn` 按服务端 `hosted` 能力加入 `bk_cloud_chat|image|stt|jev` 记录；保留用户已有且可用的自有活动服务商。Tavily / Firecrawl 槽位为空或已指向本服务时更新。退出调用 `/api/device/revoke`（best-effort），移除云服务商和仍指向本服务的 web 槽，清理账户及权益缓存。

unpacked 构建可通过 `browserbot_cloud_origin` 选择 `https://staging.browserkitten.com`；manifest 带 `update_url` 时固定使用正式 origin。登录后的请求使用账户记录内的 origin。

## 请求路径

| 服务 | 扩展请求 |
|------|----------|
| 对话 | `/api/v1/chat/completions`、`/api/v1/models` |
| 生图 | `/api/v1/images/generations` |
| 转写 | `/api/v1/audio/transcriptions` |
| System1 delegate | `/api/v1/chat/completions`，云记录带 `x-bk-purpose: executor` |
| System1 设置探测 | 与 delegate 相同的 `/chat/completions`，无页面操作的完成决策 |
| 旧 choose 路径 | `host/jevSelect.js` 的 System1 `/systemone` 请求 |
| 搜索 | `/api/tavily/search` |
| 抓取 | `/api/firecrawl/…` |

云服务商的模型路由名在 `cloudModels.js` 中固定，实际路由由服务端处理。自有 Key 使用用户配置的 base URL。

## BYOK 门与错误处理

`byokGate.js` 在受限构建中检查付费 plan。unpacked 默认豁免；`browserbot_byok_enforce_unpacked = true` 可启用检查。权益缓存 `browserbot_cloud_entitlement = { plan, checkedAt }`：72 h 内有效，超过 6 h 尝试刷新，网络失败时仍按 72 h；退出和 401 清理缓存。

`BYOK_REQUIRES_PLAN`、积分耗尽、用量限制等由 `cloudAccount.js` 与侧栏通知模块处理。客户端配置和缓存不能授予服务端权益。不调用模型的个人工具与结构化 Workflow 不经过模型代理。

## 验证

相关回归：`cloud-account.test.mjs`、`cloud-origin.test.mjs`、`byok-gate.test.mjs`、`provider-fetch-proxy.test.mjs`。真实登录、服务可用性和计量需要另外验收；完整回归命令见根 README。
