---
"@kindgi/api": patch
"@kindgi/client": patch
---

**System keys, for a runtime serving many tenants.** A system key (`kgi_sy_…`) is the operator's, for a service that acts for it, with the least system scope that service needs (`system:tenants`, `system:deployments`, `system:license` and others). It acts in no tenant.
- **Where it reaches:** `/v1/system/*` and the deployment's license. Every other route refuses it (`403 system-key-on-tenant-route`), and system routes refuse a tenant's key or session whatever it holds (`403 system-principal-required`).
- **The record:** every request a system key makes is recorded through `systemAccessAudit`.
- **Managing them:** `POST /v1/system/keys`, `GET /v1/system/keys` and `POST /v1/system/keys/{keyId}/revoke`, for the full system capability (`kindgi:system`) only. A key can't outlive the key minting it.
- **New `createApp` inputs:** `tenancy`, `systemKeys` and `systemAccessAudit`.
- **For routes:** `requireSystemScope`, `requireFullSystem`, `withSystemTenantContext` and `systemReadAcrossTenants`.
- **Tenant keys:** a tenant's key is never minted holding a `system:*` scope, and on a runtime serving many tenants not `kindgi:system` either (`403 capability-not-mintable`).
- **The license:** `GET /v1/license` also answers a system key holding `system:license` as it answers the deployment's own token.

Nothing changes for a runtime serving one tenant: it has no system principal.

The TypeScript client gains `systemKeys` (`mint`, `list`, `revoke`), and the Python client the matching calls.
