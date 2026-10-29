# Kindgi JVM SDKs

Every artifact under `sdks/java` and `sdks/scala` has one version, the same as
the npm packages' and PyPI's. Each user-visible change adds its line under
**Unreleased** in the pull request that makes it. A release turns that
heading into its version. From 0.2.0 on, a release after release candidates
lists their changes too, so its section has every change since the release
before. An earlier release's section has only what came after its
candidates, and theirs are just below it.

## Unreleased

- `kindgi-client`, `kindgi-pack`, `kindgi-pack-scala`: **a `retry` guardrail sends a failed answer back to the model, for a new one**, until it has failed `maxAttempts` answers (2 when left out), and then the turn fails with `guardrail-violation`. `GuardrailViolationException.attempts()` says how many answers the turn had (`null` when a `halt` guardrail stopped it). `onViolation`'s docs say what `retry` does.
- `kindgi-client`: **a trigger's versions.** `client.schedules().listVersions(triggerId)` pages a schedule's versions, newest first (`GET /v1/schedules/{triggerId}/versions`), `listVersionsAll` streams them, and `getVersion(triggerId, version)` reads one; `webhooks()` and `mailTriggers()` have the same. Each says when it was made, by whom (`createdBy`), why (`cause`) and what the trigger was then (`definition`). A trigger's `version` names its newest, and a fire's and a run's `trigger.version` the one its run used; all three are absent from an older runtime. A version the trigger doesn't have is `404 trigger-version-not-found`.
- `kindgi-client`: **`client.agents().projects(agentId)` lists the projects an agent runs in** (`GET /v1/agents/{agentId}/projects`): the project it was first published in, then each project a deployment that isn't retired shipped a version of it into, such as the next environment `kindgi promote` carried its build to, among those the caller can read. A retired agent still answers.
- `kindgi-models`, `kindgi-client`: **a value read from a newer runtime isn't sent back.** A request body is checked against the values this client knows before it's sent (a `ValidationException` if not), so an enum value, a union variant, or text in a union of known text and objects that a newer runtime sent can't be sent back. Before, the client sent it, and the server decided. Reading one keeps it, as before, and so does `build()`, so an answer that carries one can still be copied and changed: `EvalBaseline`'s text is no longer refused by `build()`. Every enum class implements the new `OpenEnum` (`asString()`, `isKnown()`, `knownValues()`). The Python client refuses the same values. A `ValidationException` now names a nested model after the classes it's in, as the field names in its other checks are: `StartRunBody.WithAgent is invalid: …` for a union's variant, where it read `WithAgent is invalid: …`, and `CreateSystemTenantBody.FirstAdmin is invalid: …` for an inline object, where it read `FirstAdmin is invalid: …` (`Checks.throwIfAny(Class)`).

## 0.2.0

- `kindgi-pack`, `kindgi-pack-scala`: **a tool can say `resultIsOutsideData`.** `Tool.define(...).resultIsOutsideData(true)` (Scala: `.resultIsOutsideData(true)`) says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. The pack's index carries it; left out, nothing changes.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool can be an HTTP request, declared as data.** `Tool.define(...).http(spec)` (Scala: `.http(spec)`) finishes a tool with an `HttpToolSpec` — method, URL template, headers, authorization by secret reference, request body and success-status range — in place of a handler. The Kindgi runtime makes the request; calling the tool in the JVM throws. `{placeholders}` in the URL's path and query, and in a text body, are filled from the input's fields, never from the host. The same declarative form as the TypeScript `kind: 'http'` tool spec and Python's `http_tool`.
- `kindgi-client`: **the SSO handoff message, for a JVM app that sets up sign-in.** `SsoHandoff.forProvider(urls, preset, version)` builds what an admin sends whoever runs their identity provider — the OIDC or SAML URLs and what to send back, a preset's console steps (`IdentityProviderPreset`: Google, Entra, Okta, Keycloak) and the guide's link (`DocsLinks.docsUrl`). The same text the CLI's `kindgi sso providers start` and the console show. No network and no dependencies, so an app that shows its own setup screen can use it on its own.
- `kindgi-client`: **`SignedExports.verify` checks a signed export** (an approval's audit bundle, a run's provenance, compliance evidence) — its `ed25519` or `ecdsa-p256-sha256` signature over the exact bytes shipped, and, when you pass the keys you trust, that the signing key is one of them. It returns a `SignedExportVerification`, with the signed body when it checks out, and never throws for an export that doesn't verify. The Java counterpart of `verifySignedExport` in the TypeScript client and `verify_signed_export` in Python; it checks with the JDK's own crypto, so there's nothing extra to install.
- `kindgi-client`: **a comparison eval run's result, typed.** `Comparisons.comparisonOf(run)` reads a `judged` `EvalRun`'s open `result` as the OpenAPI `JudgedComparisonResult` — its summary and each case — and is empty for another kind of run, a dry run, or one that hasn't finished. The same reading as the TypeScript `comparisonOf` and Python `comparison_of`.
- `kindgi-client`: **verify the webhooks Kindgi sends, or sign them.** `Webhooks.verify(secret, headers, body)` checks a Standard Webhooks `v1` signature — HMAC-SHA256, a constant-time compare, a 300-second timestamp tolerance, and a message signed by several secrets during a rotation (any signature that matches yours passes) — and returns the `VerifiedWebhook`, or throws `WebhookVerificationException` naming which check failed. `Webhooks.parseEvent(body)` reads the typed `WebhookEvent`, keeping a type the client doesn't know yet as `WebhookEvent.Unrecognized`. `sign`, `signedHeaders`, `generateSecret` and `isStrongSecret` round out the helper, matching the TypeScript `@kindgi/crypto` and Python `kindgi.webhooks`.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's `needsSpec` is checked, and a test can fill its `env`.** The indexer refuses a tool whose `needsSpec.env` or `needsSpec.secrets` names a schema that doesn't compile, or whose `needsSpec.env` default isn't a string, as a file error at `/needsSpec/<slot>/<name>`; `kindgi build` stops on it. `ToolContext.forTest(tool, env, secrets)` builds a context whose `env` is what the tool declares under `needsSpec.env` — each name from the `env` you pass or its schema's string default, checked against its schema, with an `IllegalArgumentException` when one is missing or doesn't match — so a handler test resolves env the way the runtime does. A `ToolContext.Builder` sets a test context's fields one by one; with `withTool(tool)` it decides `env` the same way, so a test can set the project, config or logger too. Scala reaches both through the same Java `ToolContext`. Matches the TypeScript `@kindgi/tools` definition check and test context.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's connections to other apps (pack protocol 2.9.0).** `ToolContext.connections()` maps each connection the tool declares (`needsSpec.connections`) to a `ToolConnection`: its id, the app, the account (`ConnectionAccount`: `id`, `label`) and a short-lived `accessToken` for this call, empty when the tool declares none. Printing a connection or the context never shows a token, and their JSON leaves it out. When the app answers 401, throw `ConnectionRejectedException(name)`, or your own exception with it as the cause: the call answers `connection-rejected` naming the connection, and the runtime renews the token once and runs the call again. An HTTP tool sends a connection's token with `new HttpAuthSpec.Connection(name)`. `ToolContext.forTest(connections)` builds one for a unit test, as does `ToolContext.Builder.withConnections`, and the constructors without `connections` still compile. Scala names them `ToolConnection`, `ConnectionAccount` and `ConnectionRejectedException` in `scaladsl`.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's schemas are refused where the runtime's strict compile refuses them, beyond unknown names.** This covers a keyword with no `type` it applies to (`minLength` with no `"type": "string"`, say), a `type` its context can't be (`number` under `integer`), a `required` property nothing defines, an empty `enum`, and references that only lead back to themselves. The indexer refuses such a tool, and so does `needsSpec`'s check, naming where the schema goes wrong; before, such a schema reached the runtime, which refused it. A schema derived from a type is unchanged. The SDKs replay the runtime's answers to a shared set of schemas (`@kindgi/specs`' `test-vectors/strict-schemas`).
- `kindgi-pack`, `kindgi-pack-scala`: **a `pattern` is checked as the runtime's JavaScript reads it.** The indexer refuses a `pattern` the runtime's `RegExp` refuses, and so does `needsSpec`'s check, in the runtime's words (`Invalid regular expression: /(/u: Unterminated group`). Before, it went by Java's `Pattern`: a pattern only Java reads, such as `(?i)abc` or `a\Z`, reached the runtime, which refused it. A pattern only JavaScript reads, such as `[^]`, is still refused, since the service checks data against it with Java's `Pattern`. A `"format": "regex"` value is checked as the runtime checks it, too.

## 0.2.0-rc.1

- `kindgi-pack`, `kindgi-pack-scala`: **a tool can say `resultIsOutsideData`.** `Tool.define(...).resultIsOutsideData(true)` (Scala: `.resultIsOutsideData(true)`) says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. The pack's index carries it; left out, nothing changes.

## 0.2.0-rc.0

- `kindgi-pack`, `kindgi-pack-scala`: **a tool can be an HTTP request, declared as data.** `Tool.define(...).http(spec)` (Scala: `.http(spec)`) finishes a tool with an `HttpToolSpec` — method, URL template, headers, authorization by secret reference, request body and success-status range — in place of a handler. The Kindgi runtime makes the request; calling the tool in the JVM throws. `{placeholders}` in the URL's path and query, and in a text body, are filled from the input's fields, never from the host. The same declarative form as the TypeScript `kind: 'http'` tool spec and Python's `http_tool`.
- `kindgi-client`: **the SSO handoff message, for a JVM app that sets up sign-in.** `SsoHandoff.forProvider(urls, preset, version)` builds what an admin sends whoever runs their identity provider — the OIDC or SAML URLs and what to send back, a preset's console steps (`IdentityProviderPreset`: Google, Entra, Okta, Keycloak) and the guide's link (`DocsLinks.docsUrl`). The same text the CLI's `kindgi sso providers start` and the console show. No network and no dependencies, so an app that shows its own setup screen can use it on its own.
- `kindgi-client`: **`SignedExports.verify` checks a signed export** (an approval's audit bundle, a run's provenance, compliance evidence) — its `ed25519` or `ecdsa-p256-sha256` signature over the exact bytes shipped, and, when you pass the keys you trust, that the signing key is one of them. It returns a `SignedExportVerification`, with the signed body when it checks out, and never throws for an export that doesn't verify. The Java counterpart of `verifySignedExport` in the TypeScript client and `verify_signed_export` in Python; it checks with the JDK's own crypto, so there's nothing extra to install.
- `kindgi-client`: **a comparison eval run's result, typed.** `Comparisons.comparisonOf(run)` reads a `judged` `EvalRun`'s open `result` as the OpenAPI `JudgedComparisonResult` — its summary and each case — and is empty for another kind of run, a dry run, or one that hasn't finished. The same reading as the TypeScript `comparisonOf` and Python `comparison_of`.
- `kindgi-client`: **verify the webhooks Kindgi sends, or sign them.** `Webhooks.verify(secret, headers, body)` checks a Standard Webhooks `v1` signature — HMAC-SHA256, a constant-time compare, a 300-second timestamp tolerance, and a message signed by several secrets during a rotation (any signature that matches yours passes) — and returns the `VerifiedWebhook`, or throws `WebhookVerificationException` naming which check failed. `Webhooks.parseEvent(body)` reads the typed `WebhookEvent`, keeping a type the client doesn't know yet as `WebhookEvent.Unrecognized`. `sign`, `signedHeaders`, `generateSecret` and `isStrongSecret` round out the helper, matching the TypeScript `@kindgi/crypto` and Python `kindgi.webhooks`.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's `needsSpec` is checked, and a test can fill its `env`.** The indexer refuses a tool whose `needsSpec.env` or `needsSpec.secrets` names a schema that doesn't compile, or whose `needsSpec.env` default isn't a string, as a file error at `/needsSpec/<slot>/<name>`; `kindgi build` stops on it. `ToolContext.forTest(tool, env, secrets)` builds a context whose `env` is what the tool declares under `needsSpec.env` — each name from the `env` you pass or its schema's string default, checked against its schema, with an `IllegalArgumentException` when one is missing or doesn't match — so a handler test resolves env the way the runtime does. A `ToolContext.Builder` sets a test context's fields one by one; with `withTool(tool)` it decides `env` the same way, so a test can set the project, config or logger too. Scala reaches both through the same Java `ToolContext`. Matches the TypeScript `@kindgi/tools` definition check and test context.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's connections to other apps (pack protocol 2.9.0).** `ToolContext.connections()` maps each connection the tool declares (`needsSpec.connections`) to a `ToolConnection`: its id, the app, the account (`ConnectionAccount`: `id`, `label`) and a short-lived `accessToken` for this call, empty when the tool declares none. Printing a connection or the context never shows a token, and their JSON leaves it out. When the app answers 401, throw `ConnectionRejectedException(name)`, or your own exception with it as the cause: the call answers `connection-rejected` naming the connection, and the runtime renews the token once and runs the call again. An HTTP tool sends a connection's token with `new HttpAuthSpec.Connection(name)`. `ToolContext.forTest(connections)` builds one for a unit test, as does `ToolContext.Builder.withConnections`, and the constructors without `connections` still compile. Scala names them `ToolConnection`, `ConnectionAccount` and `ConnectionRejectedException` in `scaladsl`.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool's schemas are refused where the runtime's strict compile refuses them, beyond unknown names.** This covers a keyword with no `type` it applies to (`minLength` with no `"type": "string"`, say), a `type` its context can't be (`number` under `integer`), a `required` property nothing defines, an empty `enum`, and references that only lead back to themselves. The indexer refuses such a tool, and so does `needsSpec`'s check, naming where the schema goes wrong; before, such a schema reached the runtime, which refused it. A schema derived from a type is unchanged. The SDKs replay the runtime's answers to a shared set of schemas (`@kindgi/specs`' `test-vectors/strict-schemas`).
- `kindgi-pack`, `kindgi-pack-scala`: **a `pattern` is checked as the runtime's JavaScript reads it.** The indexer refuses a `pattern` the runtime's `RegExp` refuses, and so does `needsSpec`'s check, in the runtime's words (`Invalid regular expression: /(/u: Unterminated group`). Before, it went by Java's `Pattern`: a pattern only Java reads, such as `(?i)abc` or `a\Z`, reached the runtime, which refused it. A pattern only JavaScript reads, such as `[^]`, is still refused, since the service checks data against it with Java's `Pattern`. A `"format": "regex"` value is checked as the runtime checks it, too.

## 0.1.10

No JVM changes; the version moves with the npm packages.

## 0.1.10-rc.1

No JVM changes; the version moves with the npm packages.

## 0.1.10-rc.0

- `kindgi-pack`, `kindgi-pack-scala`: **an agent's `conversationPolicy` can't set `autoCloseAfterInactiveSeconds`.** It was accepted and never acted on: a conversation never closes by itself, only when someone closes it. The indexer refuses an agent that sets it, as a file error at `/conversationPolicy/autoCloseAfterInactiveSeconds`; the rest of the pack still indexes, and `kindgi build` stops on it.

## 0.1.9

No JVM changes; the version moves with the npm packages.

## 0.1.9-rc.1

No JVM changes; the version moves with the npm packages.

## 0.1.9-rc.0

- `kindgi-models`: **a server's retention limit.** `RetentionScheduledItem`'s `policyId` and `policyVersion` can be `null`: a record that a server's limit decides, in a domain no policy covers, has neither. `limitApplied`, on `RetentionScheduledItem` and `RetentionSweepResult.PerDomainItem`, is `true` when the limit decides; `null` otherwise.
- `kindgi-pack`, `kindgi-pack-scala`: **a tool can say `needsApprovalWhenUnattended`.** `Tool.define(...).needsApprovalWhenUnattended(true)` (Scala: `.needsApprovalWhenUnattended(true)`) makes each call wait for a person's approval in a run no person started (a webhook, a schedule, an event, or a service account's key). A flow's tool step that calls it is refused there. A run a person starts is unaffected. The pack's index carries it; left out, nothing changes.

## 0.1.8

No JVM changes; the version moves with the npm packages.

## 0.1.8-rc.0

- `kindgi-client`: **`runs().journal` pages when asked.** `RunsJournalParams` gains `limit` (1 to 100) and `cursor`, `RunJournalPage` gains `nextCursor`, and `journalAll` streams every entry, page after page. Without `limit`, the whole journal is one page, as before; a runtime before 0.1.8 answers it whole either way.
- `kindgi-client`: **`secrets().list` takes `includeRevoked`.** `SecretsListParams.includeRevoked("true")` lists revoked secrets too, with `revokedAt` and `revokeReason` (metadata only, never a value). A runtime before 0.1.8 ignores it.
- `kindgi-models`: **where a secret an item names is read**, as the server recorded it when the item was registered: `secretScopes` on a `Tool` and an `MCPEndpoint` (by secret name) and `hmacSecretScope` on a webhook trigger, each a `RecordedSecretScope` (`Tenant`, `Org` or `Project`), `null` when none is usable. `SecretResolveOutcome` gains `scope`. The generator now takes a nullable reference to a tagged union, alone or as a map's values.

## 0.1.7

No JVM changes; the version moves with the npm packages.

## 0.1.7-rc.0

- `kindgi-client`: **`webhooks()`**, webhook triggers: a signed request from WooCommerce, Drupal's Webhooks module, GitHub, Shopify or a Standard Webhooks sender starts a flow run. `register`, `list`, `get`, `update`, `pause`, `resume`, `unregister`, `fires` and `takeOwnership`. The receive URL itself is the sender's (marked `x-kindgi-sender-only`), so the client has no method for it.

## 0.1.6

No JVM changes; the version moves with the npm packages.

## 0.1.6-rc.0

- `kindgi-pack`, `kindgi-pack-scala`: **`ToolContext.idempotencyKey()`**, the same every time a
  tool call runs (resumed, retried, or run again after a crash) and different for every other
  call, so a tool that writes can dedupe on it. `null` from a runtime before 0.1.6. The
  constructor without it stays. It's the record's last component, so a Java 21 record pattern
  over `ToolContext` names one more.
- `kindgi-pack`, `kindgi-pack-scala`: **only the names a pack declares reach
  its code.** The launcher (`kindgi-pack-java`) drops every variable the pack
  doesn't declare before the JVM starts, keeping `KINDGI_*`, the platform's,
  and the names in `KINDGI_PACK_ENV_DECLARED`, which `kindgi build` sets in
  the image. The service logs the dropped names (`env-dropped`), never their
  values, and won't start while an undeclared variable still reaches it.
  `KINDGI_PACK_ENV_FILTER=off` keeps every variable.
- `kindgi-pack`, `kindgi-pack-scala`: **the indexer warns when a guardrail's
  check id doesn't start with the pack's id** (`<pack id>.`; the check id is
  `checkId`, or the guardrail's own id). Packs in one tenant share one space
  of check names, so the warning says to name it `<pack id>.checks.<name>`.
  It's a warning only: the pack builds and indexes as before, and
  `kindgi build` and `kindgi dev` print it.
- `kindgi-pack`, `kindgi-pack-scala`: **a union of types validates**
  (`"type": ["string", "number"]`, what Zod writes for a union of scalars in a
  TypeScript tool's schema). It used to be refused as unsupported, matching the
  TypeScript pack service's old strict mode; both take it now. (#477)
- `kindgi-pack`, `kindgi-pack-scala`: **a secret whose schema names null is
  optional** (`.set("needsSpec", …)` with `"type": ["string", "null"]`): with
  runtime 0.1.6 or later, one the env doesn't have, or has empty, is absent
  from `ctx.secrets()`, and the call goes on. The index keeps the schema as
  written. (#478)

## 0.1.5

No JVM changes; the version moves with the npm packages.

## 0.1.5-rc.0

- `kindgi-pack`: **on SIGTERM, the service stops taking calls before it writes
  `draining`.** It wrote the record first, so for a moment a supervisor that
  read it and asked `/readyz` at once could still get 200. (#471)
- `kindgi-pack`, `kindgi-pack-scala`: **a guardrail can't ship its check under
  a built-in check's id** (`must-cite`, `never-call-tool`, `max-tool-calls`,
  `output-matches`, `tool-order`, `required-substring`,
  `forbidden-substring`). The runtime runs the built-in for a guardrail naming
  one, so the pack's check would be silently replaced. `Guardrail.Builder.check`
  (Scala: `check`) refuses it, saying to rename the check; the indexer reports
  the file. `Guardrail.RESERVED_CHECK_IDS` lists them, and a test holds it
  equal to `@kindgi/guardrails`' built-in checks, as the TypeScript and Python
  pack SDKs do. (#461)
- `kindgi-pack`, `kindgi-pack-scala`: **Jackson 2.18.11 or later.** kindgi-pack's
  Jackson (core, databind, annotations, jdk8, jsr310) and the Scala layer's
  jackson-module-scala move from 2.15.4 to 2.18.11, which fixes advisories that
  reach the pack service through an app's own input types: a `Path` resolved
  through any file system provider, eager DNS for `InetAddress` (SSRF), unknown
  type ids kept without bound, `@JsonIgnore` on a record component bypassed
  under a naming strategy, and `@JsonIgnoreProperties` bypassed by
  case-insensitive binding. An app's newer Jackson still wins; Spring Boot
  3.4 and later manage 2.18 or newer. kindgi-models keeps its optional
  jackson-annotations at 2.15, and kindgi-client's Jackson stays shaded. (#446)
- `kindgi-pack`, `kindgi-pack-scala`: **the Java pack service writes log
  records**, the same as the TypeScript and Python services' and the
  runtime's: one per call (`tool acme.lookup ok 12ms`) with the call's ids and
  the caller's trace, and the lifecycle (`listening`, `boot-failed`, …)
  whatever the levels. `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and
  `KINDGI_LOG_FORMAT` set them. A handler logs beneath its call with
  `ctx.log()` (Scala: `ctx.log.info("looked up order", "orderId" -> id)`), and
  `ToolContext.forTest(log)` takes a logger for a unit test. `ToolContext`
  gains the `log` component. The logger, `com.kindgi.log`, redacts
  secret-looking keys and known secret shapes, and writes exactly the records
  of `@kindgi/log`'s shared vectors. (#393)
- `kindgi-client`: **every 409 is a `ConflictException`.** A 409 whose code the
  client didn't list was a `ServerException`; now it's a conflict, as a 404 is
  a `NotFoundException`. Twenty codes the API documents move, such as
  `run-lease-lost`, `agent-version-mismatch` and `secret-write-conflict`. Match
  on `serverCode()`, which every exception carries. An unlisted 413 is an
  `InvalidRequestException`, and `provider-config-invalid` is one too, as in
  the TypeScript and Python clients. A test holds every code the API documents
  (`x-error-codes` in openapi.json) to its status's family. (#372)
- Skills for coding agents in Scala packs: `kindgi-scala-getting-started` and
  the Scala authoring skills for tools, guardrails, agents and flows in
  `.claude/skills/`, with the shared skills for providers, MCP servers and
  framework feedback. (#370)
- Skills for coding agents: a Java pack gets `kindgi-java-getting-started` and
  the Java authoring skills for tools, guardrails, agents and flows in
  `.claude/skills/`, with the shared skills for providers, MCP servers and
  framework feedback. (#367)
- `kindgi-pack`, `kindgi-pack-scala`: **a flow's edges can branch.**
  `Flow.Builder.edge(Map)` (Scala: `edge(Map(…))`) takes an edge as the flow
  schema describes it, with a condition (`when`) or a `policy`; until now an
  edge could only join two nodes. `Guardrail.evaluate(config, trace)` runs a
  check in a unit test, as `Tool.call` runs a handler. (#364)
- The CLI: `kindgi init` says a Java or Scala pack is a preview, and its
  kindgi-pack and kindgi-pack-scala come from Maven Central at the CLI's
  version (no more building them from this repository). The READMEs and the
  docs' Java and Scala pages say what preview means. (#363)
- All artifacts: **on Maven Central** (`com.kindgi`), each jar with its sources
  and javadoc jars and every file signed. A version's Java and Scala artifacts
  are published together, release candidates too. They're in preview: tested
  and supported, but the API may still change in 0.1.6 without the usual
  deprecation period. `kindgi-pack-scala`'s jars now carry the LICENSE and
  NOTICE. (#361)
- `kindgi-pack`: **your app's Jackson modules apply to tool inputs, tool
  outputs, a check's attributes and the schemas derived from your types.**
  They're found the way `ObjectMapper.findAndRegisterModules()` finds them,
  through `META-INF/services`. A module that renames properties renames them
  in the tool's schema too. A module your app registers only in code, on its
  own `ObjectMapper`, isn't seen. The pack protocol and the pack index use a
  separate mapper that your modules never change. (#329)
- `kindgi-pack`: `Tool.Builder.asyncHandler` and `Guardrail.Builder.asyncCheck`
  take a `CompletionStage`. `ctx.cancellation().onCancel(…)` stops work a
  handler started elsewhere. (#329)
- `kindgi-pack`: `com.kindgi.pack.spi.SchemaTypeAdapter` lets a JVM language
  layer teach the schema deriver its own types. (#329)
- `kindgi-pack-scala`: first release. Tools, guardrail checks, agents and flows
  in Scala 2.13 and 3, with case classes for schemas (`Option`, collections,
  defaults, Scala 3 simple enums) and `Future`s for async work, on
  kindgi-pack's indexer and service (preview).
- `kindgi-pack`: reads Scala packs (`"language": "scala"`). A `.scala` file's
  primitives are the vals of its object. A tool defined as a `def` or a
  `lazy val` is a file error that says to make it a `val`.
- `kindgi-pack`: first release. Tools, guardrail checks, agents and flows in
  Java, plus the indexer and the pack service that runs them (preview). (#313)
- `kindgi-client` and `kindgi-models`: first release. The Kindgi API client
  for Java 17 or later, generated from the API's OpenAPI description, with
  `runs().follow(runId)` for a run's events through to its end (preview). (#297)
