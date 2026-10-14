---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
---

**Tenants, for the operator of a runtime serving many tenants:** `/v1/system/tenants`, each route under its own system scope.
- **`POST /v1/system/tenants`** (`system:tenants`) creates a tenant with its setup.
  - With `firstAdmin`, that person becomes its admin by email, and no key comes back. Without it, its first admin key comes back once, and that takes the full system capability, as does a `test` tenant.
  - It takes `productionAllowed` and `imagePrefix` (`<host>/<path>`) at creation.
  - A taken slug is `409 tenant-slug-taken`.
  - It's safe to retry with the same slug: if the tenant's setup didn't finish, the tenant waits, frozen, and the same request (the same name, slug, settings and first admin, under any Idempotency-Key) finishes it and answers as the first would have. Another request naming that slug is `409 tenant-slug-taken`.
  - A repeat of a create that finished is `409 tenant-slug-taken` too, unless it carries the first request's Idempotency-Key. Then it gets the first answer again, or `409 idempotency-key-replay-withheld` when that answer held the admin key, which is never sent twice.
- **`GET /v1/system/tenants`** and **`GET /v1/system/tenants/{tenantId}`** (`system:tenants`) list and read tenants: never their content.
- **`POST …/close`** (`system:tenants`) makes the tenant `closing`: readable and exportable with its own keys for its window, nothing runs. It's one-way.
- **`PUT …/suspended`** (`system:suspend`, which no other scope includes) suspends or restores it, reversibly.
- **`PUT …/image-prefix`** (`system:tenants`) sets the repository its deployments' images must sit in.
- **`GET …/admins`** (`system:tenants:contacts`) returns its admins' contact addresses, for service notices only.
- **`GET /v1/system/whoami`** answers any system key with its own id, scopes and expiry.

The TypeScript client's `systemTenants` and `systemKeys.whoami`, and the Python client, gain the matching calls.

**Also, from the reviews:**
- **Least privilege at create:**
  - sign-up's key can hold `system:tenants:create` only;
  - a tenant created here starts with production **blocked**;
  - `productionAllowed: true` takes `system:tenants:production`;
  - `imagePrefix` takes the new `system:tenants:image-prefix`, as does `PUT …/image-prefix`;
  - asking for more than the key's scopes is refused naming the scope.
- **The image prefix:**
  - changing one already set takes the full system capability;
  - no two tenants' prefixes overlap (`409 image-prefix-taken`; `imagePrefixesOverlap`).
- **`PUT …/projects/{projectId}/suspended`** (`system:suspend`) suspends or restores one project.
- **A closing or suspended tenant is frozen**, however it signs in: a key, a session or SigV4 (`createApp({ tenantStates })`, required with `tenancy: 'multi'`).
  - **What still works:** reading, its signed exports, signing in and out, deleting, erasure in every state before purge (`POST /v1/memory/erasures`, `…/replay`, `…/{erasureId}/resume`, and the retention sweeps), unregistering, and revoking keys and sessions.
  - **Anything else** is `409 tenant-closing` or `409 tenant-suspended`, registering or changing a sign-in provider included.
  - **If the state can't be read,** a write gets `503 tenant-state-unavailable`, failing closed.
  - **On `/s3`,** both answers are S3 error documents, which S3 clients parse: `403 AllAccessDisabled`, and `503 ServiceUnavailable` with `Retry-After`.
  - `GET /v1/tenant` carries `state`.
- **On a runtime serving many tenants only, `POST /v1/deployments`** refuses an image outside the tenant's repository (`409 image-not-allowed`), before any registry read, and refuses a tenant without one (`409 image-prefix-unset`). A runtime serving one tenant never checks.
- **The tenants list** carries `hasMore`.
- **`KINDGI_TENANCY`** (`single`, the default, or `multi`) in `@kindgi/env-schema`: how many tenants the runtime serves.
