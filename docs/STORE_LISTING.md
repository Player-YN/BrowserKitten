# Manifest、权限与发布验证

本文记录当前源码的技术接线，不包含产品定位、商店宣传文案、套餐或市场决策。权限事实以 `manifest.json` 与实际调用为准。

## Manifest

`manifest_version: 3`、`version: 1.2.0`、`minimum_chrome_version: 135`；当前无 `version_name` 或 `update_url`。`name` 为 `Browser Kitten`，`action.default_title` 为 `Open Browser Kitten`，description 和快捷键说明为英文。

## 权限接线

| 权限 | 实现位置与用途 |
|------|----------------|
| sidePanel | 侧栏 UI 与工具栏打开入口 |
| activeTab / tabs | 当前授权标签、标签读取与管理 |
| scripting | 注入包内 content script 与 MAIN-world 上传函数 |
| storage | 设置、账户、storage.session 租约与派发工单 |
| identity | cloudAccount.js 的 launchWebAuthFlow |
| alarms | taskScheduler.js 的 Task 唤醒、workflowScheduler.js 的定时新运行 |
| downloads | 文件下载与下载完成检查 |
| offscreen | SessionWorkspaceService、持久化、QuickJS 客户端、音视频采集 |
| tabGroups | 会话相关标签分组 |
| webNavigation | frame / documentId 与导航检查 |
| debugger | guest CDP、宿主坐标输入与显式 CDP 上传 |
| userScripts（可选） | sys.eval / waitFor / page-fetch，及脚本类 CDP 的能力门 |
| tabCapture（可选） | 用户点击授权后的标签音频或视频采集 |
| host_permissions: all_urls | HTTP(S) 页面的 content script 与页面运输 |

`debugger` 仍在必需权限中。脚本类 guest CDP 在占租约、消费 ticket 和 attach 前检查 userScripts。缺少可选权限返回 `PERMISSION_REQUIRED`；采集还需要相应的侧栏授权。

## 代码运行与数据

QuickJS / esbuild-wasm / AI SDK loader 随扩展打包。模型生成的 JS/TS 在 sandbox 解释执行，guest 无 chrome.*；fs/sys 经宿主 RPC。页面脚本使用 userScripts，网站预览仅执行包内 sandbox bridge，用户脚本由 siteSanitize 剥离。

会话保存在 IndexedDB + OPFS，设置与 Key 保存在 chrome.storage.local。模型请求可能包含对话与网页信息，发送到配置的服务商或账户代理；服务端数据策略需要在对应后端源码核验。

## 打包与验收

加载根为仓库根。pack_extension.py 从工作区生成 extension/ 与 zip，verify_extension.py 校验本地依赖和源码字节一致性。Node 回归、打包检查、真实 Chrome 验收分别执行，不互相替代。改变扩展 ID 会改变存储所属，既有数据不会自动迁移。
