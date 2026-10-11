# @kindgi/runtime

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
- Updated dependencies [8b60576]
  - @kindgi/authz@0.1.6
  - @kindgi/handler@0.1.6
  - @kindgi/flow@0.1.6
  - @kindgi/types@0.1.6

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
