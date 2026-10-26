---
"@kindgi/adapter-model-gemini": patch
---

**A Gemini provider can set how much each model thinks: `thinkingLevels`.** Gemini 3.8 Flash thinks on every call, `low` at the least, and the thinking bills as output and counts against `maxOutputTokens`.
- **On a registration** it's `adapter_config.thinkingLevels`, `"model=level,…"` (`"gemini-3.8-flash=low"`); in code, `GeminiProviderOptions.thinkingLevels`, by model name. The levels are Gemini's four: `minimal`, `low`, `medium` and `high`, sent as `thinkingConfig.thinkingLevel` on every call to that model. A model it doesn't name thinks as Google sets by default.
- **A call's `thinking: 'lowest'`** (judges set it) still sends the model's `thinking.lowest`.
- **Checked when the provider registers,** or is made in code, with the path `/adapter_config/thinkingLevels`: an entry that isn't `model=level`, a model named twice or not in `metadata.models`, a model with no `thinking`, a level that isn't one of the four, a model whose `thinking.lowest` isn't one of them, and a level under that model's `lowest` (Gemini 3.8 Flash takes `low` at the least; Vertex AI refuses `minimal` on it).
- **It takes effect from this adapter on.** An older one ignores the key, as the adapter ignores any `adapter_config` key it doesn't know. Keys are case-sensitive.
- **New type:** `GeminiThinkingLevel`.
