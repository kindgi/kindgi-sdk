---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A `GET` or `HEAD` the database was too busy to answer in time answers `503 database-busy` with `Retry-After`, where it answered `500 internal-server-error`.** The API answers it for a thrown error that carries `code: 'database-busy'`, on itself or on its `cause` chain, as the runtime's storage marks a lock or statement timeout, or a wait for a pooled connection past its limit. A request with any other method keeps the 500: a write may have saved part of its work before the timeout, and clients retry a 503 as an answer that nothing ran.
- The TS client's server error now carries `retryAfterSeconds` from a 503's `Retry-After` (whole seconds or an HTTP date). The client still doesn't retry on its own.
