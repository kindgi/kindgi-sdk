---
"@kindgi/tools": minor
"@kindgi/handler-runtime": minor
"@kindgi/specs": minor
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/agents": minor
"@kindgi/pack-conformance": minor
---

**A tool can store the files it fetches, such as a mail's attachments, and an agent is shown them.**
- **The declaration.** A tool that declares `storesFiles: true` gets `ctx.files` with each call. `ctx.files.store({ name, contentType, bytes })` stores a file as one the call's run owns: the runtime checks the bytes, and only they decide the type. It answers `{ file }`, a file value the tool returns in its result's top-level `files`, or `{ notStored }`: `type`, `size`, or `limit` past `MAX_STORED_FILES_PER_CALL` (10) files a call. A pack's store of a file over `MAX_STORED_FILE_BYTES` (10 MB, the most any type allows) answers `size` without sending its bytes. The same bytes again in the same call, a re-run of it included, answer the first file. A store the runtime refuses, or can't be reached for, rejects, and the call fails as any throw fails it. Only a tool with a handler can store files: `defineTool` and the pack indexer refuse `storesFiles` on a tool with a declarative `spec` or an MCP transport.
- **In a pack.** Pack protocol 2.10.0: a call of a tool that declares `storesFiles` carries `ctx.fileUpload` (`{ url, token }`). The runner keeps it from the handler and gives the handler `files` instead, which posts each file's bytes to the link with the token as the bearer. The handler never sees the link or the token, and a thrown error that quotes the token shows it redacted. A call from an older runtime carries no upload, and the tool gets no `files`. The tool manifest schema is 1.4.0 and the pack index schema 1.7.0, each with `storesFiles`.
- **In-process.** `FileBinding` gains `store(call, file)`, and an agent's tool call of a tool that declares `storesFiles` gets `ctx.files` from it, keyed by the call's `idempotencyKey`.
- **The API.** `POST /v1/file-uploads` takes a pack service's store: the call's upload token as the bearer, no API key; the body is the file's bytes, with `Content-Type` and a percent-encoded `Kindgi-File-Name`. It answers `{ file }` or `{ notStored }`, and `404 file-upload-not-found` for a missing or wrong token alike, or `409 file-upload-closed` once the call has answered, its time has passed or its run has ended. A runtime supplies the store as `createApp`'s `fileUploads` binding. The wire `Tool` gains an optional `storesFiles`, in the TypeScript client too.
- **Conformance.** The `files` feature, with the fixture tool `conformance.store`, checks that a pack service posts a store to the call's upload link and gives the handler only what the runtime answered.
