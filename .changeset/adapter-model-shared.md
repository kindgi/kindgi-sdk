---
"@kindgi/adapter-model-shared": patch
---

New package: shared plumbing for Kindgi's model adapters. The Azure OpenAI and Amazon Bedrock adapters (0.1.6) build on it.
- **In Kindgi's terms:** typed errors (`ModelProviderError`, with a `kind` and the HTTP `status`), the retry policy (counted attempts, `retry-after`, an abort-aware backoff), and `tokenCostUsd`, the token cost formula our OpenAI-compatible and Anthropic adapters use, in one place.
- **Behind `@kindgi/adapter-model-shared/ai-sdk`,** today's engine, the AI SDK's provider packages called at the spec level (never the `ai` package or Vercel's gateway). `createAiSdkModelProvider` turns a provider's model into a `ModelProvider`. It carries the reasoning state across a pause in the first tool call's `signature`, puts usage onto Kindgi's counters, drops refused sampling with a warning, and sends `traceparent` only when set.
