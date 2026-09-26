# Chrome 应用商店提交材料（草稿）

给 owner 看的上架草稿。说明用中文，要粘进商店后台的文字用英文（简介另附中文版）。未定的值一律写成 `[[…]]`。

依据：`manifest.json`（1.2.0）、`AGENTS.md`、`src/AGENTS.md`、`src/agent/AGENTS.md`、`docs/COMMERCIAL_LAUNCH.md`、`docs/HANDOFF.md`，以及官网仓库 `feat/backend` 分支的 `privacy.html` / `terms.html` / `refund.html` / `server/plans.js`。下面每条权限说明都对照过源码里的实际调用；对不上的地方单独列在第 7 节，没有写进对审核的说法里。

提交前 manifest 本身要改的（不属于本次文档改动，只是提醒）：

- `description` 现在写着「开发者模式本地实验……不面向 CWS，不出售」。商店会展示这段，必须换成英文正式描述（可直接用下面的 short description）。
- `version_name` 去掉 `-bot-candidate`。
- `action.default_title`（「打开 Browser Kitten」）和两个 `commands.*.description` 是中文。商店主语言若选英文，建议改成英文或加 `_locales` + `default_locale`。

---

## 1. 名称、简介、详细描述

### 名称

`Browser Kitten`

不建议加「AI Agent for Chrome」之类的后缀：商店政策把名称里堆关键词视为 spam 风险。名称与 `manifest.name` 一致。

### Short description（≤132 字符）

英文（**125 字符**，含空格与标点，已用 `len()` 计数）：

```text
An AI assistant in your side panel. It reads, clicks, and fills the pages you are signed in to, and hands back finished work.
```

中文（**40 字符**）：

```text
侧栏里的 AI 助手：在你已登录的网页上阅读、点击、填写，把做完的结果交回给你。
```

### Long description（英文，第一句就是这个扩展做什么）

```text
Browser Kitten is an AI assistant that finishes web tasks for you in the browser you are already signed in to.

Open the side panel, say what the open tab should finish, and Browser Kitten works on the page: it reads it, clicks, types, fills forms, uploads files, and downloads results. It can open and switch tabs, pull in public web pages and search results, and turn what it finds into a document, a small web page, a spreadsheet file, or a download.

What it can do
• Work on the page you are on: read, click, type, select, scroll, upload, and download.
• Point at what matters: pick elements on a page, or take a region screenshot (Alt+Shift+C), and attach them to the chat.
• Make things: documents, simple static web pages, CSV/XLSX files, and other files, kept with the conversation.
• Run small scripts for data work in an isolated sandbox inside the extension.
• Listen to or record the current tab when you allow it, for models that accept audio or video.
• Save repeated jobs as workflows and run them again later, or schedule a task to continue at a set time.

How it runs
• The assistant runs inside your browser. Conversations, pages it reads, files it makes, and your settings are stored in the extension on your computer.
• Use your own API keys (OpenAI-compatible providers and others) and requests go directly from your browser to that provider.
• Or sign in to Browser Kitten and use credits. Then requests for that service pass through browserkitten.com to the AI or search provider. We do not store their content; we record only usage so we can charge credits.

Safety rules built in
• Payments it recognizes are never carried out.
• Deletions it recognizes ask you once before they run.
• Everything else runs without asking. The recognition is best-effort, not a guarantee, so give it tasks you would be comfortable doing yourself.

Optional abilities (off until you turn them on)
• Page scripts: Settings → Advanced abilities. On Chrome 138 and later you also need to turn on "Allow User Scripts" on the extension's details page.
• Tab audio and video capture: requested when you click to allow listening or recording.

When the assistant uses Chrome's debugging interface on a tab, Chrome shows its own "started debugging this browser" bar. This is expected.

Plans: Developer (your own keys), Standard, Pro, and Max. See https://browserkitten.com/pricing.html
Privacy policy: https://browserkitten.com/privacy.html
Support: [[support@browserkitten.com]]
```

说明：

- 「Everything else runs without asking」这句是按 owner 确认的单一访问模式如实写的。它会让审核员更仔细看 `debugger` 和远程代码，但不写反而是误导性描述（商店政策 Deceptive Behavior）。
- 没写「Nothing is uploaded」「never leaves your device」这类绝对说法，和 privacy.html 保持一致。
- 支持邮箱、定价页链接在 pricing.html 改版前先别填正式 URL。

### 分类建议

**Productivity**（商店新分类体系下选 `Productivity → Workflow & Planning`，若后台提供 `Tools` 类也可，但首选 Productivity）。

### 语言

- 主语言：**English**。
- 附加：**Chinese (Simplified) 简体中文**（侧栏 UI 已有 `zh` / `en` 两套文案，`src/sidepanel/i18n.js`）。
- 目标市场语言（如需）：[[其他语言，例如 繁体中文 / 日语 / 西班牙语 / 葡萄牙语——UI 未翻译前不建议列出]]。

---

## 2. Single purpose（单一用途，一句话）

```text
Browser Kitten is an AI assistant that completes web tasks the user asks for, in the user's own signed-in browser, from the side panel.
```

（生成文档、文件、工作流都是「完成用户交代的网页任务」的产物，不算第二用途。审核员若质疑，说明它们都是任务结果的承载形式。）

---

## 3. 权限说明（Permission justification）

写法：用到它的功能 → 什么时候用 → 为什么更窄的选项不行。英文部分可直接粘进后台对应输入框。

| 权限 | 英文说明（粘贴用） | 对照源码 / 备注 |
|------|------------------|-----------------|
| `sidePanel` | The whole user interface is a side panel: the chat, settings, and results. It opens when the user clicks the toolbar icon. | `manifest.side_panel`；`src/sidepanel.html` |
| `activeTab` | When the user limits the extension's site access to "on click", activeTab lets the assistant work on the tab the user invoked it from (toolbar click or the Alt+Shift+S / Alt+Shift+C shortcuts) without broader access. | 代码里没有单独的 activeTab API 调用；有 `<all_urls>` 时它只在用户把站点访问改成「点击时」才起作用。审核员可能认为冗余，见第 7 节 |
| `tabs` | The assistant needs each tab's URL and title to know which page it is working on, to open, switch, reload, and close tabs the user asks it to use, and to confirm a page has not navigated before acting. | `sys.tabs.*`、页面目标校验 |
| `scripting` | Injects the extension's own packaged content script into frames that do not have it yet (for example frames loaded before install), and runs packaged functions that attach a user-chosen file to a page's file input. No remote code is injected through this API. | `pageActionHost.js` 注入 `src/content_script.js`；`uploadChannel.js` 用 `executeScript({ world:'MAIN', func, args })`，`func` 是包内函数 |
| `storage` | Stores settings, the user's own API keys, the sign-in device token, and short-lived tab locks (storage.session) locally in the browser. | `chrome.storage.local` `browserbot_*`；`storage.session` 存 tab 租约 |
| `identity` | Used only for "Sign in to Browser Kitten": launchWebAuthFlow opens browserkitten.com so the user can sign in and connect this browser. We do not request Google account scopes through chrome.identity. | `src/agent/cloudAccount.js`：`launchWebAuthFlow`、`getRedirectURL`，没有 `getAuthToken` |
| `alarms` | Wakes the extension at the time a user-scheduled task or workflow is due, so it can continue even after Chrome has stopped the service worker. | `taskScheduler.js`、`workflowScheduler.js` |
| `downloads` | Saves files the user asks for: results the assistant makes (documents, CSV/XLSX, exported conversations) and files the assistant downloads from a page during a task. Also checks whether a download finished. | `chrome.downloads.download` / `search` |
| `offscreen` | The assistant's runtime (conversation store, model calls, sandboxed script runner) lives in an offscreen document so a task keeps running when the side panel is closed and when the service worker is restarted. It also receives tab audio/video when the user allows listening or recording. | `background.js` `createDocument` reasons：`WORKERS`、`BLOBS`、`USER_MEDIA`、`AUDIO_PLAYBACK` |
| `tabGroups` | Puts the tabs the assistant opens for one conversation into a named tab group, so the user can see and close them together. | `attachTabToSessionGroup`（`background.js`） |
| `webNavigation` | Lists the frames of a page (getAllFrames/getFrame) so the assistant can act inside iframes and verify it is still on the same document before each action. | `pageActionHost.js`、`documentTarget.js`、`browserSysHost.js` |
| `debugger` | Used only on a tab the assistant is working on, during a task the user started, when normal page actions are not enough: a real mouse click at a point on the page (for canvas or custom controls), attaching a file by drag-and-drop when a site has no file input, and advanced page inspection. Chrome shows its "started debugging this browser" bar while attached. Chrome does not allow debugger to be an optional permission, so it is requested at install. | 坐标点击：每次调用 attach、`finally` 里 detach（`pageActionHost.js` `executePointerCdp`）。`sys.cdp`：按 session + execution 归属，回合结束 `releaseBrowserExecution` → `releaseBrowserSysResources` detach。**上传 `method:'cdp'` 路径 attach 后没有找到对应 detach**，见第 7 节。因此英文说明里没写「每回合结束一定 detach」 |
| `userScripts`（可选） | Optional. Lets the assistant run a script in a page to read or change it when the page's controls are not enough, and make requests with the page's own sign-in. Off until the user turns it on in Settings → Advanced abilities; on Chrome 138+ the user must also enable "Allow User Scripts" on the extension's details page. | `sys.eval` / `sys.waitFor` / `sys.fetch({as:'page'})` → `chrome.userScripts.execute`；设置页 `chrome.permissions.request({permissions:['userScripts']})` |
| `tabCapture`（可选） | Optional. Captures the current tab's audio (listen) or audio and video (record, up to 30 seconds) so a model that accepts audio or video can understand it. Requested only when the user clicks to allow listening or recording in the side panel. | `tabListen.js` `getMediaStreamId`；录制默认 8 秒、最多 30 秒（`src/AGENTS.md`） |
| `host_permissions: <all_urls>` | The assistant works on whatever site the user asks it to, including sites where the user is signed in. Its content script provides element picking and page actions in every frame, and page reads and screenshots need access to the page. The sites are chosen by the user at task time and cannot be listed in advance. The extension does not read pages in the background for itself; pages are read when the user starts a task or picks content. | `content_scripts.matches: <all_urls>`，`all_frames: true`，`run_at: document_idle` |

`<all_urls>` 的补充（写给 owner）：content script 在所有页面常驻（为了点选和 action），这点审核员会看到。英文说明里「does not read pages in the background」要以代码为准：content script 在未被调用时只装监听、不上报——提交前请再确认 `src/content_script.js` 没有在加载时主动发送页面内容。

---

## 4. 远程代码声明（Remote code）

### 结论：选「Yes, I am using remote code」，并如实说明

商店对 remote code 的定义包括「传给 eval 的字符串」这类不在包里的代码。Browser Kitten 有三处执行模型临场生成的代码：

1. **`run`**：模型生成的 JavaScript / TypeScript，在 `manifest.sandbox` 的沙箱页里用打包进来的 QuickJS（WASM）解释执行；TypeScript 由打包的 esbuild-wasm 在本地转译。沙箱页没有 `chrome.*`，只能通过扩展自己的消息接口请求文件和浏览器操作，这些请求仍要过宿主的付款拒绝 / 删除审批门。
2. **`sys.eval` / 页面身份 fetch**：通过 `chrome.userScripts.execute` 在网页里执行模型生成的脚本。`userScripts` 是可选权限，用户在设置里打开并在 Chrome 138+ 打开「Allow User Scripts」之后才可用。
3. **`sys.cdp`**：通过 `chrome.debugger` 发送 CDP 命令。**`Runtime.evaluate` 之类的命令同样能在页面里执行任意代码，而且不受 `userScripts` 开关控制**（`riskClassify.js` 把它归为 raw，单一访问模式下自动放行）。

所有扩展自身的 JS / WASM（QuickJS、esbuild-wasm、AI SDK、fflate）都在包里，不从网络加载任何脚本；也没有运行时下载的 skills 或插件代码。

回答 No 在字面上站不住：第 3 点尤其明显。被查出来按「欺骗性声明」处理，比如实声明后被拒更糟。

### 后台 justification 框（英文，粘贴用）

```text
Browser Kitten does not load any of its own code from the network. All extension JavaScript and WebAssembly (including the QuickJS interpreter and esbuild-wasm) is in the package.

At the user's request, the AI model can write short scripts to complete the task. They run in three ways:
1. Data scripts run inside the extension's sandboxed page (manifest "sandbox"), interpreted by the packaged QuickJS WebAssembly runtime. The sandbox has no access to chrome.* APIs, extension storage, or the user's pages; it can only send requests to the extension, which applies the same checks as any other action.
2. Page scripts run through the chrome.userScripts API. userScripts is an optional permission that the user must grant in Settings, and on Chrome 138+ the user must also enable "Allow User Scripts" for the extension.
3. On a tab the assistant is working on, it can send Chrome DevTools Protocol commands through chrome.debugger, which Chrome marks with its debugging bar.

Scripts are generated for the user's current request, are not fetched from a server, and are not stored or distributed as extension code. Payments the extension recognizes are never carried out, and deletions it recognizes ask the user first.
```

### 被拒时的备选方案（出自 `docs/COMMERCIAL_LAUNCH.md`）

> 如果被拒，商店版先关掉 `sys.eval` / CDP，只保留 `action` 路径。

落地时的具体含义（给 owner 的整理）：

- 商店构建去掉 `sys.eval` / `sys.waitFor` / `sys.fetch({as:'page'})` 与 `sys.cdp`；`optional_permissions` 去掉 `userScripts`。
- 若连 `debugger` 也拿掉：`manifest.permissions` 删掉 `debugger`，坐标点击兜底和 `upload method:'cdp'` 一并失效（`docs/HANDOFF.md` 第 8 节已列为待定决策，建议先保留提交，被拒再出去 CDP 版本）。
- `run` 沙箱是否也要去掉：[[待定——若审核员连 sandbox 内解释执行模型代码也不接受，`run` 只能保留纯文件/文档操作，失去数据脚本能力]]。
- 需要一个构建开关（例如 pack 时的 store flavor）而不是分叉代码：[[实现方式待定，本文档不改代码]]。

---

## 5. 数据使用披露（Privacy practices 标签页）

原则：商店问的是「收集或使用」的数据。凡是会离开设备（发往 browserkitten.com，或经我们/用户自己的 Key 发往 AI、搜索服务商）的类别都勾上，宁可多勾不要漏勾；每项都要能在 privacy.html 找到对应段落。

| 商店类别 | 勾选 | 适用原因 | privacy.html 对应段落 |
|----------|------|---------|----------------------|
| Personally identifiable information | ✅ | 登录时的邮箱、姓名、头像、登录服务商账号 ID | What we collect → Account |
| Health information | ❌ | 不专门收集。页面内容若含健康信息，归入 Website content | — |
| Financial and payment information | ❌ | 付款由 Paddle 收集，我们只拿 Paddle customer / transaction ID，不拿卡号 | What we collect → Billing；short version「We never see your card details」 |
| Authentication information | ✅ | 扩展保存并发送我们签发的设备令牌；用户自己的 API Key 存在本地并发给用户选定的服务商 | What we collect → Account（hashed access token）；What stays on your computer（API keys） |
| Personal communications | ✅ | 用户可以让助手处理邮件、聊天等页面，这些文字会随请求发往模型；用户与助手的对话本身也会发往模型 | Content that passes through us on credits；short version（credits / own keys 两段） |
| Location | ✅ | 登录会话存 IP；Vercel 请求日志含 IP | What we collect → Account（IP address）；Hosting logs |
| Web history | ✅ | 任务里会读取标签页 URL 和标题并放进模型上下文 | 目前 privacy.html 只在 Chrome Web Store 一节说「not used to collect browsing history for us」，**建议补一句：请求里可能包含你打开的页面地址和标题**（见第 7 节） |
| User activity | ✅ | Workflow 录制会记录用户在页面上的点击和输入（存在本地）；任务中的页面快照、CDP 事件可能发往模型 | 目前没有对应段落，**建议在 What stays on your computer 加一句 workflow 录制**（见第 7 节） |
| Website content | ✅ | 页面文字、图片、截图、音视频片段会作为请求内容发往模型或搜索服务 | Content that passes through us on credits；What stays on your computer |

### 三项必选声明（全部勾选）

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

对应 privacy.html：「We do not sell your data and do not use it for advertising」「Who we share it with」「Chrome Web Store」三段。privacy.html 已写 Limited Use 声明。

隐私政策 URL：`https://browserkitten.com/privacy.html`（需在 `main` 分支上线后才可填，目前只在 `feat/backend`）。

---

## 6. 截图与宣传图

规格：1280×800 PNG，5 张。按 DESIGN.md：单色截图、不加浏览器装饰和假图表，一张图只讲一件事。说明文字写在图外或图上方一行。

| # | 画面 | Caption（英文） |
|---|------|----------------|
| 1 | 左边一个普通已登录网站（例如表单页），右边侧栏：用户一句话任务 + 助手正在逐步操作的记录 | Say what the open tab should finish. |
| 2 | 侧栏点选：页面上高亮一个元素，已被加入对话附件；或 Alt+Shift+C 区域截图附件 | Point at the part that matters. |
| 3 | 结果交付：侧栏里一个生成的文档或 CSV 交付物，旁边预览标签打开 | Get a finished document, sheet, or file back. |
| 4 | 删除审批：宿主弹出的「删除前确认一次」卡片 | Deletions ask once. Payments it recognizes never run. |
| 5 | 设置：Browser Kitten 账户卡（套餐 / 剩余积分）与自带 Key 两种方式并列 | Use your own keys, or sign in and use credits. |

注意：

- 截图里的网站用自己做的演示页或无品牌页面，不要出现真实第三方品牌（商店政策与 DESIGN.md 都不允许借别人的品牌）。
- 第 4 张写 `recognizes`，不要写成「never pays / never deletes」。
- 积分数字用 [[真实上线数值]]，不要截草稿值。

### 小宣传图 440×280

深色 `--paper #050506` 底，左侧官方 eared-tab 标志（右耳 `--signal #ff6a00`），右侧一行 `Browser Kitten`，下方一行小字 `Finishes the work in your tab.`。无渐变、无光效、无截图。

---

## 7. 审核风险与对策

| 风险 | 为什么 | 对策 |
|------|--------|------|
| 远程代码（最高） | `run` 解释执行模型生成的代码；`sys.eval` 用 userScripts；`sys.cdp` 的 `Runtime.evaluate` 可在页面执行任意代码且**不受 userScripts 开关约束** | 如实声明（第 4 节）。预先准备去掉 `sys.eval` / `sys.cdp` 的商店构建；考虑在商店版给 `sys.cdp` 加命令白名单（至少拦 `Runtime.evaluate` / `Runtime.callFunctionOn`），这样「页面脚本需用户开启」的说法才成立 |
| `debugger` 必需权限 + 安装警告 | 安装时出现「读取和更改所有数据 / 调试」类强警告，人工审核概率高；Chrome 不允许把它设为可选 | 说明只在任务中对正在处理的标签使用。若被拒，出不含 `debugger` 的版本（HANDOFF 第 8 节） |
| `upload method:'cdp'` 没有 detach | `pageActionHost.js` `executePageUpload` 的 CDP 分支 attach 后未找到 `detach`；该调用也不登记 `cdp:` 租约，回合结束的 `releaseBrowserSysResources` 可能清不到它，调试横幅可能一直挂着 | 代码问题，**本次不改**。提交前修复并实测横幅消失；修好之前对外不要承诺「回合结束一定断开调试」 |
| 权限过宽 / 冗余 | `<all_urls>` + 全 frame content script；`activeTab` 在已有 `<all_urls>` 时近乎冗余 | 权限说明写清「站点由用户在任务时决定」；`activeTab` 若说不清就删掉（未使用的权限是常见拒因） |
| 单一访问模式的描述 | 「除已知付款/删除外全部自动执行」对审核员和用户都敏感 | 描述里如实写，并强调 best-effort；不写「绝不付款/删除」 |
| manifest 文案 | `description` 自称「不面向 CWS，不出售」；中文 `default_title` 与英文主语言不一致 | 提交前改 manifest（见文首提醒） |
| 隐私表述不一致 | 官网多处写「Nothing is uploaded」（见 `docs/SITE_COPY_DRAFT.md`）；privacy.html 列了 Apple / Microsoft / GitHub 登录，但上线只开 Google + 邮箱验证码；Web history / User activity 两类在 privacy.html 里没有明确段落 | 先改官网文案，再按第 5 节补 privacy.html 的两句话，登录方式与实际开启的一致 |
| 付费功能与商店 | 商店不代收款，Paddle 收款没问题，但描述里的套餐与价格必须与官网一致，且免费可用范围要写清 | 定价页上线后再公开；描述里只链接定价页，不写具体积分数 |
| 未经真机验收 | HANDOFF：1.2.0 尚未通过真实 Chrome 全链路验收；审核员实测时功能坏掉会以「功能不完整」拒绝 | 先以 unlisted 提交；提供测试账号与测试说明（Test instructions 栏）：[[测试账号邮箱 / 带积分的测试账户]] |
| 本地数据不迁移 | 商店版扩展 ID 与 unpacked 不同，老用户数据不会跟过去 | 不是审核问题，但发布说明要写；需要的话先做导出/导入 |
