---
"@kindgi/api": patch
---

`PATCH /v1/tenant/config` asks the capability of what it writes, as `/v1/secrets` and `/v1/env` do: `secrets:write` for a secret (or an entry sent with `sensitive: true`), and `env:write` for an `env` or `config` entry. It asks it with an authorization store or without one. A key or a sign-in without it gets `403 permission-denied`. A sign-in carries the capabilities its person holds: with a store, only the workspace's first admin holds them, and without one, a sign-in carries none. On a runtime without a store, renaming the workspace (`PATCH /v1/tenant`) is the tenant admin's, as its other settings are, and anyone else gets `403 permission-denied`.
