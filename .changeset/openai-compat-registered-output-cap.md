---
"@kindgi/adapter-model-openai-compat": patch
---

**OpenAI-compatible providers send a model's registered `maxOutputTokens` when the call sets none.** A call's own cap, its agent's `maxOutputTokens`, still replaces it. Before, this adapter sent a cap only when the call set one. So a cap registered on a model, for example to bound its cost, didn't apply on OpenAI, OpenRouter, Groq or a self-hosted OpenAI-compatible server, and the vendor's default applied instead. Chat Completions sends it as `max_tokens` and Responses as `max_output_tokens`. The `openai`, `groq` and `openrouter` presets register their models with a default cap, so calls through them now send it. The Anthropic, Gemini, Azure OpenAI and Bedrock adapters already worked this way.
