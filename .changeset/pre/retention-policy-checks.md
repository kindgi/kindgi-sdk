---
"@kindgi/policy-contract": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

Retention policies are checked when they're published, a tenant has one per domain, and the retention routes are in the API reference and both clients.

- **`POST /v1/policies` validates a `retention` spec** (`{ v: 1, doc }` or bare): an unknown domain, `mode: "archive"` (not implemented) or a bad grace is `400 validation-failed` naming the field, e.g. `policy.spec/doc/domain must be one of: org, agent, … (got "blocks")`. Before, they were stored and every sweep skipped them.
- **One retention policy per domain**, plus one for `*`. A second policy id for a covered domain is `409 policy-scope-taken` (`details.heldBy` names the policy that covers it: publish a new version of that one, or unregister it first); a new version can't move a policy to another domain (`409 policy-scope-changed`); reinstating a retired policy whose domain another now covers is `409 policy-scope-taken`. `@kindgi/policy-contract` exports `policyScope` (a retention policy's scope is its domain) and `retentionSpecDoc`; `PolicyRegistryBinding.publish` and `reinstateVersion` gain the `scope-taken` and `scope-changed` outcomes, which the binding enforces under a lock. A runtime that doesn't enforce it yet answers as before.
- **Policies stored before that rule** can still cover one domain twice: the policy whose latest version is highest applies, then the lower policy id. `GET /v1/retention/scheduled` and the sweeps report them in `conflicts` (`RetentionPolicyConflict`: the domain, the policy ids, the one that applies).
- **The retention routes are in the OpenAPI spec**: `GET /v1/retention/scheduled`, `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}`. The TypeScript client has `client.retention.scheduled()` and `client.retention.sweep({ domain?, maxPerDomain? })`; the Python client has `client.retention.scheduled()`, `.sweep()` and `.sweep_domain(domain)`, and raises `ConflictError` for `policy-already-registered`, `policy-scope-taken` and `policy-scope-changed`.
