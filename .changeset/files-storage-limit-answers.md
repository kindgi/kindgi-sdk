---
"@kindgi/api": patch
---

**`POST /v1/files` and `POST /v1/files/{fileId}/versions` list `403 storage-limit-reached`.** Both routes already answered it when the workspace's storage limit had no room for the bytes, with `details.limit`, `storageMiB`, `usedBytes` and `neededBytes`, and stored nothing. Their descriptions and 403 answers now say so.
