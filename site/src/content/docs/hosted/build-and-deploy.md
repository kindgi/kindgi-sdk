---
title: Build and deploy
description: Build your pack and deploy it to your Kindgi Cloud workspace with `kindgi deploy --hosted`, then wait until its pack service is ready.
sidebar:
  order: 10
---

On Kindgi Cloud, Kindgi builds your pack's image for you. `kindgi deploy
--hosted` sends the pack to Kindgi Cloud's build service, deploys what it
built, and waits until the deployment's pack service is ready. The image goes
to your workspace's own repository.

## Before you start

- **The Kindgi CLI, signed in to your workspace:** `kindgi auth login`. The
  CLI sends its key to the build service, and only there.
- **A pack that builds,** at most 30 MiB packed. A larger one isn't sent:
  the CLI says so and links
  [what the pack's image needs](../../start/existing-app-typescript/#what-the-packs-image-needs).

## Deploy

```sh
kindgi deploy --hosted
```

Or set `build: 'hosted'` on the environment in `kindgi.config.ts`, and
`kindgi deploy` does the same.

```text
CAPTURE: kindgi deploy --hosted, from the build to the pack service ready
```

- **The build** runs on the build service, and its log streams as it goes.
  When the stream is cut before the build ends, the CLI opens it again and
  prints each line once.
- **`--project <id>`** deploys to that project. It's checked before anything
  is built, so a project that isn't there fails at once.
- **After the deploy,** the CLI waits up to 5 minutes for the deployment's
  pack service. It says each new state once (`pending`, and why), and ends
  when the pack service is ready. If the pack service is taken down before
  it's ready, the deploy fails:

  ```text
  CAPTURE: a deploy whose pack service was cleared before it was ready
  ```

- **`--from-envelope <path>`** deploys an envelope built earlier, without
  building.

## Build without deploying

```sh
kindgi build --hosted
```

```text
CAPTURE: kindgi build --hosted
```

With `--project <id>`, the project is kept as a label on the build.
`--local`, `--endpoint` and `--registry-push-creds` don't go with
`--hosted`, and neither does `kindgi deploy`'s `--build-endpoint`.

## When the build service refuses

The CLI prints the build service's refusal with its status and code, and
the wait it asks for:

```text
CAPTURE: a build service refusal, as the CLI prints it
```

A `429` with `Retry-After` is waited out, and the same build sent again.

CAPTURE: the build service's refusal codes, each with what to do, from the
release candidate.
