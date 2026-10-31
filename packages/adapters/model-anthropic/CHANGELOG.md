# @kindgi/adapter-model-anthropic

## 0.3.1-rc.1

### Patch Changes

- @kindgi/capabilities@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/capabilities@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- 8dd91b0: **An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0
  - @kindgi/types@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0

## 0.2.0

### Patch Changes

- @kindgi/capabilities@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/capabilities@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

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

- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

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
- f080a20: **A tool whose id holds `__` can be called.** Anthropic, OpenAI-compatible endpoints, Bedrock and Azure OpenAI don't take dots in tool names, so a tool id goes to the model with `.` as `__`. The model's call used to come back with every `__` as `.`, so a tool named by an MCP server with `__` in it (Drupal's MCP Server Tool Bridge names every tool `tool_api__<id>`) came back as a tool nobody has, and the turn failed with `unresolved-tool`. A call's name is now looked up among the request's own tools. Two tools that would go to the model under one name (`acme.a__b` and `acme.a.b`) are refused before the call, naming both. Gemini takes dots, so its tool names were never changed. New in `@kindgi/capabilities`: `toolIdsBySentName()` and `ToolNameCollisionError`.
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
- f080a20: **A tool whose id holds `__` can be called.** Anthropic, OpenAI-compatible endpoints, Bedrock and Azure OpenAI don't take dots in tool names, so a tool id goes to the model with `.` as `__`. The model's call used to come back with every `__` as `.`, so a tool named by an MCP server with `__` in it (Drupal's MCP Server Tool Bridge names every tool `tool_api__<id>`) came back as a tool nobody has, and the turn failed with `unresolved-tool`. A call's name is now looked up among the request's own tools. Two tools that would go to the model under one name (`acme.a__b` and `acme.a.b`) are refused before the call, naming both. Gemini takes dots, so its tool names were never changed. New in `@kindgi/capabilities`: `toolIdsBySentName()` and `ToolNameCollisionError`.
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

- 9426193: Claude agents use Anthropic's prompt cache. Before, the Anthropic adapter marked nothing for caching, so every call paid the full input price for a prompt the previous call had just sent. Now it marks up to three breakpoints with the 5-minute cache: the last tool, the agent's prompt (the first system block; each system message is now its own block), and the conversation so far when another call will send it again (a call with tools, or a conversation with an earlier answer). The next call in a turn reads that prefix at 5% of the input price on Claude Opus 5.5 and Sonnet 5.5 (10% on Haiku) and writes only what's new; the first write costs 125%. Live, a three-call turn with a 7,700-token prompt cost 53% less on both Sonnet 5.5 and Opus 5.5. A prompt below the model's minimum isn't cached and costs nothing extra. The `anthropic` preset now carries Anthropic's cache rates (writes 1.25x; reads 0.05x on Opus and Sonnet 5.5, 0.1x on Haiku). A registration from an earlier preset keeps the 0.1x read rate on every model: register the preset again to get 0.05x. New exports: `withPromptCache`, `PROMPT_CACHE`; `toAnthropicMessages` also returns `systemParts`.
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

- 9426193: Claude agents use Anthropic's prompt cache. Before, the Anthropic adapter marked nothing for caching, so every call paid the full input price for a prompt the previous call had just sent. Now it marks up to three breakpoints with the 5-minute cache: the last tool, the agent's prompt (the first system block; each system message is now its own block), and the conversation so far when another call will send it again (a call with tools, or a conversation with an earlier answer). The next call in a turn reads that prefix at 5% of the input price on Claude Opus 5.5 and Sonnet 5.5 (10% on Haiku) and writes only what's new; the first write costs 125%. Live, a three-call turn with a 7,700-token prompt cost 53% less on both Sonnet 5.5 and Opus 5.5. A prompt below the model's minimum isn't cached and costs nothing extra. The `anthropic` preset now carries Anthropic's cache rates (writes 1.25x; reads 0.05x on Opus and Sonnet 5.5, 0.1x on Haiku). A registration from an earlier preset keeps the 0.1x read rate on every model: register the preset again to get 0.05x. New exports: `withPromptCache`, `PROMPT_CACHE`; `toAnthropicMessages` also returns `systemParts`.
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
- ee0b6d5: **A provider's cost table keeps its adapter's rates.** The HTTP API kept only a model's two base rates, so a registration lost the rates its adapter prices with: Anthropic's prompt-cache multipliers, Gemini's cached-prompt share, and a `longContext` tier. A long prompt on `gemini-3.1-pro-preview` or `claude-haiku-5-5` was priced at the base rate in `totalCostUsd` and the cost budgets.
  - **The API** now keeps those rates: each a non-negative number, or one object of them (otherwise 400, reason `invalid-cost`). It returns them as stored.
  - **The anthropic adapter** prices a long prompt as the gemini adapter does: past `longContext.thresholdTokens` (regular, cache-write and cache-read tokens together), the whole call bills at the long rates. `claude-haiku-5-5` is 5× past a 100,000-token prompt.
  - **A provider registered earlier** keeps its base-rate-only cost table: re-register it (`kindgi providers register --preset=<name>`) to get long-context pricing.
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

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/capabilities@0.1.0
