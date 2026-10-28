---
"@kindgi/tools": minor
"@kindgi/handler-runtime": minor
"@kindgi/specs": minor
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/agents": minor
"@kindgi/pack-conformance": minor
"@kindgi/types": minor
"@kindgi/capabilities": patch
"@kindgi/env-schema": patch
---

**A tool can store the files it fetches, such as a mail's attachments, and read the files it's given; an agent is shown the ones it stores.**
- **Storing.** A tool that declares `storesFiles: true` gets `ctx.files.store` with each call that has an `idempotencyKey`, as an agent's tool calls do. `ctx.files.store({ name, contentType, bytes })` stores a file as one the call's run owns: the runtime checks the bytes, and only they decide the type. It answers `{ file }`, a file value the tool returns in its result's top-level `files`, or `{ notStored }`: `type`, `size`, `limit` past `MAX_STORED_FILES_PER_CALL` (10) files a call, or `storage` when the tenant's storage is full. A pack's store of a file over `MAX_STORED_FILE_BYTES` (10 MB, the most any type allows) answers `size` without sending its bytes. The same bytes again in the same call, a re-run of it included, answer the first file.
- **Reading.** A tool that declares `readsFiles: true` gets `ctx.files.read(artifactId)` with each call: the bytes of a file its run may be shown, by the `artifactId` of a file value, such as one in its input. It answers `{ bytes }`, the file as it was stored, or `{ notRead }`: `rule` (the run may not be shown a file of that id), `gone` (deleted, or its bytes are missing), `changed` (its bytes aren't the ones that were checked) or `size` (over its type's limit). `FILE_NOT_READ_REASONS` lists them.
- **Either way.** A store or a read the runtime refuses, or can't be reached for, rejects, and the call fails as any throw fails it. Only a tool with a handler can store or read files: `defineTool` and the pack indexer refuse `storesFiles` and `readsFiles` on a tool with a declarative `spec` or an MCP transport.
- **`storage`** joins the reasons a file isn't shown (`FileNotShownReason`): a tool's store found the tenant's storage full.
- **In a pack.** Pack protocol 2.10.0: a call of a tool that declares `storesFiles` or `readsFiles` carries `ctx.toolFiles` (`{ url, token }`). The runner keeps it from the handler and gives the handler `files` instead: a store posts the file's bytes to the link, and a read gets them from under it, each with the token as the bearer. The handler never sees the link or the token, and a thrown error that quotes the token shows it redacted. A call from an older runtime carries no tool files, and the tool gets no `files`. The tool manifest schema is 1.4.0 and the pack index schema 1.7.0, each with `storesFiles` and `readsFiles`.
- **In-process.** `FileBinding` gains `store(call, file)`, keyed by the call's `idempotencyKey`, and `readSource(artifactId)`; an agent's tool call gets `ctx.files` from them, with what its tool declares.
- **The API.** `POST /v1/tool-files` takes a pack service's store: the call's token as the bearer, no API key; the body is the file's bytes, with `Content-Type` and a percent-encoded `Kindgi-File-Name`. It answers `{ file }` or `{ notStored }`. `GET /v1/tool-files/{artifactId}` takes a read, with the same bearer: it answers the file's bytes as `application/octet-stream`, or `{ notRead }` as JSON. Either answers `404 tool-file-token-not-found` for a missing or wrong token alike, or for a call whose tool doesn't declare what it asks; `409 tool-file-token-closed` once the call has answered, its time has passed or its run has ended; and `503 tool-files-busy`, with `Retry-After`, when the runtime has no room for the bytes then: a store holds twice the file's size in its memory for files (`KINDGI_FILE_MEMORY_MIB`, whose description now says so), and a read its size. A runtime supplies both as `createApp`'s `toolFiles` binding. The OpenAPI document gives the read's 200 both bodies. The wire `Tool` gains optional `storesFiles` and `readsFiles`, in the TypeScript client too.
- **Conformance.** The `files` feature, with the fixture tools `conformance.store` and `conformance.read`, checks that a pack service posts a store to the call's tool files link, gets a read from under it, and gives the handler only what the runtime answered.
