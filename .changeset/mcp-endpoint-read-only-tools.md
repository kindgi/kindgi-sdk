---
"@kindgi/api": patch
"@kindgi/client": patch
---

**An MCP endpoint's registration can name the server's tools that only read.** `readOnlyTools` on `POST /v1/mcp/endpoints` lists them by the names the server's `tools/list` gives them, and reads return it. A runtime then publishes each listed tool with `mutating: false`, and a tool's newest version decides for every version of it, pinned ones included.
- **A listed tool** runs in a dry run, passes an approval gate with no rule for it, runs alongside other read-only calls, and in a replay gets the past run's result or is refused. Every unlisted tool still counts as one that may change things.
- **The server's own `readOnlyHint` isn't read.** The list is the registrant's claim.
- **1 to 256 names, each 1 to 128 characters, no repeats, on any transport.** Any other list is refused with `400 invalid-mcp-endpoint`, reason `invalid-read-only-tools`. `MCP_READ_ONLY_TOOLS_MAX` and `MCP_READ_ONLY_TOOL_NAME_MAX` are exported.
- **The TypeScript and Python clients** take the field on register and return it on reads.
- **It needs runtime 0.7.0 or later.** An older runtime refuses the field as `unknown-field` and registers nothing.
