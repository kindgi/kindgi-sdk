---
"@kindgi/api": patch
---

**A write with an `Idempotency-Key` whose key store can't be read before it runs answers `503 idempotency-store-unavailable` with `Retry-After`, where it answered `500 internal-server-error`.**
- Nothing ran, so a retry with the same key is safe.
- The store's failure is logged as an error. The logged error holds no query text or values: a query error is logged as `A database query failed.`, as the central error handler logs one.
- `idempotency-store-unavailable` is a new error code (503). `openapi.json` declares it on every write that takes the `Idempotency-Key` header, alongside the `503 database-busy` its reads declare. The `Idempotency-Key` parameter's description names it too. The Python client retries it on its own, as it does any 503 to a keyed write (twice by default, waiting as `Retry-After` says), and raises a server error once those retries run out. Before, the 500 wasn't retried. The TypeScript client reads it as it reads `database-busy`, as a server error with `serverCode: 'idempotency-store-unavailable'` and `retryAfterSeconds` from `Retry-After`, and doesn't retry on its own.

**A write whose answer can't be stored after it ran keeps its answer, where it answered `500`.** The operation took effect, so its own answer stands, though it can't be replayed, and the failure is logged as an error. The key's hold isn't released: a retry sent within the hold's 30 seconds gets `409 idempotency-key-in-flight`, as it would after a crashed request, and one sent after that runs again.

A hold that can't be renewed or released is now logged as a warning. Before, the failure was dropped silently. The answer doesn't change.
