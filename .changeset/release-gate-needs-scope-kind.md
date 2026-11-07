---
"@kindgi/api": patch
---

**`GET /v1/agents/{agentId}/release-gate` says `scopeKind` is required.** The route answers `400` without one (the release gate is resolved for a scope), but its spec listed the parameter as optional, so the Python client's `client.agents.release_gate.resolve` let a caller leave `scope_kind` out and get that `400`. The spec now marks it required, and `scope_kind` is a required argument in the Python client, sync and async. `@kindgi/client`'s `agents.releaseGate.resolve` and `kindgi agents release-gate` already asked for a scope. On `GET /v1/release-gates` and `GET /v1/agents/{agentId}/pin-history`, `scopeKind` stays an optional filter.
