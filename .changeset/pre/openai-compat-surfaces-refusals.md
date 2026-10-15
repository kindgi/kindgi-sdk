---
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-shared": patch
---

**The OpenAI-compatible adapter surfaces a refused connection instead of retrying it.** The adapter now owns the retry policy on every call path — chat, responses and embeddings — with the OpenAI SDK's own retries off (`maxRetries: 0`).

- A connection the runtime refuses the same way every time — an egress or body-size guard, or a redirect the request won't follow — is tried once, and its own words reach the caller rather than the SDK's generic "Connection error."
- A transient failure (408, 409, 429, 5xx, or a dropped connection) is still retried, honouring the vendor's `retry-after` and the vendor's `x-should-retry` override; a caller's `clientOptions.maxRetries` keeps its meaning, the retries after the first attempt (the SDK default is 2, so 3 attempts in all).
- A failed call now throws the shared `ModelProviderError` (its `kind` and `status`, the OpenAI SDK's error as `cause`) on every path, as the other adapters do, and an aborted call rejects with the turn's reason — where a failed OpenAI-compatible call used to reject with the `openai` SDK's own `APIError`, and an abort with `APIUserAbortError`. Code that caught `OpenAI.APIError` on this path should catch `ModelProviderError`.
- `@kindgi/adapter-model-shared` now exports `refusedConnection` and `isTransport`, the one classifier it and the OpenAI-compatible adapter share.
