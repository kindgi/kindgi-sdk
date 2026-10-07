---
title: "Quickstart: Java"
description: Create a Java pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 4.5
  label: "Quickstart: Java"
---

The same pack as the [TypeScript quickstart](../quickstart-typescript/), in
Java: two tools, an agent that calls them, a guardrail and a flow. Its tools
are records and lambdas, built with Maven.

:::caution[Preview: built from source]
The Java SDK for packs, `com.kindgi:kindgi-pack`, isn't on Maven Central yet.
Until it is, you build it from the Kindgi SDK repository (step 1), and
`kindgi build` can't make a Java pack's image (its Maven fetches
kindgi-pack from Maven Central).
:::

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Node 22.12 or later, and access to the runtime image. The image is
in private preview: request access at contact@kindgi.com, then log in once
with `kindgi auth registry`. You also need a JDK 17 or later, with
`JAVA_HOME` set to it. Maven comes with the pack.

## 1. Get kindgi-pack

Build the Java SDK, and install it into your local Maven repository:

```sh
git clone https://github.com/kindgi/kindgi-sdk.git
cd kindgi-sdk/sdks/java
./mvnw -q install -DskipTests
cd ../../..
```

## 2. Create the pack

```sh tutorial=run
npx --yes @kindgi/cli@0.1 init my-pack --template=java
cd my-pack
./mvnw -q test    # the template's tests: the tools, called directly
```

The pack is a Maven project. Its config is `kindgi.config.json`; its tools,
guardrails, agents and flows are classes in four packages:

```
my-pack/
├── kindgi.config.json                      # "language": "java", the pack's id and version
├── pom.xml                                 # com.kindgi:kindgi-pack, Java 17
├── mvnw, .mvn/                             # the Maven wrapper
├── src/main/java/mypack/
│   ├── tools/Echo.java, tools/Greet.java   # Tool.define(...)
│   ├── guardrails/ResponseNotEmpty.java    # Guardrail.define(...)
│   ├── agents/EchoAgent.java               # Agent.define(...)
│   └── flows/EchoFlow.java                 # Flow.define(...)
└── src/test/java/mypack/ToolsTest.java
```

The package comes from the pack's id (`my-pack` → `mypack`). A tool, a
guardrail, an agent or a flow is a `public static final` field of a class
in its package.

A Java project doesn't pin the Kindgi CLI the way a TypeScript project's
`package.json` does: run it as `npx --yes @kindgi/cli@0.1`, the minor
version this page is for, as below.

:::note[No skills for coding agents yet]
A TypeScript or Python pack gets Kindgi's skills in `.claude/skills/`,
which teach a coding agent how to write tools and agents. Java has none
yet: point your agent at the pack's `README.md` and `AGENTS.md` and at
[kindgi-pack's README](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java/kindgi-pack).
:::

## 3. Run it

```sh tutorial=background ready="Kindgi is up"
npx --yes @kindgi/cli@0.1 dev
```

`kindgi dev` checks the JDK (`JAVA_HOME`'s) and Maven (the pack's
`mvnw`), and starts the Kindgi runtime in Docker. Maven compiles the pack,
the Java indexer reads it, and its tools and checks run in a pack service.
It recompiles on every save. It writes the API's URL and a token to
`.kindgirc.json`, so the commands below find the runtime by themselves.
Leave it running.

## 4. Run the agent and the flow

In a second terminal, in `my-pack`:

```sh tutorial=run
npx --yes @kindgi/cli@0.1 runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
npx --yes @kindgi/cli@0.1 runs start --flow=my-pack.echo-flow --input='{"message":"Ada"}'
```

```text tutorial=expect
  "status": "completed",
…
⚠ dev-echo answered, and it isn't a real model: it only repeats what it's given. …
…
    "echo": "Ada",
```

Without a model, the agent's answer comes from `dev-echo`, a stand-in that
calls the agent's first tool with `{"message": <your userMessage>}` and
replies with what it returned, after a first line that says it isn't a real
model. The flow runs the `echo` tool on its input and returns what the tool
returned. Either way, your Java tool ran: the runtime called it over HTTP in
the pack service.

:::caution[dev-echo checks the wiring, nothing more]
It can't fill in any other tool input, and it can't produce a typed answer
(an agent with an `output` fails with `output-schema-violation`).
Connect a model ([step 6](#6-connect-a-real-model)) before you write an agent
of your own.
:::

## 5. Look at the code

A tool is a field: its input and output are records, and their schemas come
from the records (a Jakarta Validation constraint becomes its schema
keyword). The pack service checks both on every call:

```java
// src/main/java/mypack/tools/Echo.java
package mypack.tools;

import com.kindgi.pack.Tool;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.time.Instant;

/** my-pack.echo — echoes the message back with a UTC timestamp and its length. */
public final class Echo {
  public record Input(@Size(min = 1, max = 500) String message) {}

  public record Output(String echo, Instant echoedAt, @PositiveOrZero int characterCount) {}

  public static final Tool<Input, Output> TOOL = Tool.define("my-pack.echo")
      .description("Echoes the caller-provided message with a UTC timestamp and character count.")
      .input(Input.class)
      .output(Output.class)
      .mutating(false)
      .handler((input, ctx) -> new Output(input.message(), Instant.now(), input.message().length()));

  private Echo() {}
}
```

`mutating(false)` says the tool only reads. A dry run may call it, and approval
gates skip it. Left unset, a tool counts as one that writes.

An agent is data, and it refers to the tools and the guardrail themselves:

```java
// in src/main/java/mypack/agents/EchoAgent.java
public static final Agent AGENT = Agent.define("my-pack.echo-agent")
    .version("0.1.0")
    .name("Echo Agent")
    .instructions("For each user message: if the user sends a name, greet them with the greet tool. "
        + "Otherwise echo their message with the echo tool. Quote the tool result verbatim.")
    .capability(Map.of("needs", List.of(Map.of("feature", "tool-use"))))
    .tool(Echo.TOOL)
    .tool(Greet.TOOL)
    .guardrail(ResponseNotEmpty.GUARDRAIL)
    .build();
```

Save a file with a mistake in it, and `kindgi dev` says where, keeping the
last good code running:

```text
✗ refresh failed [bundle-failed] The pack's code did not build:
  src/main/java/mypack/tools/Greet.java:20:36: cannot find symbol
```

Fix it, and the pack reloads:

```text
✓ loaded 5 primitives (2 tools, 1 guardrails, 1 agents, 1 flows) in 640ms
```

## 6. Connect a real model

Store an Anthropic key as a secret (you're prompted for it; it isn't
echoed), then register the provider:

```sh
npx --yes @kindgi/cli@0.1 secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
npx --yes @kindgi/cli@0.1 providers register --preset=anthropic
```

It takes over from `dev-echo` at the next turn. OpenAI (`OPENAI_API_KEY`,
`--preset=openai`), Gemini (`GEMINI_API_KEY`, `--preset=gemini-api`), Groq
(`GROQ_API_KEY`, `--preset=groq`) and OpenRouter (`OPENROUTER_API_KEY`,
`--preset=openrouter`) work the same way; `kindgi providers presets` lists
them, Gemini on Vertex AI too. Any OpenAI-compatible endpoint registers from
a short spec file.

The registration is in this project's dev database. To have `kindgi dev`
register the model on every boot, in each worktree and after `--reset`,
declare it in `kindgi.config.json` (`"providers": [{"preset": "anthropic"}]`):
[Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Next

- [Add Kindgi to an existing Java app](../existing-app/#a-java-app-maven):
  your app's own classes as tools.
- [Call Kindgi from a Java app](../java-app/): start runs and follow them
  with the Java client.
- [Guides](../../guides/): one task at a time.
- [Concepts](../../concepts/): packs, runs and the journal, security.
- [kindgi-pack's README](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java/kindgi-pack):
  schemas from records, guardrails, flows, the call context and cancellation.
