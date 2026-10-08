---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A retry sent while the first request still runs no longer runs it again.**

**The store:** an `IdempotencyStore` can now hold a key while its request runs, through `holds` (`hold`, `renew`, `release`). It's optional: a store without it behaves as before.

**With holds, a retry under the same `Idempotency-Key` that arrives before the first request answers:**
- gets `409 idempotency-key-in-flight` with `Retry-After: 5`, instead of running the operation again (for a run start, a second run). Retrying after it gets the first request's answer;
- with another body, gets `idempotency-key-body-mismatch`, as for a stored answer.

**How long a hold lasts:** 30 s (`holdMs`), renewed while the request runs, so a crashed request frees its key within 30 s. A refusal or a failure releases it, so a retry after fixing the cause runs again.

**Also:**
- the in-memory store holds keys, and now keeps the first stored answer, as the runtime's Postgres store does;
- both clients map `idempotency-key-in-flight` to a conflict error;
- the runtime's store holds keys from 0.1.5.
