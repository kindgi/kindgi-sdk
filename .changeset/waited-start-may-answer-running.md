---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A waited start says it can answer with its run still running.** `POST /v1/runs` with `wait` left true answers `201` once the run completes, fails or suspends, or, when a read the run needs fails part-way, with the run still `running` and no `output`: the run goes on at a later resume, so poll `GET /v1/runs/{runId}` (`get(runId)` in the TypeScript client). The API reference, the client's `start` docs and the run guides now say so. A repeat with the same idempotency key gets that same `running` answer again; `GET` gives the run as it is now.
