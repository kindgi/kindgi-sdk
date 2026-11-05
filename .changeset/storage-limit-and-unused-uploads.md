---
"@kindgi/blob-binding": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A put past the workspace's storage limit is refused, and an upload for a run that never starts is deleted.**
- `BlobError` gains `storage-limit-reached`. A put that the workspace's storage limit has no room for stores nothing. The error carries the limit (`storageMiB`), what the workspace's files already take (`usedBytes`) and what the put needs (`neededBytes`). The API answers it with `403 storage-limit-reached`.
- `BlobPutInput.forRun` marks an upload for a run that hasn't started yet. Such an upload is deleted once the deployment's unused-upload time has passed (24 hours by default), unless a run that names it has started by then. `BlobMeta.expiresAt` says when, and goes away once such a run starts.
- `POST /v1/artifacts` takes `forRun=true` for such an upload, and its answer, like every artifact's, has `expiresAt` while it's unused. `forRun` with `ownerRunId`, or with a value other than `true` or `false`, is `400 bad-input`. An upload by someone who may run the project but not write to it is always one.
- The TypeScript client's `artifacts.upload` takes `forRun`, and its `BlobMeta` has `expiresAt`. With the Python client, pass `data={"forRun": "true"}` to `artifacts.upload`; its `BlobMeta` has `expires_at`.
