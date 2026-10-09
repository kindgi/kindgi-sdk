# Kindgi JVM SDKs

Every artifact under `sdks/java` and `sdks/scala` has one version, the same as
the npm packages' and PyPI's. Each user-visible change adds its line under
**Unreleased** in the pull request that makes it. A release turns that
heading into its version.

## Unreleased

- `kindgi-pack`: **on SIGTERM, the service stops taking calls before it writes
  `draining`.** It wrote the record first, so for a moment a supervisor that
  read it and asked `/readyz` at once could still get 200. (#PR)
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
