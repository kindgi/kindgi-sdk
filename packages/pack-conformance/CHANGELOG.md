# @kindgi/pack-conformance

## 0.1.6

### Patch Changes

- 5bdacf1: **Only the names a pack declares reach its code.** Before the pack's code loads, the pack service (TypeScript, Python, Java and Scala) drops from its environment every variable the pack doesn't declare in `env.required` or `env.optional`. A model key or a password in a self-hosted `--env-file`, meant for something else, no longer reaches a tool or a process a tool starts.
  
  - **What stays:** the declared names, `KINDGI_*`, and the platform's: the process's basics, the language runtime's settings, `PORT`, proxies and certificates, and Cloud Run's, AWS's and Azure's workload identity and metadata (`PLATFORM_ENV_NAMES`, `PLATFORM_ENV_PREFIXES`). Static credentials such as `AWS_SECRET_ACCESS_KEY` aren't the platform's: a pack that needs one declares it.
  - **What it says:** one `warn` record at start, `env-dropped`, with the names it dropped, never their values. A Python image always names `GPG_KEY`, which its base image sets.
  - **The opt-out:** `KINDGI_PACK_ENV_FILTER=off` keeps every variable, as before. `kindgi dev` sets it, since there the pack service gets the app's env files. Any value other than `on` or `off` is a `config-invalid` start.
  - **Java and Scala:** a JVM can't drop a variable from its own environment, so the launcher (`kindgi-pack-java`) does, keeping the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` now sets in the image from the pack's index. The service won't start while a variable the pack doesn't declare still reaches it, or when `KINDGI_PACK_ENV_DECLARED` isn't the index's `env`.
  - **The skills** (tools and getting-started, every language) say so: an undeclared name works under `kindgi dev` and is unset once deployed, so declare every name the code reads.
  - **The conformance suite** checks it for every pack service: an undeclared variable is absent in a tool, the declared ones and the platform's are there, and `off` keeps it.
- 03151ca: **A union of types compiles.** A schema with `type: ['string', 'number', 'boolean', 'null']`, which is what Zod 4 writes for `z.union([z.string(), z.number(), z.boolean(), z.null()])`, used to be refused ("strict mode: use allowUnionTypes…"), while `.nullable()` compiled. It's standard JSON Schema, and every schema compiler now takes it: tool input and output, an agent's typed output, a guardrail check's config, flow and block schemas, and the pack service's validation. `ALLOW_UNION_TYPES` (`@kindgi/schema`) says so.
  - A schema that strict mode still refuses (an open tuple, an unknown keyword) says how out: for a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.
  - The Java pack service validates a union of types too (its CHANGELOG). Python's always did.
- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- Updated dependencies [fdb86ae]
- Updated dependencies [8b60576]
  - @kindgi/specs@0.1.6

## 0.1.5

### Patch Changes

- 88a2846: **The TypeScript pack service checks a check's `config` against the guardrail's indexed `configSchema` before it runs the check, as the Python pack service does.**
  - **A config that doesn't fit** answers `input-validation-failed`, with `checkId` and the issues, and the check doesn't run.
    - **Before:** a check defined with `defineCheck` refused it as `handler-throw`.
    - **Before:** a check whose `configSchema` was only on the guardrail ran with it.
  - **The message names the first issue** in both pack services: `Check "<id>" config failed validation at /maxChars: must be > 0`. A runtime reports a check's error by its code and message alone.
  - **The config is checked as sent.** The schema's defaults aren't filled in, as when the indexer checks a declared config; the check's own schema fills them in.
  - **A `configSchema` that doesn't compile** answers `input-validation-failed` in both pack services, as a tool's input schema does. The Python pack service used to skip the check.
  - **`CheckInvocationSpec.configSchema`** is new and optional, for `runCheck`.
  - **pack-conformance** has a case for it, so the two services can't diverge again.
- f0a9b41: The suite runs against the Java pack service too. The package ships the fixture pack in Java (`fixtures/java-pack`, a `kindgi.config.json` and its classes under `src/main/java`), next to the Node and Python ones. `FIXTURE.md` is unchanged: same ids, same behaviour.
- 9b03544: The suite runs against Scala packs too, on the Java pack service. The package ships the fixture pack in Scala (`fixtures/scala-pack`, a `kindgi.config.json`, its sources under `src/main/scala` and the sbt build that compiles them), next to the Node, Python and Java ones. `FIXTURE.md` is unchanged: same ids, same behaviour.
- Updated dependencies [0919fe6]
- Updated dependencies [a211c34]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [d94a98c]
- Updated dependencies [70c5737]
- Updated dependencies [646a906]
- Updated dependencies [280377e]
- Updated dependencies [e88c3cc]
  - @kindgi/specs@0.1.5

## 0.1.5-rc.0

### Patch Changes

- 88a2846: **The TypeScript pack service checks a check's `config` against the guardrail's indexed `configSchema` before it runs the check, as the Python pack service does.**
  - **A config that doesn't fit** answers `input-validation-failed`, with `checkId` and the issues, and the check doesn't run.
    - **Before:** a check defined with `defineCheck` refused it as `handler-throw`.
    - **Before:** a check whose `configSchema` was only on the guardrail ran with it.
  - **The message names the first issue** in both pack services: `Check "<id>" config failed validation at /maxChars: must be > 0`. A runtime reports a check's error by its code and message alone.
  - **The config is checked as sent.** The schema's defaults aren't filled in, as when the indexer checks a declared config; the check's own schema fills them in.
  - **A `configSchema` that doesn't compile** answers `input-validation-failed` in both pack services, as a tool's input schema does. The Python pack service used to skip the check.
  - **`CheckInvocationSpec.configSchema`** is new and optional, for `runCheck`.
  - **pack-conformance** has a case for it, so the two services can't diverge again.
- f0a9b41: The suite runs against the Java pack service too. The package ships the fixture pack in Java (`fixtures/java-pack`, a `kindgi.config.json` and its classes under `src/main/java`), next to the Node and Python ones. `FIXTURE.md` is unchanged: same ids, same behaviour.
- 9b03544: The suite runs against Scala packs too, on the Java pack service. The package ships the fixture pack in Scala (`fixtures/scala-pack`, a `kindgi.config.json`, its sources under `src/main/scala` and the sbt build that compiles them), next to the Node, Python and Java ones. `FIXTURE.md` is unchanged: same ids, same behaviour.
- Updated dependencies [0919fe6]
- Updated dependencies [a211c34]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [d94a98c]
- Updated dependencies [70c5737]
- Updated dependencies [646a906]
- Updated dependencies [280377e]
- Updated dependencies [e88c3cc]
  - @kindgi/specs@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 024a47f: **An agent's prompt and settings can come from data blocks, pinned when the agent version is published.**
  
  - **References:**
    - `instructions` is the system prompt, or a prompt block by range: `{ prompt: 'acme.intake-prompt', version: '^1.0.0' }`. Its template and declared parameters are used instead.
    - `settings: [{ id, version }]` lists settings blocks.
    - `modelSettings: { id, version }` names a model-settings block (`MODEL_SETTINGS_SCHEMA`: `temperature`, `maxOutputTokens`).
  - **Pinned at publish:** `POST /v1/agents` and deploys resolve each reference by `pickVersion` into `pins.prompts` / `pins.settings`, alongside the tools.
  - **Refusals:** a reference that matches no published version, names a block of the other kind, names model settings that aren't, or runs on a runtime with no block registry refuses the publish (`400 validation-failed`).
  - **At run time:** a turn loads each block at its pinned version. A resumed turn uses the versions its `setup` journaled (`blockVersions`).
    - The prompt block renders as the instructions.
    - Settings values reach tools as `ToolContext.settings['<id>']` and templates as `settings["<id>"]`.
    - Model settings go into the model call.
    - A block that can't load fails the turn (`block-unresolvable`).
    - `InvokeAgentBindings` takes an optional `blockReader`.
  - **Changed elsewhere:** the agent spec, the pack index, both indexers (TS and Python: `Agent(instructions={...}, settings=[...], model_settings={...})`), and both clients.
  - **Pack protocol 2.4.0:** `callContext` gets optional `settings`, so pack code reads them: `ctx.settings['acme.weights']` in TS, `ctx.settings["acme.weights"]` in Python. Older pack services still answer calls that carry it: a TS one passes it to the handler, a Python one drops it.
  - **`settings` is now a reserved template name.**
- Updated dependencies [024a47f]
- Updated dependencies [2040daf]
- Updated dependencies [9801f64]
  - @kindgi/specs@0.1.4

## 0.1.4-rc.5

### Patch Changes

- Updated dependencies [9801f64]
  - @kindgi/specs@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/specs@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/specs@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2040daf]
  - @kindgi/specs@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/specs@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 024a47f: **An agent's prompt and settings can come from data blocks, pinned when the agent version is published.**
  
  - **References:**
    - `instructions` is the system prompt, or a prompt block by range: `{ prompt: 'acme.intake-prompt', version: '^1.0.0' }`. Its template and declared parameters are used instead.
    - `settings: [{ id, version }]` lists settings blocks.
    - `modelSettings: { id, version }` names a model-settings block (`MODEL_SETTINGS_SCHEMA`: `temperature`, `maxOutputTokens`).
  - **Pinned at publish:** `POST /v1/agents` and deploys resolve each reference by `pickVersion` into `pins.prompts` / `pins.settings`, alongside the tools.
  - **Refusals:** a reference that matches no published version, names a block of the other kind, names model settings that aren't, or runs on a runtime with no block registry refuses the publish (`400 validation-failed`).
  - **At run time:** a turn loads each block at its pinned version. A resumed turn uses the versions its `setup` journaled (`blockVersions`).
    - The prompt block renders as the instructions.
    - Settings values reach tools as `ToolContext.settings['<id>']` and templates as `settings["<id>"]`.
    - Model settings go into the model call.
    - A block that can't load fails the turn (`block-unresolvable`).
    - `InvokeAgentBindings` takes an optional `blockReader`.
  - **Changed elsewhere:** the agent spec, the pack index, both indexers (TS and Python: `Agent(instructions={...}, settings=[...], model_settings={...})`), and both clients.
  - **Pack protocol 2.4.0:** `callContext` gets optional `settings`, so pack code reads them: `ctx.settings['acme.weights']` in TS, `ctx.settings["acme.weights"]` in Python. Older pack services still answer calls that carry it: a TS one passes it to the handler, a Python one drops it.
  - **`settings` is now a reserved template name.**
- Updated dependencies [024a47f]
  - @kindgi/specs@0.1.4-rc.0

## 0.1.3

### Patch Changes

- fceb277: `kindgi dev` no longer misses a save that lands while a rebuild is running. The bundler skipped a rebuild that read the same files as the last one it reported, and told them apart by each file's size and modification time, read once the build had ended. A file saved during a build (an editor's save landing mid-build, or one caught half written, as when watching starts) was read before the save but stamped after it, so the rebuild the save triggered looked unchanged and was dropped: the dev index stayed on the stale build, a half-written file's "refresh failed" included, until the next save. A build during which an input changed (or changed within 3 s of its start, too close to tell) is now never taken for a later one.
  
  The pack conformance fixture has a new tool, `conformance.hold`: it prints `hold: <release>` on stdout and waits until the file `release` exists. The suite's drain, concurrency-cap and disconnect cases hold a call open with it, so each acts once the service has taken the call, and for exactly as long as it needs, rather than after a fixed wait. A pack service in another language implements it in its fixture pack (see `FIXTURE.md`).
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- eac7732: A tool knows its run's project and org: `ToolContext.projectId` and `orgId` (Python: `project_id`, `org_id`), and a guardrail check's trace gets `orgId` (`org_id`) next to `projectId`. The runtime sets them from the run and its project, never from the run's input or a model's arguments, so a tool can compare an org or project id in its input with the run's own instead of trusting it. `orgId` is absent when the project has no org. They reach pack code in the call context: pack protocol 2.3.0 adds optional `projectId` and `orgId` to `callContext`. A pack service built with Kindgi 0.1.1 answers such calls as before (it checks only `v`, `tenantId` and `runId`); `@kindgi/pack-conformance` has a suite that proves it against the 0.1.1 releases (`describeCallContextCompatibility`). Also: `NodeContext.projectId` / `orgId` for the kernel, and `InvokeAgentInput.orgId` and `ResumeAgentTurnInput.orgId`, so a turn resumed after an approval keeps its org.
- Updated dependencies [eac7732]
  - @kindgi/specs@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/specs@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/specs@0.1.1

## 0.1.0

### Minor Changes

- aec851d: A pack declares the process environment its code reads, and the pack service says what's missing.
  
  - **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
  - **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
  - **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
  - **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
  - **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
  - **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
- aec851d: The pack contracts are specs: `pack-index.schema.json` (the `index.json` a pack build emits) and `pack-protocol.schema.json` (pack protocol v2 — the messages, routes, headers and process contract of a pack service). `@kindgi/pack-conformance` checks any language's indexer and pack service against them, black-box, over one fixture pack; the Node pack service and the Python `kindgi` package both pass it.
- aec851d: A pack's code no longer sees the pack service's token.
  
  - **Fix (`@kindgi/handler-runtime`, and the Python SDK's `kindgi.pack.serve`):** the pack service reads `KINDGI_PACK_SERVICE_TOKEN`, then removes it from its process environment before it loads the pack's code. Before, a tool, or any dependency it imported, could read the token. Whoever holds the token can call the pack's tools directly, without going through the runtime.
  - **`@kindgi/specs`:** `pack-protocol.schema.json` 2.1.0 adds this to the process contract, which every pack service follows. The Python SDK's vendored copy matches.
  - **`@kindgi/pack-conformance`:** a new fixture tool, `conformance.process-env`, returns the `KINDGI_` variables its process can see. The new case "pack code doesn't see the service token" checks it, in every implementation.

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/specs@0.1.0
