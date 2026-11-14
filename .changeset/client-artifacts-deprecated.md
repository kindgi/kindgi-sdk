---
"@kindgi/client": patch
---

**`client.artifacts` is deprecated, and is removed in 0.8.0: use `client.files`, which keeps every version of a file.** Each method's `@deprecated` names its replacement: `upload` is `files.create`, `list` is `files.list`, `download` is `files.versions.download`, `head` is `files.versions.get`, and `delete` is `files.versions.delete`, or `files.delete` for the whole file. An id `upload` answered is its file's id in `client.files` too, and a blob's `BlobMeta` carries its file's `fileId` and `version`. Until 0.8.0, every `client.artifacts` method works as it did.
