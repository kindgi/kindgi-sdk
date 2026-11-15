---
"@kindgi/connections": minor
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/cli": minor
---

**An MCP server can sign in as a connection, and HubSpot and Asana are app entries.** A person, or the company, connects once to an app whose entry lists its MCP servers, and an endpoint registered for that server sends each call with a token minted for it from that connection.

- **`@kindgi/connections`: an entry lists its MCP servers.** `defineApp` takes `mcpServers`, each `{ origin, resource, issuer }` (`AppMcpServer`): the https origin a token may go to, the resource it's minted for (RFC 8707) and the authorization server that issues it. An entry that lists servers signs in with `oauth2`, and lists each origin once.
- **Two sign-in choices for such servers.** `signIn.scopesFrom: 'registration'` asks for no scope: a connection holds all of the entry's permissions, and each permission grants itself. `account: { kind: 'none' }` reads no account: the account is the owner (the person's user id, or `company`), so an owner has one connection per app and env, and connecting again renews it. Both need an `oauth2` sign-in.
- **The `hubspot` and `asana` entries** (`@kindgi/connections/hubspot`, `@kindgi/connections/asana`) sign in to HubSpot's and Asana's own MCP servers with PKCE, for a person or the company, with one permission, `mcp.tools`. They bring no tools of their own: the tools are the servers'.
- **`@kindgi/api`: an MCP endpoint signs in as a connection.** Its `auth` takes `{ scheme: 'connection', app, as: 'person' | 'company', permissions? }` (`MCPConnectionAuth`): each call uses the connection of the person the run acts for, or the company's. `permissions` names the entry's permissions the tools need, 1 to 64 (`MCP_CONNECTION_PERMISSIONS_MAX`); absent, all of them. `catalogConnectionId` names the connection the endpoint lists its tools with: the registrant's own, or the company's. It's required with a `connection` auth and refused without one.
- **`POST /v1/mcp/endpoints` checks a `connection` auth** against the entries and connections the app serves, and answers `400 invalid-mcp-endpoint` with its reason: `unknown-app`, `origin-not-listed`, `owner-not-allowed`, `unknown-permission`, `catalog-connection-required`, `invalid-catalog-connection-id`, `catalog-connection-without-connection-auth`, `catalog-connection-not-found` or `catalog-connection-not-yours`. The endpoint binding gets the entry's server as `mcpServer`, reads the server's protected resource metadata, and refuses one whose authorization servers don't name the entry's issuer: the outcome `resource-metadata-refused`, reason `resource-metadata-unreadable`, `issuer-mismatch` or `resource-mismatch` (`MCP_RESOURCE_METADATA_REFUSALS`), answered as `400 invalid-mcp-endpoint`.
- **`@kindgi/client`** gains `McpConnectionAuth` and `catalogConnectionId`. The Python and JVM clients carry the new models.
- **`@kindgi/cli`: `kindgi mcp add hubspot` and `kindgi mcp add asana`.** A connection preset (`"auth": "connection"`, with its `app`, `name` and `url`) registers the vendor's server at the runtime, with `--as=person` (the default: each person's own connection) or `--as=company`, and lists its tools with your own connection or the company's. It writes nothing to `.mcp.json`. `--env` picks the connection's env when there is more than one, `--server-name` names the endpoint, and `--force` replaces one registered under that id. `--as` on a preset the launcher runs, and `--secret` or `--path` on a connection preset, are refused. `kindgi mcp presets` lists both kinds.
- **An older runtime** refuses a `connection` auth as `invalid-auth`, and `catalogConnectionId` as `unknown-field`, and registers nothing.

Release-decision: a minor, in 0.8.0, the maintainers, 2026-11-15
