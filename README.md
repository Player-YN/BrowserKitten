# Browser Kitten

运行在 Chrome 侧栏中的浏览器 Agent。可以读取已登录网页、操作页面、整理资料，并把结果保存为文档、网页或文件；需要持续跟进时，也可以在本机安排后续检查。

当前扩展版本：**1.2.0**。这是通过「加载已解压的扩展程序」安装的体验版，仓库本身就是可加载的扩展，**不需要安装 Node.js、Python 或运行构建命令**。

## 下载与安装

1. [下载最新源码 ZIP](https://github.com/Player-YN/BrowserKitten/archive/refs/heads/main.zip)，也可以在本仓库点击 **Code → Download ZIP**。
2. **先解压**，把文件夹放到一个准备长期保留的位置。默认文件夹名为 `BrowserKitten-main`。
3. 在桌面 Chrome 中打开 `chrome://extensions`，开启右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择直接包含以下文件的文件夹：

   ```text
   BrowserKitten-main/
   ├── manifest.json
   ├── icons/
   └── src/
   ```

   选择这一层，不是 ZIP 文件，也不是里面的 `src/` 文件夹。

5. 在 Chrome 工具栏的扩展菜单中固定 **Browser Kitten**。打开普通网站，点击扩展图标即可打开侧栏；安装前已经打开的网页请先刷新。

最低 Chrome 版本为 **135**。加载后请保留该文件夹，Chrome 会直接从这里读取扩展文件。官方操作说明：[加载本地扩展](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。

## 首次配置

侧栏右上角菜单进入 **设置**。模型服务需能从你自己的电脑访问，调用费用由对应服务商或账户套餐决定。

| 配置 | 用途 | 首次体验是否需要 |
|---|---|---|
| **推理** | 理解任务、分析网页、规划和调用工具 | 需要 |
| **System1** | 执行网页点击、填写和选择控件 | 要操作页面时需要，单独配置 |
| 生图、转写、搜索 / 抽取 | 图片生成、音频转写、额外的网络搜索与抓取 | 按需配置 |

**使用自己的 API Key：**

1. 在 **推理 → 添加推理 API** 中选择模板或自定义服务商，填写 Base URL、API Key 和模型 ID，保存并选中要使用的模型。模型需支持工具调用。
2. 在 **System1 → 添加 System1** 中填写执行模型的 Base URL、API Key 和模型 ID，保存。当前页面执行使用 OpenAI-compatible 的 `/chat/completions` 接口；它与推理配置分开，不能只填推理 Key。可以使用同一服务商分别配置两个用途。
3. System1 的 **探测** 会发送一次不操作网页的小型执行模型请求，检查接口及回复格式；探测通过不代表已验证所有网站或视觉输入。

GitHub 下载的 unpacked 版本默认允许自带 Key，不要求先登录 Browser Kitten 或购买套餐；外部 API 的余额与模型权限仍由服务商决定。

**使用 Browser Kitten 账户：**也可以通过侧栏登录，使用账户提供的模型和积分服务。可用服务、额度和套餐以登录后的实际显示为准；这部分依赖独立后端，不随本仓库一起部署。

## 先完成一个小任务

在普通 `http(s)` 网页上打开侧栏，先发送：

> 总结当前页面的主要内容，并把关键结论整理成一份文档。

推理与 System1 都配置后，可以在熟悉的网站上尝试：

> 在这个网站搜索「浏览器自动化」，整理前三条结果的标题和链接。

**Enter 换行，Ctrl+Enter / Cmd+Enter 发送。** 需要指定页面的一部分时，可以使用侧栏的「点选」。产出的文档、网页和文件可从侧栏的文件入口打开。

## 页面脚本与录音 / 录屏

- 某些页面操作需要运行脚本：在 **设置 → 高级能力 → 开启页面脚本** 中授权。
- Chrome **138 及以上**还需要打开 `chrome://extensions` → Browser Kitten **详情** → **允许用户脚本 / Allow User Scripts**。授权后按界面提示重新检查；[Chrome 官方说明](https://developer.chrome.com/docs/extensions/reference/api/userScripts#enable_usage_of_the_userscripts_api)。
- 标签页录音、录屏需要点击侧栏出现的采集授权按钮。是否能直接理解音视频，还取决于当前模型的输入能力。
- `chrome://`、Chrome Web Store 等受限制页面不能按普通网页操作。使用调试能力时，目标标签页已经打开的 DevTools 可能造成 `CDP_BUSY`。

## 持续任务与定时检查

可以直接描述要持续达成的目标、允许的操作、报告条件和结束条件，例如「每隔 10 分钟检查这个页面，出现新内容时整理并告诉我，持续到今晚 8 点」。Agent 也可以在已授权目标范围内，自行安排检查时间、调整间隔和停止不再需要的唤醒。

任务出现在**输入框上方可收起的任务抽屉**中。展开可查看进度、最近检查和下次唤醒，并执行暂停、继续、停止自动唤醒或取消。

- 任务在**本机 Chrome**内运行，关闭侧栏后仍可续跑；关闭浏览器、电脑休眠或关机期间不会执行，也不会补跑每个错过的间隔。
- 当前使用分钟级定时检查，**尚未实现网页新消息的即时事件订阅**。
- 新定时任务默认只在有变化、采取行动或需要介入时报告；没有变化时可静默更新检查状态。
- 固定到某个页面的任务在目标页面缺失或匹配不唯一时暂停；定时轮次默认有 5 分钟执行预算，超时后暂停等待处理。

## 更新、数据与能力边界

更新时，下载新的 ZIP，将内容覆盖到**原来加载的文件夹**，到 `chrome://extensions` 点击本扩展的 **重新加载**，并刷新需要操作的网页。保持原加载路径、不要卸载重装，以保留同一扩展下的本地数据；重新加载会中断当前执行，建议先暂停任务并导出重要成果。

API Key 和设置保存在当前 Chrome 配置的 `chrome.storage.local`，会话、任务与文件使用本机 IndexedDB / OPFS。换电脑不会自动迁移；删除扩展会清除其本地数据。执行任务时，所需的网页内容、截图或附件可能发送给配置的模型及其他服务商。

当前没有云端常驻执行环境，也没有原生桌面或终端控制。Prompt 中的 Agent 标签组和浏览器独占属于行为要求，**尚未由宿主实现全浏览器独占与所有网页自动入组的硬约束**；体验时请一次运行一个需要操作浏览器的任务。

## 常见问题与反馈

| 现象 | 处理方式 |
|---|---|
| 加载时提示找不到清单 | 解压 ZIP，选择直接包含 `manifest.json` 的文件夹 |
| 可以对话，但点击提示 `NEED_JEV` | 单独配置并保存 System1，检查 Base URL、Key 与模型 ID |
| 提示 `PERMISSION_REQUIRED` | 按提示授予能力；页面脚本还需检查 Chrome 的「允许用户脚本」开关 |
| API 返回 401、403、模型不存在或额度不足 | 核对对应服务商的 Key、模型 ID、权限和余额 |
| 页面没有反应或提示 `NEED_PAGE` | 改用普通网站，刷新网页，再打开侧栏重试 |
| 提示 `TAB_LEASED` / `SESSION_BUSY` | 等当前执行结束，或先停止原任务，再继续 |

反馈时请提供 Chrome 版本、操作系统、复现步骤、完整错误码，以及已隐藏敏感内容的截图。可在 [GitHub Issues](https://github.com/Player-YN/BrowserKitten/issues) 提交，**不要附 API Key、登录令牌或含私人对话的完整导出记录**。

## 开发与验证

普通体验不需要以下命令。项目是原生 Chrome MV3 扩展，无 `package.json`、无需 npm。侧栏经 Service Worker 调用 offscreen 中的 Session Workspace；模型循环与存储在 offscreen，浏览器 API 由 Service Worker 派发。

```sh
node --test tests/*.test.mjs
python3 scripts/pack_extension.py --zip dist/BrowserKitten_1.2.0_extension.zip
python3 scripts/verify_extension.py extension --source .
node tests/browser-smoke.cjs <path-to-playwright-package>
```

逻辑回归使用 Node.js 22+；打包使用 Python 3.10+。打包脚本从当前工作区生成 `extension/` 与 ZIP；输出不入库。浏览器烟测使用独立临时配置，需要另外准备 Playwright 和 Chromium；`BROWSERBOT_LOAD_ROOT=extension` 可检查打包目录，`BROWSERBOT_CHROMIUM_EXECUTABLE` 可指定 Chromium 可执行文件。逻辑测试、浏览器烟测与真实模型 / 网站验收分别进行。

技术资料：[架构](AGENTS.md) · [宿主与消息](src/AGENTS.md) · [Agent runtime](src/agent/AGENTS.md) · [UI](Design.md) · [个人工具](docs/PERSONAL_LIBRARY.md) · [Workflow](docs/WORKFLOW_V1.md) · [媒体](docs/CHAT_MEDIA_INPUT.md) · [账户接口](docs/COMMERCIAL_LAUNCH.md)。

## License

[MIT](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
