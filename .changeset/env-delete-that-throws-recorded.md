---
"@kindgi/api": patch
---

**A delete of an env value, or of a name set to a cloud secret, whose store throws is now recorded, as `env-deleted` with `outcome: "failed"`.** `DELETE /v1/env/{name}` and `DELETE /v1/system/tenants/{tenantId}/env/{name}` recorded only a delete that removed something, so one whose storage failed left no record. It's now recorded with the caller, the request and `errorCode: "internal-server-error"`, the answer the client gets, and never the error itself. The answer doesn't change: `500 internal-server-error`. A delete that finds nothing to remove (`{ deleted: false }`) still isn't recorded.
