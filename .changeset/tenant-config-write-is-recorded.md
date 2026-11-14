---
"@kindgi/api": patch
---

`PATCH /v1/tenant/config` records each write in the audit log, as `/v1/env` and `/v1/secrets` record theirs: `env-set` for an `env` or `config` entry, and `secret-set` for a secret (or an entry sent with `sensitive: true`). The record names the caller, the key, the env it's stored under and the store's answer, never the value. A refusal before the store is called, such as a bad body or a missing capability, records nothing. A new secret whose key another writer created between the read and the write is now stored as the key's next version, still under the request's `ifRevision`. Before, the request answered `200` with the other writer's version, and its own value wasn't stored.
