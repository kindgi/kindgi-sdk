---
title: Install
description: What you need on your machine, and how a project gets the Kindgi CLI and SDK.
sidebar:
  order: 2
---

This page gets your machine ready for Kindgi, and shows how a project gets
the Kindgi CLI and SDK.

## What you need

- **For a TypeScript pack: Node 22.12 or later.** The `kindgi` CLI and the SDK
  run on Node. On an older Node, `kindgi` stops before it does anything and
  exits `1`, with this line:

  ```text
  Kindgi needs Node 22.12.0 or later; this is Node 20.11.0. Install or switch to it (nvm install 22, or https://nodejs.org), then run the command again.
  ```

  Through `npx`, npm may warn `EBADENGINE` first, once for each package that
  needs the newer Node.

- **Docker** (Docker Desktop, or the Docker engine on Linux). `kindgi dev`
  runs the Kindgi runtime as a container, and a Postgres container for it:
  with `docker compose` when it's there, with plain `docker` otherwise. With
  your own database (Postgres 16 with pgvector, passed as `--database-url`),
  it starts no Postgres.
- **For a Python pack:** Python 3.11 or later, and uv (or Poetry, or pip).
  The CLI comes from PyPI as `kindgi-cli`, with its own copy of Node, so you
  install no Node.
- **For a Java or Scala pack: a JDK 17 or later,** with `JAVA_HOME` set to it
  (else the `java` on your `PATH`). A Java pack brings Maven (its `mvnw`); a
  Scala pack needs sbt on your `PATH`. The pack's `kindgiw` runs the CLI with
  Node's `npx` when Node is installed, else with `uvx`, so you need one of the
  two.

Nothing else: the runtime is a container image that `kindgi dev` pulls and
runs for you.

### Access to the runtime image

Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key, which starts with `kgi_lk_`. The key is the
runtime image's password. Log in to its registry once, with the username
`kindgi`:

```sh
docker login registry.kindgi.com --username kindgi
```

It asks for the password: paste your key. It prints `Login Succeeded`.
[Pull the runtime image](../../deploy/self-hosted/pull-the-runtime-image/) has the other ways to log in, from a
script or CI.

The first `kindgi dev` then pulls the image (about 700 MB; `amd64` and
`arm64`). Questions or trouble: contact@kindgi.com.

### Check this machine

`kindgi doctor` checks what Kindgi needs: Node (or Python and uv), Docker,
access to the runtime image and, in a project's folder, the project, its
dependencies, its model key, the runtime and a provider. Each check that
fails says how to fix it, and it exits `1` until nothing does:

```sh
npx --yes @kindgi/cli@0.1 doctor
```

- `npx` downloads `@kindgi/cli` and runs it. It asks before it downloads a
  package, and `--yes` answers for you.
- `@0.1` takes the newest 0.1 release of the CLI, the line these docs
  describe. It's optional: `npx --yes @kindgi/cli doctor` runs the newest
  release, which may be on a later line than these docs.

Before there's a project, on a machine that has what Kindgi needs, it ends
with `Everything checked is ready.`:

```text
kindgi doctor (CLI …)
  ✓ Node.js: Node 22.21.1.
  ✓ npm: npm 11.21.0.
…
  ✓ Docker: Docker is running.
  ✓ Runtime image: Docker can pull the runtime image (registry.kindgi.com/kindgi/runtime:…@sha256:…).
…
  – Project: No Kindgi project in …: no kindgi.config.ts, kindgi.config.mts, kindgi.config.mjs, kindgi.config.js, kindgi.config.cjs, no pyproject.toml with [tool.kindgi], and no kindgi.config.json.
…
Everything checked is ready.
```

A `–` line is a check that's skipped: not needed here, or not possible yet,
such as the project's before you make one.

Without Node, run the CLI from PyPI instead:

```sh
uvx --from "kindgi-cli>=0.1,<0.2" kindgi doctor
```

- `uvx` runs a command from a PyPI package without installing it.
- `--from` names the package that has the `kindgi` command, here any 0.1
  release of `kindgi-cli`, the line these docs describe. The range is
  optional: `uvx --from kindgi-cli kindgi doctor` runs the newest release,
  which may be on a later line than these docs.

The PyPI CLI brings its own Node:

```text
kindgi doctor (CLI …)
  ✓ Node.js: Node 24.19.0, bundled with kindgi-cli.
  – npm: Not needed: this kindgi is kindgi-cli (from PyPI), for Python projects, and it brings its own Node.
…
Everything checked is ready.
```

In a project, run the project's own CLI instead:
- `pnpm exec kindgi doctor` in a TypeScript project, or
  `npx --no -- kindgi doctor` with npm ([A TypeScript project](#a-typescript-project));
- `uv run kindgi doctor` in a Python project;
- `./kindgiw doctor` in a Java or Scala project.

Here, with a Docker config whose `credsStore` names a helper Docker can't
run:

```text
  ✓ Docker: Docker is running.
  ✗ Runtime image: Docker couldn't run its credential helper (docker-credential-kindgi-nope): ERROR: error getting credentials - err: exec: "docker-credential-kindgi-nope": executable file not found in $PATH, out: ``
      Fix: Docker's config (~/.docker/config.json, or the one in $DOCKER_CONFIG: "credsStore" or "credHelpers") names docker-credential-kindgi-nope, and Docker couldn't run it. Put it on your PATH (Docker Desktop on macOS keeps it in /Applications/Docker.app/Contents/Resources/bin), or remove that entry from the config, then run this again.
```

A `!` line is a warning: it doesn't fail, and things work now, but read it.

The Provider check also asks the runtime about each registered provider. A
registration the runtime can't build a provider from
(one stored before the runtime checked registrations, say) is a warning, and a
failure when no working provider is left. Each problem is on a line of its
own:

```text
  ! Provider: 2 providers are registered: anthropic, openai. The runtime can't build openai from its registration, so agents only get the others.
      ✗ openai: /adapter_config/api: adapter_config.api must be one of responses, chat-completions.
      Fix: Unregister openai (pnpm exec kindgi providers unregister openai), then register it again: pnpm exec kindgi providers register --preset=openai.
```

`--json` gives the same checks as JSON, for a script or a coding agent
([Set up with a coding agent](../agent/) has an agent read it). A check's
problems, such as each provider's in the example, are in its `details`.

## A TypeScript project

The CLI is **project-local**: a project depends on `@kindgi/cli` as a
devDependency and runs the version it pins, so everyone on the project runs
the same one. `kindgi init` adds it, with `@kindgi/sdk`:

```sh
npx --yes @kindgi/cli@0.1 init my-pack
```

- `init my-pack` makes a new pack in the folder `my-pack`. In an app you
  already have, run `npx --yes @kindgi/cli@0.1 init` in its folder instead
  ([Add Kindgi to an existing app](../existing-app/)).
- `--yes` and `@0.1` are as for `doctor` in [Check this machine](#check-this-machine).

It prints what it made, then the next steps:

```text
…
✓ Pack scaffolded at …/my-pack/
✓ package.json pins pnpm@10.28.0 (packageManager)

Next steps:
  cd my-pack
  pnpm install
  pnpm exec kindgi dev  # runs the Kindgi runtime (Docker) + hot-reloads this pack

Read the pack's README.md for details.
```

From then on, run `kindgi` through the project's package manager:

| Package manager | Command |
|---|---|
| pnpm | `pnpm exec kindgi dev` |
| npm | `npx --no -- kindgi dev` |
| yarn | `yarn kindgi dev` |
| bun | `bun run kindgi dev` |

With npm:
- `--no` keeps `npx` from downloading anything. It runs the project's own
  `kindgi`, or fails if the project has none.
- `--` passes every flag after it to Kindgi, `--help` included. Without it,
  `npx` takes `--help` for itself.

Use the scoped name, `@kindgi/cli`: there is no unscoped `kindgi` package
on npm.

These docs write `pnpm exec kindgi <command>`. With another package manager,
use its form from the table.

## A Python project

The CLI is the `kindgi-cli` package on PyPI. Start a new pack with it,
pinned to Kindgi's minor version:

```sh
uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-pack --template=python
cd my-pack
uv sync
```

`uvx --from` is as for `doctor`, in [Check this machine](#check-this-machine).
`--template=python` makes a Python pack.

`init` prints what it made, and `uv sync` what it installed:

```text
…
✓ Python pack scaffolded at …/my-pack/
…
Installed 26 packages in 206ms
…
```

`init` puts the SDK, the `kindgi` package, in the pack's dependencies and
`kindgi-cli` in its dev group, so `uv sync` installs both and everyone on the
project runs the CLI it pins. From then on, a Python project runs it as
`uv run kindgi <command>` (with Poetry, `poetry run kindgi <command>`). A
page with language tabs shows that in its Python tab. A page without them
writes `pnpm exec kindgi <command>`, which in a Python project is
`uv run kindgi <command>`.

In an existing app, add both yourself:

```sh
uv add kindgi
uv add --dev "kindgi-cli>=0.1,<0.2"
```

The first adds the SDK. The second adds the CLI, and `--dev` puts it in the
project's dev dependencies.

Each prints what it added. The CLI brings its own Node:

```text
…
 + kindgi==…
…
 + kindgi-cli==…
 + nodejs-wheel-binaries==24.19.0
```

With Poetry: `poetry add kindgi` and `poetry add --group dev "kindgi-cli>=0.1,<0.2"`.
With pip: `pip install kindgi "kindgi-cli>=0.1,<0.2"`.

## A Java or Scala project

```sh
npx --yes @kindgi/cli@0.1 init my-pack --template=java
```

- `--template=scala` makes a Scala pack. Without Node:
  `uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-pack --template=java`.
- The pack pins the Kindgi CLI it runs with, `"cli"` in `kindgi.config.json`.
  From then on, a Java or Scala project runs it as `./kindgiw <command>`
  (`kindgiw.cmd` on Windows). A page with language tabs shows that in its
  Java and Scala tabs. A page without them writes
  `pnpm exec kindgi <command>`, which here is `./kindgiw <command>`.
- The SDK is a dependency at your Kindgi release's version:
  `com.kindgi:kindgi-pack` in a Java pack's `pom.xml`,
  `"com.kindgi" %% "kindgi-pack-scala"` in a Scala pack's `build.sbt`.

`init` prints what it made, then the next steps:

```text
…
✓ Java pack scaffolded at …/my-pack/ (preview)
…
Next steps (a JDK 17 or later, JAVA_HOME set):
  cd my-pack
  ./mvnw test
  ./kindgiw dev  # the CLI the pack pins (kindgi.config.json "cli"): boots Kindgi locally + compiles and runs this pack, recompiling on save
…
```

In an app you already have: [Add Kindgi to an existing app](../existing-app/).

## Where `kindgi dev` keeps its data

`kindgi dev` gives each project its own database in the Postgres it starts:
`kindgi_<project>`, and in a git worktree `kindgi_<project>__<worktree>`. The
project's name is `project` in the Kindgi config (`kindgi.config.ts`, or
`[tool.kindgi]` in `pyproject.toml`); without it, the git repository's, the
workspace root's or the pack folder's. It says which when it starts:

```text
  ✓ Project: acme-desk (the pack's folder name; set `project` in the Kindgi config to name it)
  ✓ Database: kindgi_acme_desk (created) in the bundled Postgres; to use your own: --database-url
```

- **Starting over:** `kindgi dev --reset` drops the project's database after
  asking, and makes a new token. `--yes` skips the question, for scripts;
  without a terminal to ask on and without `--yes`, it refuses. A database you
  pass with `--database-url` is never dropped.
- **Several packs in one project** share its database and tenant, but not
  each other's tools: under `kindgi dev`, a flow in one pack can't call
  another pack's tools.

## Calling Kindgi from an application

An app that only starts runs and reads their results (no pack of its own)
needs only the SDK's client:

- **TypeScript:** `@kindgi/sdk`, and `createClient` from
  `@kindgi/sdk/client`.
- **Python:** `kindgi`, and `Kindgi` (or `AsyncKindgi`) from `kindgi.client`.
- **Java:** `com.kindgi:kindgi-client`, and `Kindgi.create()` from
  `com.kindgi.client` ([Call Kindgi from a Java app](../java-app/)).
- **Scala:** the Java client, `com.kindgi:kindgi-client`
  (`"com.kindgi" % "kindgi-client" % "<version>"` in `build.sbt`).

## Next

- [Quickstart: TypeScript](../quickstart-typescript/)
- [Quickstart: Python](../quickstart-python/)
- [Quickstart: Java](../quickstart-java/) and [Quickstart: Scala](../quickstart-scala/)
- [Add Kindgi to an existing app](../existing-app/)
