---
"@kindgi/api": patch
"@kindgi/policy-contract": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A retired block, policy or release gate can be found.** `GET /v1/blocks`, `GET /v1/policies` and `GET /v1/release-gates` take `?includeRetired=true`, as the lists of agents, flows, tools and test sets do. With it, a retired item (every version unregistered) is listed too, as its highest version with that version's `unregisteredAt`, so a version can be reinstated. Without it, each list answers as before: items with an active version only.
- CLI: `kindgi blocks list` and `kindgi release-gates list` take `--include-retired`, as the agents, flows, tools and test-sets lists do.
- Clients: `client.blocks.list`, `client.policies.list` and `client.releaseGates.list` take `includeRetired`. `client.policies.list` returns `PolicyVersionRow` items, which are `Policy` plus the optional `unregisteredAt`.
- Bindings: `BlockListInput`, `PolicyListInput` and `ReleaseGateListInput` gain an optional `includeRetired`. `PolicyPage.data` is `PolicyVersionRow[]`.
- Schema: `Policy` gains an optional `unregisteredAt`. `GET /v1/policies/{policyId}` answers the latest active version, which never carries it.
- A runtime that doesn't honour the parameter ignores it, and lists as before.
- `kindgi exports create` asks the three lists for retired items too, as it does for the others, so an export includes a retired block, policy or release gate.
