---
"@kindgi/api": patch
---

**A 500's body no longer repeats the thrown error's own message.** An unhandled exception now answers with a fixed message — `A database query failed.` for a failed query, `Unhandled server error` otherwise — and the request id. A thrown error's message often carries internal detail (an upstream's `connect ECONNREFUSED <address>`, a database driver's string, an audience value), which reached the tenant whose request failed — on a shared deployment, detail of the platform every tenant shares; it now stays in the `unhandled error` log line under the same request id, so an operator can still correlate and read the whole error. Errors that mean to speak to the client are unchanged (`getResponse`, `TenantBudgetError` → `429` with its budget, wire errors).
