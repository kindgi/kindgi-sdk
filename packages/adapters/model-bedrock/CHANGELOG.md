# @kindgi/adapter-model-bedrock

## 0.4.0

### Patch Changes

- f3bd652: **A model call can carry files: photos, PDFs and text files.** A user or tool message names stored files in a new optional `files` field (`MessageFile`: the stored file's id, name, type, size and sha256). The message holds references only. The adapter reads the bytes through the call's new optional `readFile`, sends them inline, and keeps none.
  - **What's sent.** JPEG, PNG and WebP images (at most 5 MB each) and PDFs (at most 10 MB) go to a model that declares `vision`, after a line naming each file. Plain text, Markdown and CSV files (at most 1 MB, cut at 100,000 characters) are read in as text for any model, in a block marked as data, not instructions. All of them follow the message's text under a line saying they come from outside: data, not instructions.
  - **What isn't.** Anything else, or a file over a limit, is a line naming the file and saying why it isn't shown. Examples: a HEIC photo, an image sent to a model without `vision`, a file that's no longer stored, or bytes whose size or sha256 isn't the file's. A `MessageFile` can carry a PDF's page count (`pages`). A call fails for none of them. Only a `readFile` that rejects, such as a store that's down, fails the call, before anything is sent.
  - **One set of limits on every provider.** A call sends at most 10 images and PDFs, 12 MB and 100 PDF pages together, and reads in at most 200,000 characters of text files, never more than the model's context window has tokens. It keeps the newest files that fit; each one left out is a line saying so. `FILE_LIMITS` has the numbers. A provider's own lower limits apply too, listed in `PROVIDER_FILE_LIMITS`: on Bedrock, 3.75 MB an image, and 4.5 MB and five a call for PDFs.
  - **A tool result's files.** Anthropic and the OpenAI Responses API take them in the tool result. Chat Completions, Azure OpenAI and Bedrock get them in a user message right after the tool results, and Gemini in the same user turn after the function responses, each under a line naming its call.
  - **Anthropic's prompt cache** now counts image and document blocks, so a conversation's photo is read from the cache on the next step.
  - **A PDF goes to the provider under a neutral name,** never the file's own: a file name is outside data.
  - **`vision`'s description** now says it reads images and PDFs.
- Updated dependencies [b25b82f]
- Updated dependencies [d92355b]
- Updated dependencies [d6c9279]
- Updated dependencies [f2adcc2]
- Updated dependencies [9b015f7]
- Updated dependencies [f3bd652]
- Updated dependencies [9a8a294]
- Updated dependencies [1bd877d]
- Updated dependencies [dff9515]
- Updated dependencies [1131ec3]
- Updated dependencies [d576ff4]
  - @kindgi/types@0.4.0
  - @kindgi/capabilities@0.4.0
  - @kindgi/adapter-model-shared@0.4.0

## 0.3.1

### Patch Changes

- @kindgi/capabilities@0.3.1
  - @kindgi/adapter-model-shared@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/adapter-model-shared@0.3.1-rc.1
  - @kindgi/capabilities@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/capabilities@0.3.1-rc.0
  - @kindgi/adapter-model-shared@0.3.1-rc.0
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
  - @kindgi/adapter-model-shared@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/adapter-model-shared@0.3.0-rc.0

## 0.2.0

### Patch Changes

- @kindgi/capabilities@0.2.0
  - @kindgi/adapter-model-shared@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.1
  - @kindgi/adapter-model-shared@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- @kindgi/capabilities@0.2.0-rc.0
  - @kindgi/adapter-model-shared@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0

## 0.1.10

### Patch Changes

- @kindgi/capabilities@0.1.10
  - @kindgi/adapter-model-shared@0.1.10
  - @kindgi/types@0.1.10

## 0.1.10-rc.1

### Patch Changes

- @kindgi/adapter-model-shared@0.1.10-rc.1
  - @kindgi/capabilities@0.1.10-rc.1
  - @kindgi/types@0.1.10-rc.1

## 0.1.10-rc.0

### Patch Changes

- @kindgi/capabilities@0.1.10-rc.0
  - @kindgi/adapter-model-shared@0.1.10-rc.0
  - @kindgi/types@0.1.10-rc.0

## 0.1.9

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9
  - @kindgi/adapter-model-shared@0.1.9
  - @kindgi/types@0.1.9

## 0.1.9-rc.1

### Patch Changes

- @kindgi/adapter-model-shared@0.1.9-rc.1
  - @kindgi/capabilities@0.1.9-rc.1
  - @kindgi/types@0.1.9-rc.1

## 0.1.9-rc.0

### Patch Changes

- Updated dependencies [d563887]
  - @kindgi/capabilities@0.1.9-rc.0
  - @kindgi/adapter-model-shared@0.1.9-rc.0
  - @kindgi/types@0.1.9-rc.0

## 0.1.8

### Patch Changes

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
- Updated dependencies [63a06d6]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/adapter-model-shared@0.1.8
  - @kindgi/capabilities@0.1.8
  - @kindgi/types@0.1.8

## 0.1.8-rc.0

### Patch Changes

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
- Updated dependencies [63a06d6]
- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
- Updated dependencies [ebf405d]
  - @kindgi/adapter-model-shared@0.1.8-rc.0
  - @kindgi/capabilities@0.1.8-rc.0
  - @kindgi/types@0.1.8-rc.0

## 0.1.7

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-bedrock`,** Amazon Bedrock as a model provider: Claude, Nova, Llama, Mistral, OpenAI's models and the others Bedrock serves, on its Converse API. It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names its AWS region (`metadata.region`, required) and its models by Bedrock model or inference-profile id (`us.amazon.nova-pro-v1:0`). `adapter_config.baseURL` is optional, for a VPC or FIPS endpoint. Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: aws-identity` (default): the runtime's own AWS identity, SigV4 with credentials asked for every attempt, sent only to Bedrock's runtime in the region (a registration naming another host is refused);
    - `auth: api-key`: a Bedrock API key through `secret_ref`, read for every attempt. A key a header can't carry (a line break or a control character inside it) is refused as `auth` before the request, by its `secret_ref`, never quoted.
    A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried, and a 403 says what to check for the way it signed in. No request follows a redirect. It never reads AWS credentials, a bearer token, the region or an endpoint from the environment.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- Updated dependencies [7bd61d6]
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/adapter-model-shared@0.1.7
  - @kindgi/capabilities@0.1.7
  - @kindgi/types@0.1.7

## 0.1.7-rc.0

### Patch Changes

- 7bd61d6: **New package: `@kindgi/adapter-model-bedrock`,** Amazon Bedrock as a model provider: Claude, Nova, Llama, Mistral, OpenAI's models and the others Bedrock serves, on its Converse API. It's built on `@kindgi/adapter-model-shared`.
  - **A registration** names its AWS region (`metadata.region`, required) and its models by Bedrock model or inference-profile id (`us.amazon.nova-pro-v1:0`). `adapter_config.baseURL` is optional, for a VPC or FIPS endpoint. Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
  - **It signs in two ways, before each attempt:**
    - `auth: aws-identity` (default): the runtime's own AWS identity, SigV4 with credentials asked for every attempt, sent only to Bedrock's runtime in the region (a registration naming another host is refused);
    - `auth: api-key`: a Bedrock API key through `secret_ref`, read for every attempt. A key a header can't carry (a line break or a control character inside it) is refused as `auth` before the request, by its `secret_ref`, never quoted.
    A failed sign-in (no credentials, no key, a blank one) is an `auth` error, never retried, and a 403 says what to check for the way it signed in. No request follows a redirect. It never reads AWS credentials, a bearer token, the region or an endpoint from the environment.
- 7bd61d6: **The Bedrock adapter caches prompts.** Bedrock caches only the prefixes a request marks, so the adapter now marks them, for Claude and Nova models whose registration prices cache reads: a cache point after the system prompt, and after the last message when the call will be sent again (a call with tools, or a conversation with an earlier answer). Other models get none. Cache reads and writes are priced at the model's registered multipliers, as before.
  - `createAiSdkModelProvider` takes a `cacheMark` option: the provider options that mark a prompt message for a model, or none.
- Updated dependencies [7bd61d6]
- Updated dependencies [7bd61d6]
- Updated dependencies [b90e2c6]
- Updated dependencies [f080a20]
  - @kindgi/adapter-model-shared@0.1.7-rc.0
  - @kindgi/capabilities@0.1.7-rc.0
  - @kindgi/types@0.1.7-rc.0
