---
"@kindgi/client": patch
---

**`client.files`: files with versions.** It has a method for each `files.*` operation: `list`, `create`, `get`, `delete` and `pinHistory`, and `versions.list`, `versions.add`, `versions.get`, `versions.download`, `versions.restore`, `versions.delete`, `versions.pin` and `versions.unpin`. A version is named by its number or by `'latest'`, and `versions.download` streams the bytes and says which version it served. `create` and `versions.add` send a multipart upload, as `artifacts.upload` does; `versions.add` and `versions.restore` take `expectedVersion`. The wire types `StoredFile`, `FileVersion`, `FileVersionWrite`, `FilePin`, `FilePinChange` and `DeleteFileResult` are exported, and `BlobMeta` gains `fileId` and `version`, for a blob that is a file's version.
