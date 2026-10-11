# @kindgi/sdk

## 0.1.6

### Patch Changes

- 9c999e0: `kindgi init` keeps a coding agent working in your project out of the files that hold keys and tokens: `.env*`, `.kindgi/secrets.env`, `.kindgi/dev/runtime.env`, and a self-hosted deployment's `kindgi.env` and `pack.env`. It merges `Read(...)` deny rules for them into `.claude/settings.json` (it never overwrites: missing rules are appended, and a file it can't read as JSON is left as it is, with what to add), and adds them to a `.cursorignore`, `.geminiignore` or `.aiderignore` the project already has. Claude Code reads the settings of the folder a session starts in, so when the pack sits below its git repository's root (a monorepo), `init` also merges the same rules, under the pack's path (`Read(./apps/agent/.env*)`, …), into the root's `.claude/settings.json`, creating it if there's none, and says so: an agent started at the repo root can't read the pack's keys either. A repository rooted at the home folder is left alone (its `.claude/settings.json` is Claude Code's user-wide settings), and `init` says what to add by hand. A settings file `init` can't read as JSON is a warning, never a failure, `--force` included. The getting-started skills tell the agent to keep its hands off those files and to list secrets by name with `kindgi secrets list`. "Your coding agent" in the docs shows the rules and the Claude Code sandbox settings that also keep the agent's shell commands out of them.
- f0da210: **`kindgi dev` runs your pack's code sandboxed.** The tools' code, often written by a coding agent, runs as you; now it can't read your home folder (SSH keys, cloud credentials, registry tokens, other projects), the secret files in the app (`.env*`, `.kindgi`, `.git`, `kindgi.env`, `pack.env`, `.kindgirc.json`, `.npmrc`, `.pypirc`, `.netrc`), other tools' temp files, or the Docker socket and other UNIX sockets (on Linux, those under the home folder, `/tmp`, `/var/tmp` and `/run`). It can't write outside the app either (on macOS every other folder, where a program it replaced would run later outside the sandbox; on Linux the system is read-only), or write Kindgi's configuration (`kindgi.config.*`, `pyproject.toml`), which `kindgi dev` loads. On macOS the keychain, LaunchServices and Apple Events are closed; on Linux the code gets its own session, away from your terminal. It keeps the network, the app's own files, the runtime and the dependencies, and its own temp folder; a process it starts is inside too, and so is the indexer, which loads every module (and its top-level code) to list the pack.
  
  - **macOS:** Seatbelt (`sandbox-exec`). **Linux:** the system's bubblewrap (`bwrap`), which also hides other processes. Where neither can run (Linux without bwrap, Ubuntu 23.10+ without its AppArmor permission, a container, native Windows, or inside another sandbox), `kindgi dev` warns at start and runs your tools without it.
  - **`KINDGI_DEV_SANDBOX`:** `on` (default), `off`, or `required` (stop rather than run without it). `dev.sandbox: false` turns it off for one project.
  - **What runs is worked out at every start:** the runtime (Node, a Python interpreter's own paths, a JDK and the classpath), the links its paths go through (a uv-managed Python, SDKMAN's `current`), and a checkout's linked workspace packages; never a folder that holds the home folder.
  - **With the sandbox on, `kindgi dev` starts only with one Kindgi configuration in the app**, so code can't add another by a name looked up first.
  - **A path or a socket a tool needs:** `dev.sandbox.allowRead` and `dev.sandbox.allowUnixSockets` in the pack's config (`~/.aws` for the AWS SDK's credential chain, a local Postgres socket); `kindgi dev` names each at every start. A path that would open the whole home folder never is.
  - **`kindgi doctor`** says whether `kindgi dev` can sandbox your tools here, and what would fix it.
  - **The pack service supervisor** (`createPackServiceSupervisor`) takes `command` as a function called before every start, and a `cwd`.
  - **The tools skills** tell an agent to open a path in `dev.sandbox.allowRead`, never to turn the sandbox off.
- a2b2ae8: **Examples name current models.** The Java and Scala agent-authoring skills' `preferredModel` and `models.allow` examples use `claude-haiku-5-5` instead of `claude-haiku-4-5`, which Anthropic retires on or after 2026-10-15. The `preferredProvider`, `preferredModel` and `ModelInfo.name` docs give `anthropic` and `claude-sonnet-5-5` as their examples.
- 307771f: Under `kindgi dev`, Kindgi keeps the secrets you store in its own file, `.kindgi/secrets.env`, instead of your app's `.env.local`. A framework like Next.js or Vite loads `.env.local` into every route of your app, so a model key stored there was readable by code that never needs it.
  
  - `kindgi secrets set … --env=local` writes `.kindgi/secrets.env`: owner-only, under the gitignored `.kindgi/`, read after your app's `.env` and `.env.local`, so its value wins. `--app` writes your app's env file instead, for a value both read, such as a webhook signing secret (`appEnvFile` on `POST /v1/secrets`; a runtime with a secrets store refuses it).
  - `kindgi secrets copy [NAME…]` copies model providers' keys (or the names given) from your app's env files into `.kindgi/secrets.env`, merge-only and as written. It never edits or deletes anything in your app's files; it says, per key, that the key is still there and whether git tracks the file. `kindgi dev` gives a one-time hint when it uses a provider's key from a file your app loads.
  - Under `kindgi dev`, the pack service's environment no longer holds a secret stored with `kindgi secrets` (a tool reads it from `ctx.secrets`, as in a deployment), nor any model provider's key, whichever env file holds it. `GET /v1/providers/{providerId}/check` carries the provider's `secretRef` by name, never its value, which is how `kindgi dev` knows the names.
  - A command that can't read an env file says so instead of crashing: `kindgi doctor` reports the model-key check as skipped, `kindgi dev` names the file it can't read, and `kindgi providers register` asks the runtime instead.
- 85ef97c: **A tool's secret can be optional.** A secret declared in `needsSpec.secrets` with a schema that accepts `null` (`{ type: ['string', 'null'] }`) is optional. When the env doesn't have it, or has it empty, it's left out of `ctx.secrets` and the call goes on, with the call's log line naming it. A value that is set is still checked against the schema. A revoked secret, one whose value is gone at its provider though it's still mapped, or a secrets backend that fails, still fails the call. The schema has to name `null`: an unconstrained `{}` stays required. This needs runtime 0.1.6 or later: an older runtime requires every declared secret, failing a call without one with `secret-unavailable`. The guide ("An optional secret"), the authoring skills for every pack language, and the TypeScript and Python context types say so.
  
  `SecretError`'s `secret-not-found` (`@kindgi/api`) gains an optional `reason`: `deleted-at-provider` when the secret is mapped but its provider has no value for it. Absent means it was never stored.
- 5bdacf1: **Only the names a pack declares reach its code.** Before the pack's code loads, the pack service (TypeScript, Python, Java and Scala) drops from its environment every variable the pack doesn't declare in `env.required` or `env.optional`. A model key or a password in a self-hosted `--env-file`, meant for something else, no longer reaches a tool or a process a tool starts.
  
  - **What stays:** the declared names, `KINDGI_*`, and the platform's: the process's basics, the language runtime's settings, `PORT`, proxies and certificates, and Cloud Run's, AWS's and Azure's workload identity and metadata (`PLATFORM_ENV_NAMES`, `PLATFORM_ENV_PREFIXES`). Static credentials such as `AWS_SECRET_ACCESS_KEY` aren't the platform's: a pack that needs one declares it.
  - **What it says:** one `warn` record at start, `env-dropped`, with the names it dropped, never their values. A Python image always names `GPG_KEY`, which its base image sets.
  - **The opt-out:** `KINDGI_PACK_ENV_FILTER=off` keeps every variable, as before. `kindgi dev` sets it, since there the pack service gets the app's env files. Any value other than `on` or `off` is a `config-invalid` start.
  - **Java and Scala:** a JVM can't drop a variable from its own environment, so the launcher (`kindgi-pack-java`) does, keeping the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` now sets in the image from the pack's index. The service won't start while a variable the pack doesn't declare still reaches it, or when `KINDGI_PACK_ENV_DECLARED` isn't the index's `env`.
  - **The skills** (tools and getting-started, every language) say so: an undeclared name works under `kindgi dev` and is unset once deployed, so declare every name the code reads.
  - **The conformance suite** checks it for every pack service: an undeclared variable is absent in a tool, the declared ones and the platform's are there, and `off` keeps it.
- 8b60576: **A tool call's idempotency key.** A run's step can run more than once: resumed after an approval, retried after a failure, or run again when the runtime restarted while it ran. So a tool that changes something (a refund, an email, a payment) could do it twice, with no key to dedupe on. `ToolContext.idempotencyKey` is the same every time the same call runs, and different for every other call: pass it to the system you write to (an `Idempotency-Key` header, a client reference, a unique column), or look for it there first.
  
  - **What it is:** a version 5 UUID (RFC 9562) under a fixed namespace (`TOOL_IDEMPOTENCY_NAMESPACE`), over the run, the step and the tool, plus the model's call id for a call a model asked for (`toolIdempotencyKey`, `@kindgi/tools`). The pack protocol schema says how, so any runtime makes the same key.
  - **The step:** `NodeContext.stepScope` names a step the same every time it runs (its node, a loop body's step with its iteration, a fanout branch). A model's call id alone isn't enough: it's only unique within one of its answers, so two turns of a loop can share one.
  - **Every pack language:** the pack protocol's call context carries it (protocol 2.6.0; an older pack service ignores it). Python `ctx.idempotency_key`, Java and Scala `ctx.idempotencyKey()`. The conformance suite checks that each pack service hands it to the tool, and that a 0.1.1 service still answers a call carrying it.
  - **Absent** outside a run, and from a runtime that can't name its steps (before 0.1.6): the call can't be deduped on it then.
  - **The docs:** "Make a side effect happen once" in Write a tool, and the tools skills (every language). `requestId` is no longer described as an idempotency key.
- fdb86ae: The API reference and the clients no longer offer event triggers and inbound webhooks, which the runtime doesn't serve: it fires schedules only, and `/v1/event-triggers` and `/v1/webhooks` answer 404. The OpenAPI document leaves those operations out, with the schemas only they used. The TypeScript client drops `eventTriggers` and `webhooks` (and their types), and the Python client their resources. A run's `trigger.kind` keeps `event` and `webhook`, now described as not served yet. To react to something outside, start a run with `POST /v1/runs`. The operations stay registered in `@kindgi/api`, marked `unserved`, so they come back when a runtime serves them. Outbound webhook endpoints (`/v1/webhook-endpoints`) are unchanged.
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [540a3d3]
- Updated dependencies [38f2feb]
- Updated dependencies [f0da210]
- Updated dependencies [a2b2ae8]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [1703bab]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [bef2d8c]
- Updated dependencies [fdb86ae]
- Updated dependencies [85ef97c]
- Updated dependencies [5bdacf1]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [f0d6a12]
- Updated dependencies [307771f]
- Updated dependencies [edb2aba]
- Updated dependencies [2a95199]
- Updated dependencies [fdb86ae]
- Updated dependencies [6a4715c]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [26882a9]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [307771f]
- Updated dependencies [03151ca]
- Updated dependencies [fdb86ae]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
- Updated dependencies [8b60576]
- Updated dependencies [bbdccbb]
- Updated dependencies [fdb86ae]
- Updated dependencies [307771f]
  - @kindgi/client@0.1.6
  - @kindgi/agents@0.1.6
  - @kindgi/handler-runtime@0.1.6
  - @kindgi/guardrails@0.1.6
  - @kindgi/tools@0.1.6
  - @kindgi/crypto@0.1.6
  - @kindgi/schema@0.1.6
  - @kindgi/flow@0.1.6
  - @kindgi/types@0.1.6

## 0.1.5

### Patch Changes

- ce53537: `createClient()` from `@kindgi/sdk/client` now finds its settings (`KINDGI_API_URL`, `KINDGI_API_TOKEN`, or the running `kindgi dev`) when the client is first used, not when it's created. A module-scope `const kindgi = createClient()` no longer breaks a production build that runs without them: `next build` loads every route's module with `NODE_ENV=production`, and before this fix that threw. When they're still missing, the first use (`kindgi.runs`, …) throws the same error naming what to set; once they're set, the next use works. The warnings stay one-time, and the client's type is unchanged.
- 52ac75b: The tools skills cover what a coding agent got wrong without them. `kindgi-authoring-tools` 0.4.5 shows a mutating tool's `writes` effect beside `mutating: true` (and the effect kinds), how to log from the handler (`ctx.log`, ids and amounts, never what a person typed), that a tool's tests go beside it, since discovery skips `*.test.*` and `*.spec.*` files and `kindgi test` runs them, and that code the tools share goes outside `tools/` (in `lib/`, say), since discovery loads every file under it. `kindgi-python-authoring-tools` 0.1.3 adds `ctx.log`, with the same rule.
- acee59e: The agents skills (`kindgi-authoring-agents` 0.4.5, `kindgi-python-authoring-agents` 0.1.5) cover memory: `retrieval` intents over facts and earlier conversations (scopes, modes, embeddings, the `<memory>` block as data), and `memory.remember` with the built-in `kindgi_remember` tool, its review rule, and `instructionTypes`.
- ab7aee8: The guardrails authoring skill (`kindgi-authoring-guardrails` 0.3.8) gives each built-in check's config exactly, with what's required, and says a config the check doesn't take is refused (`422 guardrail-config-invalid` when registered, `deployment-validation-failed` when deployed).
- 49907f3: The guardrails authoring skills cover the built-in checks: `kindgi-authoring-guardrails` 0.3.7 shows how a pack names one (`check: 'forbidden-substring'`, no implementation), each one's `config`, and that their ids are reserved for a pack's own checks (`reserved-check-id`); `kindgi-python-authoring-guardrails` 0.1.4 says a `check_id` can't be a built-in's (`DefinitionError`), and that a Python pack writes the rule as its own check, since it can't name a built-in yet.
- a66fa27: The `kindgi-authoring-providers` skill (0.9.9) says a provider spec its adapter can't use is refused when it's registered (`422 provider-config-invalid`, one `✗ <path>: <message>` line per problem), and that `kindgi doctor` names the problems of a registration stored before 0.1.5.
- 0099fe6: The `kindgi-authoring-providers` skill (0.9.10) no longer says Anthropic retires `claude-haiku-4-5` on or after 2026-10-15: Anthropic lists it as active. The skill says to check a Claude model's status on Anthropic's model deprecations page before pinning it, and to prefer the preset's default.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- 9b03544: **Skills for coding agents in Java packs.** A Java pack (`kindgi init --template=java`, or `kindgi init` in a Maven app) now gets five skills of its own in `.claude/skills/`: `kindgi-java-getting-started`, `kindgi-java-authoring-tools`, `kindgi-java-authoring-guardrails`, `kindgi-java-authoring-agents` and `kindgi-java-authoring-flows`. It also gets the shared ones, `kindgi-authoring-providers`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback`, which now say how a Java or Scala pack runs the CLI (`./kindgiw`) and declares its providers (`kindgi.config.json`). Until now a Java pack got none. `./kindgiw skills sync` brings them to an existing pack.
- 9b03544: **Skills for coding agents in Scala packs.** A Scala pack (`kindgi init --template=scala`, or `kindgi init` in an sbt app) now gets five skills of its own in `.claude/skills/`: `kindgi-scala-getting-started`, `kindgi-scala-authoring-tools`, `kindgi-scala-authoring-guardrails`, `kindgi-scala-authoring-agents` and `kindgi-scala-authoring-flows`. It also gets the shared providers, MCP servers and framework-feedback skills. Until now a Scala pack got none: `kindgi skills sync` didn't take `scala`, and neither Scala init path copied skills. `./kindgiw skills sync` brings them to an existing pack.
- Updated dependencies [71ec431]
- Updated dependencies [0919fe6]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [88a2846]
- Updated dependencies [9b03544]
- Updated dependencies [9b03544]
- Updated dependencies [0ed747d]
- Updated dependencies [3d51f97]
- Updated dependencies [f19bc64]
- Updated dependencies [768ad8f]
- Updated dependencies [b67c599]
- Updated dependencies [a211c34]
- Updated dependencies [a432049]
- Updated dependencies [37734c5]
- Updated dependencies [3fbb4ee]
- Updated dependencies [b67c599]
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [1633db1]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [b67c599]
- Updated dependencies [d94a98c]
- Updated dependencies [768ad8f]
- Updated dependencies [fa77071]
- Updated dependencies [704dd29]
- Updated dependencies [70c5737]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [7d7d344]
- Updated dependencies [7d7d344]
- Updated dependencies [8dd0a55]
- Updated dependencies [70c5737]
- Updated dependencies [81f46aa]
- Updated dependencies [cfac0fe]
- Updated dependencies [a1f3dd1]
- Updated dependencies [d25c1b3]
- Updated dependencies [d7d5c45]
- Updated dependencies [94c999f]
- Updated dependencies [646a906]
- Updated dependencies [cbb6785]
- Updated dependencies [66bab49]
- Updated dependencies [b67c599]
- Updated dependencies [280377e]
- Updated dependencies [d7c0173]
- Updated dependencies [e88c3cc]
- Updated dependencies [423aeea]
  - @kindgi/agents@0.1.5
  - @kindgi/client@0.1.5
  - @kindgi/guardrails@0.1.5
  - @kindgi/handler-runtime@0.1.5
  - @kindgi/schema@0.1.5
  - @kindgi/tools@0.1.5
  - @kindgi/types@0.1.5
  - @kindgi/crypto@0.1.5
  - @kindgi/flow@0.1.5

## 0.1.5-rc.0

### Patch Changes

- acee59e: The agents skills (`kindgi-authoring-agents` 0.4.5, `kindgi-python-authoring-agents` 0.1.5) cover memory: `retrieval` intents over facts and earlier conversations (scopes, modes, embeddings, the `<memory>` block as data), and `memory.remember` with the built-in `kindgi_remember` tool, its review rule, and `instructionTypes`.
- ab7aee8: The guardrails authoring skill (`kindgi-authoring-guardrails` 0.3.8) gives each built-in check's config exactly, with what's required, and says a config the check doesn't take is refused (`422 guardrail-config-invalid` when registered, `deployment-validation-failed` when deployed).
- 49907f3: The guardrails authoring skills cover the built-in checks: `kindgi-authoring-guardrails` 0.3.7 shows how a pack names one (`check: 'forbidden-substring'`, no implementation), each one's `config`, and that their ids are reserved for a pack's own checks (`reserved-check-id`); `kindgi-python-authoring-guardrails` 0.1.4 says a `check_id` can't be a built-in's (`DefinitionError`), and that a Python pack writes the rule as its own check, since it can't name a built-in yet.
- a66fa27: The `kindgi-authoring-providers` skill (0.9.9) says a provider spec its adapter can't use is refused when it's registered (`422 provider-config-invalid`, one `✗ <path>: <message>` line per problem), and that `kindgi doctor` names the problems of a registration stored before 0.1.5.
- 0099fe6: The `kindgi-authoring-providers` skill (0.9.10) no longer says Anthropic retires `claude-haiku-4-5` on or after 2026-10-15: Anthropic lists it as active. The skill says to check a Claude model's status on Anthropic's model deprecations page before pinning it, and to prefer the preset's default.
- 646a906: **Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.
  
  - **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
  - **Two algorithms, chosen per key:** an Ed25519 key signs `ed25519` (the default); an EC P-256 key signs `ecdsa-p256-sha256`, for a key store without Ed25519 (a Cloud KMS `EC_SIGN_P256_SHA256` key, say). Its signature is IEEE P1363 `r‖s`. `createExportSignerFromPem` reads the algorithm from the key; `ecdsaDerToP1363` converts a KMS's DER signature. Both verifiers check either, and refuse an algorithm they don't know, naming it. Shared test vectors for both are in `@kindgi/specs` (`test-vectors/signed-export/`).
  - **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
  - **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`. **Behaviour change:** a `POST` to one of the three exports with no body, or without `signingKeyId`, used to answer `400 bad-input`; it now signs with the active key.
  - **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
  - **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
  - **Verify:** `verifySignedExport` in `@kindgi/client` and `@kindgi/sdk/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
  - **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
  - **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
  - **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
  - **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
- 9b03544: **Skills for coding agents in Java packs.** A Java pack (`kindgi init --template=java`, or `kindgi init` in a Maven app) now gets five skills of its own in `.claude/skills/`: `kindgi-java-getting-started`, `kindgi-java-authoring-tools`, `kindgi-java-authoring-guardrails`, `kindgi-java-authoring-agents` and `kindgi-java-authoring-flows`. It also gets the shared ones, `kindgi-authoring-providers`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback`, which now say how a Java or Scala pack runs the CLI (`./kindgiw`) and declares its providers (`kindgi.config.json`). Until now a Java pack got none. `./kindgiw skills sync` brings them to an existing pack.
- 9b03544: **Skills for coding agents in Scala packs.** A Scala pack (`kindgi init --template=scala`, or `kindgi init` in an sbt app) now gets five skills of its own in `.claude/skills/`: `kindgi-scala-getting-started`, `kindgi-scala-authoring-tools`, `kindgi-scala-authoring-guardrails`, `kindgi-scala-authoring-agents` and `kindgi-scala-authoring-flows`. It also gets the shared providers, MCP servers and framework-feedback skills. Until now a Scala pack got none: `kindgi skills sync` didn't take `scala`, and neither Scala init path copied skills. `./kindgiw skills sync` brings them to an existing pack.
- Updated dependencies [0919fe6]
- Updated dependencies [490d083]
- Updated dependencies [cb20b9a]
- Updated dependencies [88a2846]
- Updated dependencies [9b03544]
- Updated dependencies [9b03544]
- Updated dependencies [0ed747d]
- Updated dependencies [3d51f97]
- Updated dependencies [f19bc64]
- Updated dependencies [768ad8f]
- Updated dependencies [b67c599]
- Updated dependencies [a211c34]
- Updated dependencies [a432049]
- Updated dependencies [37734c5]
- Updated dependencies [3fbb4ee]
- Updated dependencies [b67c599]
- Updated dependencies [e27d050]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [b67c599]
- Updated dependencies [1633db1]
- Updated dependencies [b67c599]
- Updated dependencies [93ebe85]
- Updated dependencies [b67c599]
- Updated dependencies [d94a98c]
- Updated dependencies [768ad8f]
- Updated dependencies [fa77071]
- Updated dependencies [704dd29]
- Updated dependencies [70c5737]
- Updated dependencies [b67c599]
- Updated dependencies [eff6249]
- Updated dependencies [0fe157e]
- Updated dependencies [7d7d344]
- Updated dependencies [7d7d344]
- Updated dependencies [8dd0a55]
- Updated dependencies [70c5737]
- Updated dependencies [81f46aa]
- Updated dependencies [cfac0fe]
- Updated dependencies [a1f3dd1]
- Updated dependencies [d25c1b3]
- Updated dependencies [d7d5c45]
- Updated dependencies [94c999f]
- Updated dependencies [646a906]
- Updated dependencies [cbb6785]
- Updated dependencies [66bab49]
- Updated dependencies [b67c599]
- Updated dependencies [280377e]
- Updated dependencies [d7c0173]
- Updated dependencies [e88c3cc]
- Updated dependencies [423aeea]
  - @kindgi/client@0.1.5-rc.0
  - @kindgi/guardrails@0.1.5-rc.0
  - @kindgi/handler-runtime@0.1.5-rc.0
  - @kindgi/agents@0.1.5-rc.0
  - @kindgi/schema@0.1.5-rc.0
  - @kindgi/tools@0.1.5-rc.0
  - @kindgi/types@0.1.5-rc.0
  - @kindgi/crypto@0.1.5-rc.0
  - @kindgi/flow@0.1.5-rc.0

## 0.1.4

### Patch Changes

- 68da079: The providers skill and the `kindgi init` READMEs name each preset's default model and `claude-haiku-5-5`, and the skill says how ties now break (the provider's default model before its others), that the Claude 5.5 and GPT-6 models take no `temperature`, and how thinking counts. The guardrails README describes the `llm-judge` strategy, including its answer's token budget on a model that thinks.
- 6263b4b: Examples name models that aren't retiring. Anthropic retires `claude-haiku-4-5` on or after 2026-10-15 and Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20, so the `kindgi init` READMEs, the CLI README, the Gemini adapter's README and the providers and authoring-agents skills (TypeScript and Python) now use `claude-sonnet-5-5` and `gemini-3.8-flash`. The providers skill's Vertex `provider.json` registers `gemini-3.8-flash` and `gemini-3.5-flash-lite`, as the `gemini` preset does, and says not to pin the retiring models. It also says what a model's `structured-output` feature means: the model can follow a JSON schema natively, while Kindgi's typed outputs use instructions, then parse, check and repair, on every provider.
- 812aa0b: OpenRouter is described as what it is: a hosted service in front of several vendors that your prompts pass through, one option among the providers, not a way to reach every model. The `openrouter` preset's description, the `kindgi init` READMEs and the providers skill say so; the skill lists the direct vendors and self-hosted servers first.
- 6eb47c1: Agent instructions name tools by what they do, not by their dotted id. A model sees a tool's id in its provider's form (`my-pack__greet` for Anthropic and OpenAI-compatible models), so `my-pack.greet` in the instructions could make it call a name it wasn't given. The `kindgi init` echo agent (TypeScript and Python) now says "greet them with the greet tool … echo their message with the echo tool", and the authoring-agents skills say to name tools this way.
- 17f552d: The providers and Python skills describe dev-echo's "isn't a real model" first line and its `dev-echo-not-a-model` warning, and the providers skill lists the one-key presets: openai, gemini-api, groq and openrouter.
- dd9e856: The providers skill says the in-process ONNX path (Path C) runs only with the runtime from source on macOS or a glibc Linux. It doesn't load in the runtime image, so it doesn't run under `kindgi dev`; local users go to Ollama.
- f56432f: The Python skills run the CLI from PyPI, `kindgi-cli`, with no Node install: `uvx --from "kindgi-cli>=0.1,<0.2" kindgi init`, `uv add --dev "kindgi-cli>=0.1,<0.2"` in an existing app, then `uv run kindgi <command>`. The authoring skills (agents, tools, flows, guardrails) no longer say the CLI is on `PATH`.
- 53f87a6: The kindgi-getting-started skill reads a run's cost records from `.data`, as every list call answers now (`items` is deprecated).
- c744326: The Python guardrails skill's sample config gives its default as `Field(default=1, …)`, so type checkers such as pyright see the field as optional; `Field(1, …)` made `Config()` look like it needs `minLookups`.
- f90c285: A comparison's result is typed in both clients. `openapi.json` names its shape as `JudgedComparisonResult`: the `summary` (`JudgedComparisonSummary`, with `ComparisonCandidate` and each `ComparisonMetric`) and each case (`ComparisonCaseResult`). `EvalRun.result` stays an open object, since each kind of eval run has its own.
  
  The TypeScript client exports the types and `comparisonOf(run)` (also from `@kindgi/sdk/client`), which returns a `judged` eval run's result as `JudgedComparisonResult`, or `undefined` for another kind of run, a dry run, or one not finished. The Python client has `comparison_of(run)`, which returns the validated `models.JudgedComparisonResult`, or `None`.
- Updated dependencies [9564887]
- Updated dependencies [68da079]
- Updated dependencies [1c0252c]
- Updated dependencies [b9d3c01]
- Updated dependencies [82f3dec]
- Updated dependencies [366c31a]
- Updated dependencies [814af63]
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [0b1f48d]
- Updated dependencies [9a7f43b]
- Updated dependencies [6260a59]
- Updated dependencies [0359caf]
- Updated dependencies [4287798]
- Updated dependencies [fcc6a97]
- Updated dependencies [c7e27fb]
- Updated dependencies [fd011d4]
- Updated dependencies [d0ebeb6]
- Updated dependencies [e97958c]
- Updated dependencies [a311b81]
- Updated dependencies [f8deed1]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [f96bd58]
- Updated dependencies [f999acd]
- Updated dependencies [e197294]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [b8ff156]
- Updated dependencies [5608264]
- Updated dependencies [7a8e764]
- Updated dependencies [8491dd8]
- Updated dependencies [a0921a1]
- Updated dependencies [dde7fdb]
- Updated dependencies [ba55da0]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [ba2f212]
- Updated dependencies [8b28a25]
- Updated dependencies [b52d890]
- Updated dependencies [fe0ad36]
- Updated dependencies [3d23304]
- Updated dependencies [42a2e66]
- Updated dependencies [2923703]
- Updated dependencies [d69c8e9]
- Updated dependencies [bfeabfd]
- Updated dependencies [8861bf8]
- Updated dependencies [d0ebeb6]
- Updated dependencies [9801f64]
- Updated dependencies [dc5cfb1]
- Updated dependencies [a5560d7]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [62608e3]
- Updated dependencies [3e427c5]
- Updated dependencies [376d9e4]
- Updated dependencies [f90c285]
- Updated dependencies [cfba46a]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/client@0.1.4
  - @kindgi/guardrails@0.1.4
  - @kindgi/handler-runtime@0.1.4
  - @kindgi/agents@0.1.4
  - @kindgi/tools@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/flow@0.1.4
  - @kindgi/schema@0.1.4
  - @kindgi/crypto@0.1.4

## 0.1.4-rc.5

### Patch Changes

- 6eb47c1: Agent instructions name tools by what they do, not by their dotted id. A model sees a tool's id in its provider's form (`my-pack__greet` for Anthropic and OpenAI-compatible models), so `my-pack.greet` in the instructions could make it call a name it wasn't given. The `kindgi init` echo agent (TypeScript and Python) now says "greet them with the greet tool … echo their message with the echo tool", and the authoring-agents skills say to name tools this way.
- 17f552d: The providers and Python skills describe dev-echo's "isn't a real model" first line and its `dev-echo-not-a-model` warning, and the providers skill lists the one-key presets: openai, gemini-api, groq and openrouter.
- c744326: The Python guardrails skill's sample config gives its default as `Field(default=1, …)`, so type checkers such as pyright see the field as optional; `Field(1, …)` made `Config()` look like it needs `minLookups`.
- Updated dependencies [d69c8e9]
- Updated dependencies [9801f64]
  - @kindgi/client@0.1.4-rc.5
  - @kindgi/handler-runtime@0.1.4-rc.5
  - @kindgi/agents@0.1.4-rc.5
  - @kindgi/flow@0.1.4-rc.5
  - @kindgi/guardrails@0.1.4-rc.5
  - @kindgi/schema@0.1.4-rc.5
  - @kindgi/tools@0.1.4-rc.5
  - @kindgi/crypto@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- dd9e856: The providers skill says the in-process ONNX path (Path C) runs only with the runtime from source on macOS or a glibc Linux. It doesn't load in the runtime image, so it doesn't run under `kindgi dev`; local users go to Ollama.
- f56432f: The Python skills run the CLI from PyPI, `kindgi-cli`, with no Node install: `uvx --from "kindgi-cli>=0.1,<0.2" kindgi init`, `uv add --dev "kindgi-cli>=0.1,<0.2"` in an existing app, then `uv run kindgi <command>`. The authoring skills (agents, tools, flows, guardrails) no longer say the CLI is on `PATH`.
- Updated dependencies [f999acd]
- Updated dependencies [5608264]
  - @kindgi/agents@0.1.4-rc.4
  - @kindgi/client@0.1.4-rc.4
  - @kindgi/guardrails@0.1.4-rc.4
  - @kindgi/crypto@0.1.4-rc.4
  - @kindgi/flow@0.1.4-rc.4
  - @kindgi/handler-runtime@0.1.4-rc.4
  - @kindgi/schema@0.1.4-rc.4
  - @kindgi/tools@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- Updated dependencies [3e427c5]
  - @kindgi/client@0.1.4-rc.3
  - @kindgi/agents@0.1.4-rc.3
  - @kindgi/crypto@0.1.4-rc.3
  - @kindgi/flow@0.1.4-rc.3
  - @kindgi/guardrails@0.1.4-rc.3
  - @kindgi/handler-runtime@0.1.4-rc.3
  - @kindgi/schema@0.1.4-rc.3
  - @kindgi/tools@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 53f87a6: The kindgi-getting-started skill reads a run's cost records from `.data`, as every list call answers now (`items` is deprecated).
- Updated dependencies [0b1f48d]
- Updated dependencies [9a7f43b]
- Updated dependencies [4287798]
- Updated dependencies [fcc6a97]
- Updated dependencies [c7e27fb]
- Updated dependencies [fd011d4]
- Updated dependencies [e97958c]
- Updated dependencies [f8deed1]
- Updated dependencies [f96bd58]
- Updated dependencies [8491dd8]
- Updated dependencies [ba55da0]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [ba2f212]
- Updated dependencies [fe0ad36]
- Updated dependencies [42a2e66]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [376d9e4]
- Updated dependencies [cfba46a]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/client@0.1.4-rc.2
  - @kindgi/agents@0.1.4-rc.2
  - @kindgi/handler-runtime@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/guardrails@0.1.4-rc.2
  - @kindgi/crypto@0.1.4-rc.2
  - @kindgi/flow@0.1.4-rc.2
  - @kindgi/schema@0.1.4-rc.2
  - @kindgi/tools@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- f90c285: A comparison's result is typed in both clients. `openapi.json` names its shape as `JudgedComparisonResult`: the `summary` (`JudgedComparisonSummary`, with `ComparisonCandidate` and each `ComparisonMetric`) and each case (`ComparisonCaseResult`). `EvalRun.result` stays an open object, since each kind of eval run has its own.
  
  The TypeScript client exports the types and `comparisonOf(run)` (also from `@kindgi/sdk/client`), which returns a `judged` eval run's result as `JudgedComparisonResult`, or `undefined` for another kind of run, a dry run, or one not finished. The Python client has `comparison_of(run)`, which returns the validated `models.JudgedComparisonResult`, or `None`.
- Updated dependencies [0359caf]
- Updated dependencies [b8ff156]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/agents@0.1.4-rc.1
  - @kindgi/flow@0.1.4-rc.1
  - @kindgi/client@0.1.4-rc.1
  - @kindgi/handler-runtime@0.1.4-rc.1
  - @kindgi/guardrails@0.1.4-rc.1
  - @kindgi/crypto@0.1.4-rc.1
  - @kindgi/schema@0.1.4-rc.1
  - @kindgi/tools@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [e197294]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [dde7fdb]
- Updated dependencies [8b28a25]
- Updated dependencies [b52d890]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a5560d7]
- Updated dependencies [62608e3]
  - @kindgi/agents@0.1.4-rc.0
  - @kindgi/client@0.1.4-rc.0
  - @kindgi/tools@0.1.4-rc.0
  - @kindgi/handler-runtime@0.1.4-rc.0
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/flow@0.1.4-rc.0
  - @kindgi/guardrails@0.1.4-rc.0
  - @kindgi/schema@0.1.4-rc.0
  - @kindgi/crypto@0.1.4-rc.0

## 0.1.3

### Patch Changes

- d93665a: The getting-started skills (TypeScript and Python) say how an app reads what a run cost: one record per model call for the run and its agent steps (`cost.usage.query({ rootRunId })` / `cost.records.list(root_run_id=)`), one customer's month by org (`cost.usage.summary` / `cost.aggregate`), and the total in `run.finished`'s `data.run.usage`.
- 024582b: The getting-started and providers skills, and the templates' AGENTS.md, teach declaring model providers in the pack's config (`providers` in `kindgi.config.ts`, `[[tool.kindgi.providers]]` in `pyproject.toml`), which `kindgi dev` registers on every boot. The providers skill's Gemini example has the models' real output limit, 65,536 tokens.
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
