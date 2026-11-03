---
title: "Quickstart: Java"
description: Create a Java pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 4.5
  label: "Quickstart: Java"
  badge: { text: 'Preview', variant: 'caution', class: 'kg-preview' }
---

The same pack as the [TypeScript quickstart](../quickstart-typescript/), in
Java: two tools, an agent that calls them, a guardrail and a flow. Its tools
are records and lambdas, built with Maven.

:::caution[Preview]
**Preview.** Java and Scala support is tested and supported, but its API may
still change in a later release without the usual deprecation period.
:::

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Node 22.12 or later, and access to the runtime image: sign in at
[access.kindgi.com](https://access.kindgi.com) with GitHub or your email
address for a license key, then log in once with `kindgi auth registry`.
You also need a JDK 17 or later, with `JAVA_HOME` set to it. Maven comes
with the pack.

## 1. Create the pack

```sh tutorial=run
npx --yes @kindgi/cli@0.2 init my-pack --template=java
cd my-pack
./mvnw -q test    # the template's tests: the tools, called directly
```

- `npx --yes @kindgi/cli@0.2` runs the newest 0.2 release of the Kindgi CLI,
  the line these docs describe, without installing it
  ([Check this machine](../install/#check-this-machine) says how). `@0.2` is
  optional: `npx --yes @kindgi/cli init my-pack --template=java` runs the
  newest release, which may be on a later line than these docs.
- `init my-pack` makes the pack in a new folder, `my-pack`.
- `--template=java` makes it a Java pack, with examples.
- `./mvnw -q test` runs the template's tests with the pack's own Maven, quietly (`-q`).

`init` prints what it made. `./mvnw -q test` prints nothing when the tests
pass:

```text
…
✓ Java pack scaffolded at …/my-pack/ (preview)
…
```

Without Node, run `init` from PyPI instead:
`uvx --from "kindgi-cli>=0.2,<0.3" kindgi init my-pack --template=java`.

The pack is a Maven project. Its config is `kindgi.config.json`; its tools,
guardrails, agents and flows are classes in four packages:

```
my-pack/
├── kindgi.config.json                      # "language": "java", the pack's id and version
├── pom.xml                                 # com.kindgi:kindgi-pack, Java 17
├── mvnw, .mvn/                             # the Maven wrapper
├── kindgiw, kindgiw.cmd                    # the Kindgi CLI wrapper (the version kindgi.config.json pins)
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

The pack pins the Kindgi CLI it runs with, `"cli"` in `kindgi.config.json`,
as Maven's wrapper pins Maven. Run the CLI as `./kindgiw` (`kindgiw.cmd` on
Windows): it uses Node's `npx` when Node is installed, else `uvx` (no Node
needed). `kindgi upgrade` moves the pin.

:::tip[Skills for your coding agent]
The pack comes with Kindgi's skills in `.claude/skills/` and
`.agents/skills/`: how to write tools, guardrails, agents and flows in Java,
connect a model, and report a problem in Kindgi. Claude Code loads the one
your request needs; [Coding agents](../coding-agents/) says where other
agents look. `./kindgiw skills sync` refreshes them.
:::

## 2. Run it

```sh tutorial=background ready="Kindgi is up"
./kindgiw dev
```

`kindgi dev` checks the JDK (`JAVA_HOME`'s) and Maven (the pack's
`mvnw`), and starts the Kindgi runtime in Docker. Maven compiles the pack,
the Java indexer reads it, and its tools and checks run in a pack service.
It recompiles on every save. It writes the API's URL and a token to
`.kindgirc.json`, so the next commands find the runtime by themselves.
Leave it running.

When the pack is loaded and the runtime is up, it says so:

```text
…
  ✓ loaded: 2 tools, 1 guardrails, 1 agents, 1 flows
…
    ✓ Kindgi is up
…
```

## 3. Run the agent and the flow

In a second terminal, in `my-pack`:

```sh tutorial=run
./kindgiw runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
./kindgiw runs start --flow=my-pack.echo-flow --input='{"message":"Ada"}'
```

- `--agent=my-pack.echo-agent` and `--flow=my-pack.echo-flow` name what to
  run, by its id.
- `--input` is the run's input, as JSON. An agent takes the person's message
  as `userMessage`.

```text tutorial=expect
  "status": "completed",
…
⚠ dev-echo answered, and it isn't a real model: it only repeats what it's given. …
…
    "echo": "Ada",
```

Without a model, the agent's answer comes from `dev-echo`, a stand-in. It
calls the agent's first tool with `{"message": <your userMessage>}`, and
replies with what the tool returned, after a first line that says it isn't a
real model. The flow runs the `echo` tool on its input and returns what the tool
returned. Either way, your Java tool ran: the runtime called it over HTTP in
the pack service.

:::caution[dev-echo checks the wiring, nothing more]
It can't fill in any other tool input, and it can't produce a typed answer
(an agent with an `output` fails with `output-schema-violation`).
Connect a model ([step 5](#5-connect-a-real-model)) before you write an agent
of your own.
:::

## 4. Look at the code

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

```java excerpt
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

## 5. Connect a real model

Store your AI model provider's API key as a secret, then register the
provider:

```sh
./kindgiw secrets set <KEY_NAME> --env=local --scope=tenant
./kindgiw providers register --preset=<preset>
```

`<KEY_NAME>` and `<preset>` depend on the provider:

| Provider | `<KEY_NAME>` | `<preset>` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Gemini (a Google AI Studio key) | `GEMINI_API_KEY` | `gemini-api` |
| Groq | `GROQ_API_KEY` | `groq` |
| OpenRouter (a hosted gateway) | `OPENROUTER_API_KEY` | `openrouter` |

- `secrets set <KEY_NAME>` asks for the key without showing it, and
  writes it to Kindgi's own `.kindgi/secrets.env`.
- `--env=local` is the environment the secret belongs to. Under
  `kindgi dev`, `local` is the pack's env files, that one among them.
- `--scope=tenant` is where the secret lives: the workspace, rather than one
  org (`org:<orgId>`) or project (`project:<projectId>`).
- `--preset=<preset>` registers the provider's models from Kindgi's built-in
  preset, which reads the `<KEY_NAME>` secret. `kindgi providers presets`
  lists every preset, Gemini on Vertex AI too.

With Anthropic's key, for example, the two commands print:

```text
…
  Set ANTHROPIC_API_KEY at tenant in local.
…
✓ Registered anthropic: claude-opus-5-5, claude-sonnet-5-5 (default), claude-haiku-5-5, claude-haiku-4-5 — key ANTHROPIC_API_KEY (env local)
```

The provider takes over from `dev-echo` at the next turn. Any
OpenAI-compatible endpoint registers from a short spec file.

The registration is in this project's dev database. To have `kindgi dev`
register the model on every boot, in each worktree and after `--reset`,
declare it in `kindgi.config.json` (`"providers": [{"preset": "<preset>"}]`):
[Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Next

- [Add Kindgi to an existing Java app](../existing-app-java/):
  your app's own classes as tools.
- [Call Kindgi from a Java app](../java-app/): start runs and follow them
  with the Java client.
- [Guides](../../guides/): one task at a time.
- [Concepts](../../concepts/): packs, runs and the journal, security.
- [kindgi-pack's README](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java/kindgi-pack):
  schemas from records, guardrails, flows, the call context and cancellation.
