---
"@kindgi/api": patch
---

**A read whose binding returns the database's busy failure, instead of throwing it, now answers `503 database-busy` too.** A `GET` or `HEAD` the database was too busy for answered `503 database-busy` with `Retry-After` only when its binding threw the storage failure. A binding can instead return the failure as a Result error under its own code (`persistence-error`, `journal-error`, `blob-storage-error`), keeping it as the error's `cause`. The route then answered that code's `500`. These reads now check for the busy mark first and answer the same 503:
- `GET /v1/approvals` and `/v1/approvals/{approvalId}`;
- `/v1/conversations`, `/v1/conversations/{conversationId}` and `/v1/conversations/{conversationId}/messages`;
- `/v1/runs/{runId}/journal`;
- `/v1/audit/authz` and `/v1/audit/sign-ins`;
- `/v1/observations`;
- `/v1/provenance` and `/v1/provenance/{runId}`;
- `/v1/artifacts`.

A request with any other method answers as before. A thrown error that carries its own response (`getResponse`), with the busy mark down its `cause`, now answers a `GET` or `HEAD` with the 503 as well. `SupervisorQueryObservationsOutcome`'s `runtime-error` takes an optional `cause`, which never reaches the response.
