# @kindgi/client

## 0.1.4-rc.1

### Patch Changes

- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
- f90c285: A comparison's result is typed in both clients. `openapi.json` names its shape as `JudgedComparisonResult`: the `summary` (`JudgedComparisonSummary`, with `ComparisonCandidate` and each `ComparisonMetric`) and each case (`ComparisonCaseResult`). `EvalRun.result` stays an open object, since each kind of eval run has its own.
  
  The TypeScript client exports the types and `comparisonOf(run)` (also from `@kindgi/sdk/client`), which returns a `judged` eval run's result as `JudgedComparisonResult`, or `undefined` for another kind of run, a dry run, or one not finished. The Python client has `comparison_of(run)`, which returns the validated `models.JudgedComparisonResult`, or `None`.

## 0.1.4-rc.0

### Patch Changes

- c313224: **An agent version is pinned when it's published.** `POST /v1/agents` resolves each of the agent's tool ranges once, to the highest active version the range allows (`pickVersion`). It stores the result on the version as `pins` (`{tools, prompts, settings}`: tool id → exact version) with `pinsDigest` (`sha256:<hex>` of the pins' canonical JSON). Every run of that version uses exactly those tool versions. A new tool version reaches the agent only through a new agent version, and two runs of one agent version always run the same tools.
  
  - **A range that matches no published version refuses the publish:** `400 validation-failed`, with one issue per tool (`/tools/<i>/version`, "publish the tool first").
  - **Pins are set by the runtime, never authored.** `defineAgent` doesn't take them, and a publish body's `pins` is ignored.
  - **`GET /v1/agents/:id/versions/:version` returns `pins` and `pinsDigest`**, as do both clients. Python adds `pins_digest()` in `kindgi.client`, which gives the same string as `pinsDigest()` in `@kindgi/agents`.
  - **Unchanged:** a version published before pins, or by a runtime without a tool registry, has no pins and resolves its ranges per run. `agentsRouter` takes the tool binding as an optional third argument, and `createApp` passes its `toolRegistry`.
- 024a47f: **An agent's prompt and settings can come from data blocks, pinned when the agent version is published.**
  
  - **References:**
    - `instructions` is the system prompt, or a prompt block by range: `{ prompt: 'acme.intake-prompt', version: '^1.0.0' }`. Its template and declared parameters are used instead.
    - `settings: [{ id, version }]` lists settings blocks.
    - `modelSettings: { id, version }` names a model-settings block (`MODEL_SETTINGS_SCHEMA`: `temperature`, `maxOutputTokens`).
  - **Pinned at publish:** `POST /v1/agents` and deploys resolve each reference by `pickVersion` into `pins.prompts` / `pins.settings`, alongside the tools.
  - **Refusals:** a reference that matches no published version, names a block of the other kind, names model settings that aren't, or runs on a runtime with no block registry refuses the publish (`400 validation-failed`).
  - **At run time:** a turn loads each block at its pinned version. A resumed turn uses the versions its `setup` journaled (`blockVersions`).
    - The prompt block renders as the instructions.
    - Settings values reach tools as `ToolContext.settings['<id>']` and templates as `settings["<id>"]`.
    - Model settings go into the model call.
    - A block that can't load fails the turn (`block-unresolvable`).
    - `InvokeAgentBindings` takes an optional `blockReader`.
  - **Changed elsewhere:** the agent spec, the pack index, both indexers (TS and Python: `Agent(instructions={...}, settings=[...], model_settings={...})`), and both clients.
  - **Pack protocol 2.4.0:** `callContext` gets optional `settings`, so pack code reads them: `ctx.settings['acme.weights']` in TS, `ctx.settings["acme.weights"]` in Python. Older pack services still answer calls that carry it: a TS one passes it to the handler, a Python one drops it.
  - **`settings` is now a reserved template name.**
- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- a311b81: `GET /v1/cost/aggregate` returns at most 1000 groups by default: the most expensive ones. `groups` is ordered by `totalUsd`, highest first (ties by key, groups with no value last); before, the order was undefined and every group came back in one response, one per run for `groupBy=runId` over a long window. `?limit=` takes 1 to 10000 (anything else is `400 bad-input`). The response says when groups were left out: `truncated: true` and `totalGroups`, the count before the cap. `totalUsd`, `totalRecords` and `tokens` still cover every record. For every record, page through `/v1/cost/records`. **A caller that gets more than 1000 groups today gets 1000, with `truncated: true`**, unless it passes a larger `limit`. A `CostBinding` may cap in its own query (`CostAggregateInput.limit`, returning `totalGroups`); one that returns every group is capped by the route. `@kindgi/api` exports `COST_AGGREGATE_DEFAULT_LIMIT` and `COST_AGGREGATE_MAX_LIMIT`. The TypeScript and Python clients take `limit`.
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
- fa6680c: **A deploy pins its agents and never keeps a version's old pins.** `POST /v1/deployments` pins each agent as `POST /v1/agents` does. A deploy registers an agent under the version its definition names. When that version is already registered with other pins or content (versions never change), the deploy registers the next free version in its line instead (`1.4.0` → `1.4.1`, `1.4.0-rc.1` → `1.4.0-rc.2`). A deploy never refuses a routine deploy over this.
  
  - **Why a new version:**
    - `pins-changed`: a tool the agent uses has a new version in range.
    - `unpinned`: the version was published before pins existed.
    - `version-taken`: the number is registered with another definition.
  - **Redeploys are idempotent.** A redeploy finds the version an earlier deploy registered for the same definition and pins.
  - **The record:**
    - The registered version records `derivedFrom: {version, reason}`.
    - The deployment's `contents.agents` names each agent's registered `version`. Where it differs from the definition's, it also gives `authoredVersion`, `reason`, `newVersion` and `pinChanges`.
  - **`kindgi deploy` prints one line per such agent:** `agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match`.
  - **A range that matches no published version refuses the deploy:** `400 validation-failed`, with one issue per tool (`/agents/<i>/tools/<j>/version`), and the deploy's tools are rolled back.
  - **New exports:**
    - `@kindgi/agents`: `pinChanges()` and the `AgentDerivation` and `PinChange` types.
    - `@kindgi/tools`: `nextVersion()`.
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- d3dffb5: Comparison eval runs take a flow version as the candidate. On a test set built from a flow's judged runs, `POST /v1/eval-suites/{suiteId}/runs` with `flowRef: { flowId, version }` replays each case on that flow version (from the past run's input) and scores the flow's whole output against the judgments.
  
  A replayed flow stops at a tool call the replay refuses (a write the past run didn't make), so no made-up value reaches its next step. The case ends `stopped`, with what it would have done. It isn't an error and is left out of the metrics. The summary counts these cases in `stopped`, next to `errors`, and the run's status stays `completed` when cases only stopped.
  
  The summary's `candidate` now says what ran, `{ kind: 'agent', agentId, version }` or `{ kind: 'flow', flowId, version }`, and `baseline.versions` names a flow's recorded versions as `{ flowId, version, cases }`. The subject invoker reports a stop through `EvalRunSubjectInvokeOutcome.stopped`.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- b67eee6: A judged flow run keeps what it did, so it can be replayed later. At a flow run's first judgment, its run copy's `context.flow` keeps:
  - every tool call the run made, with its result: at its tool nodes (per loop iteration), in its agent steps' turns, and in its sub-flows (at most 500, with `truncated`);
  - its agent steps (each turn's agent, version and what it retrieved).
  
  `createApp` passes its `flowRegistry` to the judgments routes to tell tool nodes apart. The capture is best effort: a part that can't be read is left out, and the judgment never fails over it. Judging a run needs `write` on the run's project (the route's own description now says so).
- 7a8e764: A duplicate org, team or project slug is a `409 slug-conflict`, not a `500`. `POST /v1/orgs`, `/v1/teams` and `/v1/projects` with a slug the tenant already has, and a `PATCH` to one, answered `500`; now `409 slug-conflict` (`Another project in the tenant has the slug "acme"`, with `details: { resource, slug }`), whether or not the deployment enforces authorization. A second Default project is `409 project-default-already-exists`. A `PATCH` of a missing org, team or project, a member added to a team or project deleted mid-request, and a role change for a non-member answer their `404`s from the binding's outcome instead of matching an error message. The TypeScript and Python clients read both new codes as a conflict (`ConflictError` in Python).
  
  **Breaking for custom platform bindings.** `OrgBinding`, `TeamBinding`, `ProjectBinding`, `TeamMembershipBinding` and `ProjectMembershipBinding` writes no longer reject for a caller mistake; they resolve to an outcome discriminated on `kind`: `create` to `{ kind: 'ok', orgId | teamId | projectId }`, `slug-conflict` or (projects) `project-default-already-exists`; `update` to `ok`, `*-not-found` or `slug-conflict`; a membership's `add` and `updateRole` to `ok`, `team-not-found` / `project-not-found` or `*-membership-not-found`. The types are exported (`OrgCreateOutcome`, `ProjectUpdateOutcome`, …). The in-memory bindings keep slugs unique within a tenant. `TenantHierarchyBinding.addTeamMember` / `addProjectMember` fail with `AddTeamMemberError` / `AddProjectMemberError` (`team-not-found` / `project-not-found`, or `add-failed`), which replace `MembershipMutationError`. A binding of your own needs the same changes; the conformance suites in `@kindgi/platform`'s `tests/` check them.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 3d23304: A project's slug is unique within its org, not the whole tenant: two orgs may each have a project called `intake`. A project without an org has a slug unique among the tenant's projects without one. An org's and a team's slug stay unique in the tenant.
  
  - **`409 slug-conflict`** on `POST /v1/projects` when the org already has the slug. `PATCH /v1/projects/:id` answers it for a new slug, and now also for a move to another org (`orgId`, or `null` for none) where the slug is taken. The message says where: "Another project in its org has the slug …".
  - **Deleting an org** leaves its projects without an org. When one of them has the slug of a project that has none, `DELETE /v1/orgs/:id` deletes nothing and answers `409 slug-conflict` naming the slugs (`details.slugs`); rename or move those projects first. `OrgBinding.delete` may return `{ kind: 'slug-conflict', slugs }` (`OrgDeleteConflict`). A binding that returns nothing deletes as before.
  - The in-memory `ProjectBinding` checks slugs per org, and the binding conformance suite pins the per-org cases.
- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
- bfeabfd: Publishing a policy that nothing applies is refused. `access-control`, `adapter-allowlist`, `rate-limit` and `compliance` are known policy kinds, but no runtime consumer applies them yet, so publishing one changed nothing, silently. `POST /v1/policies` now answers `400 kind-not-applied` for them, naming the kinds it does apply in `details.appliedKinds` (`model-routing`, `retention`, `tool-errors`, `hitl`). Policies of those kinds already stored stay readable, and the list still filters by them. `@kindgi/policy-contract` exports `APPLIED_POLICY_KINDS` and `isAppliedPolicyKind`; `@kindgi/api` re-exports `APPLIED_POLICY_KINDS`.
- d0ebeb6: Replay turns: an agent turn can re-run a past run for an eval run without doing anything the past run didn't do.
  
  - `@kindgi/agents`:
    - `InvokeAgentInput.replay` (`{ of, evalRunId }`) marks a turn as a replay. It is kept on the turn's run and in its run snapshot (new nullable `agent_run_snapshots.replay` column), so a resumed turn stays a replay.
    - The new optional `InvokeAgentBindings.replay` (`ReplayBinding`) decides each tool call:
      - `live`: the tool runs;
      - `recorded`: the past run's result is used;
      - `refused`: the model gets the given result.
    - Whatever the binding says, only a tool declared read-only (`mutating: false`, no writing effect, see `isReadOnlyTool`) with no approval to wait for runs. A replay with no binding refuses every call.
    - Each decision is journaled, and `AgentTurnResult.replay` lists them. A refused call shows what the turn would have done.
    - `retrievals` can supply the past run's retrieved facts. `sessionApproval` gives the past run's decision at the session approval gate, which the replay follows (a recorded rejection fails the turn with `hitl-rejected`). Without a recorded decision the gate is skipped, and the result says so.
    - `tool.completed` events carry `replay: 'live' | 'recorded' | 'refused'`.
  - `@kindgi/runtime`: `RunReplayRef`; `replay` on `runGraph` and `startRun`; `replayOf` and `evalRunId` on `KernelRunRecord`; `replays` and `evalRunId` on `ListRunsInput`.
  - `@kindgi/capabilities`: `ModelUsageRecord.replay` tags a replay's model calls with the past run and the eval run.
  - `@kindgi/api`:
    - A run carries `replayOf` and `evalRunId`.
    - `GET /v1/runs` leaves replay runs out unless `replays=include|only`; `evalRunId` lists one eval run's replays.
    - A judged agent turn's captured `context` also keeps `sessionApproval`, the decision at its session approval gate.
  - `@kindgi/client`: `runs.list({ replays, evalRunId })`; the Python client too.
  - `@kindgi/cli`: `kindgi runs list --replays=<exclude|include|only> --eval-run=<id>`.
- 62608e3: **Unregister stops a version being chosen, not the pins that hold it.**
  
  - **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
    - Only its exact version (`getVersion`, `hasVersion`) reaches it.
    - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
  - **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
  - **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
  - **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.

## 0.1.3

### Patch Changes

- 2544717: An approval says who decided it, after the decision: on the API, in the run's journal, and in the turn's provenance.
  
  - **API.** `GET /v1/approvals/:id` and `GET /v1/approvals` carry an approval's recorded `decision` (`ApprovalDecisionRecord`): `decision`, `rationale`, `reviewerId`, `reviewerRoleAtDecision`, `decidedAt` and `decidedBy`, the decider as an actor, `user:<userId>`. An open approval, or one that ended without a decision (expired, or escalated by a timeout), has none. The TypeScript client types it (`Approval.decision`, `ApprovalDecisionRecord`), and the Python client models it.
  - **Journal.** `POST /v1/approvals/:id/complete` resumes the run with `{ decided, rationale?, decidedBy, approvalId }` (`GateDecisionValue`, exported by `@kindgi/agents`), so the run's journal records who decided which approval. `readGateDecision` reads `decidedBy` and `approvalId` when they're there; a value without them still decides. Another subject's explicit `value` is resumed as given.
  - **Provenance.** A tool call that waited on an approval has a `wait` node (`tool-hitl-gate-wait:<invocationId>`, the agent parked, at the time it parked) `resumed-from` a `resume` node (`tool-hitl-gate-resume:<invocationId>`, at the time the decision came; its `actor` is whoever decided, and its attributes the decision, rationale and `approvalId`). The call `waited-on` the wait, and its result was `caused-by` the resume. A resumed turn reads them from its journal, so every call shows its approval, those decided before an earlier park too. The session gate's `resume` node names whoever decided as its `actor` (the agent, for a decision recorded before it was named), with the `approvalId`.
  - **For a custom `HitlBinding`:** return each approval's `decision` from `getApproval` and `listApprovals`, with `ReviewDecisionRecord.decidedBy`, for them to show; both are optional, and a binding without them answers as before.
- 629057d: Every model call is recorded, with everything the provider says about it, and the cost API reads it per call, per run tree, and per org.
  
  - **Usage recording.** The agent turn records each model call in a usage sink (`InvokeAgentBindings.usage`, `UsageSink` / `ModelUsageRecord` in `@kindgi/capabilities`) before the step goes on, a call that threw included. The record carries the call id, project, run, agent and version, conversation, step, provider, the model actually called, a fallback flag, status, usage, duration and finish reason; a failed call's error carries the attempts it took. llm-judge guardrails record theirs too (`EvaluationBindings.usage`, `purpose: guardrail-judge:<id>`, with the turn's step and agent version). A dry run records nothing.
  - **A sink that fails** is tried again (`recordModelUsage`; a record is idempotent by call id). An answered call it still can't record fails the step with `persistence-error` (an llm-judge's is `judge-usage-unrecorded`, which the turn fails on the same way). A failed call keeps its own failure, and says when it couldn't be recorded either.
  - **Usage, unfolded.** `UsageCounters` reports the parts of its totals: `cacheReadTokens` and `cacheWriteTokens` are parts of `promptTokens`, `reasoningTokens` of `completionTokens`. A part is there when the provider reports it, a reported 0 included, and absent when it doesn't. `ModelCallResult` adds `servedModel` (the exact version the vendor reports), `providerRequestId`, `attempts` (HTTP attempts, the SDK's own retries included, counted with `createAttemptCounter` from `@kindgi/capabilities/attempts`, a Node-only entry; a call that throws keeps its own error, and `attemptsOf(error)` gives its attempts) and `rawUsage` (the vendor's usage object as it reported it). The Anthropic, Gemini and OpenAI-compatible adapters fill them.
  - **Breaking, for a custom model adapter:** `UsageCounters.cachedTokens` is renamed `cacheReadTokens`.
  - **Breaking, for a custom `CostBinding`:** `tokens` is required on `CostAggregateGroup` and `CostAggregateResult`, and a binding that can't read should throw (the API answers 500) rather than return an empty page.
  - **Cost API (`@kindgi/api`, `@kindgi/client`).** A cost record of a model call carries `callId`, `projectId`, `rootRunId`, `parentRunId`, `agentVersion`, `flowId`, `nodeId`, `step`, `purpose`, `model`, `servedModel`, `fallback`, `status`, `usage`, `durationMs`, `finishReason`, `providerRequestId`, `attempts` and `error`, and `rawUsage` with `include=rawUsage`. New filters: `model`, `servedModel`, `rootRunId`, `includeDescendants` (with `runId`). New `groupBy` dimensions: `model`, `servedModel`, `projectId`, `orgId`, `rootRunId`, `flowId`. Every aggregate group and the total carry `tokens: {prompt, completion, cacheRead, cacheWrite, reasoning}`. A binding that fails answers 500, never an empty page. `to` is exclusive, as the binding always applied it. The TypeScript client takes `scope`, the new filters and `includeRawUsage`.
  - **`run.finished`** carries `usage: {calls, costUsd, tokens}` (`RunTreeUsage`) for the run tree, when the runtime records usage: what the ledger had recorded when the run finished, failed calls counted (a child run still running then isn't in it).
  - **Clients:** `includeDescendants` is a boolean query parameter; the Python client names a cost record's error `ModelCallError`.
  - **Provenance (breaking for readers of `model-call` attributes):** a `model-call` node keeps the call's identity (`callId`, `providerId`, `model`, `finishReason`, `step`); its `promptTokens`, `completionTokens` and `costUsd` are gone from `attributes`. A provenance read carries them in `callUsage`, by `callId`, from the cost ledger, outside the signed DAG (`ProvenanceBinding.getCallUsage`). A signed export includes `callUsage` as it stood when signed (bundle schema `1.1.0`).
- 1463b77: Approvals, conversations and provenance list by project, as runs do. `GET /v1/approvals`, `GET /v1/conversations` and `GET /v1/provenance` take `scopeKind=project|org` + `scopeId`: one project's records, or every project's in an org. A `scopeId` that isn't a UUID is `400 scope-invalid`. The records say their project:
  - an agent's approvals are enqueued in the turn's project (`HitlEnqueueInput.projectId`);
  - a conversation has `projectId`, set by the run that opens it or by `POST /v1/conversations`' new `projectId` (one of the tenant's projects, else `400 bad-input`; omitted, the tenant's Default project, as for a run); `agent_conversations` gets a nullable `project_id` (migration `0003`);
  - a provenance record's list row has `projectId`, which the emitter passes beside the signed document (`ProvenanceEmitBinding.emit(provenance, { projectId })`).
  
  `ListScope` (`@kindgi/types`) is the scope of each binding's list input. TypeScript client: `scope` on `approvals.list`, `conversations.list` and `provenance.query`, and `projectId` on `conversations.open`; the Python client takes `scope_kind` / `scope_id` and `project_id` (regenerated). Records from before this release have no project, so only a list without a scope shows them (nothing is backfilled).
- 453056f: A registered reviewer can use the approvals surface with any token of theirs. The approvals routes refused every token that didn't carry a `reviewerRole` itself, so a reviewer signed in through OAuth, or calling with an API key, got 403 on `/v1/approvals`. Now a token with no role of its own takes the role the reviewer roster gives its user (`ReviewerBinding.resolveReviewerRole`), and `GET /v1/identity/whoami` reports the same role. A token with no user, or a user who isn't a reviewer, is still refused, and the 403 says how to register one (`kindgi reviewers register`).
  
  - **For a custom `ReviewerBinding`:** implement the new optional `resolveReviewerRole({ tenantId, userId })` (the user's reviewer role in the tenant, or `null`) for its reviewers' sessions and API keys to work; without it, only a token that carries its role reviews, as before.
- 6bae409: An agent's turn names its agent. The run record of an agent run, and of the turn a flow's agent step starts, carries `agent`: the agent's id, the version that ran and the conversation (`RunAgentRef` in `@kindgi/runtime`, `Run.agent` on the wire, the `RunAgent` schema). `GET /v1/runs?agentId=` lists one agent's turns, at every version; it combines with the scope, `topLevel` and the cursor. The TypeScript client takes `runs.list({ agentId })`; the Python client `runs.list(agent_id=…)`. Turns that ran before this release don't name their agent: they have no `agent` and aren't listed by `agentId`.
- ab23a9b: A run id that isn't one is a 400. `GET /v1/runs/not-a-uuid` (and the run's `progress`, `journal`, `stream`, `progress/stream` and `cancel`) answered `500`, from the database's uuid cast; now `400 bad-input` "`runId` must be a run id (a UUID)", before any query. A `parentRunId` filter that isn't a run id is a 400 too. And the OpenAPI `runs.list` operation declares the `scopeKind` / `scopeId` filter it already took: `ListRunsFilter.scope` in the TypeScript client and `scope_kind` / `scope_id` in the Python client list one project's runs, or every project's in an org. The TypeScript client's scopes (runs, cost, env, secrets, MCP endpoints) take a `ScopeRef`: `{ kind: 'project', projectId }` or `{ kind: 'org', orgId }`, with no `tenantId` needed (the API takes the tenant from the token; a `Scope` with one still fits).

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.

## 0.1.1

No changes in this release.

## 0.1.0

### Minor Changes

- aec851d: API keys are service accounts with a role and capabilities, and they can be listed.
  
  - **`@kindgi/api`:**
    - `POST /v1/tokens` takes `role` (`admin` | `member`, default `member`) and `capabilities`.
      - Only a tenant admin can mint (`admin` on the tenant with authorization on, otherwise the `tenant-admin` scope), and only capabilities the caller holds can be granted.
      - The response is the key's record plus its `token`, shown once.
    - New `GET /v1/tokens` (paged, newest first) and `GET /v1/tokens/{tokenId}`. They're tenant-admin only and never return secrets. Revoke is tenant-admin only too.
    - `TokenAdmin` gains `list` and `get`. `mint` takes `role`, `capabilities` and `createdBy`, and returns `{ record, token }`. New types: `ApiTokenRecord`, `ApiTokenRole`, `API_TOKEN_ROLES`.
    - `TokenResolution.tokenId` is a durable key's id. The principal is then `service_account:<tokenId>`, and it wins over a session id.
  - **`@kindgi/client`:**
    - `tokens.create(spec?)` sends `role`, `capabilities`, `label`, `expiresAt` and `projectId`, and returns the server's record. `ApiTokenSpec` and `ApiToken` drop `name`/`scopes` for `label`/`role`/`capabilities`.
    - `tokens.list({ limit, cursor })` and `tokens.get(id)` are wired.
    - The unwired `tokens.scopes()` and `TokenScope` are gone.
- aec851d: A deployment's tools and guardrails keep where their code is, and the trust list it's verified against gets routes.
  
  - **`@kindgi/api`, `POST /v1/deployments`:**
    - **What registers is the signed image's index.** The server reads `/app/index.json` from the image, checks it hashes to the signed `indexHash`, and registers what it declares. The request body no longer carries `index`. Before, the route validated and registered the body's copy, which no signature covers, so a replayed request could register tools the image never shipped. The image's index must also name the signed `artifactVersion` (`400 image-unverifiable` otherwise).
    - **The code pointer.** A tool's `modulePath` and a guardrail's `checkModulePath` become `codeArtifactRef: { kind: 'oci', imageRef, modulePath, artifactVersion }`, pointing into the deployed image. Before, they were stripped, so a deployed pack tool had no code the runtime could reach.
    - **What a deployment shipped.** The record gains `contents`: each tool's, agent's and flow's `{ id, version }`, and each guardrail's `{ id }`. `DeploymentRegisterInput` and `Deployment` carry it; it's required, so a `DeploymentBinding` stores it. Versions are immutable and a digest deploys once, so the latest deployment is the live one. A rollback rolls forward: deploy the earlier code again under new versions.
    - **The catalog caches hear of it.** A new deployment calls `onToolWrite` / `onGuardrailWrite` for each tool and guardrail it registered, as `POST /v1/tools` and `POST /v1/guardrails` do, so a runtime's tool and guardrail bridges see it at once. `DeploymentContents` and `DeployedPrimitive` are exported.
    - **Indexed guardrails deploy.** A guardrail's `checkId` becomes its `check`, and the index-only `configSchema` is dropped, as `kindgi dev` maps them. Before, every guardrail the indexer writes failed validation.
  - **`@kindgi/api`, `/v1/signing-keys`:** the tenant's trusted signing keys, the public keys whose deployments verify. Mounted when `signingKeyRegistry` is passed, on its own, without the deployments route.
    - `POST /v1/signing-keys` trusts a key: `keyId`, `publicKey` (base64 Ed25519), `label?`. It returns `201`, or `200` for the same key again. A known id with another key is `409 signing-key-conflict`; rotate under a new id.
    - `GET /v1/signing-keys` lists the active keys (`?includeRevoked=true`, `?label=` prefix). `GET /v1/signing-keys/{keyId}` returns one key, revoked or not.
    - `POST /v1/signing-keys/{keyId}/revoke` takes an optional `reason`. A revoked key stays readable for audit and verifies no new deployments.
    - Writes need the `signing-keys:write` capability.
    - Revocation is final: trusting a revoked key id again is `409 signing-key-revoked`.
    - New error codes: `signing-key-conflict` (409), `signing-key-revoked` (409), `signing-key-algorithm-unsupported` (400), `signing-key-store-error` (500).
  - **`@kindgi/client`:** `client.signingKeys` (`trust`, `list`, `get`, `revoke`); `deployments.register` takes no `index`. The Python client's models and resources follow.
  - **`@kindgi/env-schema`:** the `image-registry` group, how the server reads deployment images: `KINDGI_IMAGE_REGISTRY_HOST`, `_USERNAME`, `_PASSWORD` (credentials for one host, all three or none) and `_INSECURE_HOSTS` (hosts reached over plain HTTP).
- aec851d: Flows take plain string ids. `defineFlow`'s `FlowSpec` is now `Unbranded<Flow>`: an author writes `id: 'acme.triage-ticket'`, node `id: 'parse'`, edge `from: 'parse'` with no `as FlowId` / `as NodeId` / `as EdgeId` (and no cast on the whole object); branded ids still fit, and the validated `Flow` is branded. `@kindgi/types` exports `Unbranded<T>` (every branded string in `T` loosened to `string`, all the way down). `runs.start({ flow })` / `({ agent })` take a plain string too.
- aec851d: What a tenant registers can no longer reach the server's own host unless the deployment allows it, and MCP endpoints authenticate through the secrets store.
  
  - **`KINDGI_TENANT_HOST_ACCESS`** (`@kindgi/env-schema`): `deployed` refuses a `stdio` MCP endpoint, a command the server would run in its container as its user. `local` allows it, for a machine where every token holder may run commands. Unset, it's `local` under `KINDGI_DEV` and `deployed` otherwise.
  - **`@kindgi/api`:**
    - `createApp` takes `tenantHostAccess` (default `deployed`). Under `deployed`, registering a `stdio` endpoint answers `403 host-access-denied`, a new error code.
    - `deniesHostReach`, `parseTenantHostAccess`, `TENANT_HOST_ACCESS_LEVELS` and `stdioRefusal` are exported for the runtime's connect-time check. Checks ask `deniesHostReach(level, reach)`, so a stricter level is one more row.
    - `mcpRouter` takes the level as a fourth argument.
  - **`MCPEndpoint.secretRef: { envName, name }` replaces `authRef`.** It's a secret by name in the deployment's store, resolved at the endpoint's tenant scope, the shape webhooks and providers use.
    - `env:NAME` references, which read the server's own environment, are gone.
    - The register body now refuses unknown fields, so an `authRef` is a `400` (`unknown-field`), not silently dropped.
    - The webhook routes and MCP share one `secretRef` parser.
  - **`@kindgi/client`:** `McpEndpoint` and `RegisterMcpEndpointInput` take `secretRef` (`McpEndpointSecretRef`). The Python `kindgi.client` is regenerated: `secret_ref` replaces `auth_ref`.
- aec851d: A tool reads back the way it was registered: the wire shape carries the whole manifest.
  
  - **`@kindgi/api`:**
    - `GET /v1/tools`, `GET /v1/tools/{toolId}` and the versions routes now return `mutating`, `sandbox`, `limits`, `network`, `needsSpec`, `codeArtifactRef` (where the code runs: the deployed image and module) and the declarative `spec`. Before, they dropped them, so nothing reading the API could see where a pack tool's code runs or how it's sandboxed. A secret appears only as a reference (`secretRef`), never a value.
    - The `Tool` schema (and `RegisterToolBody`, `ToolVersionRow`) declares those fields. They were accepted and stored already, but undocumented, so a typed client couldn't send them without a cast.
    - New components: `SandboxMode`, `RuntimeLimits`, `NetworkPolicy`, `TypedNeeds`, `CodeArtifactRef`, `ToolSpec`, and the declarative HTTP tool's `HttpToolSpec`, `HttpHeaderSpec`, `HttpAuthSpec`, `HttpRequestBodySpec`, `ToolSecretRef`. Each is a mirror of `@kindgi/specs/tool.schema.json`. The schema drift test now holds Tool's property names, and each of these, equal to the spec.
  - **`@kindgi/client`:** the tool types gain the fields. The Python client's models follow.
- aec851d: Fallback providers. `ProviderMetadata.fallback: true` makes a provider serve a capability only when no other provider satisfies it; `route()` then reports `fallback: true`, and a fallback is never an alternate to a regular pick. An agent turn routed to one carries a `fallback-provider` warning (`AgentTurnResult.warnings`). `dev-echo` is a fallback, so registering a real model takes over from it with nothing to switch off — before, ties went to the provider id that sorts first, and `dev-echo` beat `gemini`, `groq` or `ollama`. `POST /v1/providers` accepts and returns `fallback`; the clients carry it. The providers and getting-started skills describe it, and register Anthropic or Gemini with `kindgi providers register --preset` (the CLI's presets).
- aec851d: Public run tokens: a browser can follow a run's progress without a secret API token.
  
  - `@kindgi/api`:
    - `CreateAppInput.publicRunTokens` (`signingKey` + `keyId`, an Ed25519 key; lifetimes; `allowedOrigins`). When set, `POST /v1/runs` returns `publicAccessToken` + `publicAccessTokenExpiresAt` (15 minutes by default), and `POST /v1/tokens/public` mints tokens for up to 50 runs (at most 24 hours).
    - Progress routes: `GET /v1/runs/{runId}/progress` (`RunProgress`: status and timing, no input, output or failure message) and `GET /v1/runs/{runId}/progress/stream` (`RunProgressEvent`: kind, node, sequence, time; no payload). They accept an API token or a public run token. `GET /v1/runs/{runId}` and `/stream` are unchanged and keep requiring an API token.
    - A public run token (`kgi_pt_…`, Ed25519-signed, stateless) is accepted only by the two progress routes (every other route answers 403), for the runs it names and their descendants (others answer 404).
    - The routes a public token may use come from the operation registry (`security: 'bearer-or-public-run'`); the OpenAPI document declares the `publicRunToken` security scheme on them.
    - CORS for `allowedOrigins` on the two progress routes only, ahead of authentication.
    - `mintPublicRunToken` / `verifyPublicRunToken` for deployments that issue tokens themselves.
  - `@kindgi/client`:
    - `subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })`: follow a run's progress from a browser with a public token, refreshing it when it expires.
    - `runs.progress`, `runs.streamProgress`, `tokens.createPublic`.
    - `runs.stream` now follows the run to its terminal event: when the server ends the stream at its time limit, it reconnects from the last event instead of ending early. `followRun` is the shared loop; `readSse` takes `lastEventId` and per-attempt `headers`, and throws `SseHttpError` (with `status`) on HTTP errors.
  - `@kindgi/env-schema`: `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` and `KINDGI_CORS_ORIGINS`.
- aec851d: Runs return their output, record which run started them, and can be started without waiting.
  
  - `@kindgi/api`:
    - Run responses (`GET /v1/runs/:runId`, start, cancel, resume) include `output` once the run completed. Lists include it only with `?include=output`.
    - A child run carries `parentRunId` and `parentNodeId`. `GET /v1/runs` filters with `?parentRunId=` (a run's children) or `?topLevel=true`.
    - `POST /v1/runs` accepts `options.wait: false`: the binding returns the run id as soon as the run exists and the route answers `202`. The default still answers `201` once the run completes, fails or suspends. `InvokeAgentBindingInput` and `InvokeFlowBindingInput` gain `wait`.
    - `POST /v1/runs/:runId/resume` resumes the run through the host's run handler after completing the waitpoint; the run used to stay suspended. Waitpoint ids starting with `child:` are reserved for the runtime (`400`).
    - New status mappings: `flow-unbound`, `flow-runs-not-supported` and `flow-resume-not-supported` → `422`.
  - `@kindgi/runtime`:
    - `ParentRunRef`, and `parent` on `RunFlowInput` / `StartRunParams`.
    - `RunFlowInput.runId` adopts a `pending` row created by `startRun`.
    - `HandlerResolver` (`handlerResolver` on `RunFlowInput` / `ResumeRunInput`) binds handlers for child flows.
    - `KernelRunRecord.parentRunId` / `parentNodeId` / `parentScope`; `ListRunsInput.parent` and `topLevelOnly`.
    - `KernelRunRecord.output` is documented as the output value itself, not a storage envelope.
  - `@kindgi/client`: `Run.output`, `Run.parentRunId` / `parentNodeId`; `runs.list({ parentRunId, topLevel, includeOutput })`; `StartRunOptions.wait`.
- aec851d: Fine-grained authorization now checks the scope a request acts on. Each route derives its scope once, with the same parser for the check and the handler.
  
  - `/v1/env` and `/v1/secrets`: the check reads `scopeKind` + `scopeId`, the parameters the handlers use. It previously read `projectId` / `orgId` query parameters, which are not part of the API, so a request could be checked against one scope and act on another, and project-scoped callers using `scopeId` were checked against the tenant.
  - `POST /v1/secrets/{name}/rotate`: the scope comes from body `scope`, else from the query; when both are present they must name the same scope (400 `scope-mismatch`), and body `envName` must match query `envName` (400 `env-name-mismatch`). The OpenAPI document now declares the optional `envName`, `scopeKind` and `scopeId` query parameters.
  - `POST /v1/mcp/endpoints`: the check reads body `scopeKind` + `scopeId`, as the handler does. `RegisterMCPEndpointBody` now declares them (`scopeKind` required).
  - Registry lists (`/v1/agents`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites`): a project filter (`scopeKind=project&scopeId=`) requires `read` on that project.
  - Env and secrets routes run one authorization check per request (previously two).
  
  `@kindgi/client`: `mcp.endpoints.register` takes a required `scope` and sends it as `scopeKind` + `scopeId`; the API has always required them, so registering through the client failed before. `not-yet-wired` reasons for `tools.manifests` and `packs.*` are reworded.
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
- aec851d: Outbound webhooks: endpoints that receive a signed `run.finished` event when a top-level run completes, fails or is cancelled.
  
  - `@kindgi/api`:
    - `WebhookEndpointBinding` (caller-plugged) and `/v1/webhook-endpoints`: create (the response carries the signing secret, once), list, get, update, `unregister`, `rotate-secret`, the delivery log (`/deliveries`, with a status filter), `redeliver`, and `test` (queues a `webhook.test` event).
    - Endpoint filter: `projectId`, `flowIds`, `includeDryRuns`. Child runs never produce `run.finished`.
    - Event bodies (`RunFinishedEvent`, `WebhookTestEvent`) carry the run's identity and outcome (`FinishedRun`), never its input or output. The OpenAPI document describes them under `webhooks`.
    - Error codes: `webhook-endpoint-not-found`, `webhook-delivery-not-found` (404), `webhook-url-refused` (400).
  - `@kindgi/crypto`: Standard Webhooks signatures (`v1`, HMAC-SHA256): `signWebhook`, `webhookHeaders`, `verifyWebhook` (timestamp tolerance, several signatures during a secret rotation, constant-time comparison) and `generateWebhookSecret` (`whsec_…`). Checked against the reference implementation both ways.
  - `@kindgi/client`: `client.webhookEndpoints`. The unused outbound shapes `Webhook`, `WebhookSpec`, `WebhookSecret`, `WebhookDelivery`, `WebhookVerifyResult` and the `WebhookId` / `WebhookDeliveryId` brands are replaced by the generated wire types and `WebhookEndpointId`; `SubscriptionSpec`'s webhook target is `{ kind: 'webhook', endpoint }`.
  - `@kindgi/types`: `WebhookEndpointId` and `WebhookEventId`. `WebhookId` is documented as what it is: the routable id of an inbound webhook trigger.
- aec851d: Webhook endpoints reference their signing secret by name instead of generating and returning one.
  
  - `@kindgi/api`:
    - Endpoints take `secretRef: { envName, name }`, a secret in the deployment's secrets store (resolved at tenant scope), like a provider's `secret_ref`. The secret is shared with the receiver, so it lives with the deployment's other secrets: `.env` in development, the secrets store in production. Endpoints show `secretRef`; `secretHint` is gone.
    - Create and update check that the secret exists and is strong (`400 webhook-secret-not-found`, `400 webhook-secret-too-weak`). `create` returns the endpoint (no secret).
    - `POST /v1/webhook-endpoints/generate-secret` returns a strong secret to store; nothing is kept.
    - `POST /v1/webhook-endpoints/{endpointId}/rotate-secret` and `WebhookEndpointWithSecret` are removed: rotating is rotating the referenced secret (`POST /v1/secrets/{name}/rotate`), and for a day deliveries are signed with both versions.
  - `@kindgi/client`: `webhookEndpoints.create` takes `secretRef` and returns the endpoint; `webhookEndpoints.generateSecret()`; `rotateSecret` is removed.
  - `@kindgi/crypto`: `isStrongWebhookSecret` and `WEBHOOK_SECRET_MIN_BYTES` (24).

### Patch Changes

- aec851d: `runs.start()` returns `StartedRun`: the run plus `publicAccessToken` and `publicAccessTokenExpiresAt`, which `POST /v1/runs` returns when the deployment issues public run tokens. TypeScript callers no longer need a cast to hand the token to a browser.
- aec851d: The OpenAPI run status says `pending` where it said `queued`. The server sends `pending` for a run that hasn't started yet, which is what `options.wait: false` answers, and a validating client (the Python client, or one generated with runtime validation) refused that response. A test now holds the document to the runtime's `RunStatus`.
- aec851d: Gemini on Vertex AI, and providers that carry their connection settings.
  
  - `@kindgi/adapter-model-gemini` (new): a Gemini `ModelProvider` on Vertex AI, through `@google/genai`.
    - **Credentials:** Google Application Default Credentials (a `gcloud` login on a laptop, the attached service account on Cloud Run), or a service-account key.
    - **Function calling:** tool ids go over the wire unchanged; each call's thought signature is kept and sent back on the next request.
    - **Tokens:** thinking parts are left out of the text, and thinking tokens count as completion.
    - **Cost:** cached-prompt and long-context rates.
    - **For servers:** `geminiAdapterFactory` reads `adapter_config.project`, and uses `metadata.region` as the location.
  - `@kindgi/capabilities`:
    - `AdapterFactoryInput.config` (`AdapterConfig`): an adapter's flat, non-secret connection settings.
    - `ModelToolCall.signature`: an opaque token a provider attaches to a tool call and needs back when the conversation continues.
  - `@kindgi/api`:
    - `POST /v1/providers` takes `adapter_config`. The binding receives it as `adapterConfig` and returns it from `resolveForRuntime`; `list` and `get` never return it.
    - The OpenAPI `RegisterProviderBody` now describes the actual body, `{ metadata, adapter_id, secret_ref?, adapter_config? }`; it used to describe `ProviderMetadata`.
    - `ProviderCost` allows adapter-specific rate fields.
  - `@kindgi/client`: the generated `RegisterProviderBody` follows.
  - `@kindgi/sdk`: the providers skill covers Gemini on Vertex, and `adapter_config`. It also notes that the OpenAI-compat adapter isn't registered by the runtime yet.
- aec851d: Client requests now match what the API accepts.
  
  - `agents.define(spec, { projectId, idempotencyKey? })`, `flows.define(flow, { projectId, idempotencyKey? })`, `guardrails.author(spec, { projectId, idempotencyKey? })`, `evalSuites.publish(input, { projectId, idempotencyKey? })` and `evalRuns.start(suiteId, input, { projectId, idempotencyKey? })` send `projectId` in the request body. `POST /v1/agents`, `/v1/flows`, `/v1/guardrails`, `/v1/eval-suites` and `/v1/eval-suites/:suiteId/runs` require it, so a call without it always failed with `400 bad-input`. The options argument is now required (types `DefineAgentOptions`, `DefineFlowOptions`, `AuthorGuardrailOptions`, `PublishSuiteOptions`, `StartEvalRunOptions`); `PublishSuiteInput` and `StartEvalRunInput` leave `projectId` out.
  - `runs.start({ agent, projectId?, … })` sends `projectId` for agent runs too; it was sent only for flow runs.
  - `approvals.list` and `conversations.list` take one `status` (`ApprovalFilter.status` / `ConversationFilter.status` no longer accept an array). The API filters by a single `?status=` and rejected the comma-joined value the client used to send; several statuses are now rejected client-side with `invalid-request`, before any request.
- aec851d: A run blocked by a guardrail now says which one, and clients get it as a typed error.
  
  - `@kindgi/agents`: the `guardrail-violation` message (and the `turn.failed` event's) names each blocking guardrail with its check's reason — `Turn blocked by guardrail 'no-pii': Response contains an email` — instead of only counting them.
  - `@kindgi/client` (re-exported by `@kindgi/sdk`): new `GuardrailViolationError` variant of `KindgiError` (`code: 'guardrail-violation'`, `violations[]` with `guardrailId` / `severity` / `action` / `reason?`, `evaluationErrors[]`). `fromWire()` previously returned it as a generic `ServerError`. Exhaustive `switch (err.code)` statements need the new case.
  - `@kindgi/api`: `POST /v1/runs` sends a binding failure's `details` as the wire error's `details`; they were nested under `details.details`, so clients could not read them.
- aec851d: A tenant can hold every agent to its own approval rules: a new policy kind, `hitl`.
  
  - `@kindgi/policy-contract`:
    - **The kind.** `hitl` joins `POLICY_KINDS`. Its spec, `HitlSpec` (`{ maxTimeoutMs?, minReviewerRole?, tools? }`), only tightens an agent's own approval rules: the shorter timeout, the higher reviewer role, and per tool id the stricter gate. `tools` maps a tool id to a mode (`never_ask`, `ask_on_first_use`, `always_ask`) or a rule `{ mode, requiredRole? }`.
    - **Exports.** `HitlSpec`, `ToolHitlMode`, `ToolHitlRule`, `ReviewerRole`, `TOOL_HITL_MODES`, `REVIEWER_ROLES`, `validateHitlSpec`, `combineHitlSpecs` (one spec at least as strict as each), and the helpers `toolHitlRule`, `stricterToolHitlRule`, `higherRole`.
    - **`validatePolicySpec(kind, spec)`** checks a spec against its kind's contract, for `tool-errors` and `hitl`. Other kinds pass.
  - `@kindgi/agents`:
    - **Applied per turn.** A turn resolves its approval rules once, at `setup` (and again when it resumes): the agent's `conversationPolicy.hitl`, held to the tenant's `hitl` policy through `policyRegistry`. Each tool call is gated by the stricter of the agent's rule for that tool and the tenant's.
    - **Fails closed.** When the tenant's `hitl` policy can't be evaluated, the turn fails with the new `tenant-policy-unavailable` error (`TenantPolicyUnavailableError`, which carries `policyKind`). Running without the policy would skip the tenant's approvals. No `hitl` executor bound means no tenant policy, as before.
    - **Breaking (preview):** `resolveEffectiveHitlPolicy({ tenant, agent })` takes the tenant's `HitlSpec` or `undefined`. `TenantHitlPolicy` is removed. `EffectiveHitlPolicy` gains `toolFloors`. An agent's tool modes and rules use `@kindgi/policy-contract`'s `ToolHitlMode` and `ToolHitlRule`, unchanged in shape.
  - `@kindgi/api`:
    - **Checked when written.** `POST /v1/policies` refuses a `tool-errors` or `hitl` spec that breaks its contract, with `validation-failed`. Each issue is pathed under `spec`, e.g. `spec/tools/acme.pay/mode`. Before, such a spec was stored and only found out on a turn.
    - **Status.** `tenant-policy-unavailable` maps to 503. `PolicyKind` includes `hitl`.
  - `@kindgi/client`: `PolicyKind` includes `hitl`. The Python client's models do too.
  - `@kindgi/sdk`: the agents skills (TypeScript and Python) say a tenant's `hitl` policy can tighten an agent's gates, never loosen them.
- aec851d: Failed tool calls go back to the model to correct, under a policy.
  
  - `@kindgi/agents`:
    - **Retries.** When a tool call fails, the failure goes back to the model as the call's result (what failed, the validation issues, what to do), and the turn continues. A failure the policy doesn't retry, or one past its retries, fails the turn as before.
    - **The setting.** `Agent.toolErrors` (`{ maxRetries?, retryOn? }`) sets how many failed calls go back per turn and for which kinds. Default: one retry, for `invalid-arguments` and `unknown-tool`, where nothing ran. `tool-error` (a tool that ran and failed) is opt-in.
    - **Bounds.** Each retry costs a step against `budget.maxSteps`. Retries are counted from the turn's messages, so a replayed turn counts the same.
    - **Errors.** `tool-invocation-failed` and `unresolved-tool` carry `toolRetries` when retries ran out.
    - **Exports.** `DEFAULT_TOOL_ERRORS` and `effectiveToolErrorPolicy`. A rejected HITL tool approval writes its result through the same path as a retry.
  - `@kindgi/policy-contract`:
    - A new policy kind, `tool-errors`. It caps an agent's setting, like every tenant policy: the fewer retries wins, and only kinds both allow are retried.
    - `ToolErrorsSpec`, `ToolErrorKind`, `TOOL_ERROR_KINDS`, `MAX_TOOL_ERROR_RETRIES` (10), and `validateToolErrorsSpec`.
  - `@kindgi/specs`: `agent.schema.json` schema-version 1.3.0 adds `toolErrors`.
  - `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `toolErrors` (`ToolErrorsSpec`). `PolicyKind` derives from `POLICY_KINDS`, so it includes `tool-errors`.
  - `@kindgi/handler-runtime`: the indexer carries an agent's `toolErrors`.
  - `@kindgi/client`: `PolicyKind` includes `tool-errors`, and the generated agent types carry `toolErrors`.
  - `@kindgi/sdk`: the agents skill covers `output` and `toolErrors`, and `preferredModel` as `defineAgent` keeps it.
- aec851d: Typed agent output and structured turn input.
  
  - `@kindgi/agents`:
    - **Typed output.** An agent can declare `output: { schema, name?, maxRepairs? }` (JSON Schema, or a Zod schema converted by `defineAgent`).
      - The final answer must be JSON matching the schema; a fenced JSON block is accepted.
      - An answer that doesn't fit is sent back to the model with the problems listed, up to `maxRepairs` times (default 1, counted against `budget.maxSteps`). After that the turn fails with `output-schema-violation` (`errors`, `attempts`).
      - The parsed answer is `AgentTurnResult.output`, or `null` on a dry run, where no answer is checked.
    - `AgentTurnResult.runId` is the turn's kernel run.
    - **Structured input.** `invokeAgent({ input })` makes `{{ input.* }}` available to the instructions (`input` joins `AUTO_INJECTED_VARS`). It is kept in the run snapshot and passed to guardrails as `trace.attributes.stepInput`.
    - **Parent link.** `invokeAgent({ parent })` records the run that started the turn, for turns started by a flow step.
    - **Resume.** The run snapshot keeps `parameters` and `input`, and `resumeAgentTurn` restores them; a resumed turn used to lose its parameters. Migration `0002` adds the two columns to `agent_run_snapshots`.
    - **Guardrail trace.** `buildRunTrace` now takes the run id, project id, turn number and user message. The trace carries them, so failed checks during a turn produce compliance evidence. Before, `runId` was the conversation id, `turnCount` was the step count, and `projectId` was missing. `attributes.steps` replaces `attributes.turnCount`; a typed answer appears as `attributes.structuredOutput`.
    - `defineAgent` keeps `preferredModel`.
  - `@kindgi/specs`: `agent.schema.json` schema-version 1.2.0 adds `output`, `preferredProvider` and `preferredModel`.
  - `@kindgi/handler-runtime`: the indexer carries an agent's `output`, `conversationPolicy`, `preferredModel`, `description` and `tags`.
  - `@kindgi/dev-echo-provider`: a call with no tools gets the last user message back as the answer, instead of a call to an echo tool the agent doesn't have.
  - `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `output` (`AgentOutputSpec`); `output-schema-violation` maps to 422.
  - `@kindgi/client`: the generated agent types carry `output`.
