---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/authz": patch
"@kindgi/compliance": patch
"@kindgi/types": patch
"@kindgi/agents": patch
"@kindgi/runtime": patch
"@kindgi/flow": patch
"@kindgi/specs": patch
---

**Choosing what a project runs is a pin, for agents as for flows and tools.** This is a breaking rename, and no old name is kept.

- **Routes.** An agent's `/promotions` is `/pinned/pin`, `/promotions/check` is `/pinned/check`, `/promotions` and `/promotions/{promotionId}` are `/pin-history` and `/pin-history/{changeId}`, `/live` is `/pinned`, `/live-versions` is `/pinned-versions`, and `/live/unpin` is `/pinned/unpin`. `/live/rollback` is removed: going back is a pin of an earlier version, with the same release gate and approval.
- **Fields and values.**
  - `promotionId` is `changeId`: on a pinned version, in a deployment's pin gate, in a suggested change's `rolledBack` and in a refused pin's `details`. A suggested change's `promotion` is `pin`.
  - A pin's status `promoted` is `pinned`, and the check's outcome `would-promote` is `would-pin`. A pin's action is `pin` or `unpin`.
  - What an agent resolves to: `via: 'live'` is `'pinned'`, and `liveScope` is `pinnedScope`. A run's `via` value `live` is `pinned`, and so is a queue rule's `when.versions` value.
  - A suggested change's pin: `liveNow` is `pinnedNow`.
  - A test run's comparison baseline `{ live: … }` is `{ pinned: … }`, and a compared version's `via` value `live` is `pinned`. The CLI's `--baseline live` is `--baseline pinned`.
  - Unregistering an agent version that is pinned answers `agent-version-pinned` (was `agent-version-live`), like flows and tools, and the scopes it is pinned in are `pinned` (was `live`).
  - The approval subject `agent-promotion` is `agent-pin`, and the permission `promote` on an agent is `pin`.
  - The audit kinds `agent-promotion`, `agent-promotion-refused`, `agent-live-unpinned` and `agent-live-pin-inactive` are `agent-pinned`, `agent-pin-refused`, `agent-unpinned` and `agent-pin-inactive`. `agent-rollback` is removed, since going back is a pin.
- **Errors.** `promotion-not-found`, `promotion-superseded` and `promotion-gate-unsupported` are `pin-not-found`, `pin-superseded` and `pin-gate-unsupported`, and `live-scope-spans-environments` is `pin-scope-spans-environments`, the code a flow or tool pin answers, with the same body. `nothing-to-roll-back` is removed with the rollback route. Environment promotion's codes keep their names.
- **Messages.** A pin's gate checks call the version a test run is measured against "the pinned version" (was "the live version"), and `gate-policy-scope-unpinned` says the scope has no pinned version of its own.
- **Schemas and types.** `Promotion`, `PromotionPage`, `PromotionCheck` and `SuggestedChangePromotion` are `Pin`, `PinPage`, `PinCheck` and `SuggestedChangePin`. `PromoteBody` and `UnpinBody` are `AgentPinBody` and `AgentUnpinBody`. `LivePin`, `LivePinList` and `LiveVersionResolution` are `AgentPinnedVersion`, `AgentPinnedVersionList` and `AgentPinnedVersionResolution`. An agent's pin scope is `AgentPinScope`: its tenant, org and project kinds are the `PinScope*` schemas flows and tools use, and its segment kind is `PinScopeSegment`.
- **Binding.** A runtime implements `AgentPinnedVersionBinding` (was `LiveVersionBinding`) and `PinBinding` (was `PromotionBinding`), with `AgentPinBindings` and `AgentPinGateDeps` (were `AgentReleaseBindings` and `AgentReleaseGateDeps`). Their types take the `Pin` names: `Pin`, `PinStatus`, `PinAction`, `PinError`, `PinErrorCode`, `PinRequestInput`, `ListPinHistoryInput`, `AgentPinInput`, `AgentUnpinInput`, `AgentPinnedVersion`, `AgentPinResolution` and `AgentPinResolveInput`. `PromotionActor` and `PinActor` are one `PinActor`. `liveScopeCoordinates` is `agentPinScopeCoordinates`. `rollback` and `RollbackInput` are removed. An unregister that a pin refuses answers `pinned` (was `live`). In `@kindgi/types`, `LiveScope` is `AgentPinScope`, and a run's `liveScope` is `pinnedScope` in `@kindgi/runtime` and `@kindgi/agents`.
- **TypeScript client.** `client.agents.pinned` has `resolve`, `list`, `pin`, `check`, `unpin`, `history` and `getChange`; `client.agents.promotions` and `client.agents.live` are removed. The client's types are `AgentPinnedClient`, `AgentPinnedWhere` (`PinnedWhere` stays the flow and tool lookup), `AgentUnpinInput` and `ListPinHistoryFilter`.
- **CLI.** `kindgi agents promote` is `kindgi agents pin`, `promotions list|get` is `pin-history list|get`, `live` is `pinned` and `live-versions` is `pinned-versions`. `kindgi agents rollback` is removed. `<promotion-id>` is `<change-id>`, and `--to` went with `rollback`.
- **Unchanged.** Environment promotion keeps its name: `kindgi promote` and `POST /v1/deployments/{deploymentId}/promotions`.
