---
"@kindgi/cli": patch
"@kindgi/sdk": patch
"@kindgi/adapter-model-gemini": patch
---

The `gemini` and `gemini-api` provider presets price a cached prompt token at a tenth of the input price, as Google bills it on Vertex AI and the Gemini API, past `gemini-3.1-pro-preview`'s 200K-token threshold too. Before, they set no `cachedPromptMultiplier`, so a turn's `totalCostUsd` priced cached tokens at the Gemini adapter's default of a quarter, 2.5 times too high. The Gemini adapter's README example and the providers skill's Vertex AI example set it too. A provider already registered from either preset keeps the prices it was registered with: to take the new ones, unregister it, then register the preset. For one a pack's config declares, restart `kindgi dev`, which registers it again because the preset changed. Both presets' `pricesCheckedAt` is 2026-11-07.
