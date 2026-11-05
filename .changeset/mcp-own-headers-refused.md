---
"@kindgi/api": patch
"@kindgi/client": patch
---

**An MCP endpoint never sets MCP's own headers.** `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and any `Mcp-Param-…` header, whatever its case, are set by the MCP client itself on every request, the `Mcp-Param-` ones from a tool's arguments, and a server checks them against the request.

- **In `config.headers`,** a registration that names one is refused: `400 invalid-mcp-endpoint`, reason `transport-header-in-config`, naming the header. Nothing is registered.
- **In `auth.headers`,** `Mcp-Method`, `Mcp-Name` and any `Mcp-Param-…` join the headers the transport sets itself (`Mcp-Session-Id`, `Mcp-Protocol-Version`, `Host`, `traceparent`, …): `400 invalid-mcp-endpoint`, reason `invalid-auth`, in the same words.
- The `MCPEndpoint` schema, the `@kindgi/client` types and the MCP servers guide say so.
