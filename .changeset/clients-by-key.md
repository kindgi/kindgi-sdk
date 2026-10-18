---
"@kindgi/capabilities": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-openai-compat": patch
---

**A model provider keeps a client per key.** The Anthropic, Gemini and OpenAI-compatible adapters (models and embeddings) kept one SDK client, built again whenever the key changed. Calls whose keys take turns, such as runs in two projects each with a key of its own, built a client on every call, and on Vertex AI a new auth client, which fetched a new token on its next call. Connections live in the `fetch` every client sends with, so they were kept either way. Each provider now keeps up to 16 clients, one per key, held by a SHA-256 of the key, the least recently used dropped first. A rotated key still takes effect on the next call. The cache is `createClientsByKey` from `@kindgi/capabilities/clients-by-key`, for an adapter of your own.
