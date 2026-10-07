# @kindgi/capabilities

## 0.1.4-rc.3

### Patch Changes

- @kindgi/platform@0.1.4-rc.3
  - @kindgi/schema@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [e7e2f86]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2
  - @kindgi/schema@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [06b5fc0]
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/schema@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 2923703: A provider can carry labels, and `provider` is a retention domain.
  
  - **`ProviderMetadata.labels`**, optional: string keys to string values, for bookkeeping such as who manages the provider. The router ignores them. `POST /v1/providers` stores them, and get and list return them. At most 32 keys; a key is 1-63 lowercase letters and digits, with `.`, `-`, `_` or `/` inside; a value is at most 256 characters. Anything else is `400 invalid-provider` with reason `invalid-labels`, and `createProviderRegistry` refuses the same labels. The convention key `kindgi.com/managed-by` (`PROVIDER_LABEL_MANAGED_BY`) names the manager: `kindgi-dev`, `kindgi-dev:<pack id>` or `kindgi-deploy:<environment>`. `@kindgi/capabilities` exports `validateProviderLabels` and the limits. The TypeScript and Python clients have the field.
  - **`provider` in `RETENTION_DOMAINS`.** `ProviderRegistryBinding.unregister` is a tombstone, not an erase: the provider is gone from list, get, capabilities and routing at once, its id is free to register again, and a retention policy on `provider` purges the row. A runtime that still erases on unregister behaves the same through the API.
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
- Updated dependencies [7a8e764]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

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
- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3
  - @kindgi/platform@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/platform@0.1.2
  - @kindgi/schema@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/platform@0.1.1
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
- aec851d: Fallback providers. `ProviderMetadata.fallback: true` makes a provider serve a capability only when no other provider satisfies it; `route()` then reports `fallback: true`, and a fallback is never an alternate to a regular pick. An agent turn routed to one carries a `fallback-provider` warning (`AgentTurnResult.warnings`). `dev-echo` is a fallback, so registering a real model takes over from it with nothing to switch off — before, ties went to the provider id that sorts first, and `dev-echo` beat `gemini`, `groq` or `ollama`. `POST /v1/providers` accepts and returns `fallback`; the clients carry it. The providers and getting-started skills describe it, and register Anthropic or Gemini with `kindgi providers register --preset` (the CLI's presets).
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

### Patch Changes

- aec851d: Safety fixes in model routing policy and the agent turn.
  
  - `@kindgi/agents`: combining the bound tenant policy with a policy derived from the registry now yields a policy at least as strict as each. Allow lists (`providers.allow`, `models.allow`, `regionAllow`) intersect when both set one; they were unioned, so a registry policy could widen what the tenant allowed (for example an `eu-west-1`-only tenant also allowing `us-east-1`). Deny lists still union; caps take the smaller value.
  - `@kindgi/agents`: guardrails now run on the final response before it is stored. A response that a blocking guardrail rejects is no longer written to the conversation (and no final `agent.message` event is emitted for it); the turn fails with `guardrail-violation` as before. The agent-turn flow is now version `1.1.0` (`evaluate-guardrails` → `persist-final-message`); runs parked on the `1.0.0` flow cannot be resumed.
  - `@kindgi/capabilities`: a tenant allow list that is present restricts routing even when empty — `[]` allows nothing (fail closed), as a capability requirement's allow list already did. Previously an empty tenant allow list meant "no restriction".
- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
  - @kindgi/platform@0.1.0
