---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A retired flow can be found and brought back.** `GET /v1/flows/{id}/versions?includeTombstoned=true` lists a flow's unregistered versions too, each with `unregisteredAt`, as tools and policies already do. It answers for a retired flow (every version unregistered) instead of `404`; only a never-registered id is `404`. `GET /v1/flows?includeRetired=true` lists retired flows too, each as its highest version with `unregisteredAt`. Both are off by default.
- `FlowListVersionsInput.includeTombstoned` and `FlowListInput.includeRetired` are optional; a registry that ignores them lists active versions and flows as before.
- The client: `flows.list({ includeRetired })` and `flows.versions.list(id, { includeTombstoned })`, rows typed `FlowVersionRow` (a `Flow` with `unregisteredAt`).
- The CLI: `kindgi flows list --include-retired` and `kindgi flows versions <id> --include-unregistered`; tables show `UNREGISTERED`.
