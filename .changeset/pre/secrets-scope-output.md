---
"@kindgi/cli": patch
---

`kindgi secrets` no longer prints a made-up tenant. `set` printed `"tenantId": "session-tenant"` in its scope, a placeholder the CLI used because the server takes the tenant from the bearer. `set` now prints the scope the server wrote the secret to, its real tenant included. `rotate`, `revoke` and `pull`'s manifest print the scope they were given, as its kind and id (`{"kind": "org", "orgId": "…"}`), with no tenant. `get` and `list` print the server's records, as before. A `set` the server answers with "already exists" exits 1 with the conflict message, instead of printing "Set".
