---
"@kindgi/types": patch
"@kindgi/specs": patch
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/capabilities": patch
"@kindgi/handler-runtime": patch
"@kindgi/api": patch
"@kindgi/pack-conformance": patch
---

**Tools and agents that change files.** A tool can declare `updatesFiles: true` (tool schema 1.5.0, pack index 1.10.0): it adds versions to files its run has. Only a tool with a handler can, so `defineTool` and the pack indexer refuse it on a declarative or MCP tool, as they refuse `storesFiles`. It's part of the tool's definition, so changing it takes a new version.

An agent can declare `files: { update?, create? }` (agent schema 1.9.0). `update: true` offers its model the built-in `kindgi_update_file`, and `create: true` offers `kindgi_create_file`. An agent can't list either one in `tools`. The pack index and the API's agent schemas carry the declaration, and `@kindgi/agents` exports `UPDATE_FILE_TOOL_ID`, `CREATE_FILE_TOOL_ID` and the `AgentFilesPolicy` type.

A handler of a tool that declares `updatesFiles` gets `ctx.files.update({ fileId, expectedVersion, name?, contentType, bytes })` on a call with an `idempotencyKey`. It answers `{ file }`, the new version; `{ same }`, Latest, when the bytes are Latest's; `{ conflict }`, Latest, when Latest isn't the version the tool read; or `{ notUpdated }`, with a reason from `FILE_NOT_UPDATED_REASONS` (`@kindgi/types`): `rule`, `denied`, `gone`, `type`, `size` or `storage`. A re-run of the call answers the version its first run made. The new version keeps Latest's tags, and Latest's name unless the call gives one.

The runtime takes an update through the call's tool files link (pack protocol 2.13.0). It says a call may update with `toolFiles.updates: true`. Without it, as from a runtime before 2.13.0, a handler gets no `files.update`. The tool's update posts its bytes to `<url>/<fileId>/versions`, with `Kindgi-Expected-Version` set to the version it read, and `Kindgi-File-Name` when it names the new version. An update over 10 MB (`MAX_STORED_FILE_BYTES`) answers `size`, and nothing is sent. `@kindgi/api` serves the route as `toolFiles.update` (`POST /v1/tool-files/{fileId}/versions`) for a `ToolFilesBinding` that has `update`, and answers a `ToolFileUpdateAnswer`. Without `update`, it answers 404, as it does for an unknown token. In `@kindgi/agents`, a `FileBinding` gains `update`, keyed by the call, and `create`, which answers a `FileCreateAnswer`: the new file, or why there's none (`FILE_NOT_CREATED_REASONS`: `denied`, `type`, `size` or `storage`). `@kindgi/pack-conformance` gains the `file-updates` feature and the fixture tool `conformance.update`.

**The model's file tools.** On a turn whose file binding can, `kindgi_update_file` takes `{ fileId, expectedVersion, content }`: the whole new text of a version the turn was given (in its messages, a tool's result or the history its model reads), up to 1 MiB of UTF-8. It adds a version through `FileBinding.update` under the call's key, keeping that version's type, and answers `{ status, files?, reason? }`: `updated`, `same` or `conflict`, each with the file in `files`, so the next call shows it (Latest, for `same` and `conflict`); or `not-text`, `too-large`, `gone`, `not-in-run`, `not-allowed` or `not-stored`, each with a reason. `kindgi_create_file` takes `{ name, content, contentType? }` (`text/plain` by default) and answers `created`, with the new file, or `not-text`, `too-large`, `not-allowed` or `not-stored`. Both are mutating, write `files`, and are asked of `authorizeToolCall` as built-ins are. Only text changes this way: `isTextFileType` (`@kindgi/types`) says which types are text, any `text/*`, JSON, XML and YAML, and their `+json`, `+xml` and `+yaml` types. `@kindgi/agents` exports `FILE_TOOLS_VERSION` and the `UpdateFileToolOutput` and `CreateFileToolOutput` types.

A file a model call is shown, when its value has a `fileId` and `version`, comes after the line `file <fileId> v<version>` (`@kindgi/capabilities`' `fileParts`), so the model can name that version; a value from before file versions shows as before. A kept file value keeps its `fileId` and `version` in a model message. Publishing an agent that declares `files.update` or `files.create` to an API with no file store (no `fileVersions`) answers the warning `files-unavailable`.
