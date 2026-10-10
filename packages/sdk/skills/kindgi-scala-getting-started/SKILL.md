---
name: kindgi-scala-getting-started
description: >
  Getting a Scala Kindgi pack running: what a pack is, scaffolding one
  (`kindgi init <name> --template=scala`) or adding Kindgi to an existing
  sbt app (`kindgi.config.json`, discovery under `kindgi` packages),
  `./kindgiw dev` through sbt's server, the first agent run, connecting a
  real model, flows, calling the Kindgi API from Scala, building an image,
  and the Scala layer's known limits. Load this when an sbt project has no
  `kindgi.config.json` yet and the user asks to "add Kindgi", "make an
  agent", "set up a pack", or when you are orienting in a Scala pack
  (`kindgi.config.json` with `"language": "scala"`) for the first time.
  Authoring tools, guardrails, agents and flows is covered by
  kindgi-scala-authoring-tools, kindgi-scala-authoring-guardrails,
  kindgi-scala-authoring-agents and kindgi-scala-authoring-flows; models by
  kindgi-authoring-providers.
type: core
library: "kindgi-pack-scala"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [scala]
sources:
  - sdks/scala/README.md
  - site/src/content/docs/start/quickstart-scala.md
---

# Getting started with Kindgi in Scala

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), and `./kindgiw` runs that version (`kindgiw.cmd` on
> Windows): through Node's `npx` when Node is installed, else `uvx`. So every
> `kindgi <command>` below runs as `./kindgiw <command>`. `./kindgiw upgrade`
> moves the pin, and kindgi-pack-scala's version in `build.sbt` with it.
>
> **Preview:** Java and Scala support is tested and supported, but its API
> may still change in 0.1.6 without the usual deprecation period.

## What a pack is

A **pack** is a project Kindgi indexes and runs. Its config is
`kindgi.config.json` (`"language": "scala"`). Its primitives are the `val`s
of an object named like its file (`Greet.scala` holds `object Greet`), in
four kinds of packages:

- **Tools** (`…/tools/…`, `Tool[Input, Output](id)`): your Scala code an
  agent or flow calls.
- **Guardrails** (`…/guardrails/…`, `Guardrail[Config](id)`): checks over an
  agent's turn.
- **Agents** (`…/agents/…`, `Agent(id)`): data. Instructions, tools,
  capabilities. The model runs in Kindgi.
- **Flows** (`…/flows/…`, `Flow(id)`): data. Steps (tool or agent nodes) and
  the edges between them.

The Scala layer (`com.kindgi %% kindgi-pack-scala`, package
`com.kindgi.pack.scaladsl`) is thin, over the Java SDK: kindgi-pack's
indexer reads the pack, and its pack service runs the tools and checks in
the pack's own JVM, called over HTTP. Everything else runs in the Kindgi
runtime. It's built for Scala 2.13 and 3.3. In those packages:
- An object with no primitives, or a file with no object (a case class, a
  trait), is a helper.
- A primitive defined as a `def` or a `lazy val` is an error: make it a
  `val`.
- Tests (`src/test/`) are never primitives.

## Scaffold a new pack

You need a JDK 17 or later (`JAVA_HOME`) and sbt.

```sh
npx --yes @kindgi/cli@0.1 init my-pack --template=scala   # or: uvx --from "kindgi-cli>=0.1,<0.2" kindgi init …
cd my-pack
sbt test           # the template's tests: the tools, called directly
./kindgiw dev      # boots Kindgi locally and runs this pack, recompiling on save
```

`kindgi dev` needs Docker and Postgres. It starts Postgres in Docker unless
`KINDGI_DATABASE_URL` points at yours. It compiles through sbt's server
(`sbt --client`), so a save compiles in about a second once it's warm.
- When no sbt server is running, it starts one, and stops it when it stops.
- A server you already run (your IDE's) is used and left running.
- A compile error is reported as `file:line:col`, and the last good code
  keeps serving.
- It uses `JAVA_HOME`'s JDK (or `dev.javaHome` in `kindgi.config.json`) and
  the `sbt` on your `PATH` (or `dev.sbt`, such as `["sbt", "-mem", "2048"]`).
- `SBT_OPTS` reaches sbt, never the pack.

## Add Kindgi to an existing sbt app

In the app's directory (where its `build.sbt` is):

```sh
npx --yes @kindgi/cli@0.1 init   # --pack-id=<id> if the build's name doesn't make one
./kindgiw dev
```

`init` writes `kindgi.config.json`:
- the pack id, from the build's `name`, and its version;
- the CLI version it pins (`"cli"`, which `./kindgiw` runs, also written);
- discovery under `kindgi` packages (`src/main/scala/**/kindgi/tools/**/*.scala`
  and so on), so the app's own `tools` packages are never taken for
  Kindgi's.

It leaves `build.sbt` alone, and prints the dependency to add (from Maven
Central, at the CLI's version):

```scala
libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "…"
```

It also adds these skills and `.gitignore` entries. An app with a
`build.sbt` next to a `package.json` or a `pom.xml` gets a TypeScript or Java
pack unless you pass `--template=scala`.

A tool there is a `val` of an object in a `kindgi.tools` package under the
app's own (`com.acme.app.kindgi.tools`), and calls the app's code directly. A
library a tool uses must be on the runtime classpath (not `% Test` or
`% Provided`): the image ships the runtime classpath only. `kindgi dev` reads
the app's `.env` and `.env.local`: values already there reach the tools as
environment variables. A model provider's key, and a secret stored with
`kindgi secrets set`, don't: a tool reads a secret from its context
(`needsSpec.secrets`).

## Layout of the template

```
my-pack/
├── kindgi.config.json                       # "language": "scala", the pack's id and version, the CLI it pins
├── build.sbt                                # kindgi-pack-scala, Scala 3.3, Java 17
├── project/build.properties                 # the sbt version
├── kindgiw, kindgiw.cmd                     # the Kindgi CLI wrapper
├── src/main/scala/mypack/
│   ├── tools/Echo.scala, tools/Greet.scala  # Tool[Input, Output](...)
│   ├── guardrails/ResponseNotEmpty.scala    # Guardrail[Config](...)
│   ├── agents/EchoAgent.scala               # Agent(...)
│   └── flows/EchoFlow.scala                 # Flow(...)
├── src/test/scala/mypack/ToolsSuite.scala   # the tools, called directly (munit)
└── .claude/skills/                          # these skills (`./kindgiw skills sync` refreshes them)
```

The package comes from the pack's id, with Java's and Scala's keywords
escaped (`my-pack` becomes `mypack`). `kindgi.config.json` also takes
`discovery`, `dev`, `env`, `environments`, `image` and `providers`.

## First run

With `kindgi dev` running, from another terminal in the pack directory:

```sh
./kindgiw runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
./kindgiw runs start --flow=my-pack.echo-flow --input='{"message":"Ada"}'
```

The agent's answer comes from `dev-echo`, a **fallback** provider a new pack
gets: no model, no key. It calls the agent's first tool with
`{"message": <userMessage>}` and replies "⚠ dev-echo isn't a real model: …",
then "Tool responded: …". The turn carries the `fallback-provider` and
`dev-echo-not-a-model` warnings. It can't fill in any other tool's input,
and it can't give a typed answer. For a real model, store an LLM provider's
key and register its preset (Anthropic below; `./kindgiw providers presets`
lists OpenAI, Gemini, Groq and OpenRouter too):

```sh
./kindgiw secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # no-echo prompt; writes .kindgi/secrets.env
./kindgiw providers register --preset=anthropic
```

It takes over at the next turn. That registration is in this project's dev
database only. To have `kindgi dev` register it on every boot, in every
worktree and after `--reset`, declare it in `kindgi.config.json`:
`"providers": [{"preset": "anthropic"}]` (its key, `ANTHROPIC_API_KEY`, comes
from the env files). Details and other providers: `kindgi-authoring-providers`.

To see what Kindgi sees (the index), with no runtime:

```sh
java -cp "$(sbt -batch -error 'export Runtime/fullClasspath')" com.kindgi.pack.Main index --pack-dir .
```

## Flows

A flow is data: nodes and edges (`flow.schema.json`). A node's ref may be
the `Tool` itself:

```scala
val flow: Flow = Flow("acme.ledger.record-flow")
  .version("0.1.0")
  .toolNode("record", RecordExpense.tool)
  .edge("e-start", "$start", "record")
  .edge("e-end", "record", "$end")
  .build()
```

A node gets the output of its single upstream node (the run input after
`$start`), or what its `inputMapping` says. Run one with
`./kindgiw runs start --flow=<id> --input='{…}'`. For branches, loops and
agent steps, see `kindgi-scala-authoring-flows`.

## Calling Kindgi from Scala

The Java client, `com.kindgi:kindgi-client` (on Maven Central, at the same
version as the CLI), covers the whole API, with typed models and errors,
and works from Scala as it is:

```scala
import com.kindgi.client.Kindgi
import com.kindgi.client.models.StartRunBody
import scala.jdk.CollectionConverters._

val client = Kindgi.create()   // KINDGI_API_URL + KINDGI_API_TOKEN; in dev, the running kindgi dev
val run = client.runs().start(StartRunBody.WithAgent.builder()
  .agent("my-pack.echo-agent")
  .input(Map[String, AnyRef]("userMessage" -> "Ada").asJava)
  .build())
val events = client.runs().follow(run.id())
try events.asScala.foreach(event => println(event.kind()))
finally events.close()
```

The methods follow the API's operations: `approvals.reviewers.list` is
`client.approvals().reviewers().list()`. `client.async()` has the same ones,
answering `CompletableFuture`s (`scala.jdk.FutureConverters` turns them into
`Future`s). A refused call throws a typed `KindgiApiException`. The client
shades its own Jackson, so the app's Jackson is left alone. In production it
never reads `.kindgirc.json`: set `KINDGI_API_URL` and `KINDGI_API_TOKEN`.

## Your app and Kindgi's data

When the app keeps something a run did (a ticket a flow triaged, an answer
an agent gave), its own row stores the run's id, in a column such as
`kindgi_run_id`. The app reads the rest through the API, server side:

- **Status, output, timing:** `client.runs().get(runId)`.
- **The audit, step by step:** `client.runs().journal(runId)`.
- **What it cost:** `client.cost().records().list(…)`, filtered by the run.
- **When a run finished:** the `run.finished` webhook, not polling.

Show it in the app's own UI. **Never:**

- **query Kindgi's database**, even on the app's own Postgres server, or map
  its tables in Slick, Doobie or Quill. Its schema is private and changes
  with every release, row-level security guards every tenant query, and a
  runtime Kindgi hosts gives no database access.
- **link users to Kindgi's console**, or any Kindgi UI, for this data.

Docs: https://docs.kindgi.com/v0.1/guides/runs/show-runs-in-your-app/

## Build an image

`./kindgiw build --env=<name>` builds the pack's image for an
`environments.<name>` block of `kindgi.config.json`; `--local` builds it with
this machine's Docker. sbt builds it in a pinned sbt + JDK 17 image, fetching
kindgi-pack-scala and kindgi-pack from Maven Central, and copies the runtime
classpath as jars. The index is built in the image, and the pack service
runs on a JRE 17 as its entrypoint, as user 65532.

Debian packages the code needs are declared in `kindgi.config.json`, and the
image installs them: `"image": {"systemPackages": ["tesseract-ocr"]}`
(names, or `name=version`). So are the variables the code reads, names only:
`"env": {"required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"]}`. A
deployed pack service missing a required one isn't ready, and its `/readyz`
names it.

## Known limits

- **Scala's primitives inside a type parameter** (`Seq[Int]`,
  `Option[Long]`) are `Object` on the JVM, so the schema allows any JSON
  value there. Use a case class (`Seq[Item]`), or give the schema with
  `Tool.json`.
- **In Scala 3, name a Java annotation's arguments:** `@Min(value = 0)`, not
  `@Min(0)`.
- **A Scala 3 enum whose cases take parameters** is a sealed hierarchy, not
  a string: describe it with `@JsonTypeInfo` and `@JsonSubTypes`. A simple
  enum is a string of its case names.
- **jackson-module-scala must match your app's `jackson-databind` minor
  version.** If your app uses a newer Jackson, depend on the matching
  `jackson-module-scala` yourself.

## Two things need the human

- **The pack id and version** in `kindgi.config.json`. The id prefixes every
  primitive (`<pack-id>.<name>`): pick it once.
- **Model credentials.** Ask for the key; never invent or hard-code one.

## Next

- A tool: `kindgi-scala-authoring-tools`.
- A guardrail: `kindgi-scala-authoring-guardrails`.
- An agent: `kindgi-scala-authoring-agents`.
- A flow: `kindgi-scala-authoring-flows`.
- A real model: `kindgi-authoring-providers`.
- An external resource (a database) for the coding agent:
  `kindgi-authoring-mcp-servers`.

## Keeping skills up to date

`./kindgiw skills sync` refreshes `.claude/skills/` from the CLI's copy
(local edits are kept unless `--force`). `kindgi dev` says when they are out
of date.

## When the framework itself is the problem

If the bug is in Kindgi, kindgi-pack or the Scala layer and not in the
pack's code, load `kindgi-framework-feedback` and file it with
`./kindgiw feedback write`.
