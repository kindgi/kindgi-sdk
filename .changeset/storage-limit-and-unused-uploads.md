---
"@kindgi/blob-binding": patch
"@kindgi/api": patch
---

**A put past the workspace's storage limit is refused, and an upload for a run that never starts is deleted.**
- `BlobError` gains `storage-limit-reached`. A put that the workspace's storage limit has no room for stores nothing. The error carries the limit (`storageMiB`), what the workspace's files already take (`usedBytes`) and what the put needs (`neededBytes`). The API answers it with `403 storage-limit-reached`.
- `BlobPutInput.forRun` marks an upload for a run that hasn't started yet. Such an upload is deleted once the deployment's unused-upload time has passed (24 hours by default), unless a run that names it has started by then. `BlobMeta.expiresAt` says when, and goes away once such a run starts.
