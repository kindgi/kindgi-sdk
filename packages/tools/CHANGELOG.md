# @kindgi/tools

## 0.2.0-rc.1

### Patch Changes

- b6e20ca: **`POST /v1/deployments` refuses a pack's tool whose version the runtime holds with another definition: `409 tool-already-registered`.** Before, a deploy kept the manifest the version already held and only moved its code pointer to the new image. So a tool changed under the same version, such as a new input schema, another `needsSpec` (whose account a connection uses, for one), `mutating` or its approvals, deployed "ok", and its new code ran under the old manifest. The deploy now checks each of the pack's tools before it writes anything, as it does the pack's data blocks:
  
  - A version the runtime doesn't hold is published, as before.
  - One it holds in the deploy's project with the same definition is kept, active or unregistered, as before. A new image of the same tool is the same definition: what a deploy derives (the image and artifact version in the code pointer, the version's project and secret scopes) isn't compared.
  - One it holds in the deploy's project with another definition, active or unregistered, is refused. `details.fields` names the fields of its definition that differ (the manifest's top-level fields, and `modulePath` for where its code lives in the pack), and the message says to give the tool a new version. Nothing is written.
  - A version in another project, or an MCP endpoint's tool, is refused as before (`tool-project-mismatch`, `tool-kind-mismatch`). One the runtime takes from another project of the project's environment order, and one published with another definition while the deploy runs, are refused at the write, and the deploy rolls back what it wrote.
  
  A digest replay goes through the same check. So an image recorded before this release, whose tool the runtime kept with another definition, now gets `409 tool-already-registered` where it got `200`. Give the tool a new version and build again.
  
  `@kindgi/tools` exports what the deploy compares: `toolDefinition` (a tool's declared fields, and its module path), `changedToolFields` and `sameToolDefinition`. The classification of the manifest's fields is typed over every field, so one a later release adds fails the typecheck until it's classified. The tools in `@kindgi/connections` take a new version whenever what they declare changes, and their tests pin each one's definition at its version.
- b6e20ca: **A tool's error says why it failed.** A tool whose fetch failed used to report only `fetch failed`. The reason was in the error's cause, which no run showed. Now the message names each cause, Node's way:
  
  ```text
  Handler for tool "acme.list-orders" threw: TypeError: fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)
  ```
  
  - **Where:** a pack tool's handler, a check's `evaluate`, a pack file that fails to import, and a tool run in the server's own process. Every place a failure shows carries the message: the run's record, its events, the console, the model's retry and the CLI.
  - **Three causes at most,** each on one line and cut at 500 characters, never inside a word. A cause the message already says is left out.
  - **A refused connection names its addresses:** `AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:4000, connect ECONNREFUSED 127.0.0.1:4000`.
  - **An error without a cause reads as it did.**
  - **The message is masked, its causes and the error's own words alike.** A Kindgi token becomes `[redacted]` whole, a `Bearer` value is redacted, a URL's password becomes `***`, and a URL's secret query or fragment value becomes `[redacted]`. `?token=`, `#access_token=`, `X-Amz-Signature=`, a SAS `sig=` and `?key=` are covered. Log lines keep their form, a token's last four included.
  - **A pack tool's own secrets and connection tokens are taken out first,** at any depth of the error, before the message is masked or cut. So the mask, the cut and the one-line step can't leave part of one, a connection string's host included.
  - **`@kindgi/log`** exports `describeCauses(err)`, which gives the `; caused by …` text, and `scrubText(text, { fullMask: true })`, which is the mask for an error a run shows.
- b6e20ca: **A tool can say its results are text from outside: `resultIsOutsideData`.** A tool manifest's new optional `resultIsOutsideData: true` says the tool's results are text nobody checked, such as a mail someone sent. An agent then reads each result of it as data, not instructions:
  - in an `<event>` block;
  - in that turn, and again in every later turn's history;
  - with the framework's line about outside data in the system message from the turn's start.
  
  It changes what the model is told, not what the tool may do. The pack index carries it, and `GET /v1/tools` shows it. `outlookMessagesList` sets it, so it moves to version 1.1.0: a project that has 1.0.0 gets the flag when it takes 1.1.0.
- b6e20ca: **In a run no person started, a tool that reads with a person's connection now waits for that person's yes too, as one that changes things does; in a schedule's or webhook's run, list it in its tools allowed unattended to run it unasked.** A tool counts when it has an `as: 'person'` connection, whatever its `mutating` says. On a flow's tool step such a call is refused with `needs-a-person`, as a change is.
  
  **A run can say a mail started it.**
  - `startedBy` and a run's `trigger.kind` can be `mail`. The two OpenAPI enums are now built from `RUN_STARTED_BY` and the new `RUN_TRIGGER_KINDS`, so they can't drift from the runtime's.
  - `RunMailbox` (`app`, and `as: 'company' | 'person'`) is the mailbox a mail trigger's run came from. It's recorded with the run, as `mailbox`, beside `startedBy` and `toolsAllowedUnattended`, and a resumed turn reads it back from its snapshot.
  - In a run a mail started, two more calls wait for a person's yes in an agent turn, and are refused in a flow's tool step:
    - a call of any tool that isn't `mutating: false`;
    - a call with a connection of the run's own mailbox, its app and kind, read-only or not.
  - A tool the mail trigger's `toolsAllowedUnattended` lists runs without that yes, as on a schedule or a webhook.
  - `needsPersonsYesUnattended` takes the run's mailbox as an optional fourth argument.
  - `unattendedWaitReason` gives why a call waits, the first that holds: the tool declares it (`declared`), it uses a person's connection (`persons-connection`), or in a mail's run it changes something (`mail-change`) or uses the run's own mailbox (`mail-own-mailbox`). So a refusal can name the reason the rule found. `needsPersonsYesUnattended` is whether it gives one.
  - The TypeScript client's `RunTrigger.kind` can be `mail`.
- Updated dependencies [b6e20ca]
  - @kindgi/log@0.2.0-rc.1
  - @kindgi/schema@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **An agent's tool call gets the connections its tool declares, before it runs.** `InvokeAgentBindings.connections` is where it gets them: a runtime's `ConnectionResolver` and the env it serves.
  - **Found once per call, and recorded without a token.** A person's connection that's missing, lacks a permission or needs reconnecting makes a connect request when a person started the run, and the call waits for them to connect (`waitingFor.connections`). In any other run it can't wait, and the call fails.
  - **Asked fresh every time the tool runs,** never recorded: the tool reads its tokens in `ctx.connections`. When the app refuses one (`ConnectionRejectedError`, or a pack tool's `connection-rejected`), its token is renewed and the call runs once more. If the app refuses the renewed one too, the call fails with `connection-rejected`, as a call its connections stop does (below), and the connection stays as it is.
  - **A token the tool echoes in what it throws goes no further.** The call's tokens are replaced by `[redacted]` in its error's message, stack and own strings, in the errors, arrays and plain objects it holds (a pack error's `issues`, a `details` object), down its causes, and in any other object it holds whose JSON form carries one (a request, a client's headers), which is written out redacted in its place, before the run's events, its record or the model see it. `withoutConnectionTokens` in `@kindgi/tools` does this for any runner.
  - **A call its connections stop runs nothing.** It fails with `tool.failed` and a code: `connection-app-missing`, `connection-needs-a-person`, `connection-missing`, `connection-declined`, `connection-timed-out` or `connection-renew-failed`. The model reads why as the call's result, `{ status: 'failed', error: { code, message } }`, and the turn goes on.
  - **A call that acts with a person's connection is theirs to approve.** When it asks for an approval, the approval names that person as its only `approver`, with the account it acts as (`connection`). The binding refuses one whose approver has no reviewer seat at the rank it needs, by throwing `approver-not-a-reviewer`, and the call fails with `connection-approver-not-a-reviewer`. Four eyes (`separateApprover`) on such a call can't be met, so it fails with `connection-approval-conflict` before anyone is asked to connect.
  - **The approvals routes:** an approval addressed to one member is theirs alone to decide, and among the reviewers only they see it in the list, `GET /v1/approvals/{id}` and its audit bundle; to them it doesn't exist (`404 approval-not-found`). A person who is the tenant's admin still reads it, and `POST /v1/approvals/{id}/complete` tells them only its approver decides it (`403 named-approver-required`). A page of only someone else's approvals still continues to the next.
  - **Without `connections`,** a call to a tool that declares one fails with `connection-app-missing`; no other call changes.
- 08dedca: **Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
  - **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. An OAuth 2.0 sign-in's `refreshToken` says whether a connect needs a refresh token: `'required'` (the default) refuses one without, and `'optional'` is for an app that may give none, whose connections then work until one minute before their access token ends and then need reconnecting (a grant that gives neither a refresh token nor the token's `expires_in` is refused). `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. A permission's `grants` and each account scope is one scope, with no space or comma, since the scopes an app grants are read split on both. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
  - **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too, alone or as another error's `cause`), so the runtime renews the token once and runs the call again. `connectionRejectionOf(error)` finds it, up to three causes deep, for a runtime's dispatch and a pack service alike. When the app can't give a token just now, the call fails with `ConnectionRenewError` (`connection-renew-failed`) and the connection stays as it is; one it can't renew at all (no refresh token, or the grant withdrawn) needs reconnecting, and the call waits or is refused as for any such connection. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
  - **`@kindgi/specs`:** `tool.schema.json` 1.3.0 has `needsSpec.connections` and the `connection` authorization.
  - **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
  - **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use. A secret read for a connection names its caller `connections`, in `@kindgi/compliance` too.
- 08dedca: **Connections on the wire.** A server with a `ConnectionBinding` (`createApp({ connections })`, which needs the env it serves) answers:
  - **`GET /v1/connection-entries`:** the apps a company can connect, with what each permission allows in plain words.
  - **`/v1/connection-apps`:** a tenant admin registers the company's own app at Google or GitHub, by secret reference, and lists (removed ones too with `includeRemoved=true`), reads, changes or removes it. A project uses one registration of an app, so two registrations of it can't serve the same project. A registration a connection still uses can't be removed, nor its client changed (its client id, or its GitHub App). Without an authorizer, the key's `tenant-admin` scope decides who's a tenant admin here, as on the other connections routes.
  - **`/v1/connections`:** a member lists their own connections, a tenant admin every one. Removed ones are listed only with `state=removed`, or with the others under `includeRemoved=true`. `POST` starts a connect for the member's own account, or for the company's (a tenant admin only), and answers a connect request; its `start` gives the app's sign-in address, and `POST /v1/connections/finish` takes what the app sent back. `DELETE` disconnects. Someone else's connection or connect request answers the same `404` as one that doesn't exist.
  - **A GitHub App's connect:** its `start` goes to the app's install page while the app has no installation, and otherwise to GitHub's authorization. The finish attaches an installation only if the person's GitHub account can reach it. When it reaches several, the finish answers `kind: 'pick-installation'`, the request lists them (`installations`), and the start takes the one picked (`installationId`); `newInstallation: true` installs the app on another account. When it reaches none, the finish answers `403 connection-installation-unreachable` with the request's id (`details.connectRequestId`), to start it again that way.
  - **Why a connection needs reconnecting:** `stateReason` says `invalid-grant`, `no-refresh-token`, `token-missing`, `store-write-failed`, `installation-missing`, `installation-permissions`, `suspended`, `sessions-revoked` or `access-expired`, each described in the schema. Other values may be added; `state` says what to do. A connection the app gave no refresh token has `accessEndsAt`, when its access token ends; from one minute before then, it needs reconnecting (`access-expired`), and reads say so too.
  - **`POST /v1/connection-notices/{tenantId}/{appId}`:** where an app tells the server a person withdrew access. It takes no key, answers `202`, and every refusal has the same body.
  - **A paused run says what it waits for:** `waitingFor.connections` lists each connect it waits on (the app, the connection's name, and whether it's a reconnect). An approval names its addressee (`approver`) and the connection a send uses (`connection`).
  - **The connect wait token takes the step:** `computeConnectWaitToken({ runId, stepScope, callId, name })`, so the same call id in two steps of a flow waits on two requests. `ResolveConnectionsInput.stepScope` carries it.
  - **Clients:** `client.connectionEntries`, `client.connectionApps` and `client.connections` in the TypeScript client, and the same resources in the Python client.
- 68e0d57: **A pack tool can pause its run until another system answers (pack protocol 2.8.0).**
  
  - **Declaring it:** a tool declares `pauses: true`. Its handler gets `ctx.waitToken`, `{ id, url }`: it hands the `url` to the system that will answer, then returns `ctx.pause({ timeoutMs, name })`. That system `POST`s its answer to the link as JSON, with no `Authorization` header: the link is the credential. The answer, valid against the tool's output schema, becomes the call's result. The handler may also answer at once, as any tool does.
  - **Re-runs:** the token's id is the same every time one attempt of the call runs; a retry of its step gets a new token, and waits afresh. A re-run after a crash gets a new link to the same wait, and either link completes it. Hand on the new one only if the old one never went out, and dedupe on `idempotencyKey`.
  - **How long:** `timeoutMs` is from 1 ms to 24 days (`MAX_PAUSE_TIMEOUT_MS`), and 24 hours when not given (`DEFAULT_PAUSE_TIMEOUT_MS`). A pause never waits forever. `name` says what the run waits for, in 1 to 200 characters.
  - **Refusals:**
    - a tool with a declarative `spec` or an MCP transport can't declare `pauses`: `defineTool` answers `invalid-tool-definition`, and the indexer `manifest-validation-failed`;
    - a pause outside those bounds is `handler-shape-invalid`;
    - the new error `pause-not-available`: a call from a runtime that sends no wait token, or a pause from a tool that doesn't declare `pauses`. Reading `ctx.waitToken` throws then, so the tool fails before it hands anything on. Pausing needs a runtime that speaks pack protocol 2.8.0.
  - **The protocol:** a tool's index entry carries `pauses: true` (pack index 1.6.0, tool manifest 1.2.0), and the call's context then carries `waitToken`. The pack service answers `{ v: 2, kind: 'pause', timeoutMs, name }`, each field only when the tool gave it. A tool that doesn't declare `pauses` never sees the token.
  - **`@kindgi/handler-runtime`:** `runHandlerOrPause` returns a pause as a third outcome. `runHandler` keeps its two, and reports a pause as `pause-not-available`.
  - **`@kindgi/tools`, for a runtime that calls tools:**
    - `invokeToolOrPause` returns `{ kind: 'pause', pause: { tokenId, timeoutMs, name } }` when the tool's handler returns `pauseOutcome(...)`. `invokeTool` reports a pause as `tool-pause-unsupported`, and so does `invokeToolOrPause` for a tool that doesn't declare `pauses`;
    - a runtime that won't run a pausing call again throws `ToolRerunsExhaustedError` from the handler, and the call fails with `wait-token-reruns-exhausted`;
    - `wait-token-timed-out` is the error for an answer that didn't come in time;
    - `ToolContext.attempt` counts the runs of the call's step;
    - `toolOutputIssues(tool, output)` checks an answer that comes from outside the call, such as another system's answer to a paused call, against the tool's output schema, as a call's output is checked: `{ path, message }` per finding, or `undefined` when it fits;
    - `PAUSE_TOKEN_PREFIX` (`pause:`) starts the waitpoint id of every pause. The runtime mints these ids, never a handler.
  - **`@kindgi/handler`:** `NodeContext.attempt` counts the runs of a step, and `WAITPOINT_TIMEOUT_REASON` is the reason a wait that timed out resumes with.
  - **`@kindgi/api`:** a tool's wire manifest (`Tool`) carries `pauses`.
  - **Conformance:** the fixture pack gains `conformance.pause`, and targets gain a `pause` feature they may not support yet.
- Updated dependencies [d70c2a5]
  - @kindgi/schema@0.2.0-rc.0
  - @kindgi/log@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/schema@0.1.10
  - @kindgi/log@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/log@0.1.10-rc.1
  - @kindgi/schema@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/schema@0.1.10-rc.0
  - @kindgi/log@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

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
- cf339d3: **A tool can ask for a person's yes on every call no person is there to see: `needsApprovalWhenUnattended`.** A tool manifest's new optional `needsApprovalWhenUnattended: true` declares it. In a run no person started:
  - **An agent's call of the tool waits for a reviewer,** as `always_ask` does. Neither the agent's `conversationPolicy.hitl` nor the tenant's approval rules can lift it.
  - **A flow's tool step that calls it fails,** with `needs-a-person: …` naming the tool, since a tool step can't wait. Call such a tool from an agent step.
  - In a run a person started, the agent's own gates decide, as for any tool. A tool that doesn't declare it is unchanged.
  
  **A run says how it started: `startedBy`** on `GET /v1/runs` and `GET /v1/runs/{runId}`, and on `KernelRunRecord`. It's `person` (signed in, or with their own API key), `key` (a service account's key), or `schedule`, `webhook` or `event` (a trigger). Only `person` counts as attended (`runIsAttended`, `@kindgi/runtime`). It's set from the caller, never from the request body, and never changes: an approval doesn't make a run its approver's. A run that a run starts started the way its run did. A run from before a runtime recorded it has none, and counts as unattended.
  - **A key acts as its person.** For automation, use a service account's key: its runs count as unattended. A request with a service account's key is `key` whoever else it names. A tenant's first admin key, the one `POST /v1/system/tenants` answers with when it names no `firstAdmin`, is a service account's too: for the work you start, add yourself as a person and use a key of your own.
  - **The wire `Tool`** carries `needsApprovalWhenUnattended`, so `kindgi tools get` and the console show it. The pack indexer carries it into the pack's index.
  - **The `woocommerce` template declares it** on `woo.refund`, `woo.refund-large`, `woo.set-price` and `woo.publish-product`. A staff member's refund in the store chat runs as the store agent says; one an order webhook's run asks for waits for a person.
  - **The authoring skills** (`kindgi-authoring-tools` and the Java, Python and Scala ones) say when to declare it.
- Updated dependencies [3b90568]
  - @kindgi/log@0.1.9
  - @kindgi/schema@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/log@0.1.9-rc.1
  - @kindgi/schema@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

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
- cf339d3: **A tool can ask for a person's yes on every call no person is there to see: `needsApprovalWhenUnattended`.** A tool manifest's new optional `needsApprovalWhenUnattended: true` declares it. In a run no person started:
  - **An agent's call of the tool waits for a reviewer,** as `always_ask` does. Neither the agent's `conversationPolicy.hitl` nor the tenant's approval rules can lift it.
  - **A flow's tool step that calls it fails,** with `needs-a-person: …` naming the tool, since a tool step can't wait. Call such a tool from an agent step.
  - In a run a person started, the agent's own gates decide, as for any tool. A tool that doesn't declare it is unchanged.
  
  **A run says how it started: `startedBy`** on `GET /v1/runs` and `GET /v1/runs/{runId}`, and on `KernelRunRecord`. It's `person` (signed in, or with their own API key), `key` (a service account's key), or `schedule`, `webhook` or `event` (a trigger). Only `person` counts as attended (`runIsAttended`, `@kindgi/runtime`). It's set from the caller, never from the request body, and never changes: an approval doesn't make a run its approver's. A run that a run starts started the way its run did. A run from before a runtime recorded it has none, and counts as unattended.
  - **A key acts as its person.** For automation, use a service account's key: its runs count as unattended. A request with a service account's key is `key` whoever else it names. A tenant's first admin key, the one `POST /v1/system/tenants` answers with when it names no `firstAdmin`, is a service account's too: for the work you start, add yourself as a person and use a key of your own.
  - **The wire `Tool`** carries `needsApprovalWhenUnattended`, so `kindgi tools get` and the console show it. The pack indexer carries it into the pack's index.
  - **The `woocommerce` template declares it** on `woo.refund`, `woo.refund-large`, `woo.set-price` and `woo.publish-product`. A staff member's refund in the store chat runs as the store agent says; one an order webhook's run asks for waits for a person.
  - **The authoring skills** (`kindgi-authoring-tools` and the Java, Python and Scala ones) say when to declare it.
- Updated dependencies [3b90568]
  - @kindgi/log@0.1.9-rc.0
  - @kindgi/schema@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- 57a7b2e: **An HTTP tool's response body is read under the call's deadline, its cancel, and a size cap.**
  - **The deadline and the cancel cover the body:** `timeoutMs` (30 s by default) runs until the body is read, not just until the headers arrive, and so does the run's cancel. A server that answers at once and then trickles its body fails the call as timed out, and the body's connection is closed.
  - **A size cap,** counted as fetch decodes the body (so a small gzip download that expands past the cap is refused too). Reading stops at the cap, and the call fails, naming it. The default is 10 MiB.
  - **`ToolSpecSynthesizerOptions.maxResponseBytes?`** (optional) sets the cap for the handlers a host synthesizes (`defineTool(spec, { synthesizer: { maxResponseBytes } })`). A value that isn't a positive whole number is refused when the tool is built.
  - **A failed call's message** still quotes the start of its body (512 characters), and reads at most 2 KiB of it.
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
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- Updated dependencies [d92706f]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/log@0.1.8
  - @kindgi/schema@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- 57a7b2e: **An HTTP tool's response body is read under the call's deadline, its cancel, and a size cap.**
  - **The deadline and the cancel cover the body:** `timeoutMs` (30 s by default) runs until the body is read, not just until the headers arrive, and so does the run's cancel. A server that answers at once and then trickles its body fails the call as timed out, and the body's connection is closed.
  - **A size cap,** counted as fetch decodes the body (so a small gzip download that expands past the cap is refused too). Reading stops at the cap, and the call fails, naming it. The default is 10 MiB.
  - **`ToolSpecSynthesizerOptions.maxResponseBytes?`** (optional) sets the cap for the handlers a host synthesizes (`defineTool(spec, { synthesizer: { maxResponseBytes } })`). A value that isn't a positive whole number is refused when the tool is built.
  - **A failed call's message** still quotes the start of its body (512 characters), and reads at most 2 KiB of it.
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
- ebf405d: **`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
  - A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
  - A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
  - Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it. New `holdJsonSchema` does the same for `compileJsonSchema`, and a tool holds its validators through it. A schema JSON can't carry (a key whose value is `undefined`, say) is never cached, so it's held as compiled.
  - Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
  - Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only as it builds the program, for its size or a few escapes, passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
  - `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
  - A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
- Updated dependencies [d92706f]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/log@0.1.8-rc.0
  - @kindgi/schema@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- 72f3582: The tool call idempotency key's description now says how its JSON is written: as `JSON.stringify` writes it, no whitespace, and characters beyond ASCII as themselves, never `\u` escapes. In Python that's `json.dumps(parts, separators=(',', ':'), ensure_ascii=False)`; the default `json.dumps` escapes them and gives another key. The key itself is unchanged.
- fdb644c: **Test a tool with its env values decided as a run decides them.** A unit test reached a tool's `needsSpec.env` only as it passed it, so a handler had to repeat each default in code.
  - **`invokeToolForTest(tool, input, context?)`** (`@kindgi/tools`, `@kindgi/sdk/define`) calls the tool through `invokeTool`, deciding its env values the way the runtime decides a pack tool's:
    - each declared name takes the context's `env` value, else its schema's `default`;
    - each value is checked against its schema;
    - the handler's `ctx.env` holds the declared names only.
  
    A name with neither, or a value its schema refuses, is `precondition-failed` (`env-value-missing`, then `env-value-invalid`), and the handler doesn't run. As in a run, the input is checked first.
  - **`toolContextForTest(overrides?)`**: a context for a unit test, the TypeScript counterpart of Python's `ToolContext.for_test`. It holds tenant `tenant-test`, run `run-test` and an abort signal, with what you pass over them.
  - **`invokeTool` is unchanged.** It passes `ctx.env` as given, because in a run the runtime's tool resolves its own env.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7
  - @kindgi/schema@0.1.7
  - @kindgi/log@0.1.7

## 0.1.7-rc.0

### Patch Changes

- 72f3582: The tool call idempotency key's description now says how its JSON is written: as `JSON.stringify` writes it, no whitespace, and characters beyond ASCII as themselves, never `\u` escapes. In Python that's `json.dumps(parts, separators=(',', ':'), ensure_ascii=False)`; the default `json.dumps` escapes them and gives another key. The key itself is unchanged.
- fdb644c: **Test a tool with its env values decided as a run decides them.** A unit test reached a tool's `needsSpec.env` only as it passed it, so a handler had to repeat each default in code.
  - **`invokeToolForTest(tool, input, context?)`** (`@kindgi/tools`, `@kindgi/sdk/define`) calls the tool through `invokeTool`, deciding its env values the way the runtime decides a pack tool's:
    - each declared name takes the context's `env` value, else its schema's `default`;
    - each value is checked against its schema;
    - the handler's `ctx.env` holds the declared names only.
  
    A name with neither, or a value its schema refuses, is `precondition-failed` (`env-value-missing`, then `env-value-invalid`), and the handler doesn't run. As in a run, the input is checked first.
  - **`toolContextForTest(overrides?)`**: a context for a unit test, the TypeScript counterpart of Python's `ToolContext.for_test`. It holds tenant `tenant-test`, run `run-test` and an abort signal, with what you pass over them.
  - **`invokeTool` is unchanged.** It passes `ctx.env` as given, because in a run the runtime's tool resolves its own env.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/schema@0.1.7-rc.0
  - @kindgi/log@0.1.7-rc.0

## 0.1.6

### Patch Changes

- bef2d8c: **A tool whose `needsSpec` schema wouldn't compile is refused up front.** Each schema in `needsSpec.secrets` and `needsSpec.env` must compile as the runtime compiles it when it loads the tool, and an env value's `default` must be a string. Before, a pack with one the runtime couldn't compile (an unknown keyword, say) deployed fine, and then the runtime left that tool out, so calls to it failed as an unknown tool. Now `defineTool` refuses it (`invalid-tool-definition`), and so do `POST /v1/tools` (`400 validation-failed`) and a deployment (`400 deployment-validation-failed`). The message names the tool, the slot and the name (`Tool "acme.sign": the schema for needsSpec.secrets.SIGNING_KEY doesn't compile: …`), and the issue's path is `/needsSpec/<slot>/<name>`.
- 85ef97c: **A tool's secret can be optional.** A secret declared in `needsSpec.secrets` with a schema that accepts `null` (`{ type: ['string', 'null'] }`) is optional. When the env doesn't have it, or has it empty, it's left out of `ctx.secrets` and the call goes on, with the call's log line naming it. A value that is set is still checked against the schema. A revoked secret, one whose value is gone at its provider though it's still mapped, or a secrets backend that fails, still fails the call. The schema has to name `null`: an unconstrained `{}` stays required. This needs runtime 0.1.6 or later: an older runtime requires every declared secret, failing a call without one with `secret-unavailable`. The guide ("An optional secret"), the authoring skills for every pack language, and the TypeScript and Python context types say so.
  
  `SecretError`'s `secret-not-found` (`@kindgi/api`) gains an optional `reason`: `deleted-at-provider` when the secret is mapped but its provider has no value for it. Absent means it was never stored.
- 307771f: A model provider's key is used by its provider only. A secret that a provider registration of the tenant names (its `secret_ref`, in any env) can't be declared or sent by a tool, or named by an MCP or a webhook endpoint:
  
  - **`POST /v1/tools`, `POST /v1/mcp/endpoints`, and `POST` or `PATCH /v1/webhook-endpoints`** refuse it with `400 provider-key-refused`, naming the secret and the provider (`details.secret`, `details.providerId`). The message says what to do: store the key under its own name (the same value is fine) and use that name.
  - **`POST /v1/deployments`** reports each tool that names one as a `deployment-validation-failed` issue (`path` `/secrets/<name>`), and deploys nothing.
  - **`POST /v1/providers`** refuses a `secret_ref` that a tool (its current version), an MCP endpoint or a webhook endpoint already uses: `409 provider-key-in-use`, with `details.usedBy` listing each.
  
  For a runtime to enforce the same at every call, `@kindgi/api` exports `guardProviderKeys(binding, keys, user)`: a `SecretBinding` whose `resolve` answers a model provider's key with the new `SecretError` code `provider-key-refused` (naming the secret and the provider), for whatever hands secrets to tools and endpoints, while the provider adapters keep the store itself. Also exported: `providerKeysOf(registry)`, `providerKeyRefusal`, `usersOfSecret`, and their types.
  
  `@kindgi/tools` exports `toolSecretNames(manifest)`: every secret a tool declares or sends, by name.
- 03151ca: **A union of types compiles.** A schema with `type: ['string', 'number', 'boolean', 'null']`, which is what Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`, used to be refused ("strict mode: use allowUnionTypes…"), while `.nullable()` compiled. It's standard JSON Schema, and every schema compiler now takes it: tool input and output, an agent's typed output, a guardrail check's config, flow and block schemas, and the pack service's validation. `ALLOW_UNION_TYPES` (`@kindgi/schema`) says so.
  - A schema that strict mode still refuses (an open tuple, an unknown keyword) says how out: for a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.
  - The Java pack service validates a union of types too (its CHANGELOG). Python's always did.
- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.
- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/schema@0.1.6
  - @kindgi/types@0.1.6
  - @kindgi/log@0.1.6

## 0.1.6-rc.0

### Patch Changes

- bef2d8c: **A tool whose `needsSpec` schema wouldn't compile is refused up front.** Each schema in `needsSpec.secrets` and `needsSpec.env` must compile as the runtime compiles it when it loads the tool, and an env value's `default` must be a string. Before, a pack with one the runtime couldn't compile (an unknown keyword, say) deployed fine, and then the runtime left that tool out, so calls to it failed as an unknown tool. Now `defineTool` refuses it (`invalid-tool-definition`), and so do `POST /v1/tools` (`400 validation-failed`) and a deployment (`400 deployment-validation-failed`). The message names the tool, the slot and the name (`Tool "acme.sign": the schema for needsSpec.secrets.SIGNING_KEY doesn't compile: …`), and the issue's path is `/needsSpec/<slot>/<name>`.
- 85ef97c: **A tool's secret can be optional.** A secret declared in `needsSpec.secrets` with a schema that accepts `null` (`{ type: ['string', 'null'] }`) is optional. When the env doesn't have it, or has it empty, it's left out of `ctx.secrets` and the call goes on, with the call's log line naming it. A value that is set is still checked against the schema. A revoked secret, one whose value is gone at its provider though it's still mapped, or a secrets backend that fails, still fails the call. The schema has to name `null`: an unconstrained `{}` stays required. This needs runtime 0.1.6 or later: an older runtime requires every declared secret, failing a call without one with `secret-unavailable`. The guide ("An optional secret"), the authoring skills for every pack language, and the TypeScript and Python context types say so.
  
  `SecretError`'s `secret-not-found` (`@kindgi/api`) gains an optional `reason`: `deleted-at-provider` when the secret is mapped but its provider has no value for it. Absent means it was never stored.
- 307771f: A model provider's key is used by its provider only. A secret that a provider registration of the tenant names (its `secret_ref`, in any env) can't be declared or sent by a tool, or named by an MCP or a webhook endpoint:
  
  - **`POST /v1/tools`, `POST /v1/mcp/endpoints`, and `POST` or `PATCH /v1/webhook-endpoints`** refuse it with `400 provider-key-refused`, naming the secret and the provider (`details.secret`, `details.providerId`). The message says what to do: store the key under its own name (the same value is fine) and use that name.
  - **`POST /v1/deployments`** reports each tool that names one as a `deployment-validation-failed` issue (`path` `/secrets/<name>`), and deploys nothing.
  - **`POST /v1/providers`** refuses a `secret_ref` that a tool (its current version), an MCP endpoint or a webhook endpoint already uses: `409 provider-key-in-use`, with `details.usedBy` listing each.
  
  For a runtime to enforce the same at every call, `@kindgi/api` exports `guardProviderKeys(binding, keys, user)`: a `SecretBinding` whose `resolve` answers a model provider's key with the new `SecretError` code `provider-key-refused` (naming the secret and the provider), for whatever hands secrets to tools and endpoints, while the provider adapters keep the store itself. Also exported: `providerKeysOf(registry)`, `providerKeyRefusal`, `usersOfSecret`, and their types.
  
  `@kindgi/tools` exports `toolSecretNames(manifest)`: every secret a tool declares or sends, by name.
- 03151ca: **A union of types compiles.** A schema with `type: ['string', 'number', 'boolean', 'null']`, which is what Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`, used to be refused ("strict mode: use allowUnionTypes…"), while `.nullable()` compiled. It's standard JSON Schema, and every schema compiler now takes it: tool input and output, an agent's typed output, a guardrail check's config, flow and block schemas, and the pack service's validation. `ALLOW_UNION_TYPES` (`@kindgi/schema`) says so.
  - A schema that strict mode still refuses (an open tuple, an unknown keyword) says how out: for a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.
  - The Java pack service validates a union of types too (its CHANGELOG). Python's always did.
- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.
- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- Updated dependencies [03151ca]
- Updated dependencies [b4bbd95]
  - @kindgi/schema@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0
  - @kindgi/log@0.1.6-rc.0

## 0.1.5

### Patch Changes

- 93ebe85: Agents can remember, under rules the model can't change.
  
  - **The declaration.** `defineAgent({ memory: { remember: { types: ['preference'], scope: 'same-user', keepDays: 30 } } })` gives the agent's turns the built-in tool `kindgi_remember`. The model picks the type (one of `types`), the text (up to 2,000 characters), an optional slot `key` and when it stops being true. It never picks the scope: `same-user` (the conversation's end user, else the user the run acts for), `same-conversation`, `same-project` or `tenant` come from the declaration and the run. Built-in tools are `kindgi_<verb>`, with no dots, so the model calls exactly the name the docs and instructions use, and the tool's description names it. The prefix is reserved: an agent can't list a built-in in `tools`, and publishing a tool whose id starts with `kindgi_` is refused (`BUILT_IN_TOOL_PREFIX` in `@kindgi/tools`).
  - **Every remembered fact** is `unverified`, attributed to the agent version (`attributedTo`) and to the run, step and tool call that wrote it (`generatedBy`). It expires after `keepDays` (default 30) unless a person verifies it. A new value for the same type and `key` replaces the one the same agent remembered before, as that fact's next revision. An agent never replaces another agent's fact or a person's.
  - **A person approves it first** when the scope is wider than one person (`same-project`, `tenant`), or the text reads like an instruction (always/never, ignore/disregard, "you must", a link, one of the agent's tools). Until then no read sees it, and the model is told it waits for review. Otherwise it's used at once.
  - **The tool dispatches like any other.** The agent's `hitl.tools` policy applies to it, a replay refuses it or uses the recording, and the tool error policy decides what a failed store does. `InvokeAgentBindings.memoryWriter` (`MemoryRememberBinding` in `@kindgi/memory`) is where the runtime stores it. On a host without one, a call answers that nothing was remembered, and publishing warns `remember-unavailable` (`MemoryBinding.agentRemember`).
  - **The `<memory>` block** now gives each fact the time it was recorded (`recordedAt`), and for a fact an agent remembered, which agent (`agent`). Two agents' values for the same slot both show, each with its agent and time; none is picked silently. **This changes what models see.**
  - **Provenance.**
    - Each retrieval intent is a `memory-read` node with `operation: search_memory`, holding what it searched and the ids it found. Each retrieved fact is `retrieved-from` its search and carries its ranks.
    - Each remembered fact is a `memory-write` node with `operation: create_memory` or `update_memory`, its actor the agent version, `produced` by the tool call.
    - These are the OpenTelemetry GenAI operation names, as an attribute on the existing node kinds, so no client sees a new enum value.
  - **`Fact.expiresAt`** (optional in the API): when a revision stops being readable. No read returns a fact after it. The runtime sets it from the fact's retention, or from an agent-remembered fact's unverified window.
  - **Specs.** The agent spec (schema-version 1.5.0) carries `memory.remember`. The pack index keeps it, as it keeps all of `memory`.
- 768ad8f: The TypeScript pack service writes `@kindgi/log` records on stderr (subsystem `pack`), the same schema as the runtime's: one record per call carrying the call's `tenantId`, `runId`, `requestId`, `toolId`, its outcome and duration, and the caller's `traceId` from the `traceparent` it sent. The lifecycle (`listening`, `boot-failed`, `config-invalid`, `draining`, `stopped`) is written whatever the levels; `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` apply to the rest (`auto` is JSON unless stderr is a terminal). The service's records keep `kind` beside `event`, so an older supervisor still reads them.
  
  `ctx.log` (an optional `ToolContext.log`): a logger bound to the call, so a tool's own records carry the run's ids and trace (`ctx.log.info('looked up order', { orderId })`, subsystem `pack.tool`). `kindgi dev` shows them as `[pack]` lines.
  
  The supervisor reads records and older bare events, acts only on the service's own lifecycle, and no longer swallows the pack's own JSON output that happens to have a `kind` field. It runs its child with `KINDGI_LOG_FORMAT=json`. `createPackService` takes `log`; its `logger` callback still gets the events.
- 81f46aa: **A replay sends a read-only tool the env values the past run's call saw.** A comparison that replays a run (a candidate agent version over a test set) runs some read-only tools live. Those tools now read the config the past run read, not today's, so an env value changed since then can't skew the judged deltas.
  
  - **`@kindgi/api`:** a judged run's copy keeps `context.toolEnv`, each tool's recorded env values by tool id. It's taken from an agent turn's calls and from a flow's tool steps, agent steps and sub-flows. It's optional in the spec, and a run from before env was recorded has none.
  - **`@kindgi/agents`:** a replay binding's `live` decision can carry `env`. The turn journals it with the decision, keeps it out of the replay report, and sends it as the call's `ctx.env`. Names it doesn't hold (a tool version that declares more) resolve as usual.
  - **`@kindgi/tools`:** `toolCallRecordKey` and `TOOL_ENV_RECORD_KEY` name where a call's `ToolContext.record` decisions are journaled, so dispatch sites and capture agree.
- 280377e: **A tool's env values, per project (`ctx.env`).** A tool that declares names in `needsSpec.env` gets their values in `ctx.env` on each call: the call's project's value, else its org's, else the tenant's, in the env the runtime serves (`KINDGI_ENV`). A schema `default` makes a name optional. The values a call used are recorded with it (`ToolContext.record`, new: the step's durable record, set by the dispatch site), so the call re-run after a wait or a retry sees the same ones. A runtime that resolves them is needed; with an older one, `ctx.env` stays absent.
  
  - **`@kindgi/tools`:** `ToolContext.env`; `ToolContext.record`, which an agent turn's tool dispatch (`@kindgi/agents`) sets to its step's record under `tool-call:<call id>:<tool id>:<key>`; and `TypedNeeds` documents what `env` and `secrets` take (strings, checked by their schema; `config` is reserved).
  - **Pack protocol 2.5.0** (`@kindgi/specs`, `@kindgi/handler-runtime`, the Python SDK): `callContext.env` holds the declared names' string values. It's additive: a pack service that predates it already passes it through.
  - **`kindgi env set/list/unset --scope=tenant|org:<id>|project:<id> --env=<name>`** act on the runtime's env values (`/v1/env`). Without `--scope` they edit the pack's local env files, as before. `--env` is required with `--scope`. `set` refuses to change a value without `--force`, and warns about a name that looks like a credential. A runtime that doesn't serve `/v1/env` gets a plain message.
  - `kindgi env`'s description now says what it manages. It used to say values "resolve into `needs.env` at deploy time", which nothing did.
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
  - @kindgi/schema@0.1.5
  - @kindgi/log@0.1.5
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- 93ebe85: Agents can remember, under rules the model can't change.
  
  - **The declaration.** `defineAgent({ memory: { remember: { types: ['preference'], scope: 'same-user', keepDays: 30 } } })` gives the agent's turns the built-in tool `kindgi_remember`. The model picks the type (one of `types`), the text (up to 2,000 characters), an optional slot `key` and when it stops being true. It never picks the scope: `same-user` (the conversation's end user, else the user the run acts for), `same-conversation`, `same-project` or `tenant` come from the declaration and the run. Built-in tools are `kindgi_<verb>`, with no dots, so the model calls exactly the name the docs and instructions use, and the tool's description names it. The prefix is reserved: an agent can't list a built-in in `tools`, and publishing a tool whose id starts with `kindgi_` is refused (`BUILT_IN_TOOL_PREFIX` in `@kindgi/tools`).
  - **Every remembered fact** is `unverified`, attributed to the agent version (`attributedTo`) and to the run, step and tool call that wrote it (`generatedBy`). It expires after `keepDays` (default 30) unless a person verifies it. A new value for the same type and `key` replaces the one the same agent remembered before, as that fact's next revision. An agent never replaces another agent's fact or a person's.
  - **A person approves it first** when the scope is wider than one person (`same-project`, `tenant`), or the text reads like an instruction (always/never, ignore/disregard, "you must", a link, one of the agent's tools). Until then no read sees it, and the model is told it waits for review. Otherwise it's used at once.
  - **The tool dispatches like any other.** The agent's `hitl.tools` policy applies to it, a replay refuses it or uses the recording, and the tool error policy decides what a failed store does. `InvokeAgentBindings.memoryWriter` (`MemoryRememberBinding` in `@kindgi/memory`) is where the runtime stores it. On a host without one, a call answers that nothing was remembered, and publishing warns `remember-unavailable` (`MemoryBinding.agentRemember`).
  - **The `<memory>` block** now gives each fact the time it was recorded (`recordedAt`), and for a fact an agent remembered, which agent (`agent`). Two agents' values for the same slot both show, each with its agent and time; none is picked silently. **This changes what models see.**
  - **Provenance.**
    - Each retrieval intent is a `memory-read` node with `operation: search_memory`, holding what it searched and the ids it found. Each retrieved fact is `retrieved-from` its search and carries its ranks.
    - Each remembered fact is a `memory-write` node with `operation: create_memory` or `update_memory`, its actor the agent version, `produced` by the tool call.
    - These are the OpenTelemetry GenAI operation names, as an attribute on the existing node kinds, so no client sees a new enum value.
  - **`Fact.expiresAt`** (optional in the API): when a revision stops being readable. No read returns a fact after it. The runtime sets it from the fact's retention, or from an agent-remembered fact's unverified window.
  - **Specs.** The agent spec (schema-version 1.5.0) carries `memory.remember`. The pack index keeps it, as it keeps all of `memory`.
- 768ad8f: The TypeScript pack service writes `@kindgi/log` records on stderr (subsystem `pack`), the same schema as the runtime's: one record per call carrying the call's `tenantId`, `runId`, `requestId`, `toolId`, its outcome and duration, and the caller's `traceId` from the `traceparent` it sent. The lifecycle (`listening`, `boot-failed`, `config-invalid`, `draining`, `stopped`) is written whatever the levels; `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` apply to the rest (`auto` is JSON unless stderr is a terminal). The service's records keep `kind` beside `event`, so an older supervisor still reads them.
  
  `ctx.log` (an optional `ToolContext.log`): a logger bound to the call, so a tool's own records carry the run's ids and trace (`ctx.log.info('looked up order', { orderId })`, subsystem `pack.tool`). `kindgi dev` shows them as `[pack]` lines.
  
  The supervisor reads records and older bare events, acts only on the service's own lifecycle, and no longer swallows the pack's own JSON output that happens to have a `kind` field. It runs its child with `KINDGI_LOG_FORMAT=json`. `createPackService` takes `log`; its `logger` callback still gets the events.
- 81f46aa: **A replay sends a read-only tool the env values the past run's call saw.** A comparison that replays a run (a candidate agent version over a test set) runs some read-only tools live. Those tools now read the config the past run read, not today's, so an env value changed since then can't skew the judged deltas.
  
  - **`@kindgi/api`:** a judged run's copy keeps `context.toolEnv`, each tool's recorded env values by tool id. It's taken from an agent turn's calls and from a flow's tool steps, agent steps and sub-flows. It's optional in the spec, and a run from before env was recorded has none.
  - **`@kindgi/agents`:** a replay binding's `live` decision can carry `env`. The turn journals it with the decision, keeps it out of the replay report, and sends it as the call's `ctx.env`. Names it doesn't hold (a tool version that declares more) resolve as usual.
  - **`@kindgi/tools`:** `toolCallRecordKey` and `TOOL_ENV_RECORD_KEY` name where a call's `ToolContext.record` decisions are journaled, so dispatch sites and capture agree.
- 280377e: **A tool's env values, per project (`ctx.env`).** A tool that declares names in `needsSpec.env` gets their values in `ctx.env` on each call: the call's project's value, else its org's, else the tenant's, in the env the runtime serves (`KINDGI_ENV`). A schema `default` makes a name optional. The values a call used are recorded with it (`ToolContext.record`, new: the step's durable record, set by the dispatch site), so the call re-run after a wait or a retry sees the same ones. A runtime that resolves them is needed; with an older one, `ctx.env` stays absent.
  
  - **`@kindgi/tools`:** `ToolContext.env`; `ToolContext.record`, which an agent turn's tool dispatch (`@kindgi/agents`) sets to its step's record under `tool-call:<call id>:<tool id>:<key>`; and `TypedNeeds` documents what `env` and `secrets` take (strings, checked by their schema; `config` is reserved).
  - **Pack protocol 2.5.0** (`@kindgi/specs`, `@kindgi/handler-runtime`, the Python SDK): `callContext.env` holds the declared names' string values. It's additive: a pack service that predates it already passes it through.
  - **`kindgi env set/list/unset --scope=tenant|org:<id>|project:<id> --env=<name>`** act on the runtime's env values (`/v1/env`). Without `--scope` they edit the pack's local env files, as before. `--env` is required with `--scope`. `set` refuses to change a value without `--force`, and warns about a name that looks like a credential. A runtime that doesn't serve `/v1/env` gets a plain message.
  - `kindgi env`'s description now says what it manages. It used to say values "resolve into `needs.env` at deploy time", which nothing did.
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
  - @kindgi/schema@0.1.5-rc.0
  - @kindgi/log@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

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
- 8b28a25: **`pickVersion` and `latestVersion`: one rule for picking a version from a range.** `@kindgi/tools` now exports the rule the tool registry uses when a turn resolves an agent's tool ranges. A range picks the highest version it allows. A prerelease is picked only when the range names one, as in npm. With no range, the pick is the latest version. Other places that turn a range into a version use the same rule: the runtime's registries, `kindgi dev`, and (next) the versions an agent version pins when it's published. So a pin is always the version a run would have picked. `createToolRegistry`'s `resolve` behaves as before.
- 62608e3: **Unregister stops a version being chosen, not the pins that hold it.**
  
  - **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
    - Only its exact version (`getVersion`, `hasVersion`) reaches it.
    - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
  - **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
  - **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
  - **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.
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

- @kindgi/schema@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

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
- 8b28a25: **`pickVersion` and `latestVersion`: one rule for picking a version from a range.** `@kindgi/tools` now exports the rule the tool registry uses when a turn resolves an agent's tool ranges. A range picks the highest version it allows. A prerelease is picked only when the range names one, as in npm. With no range, the pick is the latest version. Other places that turn a range into a version use the same rule: the runtime's registries, `kindgi dev`, and (next) the versions an agent version pins when it's published. So a pin is always the version a run would have picked. `createToolRegistry`'s `resolve` behaves as before.
- 62608e3: **Unregister stops a version being chosen, not the pins that hold it.**
  
  - **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
    - Only its exact version (`getVersion`, `hasVersion`) reaches it.
    - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
  - **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
  - **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
  - **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- eac7732: A tool knows its run's project and org: `ToolContext.projectId` and `orgId` (Python: `project_id`, `org_id`), and a guardrail check's trace gets `orgId` (`org_id`) next to `projectId`. The runtime sets them from the run and its project, never from the run's input or a model's arguments, so a tool can compare an org or project id in its input with the run's own instead of trusting it. `orgId` is absent when the project has no org. They reach pack code in the call context: pack protocol 2.3.0 adds optional `projectId` and `orgId` to `callContext`. A pack service built with Kindgi 0.1.1 answers such calls as before (it checks only `v`, `tenantId` and `runId`); `@kindgi/pack-conformance` has a suite that proves it against the 0.1.1 releases (`describeCallContextCompatibility`). Also: `NodeContext.projectId` / `orgId` for the kernel, and `InvokeAgentInput.orgId` and `ResumeAgentTurnInput.orgId`, so a turn resumed after an approval keeps its org.
- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- 89a14b6: Tools from MCP servers built with the TypeScript MCP SDK are no longer skipped. Their schemas declare JSON Schema draft-07 (`"$schema": "http://json-schema.org/draft-07/schema#"`), and every tool schema compiled as Draft 2020-12 only, so each one failed with `no schema with key or ref "http://json-schema.org/draft-07/schema#"`. An MCP tool's schemas (`transport: 'mcp'`) now compile in the dialect they declare: draft-06, draft-07, 2019-09 or 2020-12 (the default when they declare none), each with its own semantics (a draft-07 array-form `items` is a tuple), and without Ajv's strict mode, a lint for the schemas a pack writes: a server's union `type`s, open tuples and extension keywords are valid JSON Schema. Another dialect is refused, naming it. A pack's own tools are unchanged: Draft 2020-12, in strict mode; one declaring another dialect is refused with a message that says so. `@kindgi/schema` exports the compiler as `compileJsonSchema` (with `dialects` and `strict` options), and `jsonSchemaDialect`. `tool.schema.json`'s `input` and `output` descriptions say which dialects a tool's schemas may be in.
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

- aec851d: The hooks the runtime needs to guard the server's connections to hosts a tenant chose (T83). The guard itself is in the runtime.
  
  - **`@kindgi/api`:** `HostReach` gains `'metadata-network'` (link-local addresses, where the cloud metadata endpoints hand out the server's credentials) and `'loopback'` (the server's own host). `KINDGI_TENANT_HOST_ACCESS=deployed` refuses both, as well as `'exec'`.
  - **`@kindgi/capabilities`:** `AdapterFactoryInput.fetch` is the fetch for a provider endpoint the registration chose.
  - **`@kindgi/adapter-model-openai-compat`:** the factory sends through that fetch.
  - **`@kindgi/tools`:**
    - `defineTool(spec, { synthesizer: { fetch } })` and `ToolSpecSynthesizerOptions`: a declarative HTTP tool's handler sends through the runtime's fetch.
    - `validateToolManifest` now refuses an HTTP tool whose `urlTemplate` puts a `{placeholder}` in the scheme, host or port, or isn't `http(s)://` with a host. Placeholders belong in the path and query, where they're URL-encoded; in the authority, a run's input would pick the host.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS`'s description says what `deployed` refuses.
- aec851d: `ToolContext.secrets`: the secrets a tool declares in `needsSpec.secrets`, resolved by the runtime for the call's tenant, are typed on the handler's context, so a TypeScript pack tool reads `ctx.secrets?.NAME` without a cast. The `kindgi-authoring-tools` skill says how to declare and read them, and that the runtime resolves an HTTP tool's `secretRef` itself.
- aec851d: `precondition-failed`: a runtime that refuses to run a tool — a secret the tool declares couldn't be resolved, say — throws `ToolPreconditionError(reason, message)` from its handler wrapper, and `invokeTool` reports `{ code: 'precondition-failed', reason }` instead of `handler-error … handler threw`, since the tool's code never ran. `isToolPreconditionError` recognizes one from any copy of the package.
- aec851d: A pack service to run a pack's code over HTTP (pack protocol v2), and tools learn which run they belong to.
  
  - `@kindgi/handler-runtime`:
    - New `./protocol` (v2): tool and check requests name the tool or check by id, and responses are `result`, `check-result` or `error` messages with typed codes (including `tool-not-in-pack`, `tool-version-mismatch`, `deadline-exceeded` and `cancelled`).
    - New `./pack-service`: `createPackService` and `startPackService` expose `POST /v1/invoke`, `GET /v1/info`, `/healthz` and `/readyz`, with token auth, a concurrency cap, a body limit, deadlines, cancellation on disconnect, prewarm and drain.
    - New `./pack-service-main`: the process entry (`KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_INDEX`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`, `PORT`; SIGTERM drains).
    - `HandlerContext.abortSignal` (in-process calls only) lets handlers stop on cancel or deadline.
    - The v1 worker, controller and invokers are unchanged.
  - `@kindgi/tools`: `ToolContext.runId`, the kernel run a call belongs to. `requestId` stays the individual call's id.
  - `@kindgi/agents`: agent tool calls set `runId` to the turn's kernel run. They used to pass only the model's call id.
- aec851d: Tool lookups are bound to one tenant: `ToolRegistry.forTenant(tenantId)` replaces `hydrate`.
  
  - `@kindgi/tools`: `ToolRegistry.hydrate?(tenantId): Promise<void>` is replaced by a required `forTenant(tenantId): Promise<ToolRegistry>` that returns a registry answering for that tenant only. With `hydrate` followed by the tenant-less `resolve`, a multi-tenant implementation had to keep a shared "current tenant", so two tenants' concurrent agent turns could resolve each other's tools. `createToolRegistry` (single-tenant) returns itself; `invalidate(tenantId)` is unchanged. Implementations must add `forTenant` (breaking for custom `ToolRegistry` implementations).
  - `@kindgi/agents`: each turn resolves its tools through `toolRegistry.forTenant(tenantId)` (`resolveTurnTools`).
- aec851d: Tool inputs get their Zod defaults, transforms and refinements.
  
  - `@kindgi/schema`:
    - `toJSONSchema(schema, io)` and `toJSONSchemaSync(schema, converter, io)` take a required `io` (`SchemaIo`, `'input'` or `'output'`). The two sides differ exactly where Zod defaults: on the input side a `.default()` field is optional, on the output side it is required. Before, every conversion produced the output side.
    - `parseWithSchema(schema, value)` parses through a Zod schema's Standard Schema interface: defaults, transforms and refinements applied, or the issues.
  - `@kindgi/tools`:
    - A tool's advertised input schema is the input side, so a model may leave a defaulted field out.
    - `invokeTool` validates a copy of the input, filling in JSON Schema `default`s. A Zod-authored tool's input is then parsed with `inputZod`, so the handler gets its parsed input. A failed refinement is `input-validation-failed`, with the field's path.
    - A handler's input type defaults to `InferOutput` of the input schema, the parsed type.
  - `@kindgi/handler-runtime`: `runWorker`, which the pack service runs tools through, prepares the input the same way. The indexer converts tool inputs and guardrail config on the input side.
  - `@kindgi/guardrails`: a check's config schema converts on the input side.
  - `@kindgi/agents`: a typed agent's output schema converts on the output side, so downstream steps can rely on every field.
  - `@kindgi/sdk`: the tools skill explains what a handler receives.

### Patch Changes

- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
