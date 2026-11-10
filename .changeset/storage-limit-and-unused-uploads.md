---
"@kindgi/blob-binding": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/platform": patch
"@kindgi/env-schema": patch
---

**A put past the workspace's storage limit is refused, and an upload for a run that never starts is deleted.**
- `BlobError` gains `storage-limit-reached`. A put that the workspace's storage limit has no room for stores nothing. The error carries the limit (`storageMiB`), what the workspace's files already take (`usedBytes`) and what the put needs (`neededBytes`). The API answers it with `403 storage-limit-reached`.
- `BlobPutInput.forRun` marks an upload for a run that hasn't started yet. Such an upload is deleted once the deployment's unused-upload time has passed (24 hours by default), unless a run that names it has started by then. `BlobMeta.expiresAt` says when, and goes away once such a run starts.
- `POST /v1/artifacts` takes `forRun=true` for such an upload, and its metadata, in the answer and wherever it's read, has `expiresAt` while it's unused. `forRun` with `ownerRunId`, or with a value other than `true` or `false`, is `400 bad-input`. An upload by someone who may run the project but not write to it is always one.
- The TypeScript client's `artifacts.upload` takes `forRun`, and its `BlobMeta` has `expiresAt`. With the Python client, pass `data={"forRun": "true"}` to `artifacts.upload`; its `BlobMeta` has `expires_at`.
- `TenantLimits.storageMiB` is the workspace's storage limit, in MiB, from 1 to 1000000. It's set and read like the other limits, on `PUT` and `GET /v1/system/tenants/:tenantId/limits`. Lowering it deletes no file.
- `BlobStorageBinding.storageUsed`, optional, says what a tenant's files take, with the uploads under way. From a store that has it, `GET /v1/tenant` answers `storage: { usedBytes }`. A runtime that counts files adds `storageUsedBytes` to the limits read's `inUse`.
- The env schema has `KINDGI_UNUSED_UPLOAD_TTL_MS`: how long an upload for a run is kept while no run that names it has started, in milliseconds, from 1 to 315360000000 (ten years). The default is 86400000 (24 hours). Runtimes before 0.7.0 ignore it.
