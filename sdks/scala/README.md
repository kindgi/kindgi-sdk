# Kindgi Scala packs (`kindgi-pack-scala`)

Write a Kindgi™ pack's tools, guardrail checks, agents and flows in Scala: case
classes for schemas, `Future`s for async work. It's a thin layer over
[`kindgi-pack`](../java/kindgi-pack) (Java), so a Scala pack is indexed and
served by kindgi-pack's own indexer and pack service. That service passes the
same conformance suite as the TypeScript, Python and Java ones, with this
layer's fixture pack on Scala 2.13 and 3.

**Status:** preview. Java and Scala support is tested and supported, but its
API may still change in 0.1.6 without the usual deprecation period. On Maven Central,
built for Scala 2.13 and the 3.3 LTS line, on Java 17 or later. Its version is
the Kindgi release's (the CLI's).

```scala
// build.sbt
libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "<version>"
```

## A tool

```scala
// src/main/scala/com/acme/tools/Greet.scala
package com.acme.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.Size

object Greet {
  final case class Input(@Size(min = 1, max = 100) name: String, greeting: String = "Hello")
  final case class Output(message: String)

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.greet")
    .description("Formats a greeting for the named recipient.")
    .readOnly
    .handler((in, ctx) => Output(s"${in.greeting}, ${in.name}!"))
}
```

A file's primitives are **vals of an object named like the file**: `Greet.scala`
holds `object Greet`. The input and output schemas come from the case
classes. The service checks both on every call: an input that breaks the
schema never reaches the handler, and an output that breaks it never reaches
the runtime.

`readOnly` says the tool only reads: a dry run may call it, and approval gates
skip it. Left out, a tool counts as one that writes. `mutating`, `version`,
`effect` and `set` say the rest.

Unit-test a handler directly:

```scala
assertEquals(Greet.tool.call(Greet.Input("Ada"), ToolContext.forTest()), Greet.Output("Hello, Ada!"))
```

### Answering later

```scala
val tool: Tool[Input, Output] = Tool[Input, Output]("acme.quote")
  .readOnly
  .handlerAsync((in, ctx) => rates.fetch(in.currency).map(Output(_)))
```

The service awaits the `Future`. A failed future fails the call with its own
exception. At the deadline, or when the caller goes away, the call is
answered `deadline-exceeded` or `cancelled`, but a Scala `Future` has no way
to stop. Stop the work behind it with `ctx.cancellation.onCancel(() => …)`.

### Logging

A handler logs beneath its call with `ctx.log`, whose records carry the
call's ids and trace. Fields go as pairs or a Scala map:

```scala
ctx.log.info("looked up order", "orderId" -> order.id)
ctx.log.warn("retrying the lookup", e)
```

A case class is written as an object of its fields, so a field that looks
secret (`apiKey`, `password`, …) is redacted by its name. The records, their
settings (`KINDGI_LOG_*`) and the redaction are kindgi-pack's: see
[its README](../java/kindgi-pack/README.md#index-and-serve).

### Schemas you give

When a type can't say it, `Tool.json` takes the schemas as Scala maps. Its
handler gets the input as a `Map[String, Any]`, and may return any JSON value:

```scala
val tool: Tool[Map[String, Any], Any] = Tool.json("acme.search")
  .inputSchema(Map(
    "type" -> "object",
    "properties" -> Map("query" -> Map("type" -> "string", "minLength" -> 1)),
    "required" -> List("query")))
  .handler((in, ctx) => Map("hits" -> search(in("query").asInstanceOf[String])))
```

## Schemas from Scala's types

kindgi-pack derives the schema (see [its table](../java/kindgi-pack/README.md#schemas));
this layer adds Scala's types:

| In Scala | In the schema |
|---|---|
| `Option[T]` | not required; `null` allowed |
| a parameter's default (`greeting: String = "Hello"`) | `default`, not required; the service fills it in |
| `Seq[T]`, `List[T]`, `Vector[T]` | `array` |
| `Set[T]` | `array` with `uniqueItems` |
| `Map[String, T]` | `object` with `additionalProperties` |
| `BigDecimal`, `BigInt` | `number`, `integer` |
| a Scala 3 simple enum (`enum Color { case Red, Green }`) | `string`, `enum` of its case names |

Jakarta Validation annotations on a case class's parameters apply (`@Size`,
`@Min`, `@Pattern`, …). In Scala 3, name a Java annotation's arguments:
`@Min(value = 0)`, not `@Min(0)`. Scala 3 passes a positional argument to the
wrong element.

Two limits of the JVM:
- **Scala's primitives inside a type parameter** (`Seq[Int]`, `Option[Long]`)
  are `Object` on the JVM, so the schema allows any JSON value there. Use a
  case class (`Seq[Item]`), or say the schema with `Tool.json`.
- **A Scala 3 enum whose cases take parameters** is a sealed hierarchy, not a
  string. Describe it with `@JsonTypeInfo` and `@JsonSubTypes`, as for a
  sealed trait.

## Guardrails, agents and flows

```scala
// src/main/scala/com/acme/guardrails/Checks.scala
object Checks {
  final case class MinLength(@Min(value = 0) minLength: Int = 1)

  val minLength: Guardrail[MinLength] = Guardrail[MinLength]("acme.min-length")
    .checkId("acme.checks.min-length")
    .onViolation("halt")
    .check((config, trace) =>
      if (Option(trace.output).getOrElse("").length >= config.minLength) CheckResult.pass
      else CheckResult.fail("too short"))
}

// src/main/scala/com/acme/agents/Bot.scala
object Bot {
  val agent: Agent = Agent("acme.bot")
    .name("Greeter")
    .instructions("Greet whoever asks.")
    .tool(Greet.tool)
    .guardrail(Checks.minLength)
    .build()
}
```

`checkAsync` takes a `Future[CheckResult]`, and `Guardrail.json` takes a
config schema you give. `Flow("acme.pipeline")` builds a flow
(`toolNode`, `agentNode`, `edge`); a node or an edge with more than those say
(an `inputMapping`, a condition `when`, a `policy`) is a map: `node(Map(…))`,
`edge(Map("id" -> "e2", "from" -> "classify", "to" -> "billing", "when" -> Map(…)))`.
Maps and lists anywhere in these builders are Scala's. A check id
(`checkId`, else the guardrail's id) can't be a built-in check's
(`com.kindgi.pack.Guardrail.RESERVED_CHECK_IDS`): `check` refuses it. A unit
test runs a check with `evaluate`:
`Checks.minLength.evaluate(MinLength(3), new RunTrace(java.util.Map.of("output", "abc")))`.

## The pack

A pack is a directory with a `kindgi.config.json`, usually your sbt project's
root:

```json
{
  "language": "scala",
  "pack": { "id": "acme", "version": "1.0.0" }
}
```

Its discovery defaults are `src/main/scala/**/tools/**/*.scala`,
`…/guardrails/…`, `…/agents/…` and `…/flows/…`. The rest of the file, and the
indexer and pack service, are kindgi-pack's: see
[The pack](../java/kindgi-pack/README.md#the-pack) and
[Index and serve](../java/kindgi-pack/README.md#index-and-serve).

The indexer reads each discovered file's object (the class `Greet$`). What it
indexes:
- **The object's vals.** It takes only the primitives the object defined, so a
  val that refers to another object's tool isn't indexed twice.
- **Models are skipped.** A file with no object, such as a case class or a
  trait, is a model. So is a case class's companion that holds no primitives.
- **A tool defined as a `def` or a `lazy val` is an error that says so.** The
  indexer can't read it without running it, so make it a `val`.
- **A file with no object named like it is an error too.**

## Jackson

Tool inputs and outputs bind through your app's Jackson 2. This layer brings
`jackson-module-scala` (2.18, the oldest Jackson kindgi-pack supports), and
Jackson finds it, with your app's own modules. jackson-module-scala must match
your `jackson-databind` minor version; it refuses another. If your app uses a
newer Jackson, depend on the matching `jackson-module-scala` yourself:

```scala
libraryDependencies += "com.fasterxml.jackson.module" %% "jackson-module-scala" % "<your Jackson version>"
```

## The package name

The layer is `com.kindgi.pack.scaladsl`, as Pekko's Scala API is `…scaladsl`.
A package named `scala` would shadow Scala's own `scala` package wherever
`com.kindgi.pack._` is imported.

## Build from source

kindgi-pack first (into the local Maven repository), then this layer, on both
Scala versions:

```sh
cd sdks/java && ./mvnw -pl kindgi-pack -am install -DskipTests
cd ../scala && sbt +test
```

The conformance fixture pack in Scala is
[`packages/pack-conformance/fixtures/scala-pack`](../../packages/pack-conformance/fixtures/scala-pack).
It builds against this layer from source:

```sh
cd packages/pack-conformance/fixtures/scala-pack
sbt writeClasspath                 # Scala 3; sbt "++2.13.18!" writeClasspath for 2.13
cd ../.. && pnpm exec vitest run tests/scala.test.ts
```

The version is the npm packages' (`version.sbt`, which
`scripts/sync-jvm-version.mjs` moves); changes go in
[`sdks/java/CHANGELOG.md`](../java/CHANGELOG.md).
