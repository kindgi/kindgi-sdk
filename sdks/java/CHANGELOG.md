# Kindgi JVM SDKs

Every artifact under `sdks/java` and `sdks/scala` has one version, the same as
the npm packages' and PyPI's. Each user-visible change adds its line under
**Unreleased** in the pull request that makes it. A release turns that
heading into its version.

## Unreleased

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
