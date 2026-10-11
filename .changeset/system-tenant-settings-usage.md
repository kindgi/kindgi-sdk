---
"@kindgi/api": patch
"@kindgi/client": patch
---

**The control plane's system routes for a tenant's production switch, its limits, and usage across tenants.** Each takes its own system scope, and a tenant's key gets `403 system-principal-required`.
- **`PUT /v1/system/tenants/{tenantId}/production-allowed`** `{ allowed }` (`system:tenants:production`): the switch the production gate reads. It answers `{ tenantId, productionAllowed }`.
- **`PUT /v1/system/tenants/{tenantId}/limits`** (`system:tenants:limits`): replaces the tenant's limits with exactly those given (`apiRequestsPerMinute`, `webhookReceivesPerMinute`, `runsAtOnce`, `runsPending`, `toolCallsInFlight`, `approvalsPending`, each 1 to 1000000). One left out isn't set. It answers `{ tenantId, limits }`.
- Both refuse an unknown or purged tenant (`404 tenant-not-found`) and a closing one (`409 tenant-closing`).
- **`GET /v1/system/usage`** (`system:usage:read`): usage records aggregated by `groupBy` (`tenant`, `project`, `agent`, `kind`, `class`, `state`, `day`), with filters on kind, class, state and tenant, over a window of at most 92 days. Each group carries its count, the sum of its quantities, and its first and last times; never a record's content. The answer has a `watermark` (every record at or before it is included) and `nextCursor` for the next page. The access record marks it a read across every tenant.
- **For runtimes:** `createApp` takes `systemTenantDirectory`, `systemTenantSettings` (`SystemTenantSettingsBinding`) and `systemUsage` (`SystemUsageBinding`).
- **Clients:** the TypeScript client's `systemTenants.setProductionAllowed`, `systemTenants.setLimits` and `systemUsage.read`. The Python client is regenerated.
