---
name: kindgi-scala-authoring-tools
description: >
  Covers writing tools for a Kindgi pack in Scala (`kindgi-pack-scala`,
  `com.kindgi.pack.scaladsl`): `Tool[Input, Output](id)` as a `val` of an
  object named like its file, schemas from case classes (Option, defaults,
  collections, Jakarta constraints) or `Tool.json` with maps, `handler` and
  `handlerAsync` (a Future), `ToolContext` and cancellation, secrets
  (`needsSpec`) and configuration, errors, `readOnly` and effects, munit
  tests with `tool.call`, and wiring a tool onto an agent. Load this
  whenever you are authoring or editing code in a Scala pack's tools
  packages (a pack whose `kindgi.config.json` says `"language": "scala"`),
  defining a tool, or wiring one onto an agent. Scala agents are covered by
  kindgi-scala-authoring-agents, getting started by
  kindgi-scala-getting-started.
type: core
library: "kindgi-pack-scala"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [scala]
sources:
  - sdks/scala/README.md
  - sdks/scala/kindgi-pack-scala/src/main/scala/com/kindgi/pack/scaladsl/Tool.scala
  - sdks/java/kindgi-pack/README.md
---

# Authoring Kindgi tools in Scala

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>`. sbt is the one on
> your `PATH`.
>
> Scala support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

A **tool** is a unit of work an agent (or a flow step) calls: typed input,
typed output, your code in between. In a Scala pack it is a `val` of type
`Tool[I, O]` in an object named like its file (`VerifyCitation.scala` holds
`object VerifyCitation`), in a `tools` package
(`src/main/scala/**/tools/**/*.scala`; in an app, `**/kindgi/tools/**`).
Kindgi runs it in the pack's own JVM (the pack service) and calls it over
HTTP. The model sees its id, description and input schema.

Before writing one, establish what it should **do**: what it computes or
fetches, what the caller provides, what it returns. "Add a tool" is a
conversation opener. The pack's sample tools prove the runtime works; they
are not the shape to copy unless the user asks.

## A tool

```scala
// src/main/scala/acme/tools/VerifyCitation.scala
package acme.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.{Pattern, Size}

/** acme.verify-citation: checks a legal citation against the citator. */
object VerifyCitation {
  final case class Input(
      @Size(min = 1) citation: String,
      @Pattern(regexp = "^(US|UK|EU)$") jurisdiction: String)

  final case class Output(found: Boolean, canonicalCite: Option[String])

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.verify-citation")
    .description("Verifies a legal citation against the citator; returns whether it resolves and its canonical form.")
    .readOnly
    .set("needsSpec", Map("secrets" -> Map("CITATOR_KEY" -> Map("type" -> "string", "minLength" -> 20))))
    .handler((in, ctx) =>
      verify(in, String.valueOf(ctx.secrets.get("CITATOR_KEY")), sys.env.getOrElse("CITATOR_URL", "")))

  /** The tool's work, with what it reads from its context and the environment passed in: a test calls it. */
  def verify(in: Input, key: String, citatorUrl: String): Output = {
    val hit = Citator.lookup(citatorUrl, key, in.citation, in.jurisdiction)
    Output(hit.isDefined, hit)
  }
}
```

```scala
// src/main/scala/acme/tools/Citator.scala
package acme.tools

import java.net.URI
import java.net.URLEncoder
import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.nio.charset.StandardCharsets

/** The citator's API: an object with no tools in it is a helper, not a primitive. */
object Citator {
  private val http = HttpClient.newHttpClient()

  def lookup(baseUrl: String, key: String, citation: String, jurisdiction: String): Option[String] = {
    val query = s"q=${URLEncoder.encode(citation, StandardCharsets.UTF_8)}&j=$jurisdiction"
    val request = HttpRequest.newBuilder(URI.create(s"$baseUrl/lookup?$query"))
      .header("Authorization", s"Bearer $key")
      .build()
    val response = http.send(request, HttpResponse.BodyHandlers.ofString())
    if (response.statusCode() == 200) Some(response.body()) else None
  }
}
```

- **Where it lives:** a `val` of the object named like the file. The
  indexer reads the object's vals, and only the primitives that object
  defined. A tool defined as a `def` or a `lazy val` is a file error that
  says to make it a `val`: the indexer can't read one without running it.
  An object with no tools in it is a helper. So is a file with no object
  (a case class, a trait).
- **Id:** `<pack-id>.<tool-name>`, kebab-case, dot-namespaced.
- **Description:** what it does and returns. The model reads it to decide
  when to call the tool. It isn't enforced, so never leave it out.
- **Version:** the pack's (`pack.version`), or `.version("1.2.0")` (an exact
  semver).
- **Schemas:** from the case classes `Tool[Input, Output]` names. A
  parameter is a property, by its Jackson name
  (`@JsonProperty("canonical_cite")` renames one). The input must be an
  **object**: a model calls a tool with an object of arguments.

  | In Scala | In the schema |
  |---|---|
  | `String`, `Int`/`Long`, `Double`/`BigDecimal`, `Boolean`; `BigInt` | `string`, `integer`, `number`, `boolean`; `integer` |
  | `Option[T]` | not required; `null` allowed |
  | a parameter's default (`greeting: String = "Hello"`) | `default`, not required; the service fills it in |
  | `Seq[T]`, `List[T]`, `Vector[T]`; `Set[T]` | `array`; `array` with `uniqueItems` |
  | `Map[String, T]` | `object` with `additionalProperties` |
  | a Scala 3 simple enum (`enum Scale { case C, F }`) | `string`, `enum` of its case names |
  | `@Size`, `@Min`, `@Max`, `@Pattern`, `@Email`, `@NotBlank`, `@Positive`, … | the matching keywords |

  **In Scala 3, name a Java annotation's arguments:** `@Min(value = 0)`, not
  `@Min(0)`. Scala 3 passes a positional argument to the wrong element.
  When a type can't say it, `Tool.json(id).inputSchema(Map(…))` takes the
  schema as Scala maps, and the handler gets a `Map[String, Any]`.
- **Handler:** `(in, ctx) => output`. It may throw. It runs on a thread of
  its own, so blocking I/O is fine. `handlerAsync((in, ctx) => future)`
  returns a `Future[O]`, and the service awaits it.
- **Validation:** before the handler runs, the input is checked against the
  schema (its defaults filled in). Then what the handler returns is checked
  against the output schema. A bad input comes back as
  `input-validation-failed`, naming the field (a bad output as
  `output-validation-failed`). The agent's `toolErrors` policy decides
  whether the model gets to fix the call.

## `ToolContext`

- `ctx.tenantId`: the tenant the call is for. Key per-tenant state by it.
- `ctx.runId`: the run (an agent turn or a flow step) the call belongs to.
- `ctx.requestId`: this call, such as the model's tool-call id. For logs: a
  model's call id is only unique within one of its answers, so don't dedupe
  on it.
- `ctx.idempotencyKey`: the same every time this call runs (resumed,
  retried, or run again after a crash), different for every other call. A
  step can run more than once, so a tool that writes passes it to the system
  it writes to (`Option(ctx.idempotencyKey).foreach(k => request.header("Idempotency-Key", k))`)
  or looks for it there first: a refund never goes out twice. A UUID; `null`
  outside a run and from a runtime before 0.1.6. Docs:
  https://docs.kindgi.com/v0.1/guides/tools/write-a-tool/#make-a-side-effect-happen-once
- `ctx.projectId`, `ctx.orgId`: the run's project, and its org (`null` when
  it has none). The runtime sets them from the run, never from the input.
  To check an id the input names, compare it with these.
- `ctx.cancellation` fires when the call's deadline passes (120 s by
  default) or the caller goes away. A blocking handler's thread is
  interrupted too. A loop checks `ctx.cancellation.isCancelled`. A `Future`
  has no way to stop, so stop the work behind it with
  `ctx.cancellation.onCancel(() => …)`.
- `ctx.secrets`: the secrets the tool declares (below), as a Java map.
  Printing the context shows their names, never their values.
- `ctx.env`, `ctx.config`: **reserved, empty today**.

## Configuration and secrets

A secret that belongs to the tenant, such as an API key a customer gives
you, is declared with `set("needsSpec", …)` and read from `ctx.secrets`, as
above. The runtime resolves every declared secret on every call, for the
call's tenant, in its env (`KINDGI_ENV`; under `kindgi dev`, `local`: the
pack's `.env` and `.env.local`). It checks each against its schema, and fails
the call, naming the secret, when one is missing or doesn't match. A
declared secret is required, unless its schema names null
(`"type": ["string", "null"]`): an optional one the env doesn't have, or has
empty, is absent from `ctx.secrets`, and the call goes on (runtime 0.1.6 or
later; an older runtime requires it).

Everything else comes from the process environment: `sys.env("CITATOR_URL")`.
Under `kindgi dev`, the pack service gets the pack's `.env` and `.env.local`,
and restarts when they change. Nothing else from your shell reaches it
except `PATH`, `HOME` and `TMPDIR`; `SBT_OPTS` reaches sbt only. Put a secret
there by hand, or with `./kindgiw secrets set NAME --env=local --scope=tenant`
(a no-echo prompt), and keep the env files out of git. A deployed service
names the variables it needs in `kindgi.config.json`:
`"env": {"required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"]}`. Without
a required one it isn't ready, and every variable it doesn't declare is
dropped before your code loads (`kindgi dev` keeps them), so an undeclared
one works locally and is unset once deployed. `KINDGI_*` names are Kindgi's
own: a pack can't declare one.

## Errors and output

- Throw for a failure, or fail the `Future`: the call fails with
  `handler-throw` and the exception's message. In an agent turn, the model
  sees the failure only when the agent's `toolErrors` policy includes
  `tool-error`, so retrying must be safe for that tool.
- What the handler logs goes to the pack service's output (`kindgi dev`
  shows it as `[pack] …`), never into a result.

## Other declarations

**`readOnly`** declares a tool that changes nothing outside itself (a lookup,
a search, a calculation): it's `mutating(false)`. A dry run
(`./kindgiw runs start --dry-run`) runs it. Leave it off for anything that
writes, sends, charges or deletes: such a tool stops a dry run. It's also
the tool's approval default: an agent that turns approval gates on
(`conversationPolicy.hitl`) asks before any tool that isn't read-only on its
first use.

`effect(kind, resource)` declares a side effect, such as
`.effect("writes", "db:ledger")`. A dry run also stops at a tool with a
`writes`, `deletes`, `spawns-run`, `emits-event` or `external-side-effect`
effect. `set(field, value)` sets the index entry's other fields (`needs`,
`needsSpec`, `sandbox`, `limits`, `network`), with Scala maps and lists. They
are recorded for policy and review, so declare what the tool really does.

There is no HTTP-tool form (TypeScript's `kind: 'http'`). A tool that calls
an HTTP API is a handler with `java.net.http.HttpClient`, as above.

## Testing

`tool.call(input, ctx)` runs the handler with the input as given (no schema
check). `ToolContext.forTest()` is a context with a test tenant and run and
nothing else. A handler that reads the environment and calls a service is
tested through the method it calls, with a stub server:

```scala
// src/test/scala/acme/VerifyCitationSuite.scala
package acme

import acme.tools.VerifyCitation
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress

class VerifyCitationSuite extends munit.FunSuite {
  test("an unknown citation is not found") {
    val citator = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
    citator.createContext("/lookup", exchange => {
      exchange.sendResponseHeaders(404, -1)
      exchange.close()
    })
    citator.start()
    try {
      val url = s"http://127.0.0.1:${citator.getAddress.getPort}"
      assert(!VerifyCitation.verify(VerifyCitation.Input("1 U.S. 1", "US"), "test-key", url).found)
    } finally citator.stop(0)
  }
}
```

`sbt test` runs the tests (anything under `src/test/` is never indexed). To
see the schemas Kindgi derives:

```sh
java -cp "$(sbt -batch -error 'export Runtime/fullClasspath')" com.kindgi.pack.Main index --pack-dir .
```

## Wiring the tool onto an agent

Pass the `Tool`, which pins that tool's version:

```scala
Agent("acme.brief-writer")
  // …
  .tool(VerifyCitation.tool)
```

A tool of another pack is `.tool("other.lookup", "^1.0.0")`: its id and a
semver **range**, and the highest active version matching it is picked at
turn start. In a flow, `toolNode("verify", VerifyCitation.tool)` runs it.

## Iterating

Save the file. `kindgi dev` recompiles through sbt's server, and the next
call runs the new code. A compile error is reported as `file:line:col`, and
the last good code keeps serving. Bump the version when callers' contract
changes (a removed field, a narrower type), not on every save.

## Common mistakes

1. **Copying the sample tool's shape without asking what the tool should do.**
2. **A tool as a `def` or a `lazy val`.** It's a file error: make it a `val`.
3. **An object not named like its file.** The indexer reads `Greet.scala`'s
   `object Greet`, and a file without one is an error.
4. **No description.** The model can't tell when to call the tool.
5. **`@Min(0)` in Scala 3.** Name the argument: `@Min(value = 0)`.
6. **A primitive inside a type parameter** (`Seq[Int]`, `Option[Long]`). On
   the JVM it's `Object`, so the schema allows any JSON value there. Use a
   case class (`Seq[Item]`), or say the schema with `Tool.json`.
7. **Reading `ctx.env` or `ctx.config`, or an undeclared secret.** The first
   two are empty, and `ctx.secrets` holds only what `needsSpec` declares.
   Use `sys.env` for the rest.
8. **A library the tool uses as `% Test` or `% Provided`.** It works under
   `kindgi dev` and fails in the image, which ships the runtime classpath
   only.
9. **A read-only tool without `readOnly`.** A dry run stops at it, and an
   approval gate asks before it on first use.
10. **`readOnly` on a tool that writes.** A dry run then runs it for real.
11. **A jackson-module-scala that doesn't match your app's
    `jackson-databind` minor version.** It refuses to load: depend on the
    matching one.

## When the framework itself is the problem

If the bug is in Kindgi, kindgi-pack or the Scala layer (a schema derived
wrong, a misleading error, the pack service misbehaving) and not in the
tool's code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
