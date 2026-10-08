---
title: Call Kindgi from a Java app
description: Start runs, follow them and read their answers from a Java application, with the Java client (preview).
sidebar:
  order: 5.5
  label: Call Kindgi from Java
  badge: { text: 'Preview', variant: 'caution' }
---

Your Java app starts runs, follows them and reads what they answered,
through the Java client: every operation of the API, with typed answers and
typed errors.

:::caution[Preview]
**Preview.** Java and Scala support is tested and supported, but its API may
still change in 0.1.6 without the usual deprecation period.
:::

**Before you start:** a pack running under `kindgi dev`, such as the one
from the [TypeScript quickstart](../quickstart-typescript/) (`my-pack`,
with its `echo-agent`). The client finds that runtime by itself.

## 1. Get the client

The client is on Maven Central, and needs Java 17 or later. In your app, it's
one dependency, at your Kindgi release's version (the CLI's, `kindgi --version`):

```xml
<dependency>
  <groupId>com.kindgi</groupId>
  <artifactId>kindgi-client</artifactId>
  <version>0.1.5</version>
</dependency>
```

It brings `kindgi-models`, the API's records. It uses its own copy of
Jackson, inside its jar, so your app's Jackson (its version and its
settings) is left alone; that's checked with Spring Boot 3.2 to 4.1.

## 2. Start a run and follow it

To try it, make a small app in a folder inside the pack, `my-pack/hello-java`:
`Kindgi.create()` finds the running `kindgi dev` through the nearest
`.kindgirc.json` above the folder the app runs in, which is the pack's. Its
`pom.xml`:

```xml
<!-- my-pack/hello-java/pom.xml -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>hello-java</artifactId>
  <version>1</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <exec.mainClass>com.acme.StartRun</exec.mainClass>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.kindgi</groupId>
      <artifactId>kindgi-client</artifactId>
      <version>0.1.5</version>
    </dependency>
  </dependencies>
</project>
```

and this class:

```java
// src/main/java/com/acme/StartRun.java
package com.acme;

import com.kindgi.client.EventStream;
import com.kindgi.client.Kindgi;
import com.kindgi.client.models.Run;
import com.kindgi.client.models.RunEvent;
import com.kindgi.client.models.StartRunBody;
import java.util.Map;

public final class StartRun {
  public static void main(String[] args) {
    Kindgi client = Kindgi.create();

    Run run = client.runs().start(StartRunBody.WithAgent.builder()
        .agent("my-pack.echo-agent")
        .input(Map.of("userMessage", "hi"))
        .build());
    System.out.println("started " + run.id());

    try (EventStream<RunEvent> events = client.runs().follow(run.id())) {
      for (RunEvent event : events) {
        System.out.println(event.kind());
      }
    }

    Run done = client.runs().get(run.id());
    Map<?, ?> output = (Map<?, ?>) done.output();
    Map<?, ?> reply = (Map<?, ?>) output.get("response");
    System.out.println(done.status() + ": " + reply.get("content"));
  }
}
```

Run it, with `kindgi dev` still running. This needs Maven 3.9 or later
(`mvn`):

```sh
cd my-pack/hello-java
mvn -q compile exec:java
```

```text
Oct. 07, 2026 4:54:34 P.M. com.kindgi.client.internal.RuntimeSettings warnOnce
WARNING: [kindgi] Using the running kindgi dev from …/my-pack/.kindgirc.json for KINDGI_API_URL and KINDGI_API_TOKEN. Set them in your env file (.env / .env.local), and in production, where there's no .kindgirc.json.
started 0f5a3f72-7b3e-464c-9936-7ab4b4898e03
run.started
run.step-started
run.step-completed
…
run.completed
completed: ⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers.

Tool responded: {"echo":"hi","echoedAt":"2026-10-07T20:54:35.179Z","characterCount":2}
```

The run's events come in as they happen, and `follow` ends with the run. A
server ends one stream after 5 minutes; for a longer run, `follow` reconnects
and carries on after the last event it read. (`runs().stream(runId)` is the
plain operation, which ends when the server closes it.)
The answer comes from `dev-echo`, the stand-in a new pack gets until you
[connect a model](../quickstart-typescript/#6-connect-a-real-model). A run's
`output` is the JSON its agent or flow answered, so the app reads it as maps.

`Kindgi.create()` reads `KINDGI_API_URL` and `KINDGI_API_TOKEN`. When
they're unset in development, it uses the running `kindgi dev` (the nearest
`.kindgirc.json` above the folder it runs in) and logs a warning to put them
in your env file, as the first lines show. In production (`KINDGI_ENV` or `NODE_ENV` set to
`production`) it never reads `.kindgirc.json`. `Kindgi.builder()` sets the
URL, the token, the timeout or your own `HttpClient`.

## 3. Find your way around

**The methods follow the API's operations.** The operation
`approvals.reviewers.list` is `client.approvals().reviewers().list()`; the
[HTTP API reference](../../reference/api/) lists them all. A method takes
the path's ids first, then the request body, then the query parameters as
one record with a builder:

```java
// in src/main/java/com/acme/Lists.java
RunCollectionPage page = client.runs().list(RunsListParams.builder().limit(20L).build());
```

**Every list has a lazy stream of all its pages:** `client.runs().listAll()`
fetches the next page as you read on.

**Errors are typed.** A refused call throws a `KindgiApiException`:
`NotFoundException`, `ConflictException`, `InvalidRequestException`,
`AuthException`, `RateLimitedException` and so on, with the server's own
code in `serverCode()`:

```java
// in src/main/java/com/acme/Lookup.java
try {
  client.runs().get(runId);
} catch (NotFoundException e) {
  System.out.println(e.serverCode());   // run-not-found
}
```

A call that's safe to repeat (a read, or a call that takes an idempotency
key, such as starting a run: the client adds one for you) is retried, with
backoff, after a dropped connection, a timeout, or a 429, 502, 503 or 504
answer.

**Async:** `client.async()` has the same methods, answering
`CompletableFuture`s.

## 4. What the models do for you

The answers are records, a union is a sealed interface you can switch on,
and every request body has a builder that checks it against the API's
rules before it's sent (a `ValidationException` lists what's wrong).

A newer Kindgi runtime may answer with an enum value or a kind of object
this client doesn't know yet. The Java client keeps it (`status().value()`
is `UNRECOGNIZED`), where the Python client refuses the whole answer.

More detail is in the client's
[README](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java#readme):
streams, updates that clear a property, your app's Jackson.
