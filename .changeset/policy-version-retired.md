---
"@kindgi/policy-contract": patch
"@kindgi/api": patch
---

`GET /v1/policies/{policyId}/versions/{version}` answers for a retired (unregistered) version too, with its `unregisteredAt`, as the agent, flow, block and gate-policy version routes already do. It used to answer `404 policy-not-found`, so a link to a retired version from the versions list led nowhere. `PolicyRegistryBinding.getVersion` now returns a `PolicyVersionRow`: the contract already said a tombstoned version is returned, and its `unregisteredAt` is now part of the type. An active version carries no `unregisteredAt`. A version the retention sweep has purged is still `404`. The Python client's `get_version` returns a `PolicyVersionRow`.
