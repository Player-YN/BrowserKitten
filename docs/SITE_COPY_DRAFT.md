# 官网文案修正草稿

给 owner 审的文案，不改官网文件。官网仓库：`/Users/yn/Desktop/broswer-bot-intro`（`feat/backend` 与 `main` 在下列句子上相同，行号按 `feat/backend`）。未定的值一律写成 `[[…]]`。

语气按 `DESIGN.md` 的 Voice：短、具体、不叠形容词。所有替换句都要和 `privacy.html` 的说法一致：runtime 在本地；自带 Key 时请求直接发往用户选的服务商；用积分时该服务的请求经过我们的服务器，不存正文，只记用量。

---

## 1. 绝对化隐私说法：逐条替换

### 1.1 替换表

| # | 文件:行 | 现在的句子 | 建议替换 |
|---|---------|-----------|----------|
| 1 | `index.html:187`（03 / Runtime 段落） | Runs on your computer. Nothing is uploaded. | Runs in your browser. Your chats and files stay there. |
| 2 | `product.html:107`（Runtime 卡片 `Local`） | Runs on your computer. Nothing is uploaded. | Runs in your browser. Chats, pages, and files stay on this computer. Model requests go to the provider you choose. |
| 3 | `contact.html:8`（`meta description`） | Write to Browser Kitten. Say what the open tab should finish. It runs on your computer. Nothing is uploaded. | Write to Browser Kitten. Say what the open tab should finish. It runs in your browser. |
| 4 | `contact.html:14`（`og:description`） | 同上 | 同 #3 |
| 5 | `contact.html:17`（`twitter:description`） | 同上 | 同 #3 |
| 6 | `pricing.html:106–108`（表格 `Data` 行，三列相同） | Runs on your computer. Nothing is uploaded. | 定价页整体重写，见第 2 节；新表里的数据行用：Runs in your browser. Own keys: straight to your provider. Credits: through us, not stored. |
| 7 | `pricing.html:8`（`meta description`） | Free, Pro, and Team. Prices, limits, and the Chrome Web Store listing fields are blank until set. Browser Kitten runs on your computer. | Developer, Standard, Pro, and Max. Use your own keys or credits. Browser Kitten runs in your browser. |
| 8 | `pricing.html:28`（页首 lead） | The sheet for launch. Fill the blanks. Nothing here is a price yet. | 随第 2 节重写：Use your own keys, or let us run the models on credits. |

### 1.2 需要一起看、但不一定要改的句子

| 文件:行 | 句子 | 意见 |
|---------|------|------|
| `index.html:186`、`product.html:104` | 标题 `On your computer.` | 可以保留：runtime 确实在本地。若想更准，改成 `In your browser.` |
| `index.html:191` | 列表项 `This computer` | 保留。 |
| `vercel.html:34` | `Runs on your computer.` | 实验页（DESIGN.md 说 compare 路由是构图实验）。句子本身不绝对，可保留；若该页会公开，改成 `Runs in your browser.` 与首页一致。 |
| `DESIGN.md`（Pricing 段） | 「Privacy line stays: it runs on the user's computer; data is not uploaded.」以及「Columns are Free, Pro, and Team」 | 这是规范文件，会让后来改页面的人把旧句子写回去。建议同步改成：Privacy line: it runs in the user's browser; own keys go straight to the provider; credit requests pass through us and are not stored. 列改为 Developer / Standard / Pro / Max。 |
| `privacy.html:29` | 「…are stored on your computer, not on our servers.」 | 准确（说的是存储），保留。 |
| `privacy.html` Chrome Web Store 段 | 「…they are not used to collect browsing history for us.」 | 准确但不完整。建议加一句：Requests you make can include the address and title of pages you have open. |
| `privacy.html` What stays on your computer | — | 建议加：Workflow recordings, including the clicks and typing they capture, are stored in the extension. |
| `privacy.html` / `terms.html` 登录方式 | 列了 Google、Apple、Microsoft、GitHub、email code | 上线只开 Google + 邮箱验证码。两页改成只列这两种，或写 [[上线时开启的登录方式]]。 |

扩展本身（不在官网，但同一类问题）：`src/sidepanel.html:669`、`:1089` 的 title 提示「配置仅保存在本机，不会上传到云端服务器。」说的是设置本身，基本准确；登录后设备令牌会随积分请求发往 browserkitten.com，若要严谨可改成「配置保存在本机」。

---

## 2. pricing.html 内容大纲（替换现在的 Free / Pro / Team 空表）

只写内容，不写 HTML。结构沿用现有组件：Page hero → 套餐卡片 → 对比表 → Boosters → 退款一行 → FAQ。原页下半部分的「Store listing」填空表是内部工作表，**从公开定价页移除**（内容已进 `docs/STORE_LISTING.md`）。

### 2.1 Page hero

- Kicker：`Pricing`
- 标题：`Plans.`
- Lead：`Use your own keys, or let us run the models on credits.`
- 计费切换：`Monthly` / `Yearly`（年付显示「2 months free」——$99 vs $9.9×12=$118.8 等，四档都约等于 10 个月价格；是否写这句：[[是否展示年付优惠文案]]）

### 2.2 套餐卡片（四张，同一行）

| | Developer | Standard | Pro | Max |
|---|---|---|---|---|
| 一句话 | Your keys. Every feature. | Credits for everyday tasks. | More credits, stronger models. | For heavy daily use. |
| 月付 | $9.9 / month | $19.9 / month | $49.9 / month | $99.9 / month |
| 年付 | $99 / year | $199 / year | $499 / year | $999 / year |
| 积分 | None. Bring your own keys. | [[credits TBD]] / month | [[credits TBD]] / month | [[credits TBD]] / month |
| 自带 Key（BYOK） | Yes, for every service | Yes. Any service you add a key for uses your key; the rest use credits. | 同 Standard | 同 Standard |
| 模型 | You choose | Chosen for you, per task | Chosen for you, per task. [[stronger model tier — 以 bk-auto 的 pro 路由为准]] | Chosen for you, per task. [[max 路由内容]] |
| 用量窗口 | — | [[5-hour / weekly / monthly limits TBD]] | [[TBD]] | [[TBD]] |
| 连接浏览器数 | [[TBD，HANDOFF 建议 3]] | [[TBD]] | [[TBD]] | [[TBD]] |
| 按钮 | `Choose Developer` | `Choose Standard` | `Choose Pro` | `Choose Max` |

说明（给 owner）：

- 按钮文字不用 `Get access` / `Add to Chrome`（DESIGN.md 明确禁止）。点击去 `account.html` 登录后结账。
- 「Chosen for you」对应 bk-auto：积分用户不选模型。不写具体模型名，避免上游一换就过期。
- 年付积分是一次性发还是按月发：[[待定，HANDOFF 建议按月发]]。若按月发，年付卡片写「[[credits TBD]] / month, billed yearly」。
- 所有功能每档都一样（action、run、文档、workflow 等），差别只在积分和模型路由；卡片不列功能清单，对比表里一行写明 `All features: every plan`。

### 2.3 免费使用（放在卡片下方一行，或第五张窄卡）

`[[是否存在免费档：privacy.html 写着「use the extension with your own keys without an account」，server/plans.js 的 free 档送一次性试用积分 [[trial credits TBD]]。需要决定：不登录能否用自带 Key？若能，Developer 档的付费理由是什么？]]`

建议文案（二选一，待定）：

- A：`Try it free: new accounts get [[trial credits TBD]] credits once.`
- B：`Free with your own keys, no account needed. Plans add credits.`（若选 B，Developer 档需要另写卖点）

### 2.4 对比表（卡片下方，可折叠）

行：

1. Price, monthly / yearly
2. Credits per month — Developer `—`，其余 `[[credits TBD]]`
3. Your own keys — 四档 `Yes`
4. Mix keys and credits per service（chat, image, transcription, System1, search, page fetch）— Developer `Keys only`，其余 `Yes`
5. Model — Developer `You choose`，其余 `Chosen for you`
6. Usage windows（5-hour / 7-day / 30-day）— `[[TBD]]`
7. Browsers per account — `[[TBD]]`
8. All features — 四档 `Yes`
9. Recorded workflow replays — 四档 `No credits used`（结构化 Workflow 回放不调模型、不扣积分，出自 COMMERCIAL_LAUNCH；文字 Workflow 走模型，照常计费）
10. Data — `Runs in your browser. Own keys: straight to your provider. Credits: through us, not stored.`

### 2.5 Boosters

- 标题：`Boosters`
- Lead：`One-time credit packs. They do not expire.`（`server/plans.js` 注释：加油包积分不过期）
- Booster S — $9.9 — [[credits TBD]] credits
- Booster L — $29.9 — [[credits TBD]] credits
- 一行条件：`Boosters need an active paid plan.` [[是否要求有订阅才可买加油包，待定]]
- 扣减顺序（可选小字）：`Credits that expire first are used first.`

### 2.6 退款一行

`Refunds within 14 days, for the unused part, once per account. See the refund policy.` → 链接 `/refund.html`

（与 refund.html 三条规则一致；Developer 档的「未使用部分」口径 refund.html 里仍是 `[[the unused days of the billing period]]`，定了之后两处一起改。）

小字：`Payments are handled by Paddle, our reseller. Prices exclude tax where it applies.` [[价格是否含税，按 Paddle 设置确定]]；`Plans renew automatically. Cancel anytime from your account.`

### 2.7 FAQ

**What are credits?**
Credits pay for the AI and search services we run for you: chat, images, transcription, search, and page fetches. Each request uses credits based on how much it uses, and your balance is on your account page. Monthly credits [[expire at the end of each billing period, plus a 3-day grace — 待定]]; booster credits do not expire.

**What happens when credits run out?**
Requests on credits stop until your next period starts, or until you add a booster or move to a larger plan. The extension shows a link to your account. Services you have your own key for keep working. Hitting a usage window [[if limits are set]] pauses credit requests until the window resets.

**Can I use my own keys?**
Yes, on every plan. Add a key for any service in Settings and that service uses your key and your provider's pricing; the rest use credits. The Developer plan is keys only. [[若有免费用法，在此补一句]]

**What is sent to your servers?**
The assistant runs in your browser. Your chats, the pages it reads, and the files it makes are stored there. With your own keys, requests go straight from your browser to your provider. With credits, each request for that service — which can include text or images from the page you are on — passes through our servers to the AI or search provider and back. We do not store its content. We record the time, the service, the amount used, and the credits charged. See the privacy policy.（链接 `/privacy.html`）

**Can I choose the model on credits?**（可选）
No. On credits we pick a model for each task and switch to a backup if one fails. With your own keys you choose.

**How do refunds work?**（可选，与 2.6 重复则省略）
Within 14 days of a payment, for the unused part, once per account. See the refund policy.

### 2.8 移除项

- `Store listing` 表（Field / Limit / Your line）整段移除。
- `Free / Pro / Team` 列名、`Seats`、`Jobs in the tab`、`Trial` 等空行全部移除；`Seats`（团队）目前没有对应产品，不写。
