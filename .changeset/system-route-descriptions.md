---
"@kindgi/api": patch
---

**Two system-route descriptions say what the server does.**
- **`PUT /v1/system/tenants/{tenantId}/production-allowed`:** a tenant made by `POST /v1/system/tenants` starts with production off, unless the create says `productionAllowed: true`. The tenant a server makes for itself, and one from before the switch, start with it on. It used to say every tenant is allowed until it's switched off.
- **A system deployment's `packId`, and the `superseded` reason to retire one:** no new call reaches a superseded deployment, so a rollback needs none of them. A tool call a step made on one still goes back to it when the step runs again, and fails closed (`pack-endpoint-cleared`) once its endpoint is cleared. The advice to keep the newest few per pack is gone.
