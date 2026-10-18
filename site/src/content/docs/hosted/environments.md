---
title: 'Environments: from staging to production'
description: Put your Kindgi Cloud projects in order as environments, deploy each new build into the first one, and promote that exact build from one environment to the next until it reaches production.
sidebar:
  order: 2
  label: Environments
---

On Kindgi Cloud, an environment is a project of your workspace. You put
projects in order, such as `staging-1`, `staging-2` and `prod`. A new build
goes into the first environment only. From there, you promote it to the next
one, one environment at a time, until it reaches `prod`.

```text
kindgi deploy --hosted --env=staging-1      a new build enters here only
        │
        ▼
  staging-1    its own values and data: try it, make it live here
        │
        │  kindgi promote --from=staging-1 --to=staging-2
        ▼
  staging-2    its own values and data: try it, compare it, make it live here
        │
        │  kindgi promote --from=staging-2 --to=prod
        ▼
  prod         in production, with your live keys: the promoted version
               waits while the live one serves, until you make it live
```

Each environment has its own values and its own data. Only the build moves.

## What a promotion does

- **It moves the exact build.** The next environment gets the same signed
  image, with the same agent, flow and tool versions, under the same version
  numbers. Nothing is rebuilt, so what runs in `prod` is what ran in
  `staging-2`.
- **Values never move.** Each environment has its own secrets, model keys
  and tool values. A promoted build reads the next environment's values,
  never the ones it had before.
- **It checks the next environment first.** Before anything moves, it lists
  each value the build needs that the next environment doesn't have. If one
  is missing, nothing moves.
- **It goes one environment at a time, in order.** Only the first
  environment takes new builds. The others take promotions only, so nothing
  reaches `prod` without passing through every environment before it.
- **It doesn't make anything live unless you ask.** Where an agent has a
  live version, the promoted version waits until you make it live there, as
  after a deploy. `--make-live` does both in one step, and a gate that needs
  a reviewer still applies.

## What stays in its environment

- **Data.** Runs, conversations, memory, judgments and approvals stay in the
  environment they happened in. A conversation keeps the version it started
  with, in its own environment.
- **Live versions and rollbacks.** Each environment has its own live
  versions. Rolling back `prod` doesn't change `staging-2`.
- **Test sets move forward only.** A test set can be used in the environment
  it was made in and in every later one, never in an earlier one. A test set
  made in `prod` can hold production data, and data never moves back toward
  staging.

Changes you make in Kindgi Cloud start in the first environment too. A
prompt or settings change in the console, or an accepted proposal from
Improve, makes a new version in the first environment. It reaches `prod` by
promotion, like any build. Improve still learns from the runs of every
environment, `prod`'s included.

## Before you start

- **A pack deployed to Kindgi Cloud,** as in
  [Deploy your agent to Kindgi Cloud](../deploy-your-agent/).
- **A tenant admin** of the workspace. Only a tenant admin sets the order of
  environments, or changes it.
- **A project for each environment.** `kindgi projects create --name=staging-1`
  makes one ([Organize by org and project](../../guides/projects/organize-by-org-and-project/)).
  An order's projects all sit directly in your workspace, or all in the same
  org. A project is in one order at most.

## Name each environment's project

Each environment in the pack's `kindgi.config.ts` names its project. Only
the first one builds:

```ts
environments: {
  'staging-1': {
    build: 'hosted',
    project: 'staging-1',
    signingKey: '~/.kindgi/keys/acme-desk.pem',
  },
  'staging-2': { project: 'staging-2' },
  prod: { project: 'production' },
},
```

On Kindgi Cloud, `--env=<name>` then means that environment's project, for
every command: `deploy`, `promote`, `secrets set`, `env set` and the rest.
A `--env` that names no environment of the pack is refused, and so is one
whose environment names no project.

## Set the order

:::note[What only you do]
**Set the order, once, as a tenant admin.** First environment first:

```sh
kindgi environments set staging-1 staging-2 prod
```
:::

It takes the pack's environment names, and maps each to its project.
Outside a pack, `--projects` names the projects instead, by id or slug.

`kindgi environments` shows the order. For each environment and agent, it
shows the live version and the versions waiting.

## If your agents already run in the Default project

The Default project can be an environment too. Keep it as the last one,
`prod`, and put one or more staging projects before it.

`kindgi projects get-default` prints the Default project, with its slug.
`prod` names the Default project by that slug, as every environment names
its project:

```ts
environments: {
  staging: {
    build: 'hosted',
    project: 'staging',
    signingKey: '~/.kindgi/keys/acme-desk.pem',
  },
  prod: { project: '<default-project-slug>' },
},
```

Then set the order, as a tenant admin:

```sh
kindgi environments set staging prod
```

- **Your live agents stay live.** If the Default project is in production,
  it stays in, and you don't go live again.
- **From then on, a deploy into the Default project is refused,** with a
  message that names `staging`. Deploy into `staging`, and promote to
  `prod`.
- **The order's projects sit directly in your workspace,** as the Default
  project does, not in an org.

## Give each environment its values

Store each value in the environment that reads it:

```sh
kindgi secrets set ORDERS_API_KEY --env=staging-2
```

The same goes for model keys and a tool's per-project values
([Give a tool per-project values](../../guides/tools/give-a-tool-env-values/)).
A value stored for the whole workspace, with `--scope=tenant`, is used by
every environment that doesn't have its own. Keep `prod`'s live keys in
`prod`.

## Deploy into the first environment

Ask your coding agent: "Deploy the pack to Kindgi Cloud, into `staging-1`."
For reference:

```sh
kindgi deploy --hosted --env=staging-1
```

A deploy into a later environment is refused. The message names the first
environment and the command that promotes from it.

Try the new version in `staging-1`, and make it live there, as in
[Deploy your agent to Kindgi Cloud](../deploy-your-agent/#try-it).

## Promote to the next environment

Ask your coding agent: "Promote the build from `staging-1` to `staging-2`."
For reference:

```sh
kindgi promote --from=staging-1 --to=staging-2 --reason="Tried in staging-1"
```

It prints what moves before it moves anything: the pack, its build, and
each agent, flow, tool and test set with its version. Then it checks
`staging-2`'s values, and then it promotes.

- **By default, it promotes `staging-1`'s newest build of the pack.** When
  there's more than one it could take, it lists them: name one with
  `--deployment=<id>`.
- **`--make-live`** also makes each promoted agent version live in
  `staging-2`, through any gate there.

If a value is missing, the promotion names each one, says what needs it,
and moves nothing. Store the missing values in `staging-2`, then promote
again. Promoting the same build again doesn't make a second copy.

## Go live in `prod`

Promote from the environment before `prod`, the same way:

```sh
kindgi promote --from=staging-2 --to=prod --reason="Compared on the test set"
```

The project of `prod` is the one you put in production, with **Go live**
([Go live](../deploy-your-agent/#go-live)). Only one project of your
workspace is in production at a time
([projects in production](../limits/#projects-in-production)). The other
environments aren't, so their runs count as staging.

In `prod`, the promoted version waits while the live one serves. Try it by
its version, make it live, and roll back if you need to, as in
[Change your agent once it's live](../deploy-your-agent/#change-your-agent-once-its-live).

## In the console

- **Environments** has a column for each environment, with each agent's live
  version and the versions waiting. **Promote to staging-2** runs the same
  check of the values first, and **Make live** and **Roll back** work on
  their own column only.
- **Values**, for each environment, lists what the build needs: what's set
  there, what falls back to the workspace, and what's missing.

## If something goes wrong

- **A command with `--env` is refused.** The pack has no environment of that
  name, or the environment names no project. Name its project in
  `kindgi.config.ts`, as in
  [Name each environment's project](#name-each-environments-project).
- **A deploy into a later environment is refused.** Deploy into the first
  environment, then promote.
- **A promotion is refused because values are missing.** Store each value
  it names in the environment you're promoting to, then promote again.
- **A promotion that skips an environment is refused.** Promote to the next
  environment in the order.
- **A promotion is refused because the signing key isn't trusted.** The key
  that signed the build was revoked after the deploy. Deploy a new build,
  signed with a trusted key, into the first environment.
- **A project outside the order can't take the pack.** It's refused as a
  project of another pack
  ([A project for each client](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).

## Without environments

Nothing changes for a workspace that doesn't set an order. Its projects
work as [Deploy your agent to Kindgi Cloud](../deploy-your-agent/) says.
