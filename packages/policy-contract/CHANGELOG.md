# @kindgi/policy-contract

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
