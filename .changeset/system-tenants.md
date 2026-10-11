---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Tenants, for the operator of a runtime serving many tenants:** `/v1/system/tenants`, each route under its own system scope.
- **`POST /v1/system/tenants`** (`system:tenants`) creates a tenant with its setup.
  - With `firstAdmin`, that person becomes its admin by email, and no key comes back. Without it, its first admin key comes back once, and that takes the full system capability, as does a `test` tenant.
  - It takes `productionAllowed` and `imagePrefix` (`<host>/<path>`) at creation.
  - A taken slug is `409 tenant-slug-taken`.
- **`GET /v1/system/tenants`** and **`GET /v1/system/tenants/{tenantId}`** (`system:tenants`) list and read tenants: never their content.
- **`POST …/close`** (`system:tenants`) makes the tenant `closing`: readable and exportable with its own keys for its window, nothing runs. It's one-way.
- **`PUT …/suspended`** (`system:suspend`, which no other scope includes) suspends or restores it, reversibly.
- **`PUT …/image-prefix`** (`system:tenants`) sets the repository its deployments' images must sit in.
- **`GET …/admins`** (`system:tenants:contacts`) returns its admins' contact addresses, for service notices only.
- **`GET /v1/system/whoami`** answers any system key with its own id, scopes and expiry.

The TypeScript client's `systemTenants` and `systemKeys.whoami`, and the Python client, gain the matching calls.
