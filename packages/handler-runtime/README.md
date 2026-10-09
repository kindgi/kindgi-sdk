# `@kindgi/handler-runtime`

Runs a Kindgi pack's own code: its tool handlers and guardrail checks.

- **The pack service**: a long-lived HTTP server that runs a pack's tools and checks over pack protocol v2. It's the process a pack image runs, and `kindgi dev` runs the same process locally, behind a supervisor.
- **The handler runner** (`runHandler`, `runCheck`): runs one tool call or one check in process. The pack service runs every call through it.
- **The build-time indexer** (`kindgi-index`): writes the pack's `index.json`, the list of its tools, guardrails, agents and flows that the pack service and the runtime read.

## Handler runner

`runHandler({ tool, input, ctx })` runs one tool call:

1. Validates a copy of `input` against the tool's input JSON Schema (ajv, Draft 2020-12), filling in each property's `default`. When the module exports a Zod schema (`defineTool`'s `inputZod`), it also parses the input with it, so the handler gets what its type says.
2. Imports `tool.modulePath` and resolves the handler: a bare function export, or `default` / `handler` / `run`, or a `defineTool` export holding one.
3. Calls `handler(input, ctx)`, awaiting a promise.
4. Validates the return value against the tool's output JSON Schema.

`runCheck({ check, config, trace, abortSignal? })` runs one guardrail check: it imports the module, resolves its `evaluate` (`default`, `check`, or a bare export), and calls `evaluate(config, trace, bindings)`. `bindings` carries only `abortSignal`; a check here has no provider registry, so llm-judge checks run in the server.

Neither throws. Each returns `{ kind: 'ok', value }` or `{ kind: 'err', error: HandlerError }`:

| `error.code` | When |
|---|---|
| `input-validation-failed` | The input failed its schema (`issues` lists why). The handler isn't called. |
| `output-validation-failed` | The handler's return value failed the output schema. |
| `handler-import-failed` | Importing the module threw (`cause`). |
| `handler-shape-invalid` | The module exports no handler. |
| `handler-throw` | The handler (or `evaluate`) threw (`cause`). |
| `check-shape-invalid` | The check module exports no `evaluate`. |

```ts
import { runHandler } from '@kindgi/handler-runtime';

const outcome = await runHandler({
  tool: { id: 'acme.lookup', modulePath: '/app/dist/tools/lookup.js', inputSchema, outputSchema },
  input: { q: 'backpay' },
  ctx: { tenantId, runId, abortSignal },
});
```

`importHandler` / `importCheck` replace the default `import(modulePath)` (tests use them). The runner is not a sandbox: the pack service's process is the boundary, and pack code is the team's own.

## Pack service (protocol v2)

A long-lived HTTP server that runs a pack's tool handlers and guardrail checks for a runtime. It's the process a pack image runs, and the same process runs locally during development. Imports happen once at boot, calls run concurrently, and handler console output can't corrupt a response.

```sh
KINDGI_PACK_SERVICE_TOKEN=… PORT=8080 node node_modules/@kindgi/handler-runtime/dist/pack-service/main.js \
  --index dist/index.json          # module paths resolve against --module-root (default: the index's directory)
                                   # --bundle-map <path>: a build's map of the index's source paths to their bundles
                                   # --host <address>: listen on one address (default: every interface)
```

A pack image runs it bundled (`dist/kindgi-pack-service.mjs`) with `--bundle-map`: the index names each module by its source path (`tools/echo/index.ts`), and the map points it at the bundle that loads (`tools/echo/index.mjs`).

| Route | Auth | Answer |
|---|---|---|
| `POST /v1/invoke` | `kindgi-pack-token` | `200` with a v2 response message |
| `GET /v1/info` | `kindgi-pack-token` | pack id, versions, protocol, tools, checks, and the required env names it lacks (`missingEnv`) |
| `GET /healthz` | none | the process is up |
| `GET /readyz` | none | prewarmed, not draining, and every required env name set (unless the env check is `warn`) |

- **Requests** (`@kindgi/handler-runtime/protocol`) name a tool (`{ id, version? }`) or a check (`{ id }`). The service resolves it from its own `index.json`, so a caller never chooses which module is imported.
- **Every outcome of running pack code is a message**, answered with `200`: the result, validation failures (with `issues`), a throw, an unknown tool or check, a version mismatch, `deadline-exceeded` (from `kindgi-timeout-ms`), and `cancelled` (the caller disconnected). HTTP statuses are for the transport only: `401`, `404`, `405`, `413`, `415`, `503` with `Retry-After` when the service isn't ready, is draining, or is at its concurrency cap, and `500` if the service itself fails while handling a call.
- **The declared process env:** a pack lists the environment variables its code reads in `kindgi.config` (`env: { required, optional }`), and the index carries them. With a `required` name unset or empty, the service isn't ready: `/readyz` and every call answer `503` with `{ "error": "missing env", "missingEnv": [...] }`, names only. `KINDGI_PACK_ENV_CHECK=warn` serves anyway and names them in the log (`missing-env`) and `/v1/info`; `kindgi dev` uses it. `resolvePackEnv` and `missingPackEnv` are the shared checks.
- **Cancellation:** the handler's `ctx.abortSignal` fires on a deadline or a disconnect. Handlers that do slow I/O should pass it on.
- **Boot fails** (exit `1`, listing every problem) when the index can't be read, a module it names is missing, or one fails to import. SIGTERM drains in-flight calls and exits `0`.
- **Logs** are JSON lines on stderr. The `listening` line carries the bound port, so a caller can start the service with `PORT=0`.
- **Programmatic:** `createPackService({ index, resolveModule, token, … })` returns a service whose `handle` is a `node:http` request handler. `startPackService(config)` also listens (`@kindgi/handler-runtime/pack-service`).

### Supervisor (local development)

`createPackServiceSupervisor({ command, moduleRoot, env, … })` (`@kindgi/handler-runtime/pack-service`) runs a pack service as a child process behind a **front**: one HTTP listener on a fixed loopback address with a session token, for the supervisor's whole life. A caller — a runtime calling tools — holds that one URL and token however often the code changes.

- `listen()` opens the front; `start(indexPath)` boots a child on the index (loopback, any port) and switches calls to it once it listens. The previous child finishes its in-flight calls and stops; a child that fails to boot leaves the previous one serving; a child that exits on its own is restarted.
- The front forwards `POST /v1/invoke` and `GET /v1/info`, and answers `503` with `Retry-After` while no child serves (the call did not run, so a caller may retry) and `502` when a child died mid-call (it may have run). `/healthz` answers while the front listens, `/readyz` while a child serves.
- `command` is the child's argv; the supervisor appends `--index`, `--module-root` and `--host`. Any pack service with the process contract of [`pack-protocol.schema.json`](../specs/schemas/pack-protocol.schema.json) works: this package's (`[process.execPath, <pack-service-main>]`) or the Python SDK's (`[python, '-m', 'kindgi.pack', 'serve']`).
- The child's environment is exactly `env()` plus the token and `PORT=0`.
- Forwarding is a separate `relay` (a request body plus deadline, run and request ids, and a cancel signal), so a listener other than HTTP can reuse it.
- `stop()` stops the child (the front then answers `503`); `close()` also closes the front.

## Build extensions

`@kindgi/handler-runtime/build-extensions` (re-exported as `@kindgi/sdk/build`): the types and helpers for `image` in a TypeScript pack's `kindgi.config.*`.
- `ImageConfig { systemPackages?, extensions?, buildEnv? }`;
- `BuildExtension { name, contextFiles?, systemPackages?, postInstall?, buildEnv? }`;
- `prisma({ schema, config? })`: `prisma generate` after the install;
- `defineBuildExtension()`.

They're data only: `kindgi build` renders them into the image's Containerfile.

## Build-time indexer

`kindgi-index.ts` writes a pack's `index.json`. A pack image's indexer stage runs it over the image's bundles (process entry `kindgi-index-main`, bundled as `dist/kindgi-index.mjs`), and the emitted `/app/index.json` is `COPY --from=indexer`'d into the runtime image; `kindgi build` runs the same bundle locally, so the two indexes compare byte for byte. The pack service reads `index.json` at boot: it serves exactly the tools and checks the index lists.

### What the indexer does

1. **Discovers** files under `tools/`, `guardrails/`, `agents/`, `flows/` per `kindgi.config.ts` (`.ts` / `.js` / `.mjs` all accepted). Indexing a build (`bundleMap`), the map's source paths are the file list, classified by the same patterns — the source tree needn't be there — each imported from its bundle; the index still records the source path.
2. **Kind-maps** each file by its containing directory (primary) or by structural detection on the default export (fallback for files matched by custom-discovery globs outside the four default folders).
3. **Imports** each file and reads the `default` export — accepting either the raw primitive shape or a `Result`-wrapped envelope from `defineTool` / `defineGuardrail` / etc. Fails loud on: no default export, kind mismatch, or a `Result`-wrapped error.
4. **Converts Zod schemas** — `tool.inputZod` / `tool.outputZod` / `check.configZod` — to their JSON Schema wire form via `@kindgi/schema.toJSONSchemaSync`. JSON-Schema-authored slots pass through verbatim.
5. **Writes** the `v: 1` `index.json` envelope atomically (write to `.tmp-<pid>-<time>`, then rename) to the configured output path.

### Programmatic form

```ts
import { runIndexer } from '@kindgi/handler-runtime';

const outcome = await runIndexer({
  packDir: '/path/to/pack',
  // Optional overrides
  configPath:      '/path/to/kindgi.config.ts',
  outputPath:      '/app/index.json',
  artifactVersion: '20260920.1',                      // pin for reproducible builds
  publishedAt:     '2026-09-20T14:32:07.104Z',        // pin for byte-determinism
});

if (outcome.kind === 'ok') {
  console.log(outcome.value.counts);   // { tools, guardrails, agents, flows }
  console.log(outcome.value.outputPath);
} else {
  console.error(outcome.error.code, outcome.error.message);
}
```

`runIndexer` never throws — every failure surfaces as a typed `IndexerError`:

| Code | When |
|---|---|
| `config-not-found` | No `kindgi.config.{ts,mts,mjs,js,cjs}` at the pack root. |
| `config-parse-failed` | Config file imported but is malformed. |
| `discovery-empty` | Glob patterns matched zero files. |
| `file-import-failed` | Dynamic `import()` of a discovered file threw. |
| `no-default-export` | A discovered file exported no `default`. |
| `kind-mismatch` | File under `tools/` default-exports a non-tool (or symmetric for the other three folders). |
| `ambiguous-kind` | Custom-pattern file whose default export doesn't structurally match any primitive shape. |
| `zod-conversion-failed` | `z.toJSONSchema()` threw for a specific schema. |
| `manifest-validation-failed` | Inner manifest didn't match the expected shape (or was a `Result`-wrapped error). |
| `output-write-failed` | Filesystem write error. |
| `reserved-check-id` | A guardrail ships its own check (an `id` and an `evaluate`, as its `check` or any check its module exports) under a built-in check's id (`RESERVED_CHECK_IDS`: `must-cite`, `never-call-tool`, …), which the runtime would replace with the built-in. Naming a built-in (`check: 'must-cite'`) is fine: that's how to use it. |

Some things the pack should change don't stop the build. The report lists them as `warnings` (`IndexerWarning`), and the pack indexes as it would without them:

| Code | When |
|---|---|
| `check-id-unprefixed` | A check the pack ships (its `id`, as a guardrail's `check` or any check its module exports) doesn't start with the pack's id (`<pack id>.`). Packs in one tenant share one space of check names, so name it `<pack id>.checks.<name>`. A built-in named by its id isn't the pack's check, so it isn't flagged. |

### Loading `kindgi.config.*` on its own

The indexer's config loader is exported so every tool reads the pack
config the same way:

```ts
import { loadKindgiConfig } from '@kindgi/handler-runtime';

const r = await loadKindgiConfig('/path/to/pack');
if (r.kind === 'ok') r.value.pack.id;
// r.kind === 'err': 'config-not-found' | 'config-parse-failed' (message carries the cause)
```

It looks up `KINDGI_CONFIG_FILENAMES` in order and imports the first that
exists (cache-busted by mtime, so a long-running process sees edits). With
none, a `pyproject.toml` whose `[tool.kindgi]` table holds the same keys is
the config — a **Python pack** (`language: 'python'`, unless the table says
otherwise). It checks `pack.id` / `pack.version` and `language`. Never throws.

- `findKindgiConfig(packDir)` — where the config is (`{ path, format: 'module' | 'pyproject' }`), or `undefined`; a `pyproject.toml` without the table is not a pack.
- `packLanguage(config)` — `'node'` or `'python'`: which indexer reads the pack and which pack service runs it. `runIndexer` refuses a Python pack (`language-mismatch`); `python -m kindgi.pack index` indexes it.
- `resolveDiscovery(discovery, language)` — the patterns with the language's defaults (`DEFAULT_DISCOVERY`, `DEFAULT_PYTHON_DISCOVERY`).

### Command-line form

`main(argv)` is the command; the `kindgi-index-main` export runs it as a process (a pack image runs it bundled, as `dist/kindgi-index.mjs`).

```
kindgi-index --pack-dir <path> [--config <path>] [--output <path>]
                [--bundle-map <path> [--module-root <path>]]
                [--artifact-version <str>] [--published-at <iso>]
                [--help] [--version]
```

`--bundle-map` indexes a build: a JSON object of source path → bundle path, the bundle paths relative to `--module-root` (default `--pack-dir`).

### `index.json` shape

```jsonc
{
  "v": 1,
  "packId":          "acme.support",
  "packVersion":     "1.0.0",
  "artifactVersion": "20260920.1",
  "publishedAt":     "2026-09-20T14:32:07.104Z",
  "tools":      [{ "id": "…", "input": { … }, "output": { … }, "effects": [ … ], "modulePath": "tools/…/index.js", "sandbox": "strict", "limits": { … }, "network": { … } }, …],
  "guardrails": [{ "id": "…", "kind": "zero-llm", "action": { "on-violation": "halt" }, "severity": "error", "checkModulePath": "guardrails/…/index.js", "checkId": "…", "configSchema": { … } }, …],
  "agents":     [{ "id": "…", "version": "1.0.0", "instructions": "…", "capabilities": [ … ], "tools": [ … ], "modulePath": "agents/…/index.js" }, …],
  "flows":     [{ "id": "…", "version": "1.0.0", "nodes": [ … ], "edges": [ … ], "kernelPayloadVersion": 1, "modulePath": "flows/…/index.js" }, …],
  "env":        { "optional": ["LOG_LEVEL"], "required": ["DATABASE_URL"] }   // only when the pack declares env
}
```

The pack service:
1. Reads the index at boot (`--index`, else `KINDGI_PACK_INDEX`, else `/app/index.json`) and imports every module it names (prewarm). A missing or failing module fails the boot.
2. For a call to tool `X`, finds `X` in the index and runs it with `runHandler`, with its module path resolved against `--module-root`. A guardrail check is found by its `checkId`.

### Determinism

An index computed on a developer's laptop must match one computed by the build server for the same inputs — byte-identical inputs must produce byte-identical outputs. To make that work:

- All list fields (`tools` / `guardrails` / `agents` / `flows`) are sorted lexicographically by `id`.
- JSON serialization writes keys in sorted order at every level.
- `publishedAt` is accepted as an explicit `opts.publishedAt` (build-arg from the Dockerfile, SOURCE_DATE_EPOCH-shaped). Default: fresh ISO string — non-deterministic; production builds must override it.

## Not in this package

- Running the indexer as part of a pack build — that is the build tooling's job.
- Multi-pack workspace indexing (one pack per subfolder).
- Watch mode / hot re-indexing.
- A signed `index.json` — the image digest, which contains the file, is what gets signed.
- Cross-file dependency validation (an agent referencing a tool the pack doesn't have).
- Bundle-size warnings or thresholds.
- Handler-side telemetry / cost-tracking hooks.
- Streaming output for tools that yield incremental results.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
