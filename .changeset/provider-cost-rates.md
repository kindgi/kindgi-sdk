---
"@kindgi/api": patch
"@kindgi/adapter-model-anthropic": patch
---

**A provider's cost table keeps its adapter's rates.** The HTTP API kept only a model's two base rates, so a registration lost the rates its adapter prices with: Anthropic's prompt-cache multipliers, Gemini's cached-prompt share, and a `longContext` tier. A long prompt on `gemini-3.1-pro-preview` or `claude-haiku-5-5` was priced at the base rate in `totalCostUsd` and the cost budgets.
- **The API** now keeps those rates: each a non-negative number, or one object of them (otherwise 400, reason `invalid-cost`). It returns them as stored.
- **The anthropic adapter** prices a long prompt as the gemini adapter does: past `longContext.thresholdTokens` (regular, cache-write and cache-read tokens together), the whole call bills at the long rates. `claude-haiku-5-5` is 5× past a 100,000-token prompt.
- **A provider registered earlier** keeps its base-rate-only cost table: re-register it (`kindgi providers register --preset=<name>`) to get long-context pricing.
