---
"@kindgi/api": patch
---

`GET /v1/auth/sign-in-options`' rate limit can be shared by every instance.
- **The binding:** a new `RateLimitStore` (`take({ key, limit, windowMs })` → allowed, or refused with `retryAfterMs`). `SignInOptionsRateLimit.store` takes one.
- **The default:** `createInMemoryRateLimitStore()` counts in each process, as before, so N instances let N × `limit` through. The Kindgi runtime passes one it keeps in Postgres.
- **Keys:** the route asks the store with the client's key, namespaced (`sign-in-options:<client>`), so one store can serve several limits.
- **A store that fails:** the lookup is still answered, because the limit is a speed bump, not a lock, and the failure is logged.
