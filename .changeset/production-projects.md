---
"@kindgi/api": patch
"@kindgi/platform": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

**A project can be put in production, and the runtime can gate it.** A run in a project in production is a production run; a run anywhere else is staging.
- **`PUT /v1/projects/{projectId}/production`**, body `{ "production": true | false }`, for tenant admins, both ways. It answers `{ projectId, productionSince }`, where `productionSince` is `null` once the project is out of production. Setting what's already set changes nothing and keeps the first `productionSince`. The TypeScript client has `projects.setProduction(projectId, production)`, and the Python client `projects.production.set(project_id, production=…)`.
- **The production gate:** with `KINDGI_PRODUCTION_GATE=on`, putting a project in production is refused with `403 production-not-allowed` while the tenant isn't allowed it. The error's `details` carry the `projectId` and, from `KINDGI_PRODUCTION_NEXT_URL`, a `next` URL saying where to go. A project already in production stays so. Off by default, so nothing changes for a self-hosted runtime.
- **Reads:** a project read shows `productionSince` while the project is in production. `GET /v1/tenant` gains optional `productionAllowed`, `productionNext` (only while it's `false`) and `limits`, when the runtime knows them.
- **For runtimes:** `Project.productionSince?`, an optional `ProjectBinding.setProduction?` (without it, the route answers `501 production-unsupported`), and `TenantSummary`'s optional `productionAllowed` and `limits` (`TenantLimits`). `createApp` takes `production: { gate?, next? }`.
- **The usage vocabulary:** `USAGE_CLASSES` (`production`, `staging`, `dry-run`, `replay`, `eval`, `child`) and `USAGE_KINDS`, for a runtime that counts usage (`KINDGI_USAGE_METERING`).
- **New settings, documented:** `KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`.
