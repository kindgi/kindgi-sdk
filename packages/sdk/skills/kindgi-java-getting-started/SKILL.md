---
name: kindgi-java-getting-started
description: >
  Getting a Java Kindgi pack running: what a pack is, scaffolding one
  (`kindgi init <name> --template=java`) or adding Kindgi to an existing
  Maven app (`kindgi.config.json`, discovery under `kindgi` packages),
  `./kindgiw dev`, the first agent run, connecting a real model, flows,
  calling the Kindgi API from Java (`com.kindgi:kindgi-client`), and
  building an image. Load this when a Maven project has no
  `kindgi.config.json` yet and the user asks to "add Kindgi", "make an
  agent", "set up a pack", or when you are orienting in a Java pack
  (`kindgi.config.json` with `"language": "java"`) for the first time.
  Authoring tools, guardrails, agents and flows is covered by
  kindgi-java-authoring-tools, kindgi-java-authoring-guardrails,
  kindgi-java-authoring-agents and kindgi-java-authoring-flows; models by
  kindgi-authoring-providers.
type: core
library: "kindgi-pack (Java)"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [java]
sources:
  - sdks/java/kindgi-pack/README.md
  - sdks/java/README.md
  - site/src/content/docs/start/quickstart-java.md
---

# Getting started with Kindgi in Java

> **Running `kindgi`:** the pack pins its CLI (`"cli"` in
> `kindgi.config.json`), as Maven's wrapper pins Maven. `./kindgiw` runs that
> version (`kindgiw.cmd` on Windows): through Node's `npx` when Node is
> installed, else `uvx`. So every `kindgi <command>` below runs as
> `./kindgiw <command>`, and `./kindgiw upgrade` moves the pin.
>
> **Preview:** Java and Scala support is tested and supported, but its API
> may still change in 0.1.6 without the usual deprecation period.

## What a pack is

A **pack** is a project Kindgi indexes and runs. Its config is
`kindgi.config.json` (`"language": "java"`). Its primitives are
`public static final` fields of classes in four kinds of packages:

- **Tools** (`…/tools/…`, `Tool.define`): your Java code an agent or flow
  calls.
- **Guardrails** (`…/guardrails/…`, `Guardrail.define`): checks over an
  agent's turn.
- **Agents** (`…/agents/…`, `Agent.define`): data. Instructions, tools,
  capabilities. The model runs in Kindgi.
- **Flows** (`…/flows/…`, `Flow.define`): data. Steps (tool or agent nodes)
  and the edges between them.

Kindgi runs the tools and checks in the pack's own JVM (the pack service,
`com.kindgi:kindgi-pack`) and calls them over HTTP. Everything else runs in
the Kindgi runtime. In those packages, a helper is a package-private class,
a record, an enum or an interface. A public class that defines nothing is
an error, so a forgotten `static` can't drop a tool silently. Tests
(`*Test.java`, `*IT.java`, `src/test/`) are never primitives.

## Scaffold a new pack

You need a JDK 17 or later (`JAVA_HOME`). Maven comes with the pack
(`./mvnw`).

```sh
npx --yes @kindgi/cli@0.1 init my-pack --template=java   # or: uvx --from "kindgi-cli>=0.1,<0.2" kindgi init …
cd my-pack
./mvnw test        # the template's tests: the tools, called directly
./kindgiw dev      # boots Kindgi locally and runs this pack, recompiling on save
```

`kindgi dev` needs Docker and Postgres. It starts Postgres in Docker unless
`KINDGI_DATABASE_URL` points at yours. It checks the JDK (`JAVA_HOME`'s, or
`dev.javaHome` in `kindgi.config.json`) and Maven (the pack's `mvnw`, or
`dev.maven`, such as `["mvn", "-s", "settings.xml"]`). Maven compiles the
pack, the Java indexer reads it, and a save recompiles. A compile error is
reported as `file:line:col`, and the last good code keeps serving.
`MAVEN_ARGS` and `MAVEN_OPTS` reach Maven, never the pack.

## Add Kindgi to an existing Maven app

In the app's directory (where its `pom.xml` is):

```sh
npx --yes @kindgi/cli@0.1 init   # --pack-id=<id> if the app's artifactId doesn't make one
./kindgiw dev
```

`init` writes `kindgi.config.json`:
- the pack id, from the app's `artifactId`, and its version;
- the CLI version it pins (`"cli"`, which `./kindgiw` runs, also written);
- discovery under `kindgi` packages (`src/main/java/**/kindgi/tools/**/*.java`
  and so on), so the app's own `tools` packages are never taken for
  Kindgi's.

It leaves `pom.xml` alone, and prints the `com.kindgi:kindgi-pack`
dependency to add (from Maven Central, at the CLI's version). It also adds
these skills and `.gitignore` entries. An app with both a `package.json` and
a `pom.xml` gets a TypeScript pack unless you pass `--template=java`.

A tool there is a class in a `kindgi.tools` package under the app's own
(`com.acme.app.kindgi.tools`), and calls the app's code directly. A class a
tool uses must be on the runtime classpath (`compile` or `runtime` scope,
not `test` or `provided`): the image copies the runtime dependencies only.
`kindgi dev` reads the app's `.env` and `.env.local`: keys already there
reach the tools as environment variables.

## Layout of the template

```
my-pack/
├── kindgi.config.json                       # "language": "java", the pack's id and version, the CLI it pins
├── pom.xml                                  # com.kindgi:kindgi-pack, Java 17
├── mvnw, .mvn/                              # the Maven wrapper
├── kindgiw, kindgiw.cmd                     # the Kindgi CLI wrapper
├── src/main/java/mypack/
│   ├── tools/Echo.java, tools/Greet.java    # Tool.define(...)
│   ├── guardrails/ResponseNotEmpty.java     # Guardrail.define(...)
│   ├── agents/EchoAgent.java                # Agent.define(...)
│   └── flows/EchoFlow.java                  # Flow.define(...)
├── src/test/java/mypack/ToolsTest.java      # the tools, called directly
└── .claude/skills/                          # these skills (`./kindgiw skills sync` refreshes them)
```

The package comes from the pack's id (`my-pack` becomes `mypack`).
`kindgi.config.json` also takes `discovery`, `dev`, `env`, `environments`,
`image` and `providers`.

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
./kindgiw secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # no-echo prompt; writes .env.local
./kindgiw providers register --preset=anthropic
```

It takes over at the next turn. That registration is in this project's dev
database only. To have `kindgi dev` register it on every boot, in every
worktree and after `--reset`, declare it in `kindgi.config.json`:
`"providers": [{"preset": "anthropic"}]` (its key, `ANTHROPIC_API_KEY`, comes
from the env files). Details and other providers: `kindgi-authoring-providers`.

To see what Kindgi sees (the index), with no runtime:

```sh
./mvnw -q compile dependency:build-classpath -Dmdep.outputFile=target/classpath.txt
java -cp "target/classes:$(cat target/classpath.txt)" com.kindgi.pack.Main index --pack-dir .
```

## Flows

A flow is data: nodes and edges (`flow.schema.json`). A node's ref may be
the `Tool` itself:

```java
public static final Flow FLOW = Flow.define("acme.ledger.record-flow")
    .version("0.1.0")
    .toolNode("record", RecordExpense.TOOL)
    .edge("e-start", "$start", "record")
    .edge("e-end", "record", "$end")
    .build();
```

A node gets the output of its single upstream node (the run input after
`$start`), or what its `inputMapping` says. Run one with
`./kindgiw runs start --flow=<id> --input='{…}'`. For branches, loops and
agent steps, see `kindgi-java-authoring-flows`.

## Calling Kindgi from Java

`com.kindgi:kindgi-client` (on Maven Central, at the same version as the
CLI) covers the whole API, with typed models and errors:

```java
Kindgi client = Kindgi.create();   // KINDGI_API_URL + KINDGI_API_TOKEN; in dev, the running kindgi dev
Run run = client.runs().start(StartRunBody.WithAgent.builder()
    .agent("my-pack.echo-agent")
    .input(Map.of("userMessage", "Ada"))
    .build());
try (EventStream<RunEvent> events = client.runs().follow(run.id())) {
  for (RunEvent event : events) System.out.println(event.kind());
}
```

The methods follow the API's operations: `approvals.reviewers.list` is
`client.approvals().reviewers().list()`. `client.async()` has the same ones,
answering `CompletableFuture`s. A refused call throws a typed
`KindgiApiException` (`NotFoundException`, …). The client shades its own
Jackson, so the app's Jackson is left alone. In production it never reads
`.kindgirc.json`: set `KINDGI_API_URL` and `KINDGI_API_TOKEN`.

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
  its tables in JPA. Its schema is private and changes with every release,
  row-level security guards every tenant query, and a runtime Kindgi hosts
  gives no database access.
- **link users to Kindgi's console**, or any Kindgi UI, for this data.

Docs: https://docs.kindgi.com/v0.1/guides/runs/show-runs-in-your-app/

## Build an image

`./kindgiw build --env=<name>` builds the pack's image for an
`environments.<name>` block of `kindgi.config.json`; `--local` builds it with
this machine's Docker. Maven compiles the pack in a pinned Maven + JDK 17
image, fetching kindgi-pack from Maven Central. The index is built in the
image, and the pack service runs on a JRE 17 as its entrypoint, as user
65532.

Debian packages the code needs are declared in `kindgi.config.json`, and the
image installs them: `"image": {"systemPackages": ["tesseract-ocr"]}`
(names, or `name=version`). So are the variables the code reads, names only:
`"env": {"required": ["DATABASE_URL"], "optional": ["SENTRY_DSN"]}`. A
deployed pack service missing a required one isn't ready, and its `/readyz`
names it; one the pack doesn't declare is dropped before the code loads
(`kindgi dev` keeps it).

## Two things need the human

- **The pack id and version** in `kindgi.config.json`. The id prefixes every
  primitive (`<pack-id>.<name>`): pick it once.
- **Model credentials.** Ask for the key; never invent or hard-code one.

## Next

- A tool: `kindgi-java-authoring-tools`.
- A guardrail: `kindgi-java-authoring-guardrails`.
- An agent: `kindgi-java-authoring-agents`.
- A flow: `kindgi-java-authoring-flows`.
- A real model: `kindgi-authoring-providers`.
- An external resource (a database) for the coding agent:
  `kindgi-authoring-mcp-servers`.

## Keeping skills up to date

`./kindgiw skills sync` refreshes `.claude/skills/` from the CLI's copy
(local edits are kept unless `--force`). `kindgi dev` says when they are out
of date.

## When the framework itself is the problem

If the bug is in Kindgi or kindgi-pack and not in the pack's code, load
`kindgi-framework-feedback` and file it with `./kindgiw feedback write`.
