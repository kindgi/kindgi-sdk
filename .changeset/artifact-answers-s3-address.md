---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Fixed: the published artifact answer lists the S3 address it already carried.** `GET /v1/artifacts` and `POST /v1/artifacts` answer a blob's `bucket` and `key` when the server's storage gives it an S3-compatible address (`/s3/{bucket}/{key}`). The `BlobMeta` schema didn't list them, and it allows no other properties, so a client checking an answer against the spec would refuse it. The schema now lists both, optional: present when the storage gives the blob an address, absent otherwise. The answers don't change. The TypeScript and Python clients' `BlobMeta` have `bucket` and `key`.
