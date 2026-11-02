# @kindgi/adapter-model-shared

## 0.3.2

### Patch Changes

- @kindgi/capabilities@0.3.2

## 0.3.1

### Patch Changes

- @kindgi/capabilities@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/capabilities@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/capabilities@0.3.1-rc.0

## 0.3.0

### Patch Changes

- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0-rc.0

## 0.2.0

### Patch Changes

- @kindgi/capabilities@0.2.0

## 0.2.0-rc.1

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/capabilities@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.0

## 0.1.9

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/capabilities@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9-rc.0

## 0.1.8

### Patch Changes

- 63a06d6: **The OpenAI-compatible adapter surfaces a refused connection instead of retrying it.** The adapter now owns the retry policy on every call path — chat, responses and embeddings — with the OpenAI SDK's own retries off (`maxRetries: 0`).
  
  - A connection the runtime refuses the same way every time — an egress or body-size guard, or a redirect the request won't follow — is tried once, and its own words reach the caller rather than the SDK's generic "Connection error."
  - A transient failure (408, 409, 429, 5xx, or a dropped connection) is still retried, honouring the vendor's `retry-after` and the vendor's `x-should-retry` override; a caller's `clientOptions.maxRetries` keeps its meaning, the retries after the first attempt (the SDK default is 2, so 3 attempts in all).
  - A failed call now throws the shared `ModelProviderError` (its `kind` and `status`, the OpenAI SDK's error as `cause`) on every path, as the other adapters do, and an aborted call rejects with the turn's reason — where a failed OpenAI-compatible call used to reject with the `openai` SDK's own `APIError`, and an abort with `APIUserAbortError`. Code that caught `OpenAI.APIError` on this path should catch `ModelProviderError`.
  - `@kindgi/adapter-model-shared` now exports `refusedConnection` and `isTransport`, the one classifier it and the OpenAI-compatible adapter share.
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8

## 0.1.8-rc.0

### Patch Changes

- 63a06d6: **The OpenAI-compatible adapter surfaces a refused connection instead of retrying it.** The adapter now owns the retry policy on every call path — chat, responses and embeddings — with the OpenAI SDK's own retries off (`maxRetries: 0`).
  
  - A connection the runtime refuses the same way every time — an egress or body-size guard, or a redirect the request won't follow — is tried once, and its own words reach the caller rather than the SDK's generic "Connection error."
  - A transient failure (408, 409, 429, 5xx, or a dropped connection) is still retried, honouring the vendor's `retry-after` and the vendor's `x-should-retry` override; a caller's `clientOptions.maxRetries` keeps its meaning, the retries after the first attempt (the SDK default is 2, so 3 attempts in all).
  - A failed call now throws the shared `ModelProviderError` (its `kind` and `status`, the OpenAI SDK's error as `cause`) on every path, as the other adapters do, and an aborted call rejects with the turn's reason — where a failed OpenAI-compatible call used to reject with the `openai` SDK's own `APIError`, and an abort with `APIUserAbortError`. Code that caught `OpenAI.APIError` on this path should catch `ModelProviderError`.
  - `@kindgi/adapter-model-shared` now exports `refusedConnection` and `isTransport`, the one classifier it and the OpenAI-compatible adapter share.
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8-rc.0

## 0.1.7

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-azure-openai`,** your Azure OpenAI deployments as a model provider, on the v1 API (Responses by default, or Chat Completions). It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names the resource (`adapter_config.resourceName`, or `baseURL` for a custom endpoint) and the deployment serving each model (`adapter_config.deployments`, `"model=deployment,…"`). Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: api-key` (default): the key `secret_ref` names, read for every attempt, so a rotated key takes effect on the next call;
    - `auth: entra`: the runtime's own Azure identity, a bearer token per attempt, no key. The token goes only to an Azure OpenAI host, in Azure's public cloud or Azure Government (`*.openai.azure.us` and `*.cognitiveservices.azure.us`, with that cloud's scope); a registration naming any other host with `auth: entra` is refused.
    A failed sign-in (no token, no key, a blank one) is an `auth` error, never retried. So is a key or a token a header can't carry, such as one with a line break inside it: it's refused before the request and named, never quoted (fetch's own error would quote it). No request follows a redirect, so the credential reaches the endpoint and nothing else. It never reads `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment.
  - **Whether a model reasons is the registration's to say:** a model registered with `thinking` or `sampling: false` reasons, one with `sampling: true` doesn't, whatever its deployment is called. When the registration says neither, the AI SDK decides from the deployment's name.
  - **Nothing kept on Azure's side:** Responses calls send `store: false`.
  - **`AdapterFactoryInput.identities?`** (optional, `@kindgi/capabilities`) is the runtime's cloud identities for an adapter that signs in as the server: `azure` (`AzureTokenClient`, which an `@azure/identity` credential satisfies) and `aws` (`AwsCredentialClient`, a refreshing credential provider). The runtime fills each only from settings that name it, never from ambient credentials.
  - **`createAdapterFactoryRegistry(seed, { identities })`** hands those to every factory and tells every `checkConfig` which are there (`AdapterConfigCheckInput.identities?`, also new). So a registration that signs in as an identity the runtime lacks (`auth: entra` with no Azure identity) is refused when it registers, naming the setting, rather than failing when it's first used.
  - **`createAiSdkModelProvider`'s `fetch?`** (`@kindgi/adapter-model-shared/ai-sdk`) is the fetch every attempt goes through: the runtime's, which refuses the hosts its deployment forbids.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- f080a20: **A tool whose id holds `__` can be called.** Anthropic, OpenAI-compatible endpoints, Bedrock and Azure OpenAI don't take dots in tool names, so a tool id goes to the model with `.` as `__`. The model's call used to come back with every `__` as `.`, so a tool named by an MCP server with `__` in it (Drupal's MCP Server Tool Bridge names every tool `tool_api__<id>`) came back as a tool nobody has, and the turn failed with `unresolved-tool`. A call's name is now looked up among the request's own tools. Two tools that would go to the model under one name (`acme.a__b` and `acme.a.b`) are refused before the call, naming both. Gemini takes dots, so its tool names were never changed. New in `@kindgi/capabilities`: `toolIdsBySentName()` and `ToolNameCollisionError`.
- Updated dependencies [7bd61d6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7

## 0.1.7-rc.0

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-azure-openai`,** your Azure OpenAI deployments as a model provider, on the v1 API (Responses by default, or Chat Completions). It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names the resource (`adapter_config.resourceName`, or `baseURL` for a custom endpoint) and the deployment serving each model (`adapter_config.deployments`, `"model=deployment,…"`). Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: api-key` (default): the key `secret_ref` names, read for every attempt, so a rotated key takes effect on the next call;
    - `auth: entra`: the runtime's own Azure identity, a bearer token per attempt, no key. The token goes only to an Azure OpenAI host, in Azure's public cloud or Azure Government (`*.openai.azure.us` and `*.cognitiveservices.azure.us`, with that cloud's scope); a registration naming any other host with `auth: entra` is refused.
    A failed sign-in (no token, no key, a blank one) is an `auth` error, never retried. So is a key or a token a header can't carry, such as one with a line break inside it: it's refused before the request and named, never quoted (fetch's own error would quote it). No request follows a redirect, so the credential reaches the endpoint and nothing else. It never reads `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment.
  - **Whether a model reasons is the registration's to say:** a model registered with `thinking` or `sampling: false` reasons, one with `sampling: true` doesn't, whatever its deployment is called. When the registration says neither, the AI SDK decides from the deployment's name.
  - **Nothing kept on Azure's side:** Responses calls send `store: false`.
  - **`AdapterFactoryInput.identities?`** (optional, `@kindgi/capabilities`) is the runtime's cloud identities for an adapter that signs in as the server: `azure` (`AzureTokenClient`, which an `@azure/identity` credential satisfies) and `aws` (`AwsCredentialClient`, a refreshing credential provider). The runtime fills each only from settings that name it, never from ambient credentials.
  - **`createAdapterFactoryRegistry(seed, { identities })`** hands those to every factory and tells every `checkConfig` which are there (`AdapterConfigCheckInput.identities?`, also new). So a registration that signs in as an identity the runtime lacks (`auth: entra` with no Azure identity) is refused when it registers, naming the setting, rather than failing when it's first used.
  - **`createAiSdkModelProvider`'s `fetch?`** (`@kindgi/adapter-model-shared/ai-sdk`) is the fetch every attempt goes through: the runtime's, which refuses the hosts its deployment forbids.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- f080a20: **A tool whose id holds `__` can be called.** Anthropic, OpenAI-compatible endpoints, Bedrock and Azure OpenAI don't take dots in tool names, so a tool id goes to the model with `.` as `__`. The model's call used to come back with every `__` as `.`, so a tool named by an MCP server with `__` in it (Drupal's MCP Server Tool Bridge names every tool `tool_api__<id>`) came back as a tool nobody has, and the turn failed with `unresolved-tool`. A call's name is now looked up among the request's own tools. Two tools that would go to the model under one name (`acme.a__b` and `acme.a.b`) are refused before the call, naming both. Gemini takes dots, so its tool names were never changed. New in `@kindgi/capabilities`: `toolIdsBySentName()` and `ToolNameCollisionError`.
- Updated dependencies [7bd61d6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7-rc.0

## 0.1.6

### Patch Changes

- 5ef2aec: New package: shared plumbing for Kindgi's model adapters.
  - **In Kindgi's terms:** typed errors (`ModelProviderError`, with a `kind` and the HTTP `status`), the retry policy (counted attempts, `retry-after`, an abort-aware backoff), and `tokenCostUsd`, a token cost formula with the same arithmetic as our OpenAI-compatible and Anthropic adapters' own (their tests hold the three equal on the bundled presets).
  - **Behind `@kindgi/adapter-model-shared/ai-sdk`,** today's engine, the AI SDK's provider packages called at the spec level (never the `ai` package or Vercel's gateway). `createAiSdkModelProvider` turns a provider's model into a `ModelProvider`. It carries the reasoning state across a pause in the first tool call's `signature` (back only to the same provider's same model), puts usage onto Kindgi's counters, drops refused sampling with a warning, and sends `traceparent` only when set. This entry point is for Kindgi's own adapters, with no compatibility promise across a change of engine.
- Updated dependencies [a2b2ae8]
  - @kindgi/capabilities@0.1.6

## 0.1.6-rc.0

### Patch Changes

- 5ef2aec: New package: shared plumbing for Kindgi's model adapters.
  - **In Kindgi's terms:** typed errors (`ModelProviderError`, with a `kind` and the HTTP `status`), the retry policy (counted attempts, `retry-after`, an abort-aware backoff), and `tokenCostUsd`, a token cost formula with the same arithmetic as our OpenAI-compatible and Anthropic adapters' own (their tests hold the three equal on the bundled presets).
  - **Behind `@kindgi/adapter-model-shared/ai-sdk`,** today's engine, the AI SDK's provider packages called at the spec level (never the `ai` package or Vercel's gateway). `createAiSdkModelProvider` turns a provider's model into a `ModelProvider`. It carries the reasoning state across a pause in the first tool call's `signature` (back only to the same provider's same model), puts usage onto Kindgi's counters, drops refused sampling with a warning, and sends `traceparent` only when set. This entry point is for Kindgi's own adapters, with no compatibility promise across a change of engine.
- Updated dependencies [a2b2ae8]
  - @kindgi/capabilities@0.1.6-rc.0
