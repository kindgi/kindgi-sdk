---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-inmemory": patch
"@kindgi/secrets-dotenv": patch
---

**`GET /v1/environments` lists the tenant's env names,** for a tenant admin: each name that holds an env value or a secret, at any scope, once, in byte order, paged by `cursor` and `limit`.
- An env store and a secrets store each say their own names through a new optional `listEnvNames({ tenantId, limit, after })` (`EnvBinding`, `SecretBinding`). A runtime with a store that doesn't is answered `501 environments-unsupported`, which names the store, rather than a list missing its names.
- The in-memory env store gives the names its tenant's values are under. The dotenv secrets store gives `local` and each `.env.<name>` file that holds a name.
- The TypeScript client lists them with `client.environments.list()`.
