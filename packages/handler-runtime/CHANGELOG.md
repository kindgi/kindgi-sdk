# @kindgi/handler-runtime

## 0.1.4-rc.4

### Patch Changes

- @kindgi/env-schema@0.1.4-rc.4
  - @kindgi/flow@0.1.4-rc.4
  - @kindgi/sandbox@0.1.4-rc.4
  - @kindgi/schema@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/env-schema@0.1.4-rc.3
  - @kindgi/flow@0.1.4-rc.3
  - @kindgi/sandbox@0.1.4-rc.3
  - @kindgi/schema@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- f96bd58: **One Ctrl+C stops `kindgi dev` cleanly, the runtime container included.**
  
  - **Under a package manager** (`pnpm exec kindgi dev`, `npx kindgi dev`, a `pnpm run` script), `kindgi dev` no longer exits at once with code 130 and leaves the runtime container running. A terminal's Ctrl+C signals the whole process group, and the wrapper signals its child too: `npx` and `pnpm run` forward SIGINT; `pnpm exec` sends SIGTERM. So one Ctrl+C arrived twice and was read as the second, forced one.
    - A signal that comes with the first is now the same Ctrl+C. That holds even when it's handled late because the stop held the event loop: closing the file watcher takes over a second on macOS.
    - A SIGTERM never forces the exit.
    - Pressing Ctrl+C again later still forces it.
    - `pnpm exec` itself exits at once, so the prompt returns while `kindgi dev` finishes stopping and prints "stopped.".
  - **The pack service isn't restarted mid-shutdown.** Its child gets the same Ctrl+C and exits. `kindgi dev` printed "pack service exited (SIGINT) — restarting" and started a new one. It now marks the pack service as closing the moment the stop arrives.
  - **Every shutdown step runs**, even after one fails, so the runtime container is removed either way.
  - **`@kindgi/handler-runtime`**: the pack service supervisor has `beginClose()`. From then on a child that exits is expected, not restarted, and `start()` is refused. `close()` does this too.
- fe0ad36: **A pack service child stopped by the terminal's Ctrl+C isn't reported as a crash while `kindgi dev` stops.** Ctrl+C (or closing the terminal) signals the whole process group, the pack service's child included. Under load, the child's exit could be handled before `kindgi dev`'s own stop, which printed "pack service exited (SIGINT) — restarting" mid-shutdown; nothing actually restarted. A child killed by SIGINT or SIGHUP now gets two event-loop turns for its owner's stop to arrive before it counts as a crash. Every other exit is reported at once, as before.
- Updated dependencies [149a8c9]
- Updated dependencies [2040daf]
- Updated dependencies [7c084e1]
- Updated dependencies [ae417f7]
  - @kindgi/env-schema@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/flow@0.1.4-rc.2
  - @kindgi/sandbox@0.1.4-rc.2
  - @kindgi/schema@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [846dd9c]
- Updated dependencies [b8ff156]
- Updated dependencies [c0f1b56]
  - @kindgi/env-schema@0.1.4-rc.1
  - @kindgi/flow@0.1.4-rc.1
  - @kindgi/sandbox@0.1.4-rc.1
  - @kindgi/schema@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

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
- e197294: Two files in a pack that define a tool, guardrail, agent or flow with the same id are an error. The indexer kept both, and the pack service silently served only the last. Now the indexer keeps the first file in path order and reports the second: `tools/b.ts: duplicate tool id 'acme.echo' (also defined in tools/a.ts)` (`manifest-validation-failed`), as the Python indexer already does. That holds for two versions of one id as well: a pack serves one version of each primitive. `kindgi build` and `kindgi deploy` refuse the pack; `kindgi dev` prints the error and loads the rest. The same id on two different kinds (a tool and a flow) is still allowed.
- b52d890: A pack can hold several versions of one tool, side by side: one agent version may pin `acme.scorer@1.0.0` while another pins `2.0.0`. The pack service (TypeScript and Python) keys its tools by id and version: a call runs the version it names; a call that names none runs the tool's only version, and is refused (`tool-version-mismatch`, naming the versions it has) when there are several. `GET /v1/info` lists every version. The Python indexer accepts several versions of one id, keyed by the version the index records (a tool without its own takes the pack's), and refuses the same version twice.
- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/flow@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0
  - @kindgi/sandbox@0.1.4-rc.0
  - @kindgi/env-schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- 38935d3: `KindgiConfig` types two optional fields that `kindgi dev` reads.
  
  - `project`: the project's name, for its dev database and tenant.
  - `providers`: the model providers `kindgi dev` registers, as presets (`{ preset, models?, project?, secret?, maxOutputTokens? }`) or full registrations (`{ spec }`). The new `KindgiProviderDeclaration` type describes them.
  
  In `pyproject.toml` they are `project` under `[tool.kindgi]` and `[[tool.kindgi.providers]]`. Both are additive.
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- Updated dependencies [1463b77]
- Updated dependencies [4ed3d2f]
- Updated dependencies [2c185d8]
- Updated dependencies [66e7ac2]
  - @kindgi/types@0.1.3
  - @kindgi/env-schema@0.1.3
  - @kindgi/flow@0.1.3
  - @kindgi/sandbox@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- afd259f: A TypeScript guardrail's config is resolved by its check's `configSchema`, as Python's guardrails do. `defineCheck`'s `evaluate` gets the schema's defaults applied (a guardrail that declares no config gets them all, so `z.number().default(1)` is 1, not `undefined`), and a config that doesn't fit is refused, naming where. The indexer checks each guardrail's `config` against its schema: a config that doesn't fit, or a required field with no default left out, is a file error, and `kindgi build` refuses the pack.
- Updated dependencies [966a615]
- Updated dependencies [89a14b6]
  - @kindgi/flow@0.1.2
  - @kindgi/sandbox@0.1.2
  - @kindgi/schema@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- 319a134: A pack module that wouldn't load in the image now fails the build, saying why, not as a vague integrity-gate mismatch later.
  
  - **`@kindgi/cli`:**
    - `kindgi build` refuses a pack that imports a package its project lists only in `devDependencies`, before the image is built. The image keeps production dependencies only, so such an import loads locally but not in the image. The message names the package and says to move it to `dependencies`.
    - A Node pack's local index fails the build on file errors (a module that throws on import), as a Python pack's already did.
    - The image's indexer stage runs `kindgi-index --strict`.
  - **`@kindgi/handler-runtime`:** `kindgi-index --strict` exits 1 when a module fails to load, printing each file error. Before, the index was written without that module, and only the CLI's integrity gate noticed: "indexHash mismatch".
- @kindgi/flow@0.1.1
  - @kindgi/sandbox@0.1.1
  - @kindgi/schema@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: Build extensions for a TypeScript pack image: `image` in `kindgi.config.*`, with `@kindgi/sdk/build`.
  
  ```ts
  import { prisma } from '@kindgi/sdk/build';
  
  export default {
    pack: { id: 'acme.app', version: '1.0.0' },
    image: {
      systemPackages: ['tesseract-ocr'],
      extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
    },
  };
  ```
  
  - **`@kindgi/handler-runtime/build-extensions`**, re-exported as **`@kindgi/sdk/build`**:
    - `ImageConfig` and `BuildExtension` (`contextFiles`, `systemPackages`, `postInstall` steps, `buildEnv`);
    - `prisma({ schema, config? })`: copies the schema in and runs `prisma generate` after the install, before the prune. An app's `postinstall` doesn't run in the image;
    - `defineBuildExtension()`.
  - **`kindgi build`** reads and checks `image`, naming any field that's wrong, then renders it:
    - system packages in the base stage;
    - `buildEnv` in the install stage only, never the final image;
    - each step after the install, through the app's package manager (`pnpm exec`, `npx --no`, `yarn`).
- aec851d: A pack declares the process environment its code reads, and the pack service says what's missing.
  
  - **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
  - **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
  - **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
  - **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
  - **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
  - **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
- aec851d: A TypeScript pack image that works: it runs the pack's bundles, installs the app the way the app does, and `kindgi build --local` builds it with this machine's Docker.
  
  `@kindgi/handler-runtime`:
  - `runIndexer({ bundleMap, moduleRoot })` indexes a build. The map's source paths are the file list, classified by the discovery patterns, so the source tree needn't be there. Each file is imported from its bundle, and the index records the source path. `kindgi-index` takes `--bundle-map` and `--module-root`.
  - `kindgi-index-main`: the indexer as a process entry. Before, the image's indexer stage loaded `kindgi-index` and exited without writing an index.
  - The pack service's `--bundle-map`: the modules the index names load from their bundles.
  
  `@kindgi/cli`, `kindgi build`:
  - **Bundles:**
    - the pack's code is bundled, and its installed dependencies stay external, imported by name from the image's `node_modules`;
    - the indexer and the pack service are self-contained bundles;
    - every bundle is `.mjs` with sourcemaps, plus `dist/bundle-map.json` and the bundled `kindgi.config`;
    - the local index runs the same bundled indexer over the same bundles as the image, so the integrity gate compares like with like.
  - **Install:** the app's own package manager from its own lockfile, frozen with scripts off, then the build scripts the app allows, then a prune to production. pnpm and yarn come through corepack and the `packageManager` field. A pack in a workspace member sits at its own path.
    - `.npmrc` and `.yarnrc*` are build secrets, never in the context.
    - A dependency linked from outside the project is refused, with what to do instead.
    - The synthesized `package.json` is gone.
  - **Base image:** `node:22` or `node:24-bookworm-slim`, pinned by image index digest, picked from `engines.node` (`scripts/refresh-node-digests.mjs`).
  - **The Containerfile:** tini, `USER node`, `HEALTHCHECK`, `EXPOSE 8080`, `NODE_ENV=production`.
  - **The context:** the install's files, the bundles and `bundle.include`. The pack's source never ships.
  - **`--local`:** `docker buildx build --load` into the local image store as `kindgi-pack/<packId>:<artifactVersion>`, with the same integrity gate. No build service, no signing.
- aec851d: The pack service is the only way pack code runs. The old run-queue controller and the stdio worker are removed.
  
  - **Breaking (preview), `@kindgi/handler-runtime`:**
    - **Removed:**
      - the run-queue controller (`managed-run-controller`) and its run fetchers (`HttpFetcher`, `InMemoryFetcher`);
      - the per-call sandbox invokers (`tool-sandbox-invoker`, `check-sandbox-invoker`);
      - the version-1 stdio worker protocol: its frames, `encodeFrame`, `parseStdinFrame(s)`, `runWorkerStdio`, the worker's `main` and `PROTOCOL_VERSION`.
  
      None of these had a caller. A pack image now runs the pack service, which replaced them.
    - **Removed exports:** `./managed-run-controller`, `./managed-run-worker`, `./fetchers/http`, `./fetchers/in-memory`, `./tool-sandbox-invoker` and `./check-sandbox-invoker`, and their names on the package root.
    - **The handler runner:**
      - `runWorker` is now `runHandler` (`RunHandlerOptions`), and the check runner is `runCheck` (`RunCheckOptions`), both exported from the package root. They're unchanged apart from the names.
      - `HandlerErrorCode` drops the four stdio-only codes (`malformed-stdin-frame`, `unknown-envelope-version`, `unexpected-frame-kind`, `stdin-closed`).
  - **Fix: a guardrail check in the pack service gets the call's abort signal.** `runCheck` takes `abortSignal` and passes it as `bindings.abortSignal`, and the pack service passes its call's signal, which fires on the deadline or when the caller disconnects. Before, a check got empty bindings and kept running after its call ended.
  - `@kindgi/agents`, `@kindgi/sdk`: comments and a skill's sources name the handler runner.
- aec851d: `createPackServiceSupervisor` takes an optional `token`: the one its front's callers send. Default: a new random one per supervisor, as before. Pass the previous supervisor's token, with its `port`, so a caller started with both keeps reaching the front across restarts. That caller is a runtime running from source for `kindgi dev --runtime-url`. A given token is at least 32 URL-safe base64 characters.
- aec851d: Tool secrets reach the tools that declare them.
  
  - `@kindgi/env-schema`: `KINDGI_ENV`, the env a runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under it; development mode defaults it to `local`.
  - `@kindgi/handler-runtime`: the indexer carries a declarative tool's `spec` (`defineTool({ spec })`) into `index.json`, so the runtime runs the tool itself and resolves its `secretRef`s, instead of the pack service running it without them.
  - `@kindgi/specs`: `pack-index.schema.json` 1.2.0 adds a tool's optional `spec`. The Python SDK's vendored copy matches.
  - `@kindgi/sdk`: the `kindgi-python-authoring-tools` skill — and the Python SDK's README and `ToolContext.secrets` docstring — say how to declare a secret (`needs_spec={"secrets": …}`) and read it from `ctx.secrets`; `ctx.env` and `ctx.config` are still empty.
- aec851d: Flows can say what each step receives and what the run returns (flow schema-version 1.8.0), and a conditional branch that rejoins no longer stalls.
  
  - `@kindgi/flow`:
    - New optional `inputMapping` on tool / agent nodes: each key resolves from `runInput`, `state` or `nodeOutputs.<nodeId>` when the node dispatches, so a step can combine the run input and the outputs of any earlier steps. Without it, a node still receives its single upstream node's output.
    - New optional flow-level `output: { mapping, schema? }` declaring the run's output.
    - `maxParallelism` is now accepted by the schema; it was in the TypeScript type only, so `loadFlow` rejected it.
    - `resolveMapping(mapping, env)` resolves a `Mapping`; a path that does not resolve omits its key.
    - The loader rejects mappings that name no node, map a node's own output, or use a loop-only root, with the new `invalid-mapping` error. An output schema that does not compile is the new `invalid-flow-output` error.
    - Scheduler: a node whose every incoming edge is not taken, or comes from such a skipped node, is skipped. A join after an `if` branch used to wait for the skipped arm forever, so the run ended as stuck.
  - `@kindgi/specs`: `flow.schema.json` 1.8.0 (the `Mapping` and `FlowOutput` definitions; `inputMapping` on leaf nodes; `output` and `maxParallelism` at the root).
  - `@kindgi/handler-runtime`: the indexer validates each discovered flow with `loadFlow`, reporting the loader's message as a file error, and keeps `description`, `maxParallelism`, `metadata` and `output` in `index.json`.
- aec851d: Pack code in any language.
  
  - `createPackServiceSupervisor` takes `command` — the child's argv — instead of `entrypoint`, `nodeBinary` and `nodeArgs`: `[process.execPath, <pack-service-main>]` for this package's service, `[python, '-m', 'kindgi.pack', 'serve']` for the Python SDK's.
  - A pack's config may be the `[tool.kindgi]` table of its `pyproject.toml` (same keys as `kindgi.config.*`): a Python pack. `KindgiConfig.language` (`'node' | 'python'`), `packLanguage`, `findKindgiConfig`, `PYPROJECT_FILENAME`, `DEFAULT_PYTHON_DISCOVERY`; `resolveDiscovery` takes the language. `runIndexer` refuses a Python pack with `language-mismatch`.
- aec851d: `createPackServiceSupervisor` runs the pack service as a local child process behind a stable front: one loopback address and session token for the supervisor's life, forwarding to whichever child serves (code swaps on `start`, the previous child drains, a failed boot keeps the old one, a crashed child restarts). Forwarding is a separate `relay` (request body plus deadline, run and request ids, protocol version, and a cancel signal), reusable by other listeners. A retiring child gets its full drain (`PACK_SERVICE_DRAIN_MS`, 8 s) plus 2 s before it is killed, so a call it would still finish is never cut off.
  
  `pack-service-main` takes `--host <address>` (default: every interface). Stopping the pack service now also closes connections left by callers that went away mid-call, which used to hold shutdown for several seconds.
- aec851d: A pack service to run a pack's code over HTTP (pack protocol v2), and tools learn which run they belong to.
  
  - `@kindgi/handler-runtime`:
    - New `./protocol` (v2): tool and check requests name the tool or check by id, and responses are `result`, `check-result` or `error` messages with typed codes (including `tool-not-in-pack`, `tool-version-mismatch`, `deadline-exceeded` and `cancelled`).
    - New `./pack-service`: `createPackService` and `startPackService` expose `POST /v1/invoke`, `GET /v1/info`, `/healthz` and `/readyz`, with token auth, a concurrency cap, a body limit, deadlines, cancellation on disconnect, prewarm and drain.
    - New `./pack-service-main`: the process entry (`KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_INDEX`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`, `PORT`; SIGTERM drains).
    - `HandlerContext.abortSignal` (in-process calls only) lets handlers stop on cancel or deadline.
    - The v1 worker, controller and invokers are unchanged.
  - `@kindgi/tools`: `ToolContext.runId`, the kernel run a call belongs to. `requestId` stays the individual call's id.
  - `@kindgi/agents`: agent tool calls set `runId` to the turn's kernel run. They used to pass only the model's call id.
- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).

### Patch Changes

- aec851d: The indexer carries a tool's `mutating` into `index.json`. It dropped it, so in `kindgi dev` (and anything built from the index) every pack tool counted as mutating: a dry run never ran a pack tool, and an agent's opt-in per-tool approval gates asked even before read-only ones. `pack-index.schema.json` 1.3.0 adds the optional `mutating`; the Python SDK's vendored copy matches.
- aec851d: A guardrail's `config` reaches the dev index, and the pack service compiles each tool's schemas once.
  
  - `@kindgi/handler-runtime`:
    - **Fix: guardrail `config` in the index.** The indexer now writes a guardrail's `config` (what its check is configured with) to the index. In `kindgi dev`, a configured guardrail ran without its config.
    - **Validators are compiled once.** The pack service compiles a tool's input and output validators once and reuses them, instead of compiling them on every call: about 12 ms off each tool call. An edited schema compiles again, so hot reload still takes effect.
  - `@kindgi/specs`: `pack-index.schema.json` 1.1.0 adds a guardrail's `config`. The Python SDK's vendored copy matches.
- aec851d: `pack-service-main` and `managed-run-worker` run when started through a symlinked path (`node node_modules/@kindgi/handler-runtime/dist/pack-service/main.js` in a pnpm install). They compared `import.meta.url` with `process.argv[1]` as given, so through a symlink they exited 0 without serving.
- aec851d: A pack's code no longer sees the pack service's token.
  
  - **Fix (`@kindgi/handler-runtime`, and the Python SDK's `kindgi.pack.serve`):** the pack service reads `KINDGI_PACK_SERVICE_TOKEN`, then removes it from its process environment before it loads the pack's code. Before, a tool, or any dependency it imported, could read the token. Whoever holds the token can call the pack's tools directly, without going through the runtime.
  - **`@kindgi/specs`:** `pack-protocol.schema.json` 2.1.0 adds this to the process contract, which every pack service follows. The Python SDK's vendored copy matches.
  - **`@kindgi/pack-conformance`:** a new fixture tool, `conformance.process-env`, returns the `KINDGI_` variables its process can see. The new case "pack code doesn't see the service token" checks it, in every implementation.
- aec851d: Failed tool calls go back to the model to correct, under a policy.
  
  - `@kindgi/agents`:
    - **Retries.** When a tool call fails, the failure goes back to the model as the call's result (what failed, the validation issues, what to do), and the turn continues. A failure the policy doesn't retry, or one past its retries, fails the turn as before.
    - **The setting.** `Agent.toolErrors` (`{ maxRetries?, retryOn? }`) sets how many failed calls go back per turn and for which kinds. Default: one retry, for `invalid-arguments` and `unknown-tool`, where nothing ran. `tool-error` (a tool that ran and failed) is opt-in.
    - **Bounds.** Each retry costs a step against `budget.maxSteps`. Retries are counted from the turn's messages, so a replayed turn counts the same.
    - **Errors.** `tool-invocation-failed` and `unresolved-tool` carry `toolRetries` when retries ran out.
    - **Exports.** `DEFAULT_TOOL_ERRORS` and `effectiveToolErrorPolicy`. A rejected HITL tool approval writes its result through the same path as a retry.
  - `@kindgi/policy-contract`:
    - A new policy kind, `tool-errors`. It caps an agent's setting, like every tenant policy: the fewer retries wins, and only kinds both allow are retried.
    - `ToolErrorsSpec`, `ToolErrorKind`, `TOOL_ERROR_KINDS`, `MAX_TOOL_ERROR_RETRIES` (10), and `validateToolErrorsSpec`.
  - `@kindgi/specs`: `agent.schema.json` schema-version 1.3.0 adds `toolErrors`.
  - `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `toolErrors` (`ToolErrorsSpec`). `PolicyKind` derives from `POLICY_KINDS`, so it includes `tool-errors`.
  - `@kindgi/handler-runtime`: the indexer carries an agent's `toolErrors`.
  - `@kindgi/client`: `PolicyKind` includes `tool-errors`, and the generated agent types carry `toolErrors`.
  - `@kindgi/sdk`: the agents skill covers `output` and `toolErrors`, and `preferredModel` as `defineAgent` keeps it.
- aec851d: Typed agent output and structured turn input.
  
  - `@kindgi/agents`:
    - **Typed output.** An agent can declare `output: { schema, name?, maxRepairs? }` (JSON Schema, or a Zod schema converted by `defineAgent`).
      - The final answer must be JSON matching the schema; a fenced JSON block is accepted.
      - An answer that doesn't fit is sent back to the model with the problems listed, up to `maxRepairs` times (default 1, counted against `budget.maxSteps`). After that the turn fails with `output-schema-violation` (`errors`, `attempts`).
      - The parsed answer is `AgentTurnResult.output`, or `null` on a dry run, where no answer is checked.
    - `AgentTurnResult.runId` is the turn's kernel run.
    - **Structured input.** `invokeAgent({ input })` makes `{{ input.* }}` available to the instructions (`input` joins `AUTO_INJECTED_VARS`). It is kept in the run snapshot and passed to guardrails as `trace.attributes.stepInput`.
    - **Parent link.** `invokeAgent({ parent })` records the run that started the turn, for turns started by a flow step.
    - **Resume.** The run snapshot keeps `parameters` and `input`, and `resumeAgentTurn` restores them; a resumed turn used to lose its parameters. Migration `0002` adds the two columns to `agent_run_snapshots`.
    - **Guardrail trace.** `buildRunTrace` now takes the run id, project id, turn number and user message. The trace carries them, so failed checks during a turn produce compliance evidence. Before, `runId` was the conversation id, `turnCount` was the step count, and `projectId` was missing. `attributes.steps` replaces `attributes.turnCount`; a typed answer appears as `attributes.structuredOutput`.
    - `defineAgent` keeps `preferredModel`.
  - `@kindgi/specs`: `agent.schema.json` schema-version 1.2.0 adds `output`, `preferredProvider` and `preferredModel`.
  - `@kindgi/handler-runtime`: the indexer carries an agent's `output`, `conversationPolicy`, `preferredModel`, `description` and `tags`.
  - `@kindgi/dev-echo-provider`: a call with no tools gets the last user message back as the answer, instead of a call to an echo tool the agent doesn't have.
  - `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `output` (`AgentOutputSpec`); `output-schema-violation` maps to 422.
  - `@kindgi/client`: the generated agent types carry `output`.
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
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
  - @kindgi/flow@0.1.0
  - @kindgi/schema@0.1.0
  - @kindgi/sandbox@0.1.0
