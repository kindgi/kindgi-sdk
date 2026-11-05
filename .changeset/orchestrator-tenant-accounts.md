---
"@kindgi/env-schema": patch
---

`@kindgi/env-schema` gains `KINDGI_ORCHESTRATOR_TENANT_ACCOUNTS`: the pack orchestrator's map of each tenant's id to the service account that tenant's pack services run as, a pack account per tenant. A tenant not in it has nowhere to run pack services, and its deployments wait with `tenant-not-provisioned`. Unset, every pack service runs as `KINDGI_ORCHESTRATOR_PACK_SERVICE_ACCOUNT`, as before. With it set, that one is still required, as the install's name.
