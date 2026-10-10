---
"@kindgi/api": patch
---

**Every 403 is in the access audit.** A refusal to a caller the API knows is an access decision, so it is recorded with the authorizer and `GET /v1/audit/authz` shows it, whatever the route. Two refusals didn't record:
- **Identity-provider changes while the operator manages sign-in** (`KINDGI_AUTH_TENANT_PROVIDERS=off`), from a key without `kindgi:system`: `403 identity-providers-operator-managed`.
- **Console token sign-in** (`POST /v1/auth/token-sign-in`) with a service account's key or a narrowed key (`403 token-sign-in-not-allowed`), or on a deployment that doesn't allow it (`403 token-sign-in-off`).

Each keeps its code and message, and its error gains the `action`, `resource` and `reason` details the other refusals carry. Token sign-in's own `sign-in-refused` event is still written. A 401, for a caller the API doesn't know, stays a sign-in matter and isn't in the access audit.
