---
"@kindgi/api": patch
"@kindgi/client": patch
---

**The control plane's system routes for a tenant's production switch and its limits.** Each takes its own system scope, and a tenant's key gets `403 system-principal-required`.
- **`PUT /v1/system/tenants/{tenantId}/production-allowed`** `{ allowed }` (`system:tenants:production`): the switch the production gate reads. It answers `{ tenantId, productionAllowed }`.
- **`PUT /v1/system/tenants/{tenantId}/limits`** (`system:tenants:limits`): replaces the tenant's limits with exactly those given (`apiRequestsPerMinute`, `webhookReceivesPerMinute`, `runsAtOnce`, `runsPending`, `toolCallsInFlight`, `approvalsPending`, each 1 to 1000000). One left out isn't set. It answers `{ tenantId, limits }`.
- Both refuse an unknown or purged tenant (`404 tenant-not-found`) and a closing one (`409 tenant-closing`).
- **For runtimes:** `createApp` takes `systemTenantDirectory` and `systemTenantSettings` (`SystemTenantSettingsBinding`).
- **Clients:** the TypeScript client's `systemTenants.setProductionAllowed` and `systemTenants.setLimits`. The Python client is regenerated.
