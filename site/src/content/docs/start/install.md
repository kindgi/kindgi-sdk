---
title: Install
description: What you need on your machine, and how a project gets the Kindgi CLI and SDK.
sidebar:
  order: 2
---

## What you need

- **For a TypeScript pack: Node 22.12 or later.** The `kindgi` CLI and the SDK
  run on Node.
- **Docker** (Docker Desktop, or the Docker engine on Linux). `kindgi dev`
  runs the Kindgi runtime as a container, and a Postgres container for it:
  with `docker compose` when it's there, with plain `docker` otherwise. With
  your own database (Postgres 16 with pgvector, passed as `--database-url`),
  it starts no Postgres.
- **For a Python pack:** Python 3.11 or later, and uv (or Poetry, or pip).
  The CLI comes from PyPI as `kindgi-cli`, with its own copy of Node, so you
  install no Node.

Nothing else: the runtime is a container image that `kindgi dev` pulls and
runs for you.

### Access to the runtime image

Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub: it
shows the runtime image's pull credentials, a robot name and a token. Log in
to its registry once with them. The CLI asks for the token without showing
it, hands both to `docker login` (Kindgi keeps no copy), and checks that you
can pull the image it runs:

```sh
npx --yes @kindgi/cli@0.1 auth registry --username <your robot name>
# without Node: uvx --from "kindgi-cli>=0.1,<0.2" kindgi auth registry --username <your robot name>
```

```text
✓ You can pull quay.io/kindgi/runtime:…@sha256:…, the image this CLI runs.
```

The first `kindgi dev` then pulls the image (about 700 MB; `amd64` and
`arm64`). Questions or trouble: contact@kindgi.com.

### Check this machine

`kindgi doctor` checks what Kindgi needs: Node (or Python and uv), Docker,
access to the runtime image and, in a project's folder, the project, its
dependencies, its model key, the runtime and a provider. Each check that
fails says how to fix it, and it exits `1` until nothing does:

```sh
npx --yes @kindgi/cli@0.1 doctor     # in a project: pnpm exec kindgi doctor, or npx --no kindgi doctor
uvx --from "kindgi-cli>=0.1,<0.2" kindgi doctor   # without Node; in a Python project: uv run kindgi doctor
```

Here, with a Docker config whose `credsStore` names a helper Docker can't
run:

```text
  ✓ Docker: Docker is running.
  ✗ Runtime image: Docker couldn't run its credential helper (docker-credential-kindgi-nope): ERROR: error getting credentials - err: exec: "docker-credential-kindgi-nope": executable file not found in $PATH, out: ``
      Fix: Docker's config (~/.docker/config.json, or the one in $DOCKER_CONFIG: "credsStore" or "credHelpers") names docker-credential-kindgi-nope, and Docker couldn't run it. Put it on your PATH (Docker Desktop on macOS keeps it in /Applications/Docker.app/Contents/Resources/bin), or remove that entry from the config, then run this again.
```

A `!` line is a warning: it doesn't fail, and things work now, but read it.

The Provider check also asks the runtime about each registered provider
(runtimes from 0.1.5). A registration the runtime can't build a provider from
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
problems, such as each provider's above, are in its `details`.

## A TypeScript project

The CLI is **project-local**: a project depends on `@kindgi/cli` as a
devDependency and runs the version it pins, so everyone on the project runs
the same one. `kindgi init` adds it, with `@kindgi/sdk`:

```sh
npx @kindgi/cli init my-pack     # a new pack; in an existing app: npx @kindgi/cli init
```

From then on, run `kindgi` through the project's package manager:

| Package manager | Command |
|---|---|
| pnpm | `pnpm exec kindgi dev` |
| npm | `npx --no kindgi dev` |
| yarn | `yarn kindgi dev` |
| bun | `bun run kindgi dev` |

Use the scoped name, `@kindgi/cli`: there is no unscoped `kindgi` package
on npm.

## A Python project

The CLI is the `kindgi-cli` package on PyPI. Start a new pack with it,
pinned to Kindgi's minor version:

```sh
uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-pack --template=python
cd my-pack
uv sync
```

`init` puts the SDK, the `kindgi` package, in the pack's dependencies and
`kindgi-cli` in its dev group, so `uv sync` installs both and everyone on the
project runs the CLI it pins. From then on, in a Python project, every
`kindgi <command>` in these docs is `uv run kindgi <command>` (with Poetry,
`poetry run kindgi <command>`).

In an existing app, add both yourself:

```sh
uv add kindgi                          # the SDK
uv add --dev "kindgi-cli>=0.1,<0.2"    # the CLI
```

With Poetry: `poetry add kindgi` and `poetry add --group dev "kindgi-cli>=0.1,<0.2"`.
With pip: `pip install kindgi "kindgi-cli>=0.1,<0.2"`.

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
- **Coming from Kindgi 0.1.2 or earlier,** where every project shared one
  database: that database stays as it was, and the project's first start
  says so once. Register your model providers and reviewers again in each
  project:

  ```text
  This project now has its own database, kindgi_acme_desk. The old shared `kindgi` database is left as it is: projects on an older Kindgi still use it. Providers and reviewers are set up once per project: set them up here again.
  ```

## Calling Kindgi from an application

An app that only starts runs and reads their results (no pack of its own)
needs just the SDK's client:

- **TypeScript:** `@kindgi/sdk`, and `createClient` from
  `@kindgi/sdk/client`.
- **Python:** `kindgi`, and `Kindgi` (or `AsyncKindgi`) from `kindgi.client`.

## Next

- [Quickstart: TypeScript](../quickstart-typescript/)
- [Quickstart: Python](../quickstart-python/)
- [Add Kindgi to an existing app](../existing-app/)
