# @kindgi/sdk

## 0.1.3

### Patch Changes

- Updated dependencies [2544717]
- Updated dependencies [0f226c2]
- Updated dependencies [629057d]
- Updated dependencies [786cbde]
- Updated dependencies [38935d3]
- Updated dependencies [1463b77]
- Updated dependencies [aa4399f]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [2c185d8]
- Updated dependencies [eac7732]
  - @kindgi/agents@0.1.3
  - @kindgi/client@0.1.3
  - @kindgi/guardrails@0.1.3
  - @kindgi/handler-runtime@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/tools@0.1.3
  - @kindgi/crypto@0.1.3
  - @kindgi/flow@0.1.3
  - @kindgi/schema@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- 80210cb: The getting-started skills (TypeScript and Python) say how an app reads what a run did: it stores the run's id on its own row and reads the status, output, journal and provenance through the API, hearing about finished runs from the `run.finished` webhook. They also say what not to do: query Kindgi's database, or send users to Kindgi's console.
- 5c9594b: The tool-authoring skill says what a pack's image needs from the app's own install scripts, which don't run there: `prisma()` from `@kindgi/sdk/build` for a tool that uses Prisma's client, `defineBuildExtension` for other generate steps, and `image.systemPackages` / `image.buildEnv`.
- da1a8da: The Python getting-started skill names Node 22.12, the floor the CLI now needs.
- Updated dependencies [966a615]
- Updated dependencies [610a9de]
- Updated dependencies [afd259f]
- Updated dependencies [a994217]
- Updated dependencies [89a14b6]
  - @kindgi/agents@0.1.2
  - @kindgi/client@0.1.2
  - @kindgi/crypto@0.1.2
  - @kindgi/flow@0.1.2
  - @kindgi/guardrails@0.1.2
  - @kindgi/handler-runtime@0.1.2
  - @kindgi/schema@0.1.2
  - @kindgi/tools@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- 0fe5626: **`createClient()` from `@kindgi/sdk/client` finds the runtime by itself.** Every option is optional now:
  - `apiUrl` and `auth` come from `KINDGI_API_URL` and `KINDGI_API_TOKEN`;
  - in development, when those aren't set, from the running `kindgi dev` (the nearest `.kindgirc.json`), with a one-time warning to put them in your env file (`.env` / `.env.local`);
  - a token that doesn't match the running `kindgi dev`'s for the same URL (after `kindgi dev --reset`) is warned about once.
  
  Production (`NODE_ENV` or `KINDGI_ENV` = `production`) never reads `.kindgirc.json`, and a missing setting there is an error that says what to set. Explicit options win, field by field. `@kindgi/client`'s `createClient` stays the explicit client underneath (and the one for browsers).
- 5ef3129: The flow skills describe conditions on a missing value as they behave (`ne` is true, the other comparisons false) and say a number segment in a path indexes an array.
- d28e1fd: **`@kindgi/sdk` declares zod v4 as an optional peer dependency** (`zod: ^4.0.0`), as its tool, agent, guardrail, schema and handler-runtime packages already do. Schemas can be JSON Schema or zod v4, so zod stays optional; an app that has zod 3 is now flagged by its package manager at install. An app whose own code imports zod (every example does) still lists `zod` in its own dependencies, which `kindgi init` adds.
- ca66617: Skills: `kindgi-getting-started` no longer points at a `demo.echo-agent` that `kindgi dev` doesn't register; it runs the sample template's `<pack-id>.echo-agent` and says what `dev-echo` can and can't do. The authoring skills link this release line's API reference (docs.kindgi.com/v0.1/…) instead of a contributor-only typedoc command; `check:refs` keeps skills' docs links on the current minor. The guardrail skills say that only `halt` acts in 0.1 (`retry`, `escalate` and `compensate` are recorded), give the real error for an unregistered guardrail, and say a pack's guardrail `config` isn't validated; the tools skill no longer promises a field path in `input-validation-failed`. `kindgi-authoring-providers` 0.9.2: `defineAgent` takes `preferredModel` too, and the adapter ids are listed (there is no `kindgi adapters list`).
- bbe0bc9: The tool-authoring skills (TypeScript and Python) say that a package a tool imports at runtime must be in the app's dependencies, not dev dependencies: the deployed pack installs production dependencies only. The getting-started skills point to it from their existing-app sections.
- Updated dependencies [319a134]
  - @kindgi/handler-runtime@0.1.1
  - @kindgi/client@0.1.1
  - @kindgi/agents@0.1.1
  - @kindgi/crypto@0.1.1
  - @kindgi/flow@0.1.1
  - @kindgi/guardrails@0.1.1
  - @kindgi/schema@0.1.1
  - @kindgi/tools@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: A `kindgi-authoring-flows` skill for TypeScript packs:
  - `defineFlow` with tool and agent steps;
  - edges and `when` conditions, including why `ne` on a missing path never fires;
  - branches that join again, `inputMapping` and typed agent output in a flow (`nodeOutputs.<step>.output.<field>`), and the flow's declared `output`;
  - loops, fanout, and edge retry and timeout;
  - running a flow (`--no-wait`, `--dry-run`) and reading its journal.
  
  `kindgi-authoring-agents` gains "What a turn receives": a direct run's input (`userMessage`, `conversationId`, `parameters`) versus a flow step's structured input (`{{ input.* }}`, `config.parameters`, `config.version`). `kindgi-getting-started` routes flows to the new skill.
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
- aec851d: An application lists `@kindgi/sdk` and `@kindgi/cli` (dev) and needs no other `@kindgi/*` package:
  
  - `@kindgi/sdk/client` re-exports `subscribeToRun` and `followRun` (with `SubscribeToRunOptions`, `FollowRunOptions`, `RunProgressEvent`, `RunProgress`), so a browser page follows a run from the sdk.
  - New `@kindgi/sdk/webhooks` (server only): `verifyWebhook`, `generateWebhookSecret`, `isStrongWebhookSecret`, `signWebhook`, `webhookHeaders` and the webhook constants and types, re-exported from `@kindgi/crypto`. It stays out of the flat barrel, since it uses `node:crypto`.
  
  The run-events doc and the flows and guardrails skills import from the sdk.
- aec851d: Skills for Python packs: `kindgi-python-getting-started`, `kindgi-python-authoring-tools`, `kindgi-python-authoring-guardrails` and `kindgi-python-authoring-agents` (`pack_languages: [python]`), so a Python pack's coding agent learns `@tool`, `@guardrail`, `Agent` and `Flow` — schemas from pydantic models, `ToolContext` and cancellation, configuration from the environment, config defaults for checks (a pack guardrail is evaluated with `{}`), camelCase keys inside an agent's dicts, tests, wiring, flows and `kindgi.client`. A Python pack now gets these four with the shared providers, MCP-servers and framework-feedback skills; a TypeScript pack is unchanged. The TypeScript guardrails skill says the index now carries a guardrail's `config` (#17).
- aec851d: Every bundled skill declares the pack languages it is written for (`pack_languages` in its frontmatter), so `kindgi init` and `kindgi skills sync` copy a Python pack only the skills that apply to it. The providers, MCP-servers and framework-feedback skills cover Python packs (`[tool.kindgi]` in `pyproject.toml`, the `kindgi` on `PATH`, `preferred_provider=`); the getting-started and authoring skills stay TypeScript. The providers skill lists the current Claude models and prices, and says to run `kindgi dev --no-dev-echo` once a real provider is registered — dev-echo otherwise keeps answering for any provider id that sorts after it.

### Patch Changes

- aec851d: The `kindgi-authoring-tools` skill says what `mutating` does: `mutating: false` declares a tool read-only, so it runs in a dry run and approval gates don't ask before it by default; leaving it out counts as mutating. The `kindgi-authoring-flows` skill had this backwards in its common mistakes; it now lists both real mistakes (`mutating: false` on a tool that writes, a read-only tool without it), and its example flow drops the id casts `defineFlow` no longer needs.
- aec851d: A pack declares the process environment its code reads, and the pack service says what's missing.
  
  - **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
  - **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
  - **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
  - **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
  - **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
  - **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
- 1f81d37: `kindgi-authoring-providers`: an OpenAI-compatible provider works (the runtime registers the adapter); a keyless endpoint such as Ollama needs no placeholder `secret_ref`; and what a model you serve yourself must do for an agent: tool calling on, thinking off (on the server, or per request with `extraBody.*` keys in `adapter_config`).
- aec851d: `kindgi-python-authoring-flows`: a flows skill for Python packs (`pack_languages: [python]`), the counterpart of `kindgi-authoring-flows` — `Flow(...)` with Tool and Agent objects as refs, tool and agent steps, edges and `when` conditions, joins, `inputMapping` in wire names, typed agent output, the flow's output, loops and fanout, edge policy, and running a flow. The Python getting-started skill points to it.
- aec851d: The `kindgi-python-authoring-tools` skill: HTTP tools in Python — `http_tool(...)` declares a tool that is one HTTP request, with no handler; the Kindgi runtime makes the request.
- aec851d: The Python tools and flows skills: `mutating=False` sets a tool's approval default only when an agent turns tool approval gates on and has neither an override for the tool nor a `default`; both `mutating` mistakes are listed (a read-only tool left unmarked, and a writing tool marked read-only).
- aec851d: `kindgi-python-getting-started`: a Python pack declares the process env its code reads in `[tool.kindgi.env]` (`required`, `optional`; names only), and a deployed pack service missing a required one isn't ready.
- aec851d: The `kindgi-python-getting-started` skill: `kindgi build` installs from `uv.lock` or a Poetry app's `poetry.lock`; `[tool.kindgi.image] system-packages` adds Debian packages to the image; `kindgi init` takes a Poetry 1 app's name from `[tool.poetry]`.
- aec851d: The `kindgi-python-authoring-tools` skill: `@tool(mutating=False)` declares a Python tool read-only, so it runs in a dry run and approval gates don't ask before it by default.
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
- aec851d: `ToolContext.secrets`: the secrets a tool declares in `needsSpec.secrets`, resolved by the runtime for the call's tenant, are typed on the handler's context, so a TypeScript pack tool reads `ctx.secrets?.NAME` without a cast. The `kindgi-authoring-tools` skill says how to declare and read them, and that the runtime resolves an HTTP tool's `secretRef` itself.
- aec851d: Tool secrets reach the tools that declare them.
  
  - `@kindgi/env-schema`: `KINDGI_ENV`, the env a runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under it; development mode defaults it to `local`.
  - `@kindgi/handler-runtime`: the indexer carries a declarative tool's `spec` (`defineTool({ spec })`) into `index.json`, so the runtime runs the tool itself and resolves its `secretRef`s, instead of the pack service running it without them.
  - `@kindgi/specs`: `pack-index.schema.json` 1.2.0 adds a tool's optional `spec`. The Python SDK's vendored copy matches.
  - `@kindgi/sdk`: the `kindgi-python-authoring-tools` skill — and the Python SDK's README and `ToolContext.secrets` docstring — say how to declare a secret (`needs_spec={"secrets": …}`) and read it from `ctx.secrets`; `ctx.env` and `ctx.config` are still empty.
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
- aec851d: Fallback providers. `ProviderMetadata.fallback: true` makes a provider serve a capability only when no other provider satisfies it; `route()` then reports `fallback: true`, and a fallback is never an alternate to a regular pick. An agent turn routed to one carries a `fallback-provider` warning (`AgentTurnResult.warnings`). `dev-echo` is a fallback, so registering a real model takes over from it with nothing to switch off — before, ties went to the provider id that sorts first, and `dev-echo` beat `gemini`, `groq` or `ollama`. `POST /v1/providers` accepts and returns `fallback`; the clients carry it. The providers and getting-started skills describe it, and register Anthropic or Gemini with `kindgi providers register --preset` (the CLI's presets).
- aec851d: A run blocked by a guardrail now says which one, and clients get it as a typed error.
  
  - `@kindgi/agents`: the `guardrail-violation` message (and the `turn.failed` event's) names each blocking guardrail with its check's reason — `Turn blocked by guardrail 'no-pii': Response contains an email` — instead of only counting them.
  - `@kindgi/client` (re-exported by `@kindgi/sdk`): new `GuardrailViolationError` variant of `KindgiError` (`code: 'guardrail-violation'`, `violations[]` with `guardrailId` / `severity` / `action` / `reason?`, `evaluationErrors[]`). `fromWire()` previously returned it as a generic `ServerError`. Exhaustive `switch (err.code)` statements need the new case.
  - `@kindgi/api`: `POST /v1/runs` sends a binding failure's `details` as the wire error's `details`; they were nested under `details.details`, so clients could not read them.
- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).
- aec851d: JSON Schema descriptions (51, across 12 schemas and their bundled copies) now match the code and stay inside this repository: neutral examples (`acme.*`), no vendor names the code doesn't target, "the Kindgi runtime" instead of "the OS", no roadmap notes, and corrected claims (tool `needs` are declarative, `capability-unsatisfiable` happens at routing time, `step.cancelled` wording, SSE `eventId`). `Capability.budget` and `Guardrail.budget` are documented as declarative — not enforced by the runtime — in the schemas and the TypeScript types. Only `description` values changed; keys, types, enums and `$comment` schema versions are unchanged.
- aec851d: - `@kindgi/env-schema`: `KINDGI_DATABASE_URL`'s documented dev default is now `postgres://localhost:5432/kindgi`, matching the runtime's new default database name.
  - `@kindgi/sdk`: the `kindgi-getting-started`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback` skills no longer list `sources:` paths outside this repository.
- aec851d: A tenant can hold every agent to its own approval rules: a new policy kind, `hitl`.
  
  - `@kindgi/policy-contract`:
    - **The kind.** `hitl` joins `POLICY_KINDS`. Its spec, `HitlSpec` (`{ maxTimeoutMs?, minReviewerRole?, tools? }`), only tightens an agent's own approval rules: the shorter timeout, the higher reviewer role, and per tool id the stricter gate. `tools` maps a tool id to a mode (`never_ask`, `ask_on_first_use`, `always_ask`) or a rule `{ mode, requiredRole? }`.
    - **Exports.** `HitlSpec`, `ToolHitlMode`, `ToolHitlRule`, `ReviewerRole`, `TOOL_HITL_MODES`, `REVIEWER_ROLES`, `validateHitlSpec`, `combineHitlSpecs` (one spec at least as strict as each), and the helpers `toolHitlRule`, `stricterToolHitlRule`, `higherRole`.
    - **`validatePolicySpec(kind, spec)`** checks a spec against its kind's contract, for `tool-errors` and `hitl`. Other kinds pass.
  - `@kindgi/agents`:
    - **Applied per turn.** A turn resolves its approval rules once, at `setup` (and again when it resumes): the agent's `conversationPolicy.hitl`, held to the tenant's `hitl` policy through `policyRegistry`. Each tool call is gated by the stricter of the agent's rule for that tool and the tenant's.
    - **Fails closed.** When the tenant's `hitl` policy can't be evaluated, the turn fails with the new `tenant-policy-unavailable` error (`TenantPolicyUnavailableError`, which carries `policyKind`). Running without the policy would skip the tenant's approvals. No `hitl` executor bound means no tenant policy, as before.
    - **Breaking (preview):** `resolveEffectiveHitlPolicy({ tenant, agent })` takes the tenant's `HitlSpec` or `undefined`. `TenantHitlPolicy` is removed. `EffectiveHitlPolicy` gains `toolFloors`. An agent's tool modes and rules use `@kindgi/policy-contract`'s `ToolHitlMode` and `ToolHitlRule`, unchanged in shape.
  - `@kindgi/api`:
    - **Checked when written.** `POST /v1/policies` refuses a `tool-errors` or `hitl` spec that breaks its contract, with `validation-failed`. Each issue is pathed under `spec`, e.g. `spec/tools/acme.pay/mode`. Before, such a spec was stored and only found out on a turn.
    - **Status.** `tenant-policy-unavailable` maps to 503. `PolicyKind` includes `hitl`.
  - `@kindgi/client`: `PolicyKind` includes `hitl`. The Python client's models do too.
  - `@kindgi/sdk`: the agents skills (TypeScript and Python) say a tenant's `hitl` policy can tighten an agent's gates, never loosen them.
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
  - @kindgi/client@0.1.0
  - @kindgi/tools@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/flow@0.1.0
  - @kindgi/handler-runtime@0.1.0
  - @kindgi/agents@0.1.0
  - @kindgi/guardrails@0.1.0
  - @kindgi/crypto@0.1.0
  - @kindgi/schema@0.1.0
