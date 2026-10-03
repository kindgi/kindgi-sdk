---
title: Install
description: What you need on your machine, and how a project gets the Kindgi CLI and SDK.
sidebar:
  order: 2
---

## What you need

- **Node 22 or later.** The `kindgi` CLI is a Node program, for TypeScript
  and Python projects alike.
- **Docker** (Docker Desktop, or a Docker engine on Linux). `kindgi dev`
  runs the Kindgi runtime as a container, and starts a Postgres container
  for it unless you point it at your own database.
- **For a Python pack:** Python 3.11 or later, and uv (or Poetry, or pip).
  The CLI still needs Node 22.

Nothing else: the runtime is a container image that `kindgi dev` pulls and
runs for you.

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com.
:::

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

A Python app has no npm project for the CLI, so run it with `npx` (it comes
with Node 22), pinned to Kindgi's minor version:

```sh
npx --yes @kindgi/cli@0.1 init my-pack --template=python
```

In a Python project, every `kindgi <command>` in these docs is
`npx --yes @kindgi/cli@0.1 <command>`. (`--yes` skips npx's install prompt,
so a coding agent never waits on it.)

The Python SDK is the `kindgi` package. `kindgi init` adds it to your
`pyproject.toml`; to add it yourself:

```sh
uv add kindgi            # or: poetry add kindgi, or: pip install kindgi
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
