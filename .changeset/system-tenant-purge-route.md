---
'@kindgi/api': patch
'@kindgi/client': patch
'@kindgi/env-schema': patch
---

**New system route `POST /v1/system/tenants/{tenantId}/purge`:** purges a closed tenant for good, once its 30-day export window has passed, as `kindgi-runtime tenants purge` does: every row of it, its artifacts' bytes and its authorization store, then its purge record, then the mark. `confirm` is the tenant's slug. It takes `system:tenants:purge`, which no other scope includes, or `kindgi:system`. Until now that scope could be put on a key and reached nothing.

- **It answers when done:** `complete`, what it deleted per table (`deleted`, `objectsDeleted`, `authzStoreDeleted`), and what's left (`left`, `objectsLeft`, `leftBecause`). With `complete: false`, or a call that ended before its answer, run it again. On a tenant already purged it deletes what was written after its mark (`alreadyPurged: true`). Every call is on the operator's access record.
- **Refused, with nothing changed:** `400 tenant-slug-mismatch`; `409 tenant-not-closing`, `tenant-export-window-open`, `purge-record-unset` and `purge-setting-missing`. A runtime that doesn't purge answers `501 tenant-purge-unsupported`.
- **A failed delete of its OpenFGA store** is `502 authz-store-delete-failed`, and its message says what that left. Run it again.
- **`SystemTenantsBinding.purge`** is optional. `withSystemTenantContext` takes `admitPurged`, so the purge's route reaches a tenant already purged; every other system route still answers `404 tenant-not-found` for one.
- **New runtime setting `KINDGI_TENANT_PURGE_RECORD`** (`local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`): where the server writes purge records. The route refuses every purge while it's unset.
- **Clients:** `client.systemTenants.purge(tenantId, confirm, { idempotencyKey, timeoutMs })` in TypeScript (`TenantPurge`), and `client.system_tenants.purge(tenant_id, confirm=…, idempotency_key=…, timeout=…)` in Python.
