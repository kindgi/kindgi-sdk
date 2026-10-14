---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Two system-route descriptions say what the server does.**
- **`PUT /v1/system/tenants/{tenantId}/production-allowed`:** a tenant made by `POST /v1/system/tenants` starts with production off, unless the create says `productionAllowed: true`. The tenant a server makes for itself, and one from before the switch, start with it on. It used to say every tenant is allowed until it's switched off.
- **A system deployment's `packId`, and the `superseded` reason to retire one:** no call reaches a superseded deployment again, so there's nothing to keep for a rollback. The advice to keep the newest few per pack is gone.
