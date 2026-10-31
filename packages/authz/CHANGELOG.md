# @kindgi/authz

## 0.3.1-rc.1

### Patch Changes

- @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- 8dd91b0: **Flows and tools can have pinned versions, as agents have live versions.** A pin says which version is in use in a scope (a project, an org or the tenant) when nothing names one. A new version is then published without going into use where a pin covers. Without a pin, a new version is in use at once, as before.
  - `@kindgi/api` adds `PinnedVersionBinding`, the binding behind the pins, and `createApp({ pinnedVersions })` to wire it. Its `resolve` takes the most specific pin covering a project (the project, its org, then the tenant) whose version is still active. `list`, `pin`, `unpin` and `history` keep each change for good: what was pinned before and after, who asked and why.
  - The pin routes check, in order: the right to pin, the scope (a segment is `400 scope-invalid`, since flows and tools pin no finer than a project), the item and its version, that a project scope reaches the item, and that a pin wider than one project isn't for an item in an environment order (`409 pin-scope-spans-environments`). A tool pin is also refused on a later environment of an order (`409 environment-takes-promotions`), since a tool's pin acts where agent and flow versions are made. A tool that follows its server, an MCP catalog's or one the runtime ships, can't be pinned (`400 tool-not-pinnable`).
  - Flows: with the binding, `/v1/flows/{flowId}` gains the five pin routes (`flows.pinned.resolve`, `list`, `pin`, `unpin` and `history`). A run that names no flow version takes the version pinned for its project, else the newest the project reaches, and `GET …/pinned` answers what such a run takes there; a pin whose version doesn't reach the project is passed over, as a run passes it over. Under `kindgi dev`, the flow registry is read-only and a pin write is refused with `409 registry-read-only`, as its other writes are. `Run` gains the optional `flowVersionVia` (`explicit`, `pinned` or `latest`) and `flowPinnedScope`, and `StartRunBody.flowVersion` says that an omitted version takes the pin.
  - Tools: with the binding, `/v1/tools/{toolId}` gains the same five routes (`tools.pinned.*`). An agent or flow version made in a project a tool's pin covers (`POST /v1/agents`, `POST /v1/flows`, a deploy) locks the tool at the pinned version: a flow's tool step always, an agent's tool range when the pinned version is in it; else as before. A deploy looks each tool's pin up once. `GET …/pinned` answers what a flow version made there would lock. A tool an MCP catalog lists (its `kindgi.mcp` metadata) is refused with `400 tool-not-pinnable`, and a pin on a later environment of an order with `409 environment-takes-promotions`.
  - A deployment promotion with `makeLive` also pins each flow version it carries for the target project, after the agents, and its answer lists them in the new optional `pinnedFlows` (`DeploymentPinnedFlow`: `{id, version}`). The right to pin each flow is checked with the agents' rights, before any pin. An error after some pins lists the flows pinned so far in `error.details.pinnedFlows`, as `error.details.live` lists the agents. Without the binding, nothing pins a flow and the answer has no `pinnedFlows`.
  - Unregistering a pinned flow or tool version answers `409 flow-version-pinned` or `409 tool-version-pinned`, naming the pins' scopes in `details.scopes`: `FlowUnregisterOutcome` and `ToolUnregisterOutcome` gain the optional `pinned`, which a registry that knows pins sets.
  - New schemas: `PinScope`, `PinActor`, `PinnedVersionResolution`, `PinnedVersion`, `PinnedVersionList`, `PinnedVersionChange`, `PinnedVersionChangePage`, `PinVersionBody` and `UnpinVersionBody`. New error codes: `pin-scope-spans-environments`, `tool-not-pinnable`, and `flow-version-pinned` and `tool-version-pinned`, which a runtime answers when a pinned version is unregistered or its item deleted.
  - `@kindgi/authz` adds the `pin` action (`can_pin`) on flows and tools, so a caller's permissions can list it there.
  - `@kindgi/compliance` and `@kindgi/specs` add six audit kinds: `flow-pinned`, `flow-unpinned`, `flow-pin-inactive`, `tool-pinned`, `tool-unpinned` and `tool-pin-inactive`.
  - `@kindgi/types` adds `PinScope`, `PinnedItemKind` and `FlowVersionVia`.
  - `@kindgi/runtime`: `RunFlowInput`, `StartRunParams` and `KernelRunRecord` gain the optional `flowVersionVia` and `flowPinnedScope`, recorded with the run.
  - `@kindgi/cli`: `kindgi promote --make-live` also prints each flow version it pinned in `--to`, under "Flows pinned in", and its help says so; with `--json` they are in `promotion.pinnedFlows`. `kindgi exports create` writes each flow's and tool's pins, in `flow-pinned-versions.jsonl` and `tool-pinned-versions.jsonl`, and their changes, in `flow-pin-history.jsonl` and `tool-pin-history.jsonl`, one line per record under its flow's or tool's id.
  - `@kindgi/client`: `client.flows.pinned.{resolve, list, pin, unpin, history}`, the same on `client.tools.pinned`, `Run.flowVersionVia` and `Run.flowPinnedScope`, and `DeploymentPromotion.pinnedFlows`.
  - `@kindgi/sdk`: the four flow skills (`kindgi-authoring-flows` and its Java, Python and Scala ones) say a run keeps the flow version it started on, and that a run naming no version takes the version pinned for its project (or its org, or the tenant), else the newest the project reaches.
- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **Flows and tools can have pinned versions, as agents have live versions.** A pin says which version is in use in a scope (a project, an org or the tenant) when nothing names one. A new version is then published without going into use where a pin covers. Without a pin, a new version is in use at once, as before.
  - `@kindgi/api` adds `PinnedVersionBinding`, the binding behind the pins, and `createApp({ pinnedVersions })` to wire it. Its `resolve` takes the most specific pin covering a project (the project, its org, then the tenant) whose version is still active. `list`, `pin`, `unpin` and `history` keep each change for good: what was pinned before and after, who asked and why.
  - The pin routes check, in order: the right to pin, the scope (a segment is `400 scope-invalid`, since flows and tools pin no finer than a project), the item and its version, that a project scope reaches the item, and that a pin wider than one project isn't for an item in an environment order (`409 pin-scope-spans-environments`). A tool pin is also refused on a later environment of an order (`409 environment-takes-promotions`), since a tool's pin acts where agent and flow versions are made. A tool that follows its server, an MCP catalog's or one the runtime ships, can't be pinned (`400 tool-not-pinnable`).
  - Flows: with the binding, `/v1/flows/{flowId}` gains the five pin routes (`flows.pinned.resolve`, `list`, `pin`, `unpin` and `history`). A run that names no flow version takes the version pinned for its project, else the newest the project reaches, and `GET …/pinned` answers what such a run takes there; a pin whose version doesn't reach the project is passed over, as a run passes it over. Under `kindgi dev`, the flow registry is read-only and a pin write is refused with `409 registry-read-only`, as its other writes are. `Run` gains the optional `flowVersionVia` (`explicit`, `pinned` or `latest`) and `flowPinnedScope`, and `StartRunBody.flowVersion` says that an omitted version takes the pin.
  - Tools: with the binding, `/v1/tools/{toolId}` gains the same five routes (`tools.pinned.*`). An agent or flow version made in a project a tool's pin covers (`POST /v1/agents`, `POST /v1/flows`, a deploy) locks the tool at the pinned version: a flow's tool step always, an agent's tool range when the pinned version is in it; else as before. A deploy looks each tool's pin up once. `GET …/pinned` answers what a flow version made there would lock. A tool an MCP catalog lists (its `kindgi.mcp` metadata) is refused with `400 tool-not-pinnable`, and a pin on a later environment of an order with `409 environment-takes-promotions`.
  - A deployment promotion with `makeLive` also pins each flow version it carries for the target project, after the agents, and its answer lists them in the new optional `pinnedFlows` (`DeploymentPinnedFlow`: `{id, version}`). The right to pin each flow is checked with the agents' rights, before any pin. An error after some pins lists the flows pinned so far in `error.details.pinnedFlows`, as `error.details.live` lists the agents. Without the binding, nothing pins a flow and the answer has no `pinnedFlows`.
  - Unregistering a pinned flow or tool version answers `409 flow-version-pinned` or `409 tool-version-pinned`, naming the pins' scopes in `details.scopes`: `FlowUnregisterOutcome` and `ToolUnregisterOutcome` gain the optional `pinned`, which a registry that knows pins sets.
  - New schemas: `PinScope`, `PinActor`, `PinnedVersionResolution`, `PinnedVersion`, `PinnedVersionList`, `PinnedVersionChange`, `PinnedVersionChangePage`, `PinVersionBody` and `UnpinVersionBody`. New error codes: `pin-scope-spans-environments`, `tool-not-pinnable`, and `flow-version-pinned` and `tool-version-pinned`, which a runtime answers when a pinned version is unregistered or its item deleted.
  - `@kindgi/authz` adds the `pin` action (`can_pin`) on flows and tools, so a caller's permissions can list it there.
  - `@kindgi/compliance` and `@kindgi/specs` add six audit kinds: `flow-pinned`, `flow-unpinned`, `flow-pin-inactive`, `tool-pinned`, `tool-unpinned` and `tool-pin-inactive`.
  - `@kindgi/types` adds `PinScope`, `PinnedItemKind` and `FlowVersionVia`.
  - `@kindgi/runtime`: `RunFlowInput`, `StartRunParams` and `KernelRunRecord` gain the optional `flowVersionVia` and `flowPinnedScope`, recorded with the run.
  - `@kindgi/cli`: `kindgi promote --make-live` also prints each flow version it pinned in `--to`, under "Flows pinned in", and its help says so; with `--json` they are in `promotion.pinnedFlows`. `kindgi exports create` writes each flow's and tool's pins, in `flow-pinned-versions.jsonl` and `tool-pinned-versions.jsonl`, and their changes, in `flow-pin-history.jsonl` and `tool-pin-history.jsonl`, one line per record under its flow's or tool's id.
  - `@kindgi/client`: `client.flows.pinned.{resolve, list, pin, unpin, history}`, the same on `client.tools.pinned`, `Run.flowVersionVia` and `Run.flowPinnedScope`, and `DeploymentPromotion.pinnedFlows`.
  - `@kindgi/sdk`: the four flow skills (`kindgi-authoring-flows` and its Java, Python and Scala ones) say a run keeps the flow version it started on, and that a run naming no version takes the version pinned for its project (or its org, or the tenant), else the newest the project reaches.
- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0-rc.0

## 0.2.0

### Patch Changes

- b6e20ca: **A trigger can't be set to run as an owner that can't run what it starts.** With an authorization store, the check every fire makes is now also made when the owner or the target is set: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule.
  - Registering a schedule, webhook or mail trigger, or taking one over, with `runAsServiceAccountId` (`--run-as`): an account that can't is refused with `409 trigger-owner-cannot-run-target`, and nothing is registered or changed. The message names the account and the target, and what fixes it: give the account the editor role on the target's project, or name another account. Only a caller who may name the account (`act_as`, a tenant admin's) gets this far.
  - Running one as the project (`runAsProject`, `--run-as=project`), on create or take-over: the project's own account runs only what the project's editors can, so a target it can't run, such as one another project serves, is refused with the same 409. Its message says what fixes it: run the trigger as a service account that can, or own it yourself. The account is made before the check, so it stays, with no keys, for the next `runAsProject`.
  - Changing a schedule's or mail trigger's target (another agent or flow, or for a schedule an Improve pass): the trigger keeps its owner, so the owner, a service account or a person, must be able to run the new target. Otherwise the change is refused with the same 409, naming the owner (or, for the project's own account, saying a project admin can take the trigger over first), and nothing changes. It isn't checked when the caller is the owner, whose own check has run, nor for an owner that was unregistered or removed: every fire is refused for that already, and a take-over is the fix.
  - Before, the change was accepted, and then every fire was refused ("may no longer run") until the trigger paused.
  - Without an authorization store, nothing changes: a grant limits nothing there.
  
  `@kindgi/authz` exports `targetAccess(target)`: the action and resource a trigger's target is checked by.
- @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- b6e20ca: **A trigger can't be set to run as an owner that can't run what it starts.** With an authorization store, the check every fire makes is now also made when the owner or the target is set: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule.
  - Registering a schedule, webhook or mail trigger, or taking one over, with `runAsServiceAccountId` (`--run-as`): an account that can't is refused with `409 trigger-owner-cannot-run-target`, and nothing is registered or changed. The message names the account and the target, and what fixes it: give the account the editor role on the target's project, or name another account. Only a caller who may name the account (`act_as`, a tenant admin's) gets this far.
  - Running one as the project (`runAsProject`, `--run-as=project`), on create or take-over: the project's own account runs only what the project's editors can, so a target it can't run, such as one another project serves, is refused with the same 409. Its message says what fixes it: run the trigger as a service account that can, or own it yourself. The account is made before the check, so it stays, with no keys, for the next `runAsProject`.
  - Changing a schedule's or mail trigger's target (another agent or flow, or for a schedule an Improve pass): the trigger keeps its owner, so the owner, a service account or a person, must be able to run the new target. Otherwise the change is refused with the same 409, naming the owner (or, for the project's own account, saying a project admin can take the trigger over first), and nothing changes. It isn't checked when the caller is the owner, whose own check has run, nor for an owner that was unregistered or removed: every fire is refused for that already, and a take-over is the fix.
  - Before, the change was accepted, and then every fire was refused ("may no longer run") until the trigger paused.
  - Without an authorization store, nothing changes: a grant limits nothing there.
  
  `@kindgi/authz` exports `targetAccess(target)`: the action and resource a trigger's target is checked by.
- @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- d563887: **Rights on an item an environment order carries come from the projects that serve it.** Once an order carries an agent, a flow, a tool, a guardrail, a data block or an eval suite from one environment to the next, each project that serves the item governs what happens to it there. All of this applies only when the runtime wires `itemProjects` (`ItemProjectsBinding`, new on `CreateAppInput`). An item that one project serves is checked as before, check for check.
  - **Reading.** A caller reads the item through any project that serves it, and sees each version that can run in a project it reads. A version it can't see answers as one that doesn't exist, with the same 404. `GET /v1/agents/{agentId}`, `/v1/flows/{flowId}`, `/v1/tools/{toolId}`, `/v1/eval-suites/{suiteId}` and `/v1/blocks/{blockId}`, and each list row, answer the newest active version the caller can see. A grant on the item itself reads as its first project's readers do. An agent's live versions and promotions list only versions the caller can see.
  - **`?projectId=`** on those five reads answers the newest version that can run in that project, which the caller must read. Otherwise it's a 404, the same whether or not the item runs there. A value that isn't a project id (a UUID) is a 400. On an item one project serves, only its own project answers; on one that names no project (under `kindgi dev`, a pack's agents, flows and tools), any project does. With authorization off, the caller reads every project, so each one answers the version it runs. An older runtime ignores the parameter and answers the latest version.
  - **Changing.** A change in one project needs the right on that project, and not the item's own as well. A promotion, a rollback or an unpin of a project's or a segment's live version is `admin` there. A tenant's or an org's live version needs `admin` on every project that serves the item. Unregistering or reinstating a version needs `admin` on every project that version can run in (`write`, for a data block). A derived agent version, an improvement proposal and an improvement pass are `write` in the order's first environment, where the item's new versions are made. Requesting or rolling back a proposal is `admin` where its scope is. Building a test set from judgments under such a suite is `admin` in the project whose judged runs it takes, where the new version is made; a body naming a project the suite isn't in needs `admin` on every project of the suite.
  - **Running.** A run of an agent in one of its projects needs `call` on that project, which its callers and editors have. A run of a flow or an eval suite needs `execute` there, which its executors and editors have. Neither the item's own `execute` nor `write` on the named project is asked. An unnamed run is checked where the runtime puts it: the conversation's project; else a project-scoped key's own project, when that project serves the item, and the run is filed there; else the item's first project. Opening and closing a conversation, scheduling an agent or a flow, and wiring a webhook trigger are checked the same way, in the conversation's or the trigger's project. A schedule that improves an agent is `write` in the order's first environment. An eval run still needs `write` on its project.
  - **What runs leave.** An eval run of such a suite is read on its own project, and cancelled or rescored with `execute` there. An event trigger's runs land in the flow's first project, so registering one is `write` on the flow and `execute` there, and reading one is `read` there. Reading observations of such an agent needs `read` on every project that serves it.
  - A project-scoped key reaches only what its project serves.
  - `@kindgi/authz`: `Action` gains `call`. `CHECK_ONLY_ACTIONS` lists what the model defines but a role's capabilities never report: a project's `call` and `execute`. `GET /v1/identity/me/permissions` doesn't change.
  - `@kindgi/client`: `get` on agents, flows, tools, eval suites and blocks takes `{ projectId }` (`GetLatestOptions`). In the Python client, `project_id`.
- 3502389: A webhook or schedule trigger can run as a **service account**. A trigger's runs act as its owner; now the owner can be an account rather than whoever registered it. Pass `runAsServiceAccountId` when registering (`webhooks.register`, `schedules.register`) or when taking over a trigger whose owner left (`webhooks.takeOwnership`, `schedules.takeOwnership`), or `--run-as <service-account-id>` on `kindgi webhooks register`, `kindgi schedules create` and the `take-ownership` commands. Naming an account needs `act_as` on it. Only a caller who may read service accounts learns whether a named one is missing, unregistered or not `act_as`-able; everyone else gets a uniform permission error.
- @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- d563887: **Rights on an item an environment order carries come from the projects that serve it.** Once an order carries an agent, a flow, a tool, a guardrail, a data block or an eval suite from one environment to the next, each project that serves the item governs what happens to it there. All of this applies only when the runtime wires `itemProjects` (`ItemProjectsBinding`, new on `CreateAppInput`). An item that one project serves is checked as before, check for check.
  - **Reading.** A caller reads the item through any project that serves it, and sees each version that can run in a project it reads. A version it can't see answers as one that doesn't exist, with the same 404. `GET /v1/agents/{agentId}`, `/v1/flows/{flowId}`, `/v1/tools/{toolId}`, `/v1/eval-suites/{suiteId}` and `/v1/blocks/{blockId}`, and each list row, answer the newest active version the caller can see. A grant on the item itself reads as its first project's readers do. An agent's live versions and promotions list only versions the caller can see.
  - **`?projectId=`** on those five reads answers the newest version that can run in that project, which the caller must read. Otherwise it's a 404, the same whether or not the item runs there. A value that isn't a project id (a UUID) is a 400. On an item one project serves, only its own project answers; on one that names no project (under `kindgi dev`, a pack's agents, flows and tools), any project does. With authorization off, the caller reads every project, so each one answers the version it runs. An older runtime ignores the parameter and answers the latest version.
  - **Changing.** A change in one project needs the right on that project, and not the item's own as well. A promotion, a rollback or an unpin of a project's or a segment's live version is `admin` there. A tenant's or an org's live version needs `admin` on every project that serves the item. Unregistering or reinstating a version needs `admin` on every project that version can run in (`write`, for a data block). A derived agent version, an improvement proposal and an improvement pass are `write` in the order's first environment, where the item's new versions are made. Requesting or rolling back a proposal is `admin` where its scope is. Building a test set from judgments under such a suite is `admin` in the project whose judged runs it takes, where the new version is made; a body naming a project the suite isn't in needs `admin` on every project of the suite.
  - **Running.** A run of an agent in one of its projects needs `call` on that project, which its callers and editors have. A run of a flow or an eval suite needs `execute` there, which its executors and editors have. Neither the item's own `execute` nor `write` on the named project is asked. An unnamed run is checked where the runtime puts it: the conversation's project; else a project-scoped key's own project, when that project serves the item, and the run is filed there; else the item's first project. Opening and closing a conversation, scheduling an agent or a flow, and wiring a webhook trigger are checked the same way, in the conversation's or the trigger's project. A schedule that improves an agent is `write` in the order's first environment. An eval run still needs `write` on its project.
  - **What runs leave.** An eval run of such a suite is read on its own project, and cancelled or rescored with `execute` there. An event trigger's runs land in the flow's first project, so registering one is `write` on the flow and `execute` there, and reading one is `read` there. Reading observations of such an agent needs `read` on every project that serves it.
  - A project-scoped key reaches only what its project serves.
  - `@kindgi/authz`: `Action` gains `call`. `CHECK_ONLY_ACTIONS` lists what the model defines but a role's capabilities never report: a project's `call` and `execute`. `GET /v1/identity/me/permissions` doesn't change.
  - `@kindgi/client`: `get` on agents, flows, tools, eval suites and blocks takes `{ projectId }` (`GetLatestOptions`). In the Python client, `project_id`.
- 3502389: A webhook or schedule trigger can run as a **service account**. A trigger's runs act as its owner; now the owner can be an account rather than whoever registered it. Pass `runAsServiceAccountId` when registering (`webhooks.register`, `schedules.register`) or when taking over a trigger whose owner left (`webhooks.takeOwnership`, `schedules.takeOwnership`), or `--run-as <service-account-id>` on `kindgi webhooks register`, `kindgi schedules create` and the `take-ownership` commands. Naming an account needs `act_as` on it. Only a caller who may read service accounts learns whether a named one is missing, unregistered or not `act_as`-able; everyone else gets a uniform permission error.
- @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0

## 0.1.6

### Patch Changes

- fd93b3e: **The access audit keeps every refusal.** Refusals the API decided before asking the authorization model weren't recorded: what a caller's API key rules out (a `member` key asking a tenant admin's action, a key limited to a project reaching outside it, a key without the capability a write needs) and a caller who isn't a reviewer on the approvals routes. They're now recorded like every other decision, through the binding's new optional `recordDecision` (`@kindgi/authz`), with a `reason` saying which check refused.
  - `refused()` (with `capabilityRefusal()`) is the one way a route refuses on its own check: it records and answers `403 permission-denied`, the route's message unchanged, with `action`, `resource` and `reason` in the details.
  - A check the authorization model can't answer (an action it doesn't define on the type) is recorded as one, and a test over every operation fails on it.
  - A runtime without `recordDecision` refuses as before, recording nothing more.
- Updated dependencies [b4bbd95]
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- fd93b3e: **The access audit keeps every refusal.** Refusals the API decided before asking the authorization model weren't recorded: what a caller's API key rules out (a `member` key asking a tenant admin's action, a key limited to a project reaching outside it, a key without the capability a write needs) and a caller who isn't a reviewer on the approvals routes. They're now recorded like every other decision, through the binding's new optional `recordDecision` (`@kindgi/authz`), with a `reason` saying which check refused.
  - `refused()` (with `capabilityRefusal()`) is the one way a route refuses on its own check: it records and answers `403 permission-denied`, the route's message unchanged, with `action`, `resource` and `reason` in the details.
  - A check the authorization model can't answer (an action it doesn't define on the type) is recorded as one, and a test over every operation fails on it.
  - A runtime without `recordDecision` refuses as before, recording nothing more.
- Updated dependencies [b4bbd95]
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- 0919fe6: API keys act for a person or a service account, with that principal's grants. All of it is optional for a runtime: what it doesn't wire, it doesn't mount.
  - **Whom a key acts for:**
    - `POST /v1/tokens` takes `for` (`{kind: 'user' | 'service-account', id}`), the caller by default.
    - Only a tenant admin mints for someone else, or mints an `admin` key. A key's record and `GET /v1/identity/whoami` carry `principal`; whoami also gives a key's `tokenId`, `role` and `projectId`.
    - Anyone may list, read and revoke their own keys. A tenant admin sees every key, and `?principal=user:<id>` filters to one principal's. Someone else's key reads as `404`.
    - A token that names no principal works as before: tenant admins only, and the key is a service account of its own.
  - **A key's `role` is a ceiling.** A `member` key takes no `admin` action, even for an admin. The authorizer applies a key's limits in `filterByCan` too, so a list never shows what the key can't reach.
  - **A key's `projectId` is a limit:**
    - A request naming another project, in the path (`/projects/<id>`), the query (`projectId`, or `scopeKind=project&scopeId`) or a write body (`projectId`, `scope.projectId`), is `403 key-project-mismatch`.
    - Such a key takes no `admin` action on the tenant, an org or a team, and mints only keys limited to the same project.
    - It reaches only its project's resources (an agent, a run, a secret, …): the authorizer asks the authorization store with the new optional `AuthzCheckBinding.inProject` from `@kindgi/authz`. A store without it limits the key to the project itself.
  - **Refusals:**
    - `404 principal-not-found`: `for` names nobody.
    - `403 role-exceeds-principal`: an `admin` key for a principal who isn't a tenant admin.
  - **Service accounts** (`/v1/service-accounts`, tenant admins, with a `ServiceAccountBinding`):
    - Create one with its first grants (tenant admin, tenant member, or a role on a project); list, get, `grant`, `ungrant`, and `unregister` (a tombstone: its grants go and its keys stop working).
    - A service account isn't a tenant member unless it's granted `{kind: 'tenant-member'}`, which lets it read the tenant's settings (providers, policies, adapters, signing keys, deployments). Give it only what its job needs.
    - Errors: `404 service-account-not-found`, `409 service-account-name-taken` and `409 service-account-unregistered`.
  - **Revoking sessions:** `POST /v1/identity/users/{userId}/revoke-sessions` now needs a tenant admin, unless the caller revokes their own sessions (`403 permission-denied`). Any caller could revoke anyone's before.
  - **Add a person:** `POST /v1/identity/users` (`{displayName, primaryEmail?}`), tenant admins only. It is mounted when the identity directory implements the new optional `createUser`. The person becomes a tenant member: they can read the tenant's settings, not its projects, until they're given a role. An email another person already has is `409 identity-user-email-taken`.
  - **TypeScript client:**
    - `tokens.create({ for })`, `tokens.list({ principal })`, the new `serviceAccounts` resource, and `users.create` (it used to throw `not-yet-wired`).
    - The new error codes are classified.
  - **Python client:** `tokens.mint(for_=…)`, `service_accounts.*` and `identity.users.create`.
  - **Evidence kinds:** `api-key-minted`, `api-key-revoked`, `service-account-created`, `service-account-granted`, `service-account-ungranted`, `service-account-unregistered` and `person-added` join `EVIDENCE_KINDS` and the evidence schema. A key's secret is never in one. The stores learn who acted: `TokenRevokeInput.revokedBy`, and `by` on a service account's grant, ungrant and unregister.
  - **Retention domains `api_key` and `service_account`:** a retention policy can purge revoked and expired keys, and unregistered service accounts, after its grace.
- 1633db1: Memory facts keep their id across revisions, and every read sees only what the caller may.
  
  - **The scope guard.** A memory read gets `readers` (`MemoryReaders`): the projects, orgs, user, end user (`participantId`, new on `MemoryScope`) and conversations it may see. A binding applies them inside its query, before any limit; `isReadableBy` is the rule. On `/v1/memory`, the route works out the readers from the caller: a tenant admin reads everything; anyone else reads tenant-wide facts, the projects and orgs they may read, their own user facts, and every end user's and conversation's facts in the projects they may write. Writes are checked against the scope (`403 permission-denied`). An agent turn's retrievals see the run's project and org, the user it acts for, its conversation and that conversation's end user, never another conversation's or another end user's; `same-project` in a run without a project selects nothing.
  - **Revisions.** `POST /v1/memory/facts/{factId}/supersede` writes the fact's next revision (same id, body `{ content, expectVersion?, … }`) and returns it; `DELETE /v1/memory/facts/{factId}` closes the current one; `POST …/verify` marks it verified; `GET …/revisions` lists them; `?version=` and `?asOf=` read the past. `409 fact-changed` (with `expectVersion`) and `409 legal-hold` refuse; a runtime without delete, verify or history answers `501 memory-operation-unsupported`.
  - **Facts** carry `revisionId`, `trust`, `verifiedBy`/`verifiedAt`, `attributedTo` (from the writer), `generatedBy`, `subjects`, `validFrom`/`validUntil`/`observedAt`, `invalidatedAt`/`invalidatedBy`/`invalidationReason` and `review`, all optional.
  - `AuthzCheckBinding.listObjects` (optional) lists the objects a principal may act on.
  - `POST /v1/runs` hands the run handler the caller (`InvokeAgentBindingInput.principal`, `InvokeFlowBindingInput.principal`), so a turn knows whom it acts for: their own user facts are among what it may read.
  - Clients: `memory.facts.supersede`, `.delete` (now `DELETE`, returning the closed revision), `.verify`, `.revisions`, and `version`/`asOf` on `read`/`list`. CLI: `kindgi memory facts supersede|delete|verify|revisions`, `--revision` and `--as-of` on `get`, `--as-of` on `list`.
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- 0919fe6: API keys act for a person or a service account, with that principal's grants. All of it is optional for a runtime: what it doesn't wire, it doesn't mount.
  - **Whom a key acts for:**
    - `POST /v1/tokens` takes `for` (`{kind: 'user' | 'service-account', id}`), the caller by default.
    - Only a tenant admin mints for someone else, or mints an `admin` key. A key's record and `GET /v1/identity/whoami` carry `principal`; whoami also gives a key's `tokenId`, `role` and `projectId`.
    - Anyone may list, read and revoke their own keys. A tenant admin sees every key, and `?principal=user:<id>` filters to one principal's. Someone else's key reads as `404`.
    - A token that names no principal works as before: tenant admins only, and the key is a service account of its own.
  - **A key's `role` is a ceiling.** A `member` key takes no `admin` action, even for an admin. The authorizer applies a key's limits in `filterByCan` too, so a list never shows what the key can't reach.
  - **A key's `projectId` is a limit:**
    - A request naming another project, in the path (`/projects/<id>`), the query (`projectId`, or `scopeKind=project&scopeId`) or a write body (`projectId`, `scope.projectId`), is `403 key-project-mismatch`.
    - Such a key takes no `admin` action on the tenant, an org or a team, and mints only keys limited to the same project.
    - It reaches only its project's resources (an agent, a run, a secret, …): the authorizer asks the authorization store with the new optional `AuthzCheckBinding.inProject` from `@kindgi/authz`. A store without it limits the key to the project itself.
  - **Refusals:**
    - `404 principal-not-found`: `for` names nobody.
    - `403 role-exceeds-principal`: an `admin` key for a principal who isn't a tenant admin.
  - **Service accounts** (`/v1/service-accounts`, tenant admins, with a `ServiceAccountBinding`):
    - Create one with its first grants (tenant admin, tenant member, or a role on a project); list, get, `grant`, `ungrant`, and `unregister` (a tombstone: its grants go and its keys stop working).
    - A service account isn't a tenant member unless it's granted `{kind: 'tenant-member'}`, which lets it read the tenant's settings (providers, policies, adapters, signing keys, deployments). Give it only what its job needs.
    - Errors: `404 service-account-not-found`, `409 service-account-name-taken` and `409 service-account-unregistered`.
  - **Revoking sessions:** `POST /v1/identity/users/{userId}/revoke-sessions` now needs a tenant admin, unless the caller revokes their own sessions (`403 permission-denied`). Any caller could revoke anyone's before.
  - **Add a person:** `POST /v1/identity/users` (`{displayName, primaryEmail?}`), tenant admins only. It is mounted when the identity directory implements the new optional `createUser`. The person becomes a tenant member: they can read the tenant's settings, not its projects, until they're given a role. An email another person already has is `409 identity-user-email-taken`.
  - **TypeScript client:**
    - `tokens.create({ for })`, `tokens.list({ principal })`, the new `serviceAccounts` resource, and `users.create` (it used to throw `not-yet-wired`).
    - The new error codes are classified.
  - **Python client:** `tokens.mint(for_=…)`, `service_accounts.*` and `identity.users.create`.
  - **Evidence kinds:** `api-key-minted`, `api-key-revoked`, `service-account-created`, `service-account-granted`, `service-account-ungranted`, `service-account-unregistered` and `person-added` join `EVIDENCE_KINDS` and the evidence schema. A key's secret is never in one. The stores learn who acted: `TokenRevokeInput.revokedBy`, and `by` on a service account's grant, ungrant and unregister.
  - **Retention domains `api_key` and `service_account`:** a retention policy can purge revoked and expired keys, and unregistered service accounts, after its grace.
- 1633db1: Memory facts keep their id across revisions, and every read sees only what the caller may.
  
  - **The scope guard.** A memory read gets `readers` (`MemoryReaders`): the projects, orgs, user, end user (`participantId`, new on `MemoryScope`) and conversations it may see. A binding applies them inside its query, before any limit; `isReadableBy` is the rule. On `/v1/memory`, the route works out the readers from the caller: a tenant admin reads everything; anyone else reads tenant-wide facts, the projects and orgs they may read, their own user facts, and every end user's and conversation's facts in the projects they may write. Writes are checked against the scope (`403 permission-denied`). An agent turn's retrievals see the run's project and org, the user it acts for, its conversation and that conversation's end user, never another conversation's or another end user's; `same-project` in a run without a project selects nothing.
  - **Revisions.** `POST /v1/memory/facts/{factId}/supersede` writes the fact's next revision (same id, body `{ content, expectVersion?, … }`) and returns it; `DELETE /v1/memory/facts/{factId}` closes the current one; `POST …/verify` marks it verified; `GET …/revisions` lists them; `?version=` and `?asOf=` read the past. `409 fact-changed` (with `expectVersion`) and `409 legal-hold` refuse; a runtime without delete, verify or history answers `501 memory-operation-unsupported`.
  - **Facts** carry `revisionId`, `trust`, `verifiedBy`/`verifiedAt`, `attributedTo` (from the writer), `generatedBy`, `subjects`, `validFrom`/`validUntil`/`observedAt`, `invalidatedAt`/`invalidatedBy`/`invalidationReason` and `review`, all optional.
  - `AuthzCheckBinding.listObjects` (optional) lists the objects a principal may act on.
  - `POST /v1/runs` hands the run handler the caller (`InvokeAgentBindingInput.principal`, `InvokeFlowBindingInput.principal`), so a turn knows whom it acts for: their own user facts are among what it may read.
  - Clients: `memory.facts.supersede`, `.delete` (now `DELETE`, returning the closed revision), `.verify`, `.revisions`, and `version`/`asOf` on `read`/`list`. CLI: `kindgi memory facts supersede|delete|verify|revisions`, `--revision` and `--as-of` on `get`, `--as-of` on `list`.
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 2b34f78: A request the authorizer denies (on the agents, flows, tools and other routes with authorization on) answers its 403 in the error envelope every other error uses: `{ error: { code: 'permission-denied', message, details: { action, resource, reason }, requestId } }`. It was a bare `{ code, action, resource, reason }`, which the TypeScript client and the CLI reported as "HTTP 403 without recognizable error envelope"; both clients now read it as a forbidden auth error. `@kindgi/authz`'s `DenyPayload` doc describes it as the denial's `details`.
- d9cee7c: Judging a run needs `write` on the run's project, as cancelling one does: a run inherits its permissions from its project. With authorization on, judging was refused for every run, because it asked for a `judge` permission on the run itself, which no run has. The unreleased `judge` action is gone from `@kindgi/authz`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 2b34f78: A request the authorizer denies (on the agents, flows, tools and other routes with authorization on) answers its 403 in the error envelope every other error uses: `{ error: { code: 'permission-denied', message, details: { action, resource, reason }, requestId } }`. It was a bare `{ code, action, resource, reason }`, which the TypeScript client and the CLI reported as "HTTP 403 without recognizable error envelope"; both clients now read it as a forbidden auth error. `@kindgi/authz`'s `DenyPayload` doc describes it as the denial's `details`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- d9cee7c: Judging a run needs `write` on the run's project, as cancelling one does: a run inherits its permissions from its project. With authorization on, judging was refused for every run, because it asked for a `judge` permission on the run itself, which no run has. The unreleased `judge` action is gone from `@kindgi/authz`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
