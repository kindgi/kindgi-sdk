---
"@kindgi/capabilities": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-in-process": patch
---

A provider registration the runtime couldn't build is refused when it registers, naming the setting. Before, a bad `adapter_config` (an unknown `api`, a missing `baseURL`, a Vertex registration without `project`, …) registered fine, and the provider was skipped at the first model call with the reason only in the runtime's log.
- **`POST /v1/providers`** runs the adapter's own check before storing: `422 provider-config-invalid`, with each problem in `details.issues` (`path`, a JSON pointer such as `/adapter_config/api`, and `message`), the shape other validation errors use; the clients read it as an invalid-request error. Without the runtime's adapter factories (an older runtime), nothing changes.
- **`GET /v1/providers/{providerId}/check`** runs the same check over a registered provider (`{ providerId, adapterId, checked, issues }`); TS `providers.check(id)`, Python `providers.check(provider_id)`.
- **Adapters:** `AdapterFactoryEntry.checkConfig` (static: no network, no secret read): `{ path, message }` problems, the message naming the setting and what it takes; the factory throws the same problems as `adapterConfigError` words them (`<adapter>: provider "<id>": <message>`). The 422's own message is one sentence naming the provider, its adapter and the first problem, with a count of the rest. Each adapter exports its entry: `openAICompatAdapterEntry`, `geminiAdapterEntry`, `anthropicAdapterEntry` (new `anthropicAdapterFactory`: needs `secret_ref`) and `inProcessAdapterEntry` (new `inProcessAdapterFactory`).
