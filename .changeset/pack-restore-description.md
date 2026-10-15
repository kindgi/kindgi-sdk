---
"@kindgi/api": patch
---

**Restoring a pack says what it does.** `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/suspended`: a restored pack serves again from the endpoint recorded for it, and it lists as needing a pack service only when that endpoint is pending or was cleared meanwhile. It used to say a restored pack lists as needing a pack service again.
