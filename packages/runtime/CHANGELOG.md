# @kindgi/runtime

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **A tool that changes things with a person's connection waits for a person's yes in a run no person started, as if it declared `needsApprovalWhenUnattended`.** It counts when its `needsSpec.connections` has an entry `as: 'person'` and it isn't read-only (`mutating: false`); `needsApprovalWhenUnattended: false` doesn't lift it. So a tool that sends as someone never runs unasked under a schedule or a webhook because its author left the flag off. A trigger's `toolsAllowedUnattended` still lifts it in that trigger's own runs, as for any tool. `toolNeedsPersonsYesUnattended(tool)` answers the tool's half of the rule.
- 68e0d57: **A run says whom it acts for: `actsFor`.**
  
  - **Where:** `KernelRunRecord.actsFor`, `GET /v1/runs` and `GET /v1/runs/{runId}`. The response field is optional and additive. The TypeScript, Python and Java clients' `Run` gain it.
  - **The value** is whom the run acts for, whose access it has: `user:<id>` (a person) or `service_account:<id>` (a service account). These are the same strings as an approval's `requestedBy`, a conversation's `openedBy` and `whoami`'s `actor`. `@kindgi/runtime` exports its type, `RunActsFor`. It is recorded when the run is created and never changes. An approval or a resume doesn't change it.
    - A person who starts a run, signed in or with their own API key, is whom it acts for. So is a service account whose key starts one.
    - A run a schedule or a webhook fired (`startedBy` `schedule` or `webhook`) acts for the trigger's owner when it fired.
    - A child run acts for its parent's.
    - An agent acting for someone acts for that someone.
    - It is absent on a run that acts for no one (a system job, an agent on its own, an eval run's replay run) and on runs from before runs recorded it.
  - **An id, never a name.** A run's readers already see these ids on the project's approvals and conversations. Show the caller's own as `you` (`whoami`'s `actor`), and a name only where the caller may read that person or service account.
  - **Not on the public view or the webhook.** A public run token's `GET /v1/runs/{runId}/progress` and its stream never carry it, nor does the `run.finished` webhook's run. The journal's `run.started` payload carries it to the run's readers, on `GET /v1/runs/{runId}/journal` and `/stream`.
- 119ac78: **A webhook trigger or a schedule can name tools its runs call without waiting for a person's yes (`toolsAllowedUnattended`).** A tool that declares `needsApprovalWhenUnattended` waits for a person's yes in a run no person started. A trigger's list lifts that wait for the tools it names, and only that: the tenant's approval rules, the agent's own, the permission check (as the trigger's owner) and the tool's own limits all still apply.
  - **Where:** `POST` and `PATCH` on `/v1/webhooks` and `/v1/schedules` take it, and their records show it (absent: none). `POST /v1/runs` never takes it. A take-over (`/owner`) keeps it and refuses a body that names it (`400 bad-input`).
  - **Who:** naming it, `[]` included, takes `admin` on the trigger's project, at register too.
  - **What:** each tool by its id: at most 100, no wildcard or pattern, each once. Each must be a tool the target calls, else `400 bad-input` naming it. For a flow, that's its tool steps, loop bodies, fan-out branches, its subflows' tools, and its agents' tools at the node's version, the flow's pin or the latest. An improvement schedule calls no tools, so its list can only be `[]`.
  - **A new target:** a schedule `PATCH` to another flow or agent while its list isn't empty must name the list again, as it is or `[]`, else `400 bad-input` naming the kept ids. A new version alone keeps it. A webhook trigger's new `flowVersion` keeps it, and naming it checks it against that version.
  - **Audit:** every change is recorded as `trigger-tools-allowed-unattended-set` (the trigger, its target, `from`, `to`, `by`), and `trigger-owner-set` names the list a take-over keeps.
  - **Runs:** a run's `toolsAllowedUnattended` is its trigger's list as it was when the run started. A child run has its parent's, and a resumed agent turn keeps its run's, never the resumer's.
  - **For runtimes:** `@kindgi/runtime` exports `needsPersonsYesUnattended(tool, startedBy, toolsAllowedUnattended)`, the one rule the agent's tool gate and a flow's tool steps share. The field is on `RunFlowInput`, `StartRunParams`, the run record, and the trigger registry's register and update inputs and its records. It's also on `InvokeAgentInput`, the run snapshot, and the API's `InvokeAgentBindingInput` and `InvokeFlowBindingInput`, which a webhook's or a schedule's fire sets from its trigger.
- Updated dependencies [68e0d57]
  - @kindgi/handler@0.2.0-rc.0
  - @kindgi/flow@0.2.0-rc.0
  - @kindgi/authz@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/flow@0.1.10
  - @kindgi/authz@0.1.10
  - @kindgi/handler@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/authz@0.1.10-rc.1
  - @kindgi/flow@0.1.10-rc.1
  - @kindgi/handler@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/flow@0.1.10-rc.0
  - @kindgi/authz@0.1.10-rc.0
  - @kindgi/handler@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- cf339d3: **A tool can ask for a person's yes on every call no person is there to see: `needsApprovalWhenUnattended`.** A tool manifest's new optional `needsApprovalWhenUnattended: true` declares it. In a run no person started:
  - **An agent's call of the tool waits for a reviewer,** as `always_ask` does. Neither the agent's `conversationPolicy.hitl` nor the tenant's approval rules can lift it.
  - **A flow's tool step that calls it fails,** with `needs-a-person: …` naming the tool, since a tool step can't wait. Call such a tool from an agent step.
  - In a run a person started, the agent's own gates decide, as for any tool. A tool that doesn't declare it is unchanged.
  
  **A run says how it started: `startedBy`** on `GET /v1/runs` and `GET /v1/runs/{runId}`, and on `KernelRunRecord`. It's `person` (signed in, or with their own API key), `key` (a service account's key), or `schedule`, `webhook` or `event` (a trigger). Only `person` counts as attended (`runIsAttended`, `@kindgi/runtime`). It's set from the caller, never from the request body, and never changes: an approval doesn't make a run its approver's. A run that a run starts started the way its run did. A run from before a runtime recorded it has none, and counts as unattended.
  - **A key acts as its person.** For automation, use a service account's key: its runs count as unattended. A request with a service account's key is `key` whoever else it names. A tenant's first admin key, the one `POST /v1/system/tenants` answers with when it names no `firstAdmin`, is a service account's too: for the work you start, add yourself as a person and use a key of your own.
  - **The wire `Tool`** carries `needsApprovalWhenUnattended`, so `kindgi tools get` and the console show it. The pack indexer carries it into the pack's index.
  - **The `woocommerce` template declares it** on `woo.refund`, `woo.refund-large`, `woo.set-price` and `woo.publish-product`. A staff member's refund in the store chat runs as the store agent says; one an order webhook's run asks for waits for a person.
  - **The authoring skills** (`kindgi-authoring-tools` and the Java, Python and Scala ones) say when to declare it.
- Updated dependencies [22b619b]
- Updated dependencies [d563887]
- Updated dependencies [3502389]
  - @kindgi/flow@0.1.9
  - @kindgi/authz@0.1.9
  - @kindgi/handler@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/authz@0.1.9-rc.1
  - @kindgi/flow@0.1.9-rc.1
  - @kindgi/handler@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- cf339d3: **A tool can ask for a person's yes on every call no person is there to see: `needsApprovalWhenUnattended`.** A tool manifest's new optional `needsApprovalWhenUnattended: true` declares it. In a run no person started:
  - **An agent's call of the tool waits for a reviewer,** as `always_ask` does. Neither the agent's `conversationPolicy.hitl` nor the tenant's approval rules can lift it.
  - **A flow's tool step that calls it fails,** with `needs-a-person: …` naming the tool, since a tool step can't wait. Call such a tool from an agent step.
  - In a run a person started, the agent's own gates decide, as for any tool. A tool that doesn't declare it is unchanged.
  
  **A run says how it started: `startedBy`** on `GET /v1/runs` and `GET /v1/runs/{runId}`, and on `KernelRunRecord`. It's `person` (signed in, or with their own API key), `key` (a service account's key), or `schedule`, `webhook` or `event` (a trigger). Only `person` counts as attended (`runIsAttended`, `@kindgi/runtime`). It's set from the caller, never from the request body, and never changes: an approval doesn't make a run its approver's. A run that a run starts started the way its run did. A run from before a runtime recorded it has none, and counts as unattended.
  - **A key acts as its person.** For automation, use a service account's key: its runs count as unattended. A request with a service account's key is `key` whoever else it names. A tenant's first admin key, the one `POST /v1/system/tenants` answers with when it names no `firstAdmin`, is a service account's too: for the work you start, add yourself as a person and use a key of your own.
  - **The wire `Tool`** carries `needsApprovalWhenUnattended`, so `kindgi tools get` and the console show it. The pack indexer carries it into the pack's index.
  - **The `woocommerce` template declares it** on `woo.refund`, `woo.refund-large`, `woo.set-price` and `woo.publish-product`. A staff member's refund in the store chat runs as the store agent says; one an order webhook's run asks for waits for a person.
  - **The authoring skills** (`kindgi-authoring-tools` and the Java, Python and Scala ones) say when to declare it.
- Updated dependencies [22b619b]
- Updated dependencies [d563887]
- Updated dependencies [3502389]
  - @kindgi/flow@0.1.9-rc.0
  - @kindgi/authz@0.1.9-rc.0
  - @kindgi/handler@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- ebf405d: **A schedule's or webhook trigger's fire says whether it counted toward the trigger's auto-pause.** `TriggerFire.countsTowardPause`, and `countsTowardPause` on `GET /v1/schedules/{scheduleId}/fires` and `GET /v1/webhooks/{triggerId}/fires`, optional:
  - **`false`** for a refusal for a limit, such as the tenant's runs pending (its `detail` starts `rate-limited:`): the limit passes, and the trigger isn't at fault.
  - **Absent** from a runtime that doesn't say: `refused` and `failed` fires counted, and the others didn't, as before.
- 059c2c2: **A fire's `skipped` outcome covers a tenant suspended or closing as its run starts.** A schedule's or webhook trigger's fire whose run starts as its tenant is suspended or starts closing is recorded `skipped`, with `tenant-suspended` or `tenant-closing` in its `detail`. Like a skip for a project's suspension, it doesn't count toward a schedule's auto-pause and doesn't reset its count of fires in a row that were refused or failed. The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say so.
- 2969337: **Checks inside a run are documented as not enforced in 0.1.7.** The docs of `InvokeAgentInput.principal`, `RunFlowInput.principal` and `authz`, and `NodeContext`'s `authorize`, `can` and `check` (and the agents and handler READMEs) now say that the runtime doesn't yet decide authorization checks inside a run in 0.1.7; route-level permissions apply. This is planned for 0.1.8. The agents README and `InvokeAgentInput.principal` no longer claim that an agent's tool calls are checked against its principal.
- ebf405d: **A deployment can keep what a project's flows, agents, triggers and runs name within that project's reach.**
  - **`CreateAppInput.referenceScope?`** (a `ReferenceScopeBinding`, `reachable(tenantId, fromProjectId, ref)`) is asked before each write that makes a reference live:
    - publishing a flow (its tool, agent and subflow steps) or an agent (its tools, guardrails and data blocks), and reinstating a retired version of either;
    - registering a deployment (what its agents and flows name, besides what it brings itself);
    - registering a guardrail with a pack check;
    - registering a schedule or a webhook trigger, and changing a schedule's target;
    - starting an eval run (its suite, and its agent or flow), and starting a run filed under a named `projectId`;
    - opening a conversation (its agent);
    - promoting an agent into a project or a segment, directly or through an improvement proposal;
    - drafting an improvement proposal (its scope and block), evaluating one, and starting an improvement pass (its suite and scope).
  - **The refusal:** an item the project doesn't reach is refused with `reference-out-of-scope` (400), naming each one at its path. An item that doesn't exist gets the same answer. Without the binding, nothing changes.
  - **A conversation opened without `projectId` is filed under its agent's own project,** as a run is. Before, it went to the tenant's Default project; an agent filed under no project still goes there.
  - **Tool metadata:** `POST /v1/tools` and deployments refuse a tool `metadata` key under `kindgi.`, which is the runtime's own.
  - **`ToolRegistry.forProject?`** (`@kindgi/tools`): the tools a run in a project may reach. An agent's turn resolves its tools on it when it's there.
  - **`BlockReader`'s reads take the turn's `projectId`** (`@kindgi/agents`).
  - **`InvokeAgentBindings.authorizeToolCall?`** (`@kindgi/agents`) is asked before each of a turn's tool calls, before any approval.
    - A denied call runs nothing. Its result tells the model (`{ status: 'denied', reason }`), and the turn goes on.
    - A call approved by a reviewer is asked again right before it runs. Denied then, it runs nothing.
    - Each decision is recorded with the call, so a resumed turn keeps it. An authorizer that throws fails the step.
    - A built-in tool is asked only when what it touches reaches beyond the turn's project: `kindgi_remember` for a tenant-wide fact.
  - **The docs of `NodeContext`'s `authorize`, `can` and `check`, `RunFlowInput.principal` and `authz`, and `InvokeAgentInput.principal` and `authz`** (with the agents and handler READMEs) describe runtime 0.1.8: these checks are decided for every run and turn a person or a key starts.
- 3a3f233: Request bodies have a size limit and a depth limit, from the tenant input bounds.
  
  - A request body over `requestMaxBytes` (2 MiB on hosted, 10 MiB on a self-hosted server) is refused with `413 request-too-large`, with `details.maxBytes`, before more of it is read. Every operation with a body declares that answer, except the two routes that keep a limit of their own: an artifact upload (`413 artifact-too-large`, checked once the caller is known) and the webhook receiver (`413 webhook-body-too-large`).
  - A JSON body nested more than `requestJsonMaxDepth` levels (128) is refused with `400 bad-input`, with `details.maxDepth`.
  - A webhook delivery whose JSON nests deeper than that is refused the same way and starts no run. The trigger's fires record it as `body-too-deep`.
  - `HOSTED_BOUNDS.requestJsonMaxDepth` is 128 (it was 64), the same as self-hosted, so a schema as deep as `schemaMaxDepth` fits inside the body that carries it.
  - `kindgi deploy` says what to make smaller when a deployment is over the server's limit.
- ebf405d: **Where a secret an item names is read is decided when the item is registered, and recorded on it.**
  - **Which items:** an MCP endpoint (`secretRef`, `auth.secretRef`), a tool (a spec tool's `secretRef`, the secrets a pack tool declares; through `POST /v1/tools` or a deployment), and a webhook trigger's signing secret.
  - **How it's decided:** the secret is looked for at the item's own scope, then its project's org, then the tenant, at the scopes the person registering it administers. The first that has it is recorded. If none has it yet, the broadest scope they administer is: the tenant for a tenant admin, the project for a project admin. Nothing is refused for it.
  - **What's recorded:** `secretScopes` (by name) on an MCP endpoint and a tool version, `hmacSecretScope` on a webhook trigger. They're the server's, never a caller's. The runtime reads the secret there only. A secret removed from that scope is missing, never read from a broader one, and one set later at another scope changes nothing until it's recorded again: a tool by publishing a new version, an MCP endpoint by unregistering it and registering it again, a webhook trigger by an update that names its secret.
  - **Webhook triggers:** the receiver reads the signing secret at `hmacSecretScope`; a trigger registered before it was recorded reads the tenant's, as before.
  - **`generateSecret`:** `POST /v1/webhooks` can make the signing secret itself, in the trigger's project, needing only `write` there; the answer carries it once (`signingSecret`). A name the project already has is refused (`409 secret-write-conflict`). `kindgi webhooks register --generate-secret` now uses it, in one call, and no longer takes `--env`.
  - **Read there only:** `SecretResolveInput.exact` reads at the given scope with no walk to a broader one, and every secrets store must honour it. `SecretResolveOutcome.scope` says where a value was read. `resolveAtScope` reads an item's secret at its recorded scope with `exact`. A value a store reads at another scope anyway, or without saying which, is refused as not set, and the refusal is audited (`secret-resolved`, failed, `secret-scope-mismatch`) without the value. A custom store must honour `exact` and report the scope it read. The dotenv store keeps one set of values for every scope, so it reports the scope it was asked at.
  - **`emitResolveEvent`** (`@kindgi/compliance`): `projectId` is optional, for a read at the tenant or an org.
  - **`CreateAppInput.envName`:** the env this deployment serves, where the secrets a tool's code declares are looked for.
  - **`RecordedSecretScope`** (`@kindgi/types`): the recorded scope's shape.
- 036605f: **A fire's `skipped` outcome names a suspension too.** The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say every reason a fire is `skipped`:
  - The target's project is suspended (`project-suspended` in `detail`): no run or pass starts. A schedule's fires are recorded `skipped`, don't count toward its auto-pause and don't reset its count of fires in a row that were refused or failed, so the schedule stays on and fires again once the project is restored.
  - Its run or pass hadn't started when its tenant was suspended (`tenant-suspended`): the restore concludes it `skipped`, and its event is dropped.
  - A tenant's suspension isn't caught up, whatever a schedule's `catchUp`: once the tenant is restored, a schedule that's on fires next at its first occurrence after the restore.
  
  The suspend routes for a tenant and for a project say the same, and a webhook trigger's `detail` names `project-suspended` or `tenant-suspended` for a skip for a suspension.
- Updated dependencies [2969337]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/handler@0.1.8
  - @kindgi/types@0.1.8
  - @kindgi/flow@0.1.8
  - @kindgi/authz@0.1.8

## 0.1.8-rc.0

### Patch Changes

- ebf405d: **A schedule's or webhook trigger's fire says whether it counted toward the trigger's auto-pause.** `TriggerFire.countsTowardPause`, and `countsTowardPause` on `GET /v1/schedules/{scheduleId}/fires` and `GET /v1/webhooks/{triggerId}/fires`, optional:
  - **`false`** for a refusal for a limit, such as the tenant's runs pending (its `detail` starts `rate-limited:`): the limit passes, and the trigger isn't at fault.
  - **Absent** from a runtime that doesn't say: `refused` and `failed` fires counted, and the others didn't, as before.
- 059c2c2: **A fire's `skipped` outcome covers a tenant suspended or closing as its run starts.** A schedule's or webhook trigger's fire whose run starts as its tenant is suspended or starts closing is recorded `skipped`, with `tenant-suspended` or `tenant-closing` in its `detail`. Like a skip for a project's suspension, it doesn't count toward a schedule's auto-pause and doesn't reset its count of fires in a row that were refused or failed. The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say so.
- 2969337: **Checks inside a run are documented as not enforced in 0.1.7.** The docs of `InvokeAgentInput.principal`, `RunFlowInput.principal` and `authz`, and `NodeContext`'s `authorize`, `can` and `check` (and the agents and handler READMEs) now say that the runtime doesn't yet decide authorization checks inside a run in 0.1.7; route-level permissions apply. This is planned for 0.1.8. The agents README and `InvokeAgentInput.principal` no longer claim that an agent's tool calls are checked against its principal.
- ebf405d: **A deployment can keep what a project's flows, agents, triggers and runs name within that project's reach.**
  - **`CreateAppInput.referenceScope?`** (a `ReferenceScopeBinding`, `reachable(tenantId, fromProjectId, ref)`) is asked before each write that makes a reference live:
    - publishing a flow (its tool, agent and subflow steps) or an agent (its tools, guardrails and data blocks), and reinstating a retired version of either;
    - registering a deployment (what its agents and flows name, besides what it brings itself);
    - registering a guardrail with a pack check;
    - registering a schedule or a webhook trigger, and changing a schedule's target;
    - starting an eval run (its suite, and its agent or flow), and starting a run filed under a named `projectId`;
    - opening a conversation (its agent);
    - promoting an agent into a project or a segment, directly or through an improvement proposal;
    - drafting an improvement proposal (its scope and block), evaluating one, and starting an improvement pass (its suite and scope).
  - **The refusal:** an item the project doesn't reach is refused with `reference-out-of-scope` (400), naming each one at its path. An item that doesn't exist gets the same answer. Without the binding, nothing changes.
  - **A conversation opened without `projectId` is filed under its agent's own project,** as a run is. Before, it went to the tenant's Default project; an agent filed under no project still goes there.
  - **Tool metadata:** `POST /v1/tools` and deployments refuse a tool `metadata` key under `kindgi.`, which is the runtime's own.
  - **`ToolRegistry.forProject?`** (`@kindgi/tools`): the tools a run in a project may reach. An agent's turn resolves its tools on it when it's there.
  - **`BlockReader`'s reads take the turn's `projectId`** (`@kindgi/agents`).
  - **`InvokeAgentBindings.authorizeToolCall?`** (`@kindgi/agents`) is asked before each of a turn's tool calls, before any approval.
    - A denied call runs nothing. Its result tells the model (`{ status: 'denied', reason }`), and the turn goes on.
    - A call approved by a reviewer is asked again right before it runs. Denied then, it runs nothing.
    - Each decision is recorded with the call, so a resumed turn keeps it. An authorizer that throws fails the step.
    - A built-in tool is asked only when what it touches reaches beyond the turn's project: `kindgi_remember` for a tenant-wide fact.
  - **The docs of `NodeContext`'s `authorize`, `can` and `check`, `RunFlowInput.principal` and `authz`, and `InvokeAgentInput.principal` and `authz`** (with the agents and handler READMEs) describe runtime 0.1.8: these checks are decided for every run and turn a person or a key starts.
- 3a3f233: Request bodies have a size limit and a depth limit, from the tenant input bounds.
  
  - A request body over `requestMaxBytes` (2 MiB on hosted, 10 MiB on a self-hosted server) is refused with `413 request-too-large`, with `details.maxBytes`, before more of it is read. Every operation with a body declares that answer, except the two routes that keep a limit of their own: an artifact upload (`413 artifact-too-large`, checked once the caller is known) and the webhook receiver (`413 webhook-body-too-large`).
  - A JSON body nested more than `requestJsonMaxDepth` levels (128) is refused with `400 bad-input`, with `details.maxDepth`.
  - A webhook delivery whose JSON nests deeper than that is refused the same way and starts no run. The trigger's fires record it as `body-too-deep`.
  - `HOSTED_BOUNDS.requestJsonMaxDepth` is 128 (it was 64), the same as self-hosted, so a schema as deep as `schemaMaxDepth` fits inside the body that carries it.
  - `kindgi deploy` says what to make smaller when a deployment is over the server's limit.
- ebf405d: **Where a secret an item names is read is decided when the item is registered, and recorded on it.**
  - **Which items:** an MCP endpoint (`secretRef`, `auth.secretRef`), a tool (a spec tool's `secretRef`, the secrets a pack tool declares; through `POST /v1/tools` or a deployment), and a webhook trigger's signing secret.
  - **How it's decided:** the secret is looked for at the item's own scope, then its project's org, then the tenant, at the scopes the person registering it administers. The first that has it is recorded. If none has it yet, the broadest scope they administer is: the tenant for a tenant admin, the project for a project admin. Nothing is refused for it.
  - **What's recorded:** `secretScopes` (by name) on an MCP endpoint and a tool version, `hmacSecretScope` on a webhook trigger. They're the server's, never a caller's. The runtime reads the secret there only. A secret removed from that scope is missing, never read from a broader one, and one set later at another scope changes nothing until it's recorded again: a tool by publishing a new version, an MCP endpoint by unregistering it and registering it again, a webhook trigger by an update that names its secret.
  - **Webhook triggers:** the receiver reads the signing secret at `hmacSecretScope`; a trigger registered before it was recorded reads the tenant's, as before.
  - **`generateSecret`:** `POST /v1/webhooks` can make the signing secret itself, in the trigger's project, needing only `write` there; the answer carries it once (`signingSecret`). A name the project already has is refused (`409 secret-write-conflict`). `kindgi webhooks register --generate-secret` now uses it, in one call, and no longer takes `--env`.
  - **Read there only:** `SecretResolveInput.exact` reads at the given scope with no walk to a broader one, and every secrets store must honour it. `SecretResolveOutcome.scope` says where a value was read. `resolveAtScope` reads an item's secret at its recorded scope with `exact`. A value a store reads at another scope anyway, or without saying which, is refused as not set, and the refusal is audited (`secret-resolved`, failed, `secret-scope-mismatch`) without the value. A custom store must honour `exact` and report the scope it read. The dotenv store keeps one set of values for every scope, so it reports the scope it was asked at.
  - **`emitResolveEvent`** (`@kindgi/compliance`): `projectId` is optional, for a read at the tenant or an org.
  - **`CreateAppInput.envName`:** the env this deployment serves, where the secrets a tool's code declares are looked for.
  - **`RecordedSecretScope`** (`@kindgi/types`): the recorded scope's shape.
- 036605f: **A fire's `skipped` outcome names a suspension too.** The descriptions of a schedule's and a webhook trigger's fires, and of `TriggerFire.outcome`, now say every reason a fire is `skipped`:
  - The target's project is suspended (`project-suspended` in `detail`): no run or pass starts. A schedule's fires are recorded `skipped`, don't count toward its auto-pause and don't reset its count of fires in a row that were refused or failed, so the schedule stays on and fires again once the project is restored.
  - Its run or pass hadn't started when its tenant was suspended (`tenant-suspended`): the restore concludes it `skipped`, and its event is dropped.
  - A tenant's suspension isn't caught up, whatever a schedule's `catchUp`: once the tenant is restored, a schedule that's on fires next at its first occurrence after the restore.
  
  The suspend routes for a tenant and for a project say the same, and a webhook trigger's `detail` names `project-suspended` or `tenant-suspended` for a skip for a suspension.
- Updated dependencies [2969337]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/handler@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0
  - @kindgi/flow@0.1.8-rc.0
  - @kindgi/authz@0.1.8-rc.0

## 0.1.7

### Patch Changes

- b90e2c6: **Webhook triggers start runs: a signed request from WooCommerce, Drupal's Webhooks module, GitHub, Shopify or any Standard Webhooks sender starts a run of a flow.**
  
  - **The receiver, `POST /v1/hooks/{tenantId}/{webhookId}`,** sits outside the bearer chain. The request's signature, made with the trigger's secret over the raw body, is what lets it start the trigger's flow as the trigger's owner; a bearer token, if sent, is never read.
    - **One answer for any request that doesn't prove its sender:** an unknown tenant or id, a missing, wrong or stale signature, or a secret that can't be read is `401 webhook-refused`. The reason goes only to the trigger's deliveries and, for the sender's own failures, the access audit (actor `webhook-sender`, the address in `evidence.clientAddress`); a secret that can't be read is the deployment's to fix, so it's on the deliveries only.
    - **Gone and paused:** an unregistered trigger is `410 webhook-gone`, but only to a sender that proved itself. A paused trigger takes the delivery (`202`, a `skipped` fire) and starts nothing: the event is dropped.
    - **Repeats:** a delivery whose dedupe key an earlier fire holds starts nothing (`200`, `duplicate: true`). The key is the trigger's delivery-id header and the body, because WooCommerce's delivery id is per second, not per event.
    - **WooCommerce's ping:** its unsigned save-time ping (`webhook_id=<n>`) is answered `200` before any lookup.
    - **Limits:**
      - a body past 1 MiB, or past the trigger's `bodyLimitBytes` (default 256 KiB), is `413 webhook-body-too-large`;
      - deliveries past the trigger's `rateLimitPerMinute` (default 600) are `429`;
      - past 60 refusals a minute from one address (`webhookReceiver.clientAddress`), that address's further refusals are `429` and not recorded. The limit is checked only after verification: a validly signed delivery is never refused because of anyone's refusals, its own address's included. An unreadable secret never counts against a sender;
      - a trigger records 20 refusals and skipped deliveries a minute, then only counts them (`suppressedRefusals`).
    - **The signing key:** the receiver keeps a trigger's key for up to 10 seconds (`WEBHOOK_SIGNING_KEY_TTL_MS`), as a `KeyObject`, never a string, so a flood of bad signatures costs one secret read a trigger. A write through `createApp`'s secrets routes drops it at once; another instance's write is seen within those 10 seconds.
    - **The event:** the flow's event is the body, parsed as JSON for a JSON content type (else `400 webhook-body-not-json`), or its text otherwise.
    - **Mounting:** the receiver mounts with `createApp`'s new `webhookReceiver` (`envName`, `clientAddress`, `rateLimitStore`) when the trigger registry implements `findWebhook`, `fireWebhook` and `recordWebhookRefusal`, which replace `fetchActiveByWebhookId` (as `SchedulerBinding.fireByWebhookId` goes).
  - **Webhook triggers are served again** (`/v1/webhooks` was hidden while no runtime served it), on the schedules model:
    - **Project and owner:** a trigger has a project (`projectId`; the Default project if none is named) and an owner (the registrant, rechecked at every delivery).
    - **Access:** it follows the project: `read`, `write`, `admin` to take ownership, plus `execute` on the flow to register, change the version or take ownership.
    - **The signing scheme:** register and update take `signature` (`hmac-sha256` with a `hex` or `base64` header and an optional prefix, or `standard-webhooks`), `deliveryIdHeader`, `bodyLimitBytes` and `rateLimitPerMinute`. An update also takes `hmacSecretName`; `null` clears the last three.
    - **Provider keys:** a model provider's key is refused as a trigger's secret (`400 provider-key-refused`); the receiver reads its secret through a guarded binding (`SecretUser` `'a webhook trigger'`), and `provider-key-in-use` names webhook triggers too.
    - **New routes:** `GET /v1/webhooks?projectId=`, `GET /v1/webhooks/{id}/fires` (the deliveries; a fire keeps the event only until its run starts) and `POST /v1/webhooks/{id}/owner`.
    - **The receive URL:** records carry `receiveUrl`, made from `createApp`'s new `publicUrl`, never from a request's `Host`. They also carry `owner`, `signature`, `bodyLimitBytes`, `rateLimitPerMinute` and `statusReason`.
  - **`@kindgi/crypto`'s `verifyInboundSignature`** checks a request in a trigger's scheme, with Standard Webhooks through `verifyWebhook`; it takes the secret, or the `KeyObject` that `inboundSigningKey(scheme, secret)` derives from it (which `JSON.stringify` shows as `{}`). `@kindgi/types` has `WebhookSignatureScheme`.
  - **The OpenAPI marks the receiver `x-kindgi-sender-only`:** the client generators skip it, because the receive URL is the sender's path, not a client's.
  - **The TypeScript client** has `webhooks` again (`register`, `list`, `get`, `update`, `pause`, `resume`, `unregister`, `fires`, `takeOwnership`), and `@kindgi/sdk` exports `WebhooksClient`. The Python client has `client.webhooks`.
  - **The CLI adds `kindgi webhooks`:** `register`, `list`, `get`, `update`, `pause`, `resume`, `fires`, `take-ownership` and `unregister`.
    - **`register --preset=woocommerce|drupal-webhooks|github|shopify|standard-webhooks`** sets a sender's scheme and delivery-id header.
    - **`--generate-secret --env=<env>`** makes a new secret (letters and digits; `whsec_…` for Standard Webhooks), stores it once the trigger is registered (a refused register leaves none behind), and shows it once.
    - **The receive URL:** register and get print it, or why there's none (no `KINDGI_PUBLIC_URL`).
    - **`pause`** says that a paused trigger drops events.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7
  - @kindgi/flow@0.1.7
  - @kindgi/authz@0.1.7
  - @kindgi/handler@0.1.7

## 0.1.7-rc.0

### Patch Changes

- b90e2c6: **Webhook triggers start runs: a signed request from WooCommerce, Drupal's Webhooks module, GitHub, Shopify or any Standard Webhooks sender starts a run of a flow.**
  
  - **The receiver, `POST /v1/hooks/{tenantId}/{webhookId}`,** sits outside the bearer chain. The request's signature, made with the trigger's secret over the raw body, is what lets it start the trigger's flow as the trigger's owner; a bearer token, if sent, is never read.
    - **One answer for any request that doesn't prove its sender:** an unknown tenant or id, a missing, wrong or stale signature, or a secret that can't be read is `401 webhook-refused`. The reason goes only to the trigger's deliveries and, for the sender's own failures, the access audit (actor `webhook-sender`, the address in `evidence.clientAddress`); a secret that can't be read is the deployment's to fix, so it's on the deliveries only.
    - **Gone and paused:** an unregistered trigger is `410 webhook-gone`, but only to a sender that proved itself. A paused trigger takes the delivery (`202`, a `skipped` fire) and starts nothing: the event is dropped.
    - **Repeats:** a delivery whose dedupe key an earlier fire holds starts nothing (`200`, `duplicate: true`). The key is the trigger's delivery-id header and the body, because WooCommerce's delivery id is per second, not per event.
    - **WooCommerce's ping:** its unsigned save-time ping (`webhook_id=<n>`) is answered `200` before any lookup.
    - **Limits:**
      - a body past 1 MiB, or past the trigger's `bodyLimitBytes` (default 256 KiB), is `413 webhook-body-too-large`;
      - deliveries past the trigger's `rateLimitPerMinute` (default 600) are `429`;
      - past 60 refusals a minute from one address (`webhookReceiver.clientAddress`), that address's further refusals are `429` and not recorded. The limit is checked only after verification: a validly signed delivery is never refused because of anyone's refusals, its own address's included. An unreadable secret never counts against a sender;
      - a trigger records 20 refusals and skipped deliveries a minute, then only counts them (`suppressedRefusals`).
    - **The signing key:** the receiver keeps a trigger's key for up to 10 seconds (`WEBHOOK_SIGNING_KEY_TTL_MS`), as a `KeyObject`, never a string, so a flood of bad signatures costs one secret read a trigger. A write through `createApp`'s secrets routes drops it at once; another instance's write is seen within those 10 seconds.
    - **The event:** the flow's event is the body, parsed as JSON for a JSON content type (else `400 webhook-body-not-json`), or its text otherwise.
    - **Mounting:** the receiver mounts with `createApp`'s new `webhookReceiver` (`envName`, `clientAddress`, `rateLimitStore`) when the trigger registry implements `findWebhook`, `fireWebhook` and `recordWebhookRefusal`, which replace `fetchActiveByWebhookId` (as `SchedulerBinding.fireByWebhookId` goes).
  - **Webhook triggers are served again** (`/v1/webhooks` was hidden while no runtime served it), on the schedules model:
    - **Project and owner:** a trigger has a project (`projectId`; the Default project if none is named) and an owner (the registrant, rechecked at every delivery).
    - **Access:** it follows the project: `read`, `write`, `admin` to take ownership, plus `execute` on the flow to register, change the version or take ownership.
    - **The signing scheme:** register and update take `signature` (`hmac-sha256` with a `hex` or `base64` header and an optional prefix, or `standard-webhooks`), `deliveryIdHeader`, `bodyLimitBytes` and `rateLimitPerMinute`. An update also takes `hmacSecretName`; `null` clears the last three.
    - **Provider keys:** a model provider's key is refused as a trigger's secret (`400 provider-key-refused`); the receiver reads its secret through a guarded binding (`SecretUser` `'a webhook trigger'`), and `provider-key-in-use` names webhook triggers too.
    - **New routes:** `GET /v1/webhooks?projectId=`, `GET /v1/webhooks/{id}/fires` (the deliveries; a fire keeps the event only until its run starts) and `POST /v1/webhooks/{id}/owner`.
    - **The receive URL:** records carry `receiveUrl`, made from `createApp`'s new `publicUrl`, never from a request's `Host`. They also carry `owner`, `signature`, `bodyLimitBytes`, `rateLimitPerMinute` and `statusReason`.
  - **`@kindgi/crypto`'s `verifyInboundSignature`** checks a request in a trigger's scheme, with Standard Webhooks through `verifyWebhook`; it takes the secret, or the `KeyObject` that `inboundSigningKey(scheme, secret)` derives from it (which `JSON.stringify` shows as `{}`). `@kindgi/types` has `WebhookSignatureScheme`.
  - **The OpenAPI marks the receiver `x-kindgi-sender-only`:** the client generators skip it, because the receive URL is the sender's path, not a client's.
  - **The TypeScript client** has `webhooks` again (`register`, `list`, `get`, `update`, `pause`, `resume`, `unregister`, `fires`, `takeOwnership`), and `@kindgi/sdk` exports `WebhooksClient`. The Python client has `client.webhooks`.
  - **The CLI adds `kindgi webhooks`:** `register`, `list`, `get`, `update`, `pause`, `resume`, `fires`, `take-ownership` and `unregister`.
    - **`register --preset=woocommerce|drupal-webhooks|github|shopify|standard-webhooks`** sets a sender's scheme and delivery-id header.
    - **`--generate-secret --env=<env>`** makes a new secret (letters and digits; `whsec_…` for Standard Webhooks), stores it once the trigger is registered (a refused register leaves none behind), and shows it once.
    - **The receive URL:** register and get print it, or why there's none (no `KINDGI_PUBLIC_URL`).
    - **`pause`** says that a paused trigger drops events.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/flow@0.1.7-rc.0
  - @kindgi/authz@0.1.7-rc.0
  - @kindgi/handler@0.1.7-rc.0

## 0.1.6

### Patch Changes

- 307771f: `GET /v1/runs/failures`: a project's failed runs over a window, grouped by cause and version, from the server's counts. A console can show error groups and which version started failing without counting the pages it loaded.
  
  - **Each group:** the failure's `code`, the agent or flow (`subject`), the `version`, how many runs failed, when the first and the latest failed in the window (`firstSeen`, `lastSeen`), and the latest run (`exampleRunId`).
  - **People's decisions come apart:** `hitl-*` codes (an approval rejected, cancelled or timed out), with their `reason`, are `outcomes`, never failures.
  - **Runs that failed before their cause was recorded** come back as `unrecorded`, by subject and version only.
  - **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. Optionally `agentId` or `flowId` (not both), `groupBy` (`code`, `version`, or both, the default) and `limit` (1 to 200, 50 by default). It needs `read` on the project.
  - **Not counted:** replays, eval runs' runs and dry runs. A child run counts under its own agent or flow.
  - **`RunBinding.failureGroups`** is optional. Without it, the route answers `501 run-failures-not-supported`.
  - **The clients:** TypeScript `runs.failures(query)`; Python `runs.failures(...)`.
- 307771f: `GET /v1/runs` (`runs.list`) narrows by more: `status` (one or several, repeated or comma-separated), `createdAfter` and `createdBefore` (strict), `agentVersion` (with `agentId`), and `flowId` with `flowVersion` (with `flowId`). An unknown status, a bad time, an empty value, or a version without its id is a `400 bad-input`. Both clients take `status` as one status or a list. An unfiltered tenant-wide page is also much faster on a large deployment.
- 307771f: **A project's schedules in one read, their owners named.** `GET /v1/schedules?projectId=` lists one project's schedules (a project id that isn't one is `400 bad-input`). `ListTriggersInput.projectId` is optional: the registry narrows, and the route keeps a page right from one that doesn't. Each schedule's `owner` gains an optional `displayName`, the owner's name at the time of the response: the person's display name from the directory, or the service account's name. It's absent when it can't be read (no directory, a removed account), and the id stands. The schedules router takes the directory and service-account bindings for it, and reads each owner once per response. The in-memory trigger registry narrows by project too. The client takes `projectId` on `schedules.list`; the CLI adds `kindgi schedules list --project=<id>` and an `OWNER` column.
- Updated dependencies [fd93b3e]
- Updated dependencies [b4bbd95]
- Updated dependencies [8b60576]
  - @kindgi/authz@0.1.6
  - @kindgi/types@0.1.6
  - @kindgi/handler@0.1.6
  - @kindgi/flow@0.1.6

## 0.1.6-rc.0

### Patch Changes

- 307771f: `GET /v1/runs/failures`: a project's failed runs over a window, grouped by cause and version, from the server's counts. A console can show error groups and which version started failing without counting the pages it loaded.
  
  - **Each group:** the failure's `code`, the agent or flow (`subject`), the `version`, how many runs failed, when the first and the latest failed in the window (`firstSeen`, `lastSeen`), and the latest run (`exampleRunId`).
  - **People's decisions come apart:** `hitl-*` codes (an approval rejected, cancelled or timed out), with their `reason`, are `outcomes`, never failures.
  - **Runs that failed before their cause was recorded** come back as `unrecorded`, by subject and version only.
  - **The query:** `projectId`, `from` and `to` are required, with a window of at most 90 days. Optionally `agentId` or `flowId` (not both), `groupBy` (`code`, `version`, or both, the default) and `limit` (1 to 200, 50 by default). It needs `read` on the project.
  - **Not counted:** replays, eval runs' runs and dry runs. A child run counts under its own agent or flow.
  - **`RunBinding.failureGroups`** is optional. Without it, the route answers `501 run-failures-not-supported`.
  - **The clients:** TypeScript `runs.failures(query)`; Python `runs.failures(...)`.
- 307771f: `GET /v1/runs` (`runs.list`) narrows by more: `status` (one or several, repeated or comma-separated), `createdAfter` and `createdBefore` (strict), `agentVersion` (with `agentId`), and `flowId` with `flowVersion` (with `flowId`). An unknown status, a bad time, an empty value, or a version without its id is a `400 bad-input`. Both clients take `status` as one status or a list. An unfiltered tenant-wide page is also much faster on a large deployment.
- 307771f: **A project's schedules in one read, their owners named.** `GET /v1/schedules?projectId=` lists one project's schedules (a project id that isn't one is `400 bad-input`). `ListTriggersInput.projectId` is optional: the registry narrows, and the route keeps a page right from one that doesn't. Each schedule's `owner` gains an optional `displayName`, the owner's name at the time of the response: the person's display name from the directory, or the service account's name. It's absent when it can't be read (no directory, a removed account), and the id stands. The schedules router takes the directory and service-account bindings for it, and reads each owner once per response. The in-memory trigger registry narrows by project too. The client takes `projectId` on `schedules.list`; the CLI adds `kindgi schedules list --project=<id>` and an `OWNER` column.
- Updated dependencies [fd93b3e]
- Updated dependencies [b4bbd95]
- Updated dependencies [8b60576]
  - @kindgi/authz@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/handler@0.1.6-rc.0
  - @kindgi/flow@0.1.6-rc.0

## 0.1.5

### Patch Changes

- b67c599: Schedules can start improvement passes. `POST /v1/schedules` takes `improve: { agentId, scope }` instead of `flowId` or `agentId`, and `kindgi schedules create --improve=<agent-id>` with `--project` and `--segment`.
  - **When a pass starts:** each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent's runs in the scope since its last pass. With enough of them, across enough runs and judges, it starts a pass on a fresh test set of those runs. Otherwise the fire is `skipped`, and its `detail` says which count was short.
  - **Input:** `config.input` takes the pass options `improve` takes, plus `threshold` (default 5 judgments, 3 runs, 2 judges) and `monthlyCapUsd` (default 20). It's kept with the defaults applied.
  - **Permissions:** registering needs `publish` on the agent.
  - **Scope:** the schedule's project or a segment of it, not the tenant or an org: a pass's evidence must cover the scope it changes. Promote to the tenant by hand after review.
  - **Interval:** at most once an hour.
  - **Fires:** a fire that started a pass names it (`passId`). A pass a schedule started names the schedule and fire (`trigger`).
  - **Webhooks:** endpoints can subscribe to `improvement-pass.finished`, sent when any pass ends, with the pass. `projectId` narrows it; `flowIds` and `includeDryRuns` are about runs only. The Python `parse_event` reads it.
- b67c599: Memory erasure: a person's unfinished runs settle before anything is cleared. An erasure has a new phase, `settle`, between `expand` and `erase`: the person's waiting turns are cancelled (reason `erased`, kept in the run's history) and it waits for one an executor holds, so nothing writes their words after a store was cleared. `MemoryErasure.settleRoundsCapped` says it went on to erase while runs kept appearing. The kernel's `RunExecutingError` (`run-executing`) is a cancel the caller asked to leave to a live executor. A replay of an erased run is refused by the runtime (`run-erased`); `EvalRunSubjectInvokeOutcome.erased` (optional) tells a comparison eval run to leave that case out and count it as `erased`, like a case erased before it was listed.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- fa77071: Paging `GET /v1/conversations`, `GET /v1/approvals` and `GET /v1/runs` no longer skips rows created in the same millisecond as the last row of a page. Postgres keeps timestamps to the microsecond, and the next cursor carried the last row's time through a JavaScript `Date`, which keeps milliseconds. So rows created earlier in that millisecond were left out of every following page; approvals also had no tie-breaker, so ones created at the same instant were skipped too. The next cursor now carries the last row's position exactly, with its id; a cursor a client already holds still answers as before. Bindings: `ConversationPage.next` (the exact position of a page's last conversation) and, for approvals, `ListApprovalsBindingInput.after` with `ListApprovalsBindingResult.exactCreatedAt`; all optional, and the routes fall back to the old cursor for a binding that doesn't give them. A cursor whose time isn't a time is now a 400 on conversations and runs, as it already was on approvals.
- d25c1b3: A run can be started at most once per idempotency key, and a run records the trigger that started it. Both are additive contracts, which a runtime implements.
  
  - **`idempotencyKey`** on `RunFlowInput`, `StartRunParams`, the run handler's `invokeFlow` / `invokeAgent` inputs and `InvokeAgentInput`. A start with a key that a run of the tenant already has starts nothing and answers that run. `startRun` and the run handler say so with `existing: true`. A trigger's fire uses `fire:<fireId>`, so a re-driven fire never runs twice.
  - **`trigger`** (`RunTriggerRef`: `triggerId`, `kind` `schedule` | `event` | `webhook`, `fireId`, `scheduledFor?`) on a run started by a trigger: on `KernelRunRecord`, and on the wire as `Run.trigger` (OpenAPI `RunTrigger`).
  - **`GET /v1/runs?triggerId=`** lists the runs a trigger started: `runs.list({ triggerId })` in TypeScript, `triggerId` on `ListRunsInput`, and `kindgi runs list --trigger=<id>`.
- bc59b00: A run's principal is stored with it. `StartRunParams` takes `principal` (who starts a pending run), and the runtime keeps `RunFlowInput.principal` with the run, so every resume acts for whoever started it: an approval, a timeout, a child waking its flow, or a run recovered after a crash. Only the start stores it: `ResumeRunInput` no longer takes a `principal`, so a resume can't change whom a run acts for, and a pending run started without one keeps none, whoever adopts it. Schedules and other runs with no live caller name the principal they run as when they start.
- d7d5c45: Schedules run an agent or a flow, as their owner, with a catch-up and an overlap policy, a fire history and run-now. There's also a `kindgi schedules` command group.
  
  **`/v1/schedules`:**
  - **What it runs:** a schedule names `flowId` with `flowVersion`, or `agentId` (with an optional `agentVersion`; without one, its live version, as a run that names none).
  - **An agent schedule's input** is the agent payload, so `config.input.userMessage` is required (400 without it, on register or when a change would leave it out); a flow schedule's input is the flow's own.
  - **`projectId`:** default, the tenant's default project.
  - **`owner`:** the principal that registered it. Its runs act as the owner, checked again at every fire.
  - **`catchUp`:** after a gap, `latest` (the default) runs once for the latest missed occurrence, and its fire says how many it missed; `skip` drops them. Never a run per missed occurrence.
  - **`overlap`:** while the previous run is still going, `skip` (the default) records the fire as skipped; `allow` starts another.
  - **`startingDeadlineSeconds`:** default 600.
  - **`statusReason`:** set when the runtime paused a schedule. Repeated refused or failed fires pause it; skipped ones never count.
  - **`skipped-erasure`:** a fire whose person is being erased is recorded as `skipped-erasure` (the run start answered `erasure-in-progress`), so an erasure that waits on a shared flow can't pause an hourly schedule.
  - **New routes:**
    - `GET …/{id}?upcoming=N` shows the next occurrences;
    - `GET …/{id}/fires` is the fire history;
    - `POST …/{id}/run-now` fires it now, `manual: true`;
    - `POST …/{id}/owner` lets an admin take a schedule over.
  - **Authorization,** with an authorizer:
    - `read` on the schedule's project to read;
    - `write` to change;
    - `admin` to take ownership;
    - registering or retargeting also needs `execute` on what it runs.
  - **Kind check:** pause, resume, unregister and the new routes answer 404 for another kind's trigger.
  - **Fixed:** registering a schedule or an event trigger refused every body (`config.cronExpression is required`).
  - **`createApp({ triggerKinds })`** mounts only the kinds a deployment fires.
  - **The binding:** `TriggerRegistryBinding` gains optional `listFires`, `fireNow` and `setOwner`, and a schedule's record has a `target` (agent or flow). `@kindgi/testing` has `createInMemoryTriggerRegistry`.
  
  **Clients and CLI:**
  - **TS:** `schedules.get(id, { upcoming })`, `fires`, `runNow`, `takeOwnership`.
  - **Python:** `fires`, `run_now`, `take_ownership`.
  - **CLI:** `kindgi schedules list|get|create|update|pause|resume|run-now|fires|take-ownership|unregister`.
- Updated dependencies [0919fe6]
- Updated dependencies [1633db1]
- Updated dependencies [eff6249]
  - @kindgi/authz@0.1.5
  - @kindgi/types@0.1.5
  - @kindgi/handler@0.1.5
  - @kindgi/flow@0.1.5

## 0.1.5-rc.0

### Patch Changes

- b67c599: Schedules can start improvement passes. `POST /v1/schedules` takes `improve: { agentId, scope }` instead of `flowId` or `agentId`, and `kindgi schedules create --improve=<agent-id>` with `--project` and `--segment`.
  - **When a pass starts:** each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent's runs in the scope since its last pass. With enough of them, across enough runs and judges, it starts a pass on a fresh test set of those runs. Otherwise the fire is `skipped`, and its `detail` says which count was short.
  - **Input:** `config.input` takes the pass options `improve` takes, plus `threshold` (default 5 judgments, 3 runs, 2 judges) and `monthlyCapUsd` (default 20). It's kept with the defaults applied.
  - **Permissions:** registering needs `publish` on the agent.
  - **Scope:** the schedule's project or a segment of it, not the tenant or an org: a pass's evidence must cover the scope it changes. Promote to the tenant by hand after review.
  - **Interval:** at most once an hour.
  - **Fires:** a fire that started a pass names it (`passId`). A pass a schedule started names the schedule and fire (`trigger`).
  - **Webhooks:** endpoints can subscribe to `improvement-pass.finished`, sent when any pass ends, with the pass. `projectId` narrows it; `flowIds` and `includeDryRuns` are about runs only. The Python `parse_event` reads it.
- b67c599: Memory erasure: a person's unfinished runs settle before anything is cleared. An erasure has a new phase, `settle`, between `expand` and `erase`: the person's waiting turns are cancelled (reason `erased`, kept in the run's history) and it waits for one an executor holds, so nothing writes their words after a store was cleared. `MemoryErasure.settleRoundsCapped` says it went on to erase while runs kept appearing. The kernel's `RunExecutingError` (`run-executing`) is a cancel the caller asked to leave to a live executor. A replay of an erased run is refused by the runtime (`run-erased`); `EvalRunSubjectInvokeOutcome.erased` (optional) tells a comparison eval run to leave that case out and count it as `erased`, like a case erased before it was listed.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- fa77071: Paging `GET /v1/conversations`, `GET /v1/approvals` and `GET /v1/runs` no longer skips rows created in the same millisecond as the last row of a page. Postgres keeps timestamps to the microsecond, and the next cursor carried the last row's time through a JavaScript `Date`, which keeps milliseconds. So rows created earlier in that millisecond were left out of every following page; approvals also had no tie-breaker, so ones created at the same instant were skipped too. The next cursor now carries the last row's position exactly, with its id; a cursor a client already holds still answers as before. Bindings: `ConversationPage.next` (the exact position of a page's last conversation) and, for approvals, `ListApprovalsBindingInput.after` with `ListApprovalsBindingResult.exactCreatedAt`; all optional, and the routes fall back to the old cursor for a binding that doesn't give them. A cursor whose time isn't a time is now a 400 on conversations and runs, as it already was on approvals.
- d25c1b3: A run can be started at most once per idempotency key, and a run records the trigger that started it. Both are additive contracts, which a runtime implements.
  
  - **`idempotencyKey`** on `RunFlowInput`, `StartRunParams`, the run handler's `invokeFlow` / `invokeAgent` inputs and `InvokeAgentInput`. A start with a key that a run of the tenant already has starts nothing and answers that run. `startRun` and the run handler say so with `existing: true`. A trigger's fire uses `fire:<fireId>`, so a re-driven fire never runs twice.
  - **`trigger`** (`RunTriggerRef`: `triggerId`, `kind` `schedule` | `event` | `webhook`, `fireId`, `scheduledFor?`) on a run started by a trigger: on `KernelRunRecord`, and on the wire as `Run.trigger` (OpenAPI `RunTrigger`).
  - **`GET /v1/runs?triggerId=`** lists the runs a trigger started: `runs.list({ triggerId })` in TypeScript, `triggerId` on `ListRunsInput`, and `kindgi runs list --trigger=<id>`.
- bc59b00: A run's principal is stored with it. `StartRunParams` takes `principal` (who starts a pending run), and the runtime keeps `RunFlowInput.principal` with the run, so every resume acts for whoever started it: an approval, a timeout, a child waking its flow, or a run recovered after a crash. Only the start stores it: `ResumeRunInput` no longer takes a `principal`, so a resume can't change whom a run acts for, and a pending run started without one keeps none, whoever adopts it. Schedules and other runs with no live caller name the principal they run as when they start.
- d7d5c45: Schedules run an agent or a flow, as their owner, with a catch-up and an overlap policy, a fire history and run-now. There's also a `kindgi schedules` command group.
  
  **`/v1/schedules`:**
  - **What it runs:** a schedule names `flowId` with `flowVersion`, or `agentId` (with an optional `agentVersion`; without one, its live version, as a run that names none).
  - **An agent schedule's input** is the agent payload, so `config.input.userMessage` is required (400 without it, on register or when a change would leave it out); a flow schedule's input is the flow's own.
  - **`projectId`:** default, the tenant's default project.
  - **`owner`:** the principal that registered it. Its runs act as the owner, checked again at every fire.
  - **`catchUp`:** after a gap, `latest` (the default) runs once for the latest missed occurrence, and its fire says how many it missed; `skip` drops them. Never a run per missed occurrence.
  - **`overlap`:** while the previous run is still going, `skip` (the default) records the fire as skipped; `allow` starts another.
  - **`startingDeadlineSeconds`:** default 600.
  - **`statusReason`:** set when the runtime paused a schedule. Repeated refused or failed fires pause it; skipped ones never count.
  - **`skipped-erasure`:** a fire whose person is being erased is recorded as `skipped-erasure` (the run start answered `erasure-in-progress`), so an erasure that waits on a shared flow can't pause an hourly schedule.
  - **New routes:**
    - `GET …/{id}?upcoming=N` shows the next occurrences;
    - `GET …/{id}/fires` is the fire history;
    - `POST …/{id}/run-now` fires it now, `manual: true`;
    - `POST …/{id}/owner` lets an admin take a schedule over.
  - **Authorization,** with an authorizer:
    - `read` on the schedule's project to read;
    - `write` to change;
    - `admin` to take ownership;
    - registering or retargeting also needs `execute` on what it runs.
  - **Kind check:** pause, resume, unregister and the new routes answer 404 for another kind's trigger.
  - **Fixed:** registering a schedule or an event trigger refused every body (`config.cronExpression is required`).
  - **`createApp({ triggerKinds })`** mounts only the kinds a deployment fires.
  - **The binding:** `TriggerRegistryBinding` gains optional `listFires`, `fireNow` and `setOwner`, and a schedule's record has a `target` (agent or flow). `@kindgi/testing` has `createInMemoryTriggerRegistry`.
  
  **Clients and CLI:**
  - **TS:** `schedules.get(id, { upcoming })`, `fires`, `runNow`, `takeOwnership`.
  - **Python:** `fires`, `run_now`, `take_ownership`.
  - **CLI:** `kindgi schedules list|get|create|update|pause|resume|run-now|fires|take-ownership|unregister`.
- Updated dependencies [0919fe6]
- Updated dependencies [1633db1]
- Updated dependencies [eff6249]
  - @kindgi/authz@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/handler@0.1.5-rc.0
  - @kindgi/flow@0.1.5-rc.0

## 0.1.4

### Patch Changes

- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
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
- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
- Updated dependencies [2b34f78]
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [b8ff156]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/authz@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/flow@0.1.4
  - @kindgi/handler@0.1.4

## 0.1.4-rc.5

### Patch Changes

- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
- @kindgi/flow@0.1.4-rc.5
  - @kindgi/authz@0.1.4-rc.5
  - @kindgi/handler@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/authz@0.1.4-rc.4
  - @kindgi/flow@0.1.4-rc.4
  - @kindgi/handler@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/authz@0.1.4-rc.3
  - @kindgi/flow@0.1.4-rc.3
  - @kindgi/handler@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- Updated dependencies [2b34f78]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/authz@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/handler@0.1.4-rc.2
  - @kindgi/flow@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- Updated dependencies [b8ff156]
  - @kindgi/flow@0.1.4-rc.1
  - @kindgi/authz@0.1.4-rc.1
  - @kindgi/handler@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

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
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/flow@0.1.4-rc.0
  - @kindgi/authz@0.1.4-rc.0
  - @kindgi/handler@0.1.4-rc.0

## 0.1.3

### Patch Changes

- 6bae409: An agent's turn names its agent. The run record of an agent run, and of the turn a flow's agent step starts, carries `agent`: the agent's id, the version that ran and the conversation (`RunAgentRef` in `@kindgi/runtime`, `Run.agent` on the wire, the `RunAgent` schema). `GET /v1/runs?agentId=` lists one agent's turns, at every version; it combines with the scope, `topLevel` and the cursor. The TypeScript client takes `runs.list({ agentId })`; the Python client `runs.list(agent_id=…)`. Turns that ran before this release don't name their agent: they have no `agent` and aren't listed by `agentId`.
- Updated dependencies [1463b77]
- Updated dependencies [eac7732]
  - @kindgi/types@0.1.3
  - @kindgi/handler@0.1.3
  - @kindgi/authz@0.1.3
  - @kindgi/flow@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- a994217: An approval gate keeps its decision when the turn resumes. A turn that parked on a gate decided again on resume, from the policy and conversation as they were by then: a rule relaxed meanwhile skipped the gate, so a reviewer's reject was never read and the tool ran; a turn completed meanwhile changed the session gate's token, so the decision was ignored and the turn parked again.
  
  - `NodeContext.record(key, decide)` (`@kindgi/handler`): decide once per step. The first call journals `decide`'s result; when the step runs again after a wait, the call returns it without deciding again. The journal entry is `value.recorded`, derived into `DerivedRunState.recordedValues` (`@kindgi/runtime`, `recordedValueKey`).
  - `record` is a new required member of `NodeContext`: a test double that builds its own `NodeContext` adds it. A decision outlives a retry of the step as well as a wait; calls for one key at the same time share one decision; the first call returns the JSON the journal keeps, as a replay does.
  - `NodeContext.clockNow` replays as documented: when the step resumes after a wait, its calls return the times they read before, in call order. A retry after a failure reads the clock afresh.
  - The session and tool approval gates (`@kindgi/agents`) decide through `record`. A gate not yet reached follows the policy as it is now.
  - `resumeAgentTurn` reports a snapshot it couldn't read as `run-snapshot-unreadable` (resuming again may work), apart from `run-snapshot-missing`. Both are declared: `RunSnapshotError` in `InvokeAgentError`.
  
  Upgrading: a turn that parked on a gate under an earlier runtime has no recorded decision, so when this runtime resumes it, its gate decides once more from the current policy, as before.
- Updated dependencies [966a615]
- Updated dependencies [a994217]
  - @kindgi/authz@0.1.2
  - @kindgi/flow@0.1.2
  - @kindgi/handler@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/authz@0.1.1
  - @kindgi/flow@0.1.1
  - @kindgi/handler@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: `KernelError` gains `RunLeaseLostError` (`code: 'run-lease-lost'`): the executor no longer holds the run's lease, because another executor claimed the run after this one's lease expired. It stops without failing or finishing the run, and the lease holder decides what happens to it. `@kindgi/api` maps it to 409, like `run-already-terminal`.
- aec851d: A turn parked on a tool-call approval resumes where it parked.
  
  - `@kindgi/agents`:
    - **Fix: `resumeAgentTurn` after a tool-call approval.** It used to fail with `model-invocation-failed` ("model-call invoked before setup completed"), because the steps that ran before the park kept their state in memory. The turn now rebuilds that state:
      - its environment (conversation, guardrails, tools, policies), routed to the provider and model the turn started on. If that provider or model is no longer registered or allowed, the resume fails with `capability-routing-failed`.
      - the messages the turn stored, its retrieved facts, and its usage, so budgets count the whole turn.
    - **No repeats.** The step that parked runs again. It reuses the assistant message and the results of calls that ran before the park, so no call runs twice and nothing is stored twice.
    - **Errors.** `run-journal-unavailable` when the run's journal can't be read.
    - **Not rebuilt: provenance.** Provenance recorded before the park isn't rebuilt; the resumed turn's record starts at the resume.
  - `@kindgi/runtime`:
    - `DerivedRunState.completedBodySteps`: the loop-body steps that completed, by `bodyStepKey(nodeId, loopContext)`. A runtime replaying a loop on resume hands those steps their journaled results instead of running them again.
    - `CompletedBodyStep` and `bodyStepKey`.
- aec851d: A runtime can keep a run's state in memory, and publish journal entries in batches.
  
  - `@kindgi/runtime`:
    - `createRunState()`, `applyJournalEntry(state, entry)` and `cloneRunState(state)`.
      - `deriveRunState(journal)` is the fold of the first two.
      - A runtime reads a run's journal once, then applies each entry it writes, instead of reading the journal again.
      - It dispatches against a clone, so a running step sees the run as it was when the step was dispatched.
    - `KernelEventBusBinding.publishMany?(tenantId, channel, docs)` (optional): publish entries that were written together, in one call. The runtime uses it when the binding has it, and `publish` for each entry otherwise.
  - `@kindgi/api`: `EventBusBinding.publishMany?` (optional). It works like `publish` for each doc, with consecutive `seq`s and one notification.
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

### Patch Changes

- aec851d: Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/flow@0.1.0
  - @kindgi/authz@0.1.0
  - @kindgi/handler@0.1.0
