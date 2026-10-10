---
title: "Quickstart: Scala"
description: Create a Scala pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 4.6
  label: "Quickstart: Scala"
  badge: { text: 'Preview', variant: 'caution' }
---

The same pack as the [TypeScript quickstart](../quickstart-typescript/), in
Scala: two tools, an agent that calls them, a guardrail and a flow. Its tools
are case classes and functions, built with sbt, on Scala 3 (2.13 works too).

:::caution[Preview]
**Preview.** Java and Scala support is tested and supported, but its API may
still change in 0.1.6 without the usual deprecation period.
:::

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Node 22.12 or later, and access to the runtime image. The image is
in private preview: request access at contact@kindgi.com, then log in once
with `kindgi auth registry`. You also need a JDK 17 or later, with
`JAVA_HOME` set to it, and [sbt](https://www.scala-sbt.org/download) 1.10 or
later.

## 1. Create the pack

```sh tutorial=run
npx --yes @kindgi/cli@0.1.5-rc.0 init my-pack --template=scala
cd my-pack
sbt -batch test    # the template's tests: the tools, called directly
```

Without Node, run `init` from PyPI instead:
`uvx --from "kindgi-cli==0.1.5rc0" kindgi init my-pack --template=scala`.

The pack is an sbt project. Its config is `kindgi.config.json`; its tools,
guardrails, agents and flows are objects in four packages:

```
my-pack/
├── kindgi.config.json                         # "language": "scala", the pack's id and version
├── build.sbt, project/build.properties        # kindgi-pack-scala, Scala 3.3, Java 17
├── kindgiw, kindgiw.cmd                       # the Kindgi CLI wrapper (the version kindgi.config.json pins)
├── src/main/scala/mypack/
│   ├── tools/Echo.scala, tools/Greet.scala    # Tool[Input, Output](...)
│   ├── guardrails/ResponseNotEmpty.scala      # Guardrail[Config](...)
│   ├── agents/EchoAgent.scala                 # Agent(...)
│   └── flows/EchoFlow.scala                   # Flow(...)
└── src/test/scala/mypack/ToolsSuite.scala
```

The package comes from the pack's id (`my-pack` → `mypack`). A tool, a
guardrail, an agent or a flow is a `val` of an object named like its file:
`Echo.scala` holds `object Echo`.

The pack pins the Kindgi CLI it runs with, `"cli"` in `kindgi.config.json`.
Run the CLI as `./kindgiw` (`kindgiw.cmd` on Windows): it uses Node's `npx`
when Node is installed, else `uvx` (no Node needed). `kindgi upgrade` moves
the pin, and kindgi-pack-scala's version in `build.sbt` with it.

:::tip[Skills for your coding agent]
The pack comes with Kindgi's skills in `.claude/skills/`: how to write
tools, guardrails, agents and flows in Scala, connect a model, and report a
problem in Kindgi. Claude Code loads the one your request needs
([Coding agents](../coding-agents/)). `./kindgiw skills sync` refreshes them.
:::

## 2. Run it

```sh tutorial=background ready="Kindgi is up"
./kindgiw dev
```

`kindgi dev` checks the JDK (`JAVA_HOME`'s) and sbt, and starts the Kindgi
runtime in Docker. sbt compiles the pack through its server (`sbt
--client`), kindgi-pack's indexer reads it, and its tools and checks run in
a pack service. The first build starts the server and loads the build;
after that, a save compiles in about a second. `kindgi dev` starts that
server when none is running and stops it when it stops; a server you
already run (your IDE's) is used and left running. It writes the API's URL
and a token to `.kindgirc.json`, so the commands below find the runtime by
themselves. Leave it running.

## 3. Run the agent and the flow

In a second terminal, in `my-pack`:

```sh tutorial=run
./kindgiw runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
./kindgiw runs start --flow=my-pack.echo-flow --input='{"message":"Ada"}'
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
returned. Either way, your Scala tool ran: the runtime called it over HTTP in
the pack service.

:::caution[dev-echo checks the wiring, nothing more]
It can't fill in any other tool input, and it can't produce a typed answer
(an agent with an `output` fails with `output-schema-violation`).
Connect a model ([step 5](#5-connect-a-real-model)) before you write an agent
of your own.
:::

## 4. Look at the code

A tool is a `val`: its input and output are case classes, and their schemas
come from them. `Option` is optional, a parameter's default is the schema's
default, and a Jakarta Validation constraint becomes its schema keyword. The
pack service checks both on every call:

```scala
// src/main/scala/mypack/tools/Echo.scala
package mypack.tools

import com.kindgi.pack.scaladsl._
import jakarta.validation.constraints.{PositiveOrZero, Size}
import java.time.Instant

/** my-pack.echo — echoes the message back with a UTC timestamp and its length. */
object Echo {
  final case class Input(@Size(min = 1, max = 500) message: String)
  final case class Output(echo: String, echoedAt: Instant, @PositiveOrZero characterCount: Int)

  val tool: Tool[Input, Output] = Tool[Input, Output]("my-pack.echo")
    .description("Echoes the caller-provided message with a UTC timestamp and character count.")
    .readOnly
    .handler((in, _) => Output(in.message, Instant.now(), in.message.length))
}
```

`readOnly` says the tool only reads. A dry run may call it, and approval
gates skip it. Left out, a tool counts as one that writes. A tool built on
futures uses `handlerAsync`, which takes a `Future`.

An agent is data, and it refers to the tools and the guardrail themselves:

```scala
// in src/main/scala/mypack/agents/EchoAgent.scala
val agent: Agent = Agent("my-pack.echo-agent")
  .version("0.1.0")
  .name("Echo Agent")
  .instructions(
    "For each user message: if the user sends a name, greet them with the greet tool. " +
      "Otherwise echo their message with the echo tool. Quote the tool result verbatim.")
  .capability(Map("needs" -> List(Map("feature" -> "tool-use"))))
  .tool(Echo.tool)
  .tool(Greet.tool)
  .guardrail(ResponseNotEmpty.guardrail)
  .build()
```

Save a file with a mistake in it, and `kindgi dev` says where, keeping the
last good code running:

```text
✗ refresh failed [bundle-failed] The pack's code did not build:
  src/main/scala/mypack/tools/Greet.scala:16:31: Type Mismatch Error: Found: (42 : Int); Required: String
```

Fix it, and the pack reloads:

```text
✓ loaded 5 primitives (2 tools, 1 guardrails, 1 agents, 1 flows) in 1093ms
```

### Known limits

- **Scala's primitives inside a type parameter** (`Seq[Int]`, `Option[Long]`)
  are `Object` on the JVM, so the schema allows any JSON value there. Use a
  case class (`Seq[Item]`), or give the schema yourself with `Tool.json`.
- **In Scala 3, name a Java annotation's arguments:** `@Min(value = 0)`, not
  `@Min(0)`. Scala 3 passes a positional argument to the wrong element.
- **A Scala 3 enum whose cases take parameters** is a sealed hierarchy, not a
  string: describe it with `@JsonTypeInfo` and `@JsonSubTypes`. A simple
  enum (`enum Color { case Red, Green }`) is a string of its case names.
- **jackson-module-scala must match your app's `jackson-databind` minor
  version**, and refuses another. If your app uses a newer Jackson, depend
  on the matching `jackson-module-scala` yourself.
- **A tool defined as a `def` or a `lazy val`** isn't read without running
  it: the indexer says so, and asks for a `val`.

## 5. Connect a real model

Store an Anthropic key as a secret (you're prompted for it; it isn't
echoed), then register the provider:

```sh
./kindgiw secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
./kindgiw providers register --preset=anthropic
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

- [Add Kindgi to an existing Scala app](../existing-app/#a-scala-app-sbt):
  your app's own classes as tools.
- [Guides](../../guides/): one task at a time.
- [Concepts](../../concepts/): packs, runs and the journal, security.
- [kindgi-pack-scala's README](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/scala):
  schemas from Scala's types, guardrails, flows, futures and the limits.
