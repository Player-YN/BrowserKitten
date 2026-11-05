# Contributing to Browser Kitten

[Home](README.md) · [Documentation](docs/README.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

Thanks for helping improve Browser Kitten. Documentation fixes, clear bug reports, and focused code changes are useful contributions. **English and Chinese are both welcome / 欢迎使用中文或英文。**

## Choose the right starting point

- Search existing [issues](https://github.com/Player-YN/BrowserKitten/issues) before opening another one.
- For bugs, include a small reproduction and the exact error code using the bug template.
- For a substantial change, open a feature request describing the problem and intended behavior before investing in a large PR.
- Send security findings through [private reporting](SECURITY.md), not public issues.

## Work locally

```sh
git clone https://github.com/Player-YN/BrowserKitten.git
cd BrowserKitten
git switch -c your-change
```

Load this repository root in Chrome as an unpacked extension. There is no `package.json`, npm install, or production build step. See [Getting started](docs/GETTING_STARTED.md) for browser setup and provider configuration. Use your own credentials; never commit them.

The side panel renders UI, the offscreen document runs the agent and store, and the Service Worker dispatches browser operations. Read the relevant [architecture documentation](docs/README.md#develop-and-understand--开发与架构) before changing those boundaries. Reuse existing UI tokens and browser ownership / permission contracts.

## Validate the change proportionately

Runtime regressions require **Node.js 22+**. Packaging requires **Python 3.10+**:

```sh
node --test tests/*.test.mjs
python3 scripts/pack_extension.py
python3 scripts/verify_extension.py extension --source .
git diff --check
```

- For behavior changes, run relevant tests first, then the existing full suite. Add regression coverage when it demonstrates a meaningful failure; avoid tests that merely repeat implementation details.
- For UI changes, reload the extension and inspect the affected flow at a narrow side-panel width, including light/dark themes and keyboard interaction when relevant.
- For documentation-only changes, check rendered Markdown, navigation, relative links, and both README languages. Runtime tests are unnecessary unless the change affects behavior or packaging.

The optional browser smoke test uses Playwright and an independent temporary Chromium profile:

```sh
node tests/browser-smoke.cjs <path-to-playwright-package>
```

`BROWSERBOT_LOAD_ROOT=extension` tests the packaged tree; `BROWSERBOT_CHROMIUM_EXECUTABLE` selects an installed Chromium executable. Model and website outcomes require separate live verification. Do not report them as tested from a Node-only run.

## Submit a focused pull request

Explain the problem, resulting behavior, and checks performed. Include screenshots for visible UI changes, and identify material limits or unverified behavior. Update affected documentation; if the README structure or capabilities change, keep [English](README.md) and [中文](README.zh-CN.md) aligned.

Keep generated `extension/`, `dist/`, browser profiles, logs, account tokens, and task exports out of commits. Preserve required third-party notices. Changes should respect the existing [MIT license](LICENSE); this project does not require a separate CLA.

Maintainers may request revisions or decline changes outside the project's current scope. There is no guaranteed review turnaround.
