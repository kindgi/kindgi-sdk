---
"@kindgi/cli": patch
---

The `gemini` and `gemini-api` provider presets price a cached prompt token at a tenth of the input price, as Google bills it on Vertex AI and the Gemini API, past `gemini-3.1-pro-preview`'s 200K-token threshold too. Before, they set no `cachedPromptMultiplier`, so a turn's `totalCostUsd` priced cached tokens at the Gemini adapter's default of a quarter, 2.5 times too high. A provider already registered from either preset keeps its old prices until it's registered again. Both presets' `pricesCheckedAt` is 2026-11-07.
