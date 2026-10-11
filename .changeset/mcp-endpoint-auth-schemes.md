---
"@kindgi/api": patch
"@kindgi/client": patch
---

**An MCP endpoint can sign in with a user name and password, or with OAuth client credentials.** A new optional `auth` on the endpoint, beside `secretRef` (which stays the plain bearer form):
- **`basic`:** a `username` and a password secret (`secretRef`), sent as `Authorization: Basic`. For a WordPress site's MCP Adapter with an Application Password, for one.
- **`oauth2-client-credentials`:** a `tokenUrl`, a `clientId`, the client secret (`secretRef`), and optionally `scope`, `audience` and `clientAuth` (`client_secret_basic`, the default, or `client_secret_post`). The runtime fetches the access token and refreshes it before it expires. For a Drupal site's MCP Server with Simple OAuth, for one.
- **Secrets stay by reference:** registration stores and answers the reference only.
- **Refused at registration (`invalid-mcp-endpoint`):**
  - `auth` with `secretRef` (`auth-with-secret-ref`);
  - `auth` on a `stdio` endpoint (`auth-on-stdio`);
  - `auth` beside an `Authorization` header in `config.headers` (`auth-with-authorization-header`);
  - a token URL that isn't https, or http to a loopback host (`invalid-token-url`).
- **Model provider keys:** a key the tenant's providers use is refused as an `auth` secret too, and registering a provider whose key an endpoint's `auth` names answers `409 provider-key-in-use`.
- **New exports:** `MCPEndpointAuth` and its two scheme types, and `mcpEndpointSecretNames()`, which lists the secrets an endpoint names.
- **Clients:** the TypeScript and Python clients carry the new types.
