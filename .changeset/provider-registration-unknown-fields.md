---
"@kindgi/api": patch
---

**A provider registration with a field its metadata or a model doesn't take is refused, naming the field.** `POST /v1/providers` answers `400 invalid-provider` with reason `unknown-model-field` or `unknown-metadata-field`, for example `provider "ollama" model "llama3.1" has "thinkng", which isn't a model field: a model takes name, contextWindow, features, cost, p95LatencyMs, maxOutputTokens, sampling, thinking, description`. Before, such a field was dropped without a word. A misspelled `thinking` registered a model that doesn't think, and each call then dropped the level its agent asked for, with only a `thinking-unsupported` warning. The API's schema already allowed no other fields; now the route checks it. A cost table still takes an adapter's own rates, and stored registrations aren't checked again.
