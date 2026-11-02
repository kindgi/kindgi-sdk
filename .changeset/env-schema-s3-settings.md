---
"@kindgi/env-schema": patch
---

**The settings for files kept in S3 are in the schema, for runtime 0.4.0.** `KINDGI_S3_REGION`, `KINDGI_S3_ENDPOINT`, `KINDGI_S3_PATH_STYLE` and `KINDGI_S3_CREDENTIALS_PATH` say how the server reaches its S3 buckets: AWS S3 as the server's AWS identity, or an S3-compatible store (MinIO, R2) at its own address, with its own key file. `KINDGI_ARTIFACTS`, `KINDGI_ERASURE_LEDGER_EXPORT` and `KINDGI_TENANT_PURGE_RECORD` say they take an `s3:<bucket>[/<prefix>]` bucket from runtime 0.4.0. Earlier runtimes ignore the four `KINDGI_S3_*` settings and refuse an `s3:` value at start.
