# @kindgi/env-schema

## 0.1.4-rc.4

No changes in this release.

## 0.1.4-rc.3

No changes in this release.

## 0.1.4-rc.2

### Patch Changes

- 149a8c9: **`KINDGI_COMPLIANCE_CLASSIFIER` turns on the audit trail's compliance features**, off by default. Set it to `shipped` (the classifier the runtime ships) or to the absolute path of your own classifier JSON. When set, the runtime serves `/v1/compliance/*` and **purges audit events by kind, as the classifier says**.
  
  With `shipped`:
  
  | Audit events | Purged after |
  |---|---|
  | Authorization decisions | 90 days |
  | Authorization denials | 365 days |
  | Run outcomes and guardrail violations | 730 days |
  | Secret changes and approval decisions | never (legal hold) |
  | Kinds the classifier doesn't list | never |
  
  Unset: no `/v1/compliance/*`, and no audit event is ever purged.
  
  `AuditEventPurgeInput` gains optional `outcome` / `exceptOutcome`, so a kind's denials can be kept longer than the rest (a classifier's `onDenyDays`). The in-memory binding honors both.
- 7c084e1: New server setting `KINDGI_RETENTION_SWEEP_INTERVAL_MS`, off by default: when set, the runtime purges deleted rows on its own on that interval, in every tenant it serves. It purges the tombstones past their retention policy's grace, as `POST /v1/retention/sweep` does, keeps holds (`graceSeconds: -1`), and logs what it purged. Unset, nothing purges on its own, as before. At least 60000 (one minute).

## 0.1.4-rc.1

### Patch Changes

- 846dd9c: `KINDGI_RUN_LEASE_MS` and `KINDGI_RUN_SWEEP_INTERVAL_MS` say they cover eval runs too: a running eval run holds the same executor lease, and when its server stops without a shutdown, the sweep ends it `failed`, interrupted, with its finished cases kept.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.

## 0.1.4-rc.0

No changes in this release.

## 0.1.3

### Patch Changes

- 4ed3d2f: CLI fixes from a pilot's feedback, and the runtime's port order.
  
  - **`kindgi runs start` never loses the run.** It starts the run in the background and follows it, rather than holding the start request open. A long agent turn no longer times out the CLI with no run id to look it up by. It still waits until the run finishes or waits on an approval, and prints the same record. A stopped wait (Ctrl+C) prints `Stopped waiting. Run <id> goes on: kindgi runs get <id>`.
  - **The Gemini preset uses the models' real output limit:** 65,536 tokens for Gemini 2.5 Pro and Flash, thinking included. It used to cap Pro at 8192. `kindgi providers register --preset=<name> --max-output-tokens=<n>` sets another cap.
  - **`kindgi env plan --format=gcloud` emits `--update-env-vars` / `--update-secrets`.** They add or replace the names listed and leave the service's other variables alone. `--set-*` replaced the whole env.
  - **`KINDGI_API_PORT`'s description states the port order.** The runtime takes the first that's set: the `--port` flag, `KINDGI_API_PORT`, the platform's `PORT` (Cloud Run, Render, Heroku and Fly set it), the config file's `port`, then 4000.
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- 66e7ac2: `KINDGI_WEBHOOK_PRIVATE_NETWORKS` (`allow` | `deny`, default `deny`): a self-hosted runtime's webhooks may go to a receiver on its own private network, at an RFC 1918, CGNAT (100.64.0.0/10) or IPv6 unique-local address. Loopback, link-local (the cloud metadata endpoints) and unroutable addresses stay refused, and webhooks stay https only. The runtime reads it from 0.1.3.

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- fde369b: The local key for secrets (`KINDGI_SECRETS_BACKEND_KMS=libsodium`): `KINDGI_SECRETS_LOCAL_KEY_PATH` or `KINDGI_SECRETS_LOCAL_KEY`, and `KINDGI_SECRETS_LOCAL_KEY_ACK` (required, exactly `single-node`). A self-hosted runtime without a cloud KMS can keep secrets in Postgres with a key it holds; `KINDGI_SECRETS_BACKEND_KMS` lists `libsodium` as supported.

## 0.1.1

### Patch Changes

- d00fc1b: **The executor lease's timings, for operators.** The runtime fails a run whose server stopped without a shutdown (killed, out of memory, a crash) once the run's lease runs out, and sends `run.finished`. Two `core` variables set how fast:
  
  - `KINDGI_RUN_LEASE_MS`: how long a run's lease lasts without renewal (default 300000, 5 minutes; at least 10000). The server executing the run renews it every quarter of this.
  - `KINDGI_RUN_SWEEP_INTERVAL_MS`: how often each server sweeps for runs whose lease ran out (default 60000; at least 1000, and shorter than the lease).
  
  Out-of-range values stop the server at startup. Such a run is failed within about a lease plus one sweep.

## 0.1.0

### Minor Changes

- aec851d: A deployment's tools and guardrails keep where their code is, and the trust list it's verified against gets routes.
  
  - **`@kindgi/api`, `POST /v1/deployments`:**
    - **What registers is the signed image's index.** The server reads `/app/index.json` from the image, checks it hashes to the signed `indexHash`, and registers what it declares. The request body no longer carries `index`. Before, the route validated and registered the body's copy, which no signature covers, so a replayed request could register tools the image never shipped. The image's index must also name the signed `artifactVersion` (`400 image-unverifiable` otherwise).
    - **The code pointer.** A tool's `modulePath` and a guardrail's `checkModulePath` become `codeArtifactRef: { kind: 'oci', imageRef, modulePath, artifactVersion }`, pointing into the deployed image. Before, they were stripped, so a deployed pack tool had no code the runtime could reach.
    - **What a deployment shipped.** The record gains `contents`: each tool's, agent's and flow's `{ id, version }`, and each guardrail's `{ id }`. `DeploymentRegisterInput` and `Deployment` carry it; it's required, so a `DeploymentBinding` stores it. Versions are immutable and a digest deploys once, so the latest deployment is the live one. A rollback rolls forward: deploy the earlier code again under new versions.
    - **The catalog caches hear of it.** A new deployment calls `onToolWrite` / `onGuardrailWrite` for each tool and guardrail it registered, as `POST /v1/tools` and `POST /v1/guardrails` do, so a runtime's tool and guardrail bridges see it at once. `DeploymentContents` and `DeployedPrimitive` are exported.
    - **Indexed guardrails deploy.** A guardrail's `checkId` becomes its `check`, and the index-only `configSchema` is dropped, as `kindgi dev` maps them. Before, every guardrail the indexer writes failed validation.
  - **`@kindgi/api`, `/v1/signing-keys`:** the tenant's trusted signing keys, the public keys whose deployments verify. Mounted when `signingKeyRegistry` is passed, on its own, without the deployments route.
    - `POST /v1/signing-keys` trusts a key: `keyId`, `publicKey` (base64 Ed25519), `label?`. It returns `201`, or `200` for the same key again. A known id with another key is `409 signing-key-conflict`; rotate under a new id.
    - `GET /v1/signing-keys` lists the active keys (`?includeRevoked=true`, `?label=` prefix). `GET /v1/signing-keys/{keyId}` returns one key, revoked or not.
    - `POST /v1/signing-keys/{keyId}/revoke` takes an optional `reason`. A revoked key stays readable for audit and verifies no new deployments.
    - Writes need the `signing-keys:write` capability.
    - Revocation is final: trusting a revoked key id again is `409 signing-key-revoked`.
    - New error codes: `signing-key-conflict` (409), `signing-key-revoked` (409), `signing-key-algorithm-unsupported` (400), `signing-key-store-error` (500).
  - **`@kindgi/client`:** `client.signingKeys` (`trust`, `list`, `get`, `revoke`); `deployments.register` takes no `index`. The Python client's models and resources follow.
  - **`@kindgi/env-schema`:** the `image-registry` group, how the server reads deployment images: `KINDGI_IMAGE_REGISTRY_HOST`, `_USERNAME`, `_PASSWORD` (credentials for one host, all three or none) and `_INSECURE_HOSTS` (hosts reached over plain HTTP).
- aec851d: `KINDGI_DEV_HOST_ALIAS` (development only): where the server's outbound calls to a loopback address connect instead. Inside a container, loopback is the container itself, so webhooks to the app, HTTP MCP endpoints, a model provider and the pack service on the developer's machine would all miss. `kindgi dev` sets `host.docker.internal` on Docker Desktop. The URL, the `Host` header and the TLS server name stay as written; only the connection goes to the alias.
- aec851d: The server binary's development settings, so `kindgi dev` can run the runtime as a container:
  
  - `KINDGI_API_HOST` (core): the address the API server binds. Default: all interfaces. `127.0.0.1` keeps it off the network.
  - `KINDGI_PACK_DIR` (development only): the pack directory `kindgi dev` runs. The server reads the pack's primitives from the index `kindgi dev` writes there (`.kindgi/dev/index.json`) instead of from Postgres, and signed deployments are off.
  - `KINDGI_DEV_CONSOLE_LOGIN` (development only): the console logs in by itself through `GET /__dev/bearer`, which answers loopback hosts only.
  
  The development settings form a new `dev` group, listed last in `.env.example`. `KINDGI_DEV`'s description now names them.
- aec851d: `KINDGI_LICENSE_KEY`: the commercial license key (`kgi_lk_...`) the server checks offline at startup outside development mode. Without a valid key, a server that isn't in development mode refuses to start; `KINDGI_DEV=true` needs none. `LICENSE_KEY_VAR` names it.
- aec851d: `parseCorsOrigins`, `CORS_ORIGINS_VAR` and `PUBLIC_TOKEN_KEY_PATH_VAR`: the check for `KINDGI_CORS_ORIGINS` (exact origins: a scheme, a host and an optional port; no path or wildcard), so the server and the CLI refuse the same values with the same message.
- aec851d: A pack declares the process environment its code reads, and the pack service says what's missing.
  
  - **`kindgi.config`** takes `env: { required?, optional? }`: the names the pack's code reads from `process.env`. The indexer validates them (environment variable names, no `KINDGI_*`, no name twice) and writes them, sorted, into `index.json` as `env`, which is absent when nothing is declared. A malformed declaration fails indexing as `config-invalid`. `resolvePackEnv` and `missingPackEnv` are exported for tools that check the same thing.
  - **The pack service**, with a required name unset or empty, isn't ready: `/readyz` and every call answer 503 `{ "error": "missing env", "missingEnv": [...] }`, names only. `/v1/info` always lists `missingEnv`, and the names are logged once at startup (`missing-env`). `KINDGI_PACK_ENV_CHECK=warn` serves anyway; anything other than `strict` (the default) or `warn` fails startup.
  - **`@kindgi/specs`:** `pack-index.schema.json` 1.4.0 adds the optional `env`; `pack-protocol.schema.json` 2.2.0 adds the optional `missingEnv` to `info`. The Python SDK's vendored copies match.
  - **`@kindgi/env-schema`:** `KINDGI_PACK_ENV_CHECK` (component `pack-service`).
  - **`@kindgi/pack-conformance`:** cases for the declared env, and `unsupported` on a target, which skips the cases for a part of the contract it hasn't implemented yet.
  - **The `kindgi-authoring-tools` skill** says to declare the names a tool reads.
- aec851d: The pack service's variables, and the server's for reaching it.
  
  - **The `component` axis.** `EnvTarget.component` is `server` (the default) or `pack-service`, the separate process that runs a pack's code. The server's vars don't apply to the pack service's target.
  - **The `packTransport` axis.** `EnvTarget.packTransport: 'http'` is set when the server calls a pack service at `KINDGI_PACK_SERVICE_URL`. Its token is then required.
  - **New vars,** in a new `pack-service` group:
    - `KINDGI_PACK_SERVICE_URL`: the server's address for the pack service. Unset, no pack code runs.
    - `KINDGI_PACK_SERVICE_TOKEN`: the secret shared by the server and the pack service. Required by the pack service, and by the server with an HTTP pack transport.
    - `KINDGI_PACK_CALL_TIMEOUT_MS`: how long one pack call may take (default 120000).
    - `KINDGI_PACK_INDEX` and `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`: the pack service's index path (default `/app/index.json`) and call cap (default 32). The pack service already reads both; they're declared here now.
- aec851d: What a server on Cloud Run needs to reach its pack service and images, and to take its keys without files:
  
  - `KINDGI_PACK_SERVICE_AUTH`: `token` (default) | `google-id-token`, which also sends a Google ID token for an IAM-protected pack service.
  - `KINDGI_IMAGE_REGISTRY_AUTH`: `static` (default, the username and password) | `google`, the server's own Google identity for Artifact Registry.
  - `KINDGI_SECRETS_AAD_KEY` and `KINDGI_PUBLIC_TOKEN_SIGNING_KEY`: the key material itself, base64, as the alternative to the `_PATH` variables (one or the other, not both) for platforms that give secrets as environment variables. `KINDGI_SECRETS_AAD_KEY_PATH` is no longer required on its own: the postgres backend needs one of the two. `PUBLIC_TOKEN_KEY_VAR` names the new signing-key variable.
- aec851d: What a tenant registers can no longer reach the server's own host unless the deployment allows it, and MCP endpoints authenticate through the secrets store.
  
  - **`KINDGI_TENANT_HOST_ACCESS`** (`@kindgi/env-schema`): `deployed` refuses a `stdio` MCP endpoint, a command the server would run in its container as its user. `local` allows it, for a machine where every token holder may run commands. Unset, it's `local` under `KINDGI_DEV` and `deployed` otherwise.
  - **`@kindgi/api`:**
    - `createApp` takes `tenantHostAccess` (default `deployed`). Under `deployed`, registering a `stdio` endpoint answers `403 host-access-denied`, a new error code.
    - `deniesHostReach`, `parseTenantHostAccess`, `TENANT_HOST_ACCESS_LEVELS` and `stdioRefusal` are exported for the runtime's connect-time check. Checks ask `deniesHostReach(level, reach)`, so a stricter level is one more row.
    - `mcpRouter` takes the level as a fourth argument.
  - **`MCPEndpoint.secretRef: { envName, name }` replaces `authRef`.** It's a secret by name in the deployment's store, resolved at the endpoint's tenant scope, the shape webhooks and providers use.
    - `env:NAME` references, which read the server's own environment, are gone.
    - The register body now refuses unknown fields, so an `authRef` is a `400` (`unknown-field`), not silently dropped.
    - The webhook routes and MCP share one `secretRef` parser.
  - **`@kindgi/client`:** `McpEndpoint` and `RegisterMcpEndpointInput` take `secretRef` (`McpEndpointSecretRef`). The Python `kindgi.client` is regenerated: `secret_ref` replaces `auth_ref`.
- aec851d: Tool secrets reach the tools that declare them.
  
  - `@kindgi/env-schema`: `KINDGI_ENV`, the env a runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under it; development mode defaults it to `local`.
  - `@kindgi/handler-runtime`: the indexer carries a declarative tool's `spec` (`defineTool({ spec })`) into `index.json`, so the runtime runs the tool itself and resolves its `secretRef`s, instead of the pack service running it without them.
  - `@kindgi/specs`: `pack-index.schema.json` 1.2.0 adds a tool's optional `spec`. The Python SDK's vendored copy matches.
  - `@kindgi/sdk`: the `kindgi-python-authoring-tools` skill — and the Python SDK's README and `ToolContext.secrets` docstring — say how to declare a secret (`needs_spec={"secrets": …}`) and read it from `ctx.secrets`; `ctx.env` and `ctx.config` are still empty.
- aec851d: `KINDGI_DEV` (development mode; boolean like `KINDGI_DOCS`) and the `dotenv` secrets backend: `KINDGI_SECRETS_BACKEND=dotenv` reads and writes `.env` files in `KINDGI_SECRETS_DOTENV_DIR` (required), optionally narrowed by `KINDGI_SECRETS_DOTENV_FILES` (default `.env,.env.local`). `EnvTarget.secretsBackend` accepts `dotenv`. The server allows the `dotenv` backend only in development mode.
- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).
- aec851d: Public run tokens: a browser can follow a run's progress without a secret API token.
  
  - `@kindgi/api`:
    - `CreateAppInput.publicRunTokens` (`signingKey` + `keyId`, an Ed25519 key; lifetimes; `allowedOrigins`). When set, `POST /v1/runs` returns `publicAccessToken` + `publicAccessTokenExpiresAt` (15 minutes by default), and `POST /v1/tokens/public` mints tokens for up to 50 runs (at most 24 hours).
    - Progress routes: `GET /v1/runs/{runId}/progress` (`RunProgress`: status and timing, no input, output or failure message) and `GET /v1/runs/{runId}/progress/stream` (`RunProgressEvent`: kind, node, sequence, time; no payload). They accept an API token or a public run token. `GET /v1/runs/{runId}` and `/stream` are unchanged and keep requiring an API token.
    - A public run token (`kgi_pt_…`, Ed25519-signed, stateless) is accepted only by the two progress routes (every other route answers 403), for the runs it names and their descendants (others answer 404).
    - The routes a public token may use come from the operation registry (`security: 'bearer-or-public-run'`); the OpenAPI document declares the `publicRunToken` security scheme on them.
    - CORS for `allowedOrigins` on the two progress routes only, ahead of authentication.
    - `mintPublicRunToken` / `verifyPublicRunToken` for deployments that issue tokens themselves.
  - `@kindgi/client`:
    - `subscribeToRun({ apiUrl, runId, accessToken, refreshAccessToken })`: follow a run's progress from a browser with a public token, refreshing it when it expires.
    - `runs.progress`, `runs.streamProgress`, `tokens.createPublic`.
    - `runs.stream` now follows the run to its terminal event: when the server ends the stream at its time limit, it reconnects from the last event instead of ending early. `followRun` is the shared loop; `readSse` takes `lastEventId` and per-attempt `headers`, and throws `SseHttpError` (with `status`) on HTTP errors.
  - `@kindgi/env-schema`: `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` and `KINDGI_CORS_ORIGINS`.

### Patch Changes

- aec851d: The hooks the runtime needs to guard the server's connections to hosts a tenant chose (T83). The guard itself is in the runtime.
  
  - **`@kindgi/api`:** `HostReach` gains `'metadata-network'` (link-local addresses, where the cloud metadata endpoints hand out the server's credentials) and `'loopback'` (the server's own host). `KINDGI_TENANT_HOST_ACCESS=deployed` refuses both, as well as `'exec'`.
  - **`@kindgi/capabilities`:** `AdapterFactoryInput.fetch` is the fetch for a provider endpoint the registration chose.
  - **`@kindgi/adapter-model-openai-compat`:** the factory sends through that fetch.
  - **`@kindgi/tools`:**
    - `defineTool(spec, { synthesizer: { fetch } })` and `ToolSpecSynthesizerOptions`: a declarative HTTP tool's handler sends through the runtime's fetch.
    - `validateToolManifest` now refuses an HTTP tool whose `urlTemplate` puts a `{placeholder}` in the scheme, host or port, or isn't `http(s)://` with a host. Placeholders belong in the path and query, where they're URL-encoded; in the authority, a run's input would pick the host.
  - **`@kindgi/env-schema`:** `KINDGI_TENANT_HOST_ACCESS`'s description says what `deployed` refuses.
- aec851d: Messages and variable descriptions no longer point at internal components: `KINDGI_API_PORT` / `KINDGI_OPENFGA_API_URL` / `KINDGI_SECRETS_BACKEND` descriptions say what the runtime does; the `external` guardrail strategy's error says to register an execution strategy; the payload-version error reads "Unsupported payload version N (this reader handles version M)" — it was worded "newer than this reader" also for older versions.
- aec851d: - `@kindgi/env-schema`: `KINDGI_DATABASE_URL`'s documented dev default is now `postgres://localhost:5432/kindgi`, matching the runtime's new default database name.
  - `@kindgi/sdk`: the `kindgi-getting-started`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback` skills no longer list `sources:` paths outside this repository.
