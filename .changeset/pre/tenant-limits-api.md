---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A runtime can enforce each tenant's own limits on API requests and webhook deliveries.** With `createApp`'s `tenantLimits`, the limits a tenant has (`TenantSummary.limits`, set through `PUT /v1/system/tenants/{tenantId}/limits`) apply:
- **`apiRequestsPerMinute`** on every authenticated request a tenant's key or session makes, `/v1` and the S3-compatible `/s3` counted together;
- **`webhookReceivesPerMinute`** on deliveries across the tenant's triggers, after each trigger's own `rateLimitPerMinute`.

Past either, the answer is `429 rate-limit-exceeded` with `Retry-After`, and `details.limit` names which (`api-requests` or `webhook-receives`). On `/s3` it's S3's own `503 SlowDown` with `Retry-After`, which S3 clients back off from and retry. A tenant without a limit isn't limited, and a system key acts in no tenant and isn't counted.
- **Reads:** a tenant's limits are read through the tenant binding and kept for `cacheMs` (60 s by default).
- **The store:** counts live in the `RateLimitStore` passed (a deployment with several instances passes a shared one). A failing store counts nothing and refuses no one.
- **Default:** without `tenantLimits`, nothing changes.
- **Reading them:** `GET /v1/system/tenants/{tenantId}/limits` (`system:tenants:limits`) answers the tenant's limits in the shape `PUT` takes, so the control plane raises one by reading them, changing it and putting them back. A closing tenant's can be read. `SystemTenantSettingsBinding` gains `limits(tenantId)`, and the TypeScript client `systemTenants.limits(tenantId)`.
