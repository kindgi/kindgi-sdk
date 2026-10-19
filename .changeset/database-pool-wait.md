---
"@kindgi/env-schema": patch
---

**`KINDGI_DB_POOL_WAIT_TIMEOUT_MS`** (runtime 0.1.9 on): how long a query waits for one of the server's pooled database connections while every one is taken, 10000 ms by default; 0 turns it off. Past it the query fails before it runs: a GET or HEAD answers 503 `database-busy` with `Retry-After: 5` (under `/auth/`, a browser signing in is sent back to the sign-in page instead), any other request 500. The admin commands wait as long as it takes. The statement and lock timeouts' descriptions now say the same of the GETs and HEADs they end.
