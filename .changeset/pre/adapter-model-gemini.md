---
"@kindgi/adapter-model-gemini": minor
"@kindgi/capabilities": minor
"@kindgi/api": minor
"@kindgi/client": patch
"@kindgi/sdk": patch
---

Gemini on Vertex AI, and providers that carry their connection settings.

- `@kindgi/adapter-model-gemini` (new): a Gemini `ModelProvider` on Vertex AI, through `@google/genai`.
  - **Credentials:** Google Application Default Credentials (a `gcloud` login on a laptop, the attached service account on Cloud Run), or a service-account key.
  - **Function calling:** tool ids go over the wire unchanged; each call's thought signature is kept and sent back on the next request.
  - **Tokens:** thinking parts are left out of the text, and thinking tokens count as completion.
  - **Cost:** cached-prompt and long-context rates.
  - **For servers:** `geminiAdapterFactory` reads `adapter_config.project`, and uses `metadata.region` as the location.
- `@kindgi/capabilities`:
  - `AdapterFactoryInput.config` (`AdapterConfig`): an adapter's flat, non-secret connection settings.
  - `ModelToolCall.signature`: an opaque token a provider attaches to a tool call and needs back when the conversation continues.
- `@kindgi/api`:
  - `POST /v1/providers` takes `adapter_config`. The binding receives it as `adapterConfig` and returns it from `resolveForRuntime`; `list` and `get` never return it.
  - The OpenAPI `RegisterProviderBody` now describes the actual body, `{ metadata, adapter_id, secret_ref?, adapter_config? }`; it used to describe `ProviderMetadata`.
  - `ProviderCost` allows adapter-specific rate fields.
- `@kindgi/client`: the generated `RegisterProviderBody` follows.
- `@kindgi/sdk`: the providers skill covers Gemini on Vertex, and `adapter_config`. It also notes that the OpenAI-compat adapter isn't registered by the runtime yet.
