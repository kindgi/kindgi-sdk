---
"@kindgi/api": patch
"@kindgi/tools": patch
---

A model provider's key is used by its provider only. A secret that a provider registration of the tenant names (its `secret_ref`, in any env) can't be declared or sent by a tool, or named by an MCP or a webhook endpoint:

- **`POST /v1/tools`, `POST /v1/mcp/endpoints`, and `POST` or `PATCH /v1/webhook-endpoints`** refuse it with `400 provider-key-refused`, naming the secret and the provider (`details.secret`, `details.providerId`). The message says what to do: store the key under its own name (the same value is fine) and use that name.
- **`POST /v1/deployments`** reports each tool that names one as a `deployment-validation-failed` issue (`path` `/secrets/<name>`), and deploys nothing.
- **`POST /v1/providers`** refuses a `secret_ref` that a tool (its current version), an MCP endpoint or a webhook endpoint already uses: `409 provider-key-in-use`, with `details.usedBy` listing each.

For a runtime to enforce the same at every call, `@kindgi/api` exports `guardProviderKeys(binding, keys, user)`: a `SecretBinding` whose `resolve` answers a model provider's key with the new `SecretError` code `provider-key-refused` (naming the secret and the provider), for whatever hands secrets to tools and endpoints, while the provider adapters keep the store itself. Also exported: `providerKeysOf(registry)`, `providerKeyRefusal`, `usersOfSecret`, and their types.

`@kindgi/tools` exports `toolSecretNames(manifest)`: every secret a tool declares or sends, by name.
