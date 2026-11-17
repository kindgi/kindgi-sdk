# @kindgi/policy-contract

## 0.8.2

### Patch Changes

- @kindgi/types@0.8.2

## 0.8.1

### Patch Changes

- @kindgi/types@0.8.1

## 0.8.0

### Patch Changes

- @kindgi/types@0.8.0

## 0.7.0

### Minor Changes

- 7f9d20f: **A tool can fail a call on purpose, with its own code and words for a person.** `` throw new ToolFailure('order-not-found', `No order ${orderId}`, { details: { orderId } }) `` (`@kindgi/sdk/define`; `ToolFailure` in Python, `ToolFailureException` in Java and Scala) fails the call with `tool-failed`, a new code beside the crash's.
  
  - **The call's error.** `invokeTool` answers `ToolFailedError`: `{ code: 'tool-failed', message, toolId, reason, details? }`. The tool's code is `reason`, its words are the message as written, with no lead-in and no cause, and `details` are its facts. The message and every string in the details are masked as a thrown message is.
  - **The rules.** The code is kebab case, a letter first, at most 64 characters: a fixed word, since runs are grouped by it. The message isn't empty and is cut at 1,000 characters. The details are a JSON object of at most 4 KiB as JSON. A value the class refuses throws a `TypeError`, so the call is a crash that says why, and so is a `ToolFailure` changed after it was made. `isToolFailure` tells one by its brand, so another copy of the package agrees.
  - **Pack protocol 2.12.0.** The error answer's codes gain `tool-failed`, with `reason` and `details`; `v` stays 2. The TypeScript, Python and Java pack services answer it, and the conformance suite has a fixture tool for it, `conformance.fails-on-purpose`, in each language.
  - **In an agent.** `tool-failed` is a `toolErrors` kind of its own, out of the default and not covered by `tool-error`. With it in `retryOn`, the call goes back to the model with the tool's code, words and details, and an instruction to tell the person or try another way. Otherwise, or past the retries, the turn fails with `ToolFailedTurnError`, `tool-failed` at the top: `{ code, message, toolId, reason, details?, toolRetries? }`. The `tool.failed` stream event says `tool-failed` and the tool's code as `reason`, without the details.
  - **A run's failure.** `Run.failure` for it has the tool's code as `reason`, its details whole in `details`, and the tool as `cause`: `{ toolId }`. The API answers the turn's error with `422`. The OpenAPI document says so, and an agent's `toolErrors.retryOn` takes `tool-failed`, in the agent schema and the clients too.
  
  A check that throws a `ToolFailure` fails as any throw does.
  
  Release-decision: 0.7.0, the maintainers, 2026-11-06T22:04:22Z

### Patch Changes

- c7b560c: **The docs say what `ask_on_first_use` does: each call to the tool waits for an approval, as with `always_ask`.** They said an approved call ran without asking when it was made again with the same arguments in the conversation, but nothing remembers an approval, and every call has always asked. The mode's doc is now on `ToolHitlMode`, where an editor shows it, and `Tool.mutating`'s description (in the tool schema and the API reference), the approvals guide and the authoring skills say the same. How a call is gated doesn't change.
- bb5bbf8: **Files with versions.** A runtime that keeps files serves `/v1/files`: a file is a name and its versions 1, 2, 3, each one stored blob, read by its number or by `latest`. The operations are `files.list`, `files.create`, `files.get`, `files.delete`, `files.versions.list`, `files.versions.add`, `files.versions.get`, `files.versions.download` (the bytes, with `X-Kindgi-File-Version`), `files.versions.restore`, `files.versions.delete`, `files.versions.pin`, `files.versions.unpin` and `files.pinHistory`. Adding or restoring a version takes an optional `expectedVersion`: when Latest isn't that version, nothing is written and the answer is `409 file-version-conflict`. Bytes that are Latest's add no version (`200`, `created: false`). A restore is a new version with an earlier version's bytes, type and tags, under Latest's name. A pinned version can't be deleted, nor a file with one (`409 file-version-pinned`), and a file's last live version goes only with the file (`409 file-last-version`). Reads need `read` on the file's project, or, for a person, `run` there for a file of their own; changes need `write`, except that a person with `run` can create a file of their own that names no run, to start a run with. An upload has the artifact upload's cap: over it is `413 file-too-large`.
  
  `createApp` takes the store as `fileVersions`, a `FileVersionsBinding` from `@kindgi/blob-binding` (its types are also exported by `@kindgi/api`); without one, `/v1/files` isn't mounted. A file's id is its version 1's `blobId`. `BlobMeta` gains `fileId` and `version`, for a blob that is a file's version, and `/v1/artifacts` answers carry them; deleting an artifact whose bytes a file still needs is `409 artifact-in-file`. `FileValue` in `@kindgi/types` takes `fileId` and `version`, both or neither, and `FileId` is a new id type. The retention domains gain `file_version`, opt-in like `memory` and `conversation`: a deleted version goes after the grace, and so does one that isn't Latest, isn't among its file's newest 10, isn't pinned, and was superseded longer ago than the grace. The error codes `file-not-found`, `file-version-not-found`, `file-version-conflict`, `file-version-pinned`, `file-last-version`, `file-too-large` and `artifact-in-file` are in the API's status map and the error codes reference, and the TypeScript client reads each as its kind.
  
  Deleting a file or a version that's already deleted answers `{ deleted: false }` and changes nothing; an id no file ever had is `404 file-not-found`. The version in a restore, delete, pin or unpin path is a whole number from 1. A `files.list` filter on `ownerRunId` or `projectId` that isn't an id is `400`. A version's `supersededAt` is when a newer version replaced it as Latest, so Latest has none. When two versions share bytes, the blob's `BlobMeta.version` names the lower one. The five `artifacts.*` operations are `deprecated: true` and go in 0.8.0, and every `/v1/artifacts` answer, a refused one too, carries a `Link` with `rel="deprecation"` to the docs' "What 0.8.0 removes", `concepts/files-and-versions/#what-080-removes` on the release's docs line. The TypeScript client's wire types keep a deprecated operation, since it's served until the release that removes it.
- af5b037: When a turn merges the `tenantPolicy` bound to it with the policy its `policyRegistry` yields, it now keeps the larger `maxTokensPerCall`. That field is the smallest context window a picked model must have, so keeping the smaller value let the weaker policy win. Now a model whose context window is below either policy's isn't picked. The `TenantPolicy` docs now say what both fields check. `maxCostPerCallUsd` is the highest prompt price per 1K tokens a picked model may have, not what a call costs. `maxTokensPerCall` is the smallest context window it must have, not the tokens a call uses. When no model routes, a `capability-unsatisfiable` error's `requirement` names them the same way, for example `tenant.maxCostPerCallUsd: promptUsdPer1kTokens<=0.5` and `tenant.maxTokensPerCall: contextWindow>=100000`. The context window's message now reads "workspace minimum".
- Updated dependencies [dfaeea7]
- Updated dependencies [2d279a5]
- Updated dependencies [bb5bbf8]
- Updated dependencies [524e626]
- Updated dependencies [439bffc]
- Updated dependencies [00afa37]
- Updated dependencies [25d902a]
  - @kindgi/types@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [6707cb9]
  - @kindgi/types@0.6.0

## 0.5.0

### Patch Changes

- 1ed72e3: The doc comments and READMEs call the place a workspace, as the console does, and so do the npm descriptions of `@kindgi/capabilities`, `@kindgi/memory` and `@kindgi/policy-contract` and the types package's `SPEC.md`. What you type keeps `tenant`: `tenantId`, `TenantId` and `forTenant`. So does the multi-tenant text.
- Updated dependencies [1ed72e3]
- Updated dependencies [1365f49]
  - @kindgi/types@0.5.0

## 0.4.0

### Patch Changes

- **A retired block, policy or release gate can be found.** `GET /v1/blocks`, `GET /v1/policies` and `GET /v1/release-gates` take `?includeRetired=true`, as the lists of agents, flows, tools and test sets do. With it, a retired item (every version unregistered) is listed too, as its highest version with that version's `unregisteredAt`, so a version can be reinstated. Without it, each list answers as before: items with an active version only.
  - CLI: `kindgi blocks list` and `kindgi release-gates list` take `--include-retired`, as the agents, flows, tools and test-sets lists do.
  - Clients: `client.blocks.list`, `client.policies.list` and `client.releaseGates.list` take `includeRetired`. `client.policies.list` returns `PolicyVersionRow` items, which are `Policy` plus the optional `unregisteredAt`.
  - Bindings: `BlockListInput`, `PolicyListInput` and `ReleaseGateListInput` gain an optional `includeRetired`. `PolicyPage.data` is `PolicyVersionRow[]`.
  - Schema: `Policy` gains an optional `unregisteredAt`. `GET /v1/policies/{policyId}` answers the latest active version, which never carries it.
  - A runtime that doesn't honour the parameter ignores it, and lists as before.
  - `kindgi exports create` asks the three lists for retired items too, as it does for the others, so an export includes a retired block, policy or release gate.
- d92355b: **A judgment is now a correction, in the API, the clients, the CLI and the docs.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** `/v1/judgments` is `/v1/corrections`, and `/v1/judgments/{judgmentId}/unregister` is `/v1/corrections/{correctionId}/remove`. The retention domain `judgment` is `correction`, as in `POST /v1/retention/sweep/correction`.
  - **Fields.**
    - `judgmentId` is `correctionId`, and `judgmentIds` is `correctionIds`.
    - A proposal's `evidence.judgmentIds` is `evidence.fixes`.
    - These counts are renamed: `judgmentCount` to `correctionCount`, `minJudgments` to `minCorrections`, `runsWithJudgments` to `runsWithCorrections`, and `anyJudgment` to `anyCorrection`.
    - A response's `judgments` is `corrections`.
    - A comparison summary's `corrections.judgments` is `corrections.results`.
    - A comparison case's `judgedItems`, on its `baseline` and each `candidate`, is `correctedItems`, and a `changes.new` entry's `judged` is `corrected`.
    - A suite built from corrections has `source: 'corrections'`.
    - The improve schedule's `threshold.judges` and `threshold.judgments` are `threshold.correctors` and `threshold.corrections`.
  - **Schemas and types.**
    - `Judgment` is `Correction`, and `JudgmentWithCopies` is `CorrectionWithCopies`.
    - The `{ calls, notCalled }` value that was called `Correction` is now `ExpectedDecisions`, and its grading result is `ExpectedDecisionsResult`.
    - `Judged*` names are `Corrected*`, and `UnregisterJudgmentResult` is `RemoveCorrectionResult`.
  - **TypeScript client.** `client.judgments` is `client.corrections`, and `unregister` is `remove`.
  - **CLI.** `kindgi judgments add|list|show|unregister` is `kindgi corrections add|list|show|remove`.
- d6c9279: **Judge classes are now corrector groups, the judging queue is the expert queue, and judging rules are queue rules.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** `/v1/judge-classes` is `/v1/corrector-groups`, with `{correctorGroupId}` in its paths. `/v1/projects/{projectId}/judging-queue` is `/v1/projects/{projectId}/expert-queue`, and `/v1/projects/{projectId}/judging-rules` is `/v1/projects/{projectId}/queue-rules`; their sub-paths are the same. The retention domain `judge_class` is `corrector_group`.
  - **Fields and values.**
    - `judgeClassId` is `correctorGroupId`, and `judgeClassIds` is `correctorGroupIds`.
    - A correction, a corrected item and a test case's item say `expert` where they said `restricted`.
    - `classWeights` is `groupWeights`, and its value `restricted-only` is `experts-only`.
    - A release gate's `onlyRestrictedClasses` is `onlyExpertGroups`, and its check is named `groupWeights.expertsOnly`.
    - The expert queue's state `judged` is `corrected`, as is a rule result's `judged` count. Progress `byClass` is `byGroup`, and `wantedClassIds` is `wantedGroupIds`.
  - **Errors.** Codes starting `judge-class-` start `corrector-group-`, `judging-rule-` codes start `queue-rule-`, and other `judging-` codes start `expert-queue-`.
  - **Schemas and types.** `JudgeClass*` names are `CorrectorGroup*`, `JudgingRule*` names are `QueueRule*`, and the judging queue's `Judging*` names are `ExpertQueue*`.
  - **TypeScript client.** `client.judgeClasses` is `client.correctorGroups`, `client.projects.judgingQueue` is `client.projects.expertQueue`, and `client.projects.judgingRules` is `client.projects.queueRules`.
  - **CLI.** `kindgi judge-classes` is `kindgi corrector-groups`, `kindgi judging-queue` is `kindgi expert-queue`, and `kindgi judging-rules` is `kindgi queue-rules`. `--class` is `--group`, `--clear-class` is `--clear-group`, and `--class-weights` is `--group-weights`.
  - **Docs.** The guides under `guides/evals/` are now under `guides/improve/`, with no redirects, so old links to them don't resolve. Four of them also have new names:
    - `judge-a-runs-output` is `correct-a-runs-output`.
    - `propose-a-change` is `suggest-a-change`.
    - `judging-reference` is `expert-queue-reference`: the judging reference page is now the expert queue reference, at `guides/improve/expert-queue-reference/`.
    - `live-versions-reference` is `pinned-versions-reference`.
- d576ff4: **Eval suites are now test sets.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** `/v1/eval-suites` is `/v1/test-sets`, with `{testSetId}` in its paths; the sub-paths are the same, including `runs`.
  - **Fields and values.**
    - `suiteId` is `testSetId` everywhere it names a test set, including on eval runs, and `suiteVersion` is `testSetVersion`.
    - A test set's and an eval run's kind `judged` is `corrections`.
    - A release gate's `comparison.suite` is `comparison.testSet`, and its check is named `comparison.testSet`. A comparison's summary says `testSet` where it said `suite`.
    - The retention domain `eval_suite` is `test_set`, and so is the authorization resource type.
    - A `reference-out-of-scope` issue names a test set with the kind `test-set` where it said `suite`.
  - **Errors.** Codes starting `eval-suite-` start `test-set-`.
  - **Schemas and types.** `EvalSuite*` names are `TestSet*`. `EvalKind` is `TestSetKind` (and `EVAL_KINDS` is `TEST_SET_KINDS`), and `CorrectedEvalCase`, `CorrectedEvalCaseCollectionPage` and `CorrectedEvalCaseCorrection` are `CorrectedTestCase`, `CorrectedTestCaseCollectionPage` and `CorrectedTestCaseCorrection`.
  - **TypeScript client.** `client.evalSuites` is `client.testSets`.
  - **Specs.** `@kindgi/specs/eval-suite.schema.json` is `@kindgi/specs/test-set.schema.json`, its `$id` is `https://kindgi.com/schemas/v1/test-set.schema.json` and its title "Test set", and its reference page is `reference/schemas/test-set/`. Its `kind` takes `corrections`, as the API does.
  - **CLI.** `kindgi eval-suites` is `kindgi test-sets`, `--suite` is `--test-set`, and `--suite-version` is `--test-set-version`. `kindgi exports create` writes them as `test-sets` and `test-set-versions`.
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

## 0.3.1

### Patch Changes

- @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
  - @kindgi/types@0.3.0-rc.0

## 0.2.0

### Patch Changes

- @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

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

- 66bb5eb: `GET /v1/policies/{policyId}/versions/{version}` answers for a retired (unregistered) version too, with its `unregisteredAt`, as the agent, flow, block and gate-policy version routes already do. It used to answer `404 policy-not-found`, so a link to a retired version from the versions list led nowhere. `PolicyRegistryBinding.getVersion` now returns a `PolicyVersionRow`: the contract already said a tombstoned version is returned, and its `unregisteredAt` is now part of the type. An active version carries no `unregisteredAt`. A version the retention sweep has purged is still `404`. The TypeScript client's `policies.getVersion` (the client now exports `PolicyVersionRow`) and the Python client's `policies.versions.get` return a `PolicyVersionRow`.
- @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- 66bb5eb: `GET /v1/policies/{policyId}/versions/{version}` answers for a retired (unregistered) version too, with its `unregisteredAt`, as the agent, flow, block and gate-policy version routes already do. It used to answer `404 policy-not-found`, so a link to a retired version from the versions list led nowhere. `PolicyRegistryBinding.getVersion` now returns a `PolicyVersionRow`: the contract already said a tombstoned version is returned, and its `unregisteredAt` is now part of the type. An active version carries no `unregisteredAt`. A version the retention sweep has purged is still `404`. The TypeScript client's `policies.getVersion` (the client now exports `PolicyVersionRow`) and the Python client's `policies.versions.get` return a `PolicyVersionRow`.
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

- b90e2c6: A page cursor a list didn't issue answers `400 bad-input` on the agents, flows, policies and eval-suites `/versions` lists and on an agent's promotions, instead of the first page again.
  - **The bindings say so:** the agent, flow, policy and eval-suite registries gain an optional `issuedCursor(list: 'versions', cursor)`, and the promotions binding an optional `issuedCursor(list: 'promotions', cursor)`. The route asks before it reads the list, and answers `400 bad-input` ("`cursor` is malformed") when the binding says no. A binding without the method gets any cursor, as before.
  - **Why:** a binding that reads a cursor it didn't issue as no cursor hands back the first page, so a client paging until done would start over. The cursor stays opaque to the API: only the binding that issued it knows its shape.
  - **The OpenAPI document** now lists the `400` on these operations, and on the blocks and tools `/versions` lists, which already answered it.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- b90e2c6: A page cursor a list didn't issue answers `400 bad-input` on the agents, flows, policies and eval-suites `/versions` lists and on an agent's promotions, instead of the first page again.
  - **The bindings say so:** the agent, flow, policy and eval-suite registries gain an optional `issuedCursor(list: 'versions', cursor)`, and the promotions binding an optional `issuedCursor(list: 'promotions', cursor)`. The route asks before it reads the list, and answers `400 bad-input` ("`cursor` is malformed") when the binding says no. A binding without the method gets any cursor, as before.
  - **Why:** a binding that reads a cursor it didn't issue as no cursor hands back the first page, so a client paging until done would start over. The cursor stays opaque to the API: only the binding that issued it knows its shape.
  - **The OpenAPI document** now lists the `400` on these operations, and on the blocks and tools `/versions` lists, which already answered it.
- Updated dependencies [b90e2c6]
  - @kindgi/types@0.1.7-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [b4bbd95]
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

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
- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
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
- 490d083: Artifacts belong to a project, and the capability catalog says what each feature means and which of your models have it.
  - **Artifacts (`/v1/artifacts`):**
    - Every artifact belongs to a project: its owner run's, else the upload's new `projectId`, else the tenant's default project. `BlobMeta` carries `projectId` and `createdBy`, and `BlobPutInput` takes them (both optional).
    - With authorization on, listing and downloading need `read` on that project, and uploading and deleting need `write`.
      - An artifact the caller can't read is `404`, as if absent.
      - A list shows only what the caller can read. `?projectId=` narrows it.
    - An upload naming an owner run that doesn't exist is `404 run-not-found`. A `projectId` that isn't the owner run's project is `400`.
    - The runtime caps an upload: `413 artifact-too-large`, with `details.maxBytes`. `CreateAppInput.artifactMaxBytes` sets it (default 100 MB).
  - **Retention domain `artifact`:** a retention policy can purge deleted artifacts after its grace.
  - **Capabilities:**
    - `FEATURE_DESCRIPTIONS` (`@kindgi/capabilities`) says in a line what each of the 13 features means.
    - A `CapabilityDescriptor` may carry `providers: [{providerId, models}]`, the tenant's providers with a model that has the feature (optional in the spec).
  - **TypeScript client:**
    - `artifacts.upload` (multipart), `download` (streamed bytes) and `head`; `list` takes `projectId`.
    - `put` and `get` (content-addressed `BlobRef`s) have no API route: they throw, pointing to `upload` and `download`.
    - `artifact-too-large` is an invalid request.
  - **Python client:** the new fields; a 413 is an `InvalidRequestError`.
  - **Runtime settings (`@kindgi/env-schema`):**
    - `KINDGI_ARTIFACTS` is `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`; it turns on `/v1/artifacts`.
    - `KINDGI_ARTIFACT_MAX_BYTES` sets the upload cap.
    - `kindgi dev` sets artifacts to the pack's `.kindgi/dev/artifacts`, which is gitignored.
  - **CLI:**
    - `kindgi artifacts list|get|upload|download|delete` and `kindgi capabilities list|get` work; before, they were hidden.
    - `artifacts head` is folded into `get`.
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- e17b230: Deleting an org is a tombstone, and `org` is a retention domain. `OrgBinding.delete` no longer erases the org: from then on `get`, `list` and `update` treat it as unknown, and its slug is free for a new org, as before; a retention policy on `org` (new in `RETENTION_DOMAINS`) purges the row. The in-memory binding tombstones too, and the conformance suite checks that a deleted org is unknown to every read, frees its slug, and can be deleted again. `DELETE /v1/orgs/{orgId}` describes what the Kindgi runtime does: the org's projects and teams stay, without an org; the org's own secrets and secret mappings are deleted with it, for good; its own environments and MCP endpoints are unregistered.
- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
- bfeabfd: Publishing a policy that nothing applies is refused. `access-control`, `adapter-allowlist`, `rate-limit` and `compliance` are known policy kinds, but no runtime consumer applies them yet, so publishing one changed nothing, silently. `POST /v1/policies` now answers `400 kind-not-applied` for them, naming the kinds it does apply in `details.appliedKinds` (`model-routing`, `retention`, `tool-errors`, `hitl`). Policies of those kinds already stored stay readable, and the list still filters by them. `@kindgi/policy-contract` exports `APPLIED_POLICY_KINDS` and `isAppliedPolicyKind`; `@kindgi/api` re-exports `APPLIED_POLICY_KINDS`.
- e2ba026: Retention policies are checked when they're published, a tenant has one per domain, and the retention routes are in the API reference and both clients.
  
  - **`POST /v1/policies` validates a `retention` spec** (`{ v: 1, doc }` or bare): an unknown domain, `mode: "archive"` (not implemented) or a bad grace is `400 validation-failed` naming the field, e.g. `policy.spec/doc/domain must be one of: org, agent, … (got "blocks")`. Before, they were stored and every sweep skipped them.
  - **One retention policy per domain**, plus one for `*`. A second policy id for a covered domain is `409 policy-scope-taken` (`details.heldBy` names the policy that covers it: publish a new version of that one, or unregister it first); a new version can't move a policy to another domain (`409 policy-scope-changed`); reinstating a retired policy whose domain another now covers is `409 policy-scope-taken`. `@kindgi/policy-contract` exports `policyScope` (a retention policy's scope is its domain) and `retentionSpecDoc`; `PolicyRegistryBinding.publish` and `reinstateVersion` gain the `scope-taken` and `scope-changed` outcomes, which the binding enforces under a lock. A runtime that doesn't enforce it yet answers as before.
  - **Policies stored before that rule** can still cover one domain twice: the policy whose latest version is highest applies, then the lower policy id. `GET /v1/retention/scheduled` and the sweeps report them in `conflicts` (`RetentionPolicyConflict`: the domain, the policy ids, the one that applies).
  - **The retention routes are in the OpenAPI spec**: `GET /v1/retention/scheduled`, `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}`. The TypeScript client has `client.retention.scheduled()` and `client.retention.sweep({ domain?, maxPerDomain? })`; the Python client has `client.retention.scheduled()`, `.sweep()` and `.sweep_domain(domain)`, and raises `ConflictError` for `policy-already-registered`, `policy-scope-taken` and `policy-scope-changed`.
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

- e2ba026: Retention policies are checked when they're published, a tenant has one per domain, and the retention routes are in the API reference and both clients.
  
  - **`POST /v1/policies` validates a `retention` spec** (`{ v: 1, doc }` or bare): an unknown domain, `mode: "archive"` (not implemented) or a bad grace is `400 validation-failed` naming the field, e.g. `policy.spec/doc/domain must be one of: org, agent, … (got "blocks")`. Before, they were stored and every sweep skipped them.
  - **One retention policy per domain**, plus one for `*`. A second policy id for a covered domain is `409 policy-scope-taken` (`details.heldBy` names the policy that covers it: publish a new version of that one, or unregister it first); a new version can't move a policy to another domain (`409 policy-scope-changed`); reinstating a retired policy whose domain another now covers is `409 policy-scope-taken`. `@kindgi/policy-contract` exports `policyScope` (a retention policy's scope is its domain) and `retentionSpecDoc`; `PolicyRegistryBinding.publish` and `reinstateVersion` gain the `scope-taken` and `scope-changed` outcomes, which the binding enforces under a lock. A runtime that doesn't enforce it yet answers as before.
  - **Policies stored before that rule** can still cover one domain twice: the policy whose latest version is highest applies, then the lower policy id. `GET /v1/retention/scheduled` and the sweeps report them in `conflicts` (`RetentionPolicyConflict`: the domain, the policy ids, the one that applies).
  - **The retention routes are in the OpenAPI spec**: `GET /v1/retention/scheduled`, `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}`. The TypeScript client has `client.retention.scheduled()` and `client.retention.sweep({ domain?, maxPerDomain? })`; the Python client has `client.retention.scheduled()`, `.sweep()` and `.sweep_domain(domain)`, and raises `ConflictError` for `policy-already-registered`, `policy-scope-taken` and `policy-scope-changed`.
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- e17b230: Deleting an org is a tombstone, and `org` is a retention domain. `OrgBinding.delete` no longer erases the org: from then on `get`, `list` and `update` treat it as unknown, and its slug is free for a new org, as before; a retention policy on `org` (new in `RETENTION_DOMAINS`) purges the row. The in-memory binding tombstones too, and the conformance suite checks that a deleted org is unknown to every read, frees its slug, and can be deleted again. `DELETE /v1/orgs/{orgId}` describes what the Kindgi runtime does: the org's projects and teams stay, without an org; the org's own secrets and secret mappings are deleted with it, for good; its own environments and MCP endpoints are unregistered.
- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
- bfeabfd: Publishing a policy that nothing applies is refused. `access-control`, `adapter-allowlist`, `rate-limit` and `compliance` are known policy kinds, but no runtime consumer applies them yet, so publishing one changed nothing, silently. `POST /v1/policies` now answers `400 kind-not-applied` for them, naming the kinds it does apply in `details.appliedKinds` (`model-routing`, `retention`, `tool-errors`, `hitl`). Policies of those kinds already stored stay readable, and the list still filters by them. `@kindgi/policy-contract` exports `APPLIED_POLICY_KINDS` and `isAppliedPolicyKind`; `@kindgi/api` re-exports `APPLIED_POLICY_KINDS`.
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

### Minor Changes

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

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
