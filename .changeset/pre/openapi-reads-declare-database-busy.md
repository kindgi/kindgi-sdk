---
"@kindgi/api": patch
---

**`openapi.json` now declares the `503 database-busy` answer on every `GET` and `HEAD`.** A read whose database is too busy to answer in time already answers `503` with `Retry-After`; the spec now says so, so a generated client and anyone reading the document see a status that was already real. It is one shared response on every served read, carrying the `WireError` body (`code: database-busy`) — on a `HEAD`, the status and `Retry-After` with no body. The two reads that never reach storage, the liveness probe (`GET /health`) and the spec document (`GET /v1/openapi.json`), are left out, and the reads that already declared a `503` of their own keep it, each description widened to name `database-busy` too. A generated client's answers and errors don't change: each types a read by its `2xx` body and classifies an error by status, so a declared `503` adds documentation without changing what a client returns or throws.
