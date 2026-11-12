# @kindgi/types

## 0.6.0

### Patch Changes

- 6707cb9: **An agent or a flow can be a tool in a person's chat app.** A new optional field, **`mcp`** (`{ expose, readOnly?, destructive? }`), on agents and flows says whether one is offered as a tool, through the API's MCP server, to the people who can see it. An agent's tool is named by its id, a flow's by `flow.` and its id. With `expose: true`, the id must be a tool's name (letters, digits, `_`, `-` and `.`, at most 128 characters, or 123 for a flow), and an agent's can't start with `kindgi.` or `flow.`, the prefixes Kindgi keeps; the error names the prefix. `readOnly` and `destructive` become the tool's `readOnlyHint` and `destructiveHint`; left out, no hint is sent and the chat app applies the protocol's defaults. Absent, nothing changes: an agent or flow without it is stored and answered as before, with no `mcp` key.
  
  It is in `agent.schema.json` (1.8.0), `flow.schema.json` (1.10.0) and `pack-index.schema.json` (1.9.0); `Agent`, `defineAgent` (which refuses an invalid one), `Flow` and `loadFlow` (a new error, `invalid-mcp-exposure`); `McpExposure` and `mcpExposureIssues` in `@kindgi/types`; the indexed pack agent and flow; `POST /v1/agents`, `POST /v1/flows`, their `GET` answers and a deployment's agents and flows (the API's new `McpExposure` schema); and the Python SDK's `Agent(mcp=...)` and `Flow(mcp=...)`. The authoring skills for agents and flows (TypeScript, Python, Java and Scala) say how to set it.

## 0.5.0

### Patch Changes

- 1ed72e3: The doc comments and READMEs call the place a workspace, as the console does, and so do the npm descriptions of `@kindgi/capabilities`, `@kindgi/memory` and `@kindgi/policy-contract` and the types package's `SPEC.md`. What you type keeps `tenant`: `tenantId`, `TenantId` and `forTenant`. So does the multi-tenant text.
- 1365f49: The spec schemas' descriptions, the doc text of the types a pack author reads, and the indexer's `check-id-unprefixed` warning call the place a workspace, as the console does. The policy spec's title is Workspace policy. What you type keeps `tenant`: `tenantId`, the `kindgi-tenant-id` header, `KINDGI_PACK_TENANT_ID`, the scope and context-slot value `tenant`, and error codes such as `pack-tenant-mismatch`. So does the multi-tenant text: a cross-tenant call is still refused by that name.

## 0.4.0

### Patch Changes

- b25b82f: **An agent can be shown stored files: photos, PDFs and text files, from its run's input and from its tools' results.**
  - **A file as a value.** `FileValue` (`@kindgi/types`: `{type: 'kindgi.file', artifactId, …}`) is a stored file inside plain JSON: a run's input `files`, a tool result's top-level `files`, or a conversation message's `files`. `isFileValue` checks its shape: each field's type, a whole size, a lowercase hex sha256, a page count from 1 and a known `notShown` reason. Only `artifactId` is trusted: the runtime shows a file by its own checked record of it.
  - **The turn's files binding.** `InvokeAgentBindings.files` (`FileBindings`) gives a turn the `FileBinding` of its run (`forRun`), once the run has its id: the runtime's rule for which files the turn's model may be shown (`admit`) and how a call reads their bytes (`read`). Without one, a tool result's files stay plain JSON, and an earlier message's files are each a line saying there's no file store.
  - **Where files come from.**
    - **The run's input.** `InvokeAgentInput.files` are the turn's own: the user message keeps the ones the rule admits, so a later turn is shown them too.
    - **A tool's result.** The first 10 file values in its top-level `files` that the rule admits become the tool message's files, and the rest of the result is its text. One the rule refuses, one past the tenth, and anything that isn't a file value stay in the result as plain JSON.
    - **The conversation's history.** Each earlier message's files are asked of the rule again. One it refuses now is a line saying the file is no longer stored.
  - **A file the model couldn't read.** `refused` joins the reasons a file isn't shown (`FILE_NOT_SHOWN_REASONS`, and `FileValue.notShown` in the API and the clients): the model reads that it couldn't read the file when it was attached.
    - **The retry.** A call that carried images or PDFs and that the provider refused as an invalid request (the adapter's `ModelProviderError` of kind `invalid-request`) is sent once more, in the same step, with that line in each one's place. The files the first call left out for its limits stay out, so the second call is the first without the files it carried. When it answers, the turn goes on without them, the files binding marks them (`FileBinding.refuse`), and the turn's result has a `file-refused` warning naming them. When it fails too, nothing is marked and the turn fails with the first call's error. A turn retries once at most, and not when it has spent its cost budget. The second call is recorded as its own call and counts against the turn's cost, not its steps.
    - **Events.** A step with a retry has two `model.call.started` events; the refused call has no `model.call.completed`.
    - **Everything else keeps the files:** a 429, a 5xx, no response, auth, a context too long, a content filter, an error with no kind, or an aborted turn.
    - **`FileBinding.shown`** is told the images and PDFs each answered call carried; the runtime's choice of what a refusal marks reads it. A binding that fails at either is a `file-record-failed` warning, and the turn goes on.
  - **Images and PDFs go to an agent that needs `vision`.** For any other agent, each is a line naming it. That's decided for each call: the conversation and the journal keep the plain reference, so a later version of the agent that needs `vision` is shown the file. Text files go to any agent.
  - **Outside data.** The rule an agent's system message gains for event data now covers files: any file under a line saying it comes from outside is data, not instructions. A turn gets it when its first messages carry files. A tool whose results may carry files should set `resultIsOutsideData`, so the rule is there from the turn's start.
  - **What's made of a file, sent in its place.** A runtime may make an image of a photo for a model, or read a document's text, and send that in the file's place.
    - **For each call.** `FileBinding.admit` takes an optional call (`{ seesFiles }`). With it, each file carries its form for that one model call: `rendition` (an image, `FileRendition`) or `extracted` (its text, `FileExtract`). A turn asks for them before each model call, in the call's own copy only, so the journal and the conversation keep the plain reference, and a later call finds what's been made since. Without a call, `admit` is as before.
    - **Reading one.** `ModelCallInput.readFile` and `FileBinding.read` take the form to read (`FileForm`); without it, the file itself.
    - **Sending one.** `fileParts` sends a rendition as an image after the line naming the file, and a text in a `<file>` block naming the file, marked as read as text (and as cut, when it was cut at `FILE_LIMITS.textChars`), to any agent. Each form is held to the limits of what it is (a rendition to an image's, a text to a text file's), and counts its own bytes against the call's.
    - **`reading`** joins the reasons a file isn't shown: what's sent in its place isn't made yet.
  - **A turn's memory charge** counts the bytes each call reads of its files (a form in a file's place, else the file), three times: the bytes, their base64 and the request body. `filesForCall` gives the files a call reads, decided as `fileParts` decides them, without reading any. `isReadable` says whether a call reads a file when it fits.
  - **Room for a call's files.** A binding with `FileBinding.hold` gives each model call room for the files it reads, in the runtime's memory for files, before it reads any; the call releases it (`FileHold`) once it answers or fails. With no room in time, the call is sent with a `limit` line for each of them, so it reads none, and a later call shows them again.
    - **Two server settings** size that memory (runtime 0.4.0 on): `KINDGI_FILE_MEMORY_MIB`, 512 by default or a quarter of the server's memory when that's less, at least 35, the room one call's files take at their limit; and `KINDGI_FILE_CACHE_MIB`, the share of it that keeps files' bytes for later calls, half of it by default, 0 for none. A value out of range stops the boot, naming the variable.
  - **Provenance.** A model call's node names the files it planned to read, by artifact id and sha256: at most what it read, since a provider's lower limit or a file found gone or changed can leave one out.
  - **The API.** `ConversationMessage` gains an optional `files` (`FileValue[]`), and `GET /v1/conversations/{conversationId}/messages` returns it. The TypeScript client's `ConversationMessage` gains it too.
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
- f2adcc2: **An operator can set a pack's env name to a cloud secret.** On a runtime that runs a pack service for each deployment, a name a pack reads from its env can be set, at a tenant's scope and under one env, to a numbered version of a secret the operator's cloud holds, `projects/<project>/secrets/<secret>/versions/<number>`, instead of to a value. The runtime keeps that path and never reads the value: the pack service is given the name, and its cloud reads the value as the pack service's own account. A version is a number, never `latest` or an alias, and a secret whose id starts with `kp-` is refused (`400 cloud-secret-invalid`): those are the pack services' own copies.
  
  Only the operator sets one, with a system key holding the new scope `system:env-refs`: `PUT`, `GET` and `DELETE` on `/v1/system/tenants/{tenantId}/env[/{name}]`, or `kindgi env set NAME --cloud-secret <path> --tenant=<id> --scope=… --env=…`, `kindgi env unset NAME --cloud-secret …` and `kindgi env list --cloud-secret …`. A tenant's own key is refused, on `PUT /v1/env/{name}` with a `cloudSecret` too (`403 cloud-secret-system-only`). A runtime serving one tenant with a pack service per deployment mints `system:env-refs` keys from its own token, for that tenant alone. The runtime keeps them only with the new setting `KINDGI_ENV_CLOUD_SECRETS=on`, which needs `KINDGI_PACK_ROUTING=per-deployment`. Off, the default, it keeps none, and the routes answer `501 cloud-secrets-unsupported`. Each change is an `env-set` or `env-deleted` audit row naming the system key, marked `cloudSecret`, never with the path. `createInMemoryEnvCloudSecretBinding` is a store for dev and tests, and `parseCloudSecretVersion` checks a path.
  
  The tenant sees which names are set this way, never the path: `GET /v1/env/cloud-secrets` lists them, the pack-env check names each as `kind: "cloud-secret"`, and `kindgi env list --scope` prints it as `NAME (cloud secret)`. The orchestrator's pack-env answer gives each by its path, in `cloudSecrets`, and setting, changing or removing one moves the pack env revision. A name set to a cloud secret and also as a value or a secret is `pack-env-ambiguous`, and its `names` entry carries `cloudSecretScope`. An orchestrator whose host can't give a pack service a cloud secret records `pack-env-cloud-secret-unsupported`. The TypeScript client's `systemEnv` has `setCloudSecret`, `deleteCloudSecret` and `listCloudSecrets`, and `env.listCloudSecrets` is the tenant's list.
- 9b015f7: **A stdio MCP server's secret goes by reference, never in plaintext `config.env`** (runtime 0.4.0 or later).
  - **New field, `secretEnv`:** a stdio endpoint's secret variables, each name with the secret its value is read from when the runtime starts the server. The value is never stored with the endpoint or answered:
    ```json
    "secretEnv": { "GITHUB_TOKEN": { "envName": "production", "name": "FILES_GITHUB_TOKEN" } }
    ```
    It takes 1 to 16 variables. Each name has no `=` or NUL, and none is also in `config.env` (`secret-env-twice`); otherwise the reason is `invalid-secret-env`. It's `stdio` only: on an HTTP endpoint it's refused (`secret-env-on-http`). Each secret is read at the endpoint's recorded scope, and counts for the provider-key guard and for the env a runtime serves, as `secretRef`'s does. A value the server quotes back in an error shows `[redacted]`, as an HTTP endpoint's credential does.
  - **A credential in `config.env` is refused at registration** (`invalid-mcp-endpoint`, reason `credential-in-env`). The message names the variable, never its value, and shows the `secretEnv` that replaces it.
    - **Which names count:** the ones `config.headers` refuses, with parts split on `_` as well as `-`: `GITHUB_TOKEN`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `SLACK_BOT_TOKEN`, `DB_PASSWORD`. A lone `KEY` doesn't count: `CACHE_KEY` stays plain.
    - **Exported:** the rule is `isCredentialEnvName()`.
  - **Every `config.env` value reads back as `"[redacted]"`**, its name kept, from `GET /v1/mcp/endpoints[/:id]`, on endpoints registered before too. A secret can sit under a name the rule doesn't catch (`DATABASE_URL`, `PGPASSWORD`), and the runtime reads the stored endpoint, never this answer. So a stdio endpoint's export holds env names, not values. A value of exactly `[redacted]` is refused at registration (`invalid-stdio-env`), so a copy of a `GET` answer can't register it by mistake.
  - **`secretRef` on a `stdio` endpoint is refused** (`secret-ref-on-stdio`): it's sent as a bearer header, and a stdio server gets no headers. Use `secretEnv`.
  - **What a process's environment can't carry is refused** (`invalid-stdio-env`): an empty `config.env` name, `=` or a NUL in a name, a NUL in a value. The message names the variable, never the value.
  - **Endpoints registered before keep working.** `kindgi doctor` has a new check, MCP endpoint env (`mcp-env`). It lists each stdio endpoint on the runtime the CLI points at that keeps a credential-named variable in `config.env`, or a `secretRef`, with the fix. It's a warning: the endpoint still works.
  - **If you roll back** to a runtime older than 0.4.0, an endpoint registered with `secretEnv` before the rollback starts without those variables. The server fails its own calls, and no value is exposed. Registering one with `secretEnv` there is refused (`invalid-mcp-endpoint`, reason `unknown-field`): that runtime doesn't know the field.
  - **New exports:**
    - `@kindgi/types`: `isCredentialName()`, the rule both `isCredentialHeaderName()` and `isCredentialEnvName()` apply;
    - `@kindgi/api`: `isCredentialEnvName()`, `MCP_SECRET_ENV_MAX` and `REDACTED_ENV_VALUE`;
    - `@kindgi/client`: `secretEnv` on `McpEndpoint` and `RegisterMcpEndpointInput`. The Python client's models carry it too.
- 9a8a294: **A tool can store the files it fetches, such as a mail's attachments, and read the files it's given; an agent is shown the ones it stores.**
  - **Storing.** A tool that declares `storesFiles: true` gets `ctx.files.store` with each call that has an `idempotencyKey`, as an agent's tool calls do. `ctx.files.store({ name, contentType, bytes })` stores a file as one the call's run owns: the runtime checks the bytes, and only they decide the type. It answers `{ file }`, a file value the tool returns in its result's top-level `files`, or `{ notStored }`: `type`, `size`, `limit` past `MAX_STORED_FILES_PER_CALL` (10) files a call, or `storage` when the tenant's storage is full. A pack's store of a file over `MAX_STORED_FILE_BYTES` (10 MB, the most any type allows) answers `size` without sending its bytes. The same bytes again in the same call, a re-run of it included, answer the first file.
  - **Reading.** A tool that declares `readsFiles: true` gets `ctx.files.read(artifactId)` with each call: the bytes of a file its run may be shown, by the `artifactId` of a file value, such as one in its input. It answers `{ bytes }`, the file as it was stored, or `{ notRead }`: `rule` (the run may not be shown a file of that id), `gone` (deleted, or its bytes are missing), `changed` (its bytes aren't the ones that were checked) or `size` (over its type's limit). `FILE_NOT_READ_REASONS` lists them.
  - **Either way.** A store or a read the runtime refuses, or can't be reached for, rejects, and the call fails as any throw fails it. Only a tool with a handler can store or read files: `defineTool` and the pack indexer refuse `storesFiles` and `readsFiles` on a tool with a declarative `spec` or an MCP transport.
  - **`storage`** joins the reasons a file isn't shown (`FileNotShownReason`): a tool's store found the tenant's storage full.
  - **In a pack.** Pack protocol 2.10.0: a call of a tool that declares `storesFiles` or `readsFiles` carries `ctx.toolFiles` (`{ url, token }`). The runner keeps it from the handler and gives the handler `files` instead: a store posts the file's bytes to the link, and a read gets them from under it, each with the token as the bearer. The handler never sees the link or the token, and a thrown error that quotes the token shows it redacted. A call from an older runtime carries no tool files, and the tool gets no `files`. The tool manifest schema is 1.4.0 and the pack index schema 1.8.0, each with `storesFiles` and `readsFiles`.
  - **In-process.** `FileBinding` gains `store(call, file)`, keyed by the call's `idempotencyKey`, and `readSource(artifactId)`; an agent's tool call gets `ctx.files` from them, with what its tool declares.
  - **The API.** `POST /v1/tool-files` takes a pack service's store: the call's token as the bearer, no API key; the body is the file's bytes, with `Content-Type` and a percent-encoded `Kindgi-File-Name`. It answers `{ file }` or `{ notStored }`. `GET /v1/tool-files/{artifactId}` takes a read, with the same bearer: it answers the file's bytes as `application/octet-stream`, or `{ notRead }` as JSON. Either answers `404 tool-file-token-not-found` for a missing or wrong token alike, or for a call whose tool doesn't declare what it asks; `409 tool-file-token-closed` once the call has answered, its time has passed or its run has ended; and `503 tool-files-busy`, with `Retry-After`, when the runtime has no room for the bytes then: a store holds twice the file's size in its memory for files (`KINDGI_FILE_MEMORY_MIB`, whose description now says so), and a read its size. A runtime supplies both as `createApp`'s `toolFiles` binding. The OpenAPI document gives the read's 200 both bodies. The wire `Tool` gains optional `storesFiles` and `readsFiles`, in the TypeScript client too.
  - **Conformance.** The `files` feature, with the fixture tools `conformance.store` and `conformance.read`, checks that a pack service posts a store to the call's tool files link, gets a read from under it, and gives the handler only what the runtime answered.
- 1bd877d: **Choosing what a project runs is a pin, for agents as for flows and tools.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** An agent's `/promotions` is `/pinned/pin`, `/promotions/check` is `/pinned/check`, `/promotions` and `/promotions/{promotionId}` are `/pin-history` and `/pin-history/{changeId}`, `/live` is `/pinned`, `/live-versions` is `/pinned-versions`, and `/live/unpin` is `/pinned/unpin`. `/live/rollback` is removed: going back is a pin of an earlier version, with the same release gate and approval.
  - **Fields and values.**
    - `promotionId` is `changeId`: on a pinned version, in a deployment's pin gate, in a suggested change's `rolledBack` and in a refused pin's `details`. A suggested change's `promotion` is `pin`.
    - A pin's status `promoted` is `pinned`, and the check's outcome `would-promote` is `would-pin`. A pin's action is `pin` or `unpin`.
    - What an agent resolves to: `via: 'live'` is `'pinned'`, and `liveScope` is `pinnedScope`. A run's `via` value `live` is `pinned`, and so is a queue rule's `when.versions` value. A `when.versions` entry that is neither an exact version, such as `1.2.0`, nor `pinned` is a 400.
    - A suggested change's pin: `liveNow` is `pinnedNow`.
    - A test run's comparison baseline `{ live: … }` is `{ pinned: … }`, and a compared version's `via` value `live` is `pinned`. The CLI's `--baseline live` is `--baseline pinned`.
    - Unregistering an agent version that is pinned answers `agent-version-pinned` (was `agent-version-live`), like flows and tools, and the scopes it is pinned in are `pinned` (was `live`).
    - The approval subject `agent-promotion` is `agent-pin`, and the permission `promote` on an agent is `pin`.
    - The audit kinds `agent-promotion`, `agent-promotion-refused`, `agent-live-unpinned` and `agent-live-pin-inactive` are `agent-pinned`, `agent-pin-refused`, `agent-unpinned` and `agent-pin-inactive`. `agent-rollback` is removed, since going back is a pin.
  - **Errors.** `promotion-not-found`, `promotion-superseded` and `promotion-gate-unsupported` are `pin-not-found`, `pin-superseded` and `pin-gate-unsupported`, and `live-scope-spans-environments` is `pin-scope-spans-environments`, the code a flow or tool pin answers, with the same body. `nothing-to-roll-back` is removed with the rollback route. Environment promotion's codes keep their names.
  - **Messages.** A pin's gate checks call the version a test run is measured against "the pinned version" (was "the live version"), and `release-gate-scope-unpinned` says the scope has no pinned version of its own.
  - **Schemas and types.** `Promotion`, `PromotionPage`, `PromotionCheck` and `SuggestedChangePromotion` are `Pin`, `PinPage`, `PinCheck` and `SuggestedChangePin`. `PromoteBody` and `UnpinBody` are `AgentPinBody` and `AgentUnpinBody`. `LivePin`, `LivePinList` and `LiveVersionResolution` are `AgentPinnedVersion`, `AgentPinnedVersionList` and `AgentPinnedVersionResolution`. An agent's pin scope is `AgentPinScope`: its tenant, org and project kinds are the `PinScope*` schemas flows and tools use, and its segment kind is `PinScopeSegment`.
  - **Binding.** A runtime implements `AgentPinnedVersionBinding` (was `LiveVersionBinding`) and `PinBinding` (was `PromotionBinding`), with `AgentPinBindings` and `AgentPinGateDeps` (were `AgentReleaseBindings` and `AgentReleaseGateDeps`). Their types take the `Pin` names: `Pin`, `PinStatus`, `PinAction`, `PinError`, `PinErrorCode`, `PinRequestInput`, `ListPinHistoryInput`, `AgentPinInput`, `AgentUnpinInput`, `AgentPinnedVersion`, `AgentPinResolution` and `AgentPinResolveInput`. `PromotionActor` and `PinActor` are one `PinActor`. `liveScopeCoordinates` is `agentPinScopeCoordinates`. `rollback` and `RollbackInput` are removed. An unregister that a pin refuses answers `pinned` (was `live`). In `@kindgi/types`, `LiveScope` is `AgentPinScope`, and a run's `liveScope` is `pinnedScope` in `@kindgi/runtime` and `@kindgi/agents`.
  - **TypeScript client.** `client.agents.pinned` has `resolve`, `list`, `pin`, `check`, `unpin`, `history` and `getChange`; `client.agents.promotions` and `client.agents.live` are removed. The client's types are `AgentPinnedClient`, `AgentPinnedWhere` (`PinnedWhere` stays the flow and tool lookup), `AgentUnpinInput` and `ListPinHistoryFilter`.
  - **CLI.** `kindgi agents promote` is `kindgi agents pin`, `promotions list|get` is `pin-history list|get`, `live` is `pinned` and `live-versions` is `pinned-versions`. `kindgi agents rollback` is removed. `<promotion-id>` is `<change-id>`, and `--to` went with `rollback`.
  - **Unchanged.** Environment promotion keeps its name: `kindgi promote` and `POST /v1/deployments/{deploymentId}/promotions`.
- dff9515: **Proposals are now suggested changes.** This is a breaking rename, and no old name is kept.
  
  - **Routes.** `/v1/proposals` is `/v1/suggested-changes`, with `{suggestedChangeId}` in its paths; `evaluate`, `rescore` and `withdraw` keep their sub-paths. `.../request` is `.../pin`. `.../rollback` is removed: going back is putting the agent's earlier version back in use.
  - **Fields and values.**
    - `proposalId` is `suggestedChangeId` everywhere it names a suggested change: on a version's `derivedFrom`, on an Improve outcome, and in a refused gate's `details`.
    - A suggested change's status `promoted` is `pinned`.
    - The header `X-Proposal-Deduped` is `X-Suggested-Change-Deduped`.
  - **Errors.** Codes starting `proposal-` start `suggested-change-`.
  - **Schemas and types.** `Proposal*` and `FixProposal*` names are `SuggestedChange*`; the block edit a suggested change carries is `SuggestedChangeBlockEdit`, and `FixProposalId` is `SuggestedChangeId`. The binding's `SuggestedChangeStep` loses its `rolled-back` kind: nothing records one now. A suggested change rolled back by the removed route still reads as `rolled-back`.
  - **TypeScript client.** `client.suggestedChanges` holds suggested changes, and its `request` is `pin`. Its `rollback` is removed: pinning the agent's earlier version with `client.agents.pinned.pin` puts it back. The supervisor client's `proposals`, deprecated since 0.1.5, is removed with its types.
  - **CLI.** `kindgi suggested-changes` holds suggested changes, with the same verbs except `rollback`, which is removed (`kindgi agents pin` with the earlier version puts it back), and `draft --judgment` is `draft --correction`. `kindgi exports create` writes them as `suggested-changes`.
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

## 0.3.1

No changes in this release.

## 0.3.1-rc.1

No changes in this release.

## 0.3.1-rc.0

No changes in this release.

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

## 0.2.0

No changes in this release.

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

No changes in this release.

## 0.1.10

No changes in this release.

## 0.1.10-rc.1

No changes in this release.

## 0.1.10-rc.0

No changes in this release.

## 0.1.9

No changes in this release.

## 0.1.9-rc.1

No changes in this release.

## 0.1.9-rc.0

No changes in this release.

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

## 0.1.6

### Patch Changes

- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.

## 0.1.6-rc.0

### Patch Changes

- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.

## 0.1.5

### Patch Changes

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

## 0.1.5-rc.0

### Patch Changes

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

## 0.1.4

### Patch Changes

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
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ae417f7: A flow's agent step that runs the version its flow version holds records `via: 'flow-pin'` on its turn (`Run.agent.via`), not `explicit`: the node's `config.version`, else the version the flow version pinned when it was published. `explicit` now means only a version named on the run itself. In the TypeScript and Python clients, `via` gains the value.

## 0.1.4-rc.5

No changes in this release.

## 0.1.4-rc.4

No changes in this release.

## 0.1.4-rc.3

No changes in this release.

## 0.1.4-rc.2

### Patch Changes

- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ae417f7: A flow's agent step that runs the version its flow version holds records `via: 'flow-pin'` on its turn (`Run.agent.via`), not `explicit`: the node's `config.version`, else the version the flow version pinned when it was published. `explicit` now means only a version named on the run itself. In the TypeScript and Python clients, `via` gains the value.

## 0.1.4-rc.1

No changes in this release.

## 0.1.4-rc.0

### Patch Changes

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
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.

## 0.1.3

### Patch Changes

- 1463b77: Approvals, conversations and provenance list by project, as runs do. `GET /v1/approvals`, `GET /v1/conversations` and `GET /v1/provenance` take `scopeKind=project|org` + `scopeId`: one project's records, or every project's in an org. A `scopeId` that isn't a UUID is `400 scope-invalid`. The records say their project:
  - an agent's approvals are enqueued in the turn's project (`HitlEnqueueInput.projectId`);
  - a conversation has `projectId`, set by the run that opens it or by `POST /v1/conversations`' new `projectId` (one of the tenant's projects, else `400 bad-input`; omitted, the tenant's Default project, as for a run); `agent_conversations` gets a nullable `project_id` (migration `0003`);
  - a provenance record's list row has `projectId`, which the emitter passes beside the signed document (`ProvenanceEmitBinding.emit(provenance, { projectId })`).
  
  `ListScope` (`@kindgi/types`) is the scope of each binding's list input. TypeScript client: `scope` on `approvals.list`, `conversations.list` and `provenance.query`, and `projectId` on `conversations.open`; the Python client takes `scope_kind` / `scope_id` and `project_id` (regenerated). Records from before this release have no project, so only a list without a scope shows them (nothing is backfilled).

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

- aec851d: Flows take plain string ids. `defineFlow`'s `FlowSpec` is now `Unbranded<Flow>`: an author writes `id: 'acme.triage-ticket'`, node `id: 'parse'`, edge `from: 'parse'` with no `as FlowId` / `as NodeId` / `as EdgeId` (and no cast on the whole object); branded ids still fit, and the validated `Flow` is branded. `@kindgi/types` exports `Unbranded<T>` (every branded string in `T` loosened to `string`, all the way down). `runs.start({ flow })` / `({ agent })` take a plain string too.
- aec851d: Outbound webhooks: endpoints that receive a signed `run.finished` event when a top-level run completes, fails or is cancelled.
  
  - `@kindgi/api`:
    - `WebhookEndpointBinding` (caller-plugged) and `/v1/webhook-endpoints`: create (the response carries the signing secret, once), list, get, update, `unregister`, `rotate-secret`, the delivery log (`/deliveries`, with a status filter), `redeliver`, and `test` (queues a `webhook.test` event).
    - Endpoint filter: `projectId`, `flowIds`, `includeDryRuns`. Child runs never produce `run.finished`.
    - Event bodies (`RunFinishedEvent`, `WebhookTestEvent`) carry the run's identity and outcome (`FinishedRun`), never its input or output. The OpenAPI document describes them under `webhooks`.
    - Error codes: `webhook-endpoint-not-found`, `webhook-delivery-not-found` (404), `webhook-url-refused` (400).
  - `@kindgi/crypto`: Standard Webhooks signatures (`v1`, HMAC-SHA256): `signWebhook`, `webhookHeaders`, `verifyWebhook` (timestamp tolerance, several signatures during a secret rotation, constant-time comparison) and `generateWebhookSecret` (`whsec_…`). Checked against the reference implementation both ways.
  - `@kindgi/client`: `client.webhookEndpoints`. The unused outbound shapes `Webhook`, `WebhookSpec`, `WebhookSecret`, `WebhookDelivery`, `WebhookVerifyResult` and the `WebhookId` / `WebhookDeliveryId` brands are replaced by the generated wire types and `WebhookEndpointId`; `SubscriptionSpec`'s webhook target is `{ kind: 'webhook', endpoint }`.
  - `@kindgi/types`: `WebhookEndpointId` and `WebhookEventId`. `WebhookId` is documented as what it is: the routable id of an inbound webhook trigger.

### Patch Changes

- aec851d: Copyright holder in every source header is Kindgi Inc.; the `@kindgi/handler-runtime` README now states its actual license (Apache-2.0). No code changes.
