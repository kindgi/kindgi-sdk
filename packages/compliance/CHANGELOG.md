# @kindgi/compliance

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
