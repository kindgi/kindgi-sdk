---
"@kindgi/adapter-model-anthropic": minor
"@kindgi/adapter-model-gemini": minor
---

**A failed call is the shared typed error.** The Anthropic and Gemini adapters throw `ModelProviderError` (`@kindgi/adapter-model-shared`) for a response that refuses a call, as the Bedrock, Azure OpenAI and OpenAI-compatible adapters do. Its `kind` comes from the status and the vendor's words (`invalid-request`, `auth`, `rate-limited`, `unavailable`, `context-too-long` or `content-filter`; `network` for Anthropic's failed connection), with its `status`, and its message is the same as before. The SDK's own error (Anthropic's `APIError`, Gemini's `ApiError`) is now its `cause`: code that checked the thrown error's type checks `cause` instead. An abort, and Gemini's failed connection, are thrown as they were.
