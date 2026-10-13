---
"@kindgi/adapter-model-gemini": patch
---

**Gemini pins its request host, so a server-environment variable can't redirect a tenant's calls.** The adapter now gives `@google/genai` an explicit `httpOptions.baseUrl` on both paths — the Developer API and Vertex AI.
- Left unset, the SDK's `getBaseUrl` falls back to `GOOGLE_GEMINI_BASE_URL` (Developer API) or `GOOGLE_VERTEX_BASE_URL` (Vertex) from the process environment, so one operator-set variable would send every tenant's Gemini calls — with the tenant's API key, or the server's Google credentials — to that host.
- The Developer API path targets `https://generativelanguage.googleapis.com/`; the Vertex path targets the SDK's own host for the location (`global` and the multi-regional `us`/`eu` each have a dedicated host, every other location a regional one). Behaviour is unchanged when neither variable is set.
