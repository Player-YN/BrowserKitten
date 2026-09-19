# 当前推理模型的音视频输入

需要现场时序画面时使用 `action op=record`（默认 8 秒，最多 30 秒，tab 画面 + 声音）；现场声音仍是 `action op=listen`（只录 tab 音频，授权和回放不变）。公开可下载音视频用 `acquire action=fetch url=…`；已经下载的媒体用 `acquire action=fetch path=…`。登录态文件先用 `run` 中的 `sys.fetch({as:'page', …, saveTo:'/scratch/…'})` 保存，再 fetch path。没有增加工具，也不会改用生图供应商理解媒体。

每次发送固定当前 chat 连接设置；每一跳 `prepareStep` 从缓存更新能力快照，模型提示、工具路由与 provider 请求转换共用该快照。在途请求不被后台结果修改。发送与新建 session 不发校验请求，也不等待后台检查。

能力按 text / image / audio / video 分别记录 supported / unsupported / unknown，以及证据来源。优先级为用户覆盖 > 已验证格式 > 目录声明 > 已确认官方端点上的内置规则 > unknown。近期明确的媒体格式拒绝阻止对应 MIME，不否定整个模态。用户覆盖优先于自动证据。只匹配完整 ID；未知网关不按模型名字继承官方能力。目录字段归一化见 [MODEL_CATALOG_MODALITIES.md](MODEL_CATALOG_MODALITIES.md)，输出模态和生图标记不会提升输入能力。

设置 → 推理 API 展示「已声明可用 / 已验证 / 历史验证 / 检查中 / 未确定 / 当前格式不可用」，可重新检查或关闭自动校验。高级设置保留按 Base URL + 模型的覆盖及协议选择。未保存的草稿不显示其他连接的结果。自建网关协议未知时不会自动发送样本；可按网关文档选现有兼容协议。音视频未知走 STT，没有 STT 则返回 `NEED_STT` 并保留原文件；图片仍保留既有未知可尝试策略，独立校验则必须有已确认的协议配置。

原生输入要求「模型支持」和「接口可传输」同时成立：

| 接口 | 音频 | 视频 |
| --- | --- | --- |
| OpenAI Chat / Gemini OpenAI 兼容端点 | `input_audio`，WAV / MP3 | 本实现没有已确认的兼容视频传输，降级 STT |
| OpenRouter Chat | `input_audio`，WAV / MP3 | `video_url` + 内联 data URL，MP4 / MPEG / MOV / WebM |
| 自建网关 | 用户显式选择上述协议，同时声明精确模型的能力 | 同左 |

普通 `gpt-4o` 不因名字而当作音频模型；音频专用 ID 与普通 ID 分开。已知 Gemini 音视频能力也不会自动证明某个未知网关支持这些 wire parts。内置 Gemini 默认仅覆盖代码中列出的版本，新型号可以通过目录或显式配置声明。

WebM/Opus 听音在 offscreen 用 Web Audio 解码、混成单声道 PCM WAV，然后进入原生输入；绝不只改 MIME 冒充 WAV。需要转换的音频限制 120 秒，单份原生媒体限制 16 MiB；转换失败或超限保留文件并尝试 STT。视频降级仅代表语音，不声称已经看到画面。`acquire action=transcribe` 仍明确调用独立的 STT API。

工具回执把路径、来源和路由留在 JSON，字节只放 `modelParts`。`toModelOutput` 传入 SDK 后，provider 将媒体从 tool JSON 提升为紧随完整 tool-result 批次的 user 媒体 parts；原有 JPEG `image_url` 路径保留。发送前再次核对 body.model，不匹配或不允许的音视频会被移除，绝不把 base64 留作普通文本。模型收到 STT 文本和 `NEED_STT` 的 action 输出也已修复。

实现依据：[OpenRouter 音频协议](https://openrouter.ai/docs/guides/overview/multimodal/audio)、[OpenRouter 视频协议](https://openrouter.ai/docs/guides/overview/multimodal/videos)、[Gemini OpenAI 兼容音频示例](https://ai.google.dev/gemini-api/docs/openai#audio-understanding)。模型能力、端点支持和文件编码分别判断。实际请求若明确拒绝一种媒体格式，会记录该 MIME 的拒绝证据，不自动重放业务请求。大小、鉴权、限流、网络错误不会误判成整个模态不支持。

## 后台校验与缓存

- offscreen 的 `MediaCapabilityChecks` 是唯一调度器。保存/切换推理配置、模型目录缓存更新、offscreen 启动、打开设置及手动重验触发识别；普通发送只读缓存。SW 监听设置变更，侧栏使用 `getChatMediaStatus`（可重试读取）与 `requestChatMediaCheck`（不可自动重投）RPC。
- 目录/内置规则足以判定时不自动检查该模态；已知协议但能力未知时，依次检查 JPEG、PCM WAV、WebM。手动重验可覆盖已声明能力，用户显式覆盖的模态仍不检查。全局单请求在途，相同配置去重，配置或覆盖改变取消旧任务。
- 每项最多 20 秒（含样本生成）、1,024 输出 token、一次 chat 请求。直接调用打包 SDK 的单次 `doGenerate`，不经 Agent 循环，无 SDK 重试/网络失败代理重发。只发送宿主合成样本，不使用用户页面或文件。
- JPEG 包含随机字符，WAV 包含高低音序列，WebM 包含随机字母顺序和独立音轨。宿主核对 JSON 答案；答案不放入提示/文件名/元数据。视频画面和音轨分别评分。HTTP 200 但答错仍为未确定；这也不证明网关内部采用原生处理。
- `pagewand_chat_media_evidence_v1` 存储最多 100 份连接证据，连接身份由配置 ID、规范化端点、精确模型、凭证、协议、路由选项与校验版本的 SHA-256 摘要表示，不新增明文 Key 副本，不存上游错误正文。`pagewand_chat_media_auto_check` 默认 true。
- 成功结果 30 天有效，过期保留历史证据并在下一次识别触发时后台刷新；未确定冷却 24 小时，明确拒绝冷却 7 天。派发前先记录尝试，offscreen 重启不会马上重复收费。鉴权/限流/网络错误停止本批并为未检查项设置冷却。手动重验绕过冷却。
- 已验证只启用测试过的 MIME，未知格式不从样本外推。近期格式拒绝不会抹掉其他已验证格式；临时错误保留先前肯定证据。视频音轨未知时提示 Agent 使用独立音频或 STT。
- 工具遇到未知能力且相应检查正在执行时，最多等待 2 秒，然后使用最新结果或现有降级；工具从不启动新检查。没有周期计时唤醒和后台重试风暴。

回归：`node --test tests/chat-media.test.mjs` 覆盖缓存、精确匹配、设置作用域、切模快照、listen/fetch 原生与降级、大小/转换失败，以及真实打包 AI SDK 的请求序列化（使用本地 fetch stub，不调用供应商）。全量命令仍是 `node --test tests/*.test.mjs`。真实 Chrome 录音与解码需要另行烟测。

## Agent 如何自主想到视频

基础能力由四层配合，不依赖用户说“看视频”，也不依赖按需 Skill 才能发现：

- **感知事实**：snapshot 的 `mediaElements`（最多 6 项）列出可见性、播放状态、时间、HTTP 源候选 / blob 或 srcObject 流，并附 frame/document。HTTP 候选不代表可匿名下载。动态 canvas/界面即使没有 video 标签也可以录制。
- **当前能力**：每跳 instructions 注入 `routes.nativeVideo/nativeAudio` 和确切入口。后台完成校验后，正在运行的 Agent 在下一跳即可得知新入口；未知视频能力不触发录制，工具不自行发送校验请求。
- **System Prompt v18**：根据完成目标缺少的证据自主选择文本、单帧、音频、短视频；例如动作先后、动画故障、动态状态或视听配合需要时序证据时主动考虑视频。已有资料足够就继续任务，避免看到视频就一律录制。
- **Tool Schema 与宿主**：九工具不变。`action op=record` 提供真实短录制通道，音视频通过已有媒体路由交给当前模型。它不需要 rev，但需要可见标签、租约和独立的视频授权。沿用音频授权键不会放行视频；关闭标签时两种授权都清除。

录制优先 WebM VP8/Opus，约束上限 720p / 12 fps、目标视频码率 1.2 Mbps；累计约 12 MiB 提前停止并标记截断。文件有 16 MiB 原生递交上限。取消、标签关闭、回合结束释放轨道；申请媒体流尚未完成时也登记取消，返回后立即释放。录制整张标签合成画面，不承诺只截视频元素或可读取受保护内容。

Skill 留给长视频分段分析、证据时间线等复杂方法。新增基础 Tool 会重复 acquire/action 的职责；只有 Prompt 而没有可调用入口，则会让 Agent 想到了也做不到。这次实现把选择依据和实际通道同时补齐。

手测建议：用视频输入可用的 chat 模型，给“找出这段流程为何卡住”或“判断动画在哪一步异常”等目标，不提录屏/视频工具；检查 Agent 能按信息缺口选择 record，授权条明确显示画面与声音，下一跳为 `video_url`。对照静态页面应能直接 snapshot；切换 DeepSeek 后 record 应在采集前返回 `VIDEO_INPUT_UNAVAILABLE`。浏览器手测由用户执行。

新增手测：保存配置后立刻发文字消息，应无需等待检查；设置可见检查状态与费用提示。已声明模型不应自动产生样本请求。对已选择兼容协议的未知别名模型点击重验，检查每项最多一次请求、WAV 音序及 WebM 字母/音轨真实生成。关闭设置不应取消校验，关闭自动检查或切换模型应取消旧任务。多个新会话与扩展重载复用证据；自建未知协议显示需要选择协议。检查完成后，正在执行任务的下一跳提示与请求格式应同步更新。请求失败不在任务中生成伪工具记录。
