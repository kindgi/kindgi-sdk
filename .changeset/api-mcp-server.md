---
"@kindgi/api": patch
"@kindgi/env-schema": patch
---

**The API can serve Kindgi to people's chat apps as an MCP server.** `createApp`'s new optional `mcpServer` mounts `/mcp`, outside the `/v1` chain, for a chat app signed in as a person with OAuth. It's the other way round from `mcpEndpointRegistry`, which lists the servers Kindgi's agents call.

- **Its own token check.** `mcpServer.resolveToken` checks the chat app's token. A request without a valid one gets a 401 whose `WWW-Authenticate` names `resourceMetadataUrl`, where the chat app learns how to sign in. A token for anyone but a person (a service account, the deployment's operator), or one limited to a project, a reviewer role or an inactivity timeout, gets a 403: the tool calls carry only the person and their scopes, so they couldn't keep that limit. A chat token opens no `/v1` route, and `/mcp` reads no cookie. Every answer is `Cache-Control: no-store`.
- **Each tool call is a `/v1` request as the person.** The request runs in the same process, and only to the routes its tool set declared. The person's own grants decide what it may do, narrowed to what the token's scopes allow, so every route's own checks apply.
- **The scopes.** `MCP_SCOPES` (exported, with `McpScope`) lists them: `kindgi:read`, `kindgi:run` and `kindgi:schedule`. None of them allows `write`, `publish`, `admin` or `delete`, so from a chat app even an editor acts only on their own runs and schedules.
- **Absent:** `/mcp` isn't mounted and answers 404, so nothing changes.

`@kindgi/env-schema` gains `KINDGI_MCP_SERVER`: `on` serves Kindgi to people's chat apps at `/mcp`. The runtime needs sign-in and `KINDGI_PUBLIC_URL` with no path for it; it's off by default.
