---
"@kindgi/api": patch
---

**A second suspend keeps the first one's time and reason.** Suspending a tenant or a project that's already suspended keeps when it was suspended and why, so a later suspend never replaces the reason given first. Restoring clears both. The descriptions of `PUT /v1/system/tenants/{tenantId}/suspended` and `PUT /v1/system/tenants/{tenantId}/projects/{projectId}/suspended` now say so, as do `SystemTenantsBinding.setSuspended` and `setProjectSuspended`.
