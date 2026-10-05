# @kindgi/client

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
