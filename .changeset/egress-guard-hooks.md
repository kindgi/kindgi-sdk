---
"@kindgi/api": minor
"@kindgi/capabilities": minor
"@kindgi/tools": minor
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/env-schema": patch
---

The hooks the runtime needs to guard the server's connections to hosts a tenant chose (T83). The guard itself is in the runtime.

- **`@kindgi/api`:** `HostReach` gains `'metadata-network'` (link-local addresses, where the cloud metadata endpoints hand out the server's credentials) and `'loopback'` (the server's own host). `KINDGI_TENANT_HOST_ACCESS=deployed` refuses both, as well as `'exec'`.
- **`@kindgi/capabilities`:** `AdapterFactoryInput.fetch` is the fetch for a provider endpoint the registration chose.
- **`@kindgi/adapter-model-openai-compat`:** the factory sends through that fetch.
- **`@kindgi/tools`:**
  - `defineTool(spec, { synthesizer: { fetch } })` and `ToolSpecSynthesizerOptions`: a declarative HTTP tool's handler sends through the runtime's fetch.
  - `validateToolManifest` now refuses an HTTP tool whose `urlTemplate` puts a `{placeholder}` in the scheme, host or port, or isn't `http(s)://` with a host. Placeholders belong in the path and query, where they're URL-encoded; in the authority, a run's input would pick the host.
- **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS`'s description says what `deployed` refuses.
