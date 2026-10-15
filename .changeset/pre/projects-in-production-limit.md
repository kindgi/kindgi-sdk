---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
"@kindgi/platform": patch
---

**A tenant can have a limit on its projects in production.** The new limit `projectsInProduction` sits in `TenantLimits`, beside the others, and is set through `PUT /v1/system/tenants/{tenantId}/limits`. It works like them: unset, it isn't enforced, and a self-hosted runtime sets none unless its operator does.
- **The refusal:** with the limit set, `PUT /v1/projects/{projectId}/production` refuses another project with `403 production-limit-reached` while the tenant has that many in production, or more. `details` carries `limit: 'projects-in-production'`, the limit (`projectsInProduction`), the count (`inProduction`), the `projectId`, and `next` when the runtime names where to go (`KINDGI_PRODUCTION_NEXT_URL`).
- **What's never counted or refused:** a project already in production answers its repeat 200, uncounted. Taking a project out is never refused.
- **Lowering the limit** takes no project out of production. The next one waits until the count is under the limit.
- **Order:** with the production gate on, a tenant that isn't allowed is refused `production-not-allowed` first.
- **The binding:** `ProjectBinding.setProduction` reads the tenant's limit itself, where the runtime keeps it, and answers `limit-reached` (with the limit and the count) without a change. It reads the limit, counts the tenant's projects in production and changes the project in one step, so two projects put in production at once can't both take the last place, and a limit changed meanwhile is the one counted against. The in-memory binding takes its reader at construction (`productionLimit`). The conformance suite's `productionLimit` option checks a binding against it, setting the limit through the `setProductionLimit` its `makeBinding` returns.
- **The count, read:** `GET /v1/system/tenants/{tenantId}/limits` answers an optional `inUse: { projectsInProduction }` from a runtime whose `SystemTenantSettingsBinding` has the new optional `inUse(tenantId)`. The count can be over a limit that was lowered below it.
- **`KINDGI_PRODUCTION_NEXT_URL`** is the `details.next` of both refusals, `production-not-allowed` and `production-limit-reached`, and its description says so. `KINDGI_PRODUCTION_GATE`'s no longer assumes a payment card.
