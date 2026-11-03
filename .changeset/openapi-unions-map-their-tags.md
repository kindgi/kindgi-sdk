---
"@kindgi/api": patch
---

**Every union in `openapi.json` maps each of its tags to its member.**

- **Nine unions named only the property that tells their members apart:** `AgentPinScope`, `PinScope`, `ServiceAccountGrant`, `ServiceAccountGrantBody`, `ServiceAccountUngrantBody` (and the grants a `CreateServiceAccountBody` lists), `ImproveRunOutcome`, `MCPEndpointAuth` (by `scheme`), `AccessPath` and `ProjectAccessPath`. Each one's `discriminator` now has a `mapping` from each tag, such as `suggested`, to its member's schema, as `WebhookEvent` and the identity-provider unions already did.
- **Why:** without a mapping, a generator may take a member's schema name as its tag. openapi-typescript, for one, typed `ImproveRunOutcome`'s `kind` as `"ImproveRunOutcomeSuggested"`, not `"suggested"`. Types generated that way now name the values the server sends.
- **Nothing on the wire changes.** A test now checks every union in the document: it has a mapping, each member is named once, and each key is that member's tag.
