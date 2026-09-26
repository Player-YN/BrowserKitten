<div align="center">

# Browser Kitten

[![license](https://img.shields.io/github/license/Player-YN/BrowserKitten)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![unpacked](https://img.shields.io/badge/load-unpacked-111111)](#load-it)

Treat the already-logged-in Chrome as a programmable computer. Browser Kitten is the agent on that machine.

</div>

**Browser Kitten** is a Chrome MV3 **unpacked** extension. It runs a side-panel agent that can drive the current tab (`action`), execute guest JS against the browser (`sys` inside `run`), and keep sheet, marked-HTML document, and site HTML artifacts in the session.

Not on the Chrome Web Store. No hosted model — bring your own key.

## Load it

1. Clone this repo, **or** download a [Release zip](https://github.com/Player-YN/BrowserKitten/releases)
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the folder (`manifest.json` is at its root)
3. Open the side panel → paste an OpenAI-compatible API key (BYOK; stored in `chrome.storage.local`) → send a task on a normal `http(s)` page

After editing files, click **重新加载** on the extension card. There is no `package.json` and no build step.

Needs Chrome 135+. On Chrome 138+, enable **Allow User Scripts** on the extension details page if you want `sys.eval` or page-identity fetch. Close DevTools on the target tab before using `sys.cdp` (otherwise `CDP_BUSY`). Restricted pages such as `chrome://` and the Web Store return `NEED_PAGE`.

只有一种访问模式，没有开关：已知付款一律不执行，已知删除先问你一次，其余操作（包括页面脚本和 CDP）自动进行。风险分类是启发式的 **best-effort**，不是硬安全保证。

## Tests

```text
node --test tests/*.test.mjs                      # policy/journal + 既有回归
node --test tests/runtime-regression.test.mjs      # 子集
node tests/browser-smoke.cjs <path-to-playwright>  # loads the real extension
```

## Architecture

UI 配色、组件、布局与交互规范见 [Design.md](Design.md)。

Side panel → service worker → offscreen `SessionWorkspaceService` → AI SDK `ToolLoopAgent`. Process layering, domain objects, tool contracts, and the unimplemented boundaries are documented in [AGENTS.md](AGENTS.md) and the nested `AGENTS.md` files under `src/`.

Release packaging: `python scripts/pack_extension.py --zip dist/browserbot.zip`.

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Chrome BOT 架构优化候选版

当前源码版本为 **1.2.0-bot-candidate**。保留原有模型工具、Task 语义和 Chrome 内运行边界；补充文档级页面目标、可跨 SW 重启的 tab 租约、执行归属/CDP 释放、RPC 方法清单与未知结果处理。

架构取舍、修改清单、验证范围及本地验收见 [docs/CHROME_BOT_OPTIMIZATION.md](docs/CHROME_BOT_OPTIMIZATION.md)。
**Node 测试通过不代表真机验收通过**：本轮受管理策略限制，Chromium 未加载待测扩展。

```sh
node --test tests/*.test.mjs
python3 scripts/pack_extension.py --zip dist/BrowserKitten_ChromeBOT_1.2.0_extension.zip
python3 scripts/verify_extension.py extension --source .
```

源码包无需 `.git` 即可打包；运行包根目录直接包含 manifest.json。不改存储键、不迁移 IDB 数据；更新前先停止任务并保留原目录，采用原路径替换/补丁的方式更新，避免误删原扩展数据。

音视频如何进入当前推理模型、Agent 如何自主选择视频证据，以及设置与手测步骤，见 [当前模型媒体输入](docs/CHAT_MEDIA_INPUT.md)。


自定义工具与 Workflow 的制作、持久化、备份及执行边界见 [个人库说明](docs/PERSONAL_LIBRARY.md)。新增无 Key 的顺序自动化支持多标签录制、步骤编辑、固定工具依赖和核查续跑；开发合同及 Chrome 手工验收见 [Workflow 第一阶段](docs/WORKFLOW_V1.md)。
