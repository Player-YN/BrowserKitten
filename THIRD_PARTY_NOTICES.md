# Third-party notices

Browser Kitten's own code is MIT-licensed (see [LICENSE](LICENSE)). This repository **does** commit and redistribute the third-party runtime bundles listed below — an unpacked MV3 extension has no install step, so every dependency must already be in the load root. Build commands for the Univer bundles are recorded in [`src/preview/vendor/README.md`](src/preview/vendor/README.md).

| Component | License | How it ships |
|-----------|---------|--------------|
| [Univer](https://univer.ai) (`@univerjs/*` presets) | Apache-2.0 | Committed as `src/preview/vendor/sheet-runtime.*` and `docs-runtime.*` |
| [SheetJS CE](https://sheetjs.com) (`xlsx`) | Apache-2.0 | Bundled inside the committed `src/preview/vendor/sheet-runtime.js` |
| [React](https://react.dev) / `react-dom` | MIT | Bundled inside the committed Univer runtimes |
| [Lucide](https://lucide.dev) | ISC | Icon path data inlined in `src/sidepanel/icons.js` |
| [esbuild](https://esbuild.github.io) (`esbuild-wasm`) | MIT | Committed as `src/agent/vnext/adapters/vendor/esbuild.wasm` + `esbuild-loader.mjs` |
| [QuickJS](https://bellard.org/quickjs/) via [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) | MIT (both) | Committed as `src/agent/vnext/adapters/vendor/quickjs-loader.mjs` |
| [Vercel AI SDK](https://ai-sdk.dev) (`ai`, `@ai-sdk/openai-compatible`) | Apache-2.0 | Committed as `src/agent/vnext/adapters/vendor/ai-sdk-loader.mjs` |
| [Zod](https://zod.dev) | MIT | Bundled inside the committed `ai-sdk-loader.mjs` |
| [fflate](https://github.com/101arrowz/fflate) | MIT | Committed as `src/preview/vendor/fflate.js` |
| [Playwright](https://playwright.dev) | Apache-2.0 | Dev-only, supplied by the machine running `tests/browser-smoke.cjs`; not committed, never packaged |

Upstream license texts are at the linked project pages. If you redistribute builds of this extension, you are responsible for complying with each upstream license.
