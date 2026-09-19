# Model catalog modality declarations

`src/agent/modelCatalog.js` accepts a media-input declaration only when it is
present in a documented, per-model **input** field.  It normalizes the value to
`text`, `image`, `audio`, `video`, or `file` and retains the field source on the
cached `ModelEntry` as `inputModalitiesSource`.

| Catalog | Response field used | Notes |
| --- | --- | --- |
| OpenRouter | `architecture.input_modalities` | The Models API exposes both input and output modality arrays. [API reference](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) |
| OpenAI-compatible extension | `input_modalities` | Supported only when a gateway actually returns this per-model array. OpenAI compatibility alone does not imply it. |
| Alibaba Cloud Model Studio / DashScope | `output.models[].inference_metadata.request_modality` | The native Models API returns models under `output.models`; `request_modality` has `Text`, `Image`, `Audio`, and `Video`. A configured `.../compatible-mode/v1` chat base is automatically redirected only for its catalog request to same-host `/api/v1/models`. [API reference](https://www.alibabacloud.com/help/en/model-studio/list-models) |

The parser intentionally does not infer inputs from `output_modalities`, a
description, a model name, or broad labels such as `vision`, `VU`, or
`Multimodal-Omni`.  Those fields do not establish that the configured chat
endpoint accepts a particular media part.  In particular, they must not turn
audio or video from unknown into supported.

The official DeepSeek `GET /models` response contains `id`, `object`, and
`owned_by`, with no modality declaration, so it remains unknown until another
source of evidence applies. [DeepSeek reference](https://api-docs.deepseek.com/api/list-models/)

This is catalog evidence only.  A supported input declaration still needs a
matching transport adapter, MIME/size limits, and the exact configured model
and endpoint before bytes are sent.  Catalog absence is never a negative
declaration.

## Common Chinese upstreams: current adapter boundary

The table below is intentionally about the **machine-readable model-list
response**, rather than what a provider's model page says it can do.  A product
page or a `type` query filter cannot establish which inputs the selected chat
model accepts.

| Upstream | Current result | Why |
| --- | --- | --- |
| DashScope / Model Studio (Qwen and hosted models) | Adapted | Its native list response supplies the per-model `inference_metadata.request_modality` field documented above. |
| DeepSeek official | Not catalog-adapted | Its documented `GET /models` row has only `id`, `object`, and `owned_by`; an image-capable model shown in separate API/model documentation does not add a per-row declaration. [List API](https://api-docs.deepseek.com/api/list-models/) [Responses image input](https://api-docs.deepseek.com/api/create-response/) |
| SiliconFlow | Not catalog-adapted | `GET /v1/models` accepts `type=text|image|audio|video` as a **list filter**, but its documented returned model row contains only ID, object, creation time, and owner. A filter says how the catalog was queried, not the input modalities of each returned chat model. [List API](https://api-docs.siliconflow.cn/docs/api/models-get) |
| Zhipu / BigModel | Not catalog-adapted | The reviewed public OpenAI-compatible/assistant references document individual calls and media examples, but did not provide a stable per-model list field equivalent to an input-modality array. Keep the value unknown, then use user override or the background check when a compatible transport is selected. |
| Volcengine Ark | Not catalog-adapted | Ark publishes a model-list API, but no documented per-row input-modality field was found in the public reference during this review. Its model catalog must not be inferred from model names or console labels. [Model-list reference](https://www.volcengine.com/docs/82379/1554711) |

Adding another adapter therefore requires all three of: a stable official
response field, proof that it belongs to each model row, and a known chat-media
wire transport.  Otherwise the parser preserves the model ID and leaves its
media inputs unknown; it never turns a model-name, output type, or catalog
filter into a positive media-input claim.
