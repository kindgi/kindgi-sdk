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
version: "0.1.6"
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
> change in a later release without the usual deprecation period.

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

- `ctx.tenantId()`: the workspace the call is for. Key per-workspace state by it.
- `ctx.runId()`: the run (an agent turn or a flow step) the call belongs to.
- `ctx.requestId()`: this call, such as the model's tool-call id. For logs:
  a model's call id is only unique within one of its answers, so don't
  dedupe on it.
- `ctx.idempotencyKey()`: the same every time this call runs (resumed,
  retried, or run again after a crash), different for every other call. A
  step can run more than once, so a tool that writes passes it to the system
  it writes to (an `Idempotency-Key` header, a client reference, a unique
  column) or looks for it there first: a refund never goes out twice. A
  UUID; `null` outside a run and from a runtime before 0.1.6. Docs:
  https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#make-a-side-effect-happen-once
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
- `ctx.env()`: the env values the tool declares (`set("needsSpec",
  Map.of("env", …))`), resolved for the call: its project's value, else its
  org's, else the workspace's (`kindgi env set NAME <value>
  --scope=project:<id> --env=<env>`), with a declared `default` filled in.
  Strings, and not secret.
- `ctx.config()`: **reserved, empty today**.

## Work that takes longer than a call

A tool call has a deadline: 120 s by default (`KINDGI_PACK_CALL_TIMEOUT_MS`
on a runtime the user runs). At the deadline the call fails with
`deadline-exceeded` and `ctx.cancellation()` fires; a handler that doesn't
stop runs on, and its result goes nowhere.
- In an agent, the turn fails, unless the agent's `toolErrors`
  (`set("toolErrors", …)`) lists `tool-error` in `retryOn`. The list
  replaces the default, so keep `invalid-arguments` and `unknown-tool` in
  it; the workspace's `tool-errors` policy can narrow it further.
- In a flow, the step fails. An edge's `retry` may run it again while the
  first handler still runs, with the same `ctx.idempotencyKey()`: pass the
  key on. An edge's `timeoutMs` can only fail it sooner.
- A run whose call is still running is executing, not parked: a runtime
  deploy or restart, or a crash, fails it.

NEVER write a tool that waits for work taking minutes or hours, and don't
raise the deadline for it: a Java tool can't pause its run. Start the job
with `ctx.idempotencyKey()`, return its id at once, and give the other
system a webhook trigger that starts the next flow with its answer; when it
can't call back, check the job from a scheduled flow.

Docs: https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#work-that-takes-longer-than-a-call

## Configuration and secrets

A workspace's secret, such as an API key a customer gives
you, is declared with `set("needsSpec", …)` and read from `ctx.secrets()`, as
above. The runtime resolves every declared secret on every call, for the
call's workspace, in its env (`KINDGI_ENV`; under `kindgi dev`, `local`: the
pack's `.env` and `.env.local`, then Kindgi's own `.kindgi/secrets.env`, where
`./kindgiw secrets set` writes). It checks each against its schema, and fails
the call, naming the secret, when one is missing or doesn't match. A
declared secret is required, unless its schema names null
(`"type": ["string", "null"]`): an optional one the env doesn't have, or has
empty, is absent from `ctx.secrets`, and the call goes on (runtime 0.1.6 or
later; an older runtime requires it).

Everything else comes from the process environment: `System.getenv("CITATOR_URL")`.
Under `kindgi dev`, the pack service gets the pack's `.env` and `.env.local`,
and restarts when they change. Nothing else from your shell reaches it
except `PATH`, `HOME` and `TMPDIR`; `MAVEN_ARGS` and `MAVEN_OPTS` reach Maven
only. Put a setting there by hand, and keep the env files out of git. A
secret stored with `./kindgiw secrets set NAME --env=local --scope=tenant` (a
no-echo prompt) never reaches the process environment: declare it and read it
from `ctx.secrets()`. A model provider's key reaches no tool at all: a tool
that calls a model declares a key of its own. A deployed service names the
variables it needs in `kindgi.config.json`: `"env": {"required": ["DATABASE_URL"],
"optional": ["SENTRY_DSN"]}`. Without a required one it isn't ready, and
every variable it doesn't declare is dropped before your code loads
(`kindgi dev` keeps them), so an undeclared one works locally and is unset
once deployed. `KINDGI_*` names are Kindgi's own: a pack can't declare one.

### Connections to other apps

A tool that acts in another app as a person or as the company (sending mail, opening an issue) declares a **connection**, never a secret holding someone's token, and reads the call's short-lived token from `ctx.connections()` (runtime 0.2.0 or later):

```java
public static final Tool<Input, Output> TOOL = Tool.define("my-pack.send-mail")
    // …description, version, input, output, effects…
    .set("needsSpec", Map.of("connections", Map.of(
        "mail", Map.of("app", "google", "permissions", List.of("gmail.send"), "as", "person"))))
    .handler((input, ctx) -> {
      ToolConnection mail = ctx.connections().get("mail");
      HttpResponse<String> res = http.send(
          HttpRequest.newBuilder(uri).header("authorization", "Bearer " + mail.accessToken()).build(),
          HttpResponse.BodyHandlers.ofString());
      if (res.statusCode() == 401) throw new ConnectionRejectedException("mail");
      // …
    });
```

- **Whose connection:** `"as", "person"` is the connection of the person the run acts as (whoever started it, or the owner of the schedule or webhook that did); `"as", "company"` is the company's. The runtime picks it from the run, never from the input or the model. A run that acts as nobody (a service account's, an event's) fails a `"person"` call with `connection-needs-a-person`.
- **The token:** `accessToken()` is current for this call only. Never keep, print, log or return it; it never reaches the journal. `account().label()` says whose account it is (`ana@acme.com`).
- **A 401 from the app:** `throw new ConnectionRejectedException("mail")`, with the connection's name (a second argument can say what the app answered, never the token), or your own exception with it as the cause. The runtime renews the token once and runs the call again; refused again, the call fails with `connection-rejected`.
- **An HTTP tool** sends the token with no code: `.authorization(new HttpAuthSpec.Connection("mail"))`.
- **Unattended runs:** in a run no person started, a tool that uses a `"person"` connection waits for that person's yes, reads included: `.mutating(false)` doesn't lift it. The agent's own approval settings can't lift it; only a trigger's `toolsAllowedUnattended` can, which a project admin sets, as for `needsApprovalWhenUnattended` (below). In a run a new mail started, the mail is a stranger's text, so two more calls wait: a call of a tool that isn't `.mutating(false)`, and, when the trigger reads the company's mailbox, a read with the company's connection to that app. The mail trigger's `toolsAllowedUnattended` lifts these too.
- **In a unit test:** `ToolContext.forTest(Map.of("mail", new ToolConnection("c-1", "google", "Google", "test", new ConnectionAccount("1", "ana@acme.com"), null)))`; the last argument, when the token expires, can be `null`. `ctx.connections()` is empty when the tool declares none.

Docs: https://docs.kindgi.com/v0.3/guides/connections/use-a-connection/

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
writes, sends, charges or deletes: such a tool stops a dry run. It's also the
tool's approval default: an agent that turns approval gates on
(`conversationPolicy.hitl`) asks before any tool that isn't read-only on its
first use. And it decides what runs together: when a model step asks for
several calls at once, an agent runs calls to read-only tools (no changing
effect either) that come one after another at the same time, up to 8 of them,
and any other call on its own, in the order the model asked (an agent with
`set("parallelToolCalls", false)` runs every call on its own). A call that may
wait, for another system's answer or for the person who started the run to
connect an app, runs on its own too.

In a run a new mail started, a call of a tool that isn't read-only waits
for a person's yes, unless the mail trigger's `toolsAllowedUnattended`
lists it.

`effect(kind, resource)` declares a side effect, such as
`.effect("writes", "db:ledger")`. A dry run also stops at a tool with a
`writes`, `deletes`, `spawns-run`, `emits-event` or `external-side-effect`
effect. `set(field, value)` sets the index entry's other fields: `needs`,
`needsSpec`, `sandbox`, `limits`, `network`. They are recorded for policy and
review, so declare what the tool really does.

A tool that calls an HTTP API can be a handler with `java.net.http.HttpClient`,
as above, or the request declared as data with no handler — see **HTTP tool (as
data)** below.

## HTTP tool (as data)

A tool that calls an HTTP API can be the request itself, declared as data,
instead of a handler: `.http(spec)` in place of `.handler(...)`. The Kindgi
runtime makes the request from the spec — the SDK only builds and validates it,
so calling such a tool in this JVM throws. Build the spec with
`HttpToolSpec.builder()` (package `com.kindgi.pack.http`):

```java
import com.kindgi.pack.Tool;
import com.kindgi.pack.http.HttpAuthSpec;
import com.kindgi.pack.http.HttpMethod;
import com.kindgi.pack.http.HttpToolSpec;
import com.kindgi.pack.http.ToolSecretRef;

public record FetchOrder(String orderId) {}

public record Order(String id, String status, double total) {}

public static final Tool<FetchOrder, Order> TOOL =
    Tool.define("shop.fetch-order")
        .description("Fetch an order by id from the storefront API.")
        .version("0.1.0")
        .mutating(false)
        .input(FetchOrder.class)
        .output(Order.class)
        .http(
            HttpToolSpec.builder()
                .method(HttpMethod.GET)
                .urlTemplate("https://api.shop.example/orders/{orderId}")
                .authorization(
                    new HttpAuthSpec.Bearer(new ToolSecretRef("production", "shop-api-token")))
                .successStatus(200, 299)
                .build());
```

Every `{placeholder}` in the URL — in the path and query only, never in the
host or port — is a field of the input, and so is one in a
`HttpRequestBodySpec.Text` body; `.http(...)` throws if it isn't. Authorization
is a `secretRef` (`HttpAuthSpec.Bearer` or `HttpAuthSpec.Header`), named for the
runtime to resolve, never a literal credential. A request body is
`HttpRequestBodySpec.JsonInput` (the input as JSON), `InputPassthrough` or
`Text`. `timeoutMs` (default 30 seconds) covers the whole call, the response
read included, and a run's cancel does too; a response body over 10 MiB,
measured decompressed, fails the call — so point a tool at an endpoint that
pages or filters, not one that returns everything. Scala declares the same tool
the same way, with the same `HttpToolSpec`.

## A person's yes when no one is watching: `needsApprovalWhenUnattended`

`needsApprovalWhenUnattended(true)` declares that a person must say yes to every call of the tool in a run no person started: one a schedule, a webhook, a new mail, an event or a service account's key started. In such a run:

- **An agent's call waits** for a person's yes, whatever the agent's `conversationPolicy.hitl.tools` says. The agent's rules can't lift it: agents are reused, and the tool's author knows what it does.
- **A flow's tool step that calls it is refused.** Put the tool behind an agent step instead, whose call waits.
- **A trigger can lift both, for its own runs only.** A project admin names the tool in a webhook trigger's, a schedule's or a mail trigger's `toolsAllowedUnattended` (`--allow-unattended=<tool-id>` on `kindgi webhooks`, `kindgi schedules` and `kindgi mail-triggers`). In that trigger's runs, the tool is then as in a run a person started. The workspace's approval rules still apply.

In a run a person started (signed in, or with their own API key), the agent's rules decide, as for any tool. Left unset, it counts as `false`. Declare it on a tool that moves money or changes something people rely on:

```java
      .effect("writes", "acme:refunds")
      .mutating(true)
      .needsApprovalWhenUnattended(true)
```

Docs: https://docs.kindgi.com/v0.3/guides/approvals/ask-before-a-tool-runs/#when-no-person-started-the-run

## Results that are text from outside: `resultIsOutsideData`

`resultIsOutsideData(true)` says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. Absent means `false`.

## Testing

`Tool.call(input, ctx)` runs the handler with the input as given (no schema
check). `ToolContext.forTest()` is a context with only a test workspace and
run. `ToolContext.forTest(tool, env, secrets)` adds the env values
the tool declares in `needsSpec`, decided as a run decides them (a schema
`default` fills a name the test doesn't set, each value is checked, and a
missing or invalid one throws `IllegalArgumentException`), and the secrets as
given. `ToolContext.Builder` sets the rest:

```java
ToolContext ctx = ToolContext.forTest(new ToolContext.Builder()
    .withSecrets(Map.of("CITATOR_KEY", "test-key-of-twenty-chars")));
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
8. **A read-only tool without `mutating(false)`.** A dry run stops at it, an
   approval gate asks before it on first use, and an agent runs each call to
   it on its own.
9. **`mutating(false)` on a tool that writes.** A dry run then runs it for
   real, and an agent may run it at the same time as other calls.
10. **A Jackson module registered only in code, on your own `ObjectMapper`.**
    kindgi-pack finds modules as `findAndRegisterModules()` does, through
    `META-INF/services`. Declare it there, or the tool's input and schema
    won't see it.

11. **Turning the dev sandbox off for a file the tool needs.** Under `kindgi dev`
    the tool's code runs sandboxed: it can't read outside the app (the home
    folder, `~/.aws`) or any `.env*` file, and gets `EPERM` there. A tool that
    needs a path names it in `kindgi.config.json`: `"dev": {"sandbox": {"allowRead": ["~/.aws"]}}`.
    Never set `KINDGI_DEV_SANDBOX=off` or `dev.sandbox: false` to get past it
    (https://docs.kindgi.com/v0.3/guides/secrets/dev-sandbox/).

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack (a schema derived wrong, a misleading
error, the pack service misbehaving) and not in the tool's code, load
`kindgi-framework-feedback` and file it with `./kindgiw feedback write`.
