---
"@kindgi/api": patch
"@kindgi/platform": patch
"@kindgi/client": patch
---

**A tenant can have its own limits on the flows and agents in production, and the control plane can record the plan it's on.** `TenantLimits` gains `flowsInProduction` and `agentsInProduction`, set on `PUT /v1/system/tenants/{tenantId}/limits` like the others. Each counts a flow or an agent once, however many of the tenant's projects in production run it, with the plan limits' margin: on a runtime that counts them, a write that would take a count past the most (the larger of 1.2 times the number, rounded down, and one more than it) is refused with `403 plan-limit-reached`, and a write's answer carries `planWarning` from the number itself. Lowering one takes nothing out of production.

- **Whose numbers:** a refusal's details, and each of `over`'s entries, gain an optional `scope`: `installation` for the license key's plan, `tenant` for the tenant's own limits. A tenant's own numbers are always given, and its words name its limit, not a key or a plan. `PlanOver` gains `scope` (`PlanScope`).
- **The counts, read:** a runtime that counts them answers `inUse.flowsInProduction` and `inUse.agentsInProduction` on `GET …/limits`.
- **The plan id:** `PUT /v1/system/tenants/{tenantId}/plan` `{ plan }` (`system:tenants:limits`) sets the id of the plan the tenant is on, a lowercase letter then up to 31 lowercase letters, digits and hyphens (`TENANT_PLAN_PATTERN`), or clears it with null, and answers `{ tenantId, plan }`. It's only shown: the limits are what's enforced. `GET …/limits` answers it as `plan`, null while none is set, and `PUT …/limits` leaves it as it is. A closing tenant is `409 tenant-closing`.
- **The binding:** `SystemTenantSettingsBinding` gains optional `plan` and `setPlan`. Without `setPlan`, `PUT …/plan` answers the new `501 tenant-plan-unsupported`; without `plan`, `GET …/limits` leaves `plan` out.
- **Clients:** the TypeScript client's `systemTenants.setPlan`. The Python client is regenerated.
