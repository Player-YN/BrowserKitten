# 商业化上架：后端设计与清单

Browser Kitten 从 unpacked + 纯 BYOK 走向 Chrome 应用商店 + 订阅。本文件是**设计与清单**，不是已实现的事实；实现落地后以代码为准。

## 原则

- **runtime 仍在用户浏览器里。** 后端只做四件事：账号、订阅、积分、推理代理。不跑 agent 循环，不存会话，不碰页面。
- **每一类服务独立选「积分」或「自带 Key」。** 只有走积分的那一类才扣费。开发者档可以全部自带，不含积分。
- **扩展改动最小。** 代理对外兼容现有各类接口的格式，积分模式在扩展里就是一个新的服务商预设（baseURL 指向代理，apiKey = 设备令牌）。
- **推理内容不落盘。** 代理只记计量（token 数、服务类别、模型、金额），不记 prompt 和回复正文。

## 需要代理的 6 类服务

| 类别 | 扩展里的配置 | 代理端点（兼容格式） | 上游（示例） | 地址可改？ |
|------|--------------|----------------------|--------------|-----------|
| 对话推理 | `browserbot_providers` purpose=chat | `POST /v1/chat/completions`（OpenAI 兼容，SSE 流式） | OpenRouter / 厂商直连 | ✓ `apiBase` |
| 生图 | purpose=image | `POST /v1/images/generations` | 同上 | ✓ |
| 转写 | purpose=stt | `POST /v1/audio/transcriptions` | Whisper 兼容 | ✓ |
| System1 | purpose=jev | `POST /v1/systemone` | 自选小模型 | ✓ |
| 搜索 | `browserbot_web_acquire` Tavily | `POST /search`（Tavily 兼容） | Tavily | ✓ `tavilyBaseURL`；Brave 地址写死在 `webSearch.js:55` |
| 抓取 | Firecrawl | `POST /v1/scrape` 等（Firecrawl 兼容） | Firecrawl | ✓ `firecrawlBaseURL` |

上游 Key 只存在后端的 secret 里，扩展永远拿不到。

## 架构

```text
扩展（用户浏览器）
  ├─ 登录：chrome.identity.launchWebAuthFlow → 网站登录页 → 回调带一次性 code
  │        → POST /auth/device 换设备令牌（bk_dev_…，存 chrome.storage.local）
  ├─ 积分模式的每一类：baseURL = https://api.<域名>/v1，apiKey = 设备令牌
  └─ 余额 / 套餐：GET /me
        │
        ▼
Cloudflare Workers（Hono）  ── D1（SQLite）── KV（限流）
  /auth/*   登录、设备令牌签发与吊销
  /billing/* Stripe Checkout、Customer Portal、webhook
  /v1/*      推理代理：鉴权 → 预扣 → 转发上游（流式透传）→ 按实际用量结算
        │
        ├─ Stripe（订阅、加油包、税）
        ├─ Resend（邮箱验证码）
        └─ 上游：模型、Tavily、Firecrawl…
```

选 Workers 的理由：按请求计费、没有闲置成本；原生支持 SSE 流式透传；全球边缘，离用户近；一个仓库就能部署。私有仓库 `browserkitten-site` 可以放登录页和定价页。

## 鉴权

- **网页登录**：Google OAuth + 邮箱验证码两种。不做密码（少一类风险，也少一个客服问题）。可用 Better Auth（支持 Workers + D1），不要自己写 OAuth。
- **扩展拿令牌**：`chrome.identity.launchWebAuthFlow` 打开网站的 `/extension-login`，登录后重定向到 `https://<扩展ID>.chromiumapp.org/cb?code=…`。扩展用 code 换**设备令牌**。Edge 也支持这个 API。
- **设备令牌**：长期有效、可吊销，每台设备一条，后台只存 SHA-256 哈希。它就是积分模式下各类服务的 `apiKey`，所以扩展现有的 provider 代码不用改鉴权逻辑。
- **吊销**：网站「我的设备」里可以逐条注销；退订不吊销令牌，只把权益降到免费档。

## 订阅与 Stripe

**主体**：用美国公司开 Stripe 账户（覆盖面最广，Stripe Tax 可用）。香港公司可以留作亚洲本地支付（支付宝 / 微信支付）的备选主体。

**全球消费者税务**：卖给全球个人用户，要处理欧盟 VAT、英国 VAT、美国各州销售税等。两条路：
1. Stripe + Stripe Tax：你自己是卖方，要在各地按门槛注册申报。
2. 用 Merchant of Record（Paddle、Lemon Squeezy，或 Stripe 的 Managed Payments，如果已对你的账户开放）：对方是法律上的卖方，替你收税报税，费率高一些。**早期建议走 MoR**，省掉合规负担。

**Stripe 对象**：

| Product | Price | 说明 |
|---------|-------|------|
| Developer | $5/月、年付 | 只含 BYOK，不含积分 |
| Standard | $12/月、年付 | 每月 N 积分 + BYOK |
| Pro | $20/月、年付 | 每月 M 积分 + 高端模型 + BYOK |
| Booster | 一次性 | 加油包，积分不过期或 12 个月过期 |

具体积分额度等上线前用真实成本数据定，见下文「积分」。

**流程**：
- 升级：`POST /billing/checkout` → Stripe Checkout（托管页面，不在扩展里收卡）→ 成功页。
- 管理：`POST /billing/portal` → Stripe Customer Portal（换档、取消、发票、换卡）。
- **权益只以 webhook 为准**：`checkout.session.completed`、`customer.subscription.created|updated|deleted`、`invoice.paid`（按周期发放积分）、`invoice.payment_failed`、`charge.refunded`。webhook 必须验签、按 event id 幂等。

## 积分

**单位**：1 积分 = 固定美元成本（比如 $0.001），对用户只显示积分。各类的换算：

| 类别 | 计量 | 换算 |
|------|------|------|
| 对话推理 | 上游返回的 input / output / cached token | 按各模型的上游单价 × 加价系数 |
| System1 | 同上 | 很便宜，可以单独打低系数 |
| 生图 | 张数 × 尺寸 | 固定价目 |
| 转写 | 音频秒数 | 固定价目 |
| 搜索 / 抓取 | 次数 / 页数 | 固定价目 |
| Workflow 回放 | 不经过代理 | **0** |

**账本**（D1）：

```sql
users(id, email, created_at, stripe_customer_id)
devices(id, user_id, token_hash, label, created_at, last_seen_at, revoked_at)
subscriptions(user_id, plan, status, current_period_end, stripe_subscription_id)
credit_grants(id, user_id, source, amount, remaining, expires_at)   -- 订阅周期 / 加油包 / 试用
usage(id, user_id, device_id, category, model, units_json, credits, request_id, created_at)
processed_events(stripe_event_id PRIMARY KEY)
```

**扣费流程**（流式也适用）：
1. 请求进来：校验设备令牌 → 查套餐是否允许这一类和这个模型 → **预扣**一个上限（按 `max_tokens` 估）。余额不足直接返回 `402 {code:"CREDITS_EXHAUSTED"}`。
2. 转发上游，流式透传给扩展。
3. 结束时按上游返回的真实 usage **结算**：多退少补。上游没给 usage 就按预扣额结算。
4. 扣减顺序：最早过期的 grant 先扣。

**硬上限**：每档每月积分封顶；每分钟请求数和并发流数限流（KV）。免费试用要求登录，按设备和邮箱去重，拦截一次性邮箱。

**定价方法**：上线前用基准任务集跑一遍，统计每个任务在各类上的平均成本，再定每档积分数，保证**满额用完仍有毛利**。

## 扩展侧改动（上架必需的最小集）

- 设置页：每一类加一个「Browser Kitten Cloud（积分）」预设，登录后自动填好 baseURL + 设备令牌。完整的「每类积分/自带」开关界面可以后做。
- 侧栏：登录按钮、当前套餐、剩余积分；收到 `402` 时给出升级 / 加油包入口，不当成模型错误。
- `manifest.json` 加 `identity` 权限（`launchWebAuthFlow` 需要）。
- Brave 搜索的地址改成可配置，或者积分模式只走 Tavily。

## 上架 Chrome 应用商店清单

### 账户与主体
- [ ] 开发者账户（一次性 $5），以美国公司注册为**组织**，开启两步验证。
- [ ] 完成 trader 声明（面向欧盟必需）：公司地址、电话、邮箱要验证并公开展示。
- [ ] 域名、官网、支持邮箱。

### 法律页面（Stripe 和商店都要）
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
