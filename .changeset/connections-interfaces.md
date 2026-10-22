---
"@kindgi/connections": patch
"@kindgi/tools": patch
"@kindgi/specs": patch
"@kindgi/agents": patch
"@kindgi/api": patch
---

**Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
- **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
- **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too), so the runtime renews the token once and runs the call again. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
- **`@kindgi/specs`:** `tool.schema.json` has `needsSpec.connections` and the `connection` authorization.
- **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
- **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use.
