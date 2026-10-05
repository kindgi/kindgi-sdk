# @kindgi/tools

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- 89a14b6: Tools from MCP servers built with the TypeScript MCP SDK are no longer skipped. Their schemas declare JSON Schema draft-07 (`"$schema": "http://json-schema.org/draft-07/schema#"`), and every tool schema compiled as Draft 2020-12 only, so each one failed with `no schema with key or ref "http://json-schema.org/draft-07/schema#"`. An MCP tool's schemas (`transport: 'mcp'`) now compile in the dialect they declare: draft-06, draft-07, 2019-09 or 2020-12 (the default when they declare none), each with its own semantics (a draft-07 array-form `items` is a tuple), and without Ajv's strict mode, a lint for the schemas a pack writes: a server's union `type`s, open tuples and extension keywords are valid JSON Schema. Another dialect is refused, naming it. A pack's own tools are unchanged: Draft 2020-12, in strict mode; one declaring another dialect is refused with a message that says so. `@kindgi/schema` exports the compiler as `compileJsonSchema` (with `dialects` and `strict` options), and `jsonSchemaDialect`. `tool.schema.json`'s `input` and `output` descriptions say which dialects a tool's schemas may be in.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/schema@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

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
- aec851d: `ToolContext.secrets`: the secrets a tool declares in `needsSpec.secrets`, resolved by the runtime for the call's tenant, are typed on the handler's context, so a TypeScript pack tool reads `ctx.secrets?.NAME` without a cast. The `kindgi-authoring-tools` skill says how to declare and read them, and that the runtime resolves an HTTP tool's `secretRef` itself.
- aec851d: `precondition-failed`: a runtime that refuses to run a tool — a secret the tool declares couldn't be resolved, say — throws `ToolPreconditionError(reason, message)` from its handler wrapper, and `invokeTool` reports `{ code: 'precondition-failed', reason }` instead of `handler-error … handler threw`, since the tool's code never ran. `isToolPreconditionError` recognizes one from any copy of the package.
- aec851d: A pack service to run a pack's code over HTTP (pack protocol v2), and tools learn which run they belong to.
  
  - `@kindgi/handler-runtime`:
    - New `./protocol` (v2): tool and check requests name the tool or check by id, and responses are `result`, `check-result` or `error` messages with typed codes (including `tool-not-in-pack`, `tool-version-mismatch`, `deadline-exceeded` and `cancelled`).
    - New `./pack-service`: `createPackService` and `startPackService` expose `POST /v1/invoke`, `GET /v1/info`, `/healthz` and `/readyz`, with token auth, a concurrency cap, a body limit, deadlines, cancellation on disconnect, prewarm and drain.
    - New `./pack-service-main`: the process entry (`KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_INDEX`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`, `PORT`; SIGTERM drains).
    - `HandlerContext.abortSignal` (in-process calls only) lets handlers stop on cancel or deadline.
    - The v1 worker, controller and invokers are unchanged.
  - `@kindgi/tools`: `ToolContext.runId`, the kernel run a call belongs to. `requestId` stays the individual call's id.
  - `@kindgi/agents`: agent tool calls set `runId` to the turn's kernel run. They used to pass only the model's call id.
- aec851d: Tool lookups are bound to one tenant: `ToolRegistry.forTenant(tenantId)` replaces `hydrate`.
  
  - `@kindgi/tools`: `ToolRegistry.hydrate?(tenantId): Promise<void>` is replaced by a required `forTenant(tenantId): Promise<ToolRegistry>` that returns a registry answering for that tenant only. With `hydrate` followed by the tenant-less `resolve`, a multi-tenant implementation had to keep a shared "current tenant", so two tenants' concurrent agent turns could resolve each other's tools. `createToolRegistry` (single-tenant) returns itself; `invalidate(tenantId)` is unchanged. Implementations must add `forTenant` (breaking for custom `ToolRegistry` implementations).
  - `@kindgi/agents`: each turn resolves its tools through `toolRegistry.forTenant(tenantId)` (`resolveTurnTools`).
- aec851d: Tool inputs get their Zod defaults, transforms and refinements.
  
  - `@kindgi/schema`:
    - `toJSONSchema(schema, io)` and `toJSONSchemaSync(schema, converter, io)` take a required `io` (`SchemaIo`, `'input'` or `'output'`). The two sides differ exactly where Zod defaults: on the input side a `.default()` field is optional, on the output side it is required. Before, every conversion produced the output side.
    - `parseWithSchema(schema, value)` parses through a Zod schema's Standard Schema interface: defaults, transforms and refinements applied, or the issues.
  - `@kindgi/tools`:
    - A tool's advertised input schema is the input side, so a model may leave a defaulted field out.
    - `invokeTool` validates a copy of the input, filling in JSON Schema `default`s. A Zod-authored tool's input is then parsed with `inputZod`, so the handler gets its parsed input. A failed refinement is `input-validation-failed`, with the field's path.
    - A handler's input type defaults to `InferOutput` of the input schema, the parsed type.
  - `@kindgi/handler-runtime`: `runWorker`, which the pack service runs tools through, prepares the input the same way. The indexer converts tool inputs and guardrail config on the input side.
  - `@kindgi/guardrails`: a check's config schema converts on the input side.
  - `@kindgi/agents`: a typed agent's output schema converts on the output side, so downstream steps can rely on every field.
  - `@kindgi/sdk`: the tools skill explains what a handler receives.

### Patch Changes

- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/schema@0.1.0
