---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**An MCP endpoint's credential header goes by reference, never in plaintext `config.headers`.**
- **New `auth` scheme, `header`:** headers of the server's own, each with a secret, sent as `<name>: <prefix><secret>`. For example, an API key in `X-Api-Key`, a key and a secret in two headers, or `Authorization: Token …`:
  ```json
  "auth": { "scheme": "header", "headers": [{ "name": "X-Api-Key", "secretRef": { "envName": "production", "name": "INVENTORY_KEY" } }] }
  ```
  It takes 1 to 4 headers, each name once (case-insensitive), and `prefix` is optional. A header the MCP transport or HTTP sets itself (`Host`, `Content-Type`, `Accept`, `Mcp-Session-Id`, `traceparent`, …) is refused (`invalid-auth`). A name `config.headers` sets too is refused as well (`auth-header-in-config`). Each secret counts for the provider-key guard and for `usersOfSecret`.
- **A credential in `config.headers` is refused at registration** (`invalid-mcp-endpoint`, reason `credential-in-headers`). The message names the header, never its value, and shows the `auth` that replaces it.
  - **Which names count:** `Authorization`, `Proxy-Authorization`, `Cookie`, and any name with a `-`/`_`-separated part `token`, `secret`, `password`, `passwd`, `apikey`, `credential`, `credentials`, `signature`, `session` or `auth`, or the parts `api-key`, `access-key`, `private-key`, `auth-key` or `subscription-key`.
  - **Exported:** the rule is `isCredentialHeaderName()`.
- **Endpoints registered before keep working.** `GET /v1/mcp/endpoints[/:id]` answers such a header's value as `"[redacted]"`, its name kept.
- **`kindgi doctor` names them:** a new check, MCP endpoint headers, lists each endpoint on the runtime the CLI points at that keeps one, with the fix. It's a warning: the endpoint still works.
- **New exports:**
  - `@kindgi/api`: `MCPHeaderAuth`, `MCPAuthHeader`, `MCP_AUTH_HEADERS_MAX`, `mcpAuthSecretRefs()`, `isCredentialHeaderName()` and `REDACTED_HEADER_VALUE`;
  - `@kindgi/client`: `McpHeaderAuth` and `McpAuthHeader`. The Python client carries the new models.
