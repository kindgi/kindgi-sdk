# @kindgi/client

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
- 0ed747d: The TypeScript client's docs no longer say `auth.refresh` is called when a token expires: nothing calls it yet. On an `auth` error with reason `token-expired`, get a new token and make the call again.
- 3d51f97: **Every 409 is a conflict, in the TypeScript and Python clients.** These 409s are now `ConflictError` in the TypeScript and Python clients; they were `ServerError`. The server still answers them with 409: the clients had misread them as server errors, because they didn't list their codes. A 409 is now read as a conflict, as a 404 is already read as a not-found:
  - TypeScript: `code: 'conflict'` (was `code: 'server'`), with `reason` the server's code;
  - Python: `ConflictError` (was `ServerError`).
  
  The 20 codes the API documents with 409 that move: `run-lease-lost`, `duplicate-node-id`, `duplicate-edge-id`, `agent-version-mismatch`, `waitpoint-error`, `reviewer-deactivated`, `approval-terminal`, `invalid-transition`, `signing-key-conflict`, `signing-key-revoked`, `proposal-terminal`, `block-already-registered`, `block-project-mismatch`, `run-not-finished`, `session-revoked`, `tenant-config-revision-conflict`, `secret-write-conflict`, `env-write-conflict`, `trigger-webhook-id-conflict`, `trigger-already-in-state`.
  
  **If you matched one of them by its class** (`err.code === 'server' && err.serverCode === 'run-lease-lost'`, `except ServerError`), match on its code alone: `err.serverCode` / `e.server_code`. Every error carries it, whatever its class.
  
  **Also changed:**
  - A TypeScript `ConflictError` now carries the server's details as `fields`, as a `ServerError` does. So `secrets.set`'s version conflict and `env.set`'s revision conflict still read `currentVersion` and `currentRevision`.
  - The TypeScript client reads an unlisted 413 as an invalid request, as the Python client does.
  - A 422 code a client doesn't list stays a server error (`budget-exceeded`, `output-schema-violation`).
  - The CLI's error line is unchanged: it already showed the code (`Error [run-lease-lost]: …`).
  
  A test in each client now checks every code in the API's `x-error-codes` against its HTTP status's family. A code the API adds can't go unclassified.
- f19bc64: **Upgrading: signing in to the console with an API token is now off by default, except in `kindgi dev`.** If people sign in to your console by pasting an API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you upgrade, or set up sign-in with your organization's identity provider. Otherwise the console's sign-in page offers no way in. API tokens keep working for the API, the CLI and the SDKs either way. `kindgi doctor` now warns when nobody can sign in to the console of the runtime it points at.
  
  - **`POST /v1/auth/token-sign-in`**: the API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly, the same as sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused 403 `token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. 403 `token-sign-in-off` when the deployment doesn't allow it. TypeScript `client.auth.tokenSignIn()`. Enabled by `SessionConfig.tokenSignIn`; audited as `signed-in` (method `api-token`).
  - **`POST /v1/auth/logout`** is mounted with browser sessions even without identity providers, so a console signed in with a token can sign out.
  - **`GET /v1/auth/sign-in-options`** gains `methods: { identityProviders, apiToken }` (optional: absent from older servers), and is mounted whenever there's a way in, with or without identity providers.
  - **`SessionCookieOptions.sameOrigin`**: also accept a cookie request whose `Origin` names the host it was sent to (`Host`, or `X-Forwarded-Host`), for a deployment that doesn't know its public URL. The console is served by the runtime itself, and a cross-site page can't forge `Origin`.
  - **`KINDGI_CONSOLE_TOKEN_SIGN_IN`** (`@kindgi/env-schema`): `on` or `off`; default `off`, and `on` in `kindgi dev`.
  - **`kindgi doctor`**: a "Console sign-in" check for the runtime the CLI points at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). It warns when token sign-in is off and no identity provider is set up, or none is registered, naming the setting that fixes it.
- b67c599: `kindgi dev` reads the runtime's and the pack service's log records and shows them pretty, each line tagged `[runtime]` or `[pack]`, coloured on a terminal unless `NO_COLOR` is set. The runtime container writes JSON for it.
  
  New flags:
  - `--log-level=<level>` (default `KINDGI_LOG_LEVEL`, from the shell then the env files, else `info`) and `--log=<subsystem>=<level>` (repeatable) set what's shown. The runtime, the pack service and the indexer get them as `KINDGI_LOG_LEVEL`/`KINDGI_LOG_LEVELS`, so they write only that.
  - `--log-format=json` writes each record as written, one per line on stdout, for `| jq`; everything else stays on stderr.
  - `--quiet` now quiets `kindgi dev`'s live output too: errors only.
  
  What pack code prints while it's indexed is shown at `debug` (subsystem `pack.index`) instead of being dropped. A runtime you run with `--runtime-url` gets the levels in `runtime.env`, and its own terminal picks the format.
  
  The pack-service supervisor's `log` event carries the line as written (`line`). Both pack services, TypeScript and Python, no longer warn about a `KINDGI_LOG_LEVELS` entry for a subsystem they don't know: pack code logs under its own names too.
- a211c34: **A guardrail whose config its pack check would refuse can be refused at registration.**
  - **The gap:** `POST /v1/guardrails` naming a pack's check with a config that breaks the check's `configSchema` was accepted. Then the pack service refused every call, so every turn the guardrail checked failed.
  - **`createApp({ checkGuardrailConfig })`:** a runtime passes this optional hook, and the route answers **`422 guardrail-config-invalid`**:
    - the message is one sentence naming the guardrail, the check and the first problem: `Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length": config.maxChars must be > 0.`;
    - `details.issues` lists every problem, `{ path, message }`, with `path` a JSON pointer into the guardrail (`/config/maxChars`) and `message` naming the setting (`config.maxChars must be > 0.`), the provider check's shape.
    - Without the hook, nothing changes.
  - **`Guardrail.configSchema`** is a new optional runtime-declaration field, like `codeArtifactRef`. `POST /v1/deployments` now keeps the pack index's `configSchema` on each guardrail it registers, so a runtime can check against it.
  - **`@kindgi/guardrails`:**
    - `guardrailConfigProblems({ configSchema, config })` checks the config as declared, without filling in defaults, as the indexer and the pack service do;
    - `describeGuardrailConfigProblems` words the message.
  - **Both clients** read `guardrail-config-invalid` as an invalid request, with its `issues`. The CLI prints the message and one line per issue.
- 37734c5: **A retry sent while the first request still runs no longer runs it again.**
  
  **The store:** an `IdempotencyStore` can now hold a key while its request runs, through `holds` (`hold`, `renew`, `release`). It's optional: a store without it behaves as before.
  
  **With holds, a retry under the same `Idempotency-Key` that arrives before the first request answers:**
  - gets `409 idempotency-key-in-flight` with `Retry-After: 5`, instead of running the operation again (for a run start, a second run). Retrying after it gets the first request's answer;
  - with another body, gets `idempotency-key-body-mismatch`, as for a stored answer.
  
  **How long a hold lasts:** 30 s (`holdMs`), renewed while the request runs, so a crashed request frees its key within 30 s. A refusal or a failure releases it, so a retry after fixing the cause runs again.
  
  **Also:**
  - the in-memory store holds keys, and now keeps the first stored answer, as the runtime's Postgres store does;
  - both clients map `idempotency-key-in-flight` to a conflict error;
  - the runtime's store holds keys from 0.1.5.
- 3fbb4ee: An Idempotency-Key is the caller's, and an answer that carries a secret isn't kept.
  - **Per caller:** the idempotency cache key is the tenant, the caller (`user:…`, `service_account:…`, else the session, else the credential itself, as `token:` and 16 hex of its sha256), the route and the key. Someone else in the tenant who sends the same key and body runs the request themselves, and never gets another caller's answer. Keys stored before are simply not found again; they expire within 24 hours.
  - **Secrets aren't kept:** a route whose answer carries a secret calls `withholdFromReplay(c)`. The middleware then keeps only that the request succeeded (status, when), never the answer. A retry with the same key and body gets `409 idempotency-key-replay-withheld`, with `status` and `at`, instead of the secret, and instead of running again, which would make a second one. The routes: `POST /v1/tokens`, `POST /v1/tokens/public`, `POST /v1/auth/callback/{providerId}`, `POST /v1/auth/refresh`, `POST /v1/auth/token-sign-in` (its session is in the cookie, which a stored answer never kept, so a repeat answered "signed in" with no session) and `POST /v1/webhook-endpoints/generate-secret`.
  - **Stores:** `StoredIdempotencyEntry` gains optional `withheld` and `storedAt`. A store that doesn't keep `withheld` replays an empty body, so a store should add it; the in-memory one does.
  - **Clients:** TypeScript and Python read the new code as a conflict.
  - **Docs:** `env.put`'s description says env values aren't secret (a credential goes in `/v1/secrets`).
- b67c599: Schedules can start improvement passes. `POST /v1/schedules` takes `improve: { agentId, scope }` instead of `flowId` or `agentId`, and `kindgi schedules create --improve=<agent-id>` with `--project` and `--segment`.
  - **When a pass starts:** each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent's runs in the scope since its last pass. With enough of them, across enough runs and judges, it starts a pass on a fresh test set of those runs. Otherwise the fire is `skipped`, and its `detail` says which count was short.
  - **Input:** `config.input` takes the pass options `improve` takes, plus `threshold` (default 5 judgments, 3 runs, 2 judges) and `monthlyCapUsd` (default 20). It's kept with the defaults applied.
  - **Permissions:** registering needs `publish` on the agent.
  - **Scope:** the schedule's project or a segment of it, not the tenant or an org: a pass's evidence must cover the scope it changes. Promote to the tenant by hand after review.
  - **Interval:** at most once an hour.
  - **Fires:** a fire that started a pass names it (`passId`). A pass a schedule started names the schedule and fire (`trigger`).
  - **Webhooks:** endpoints can subscribe to `improvement-pass.finished`, sent when any pass ends, with the pass. `projectId` narrows it; `flowIds` and `includeDryRuns` are about runs only. The Python `parse_event` reads it.
- e27d050: Improvement passes. `POST /v1/proposals/improve` starts one: the runtime looks for better values for an agent version's tunable settings on a test set, within a budget (default $5 and 30 candidates). It writes its best candidate as an improvement proposal, which waits for a reviewer when requested.
  - `GET /v1/improvement-passes` and `/{passId}` read passes back: their status, the candidates compared, the cost, and once one ends, its outcome (`proposed` with the proposal, or `nothing-found` with the hold-out numbers).
  - `POST /v1/improvement-passes/{passId}/cancel` stops a pass.
  - Without improvement passes in the runtime, these answer `501 improve-unsupported`.
  - The TypeScript client has `proposals.improve` and `improvementPasses.{list,get,cancel}`. The Python client has `proposals.improve` and `improvement_passes`.
  
  A settings block's schema marks the keys a pass may tune with `"x-kindgi-tunable": true`: a number or integer with a minimum below its maximum, or an enum. Any other mark is refused at publish, and `tunableKeys(schema)` lists the marked keys.
  
  Comparisons can run unpublished settings values (`overrides.settings`, checked against the blocks the version pins) and part of the test set (`sample: { part, seed, holdOutShare }`, a deterministic search/hold-out split). A promotion gate fails a comparison with overrides (`sameContents`) and one on the search part (`comparison.sample`). A proposal's evaluate takes `sample`.
  
  A replayed tool that reads from nowhere, re-run because the compared version pins other settings, is marked `recomputed: true` and doesn't count as divergence.
  
  A proposal that a drafter wrote (not a person) waits for a reviewer when requested, even where the scope's policy asks for no approval.
- b67c599: A record written with `inMessage` (the fields its message already states, like the request line's `method`, `route`, `status` and `durationMs`) names them in its JSON as `inMessage`, listing the ones the record has. A renderer may leave them out of a line. `formatPretty` does, so a record read back from JSON renders as it did at the source. A field an app itself calls `inMessage` is kept under `fields`, like one named after the fixed five. Python's `kindgi.log` does the same (`in_message=`).
- b67c599: Memory erasure: an erasure takes effect for agents at once. From the moment it starts until it completes, no memory read returns the facts it names (the person's, one fact, a conversation's), even before they're cleared, and starting a turn for that person (their conversation or their `participantId`) is refused with `409 erasure-in-progress`. A turn already running or waiting isn't refused: the erasure ends or waits for it. The TypeScript and Python clients read it as a conflict (reason `erasure-in-progress`), as they read `legal-hold`, so the CLI says `Error [erasure-in-progress]`.
- b67c599: Memory erasure: a person's unfinished runs settle before anything is cleared. An erasure has a new phase, `settle`, between `expand` and `erase`: the person's waiting turns are cancelled (reason `erased`, kept in the run's history) and it waits for one an executor holds, so nothing writes their words after a store was cleared. `MemoryErasure.settleRoundsCapped` says it went on to erase while runs kept appearing. The kernel's `RunExecutingError` (`run-executing`) is a cancel the caller asked to leave to a live executor. A replay of an erased run is refused by the runtime (`run-erased`); `EvalRunSubjectInvokeOutcome.erased` (optional) tells a comparison eval run to leave that case out and count it as `erased`, like a case erased before it was listed.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- 1633db1: Memory facts keep their id across revisions, and every read sees only what the caller may.
  
  - **The scope guard.** A memory read gets `readers` (`MemoryReaders`): the projects, orgs, user, end user (`participantId`, new on `MemoryScope`) and conversations it may see. A binding applies them inside its query, before any limit; `isReadableBy` is the rule. On `/v1/memory`, the route works out the readers from the caller: a tenant admin reads everything; anyone else reads tenant-wide facts, the projects and orgs they may read, their own user facts, and every end user's and conversation's facts in the projects they may write. Writes are checked against the scope (`403 permission-denied`). An agent turn's retrievals see the run's project and org, the user it acts for, its conversation and that conversation's end user, never another conversation's or another end user's; `same-project` in a run without a project selects nothing.
  - **Revisions.** `POST /v1/memory/facts/{factId}/supersede` writes the fact's next revision (same id, body `{ content, expectVersion?, … }`) and returns it; `DELETE /v1/memory/facts/{factId}` closes the current one; `POST …/verify` marks it verified; `GET …/revisions` lists them; `?version=` and `?asOf=` read the past. `409 fact-changed` (with `expectVersion`) and `409 legal-hold` refuse; a runtime without delete, verify or history answers `501 memory-operation-unsupported`.
  - **Facts** carry `revisionId`, `trust`, `verifiedBy`/`verifiedAt`, `attributedTo` (from the writer), `generatedBy`, `subjects`, `validFrom`/`validUntil`/`observedAt`, `invalidatedAt`/`invalidatedBy`/`invalidationReason` and `review`, all optional.
  - `AuthzCheckBinding.listObjects` (optional) lists the objects a principal may act on.
  - `POST /v1/runs` hands the run handler the caller (`InvokeAgentBindingInput.principal`, `InvokeFlowBindingInput.principal`), so a turn knows whom it acts for: their own user facts are among what it may read.
  - Clients: `memory.facts.supersede`, `.delete` (now `DELETE`, returning the closed revision), `.verify`, `.revisions`, and `version`/`asOf` on `read`/`list`. CLI: `kindgi memory facts supersede|delete|verify|revisions`, `--revision` and `--as-of` on `get`, `--as-of` on `list`.
- b67c599: Agents recall earlier conversations, and a conversation can be unregistered.
  
  - **Recall.** A retrieval intent with `source: 'conversations'` recalls messages of this agent's earlier conversations (a user's message or an agent's answer; tool calls are not indexed). It has no `types`, and its scopes are:
    - `same-user` (the usual choice): this end user's, or this user's, other conversations;
    - `same-conversation`: this conversation's messages older than the history window (`conversationPolicy.historyLimit`);
    - `same-segment`: conversations in the run's segment path (the same customer);
    - `same-project`: the project's conversations.
  
    `mode` works as for facts: absent (newest first), `keyword`, `semantic` (needs embeddings, else `semantic-unavailable`) or `both` (fused by rank).
  - **The people's own words, by default.** Recall returns users' messages only. `roles: ['user', 'agent']` adds the agent's earlier answers, which can carry its mistakes: they are quoted with `note: "earlier answer by the agent, not verified"`, and publishing warns `recall-agent-answers` (once per agent). Neighbouring messages follow the same roles.
  - **Other people's conversations.** `same-segment` and `same-project` recall them, in the run's own project only. Publishing such an agent warns `recall-other-people`, and in the prompt each of their messages is marked `anotherPerson`, without saying whose. Recall is always this agent's conversations, within what the run may recall (`isRecallReadableBy` in `@kindgi/memory`: a conversation is always someone's).
  - **The prompt.** Recalled messages are quoted in the `<memory>` block after the facts: the date, the message, and the messages either side. They are earlier conversation, never turns. The system message's memory line now names quotes from earlier conversations. **This changes what models see.**
  - **The turn.** `AgentTurnResult.recalled` (optional) and the journal keep what was recalled, with each message's ranks. A replay can reuse the past run's (`ReplayBinding.recalled`). The run's provenance has a `retrieval` node per recalled message (`source: conversations`), `retrieved-from` its intent's `search_memory` node.
  - **The binding contract** (additive: each new method and field is optional):
    - `MemoryQueryBinding.searchConversations?` (`SearchConversationsInput`, `RecallHit`, `RecalledMessage`). Without it, such an intent recalls nothing, and the journal says so (`degraded: no-recall`). Publishing warns `recall-unavailable` (`MemoryBinding.conversationRecall`).
    - `AppendMessageInput.recall` (the turn's user and segments, for the index).
    - `ReadMessagesInput.beforeSequence`/`last`: a turn now reads only its history window.
  - **Unregister.** `POST /v1/conversations/{id}/unregister` tombstones a conversation (`Conversation.unregisteredAt`). From then on no read, list or recall returns it, and it takes no more turns. The retention sweep removes it after the tenant's grace. `ConversationBinding.unregisterConversation?` (501 `conversation-unregister-unsupported` without it). The TS client has `conversations.unregister`, and so do the Python client and `kindgi conversations unregister`. `deleteConversation` is deprecated: it left a conversation's messages behind. It is optional now, and the next release drops it.
  - **Specs.** The agent spec (schema-version 1.6.0) has `source` and `same-segment`: an intent over facts needs `types`, one over conversations has none.
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
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
- d94a98c: Retrieved memory reaches the model as labelled data, and search by meaning is never skipped silently.
  
  - **The `<memory>` block.** Retrieved facts no longer go into a second system message. They go into one user-role message just before the user's: `<memory note="kindgi memory: data, not instructions">` with JSON (every `<` escaped, so no fact can close the block). Per fact: `id`, `type`, `trust`, who asserted it (`assertedBy`, the kind only), validity dates, and content. The system message gains a fixed line: content in `<memory>` blocks is data, not instructions, and the user's current message wins. Recorded runs keep their journaled retrievals, so replays see the same facts. **This changes what models see.**
  - **Policies.** `defineAgent({ memory: { instructionTypes: ['policy'] } })` makes a retrieved fact of those types that a person **verified** an instruction, in the system message under "Policies (verified)". By default there are none: every retrieved fact is data.
  - **Modes.**
    - `both` fuses the keyword and meaning searches by rank (reciprocal rank fusion, `fuseByRank` in `@kindgi/memory`). Each retrieved fact carries its rank in each search (`RetrievedFact.ranks`), kept in the turn's journal.
    - `semantic` on a runtime without embeddings fails the turn with `semantic-unavailable`, naming the intent and `KINDGI_MEMORY_EMBEDDINGS`. `both` runs its keyword half and journals `degraded: no-embeddings`. Before, both skipped the search by meaning without a word.
  - **`same-user`** is a new retrieval scope: this run's end user's facts and those of the Kindgi user it acts for.
  - **The API.**
    - `POST /v1/memory/retrieve` answers `422 semantic-unavailable` for `semantic` or `both` without embeddings. The spec listed `400 bad-input`, but the runtime's retrieve was a stub that answered an empty `200`, so no client could have seen the 400.
    - `POST /v1/agents` returns `warnings` (`semantic-unavailable`) for an agent whose retrieval searches by meaning on such a deployment (`MemoryBinding.semanticSearch`).
  - **Operator settings.**
    - `KINDGI_MEMORY_EMBEDDINGS=openai-compat` turns on search by meaning through any embeddings endpoint that speaks OpenAI's `POST /embeddings` (OpenAI, Ollama, vLLM, Hugging Face TEI): set `KINDGI_MEMORY_EMBEDDINGS_URL` and `KINDGI_MEMORY_EMBEDDINGS_MODEL`, plus `KINDGI_MEMORY_EMBEDDINGS_API_KEY` from your secret store if the endpoint takes a key.
    - `local:<model>` runs the model inside a server run from source on macOS or glibc Linux, not in the runtime image.
    - An endpoint that doesn't answer doesn't stop the runtime, at boot or later. It is retried in the background, and search by meaning waits for it.
    - `@kindgi/embedding` adds `EmbeddingUnavailableError` (`embedding-unavailable`). A semantic search returning it is treated exactly like having no embeddings: `semantic` fails the turn with `semantic-unavailable`, and `both` runs its keyword half and journals it.
    - `@kindgi/adapter-model-openai-compat` adds `createOpenAICompatEmbeddingProvider`. Its `probe()` embeds once, to learn the dimensions.
  - **Specs and SDKs.**
    - The agent spec (schema-version 1.4.0) and pack index carry `memory` and the `same-user` scope; both indexers, TS and Python (`Agent(memory=...)`), keep them.
    - CLI: `kindgi memory facts retrieve --query=<json>` is wired.
- 704dd29: Who can read the tenant's people, and how a project admin adds one.
  - **The people list is for tenant admins:** `GET /v1/identity/users` answers anyone else `403 permission-denied`. Reading a person's record (`GET /v1/identity/users/{userId}`) or sessions (`…/sessions`) needs a tenant admin, or that person.
  - **Add a project member by email or id:** `POST /v1/projects/{projectId}/memberships` takes exactly one of `userId` and `email`. The runtime looks the person up among the tenant's people: someone who isn't one, or was removed, is `404 identity-user-not-found`, and nothing is added. The answer has their `userId`. A directory names the email lookup with the optional `IdentityDirectoryBinding.findUserByEmail`; without it, an email is `400` and an id still works.
  - **`GET /v1/projects/default`** needs read on the Default project, as `GET /v1/projects/{projectId}` does: someone with a role on another project only gets `403`.
  - **A member API key administers below the tenant:** it's refused `admin` on the tenant only, as the API keys design has it, so a project admin's member key adds and changes that project's members. Before, it was refused every `admin` action, and a project admin who isn't a tenant admin can't hold an `admin` key.
  - **Clients:** TypeScript `projects.memberships.add(projectId, { email, role })`; the Python client is regenerated.
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
- b67c599: Improvement passes can draft prompt templates. `POST /v1/proposals/improve` takes `tiers: ['prompt']` with `model` (the tenant's provider and model that drafts the templates) and `candidates` (1–5, default 3). The agent version must take its instructions from a prompt block it pins.
  - Every pass takes `classWeights`, default `restricted-only`: a pass learns from trusted judgments only.
  - `checkDraftedTemplate` (`@kindgi/agents`) checks a drafted template against what the agent has. It must parse as Liquid and may read only the declared parameters, the current template's variables, the turn's clock and identity, and the settings blocks the version pins. It may not name a dotted id the agent doesn't use, and it may be at most twice as long as the current template (at least 2,000 characters).
  - Comparisons take `overrides.prompts`: a template for a prompt block the version pins, checked at start. The summary's candidate names the overridden prompt blocks, and a promotion gate fails such a comparison (`sameContents`).
  - The replay binding's `settings` is now `overrides` (`settings` and `prompts`).
  - A judged test set's reasons name their judgment's class (`judgeClassId`) and say whether it was recorded while the class was restricted (`restricted: true`).
  - A pass's `comparisons` show a refused template's issues (`refused: [{path, message}]`) and each drafted template's `hypothesis`. A proposal a pass drafted names the pass (`drafter.passId`).
- eff6249: Improvement proposals change data blocks. A proposal is new settings values or a new prompt template for one block an agent version pins, for one live scope:
  - `POST /v1/proposals` drafts one. The content is checked as publishing that block version would be, and refused when it equals the pinned content. The same change from the same version for the same scope is one proposal.
  - `POST /v1/proposals/{id}/evaluate` publishes the block version, derives the agent version (`derivedFrom.proposalId`) and compares it on a test set. Neither serves any scope until promoted. Without a live version of the agent for the whole tenant, it answers `409 proposal-needs-pin`. Under `kindgi dev`, where the agent registry takes no writes, it answers `409 registry-read-only`.
  - `POST /v1/proposals/{id}/request` promotes the candidate for the scope through its gate, as `POST /v1/agents/{agentId}/promotions` does. It's allowed whether or not the candidate measured better: the gate decides.
  - `POST /v1/proposals/{id}/rollback` puts the scope back.
  - `POST /v1/proposals/{id}/withdraw` closes the proposal.
  - `GET /v1/proposals` filters by agent, tier, status, and the live scope a proposal is for (`scopeKind`, `scopeId`, `segment`).
  - `status` is derived from the comparison and the promotion: `draft`, `evaluating`, `evaluated`, `not-better`, `evaluation-failed`, `in-review`, `promoted`, `refused`, `rejected`, `expired`, `superseded`, `rolled-back` or `withdrawn`.
  - Proposals are authorized on their agent: `read` to see one; `publish` to draft, evaluate or withdraw; `promote` to request or roll back. `X-Supervisor-Id` is no longer needed.
  
  The instruction-string tiers (`prompt`, `retrieval`, `tool-config`) and the `dry-run`, `submit-review` and `apply` routes are gone.
  
  The TypeScript client has `client.proposals` (`list`, `get`, `create`, `evaluate`, `request`, `rollback`, `withdraw`). Every `client.supervisor.proposals` method now throws `not-yet-wired`, naming its replacement, until 0.2. The Python client's `proposals` resource has the new calls. `draft`, `dry_run`, `submit_review` and `apply` raise `InvalidRequestError`, naming their replacement.
  
  `SupervisorBinding` stores proposals (`listProposals`, `getProposal`, `createProposal`, and `recordProposal`, a compare-and-set on `revision`). The API package runs the lifecycle from the agent, block, eval-run and promotion bindings.
- 0fe157e: A provider registration the runtime couldn't build is refused when it registers, naming the setting. Before, a bad `adapter_config` (an unknown `api`, a missing `baseURL`, a Vertex registration without `project`, …) registered fine, and the provider was skipped at the first model call with the reason only in the runtime's log.
  - **`POST /v1/providers`** runs the adapter's own check before storing: `422 provider-config-invalid`, with each problem in `details.issues` (`path`, a JSON pointer such as `/adapter_config/api`, and `message`), the shape other validation errors use; the clients read it as an invalid-request error. Without the runtime's adapter factories (an older runtime), nothing changes.
  - **`GET /v1/providers/{providerId}/check`** runs the same check over a registered provider (`{ providerId, adapterId, checked, issues }`); TS `providers.check(id)`, Python `providers.check(provider_id)`.
  - **Adapters:** `AdapterFactoryEntry.checkConfig` (static: no network, no secret read): `{ path, message }` problems, the message naming the setting and what it takes; the factory throws the same problems as `adapterConfigError` words them (`<adapter>: provider "<id>": <message>`). The 422's own message is one sentence naming the provider, its adapter and the first problem, with a count of the rest. Each adapter exports its entry: `openAICompatAdapterEntry`, `geminiAdapterEntry`, `anthropicAdapterEntry` (new `anthropicAdapterFactory`: needs `secret_ref`) and `inProcessAdapterEntry` (new `inProcessAdapterFactory`).
- 7d7d344: **Security (Python):** a tool's context never shows its secrets: `ToolContext.secrets` is left out of the context's `repr`, so printing or logging a context (`print(ctx)`, `f"{ctx}"`) no longer includes the secrets' values. `ctx.secrets` still reads them.
- 7d7d344: Python: `kindgi.log`, the same log records as `@kindgi/log`, with no new dependency. `get_logger("billing", tenantId=…)` gives a logger (`log.info("charged", {"amountCents": 1200})`, `log.child(runId=…)`, `err=exc`) at the levels and format of `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` (`configure()`; a `TRACE` level), redacting secret-looking keys and known secret shapes. `JsonFormatter` and `PrettyFormatter` put an app's own `logging` records in the same schema. The shared vectors check that Python and TypeScript write the same records.
  
  The Python pack service writes these records on stderr (subsystem `pack`), as the TypeScript one does: one per call, with the call's ids and the caller's `traceId`, and the lifecycle whatever the levels (each keeps `kind` for older supervisors). `ToolContext.log` is a logger bound to the call (`ctx.log.info("looked up order", order_id=…)`, subsystem `pack.tool`); in a test it writes nothing unless you pass one.
- 8dd0a55: **The Python client follows a run to its end: `runs.follow(run_id)` and `runs.follow_progress(run_id)`, sync and async.**
  - **Why:** the server ends a run's stream after its terminal event or after 5 minutes. `runs.stream` ended there too, so a run that took longer, waiting for an approval say, stopped streaming early unless the caller reconnected.
  - **What they do:**
    - reconnect with `Last-Event-Id` until `run.completed`, `run.failed` or `run.cancelled`, each event once;
    - pause 0.5 s before reconnecting after a connection that brought nothing;
    - retry a dropped connection, a 429 or a 502–504 with backoff (0.5 s up to 30 s, 10 attempts in a row);
    - raise any other error, such as a 404;
    - end after the terminal event, even if the server keeps the connection open.
  - **The pair** matches TypeScript's `runs.stream` and `runs.streamProgress` and the Java client's `runs().follow` and `runs().followProgress`.
  - **`runs.stream`** stays the plain call.
- 70c5737: Remove a person from a tenant: `POST /v1/identity/users/{userId}/unregister`, mounted when the identity directory can (`IdentityDirectoryBinding.unregisterUser`, optional). Tenant admins only.
  - **What it does, in one step:** every API key and session of theirs is revoked, and every grant and membership taken away, before it answers. Their keys get `401` at once.
  - **Their record stays,** with `unregisteredAt`, so their history still says who they were. Their email is free again: adding it makes a new person.
  - **Idempotent:** removing someone already removed changes nothing.
  - **Refused** for yourself and the seed user (`identity-user-unregister-refused`), and for the only tenant admin (`last-tenant-admin`).
  - **The list** (`GET /v1/identity/users`) leaves removed people out unless `includeUnregistered=true`.
  - **Clients:** TypeScript `client.users.unregister(id)` and `users.list({ includeUnregistered })`; the Python client is regenerated.
  - **CLI:** `kindgi people remove <user-id>` and `kindgi people list --include-removed`.
- a1f3dd1: A failed run says why, as data: `failure: {code, message, cause?}` on the run (`GET /v1/runs/{id}`, lists, the start answer). An agent turn's failure carries its own code (`budget-exceeded`, `capability-routing-failed`, `model-invocation-failed`, …) and, when it says, what it came from (`cause`: for `capability-routing-failed`, the router's reasons by provider). Any other failure is `run-failed`, with the run's failure message. Only a `failed` run has one. `failureMessage` is unchanged; read `failure` instead.
  
  - The TypeScript client's `Run` has `failure` (`RunFailure`), the Python models `RunFailure`.
  - `@kindgi/api` exports `runFailure(row)`, the decoder the routes use.
  - `kindgi runs start` prints a failed run's line from `failure` (`Error [<code>]: <message>`), and decodes `failureMessage` itself only for a runtime from before it.
- d25c1b3: A run can be started at most once per idempotency key, and a run records the trigger that started it. Both are additive contracts, which a runtime implements.
  
  - **`idempotencyKey`** on `RunFlowInput`, `StartRunParams`, the run handler's `invokeFlow` / `invokeAgent` inputs and `InvokeAgentInput`. A start with a key that a run of the tenant already has starts nothing and answers that run. `startRun` and the run handler say so with `existing: true`. A trigger's fire uses `fire:<fireId>`, so a re-driven fire never runs twice.
  - **`trigger`** (`RunTriggerRef`: `triggerId`, `kind` `schedule` | `event` | `webhook`, `fireId`, `scheduledFor?`) on a run started by a trigger: on `KernelRunRecord`, and on the wire as `Run.trigger` (OpenAPI `RunTrigger`).
  - **`GET /v1/runs?triggerId=`** lists the runs a trigger started: `runs.list({ triggerId })` in TypeScript, `triggerId` on `ListRunsInput`, and `kindgi runs list --trigger=<id>`.
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
- 94c999f: **A provider or MCP endpoint registration can opt in to receive the run's `traceparent`.** It's off by default: nothing about a run's trace leaves the deployment unless a registration turns it on.
  - **Providers:** `send_traceparent: true` on `POST /v1/providers`. A runtime then sends each model call's `traceparent` to the provider as a request header: ids only, never content.
    - Any other value is refused with `422 provider-config-invalid` at `details.issues` `/send_traceparent`, listed before the adapter's own issues.
    - `ProviderRegisterInput` and `ProviderRuntimeEntry` gain `sendTraceparent`.
  - **MCP endpoints:** `sendTraceparent: true` on `POST /v1/mcp/endpoints`, for HTTP transports, and reads return it.
    - A non-boolean, or `true` on a `stdio` endpoint, is refused with `400 invalid-mcp-endpoint`, reason `invalid-send-traceparent`.
  - **The runtime enforces it,** not the adapters. An older runtime ignores the field and sends nothing.
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
- cbb6785: Setting up sign-in with an identity provider the way it happens in practice: the identity provider's side first, then Kindgi's.
  
  - **`GET /v1/auth/providers/{providerId}/sign-in?kind=oidc|saml`**: what to give the identity provider (the redirect URI, or SAML's ACS URL, entity ID and metadata URL) **before** anything is registered. The URLs stay the same after registering, after any update, and after an unregister and a new registration under the same id. They aren't secrets: every sign-in's browser redirects carry them. TypeScript `client.auth.providers.signIn(providerId, { kind })`. Backed by the optional `IdentityProviderBinding.signInUrls`.
  - **`PATCH /v1/auth/providers/{providerId}`**: change a provider in place (a field given replaces the stored one, `null` removes an optional one). It's checked as a registration is, and keeps its sign-in URLs, so nothing changes on the identity provider's side. `providerId` and `kind` can't change; a new `issuer` drops the endpoints discovered from the old one. TypeScript `client.auth.providers.update(providerId, changes)`. Backed by the optional `IdentityProviderBinding.update`.
  - **`GET /v1/auth/providers/{providerId}`**: one provider. TypeScript `client.auth.providers.get(providerId)`.
  - **`kindgi sso providers`**: `start` prints the URLs and a message for whoever runs the identity provider (`--idp=google|entra|okta|keycloak` adds its click-by-click steps); `finish` registers what came back; then `update`, `get`, `list`, `test` (the link to try signing in) and `remove`.
- 66bab49: Sign-in contract for identity providers and browser sessions.
  
  - **Identity providers, one shape per `kind`.** `ProviderConfig` is a union: `oidc` (an OpenID Connect identity provider: `issuer` + `clientId` + `clientSecretRef`, endpoints from discovery), `saml` (IdP metadata XML, or entity ID + SSO URL + certificates; `spSigningKeyRef` / `spDecryptionKeyRef` by reference), and `oauth2` (a plain OAuth 2.0 provider that isn't OpenID Connect, e.g. GitHub: the old shape). All kinds gain `displayName`, `domains`, `join` and `signIn`. A `clientSecret` or raw key in the body is refused (400 `invalid-provider-config`), and the deployment may refuse a configuration it can't use (422 `identity-provider-invalid`). **TypeScript: narrow on `kind` before reading kind-specific fields** (`config.tokenEndpoint` needs `config.kind === 'oauth2'`, or `'oidc'` with endpoints).
  - **`GET /v1/auth/sign-in-options?email=`** (unauthenticated): the providers for the email's domain, each with a `signInUrl`. Sign-in is email first: with no email the list is empty, and the binding isn't asked. The same answer for anyone at a domain; rate-limited per client (429 `rate-limit-exceeded`). TypeScript `client.auth.signInOptions({ email })`. Backed by the optional `IdentityProviderBinding.signInOptions`.
  - **Browser sessions in a cookie** (`SessionConfig.cookie`): the session token is read from `__Host-kindgi_session` when there's no `Authorization` header; a cookie-authenticated unsafe request needs an allowed `Origin` (403 `csrf-origin-mismatch`, a missing `Origin` too). Logout clears the cookie; refresh of a cookie session is refused (400 `cookie-session-not-refreshable`).
  - **The provider catalog, refresh and logout mount without `exchangeCode`**; only this API's own OAuth flow (`/v1/auth/login` + callback) needs it.
  - **For `SessionStoreBinding` implementers:** `SessionCreateInput.accessToken` and `Session.accessToken` are optional (a deployment may keep no identity-provider tokens). Copy them conditionally.
  - **Runtime settings for sign-in** (`@kindgi/env-schema`): `KINDGI_AUTH_SECRET_PATH` / `KINDGI_AUTH_SECRET` (turn sign-in with identity providers on; need `KINDGI_PUBLIC_URL`), `KINDGI_AUTH_PRIVATE_IDP_ORIGINS` (private-network identity providers the operator allows), `KINDGI_SESSION_TTL_MS` (default 12 hours) and `KINDGI_SESSION_IDLE_TIMEOUT_MS` (default 60 minutes).
- b67c599: A test set can be narrowed to a segment. `POST /v1/eval-suites/{suiteId}/versions/from-judgments` takes `segments`, and `kindgi eval-suites from-judgments` takes a repeatable `--segment=key:value`. With it, the test set keeps only runs started in that segment path or below it, and its spec records the path.
  - A judgment's copy of its run keeps the segment path the run was started with (`run.segments`; empty when there was none).
  - A run judged before this change has no recorded segment, so it's left out of a narrowed test set.
- d7c0173: **`runs.follow(runId)` and `runs.followProgress(runId)`: the TypeScript client follows a run to its end under the same names as Python and Java.**
  - **What they do:** reconnect with `Last-Event-Id` after a drop or the server's 5-minute limit, through to `run.completed`, `run.failed` or `run.cancelled`. This is what `runs.stream` and `runs.streamProgress` do today.
  - **`runs.stream` and `runs.streamProgress` are deprecated.** Use `runs.follow`, which does the same. In a later minor release, announced in advance, `runs.stream` becomes the plain call, as in Python and Java: it ends when the server closes the stream. Until then it still follows the run to its end.
  - **The CLI's `kindgi runs stream`, the README and the guides** use `follow`.
- e88c3cc: **Audit bundles made with `@kindgi/api` 0.1.4 verify.** The 0.1.4 runtime didn't sign exports, but an app that embedded `@kindgi/api` 0.1.4 with its own key could export audit bundles. That version stamped an audit bundle's envelope `exportedAt` separately from the signed one, so about 1 in 10 came out a millisecond apart, and the new verifiers refused them. For that format only (the envelope's `bundleSchemaVersion` is the integer `1`, over a signed `bundleVersion: 1`), `verifySignedExport`, the Python SDK's `verify_signed_export` and `kindgi exports verify` no longer compare the envelope's unsigned `exportedAt`. They report the signed time in a new `notes` field: `made by Kindgi 0.1.4, which stamped the envelope's exportedAt separately: the signed export time is … (the envelope says …)`. Every later bundle keeps the strict check. Real 0.1.4 exports are a shared test vector in `@kindgi/specs` (`test-vectors/signed-export/kindgi-0.1.4.json`).
- 423aeea: A console signed in with a cookie session knows who is a tenant admin again.
  - **`GET /v1/identity/whoami`** answers `tenantAdmin`: whether the caller is a tenant admin, decided as the admin routes decide it. That's `admin` on the tenant when the runtime authorizes; otherwise the `tenant-admin` scope of a full key, never a `member` key or one limited to a project. A console shows its admin pages by it. The field is optional: from older servers it's absent, so read `scopes`.
  - **A session opened with an API token (`POST /v1/auth/token-sign-in`) carries the key's scopes**, so it acts as the key did. Before, it had none, so with authorization off (`kindgi dev`, or a deployment without OpenFGA), even the deployment's own token lost admin once it signed in to the console. The session can't do more than the key: member and project keys still can't sign in, a key's scopes never change, revoking the key ends its sessions, and with authorization on the authorizer decides. Sessions from an identity provider are unchanged.

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
- 0ed747d: The TypeScript client's docs no longer say `auth.refresh` is called when a token expires: nothing calls it yet. On an `auth` error with reason `token-expired`, get a new token and make the call again.
- 3d51f97: **Every 409 is a conflict, in the TypeScript and Python clients.** These 409s are now `ConflictError` in the TypeScript and Python clients; they were `ServerError`. The server still answers them with 409: the clients had misread them as server errors, because they didn't list their codes. A 409 is now read as a conflict, as a 404 is already read as a not-found:
  - TypeScript: `code: 'conflict'` (was `code: 'server'`), with `reason` the server's code;
  - Python: `ConflictError` (was `ServerError`).
  
  The 20 codes the API documents with 409 that move: `run-lease-lost`, `duplicate-node-id`, `duplicate-edge-id`, `agent-version-mismatch`, `waitpoint-error`, `reviewer-deactivated`, `approval-terminal`, `invalid-transition`, `signing-key-conflict`, `signing-key-revoked`, `proposal-terminal`, `block-already-registered`, `block-project-mismatch`, `run-not-finished`, `session-revoked`, `tenant-config-revision-conflict`, `secret-write-conflict`, `env-write-conflict`, `trigger-webhook-id-conflict`, `trigger-already-in-state`.
  
  **If you matched one of them by its class** (`err.code === 'server' && err.serverCode === 'run-lease-lost'`, `except ServerError`), match on its code alone: `err.serverCode` / `e.server_code`. Every error carries it, whatever its class.
  
  **Also changed:**
  - A TypeScript `ConflictError` now carries the server's details as `fields`, as a `ServerError` does. So `secrets.set`'s version conflict and `env.set`'s revision conflict still read `currentVersion` and `currentRevision`.
  - The TypeScript client reads an unlisted 413 as an invalid request, as the Python client does.
  - A 422 code a client doesn't list stays a server error (`budget-exceeded`, `output-schema-violation`).
  - The CLI's error line is unchanged: it already showed the code (`Error [run-lease-lost]: …`).
  
  A test in each client now checks every code in the API's `x-error-codes` against its HTTP status's family. A code the API adds can't go unclassified.
- f19bc64: **Upgrading: signing in to the console with an API token is now off by default, except in `kindgi dev`.** If people sign in to your console by pasting an API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you upgrade, or set up sign-in with your organization's identity provider. Otherwise the console's sign-in page offers no way in. API tokens keep working for the API, the CLI and the SDKs either way. `kindgi doctor` now warns when nobody can sign in to the console of the runtime it points at.
  
  - **`POST /v1/auth/token-sign-in`**: the API token in `Authorization` is exchanged once for a browser session in the session cookie (HttpOnly, the same as sign-in with an identity provider), so the browser never keeps the token. Only a person's full key opens a session: a service account's key, or a narrowed one (a `member` role, or one project), is refused 403 `token-sign-in-not-allowed`. The session ends after its lifetime, or when the key expires if sooner. 403 `token-sign-in-off` when the deployment doesn't allow it. TypeScript `client.auth.tokenSignIn()`. Enabled by `SessionConfig.tokenSignIn`; audited as `signed-in` (method `api-token`).
  - **`POST /v1/auth/logout`** is mounted with browser sessions even without identity providers, so a console signed in with a token can sign out.
  - **`GET /v1/auth/sign-in-options`** gains `methods: { identityProviders, apiToken }` (optional: absent from older servers), and is mounted whenever there's a way in, with or without identity providers.
  - **`SessionCookieOptions.sameOrigin`**: also accept a cookie request whose `Origin` names the host it was sent to (`Host`, or `X-Forwarded-Host`), for a deployment that doesn't know its public URL. The console is served by the runtime itself, and a cross-site page can't forge `Origin`.
  - **`KINDGI_CONSOLE_TOKEN_SIGN_IN`** (`@kindgi/env-schema`): `on` or `off`; default `off`, and `on` in `kindgi dev`.
  - **`kindgi doctor`**: a "Console sign-in" check for the runtime the CLI points at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). It warns when token sign-in is off and no identity provider is set up, or none is registered, naming the setting that fixes it.
- b67c599: `kindgi dev` reads the runtime's and the pack service's log records and shows them pretty, each line tagged `[runtime]` or `[pack]`, coloured on a terminal unless `NO_COLOR` is set. The runtime container writes JSON for it.
  
  New flags:
  - `--log-level=<level>` (default `KINDGI_LOG_LEVEL`, from the shell then the env files, else `info`) and `--log=<subsystem>=<level>` (repeatable) set what's shown. The runtime, the pack service and the indexer get them as `KINDGI_LOG_LEVEL`/`KINDGI_LOG_LEVELS`, so they write only that.
  - `--log-format=json` writes each record as written, one per line on stdout, for `| jq`; everything else stays on stderr.
  - `--quiet` now quiets `kindgi dev`'s live output too: errors only.
  
  What pack code prints while it's indexed is shown at `debug` (subsystem `pack.index`) instead of being dropped. A runtime you run with `--runtime-url` gets the levels in `runtime.env`, and its own terminal picks the format.
  
  The pack-service supervisor's `log` event carries the line as written (`line`). Both pack services, TypeScript and Python, no longer warn about a `KINDGI_LOG_LEVELS` entry for a subsystem they don't know: pack code logs under its own names too.
- a211c34: **A guardrail whose config its pack check would refuse can be refused at registration.**
  - **The gap:** `POST /v1/guardrails` naming a pack's check with a config that breaks the check's `configSchema` was accepted. Then the pack service refused every call, so every turn the guardrail checked failed.
  - **`createApp({ checkGuardrailConfig })`:** a runtime passes this optional hook, and the route answers **`422 guardrail-config-invalid`**:
    - the message is one sentence naming the guardrail, the check and the first problem: `Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length": config.maxChars must be > 0.`;
    - `details.issues` lists every problem, `{ path, message }`, with `path` a JSON pointer into the guardrail (`/config/maxChars`) and `message` naming the setting (`config.maxChars must be > 0.`), the provider check's shape.
    - Without the hook, nothing changes.
  - **`Guardrail.configSchema`** is a new optional runtime-declaration field, like `codeArtifactRef`. `POST /v1/deployments` now keeps the pack index's `configSchema` on each guardrail it registers, so a runtime can check against it.
  - **`@kindgi/guardrails`:**
    - `guardrailConfigProblems({ configSchema, config })` checks the config as declared, without filling in defaults, as the indexer and the pack service do;
    - `describeGuardrailConfigProblems` words the message.
  - **Both clients** read `guardrail-config-invalid` as an invalid request, with its `issues`. The CLI prints the message and one line per issue.
- 37734c5: **A retry sent while the first request still runs no longer runs it again.**
  
  **The store:** an `IdempotencyStore` can now hold a key while its request runs, through `holds` (`hold`, `renew`, `release`). It's optional: a store without it behaves as before.
  
  **With holds, a retry under the same `Idempotency-Key` that arrives before the first request answers:**
  - gets `409 idempotency-key-in-flight` with `Retry-After: 5`, instead of running the operation again (for a run start, a second run). Retrying after it gets the first request's answer;
  - with another body, gets `idempotency-key-body-mismatch`, as for a stored answer.
  
  **How long a hold lasts:** 30 s (`holdMs`), renewed while the request runs, so a crashed request frees its key within 30 s. A refusal or a failure releases it, so a retry after fixing the cause runs again.
  
  **Also:**
  - the in-memory store holds keys, and now keeps the first stored answer, as the runtime's Postgres store does;
  - both clients map `idempotency-key-in-flight` to a conflict error;
  - the runtime's store holds keys from 0.1.5.
- 3fbb4ee: An Idempotency-Key is the caller's, and an answer that carries a secret isn't kept.
  - **Per caller:** the idempotency cache key is the tenant, the caller (`user:…`, `service_account:…`, else the session, else the credential itself, as `token:` and 16 hex of its sha256), the route and the key. Someone else in the tenant who sends the same key and body runs the request themselves, and never gets another caller's answer. Keys stored before are simply not found again; they expire within 24 hours.
  - **Secrets aren't kept:** a route whose answer carries a secret calls `withholdFromReplay(c)`. The middleware then keeps only that the request succeeded (status, when), never the answer. A retry with the same key and body gets `409 idempotency-key-replay-withheld`, with `status` and `at`, instead of the secret, and instead of running again, which would make a second one. The routes: `POST /v1/tokens`, `POST /v1/tokens/public`, `POST /v1/auth/callback/{providerId}`, `POST /v1/auth/refresh`, `POST /v1/auth/token-sign-in` (its session is in the cookie, which a stored answer never kept, so a repeat answered "signed in" with no session) and `POST /v1/webhook-endpoints/generate-secret`.
  - **Stores:** `StoredIdempotencyEntry` gains optional `withheld` and `storedAt`. A store that doesn't keep `withheld` replays an empty body, so a store should add it; the in-memory one does.
  - **Clients:** TypeScript and Python read the new code as a conflict.
  - **Docs:** `env.put`'s description says env values aren't secret (a credential goes in `/v1/secrets`).
- b67c599: Schedules can start improvement passes. `POST /v1/schedules` takes `improve: { agentId, scope }` instead of `flowId` or `agentId`, and `kindgi schedules create --improve=<agent-id>` with `--project` and `--segment`.
  - **When a pass starts:** each fire counts the trusted "no" judgments (recorded under a restricted judge class) on the agent's runs in the scope since its last pass. With enough of them, across enough runs and judges, it starts a pass on a fresh test set of those runs. Otherwise the fire is `skipped`, and its `detail` says which count was short.
  - **Input:** `config.input` takes the pass options `improve` takes, plus `threshold` (default 5 judgments, 3 runs, 2 judges) and `monthlyCapUsd` (default 20). It's kept with the defaults applied.
  - **Permissions:** registering needs `publish` on the agent.
  - **Scope:** the schedule's project or a segment of it, not the tenant or an org: a pass's evidence must cover the scope it changes. Promote to the tenant by hand after review.
  - **Interval:** at most once an hour.
  - **Fires:** a fire that started a pass names it (`passId`). A pass a schedule started names the schedule and fire (`trigger`).
  - **Webhooks:** endpoints can subscribe to `improvement-pass.finished`, sent when any pass ends, with the pass. `projectId` narrows it; `flowIds` and `includeDryRuns` are about runs only. The Python `parse_event` reads it.
- e27d050: Improvement passes. `POST /v1/proposals/improve` starts one: the runtime looks for better values for an agent version's tunable settings on a test set, within a budget (default $5 and 30 candidates). It writes its best candidate as an improvement proposal, which waits for a reviewer when requested.
  - `GET /v1/improvement-passes` and `/{passId}` read passes back: their status, the candidates compared, the cost, and once one ends, its outcome (`proposed` with the proposal, or `nothing-found` with the hold-out numbers).
  - `POST /v1/improvement-passes/{passId}/cancel` stops a pass.
  - Without improvement passes in the runtime, these answer `501 improve-unsupported`.
  - The TypeScript client has `proposals.improve` and `improvementPasses.{list,get,cancel}`. The Python client has `proposals.improve` and `improvement_passes`.
  
  A settings block's schema marks the keys a pass may tune with `"x-kindgi-tunable": true`: a number or integer with a minimum below its maximum, or an enum. Any other mark is refused at publish, and `tunableKeys(schema)` lists the marked keys.
  
  Comparisons can run unpublished settings values (`overrides.settings`, checked against the blocks the version pins) and part of the test set (`sample: { part, seed, holdOutShare }`, a deterministic search/hold-out split). A promotion gate fails a comparison with overrides (`sameContents`) and one on the search part (`comparison.sample`). A proposal's evaluate takes `sample`.
  
  A replayed tool that reads from nowhere, re-run because the compared version pins other settings, is marked `recomputed: true` and doesn't count as divergence.
  
  A proposal that a drafter wrote (not a person) waits for a reviewer when requested, even where the scope's policy asks for no approval.
- b67c599: A record written with `inMessage` (the fields its message already states, like the request line's `method`, `route`, `status` and `durationMs`) names them in its JSON as `inMessage`, listing the ones the record has. A renderer may leave them out of a line. `formatPretty` does, so a record read back from JSON renders as it did at the source. A field an app itself calls `inMessage` is kept under `fields`, like one named after the fixed five. Python's `kindgi.log` does the same (`in_message=`).
- b67c599: Memory erasure: an erasure takes effect for agents at once. From the moment it starts until it completes, no memory read returns the facts it names (the person's, one fact, a conversation's), even before they're cleared, and starting a turn for that person (their conversation or their `participantId`) is refused with `409 erasure-in-progress`. A turn already running or waiting isn't refused: the erasure ends or waits for it. The TypeScript and Python clients read it as a conflict (reason `erasure-in-progress`), as they read `legal-hold`, so the CLI says `Error [erasure-in-progress]`.
- b67c599: Memory erasure: a person's unfinished runs settle before anything is cleared. An erasure has a new phase, `settle`, between `expand` and `erase`: the person's waiting turns are cancelled (reason `erased`, kept in the run's history) and it waits for one an executor holds, so nothing writes their words after a store was cleared. `MemoryErasure.settleRoundsCapped` says it went on to erase while runs kept appearing. The kernel's `RunExecutingError` (`run-executing`) is a cancel the caller asked to leave to a live executor. A replay of an erased run is refused by the runtime (`run-erased`); `EvalRunSubjectInvokeOutcome.erased` (optional) tells a comparison eval run to leave that case out and count it as `erased`, like a case erased before it was listed.
- b67c599: Erasing a person's words: `/v1/memory/erasures` (create, get, list, export, replay), for a tenant admin only. Erasing a Kindgi user (`subject.kind: user`) isn't offered: `400`. An erasure clears, in the background, a person's (an app's end user, `participant`, or an `external` subject facts name; or one fact's, or one conversation's) facts, conversations, the runs that served them and what those left in provenance; facts written from them go to review. A completed erasure keeps no identifier, only a keyed hash in the ledger, which you export off-box (`kindgi memory erasures export`) and replay after restoring a backup (`kindgi memory erasures replay`). `409 legal-hold` names held facts; an `erasure-unmatchable` warning says when the deployment can't keep the hash. Clients: `memory.erasures.*` (TypeScript), `memory.create_erasure` and friends (Python). A run whose content an erasure cleared has `contentErasedAt`. An erasure whose person has a turn in a flow serving other people waits for that run (`waiting-on-run`, `waitingOn`) until a deadline (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default), then cancels it; `POST /v1/memory/erasures/{erasureId}/resume` (`kindgi memory erasures resume <id> [--force]`) tries again now, and `force` stops the wait. A test set's case copied from an erased run reads `erased: true` (`input`/`output` null, no items); comparison eval runs leave it out and count it (`summary.erased`).
- 1633db1: Memory facts keep their id across revisions, and every read sees only what the caller may.
  
  - **The scope guard.** A memory read gets `readers` (`MemoryReaders`): the projects, orgs, user, end user (`participantId`, new on `MemoryScope`) and conversations it may see. A binding applies them inside its query, before any limit; `isReadableBy` is the rule. On `/v1/memory`, the route works out the readers from the caller: a tenant admin reads everything; anyone else reads tenant-wide facts, the projects and orgs they may read, their own user facts, and every end user's and conversation's facts in the projects they may write. Writes are checked against the scope (`403 permission-denied`). An agent turn's retrievals see the run's project and org, the user it acts for, its conversation and that conversation's end user, never another conversation's or another end user's; `same-project` in a run without a project selects nothing.
  - **Revisions.** `POST /v1/memory/facts/{factId}/supersede` writes the fact's next revision (same id, body `{ content, expectVersion?, … }`) and returns it; `DELETE /v1/memory/facts/{factId}` closes the current one; `POST …/verify` marks it verified; `GET …/revisions` lists them; `?version=` and `?asOf=` read the past. `409 fact-changed` (with `expectVersion`) and `409 legal-hold` refuse; a runtime without delete, verify or history answers `501 memory-operation-unsupported`.
  - **Facts** carry `revisionId`, `trust`, `verifiedBy`/`verifiedAt`, `attributedTo` (from the writer), `generatedBy`, `subjects`, `validFrom`/`validUntil`/`observedAt`, `invalidatedAt`/`invalidatedBy`/`invalidationReason` and `review`, all optional.
  - `AuthzCheckBinding.listObjects` (optional) lists the objects a principal may act on.
  - `POST /v1/runs` hands the run handler the caller (`InvokeAgentBindingInput.principal`, `InvokeFlowBindingInput.principal`), so a turn knows whom it acts for: their own user facts are among what it may read.
  - Clients: `memory.facts.supersede`, `.delete` (now `DELETE`, returning the closed revision), `.verify`, `.revisions`, and `version`/`asOf` on `read`/`list`. CLI: `kindgi memory facts supersede|delete|verify|revisions`, `--revision` and `--as-of` on `get`, `--as-of` on `list`.
- b67c599: Agents recall earlier conversations, and a conversation can be unregistered.
  
  - **Recall.** A retrieval intent with `source: 'conversations'` recalls messages of this agent's earlier conversations (a user's message or an agent's answer; tool calls are not indexed). It has no `types`, and its scopes are:
    - `same-user` (the usual choice): this end user's, or this user's, other conversations;
    - `same-conversation`: this conversation's messages older than the history window (`conversationPolicy.historyLimit`);
    - `same-segment`: conversations in the run's segment path (the same customer);
    - `same-project`: the project's conversations.
  
    `mode` works as for facts: absent (newest first), `keyword`, `semantic` (needs embeddings, else `semantic-unavailable`) or `both` (fused by rank).
  - **The people's own words, by default.** Recall returns users' messages only. `roles: ['user', 'agent']` adds the agent's earlier answers, which can carry its mistakes: they are quoted with `note: "earlier answer by the agent, not verified"`, and publishing warns `recall-agent-answers` (once per agent). Neighbouring messages follow the same roles.
  - **Other people's conversations.** `same-segment` and `same-project` recall them, in the run's own project only. Publishing such an agent warns `recall-other-people`, and in the prompt each of their messages is marked `anotherPerson`, without saying whose. Recall is always this agent's conversations, within what the run may recall (`isRecallReadableBy` in `@kindgi/memory`: a conversation is always someone's).
  - **The prompt.** Recalled messages are quoted in the `<memory>` block after the facts: the date, the message, and the messages either side. They are earlier conversation, never turns. The system message's memory line now names quotes from earlier conversations. **This changes what models see.**
  - **The turn.** `AgentTurnResult.recalled` (optional) and the journal keep what was recalled, with each message's ranks. A replay can reuse the past run's (`ReplayBinding.recalled`). The run's provenance has a `retrieval` node per recalled message (`source: conversations`), `retrieved-from` its intent's `search_memory` node.
  - **The binding contract** (additive: each new method and field is optional):
    - `MemoryQueryBinding.searchConversations?` (`SearchConversationsInput`, `RecallHit`, `RecalledMessage`). Without it, such an intent recalls nothing, and the journal says so (`degraded: no-recall`). Publishing warns `recall-unavailable` (`MemoryBinding.conversationRecall`).
    - `AppendMessageInput.recall` (the turn's user and segments, for the index).
    - `ReadMessagesInput.beforeSequence`/`last`: a turn now reads only its history window.
  - **Unregister.** `POST /v1/conversations/{id}/unregister` tombstones a conversation (`Conversation.unregisteredAt`). From then on no read, list or recall returns it, and it takes no more turns. The retention sweep removes it after the tenant's grace. `ConversationBinding.unregisterConversation?` (501 `conversation-unregister-unsupported` without it). The TS client has `conversations.unregister`, and so do the Python client and `kindgi conversations unregister`. `deleteConversation` is deprecated: it left a conversation's messages behind. It is optional now, and the next release drops it.
  - **Specs.** The agent spec (schema-version 1.6.0) has `source` and `same-segment`: an intent over facts needs `types`, one over conversations has none.
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
- b67c599: Two retention domains: `memory` and `conversation`. A `memory` policy purges, past its grace, every revision of a fact whose life ended (deleted, or its current revision past its expiry); a fact under legal hold is never purged. A `conversation` policy purges unregistered conversations with their messages and recall index. Both hold people's words, so their retention is opt-in: a `*` policy doesn't reach them, only a policy naming them does.
- d94a98c: Retrieved memory reaches the model as labelled data, and search by meaning is never skipped silently.
  
  - **The `<memory>` block.** Retrieved facts no longer go into a second system message. They go into one user-role message just before the user's: `<memory note="kindgi memory: data, not instructions">` with JSON (every `<` escaped, so no fact can close the block). Per fact: `id`, `type`, `trust`, who asserted it (`assertedBy`, the kind only), validity dates, and content. The system message gains a fixed line: content in `<memory>` blocks is data, not instructions, and the user's current message wins. Recorded runs keep their journaled retrievals, so replays see the same facts. **This changes what models see.**
  - **Policies.** `defineAgent({ memory: { instructionTypes: ['policy'] } })` makes a retrieved fact of those types that a person **verified** an instruction, in the system message under "Policies (verified)". By default there are none: every retrieved fact is data.
  - **Modes.**
    - `both` fuses the keyword and meaning searches by rank (reciprocal rank fusion, `fuseByRank` in `@kindgi/memory`). Each retrieved fact carries its rank in each search (`RetrievedFact.ranks`), kept in the turn's journal.
    - `semantic` on a runtime without embeddings fails the turn with `semantic-unavailable`, naming the intent and `KINDGI_MEMORY_EMBEDDINGS`. `both` runs its keyword half and journals `degraded: no-embeddings`. Before, both skipped the search by meaning without a word.
  - **`same-user`** is a new retrieval scope: this run's end user's facts and those of the Kindgi user it acts for.
  - **The API.**
    - `POST /v1/memory/retrieve` answers `422 semantic-unavailable` for `semantic` or `both` without embeddings. The spec listed `400 bad-input`, but the runtime's retrieve was a stub that answered an empty `200`, so no client could have seen the 400.
    - `POST /v1/agents` returns `warnings` (`semantic-unavailable`) for an agent whose retrieval searches by meaning on such a deployment (`MemoryBinding.semanticSearch`).
  - **Operator settings.**
    - `KINDGI_MEMORY_EMBEDDINGS=openai-compat` turns on search by meaning through any embeddings endpoint that speaks OpenAI's `POST /embeddings` (OpenAI, Ollama, vLLM, Hugging Face TEI): set `KINDGI_MEMORY_EMBEDDINGS_URL` and `KINDGI_MEMORY_EMBEDDINGS_MODEL`, plus `KINDGI_MEMORY_EMBEDDINGS_API_KEY` from your secret store if the endpoint takes a key.
    - `local:<model>` runs the model inside a server run from source on macOS or glibc Linux, not in the runtime image.
    - An endpoint that doesn't answer doesn't stop the runtime, at boot or later. It is retried in the background, and search by meaning waits for it.
    - `@kindgi/embedding` adds `EmbeddingUnavailableError` (`embedding-unavailable`). A semantic search returning it is treated exactly like having no embeddings: `semantic` fails the turn with `semantic-unavailable`, and `both` runs its keyword half and journals it.
    - `@kindgi/adapter-model-openai-compat` adds `createOpenAICompatEmbeddingProvider`. Its `probe()` embeds once, to learn the dimensions.
  - **Specs and SDKs.**
    - The agent spec (schema-version 1.4.0) and pack index carry `memory` and the `same-user` scope; both indexers, TS and Python (`Agent(memory=...)`), keep them.
    - CLI: `kindgi memory facts retrieve --query=<json>` is wired.
- 704dd29: Who can read the tenant's people, and how a project admin adds one.
  - **The people list is for tenant admins:** `GET /v1/identity/users` answers anyone else `403 permission-denied`. Reading a person's record (`GET /v1/identity/users/{userId}`) or sessions (`…/sessions`) needs a tenant admin, or that person.
  - **Add a project member by email or id:** `POST /v1/projects/{projectId}/memberships` takes exactly one of `userId` and `email`. The runtime looks the person up among the tenant's people: someone who isn't one, or was removed, is `404 identity-user-not-found`, and nothing is added. The answer has their `userId`. A directory names the email lookup with the optional `IdentityDirectoryBinding.findUserByEmail`; without it, an email is `400` and an id still works.
  - **`GET /v1/projects/default`** needs read on the Default project, as `GET /v1/projects/{projectId}` does: someone with a role on another project only gets `403`.
  - **A member API key administers below the tenant:** it's refused `admin` on the tenant only, as the API keys design has it, so a project admin's member key adds and changes that project's members. Before, it was refused every `admin` action, and a project admin who isn't a tenant admin can't hold an `admin` key.
  - **Clients:** TypeScript `projects.memberships.add(projectId, { email, role })`; the Python client is regenerated.
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
- b67c599: Improvement passes can draft prompt templates. `POST /v1/proposals/improve` takes `tiers: ['prompt']` with `model` (the tenant's provider and model that drafts the templates) and `candidates` (1–5, default 3). The agent version must take its instructions from a prompt block it pins.
  - Every pass takes `classWeights`, default `restricted-only`: a pass learns from trusted judgments only.
  - `checkDraftedTemplate` (`@kindgi/agents`) checks a drafted template against what the agent has. It must parse as Liquid and may read only the declared parameters, the current template's variables, the turn's clock and identity, and the settings blocks the version pins. It may not name a dotted id the agent doesn't use, and it may be at most twice as long as the current template (at least 2,000 characters).
  - Comparisons take `overrides.prompts`: a template for a prompt block the version pins, checked at start. The summary's candidate names the overridden prompt blocks, and a promotion gate fails such a comparison (`sameContents`).
  - The replay binding's `settings` is now `overrides` (`settings` and `prompts`).
  - A judged test set's reasons name their judgment's class (`judgeClassId`) and say whether it was recorded while the class was restricted (`restricted: true`).
  - A pass's `comparisons` show a refused template's issues (`refused: [{path, message}]`) and each drafted template's `hypothesis`. A proposal a pass drafted names the pass (`drafter.passId`).
- eff6249: Improvement proposals change data blocks. A proposal is new settings values or a new prompt template for one block an agent version pins, for one live scope:
  - `POST /v1/proposals` drafts one. The content is checked as publishing that block version would be, and refused when it equals the pinned content. The same change from the same version for the same scope is one proposal.
  - `POST /v1/proposals/{id}/evaluate` publishes the block version, derives the agent version (`derivedFrom.proposalId`) and compares it on a test set. Neither serves any scope until promoted. Without a live version of the agent for the whole tenant, it answers `409 proposal-needs-pin`. Under `kindgi dev`, where the agent registry takes no writes, it answers `409 registry-read-only`.
  - `POST /v1/proposals/{id}/request` promotes the candidate for the scope through its gate, as `POST /v1/agents/{agentId}/promotions` does. It's allowed whether or not the candidate measured better: the gate decides.
  - `POST /v1/proposals/{id}/rollback` puts the scope back.
  - `POST /v1/proposals/{id}/withdraw` closes the proposal.
  - `GET /v1/proposals` filters by agent, tier, status, and the live scope a proposal is for (`scopeKind`, `scopeId`, `segment`).
  - `status` is derived from the comparison and the promotion: `draft`, `evaluating`, `evaluated`, `not-better`, `evaluation-failed`, `in-review`, `promoted`, `refused`, `rejected`, `expired`, `superseded`, `rolled-back` or `withdrawn`.
  - Proposals are authorized on their agent: `read` to see one; `publish` to draft, evaluate or withdraw; `promote` to request or roll back. `X-Supervisor-Id` is no longer needed.
  
  The instruction-string tiers (`prompt`, `retrieval`, `tool-config`) and the `dry-run`, `submit-review` and `apply` routes are gone.
  
  The TypeScript client has `client.proposals` (`list`, `get`, `create`, `evaluate`, `request`, `rollback`, `withdraw`). Every `client.supervisor.proposals` method now throws `not-yet-wired`, naming its replacement, until 0.2. The Python client's `proposals` resource has the new calls. `draft`, `dry_run`, `submit_review` and `apply` raise `InvalidRequestError`, naming their replacement.
  
  `SupervisorBinding` stores proposals (`listProposals`, `getProposal`, `createProposal`, and `recordProposal`, a compare-and-set on `revision`). The API package runs the lifecycle from the agent, block, eval-run and promotion bindings.
- 0fe157e: A provider registration the runtime couldn't build is refused when it registers, naming the setting. Before, a bad `adapter_config` (an unknown `api`, a missing `baseURL`, a Vertex registration without `project`, …) registered fine, and the provider was skipped at the first model call with the reason only in the runtime's log.
  - **`POST /v1/providers`** runs the adapter's own check before storing: `422 provider-config-invalid`, with each problem in `details.issues` (`path`, a JSON pointer such as `/adapter_config/api`, and `message`), the shape other validation errors use; the clients read it as an invalid-request error. Without the runtime's adapter factories (an older runtime), nothing changes.
  - **`GET /v1/providers/{providerId}/check`** runs the same check over a registered provider (`{ providerId, adapterId, checked, issues }`); TS `providers.check(id)`, Python `providers.check(provider_id)`.
  - **Adapters:** `AdapterFactoryEntry.checkConfig` (static: no network, no secret read): `{ path, message }` problems, the message naming the setting and what it takes; the factory throws the same problems as `adapterConfigError` words them (`<adapter>: provider "<id>": <message>`). The 422's own message is one sentence naming the provider, its adapter and the first problem, with a count of the rest. Each adapter exports its entry: `openAICompatAdapterEntry`, `geminiAdapterEntry`, `anthropicAdapterEntry` (new `anthropicAdapterFactory`: needs `secret_ref`) and `inProcessAdapterEntry` (new `inProcessAdapterFactory`).
- 7d7d344: **Security (Python):** a tool's context never shows its secrets: `ToolContext.secrets` is left out of the context's `repr`, so printing or logging a context (`print(ctx)`, `f"{ctx}"`) no longer includes the secrets' values. `ctx.secrets` still reads them.
- 7d7d344: Python: `kindgi.log`, the same log records as `@kindgi/log`, with no new dependency. `get_logger("billing", tenantId=…)` gives a logger (`log.info("charged", {"amountCents": 1200})`, `log.child(runId=…)`, `err=exc`) at the levels and format of `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` (`configure()`; a `TRACE` level), redacting secret-looking keys and known secret shapes. `JsonFormatter` and `PrettyFormatter` put an app's own `logging` records in the same schema. The shared vectors check that Python and TypeScript write the same records.
  
  The Python pack service writes these records on stderr (subsystem `pack`), as the TypeScript one does: one per call, with the call's ids and the caller's `traceId`, and the lifecycle whatever the levels (each keeps `kind` for older supervisors). `ToolContext.log` is a logger bound to the call (`ctx.log.info("looked up order", order_id=…)`, subsystem `pack.tool`); in a test it writes nothing unless you pass one.
- 8dd0a55: **The Python client follows a run to its end: `runs.follow(run_id)` and `runs.follow_progress(run_id)`, sync and async.**
  - **Why:** the server ends a run's stream after its terminal event or after 5 minutes. `runs.stream` ended there too, so a run that took longer, waiting for an approval say, stopped streaming early unless the caller reconnected.
  - **What they do:**
    - reconnect with `Last-Event-Id` until `run.completed`, `run.failed` or `run.cancelled`, each event once;
    - pause 0.5 s before reconnecting after a connection that brought nothing;
    - retry a dropped connection, a 429 or a 502–504 with backoff (0.5 s up to 30 s, 10 attempts in a row);
    - raise any other error, such as a 404;
    - end after the terminal event, even if the server keeps the connection open.
  - **The pair** matches TypeScript's `runs.stream` and `runs.streamProgress` and the Java client's `runs().follow` and `runs().followProgress`.
  - **`runs.stream`** stays the plain call.
- 70c5737: Remove a person from a tenant: `POST /v1/identity/users/{userId}/unregister`, mounted when the identity directory can (`IdentityDirectoryBinding.unregisterUser`, optional). Tenant admins only.
  - **What it does, in one step:** every API key and session of theirs is revoked, and every grant and membership taken away, before it answers. Their keys get `401` at once.
  - **Their record stays,** with `unregisteredAt`, so their history still says who they were. Their email is free again: adding it makes a new person.
  - **Idempotent:** removing someone already removed changes nothing.
  - **Refused** for yourself and the seed user (`identity-user-unregister-refused`), and for the only tenant admin (`last-tenant-admin`).
  - **The list** (`GET /v1/identity/users`) leaves removed people out unless `includeUnregistered=true`.
  - **Clients:** TypeScript `client.users.unregister(id)` and `users.list({ includeUnregistered })`; the Python client is regenerated.
  - **CLI:** `kindgi people remove <user-id>` and `kindgi people list --include-removed`.
- a1f3dd1: A failed run says why, as data: `failure: {code, message, cause?}` on the run (`GET /v1/runs/{id}`, lists, the start answer). An agent turn's failure carries its own code (`budget-exceeded`, `capability-routing-failed`, `model-invocation-failed`, …) and, when it says, what it came from (`cause`: for `capability-routing-failed`, the router's reasons by provider). Any other failure is `run-failed`, with the run's failure message. Only a `failed` run has one. `failureMessage` is unchanged; read `failure` instead.
  
  - The TypeScript client's `Run` has `failure` (`RunFailure`), the Python models `RunFailure`.
  - `@kindgi/api` exports `runFailure(row)`, the decoder the routes use.
  - `kindgi runs start` prints a failed run's line from `failure` (`Error [<code>]: <message>`), and decodes `failureMessage` itself only for a runtime from before it.
- d25c1b3: A run can be started at most once per idempotency key, and a run records the trigger that started it. Both are additive contracts, which a runtime implements.
  
  - **`idempotencyKey`** on `RunFlowInput`, `StartRunParams`, the run handler's `invokeFlow` / `invokeAgent` inputs and `InvokeAgentInput`. A start with a key that a run of the tenant already has starts nothing and answers that run. `startRun` and the run handler say so with `existing: true`. A trigger's fire uses `fire:<fireId>`, so a re-driven fire never runs twice.
  - **`trigger`** (`RunTriggerRef`: `triggerId`, `kind` `schedule` | `event` | `webhook`, `fireId`, `scheduledFor?`) on a run started by a trigger: on `KernelRunRecord`, and on the wire as `Run.trigger` (OpenAPI `RunTrigger`).
  - **`GET /v1/runs?triggerId=`** lists the runs a trigger started: `runs.list({ triggerId })` in TypeScript, `triggerId` on `ListRunsInput`, and `kindgi runs list --trigger=<id>`.
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
- 94c999f: **A provider or MCP endpoint registration can opt in to receive the run's `traceparent`.** It's off by default: nothing about a run's trace leaves the deployment unless a registration turns it on.
  - **Providers:** `send_traceparent: true` on `POST /v1/providers`. A runtime then sends each model call's `traceparent` to the provider as a request header: ids only, never content.
    - Any other value is refused with `422 provider-config-invalid` at `details.issues` `/send_traceparent`, listed before the adapter's own issues.
    - `ProviderRegisterInput` and `ProviderRuntimeEntry` gain `sendTraceparent`.
  - **MCP endpoints:** `sendTraceparent: true` on `POST /v1/mcp/endpoints`, for HTTP transports, and reads return it.
    - A non-boolean, or `true` on a `stdio` endpoint, is refused with `400 invalid-mcp-endpoint`, reason `invalid-send-traceparent`.
  - **The runtime enforces it,** not the adapters. An older runtime ignores the field and sends nothing.
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
- cbb6785: Setting up sign-in with an identity provider the way it happens in practice: the identity provider's side first, then Kindgi's.
  
  - **`GET /v1/auth/providers/{providerId}/sign-in?kind=oidc|saml`**: what to give the identity provider (the redirect URI, or SAML's ACS URL, entity ID and metadata URL) **before** anything is registered. The URLs stay the same after registering, after any update, and after an unregister and a new registration under the same id. They aren't secrets: every sign-in's browser redirects carry them. TypeScript `client.auth.providers.signIn(providerId, { kind })`. Backed by the optional `IdentityProviderBinding.signInUrls`.
  - **`PATCH /v1/auth/providers/{providerId}`**: change a provider in place (a field given replaces the stored one, `null` removes an optional one). It's checked as a registration is, and keeps its sign-in URLs, so nothing changes on the identity provider's side. `providerId` and `kind` can't change; a new `issuer` drops the endpoints discovered from the old one. TypeScript `client.auth.providers.update(providerId, changes)`. Backed by the optional `IdentityProviderBinding.update`.
  - **`GET /v1/auth/providers/{providerId}`**: one provider. TypeScript `client.auth.providers.get(providerId)`.
  - **`kindgi sso providers`**: `start` prints the URLs and a message for whoever runs the identity provider (`--idp=google|entra|okta|keycloak` adds its click-by-click steps); `finish` registers what came back; then `update`, `get`, `list`, `test` (the link to try signing in) and `remove`.
- 66bab49: Sign-in contract for identity providers and browser sessions.
  
  - **Identity providers, one shape per `kind`.** `ProviderConfig` is a union: `oidc` (an OpenID Connect identity provider: `issuer` + `clientId` + `clientSecretRef`, endpoints from discovery), `saml` (IdP metadata XML, or entity ID + SSO URL + certificates; `spSigningKeyRef` / `spDecryptionKeyRef` by reference), and `oauth2` (a plain OAuth 2.0 provider that isn't OpenID Connect, e.g. GitHub: the old shape). All kinds gain `displayName`, `domains`, `join` and `signIn`. A `clientSecret` or raw key in the body is refused (400 `invalid-provider-config`), and the deployment may refuse a configuration it can't use (422 `identity-provider-invalid`). **TypeScript: narrow on `kind` before reading kind-specific fields** (`config.tokenEndpoint` needs `config.kind === 'oauth2'`, or `'oidc'` with endpoints).
  - **`GET /v1/auth/sign-in-options?email=`** (unauthenticated): the providers for the email's domain, each with a `signInUrl`. Sign-in is email first: with no email the list is empty, and the binding isn't asked. The same answer for anyone at a domain; rate-limited per client (429 `rate-limit-exceeded`). TypeScript `client.auth.signInOptions({ email })`. Backed by the optional `IdentityProviderBinding.signInOptions`.
  - **Browser sessions in a cookie** (`SessionConfig.cookie`): the session token is read from `__Host-kindgi_session` when there's no `Authorization` header; a cookie-authenticated unsafe request needs an allowed `Origin` (403 `csrf-origin-mismatch`, a missing `Origin` too). Logout clears the cookie; refresh of a cookie session is refused (400 `cookie-session-not-refreshable`).
  - **The provider catalog, refresh and logout mount without `exchangeCode`**; only this API's own OAuth flow (`/v1/auth/login` + callback) needs it.
  - **For `SessionStoreBinding` implementers:** `SessionCreateInput.accessToken` and `Session.accessToken` are optional (a deployment may keep no identity-provider tokens). Copy them conditionally.
  - **Runtime settings for sign-in** (`@kindgi/env-schema`): `KINDGI_AUTH_SECRET_PATH` / `KINDGI_AUTH_SECRET` (turn sign-in with identity providers on; need `KINDGI_PUBLIC_URL`), `KINDGI_AUTH_PRIVATE_IDP_ORIGINS` (private-network identity providers the operator allows), `KINDGI_SESSION_TTL_MS` (default 12 hours) and `KINDGI_SESSION_IDLE_TIMEOUT_MS` (default 60 minutes).
- b67c599: A test set can be narrowed to a segment. `POST /v1/eval-suites/{suiteId}/versions/from-judgments` takes `segments`, and `kindgi eval-suites from-judgments` takes a repeatable `--segment=key:value`. With it, the test set keeps only runs started in that segment path or below it, and its spec records the path.
  - A judgment's copy of its run keeps the segment path the run was started with (`run.segments`; empty when there was none).
  - A run judged before this change has no recorded segment, so it's left out of a narrowed test set.
- d7c0173: **`runs.follow(runId)` and `runs.followProgress(runId)`: the TypeScript client follows a run to its end under the same names as Python and Java.**
  - **What they do:** reconnect with `Last-Event-Id` after a drop or the server's 5-minute limit, through to `run.completed`, `run.failed` or `run.cancelled`. This is what `runs.stream` and `runs.streamProgress` do today.
  - **`runs.stream` and `runs.streamProgress` are deprecated.** Use `runs.follow`, which does the same. In a later minor release, announced in advance, `runs.stream` becomes the plain call, as in Python and Java: it ends when the server closes the stream. Until then it still follows the run to its end.
  - **The CLI's `kindgi runs stream`, the README and the guides** use `follow`.
- e88c3cc: **Audit bundles made with `@kindgi/api` 0.1.4 verify.** The 0.1.4 runtime didn't sign exports, but an app that embedded `@kindgi/api` 0.1.4 with its own key could export audit bundles. That version stamped an audit bundle's envelope `exportedAt` separately from the signed one, so about 1 in 10 came out a millisecond apart, and the new verifiers refused them. For that format only (the envelope's `bundleSchemaVersion` is the integer `1`, over a signed `bundleVersion: 1`), `verifySignedExport`, the Python SDK's `verify_signed_export` and `kindgi exports verify` no longer compare the envelope's unsigned `exportedAt`. They report the signed time in a new `notes` field: `made by Kindgi 0.1.4, which stamped the envelope's exportedAt separately: the signed export time is … (the envelope says …)`. Every later bundle keeps the strict check. Real 0.1.4 exports are a shared test vector in `@kindgi/specs` (`test-vectors/signed-export/kindgi-0.1.4.json`).
- 423aeea: A console signed in with a cookie session knows who is a tenant admin again.
  - **`GET /v1/identity/whoami`** answers `tenantAdmin`: whether the caller is a tenant admin, decided as the admin routes decide it. That's `admin` on the tenant when the runtime authorizes; otherwise the `tenant-admin` scope of a full key, never a `member` key or one limited to a project. A console shows its admin pages by it. The field is optional: from older servers it's absent, so read `scopes`.
  - **A session opened with an API token (`POST /v1/auth/token-sign-in`) carries the key's scopes**, so it acts as the key did. Before, it had none, so with authorization off (`kindgi dev`, or a deployment without OpenFGA), even the deployment's own token lost admin once it signed in to the console. The session can't do more than the key: member and project keys still can't sign in, a key's scopes never change, revoking the key ends its sessions, and with authorization on the authorizer decides. Sessions from an identity provider are unchanged.

## 0.1.4

### Patch Changes

- 9564887: **The TypeScript client's timeout can be set.** Until now it was fixed at 30 s, so a waited `runs.start` whose run took longer always failed on the client.
  - `createClient({ …, timeoutMs })` sets how long one request may take. The default is still 30 000 ms, and streams aren't bound by it.
  - `runs.start({ …, timeoutMs })` sets it for one start.
  - A request the timeout ended fails with a `network` error that says so and carries `timeoutMs`.
  - When it ends a waited `runs.start`, the error also says the run may still be going and that its id didn't arrive, and to start a long run with `options: { wait: false }` and follow it.
- b9d3c01: A provider can name its **default model** (`metadata.defaultModel`, one of its models). When the router's candidates rank equally (an agent with no preference and no `preferredModel`), the provider's default comes before its other models. Without one, ties break by model name, so the "default" was whichever name sorted first: for the `openai` preset that was its flagship (`gpt-6-astra`), and for `gemini-api` a preview model.
  
  Each preset now names a mid-priced default: `anthropic` claude-sonnet-5-5, `openai` gpt-6.1-sol, `gemini-api` and `gemini` gemini-3.8-flash, `groq` openai/gpt-oss-120b, `openrouter` anthropic/claude-sonnet-5.5. `kindgi providers register --preset` marks it `(default)`; registering only some of a preset's models keeps the default only when it's among them. A runtime that predates default models drops the field, and the CLI then says what an agent that chooses no model gets instead. The API refuses a `defaultModel` that isn't one of the provider's models (400, reason `unknown-default-model`).
  
  The `anthropic` preset adds `claude-haiku-5-5`, Anthropic's newer Haiku: the cheap option once `claude-haiku-4-5` retires (on or after 2026-10-15). It has a 1M-token context window and costs $0.10 / $0.50 per 1M tokens, or $0.50 / $2.50 for a prompt over 100,000 tokens. It rejects a non-default `temperature`.
- 366c31a: **The Python client no longer starts a waited run more than once.**
  
  **What happened since 0.1.2:** a waited `runs.start` whose run took longer than the client's timeout (60 s by default) was sent again with the same idempotency key, up to twice. The runtime started the run again each time: up to three runs, each with its tools' side effects. The caller got a `NetworkError` and no run id. Any other slow call with an idempotency key was exposed the same way. The TypeScript client never sends a call again, so it wasn't affected.
  
  **Now:**
  - **Which calls are sent again:** a call other than a GET only when nothing can have run: a failure to connect (or a connect or pool timeout), or a 429 or 503. A read timeout, a dropped connection, or a proxy's 502 or 504 is raised at once. A GET is retried as before.
  - **A waited `runs.start` that times out** raises a `NetworkError`. It says the run may still be going and its id didn't arrive. It also says to start a run that can take longer with `options={"wait": False}` and follow it with `runs.stream` or `runs.get`.
  - **A call the timeout ended** gets a `NetworkError` that carries `timeout`, in seconds.
- c313224: **An agent version is pinned when it's published.** `POST /v1/agents` resolves each of the agent's tool ranges once, to the highest active version the range allows (`pickVersion`). It stores the result on the version as `pins` (`{tools, prompts, settings}`: tool id → exact version) with `pinsDigest` (`sha256:<hex>` of the pins' canonical JSON). Every run of that version uses exactly those tool versions. A new tool version reaches the agent only through a new agent version, and two runs of one agent version always run the same tools.
  
  - **A range that matches no published version refuses the publish:** `400 validation-failed`, with one issue per tool (`/tools/<i>/version`, "publish the tool first").
  - **Pins are set by the runtime, never authored.** `defineAgent` doesn't take them, and a publish body's `pins` is ignored.
  - **`GET /v1/agents/:id/versions/:version` returns `pins` and `pinsDigest`**, as do both clients. Python adds `pins_digest()` in `kindgi.client`, which gives the same string as `pinsDigest()` in `@kindgi/agents`.
  - **Unchanged:** a version published before pins, or by a runtime without a tool registry, has no pins and resolves its ranges per run. `agentsRouter` takes the tool binding as an optional third argument, and `createApp` passes its `toolRegistry`.
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
- 0b1f48d: `GET /v1/audit/authz` takes `?order=asc|desc`. `asc` (the default, as before) lists the oldest decisions first; `desc` lists the newest first, and `nextCursor` continues in the same order. Any other value is `400 bad-input`. The TypeScript client's `audit.authz.list({ order })` and the Python client's `audit.authz.list(order=…)` send it. `AuditEventBinding.query` takes an optional `order` (`AuditEventOrder`); the in-memory binding implements it, and a binding that doesn't pages oldest first.
- 9a7f43b: A comparison's live baseline names its segments as a path, the way live versions resolve them: `baseline: { live: { projectId, segments: [{ key, value }, …] } }`, coarse to fine. It was an unordered object (`{ tier: 'gold' }`), so a path's order was lost. `segments` follows the rules of a run's and a pin's segment path (lowercase keys, each key once, at most 8), needs `projectId`, and anything else is `400 bad-input`. The CLI's `eval-runs start --baseline-segment` takes `<key>:<value>` (it took `<key>=<value>`), once per step in order, and needs `--baseline-project`. A live baseline is still refused when the run starts (only `recorded` runs today).
- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- 4287798: `kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]` registers a tool manifest (the tool minus its handler, which the runtime must already have) at its version, in the tenant's Default project or the one named. Before, it failed with "not yet wired". The TypeScript client gains `client.tools.register(manifest, { projectId })` (`POST /v1/tools`), as the Python client has.
- fcc6a97: An error code a client doesn't list is read by its HTTP status. Until now any newer code, such as a 404 `org-not-found`, became a server error. Now, in the TypeScript and Python clients:
  - 404 and 410 are a not-found (the resource's kind comes from the code: `org` for `org-not-found`);
  - 401 and 403 are an auth error (unauthenticated or forbidden);
  - 429 is rate-limited;
  - 400 is an invalid request.
  
  Codes the clients list keep their class; the list now also has the 409 codes of the already-registered family (`eval-suite-already-registered`, `policy-already-registered`, `mcp-endpoint-already-registered`, `identity-provider-already-registered`, `version-already-exists`, `eval-run-already-terminal`, `approval-already-decided`, `judge-class-name-taken`), conflicts like their listed siblings, the promotion gate's 409s (`promotion-superseded`, `gate-policy-already-registered`, `gate-policy-scope-taken`, `gate-policy-scope-changed`, `gate-policy-scope-unpinned`, `gate-policy-needs-pin`) are conflicts too, and the TypeScript client now also lists `policy-scope-taken` and `policy-scope-changed`, as the Python client did. 409 and 422 codes they don't list stay server errors, matched by their code, as the docs show (`budget-exceeded`, `agent-version-mismatch`). In TypeScript, every error from the server now carries the wire code as `serverCode`, whatever its family (Python's `server_code` already did). `@kindgi/api`'s OpenAPI document lists every error code and its status as `WireError['x-error-codes']`, and the clients' tests check against it.
- c7e27fb: `@kindgi/client`'s published types declare as values only what the package exports at runtime. The generated wire schemas (`LivePin`, `LiveScope`, `Promotion`, `GatePolicy`, `RunProgress`, `Block` and the others) are types; the bundled `.d.ts` also declared each as an exported `const`, so `LivePin.parse(…)` compiled and then failed at runtime (the module has no `LivePin`). Using one as a value is now a compile error ("'LivePin' only refers to a type"); importing them as types is unchanged.
- fd011d4: The published types export each name once. Sixteen names (`ConversationMessage`, `EvaluationResult`, `Fact`, `GeneratedWebhookSecret`, `MessageRole`, `ProvidersClient`, `ReviewerRole`, `RevokeSigningKeyResult`, `RunFinishedEvent`, `TrustedSigningKey`, and the `Webhook*` types `WebhookDelivery`, `WebhookDeliveryStatus`, `WebhookEndpoint`, `WebhookEvent`, `WebhookSecretRef` and `WebhookTestEvent`) were exported twice, beside an internal type of the same name. With `skipLibCheck: false`, an app no longer gets `TS2484`; with it on, `ConversationMessage`, `EvaluationResult`, `Fact` and `ProvidersClient` now mean the client's own types, where they could resolve to the internal ones.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- e97958c: Conversation lists leave a comparison's replay conversations out, as run lists leave out replay runs. `GET /v1/conversations` takes `replays=exclude|include|only` (default `exclude`); a replay conversation is one whose `metadata` has `replayOf`. `ListConversationsPageInput.replays` passes it to the binding (absent: include, for internal callers).
  
  The TypeScript client's `conversations.list` and the Python client take `replays`. `kindgi conversations list` now lists, with `--status`, `--replays`, `--limit` and `--cursor` (the other `conversations` commands stay unwired).
- a311b81: `GET /v1/cost/aggregate` returns at most 1000 groups by default: the most expensive ones. `groups` is ordered by `totalUsd`, highest first (ties by key, groups with no value last); before, the order was undefined and every group came back in one response, one per run for `groupBy=runId` over a long window. `?limit=` takes 1 to 10000 (anything else is `400 bad-input`). The response says when groups were left out: `truncated: true` and `totalGroups`, the count before the cap. `totalUsd`, `totalRecords` and `tokens` still cover every record. For every record, page through `/v1/cost/records`. **A caller that gets more than 1000 groups today gets 1000, with `truncated: true`**, unless it passes a larger `limit`. A `CostBinding` may cap in its own query (`CostAggregateInput.limit`, returning `totalGroups`); one that returns every group is capped by the route. `@kindgi/api` exports `COST_AGGREGATE_DEFAULT_LIMIT` and `COST_AGGREGATE_MAX_LIMIT`. The TypeScript and Python clients take `limit`.
- f8deed1: `client.cost.usage.summary()` takes `limit`, the most groups to return (the most expensive ones), as the API's `?limit=` and the Python client's `limit=` do. The result's `truncated` and `totalGroups` say when there were more.
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
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
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- d3dffb5: Comparison eval runs take a flow version as the candidate. On a test set built from a flow's judged runs, `POST /v1/eval-suites/{suiteId}/runs` with `flowRef: { flowId, version }` replays each case on that flow version (from the past run's input) and scores the flow's whole output against the judgments.
  
  A replayed flow stops at a tool call the replay refuses (a write the past run didn't make), so no made-up value reaches its next step. The case ends `stopped`, with what it would have done. It isn't an error and is left out of the metrics. The summary counts these cases in `stopped`, next to `errors`, and the run's status stays `completed` when cases only stopped.
  
  The summary's `candidate` now says what ran, `{ kind: 'agent', agentId, version }` or `{ kind: 'flow', flowId, version }`, and `baseline.versions` names a flow's recorded versions as `{ flowId, version, cases }`. The subject invoker reports a stop through `EvalRunSubjectInvokeOutcome.stopped`.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- b67eee6: A judged flow run keeps what it did, so it can be replayed later. At a flow run's first judgment, its run copy's `context.flow` keeps:
  - every tool call the run made, with its result: at its tool nodes (per loop iteration), in its agent steps' turns, and in its sub-flows (at most 500, with `truncated`);
  - its agent steps (each turn's agent, version and what it retrieved).
  
  `createApp` passes its `flowRegistry` to the judgments routes to tell tool nodes apart. The capture is best effort: a part that can't be read is left out, and the judgment never fails over it. Judging a run needs `write` on the run's project (the route's own description now says so).
- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- 5608264: A gated scope holds its own live version, and a change above it can't move it without its gate.
  
  - **Publishing or reinstating a gate policy** for a scope with no pin of its own is refused (`409 gate-policy-scope-unpinned`), even when a scope above it is pinned. A promotion there would otherwise change the gated scope without its gate.
  - **A promotion, rollback or unpin** that would also move a narrower gated scope with no pin of its own (one gated before this rule) is refused with the new `409 gate-policy-descendant-unpinned`. The message names each such scope and its current version: pin it there first. A gated promotion's approval re-checks this, and is `superseded` if it would.
  - **A pin in place skips the gate.** Promoting a scope that has no live version of its own to exactly the version it serves now (the fix the new 409 asks for) changes nothing any run gets. So the gate's checks and approval don't apply: it's `201`, with one passing `pinInPlace` check, the policy recorded, and a reason starting `pin-in-place`; `…/promotions/check` says the same. `PromotionRequestInput.gate.pinInPlace` tells the binding, which re-checks it as it writes (`409 promotion-superseded` if the scope moved).
  - **The follower guard only refuses a real change:** a promotion that leaves a gated follower on the version it already serves goes through.
  - **Unpinning a gated scope's own pin** is `409 gate-policy-needs-pin`: unregister the gate policy first, or roll back instead.
  - **Clients:** `gate-policy-descendant-unpinned` is a conflict in TypeScript and Python, like the other gate codes.
- 7a8e764: A duplicate org, team or project slug is a `409 slug-conflict`, not a `500`. `POST /v1/orgs`, `/v1/teams` and `/v1/projects` with a slug the tenant already has, and a `PATCH` to one, answered `500`; now `409 slug-conflict` (`Another project in the tenant has the slug "acme"`, with `details: { resource, slug }`), whether or not the deployment enforces authorization. A second Default project is `409 project-default-already-exists`. A `PATCH` of a missing org, team or project, a member added to a team or project deleted mid-request, and a role change for a non-member answer their `404`s from the binding's outcome instead of matching an error message. The TypeScript and Python clients read both new codes as a conflict (`ConflictError` in Python).
  
  **Breaking for custom platform bindings.** `OrgBinding`, `TeamBinding`, `ProjectBinding`, `TeamMembershipBinding` and `ProjectMembershipBinding` writes no longer reject for a caller mistake; they resolve to an outcome discriminated on `kind`: `create` to `{ kind: 'ok', orgId | teamId | projectId }`, `slug-conflict` or (projects) `project-default-already-exists`; `update` to `ok`, `*-not-found` or `slug-conflict`; a membership's `add` and `updateRole` to `ok`, `team-not-found` / `project-not-found` or `*-membership-not-found`. The types are exported (`OrgCreateOutcome`, `ProjectUpdateOutcome`, …). The in-memory bindings keep slugs unique within a tenant. `TenantHierarchyBinding.addTeamMember` / `addProjectMember` fail with `AddTeamMemberError` / `AddProjectMemberError` (`team-not-found` / `project-not-found`, or `add-failed`), which replace `MembershipMutationError`. A binding of your own needs the same changes; the conformance suites in `@kindgi/platform`'s `tests/` check them.
- 8491dd8: A judge class can be restricted to some judges. `assertableBy` on `POST /v1/judge-classes` and `PATCH /v1/judge-classes/{judgeClassId}` (`null` on the PATCH lifts it) takes `minReviewerRole`, `principalKinds` and `principalIds`, and a caller must meet each one given. A judgment that names a restricted class its caller doesn't meet is `403 judge-class-not-allowed`, and the message says why. A judgment recorded under a restricted class carries `restricted: true`; adding or lifting a restriction later doesn't change it. A test set's items carry `restricted`: the yes and total weight of those judgments alone.
  
  A comparison takes `classWeights`: `as-recorded` (the default, every judgment at its class's weight) or `restricted-only` (only judgments carrying `restricted` count; an item with none counts as unjudged). The summary records which one it used. A gate policy's spec takes `onlyRestrictedClasses`: the promotion's comparison must be `restricted-only` (check `classWeights.restrictedOnly`), so a class anyone may assert can't move the gate.
  
  `@kindgi/api` exports `whyNotAssertable`, `JudgeClassAssertableBy`, `JudgeClassAsserter` and `EvalClassWeights`. The TypeScript client's judge-class types take `assertableBy`, and `evalRuns.start` takes `classWeights`. The Python client sends both (`assertable_by=None` lifts a restriction). The CLI's `judge-classes add` and `set` take `--min-reviewer-role`, `--principal-kind` and `--principal-id`, `set --unrestricted` lifts the restriction, and `eval-runs start` takes `--class-weights`.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- ba55da0: A list page carries its list once: `items`, the deprecated name for `data`, is still readable (`page.items`, until 0.2) but is no longer an own enumerable property, so `JSON.stringify(page)`, a spread, and the CLI's JSON output show `data` alone. Before, every list page printed its list twice.
- 933e00a: Every list call answers in one shape, the wire's page: `data`, `hasMore` and `nextCursor`, as the API and the Python client have it. The calls that answered `{ items, nextCursor }` (adapters, approvals, artifacts, capabilities, conversations, cost, events, flows, guardrails, judge classes, judgments, MCP, memory, observations, packs, policies, provenance, supervisor, tokens, tools and users) now answer `data` and `hasMore` too. `items` keeps working, marked `@deprecated`, and will be removed in 0.2. The client exports the page type as `ListPage<T>`.
  
  `GET /v1/env`, `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` send `hasMore`, and `GET /v1/auth/providers` sends `hasMore: false` (the list comes whole). Against an older server without it, both clients derive `hasMore` from `nextCursor`, so Python's `paginate(client.env.list, …)` and `paginate(client.secrets.list, …)` page through.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ba2f212: `GET /v1/observations`'s `agentVersion`, `conversationId`, `since` and `until` filters, which the route already read, are in the OpenAPI spec, so the Python client's `observations.list` takes them. `kindgi observations` and `kindgi proposals` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't record supervisor observations or draft fix proposals yet. A reason given for a group covers each of its commands.
- 3d23304: A project's slug is unique within its org, not the whole tenant: two orgs may each have a project called `intake`. A project without an org has a slug unique among the tenant's projects without one. An org's and a team's slug stay unique in the tenant.
  
  - **`409 slug-conflict`** on `POST /v1/projects` when the org already has the slug. `PATCH /v1/projects/:id` answers it for a new slug, and now also for a move to another org (`orgId`, or `null` for none) where the slug is taken. The message says where: "Another project in its org has the slug …".
  - **Deleting an org** leaves its projects without an org. When one of them has the slug of a project that has none, `DELETE /v1/orgs/:id` deletes nothing and answers `409 slug-conflict` naming the slugs (`details.slugs`); rename or move those projects first. `OrgBinding.delete` may return `{ kind: 'slug-conflict', slugs }` (`OrgDeleteConflict`). A binding that returns nothing deletes as before.
  - The in-memory `ProjectBinding` checks slugs per org, and the binding conformance suite pins the per-org cases.
- 42a2e66: Promotions go through a gate (evals step 4b). A **gate policy** says what a promotion of an agent for a scope must show: a recent comparison of that exact version against the one live there, with enough judged evidence, metrics that reach a floor or drop no more than allowed, clean replays, and optionally a reviewer's approval.
  
  - **`/v1/gate-policies`**: publish (`{id, version, agentId, scope, spec}`), list, get, `versions` list / get / unregister / reinstate. One policy per agent and scope (`409 gate-policy-scope-taken`, `details.heldBy`); the most specific scope with a policy applies. The `spec` is checked strictly. Writes need `admin` on the tenant.
  - **`POST /v1/agents/{id}/promotions`** checks the scope's policy against the comparison named by `evalRunId`. It answers `201` (`status: 'promoted'`), `202` (`status: 'pending-approval'`, with `approvalId`: a reviewer approves it, and the version goes live if nothing changed meanwhile), or `422 gate-failed` with every check in `details.checks`. The refusal is recorded too. A promotion now carries `status`, `policy`, `checks`, `approvalId` and `resolvedAt`. With no policy for the scope, nothing changes.
  - **`POST /v1/agents/{id}/promotions/check`** answers what the gate would say (`would-promote`, `needs-approval`, `gate-failed`), recording nothing. **`GET /v1/agents/{id}/gate-policy`** answers the policy that applies to a scope.
  - **A comparison's summary records the candidate's `pinsDigest`**, so the gate can tell the promoted version ran exactly what was compared. A comparison recorded before this has none, and the gate asks for it to be re-run.
  - The TypeScript client has `gatePolicies.*`, `agents.promotions.check` and `agents.gatePolicy.resolve`; the Python client has `gate_policies`, `agents.promotions.check` and `agents.gate_policy.resolve`. The CLI has `kindgi gate-policies list | show | versions | publish | unregister | reinstate`, `kindgi agents gate-policy` and `kindgi agents promote --check`.
- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
- d69c8e9: The Python client takes a model's id straight back: every id parameter (a path or query parameter named `…Id`, or one the API declares as a UUID) accepts `str | UUID`. The models carry ids as `UUID`, so `kindgi.runs.get(run.id)` and `kindgi.approvals.complete(approval.id, decision="approve")` now type-check under pyright and mypy; they always worked at runtime. Lists of ids accept `list[str | UUID]`.
- bfeabfd: Publishing a policy that nothing applies is refused. `access-control`, `adapter-allowlist`, `rate-limit` and `compliance` are known policy kinds, but no runtime consumer applies them yet, so publishing one changed nothing, silently. `POST /v1/policies` now answers `400 kind-not-applied` for them, naming the kinds it does apply in `details.appliedKinds` (`model-routing`, `retention`, `tool-errors`, `hitl`). Policies of those kinds already stored stay readable, and the list still filters by them. `@kindgi/policy-contract` exports `APPLIED_POLICY_KINDS` and `isAppliedPolicyKind`; `@kindgi/api` re-exports `APPLIED_POLICY_KINDS`.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
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
- dc5cfb1: **A decision whose run couldn't go on says so.**
  
  - **`POST /v1/approvals/{id}/complete`** now reports how the inline resume went, in a new `resume` field: `{ kind: 'ok' }`, or `{ kind: 'failed', code, message }` with the run's error, e.g. `tool-version-unresolvable` when a tool version the turn started with is gone. The decision stands either way. Before, a failed resume was dropped silently.
  - **`@kindgi/agents` exports `turnFailureMessage(error)`** (and `parseFailureMessage`). It writes a turn's error as a run's failure message, the form `parseFailureMessage` reads back. A runtime that ends a run from outside its turn uses it, so the run reads as that typed error.
- e2ba026: Retention policies are checked when they're published, a tenant has one per domain, and the retention routes are in the API reference and both clients.
  
  - **`POST /v1/policies` validates a `retention` spec** (`{ v: 1, doc }` or bare): an unknown domain, `mode: "archive"` (not implemented) or a bad grace is `400 validation-failed` naming the field, e.g. `policy.spec/doc/domain must be one of: org, agent, … (got "blocks")`. Before, they were stored and every sweep skipped them.
  - **One retention policy per domain**, plus one for `*`. A second policy id for a covered domain is `409 policy-scope-taken` (`details.heldBy` names the policy that covers it: publish a new version of that one, or unregister it first); a new version can't move a policy to another domain (`409 policy-scope-changed`); reinstating a retired policy whose domain another now covers is `409 policy-scope-taken`. `@kindgi/policy-contract` exports `policyScope` (a retention policy's scope is its domain) and `retentionSpecDoc`; `PolicyRegistryBinding.publish` and `reinstateVersion` gain the `scope-taken` and `scope-changed` outcomes, which the binding enforces under a lock. A runtime that doesn't enforce it yet answers as before.
  - **Policies stored before that rule** can still cover one domain twice: the policy whose latest version is highest applies, then the lower policy id. `GET /v1/retention/scheduled` and the sweeps report them in `conflicts` (`RetentionPolicyConflict`: the domain, the policy ids, the one that applies).
  - **The retention routes are in the OpenAPI spec**: `GET /v1/retention/scheduled`, `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}`. The TypeScript client has `client.retention.scheduled()` and `client.retention.sweep({ domain?, maxPerDomain? })`; the Python client has `client.retention.scheduled()`, `.sweep()` and `.sweep_domain(domain)`, and raises `ConflictError` for `policy-already-registered`, `policy-scope-taken` and `policy-scope-changed`.
- 1bec998: `GET /v1/retention/scheduled` pages like the other lists. `limit` caps the rows per domain, and the page now says `hasMore` when some domain has more than it returned, with a `nextCursor` to pass back as `cursor` when the runtime can continue. Both clients take `cursor`, so Python's `paginate(client.retention.scheduled, …)` pages through. Against a runtime that doesn't page yet, the API derives `hasMore` from whether a domain filled `limit`, and the TypeScript client from whether a `nextCursor` came.
- 62608e3: **Unregister stops a version being chosen, not the pins that hold it.**
  
  - **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
    - Only its exact version (`getVersion`, `hasVersion`) reaches it.
    - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
  - **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
  - **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
  - **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.
- 3e427c5: `kindgi runs resume <run-id>` says what a run waits for before it resumes, with an exit code per answer:
  - **0:** the run isn't waiting (running, or finished).
  - **3:** it waits for an approval. The command names the approval and the command that decides it (`kindgi approvals complete <id> --decision=approve` or `--decision=reject`).
  - **4:** it waits on the runtime: a queued start, a child run, a scheduled retry and when, or a lease another run holds. A wait no approval matches is also 4, with a line pointing to `kindgi approvals list --status=pending`.
  - **5:** reserved for a held run.
  
  It reads the run, its journal's open waits, and the approvals linked to them. The never-wired `--waitpoint` and `--value` flags are gone.
  
  `GET /v1/approvals` takes `waitTokenId`, repeatable and at most 50: only approvals linked to those run waits. `ListApprovalsBindingInput.waitTokenIds` carries it to the binding. The TypeScript client's `approvals.list({ waitTokenIds })` and the Python client's `approvals.list(wait_token_id=[…])` send it.
- f90c285: A comparison's result is typed in both clients. `openapi.json` names its shape as `JudgedComparisonResult`: the `summary` (`JudgedComparisonSummary`, with `ComparisonCandidate` and each `ComparisonMetric`) and each case (`ComparisonCaseResult`). `EvalRun.result` stays an open object, since each kind of eval run has its own.
  
  The TypeScript client exports the types and `comparisonOf(run)` (also from `@kindgi/sdk/client`), which returns a `judged` eval run's result as `JudgedComparisonResult`, or `undefined` for another kind of run, a dry run, or one not finished. The Python client has `comparison_of(run)`, which returns the validated `models.JudgedComparisonResult`, or `None`.
- cfba46a: One name for a version's calls on every resource. `agents.versions.reinstate`, `tools.versions.list / get / unregister / reinstate` and `flows.versions.list / get / unregister / reinstate` join `blocks.versions` and `evalSuites.versions`; `flows.versions.unregister` returns `{ flowId, version, unregistered }`. `policies.publish` matches the Python client. The old names keep working, marked `@deprecated`, and will be removed in 0.2: `agents.reinstateVersion`; `tools.listVersions`, `getVersion`, `unregisterVersion` and `reinstateVersion`; `flows.versions(id)`, `getVersion`, `delete` and `reinstateVersion`; and `policies.author`.
  
  The Python client gains `eval_suites.unregister(suite_id, version)`, as `agents.unregister`, beside `eval_suites.versions.unregister`.
- ffb6096: Unregistering an agent version that's live in a scope is refused with `409 agent-version-live`. The error's `details.scopes` lists the scopes it serves; roll back, unpin, or promote another version there first. Unregister stops a version being chosen, and a live pin is a standing choice, so the pin moves first and a scope never drops to the one above without anyone deciding it. `AgentUnregisterOutcome` gains an optional `live` (the scopes), which a runtime's registry sets; a registry that knows no live versions answers as before. The TypeScript and Python clients read the code as a conflict.
- ae417f7: A flow's agent step that runs the version its flow version holds records `via: 'flow-pin'` on its turn (`Run.agent.via`), not `explicit`: the node's `config.version`, else the version the flow version pinned when it was published. `explicit` now means only a version named on the run itself. In the TypeScript and Python clients, `via` gains the value.

## 0.1.4-rc.5

### Patch Changes

- d69c8e9: The Python client takes a model's id straight back: every id parameter (a path or query parameter named `…Id`, or one the API declares as a UUID) accepts `str | UUID`. The models carry ids as `UUID`, so `kindgi.runs.get(run.id)` and `kindgi.approvals.complete(approval.id, decision="approve")` now type-check under pyright and mypy; they always worked at runtime. Lists of ids accept `list[str | UUID]`.
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

## 0.1.4-rc.4

### Patch Changes

- 5608264: A gated scope holds its own live version, and a change above it can't move it without its gate.
  
  - **Publishing or reinstating a gate policy** for a scope with no pin of its own is refused (`409 gate-policy-scope-unpinned`), even when a scope above it is pinned. A promotion there would otherwise change the gated scope without its gate.
  - **A promotion, rollback or unpin** that would also move a narrower gated scope with no pin of its own (one gated before this rule) is refused with the new `409 gate-policy-descendant-unpinned`. The message names each such scope and its current version: pin it there first. A gated promotion's approval re-checks this, and is `superseded` if it would.
  - **A pin in place skips the gate.** Promoting a scope that has no live version of its own to exactly the version it serves now (the fix the new 409 asks for) changes nothing any run gets. So the gate's checks and approval don't apply: it's `201`, with one passing `pinInPlace` check, the policy recorded, and a reason starting `pin-in-place`; `…/promotions/check` says the same. `PromotionRequestInput.gate.pinInPlace` tells the binding, which re-checks it as it writes (`409 promotion-superseded` if the scope moved).
  - **The follower guard only refuses a real change:** a promotion that leaves a gated follower on the version it already serves goes through.
  - **Unpinning a gated scope's own pin** is `409 gate-policy-needs-pin`: unregister the gate policy first, or roll back instead.
  - **Clients:** `gate-policy-descendant-unpinned` is a conflict in TypeScript and Python, like the other gate codes.

## 0.1.4-rc.3

### Patch Changes

- 3e427c5: `kindgi runs resume <run-id>` says what a run waits for before it resumes, with an exit code per answer:
  - **0:** the run isn't waiting (running, or finished).
  - **3:** it waits for an approval. The command names the approval and the command that decides it (`kindgi approvals complete <id> --decision=approve` or `--decision=reject`).
  - **4:** it waits on the runtime: a queued start, a child run, a scheduled retry and when, or a lease another run holds. A wait no approval matches is also 4, with a line pointing to `kindgi approvals list --status=pending`.
  - **5:** reserved for a held run.
  
  It reads the run, its journal's open waits, and the approvals linked to them. The never-wired `--waitpoint` and `--value` flags are gone.
  
  `GET /v1/approvals` takes `waitTokenId`, repeatable and at most 50: only approvals linked to those run waits. `ListApprovalsBindingInput.waitTokenIds` carries it to the binding. The TypeScript client's `approvals.list({ waitTokenIds })` and the Python client's `approvals.list(wait_token_id=[…])` send it.

## 0.1.4-rc.2

### Patch Changes

- 0b1f48d: `GET /v1/audit/authz` takes `?order=asc|desc`. `asc` (the default, as before) lists the oldest decisions first; `desc` lists the newest first, and `nextCursor` continues in the same order. Any other value is `400 bad-input`. The TypeScript client's `audit.authz.list({ order })` and the Python client's `audit.authz.list(order=…)` send it. `AuditEventBinding.query` takes an optional `order` (`AuditEventOrder`); the in-memory binding implements it, and a binding that doesn't pages oldest first.
- 9a7f43b: A comparison's live baseline names its segments as a path, the way live versions resolve them: `baseline: { live: { projectId, segments: [{ key, value }, …] } }`, coarse to fine. It was an unordered object (`{ tier: 'gold' }`), so a path's order was lost. `segments` follows the rules of a run's and a pin's segment path (lowercase keys, each key once, at most 8), needs `projectId`, and anything else is `400 bad-input`. The CLI's `eval-runs start --baseline-segment` takes `<key>:<value>` (it took `<key>=<value>`), once per step in order, and needs `--baseline-project`. A live baseline is still refused when the run starts (only `recorded` runs today).
- 4287798: `kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]` registers a tool manifest (the tool minus its handler, which the runtime must already have) at its version, in the tenant's Default project or the one named. Before, it failed with "not yet wired". The TypeScript client gains `client.tools.register(manifest, { projectId })` (`POST /v1/tools`), as the Python client has.
- fcc6a97: An error code a client doesn't list is read by its HTTP status. Until now any newer code, such as a 404 `org-not-found`, became a server error. Now, in the TypeScript and Python clients:
  - 404 and 410 are a not-found (the resource's kind comes from the code: `org` for `org-not-found`);
  - 401 and 403 are an auth error (unauthenticated or forbidden);
  - 429 is rate-limited;
  - 400 is an invalid request.
  
  Codes the clients list keep their class; the list now also has the 409 codes of the already-registered family (`eval-suite-already-registered`, `policy-already-registered`, `mcp-endpoint-already-registered`, `identity-provider-already-registered`, `version-already-exists`, `eval-run-already-terminal`, `approval-already-decided`, `judge-class-name-taken`), conflicts like their listed siblings, the promotion gate's 409s (`promotion-superseded`, `gate-policy-already-registered`, `gate-policy-scope-taken`, `gate-policy-scope-changed`, `gate-policy-scope-unpinned`, `gate-policy-needs-pin`) are conflicts too, and the TypeScript client now also lists `policy-scope-taken` and `policy-scope-changed`, as the Python client did. 409 and 422 codes they don't list stay server errors, matched by their code, as the docs show (`budget-exceeded`, `agent-version-mismatch`). In TypeScript, every error from the server now carries the wire code as `serverCode`, whatever its family (Python's `server_code` already did). `@kindgi/api`'s OpenAPI document lists every error code and its status as `WireError['x-error-codes']`, and the clients' tests check against it.
- c7e27fb: `@kindgi/client`'s published types declare as values only what the package exports at runtime. The generated wire schemas (`LivePin`, `LiveScope`, `Promotion`, `GatePolicy`, `RunProgress`, `Block` and the others) are types; the bundled `.d.ts` also declared each as an exported `const`, so `LivePin.parse(…)` compiled and then failed at runtime (the module has no `LivePin`). Using one as a value is now a compile error ("'LivePin' only refers to a type"); importing them as types is unchanged.
- fd011d4: The published types export each name once. Sixteen names (`ConversationMessage`, `EvaluationResult`, `Fact`, `GeneratedWebhookSecret`, `MessageRole`, `ProvidersClient`, `ReviewerRole`, `RevokeSigningKeyResult`, `RunFinishedEvent`, `TrustedSigningKey`, and the `Webhook*` types `WebhookDelivery`, `WebhookDeliveryStatus`, `WebhookEndpoint`, `WebhookEvent`, `WebhookSecretRef` and `WebhookTestEvent`) were exported twice, beside an internal type of the same name. With `skipLibCheck: false`, an app no longer gets `TS2484`; with it on, `ConversationMessage`, `EvaluationResult`, `Fact` and `ProvidersClient` now mean the client's own types, where they could resolve to the internal ones.
- e97958c: Conversation lists leave a comparison's replay conversations out, as run lists leave out replay runs. `GET /v1/conversations` takes `replays=exclude|include|only` (default `exclude`); a replay conversation is one whose `metadata` has `replayOf`. `ListConversationsPageInput.replays` passes it to the binding (absent: include, for internal callers).
  
  The TypeScript client's `conversations.list` and the Python client take `replays`. `kindgi conversations list` now lists, with `--status`, `--replays`, `--limit` and `--cursor` (the other `conversations` commands stay unwired).
- f8deed1: `client.cost.usage.summary()` takes `limit`, the most groups to return (the most expensive ones), as the API's `?limit=` and the Python client's `limit=` do. The result's `truncated` and `totalGroups` say when there were more.
- 8491dd8: A judge class can be restricted to some judges. `assertableBy` on `POST /v1/judge-classes` and `PATCH /v1/judge-classes/{judgeClassId}` (`null` on the PATCH lifts it) takes `minReviewerRole`, `principalKinds` and `principalIds`, and a caller must meet each one given. A judgment that names a restricted class its caller doesn't meet is `403 judge-class-not-allowed`, and the message says why. A judgment recorded under a restricted class carries `restricted: true`; adding or lifting a restriction later doesn't change it. A test set's items carry `restricted`: the yes and total weight of those judgments alone.
  
  A comparison takes `classWeights`: `as-recorded` (the default, every judgment at its class's weight) or `restricted-only` (only judgments carrying `restricted` count; an item with none counts as unjudged). The summary records which one it used. A gate policy's spec takes `onlyRestrictedClasses`: the promotion's comparison must be `restricted-only` (check `classWeights.restrictedOnly`), so a class anyone may assert can't move the gate.
  
  `@kindgi/api` exports `whyNotAssertable`, `JudgeClassAssertableBy`, `JudgeClassAsserter` and `EvalClassWeights`. The TypeScript client's judge-class types take `assertableBy`, and `evalRuns.start` takes `classWeights`. The Python client sends both (`assertable_by=None` lifts a restriction). The CLI's `judge-classes add` and `set` take `--min-reviewer-role`, `--principal-kind` and `--principal-id`, `set --unrestricted` lifts the restriction, and `eval-runs start` takes `--class-weights`.
- ba55da0: A list page carries its list once: `items`, the deprecated name for `data`, is still readable (`page.items`, until 0.2) but is no longer an own enumerable property, so `JSON.stringify(page)`, a spread, and the CLI's JSON output show `data` alone. Before, every list page printed its list twice.
- 933e00a: Every list call answers in one shape, the wire's page: `data`, `hasMore` and `nextCursor`, as the API and the Python client have it. The calls that answered `{ items, nextCursor }` (adapters, approvals, artifacts, capabilities, conversations, cost, events, flows, guardrails, judge classes, judgments, MCP, memory, observations, packs, policies, provenance, supervisor, tokens, tools and users) now answer `data` and `hasMore` too. `items` keeps working, marked `@deprecated`, and will be removed in 0.2. The client exports the page type as `ListPage<T>`.
  
  `GET /v1/env`, `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` send `hasMore`, and `GET /v1/auth/providers` sends `hasMore: false` (the list comes whole). Against an older server without it, both clients derive `hasMore` from `nextCursor`, so Python's `paginate(client.env.list, …)` and `paginate(client.secrets.list, …)` page through.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ba2f212: `GET /v1/observations`'s `agentVersion`, `conversationId`, `since` and `until` filters, which the route already read, are in the OpenAPI spec, so the Python client's `observations.list` takes them. `kindgi observations` and `kindgi proposals` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't record supervisor observations or draft fix proposals yet. A reason given for a group covers each of its commands.
- 42a2e66: Promotions go through a gate (evals step 4b). A **gate policy** says what a promotion of an agent for a scope must show: a recent comparison of that exact version against the one live there, with enough judged evidence, metrics that reach a floor or drop no more than allowed, clean replays, and optionally a reviewer's approval.
  
  - **`/v1/gate-policies`**: publish (`{id, version, agentId, scope, spec}`), list, get, `versions` list / get / unregister / reinstate. One policy per agent and scope (`409 gate-policy-scope-taken`, `details.heldBy`); the most specific scope with a policy applies. The `spec` is checked strictly. Writes need `admin` on the tenant.
  - **`POST /v1/agents/{id}/promotions`** checks the scope's policy against the comparison named by `evalRunId`. It answers `201` (`status: 'promoted'`), `202` (`status: 'pending-approval'`, with `approvalId`: a reviewer approves it, and the version goes live if nothing changed meanwhile), or `422 gate-failed` with every check in `details.checks`. The refusal is recorded too. A promotion now carries `status`, `policy`, `checks`, `approvalId` and `resolvedAt`. With no policy for the scope, nothing changes.
  - **`POST /v1/agents/{id}/promotions/check`** answers what the gate would say (`would-promote`, `needs-approval`, `gate-failed`), recording nothing. **`GET /v1/agents/{id}/gate-policy`** answers the policy that applies to a scope.
  - **A comparison's summary records the candidate's `pinsDigest`**, so the gate can tell the promoted version ran exactly what was compared. A comparison recorded before this has none, and the gate asks for it to be re-run.
  - The TypeScript client has `gatePolicies.*`, `agents.promotions.check` and `agents.gatePolicy.resolve`; the Python client has `gate_policies`, `agents.promotions.check` and `agents.gate_policy.resolve`. The CLI has `kindgi gate-policies list | show | versions | publish | unregister | reinstate`, `kindgi agents gate-policy` and `kindgi agents promote --check`.
- dc5cfb1: **A decision whose run couldn't go on says so.**
  
  - **`POST /v1/approvals/{id}/complete`** now reports how the inline resume went, in a new `resume` field: `{ kind: 'ok' }`, or `{ kind: 'failed', code, message }` with the run's error, e.g. `tool-version-unresolvable` when a tool version the turn started with is gone. The decision stands either way. Before, a failed resume was dropped silently.
  - **`@kindgi/agents` exports `turnFailureMessage(error)`** (and `parseFailureMessage`). It writes a turn's error as a run's failure message, the form `parseFailureMessage` reads back. A runtime that ends a run from outside its turn uses it, so the run reads as that typed error.
- e2ba026: Retention policies are checked when they're published, a tenant has one per domain, and the retention routes are in the API reference and both clients.
  
  - **`POST /v1/policies` validates a `retention` spec** (`{ v: 1, doc }` or bare): an unknown domain, `mode: "archive"` (not implemented) or a bad grace is `400 validation-failed` naming the field, e.g. `policy.spec/doc/domain must be one of: org, agent, … (got "blocks")`. Before, they were stored and every sweep skipped them.
  - **One retention policy per domain**, plus one for `*`. A second policy id for a covered domain is `409 policy-scope-taken` (`details.heldBy` names the policy that covers it: publish a new version of that one, or unregister it first); a new version can't move a policy to another domain (`409 policy-scope-changed`); reinstating a retired policy whose domain another now covers is `409 policy-scope-taken`. `@kindgi/policy-contract` exports `policyScope` (a retention policy's scope is its domain) and `retentionSpecDoc`; `PolicyRegistryBinding.publish` and `reinstateVersion` gain the `scope-taken` and `scope-changed` outcomes, which the binding enforces under a lock. A runtime that doesn't enforce it yet answers as before.
  - **Policies stored before that rule** can still cover one domain twice: the policy whose latest version is highest applies, then the lower policy id. `GET /v1/retention/scheduled` and the sweeps report them in `conflicts` (`RetentionPolicyConflict`: the domain, the policy ids, the one that applies).
  - **The retention routes are in the OpenAPI spec**: `GET /v1/retention/scheduled`, `POST /v1/retention/sweep` and `POST /v1/retention/sweep/{domain}`. The TypeScript client has `client.retention.scheduled()` and `client.retention.sweep({ domain?, maxPerDomain? })`; the Python client has `client.retention.scheduled()`, `.sweep()` and `.sweep_domain(domain)`, and raises `ConflictError` for `policy-already-registered`, `policy-scope-taken` and `policy-scope-changed`.
- 1bec998: `GET /v1/retention/scheduled` pages like the other lists. `limit` caps the rows per domain, and the page now says `hasMore` when some domain has more than it returned, with a `nextCursor` to pass back as `cursor` when the runtime can continue. Both clients take `cursor`, so Python's `paginate(client.retention.scheduled, …)` pages through. Against a runtime that doesn't page yet, the API derives `hasMore` from whether a domain filled `limit`, and the TypeScript client from whether a `nextCursor` came.
- cfba46a: One name for a version's calls on every resource. `agents.versions.reinstate`, `tools.versions.list / get / unregister / reinstate` and `flows.versions.list / get / unregister / reinstate` join `blocks.versions` and `evalSuites.versions`; `flows.versions.unregister` returns `{ flowId, version, unregistered }`. `policies.publish` matches the Python client. The old names keep working, marked `@deprecated`, and will be removed in 0.2: `agents.reinstateVersion`; `tools.listVersions`, `getVersion`, `unregisterVersion` and `reinstateVersion`; `flows.versions(id)`, `getVersion`, `delete` and `reinstateVersion`; and `policies.author`.
  
  The Python client gains `eval_suites.unregister(suite_id, version)`, as `agents.unregister`, beside `eval_suites.versions.unregister`.
- ffb6096: Unregistering an agent version that's live in a scope is refused with `409 agent-version-live`. The error's `details.scopes` lists the scopes it serves; roll back, unpin, or promote another version there first. Unregister stops a version being chosen, and a live pin is a standing choice, so the pin moves first and a scope never drops to the one above without anyone deciding it. `AgentUnregisterOutcome` gains an optional `live` (the scopes), which a runtime's registry sets; a registry that knows no live versions answers as before. The TypeScript and Python clients read the code as a conflict.
- ae417f7: A flow's agent step that runs the version its flow version holds records `via: 'flow-pin'` on its turn (`Run.agent.via`), not `explicit`: the node's `config.version`, else the version the flow version pinned when it was published. `explicit` now means only a version named on the run itself. In the TypeScript and Python clients, `via` gains the value.

## 0.1.4-rc.1

### Patch Changes

- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
- f90c285: A comparison's result is typed in both clients. `openapi.json` names its shape as `JudgedComparisonResult`: the `summary` (`JudgedComparisonSummary`, with `ComparisonCandidate` and each `ComparisonMetric`) and each case (`ComparisonCaseResult`). `EvalRun.result` stays an open object, since each kind of eval run has its own.
  
  The TypeScript client exports the types and `comparisonOf(run)` (also from `@kindgi/sdk/client`), which returns a `judged` eval run's result as `JudgedComparisonResult`, or `undefined` for another kind of run, a dry run, or one not finished. The Python client has `comparison_of(run)`, which returns the validated `models.JudgedComparisonResult`, or `None`.

## 0.1.4-rc.0

### Patch Changes

- c313224: **An agent version is pinned when it's published.** `POST /v1/agents` resolves each of the agent's tool ranges once, to the highest active version the range allows (`pickVersion`). It stores the result on the version as `pins` (`{tools, prompts, settings}`: tool id → exact version) with `pinsDigest` (`sha256:<hex>` of the pins' canonical JSON). Every run of that version uses exactly those tool versions. A new tool version reaches the agent only through a new agent version, and two runs of one agent version always run the same tools.
  
  - **A range that matches no published version refuses the publish:** `400 validation-failed`, with one issue per tool (`/tools/<i>/version`, "publish the tool first").
  - **Pins are set by the runtime, never authored.** `defineAgent` doesn't take them, and a publish body's `pins` is ignored.
  - **`GET /v1/agents/:id/versions/:version` returns `pins` and `pinsDigest`**, as do both clients. Python adds `pins_digest()` in `kindgi.client`, which gives the same string as `pinsDigest()` in `@kindgi/agents`.
  - **Unchanged:** a version published before pins, or by a runtime without a tool registry, has no pins and resolves its ranges per run. `agentsRouter` takes the tool binding as an optional third argument, and `createApp` passes its `toolRegistry`.
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
- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- a311b81: `GET /v1/cost/aggregate` returns at most 1000 groups by default: the most expensive ones. `groups` is ordered by `totalUsd`, highest first (ties by key, groups with no value last); before, the order was undefined and every group came back in one response, one per run for `groupBy=runId` over a long window. `?limit=` takes 1 to 10000 (anything else is `400 bad-input`). The response says when groups were left out: `truncated: true` and `totalGroups`, the count before the cap. `totalUsd`, `totalRecords` and `tokens` still cover every record. For every record, page through `/v1/cost/records`. **A caller that gets more than 1000 groups today gets 1000, with `truncated: true`**, unless it passes a larger `limit`. A `CostBinding` may cap in its own query (`CostAggregateInput.limit`, returning `totalGroups`); one that returns every group is capped by the route. `@kindgi/api` exports `COST_AGGREGATE_DEFAULT_LIMIT` and `COST_AGGREGATE_MAX_LIMIT`. The TypeScript and Python clients take `limit`.
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
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
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- d3dffb5: Comparison eval runs take a flow version as the candidate. On a test set built from a flow's judged runs, `POST /v1/eval-suites/{suiteId}/runs` with `flowRef: { flowId, version }` replays each case on that flow version (from the past run's input) and scores the flow's whole output against the judgments.
  
  A replayed flow stops at a tool call the replay refuses (a write the past run didn't make), so no made-up value reaches its next step. The case ends `stopped`, with what it would have done. It isn't an error and is left out of the metrics. The summary counts these cases in `stopped`, next to `errors`, and the run's status stays `completed` when cases only stopped.
  
  The summary's `candidate` now says what ran, `{ kind: 'agent', agentId, version }` or `{ kind: 'flow', flowId, version }`, and `baseline.versions` names a flow's recorded versions as `{ flowId, version, cases }`. The subject invoker reports a stop through `EvalRunSubjectInvokeOutcome.stopped`.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- b67eee6: A judged flow run keeps what it did, so it can be replayed later. At a flow run's first judgment, its run copy's `context.flow` keeps:
  - every tool call the run made, with its result: at its tool nodes (per loop iteration), in its agent steps' turns, and in its sub-flows (at most 500, with `truncated`);
  - its agent steps (each turn's agent, version and what it retrieved).
  
  `createApp` passes its `flowRegistry` to the judgments routes to tell tool nodes apart. The capture is best effort: a part that can't be read is left out, and the judgment never fails over it. Judging a run needs `write` on the run's project (the route's own description now says so).
- 7a8e764: A duplicate org, team or project slug is a `409 slug-conflict`, not a `500`. `POST /v1/orgs`, `/v1/teams` and `/v1/projects` with a slug the tenant already has, and a `PATCH` to one, answered `500`; now `409 slug-conflict` (`Another project in the tenant has the slug "acme"`, with `details: { resource, slug }`), whether or not the deployment enforces authorization. A second Default project is `409 project-default-already-exists`. A `PATCH` of a missing org, team or project, a member added to a team or project deleted mid-request, and a role change for a non-member answer their `404`s from the binding's outcome instead of matching an error message. The TypeScript and Python clients read both new codes as a conflict (`ConflictError` in Python).
  
  **Breaking for custom platform bindings.** `OrgBinding`, `TeamBinding`, `ProjectBinding`, `TeamMembershipBinding` and `ProjectMembershipBinding` writes no longer reject for a caller mistake; they resolve to an outcome discriminated on `kind`: `create` to `{ kind: 'ok', orgId | teamId | projectId }`, `slug-conflict` or (projects) `project-default-already-exists`; `update` to `ok`, `*-not-found` or `slug-conflict`; a membership's `add` and `updateRole` to `ok`, `team-not-found` / `project-not-found` or `*-membership-not-found`. The types are exported (`OrgCreateOutcome`, `ProjectUpdateOutcome`, …). The in-memory bindings keep slugs unique within a tenant. `TenantHierarchyBinding.addTeamMember` / `addProjectMember` fail with `AddTeamMemberError` / `AddProjectMemberError` (`team-not-found` / `project-not-found`, or `add-failed`), which replace `MembershipMutationError`. A binding of your own needs the same changes; the conformance suites in `@kindgi/platform`'s `tests/` check them.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 3d23304: A project's slug is unique within its org, not the whole tenant: two orgs may each have a project called `intake`. A project without an org has a slug unique among the tenant's projects without one. An org's and a team's slug stay unique in the tenant.
  
  - **`409 slug-conflict`** on `POST /v1/projects` when the org already has the slug. `PATCH /v1/projects/:id` answers it for a new slug, and now also for a move to another org (`orgId`, or `null` for none) where the slug is taken. The message says where: "Another project in its org has the slug …".
  - **Deleting an org** leaves its projects without an org. When one of them has the slug of a project that has none, `DELETE /v1/orgs/:id` deletes nothing and answers `409 slug-conflict` naming the slugs (`details.slugs`); rename or move those projects first. `OrgBinding.delete` may return `{ kind: 'slug-conflict', slugs }` (`OrgDeleteConflict`). A binding that returns nothing deletes as before.
  - The in-memory `ProjectBinding` checks slugs per org, and the binding conformance suite pins the per-org cases.
- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
- bfeabfd: Publishing a policy that nothing applies is refused. `access-control`, `adapter-allowlist`, `rate-limit` and `compliance` are known policy kinds, but no runtime consumer applies them yet, so publishing one changed nothing, silently. `POST /v1/policies` now answers `400 kind-not-applied` for them, naming the kinds it does apply in `details.appliedKinds` (`model-routing`, `retention`, `tool-errors`, `hitl`). Policies of those kinds already stored stay readable, and the list still filters by them. `@kindgi/policy-contract` exports `APPLIED_POLICY_KINDS` and `isAppliedPolicyKind`; `@kindgi/api` re-exports `APPLIED_POLICY_KINDS`.
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
- 62608e3: **Unregister stops a version being chosen, not the pins that hold it.**
  
  - **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
    - Only its exact version (`getVersion`, `hasVersion`) reaches it.
    - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
  - **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
  - **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
  - **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.

## 0.1.3

### Patch Changes

- 2544717: An approval says who decided it, after the decision: on the API, in the run's journal, and in the turn's provenance.
  
  - **API.** `GET /v1/approvals/:id` and `GET /v1/approvals` carry an approval's recorded `decision` (`ApprovalDecisionRecord`): `decision`, `rationale`, `reviewerId`, `reviewerRoleAtDecision`, `decidedAt` and `decidedBy`, the decider as an actor, `user:<userId>`. An open approval, or one that ended without a decision (expired, or escalated by a timeout), has none. The TypeScript client types it (`Approval.decision`, `ApprovalDecisionRecord`), and the Python client models it.
  - **Journal.** `POST /v1/approvals/:id/complete` resumes the run with `{ decided, rationale?, decidedBy, approvalId }` (`GateDecisionValue`, exported by `@kindgi/agents`), so the run's journal records who decided which approval. `readGateDecision` reads `decidedBy` and `approvalId` when they're there; a value without them still decides. Another subject's explicit `value` is resumed as given.
  - **Provenance.** A tool call that waited on an approval has a `wait` node (`tool-hitl-gate-wait:<invocationId>`, the agent parked, at the time it parked) `resumed-from` a `resume` node (`tool-hitl-gate-resume:<invocationId>`, at the time the decision came; its `actor` is whoever decided, and its attributes the decision, rationale and `approvalId`). The call `waited-on` the wait, and its result was `caused-by` the resume. A resumed turn reads them from its journal, so every call shows its approval, those decided before an earlier park too. The session gate's `resume` node names whoever decided as its `actor` (the agent, for a decision recorded before it was named), with the `approvalId`.
  - **For a custom `HitlBinding`:** return each approval's `decision` from `getApproval` and `listApprovals`, with `ReviewDecisionRecord.decidedBy`, for them to show; both are optional, and a binding without them answers as before.
- 629057d: Every model call is recorded, with everything the provider says about it, and the cost API reads it per call, per run tree, and per org.
  
  - **Usage recording.** The agent turn records each model call in a usage sink (`InvokeAgentBindings.usage`, `UsageSink` / `ModelUsageRecord` in `@kindgi/capabilities`) before the step goes on, a call that threw included. The record carries the call id, project, run, agent and version, conversation, step, provider, the model actually called, a fallback flag, status, usage, duration and finish reason; a failed call's error carries the attempts it took. llm-judge guardrails record theirs too (`EvaluationBindings.usage`, `purpose: guardrail-judge:<id>`, with the turn's step and agent version). A dry run records nothing.
  - **A sink that fails** is tried again (`recordModelUsage`; a record is idempotent by call id). An answered call it still can't record fails the step with `persistence-error` (an llm-judge's is `judge-usage-unrecorded`, which the turn fails on the same way). A failed call keeps its own failure, and says when it couldn't be recorded either.
  - **Usage, unfolded.** `UsageCounters` reports the parts of its totals: `cacheReadTokens` and `cacheWriteTokens` are parts of `promptTokens`, `reasoningTokens` of `completionTokens`. A part is there when the provider reports it, a reported 0 included, and absent when it doesn't. `ModelCallResult` adds `servedModel` (the exact version the vendor reports), `providerRequestId`, `attempts` (HTTP attempts, the SDK's own retries included, counted with `createAttemptCounter` from `@kindgi/capabilities/attempts`, a Node-only entry; a call that throws keeps its own error, and `attemptsOf(error)` gives its attempts) and `rawUsage` (the vendor's usage object as it reported it). The Anthropic, Gemini and OpenAI-compatible adapters fill them.
  - **Breaking, for a custom model adapter:** `UsageCounters.cachedTokens` is renamed `cacheReadTokens`.
  - **Breaking, for a custom `CostBinding`:** `tokens` is required on `CostAggregateGroup` and `CostAggregateResult`, and a binding that can't read should throw (the API answers 500) rather than return an empty page.
  - **Cost API (`@kindgi/api`, `@kindgi/client`).** A cost record of a model call carries `callId`, `projectId`, `rootRunId`, `parentRunId`, `agentVersion`, `flowId`, `nodeId`, `step`, `purpose`, `model`, `servedModel`, `fallback`, `status`, `usage`, `durationMs`, `finishReason`, `providerRequestId`, `attempts` and `error`, and `rawUsage` with `include=rawUsage`. New filters: `model`, `servedModel`, `rootRunId`, `includeDescendants` (with `runId`). New `groupBy` dimensions: `model`, `servedModel`, `projectId`, `orgId`, `rootRunId`, `flowId`. Every aggregate group and the total carry `tokens: {prompt, completion, cacheRead, cacheWrite, reasoning}`. A binding that fails answers 500, never an empty page. `to` is exclusive, as the binding always applied it. The TypeScript client takes `scope`, the new filters and `includeRawUsage`.
  - **`run.finished`** carries `usage: {calls, costUsd, tokens}` (`RunTreeUsage`) for the run tree, when the runtime records usage: what the ledger had recorded when the run finished, failed calls counted (a child run still running then isn't in it).
  - **Clients:** `includeDescendants` is a boolean query parameter; the Python client names a cost record's error `ModelCallError`.
  - **Provenance (breaking for readers of `model-call` attributes):** a `model-call` node keeps the call's identity (`callId`, `providerId`, `model`, `finishReason`, `step`); its `promptTokens`, `completionTokens` and `costUsd` are gone from `attributes`. A provenance read carries them in `callUsage`, by `callId`, from the cost ledger, outside the signed DAG (`ProvenanceBinding.getCallUsage`). A signed export includes `callUsage` as it stood when signed (bundle schema `1.1.0`).
- 1463b77: Approvals, conversations and provenance list by project, as runs do. `GET /v1/approvals`, `GET /v1/conversations` and `GET /v1/provenance` take `scopeKind=project|org` + `scopeId`: one project's records, or every project's in an org. A `scopeId` that isn't a UUID is `400 scope-invalid`. The records say their project:
  - an agent's approvals are enqueued in the turn's project (`HitlEnqueueInput.projectId`);
  - a conversation has `projectId`, set by the run that opens it or by `POST /v1/conversations`' new `projectId` (one of the tenant's projects, else `400 bad-input`; omitted, the tenant's Default project, as for a run); `agent_conversations` gets a nullable `project_id` (migration `0003`);
  - a provenance record's list row has `projectId`, which the emitter passes beside the signed document (`ProvenanceEmitBinding.emit(provenance, { projectId })`).
  
  `ListScope` (`@kindgi/types`) is the scope of each binding's list input. TypeScript client: `scope` on `approvals.list`, `conversations.list` and `provenance.query`, and `projectId` on `conversations.open`; the Python client takes `scope_kind` / `scope_id` and `project_id` (regenerated). Records from before this release have no project, so only a list without a scope shows them (nothing is backfilled).
- 453056f: A registered reviewer can use the approvals surface with any token of theirs. The approvals routes refused every token that didn't carry a `reviewerRole` itself, so a reviewer signed in through OAuth, or calling with an API key, got 403 on `/v1/approvals`. Now a token with no role of its own takes the role the reviewer roster gives its user (`ReviewerBinding.resolveReviewerRole`), and `GET /v1/identity/whoami` reports the same role. A token with no user, or a user who isn't a reviewer, is still refused, and the 403 says how to register one (`kindgi reviewers register`).
  
  - **For a custom `ReviewerBinding`:** implement the new optional `resolveReviewerRole({ tenantId, userId })` (the user's reviewer role in the tenant, or `null`) for its reviewers' sessions and API keys to work; without it, only a token that carries its role reviews, as before.
- 6bae409: An agent's turn names its agent. The run record of an agent run, and of the turn a flow's agent step starts, carries `agent`: the agent's id, the version that ran and the conversation (`RunAgentRef` in `@kindgi/runtime`, `Run.agent` on the wire, the `RunAgent` schema). `GET /v1/runs?agentId=` lists one agent's turns, at every version; it combines with the scope, `topLevel` and the cursor. The TypeScript client takes `runs.list({ agentId })`; the Python client `runs.list(agent_id=…)`. Turns that ran before this release don't name their agent: they have no `agent` and aren't listed by `agentId`.
- ab23a9b: A run id that isn't one is a 400. `GET /v1/runs/not-a-uuid` (and the run's `progress`, `journal`, `stream`, `progress/stream` and `cancel`) answered `500`, from the database's uuid cast; now `400 bad-input` "`runId` must be a run id (a UUID)", before any query. A `parentRunId` filter that isn't a run id is a 400 too. And the OpenAPI `runs.list` operation declares the `scopeKind` / `scopeId` filter it already took: `ListRunsFilter.scope` in the TypeScript client and `scope_kind` / `scope_id` in the Python client list one project's runs, or every project's in an org. The TypeScript client's scopes (runs, cost, env, secrets, MCP endpoints) take a `ScopeRef`: `{ kind: 'project', projectId }` or `{ kind: 'org', orgId }`, with no `tenantId` needed (the API takes the tenant from the token; a `Scope` with one still fits).

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.

## 0.1.1

No changes in this release.

## 0.1.0

### Minor Changes

- aec851d: API keys are service accounts with a role and capabilities, and they can be listed.
  
  - **`@kindgi/api`:**
    - `POST /v1/tokens` takes `role` (`admin` | `member`, default `member`) and `capabilities`.
      - Only a tenant admin can mint (`admin` on the tenant with authorization on, otherwise the `tenant-admin` scope), and only capabilities the caller holds can be granted.
      - The response is the key's record plus its `token`, shown once.
    - New `GET /v1/tokens` (paged, newest first) and `GET /v1/tokens/{tokenId}`. They're tenant-admin only and never return secrets. Revoke is tenant-admin only too.
    - `TokenAdmin` gains `list` and `get`. `mint` takes `role`, `capabilities` and `createdBy`, and returns `{ record, token }`. New types: `ApiTokenRecord`, `ApiTokenRole`, `API_TOKEN_ROLES`.
    - `TokenResolution.tokenId` is a durable key's id. The principal is then `service_account:<tokenId>`, and it wins over a session id.
  - **`@kindgi/client`:**
    - `tokens.create(spec?)` sends `role`, `capabilities`, `label`, `expiresAt` and `projectId`, and returns the server's record. `ApiTokenSpec` and `ApiToken` drop `name`/`scopes` for `label`/`role`/`capabilities`.
    - `tokens.list({ limit, cursor })` and `tokens.get(id)` are wired.
    - The unwired `tokens.scopes()` and `TokenScope` are gone.
- aec851d: A deployment's tools and guardrails keep where their code is, and the trust list it's verified against gets routes.
  
  - **`@kindgi/api`, `POST /v1/deployments`:**
    - **What registers is the signed image's index.** The server reads `/app/index.json` from the image, checks it hashes to the signed `indexHash`, and registers what it declares. The request body no longer carries `index`. Before, the route validated and registered the body's copy, which no signature covers, so a replayed request could register tools the image never shipped. The image's index must also name the signed `artifactVersion` (`400 image-unverifiable` otherwise).
    - **The code pointer.** A tool's `modulePath` and a guardrail's `checkModulePath` become `codeArtifactRef: { kind: 'oci', imageRef, modulePath, artifactVersion }`, pointing into the deployed image. Before, they were stripped, so a deployed pack tool had no code the runtime could reach.
    - **What a deployment shipped.** The record gains `contents`: each tool's, agent's and flow's `{ id, version }`, and each guardrail's `{ id }`. `DeploymentRegisterInput` and `Deployment` carry it; it's required, so a `DeploymentBinding` stores it. Versions are immutable and a digest deploys once, so the latest deployment is the live one. A rollback rolls forward: deploy the earlier code again under new versions.
    - **The catalog caches hear of it.** A new deployment calls `onToolWrite` / `onGuardrailWrite` for each tool and guardrail it registered, as `POST /v1/tools` and `POST /v1/guardrails` do, so a runtime's tool and guardrail bridges see it at once. `DeploymentContents` and `DeployedPrimitive` are exported.
    - **Indexed guardrails deploy.** A guardrail's `checkId` becomes its `check`, and the index-only `configSchema` is dropped, as `kindgi dev` maps them. Before, every guardrail the indexer writes failed validation.
  - **`@kindgi/api`, `/v1/signing-keys`:** the tenant's trusted signing keys, the public keys whose deployments verify. Mounted when `signingKeyRegistry` is passed, on its own, without the deployments route.
    - `POST /v1/signing-keys` trusts a key: `keyId`, `publicKey` (base64 Ed25519), `label?`. It returns `201`, or `200` for the same key again. A known id with another key is `409 signing-key-conflict`; rotate under a new id.
    - `GET /v1/signing-keys` lists the active keys (`?includeRevoked=true`, `?label=` prefix). `GET /v1/signing-keys/{keyId}` returns one key, revoked or not.
    - `POST /v1/signing-keys/{keyId}/revoke` takes an optional `reason`. A revoked key stays readable for audit and verifies no new deployments.
    - Writes need the `signing-keys:write` capability.
    - Revocation is final: trusting a revoked key id again is `409 signing-key-revoked`.
    - New error codes: `signing-key-conflict` (409), `signing-key-revoked` (409), `signing-key-algorithm-unsupported` (400), `signing-key-store-error` (500).
  - **`@kindgi/client`:** `client.signingKeys` (`trust`, `list`, `get`, `revoke`); `deployments.register` takes no `index`. The Python client's models and resources follow.
  - **`@kindgi/env-schema`:** the `image-registry` group, how the server reads deployment images: `KINDGI_IMAGE_REGISTRY_HOST`, `_USERNAME`, `_PASSWORD` (credentials for one host, all three or none) and `_INSECURE_HOSTS` (hosts reached over plain HTTP).
- aec851d: Flows take plain string ids. `defineFlow`'s `FlowSpec` is now `Unbranded<Flow>`: an author writes `id: 'acme.triage-ticket'`, node `id: 'parse'`, edge `from: 'parse'` with no `as FlowId` / `as NodeId` / `as EdgeId` (and no cast on the whole object); branded ids still fit, and the validated `Flow` is branded. `@kindgi/types` exports `Unbranded<T>` (every branded string in `T` loosened to `string`, all the way down). `runs.start({ flow })` / `({ agent })` take a plain string too.
- aec851d: What a tenant registers can no longer reach the server's own host unless the deployment allows it, and MCP endpoints authenticate through the secrets store.
  
  - **`KINDGI_TENANT_HOST_ACCESS`** (`@kindgi/env-schema`): `deployed` refuses a `stdio` MCP endpoint, a command the server would run in its container as its user. `local` allows it, for a machine where every token holder may run commands. Unset, it's `local` under `KINDGI_DEV` and `deployed` otherwise.
  - **`@kindgi/api`:**
    - `createApp` takes `tenantHostAccess` (default `deployed`). Under `deployed`, registering a `stdio` endpoint answers `403 host-access-denied`, a new error code.
    - `deniesHostReach`, `parseTenantHostAccess`, `TENANT_HOST_ACCESS_LEVELS` and `stdioRefusal` are exported for the runtime's connect-time check. Checks ask `deniesHostReach(level, reach)`, so a stricter level is one more row.
    - `mcpRouter` takes the level as a fourth argument.
  - **`MCPEndpoint.secretRef: { envName, name }` replaces `authRef`.** It's a secret by name in the deployment's store, resolved at the endpoint's tenant scope, the shape webhooks and providers use.
    - `env:NAME` references, which read the server's own environment, are gone.
    - The register body now refuses unknown fields, so an `authRef` is a `400` (`unknown-field`), not silently dropped.
    - The webhook routes and MCP share one `secretRef` parser.
  - **`@kindgi/client`:** `McpEndpoint` and `RegisterMcpEndpointInput` take `secretRef` (`McpEndpointSecretRef`). The Python `kindgi.client` is regenerated: `secret_ref` replaces `auth_ref`.
- aec851d: A tool reads back the way it was registered: the wire shape carries the whole manifest.
  
  - **`@kindgi/api`:**
    - `GET /v1/tools`, `GET /v1/tools/{toolId}` and the versions routes now return `mutating`, `sandbox`, `limits`, `network`, `needsSpec`, `codeArtifactRef` (where the code runs: the deployed image and module) and the declarative `spec`. Before, they dropped them, so nothing reading the API could see where a pack tool's code runs or how it's sandboxed. A secret appears only as a reference (`secretRef`), never a value.
    - The `Tool` schema (and `RegisterToolBody`, `ToolVersionRow`) declares those fields. They were accepted and stored already, but undocumented, so a typed client couldn't send them without a cast.
    - New components: `SandboxMode`, `RuntimeLimits`, `NetworkPolicy`, `TypedNeeds`, `CodeArtifactRef`, `ToolSpec`, and the declarative HTTP tool's `HttpToolSpec`, `HttpHeaderSpec`, `HttpAuthSpec`, `HttpRequestBodySpec`, `ToolSecretRef`. Each is a mirror of `@kindgi/specs/tool.schema.json`. The schema drift test now holds Tool's property names, and each of these, equal to the spec.
  - **`@kindgi/client`:** the tool types gain the fields. The Python client's models follow.
- aec851d: Fallback providers. `ProviderMetadata.fallback: true` makes a provider serve a capability only when no other provider satisfies it; `route()` then reports `fallback: true`, and a fallback is never an alternate to a regular pick. An agent turn routed to one carries a `fallback-provider` warning (`AgentTurnResult.warnings`). `dev-echo` is a fallback, so registering a real model takes over from it with nothing to switch off — before, ties went to the provider id that sorts first, and `dev-echo` beat `gemini`, `groq` or `ollama`. `POST /v1/providers` accepts and returns `fallback`; the clients carry it. The providers and getting-started skills describe it, and register Anthropic or Gemini with `kindgi providers register --preset` (the CLI's presets).
- aec851d: Public run tokens: a browser can follow a run's progress without a secret API token.
  
  - `@kindgi/api`:
    - `CreateAppInput.publicRunTokens` (`signingKey` + `keyId`, an Ed25519 key; lifetimes; `allowedOrigins`). When set, `POST /v1/runs` returns `publicAccessToken` + `publicAccessTokenExpiresAt` (15 minutes by default), and `POST /v1/tokens/public` mints tokens for up to 50 runs (at most 24 hours).
    - Progress routes: `GET /v1/runs/{runId}/progress` (`RunProgress`: status and timing, no input, output or failure message) and `GET /v1/runs/{runId}/progress/stream` (`RunProgressEvent`: kind, node, sequence, time; no payload). They accept an API token or a public run token. `GET /v1/runs/{runId}` and `/stream` are unchanged and keep requiring an API token.
    - A public run token (`kgi_pt_…`, Ed25519-signed, stateless) is accepted only by the two progress routes (every other route answers 403), for the runs it names and their descendants (others answer 404).
    - The routes a public token may use come from the operation registry (`security: 'bearer-or-public-run'`); the OpenAPI document declares the `publicRunToken` security scheme on them.
    - CORS for `allowedOrigins` on the two progress routes only, ahead of authentication.
    - `mintPublicRunToken` / `verifyPublicRunToken` for deployments that issue tokens themselves.
  - `@kindgi/client`:
    - `subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })`: follow a run's progress from a browser with a public token, refreshing it when it expires.
    - `runs.progress`, `runs.streamProgress`, `tokens.createPublic`.
    - `runs.stream` now follows the run to its terminal event: when the server ends the stream at its time limit, it reconnects from the last event instead of ending early. `followRun` is the shared loop; `readSse` takes `lastEventId` and per-attempt `headers`, and throws `SseHttpError` (with `status`) on HTTP errors.
  - `@kindgi/env-schema`: `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` and `KINDGI_CORS_ORIGINS`.
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
- aec851d: Fine-grained authorization now checks the scope a request acts on. Each route derives its scope once, with the same parser for the check and the handler.
  
  - `/v1/env` and `/v1/secrets`: the check reads `scopeKind` + `scopeId`, the parameters the handlers use. It previously read `projectId` / `orgId` query parameters, which are not part of the API, so a request could be checked against one scope and act on another, and project-scoped callers using `scopeId` were checked against the tenant.
  - `POST /v1/secrets/{name}/rotate`: the scope comes from body `scope`, else from the query; when both are present they must name the same scope (400 `scope-mismatch`), and body `envName` must match query `envName` (400 `env-name-mismatch`). The OpenAPI document now declares the optional `envName`, `scopeKind` and `scopeId` query parameters.
  - `POST /v1/mcp/endpoints`: the check reads body `scopeKind` + `scopeId`, as the handler does. `RegisterMCPEndpointBody` now declares them (`scopeKind` required).
  - Registry lists (`/v1/agents`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites`): a project filter (`scopeKind=project&scopeId=`) requires `read` on that project.
  - Env and secrets routes run one authorization check per request (previously two).
  
  `@kindgi/client`: `mcp.endpoints.register` takes a required `scope` and sends it as `scopeKind` + `scopeId`; the API has always required them, so registering through the client failed before. `not-yet-wired` reasons for `tools.manifests` and `packs.*` are reworded.
- aec851d: The JSON Schemas now describe what the code accepts (agent 1.1.0, capability 1.1.0, flow 1.9.0, guardrail 1.1.0, pack 1.1.0). The bundled copies in `@kindgi/capabilities`, `@kindgi/flow` and `@kindgi/guardrails` match.
  
  - **BREAKING — `agent.schema.json` 1.1.0:** `tools` entries are `{ id, version }` references (`version` is an npm semver range), matching `ToolRef` and `defineAgent`. Agent JSON with bare-string tool ids — which `defineAgent` already rejected — now fails schema validation too.
  - **BREAKING — `pack.schema.json` 1.1.0:** a pack agent's `tools` use the same `{ id, version }` references (`agent.schema.json#/$defs/ToolRef`). Pack manifests with bare-string tool ids now fail validation.
  - **`capability.schema.json` 1.1.0:** new optional `kind` (default `llm-inference`), which the router already reads, and a `models` requirement (`{ models: { allow?, deny? } }`) next to `providers`. `defineCapability` validates through this schema, so it now accepts both.
  - **BREAKING — `flow.schema.json` 1.9.0:** the top-level `triggers` array is gone. No code read it — schedules, event triggers and webhooks are registered through their own APIs and name the flow they start. Flow JSON that still declares `triggers` now fails `loadFlow`.
  - **BREAKING — `guardrail.schema.json` 1.1.0:** `check` is required, as in the `Guardrail` type (`defineGuardrail` already failed without a registered check), and a `retry` action requires `maxAttempts`. `POST /v1/guardrails` rejects a spec without `check`.
  - **`guardrail.schema.json` 1.1.0 (widening, not breaking):** `kind` and `on-violation` accept any non-empty string — the built-ins are listed as `examples` — so `defineGuardrail`, `validateGuardrailSpec`, the API and the client accept adapter kinds and custom actions. `defineGuardrail` still requires a registered check of the guardrail's kind, and still checks the action's shape. The schema also allows `sandbox`, `limits`, `network` and `needsSpec`, which the type declares, with the same shapes as on tools.
  - **`@kindgi/guardrails`:** when `evaluateGuardrail` runs with `EvaluationBindings.actions` and the fired action has no registered handler, it returns the new `unknown-action` error naming the action (after the violation is recorded) instead of skipping the action silently.
  - **`@kindgi/api` / `@kindgi/client`:** the `Guardrail` wire schema and client types require `check` and `retry.maxAttempts`, and take `kind` / `on-violation` as open strings.
  - **`@kindgi/specs` README:** until the first stable release, a breaking schema change is a minor bump with a version-history note; the major-`$id` rule applies from 1.0.0.
- aec851d: Outbound webhooks: endpoints that receive a signed `run.finished` event when a top-level run completes, fails or is cancelled.
  
  - `@kindgi/api`:
    - `WebhookEndpointBinding` (caller-plugged) and `/v1/webhook-endpoints`: create (the response carries the signing secret, once), list, get, update, `unregister`, `rotate-secret`, the delivery log (`/deliveries`, with a status filter), `redeliver`, and `test` (queues a `webhook.test` event).
    - Endpoint filter: `projectId`, `flowIds`, `includeDryRuns`. Child runs never produce `run.finished`.
    - Event bodies (`RunFinishedEvent`, `WebhookTestEvent`) carry the run's identity and outcome (`FinishedRun`), never its input or output. The OpenAPI document describes them under `webhooks`.
    - Error codes: `webhook-endpoint-not-found`, `webhook-delivery-not-found` (404), `webhook-url-refused` (400).
  - `@kindgi/crypto`: Standard Webhooks signatures (`v1`, HMAC-SHA256): `signWebhook`, `webhookHeaders`, `verifyWebhook` (timestamp tolerance, several signatures during a secret rotation, constant-time comparison) and `generateWebhookSecret` (`whsec_…`). Checked against the reference implementation both ways.
  - `@kindgi/client`: `client.webhookEndpoints`. The unused outbound shapes `Webhook`, `WebhookSpec`, `WebhookSecret`, `WebhookDelivery`, `WebhookVerifyResult` and the `WebhookId` / `WebhookDeliveryId` brands are replaced by the generated wire types and `WebhookEndpointId`; `SubscriptionSpec`'s webhook target is `{ kind: 'webhook', endpoint }`.
  - `@kindgi/types`: `WebhookEndpointId` and `WebhookEventId`. `WebhookId` is documented as what it is: the routable id of an inbound webhook trigger.
- aec851d: Webhook endpoints reference their signing secret by name instead of generating and returning one.
  
  - `@kindgi/api`:
    - Endpoints take `secretRef: { envName, name }`, a secret in the deployment's secrets store (resolved at tenant scope), like a provider's `secret_ref`. The secret is shared with the receiver, so it lives with the deployment's other secrets: `.env` in development, the secrets store in production. Endpoints show `secretRef`; `secretHint` is gone.
    - Create and update check that the secret exists and is strong (`400 webhook-secret-not-found`, `400 webhook-secret-too-weak`). `create` returns the endpoint (no secret).
    - `POST /v1/webhook-endpoints/generate-secret` returns a strong secret to store; nothing is kept.
    - `POST /v1/webhook-endpoints/{endpointId}/rotate-secret` and `WebhookEndpointWithSecret` are removed: rotating is rotating the referenced secret (`POST /v1/secrets/{name}/rotate`), and for a day deliveries are signed with both versions.
  - `@kindgi/client`: `webhookEndpoints.create` takes `secretRef` and returns the endpoint; `webhookEndpoints.generateSecret()`; `rotateSecret` is removed.
  - `@kindgi/crypto`: `isStrongWebhookSecret` and `WEBHOOK_SECRET_MIN_BYTES` (24).

### Patch Changes

- aec851d: `runs.start()` returns `StartedRun`: the run plus `publicAccessToken` and `publicAccessTokenExpiresAt`, which `POST /v1/runs` returns when the deployment issues public run tokens. TypeScript callers no longer need a cast to hand the token to a browser.
- aec851d: The OpenAPI run status says `pending` where it said `queued`. The server sends `pending` for a run that hasn't started yet, which is what `options.wait: false` answers, and a validating client (the Python client, or one generated with runtime validation) refused that response. A test now holds the document to the runtime's `RunStatus`.
- aec851d: Gemini on Vertex AI, and providers that carry their connection settings.
  
  - `@kindgi/adapter-model-gemini` (new): a Gemini `ModelProvider` on Vertex AI, through `@google/genai`.
    - **Credentials:** Google Application Default Credentials (a `gcloud` login on a laptop, the attached service account on Cloud Run), or a service-account key.
    - **Function calling:** tool ids go over the wire unchanged; each call's thought signature is kept and sent back on the next request.
    - **Tokens:** thinking parts are left out of the text, and thinking tokens count as completion.
    - **Cost:** cached-prompt and long-context rates.
    - **For servers:** `geminiAdapterFactory` reads `adapter_config.project`, and uses `metadata.region` as the location.
  - `@kindgi/capabilities`:
    - `AdapterFactoryInput.config` (`AdapterConfig`): an adapter's flat, non-secret connection settings.
    - `ModelToolCall.signature`: an opaque token a provider attaches to a tool call and needs back when the conversation continues.
  - `@kindgi/api`:
    - `POST /v1/providers` takes `adapter_config`. The binding receives it as `adapterConfig` and returns it from `resolveForRuntime`; `list` and `get` never return it.
    - The OpenAPI `RegisterProviderBody` now describes the actual body, `{ metadata, adapter_id, secret_ref?, adapter_config? }`; it used to describe `ProviderMetadata`.
    - `ProviderCost` allows adapter-specific rate fields.
  - `@kindgi/client`: the generated `RegisterProviderBody` follows.
  - `@kindgi/sdk`: the providers skill covers Gemini on Vertex, and `adapter_config`. It also notes that the OpenAI-compat adapter isn't registered by the runtime yet.
- aec851d: Client requests now match what the API accepts.
  
  - `agents.define(spec, { projectId, idempotencyKey? })`, `flows.define(flow, { projectId, idempotencyKey? })`, `guardrails.author(spec, { projectId, idempotencyKey? })`, `evalSuites.publish(input, { projectId, idempotencyKey? })` and `evalRuns.start(suiteId, input, { projectId, idempotencyKey? })` send `projectId` in the request body. `POST /v1/agents`, `/v1/flows`, `/v1/guardrails`, `/v1/eval-suites` and `/v1/eval-suites/:suiteId/runs` require it, so a call without it always failed with `400 bad-input`. The options argument is now required (types `DefineAgentOptions`, `DefineFlowOptions`, `AuthorGuardrailOptions`, `PublishSuiteOptions`, `StartEvalRunOptions`); `PublishSuiteInput` and `StartEvalRunInput` leave `projectId` out.
  - `runs.start({ agent, projectId?, … })` sends `projectId` for agent runs too; it was sent only for flow runs.
  - `approvals.list` and `conversations.list` take one `status` (`ApprovalFilter.status` / `ConversationFilter.status` no longer accept an array). The API filters by a single `?status=` and rejected the comma-joined value the client used to send; several statuses are now rejected client-side with `invalid-request`, before any request.
- aec851d: A run blocked by a guardrail now says which one, and clients get it as a typed error.
  
  - `@kindgi/agents`: the `guardrail-violation` message (and the `turn.failed` event's) names each blocking guardrail with its check's reason — `Turn blocked by guardrail 'no-pii': Response contains an email` — instead of only counting them.
  - `@kindgi/client` (re-exported by `@kindgi/sdk`): new `GuardrailViolationError` variant of `KindgiError` (`code: 'guardrail-violation'`, `violations[]` with `guardrailId` / `severity` / `action` / `reason?`, `evaluationErrors[]`). `fromWire()` previously returned it as a generic `ServerError`. Exhaustive `switch (err.code)` statements need the new case.
  - `@kindgi/api`: `POST /v1/runs` sends a binding failure's `details` as the wire error's `details`; they were nested under `details.details`, so clients could not read them.
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
- aec851d: Typed agent output and structured turn input.
  
  - `@kindgi/agents`:
    - **Typed output.** An agent can declare `output: { schema, name?, maxRepairs? }` (JSON Schema, or a Zod schema converted by `defineAgent`).
      - The final answer must be JSON matching the schema; a fenced JSON block is accepted.
      - An answer that doesn't fit is sent back to the model with the problems listed, up to `maxRepairs` times (default 1, counted against `budget.maxSteps`). After that the turn fails with `output-schema-violation` (`errors`, `attempts`).
      - The parsed answer is `AgentTurnResult.output`, or `null` on a dry run, where no answer is checked.
    - `AgentTurnResult.runId` is the turn's kernel run.
    - **Structured input.** `invokeAgent({ input })` makes `{{ input.* }}` available to the instructions (`input` joins `AUTO_INJECTED_VARS`). It is kept in the run snapshot and passed to guardrails as `trace.attributes.stepInput`.
    - **Parent link.** `invokeAgent({ parent })` records the run that started the turn, for turns started by a flow step.
    - **Resume.** The run snapshot keeps `parameters` and `input`, and `resumeAgentTurn` restores them; a resumed turn used to lose its parameters. Migration `0002` adds the two columns to `agent_run_snapshots`.
    - **Guardrail trace.** `buildRunTrace` now takes the run id, project id, turn number and user message. The trace carries them, so failed checks during a turn produce compliance evidence. Before, `runId` was the conversation id, `turnCount` was the step count, and `projectId` was missing. `attributes.steps` replaces `attributes.turnCount`; a typed answer appears as `attributes.structuredOutput`.
    - `defineAgent` keeps `preferredModel`.
  - `@kindgi/specs`: `agent.schema.json` schema-version 1.2.0 adds `output`, `preferredProvider` and `preferredModel`.
  - `@kindgi/handler-runtime`: the indexer carries an agent's `output`, `conversationPolicy`, `preferredModel`, `description` and `tags`.
  - `@kindgi/dev-echo-provider`: a call with no tools gets the last user message back as the answer, instead of a call to an echo tool the agent doesn't have.
  - `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `output` (`AgentOutputSpec`); `output-schema-violation` maps to 422.
  - `@kindgi/client`: the generated agent types carry `output`.
