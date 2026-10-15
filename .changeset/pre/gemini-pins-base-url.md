---
"@kindgi/adapter-model-gemini": patch
---

**The Gemini adapter takes its base URL only from explicit configuration.** The adapter now gives `@google/genai` an explicit `httpOptions.baseUrl` on both paths — the Developer API and Vertex AI — so the `GOOGLE_GEMINI_BASE_URL` and `GOOGLE_VERTEX_BASE_URL` environment variables no longer redirect its calls.
- Left unset, the SDK's `getBaseUrl` falls back to those variables from the process environment; pinning the host keeps a provider's calls going where its configuration names.
- The Developer API path targets `https://generativelanguage.googleapis.com/`; the Vertex path targets the SDK's own host for the location (`global` and the multi-regional `us`/`eu` each have a dedicated host, every other location a regional one). Behaviour is unchanged when neither variable is set.
