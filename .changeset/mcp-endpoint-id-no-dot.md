---
"@kindgi/api": patch
---

**`POST /v1/mcp/endpoints` refuses an `endpointId` with a `.`: `400 invalid-mcp-endpoint`, reason `dot-in-endpoint-id`, naming the id.** An MCP tool's id is `<endpointId>.<tool name>`, and a tool name may contain `.`. So endpoint `a` with tool `b.c` and endpoint `a.b` with tool `c` both made the tool `a.b.c`, and each sync took it from the other. With no `.` in an endpoint id, a tool id splits at its first `.`.
- A request that registered before is refused now when its id has a `.`: use `-` or `_` instead.
- An endpoint registered before with a `.` keeps its id: it still reads and unregisters as before. Nothing is renamed.
- The OpenAPI register body's `endpointId` has the pattern `^[^.]+$`, and the Python client's register body checks it before sending. The endpoint the API answers with has no pattern, so an id registered before still reads.
