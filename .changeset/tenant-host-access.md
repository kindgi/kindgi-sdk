---
"@kindgi/api": minor
"@kindgi/env-schema": minor
"@kindgi/client": minor
---

What a tenant registers can no longer reach the server's own host unless the deployment allows it, and MCP endpoints authenticate through the secrets store.

- **`KINDGI_TENANT_HOST_ACCESS`** (`@kindgi/env-schema`): `deployed` refuses a `stdio` MCP endpoint, a command the server would run in its container as its user. `local` allows it, for a machine where every token holder may run commands. Unset, it's `local` under `KINDGI_DEV` and `deployed` otherwise.
- **`@kindgi/api`:**
  - `createApp` takes `tenantHostAccess` (default `deployed`). Under `deployed`, registering a `stdio` endpoint answers `403 host-access-denied`, a new error code.
  - `deniesHostReach`, `parseTenantHostAccess`, `TENANT_HOST_ACCESS_LEVELS` and `stdioRefusal` are exported for the runtime's connect-time check. Checks ask `deniesHostReach(level, reach)`, so a stricter level is one more row.
  - `mcpRouter` takes the level as a fourth argument.
- **`MCPEndpoint.secretRef: { envName, name }` replaces `authRef`.** It's a secret by name in the deployment's store, resolved at the endpoint's tenant scope, the shape webhooks and providers use.
  - `env:NAME` references, which read the server's own environment, are gone.
  - The register body now refuses unknown fields, so an `authRef` is a `400` (`unknown-field`), not silently dropped.
  - The webhook routes and MCP share one `secretRef` parser.
- **`@kindgi/client`:** `McpEndpoint` and `RegisterMcpEndpointInput` take `secretRef` (`McpEndpointSecretRef`). The Python `kindgi.client` is regenerated: `secret_ref` replaces `auth_ref`.
