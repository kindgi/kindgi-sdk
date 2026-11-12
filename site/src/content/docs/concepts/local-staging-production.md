---
title: Local, staging and production
description: Which to use when, what "env" and "production" each mean, and what moves when a project goes from your machine to staging and on to production.
sidebar:
  order: 5
---

This page explains the three places a pack runs as you build it: on your
machine, in staging, and in production. So you can tell which one a command
or a value is for, and what you set up again when a project moves from one
to the next.

## Which to use when

| | Where it runs | What it's for | What's different |
|---|---|---|---|
| **Local** | `kindgi dev`, on your machine | Writing the pack and trying each change as you save it | Development mode: no authorization and no schedules ([On your machine](#on-your-machine)) |
| **Staging** | A project that isn't in production, first in an environment order | Trying a build with real settings before real users see it | Its runs are staging runs. On a runtime of your own, one runtime or two ([One runtime or two](#one-runtime-or-two)) |
| **Production** | The project you put in production, next in the order | Real work, for real users | Its runs are production runs, on the versions you pinned there |

**Local is the same wherever you deploy.** `kindgi dev` runs the runtime as
a container on your machine, from the image a deployment runs, pinned by
digest. Your pack's code runs beside it in a pack service, and reloads on
each save. Pulling the image needs a `docker login registry.kindgi.com`
with your license key as the password ([Install](../../start/install/)).

**Staging is a project, not a place.** It's a project that isn't in
production, ahead of prod's project in an environment order. A build goes
into staging's project, and `kindgi promote` moves that same build on to
prod's ([Environments in order](../../deploy/ship-from-ci/#environments-in-order)).
On Kindgi Cloud, staging is that second project. On a runtime of your own,
it can also be a runtime of its own.

**Production is a switch on a project.** On any runtime, turning it on is
refused, with `409 promote-only-build`, while a build signed to reach
production only by promotion was deployed into the project rather than
promoted there
([Put a project in production](../../guides/projects/organize-by-org-and-project/#put-a-project-in-production)).
On Kindgi Cloud, the platform has to allow it too, and it can refuse:
`production-not-allowed`, or `production-limit-reached` when the workspace
already has as many projects in production as it may. A project that isn't
in production, such as staging, doesn't count toward that limit.

## Three things called env

A command's `--env` means one of three things, and which one depends on the
command:

- **The pack's env block.** `kindgi.config.ts` has a block for each
  environment, and a `.env.<name>` file goes with it. `kindgi build` and
  `kindgi deploy` use one, `staging` unless `--env` names another.
- **The values' env.** A runtime keeps secrets and env values under the env
  it serves, which its `KINDGI_ENV` names. `kindgi dev` serves `local`.
  Kindgi Cloud serves `prod` and refuses a value under any other env, with
  `409 env-not-served`
  ([Set values per environment](../../guides/secrets/per-environment-values/)).
- **The environment map.** `environments.<name>.project` in
  `kindgi.config.ts` names each environment's project, by id or slug. A
  `--project` that isn't that environment's project is refused.

These pages name them `local`, `staging` and `prod`. Use the env your
runtime serves:

- On a runtime of your own, it's the name its `KINDGI_ENV` sets, and the
  startup banner prints it on its `Env:` line. The name is yours to pick:
  the runtime gives no name a meaning of its own. A runtime that serves
  `production` keeps it, and its values stay under `production`.
- On any runtime that serves an env, `kindgi auth whoami` names it in its
  JSON's `servedEnv`, with `refusesOtherEnvs` saying whether it refuses
  values under any other. Kindgi Cloud refuses them.

**An app's production test is a fourth thing, and it isn't an env name.**
An app's Kindgi client counts itself as in production when `NODE_ENV` or
`KINDGI_ENV` is `production`, that exact word, in the app's own
environment. Then it never looks for `kindgi dev`'s `.kindgirc.json`, and it
needs `KINDGI_API_URL` and `KINDGI_API_TOKEN`
([Start runs from your app](../../start/call-from-your-app/)). An app that sets
only `KINDGI_ENV=prod` still looks for `.kindgirc.json`.

## What "production" means

Three things are called production, and only the first makes a run a
production run:

- **The project's switch.** A project is in production or it isn't. The
  console shows **Testing mode** or **Live**, with **Go live**. The CLI is
  `kindgi projects production <project-id> on|off|status`, and the API is
  `PUT /v1/projects/{projectId}/production`. A run in a project in
  production is a production run, and any other run is a staging run. With
  authorization on, only a tenant admin turns it on or off. Taking a project
  out of production is never refused.
- **The license.** The runtime is free for non-production use, CI and
  staging environments that serve no end users included. Serving end users,
  or processing live business data, is production use, and needs a
  production license ([Licensing](../licensing/)). The license goes by what
  the runtime is used for, not by the switch.
- **An env's name.** `prod`, or a self-hosted runtime's own name such as
  `production`, only says where values are kept. It doesn't make a run a
  production run.

Only projects in production count toward a license key's limits. A project
that isn't in production doesn't count, and nothing counts in development
mode.

## On your machine

`kindgi dev` runs the image a deployment runs, in development mode
(`KINDGI_DEV=true`). That makes it different from a deployment:

- **Your license key.** `kindgi dev` gives the runtime your license key,
  from `KINDGI_LICENSE_KEY` or the one `kindgi auth registry` keeps. The
  free non-production key covers it ([Licensing](../licensing/)).
- **No authorization.** `kindgi dev` runs without it, while a deployment
  can turn it on ([Run with authorization](../../deploy/authorization/)).
- **No schedules.** **Schedule…** is off under `kindgi dev`, since it runs
  while you work, not around the clock
  ([Run on a schedule](../../guides/runs/run-on-a-schedule/)).
- **The dev sandbox.** It covers `kindgi dev` only
  ([Keep your tools' code away from your keys](../../guides/secrets/dev-sandbox/)).
- **Values from files.** Values come from your env files (`.env`,
  `.env.local`) and `.kindgi/secrets.env`, with no versions to rotate and
  nothing to revoke ([Store a secret](../../guides/secrets/store-a-secret/)).
- **A file your app reads.** It writes the API's address and a token to the
  pack folder's `.kindgirc.json`, and your app's client finds them there.
- **One Postgres.** Every `kindgi dev` on the machine shares one Postgres
  container, with a database for each project. `kindgi dev --reset` drops
  the project's database, after asking.
- **Port 4000,** or the next free one when it's taken.

## What moves with a project, and what doesn't

| What | When the project moves | Kept for each |
|---|---|---|
| The pack's code: agents, tools, flows and guardrails | `kindgi promote` moves the same signed build to the next environment on the same runtime. Nothing is rebuilt. It lists the edits made to its agents and flows since the build, in the environment it moves from: the ones that move with it, and the ones that stay behind. To another runtime, build and sign it again from the same commit ([One runtime or two](#one-runtime-or-two)) | project |
| Secrets and env values | Never move: they aren't part of a version. `kindgi promote --check` lists the ones the next environment is missing, and `kindgi deploy --sync-secrets` sends `.env.<env>`'s values, off by default | env and scope |
| Pinned versions | Don't move. Runs in prod keep the version pinned there until you pin the new one | environment |
| The production switch | Doesn't move. You turn it on in each project | project |
| Model providers | Registered once on each runtime | runtime |
| Signing keys | Made on your machine, under `~/.kindgi/keys/`, and trusted once on each runtime | machine and runtime |
| API keys | Made in a workspace, and one can be limited to a project | workspace |
| Triggers: schedules, webhooks and mail triggers | Set up once in each environment, by a person | project |
| Connections | Chosen in each environment's project | project |
| Runs | Never move. A run stays in the project it ran in | project |

An environment that takes promotions refuses a deploy, with
`409 environment-takes-promotions`, before anything is written. So prod
runs exactly what ran in staging.

## Which env each command uses

Each command has its own default for `--env`:

- **`kindgi build`, `kindgi deploy` and `kindgi env`** use the pack's env
  block, and default to `staging`. So a deploy with no `--env` uses
  staging's block.
- **`kindgi providers register`** keeps the provider's key under `local`,
  or under the env a runtime that refuses other envs serves.
- **`kindgi secrets` and `kindgi env … --scope`** have no default, and stop
  with `Missing required flag: --env=<name>`. On a runtime that refuses
  other envs, they use the env it serves.

On Kindgi Cloud with one project and no environment order, name
`--env=prod` on every command, as
[Deploy your agent to Kindgi Cloud](../../hosted/deploy-your-agent/) does:
`build`, `deploy` and `env` would otherwise use `staging`, which Kindgi
Cloud doesn't serve. With an environment order, `--env` names the
environment instead: `kindgi deploy --hosted --env=staging` deploys into
staging's project, and staging's values sit under `prod` in that project.

## One runtime or two

On Kindgi Cloud, staging is always a second project on the same runtime. On
a runtime of your own, staging comes in two shapes:

- **One runtime.** Staging's and prod's projects are on one runtime, in an
  order. A build goes into staging's project, and `kindgi promote` moves it
  to prod's.
  - The runtime serves one env, so staging's and prod's values sit under
    the same name, kept apart by project scope
    (`--scope=project:<projectId>`).
  - Staging runs on prod's runtime, under its production license.
  - [Environments in order](../../deploy/ship-from-ci/#environments-in-order)
    has the steps.
- **Two runtimes.** A runtime for each environment, and no promotion
  between them.
  - A signed build names its workspace, and a runtime checks the signature
    against the workspace it's deployed to. So build and sign from the same
    commit for each runtime, and deploy each build to its runtime's first
    environment ([Separate runtimes](../../deploy/ship-from-ci/#separate-runtimes)).
  - Each runtime is set up once: the CLI signed in to it, its trusted
    signing key, providers, release gates, test cases and triggers.
  - A staging runtime that serves no end users is non-production use, so a
    non-production key covers it.
  - [Staging and production](../../deploy/self-hosted/cloud-run/#staging-and-production)
    runs them as two installations on Google Cloud Run.

## Next

- [Environments in order](../../deploy/ship-from-ci/#environments-in-order):
  set up staging and prod, and promote a build, by hand or from CI.
- [Deploy your agent to Kindgi Cloud](../../hosted/deploy-your-agent/): from
  your machine to a live agent on Kindgi Cloud.
- [Self-host Kindgi](../../deploy/self-hosted/self-host/): a runtime of your
  own, with Docker.
- [Licensing](../licensing/): what counts as production use.
