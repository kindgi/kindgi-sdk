---
"@kindgi/api": patch
---

Memory routes reject a scope that names another tenant. `POST /v1/memory/facts`, `POST /v1/memory/retrieve` and `GET /v1/memory/facts?scope=` now answer `400 scope-mismatch` when `scope.tenantId` differs from the caller's tenant (from the token), before the binding is called — the same rule as the secrets, env and policy routes. Previously the write route passed the body's scope through unchecked, so an implementation that writes under `scope.tenantId` could be made to write into another tenant. `MemoryWriteFactInput.tenantId` is documented as the tenant to write under.
