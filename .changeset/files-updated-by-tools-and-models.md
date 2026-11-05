---
"@kindgi/types": patch
"@kindgi/specs": patch
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/handler-runtime": patch
"@kindgi/api": patch
"@kindgi/pack-conformance": patch
---

**Tools and agents that change files.** A tool can declare `updatesFiles: true` (tool schema 1.5.0, pack index 1.10.0): it adds versions to files its run has. Only a tool with a handler can, so `defineTool` and the pack indexer refuse it on a declarative or MCP tool, as they refuse `storesFiles`. It's part of the tool's definition, so changing it takes a new version.

An agent can declare `files: { update?, create? }` (agent schema 1.9.0). `update: true` offers its model the built-in `kindgi_update_file`, and `create: true` offers `kindgi_create_file`. An agent can't list either one in `tools`. The pack index and the API's agent schemas carry the declaration, and `@kindgi/agents` exports `UPDATE_FILE_TOOL_ID`, `CREATE_FILE_TOOL_ID` and the `AgentFilesPolicy` type.

A handler of a tool that declares `updatesFiles` gets `ctx.files.update({ fileId, expectedVersion, name?, contentType, bytes })` on a call with an `idempotencyKey`. It answers `{ file }`, the new version; `{ same }`, Latest, when the bytes are Latest's; `{ conflict }`, Latest, when Latest isn't the version the tool read; or `{ notUpdated }`, with a reason from `FILE_NOT_UPDATED_REASONS` (`@kindgi/types`): `rule`, `denied`, `gone`, `type`, `size` or `storage`. A re-run of the call answers the version its first run made. The new version keeps Latest's tags, and Latest's name unless the call gives one.

The runtime takes an update through the call's tool files link (pack protocol 2.13.0). The tool's update posts its bytes to `<url>/<fileId>/versions`, with `Kindgi-Expected-Version` set to the version it read, and `Kindgi-File-Name` when it names the new version. An update over 10 MB (`MAX_STORED_FILE_BYTES`) answers `size`, and nothing is sent. `@kindgi/api` serves the route as `toolFiles.update` (`POST /v1/tool-files/{fileId}/versions`) for a `ToolFilesBinding` that has `update`, and answers a `ToolFileUpdateAnswer`. Without `update`, it answers 404, as it does for an unknown token. In `@kindgi/agents`, a `FileBinding` gains `update`, keyed by the call, and `create`, which answers a `FileCreateAnswer`: the new file, or why there's none (`FILE_NOT_CREATED_REASONS`: `denied`, `type`, `size` or `storage`). `@kindgi/pack-conformance` gains the `file-updates` feature and the fixture tool `conformance.update`.
