# @kindgi/provenance

## 0.5.0

### Patch Changes

- 6421d6f: The server's messages call the place a workspace, as the console and the CLI do. Among them are the lookups that find nothing in it, the slug conflicts, its limits and policies (the model router's reasons among them), its render and compile budgets, and the pack service's `KINDGI_PACK_TENANT_ID` checks. What you match on keeps `tenant`: the error codes, `tenantId`, the scope value `tenant` and the paths. So do the tenant admin role and the system routes' messages, which are for the operator of a runtime that serves several workspaces. A rename's answer follows its route: `PATCH /v1/tenant` says workspace, and the operator's `PATCH /v1/system/tenants/{tenantId}` says tenant.
- 1ed72e3: The doc comments and READMEs call the place a workspace, as the console does, and so do the npm descriptions of `@kindgi/capabilities`, `@kindgi/memory` and `@kindgi/policy-contract` and the types package's `SPEC.md`. What you type keeps `tenant`: `tenantId`, `TenantId` and `forTenant`. So does the multi-tenant text.
- 1365f49: The spec schemas' descriptions, the doc text of the types a pack author reads, and the indexer's `check-id-unprefixed` warning call the place a workspace, as the console does. The policy spec's title is Workspace policy. What you type keeps `tenant`: `tenantId`, the `kindgi-tenant-id` header, `KINDGI_PACK_TENANT_ID`, the scope and context-slot value `tenant`, and error codes such as `pack-tenant-mismatch`. So does the multi-tenant text: a cross-tenant call is still refused by that name.
- Updated dependencies [6421d6f]
- Updated dependencies [04813e4]
- Updated dependencies [3360533]
- Updated dependencies [fda29c0]
- Updated dependencies [1ed72e3]
- Updated dependencies [8327900]
- Updated dependencies [1365f49]
  - @kindgi/schema@0.5.0
  - @kindgi/runtime@0.5.0
  - @kindgi/flow@0.5.0
  - @kindgi/types@0.5.0

## 0.4.0

### Patch Changes

- 1131ec3: **Eval runs are now test runs.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** `/v1/eval-runs` is `/v1/test-runs`, with `{testRunId}` in its paths; `cancel`, `events` and `rescore` keep their sub-paths. `POST /v1/test-sets/{testSetId}/runs` still starts one.
  - **Fields and values.**
    - A test run's own id is `testRunId`: in the start and rescore answers, the run view and the list rows, where it was `runId`. Ids of agent runs, such as a case's `runIds`, keep their names.
    - `evalRunId` is `testRunId` everywhere it names a test run: in the agent pin body, in a run's replay marker (`{ of, testRunId }`), in a replay's provenance, and in `/v1/runs`'s filter.
    - The stream's events `eval-run.completed`, `eval-run.failed`, `eval-run.cancelled`, `eval-run.case-completed` and `eval-run.case-failed` are `test-run.*`, with the same endings.
    - The compliance evidence kind `eval-run` is `test-run`.
    - `GET /v1/compliance/evidence?kind=` answers 400 for a kind that is neither a built-in evidence kind nor one the classifier names, such as `eval-run`. It was an empty page. A kind the classifier names but doesn't mark exportable is still an empty page.
  - **Errors.** Codes starting `eval-run-` start `test-run-`.
  - **Schemas and types.** `EvalRun*` names are `TestRun*`. A comparison's `EvalComparison`, `EvalBaseline`, `EvalOverrides` and `EvalSample` are `TestRunComparison`, `TestRunBaseline`, `TestRunOverrides` and `TestRunSample`, and the types `EvalReads` and `EvalGroupWeights` are `TestRunReads` and `TestRunGroupWeights`. The `@kindgi/api` export `EvalSubjectInvoker`, which a test run calls to run each case, is `TestRunSubjectInvoker`.
  - **TypeScript client.** `client.evalRuns` is `client.testRuns`.
  - **CLI.** `kindgi eval-runs` is `kindgi test-runs`, and `--eval-run` is `--test-run` (on `kindgi agents pin` and `kindgi runs list`). `kindgi exports create` writes them as `test-runs`.
- Updated dependencies [b25b82f]
- Updated dependencies [d92355b]
- Updated dependencies [d6c9279]
- Updated dependencies [f2adcc2]
- Updated dependencies [3a1502d]
- Updated dependencies [7bdd73e]
- Updated dependencies [9b015f7]
- Updated dependencies [9a8a294]
- Updated dependencies [1bd877d]
- Updated dependencies [dff9515]
- Updated dependencies [1131ec3]
- Updated dependencies [d576ff4]
  - @kindgi/types@0.4.0
  - @kindgi/runtime@0.4.0
  - @kindgi/flow@0.4.0
  - @kindgi/schema@0.4.0

## 0.3.1

### Patch Changes

- @kindgi/flow@0.3.1
  - @kindgi/schema@0.3.1
  - @kindgi/runtime@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/flow@0.3.1-rc.1
  - @kindgi/runtime@0.3.1-rc.1
  - @kindgi/schema@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/flow@0.3.1-rc.0
  - @kindgi/schema@0.3.1-rc.0
  - @kindgi/runtime@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- 8dd91b0: **A flow run's provenance record.** A finished flow run gets a record of its own, as an agent turn has: each step that ran, why it ran, what it started, and what the run's output came from.
  - **`flowProvenanceBuilder`** (`@kindgi/provenance`) builds a finished flow run's record from its journal, read page by page without payloads: ids, kinds, statuses, times and codes, never a value or a digest of one. Each step is a node of the new kind `step`, with its edges to what caused it. A loop body step is placed by its scope and iteration, and a fanout branch is a step of its fanout. A step lists the child runs it started, and the results it reused when the runtime passes them. A tool step's waits are `wait` and `resume` nodes. A cancelled wait's `resume` node says `decision: 'cancelled'`, with the cancel's reason when the kernel kept one, as an agent turn's does.
  - **Its caps:** at most 5000 nodes and 4 MiB of canonical bytes, cut from the middle in journal order, with a `truncated` node that says what was left out. A loop keeps whole iterations from both ends, at most 25 from each, within a node budget by its depth, and folds the rest into one node, which counts the loops inside them too. A node's attributes stop at 16 KiB, and an id over 256 characters takes a digest form. Journal entries the build didn't read become a `truncated:entries` node, and a loop across them says `partial: true`.
  - **`flowProvenanceId(runId)`** is the record's id: a version 5 UUID of the run id, so a parent run names its child's record before it's written. Flow records are written at record version `1.1.0`, which adds the `step` node kind to the schema.
  - **`stepNodePlacer(nodes)`** (`@kindgi/provenance`) finds the node in a flow record that counts a child run of one of its steps, from the child's `parentNodeId` and `parentScope`: the step's own node, or the folded node of the loop iteration it ran in. It answers `undefined` when the record has neither, as for a step cut with the record's middle. The ids it computes are part of the record's format.
  - **`JournalEntryFacts`** (`@kindgi/runtime`): the position facts a journal entry can carry beside its payload, its scope, loop, iteration, edge decision and codes, which the builder reads.
  - **`GET /v1/provenance/{runId}`** has `stepUsage` beside the DAG: a flow record's model usage per step from the cost ledger, keyed by the step's node id. A binding gives it as `getStepUsage`, one row per step as its runs' rows name it (`StepRunsUsage`), and the route places each row on the node that counts the step's runs (`stepNodePlacer`): a folded loop node sums its iterations', and a row with no node, as for a step cut with the record's middle, is left out. The signed export carries it too, at bundle version `1.3.0`. A finished run whose record isn't written yet answers `404 provenance-not-found` with `details.recordState` (`being-written` or `failed`) and, when it failed, `details.reason`.
  - **`GET /v1/provenance?flowId=`** lists one flow's runs' records, and every page says `flowId` back. In the TypeScript client, `provenance.query({ flowId })` returns a `ProvenancePage` with `flowId`, a record has `stepUsage`, and a not-found error keeps the server's details as `fields`. In the Python client, `provenance.list(flow_id=)`.
  - **`kindgi provenance list --flow=<flow-id>`** lists one flow's runs' records. A runtime that doesn't list records by flow ignores the filter, and the command then stops instead of printing every record as the flow's. `kindgi provenance get` on a finished run whose record isn't written yet prints the record's state.
  - **The getting-started skills** (`@kindgi/sdk`), TypeScript and Python, say what a flow run's record holds: its steps, the runs they started and each step's model usage, with each client's name for the step usage and the not-found error's record state.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [29b60dd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/runtime@0.3.0
  - @kindgi/types@0.3.0
  - @kindgi/flow@0.3.0
  - @kindgi/schema@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **A flow run's provenance record.** A finished flow run gets a record of its own, as an agent turn has: each step that ran, why it ran, what it started, and what the run's output came from.
  - **`flowProvenanceBuilder`** (`@kindgi/provenance`) builds a finished flow run's record from its journal, read page by page without payloads: ids, kinds, statuses, times and codes, never a value or a digest of one. Each step is a node of the new kind `step`, with its edges to what caused it. A loop body step is placed by its scope and iteration, and a fanout branch is a step of its fanout. A step lists the child runs it started, and the results it reused when the runtime passes them. A tool step's waits are `wait` and `resume` nodes. A cancelled wait's `resume` node says `decision: 'cancelled'`, with the cancel's reason when the kernel kept one, as an agent turn's does.
  - **Its caps:** at most 5000 nodes and 4 MiB of canonical bytes, cut from the middle in journal order, with a `truncated` node that says what was left out. A loop keeps whole iterations from both ends, at most 25 from each, within a node budget by its depth, and folds the rest into one node, which counts the loops inside them too. A node's attributes stop at 16 KiB, and an id over 256 characters takes a digest form. Journal entries the build didn't read become a `truncated:entries` node, and a loop across them says `partial: true`.
  - **`flowProvenanceId(runId)`** is the record's id: a version 5 UUID of the run id, so a parent run names its child's record before it's written. Flow records are written at record version `1.1.0`, which adds the `step` node kind to the schema.
  - **`stepNodePlacer(nodes)`** (`@kindgi/provenance`) finds the node in a flow record that counts a child run of one of its steps, from the child's `parentNodeId` and `parentScope`: the step's own node, or the folded node of the loop iteration it ran in. It answers `undefined` when the record has neither, as for a step cut with the record's middle. The ids it computes are part of the record's format.
  - **`JournalEntryFacts`** (`@kindgi/runtime`): the position facts a journal entry can carry beside its payload, its scope, loop, iteration, edge decision and codes, which the builder reads.
  - **`GET /v1/provenance/{runId}`** has `stepUsage` beside the DAG: a flow record's model usage per step from the cost ledger, keyed by the step's node id. A binding gives it as `getStepUsage`, one row per step as its runs' rows name it (`StepRunsUsage`), and the route places each row on the node that counts the step's runs (`stepNodePlacer`): a folded loop node sums its iterations', and a row with no node, as for a step cut with the record's middle, is left out. The signed export carries it too, at bundle version `1.3.0`. A finished run whose record isn't written yet answers `404 provenance-not-found` with `details.recordState` (`being-written` or `failed`) and, when it failed, `details.reason`.
  - **`GET /v1/provenance?flowId=`** lists one flow's runs' records, and every page says `flowId` back. In the TypeScript client, `provenance.query({ flowId })` returns a `ProvenancePage` with `flowId`, a record has `stepUsage`, and a not-found error keeps the server's details as `fields`. In the Python client, `provenance.list(flow_id=)`.
  - **`kindgi provenance list --flow=<flow-id>`** lists one flow's runs' records. A runtime that doesn't list records by flow ignores the filter, and the command then stops instead of printing every record as the flow's. `kindgi provenance get` on a finished run whose record isn't written yet prints the record's state.
  - **The getting-started skills** (`@kindgi/sdk`), TypeScript and Python, say what a flow run's record holds: its steps, the runs they started and each step's model usage, with each client's name for the step usage and the not-found error's record state.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [29b60dd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/runtime@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/flow@0.3.0-rc.0
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

- @kindgi/schema@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/schema@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

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

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- 1463b77: Approvals, conversations and provenance list by project, as runs do. `GET /v1/approvals`, `GET /v1/conversations` and `GET /v1/provenance` take `scopeKind=project|org` + `scopeId`: one project's records, or every project's in an org. A `scopeId` that isn't a UUID is `400 scope-invalid`. The records say their project:
  - an agent's approvals are enqueued in the turn's project (`HitlEnqueueInput.projectId`);
  - a conversation has `projectId`, set by the run that opens it or by `POST /v1/conversations`' new `projectId` (one of the tenant's projects, else `400 bad-input`; omitted, the tenant's Default project, as for a run); `agent_conversations` gets a nullable `project_id` (migration `0003`);
  - a provenance record's list row has `projectId`, which the emitter passes beside the signed document (`ProvenanceEmitBinding.emit(provenance, { projectId })`).
  
  `ListScope` (`@kindgi/types`) is the scope of each binding's list input. TypeScript client: `scope` on `approvals.list`, `conversations.list` and `provenance.query`, and `projectId` on `conversations.open`; the Python client takes `scope_kind` / `scope_id` and `project_id` (regenerated). Records from before this release have no project, so only a list without a scope shows them (nothing is backfilled).
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

### Patch Changes

- aec851d: Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
