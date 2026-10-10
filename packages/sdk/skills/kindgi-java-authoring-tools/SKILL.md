---
name: kindgi-java-authoring-tools
description: >
  Covers writing tools for a Kindgi pack in Java (`com.kindgi:kindgi-pack`):
  `Tool.define(id)` as a `public static final` field, input and output
  schemas from records (Jakarta Validation constraints become keywords) or
  a JSON Schema map, `handler` and `asyncHandler`, `ToolContext` and
  cancellation, secrets (`needsSpec`) and configuration, errors,
  `mutating(false)` and effects, unit tests with `Tool.call`, and wiring a
  tool onto an agent. Load this whenever you are authoring or editing code
  in a Java pack's tools packages (a pack whose `kindgi.config.json` says
  `"language": "java"`), defining a tool, or wiring one onto an agent.
  Java agents are covered by kindgi-java-authoring-agents, getting started
  by kindgi-java-getting-started.
type: core
library: "kindgi-pack (Java)"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [java]
sources:
  - sdks/java/kindgi-pack/README.md
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/Tool.java
  - sdks/java/kindgi-pack/src/main/java/com/kindgi/pack/ToolContext.java
---

# Authoring Kindgi tools in Java

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version, so every
> `kindgi <command>` below runs as `./kindgiw <command>` (`kindgiw.cmd` on
> Windows). Maven runs as `./mvnw` (or the app's own `mvn`).
>
> Java support is in preview: tested and supported, but the API may still
> change in 0.1.6 without the usual deprecation period.

A **tool** is a unit of work an agent (or a flow step) calls: typed input,
typed output, your code in between. In a Java pack it is a
`public static final Tool<I, O>` field of a class in a `tools` package
(`src/main/java/**/tools/**/*.java`; in an app, `**/kindgi/tools/**`). Kindgi
runs it in the pack's own JVM (the pack service) and calls it over HTTP; the
model sees its id, description and input schema.

Before writing one, establish what it should **do**: what it computes or
fetches, what the caller provides, what it returns. "Add a tool" is a
conversation opener. The pack's sample tools prove the runtime works; they
are not the shape to copy unless the user asks.

## A tool

```java
// src/main/java/acme/tools/VerifyCitation.java
package acme.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** acme.verify-citation: checks a legal citation against the citator. */
public final class VerifyCitation {
  public record Input(
      @Size(min = 1) String citation,
      @Pattern(regexp = "^(US|UK|EU)$") String jurisdiction) {}

  public record Output(boolean found, @Nullable String canonicalCite) {}

  public static final Tool<Input, Output> TOOL = Tool.define("acme.verify-citation")
      .description("Verifies a legal citation against the citator; returns whether it resolves and its canonical form.")
      .input(Input.class)
      .output(Output.class)
      .mutating(false)
      .set("needsSpec", Map.of("secrets", Map.of("CITATOR_KEY", Map.of("type", "string", "minLength", 20))))
      .handler((input, ctx) ->
          verify(input, (String) ctx.secrets().get("CITATOR_KEY"), System.getenv("CITATOR_URL")));

  /** The tool's work, with what it reads from its context and the environment passed in: a test calls it. */
  public static Output verify(Input input, String key, String citatorUrl) throws IOException, InterruptedException {
    String hit = Citator.lookup(citatorUrl, key, input.citation(), input.jurisdiction());
    return new Output(hit != null, hit);
  }

  private VerifyCitation() {}
}
```

```java
// src/main/java/acme/tools/Citator.java
package acme.tools;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import org.jspecify.annotations.Nullable;

/** The citator's API. Package-private: a helper, not a primitive. */
final class Citator {
  private static final HttpClient HTTP = HttpClient.newHttpClient();

  static @Nullable String lookup(String baseUrl, String key, String citation, String jurisdiction)
      throws IOException, InterruptedException {
    String query = "q=" + URLEncoder.encode(citation, StandardCharsets.UTF_8) + "&j=" + jurisdiction;
    HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/lookup?" + query))
        .header("Authorization", "Bearer " + key)
        .build();
    HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
    return response.statusCode() == 200 ? response.body() : null;
  }

  private Citator() {}
}
```

- **Where it lives:** a `public static final` field of a class in a `tools`
  package. The indexer loads the class and takes the tools its static fields
  hold. A tool built in a method, or held by an instance field, is never
  found.
- **Id:** `<pack-id>.<tool-name>`, kebab-case, dot-namespaced.
- **Description:** what it does and returns. The model reads it to decide
  when to call the tool. It isn't enforced, so never leave it out.
- **Version:** the pack's (`pack.version`), or `.version("1.2.0")` (an exact
  semver).
- **Schemas:** from the records `input(…)` and `output(…)` name. A record's
  components are the object's properties, by their Jackson names
  (`@JsonProperty("canonicalCite")` renames one). Unknown properties are
  refused unless the type says `@JsonIgnoreProperties(ignoreUnknown = true)`.
  The input must be an **object**: a model calls a tool with an object of
  arguments.

  | In Java | In the schema |
  |---|---|
  | `String`, `int`/`long`, `double`/`BigDecimal`, `boolean` | `string`, `integer`, `number`, `boolean` |
  | `@Nullable T`, `Optional<T>` | not required; `null` allowed |
  | `@JsonProperty(defaultValue = "1")` | `default: 1`, not required; the service fills it in |
  | `List<T>`, `Set<T>`, `T[]`; `Map<String, T>` | `array`; `object` with `additionalProperties` |
  | an enum; `UUID`, `Instant`, `LocalDate`, `URI` | `enum`; `string` with its `format` |
  | `@JsonPropertyDescription` | `description` |
  | `@Size`, `@Min`, `@Max`, `@Pattern`, `@Email`, `@NotBlank`, `@Positive`, … | the matching keywords |

  A type that can't be a schema (a recursive record, a map with non-string
  keys) is a file error naming the property. When a type can't say it, pass
  the schema itself, `input(Map.of("type", "object", …))`, and the handler
  gets a `Map`.
- **Handler:** `(input, ctx) -> output`. It may throw. It runs on a thread of
  its own, so blocking I/O is fine. A handler built on futures uses
  `asyncHandler((input, ctx) -> stage)` and returns a `CompletionStage`; the
  service awaits it.
- **Validation:** before the handler runs, the input is checked against the
  schema (its defaults filled in). Then what the handler returns is checked
  against the output schema. A bad input comes back as
  `input-validation-failed`, naming the field (a bad output as
  `output-validation-failed`). The agent's `toolErrors` policy decides
  whether the model gets to fix the call.

## `ToolContext`

- `ctx.tenantId()`: the tenant the call is for. Key per-tenant state by it.
- `ctx.runId()`: the run (an agent turn or a flow step) the call belongs to.
- `ctx.requestId()`: this call, such as the model's tool-call id. Useful for
  logs and idempotency keys.
- `ctx.projectId()`, `ctx.orgId()`: the run's project, and its org (`null`
  when it has none). The runtime sets them from the run, never from the
  input. To check an id the input names, compare it with these.
- `ctx.cancellation()` fires when the call's deadline passes (120 s by
  default) or the caller goes away. The handler's thread is interrupted too,
  so a blocking wait ends. A loop checks `isCancelled()` or calls
  `throwIfCancelled()`. Work started elsewhere (a request, a job) stops with
  `onCancel(action)`.
- `ctx.secrets()`: the secrets the tool declares (below). Printing the
  context shows their names, never their values.
- `ctx.env()`, `ctx.config()`: **reserved, empty today**.

## Configuration and secrets

A secret that belongs to the tenant, such as an API key a customer gives
you, is declared with `set("needsSpec", …)` and read from `ctx.secrets()`, as
above. The runtime resolves every declared secret on every call, for the
call's tenant, in its env (`KINDGI_ENV`; under `kindgi dev`, `local`: the
pack's `.env` and `.env.local`). It checks each against its schema, and fails
the call, naming the secret, when one is missing or doesn't match. A
declared secret is required, unless its schema names null
(`"type": ["string", "null"]`): an optional one the env doesn't have, or has
empty, is absent from `ctx.secrets`, and the call goes on (runtime 0.1.6 or
later; an older runtime requires it).

Everything else comes from the process environment: `System.getenv("CITATOR_URL")`.
Under `kindgi dev`, the pack service gets the pack's `.env` and `.env.local`,
and restarts when they change. Nothing else from your shell reaches it
except `PATH`, `HOME` and `TMPDIR`; `MAVEN_ARGS` and `MAVEN_OPTS` reach Maven
only. Put a secret there by hand, or with
`./kindgiw secrets set NAME --env=local --scope=tenant` (a no-echo prompt),
and keep the env files out of git. A deployed service names the variables
it needs in `kindgi.config.json`: `"env": {"required": ["DATABASE_URL"],
"optional": ["SENTRY_DSN"]}`. Without a required one it isn't ready, and
every variable it doesn't declare is dropped before your code loads
(`kindgi dev` keeps them), so an undeclared one works locally and is unset
once deployed. `KINDGI_*` names are Kindgi's own: a pack can't declare one.

## Errors and output

- Throw for a failure: the call fails with `handler-throw` and the
  exception's message. In an agent turn, the model sees the failure only
  when the agent's `toolErrors` policy includes `tool-error`, so retrying
  must be safe for that tool.
- What the handler logs (your app's logger, `System.err`) goes to the pack
  service's output (`kindgi dev` shows it as `[pack] …`), never into a
  result.

## Other declarations

**`mutating(false)`** declares a tool read-only: it changes nothing outside
itself (a lookup, a search, a calculation). A dry run
(`./kindgiw runs start --dry-run`) runs it. Leave it unset for anything that
writes, sends, charges or deletes: such a tool stops a dry run. It's also
the tool's approval default: an agent that turns approval gates on
(`conversationPolicy.hitl`) asks before any tool that isn't read-only on its
first use.

`effect(kind, resource)` declares a side effect, such as
`.effect("writes", "db:ledger")`. A dry run also stops at a tool with a
`writes`, `deletes`, `spawns-run`, `emits-event` or `external-side-effect`
effect. `set(field, value)` sets the index entry's other fields: `needs`,
`needsSpec`, `sandbox`, `limits`, `network`. They are recorded for policy and
review, so declare what the tool really does.

Java has no HTTP-tool form (TypeScript's `kind: 'http'`). A tool that calls
an HTTP API is a handler with `java.net.http.HttpClient`, as above.

## Testing

`Tool.call(input, ctx)` runs the handler with the input as given (no schema
check). `ToolContext.forTest()` is a context with a test tenant and run and
nothing else; `new ToolContext(…)` builds one with secrets:

```java
ToolContext ctx = new ToolContext("t-test", "run-test", null, null, null,
    Map.of(), Map.of("CITATOR_KEY", "test-key-of-twenty-chars"), Map.of(), Map.of(), new Cancellation());
Greet.Output out = Greet.TOOL.call(new Greet.Input("Ada", "Hi"), ctx);
```

A Java test can't set an environment variable, so a handler that reads one
(`CITATOR_URL`) and calls a service is tested through the method it calls,
with a stub server:

```java
// src/test/java/acme/VerifyCitationTest.java
package acme;

import static org.junit.jupiter.api.Assertions.assertFalse;

import acme.tools.VerifyCitation;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.Test;

class VerifyCitationTest {
  @Test
  void anUnknownCitationIsNotFound() throws Exception {
    HttpServer citator = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    citator.createContext("/lookup", exchange -> {
      exchange.sendResponseHeaders(404, -1);
      exchange.close();
    });
    citator.start();
    try {
      String url = "http://127.0.0.1:" + citator.getAddress().getPort();
      assertFalse(VerifyCitation.verify(new VerifyCitation.Input("1 U.S. 1", "US"), "test-key", url).found());
    } finally {
      citator.stop(0);
    }
  }
}
```

`./mvnw test` runs the tests (`*Test.java`, `*IT.java` and anything under
`src/test/` are never indexed). To see the schemas Kindgi derives:

```sh
./mvnw -q compile dependency:build-classpath -Dmdep.outputFile=target/classpath.txt
java -cp "target/classes:$(cat target/classpath.txt)" com.kindgi.pack.Main index --pack-dir .
```

## Wiring the tool onto an agent

Pass the `Tool`, which pins that tool's version:

```java
Agent.define("acme.brief-writer")
    // …
    .tool(VerifyCitation.TOOL)
```

A tool of another pack is `.tool("other.lookup", "^1.0.0")`: its id and a
semver **range**, and the highest active version matching it is picked at
turn start. In a flow, `toolNode("verify", VerifyCitation.TOOL)` runs it.

## Iterating

Save the file. `kindgi dev` recompiles with Maven, and the next call runs the
new code. A compile error is reported as `file:line:col`, and the last good
code keeps serving. Bump the version when callers' contract changes (a
removed field, a narrower type), not on every save.

## Common mistakes

1. **Copying the sample tool's shape without asking what the tool should do.**
2. **A tool that isn't a `static final` field.** An instance field, a local
   variable or a method's return value is never indexed.
3. **A public class in a `tools` package that defines no tool.** It's a file
   error, so a forgotten `static` can't drop a tool silently. Make a helper
   package-private, or a record, an enum or an interface.
4. **No description.** The model can't tell when to call the tool.
5. **Reading `ctx.env()` or `ctx.config()`, or an undeclared secret.** The
   first two are empty, and `ctx.secrets()` holds only what `needsSpec`
   declares. Use `System.getenv` for the rest.
6. **A non-object input** (`input(String.class)`). The input is a record, a
   bean, or an object schema.
7. **A class the tool uses with `test` or `provided` scope.** It works under
   `kindgi dev` and fails in the image, which copies the runtime classpath
   only. Use `compile` or `runtime` scope.
8. **A read-only tool without `mutating(false)`.** A dry run stops at it, and
   an approval gate asks before it on first use.
9. **`mutating(false)` on a tool that writes.** A dry run then runs it for
   real.
10. **A Jackson module registered only in code, on your own `ObjectMapper`.**
    kindgi-pack finds modules as `findAndRegisterModules()` does, through
    `META-INF/services`. Declare it there, or the tool's input and schema
    won't see it.

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack (a schema derived wrong, a misleading
error, the pack service misbehaving) and not in the tool's code, load
`kindgi-framework-feedback` and file it with `./kindgiw feedback write`.
