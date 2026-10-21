---
"@kindgi/api": patch
---

Tool and MCP endpoint answers carry `secretScopes`, where each secret the item names is read. The `Tool`, `ToolVersionRow` and `MCPEndpoint` schemas list it, and the server recorded it when the item was registered, but `GET /v1/tools`, `/v1/tools/{toolId}`, `/versions` and `/versions/{version}`, and `GET /v1/mcp/endpoints` and `/v1/mcp/endpoints/{endpointId}`, left it out. It's now in the answer as recorded, a `null` kept, and absent on an item that records none. A register body still never carries it: one that does is refused (`400`). Until now an active tool's or an endpoint's read carried no field a register body refuses; one that records secret scopes now does, so a caller that registers from a read drops `secretScopes` first. The schema and the clients' types don't change.
