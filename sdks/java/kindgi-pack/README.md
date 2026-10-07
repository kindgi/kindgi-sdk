# Kindgi Java packs (`kindgi-pack`)

Write a Kindgi™ pack's tools and guardrail checks in Java: define them next to
your app's code, index the pack, and serve them to the Kindgi runtime over the
pack protocol. Agents and flows are data, in the same pack.

**Status:** preview, not on Maven Central yet. Build it from this repository
(`./mvnw install` in `sdks/java`). Needs Java 17 or later.

```xml
<dependency>
  <groupId>com.kindgi</groupId>
  <artifactId>kindgi-pack</artifactId>
  <version>…</version>
</dependency>
<!-- Optional: constraints on inputs (@Size, @Min, @Email, …) -->
<dependency>
  <groupId>jakarta.validation</groupId>
  <artifactId>jakarta.validation-api</artifactId>
  <version>3.0.2</version>
</dependency>
```

## A tool

```java
// src/main/java/com/acme/tools/Greet.java
package com.acme.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.Size;

public final class Greet {
  public record Input(@Size(min = 1, max = 100) String name) {}

  public record Output(String message) {}

  public static final Tool<Input, Output> TOOL = Tool.define("acme.greet")
      .description("Formats a greeting for the named recipient.")
      .input(Input.class)
      .output(Output.class)
      .mutating(false)
      .handler((input, ctx) -> new Output("Hello, " + input.name() + "!"));
}
```

A tool is a `static final` field of a class. The indexer finds it there, and
the service runs it from the same class. Its input and output schemas come
from the record types. The service checks both on every call: an input that
breaks the schema never reaches the handler, and an output that breaks it
never reaches the runtime.

`mutating(false)` says the tool only reads. A dry run may call it, and approval
gates skip it. Leave it unset for a tool that writes, sends or charges.

## The pack

A pack is a directory with a `kindgi.config.json`, usually the root of your
Maven project:

```json
{
  "language": "java",
  "pack": { "id": "acme", "version": "1.0.0" },
  "env": { "required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"] }
}
```

- `pack.id` prefixes every id in the pack (`acme.greet`). Every tool takes
  `pack.version` unless it sets its own `version`.
- `env` names the process environment the service needs (`required`: unset
  or empty, the service isn't ready) or reads when set (`optional`).
- `discovery` (optional) says where the primitives are. The defaults are
  `src/main/java/**/tools/**/*.java`, `…/guardrails/…`, `…/agents/…` and
  `…/flows/…`.

The indexer loads the class of each discovered file and collects the tools,
guardrails, agents and flows its static fields hold. It takes only those the
class (or a class nested in it) defined. A tool that `Bot.java` re-exports from
`Greet` is indexed once, from `Greet.java`.

A file under `tools/` must define tools, one under `guardrails/` guardrails,
and so on. A helper there is a package-private class, a record, an enum or an
interface. A public class that defines nothing is an error, because a
forgotten `static` would otherwise drop a tool silently. Tests
(`*Test.java`, `*IT.java`, `src/test/`) are never primitives.

## Schemas

A record (or a Jackson bean) is an object with its properties, by their
Jackson names. Unknown properties are refused, unless the type says
`@JsonIgnoreProperties(ignoreUnknown = true)`.

| In Java | In the schema |
|---|---|
| `String`, `int`/`long`/…, `double`/`BigDecimal`, `boolean` | `string`, `integer`, `number`, `boolean` |
| `@Nullable T`, `Optional<T>` | not required; `null` allowed |
| `@JsonProperty(defaultValue = "1")` | `default: 1`, not required; the service fills it in |
| `List<T>`, `Set<T>`, `T[]` | `array` (`uniqueItems` for a set) |
| `Map<String, T>` | `object` with `additionalProperties` |
| an enum | `enum` of its JSON values |
| `UUID`, `OffsetDateTime`/`Instant`, `LocalDate`, `URI` | `string` with `format` `uuid`, `date-time`, `date`, `uri` |
| `@JsonPropertyDescription`, `@JsonClassDescription` | `description` |
| a sealed interface with `@JsonTypeInfo(use = NAME)` and `@JsonSubTypes` | `oneOf`, each variant's tag a `const` |
| `@Size`, `@Min`, `@Max`, `@DecimalMin`, `@DecimalMax`, `@Positive`, `@PositiveOrZero`, `@Negative`, `@NegativeOrZero`, `@Pattern`, `@NotBlank`, `@NotEmpty`, `@Email` | the matching keywords |

Jakarta and javax Validation annotations both work. They're read by name, so
the pack needs no Validation dependency unless it uses them. A type that can't
be a schema fails the index and names the property: a recursive record, or a
map with non-string keys.

When a type can't say it, give the schema itself. The handler then gets a `Map`:

```java
Tool.define("acme.search")
    .input(Map.of(
        "type", "object",
        "properties", Map.of("query", Map.of("type", "string", "minLength", 1)),
        "required", List.of("query")))
    .handler((input, ctx) -> Map.of("hits", search((String) input.get("query"))));
```

The service's validator answers exactly as the TypeScript service's Ajv does,
issue for issue. It takes the JSON Schema keywords tool schemas use, and the
indexer refuses a schema with any other keyword (`if`, `prefixItems`, a
remote `$ref`, …).

## Guardrails, agents and flows

```java
// src/main/java/com/acme/guardrails/Checks.java
public record MinLength(@JsonProperty(defaultValue = "1") @Min(0) int minLength) {}

public static final Guardrail<MinLength> RESPONSE_NOT_EMPTY = Guardrail.define("acme.response-not-empty")
    .checkId("acme.checks.response-not-empty")
    .onViolation("halt")
    .severity("error")
    .config(MinLength.class)
    .check((config, trace) -> {
      String output = trace.output() == null ? "" : trace.output().strip();
      return output.length() >= config.minLength() ? CheckResult.pass() : CheckResult.fail("too short");
    });

// src/main/java/com/acme/agents/Bookkeeper.java
public static final Agent AGENT = Agent.define("acme.bookkeeper")
    .version("1.0.0")
    .name("Bookkeeper")
    .instructions("Classify the document, then call acme.record-expense.")
    .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
    .tool(RecordExpense.TOOL)
    .guardrail(Checks.RESPONSE_NOT_EMPTY)
    .build();

// src/main/java/com/acme/flows/Record.java
public static final Flow FLOW = Flow.define("acme.record")
    .version("1.0.0")
    .toolNode("record", RecordExpense.TOOL)
    .edge("e-start", "$start", "record")
    .edge("e-end", "record", "$end")
    .build();
```

An agent or a flow takes any other field of its schema with
`set(field, value)`.

## The call context and cancellation

A handler gets a `ToolContext`: `tenantId()`, `runId()`, `requestId()`,
`projectId()`, `orgId()`, the call's `env()`, `secrets()` and `config()`,
and the `settings()` blocks its agent pins.

At its deadline (`kindgi-timeout-ms`, 120 s by default), or when the caller
goes away, the call is answered `deadline-exceeded` or `cancelled`. The
handler's `ctx.cancellation()` fires and its thread is interrupted, so a
blocking wait ends at once. A loop checks `ctx.cancellation().isCancelled()`
or calls `throwIfCancelled()`. A handler that runs on past its answer is
logged when it finishes (`handler-finished-late`).

Unit-test a handler directly:

```java
assertEquals(new Greet.Output("Hello, Ada!"), Greet.TOOL.call(new Greet.Input("Ada"), ToolContext.forTest()));
```

## Index and serve

Compile the pack, then put its classes and their dependencies on the
classpath:

```sh
./mvnw -q compile dependency:build-classpath -Dmdep.outputFile=target/classpath.txt
CP="target/classes:$(cat target/classpath.txt)"

java -cp "$CP" com.kindgi.pack.Main index --pack-dir . --output target/index.json
java -cp "$CP" com.kindgi.pack.Main launcher > kindgi-pack-java
KINDGI_PACK_SERVICE_TOKEN=… PORT=8080 sh kindgi-pack-java -cp "$CP" com.kindgi.pack.Main serve --index target/index.json
```

The indexer writes the same canonical `index.json` the TypeScript and Python
indexers do: the same classes and pins give the same bytes. `--json` prints
one line for tools to read.

The service runs the process contract every pack service does: `PORT`,
`KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY` (32),
`KINDGI_PACK_ENV_CHECK` (`strict` or `warn`), and the `listening`,
`boot-failed` and `call` lines on stderr. SIGTERM drains in-flight calls for
up to 8 seconds and exits 0. It passes the same conformance suite as the
TypeScript and Python services (`packages/pack-conformance`).

**Start it through the launcher** (`kindgi-pack-java`, a POSIX shell script).
The token authenticates the service's callers. Your code runs in the same JVM
and has no use for it, and a dependency that read it could call your tools
around the runtime. A JVM can't remove a variable from its own environment,
so the launcher removes it before the JVM starts and passes the token on file
descriptor 3. On Windows, run it under WSL.

**The service is an internal endpoint.** It answers only the Kindgi runtime,
which holds its token, behind the runtime's network (a Cloud Run service with
the runtime in front, or `kindgi dev` on your machine). Never expose it to the
public internet. Its HTTP server is deliberately small and strict:

- one request per connection;
- a body needs a `Content-Length`, and `Transfer-Encoding` is refused;
- the request line, headers, body (10 MiB) and the time to send them are capped;
- anything unexpected gets a 400;
- the token is checked before a body is read.

## Jackson

Pack code runs inside your app, with your app's classes, so `kindgi-pack`
binds inputs and outputs with your app's own Jackson 2 (2.15 or later; your
version wins). Your Jackson annotations, modules and custom deserializers
apply to tool inputs as they do everywhere else in the app. `kindgi-client`
is the other way around: it shades its Jackson so the API client never meets
yours.

## Build from source

```sh
cd sdks/java
./mvnw -pl kindgi-pack -am verify
```

The validator's differential test runs every value of
`src/test/resources/ajv/corpus.json`, and every schema the deriver writes
(`derive/golden.json`), through Ajv as the TypeScript service configures it.
`scripts/ajv-oracle.mjs` records Ajv's verdicts and issues in `oracle.json`,
and the Java test requires the same. After changing the corpus or the
deriver, rewrite them:

```sh
./mvnw -pl kindgi-pack test -Dtest=SchemaDeriverTest -Dkindgi.golden.write=true
node scripts/ajv-oracle.mjs
```
