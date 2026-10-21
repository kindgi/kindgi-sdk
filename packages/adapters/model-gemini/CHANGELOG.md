# @kindgi/adapter-model-gemini

## 0.1.10-rc.0

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- d563887: **A model provider keeps a client per key.** The Anthropic, Gemini and OpenAI-compatible adapters (models and embeddings) kept one SDK client, built again whenever the key changed. Calls whose keys take turns, such as runs in two projects each with a key of its own, built a client on every call, and on Vertex AI a new auth client, which fetched a new token on its next call. Connections live in the `fetch` every client sends with, so they were kept either way. Each provider now keeps up to 16 clients, one per key, held by a SHA-256 of the key, the least recently used dropped first. A rotated key still takes effect on the next call. The cache is `createClientsByKey` from `@kindgi/capabilities/clients-by-key`, for an adapter of your own.
- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- d563887: **A model provider keeps a client per key.** The Anthropic, Gemini and OpenAI-compatible adapters (models and embeddings) kept one SDK client, built again whenever the key changed. Calls whose keys take turns, such as runs in two projects each with a key of its own, built a client on every call, and on Vertex AI a new auth client, which fetched a new token on its next call. Connections live in the `fetch` every client sends with, so they were kept either way. Each provider now keeps up to 16 clients, one per key, held by a SHA-256 of the key, the least recently used dropped first. A rotated key still takes effect on the next call. The cache is `createClientsByKey` from `@kindgi/capabilities/clients-by-key`, for an adapter of your own.
- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

- 02ba184: **The Gemini adapter takes its base URL only from explicit configuration.** The adapter now gives `@google/genai` an explicit `httpOptions.baseUrl` on both paths — the Developer API and Vertex AI — so the `GOOGLE_GEMINI_BASE_URL` and `GOOGLE_VERTEX_BASE_URL` environment variables no longer redirect its calls.
  - Left unset, the SDK's `getBaseUrl` falls back to those variables from the process environment; pinning the host keeps a provider's calls going where its configuration names.
  - The Developer API path targets `https://generativelanguage.googleapis.com/`; the Vertex path targets the SDK's own host for the location (`global` and the multi-regional `us`/`eu` each have a dedicated host, every other location a regional one). Behaviour is unchanged when neither variable is set.
- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

- 02ba184: **The Gemini adapter takes its base URL only from explicit configuration.** The adapter now gives `@google/genai` an explicit `httpOptions.baseUrl` on both paths — the Developer API and Vertex AI — so the `GOOGLE_GEMINI_BASE_URL` and `GOOGLE_VERTEX_BASE_URL` environment variables no longer redirect its calls.
  - Left unset, the SDK's `getBaseUrl` falls back to those variables from the process environment; pinning the host keeps a provider's calls going where its configuration names.
  - The Developer API path targets `https://generativelanguage.googleapis.com/`; the Vertex path targets the SDK's own host for the location (`global` and the multi-regional `us`/`eu` each have a dedicated host, every other location a regional one). Behaviour is unchanged when neither variable is set.
- ebf405d: **`KINDGI_TENANT_HOST_ACCESS=isolated`, for a server whose tenants don't trust one another.** It refuses all that `deployed` does, plus private networks wherever tenant configuration names a host, and any sign-in as the server.
  - **`@kindgi/api`:**
    - `TENANT_HOST_ACCESS_LEVELS` gains `isolated`, so the `TenantHostAccess` union widens. A caller's exhaustive `switch` over it needs the new case.
    - `HostReach` gains `'private-network'` (RFC 1918, CGNAT 100.64.0.0/10, IPv6 unique-local and site-local) and `'server-credentials'` (signing in as the server: with credentials its environment holds, or as its own cloud identities). Only `isolated` denies them.
    - **`stdioRefusal(endpointId, level)`** now takes the level, and names it: "KINDGI_TENANT_HOST_ACCESS=isolated refuses that". Under `isolated`, registering a `stdio` MCP endpoint answers `403 host-access-denied`, as it does under `deployed`.
  - **`@kindgi/capabilities`:**
    - `AdapterFactoryInput.serverCredentials?` and `AdapterConfigCheckInput.serverCredentials?` (optional) say whether a registration may sign in as the server. Absent means allowed, as before.
    - `createAdapterFactoryRegistry(seed, { serverCredentials: false })` tells every factory and every `checkConfig`, and withholds the runtime's `identities` from them, so each check learns there are none. An input can't turn either back on.
  - **The adapters, with `serverCredentials: false`:** each refuses the registration in its check and its factory, with the same message, naming the alternative:
    - `@kindgi/adapter-model-gemini`: Vertex AI without `secret_ref`, which would sign in with Application Default Credentials;
    - `@kindgi/adapter-model-bedrock`: `auth: aws-identity`, the default (use `api-key`);
    - `@kindgi/adapter-model-azure-openai`: `auth: entra` (use the resource's API key).
  
    A registration with its own key is unchanged.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS` takes `isolated`, and its description says what the level refuses. The server won't start with `isolated` together with `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`; those descriptions, and `KINDGI_AWS_IDENTITY`'s, say so.
  - **`@kindgi/sdk`:** the providers skill says that a runtime with `isolated` needs a Gemini service-account key in `secret_ref`.
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- 2b8f19a: **A provider's calls carry nothing from the server's environment.** The model SDKs fill options a caller leaves out from environment variables, and three of those reached the calls of every provider the server runs:
  - `@kindgi/adapter-model-anthropic`: the Anthropic SDK reads `ANTHROPIC_AUTH_TOKEN`, sent as a bearer beside the provider's own key, and `ANTHROPIC_BASE_URL`. The adapter now sets no bearer and names Anthropic's API itself when no base URL is given.
  - `@kindgi/adapter-model-openai-compat`: the OpenAI SDK reads `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`, sent as headers to whatever base URL the provider names, and `OPENAI_ADMIN_KEY`. The chat and the embeddings providers now set none of them.
  - `@kindgi/adapter-model-gemini`: `@google/genai` moves to Vertex AI, with the environment's project and location, when `GOOGLE_GENAI_USE_VERTEXAI` or `GOOGLE_GENAI_USE_ENTERPRISE` is set. A Developer API provider now stays on the Developer API.
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- 2b8f19a: **A provider's calls carry nothing from the server's environment.** The model SDKs fill options a caller leaves out from environment variables, and three of those reached the calls of every provider the server runs:
  - `@kindgi/adapter-model-anthropic`: the Anthropic SDK reads `ANTHROPIC_AUTH_TOKEN`, sent as a bearer beside the provider's own key, and `ANTHROPIC_BASE_URL`. The adapter now sets no bearer and names Anthropic's API itself when no base URL is given.
  - `@kindgi/adapter-model-openai-compat`: the OpenAI SDK reads `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`, sent as headers to whatever base URL the provider names, and `OPENAI_ADMIN_KEY`. The chat and the embeddings providers now set none of them.
  - `@kindgi/adapter-model-gemini`: `@google/genai` moves to Vertex AI, with the environment's project and location, when `GOOGLE_GENAI_USE_VERTEXAI` or `GOOGLE_GENAI_USE_ENTERPRISE` is set. A Developer API provider now stays on the Developer API.
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0

## 0.1.6

### Patch Changes

- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.
- Updated dependencies [a2b2ae8]
- Updated dependencies [b4bbd95]
  - @kindgi/capabilities@0.1.6
  - @kindgi/types@0.1.6

## 0.1.6-rc.0

### Patch Changes

- b4bbd95: **A secret that can't go in a header is refused by its name, never quoted.** When a header value has a line break or a NUL inside it, fetch refuses it with an error that quotes the whole value (`Headers.append: "<value>" is an invalid header value.`). A secret pasted with its next line ended up, whole, in the error. For a declarative HTTP tool, that error became the tool call's failure message, stored with the run and its journal. For a model adapter, it was the model call's failure, and so in the logs.
  - **HTTP tools (`spec: { kind: 'http' }`):** the resolved secret (`bearer` or `header`) is checked before the request. A bad one fails the call with `http-tool "<id>": its secret <env>/<name> for the header "<header>" has a line break, which a header can't carry: store the secret without it`. Headers filled from the input are checked the same way, by name.
  - **Model adapters (Anthropic, OpenAI-compatible for chat, Responses and embeddings, Gemini):** the resolved API key is checked on every call, before a client is built or reused: `<adapter>: provider "<id>": its API key has a line break, which a header can't carry: store the secret without it`.
  - **What still works:** a trailing line break is fine, since fetch drops it, and so is a tab or a Latin-1 character. Other control characters, which the request refuses anyway, are refused here by name too.
  - **Checked as it's sent:** `Bearer ` and a secret that starts with a line break make it an inner one, which fetch refuses, so the bearer paths (an HTTP tool's `bearer`, the OpenAI-compatible adapter) check `Bearer <secret>`.
  - **New in `@kindgi/types`:** `headerValueProblem(value)`, the rule all of these use, and `bearerValueProblem(token)`, the same for `Bearer <token>`.
  - **Records made before:** a failure message already stored keeps what it recorded. Rotate a secret that was ever pasted with a line break.
- Updated dependencies [a2b2ae8]
- Updated dependencies [b4bbd95]
  - @kindgi/capabilities@0.1.6-rc.0
  - @kindgi/types@0.1.6-rc.0

## 0.1.5

### Patch Changes

- 88953c7: **A model call can carry a `traceparent`, and the three model adapters send it to the vendor.**
  - **`ModelCallInput.traceparent?`** (optional) is a W3C `traceparent` for the call.
  - **The adapters** send it as the `traceparent` header on that request, and only when it's set:
    - anthropic, through its request options (on the SDK's retries too);
    - openai-compat, on both the Chat Completions and Responses paths;
    - gemini, through the request's `httpOptions.headers`.
    It's never in the body and never logged, and an adapter never makes one up.
  - **A runtime sets it only for a provider whose registration opts in.** Trace ids leave the process only on opt-in.
  - **`ResumeRunBindingInput.trace?`:** the approval that resumes a run passes its request's trace context, as starting a run does.
- 0fe157e: A provider registration the runtime couldn't build is refused when it registers, naming the setting. Before, a bad `adapter_config` (an unknown `api`, a missing `baseURL`, a Vertex registration without `project`, …) registered fine, and the provider was skipped at the first model call with the reason only in the runtime's log.
  - **`POST /v1/providers`** runs the adapter's own check before storing: `422 provider-config-invalid`, with each problem in `details.issues` (`path`, a JSON pointer such as `/adapter_config/api`, and `message`), the shape other validation errors use; the clients read it as an invalid-request error. Without the runtime's adapter factories (an older runtime), nothing changes.
  - **`GET /v1/providers/{providerId}/check`** runs the same check over a registered provider (`{ providerId, adapterId, checked, issues }`); TS `providers.check(id)`, Python `providers.check(provider_id)`.
  - **Adapters:** `AdapterFactoryEntry.checkConfig` (static: no network, no secret read): `{ path, message }` problems, the message naming the setting and what it takes; the factory throws the same problems as `adapterConfigError` words them (`<adapter>: provider "<id>": <message>`). The 422's own message is one sentence naming the provider, its adapter and the first problem, with a count of the rest. Each adapter exports its entry: `openAICompatAdapterEntry`, `geminiAdapterEntry`, `anthropicAdapterEntry` (new `anthropicAdapterFactory`: needs `secret_ref`) and `inProcessAdapterEntry` (new `inProcessAdapterFactory`).
- Updated dependencies [490d083]
- Updated dependencies [88953c7]
- Updated dependencies [0fe157e]
  - @kindgi/capabilities@0.1.5

## 0.1.5-rc.0

### Patch Changes

- 88953c7: **A model call can carry a `traceparent`, and the three model adapters send it to the vendor.**
  - **`ModelCallInput.traceparent?`** (optional) is a W3C `traceparent` for the call.
  - **The adapters** send it as the `traceparent` header on that request, and only when it's set:
    - anthropic, through its request options (on the SDK's retries too);
    - openai-compat, on both the Chat Completions and Responses paths;
    - gemini, through the request's `httpOptions.headers`.
    It's never in the body and never logged, and an adapter never makes one up.
  - **A runtime sets it only for a provider whose registration opts in.** Trace ids leave the process only on opt-in.
  - **`ResumeRunBindingInput.trace?`:** the approval that resumes a run passes its request's trace context, as starting a run does.
- 0fe157e: A provider registration the runtime couldn't build is refused when it registers, naming the setting. Before, a bad `adapter_config` (an unknown `api`, a missing `baseURL`, a Vertex registration without `project`, …) registered fine, and the provider was skipped at the first model call with the reason only in the runtime's log.
  - **`POST /v1/providers`** runs the adapter's own check before storing: `422 provider-config-invalid`, with each problem in `details.issues` (`path`, a JSON pointer such as `/adapter_config/api`, and `message`), the shape other validation errors use; the clients read it as an invalid-request error. Without the runtime's adapter factories (an older runtime), nothing changes.
  - **`GET /v1/providers/{providerId}/check`** runs the same check over a registered provider (`{ providerId, adapterId, checked, issues }`); TS `providers.check(id)`, Python `providers.check(provider_id)`.
  - **Adapters:** `AdapterFactoryEntry.checkConfig` (static: no network, no secret read): `{ path, message }` problems, the message naming the setting and what it takes; the factory throws the same problems as `adapterConfigError` words them (`<adapter>: provider "<id>": <message>`). The 422's own message is one sentence naming the provider, its adapter and the first problem, with a count of the rest. Each adapter exports its entry: `openAICompatAdapterEntry`, `geminiAdapterEntry`, `anthropicAdapterEntry` (new `anthropicAdapterFactory`: needs `secret_ref`) and `inProcessAdapterEntry` (new `inProcessAdapterFactory`).
- Updated dependencies [490d083]
- Updated dependencies [88953c7]
- Updated dependencies [0fe157e]
  - @kindgi/capabilities@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 48e3478: The Gemini adapter retries a call that fails with a transient status (408, 429, 500, 502, 503, 504): three attempts in all, backing off from a second. Before, it didn't retry at all. The `@google/genai` client retries only when it's told to, so one `503` from an overloaded model failed the turn. The OpenAI-compatible and Anthropic adapters already retried, through their SDKs' defaults (also three attempts). A failed connection still isn't retried on Gemini. A call's `attempts` counts its retries.
- 6263b4b: Examples name models that aren't retiring. Anthropic retires `claude-haiku-4-5` on or after 2026-10-15 and Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20, so the `kindgi init` READMEs, the CLI README, the Gemini adapter's README and the providers and authoring-agents skills (TypeScript and Python) now use `claude-sonnet-5-5` and `gemini-3.8-flash`. The providers skill's Vertex `provider.json` registers `gemini-3.8-flash` and `gemini-3.5-flash-lite`, as the `gemini` preset does, and says not to pin the retiring models. It also says what a model's `structured-output` feature means: the model can follow a JSON schema natively, while Kindgi's typed outputs use instructions, then parse, check and repair, on every provider.
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
- f999acd: **dev-echo says it isn't a model, and there are presets for more LLM provider keys.**
  
  - **dev-echo's text answers start with one line:** "⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers." So a developer can't mistake it for a model wherever the answer shows, their own app included. An answer that is JSON (what a typed-output agent parses) stays bare, as does one asked for with `structuredOutput`.
  - **Every dev-echo result carries a warning, `dev-echo-not-a-model`,** with the commands that add a model. `ModelCallResult.warnings` (new, optional) lets any provider warn about its answers. An agent turn collects them into its result's `warnings`, a resumed turn too, and `kindgi runs start` prints them on stderr. dev-echo's own warning stands in for the `fallback-provider` one there.
  - **New presets for key-based LLM providers:**
    - `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`, many vendors' models with one key), on the OpenAI-compatible adapter;
    - `gemini-api` (`GEMINI_API_KEY`), Gemini with a Google AI Studio key.
  
    A preset can now fix adapter settings itself (`adapterConfigValues`, such as the `baseURL`).
  - **`@kindgi/adapter-model-gemini` takes a Gemini Developer API key** (`apiKey`, or `adapter_config.api: "developer"` with the key as `secret_ref`), next to Vertex AI. Vertex stays the default and the `gemini` preset, the route for a regulated deployment.
  - **`kindgi doctor`** looks for every preset's key, and its fixes offer any one of them: the key to set, and the preset to register.
  - **The init templates** ask for "an LLM provider key" (Anthropic, OpenAI, Gemini, Groq or OpenRouter), not Claude's alone.
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

- f999acd: **dev-echo says it isn't a model, and there are presets for more LLM provider keys.**
  
  - **dev-echo's text answers start with one line:** "⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers." So a developer can't mistake it for a model wherever the answer shows, their own app included. An answer that is JSON (what a typed-output agent parses) stays bare, as does one asked for with `structuredOutput`.
  - **Every dev-echo result carries a warning, `dev-echo-not-a-model`,** with the commands that add a model. `ModelCallResult.warnings` (new, optional) lets any provider warn about its answers. An agent turn collects them into its result's `warnings`, a resumed turn too, and `kindgi runs start` prints them on stderr. dev-echo's own warning stands in for the `fallback-provider` one there.
  - **New presets for key-based LLM providers:**
    - `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`, many vendors' models with one key), on the OpenAI-compatible adapter;
    - `gemini-api` (`GEMINI_API_KEY`), Gemini with a Google AI Studio key.
  
    A preset can now fix adapter settings itself (`adapterConfigValues`, such as the `baseURL`).
  - **`@kindgi/adapter-model-gemini` takes a Gemini Developer API key** (`apiKey`, or `adapter_config.api: "developer"` with the key as `secret_ref`), next to Vertex AI. Vertex stays the default and the `gemini` preset, the route for a regulated deployment.
  - **`kindgi doctor`** looks for every preset's key, and its fixes offer any one of them: the key to set, and the preset to register.
  - **The init templates** ask for "an LLM provider key" (Anthropic, OpenAI, Gemini, Groq or OpenRouter), not Claude's alone.
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

### Patch Changes

- aec851d: What a provider registration can make the server reach, for Gemini and for every provider's region.
  
  - **`metadata.region` must be one DNS label** (lowercase letters, digits, hyphens; e.g. `us-central1`, `global`, `unspecified`). Anything else is `400 invalid-provider`, reason `invalid-region`. The Gemini adapter builds its hostname from the region (`https://<region>-aiplatform.googleapis.com/`), so `evil.example/x?` used to move the request to another host. With no `secret_ref`, that request carried the server's own Google credentials.
  - **The Gemini adapter** checks its target itself: the location is one DNS label, and `adapter_config.project` is a Google Cloud project id or number, since it goes into the request path. This holds for `createGeminiProvider` too, not only the factory.
  - **A Gemini `secret_ref` must be a service-account key** (`"type": "service_account"`), reduced to its key fields. Other credential types made the auth library fetch URLs the "key" named, with its headers, or read a file named in it. A key's `token_uri` or `universe_domain` could move the token exchange elsewhere. Google's own token endpoint is always used now.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/capabilities@0.1.0
