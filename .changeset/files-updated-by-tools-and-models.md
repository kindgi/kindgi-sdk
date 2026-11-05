---
"@kindgi/specs": patch
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/handler-runtime": patch
"@kindgi/api": patch
---

**Tools and agents that change files.** A tool can declare `updatesFiles: true` (tool schema 1.5.0, pack index 1.10.0): it adds versions to files its run has. Only a tool with a handler can, so `defineTool` and the pack indexer refuse it on a declarative or MCP tool, as they refuse `storesFiles`. It's part of the tool's definition, so changing it takes a new version.

An agent can declare `files: { update?, create? }` (agent schema 1.9.0). `update: true` offers its model the built-in `kindgi_update_file`, and `create: true` offers `kindgi_create_file`. An agent can't list either one in `tools`. The pack index and the API's agent schemas carry the declaration, and `@kindgi/agents` exports `UPDATE_FILE_TOOL_ID`, `CREATE_FILE_TOOL_ID` and the `AgentFilesPolicy` type.
