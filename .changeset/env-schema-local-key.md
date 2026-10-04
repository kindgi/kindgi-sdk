---
"@kindgi/env-schema": patch
---

The local key for secrets (`KINDGI_SECRETS_BACKEND_KMS=libsodium`): `KINDGI_SECRETS_LOCAL_KEY_PATH` or `KINDGI_SECRETS_LOCAL_KEY`, and `KINDGI_SECRETS_LOCAL_KEY_ACK` (required, exactly `single-node`). A self-hosted runtime without a cloud KMS can keep secrets in Postgres with a key it holds; `KINDGI_SECRETS_BACKEND_KMS` lists `libsodium` as supported.
