---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/platform": patch
---

**A tenant can be renamed: its name, its slug, or both.** Its id stays, so whatever names it by its id keeps working.
- **`PATCH /v1/tenant`** renames your own tenant. It's for tenant admins. **`PATCH /v1/system/tenants/{tenantId}`** renames any tenant, for an operator's key with `system:tenants`, whose scope now reads "Create, list, read, rename and close tenants." Both take a `TenantPatch` body (`name`, `slug`, each optional; a field left out stays as it is) and an optional `Idempotency-Key`, and answer `204` with no body. The same values again also answer `204` and change nothing.
- **A slug follows the rule creating a tenant has:** lowercase letters, digits and single hyphens, at most 63 characters, unique across tenants. A name is non-empty, at most 100 characters.
- **Refusals:** `409 tenant-slug-taken` (another tenant has the slug; a purged tenant keeps its own), `409 tenant-closing`, and two new codes. `409 tenant-slug-in-config`: the server's `KINDGI_AUTH_VERIFIED_DOMAINS` names this tenant by its slug, or names the slug asked for. The server's operator names the tenant there by its id and restarts; then rename it. `409 tenant-setup-pending`: the tenant's creation hasn't finished; sending the request that created it again finishes it.
- **The clients:** `tenant.update(input)` and `systemTenants.update(tenantId, input)` in TypeScript, both `Promise<void>` (`RenameTenantInput` is the body); `tenant.update` and `system_tenants.update` in Python, sync and async, returning `None`. Read the tenant back with `get()`.
- **For a runtime:** `TenantHierarchyBinding.renameTenant` is optional, and the two routes mount only when it's there. A runtime without it answers `404` on both, as before.
