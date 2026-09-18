# 当前推理模型的音视频输入

需要现场时序画面时使用 `action op=record`（默认 8 秒，最多 30 秒，tab 画面 + 声音）；现场声音仍是 `action op=listen`（只录 tab 音频，授权和回放不变）。公开可下载音视频用 `acquire action=fetch url=…`；已经下载的媒体用 `acquire action=fetch path=…`。登录态文件先用 `run` 中的 `sys.fetch({as:'page', …, saveTo:'/scratch/…'})` 保存，再 fetch path。没有增加工具，也不会改用生图供应商理解媒体。

每次发送只读取一份当前 chat 设置和目录缓存，模型构造、工具路由和请求转换共用这份快照。下次发送重新读取，因此切换 `settings.model` 不需要先点探测。`GET /models` 仅收集声明，绝不发 chat 请求试错。

能力按 text / image / audio / video 分别记录 supported / unsupported / unknown，以及来源。优先级是：当前供应商内、Base URL + 精确模型 ID 的用户覆盖 > 目录 `architecture.input_modalities`（或顶层 `input_modalities`）> 小范围已知模型声明 > unknown。只匹配完整 ID，不用供应商级布尔值或模型尾名匹配。旧缓存没有该字段就是未知，output modalities 和生图标记不会提升输入能力。

设置 → 推理 API →「当前模型的媒体输入」可确认图片、音频、视频支持情况。自建兼容网关还需选择其文档声明的传输协议；该选择也仅作用于此 Base URL 和模型。自动模式下，音视频未知就走已有 STT，没有配置则返回 `NEED_STT`，同时保留原文件与原因；图片保留既有的未知可尝试策略，明确否定则不发送。

原生输入要求「模型支持」和「接口可传输」同时成立：

| 接口 | 音频 | 视频 |
| --- | --- | --- |
| OpenAI Chat / Gemini OpenAI 兼容端点 | `input_audio`，WAV / MP3 | 本实现没有已确认的兼容视频传输，降级 STT |
| OpenRouter Chat | `input_audio`，WAV / MP3 | `video_url` + 内联 data URL，MP4 / MPEG / MOV / WebM |
| 自建网关 | 用户显式选择上述协议，同时声明精确模型的能力 | 同左 |

普通 `gpt-4o` 不因名字而当作音频模型；音频专用 ID 与普通 ID 分开。已知 Gemini 音视频能力也不会自动证明某个未知网关支持这些 wire parts。内置 Gemini 默认仅覆盖代码中列出的版本，新型号可以通过目录或显式配置声明。

WebM/Opus 听音在 offscreen 用 Web Audio 解码、混成单声道 PCM WAV，然后进入原生输入；绝不只改 MIME 冒充 WAV。需要转换的音频限制 120 秒，单份原生媒体限制 16 MiB；转换失败或超限保留文件并尝试 STT。视频降级仅代表语音，不声称已经看到画面。`acquire action=transcribe` 仍明确调用独立的 STT API。

工具回执把路径、来源和路由留在 JSON，字节只放 `modelParts`。`toModelOutput` 传入 SDK 后，provider 将媒体从 tool JSON 提升为紧随完整 tool-result 批次的 user 媒体 parts；原有 JPEG `image_url` 路径保留。发送前再次核对 body.model，不匹配或不允许的音视频会被移除，绝不把 base64 留作普通文本。模型收到 STT 文本和 `NEED_STT` 的 action 输出也已修复。

实现依据：[OpenRouter 音频协议](https://openrouter.ai/docs/guides/overview/multimodal/audio)、[OpenRouter 视频协议](https://openrouter.ai/docs/guides/overview/multimodal/videos)、[Gemini OpenAI 兼容音频示例](https://ai.google.dev/gemini-api/docs/openai#audio-understanding)。模型原生能力、API 端点支持和文件编码是三个不同条件；元数据不能保证远端始终接收成功，正常请求错误不用于学习或探测能力，也不触发媒体试错重发。

回归：`node --test tests/chat-media.test.mjs` 覆盖缓存、精确匹配、设置作用域、切模快照、listen/fetch 原生与降级、大小/转换失败，以及真实打包 AI SDK 的请求序列化（使用本地 fetch stub，不调用供应商）。全量命令仍是 `node --test tests/*.test.mjs`。真实 Chrome 录音与解码需要另行烟测。

## Agent 如何自主想到视频

基础能力由四层配合，不依赖用户说“看视频”，也不依赖按需 Skill 才能发现：

- **感知事实**：snapshot 的 `mediaElements`（最多 6 项）列出可见性、播放状态、时间、HTTP 源候选 / blob 或 srcObject 流，并附 frame/document。HTTP 候选不代表可匿名下载。动态 canvas/界面即使没有 video 标签也可以录制。
- **当前能力**：每轮 world 注入 `routes.nativeVideo/nativeAudio` 和确切入口；它们是当前模型 + 接口的结论，不是供应商宣传。未知视频能力不触发录制或 chat 试错。
- **System Prompt v18**：根据完成目标缺少的证据自主选择文本、单帧、音频、短视频；例如动作先后、动画故障、动态状态或视听配合需要时序证据时主动考虑视频。已有资料足够就继续任务，避免看到视频就一律录制。
- **Tool Schema 与宿主**：九工具不变。`action op=record` 提供真实短录制通道，音视频通过已有媒体路由交给当前模型。它不需要 rev，但需要可见标签、租约和独立的视频授权。沿用音频授权键不会放行视频；关闭标签时两种授权都清除。

录制优先 WebM VP8/Opus，约束上限 720p / 12 fps、目标视频码率 1.2 Mbps；累计约 12 MiB 提前停止并标记截断。文件有 16 MiB 原生递交上限。取消、标签关闭、回合结束释放轨道；申请媒体流尚未完成时也登记取消，返回后立即释放。录制整张标签合成画面，不承诺只截视频元素或可读取受保护内容。

Skill 留给长视频分段分析、证据时间线等复杂方法。新增基础 Tool 会重复 acquire/action 的职责；只有 Prompt 而没有可调用入口，则会让 Agent 想到了也做不到。这次实现把选择依据和实际通道同时补齐。

手测建议：用视频输入可用的 chat 模型，给“找出这段流程为何卡住”或“判断动画在哪一步异常”等目标，不提录屏/视频工具；检查 Agent 能按信息缺口选择 record，授权条明确显示画面与声音，下一跳为 `video_url`。对照静态页面应能直接 snapshot；切换 DeepSeek 后 record 应在采集前返回 `VIDEO_INPUT_UNAVAILABLE`。浏览器手测由用户执行。
