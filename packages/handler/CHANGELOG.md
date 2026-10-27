# @kindgi/handler

## 0.2.0-rc.1

### Patch Changes

- Updated dependencies [b6e20ca]
  - @kindgi/authz@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

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
- @kindgi/authz@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/authz@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/authz@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/authz@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- Updated dependencies [d563887]
- Updated dependencies [3502389]
  - @kindgi/authz@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/authz@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- Updated dependencies [d563887]
- Updated dependencies [3502389]
  - @kindgi/authz@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

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
- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8
  - @kindgi/authz@0.1.8

## 0.1.8-rc.0

### Patch Changes

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
- Updated dependencies [ebf405d]
  - @kindgi/types@0.1.8-rc.0
  - @kindgi/authz@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7
  - @kindgi/authz@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0
  - @kindgi/authz@0.1.7-rc.0

## 0.1.6

### Patch Changes

- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- Updated dependencies [fd93b3e]
- Updated dependencies [b4bbd95]
  - @kindgi/authz@0.1.6
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- Updated dependencies [fd93b3e]
- Updated dependencies [b4bbd95]
  - @kindgi/authz@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- Updated dependencies [0919fe6]
- Updated dependencies [1633db1]
- Updated dependencies [eff6249]
  - @kindgi/authz@0.1.5
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [0919fe6]
- Updated dependencies [1633db1]
- Updated dependencies [eff6249]
  - @kindgi/authz@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- Updated dependencies [2b34f78]
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/authz@0.1.4
  - @kindgi/types@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/authz@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/authz@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/authz@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2b34f78]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/authz@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/authz@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/authz@0.1.4-rc.0

## 0.1.3

### Patch Changes

- eac7732: A tool knows its run's project and org: `ToolContext.projectId` and `orgId` (Python: `project_id`, `org_id`), and a guardrail check's trace gets `orgId` (`org_id`) next to `projectId`. The runtime sets them from the run and its project, never from the run's input or a model's arguments, so a tool can compare an org or project id in its input with the run's own instead of trusting it. `orgId` is absent when the project has no org. They reach pack code in the call context: pack protocol 2.3.0 adds optional `projectId` and `orgId` to `callContext`. A pack service built with Kindgi 0.1.1 answers such calls as before (it checks only `v`, `tenantId` and `runId`); `@kindgi/pack-conformance` has a suite that proves it against the 0.1.1 releases (`describeCallContextCompatibility`). Also: `NodeContext.projectId` / `orgId` for the kernel, and `InvokeAgentInput.orgId` and `ResumeAgentTurnInput.orgId`, so a turn resumed after an approval keeps its org.
- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/authz@0.1.3

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
  - @kindgi/authz@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/authz@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/authz@0.1.0
