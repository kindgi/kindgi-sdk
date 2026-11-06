---
"@kindgi/api": patch
---

`PATCH /v1/tenant/config` asks the capability of what it writes, as `/v1/secrets` and `/v1/env` do: `secrets:write` for a secret (or an entry sent with `sensitive: true`), and `env:write` for an `env` or `config` entry. It asks it with an authorization store or without one. A key without it gets `403 permission-denied`, and so does a sign-in on a runtime without a store, which carries no capability. On a runtime without a store, renaming the workspace (`PATCH /v1/tenant`) is the tenant admin's, as its other settings are, and anyone else gets `403 permission-denied`.
