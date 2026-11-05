# Security policy

## Report privately

Use **[GitHub private vulnerability reporting](https://github.com/Player-YN/BrowserKitten/security/advisories/new)** for suspected vulnerabilities. Do not publish exploit details, API keys, tokens, cookies, or private browser content in issues or pull requests.

Include the affected commit or extension version, Chrome version, a minimal reproduction, expected impact, and a proposed mitigation if you have one. Synthetic test pages and redacted examples are preferable to real account data. Give maintainers an opportunity to investigate before public disclosure. No response deadline or bounty program is promised.

## Versions and scope

Please check whether the issue reproduces on current `main`; older tagged builds may not include subsequent fixes. There is no published long-term support window. This policy covers code in this repository. Hosted account services and model providers are separate systems; identify which component is affected.

Browser Kitten runs inside a signed-in browser and uses broad webpage permissions. Prompts and tab groups do not establish a security boundary. Page ownership, sandboxing, host gates, and dispatch checks are relevant controls, but they do not justify blanket claims about preventing every harmful action. Local storage is not a credential vault, and necessary task content may be sent to configured providers.

Setup, data handling, and current implementation limits are documented in [Getting started](docs/GETTING_STARTED.md) and the [runtime architecture](AGENTS.md).

**中文：**安全漏洞请通过上方 GitHub 私密漏洞报告入口反馈。请附受影响版本、Chrome 版本和最小复现，不要在公开 Issue 中上传密钥、Cookie、私人页面内容或利用细节。项目未承诺固定响应时限或漏洞奖金。
