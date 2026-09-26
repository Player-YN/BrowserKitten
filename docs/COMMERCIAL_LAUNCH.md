# 商业化上架：后端与清单

Browser Kitten 从 unpacked + 纯 BYOK 走向 Chrome 应用商店 + 订阅。

**后端已实现**，在私有仓库 `Player-YN/browserkitten-site` 的 `feat/backend` 分支（`api/` + `server/`，说明见该仓库 README 的 Backend 一节）。本文件记录设计取舍、扩展这边要接的东西，以及上架清单。事实以代码为准。

## 原则

- **runtime 仍在用户浏览器里。** 后端只做四件事：账号、订阅、积分、推理代理。不跑 agent 循环，不存会话，不碰页面。
- **每一类服务独立选「积分」或「自带 Key」。** 只有走积分的那一类才扣费。开发者档可以全部自带，不含积分。
- **扩展改动最小。** 代理对外兼容现有各类接口的格式；积分模式在扩展里就是一个新的服务商预设（baseURL 指向代理，apiKey = 设备令牌）。
- **推理内容不落盘。** 代理只记计量（token 数、服务类别、模型、积分），不记 prompt、回复、页面、音频。

## 选型

| 部分 | 选择 | 理由 |
|------|------|------|
| 运行 | Vercel Functions（与官网同一个项目，`browserkitten.com/api/*`） | 官网已在 Vercel；同域名，Cookie 与登录页简单；支持流式；按实际 CPU 计费，等上游时不计 |
| 数据库 | Postgres（Neon，经 Vercel Marketplace） | 账本需要行锁与事务 |
| 登录 | Better Auth：Google + 邮箱验证码，无密码；限流存 Postgres | 不自己写 OAuth |
| 邮件 | Resend | |
| 收款 | **Paddle（Merchant of Record）** | 代收代缴全球 VAT / 销售税 |
| 测试 | PGlite（WASM 里的真 Postgres）+ 假上游 | SQL 真的跑过 |

注意：Vercel Hobby 档**禁止商业用途**，上线收费前要升级到 Pro。

## 代理的 6 类服务

| 类别 | 扩展里的配置 | 代理端点 | 地址可改？ |
|------|--------------|----------|-----------|
| 对话推理 | purpose=chat | `POST /api/v1/chat/completions`（OpenAI 兼容，SSE）· `GET /api/v1/models` | ✓ `apiBase` |
| 生图 | purpose=image，protocol=`openai-image` | `POST /api/v1/images/generations` | ✓ |
| 转写 | purpose=stt | `POST /api/v1/audio/transcriptions` | ✓ |
| System1 | purpose=jev | `POST /api/v1/systemone`（由托管小模型回答 `answers.pick.choice`） | ✓ |
| 搜索 | Tavily | `POST /api/tavily/search` | ✓ `tavilyBaseURL`；Brave 写死在 `webSearch.js:55` |
| 抓取 | Firecrawl | `/api/firecrawl/{v1,v2}/{scrape,map,search,crawl}` | ✓ `firecrawlBaseURL` |

所以积分模式下：chat / image / stt / jev 的 baseURL = `https://browserkitten.com/api/v1`，Tavily = `https://browserkitten.com/api/tavily`，Firecrawl = `https://browserkitten.com/api/firecrawl`，Key 都是设备令牌。上游 Key 只在后端环境变量里。

## 登录与设备令牌

```text
扩展  chrome.identity.launchWebAuthFlow({ url: https://browserkitten.com/connect.html?redirect_uri=https://<扩展ID>.chromiumapp.org/&state=… , interactive: true })
页面  未登录 → login.html → 回到 connect.html；用户点「Connect」
页面  POST /api/device/start → 一次性 code（5 分钟）→ 跳回 redirect_uri?code=…&state=…
扩展  POST /api/device/exchange { code, label } → { token: "bk_dev_…" }，存 chrome.storage.local
```

- 只接受 `ALLOWED_EXTENSION_IDS` 里的扩展 ID（商店版、不公开测试版、本地开发版分别加）。
- 数据库只存令牌的 SHA-256。账户页可逐台注销；退订不吊销令牌，只把权益降到免费档。
- `GET /api/me`（带设备令牌）→ 套餐、剩余积分。

## 订阅与 Paddle

- 结账：账户页 `POST /api/billing/checkout` → 后端创建 Paddle transaction（`custom_data.bk_user` 在服务端写入，浏览器改不了）→ Paddle.js 弹窗付款。
- 管理：`POST /api/billing/portal` → Paddle 客户门户（换档、换卡、取消、发票）。
- webhook `POST /api/paddle/webhook`，校验 `Paddle-Signature`（HMAC-SHA256，5 分钟时效，支持轮换期多签名）：
  - `subscription.*` → 自有表 `bk_subscription`，按 `occurred_at` 排序，迟到的旧事件不会覆盖新状态；`past_due` 期间保留权益。
  - `transaction.completed` → 按 transaction id 发积分：首单 / 续费发整期（年付 ×12）；中途升级按实付比例；加油包按包。
  - `adjustment.*` 退款（已批准）或拒付 → 该笔交易的 grant 清零剩余。

套餐与价格 ID 在 `server/plans.js`：Developer（0 积分，只 BYOK）、Standard、Pro、两档加油包。**积分数是草稿**，等成本基准跑完再定。免费用户注册送一次性试用积分。

## 积分

- 1 积分 = `catalog.creditUsd`（默认 $0.001），`markup` 可调。模型价格在 `server/catalog.json`，**价格没填的模型不对外提供**。
- 每次请求：预扣上限 → 调上游 → 按真实用量结算，多退少补；超出预扣的部分最多扣到 0，剩下的由我们承担，不会出现负余额。
- 预扣估算：输入按字符数（偏宽松），内联图片每张按固定额度，输出按 `max_tokens`；代理会把上游 `max_tokens` 强制设为这个值，实际用量不会远超预扣。
- 流式：边透传边读最后的 usage；流中断或客户端断开时按已送达的文本估算，且不超过预扣额。
- 扣减顺序：最早过期的 grant 先扣。锁住 grant 行再计算余额，并发请求不会超扣。
- 函数崩溃留下的预扣由每小时 cron 按预扣额结算。
- Workflow 回放不经过代理，**不扣积分**。

## 模型路由（bk-auto）

- 积分用户不选模型。扩展的积分记录固定发送路由名：对话 `bk-auto`、生图 `bk-image`、转写 `bk-stt`、System1 `bk-system1`（`src/agent/cloudModels.js`；`normalizeProvider` 钉死，选择器 / 设置页改不动）。
- 服务端按接口和用途选路由（`server/modelRoutes.js`），**忽略客户端传来的模型名**。每个路由是一串上游条目，按顺序尝试；在向用户转发任何字节之前失败（5xx / 429 / 我们的 Key 被拒 / 网络错误）才切下一个，400 直接返回，流式一旦开始不再切换。套餐层级可以有自己的一串（`routes.chat.tiers.pro`）。
- 上下文压缩和标题生成带 `x-bk-purpose: compact|title`，走便宜的 `bk-auto-light`；这个请求头只发往 browserkitten.com，其他服务商在 fetch 层剥掉。
- 带图片的请求只走标了 `vision: true` 的条目；`reasoning` 参数只留给标了 `reasoning: true` 的条目。
- 预扣按整串里最贵的条目算，结算按实际应答的条目算（`units.routedTo`，用于和上游账单对账）。
- `/api/v1/models` 只返回 `bk-auto` 一行（上下文长度、最大输出、输入类型、推理档位取整串的交集），扩展据此决定压缩时机、推理滑块和能否发图。
- 侧栏：积分服务商在模型列表里只显示一项「自动选择模型」，顶部标签显示 Browser Kitten。

## 扩展侧改动（上架必需的最小集）

- 设置页：每一类加一个「Browser Kitten Cloud（积分）」预设，登录后自动填好 baseURL + 设备令牌（地址见上表）。完整的「每类积分/自带」开关界面可以后做。
- 侧栏：登录按钮、当前套餐、剩余积分；收到 `402 CREDITS_EXHAUSTED` 时给出升级 / 加油包入口（`https://browserkitten.com/account.html`），不当成模型错误。
- `manifest.json` 加 `identity` 权限（`launchWebAuthFlow` 需要）。
- Brave 搜索的地址改成可配置，或者积分模式只走 Tavily。

## 上架 Chrome 应用商店清单

### 账户与主体
- [ ] 开发者账户（一次性 $5），以美国公司注册为**组织**，开启两步验证。
- [ ] 完成 trader 声明（面向欧盟必需）：公司地址、电话、邮箱要验证并公开展示。
- [ ] 域名、官网、支持邮箱。
- [ ] Paddle 账户（用美国公司）：先在 sandbox 跑通；正式收款前 Paddle 会审核网站（要能看到产品说明、定价、服务条款、隐私政策、退款政策）和域名。
- [ ] Vercel 升级 Pro（Hobby 禁止商业用途；每小时 cron 也需要 Pro）。

### 法律页面（Paddle 审核和商店都要）
- [ ] 隐私政策：写清楚页面内容、对话内容在积分模式下会发往我们的代理和上游模型；代理不存正文；BYOK 模式直接发到用户选的服务商。
- [ ] 服务条款、退款政策、订阅自动续费说明。

### 代码与 manifest
- [ ] `version_name` 去掉 `-bot-candidate`，用干净的版本号。
- [ ] **权限收窄**：`debugger`、`userScripts`、`tabCapture` 改成 `optional_permissions`，用到时再申请。装机时的警告越少，审核越快，下沉用户的安装转化越高。
- [ ] 访问策略合并成单一模式（Full），保留付款拒绝这类不宣传的硬门。
- [ ] 真实 Chrome 端到端验收（当前 1.2.0 尚未通过）：至少覆盖登录、积分扣费、页面快照与修改、`run`、SW 重启恢复。
- [ ] 打包产物检查：vendor 包可以压缩，不能混淆。

### 商店后台「隐私权规范」
- [ ] 单一用途说明（single purpose）：「在用户已登录的浏览器里代用户完成网页任务的 AI agent」。
- [ ] **每个权限的理由**，尤其是 `<all_urls>`、`scripting`、`debugger`、`userScripts`、`tabCapture`、`downloads`。
- [ ] **远程代码声明——审核风险最高的一项**：MV3 禁止执行包外的代码。`run` 在 sandbox 里执行模型生成的代码，`sys.eval` 通过 `userScripts` 注入。要准备说明：代码按用户请求生成，在无 `chrome.*` 的 sandbox 里运行，`userScripts` 只有用户在扩展详情页手动开启后才可用。**备选方案**：如果被拒，商店版先关掉 `sys.eval` / CDP，只保留 `action` 路径。
- [ ] 数据使用勾选与 Limited Use 声明。

### 商店素材
- [ ] 图标 128×128、截图 1280×800（至少 1 张，建议 5 张）、小宣传图 440×280。
- [ ] 标题、简介、详细描述（中英文，最好再加目标市场的语言）。
- [ ] 分类、语言、目标地区。

### 同步上架
- [ ] Edge 加载项商店（免费，大陆可访问，代码基本通用）。

### 迁移与发布
- [ ] 商店版的扩展 ID 和 unpacked 版不同，本地数据（IndexedDB/OPFS）**不会自动迁移**。如果要照顾老用户，需要做导出/导入。
- [ ] 先以「不公开」（unlisted）提交，拿到审核结果、跑通真实支付后再公开。
