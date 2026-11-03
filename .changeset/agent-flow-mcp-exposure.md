---
"@kindgi/types": patch
"@kindgi/flow": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/sdk": patch
---

**An agent or a flow can be a tool in a person's chat app.** A new optional field, **`mcp`** (`{ expose, readOnly?, destructive? }`), on agents and flows says whether one is offered as a tool, through the API's MCP server, to the people who can see it. An agent's tool is named by its id, a flow's by `flow.` and its id. With `expose: true`, the id must be a tool's name (letters, digits, `_`, `-` and `.`, at most 128 characters, or 123 for a flow), and an agent's can't start with `kindgi.` or `flow.`, the prefixes Kindgi keeps; the error names the prefix. `readOnly` and `destructive` become the tool's `readOnlyHint` and `destructiveHint`; left out, no hint is sent and the chat app applies the protocol's defaults. Absent, nothing changes: an agent or flow without it is stored and answered as before, with no `mcp` key.

It is in `agent.schema.json` (1.8.0), `flow.schema.json` (1.10.0) and `pack-index.schema.json` (1.9.0); `Agent`, `defineAgent` (which refuses an invalid one), `Flow` and `loadFlow` (a new error, `invalid-mcp-exposure`); `McpExposure` and `mcpExposureIssues` in `@kindgi/types`; the indexed pack agent and flow; `POST /v1/agents`, `POST /v1/flows`, their `GET` answers and a deployment's agents and flows (the API's new `McpExposure` schema); and the Python SDK's `Agent(mcp=...)` and `Flow(mcp=...)`. The authoring skills for agents and flows (TypeScript, Python, Java and Scala) say how to set it.
