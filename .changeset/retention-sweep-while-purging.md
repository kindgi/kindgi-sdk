---
"@kindgi/api": patch
---

**A retention sweep while the tenant's purge runs is refused.** `RetentionBinding.sweep` may answer `RetentionSweepRefused`, `{ refused: 'tenant-purging' }`, when the tenant's purge is running, and sweep nothing: the purge deletes the tenant's rows itself. Runtime `<x>` and later answer it. `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}` then answer `409 tenant-closing`, "Tenant <id>'s purge is running, so nothing was swept.", with `details.tenantId`, and the spec lists it. A binding of your own that never refuses needs no change.
