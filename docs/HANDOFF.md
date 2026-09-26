# 交接文档：Browser Kitten 商业化上架（截至 2026-09-26）

写给接手这项工作的新会话。先读完本文件，再读 [AGENTS.md](../AGENTS.md) 和 [docs/COMMERCIAL_LAUNCH.md](COMMERCIAL_LAUNCH.md)。事实以代码为准；本文件说明**为什么这样做、做到了哪、接下来谁做什么**。

用户用中文沟通，偏好直接给结论和推荐，不要罗列一堆选项。

---

## 0. 三条先记住的警告

1. **扩展仓库的 `origin` 仍指向旧的公开仓库** `Player-YN/BrowserKitten`（2857 star，已冻结，用户说不用管它）。本地 `main` 比它领先几十个提交，**任何 `git push` 都会把闭源代码推到公开仓库**。在用户把 origin 改成私有仓库之前，扩展仓库一律不推送。AGENTS.md 禁止我们改 git config，所以改 origin 必须由用户执行：
   ```bash
   git -C /Users/yn/Desktop/BrowserKitten remote set-url origin https://github.com/Player-YN/BrowserKitten-app.git
   ```
2. **两个仓库的所有提交都只在本地**，没有推送，后端也**没有部署过**。所有"完成"都是"代码写完 + 模拟测试通过"，没有和任何真实外部服务（Google、Paddle、OpenRouter……）连通过。
3. **积分账本出错 = 直接亏钱。** 改 `server/ledger.js`、`server/proxy/*`、`server/billing.js` 之前先读第 5 节，改完必须跑全部测试；有真实 Postgres 时还要跑压力脚本。

---

## 1. 目标与已定决策

**目标**：把 Browser Kitten 以**闭源**产品上架 Chrome 应用商店（同时上 Edge），面向散户 / 下沉市场，订阅 + 积分收费。核心差异：runtime 在用户浏览器本地，没有云电脑成本；重复任务可固化成 Workflow 回放（不调模型）。竞品对标 Sider（Hand / Code 模式）。

用户已拍板的：

| 事项 | 决定 |
|------|------|
| 收款 | **Paddle**（Merchant of Record，代收代缴全球税）。不用 Stripe。主体用美国公司（也有香港公司） |
| 开源 | 商店版闭源。旧公开仓库冻结不管；新私有仓库 `Player-YN/BrowserKitten-app` |
| 访问模式 | **只保留一种（原 Full）**，没有开关。审批不是个人用户的卖点。宿主硬规则保留：已知付款拒绝、已知删除问一次 |
| 套餐形态（类 Raycast） | ~$5 Developer：只 BYOK、不含积分；~$12 / ~$20：含积分且附赠 BYOK。BYOK 可**按服务类别**单独替换（对话/生图/转写/System1/搜索/抓取），没自带的走积分 |
| 模型选择 | **用积分的用户不能自选模型**，由我们在服务端路由（计划叫 `bk-auto`，**尚未实现**） |
| 登录方式 | Google / Apple / Microsoft / GitHub 一键登录 + 邮箱验证码（已实现，按环境变量启用） |
| 监控 | Sentry（已接，事件不含请求内容和用户身份） |
| 官网 | `browserkitten.com`，Vite 静态站，部署在 Vercel；后端放同一个 Vercel 项目 |

---

## 2. 仓库与分支

| 仓库 | 本地路径 | 远端 | 分支状态 |
|------|----------|------|----------|
| 扩展 | `/Users/yn/Desktop/BrowserKitten` | 私有 `Player-YN/BrowserKitten-app`（已推送 2026-09-26 之前的全部分支和标签）；`origin` 仍是公开仓库 ⚠️ | `main`，本轮新增提交见第 4 节，均未推送 |
| 官网 + 后端 | `/Users/yn/Desktop/broswer-bot-intro`（注意拼写 broswer） | 私有 `Player-YN/browserkitten-site`；Vercel 项目 `browserkitten` | 后端全部在 **`feat/backend`** 分支，未推送、未部署。`main` 是线上官网 |

用户的 Chrome 以**仓库根目录**作为 unpacked 扩展加载（不是 `extension/`）。

---

## 3. 架构总览

```text
用户浏览器（扩展，runtime 全在本地）
  ├─ BYOK：直接请求用户自己选的服务商（不经过我们）
  └─ 积分模式：baseURL = https://browserkitten.com/api/...，apiKey = 设备令牌 bk_dev_…
          │
          ▼
Vercel Functions（官网同项目，单入口 api/index.js → server/router.js）
  /api/auth/*              Better Auth：Google/Apple/Microsoft/GitHub + 邮箱验证码
  /api/device/*            扩展登录：launchWebAuthFlow → connect.html → 一次性 code → 设备令牌
  /api/me /api/config      套餐、积分、各窗口用量 / 页面配置
  /api/billing/*           Paddle 结账（服务端建 transaction）、客户门户
  /api/paddle/webhook      验签 → 订阅表 + 发积分 / 退款撤回
  /api/v1/*                计量代理：chat/completions(流式) · models · images · audio · systemone
  /api/tavily/search       计量代理：搜索
  /api/firecrawl/*         计量代理：抓取 / map / crawl
  /api/cron/sweep          每小时：结算卡住的预扣 + 账本审计
          │
          ├─ Neon Postgres（账本、订阅、设备、Better Auth 表）
          ├─ Paddle（沙盒 / 正式）
          ├─ Resend（验证码邮件）  ├─ Sentry
          └─ 上游：OpenRouter / OpenAI / Tavily / Firecrawl（Key 只在服务端）
```

**请求路径（每个积分请求都走）**：设备令牌鉴权 → 查套餐层级是否允许该模型 → 查滚动窗口限额（5h/7d/30d）→ **预扣**上限 → 调上游 → 按真实用量**结算**（多退少补）。

**扩展侧（积分模式怎么接上）**：登录后写 4 条固定 id 的服务商记录 `bk_cloud_chat|image|stt|jev`（baseURL 指向我们，apiKey = 设备令牌），Tavily / Firecrawl 只在为空时才填。**不覆盖用户已配的 Key，不抢已可用的活动服务商**；登出只撤回这些。模型/生图/转写/搜索调用代码一行没改。

---

## 4. 本轮已完成

### 扩展仓库（`main`，未推送）

| 提交 | 内容 |
|------|------|
| `7d05002` | 修两个过期测试断言 |
| `400596c` `fbc9ab1` | `docs/COMMERCIAL_LAUNCH.md`：后端设计 + 上架清单 |
| `8d415ab` | 设置里登录 Browser Kitten（`src/agent/cloudAccount.js`）、`identity` 权限、402 积分用完提示条 |
| `0d8a31e` | **只剩一种访问模式**：删 Guarded/Full 开关、确认弹窗、RPC；`decideAccess(classified)` 只有 付款 deny / 删除 approve / 其余 auto；启动清理旧模式键；存储桥黑名单改为保护派发工单键；左上角和首页 Logo 链接到 browserkitten.com + 悬停淡光 |
| `5e20f06` | `userScripts`、`tabCapture` 改为可选权限：tabCapture 在原有听音/录屏授权条的点击里申请；设置新增「高级能力」卡片开启页面脚本；缺权限返回 `PERMISSION_REQUIRED`。`debugger` **按 Chrome 规定不能设为可选**，仍是必需 |

测试：`node --test tests/*.test.mjs` → 674 通过。发版打包校验：`python3 scripts/pack_extension.py && python3 scripts/verify_extension.py extension --source .`（跑完删掉 `extension/`）。

### 官网仓库（`feat/backend`，未推送）

| 提交 | 内容 |
|------|------|
| `be32ff4` | 后端主体：Better Auth、设备令牌、Paddle、积分账本、6 类计量代理、账户/登录/连接页 |
| `17c4d96` | Sentry（只上报路径和标签）；上游 401/402/403 统一返回 502（不让扩展误以为用户没积分）；扩展可自行注销设备 |
| `144bc01` | 四种一键登录，按环境变量启用；Apple client secret 运行时用私钥签发，不会过期 |
| `3fd6160` | 隐私政策 / 服务条款 / 退款政策草稿（`[[…]]` 占位高亮）；5h/7d/30d 滚动限额（429 `USAGE_LIMIT` + Retry-After）；`/api/me` 返回各窗口用量 |
| `2772d59` | **账本加固**（见第 5 节）+ 真实 Postgres 压力脚本 |

测试：`npm test` → 45 通过（PGlite = 进程内真 Postgres + 假上游）。构建：`npm run build`。

---

## 5. 积分账本：设计、不变量、已修问题、剩余风险

文件：`server/ledger.js`（核心）、`server/proxy/metered.js`（请求流程）、`server/proxy/chat.js`（流式计费）、`server/billing.js`（Paddle → 积分）、`server/usageLimits.js`（限额）、`server/pricing.js` + `server/catalog.json`（定价）。

**模型**：积分以 grant（批次）形式进来——订阅周期 / 加油包 / 试用；每个请求一条 `bk_usage`（held → settled | released），`allocations` 记录从哪些 grant 扣了多少。只存计量，从不存内容。

**保证**：
- **不超扣**：同一用户的所有余额变更（reserve / settle / revoke）先拿**按用户的事务级 advisory lock**，完全串行；不同用户互不影响；单一锁序，不可能死锁。
- **余额不为负**：结算超出预扣时最多扣到 0，差额记 `absorbed`（我们承担，Sentry 报警）。
- **幂等**：grant 以 `(source, source_ref)` 唯一，webhook 重放无效；订阅事件按 `occurred_at` 排序，旧事件不覆盖新状态；settle 对非 held 行无操作。
- **退款不复活**：`revokeGrant` 置 `revoked_at`，被撤销的 grant 永远不再接受退还（`forfeited` 记账）。
- **不变量**（`auditLedger`）：每个未撤销的 grant，`amount − remaining = 所有 held/settled 行对它的 allocations 之和`。每小时 cron 跑一次，不一致即 Sentry 报警。
- **结算失败重试 3 次**（指数退避），仍失败则 Sentry 报警（否则 cron 会按全额预扣结算，多扣用户）。

**本轮修掉的真实问题**（都有回归测试）：并发下先读余额后加锁的超扣漏洞；预扣/结算锁序相反导致的死锁；进行中的请求在退款后把积分"退回"已退款的 grant；流式中断只按输出计费、漏算输入（我们亏）；结算写库失败不重试。

**剩余风险 / 上线前必须做**：
1. **压力脚本还没在真实 Postgres 上跑过**（PGlite 单连接测不出锁）。Neon 开好后，在 **Neon 分支**上跑 `DATABASE_URL=… npm run stress:ledger`，必须全绿。
2. **Paddle webhook 字段是按文档写的，从未收到过真实事件**。沙盒里必须实测：首单、续费、升级、加油包、退款，每种都核对积分。
3. **预扣估算偏差**：推理模型的思考 token、工具调用等可能让实际用量超过预扣 → `absorbed`。上线后看 Sentry 的 "Usage exceeded hold" 报警频率，必要时调 `server/pricing.js` 的估算。
4. **上游实际账单对账**：还没有"我们记的成本 vs OpenRouter/Tavily 实际账单"的对账。建议上线后每周人工比对一次，差异 >5% 要查。
5. **年付积分目前一次性发 12 个月**：用户可首月用光再退款（退款只能收回未用部分）→ 真实亏损风险。建议改为按月发放（待用户确认，见第 7 节）。
6. **试用积分滥用**：每个新账号送 300 积分（草稿值），可用邮箱别名批量注册。上线前考虑：同设备/IP 限制或连接扩展后才发。

---

## 6. 关键文件地图

扩展（`/Users/yn/Desktop/BrowserKitten`）：
- `src/agent/cloudAccount.js` — 登录/登出/查账户；`planCloudSignIn/Out` 纯函数（测试：`tests/cloud-account.test.mjs`）
- `src/agent/vnext/host/accessPolicy.js` `riskClassify.js`（`decideAccess`）`operationGate.js` `dispatchTicket.js` — 宿主门
- `src/sidepanel.js` — 设置卡片（账户、高级能力）、积分用完提示条、听音授权条（申请 tabCapture）
- `manifest.json` — `optional_permissions: userScripts, tabCapture`；`debugger` 必需；新增 `identity`
- `docs/COMMERCIAL_LAUNCH.md` — 设计 + 商店清单

后端（`/Users/yn/Desktop/broswer-bot-intro`，`feat/backend`）：
- `api/index.js` 单入口；`vercel.json`：`/api/*` 重写、`maxDuration 300`、**每小时 cron**（Hobby 档会导致部署失败，见第 7 节）
- `server/router.js` 路由；`auth.js` Better Auth；`social.js` 一键登录；`devices.js` 设备令牌
- `server/ledger.js` `usageLimits.js` `plans.js`（**草稿积分数与限额**）`pricing.js` `catalog.json`（**价格未填 → 模型不对外提供**；形状见 `catalog.example.json`）
- `server/billing.js` Paddle 验签/事件/结账/门户；`monitor.js` Sentry；`schema.sql`
- `scripts/migrate.mjs`（建表）`scripts/ledger-stress.mjs`（真实 PG 并发测试）
- 页面：`login.html` `account.html` `connect.html` `privacy.html` `terms.html` `refund.html`；脚本 `src/account.js`
- 环境变量全表：`.env.example`

---

## 7. 待办清单

### A. 新会话可以直接做（不依赖用户）

| # | 事项 | 说明 |
|---|------|------|
| A1 | **`bk-auto` 服务端模型路由** | 用户已同意方向：积分用户只看到一个模型；服务端按用途（主对话 / System1 / 压缩摘要 / 生图 / 转写）选上游，主模型失败自动切备用；扩展在活动服务商是 `bk_cloud_*` 时隐藏模型选择器。改 `catalog.json` 结构、`proxy/chat.js`、`/api/v1/models`、扩展侧栏。先给用户看方案再动手 |
| A2 | **自助删除账号** | GDPR / 商店审核需要。后端：删 Better Auth 用户 + 设备 + 会话，保留计费记录（法律要求）但去标识；取消 Paddle 订阅；账户页按钮 + 二次确认；扩展同步登出。隐私政策里对应段落要一致 |
| A3 | 账户页显示各窗口用量与限额 | `/api/me` 已返回 `limits` 与 `usage` |
| A4 | 扩展设置卡片显示套餐 / 积分 / 本周用量 | 同上 |
| A5 | 商店提交材料草稿 | 单一用途说明、每个权限的用途说明（重点 `<all_urls>` `debugger` `scripting` `identity`）、远程代码声明（`run` 在无 `chrome.*` 的 sandbox 执行模型生成代码；`userScripts` 需用户手动开启）、中英文描述 |
| A6 | 官网文案修正（先给用户看新文案） | 首页、产品页、联系页、定价页写着 "Nothing is uploaded"，与积分模式和隐私政策矛盾 |
| A7 | 若有 Playwright：跑扩展实机烟测 | `node tests/browser-smoke.cjs <playwright路径>`；验 Logo 链接、设置卡片、权限申请 |

### B. 用户要做的

| # | 事项 | 产出（交给 Claude / 填进 Vercel） |
|---|------|------|
| B1 | **改扩展 git origin 到私有仓库**（第 0 节命令） | 之后扩展才能推送 |
| B2 | Vercel Marketplace 开通 **Neon**，区域选和函数同一地区（如美东） | `DATABASE_URL` |
| B3 | **Google Cloud**：建项目 → 授权页（应用名 Browser Kitten、支持邮箱、Audience = External、只要 openid/email/profile）→ 新建 **Web 应用** OAuth 客户端，回调 `https://browserkitten.com/api/auth/callback/google`（预览地址也加一条）；之后发布到正式并做品牌验证（需域名验证 + 隐私政策链接） | `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` |
| B4 | **Resend**：注册并验证 browserkitten.com 发信域名 | `RESEND_API_KEY` |
| B5 | **Paddle 沙盒**：API Key（MCP 已装：`@paddle/paddle-mcp`，sandbox，non-destructive）、客户端 token | `PADDLE_API_KEY` `PADDLE_CLIENT_TOKEN`；webhook 在部署后由 C3 配 |
| B6 | 上游账号充值：OpenRouter、Tavily、Firecrawl、OpenAI（转写） | 各 `*_API_KEY` |
| B7 | Sentry 建项目 | `SENTRY_DSN` |
| B8 | **决定 Vercel：现在升 Pro，还是沙盒阶段先用 Hobby**（Hobby 禁商用；cron 每天最多一次，否则部署失败） | 决定 |
| B9 | 同意推送官网 `feat/backend` 分支（生成预览地址，不影响线上） | 同意 |
| B10 | 填法律页面 `[[…]]`：公司全称、注册地址、适用州法律、生效日期、联系邮箱、保留期限、退款天数；**请律师审阅** | 文本 |
| B11 | Chrome 开发者账号：$5、以美国公司注册为组织、两步验证、trader 声明 | 账号 |
| B12 | （可选）Apple Developer $99/年、Microsoft Entra、GitHub OAuth App | 对应环境变量 |
| B13 | 第 8 节的待定决策 | 决定 |

在 Vercel 需要设置的其余变量：`BETTER_AUTH_URL=https://browserkitten.com`、`BETTER_AUTH_SECRET`（`openssl rand -base64 32`）、`CRON_SECRET`（`openssl rand -hex 24`）、`ALLOWED_EXTENSION_IDS`（unpacked 开发版 ID + 未来商店版 ID）、`PADDLE_ENV=sandbox`、`PADDLE_WEBHOOK_SECRET`、`PADDLE_PRICE_*`（由 C1 产出）、`AUTH_EMAIL_FROM`。

### C. 用户完成对应事项后 Claude 才能做

| # | 前置 | 事项 |
|---|------|------|
| C1 | 新会话已加载 Paddle MCP | 在**沙盒**建商品与价格。月付三档用户给过：Developer $5、Standard $12、Pro $20；**年付和两档加油包的价格还没定，先问用户**。建完把各 `pri_…` 列给用户填进 `PADDLE_PRICE_*` |
| C2 | B2（Neon） | `npm run migrate` 建表；在 **Neon 分支**上跑 `npm run stress:ledger`，必须全绿 |
| C3 | B2–B5、B8、B9 | 部署预览；Paddle 沙盒配置 webhook 地址 `/api/paddle/webhook`（事件：subscription.*、transaction.completed、adjustment.*）→ 用户填 `PADDLE_WEBHOOK_SECRET` |
| C4 | C3 | **沙盒端到端**（内置浏览器 + Paddle 测试卡，不产生真实扣款）：Google 登录 → 自动建号 + 试用积分 → 扩展登录（`ALLOWED_EXTENSION_IDS` 需含 unpacked ID）→ 积分模式对话扣费 → 购买订阅 → 发积分 → 升级 → 加油包 → 退款撤回 → 触发限额。每步核对 `auditLedger` 为空 |
| C5 | B6 | 从各服务商**官方价格页**填 `catalog.json`（不要猜价格）；跑基准任务集测出单任务成本，给出每档积分数建议 |
| C6 | B13 决策 | 年付按月发放（需要定时任务）、设备数上限、限额数值、退款条款写回法律页面 |
| C7 | B1 | 推送扩展到私有仓库 |
| C8 | B11 + 全部通过 | 打包商店版、填商店后台、先以「不公开」提交；同步 Edge |
| C9 | B8 选 Hobby 时 | 把 `vercel.json` 的 cron 临时改成每天一次（`0 3 * * *`），升 Pro 后改回每小时 |

---

## 8. 待定决策（问用户，不要替他定）

| 决策 | 现状 / 建议 |
|------|-------------|
| 各套餐每期积分、试用积分、加油包大小与价格、年付价格 | 草稿：Standard 5000、Pro 10000、试用 300、加油包 3000 / 10000（1 积分 = $0.001 成本）。建议等 C5 基准再定 |
| 年付积分一次性发还是按月发 | **建议按月发**（防首月用光再退款） |
| 每账号最多连几台浏览器 | 现在不限；建议 3 |
| 订阅积分过期 | 现在：周期结束 + 3 天宽限，不结转；加油包不过期 |
| 退款规则 | 草稿：首购 14 天可退，已用 >20% 只退未用部分；加油包未使用 14 天内可退 |
| 限额数值（5h / 7d / 30d） | 现在全不限；建议有真实数据后再设 |
| 商店版是否保留 `debugger`（CDP） | 保留 = 功能全但安装警告多、审核严；去掉 = 失去坐标点击兜底 / CDP 上传 / `sys.cdp`。建议先保留提交，被拒再出去掉 CDP 的版本 |
| Vercel Hobby 还是 Pro | 见 B8 |
| 国内市场是否接微信登录 | Better Auth 内置；需微信开放平台 + 国内主体认证 |

---

## 9. 工作约定

- 扩展改代码后用户在 `chrome://extensions` 点**重新加载**才生效。
- 扩展测试 `node --test tests/*.test.mjs`；后端 `npm test`；都要全绿再提交。提交信息结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **对外有影响的操作先问用户**：推送、部署、在 Paddle/Google 后台创建或修改东西、改 Vercel 配置。沙盒里建价格属于用户已授权的方向，但仍要先报清单。
- 不要让用户把 API Key 贴进对话；让他在终端或 Vercel 后台自己填。
- 项目记忆里有两份摘要（`commercial-launch-state`、`launch-decisions`）；本文件更完整，冲突时以本文件和代码为准。
