# src/preview — 画布与预览标签

扩展页，由 SW 打开（`chrome.runtime.getURL('src/preview/…')`）。**不是** content script，也不是 agent 循环。读写经 `sheet_host` / artifact RPC 回到 SW → offscreen store。`canvas_host` 对已删除的 Design/Slides 返回 `NO_CANVAS`。

分类仍由 `openClassify.js` 做 kind / MIME / 魔数。打开面、家族与徽标走 `artifactCapability.js`（`previewEntryForItem` / `previewViewForItem` 是它的再导出）。shelf 与预览不得另写一套 if-else。

## 页面

| 页 | 引擎 | 打开时机 |
|----|------|----------|
| `sheet.html` | Univer Sheets（`vendor/sheet-runtime.*`） | csv / tsv / xlsx / json-workbook |
| `docs.html` | Univer Docs（`vendor/docs-runtime.*`） | docx / json-document / html-document |
| `site.html` | 静态 HTML+CSS 宿主 + postMessage bridge | `data-browserbot-kind=site`。**不是**任意 guest JS 运行时。用户 `<script>` / on* 被 `siteSanitize` 剥掉。bridge（ready/click/serialize/nudge）跑在 `sandbox.pages` 的 `siteFrame.html` + 外部 `siteFrame.js`，无 chrome.*、无 extension-origin 同源。禁止把内联 `<script>` 塞进 srcdoc。动态行为另立安全 runtime |
| `artifactPreview.html` | 通用查看 | 图片/svg、PDF 只读重建、音视频、text-like 转义只读、未知检查器。未知 HTML 不 `srcdoc` 执行。文案：`?lang=en\|zh` 优先，**不**把页面上写死的 `zh-CN` 当用户语言 |
| `print.html` | 系统打印 | PDF 交付：`delivery: browser_print` → Save as PDF |
| `preview.html` | 旧草稿预览 | 遗留 `open_draft_preview` |

共享：`workLock.js`（**同一 session** 在预览画布上的执行中 UI 锁，`execution-start/end` →「编排中」；**不是** SW 里跨 session 的 live-page tab 租约 / `TAB_LEASED`）、`officeHelp*` / `officeShortcuts` / `officeSelBubble`、`durableImage.js`、`host-bar.css`。表编解码：`sheetCodec.js` / `sheetModel.js`（agent office 工具也会 import）。

## Vendor

`vendor/sheet-runtime.*` · `docs-runtime.*` · `fflate.js` **已跟踪**，unpacked 加载需要。不要在扩展页直接 `import` `@univerjs/*`。不要引入 `@univerjs-pro/*`。历史打包命令记在 `vendor/README.md`；本仓库日常无 `package.json`。

## 宿主约定

- Query：`sessionId`、`artifactId`；预览语言可选 `lang=en|zh`。
- 页 load 后发 `sheet_tab_ready` / `html_tab_ready` / `docs_tab_ready`。
- 同一 session+artifact 复用标签（SW 里 `sheetTabByKey` / `htmlTabByKey`）。
- **预览/检查器**走 `readArtifactPreview`（默认 64K，硬顶 8M）。**下载/编辑器载入**走 `downloadArtifact` / `readArtifactChunk`，必须原字节完整。截断只能显式拒绝，不能把 truncated 前缀当完整文件。
