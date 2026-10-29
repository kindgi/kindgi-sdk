---
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-openai-compat": patch
---

**Each call of a model's reply has an id of its own.** The agent loop records what it decided for a call (its guardrails' verdicts, its approval, that it ran) by the call's id. When Gemini gives a call a null id, an empty one or one an earlier call of the reply has, the Gemini adapter makes one, as it did for a call with no id. When a compatible server sends a Chat Completions call with no id, an empty one or a repeated one, the OpenAI-compatible adapter does the same. The id made goes back with the call and with its result, so the two still match. Ids a reply gives that are its own are kept.
