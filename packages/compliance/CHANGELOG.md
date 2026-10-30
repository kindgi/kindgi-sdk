# @kindgi/compliance

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
- Updated dependencies [8dd91b0]
  - @kindgi/platform@0.3.0
  - @kindgi/types@0.3.0
  - @kindgi/audit-events@0.3.0
  - @kindgi/log@0.3.0

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
- Updated dependencies [8dd91b0]
  - @kindgi/platform@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/audit-events@0.3.0-rc.0
  - @kindgi/log@0.3.0-rc.0

## 0.2.0

### Patch Changes

- 08dedca: **Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
  - **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. An OAuth 2.0 sign-in's `refreshToken` says whether a connect needs a refresh token: `'required'` (the default) refuses one without, and `'optional'` is for an app that may give none, whose connections then work until one minute before their access token ends and then need reconnecting (a grant that gives neither a refresh token nor the token's `expires_in` is refused). `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. A permission's `grants` and each account scope is one scope, with no space or comma, since the scopes an app grants are read split on both. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
  - **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too, alone or as another error's `cause`), so the runtime renews the token once and runs the call again. `connectionRejectionOf(error)` finds it, up to three causes deep, for a runtime's dispatch and a pack service alike. When the app can't give a token just now, the call fails with `ConnectionRenewError` (`connection-renew-failed`) and the connection stays as it is; one it can't renew at all (no refresh token, or the grant withdrawn) needs reconnecting, and the call waits or is refused as for any such connection. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
  - **`@kindgi/specs`:** `tool.schema.json` 1.3.0 has `needsSpec.connections` and the `connection` authorization.
  - **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
  - **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use. A secret read for a connection names its caller `connections`, in `@kindgi/compliance` too.
- b6e20ca: **Mail triggers on the wire: each new mail in a Gmail or Outlook mailbox starts a run.** With a trigger registry, a server answers `/v1/mail-triggers` when its `triggerKinds` include `mail` (left out, all four kinds mount).
  - **`POST /v1/mail-triggers`** registers one:
    - the agent (`agentId`, with `agentVersion` optional) or the flow (`flowId` and `flowVersion`) to run;
    - `config.mailbox`, `{ app: 'google' | 'microsoft', as: 'person' | 'company' }`;
    - `config.folder`, the Gmail label id or the Outlook folder id or well-known name to watch (the inbox when left out, and `INBOX` or `inbox` to watch it again);
    - `config.pollSeconds`, how often to look, 30 to 3600 (default 60), and `config.runsPerHour`, the most runs its mail starts in an hour, 1 to 600 (default 60).
    - `projectId`, the trigger's project (the tenant's Default project when left out). One that isn't a project id is a `400`, and one that names no project of the tenant's is a `404 project-not-found`, as for schedules and webhooks.
    - Each run's input is the mail that started it, so `config.input` is refused.
  - **Whose it is.** A trigger is shared or personal, by its owner, and its runs act as that owner, with the owner's connections.
    - A trigger on a person's mailbox reads its owner's own mail, so a person owns it. A project writer registers one for their own mailbox. `runAsServiceAccountId`, or a service account calling, is a `400`.
    - A trigger on the company's mailbox is a project admin's to register. With `runAsServiceAccountId`, a service account owns it, and it's shared.
    - No edit moves the owner. Only `POST /v1/mail-triggers/{triggerId}/owner` does, and on a person's mailbox the mailbox becomes the new owner's own.
  - **Who may change it.**
    - A person's trigger is changed, paused, resumed or unregistered by its owner or a project admin, and anyone else gets a `403`.
    - Only the owner chooses what a person's trigger reads from their mailbox: another of their mailboxes, or another folder. Anyone else, a project admin included, gets a `403`, and may take the trigger over to watch their own. An admin may still move it to the company's mailbox.
    - A shared trigger's `PATCH` is an admin's, and its pause, resume and unregister need `write`.
    - A change to a trigger on the company's mailbox, before or after the change, takes an admin.
    - When an admin changes, pauses, resumes or unregisters a person's trigger, it's recorded as `trigger-changed-for-owner` evidence: the owner, who did it and what, and on a change the fields that changed, with the target, mailbox and folder before and after. Where the app tells owners (`triggerOwnerNotices`), the owner is told too, as for schedules and webhooks, and a take-over tells the former owner. Its runs go on acting as that person.
  - **`toolsAllowedUnattended`.** In a run a mail started, every call that changes something, or that uses the run's own mailbox, waits for a person's yes. The list names the tools whose calls needn't wait: only tools its agent or flow calls, and a project admin's to set. While it lists any, a new target (another agent or flow, not just a version) or another mailbox must name it again: `[]` to clear it, which a person's trigger's owner may give with their own change, or a list, which a project admin sets.
  - **Reads and the rest.**
    - `GET /v1/mail-triggers` lists them (`projectId`, `status`, paged), and `GET /v1/mail-triggers/{triggerId}` reads one. Each gives `account`, the mailbox's account at its last poll, `lastPolledAt`, and `statusReason` (`connection-missing` while the mailbox's connection is gone or lapsed, `owner-refused` while its owner was removed or may no longer run the target).
    - `POST …/pause`, `POST …/resume` and `POST …/unregister` work as for the other trigger kinds. A resume starts afresh: mail that came while it was paused doesn't start runs.
    - `GET /v1/mail-triggers/{triggerId}/fires` lists its mail, newest first: the run each started, `pending` while an earlier mail of its thread runs first (`detail` starts `thread-busy:`), or why it was skipped, refused or failed, each in `detail`.
  - **The trigger types** (`@kindgi/runtime`): the registry's mail trigger record, its config and limits, and the mail fire outcomes, which the wire describes.
  - **Clients:** `client.mailTriggers` in the TypeScript client, and `client.mail_triggers` in the Python client. In Python, a registration's `config` is a `RegisterMailTriggerBodyConfig`, and a change's is a `PatchMailTriggerBodyConfig`.
- e019e64: **A hard revoke says when the secret manager kept a recoverable copy, and until when.** Azure Key Vault keeps a deleted secret recoverable for the vault's retention period when it can't be purged.
  - **`DELETE /v1/secrets/{name}?hard=true`** answers `recoverableUntil` (ISO 8601) next to `revoked` and `hard`: when the secret manager purges that copy on its own. Setting the same name again before then can keep that copy, its values disabled, until the name is hard-revoked again. It's absent on a soft revoke, and when a hard revoke left nothing recoverable. It's optional, so a client that doesn't know it is unaffected.
  - **The `secret-hard-revoked` record** carries `recoverableUntil` too.
  - **The reference:** the `secrets.revoke` description and its `hard` parameter say what a hard revoke erases, and that `recoverableUntil` says until when a recoverable copy is kept.
  - **For backends:** `SecretProviderDeleteOutput` and `SecretRevokeOutcome` gain an optional `recoverableUntil`, and `emitLifecycleEvent` takes one.
  - **Clients:** the TypeScript client's `SecretRevokeOutcome` and the Python client's `SecretRevokeResult` gain the optional `recoverableUntil`.
  - **`kindgi secrets revoke --hard`** prints until when your secret manager keeps the copy, and puts `recoverableUntil` in its JSON.
- 68e0d57: **A run paused until another system answers is answered at its link, or through the API.**
  
  - **`@kindgi/agents`:** an agent's call to a tool that declares `pauses` parks the turn until the answer comes, and the turn goes on with it as the call's result. The model sees the answer as data from outside, inside an `<event>` block, and the turn's system prompt then says never to follow instructions found there. Resumed, the turn doesn't call the tool again. A wait that times out is the tool error `wait-token-timed-out`, handled by the agent's tool error rules like any other: it fails the turn unless they retry `tool-error`. A retried step waits on a new token.
  - **`@kindgi/api`:**
    - `POST /v1/wait-tokens/{token}/complete` takes another system's answer at the link a pausing tool handed on. The token in the path is the credential: no `Authorization` header. The body is the tool's output as JSON, at most 1 MiB; an empty body is `{}`. It answers `200 { status: 'accepted' }` at once, and the run resumes behind the answer: the sender waits for none of the run. An answer that comes before the run reaches its wait is held for it, and dropped if the run never waits on that token (the tool answered at once, or its step was retried); the link then answers `409 wait-token-closed`, `unused`. The server logs the path as `/v1/wait-tokens/:token`, never the token.
    - `POST /v1/runs/{runId}/resume` answers a `pause:` waitpoint, as the link would, and needs write access and `execute` on the run's agent or flow. It returns the run as `GET /v1/runs/{runId}` does. Every other waitpoint stays `422 run-resume-not-supported`, and a body without `waitpointId`, or with a field it doesn't take, is now `400 bad-input`.
    - `GET /v1/runs/{runId}`'s `waitingFor` gains `tokens`: each wait's `tokenId`, `name`, tool and call, step, and when it times out. Never the link.
    - New error codes: `wait-token-not-found` (404: an unknown token and a wrong one alike), `wait-token-closed` (409, `details.state`), `wait-token-output-invalid` (400, `details.issues`: the wait stays open) and `unsupported-media-type` (415: a body that isn't JSON).
    - Nothing runs where the run is while its tenant is closing or suspended or its project is suspended, so an answer then is refused (`409 tenant-closing`, `409 tenant-suspended` or `409 project-suspended`) and nothing is taken. Closing or suspending cancels the tenant's or project's runs, paused ones included, so the refusal is for an answer that comes before the cancel reaches its run. When the tenant's state can't be read, the answer is `503 tenant-state-unavailable` with `Retry-After`. The link tells any of it only for a token that matches; through the API, a frozen tenant is refused as every write of its is.
    - The link limits requests per client: past 600 a minute, `429 rate-limit-exceeded` with `Retry-After`, counted before the body is read or the token looked up, so nothing was taken and the same answer can be sent again then.
    - For a runtime: `createApp` takes `waitTokens`, a `WaitTokenBinding` (`complete` and `waiting`). Without one, the link answers `404` and resume `422`, as before. The link tells clients apart and counts them where `webhookReceiver` says (`clientAddress`, `rateLimitStore`), with its defaults when that's absent.
  - **`@kindgi/compliance` and `@kindgi/specs`:** two built-in evidence kinds, `wait-token-completed` (an answer landed, held for the run or taken) and `wait-token-discarded` (a held early answer the run never took). Their payloads carry the answer's size and SHA-256, never the answer.
  - **`@kindgi/client`:** `runs.resume` answers a run's wait for another system, and `Run` carries `waitingFor` (`RunWaitingFor`, `RunWaitingApproval` and `RunWaitingToken` are exported). `approvals.completeToken`, which had no route and always threw `not-yet-wired`, and its `CompleteTokenInput` (re-exported by `@kindgi/sdk` too) are removed, so code that imports `CompleteTokenInput` stops compiling: an approval's run resumes through `approvals.decide`.
- 119ac78: **A webhook trigger or a schedule can name tools its runs call without waiting for a person's yes (`toolsAllowedUnattended`).** A tool that declares `needsApprovalWhenUnattended` waits for a person's yes in a run no person started. A trigger's list lifts that wait for the tools it names, and only that: the tenant's approval rules, the agent's own, the permission check (as the trigger's owner) and the tool's own limits all still apply.
  - **Where:** `POST` and `PATCH` on `/v1/webhooks` and `/v1/schedules` take it, and their records show it (absent: none). `POST /v1/runs` never takes it. A take-over (`/owner`) keeps it and refuses a body that names it (`400 bad-input`).
  - **Who:** naming it, `[]` included, takes `admin` on the trigger's project, at register too.
  - **What:** each tool by its id: at most 100, no wildcard or pattern, each once. Each must be a tool the target calls, else `400 bad-input` naming it. For a flow, that's its tool steps, loop bodies, fan-out branches, its subflows' tools, and its agents' tools at the node's version, the flow's pin or the latest. An improvement schedule calls no tools, so its list can only be `[]`.
  - **A new target:** a schedule `PATCH` to another flow or agent while its list isn't empty must name the list again, as it is or `[]`, else `400 bad-input` naming the kept ids. A new version alone keeps it. A webhook trigger's new `flowVersion` keeps it, and naming it checks it against that version.
  - **Audit:** every change is recorded as `trigger-tools-allowed-unattended-set` (the trigger, its target, `from`, `to`, `by`), and `trigger-owner-set` names the list a take-over keeps.
  - **Runs:** a run's `toolsAllowedUnattended` is its trigger's list as it was when the run started. A child run has its parent's, and a resumed agent turn keeps its run's, never the resumer's.
  - **For runtimes:** `@kindgi/runtime` exports `needsPersonsYesUnattended(tool, startedBy, toolsAllowedUnattended)`, the one rule the agent's tool gate and a flow's tool steps share. The field is on `RunFlowInput`, `StartRunParams`, the run record, and the trigger registry's register and update inputs and its records. It's also on `InvokeAgentInput`, the run snapshot, and the API's `InvokeAgentBindingInput` and `InvokeFlowBindingInput`, which a webhook's or a schedule's fire sets from its trigger.
- Updated dependencies [b6e20ca]
  - @kindgi/log@0.2.0
  - @kindgi/audit-events@0.2.0
  - @kindgi/platform@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- b6e20ca: **Mail triggers on the wire: each new mail in a Gmail or Outlook mailbox starts a run.** With a trigger registry, a server answers `/v1/mail-triggers` when its `triggerKinds` include `mail` (left out, all four kinds mount).
  - **`POST /v1/mail-triggers`** registers one:
    - the agent (`agentId`, with `agentVersion` optional) or the flow (`flowId` and `flowVersion`) to run;
    - `config.mailbox`, `{ app: 'google' | 'microsoft', as: 'person' | 'company' }`;
    - `config.folder`, the Gmail label id or the Outlook folder id or well-known name to watch (the inbox when left out, and `INBOX` or `inbox` to watch it again);
    - `config.pollSeconds`, how often to look, 30 to 3600 (default 60), and `config.runsPerHour`, the most runs its mail starts in an hour, 1 to 600 (default 60).
    - `projectId`, the trigger's project (the tenant's Default project when left out). One that isn't a project id is a `400`, and one that names no project of the tenant's is a `404 project-not-found`, as for schedules and webhooks.
    - Each run's input is the mail that started it, so `config.input` is refused.
  - **Whose it is.** A trigger is shared or personal, by its owner, and its runs act as that owner, with the owner's connections.
    - A trigger on a person's mailbox reads its owner's own mail, so a person owns it. A project writer registers one for their own mailbox. `runAsServiceAccountId`, or a service account calling, is a `400`.
    - A trigger on the company's mailbox is a project admin's to register. With `runAsServiceAccountId`, a service account owns it, and it's shared.
    - No edit moves the owner. Only `POST /v1/mail-triggers/{triggerId}/owner` does, and on a person's mailbox the mailbox becomes the new owner's own.
  - **Who may change it.**
    - A person's trigger is changed, paused, resumed or unregistered by its owner or a project admin, and anyone else gets a `403`.
    - Only the owner chooses what a person's trigger reads from their mailbox: another of their mailboxes, or another folder. Anyone else, a project admin included, gets a `403`, and may take the trigger over to watch their own. An admin may still move it to the company's mailbox.
    - A shared trigger's `PATCH` is an admin's, and its pause, resume and unregister need `write`.
    - A change to a trigger on the company's mailbox, before or after the change, takes an admin.
    - When an admin changes, pauses, resumes or unregisters a person's trigger, it's recorded as `trigger-changed-for-owner` evidence: the owner, who did it and what, and on a change the fields that changed, with the target, mailbox and folder before and after. Where the app tells owners (`triggerOwnerNotices`), the owner is told too, as for schedules and webhooks, and a take-over tells the former owner. Its runs go on acting as that person.
  - **`toolsAllowedUnattended`.** In a run a mail started, every call that changes something, or that uses the run's own mailbox, waits for a person's yes. The list names the tools whose calls needn't wait: only tools its agent or flow calls, and a project admin's to set. While it lists any, a new target (another agent or flow, not just a version) or another mailbox must name it again: `[]` to clear it, which a person's trigger's owner may give with their own change, or a list, which a project admin sets.
  - **Reads and the rest.**
    - `GET /v1/mail-triggers` lists them (`projectId`, `status`, paged), and `GET /v1/mail-triggers/{triggerId}` reads one. Each gives `account`, the mailbox's account at its last poll, `lastPolledAt`, and `statusReason` (`connection-missing` while the mailbox's connection is gone or lapsed, `owner-refused` while its owner was removed or may no longer run the target).
    - `POST …/pause`, `POST …/resume` and `POST …/unregister` work as for the other trigger kinds. A resume starts afresh: mail that came while it was paused doesn't start runs.
    - `GET /v1/mail-triggers/{triggerId}/fires` lists its mail, newest first: the run each started, `pending` while an earlier mail of its thread runs first (`detail` starts `thread-busy:`), or why it was skipped, refused or failed, each in `detail`.
  - **The trigger types** (`@kindgi/runtime`): the registry's mail trigger record, its config and limits, and the mail fire outcomes, which the wire describes.
  - **Clients:** `client.mailTriggers` in the TypeScript client, and `client.mail_triggers` in the Python client. In Python, a registration's `config` is a `RegisterMailTriggerBodyConfig`, and a change's is a `PatchMailTriggerBodyConfig`.
- Updated dependencies [b6e20ca]
  - @kindgi/log@0.2.0-rc.1
  - @kindgi/audit-events@0.2.0-rc.1
  - @kindgi/platform@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
  - **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. An OAuth 2.0 sign-in's `refreshToken` says whether a connect needs a refresh token: `'required'` (the default) refuses one without, and `'optional'` is for an app that may give none, whose connections then work until one minute before their access token ends and then need reconnecting (a grant that gives neither a refresh token nor the token's `expires_in` is refused). `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. A permission's `grants` and each account scope is one scope, with no space or comma, since the scopes an app grants are read split on both. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
  - **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too, alone or as another error's `cause`), so the runtime renews the token once and runs the call again. `connectionRejectionOf(error)` finds it, up to three causes deep, for a runtime's dispatch and a pack service alike. When the app can't give a token just now, the call fails with `ConnectionRenewError` (`connection-renew-failed`) and the connection stays as it is; one it can't renew at all (no refresh token, or the grant withdrawn) needs reconnecting, and the call waits or is refused as for any such connection. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
  - **`@kindgi/specs`:** `tool.schema.json` 1.3.0 has `needsSpec.connections` and the `connection` authorization.
  - **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
  - **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use. A secret read for a connection names its caller `connections`, in `@kindgi/compliance` too.
- e019e64: **A hard revoke says when the secret manager kept a recoverable copy, and until when.** Azure Key Vault keeps a deleted secret recoverable for the vault's retention period when it can't be purged.
  - **`DELETE /v1/secrets/{name}?hard=true`** answers `recoverableUntil` (ISO 8601) next to `revoked` and `hard`: when the secret manager purges that copy on its own. Setting the same name again before then can keep that copy, its values disabled, until the name is hard-revoked again. It's absent on a soft revoke, and when a hard revoke left nothing recoverable. It's optional, so a client that doesn't know it is unaffected.
  - **The `secret-hard-revoked` record** carries `recoverableUntil` too.
  - **The reference:** the `secrets.revoke` description and its `hard` parameter say what a hard revoke erases, and that `recoverableUntil` says until when a recoverable copy is kept.
  - **For backends:** `SecretProviderDeleteOutput` and `SecretRevokeOutcome` gain an optional `recoverableUntil`, and `emitLifecycleEvent` takes one.
  - **Clients:** the TypeScript client's `SecretRevokeOutcome` and the Python client's `SecretRevokeResult` gain the optional `recoverableUntil`.
  - **`kindgi secrets revoke --hard`** prints until when your secret manager keeps the copy, and puts `recoverableUntil` in its JSON.
- 68e0d57: **A run paused until another system answers is answered at its link, or through the API.**
  
  - **`@kindgi/agents`:** an agent's call to a tool that declares `pauses` parks the turn until the answer comes, and the turn goes on with it as the call's result. The model sees the answer as data from outside, inside an `<event>` block, and the turn's system prompt then says never to follow instructions found there. Resumed, the turn doesn't call the tool again. A wait that times out is the tool error `wait-token-timed-out`, handled by the agent's tool error rules like any other: it fails the turn unless they retry `tool-error`. A retried step waits on a new token.
  - **`@kindgi/api`:**
    - `POST /v1/wait-tokens/{token}/complete` takes another system's answer at the link a pausing tool handed on. The token in the path is the credential: no `Authorization` header. The body is the tool's output as JSON, at most 1 MiB; an empty body is `{}`. It answers `200 { status: 'accepted' }` at once, and the run resumes behind the answer: the sender waits for none of the run. An answer that comes before the run reaches its wait is held for it, and dropped if the run never waits on that token (the tool answered at once, or its step was retried); the link then answers `409 wait-token-closed`, `unused`. The server logs the path as `/v1/wait-tokens/:token`, never the token.
    - `POST /v1/runs/{runId}/resume` answers a `pause:` waitpoint, as the link would, and needs write access and `execute` on the run's agent or flow. It returns the run as `GET /v1/runs/{runId}` does. Every other waitpoint stays `422 run-resume-not-supported`, and a body without `waitpointId`, or with a field it doesn't take, is now `400 bad-input`.
    - `GET /v1/runs/{runId}`'s `waitingFor` gains `tokens`: each wait's `tokenId`, `name`, tool and call, step, and when it times out. Never the link.
    - New error codes: `wait-token-not-found` (404: an unknown token and a wrong one alike), `wait-token-closed` (409, `details.state`), `wait-token-output-invalid` (400, `details.issues`: the wait stays open) and `unsupported-media-type` (415: a body that isn't JSON).
    - Nothing runs where the run is while its tenant is closing or suspended or its project is suspended, so an answer then is refused (`409 tenant-closing`, `409 tenant-suspended` or `409 project-suspended`) and nothing is taken. Closing or suspending cancels the tenant's or project's runs, paused ones included, so the refusal is for an answer that comes before the cancel reaches its run. When the tenant's state can't be read, the answer is `503 tenant-state-unavailable` with `Retry-After`. The link tells any of it only for a token that matches; through the API, a frozen tenant is refused as every write of its is.
    - The link limits requests per client: past 600 a minute, `429 rate-limit-exceeded` with `Retry-After`, counted before the body is read or the token looked up, so nothing was taken and the same answer can be sent again then.
    - For a runtime: `createApp` takes `waitTokens`, a `WaitTokenBinding` (`complete` and `waiting`). Without one, the link answers `404` and resume `422`, as before. The link tells clients apart and counts them where `webhookReceiver` says (`clientAddress`, `rateLimitStore`), with its defaults when that's absent.
  - **`@kindgi/compliance` and `@kindgi/specs`:** two built-in evidence kinds, `wait-token-completed` (an answer landed, held for the run or taken) and `wait-token-discarded` (a held early answer the run never took). Their payloads carry the answer's size and SHA-256, never the answer.
  - **`@kindgi/client`:** `runs.resume` answers a run's wait for another system, and `Run` carries `waitingFor` (`RunWaitingFor`, `RunWaitingApproval` and `RunWaitingToken` are exported). `approvals.completeToken`, which had no route and always threw `not-yet-wired`, and its `CompleteTokenInput` (re-exported by `@kindgi/sdk` too) are removed, so code that imports `CompleteTokenInput` stops compiling: an approval's run resumes through `approvals.decide`.
- 119ac78: **A webhook trigger or a schedule can name tools its runs call without waiting for a person's yes (`toolsAllowedUnattended`).** A tool that declares `needsApprovalWhenUnattended` waits for a person's yes in a run no person started. A trigger's list lifts that wait for the tools it names, and only that: the tenant's approval rules, the agent's own, the permission check (as the trigger's owner) and the tool's own limits all still apply.
  - **Where:** `POST` and `PATCH` on `/v1/webhooks` and `/v1/schedules` take it, and their records show it (absent: none). `POST /v1/runs` never takes it. A take-over (`/owner`) keeps it and refuses a body that names it (`400 bad-input`).
  - **Who:** naming it, `[]` included, takes `admin` on the trigger's project, at register too.
  - **What:** each tool by its id: at most 100, no wildcard or pattern, each once. Each must be a tool the target calls, else `400 bad-input` naming it. For a flow, that's its tool steps, loop bodies, fan-out branches, its subflows' tools, and its agents' tools at the node's version, the flow's pin or the latest. An improvement schedule calls no tools, so its list can only be `[]`.
  - **A new target:** a schedule `PATCH` to another flow or agent while its list isn't empty must name the list again, as it is or `[]`, else `400 bad-input` naming the kept ids. A new version alone keeps it. A webhook trigger's new `flowVersion` keeps it, and naming it checks it against that version.
  - **Audit:** every change is recorded as `trigger-tools-allowed-unattended-set` (the trigger, its target, `from`, `to`, `by`), and `trigger-owner-set` names the list a take-over keeps.
  - **Runs:** a run's `toolsAllowedUnattended` is its trigger's list as it was when the run started. A child run has its parent's, and a resumed agent turn keeps its run's, never the resumer's.
  - **For runtimes:** `@kindgi/runtime` exports `needsPersonsYesUnattended(tool, startedBy, toolsAllowedUnattended)`, the one rule the agent's tool gate and a flow's tool steps share. The field is on `RunFlowInput`, `StartRunParams`, the run record, and the trigger registry's register and update inputs and its records. It's also on `InvokeAgentInput`, the run snapshot, and the API's `InvokeAgentBindingInput` and `InvokeFlowBindingInput`, which a webhook's or a schedule's fire sets from its trigger.
- @kindgi/audit-events@0.2.0-rc.0
  - @kindgi/log@0.2.0-rc.0
  - @kindgi/platform@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- Updated dependencies [25a7309]
  - @kindgi/platform@0.1.10
  - @kindgi/audit-events@0.1.10
  - @kindgi/log@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/audit-events@0.1.10-rc.1
  - @kindgi/log@0.1.10-rc.1
  - @kindgi/platform@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- Updated dependencies [25a7309]
  - @kindgi/platform@0.1.10-rc.0
  - @kindgi/audit-events@0.1.10-rc.0
  - @kindgi/log@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- 5d68d0d: **An audit record that can't be written, and a check the authorization model can't answer, are logged through your logger instead of the console.**
  - `emitResolveEvent` and `emitLifecycleEvent` (`@kindgi/compliance`) take an optional `log`, a `@kindgi/log` `Logger`. An append that fails or throws still never fails the caller's operation. It's logged there at `warn`, with the record's `tenantId` and `kind`, and the error's `code` or the error it threw. Without a `log` it isn't logged anywhere; before, it went to `console.warn`.
  - `createApp` passes the request's logger, under the subsystem `audit`, for a secret or env write's record and for a secret read refused for its scope. `resolveAtScope` takes that `log` as an optional fourth argument. An app without a `logger` won't see that a record was dropped, and the `logger` option's docs say so.
  - A check the authorization model has no relation for, which is a bug in a route, is logged at `error` through the request's logger, under the subsystem `authz`, with its `action` and `resource`. Before, it went to `console.error`.
  - `createInMemoryEnvBinding` takes an optional `log` and passes it on with every audit record it writes.
- d563887: **Promoting a build from one environment to the next.**
  - `kindgi promote --from=<env> --to=<env>` moves a build to the next environment of its environment order: the same signed image, with the edits made since to its agents and flows. It finds the pack's one deployment serving in `--from` (or takes `--deployment`). It prints what moves, with the carried edits marked and the edits that stay behind, and then each value the build needs in `--to` that isn't set, with the command that sets it. It promotes only when every value is set, and exits 1 while one isn't. `--check` stops before moving anything. `--json` gives the deployment, the check and the promotion as one object.
  - `POST /v1/deployments/{deploymentId}/promotions` promotes a deployment to the next environment of its order, `{ toProjectId, reason? }`. The target gets a deployment of its own, with the source's signed fields, contents and pack, and `promotedFromDeploymentId`. The edits of its agents and flows move with it, and each tool's secrets are read where the target reads them. Nothing is built, and no registry is written. It answers `201` with `{ deployment, created, moved, leftBehind? }`. A target that has the build already answers `200` with its deployment (`created: false`), and records the carried edits it lacked. The promoter needs read on the deployment's project and admin on the target. The deployment must still serve and its signer still be trusted, with the signature checked again. Every value the build needs in the target must be ready. The audit trail records `deployment-promoted`, with the reason.
  - `POST /v1/deployments/{deploymentId}/promotions/check` answers what would move, the values not ready in the target, and the next environment. It writes nothing, and it refuses as the promotion would.
  - New error codes: `409 promotion-not-next-environment` (the project named isn't the next environment of the order), `409 promotion-values-not-ready` (`details.values`), `409 deployment-superseded` (`details.environment`, `details.newerDeploymentId`) and `501 promotions-unsupported`. A promotion from or into a suspended project or pack answers `project-suspended` or `pack-suspended`, with `details.environment`.
  - `GET /v1/deployments` takes `projectId` (one environment's deployments; the Default project also finds those that name no project) and `packId`. Each page names the filters it applied, so a client can tell a runtime that ignored them.
  - A deployment record carries `promotedFromDeploymentId` and `packId` when they're set.
  - `@kindgi/api`: `DeploymentRegistryBinding.promote` (optional) writes a promotion in one transaction. Without it, a promotion answers `501 promotions-unsupported`, and the check still answers. `createApp`'s `deploymentValues` supplies where a provider's model key is and the pack's own env, for the values check.
  - `@kindgi/client`: `deployments.promote`, `deployments.promoteCheck`, and `projectId` and `packId` on `deployments.list`.
  - `@kindgi/compliance`, `@kindgi/specs`: the audit event kind `deployment-promoted`.
  - `kindgi deploy` refused with `409 environment-takes-promotions` names where the build enters its environment order and prints each `kindgi promote` to run from there, one environment at a time, naming each environment from the pack config. When the refusal leaves out the first environment, because the caller can't read it, the hint says the rule and points at `kindgi environments list`.
  - `kindgi deploy` refused with `deployment-validation-failed` prints each issue again. They're in the refusal's `details.issues`, and the CLI looked for them elsewhere.
  - `@kindgi/api`: `DeploymentValue` describes one value a deployment needs where it's promoted to: a tool's secret or env, an agent's model key, or the pack's env. It says where the value is set and why it isn't ready, never the value itself. `ModelKeyLookup` says where a run finds a provider's model key.
  - `@kindgi/api`: `deploymentValues` lists every value a deployment needs in the project it's promoted to, each read where a run there reads it: each tool version's secrets at the scope a promotion records for them, its env values with no default, a model key for each agent version (its registered preferred provider's, else any registered provider's), and the pack's own env. `carriedVersions` gives the edits that move with a deployment to the next environment (an edit of a version it ships, reached where it serves) and the ones left behind. `findNamedSecretScope` gives the scope a secret is recorded at and the secret found there.
  - `@kindgi/tools`: `toolRequiredEnvNames` gives the env values a tool declares with no default.
  - `kindgi promote` outside a pack takes a project id or slug for `--from` and `--to` (a slug two projects share is refused), and lists every deployment serving in `--from`, with each one's pack when several serve. In a pack or outside one, the command it prints for a value sets it at the target project's scope (`--scope=project:<id>`), under the env the runtime serves. In a pack, it talks to the runtime `kindgi deploy` would use for `--from`, and refuses two environments whose `endpoint` or `tenantId` differ, naming both: an environment order lives in one tenant on one runtime.
  - The promotion check answers `envName`, the env the runtime serves, which a run in the target reads its values under. It's absent when the runtime names none.
  - A key or session limited to a project is refused promotions and their checks, `403 key-project-mismatch`, whether or not the runtime has an authorizer: a promotion reads one project and writes another.
  - A tool secret whose schema names null and validates it is optional, as at run time: unset in the target, it isn't listed and doesn't hold a promotion back. Set or revoked, it's checked like any other. `@kindgi/tools`: `toolOptionalSecretNames` gives a tool's optional secrets.
  - With no model provider registered in the tenant, each agent version that runs on any provider is listed as `any provider`, with the problem `no-provider`: a run there would have none to call. `kindgi promote` says to register one.
- d563887: **Environment orders — the order a tenant runs a project through on its way to live.** One ordered list of projects per parent: the tenant, or one of its orgs.
  - **`GET /v1/environment-orders`** lists the orders the caller can read a project in; **`GET /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** read one (empty when it was never set or was cleared). A project the caller can't read is named by its position alone, without its id — the same project-read check `GET /v1/projects` filters its list with.
  - **`PUT /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** replace an order with the projects given, in order; send `[]` to clear it. For a tenant admin; an org admin or a project admin is refused, even on an org's own order. An order needs two or more projects, no project named twice, and each project live in the tenant under that parent and in no other order (`409 project-in-another-order`). A write that changes nothing is a no-op.
  - A new optional `environmentOrders` binding (`EnvironmentOrderBinding`) backs the routes; a runtime that doesn't wire it doesn't mount them. The host application supplies it — `@kindgi/api` never constructs one.
  - The TypeScript and Python clients reach them through `client.environmentOrders`.
  - **`kindgi environments`** lists an order (`list`), sets it (`set`, naming environments from the pack config's new optional `environments.<name>.project`, or `--projects` ids/slugs), and clears it (`clear`). `kindgi env` is reworded to name a value set, to tell the two apart.
  - A signed, exportable `environment-order-set` audit event records each set, with the order before and after — never anything a project holds.
- 3c8afcf: **A pack service run per deployment can be given the secrets its pack declares, when the orchestrator asks for them.**
  - **`GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env?secrets=values`** gives each declared name that's set only as a secret in `secrets`, as `{ value, revision }`, beside the plain values in `env`.
    - Each is read at the version its revision names. A secret that changes while it's read is read again once, and then the answer is `503 pack-env-unavailable`.
    - The `revision` (`ps1-…`) is made from the name's part of the deployment's revision, never from the value, so it changes whenever what's given for the name does.
    - Every secret given is audited before the answer: one `secret-resolved` row each (caller `pack-env`, with the deployment id, the revision, the request's id as its correlation id, and the system key's id), all written in one append. Each row is in the project the deployment's names were read for: the one it names, else the tenant's Default. When they can't be written, none is given (`503 pack-env-unavailable`). A server with no audit store gives none (`501 pack-env-secrets-unaudited`).
    - It's given only to a key holding `system:pack-env` itself. Any other key asking for it, `kindgi:system` included, is refused (`403 system-scope-missing`), with nothing read.
    - A secret that can't be read for a reason the platform fixes, not the owner, is `pack-env-secret-unreadable`, and no value is given. The store's message is never passed on.
    - Without `secrets=values`, the answer is as before: such a name is `pack-env-secret-not-yet`.
  - **`GET /v1/system/pack-env`** lists a pack service held as `pack-env-secret-unreadable` or `pack-env-secrets-unaudited` at its current revision every time, with its `held` code: the revision doesn't move when the platform fixes it. `PACK_ENV_PLATFORM_HOLDS` names them.
  - **New codes:** `pack-env-secret-unreadable` (a problem), and the orchestrator's own `pack-env-secrets-unaudited`, `pack-env-secret-too-large`, `pack-env-secret-capacity` (an endpoint's problem) and `pack-env-secret-redeploy` (a ready service's hold).
  - **The owner's check** (`GET /v1/deployments/{deploymentId}/pack-env`) lists a name set only as a secret as `kind: 'secret'` with no problem, read without its value. `kindgi deploy --hosted` says why for each new code, and says the platform's team is told for the ones it fixes.
  - **`kindgi deploy --hosted` refusing `environments.<env>.env` in kindgi.config** names the command that sets a secret too, at the same scope: `kindgi secrets set NAME --scope=… --env=…`.
  - **`@kindgi/compliance`:** `resolveEvent` builds a resolve event for a caller that appends its own rows. The `pack-env` caller is new, and a resolve event can carry the revision, the deployment id, the request's id (`correlationId`) and the system key's id (`systemKeyId`).
- 3502389: A webhook or schedule trigger can run as a **service account**. A trigger's runs act as its owner; now the owner can be an account rather than whoever registered it. Pass `runAsServiceAccountId` when registering (`webhooks.register`, `schedules.register`) or when taking over a trigger whose owner left (`webhooks.takeOwnership`, `schedules.takeOwnership`), or `--run-as <service-account-id>` on `kindgi webhooks register`, `kindgi schedules create` and the `take-ownership` commands. Naming an account needs `act_as` on it. Only a caller who may read service accounts learns whether a named one is missing, unregistered or not `act_as`-able; everyone else gets a uniform permission error.
- Updated dependencies [3b90568]
- Updated dependencies [d563887]
- Updated dependencies [409b9bf]
  - @kindgi/log@0.1.9
  - @kindgi/platform@0.1.9
  - @kindgi/audit-events@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/audit-events@0.1.9-rc.1
  - @kindgi/log@0.1.9-rc.1
  - @kindgi/platform@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 5d68d0d: **An audit record that can't be written, and a check the authorization model can't answer, are logged through your logger instead of the console.**
  - `emitResolveEvent` and `emitLifecycleEvent` (`@kindgi/compliance`) take an optional `log`, a `@kindgi/log` `Logger`. An append that fails or throws still never fails the caller's operation. It's logged there at `warn`, with the record's `tenantId` and `kind`, and the error's `code` or the error it threw. Without a `log` it isn't logged anywhere; before, it went to `console.warn`.
  - `createApp` passes the request's logger, under the subsystem `audit`, for a secret or env write's record and for a secret read refused for its scope. `resolveAtScope` takes that `log` as an optional fourth argument. An app without a `logger` won't see that a record was dropped, and the `logger` option's docs say so.
  - A check the authorization model has no relation for, which is a bug in a route, is logged at `error` through the request's logger, under the subsystem `authz`, with its `action` and `resource`. Before, it went to `console.error`.
  - `createInMemoryEnvBinding` takes an optional `log` and passes it on with every audit record it writes.
- d563887: **Promoting a build from one environment to the next.**
  - `kindgi promote --from=<env> --to=<env>` moves a build to the next environment of its environment order: the same signed image, with the edits made since to its agents and flows. It finds the pack's one deployment serving in `--from` (or takes `--deployment`). It prints what moves, with the carried edits marked and the edits that stay behind, and then each value the build needs in `--to` that isn't set, with the command that sets it. It promotes only when every value is set, and exits 1 while one isn't. `--check` stops before moving anything. `--json` gives the deployment, the check and the promotion as one object.
  - `POST /v1/deployments/{deploymentId}/promotions` promotes a deployment to the next environment of its order, `{ toProjectId, reason? }`. The target gets a deployment of its own, with the source's signed fields, contents and pack, and `promotedFromDeploymentId`. The edits of its agents and flows move with it, and each tool's secrets are read where the target reads them. Nothing is built, and no registry is written. It answers `201` with `{ deployment, created, moved, leftBehind? }`. A target that has the build already answers `200` with its deployment (`created: false`), and records the carried edits it lacked. The promoter needs read on the deployment's project and admin on the target. The deployment must still serve and its signer still be trusted, with the signature checked again. Every value the build needs in the target must be ready. The audit trail records `deployment-promoted`, with the reason.
  - `POST /v1/deployments/{deploymentId}/promotions/check` answers what would move, the values not ready in the target, and the next environment. It writes nothing, and it refuses as the promotion would.
  - New error codes: `409 promotion-not-next-environment` (the project named isn't the next environment of the order), `409 promotion-values-not-ready` (`details.values`), `409 deployment-superseded` (`details.environment`, `details.newerDeploymentId`) and `501 promotions-unsupported`. A promotion from or into a suspended project or pack answers `project-suspended` or `pack-suspended`, with `details.environment`.
  - `GET /v1/deployments` takes `projectId` (one environment's deployments; the Default project also finds those that name no project) and `packId`. Each page names the filters it applied, so a client can tell a runtime that ignored them.
  - A deployment record carries `promotedFromDeploymentId` and `packId` when they're set.
  - `@kindgi/api`: `DeploymentRegistryBinding.promote` (optional) writes a promotion in one transaction. Without it, a promotion answers `501 promotions-unsupported`, and the check still answers. `createApp`'s `deploymentValues` supplies where a provider's model key is and the pack's own env, for the values check.
  - `@kindgi/client`: `deployments.promote`, `deployments.promoteCheck`, and `projectId` and `packId` on `deployments.list`.
  - `@kindgi/compliance`, `@kindgi/specs`: the audit event kind `deployment-promoted`.
  - `kindgi deploy` refused with `409 environment-takes-promotions` names where the build enters its environment order and prints each `kindgi promote` to run from there, one environment at a time, naming each environment from the pack config. When the refusal leaves out the first environment, because the caller can't read it, the hint says the rule and points at `kindgi environments list`.
  - `kindgi deploy` refused with `deployment-validation-failed` prints each issue again. They're in the refusal's `details.issues`, and the CLI looked for them elsewhere.
  - `@kindgi/api`: `DeploymentValue` describes one value a deployment needs where it's promoted to: a tool's secret or env, an agent's model key, or the pack's env. It says where the value is set and why it isn't ready, never the value itself. `ModelKeyLookup` says where a run finds a provider's model key.
  - `@kindgi/api`: `deploymentValues` lists every value a deployment needs in the project it's promoted to, each read where a run there reads it: each tool version's secrets at the scope a promotion records for them, its env values with no default, a model key for each agent version (its registered preferred provider's, else any registered provider's), and the pack's own env. `carriedVersions` gives the edits that move with a deployment to the next environment (an edit of a version it ships, reached where it serves) and the ones left behind. `findNamedSecretScope` gives the scope a secret is recorded at and the secret found there.
  - `@kindgi/tools`: `toolRequiredEnvNames` gives the env values a tool declares with no default.
  - `kindgi promote` outside a pack takes a project id or slug for `--from` and `--to` (a slug two projects share is refused), and lists every deployment serving in `--from`, with each one's pack when several serve. In a pack or outside one, the command it prints for a value sets it at the target project's scope (`--scope=project:<id>`), under the env the runtime serves. In a pack, it talks to the runtime `kindgi deploy` would use for `--from`, and refuses two environments whose `endpoint` or `tenantId` differ, naming both: an environment order lives in one tenant on one runtime.
  - The promotion check answers `envName`, the env the runtime serves, which a run in the target reads its values under. It's absent when the runtime names none.
  - A key or session limited to a project is refused promotions and their checks, `403 key-project-mismatch`, whether or not the runtime has an authorizer: a promotion reads one project and writes another.
  - A tool secret whose schema names null and validates it is optional, as at run time: unset in the target, it isn't listed and doesn't hold a promotion back. Set or revoked, it's checked like any other. `@kindgi/tools`: `toolOptionalSecretNames` gives a tool's optional secrets.
  - With no model provider registered in the tenant, each agent version that runs on any provider is listed as `any provider`, with the problem `no-provider`: a run there would have none to call. `kindgi promote` says to register one.
- d563887: **Environment orders — the order a tenant runs a project through on its way to live.** One ordered list of projects per parent: the tenant, or one of its orgs.
  - **`GET /v1/environment-orders`** lists the orders the caller can read a project in; **`GET /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** read one (empty when it was never set or was cleared). A project the caller can't read is named by its position alone, without its id — the same project-read check `GET /v1/projects` filters its list with.
  - **`PUT /v1/environment-orders/tenant`** and **`/orgs/{orgId}`** replace an order with the projects given, in order; send `[]` to clear it. For a tenant admin; an org admin or a project admin is refused, even on an org's own order. An order needs two or more projects, no project named twice, and each project live in the tenant under that parent and in no other order (`409 project-in-another-order`). A write that changes nothing is a no-op.
  - A new optional `environmentOrders` binding (`EnvironmentOrderBinding`) backs the routes; a runtime that doesn't wire it doesn't mount them. The host application supplies it — `@kindgi/api` never constructs one.
  - The TypeScript and Python clients reach them through `client.environmentOrders`.
  - **`kindgi environments`** lists an order (`list`), sets it (`set`, naming environments from the pack config's new optional `environments.<name>.project`, or `--projects` ids/slugs), and clears it (`clear`). `kindgi env` is reworded to name a value set, to tell the two apart.
  - A signed, exportable `environment-order-set` audit event records each set, with the order before and after — never anything a project holds.
- 3c8afcf: **A pack service run per deployment can be given the secrets its pack declares, when the orchestrator asks for them.**
  - **`GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env?secrets=values`** gives each declared name that's set only as a secret in `secrets`, as `{ value, revision }`, beside the plain values in `env`.
    - Each is read at the version its revision names. A secret that changes while it's read is read again once, and then the answer is `503 pack-env-unavailable`.
    - The `revision` (`ps1-…`) is made from the name's part of the deployment's revision, never from the value, so it changes whenever what's given for the name does.
    - Every secret given is audited before the answer: one `secret-resolved` row each (caller `pack-env`, with the deployment id, the revision, the request's id as its correlation id, and the system key's id), all written in one append. Each row is in the project the deployment's names were read for: the one it names, else the tenant's Default. When they can't be written, none is given (`503 pack-env-unavailable`). A server with no audit store gives none (`501 pack-env-secrets-unaudited`).
    - It's given only to a key holding `system:pack-env` itself. Any other key asking for it, `kindgi:system` included, is refused (`403 system-scope-missing`), with nothing read.
    - A secret that can't be read for a reason the platform fixes, not the owner, is `pack-env-secret-unreadable`, and no value is given. The store's message is never passed on.
    - Without `secrets=values`, the answer is as before: such a name is `pack-env-secret-not-yet`.
  - **`GET /v1/system/pack-env`** lists a pack service held as `pack-env-secret-unreadable` or `pack-env-secrets-unaudited` at its current revision every time, with its `held` code: the revision doesn't move when the platform fixes it. `PACK_ENV_PLATFORM_HOLDS` names them.
  - **New codes:** `pack-env-secret-unreadable` (a problem), and the orchestrator's own `pack-env-secrets-unaudited`, `pack-env-secret-too-large`, `pack-env-secret-capacity` (an endpoint's problem) and `pack-env-secret-redeploy` (a ready service's hold).
  - **The owner's check** (`GET /v1/deployments/{deploymentId}/pack-env`) lists a name set only as a secret as `kind: 'secret'` with no problem, read without its value. `kindgi deploy --hosted` says why for each new code, and says the platform's team is told for the ones it fixes.
  - **`kindgi deploy --hosted` refusing `environments.<env>.env` in kindgi.config** names the command that sets a secret too, at the same scope: `kindgi secrets set NAME --scope=… --env=…`.
  - **`@kindgi/compliance`:** `resolveEvent` builds a resolve event for a caller that appends its own rows. The `pack-env` caller is new, and a resolve event can carry the revision, the deployment id, the request's id (`correlationId`) and the system key's id (`systemKeyId`).
- 3502389: A webhook or schedule trigger can run as a **service account**. A trigger's runs act as its owner; now the owner can be an account rather than whoever registered it. Pass `runAsServiceAccountId` when registering (`webhooks.register`, `schedules.register`) or when taking over a trigger whose owner left (`webhooks.takeOwnership`, `schedules.takeOwnership`), or `--run-as <service-account-id>` on `kindgi webhooks register`, `kindgi schedules create` and the `take-ownership` commands. Naming an account needs `act_as` on it. Only a caller who may read service accounts learns whether a named one is missing, unregistered or not `act_as`-able; everyone else gets a uniform permission error.
- Updated dependencies [3b90568]
- Updated dependencies [d563887]
- Updated dependencies [409b9bf]
  - @kindgi/log@0.1.9-rc.0
  - @kindgi/platform@0.1.9-rc.0
  - @kindgi/audit-events@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

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
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/platform@0.1.8
  - @kindgi/types@0.1.8
  - @kindgi/audit-events@0.1.8

## 0.1.8-rc.0

### Patch Changes

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
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/platform@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0
  - @kindgi/audit-events@0.1.8-rc.0

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
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/audit-events@0.1.7
  - @kindgi/types@0.1.7
  - @kindgi/platform@0.1.7

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
- Updated dependencies [b90e2c6]
- Updated dependencies [b90e2c6]
  - @kindgi/audit-events@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/platform@0.1.7-rc.0

## 0.1.6

### Patch Changes

- a6ac2e9: Every secret and env write through the API is recorded in the audit log. Before, nothing was: a binding could emit these events only for one fixed tenant and project.
  - **`/v1/secrets`:**
    - a set → `secret-set` (`writeMode`, the new version, and `revokedValuesPurged: true` when the backend dropped a revoked secret's values to set it again);
    - a rotation → `secret-rotated` (new and previous version), `secret-rotation-started` (asynchronous, with its `rotationId`) or `secret-rotation-failed`;
    - a revoke → `secret-revoked` / `secret-hard-revoked` (with its `reason`).
  - **`/v1/env`:** a set → `env-set` (its revision); a delete → `env-deleted`.
  - **Each record:**
    - `actor` is the caller (`user:…`, `service_account:…`, else the session, else `token:` and 16 hex of the credential's sha256);
    - `correlationId` is the request;
    - `projectId` is set for a project-scoped value;
    - a refused write is recorded too, `failed`, with the code the client was answered.
  - **Never a value,** nor anything derived from one.
  - **Not recorded:** a revoke or delete that changed nothing.
  - **Best effort:** a failing audit log never fails the write.
  - **`emitLifecycleEvent`:** gains optional `actor`, `correlationId`, `writeMode`, `rotationId` and `revokedValuesPurged`, and `projectId` becomes optional.
- eed55a1: A compliance classifier file can give a kind another kind's classification by naming it: `"secret-rotated": "secret-set"` in `byKind`, so related kinds share one policy and can't drift apart. `ComplianceClassifierSource` is the file as written; a loader resolves the names into a `ComplianceClassifierFile` (every kind with its own classification), and refuses a name that names another name, or a kind that isn't listed with a classification of its own (`default` included).
- 6a4715c: The deprecated export-signing inputs are gone. **Breaking, for code that embeds `@kindgi/api`:**
  - `CreateAppInput.signingKey` is removed: pass `exportSigning`, an `ExportSigningBinding` (`createEd25519ExportSigner` or `createExportSignerFromPem` from `@kindgi/crypto`, or a KMS-backed binding).
  - `exportSignerFromSigningKeyBinding` (`@kindgi/crypto`) is removed with it.
  - `ComplianceEvidenceGenerator.exportSigned` is removed. `@kindgi/api` builds and signs a compliance export itself, so nothing called it.
  
  The Kindgi runtime already passes `exportSigning`, and nothing changes for it or for the signed exports it serves.
- Updated dependencies [b4bbd95]
- Updated dependencies [307771f]
  - @kindgi/types@0.1.6
  - @kindgi/platform@0.1.6
  - @kindgi/audit-events@0.1.6

## 0.1.6-rc.0

### Patch Changes

- a6ac2e9: Every secret and env write through the API is recorded in the audit log. Before, nothing was: a binding could emit these events only for one fixed tenant and project.
  - **`/v1/secrets`:**
    - a set → `secret-set` (`writeMode`, the new version, and `revokedValuesPurged: true` when the backend dropped a revoked secret's values to set it again);
    - a rotation → `secret-rotated` (new and previous version), `secret-rotation-started` (asynchronous, with its `rotationId`) or `secret-rotation-failed`;
    - a revoke → `secret-revoked` / `secret-hard-revoked` (with its `reason`).
  - **`/v1/env`:** a set → `env-set` (its revision); a delete → `env-deleted`.
  - **Each record:**
    - `actor` is the caller (`user:…`, `service_account:…`, else the session, else `token:` and 16 hex of the credential's sha256);
    - `correlationId` is the request;
    - `projectId` is set for a project-scoped value;
    - a refused write is recorded too, `failed`, with the code the client was answered.
  - **Never a value,** nor anything derived from one.
  - **Not recorded:** a revoke or delete that changed nothing.
  - **Best effort:** a failing audit log never fails the write.
  - **`emitLifecycleEvent`:** gains optional `actor`, `correlationId`, `writeMode`, `rotationId` and `revokedValuesPurged`, and `projectId` becomes optional.
- eed55a1: A compliance classifier file can give a kind another kind's classification by naming it: `"secret-rotated": "secret-set"` in `byKind`, so related kinds share one policy and can't drift apart. `ComplianceClassifierSource` is the file as written; a loader resolves the names into a `ComplianceClassifierFile` (every kind with its own classification), and refuses a name that names another name, or a kind that isn't listed with a classification of its own (`default` included).
- 6a4715c: The deprecated export-signing inputs are gone. **Breaking, for code that embeds `@kindgi/api`:**
  - `CreateAppInput.signingKey` is removed: pass `exportSigning`, an `ExportSigningBinding` (`createEd25519ExportSigner` or `createExportSignerFromPem` from `@kindgi/crypto`, or a KMS-backed binding).
  - `exportSignerFromSigningKeyBinding` (`@kindgi/crypto`) is removed with it.
  - `ComplianceEvidenceGenerator.exportSigned` is removed. `@kindgi/api` builds and signs a compliance export itself, so nothing called it.
  
  The Kindgi runtime already passes `exportSigning`, and nothing changes for it or for the signed exports it serves.
- Updated dependencies [b4bbd95]
- Updated dependencies [307771f]
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/platform@0.1.6-rc.0
  - @kindgi/audit-events@0.1.6-rc.0

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
- 70c5737: A person's grants: what they may do, read in one call, and tenant admin given or taken. All of it is optional for a runtime: without a `PersonGrantsBinding` the routes answer `501 person-grants-unsupported`.
  - **`GET /v1/identity/users/{userId}/grants`:** `{userId, tenantAdmin?, tenantMember?, projects: [{projectId, role}], teams: [{teamId, role}], reviewer?: {role}}`, as granted directly. What a team's or an org's grants imply is not expanded. `tenantMember` says they read the tenant's settings (a person is a member from being added). `tenantAdmin` and `tenantMember` are absent on a runtime without an authorization store. A tenant admin reads anyone's; anyone else only their own (`403 permission-denied`).
  - **`POST /v1/identity/users/{userId}/grant` and `/ungrant`** with `{kind: 'tenant-admin'}`, the same shape as a service account's grant. Tenant admins only. The grant is written before the call answers, so the person's next request holds it. Project and team roles keep their membership routes.
  - **Refusals:**
    - `404 identity-user-not-found`: no such person.
    - `409 last-tenant-admin`: removing tenant admin from the only person who holds it. Make someone else one first.
    - `409 seed-user-admin`: removing it from the seed user, whom the runtime makes tenant admin at every boot. Unset `KINDGI_SEED_USER_ID` and restart the runtime first.
  - **Evidence kinds:** `person-granted` and `person-ungranted` join `EVIDENCE_KINDS` and the evidence schema.
  - **TypeScript client:** `users.grants(id)`, `users.grant(id, {kind: 'tenant-admin'})` and `users.ungrant(…)`. The two refusals are classified as conflicts.
  - **Python client:** `identity.users.grants`, `.grant` and `.ungrant`, with the `PersonGrants`, `PersonProjectRole`, `PersonTeamRole` and `PersonReviewerRole` models.
  - **CLI:** `kindgi people grants <id> [--table]`, and `kindgi people grant|ungrant <id> --tenant-admin`.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5
  - @kindgi/audit-events@0.1.5
  - @kindgi/platform@0.1.5

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
- 70c5737: A person's grants: what they may do, read in one call, and tenant admin given or taken. All of it is optional for a runtime: without a `PersonGrantsBinding` the routes answer `501 person-grants-unsupported`.
  - **`GET /v1/identity/users/{userId}/grants`:** `{userId, tenantAdmin?, tenantMember?, projects: [{projectId, role}], teams: [{teamId, role}], reviewer?: {role}}`, as granted directly. What a team's or an org's grants imply is not expanded. `tenantMember` says they read the tenant's settings (a person is a member from being added). `tenantAdmin` and `tenantMember` are absent on a runtime without an authorization store. A tenant admin reads anyone's; anyone else only their own (`403 permission-denied`).
  - **`POST /v1/identity/users/{userId}/grant` and `/ungrant`** with `{kind: 'tenant-admin'}`, the same shape as a service account's grant. Tenant admins only. The grant is written before the call answers, so the person's next request holds it. Project and team roles keep their membership routes.
  - **Refusals:**
    - `404 identity-user-not-found`: no such person.
    - `409 last-tenant-admin`: removing tenant admin from the only person who holds it. Make someone else one first.
    - `409 seed-user-admin`: removing it from the seed user, whom the runtime makes tenant admin at every boot. Unset `KINDGI_SEED_USER_ID` and restart the runtime first.
  - **Evidence kinds:** `person-granted` and `person-ungranted` join `EVIDENCE_KINDS` and the evidence schema.
  - **TypeScript client:** `users.grants(id)`, `users.grant(id, {kind: 'tenant-admin'})` and `users.ungrant(…)`. The two refusals are classified as conflicts.
  - **Python client:** `identity.users.grants`, `.grant` and `.ungrant`, with the `PersonGrants`, `PersonProjectRole`, `PersonTeamRole` and `PersonReviewerRole` models.
  - **CLI:** `kindgi people grants <id> [--table]`, and `kindgi people grant|ungrant <id> --tenant-admin`.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/audit-events@0.1.5-rc.0
  - @kindgi/platform@0.1.5-rc.0

## 0.1.4

### Patch Changes

- bd3ce67: **Compliance evidence says who acted.** `GET /v1/compliance/evidence` (and `auditEventToEvidence`) now returns each item's `actor` as `{ kind, id }`, read from the audit event it comes from (`user:<id>`, `agent:<id>`, …). Before, the actor was dropped, so evidence of an authorization check or an approval decision didn't say who made it. An actor of a kind evidence can't name (outside `user`, `agent`, `system`, `admin`, `external`) is left out.
- e58e35c: A gated scope always resolves to a pin: publishing a gate policy for a scope that nothing covering it pins is refused (`409 gate-policy-scope-unpinned`, "pin a version for this scope, or one above it, first"), and so is an unpin that would leave a gated scope on the latest version (`409 gate-policy-needs-pin`), where publishing would go live ungated. A gate policy's `spec.comparison.required` is gone: a promotion must name a comparison exactly when the spec has `comparison`, `evidence`, `metrics` or `replay`. A promotion its gate refused is the audit and evidence kind `agent-promotion-refused`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- Updated dependencies [0b1f48d]
- Updated dependencies [149a8c9]
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [7a8e764]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [06b5fc0]
- Updated dependencies [e17b230]
- Updated dependencies [e7e2f86]
- Updated dependencies [3d23304]
- Updated dependencies [ae417f7]
  - @kindgi/audit-events@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/platform@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/audit-events@0.1.4-rc.5
  - @kindgi/platform@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/audit-events@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/audit-events@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- bd3ce67: **Compliance evidence says who acted.** `GET /v1/compliance/evidence` (and `auditEventToEvidence`) now returns each item's `actor` as `{ kind, id }`, read from the audit event it comes from (`user:<id>`, `agent:<id>`, …). Before, the actor was dropped, so evidence of an authorization check or an approval decision didn't say who made it. An actor of a kind evidence can't name (outside `user`, `agent`, `system`, `admin`, `external`) is left out.
- e58e35c: A gated scope always resolves to a pin: publishing a gate policy for a scope that nothing covering it pins is refused (`409 gate-policy-scope-unpinned`, "pin a version for this scope, or one above it, first"), and so is an unpin that would leave a gated scope on the latest version (`409 gate-policy-needs-pin`), where publishing would go live ungated. A gate policy's `spec.comparison.required` is gone: a promotion must name a comparison exactly when the spec has `comparison`, `evidence`, `metrics` or `replay`. A promotion its gate refused is the audit and evidence kind `agent-promotion-refused`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- Updated dependencies [0b1f48d]
- Updated dependencies [149a8c9]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [e7e2f86]
- Updated dependencies [ae417f7]
  - @kindgi/audit-events@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [06b5fc0]
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/audit-events@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [7a8e764]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/audit-events@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/audit-events@0.1.3
  - @kindgi/platform@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/audit-events@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/audit-events@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/audit-events@0.1.0
  - @kindgi/platform@0.1.0
