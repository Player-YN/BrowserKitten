# Getting started

[Home](../README.md) · [简体中文](GETTING_STARTED.zh-CN.md) · [Documentation](README.md)

## Install

Use desktop Chrome 135 or newer. This unpacked extension needs no build or package installation.

1. [Download the main-branch ZIP](https://github.com/Player-YN/BrowserKitten/archive/refs/heads/main.zip) and extract it into a permanent folder.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the extracted `BrowserKitten-main` folder, directly containing `manifest.json`, `icons/`, and `src/`. Do not select the ZIP or the `src` subfolder.
4. Pin Browser Kitten from Chrome's extension menu. Open an ordinary HTTP(S) website and refresh tabs that were open before installation.
5. Click the extension icon to open its side panel.

Chrome continues to load files from this folder; keep it in place. The source ZIP follows `main`, which can be newer than the tagged GitHub Releases. See [Chrome's unpacked-extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).

## Configure providers

Open **Settings** in the side-panel menu. Add an **Inference** provider with a Base URL, API key, and a model ID that supports tool calls. Save it and select the model.

To operate page controls, also add a **System1** provider. This is a separate configuration for the execution model, using an OpenAI-compatible `/chat/completions` endpoint. Inference and execution may use the same provider, but configuring one does not configure the other. Missing execution credentials produce `NEED_JEV`. System1's **Probe** makes a no-action request to the actual executor route and checks its decision format; it does not test every website or visual input.

Image generation, transcription, and additional search/extraction services are optional. Use only the ones your tasks need. API endpoints must be reachable from your computer, and provider usage is billed by that provider.

The GitHub unpacked build accepts your own keys without a Browser Kitten subscription. Signing in for account-hosted models and credits is optional; availability and quotas come from the separate backend, which is not deployed by this repository.

## First task

On an ordinary webpage, try:

> Summarize this page and save the key findings as a document.

After configuring both Inference and System1, try a small interaction on a familiar website:

> Search this website for “browser automation” and collect the titles and links of the first three results.

**Enter** inserts a newline; **Ctrl+Enter / Cmd+Enter** sends. Use **Pick** to refer to selected page content. Open generated documents, webpages, or files through the side-panel file entry.

## Permissions

- **Page scripts:** choose **Settings → Advanced capabilities → Enable page scripts** when required.
- **Chrome 138+:** also open `chrome://extensions` → Browser Kitten **Details** → **Allow User Scripts**. Follow the UI's recheck instructions. See [Chrome's userScripts documentation](https://developer.chrome.com/docs/extensions/reference/api/userScripts#enable_usage_of_the_userscripts_api).
- **Recording:** click the side-panel capture grant when requested. Audio/video understanding also depends on the selected model's input capabilities.
- **Restricted pages:** Chrome internal pages and the Web Store cannot be operated like ordinary websites. If CDP reports `CDP_BUSY`, close DevTools attached to the target tab.

## Local follow-ups

Specify the goal, permitted actions, reporting conditions, and when to stop. For example:

> Check this page every 10 minutes, summarize new items, and stop at 8 pm today.

The agent can choose or adjust follow-up times within your goal without a separate timer request. Tasks appear in the **collapsible drawer above the input**. Expand it to inspect progress, recent checks, and the next wakeup; pause, resume, stop automatic wakeups, or cancel there.

Chrome must be running and the computer awake. Closing the side panel does not stop checks. They do not execute while the browser is closed or the computer sleeps, and missed intervals are not replayed one by one. Immediate webpage-event subscriptions are not implemented.

New scheduled tasks can report only meaningful changes, actions, or requests for help. Page-bound tasks pause when the target is missing or ambiguous. Scheduled rounds have a default five-minute budget; a timeout pauses for inspection rather than proving the task completed.

## Updates and data

Pause work, export important deliverables, then replace the files at the **same loaded folder path** with a newly extracted source ZIP. Click **Reload** on `chrome://extensions` and refresh the website. Reloading interrupts current execution. Avoid uninstalling first if you want to preserve local data.

API keys and settings live in `chrome.storage.local`; sessions, tasks, and files use local IndexedDB / OPFS. They do not automatically migrate to another computer, and removing the extension clears its local data. Relevant page content, screenshots, and attachments can be sent to the providers configured for a task.

There is no cloud runner or native OS / terminal control. The Agent tab-group and exclusive-browser principles in the prompt are not global host guarantees: the current host uses per-tab leases and per-session execution slots. Run one browser-operating task at a time.

## Troubleshooting

| Symptom | What to check |
| :--- | :--- |
| Missing manifest during installation | Extract the ZIP and select the folder directly containing `manifest.json`. |
| Chat works, but clicks return `NEED_JEV` | Configure and save System1 separately, including Base URL, key, and model ID. |
| `PERMISSION_REQUIRED` | Grant the indicated capability; for page scripts, check Chrome's Allow User Scripts toggle too. |
| 401 / 403 / model unavailable / quota errors | Check the selected provider's credentials, model permissions, ID, and balance. |
| `NEED_PAGE` or no page response | Use an ordinary HTTP(S) webpage, refresh it, and reopen the side panel. |
| `TAB_LEASED` / `SESSION_BUSY` | Wait for the current execution, or stop the original task before continuing. |

For help, see [Support](../SUPPORT.md) or submit a [bug report](https://github.com/Player-YN/BrowserKitten/issues/new?template=bug_report.yml). Include Chrome and OS versions, reproduction steps, and the error code. Remove credentials and private task data before sharing logs or screenshots.

For development, see [Contributing](../CONTRIBUTING.md). Runtime, packaging, and real-model / website checks are separate kinds of verification.
