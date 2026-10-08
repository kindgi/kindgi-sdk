# @kindgi/adapter-model-openai-compat

## 0.1.4

### Patch Changes

- 1c0252c: **A model that rejects `temperature` no longer fails the call.** Anthropic's Claude 4.7 and later (Opus 5.5, Sonnet 5.5, Haiku 5.5) answer a non-default `temperature` with a 400, and OpenAI's GPT-6 models take none at their reasoning efforts. A model's `ModelInfo` now says so with `sampling: false`. For such a model, every adapter sends the call without the temperature and says so in the answer's `warnings`, code `sampling-unsupported`. That covers a model-settings block, a guardrail judge and an eval judge alike.
  - `@kindgi/capabilities`: `ModelInfo.sampling`, and `samplingFor(model, input)`, the one place an adapter asks what to send.
  - The HTTP API keeps a model's `sampling` (it must be a boolean; otherwise 400, reason `invalid-sampling`) and returns it. The Python client's `ModelInfo` has it too.
  - The `anthropic`, `openai` and `openrouter` presets mark those models. A registration made from an older preset keeps sending the temperature: re-register to pick up the marks.
  - `kindgi providers register --preset` reads the provider back, and on a runtime that drops these rules (older than 0.1.4) says so in one line, naming the models whose temperature may be refused.
- 1c0252c: **A guardrail judge on a model that thinks still gets its verdict.** Claude Sonnet 5.5 and Opus 5.5, Haiku 5.5, Gemini 3.8 Flash and OpenAI's GPT-6 models think by default, and their thinking counts against the output cap. A judge's 256 tokens could be gone before the verdict.
  - `ModelInfo.thinking` (`{ mode: 'adaptive' | 'always', lowest }`) says how a model thinks and its vendor's setting for the least thinking. The HTTP API validates it (otherwise 400, reason `invalid-thinking`) and returns it; the Python client has `ModelThinking`.
  - `ModelCallInput.thinking: 'lowest'` asks for that least. The anthropic adapter sends Sonnet 5.5's `between_tools` or Haiku 5.5's `disabled` with effort `low`, and Opus 5.5's effort `low` alone. The gemini adapter sends the thinking level (`LOW` on 3.8 Flash, which refuses `MINIMAL`; `MINIMAL` on 3.5 Flash-Lite). openai-compat sends `reasoning_effort`. A model without `thinking` gets nothing extra.
  - A guardrail judge asks for it, and on a thinking model its cap is 256 + 2048 tokens (`JUDGE_VERDICT_TOKENS`, `JUDGE_THINKING_TOKENS`).
  - The presets mark the models: anthropic's Opus, Sonnet and Haiku 5.5, gemini and gemini-api's 3.8 Flash and 3.5 Flash-Lite, openai's gpt-6.1-sol and gpt-6-luna. Re-register to pick the marks up.
- 4f90882: The OpenAI-compatible adapter prices a call the way OpenAI bills it, so a run's cost and its cost budget are right on GPT-6. Before, every prompt token billed at the base input rate: cached prompts were overcharged 10–20 times, and a prompt past 272,000 tokens was undercharged (OpenAI bills those at twice the input and 1.5 times the output rate).
  - **A model's cost table** takes the rates the Gemini and Anthropic adapters already price with: `cachedPromptMultiplier`, `promptCacheCreationMultiplier`, `longContext` (the whole call at its rates past `thresholdTokens`), and `dataResidencyMultiplier` (applied only on a data-residency host such as `eu.api.openai.com`). Both APIs (Responses and Chat Completions) price with them.
  - **The `openai` preset** carries OpenAI's published GPT-6 rates (checked 2026-10-07): cached input at 10% of input (5% on GPT-6.1 Sol), cache writes at 1.25 times, twice the input and 1.5 times the output past 272,000 input tokens, and +10% on a data-residency host. Past 272,000 means per call, counting all of its input tokens (cached and cache-write ones included), as we read OpenAI's pricing. A registration can't be edited, so one made from an earlier preset keeps its base rates: unregister it (`kindgi providers unregister openai`), then register the preset again; one your pack's config declares updates when `kindgi dev` restarts.
- bcdc637: OpenAI's GPT-6 models can call tools: the OpenAI-compatible adapter now speaks OpenAI's Responses API to OpenAI itself. GPT-6 Astra and Sol can't call tools through Chat Completions, and Luna only without reasoning, so an agent with tools on the `openai` preset failed.
  - **Which API:** a provider's `adapter_config.api` picks it, `responses` or `chat-completions`. Without one, a `baseURL` on `api.openai.com` (or a data-residency host such as `eu.api.openai.com`) speaks Responses, and every other endpoint (Ollama, vLLM, Groq, OpenRouter, …) keeps Chat Completions. **An existing OpenAI registration moves to Responses on upgrade, with no re-registration:** set `adapter_config.api` to `chat-completions` to keep the old path. A registration whose `extraBody.*` fields were written for Chat Completions (such as `extraBody.reasoning_effort`) either keeps that path the same way, or moves them to their Responses names (`extraBody.reasoning.effort`).
  - **The `openai` preset** sets `api: responses`.
  - **Stateless:** every Responses call sends `store: false`, so OpenAI keeps no conversation state for Kindgi's calls. A reasoning model's reasoning between tool calls goes back to it with the calls (in the tool call's `signature`), for the same model only.
  - **`extraBody`** on Responses refuses the fields the adapter sets there (`EXTRA_BODY_RESERVED_RESPONSES`); `extraBody.reasoning.effort` sets a reasoning model's effort.
  - **The model data applies on Responses too:** a temperature the model doesn't take (`sampling: false`) isn't sent and the answer carries a `sampling-unsupported` warning; a call asking for `thinking: 'lowest'` (a guardrail judge) sends the model's lowest `reasoning.effort` (`gpt-6-astra` now has one: `low`, checked live; `none` is refused); and the system prompt names the call's tools as they're sent.
- 7b63137: An agent whose instructions name a tool by its id (`call acme.lookup_order`) now gets the tool called on Anthropic and OpenAI-compatible models. Those providers forbid dots in tool names, so the tool is sent as `acme__lookup_order`; a model told the dotted id would call a name it wasn't given, writing the call as text or having it dropped (measured on local models: 43% of such turns). The adapters now name the call's own tools in the system prompt by the names they're sent under: whole ids only, deterministically, at the wire boundary. The journal, the conversation and provenance keep the dotted ids. Gemini keeps dots and is unchanged. `nameToolsAsSent` (`@kindgi/capabilities/tool-names`) is the helper.
- Updated dependencies [1c0252c]
- Updated dependencies [1c0252c]
- Updated dependencies [b9d3c01]
- Updated dependencies [7b63137]
- Updated dependencies [f999acd]
- Updated dependencies [2923703]
- Updated dependencies [d0ebeb6]
  - @kindgi/capabilities@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [f999acd]
  - @kindgi/capabilities@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [2923703]
- Updated dependencies [d0ebeb6]
  - @kindgi/capabilities@0.1.4-rc.0

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
- Updated dependencies [629057d]
  - @kindgi/capabilities@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/capabilities@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/capabilities@0.1.1

## 0.1.0

### Minor Changes

- aec851d: `extraBody`: fields merged into every Chat Completions request, for settings an endpoint takes that the OpenAI format has no field for. A Qwen thinking model on vLLM, SGLang or llama-server needs `{ "chat_template_kwargs": { "enable_thinking": false } }`, or its answer starts with its thinking and a typed answer fails, and a shared server can't always be reconfigured to turn it off. A registered provider gives them as flat `adapter_config` keys, one per field, dots nesting: `"extraBody.chat_template_kwargs.enable_thinking": false` (`EXTRA_BODY_PREFIX`; `openAICompatExtraBody` expands and checks them). The fields the adapter sets (`EXTRA_BODY_RESERVED`) are refused. The README no longer says the abort signal isn't forwarded (it is).
- aec851d: The runtime can register OpenAI-compatible providers: `openAICompatAdapterFactory` (`OPENAI_COMPAT_ADAPTER_ID`) takes the endpoint from `adapter_config.baseURL` and the key from `secret_ref`, resolved on every call (`apiKey` now also takes a resolver; the client is rebuilt when the key rotates; without a secret the adapter sends a placeholder, as local runners expect). `invoke()` passes the turn's abort signal to the request, so a cancelled turn cancels the call.

### Patch Changes

- aec851d: The hooks the runtime needs to guard the server's connections to hosts a tenant chose (T83). The guard itself is in the runtime.
  
  - **`@kindgi/api`:** `HostReach` gains `'metadata-network'` (link-local addresses, where the cloud metadata endpoints hand out the server's credentials) and `'loopback'` (the server's own host). `KINDGI_TENANT_HOST_ACCESS=deployed` refuses both, as well as `'exec'`.
  - **`@kindgi/capabilities`:** `AdapterFactoryInput.fetch` is the fetch for a provider endpoint the registration chose.
  - **`@kindgi/adapter-model-openai-compat`:** the factory sends through that fetch.
  - **`@kindgi/tools`:**
    - `defineTool(spec, { synthesizer: { fetch } })` and `ToolSpecSynthesizerOptions`: a declarative HTTP tool's handler sends through the runtime's fetch.
    - `validateToolManifest` now refuses an HTTP tool whose `urlTemplate` puts a `{placeholder}` in the scheme, host or port, or isn't `http(s)://` with a host. Placeholders belong in the path and query, where they're URL-encoded; in the authority, a run's input would pick the host.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS`'s description says what `deployed` refuses.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/capabilities@0.1.0
