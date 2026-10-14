---
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-shared": patch
---

**The OpenAI-compatible adapter surfaces a refused connection instead of retrying it.** The adapter now owns the retry policy on every call path — chat, responses and embeddings — with the OpenAI SDK's own retries off (`maxRetries: 0`).

- A connection the runtime refuses the same way every time — an egress or body-size guard, or a redirect the request won't follow — is tried once, and its own words reach the caller rather than the SDK's generic "Connection error."
- A transient failure (408, 409, 429, 5xx, or a dropped connection) is still retried, honouring the vendor's `retry-after`; a caller's `clientOptions.maxRetries` keeps its meaning as the attempts in all.
- `@kindgi/adapter-model-shared` now exports `refusedConnection` and `isTransport`, the one classifier it and the OpenAI-compatible adapter share.
