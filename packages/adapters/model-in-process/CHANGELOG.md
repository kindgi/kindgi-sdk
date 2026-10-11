# @kindgi/adapter-model-in-process

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
