---
'@kindgi/api': patch
'@kindgi/client': patch
'@kindgi/env-schema': patch
---

**New system route `POST /v1/system/tenants/{tenantId}/purge`:** purges a closed tenant for good, once its 30-day export window has passed, as `kindgi-runtime tenants purge` does: every row of it, its artifacts' bytes and its authorization store, then its purge record, then the mark. `confirm` is the tenant's slug. It takes `system:tenants:purge`, which no other scope includes, or `kindgi:system`; until now that scope could be put on a key and reached nothing.

- **It answers when done:** `complete`, what it deleted per table (`deleted`, `bytesDeleted`, `authzStoreDeleted`), and what's left (`left`, `bytesLeft`, `leftBecause`). With `complete: false`, or a call that ended before its answer, run it again. On a tenant already purged it deletes what was written after its mark (`alreadyPurged: true`). Every call is on the operator's access record.
- **Refused, with nothing changed:** `400 tenant-slug-mismatch`; `409 tenant-not-closing`, `tenant-export-window-open`, `purge-record-unset` and `purge-setting-missing`. OpenFGA refusing the store's delete is `502 authz-store-delete-failed`, and a runtime that doesn't purge answers `501 tenant-purge-unsupported`.
- **`SystemTenantsBinding.purge`** is optional. `withSystemTenantContext` takes `admitPurged`, so the purge's route reaches a tenant already purged; every other system route still answers `404 tenant-not-found` for one.
- **New runtime setting `KINDGI_TENANT_PURGE_RECORD`** (`local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`): where the server writes purge records. The route refuses every purge while it's unset.
- **Clients:** `client.systemTenants.purge(tenantId, confirm, { timeoutMs })` in TypeScript (`TenantPurge`), and `client.system_tenants.purge(tenant_id, confirm=…)` in Python.
