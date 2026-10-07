# Kindgi Java SDK

Call the Kindgi™ API from a Java application: agents, runs, approvals, evals
and the rest, with typed models, typed errors, paging, streaming and retries.

**Status:** preview, not on Maven Central yet. Build it from this repository
(below). Needs Java 17 or later.

```xml
<dependency>
  <groupId>com.kindgi</groupId>
  <artifactId>kindgi-client</artifactId>
  <version>…</version>
</dependency>
```

`kindgi-client` brings `kindgi-models` (the API's records) and nothing else
you'd notice: its JSON library is inside its jar, so it never meets your
app's own Jackson.

## Use

```java
// in src/main/java/com/acme/Bookkeeping.java
Kindgi client = Kindgi.create();

Run run = client.runs().start(StartRunBody.WithAgent.builder()
    .agent("acme.bookkeeper")
    .input(Map.of("userMessage", "Record the Acme invoice"))
    .build());
System.out.println(client.runs().get(run.id()).status());
```

`Kindgi.create()` reads `KINDGI_API_URL` and `KINDGI_API_TOKEN`. In
development, when they're unset, it uses the running `kindgi dev` (the
nearest `.kindgirc.json`) and logs a warning to put them in your env file.
Production (`KINDGI_ENV` or `NODE_ENV` set to `production`) never reads
`.kindgirc.json`. `Kindgi.builder()` sets the URL, the token, the timeout
(60 s), the retries (2), extra headers or your own `HttpClient`.

**Resources follow the API's operation ids:** `approvals.reviewers.list` is
`client.approvals().reviewers().list()`. Path parameters come first, then
the request body, then the query and header parameters as one record with a
builder (`RunsListParams.builder().limit(20L).build()`). A method whose
parameters are all optional also has a form without them.

**Async:** `client.async()` (or `KindgiAsync.create()`) has the same
methods, answering `CompletableFuture`s; a failed call completes
exceptionally with the same typed exception.

**Streams:** `runs().follow(runId)` is an `EventStream<RunEvent>` of a
run's events through to its end (`run.completed`, `run.failed` or
`run.cancelled`). Iterate it, or `stream()` it. The server ends a stream
after a time limit while the run is still going. `follow` reconnects with
`Last-Event-Id`, so each event comes once, and so does a dropped connection
(backoff 0.5 s → 30 s, 10 attempts). Close it to stop early.
`followProgress(runId)` does the same for the progress events (no payloads).
`runs().stream(runId)` is the plain operation, which ends when the server
closes it. On the async client these are `Flow.Publisher`s.

```java
// in src/main/java/com/acme/Follow.java
try (EventStream<RunEvent> events = client.runs().follow(run.id())) {
  for (RunEvent event : events) {
    System.out.println(event.kind());
  }
}
```

**Pages:** a list answers one page (`data`, `hasMore`, `nextCursor`).
Every cursor-paginated list also has `…All`, a lazy `Stream` of every item:
`client.runs().listAll().limit(500)`.

**Errors** are typed: `NotFoundException`, `ConflictException`,
`InvalidRequestException`, `AuthException`, `RateLimitedException`,
`GuardrailViolationException`, `ServerException` and `NetworkException`, all
`KindgiApiException`s. `serverCode()` is the server's own code
(`run-not-found`); `code()` is the category, as in the TypeScript and
Python clients.

**Retries:** a connection error, a timeout, or a 429 / 502 / 503 / 504 is
retried with backoff (honouring `Retry-After`) when the call is safe to
repeat: a `GET`, or a call with an idempotency key. The client generates the
key when you give none, so a retried start never runs twice.

## The models

`kindgi-models` has a record for every schema of the API, a sealed
interface for every union (switch over it), and a class for every enum.
Each record has a builder.

- **Built or sent, a value is checked** against the API's constraints
  (lengths, patterns, ranges): `build()` and the client before it sends a
  body throw a `ValidationException` that lists every problem.
- **Read, an answer is checked for its structure** (types, required
  properties, a union's variant), not its constraints, so a newer runtime
  that relaxes one doesn't break your client.
- **Newer runtimes are expected.** Unknown properties are ignored. An enum
  value this client doesn't know is kept: `status().value()` is
  `UNRECOGNIZED`, and `asString()` has the text. A union variant it doesn't
  know is kept too, as the union's `Unrecognized`.
- **An update can clear a property:** a property that can be left out or
  `null` is an `OptionalNullable`. Not calling the builder's setter leaves
  it as it is; `label(null)` sends `null`, which clears it.
- **Your app's Jackson (2 or 3) reads and writes the models** through their
  `jackson-annotations` (Spring Boot 3.2 and later). To get exactly the
  client's JSON, use `KindgiJson.write(value)` and
  `KindgiJson.read(json, Run.class)`.

A property named like a Java keyword or a method every record has gets a
trailing underscore: `wait` is `wait_()`.

## Tools in Java

[`kindgi-pack`](./kindgi-pack) is the other direction: tools and guardrail
checks written in Java, which the Kindgi runtime calls. Define them as
records and lambdas, index the pack, and serve it over the pack protocol.

## Build from source

```sh
cd sdks/java
./mvnw verify            # the generator, the models, the client and kindgi-pack, with their tests
./mvnw install           # into your local Maven repository, to use from an app
./mvnw -Pcompat verify   # also the client inside Spring Boot 3 and 4 apps
```

The client is generated, at build time, from the API's OpenAPI document
(`packages/api/openapi.json`) by the generator in `codegen/`: it can't fall
behind the API. The generator supports exactly the schema constructs the API
uses, and refuses any other, so a new construct fails the build rather than
generating a wrong client. Its output for a small document that uses every
construct is checked in `codegen/src/test/resources/fixture/expected/`: after
an intended change, regenerate it with
`./mvnw -pl codegen test -Dkindgi.updateGolden=true` and review the diff.
