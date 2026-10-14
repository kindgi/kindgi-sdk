---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A publish refused by its tenant's compile budget answers `429 rate-limit-exceeded`,** with `details: { limit: 'schema-compile-time', budgetMs }` and `Retry-After`, and stores nothing. The OpenAPI document lists it on the routes that publish schemas.
- The TS client's rate-limited error now takes `retryAfterSeconds` from the `Retry-After` header when the body gives none (whole seconds or an HTTP date), and carries `limit`, the limit the server named. The client still doesn't retry on its own.
