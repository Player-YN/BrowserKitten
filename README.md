<div align="center">

# 爪爪 · PawWork

[![license](https://img.shields.io/github/license/Player-YN/PawWork_ZhuaZhua)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![unpacked](https://img.shields.io/badge/load-unpacked-111111)](#load-it)

Treat the already-logged-in Chrome as a programmable computer. 爪爪 is the agent on that machine.

</div>

**爪爪 · 完全解放版** (`PawWork_ZhuaZhua`) is a Chrome MV3 **unpacked** extension. It runs a side-panel agent that can drive the current tab (`action`), execute guest JS against the browser (`sys` inside `run`), and keep sheet / Univer doc / site HTML artifacts in the session.

Not on the Chrome Web Store. No hosted model — bring your own key.

## Load it

1. Clone this repo, **or** download a [Release zip](https://github.com/Player-YN/PawWork_ZhuaZhua/releases)
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the folder (`manifest.json` is at its root)
3. Open the side panel → paste an OpenAI-compatible API key (BYOK; stored in `chrome.storage.local`) → send a task on a normal `http(s)` page

After editing files, click **重新加载** on the extension card. There is no `package.json` and no build step.

Public-web search works without a search API key on a fresh installation through
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp), using Fast mode.
Search queries are sent to `https://search.parallel.ai/mcp` without browser cookies.
Saved Tavily, Brave and Firecrawl settings keep their existing routing. In settings,
select **Parallel** to use keyless search or **Search off / 关闭公开网搜索** to disable
public-web search. URL fetching and bound-page access keep their existing behavior.
Anonymous search has service limits; errors are returned without switching providers.

Needs Chrome 135+. On Chrome 138+, enable **Allow User Scripts** on the extension details page if you want `sys.eval` or page-identity fetch. Close DevTools on the target tab before using `sys.cdp` (otherwise `CDP_BUSY`). Restricted pages such as `chrome://` and the Web Store return `NEED_PAGE`.

## Tests

```text
node --test tests/runtime-regression.test.mjs      # pure Node, no browser
node tests/browser-smoke.cjs <path-to-playwright>  # loads the real extension
```

## Architecture

Side panel → service worker → offscreen `SessionWorkspaceService` → AI SDK `ToolLoopAgent`. Process layering, domain objects, tool contracts, and the unimplemented boundaries are documented in [AGENTS.md](AGENTS.md) and the nested `AGENTS.md` files under `src/`.

Release packaging: `python scripts/pack_extension.py --zip dist/pawwork.zip`.

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
