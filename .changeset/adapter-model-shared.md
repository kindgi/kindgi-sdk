---
"@kindgi/adapter-model-shared": patch
---

New package: shared plumbing for Kindgi's model adapters.
- **In Kindgi's terms:** typed errors (`ModelProviderError`, with a `kind` and the HTTP `status`), the retry policy (counted attempts, `retry-after`, an abort-aware backoff), and `tokenCostUsd`, a token cost formula with the same arithmetic as our OpenAI-compatible and Anthropic adapters' own (their tests hold the three equal on the bundled presets).
- **Behind `@kindgi/adapter-model-shared/ai-sdk`,** today's engine, the AI SDK's provider packages called at the spec level (never the `ai` package or Vercel's gateway). `createAiSdkModelProvider` turns a provider's model into a `ModelProvider`. It carries the reasoning state across a pause in the first tool call's `signature` (back only to the same provider's same model), puts usage onto Kindgi's counters, drops refused sampling with a warning, and sends `traceparent` only when set. This entry point is for Kindgi's own adapters, with no compatibility promise across a change of engine.
