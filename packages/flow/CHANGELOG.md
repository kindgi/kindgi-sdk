# @kindgi/flow

## 0.6.1

### Patch Changes

- e975c6f: A Python, Java or Scala pack's flow is now checked as a TypeScript one is. Their indexers check a flow against `flow.schema.json` only, so a flow with a cycle, an edge to or from a step that doesn't exist, no edge from `$start`, or a node id used twice indexed and deployed cleanly, then hung until "Run stuck", completed with nothing run, or skipped a step.
  
  - `@kindgi/flow` exports `flowGraphProblem(flow)`, with its answer type `FlowGraphCheck`: `loadFlow`'s graph checks, run after the schema with every object left open, so a field from a newer SDK is passed over. It answers `ok`, `err` (the error `loadFlow` gives) or `not-judged` (a shape this version doesn't know). `loadFlow` is unchanged.
  - `kindgi dev` and `kindgi build` run it on every indexer's result. A flow that fails is a `manifest-validation-failed` file error (`<module>: flow '<id>' is invalid: <code>: <message>`) and is left out of the index file, so `kindgi dev` never serves it, and `kindgi build` stops. A flow whose shape the CLI doesn't know stays, with a `flow-not-checked` warning.
  - `POST /v1/deployments` refuses a flow that fails them with `deployment-validation-failed`, and the flow's issue message starts with the check's code (`cycle-detected: …`). A flow already deployed keeps running as before; deploying it again is refused until it's fixed. A field or a shape the API doesn't know is passed over, not refused.
  - `@kindgi/pack-conformance` ships an invalid-flow pack per language (`fixtures/<name>-invalid-flow-pack`, whose one flow is `FIXTURE_CYCLE_FLOW_ID`), and a case that its cycle is refused, by the indexer or by `flowGraphProblem` on the index it wrote. A target feeds it through the optional `indexInvalidFlowPack`; a target without it has the case skipped, and the skip says so. Every flow in the fixture pack's index must pass `flowGraphProblem` too. The suite depends on `@kindgi/flow`.
  - `@kindgi/sdk`: the four flow skills (`kindgi-authoring-flows` and its Java, Python and Scala ones) say where a flow is checked: `kindgi dev` and `kindgi build` run the graph checks on every language's flows, and a deploy refuses a flow that fails them.
  
  To upgrade a Python, Java or Scala pack: run `kindgi build` (or `kindgi dev`) once on this CLI before you deploy, so a flow the deploy would refuse shows up as a file error first.
- Updated dependencies [25d902a]
  - @kindgi/types@0.6.1
  - @kindgi/schema@0.6.1

## 0.6.0

### Patch Changes

- 6707cb9: **An agent or a flow can be a tool in a person's chat app.** A new optional field, **`mcp`** (`{ expose, readOnly?, destructive? }`), on agents and flows says whether one is offered as a tool, through the API's MCP server, to the people who can see it. An agent's tool is named by its id, a flow's by `flow.` and its id. With `expose: true`, the id must be a tool's name (letters, digits, `_`, `-` and `.`, at most 128 characters, or 123 for a flow), and an agent's can't start with `kindgi.` or `flow.`, the prefixes Kindgi keeps; the error names the prefix. `readOnly` and `destructive` become the tool's `readOnlyHint` and `destructiveHint`; left out, no hint is sent and the chat app applies the protocol's defaults. Absent, nothing changes: an agent or flow without it is stored and answered as before, with no `mcp` key.
  
  It is in `agent.schema.json` (1.8.0), `flow.schema.json` (1.10.0) and `pack-index.schema.json` (1.9.0); `Agent`, `defineAgent` (which refuses an invalid one), `Flow` and `loadFlow` (a new error, `invalid-mcp-exposure`); `McpExposure` and `mcpExposureIssues` in `@kindgi/types`; the indexed pack agent and flow; `POST /v1/agents`, `POST /v1/flows`, their `GET` answers and a deployment's agents and flows (the API's new `McpExposure` schema); and the Python SDK's `Agent(mcp=...)` and `Flow(mcp=...)`. The authoring skills for agents and flows (TypeScript, Python, Java and Scala) say how to set it.
- 64d1461: **A fan-out in a loop body is refused when the flow is loaded.** A loop body never ran a fan-out: the run failed at the fan-out, with no branch run. `loadFlow` now refuses such a flow with `LoopBodyFanoutError` (`code: 'loop-body-fanout'`), naming the fan-out (`nodeId`) and the loop whose body holds it (`loopNodeId`), at any nesting level. A subgraph node in a loop body can still run a flow that has a fan-out. The flow schema's `LoopBody` description says so.
- Updated dependencies [6707cb9]
  - @kindgi/types@0.6.0
  - @kindgi/schema@0.6.0

## 0.5.0

### Patch Changes

- 1ed72e3: The doc comments and READMEs call the place a workspace, as the console does, and so do the npm descriptions of `@kindgi/capabilities`, `@kindgi/memory` and `@kindgi/policy-contract` and the types package's `SPEC.md`. What you type keeps `tenant`: `tenantId`, `TenantId` and `forTenant`. So does the multi-tenant text.
- 1365f49: The spec schemas' descriptions, the doc text of the types a pack author reads, and the indexer's `check-id-unprefixed` warning call the place a workspace, as the console does. The policy spec's title is Workspace policy. What you type keeps `tenant`: `tenantId`, the `kindgi-tenant-id` header, `KINDGI_PACK_TENANT_ID`, the scope and context-slot value `tenant`, and error codes such as `pack-tenant-mismatch`. So does the multi-tenant text: a cross-tenant call is still refused by that name.
- Updated dependencies [6421d6f]
- Updated dependencies [1ed72e3]
- Updated dependencies [1365f49]
  - @kindgi/schema@0.5.0
  - @kindgi/types@0.5.0

## 0.4.0

### Patch Changes

- 1bd877d: **Choosing what a project runs is a pin, for agents as for flows and tools.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** An agent's `/promotions` is `/pinned/pin`, `/promotions/check` is `/pinned/check`, `/promotions` and `/promotions/{promotionId}` are `/pin-history` and `/pin-history/{changeId}`, `/live` is `/pinned`, `/live-versions` is `/pinned-versions`, and `/live/unpin` is `/pinned/unpin`. `/live/rollback` is removed: going back is a pin of an earlier version, with the same release gate and approval.
  - **Fields and values.**
    - `promotionId` is `changeId`: on a pinned version, in a deployment's pin gate, in a suggested change's `rolledBack` and in a refused pin's `details`. A suggested change's `promotion` is `pin`.
    - A pin's status `promoted` is `pinned`, and the check's outcome `would-promote` is `would-pin`. A pin's action is `pin` or `unpin`.
    - What an agent resolves to: `via: 'live'` is `'pinned'`, and `liveScope` is `pinnedScope`. A run's `via` value `live` is `pinned`, and so is a queue rule's `when.versions` value. A `when.versions` entry that is neither an exact version, such as `1.2.0`, nor `pinned` is a 400.
    - A suggested change's pin: `liveNow` is `pinnedNow`.
    - A test run's comparison baseline `{ live: … }` is `{ pinned: … }`, and a compared version's `via` value `live` is `pinned`. The CLI's `--baseline live` is `--baseline pinned`.
    - Unregistering an agent version that is pinned answers `agent-version-pinned` (was `agent-version-live`), like flows and tools, and the scopes it is pinned in are `pinned` (was `live`).
    - The approval subject `agent-promotion` is `agent-pin`, and the permission `promote` on an agent is `pin`.
    - The audit kinds `agent-promotion`, `agent-promotion-refused`, `agent-live-unpinned` and `agent-live-pin-inactive` are `agent-pinned`, `agent-pin-refused`, `agent-unpinned` and `agent-pin-inactive`. `agent-rollback` is removed, since going back is a pin.
  - **Errors.** `promotion-not-found`, `promotion-superseded` and `promotion-gate-unsupported` are `pin-not-found`, `pin-superseded` and `pin-gate-unsupported`, and `live-scope-spans-environments` is `pin-scope-spans-environments`, the code a flow or tool pin answers, with the same body. `nothing-to-roll-back` is removed with the rollback route. Environment promotion's codes keep their names.
  - **Messages.** A pin's gate checks call the version a test run is measured against "the pinned version" (was "the live version"), and `release-gate-scope-unpinned` says the scope has no pinned version of its own.
  - **Schemas and types.** `Promotion`, `PromotionPage`, `PromotionCheck` and `SuggestedChangePromotion` are `Pin`, `PinPage`, `PinCheck` and `SuggestedChangePin`. `PromoteBody` and `UnpinBody` are `AgentPinBody` and `AgentUnpinBody`. `LivePin`, `LivePinList` and `LiveVersionResolution` are `AgentPinnedVersion`, `AgentPinnedVersionList` and `AgentPinnedVersionResolution`. An agent's pin scope is `AgentPinScope`: its tenant, org and project kinds are the `PinScope*` schemas flows and tools use, and its segment kind is `PinScopeSegment`.
  - **Binding.** A runtime implements `AgentPinnedVersionBinding` (was `LiveVersionBinding`) and `PinBinding` (was `PromotionBinding`), with `AgentPinBindings` and `AgentPinGateDeps` (were `AgentReleaseBindings` and `AgentReleaseGateDeps`). Their types take the `Pin` names: `Pin`, `PinStatus`, `PinAction`, `PinError`, `PinErrorCode`, `PinRequestInput`, `ListPinHistoryInput`, `AgentPinInput`, `AgentUnpinInput`, `AgentPinnedVersion`, `AgentPinResolution` and `AgentPinResolveInput`. `PromotionActor` and `PinActor` are one `PinActor`. `liveScopeCoordinates` is `agentPinScopeCoordinates`. `rollback` and `RollbackInput` are removed. An unregister that a pin refuses answers `pinned` (was `live`). In `@kindgi/types`, `LiveScope` is `AgentPinScope`, and a run's `liveScope` is `pinnedScope` in `@kindgi/runtime` and `@kindgi/agents`.
  - **TypeScript client.** `client.agents.pinned` has `resolve`, `list`, `pin`, `check`, `unpin`, `history` and `getChange`; `client.agents.promotions` and `client.agents.live` are removed. The client's types are `AgentPinnedClient`, `AgentPinnedWhere` (`PinnedWhere` stays the flow and tool lookup), `AgentUnpinInput` and `ListPinHistoryFilter`.
  - **CLI.** `kindgi agents promote` is `kindgi agents pin`, `promotions list|get` is `pin-history list|get`, `live` is `pinned` and `live-versions` is `pinned-versions`. `kindgi agents rollback` is removed. `<promotion-id>` is `<change-id>`, and `--to` went with `rollback`.
  - **Unchanged.** Environment promotion keeps its name: `kindgi promote` and `POST /v1/deployments/{deploymentId}/promotions`.
- Updated dependencies [b25b82f]
- Updated dependencies [d92355b]
- Updated dependencies [d6c9279]
- Updated dependencies [f2adcc2]
- Updated dependencies [9b015f7]
- Updated dependencies [9a8a294]
- Updated dependencies [1bd877d]
- Updated dependencies [dff9515]
- Updated dependencies [d576ff4]
  - @kindgi/types@0.4.0
  - @kindgi/schema@0.4.0

## 0.3.1

### Patch Changes

- @kindgi/schema@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/schema@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/schema@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0
  - @kindgi/schema@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/schema@0.3.0-rc.0

## 0.2.0

### Patch Changes

- Updated dependencies [d70c2a5]
  - @kindgi/schema@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- @kindgi/schema@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- Updated dependencies [d70c2a5]
  - @kindgi/schema@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/schema@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/schema@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/schema@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- 22b619b: **A deployment whose agent or flow carries a schema that doesn't compile is refused, naming where it sits.** `POST /v1/deployments` used to check an index's agents and flows for shape only. An agent's `output.schema`, or a flow's loop, fanout branch or subgraph `outputSchema` or its `output.schema`, that doesn't compile deployed, and then every turn or run refused it. It's now `400 deployment-validation-failed`, as `defineAgent` and the flow loader refuse it: one issue per schema, at its path (`/output/schema`, `/nodes/<i>/branches/<k>/outputSchema`, …). An agent's `output` that isn't an object is refused at `/output`. Each compile counts against the tenant's compile budget, as the deployment's other compiles do.
  - `flowSchemaProblems(flow)` (`@kindgi/flow`) lists every inline schema of a flow that doesn't compile, where a run compiles it, with its path: for a flow that never went through `loadFlow`.
  - `defineAgent` refuses an `output` that isn't an object at `/output`, as the deployment does, instead of throwing a `TypeError` on `null`: `POST /v1/agents` answers `400 validation-failed` for it.
- @kindgi/schema@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/schema@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 22b619b: **A deployment whose agent or flow carries a schema that doesn't compile is refused, naming where it sits.** `POST /v1/deployments` used to check an index's agents and flows for shape only. An agent's `output.schema`, or a flow's loop, fanout branch or subgraph `outputSchema` or its `output.schema`, that doesn't compile deployed, and then every turn or run refused it. It's now `400 deployment-validation-failed`, as `defineAgent` and the flow loader refuse it: one issue per schema, at its path (`/output/schema`, `/nodes/<i>/branches/<k>/outputSchema`, …). An agent's `output` that isn't an object is refused at `/output`. Each compile counts against the tenant's compile budget, as the deployment's other compiles do.
  - `flowSchemaProblems(flow)` (`@kindgi/flow`) lists every inline schema of a flow that doesn't compile, where a run compiles it, with its path: for a flow that never went through `loadFlow`.
  - `defineAgent` refuses an `output` that isn't an object at `/output`, as the deployment does, instead of throwing a `TypeError` on `null`: `POST /v1/agents` answers `400 validation-failed` for it.
- @kindgi/schema@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/schema@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/schema@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7
  - @kindgi/schema@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/schema@0.1.7-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/schema@0.1.6
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/schema@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- Updated dependencies [e27d050]
- Updated dependencies [eff6249]
  - @kindgi/schema@0.1.5
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [e27d050]
- Updated dependencies [eff6249]
  - @kindgi/schema@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4
  - @kindgi/schema@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/schema@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/schema@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/schema@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/schema@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- @kindgi/schema@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/schema@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/schema@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: Flows take plain string ids. `defineFlow`'s `FlowSpec` is now `Unbranded<Flow>`: an author writes `id: 'acme.triage-ticket'`, node `id: 'parse'`, edge `from: 'parse'` with no `as FlowId` / `as NodeId` / `as EdgeId` (and no cast on the whole object); branded ids still fit, and the validated `Flow` is branded. `@kindgi/types` exports `Unbranded<T>` (every branded string in `T` loosened to `string`, all the way down). `runs.start({ flow })` / `({ agent })` take a plain string too.
- aec851d: Flows can say what each step receives and what the run returns (flow schema-version 1.8.0), and a conditional branch that rejoins no longer stalls.
  
  - `@kindgi/flow`:
    - New optional `inputMapping` on tool / agent nodes: each key resolves from `runInput`, `state` or `nodeOutputs.<nodeId>` when the node dispatches, so a step can combine the run input and the outputs of any earlier steps. Without it, a node still receives its single upstream node's output.
    - New optional flow-level `output: { mapping, schema? }` declaring the run's output.
    - `maxParallelism` is now accepted by the schema; it was in the TypeScript type only, so `loadFlow` rejected it.
    - `resolveMapping(mapping, env)` resolves a `Mapping`; a path that does not resolve omits its key.
    - The loader rejects mappings that name no node, map a node's own output, or use a loop-only root, with the new `invalid-mapping` error. An output schema that does not compile is the new `invalid-flow-output` error.
    - Scheduler: a node whose every incoming edge is not taken, or comes from such a skipped node, is skipped. A join after an `if` branch used to wait for the skipped arm forever, so the run ended as stuck.
  - `@kindgi/specs`: `flow.schema.json` 1.8.0 (the `Mapping` and `FlowOutput` definitions; `inputMapping` on leaf nodes; `output` and `maxParallelism` at the root).
  - `@kindgi/handler-runtime`: the indexer validates each discovered flow with `loadFlow`, reporting the loader's message as a file error, and keeps `description`, `maxParallelism`, `metadata` and `output` in `index.json`.
- aec851d: The JSON Schemas now describe what the code accepts (agent 1.1.0, capability 1.1.0, flow 1.9.0, guardrail 1.1.0, pack 1.1.0). The bundled copies in `@kindgi/capabilities`, `@kindgi/flow` and `@kindgi/guardrails` match.
  
  - **BREAKING — `agent.schema.json` 1.1.0:** `tools` entries are `{ id, version }` references (`version` is an npm semver range), matching `ToolRef` and `defineAgent`. Agent JSON with bare-string tool ids — which `defineAgent` already rejected — now fails schema validation too.
  - **BREAKING — `pack.schema.json` 1.1.0:** a pack agent's `tools` use the same `{ id, version }` references (`agent.schema.json#/$defs/ToolRef`). Pack manifests with bare-string tool ids now fail validation.
  - **`capability.schema.json` 1.1.0:** new optional `kind` (default `llm-inference`), which the router already reads, and a `models` requirement (`{ models: { allow?, deny? } }`) next to `providers`. `defineCapability` validates through this schema, so it now accepts both.
  - **BREAKING — `flow.schema.json` 1.9.0:** the top-level `triggers` array is gone. No code read it — schedules, event triggers and webhooks are registered through their own APIs and name the flow they start. Flow JSON that still declares `triggers` now fails `loadFlow`.
  - **BREAKING — `guardrail.schema.json` 1.1.0:** `check` is required, as in the `Guardrail` type (`defineGuardrail` already failed without a registered check), and a `retry` action requires `maxAttempts`. `POST /v1/guardrails` rejects a spec without `check`.
  - **`guardrail.schema.json` 1.1.0 (widening, not breaking):** `kind` and `on-violation` accept any non-empty string — the built-ins are listed as `examples` — so `defineGuardrail`, `validateGuardrailSpec`, the API and the client accept adapter kinds and custom actions. `defineGuardrail` still requires a registered check of the guardrail's kind, and still checks the action's shape. The schema also allows `sandbox`, `limits`, `network` and `needsSpec`, which the type declares, with the same shapes as on tools.
  - **`@kindgi/guardrails`:** when `evaluateGuardrail` runs with `EvaluationBindings.actions` and the fired action has no registered handler, it returns the new `unknown-action` error naming the action (after the violation is recorded) instead of skipping the action silently.
  - **`@kindgi/api` / `@kindgi/client`:** the `Guardrail` wire schema and client types require `check` and `retry.maxAttempts`, and take `kind` / `on-violation` as open strings.
  - **`@kindgi/specs` README:** until the first stable release, a breaking schema change is a minor bump with a version-history note; the major-`$id` rule applies from 1.0.0.

### Patch Changes

- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
