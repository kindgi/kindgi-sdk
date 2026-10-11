---
"@kindgi/api": patch
---

**A runtime can enforce each tenant's own limits on API requests and webhook deliveries.** With `createApp`'s `tenantLimits`, the limits a tenant has (`TenantSummary.limits`, set through `PUT /v1/system/tenants/{tenantId}/limits`) apply:
- **`apiRequestsPerMinute`** on every authenticated request a tenant's key or session makes;
- **`webhookReceivesPerMinute`** on deliveries across the tenant's triggers, after each trigger's own `rateLimitPerMinute`.

Past either, the answer is `429 rate-limit-exceeded` with `Retry-After`, and `details.limit` names which (`api-requests` or `webhook-receives`). A tenant without a limit isn't limited, and a system key acts in no tenant and isn't counted.
- **Reads:** a tenant's limits are read through the tenant binding and kept for `cacheMs` (60 s by default).
- **The store:** counts live in the `RateLimitStore` passed (a deployment with several instances passes a shared one). A failing store counts nothing and refuses no one.
- **Default:** without `tenantLimits`, nothing changes.
