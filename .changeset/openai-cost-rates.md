---
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/cli": patch
---

The OpenAI-compatible adapter prices a call the way OpenAI bills it, so a run's cost and its cost budget are right on GPT-6. Before, every prompt token billed at the base input rate: cached prompts were overcharged 10–20 times, and a prompt past 272,000 tokens was undercharged (OpenAI bills those at twice the input and 1.5 times the output rate).
- **A model's cost table** takes the rates the Gemini and Anthropic adapters already price with: `cachedPromptMultiplier`, `promptCacheCreationMultiplier`, `longContext` (the whole call at its rates past `thresholdTokens`), and `dataResidencyMultiplier` (applied only on a data-residency host such as `eu.api.openai.com`). Both APIs (Responses and Chat Completions) price with them.
- **The `openai` preset** carries OpenAI's published GPT-6 rates (checked 2026-10-07): cached input at 10% of input (5% on GPT-6.1 Sol), cache writes at 1.25 times, twice the input and 1.5 times the output past 272,000 input tokens, and +10% on a data-residency host. A registration from an earlier preset keeps its base rates: re-register (`kindgi providers register --preset=openai`) to price this way.
