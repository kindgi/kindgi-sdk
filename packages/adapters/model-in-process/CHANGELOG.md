# @kindgi/adapter-model-in-process

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
- Updated dependencies [f3bd652]
- Updated dependencies [9a8a294]
- Updated dependencies [1131ec3]
  - @kindgi/capabilities@0.4.0

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

- 8dd91b0: **An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
- 8dd91b0: **How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`, and none below its `lowest` when that's `medium` or `high`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`. Each built-in adapter sends the level: Anthropic as `output_config.effort`, with `thinking.type` when a call asks `lowest` of a model whose `lowest` is `disabled` or `between_tools`; Gemini as `thinkingLevel`; OpenAI-compatible endpoints as `reasoning_effort` or `reasoning.effort`, winning over an effort in `extraBody`; Azure OpenAI and Bedrock as the AI SDK's portable `reasoning`, and a level the AI SDK drops is reported as not sent, with `thinking-unsupported`. On Bedrock that includes `none`, which the AI SDK sends nothing for, so `lowest` on a model whose least is `none` or `disabled` gets the model's own default. In-process models don't think, so a level asked of them warns. Each result's `thinking` says the level and what was sent. Gemini's `adapter_config.thinkingLevels` moved to `metadata.models[].thinking.default`: a new registration with it is refused, naming the new place, and a stored one builds without it being read. `GeminiProviderOptions.thinkingLevels` and the `GeminiThinkingLevel` type are gone. The CLI's presets list each thinking model's `levels` from its vendor's pages, so `kindgi providers register --preset` registers them; Bedrock's Claude lists `max` but not `xhigh`, which the AI SDK sends to Bedrock as `max`, and a model whose levels no page settles (Bedrock's GPT models, Vertex's Gemini) lists none. Bedrock's `us.openai.gpt-6-luna` now has `low` as its least thinking, not `none`, which the AI SDK sends nothing for there. A runtime before 0.3.0 refuses a model's `levels`: there, `--preset` registers the models without them, and says so.
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/capabilities@0.3.0

## 0.3.0-rc.0

### Patch Changes

- 8dd91b0: **An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
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

- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8

## 0.1.8-rc.0

### Patch Changes

- Updated dependencies [76532eb]
- Updated dependencies [ebf405d]
  - @kindgi/capabilities@0.1.8-rc.0

## 0.1.7

### Patch Changes

- Updated dependencies [7bd61d6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7

## 0.1.7-rc.0

### Patch Changes

- Updated dependencies [7bd61d6]
- Updated dependencies [f080a20]
  - @kindgi/capabilities@0.1.7-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [a2b2ae8]
  - @kindgi/capabilities@0.1.6

## 0.1.6-rc.0

### Patch Changes

- Updated dependencies [a2b2ae8]
  - @kindgi/capabilities@0.1.6-rc.0

## 0.1.5

### Patch Changes

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
