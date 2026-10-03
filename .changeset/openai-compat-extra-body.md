---
"@kindgi/adapter-model-openai-compat": minor
---

`extraBody`: fields merged into every Chat Completions request, for settings an endpoint takes that the OpenAI format has no field for. A Qwen thinking model on vLLM, SGLang or llama-server needs `{ "chat_template_kwargs": { "enable_thinking": false } }`, or its answer starts with its thinking and a typed answer fails, and a shared server can't always be reconfigured to turn it off. A registered provider gives them as flat `adapter_config` keys, one per field, dots nesting: `"extraBody.chat_template_kwargs.enable_thinking": false` (`EXTRA_BODY_PREFIX`; `openAICompatExtraBody` expands and checks them). The fields the adapter sets (`EXTRA_BODY_RESERVED`) are refused. The README no longer says the abort signal isn't forwarded (it is).
