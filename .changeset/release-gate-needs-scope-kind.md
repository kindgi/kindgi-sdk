---
"@kindgi/api": patch
---

**`GET /v1/agents/{agentId}/release-gate` says `scopeKind` is required.** The route answers `400` without one (the release gate is resolved for a scope), but its spec listed the parameter as optional, so the Python and JVM clients generated from it let a caller leave it out and get that `400`. The spec now marks it required. In the Python client, `scope_kind` is a required argument of `client.agents.release_gate.resolve`, sync and async. In the JVM client, `AgentsReleaseGateResolveParams` requires `scopeKind`, and `client.agents().releaseGate().resolve(agentId)`, the overload without params, is gone. `@kindgi/client`'s `agents.releaseGate.resolve` and `kindgi agents release-gate` already asked for a scope. On `GET /v1/release-gates` and `GET /v1/agents/{agentId}/pin-history`, `scopeKind` stays an optional filter.
