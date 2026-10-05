# @kindgi/adapter-model-openai-compat

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
