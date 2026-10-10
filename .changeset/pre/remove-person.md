---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Remove a person from a tenant: `POST /v1/identity/users/{userId}/unregister`, mounted when the identity directory can (`IdentityDirectoryBinding.unregisterUser`, optional). Tenant admins only.
- **What it does, in one step:** every API key and session of theirs is revoked, and every grant and membership taken away, before it answers. Their keys get `401` at once.
- **Their record stays,** with `unregisteredAt`, so their history still says who they were. Their email is free again: adding it makes a new person.
- **Idempotent:** removing someone already removed changes nothing.
- **Refused** for yourself and the seed user (`identity-user-unregister-refused`), and for the only tenant admin (`last-tenant-admin`).
- **The list** (`GET /v1/identity/users`) leaves removed people out unless `includeUnregistered=true`.
- **Clients:** TypeScript `client.users.unregister(id)` and `users.list({ includeUnregistered })`; the Python client is regenerated.
- **CLI:** `kindgi people remove <user-id>` and `kindgi people list --include-removed`.
