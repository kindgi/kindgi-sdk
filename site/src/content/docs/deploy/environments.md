---
title: 'Environments: from staging to production'
description: Put your projects in order as environments, deploy each new build into the first one, and promote that exact build from one environment to the next until it reaches production, on Kindgi Cloud or on your own runtime.
sidebar:
  label: Environments
---

An environment is a project. You put projects in order, such as
`staging-1`, `staging-2` and `prod`. A new build goes into the first
environment only. From there, you promote it to the next one, one
environment at a time, until it reaches `prod`.

It works the same on Kindgi Cloud and on a runtime you host. The parts that
are Kindgi Cloud's own are marked.

```text
a deploy into staging-1      a new build enters here only
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
  `staging-2`. A version made since the build, such as a prompt change to
  one of its agents, moves with it. An edit of a version this build doesn't
  ship stays, and moves with a build that ships it.
- **Values never move.** Each environment has its own secrets, model keys
  and tool values. A promoted build reads the next environment's values,
  never the ones it had before.
- **It checks first.** Before anything moves, it checks that the key that
  signed the build is still trusted, as a deploy does. Then it lists each
  value the build needs that the next environment doesn't have. If the key
  isn't trusted or a value is missing, nothing moves.
- **It goes one environment at a time, in order.** Only the first
  environment takes new builds. The others take promotions only, so nothing
  reaches `prod` without passing through every environment before it.
- **It doesn't replace a live version.** Where an agent has a live
  version, the promoted version waits until you make it live there, as after
  a deploy.

## What stays in its environment

- **Data.** Runs, conversations, memory, judgments and approvals stay in the
  environment they happened in. A conversation keeps the version it started
  with, in its own environment.
- **Live versions and rollbacks.** Each environment has its own live
  versions. Rolling back `prod` doesn't change `staging-2`.
- **An agent that isn't in a build.** Promotion moves builds, so an agent
  made in a project outside any pack stays there. To move it, add it to the
  pack and deploy it to the first environment: it reaches the others by
  promotion. An agent the tenant or an org holds isn't in any one
  environment, so it has nothing to move.
- **Test sets move forward only.** A test set can be used in the environment
  it was made in and in every later one, never in an earlier one. A test set
  made in `prod` can hold production data, and data never moves back toward
  staging.

Changes made in the console start in the first environment too. A prompt
or settings change, or an accepted proposal from Improve, makes a new
version in the first environment. It reaches `prod` by promotion, like any
build. Improve still learns from the runs of every environment, `prod`'s
included.

In a later environment, the console doesn't offer those changes. In their
place, it says where they're made, such as "New agent versions are made in
staging-1, and reach this environment by promotion.", with a link to the
same page in `staging-1`. If you can't read `staging-1`, it's named
Environment 1, with no link. Improve's proposals and evaluations stay in
every environment. An accepted proposal's version is made in the first
environment: make it live there, then promote it.

## Before you start

- **A pack you deploy,** to Kindgi Cloud, as in
  [Deploy your agent to Kindgi Cloud](../../hosted/deploy-your-agent/), or to
  your own runtime, as in [Self-host Kindgi](../self-hosted/self-host/).
- **A tenant admin.** Only a tenant admin sets the order of environments, or
  changes it. On Kindgi Cloud, the tenant is your workspace.
- **A project for each environment.** `kindgi projects create --name=staging-1`
  makes one ([Organize by org and project](../../guides/projects/organize-by-org-and-project/)).
  An order has two or more projects. They all sit directly in the tenant, or
  all in the same org. A project is in one order at most. While it's in
  one, it can't be deleted, or moved into or out of an org.

All the environments of an order are projects of one tenant, on one
runtime.

## Name each environment's project

Each environment in the pack's `kindgi.config.ts` names its project, by its
slug, in `project`. Only the first environment builds, so only it has the
build settings.

On Kindgi Cloud:

```ts excerpt
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

On your own runtime, each environment also names the runtime's `endpoint`
and your `tenantId`, the same for every environment. Only the first has the
registry and signing key settings that
[Self-host Kindgi](../self-hosted/self-host/) describes: builds and signing
happen only there, and a promotion keeps the build's signature.

```ts excerpt
environments: {
  'staging-1': {
    endpoint: 'https://kindgi.acme.example',
    registry: 'registry.acme.example',
    tenantId: '<your tenant id>',
    signingKey: '~/.kindgi/keys/acme-desk.pem',
    signerKeyId: 'acme-desk',
    project: 'staging-1',
  },
  'staging-2': {
    endpoint: 'https://kindgi.acme.example',
    tenantId: '<your tenant id>',
    project: 'staging-2',
  },
  prod: {
    endpoint: 'https://kindgi.acme.example',
    tenantId: '<your tenant id>',
    project: 'production',
  },
},
```

In a Python pack, the same keys go in `pyproject.toml`, under
`[tool.kindgi.environments.<name>]`.

`--env=<name>` then means that environment's project, for every command:
`deploy`, `promote`, `secrets set`, `env set` and the rest. A `--project`
that names another project is refused, and the error names both.

On your own runtime, an environment without `project` keeps its usual
meaning: the runtime its `endpoint` names, its name as the value set, and the
project from `--project` or the Default project. If you run one runtime per
environment, nothing changes.

:::note[On Kindgi Cloud]
Every environment names its project. A `--env` whose environment names no
project is refused, and so is one that names no environment of the pack.
:::

## Set the order

:::note[What only you do]
**Set the order, once, as a tenant admin.** First environment first:

```sh
kindgi environments set staging-1 staging-2 prod
```
:::

It takes the pack's environment names, and maps each to its project.
Outside a pack, `--projects` names the projects instead, by id or slug.
For an order of an org's projects, add `--org=<org-id>`. Setting an order
replaces the one before.

`kindgi environments list` shows the order: each environment's position,
its name in the pack's config, and its project.

Don't confuse `kindgi environments` with `kindgi env`. `kindgi environments`
sets the order of your environments. `kindgi env` sets the values in one
environment, its value set.

## If your agents already run in the Default project

The Default project can be an environment too. Keep it as the last one,
`prod`, and put one or more staging projects before it.

`prod` names the Default project by its slug, as every environment names
its project. The slug is `default`, unless you've renamed it:
`prod: { project: 'default' }`, with its `endpoint` on your own runtime.
Then set the order, as a tenant admin:

```sh
kindgi environments set staging prod
```

- **Your live agents stay live.** Their live versions don't change. On
  Kindgi Cloud, a Default project in production stays in, and you don't go
  live again.
- **From then on, a deploy into the Default project is refused,** with a
  message that names `staging`. Deploy into `staging`, and promote to
  `prod`.
- **The order's projects sit directly in the tenant,** as the Default
  project does, not in an org.

## Give each environment its values

Each environment reads its own project's values: the secrets, model keys and
tool values stored for that project. Store each value in the environment
that reads it:

```sh
kindgi secrets set ORDERS_API_KEY --env=staging-2
```

With `--env=staging-2`, the secret is stored for `staging-2`'s project, in
the value set the runtime serves. A tool's per-project values work the same
way, with `kindgi env set`
([Give a tool per-project values](../../guides/tools/give-a-tool-env-values/)).

Outside a pack, `--env` keeps its usual meaning: the value set. Name the
project with `--scope=project:<projectId>`, and with `--env` the value set
the runtime serves: on your own runtime, its `KINDGI_ENV`; on Kindgi Cloud,
`prod`. That goes for `kindgi secrets set` and `kindgi env set` alike. A
value stored under another value set is never read.

A value stored for the whole tenant, with `--scope=tenant`, is used by every
environment that doesn't have its own. Keep `prod`'s live keys in `prod`.

A model provider's key is read the same way: a run reads the key from its
own project first. Store the key under the same name in each environment,
and each one calls the model with its own key
([Keys](../../guides/models/#keys)).

## Deploy into the first environment

Ask your coding agent: "Deploy the pack into `staging-1`." For reference, on
Kindgi Cloud:

```sh
kindgi deploy --hosted --env=staging-1
```

On your own runtime, with its token exported as `KINDGI_API_TOKEN`:

```sh
kindgi deploy --env=staging-1
```

A deploy into a later environment is refused
(`environment-takes-promotions`), and nothing is deployed. The refusal
names the first environment, and prints a `kindgi promote` line for each
step from there. Deploy into the first environment, and promote from there.
Publishing an agent, a flow, a
tool, a guardrail or a data block through the API into a later environment
is refused the same way: only builds move between environments.

Try the new version in `staging-1`, and make it live there
([Release an agent version](../../guides/evals/release-an-agent-version/)).

## Promote to the next environment

Ask your coding agent: "Promote the build from `staging-1` to `staging-2`."
For reference:

```sh
kindgi promote --from=staging-1 --to=staging-2 --reason="Tried in staging-1"
```

It prints what moves before it moves anything: the pack, its build, and
each agent, flow, tool and guardrail with its version. A version made in
`staging-1` since the build is marked as carried, and an edit that stays in
`staging-1` says why. Test sets don't move: `staging-2` reads the ones made
in `staging-1`. Then it lists any value the build needs that isn't set in
`staging-2`, and then it promotes.

- **It promotes the pack's build that serves in `staging-1`.** When more
  than one does, it lists them, newest first: name one with
  `--deployment=<id>`.
- **`--check`** prints what would move and the values not set in
  `staging-2`, and changes nothing.
- **Run it in the pack.** `--from` and `--to` are environment names, and it
  reads their projects from `kindgi.config.ts`. Outside a pack, name the two
  projects instead, by slug or id:
  `kindgi promote --from=acme-staging --to=acme-prod`. It then takes the
  build that serves in `--from`, of any pack, and when more than one does,
  the list names each one's pack.
- **It takes `read` on `staging-1` and `admin` on `staging-2`,** when
  authorization is on. A key or a session limited to one project can't
  promote, or check a promotion, either way: a promotion reads one project
  and writes another.

If a value isn't set in `staging-2`, the promotion names each one, what
needs it and the command that sets it in `staging-2`'s project, and moves
nothing. Set them in `staging-2`, then promote again. Promoting the same
build again doesn't make a second copy.

- A tool's optional secret isn't listed when it isn't set
  ([An optional secret](../../guides/tools/give-a-tool-a-secret/#an-optional-secret)).
- With no model provider registered, an agent that names no provider, or
  one that isn't registered, is listed too: a run would have no model to
  call. Register one with `kindgi providers register`, then check again.

## Go live in `prod`

Promote from the environment before `prod`, the same way:

```sh
kindgi promote --from=staging-2 --to=prod --reason="Compared on the test set"
```

In `prod`, the promoted version waits while the live one serves. Try it by
its version, make it live, and roll back if you need to
([Release an agent version](../../guides/evals/release-an-agent-version/)).

:::note[On Kindgi Cloud]
The project of `prod` is the one you put in production, with **Go live**
([Go live](../../hosted/deploy-your-agent/#go-live)). Only one project of
your workspace is in production at a time
([projects in production](../../hosted/limits/#projects-in-production)).
The other environments aren't, so their runs count as staging.
:::

## In the console

- **Environments** has a column for each environment, with each agent's live
  version and the versions waiting. **Promote to staging-2** runs the same
  checks first, and **Make live** and **Roll back** work on their own column
  only.
- **Values**, for each environment, lists what the build needs: what's set
  there, what falls back to the tenant's values, and what's missing.

## If something goes wrong

- **A command with `--env` is refused.** The pack has no environment of that
  name, or a `--project` names another project than the environment's. On
  Kindgi Cloud, the environment may name no project: name it in
  `kindgi.config.ts`, as in
  [Name each environment's project](#name-each-environments-project).
- **A deploy or a publish into a later environment is refused
  (`environment-takes-promotions`).** Deploy or publish into the first
  environment, then promote.
- **`kindgi promote` finds no build to promote, or more than one.** With
  none serving in `--from`, it says so, and why the newest was taken down:
  deploy into the first environment, or name a deployment with
  `--deployment=<id>`. With more than one, it lists them: name one.
- **`kindgi promote` is refused because the two environments name a
  different `endpoint` or `tenantId`.** An order lives in one tenant on one
  runtime, and a promotion stays there. Give both environments the same
  `endpoint` and `tenantId` in `kindgi.config.ts`.
- **`kindgi promote` is refused because a slug names no project, or more
  than one.** Two projects in different orgs can share a slug. Name the
  project by its id: `kindgi projects list` shows them.
- **A promotion is refused for a key limited to one project
  (`key-project-mismatch`).** Promote with a key that isn't limited to a
  project.
- **A promotion is refused because values aren't ready
  (`promotion-values-not-ready`).** Set each value it names in the
  environment you're promoting to, then promote again. `--check` lists them
  without promoting.
- **A promotion that skips an environment is refused
  (`promotion-not-next-environment`).** Promote to the next environment in
  the order. `kindgi environments list` shows it.
- **A promotion is refused because the build no longer serves
  (`deployment-superseded`).** A newer deployment serves in its place:
  promote that one. When it's the environment you're promoting to that has
  this build already, superseded there, promote the newer build from the
  environment before it.
- **A promotion is refused because the signing key isn't trusted
  (`signer-not-trusted`).** The key that signed the build is no longer on
  the trust list. Deploy a new build, signed with a trusted key, into the
  first environment.
- **Setting the order is refused (`project-in-another-order`).** One of its
  projects is in another order already. Set that order without it, or
  clear it, first.
- **Deleting a project, or moving it into or out of an org, is refused
  (`project-in-environment-order`).** The project is in an environment
  order. Set the order without it, or clear it, first. Renaming it isn't
  refused. If you change its slug, change the `project` that names it in
  `kindgi.config.ts` too.
- **A project outside the order can't take the pack.** It's refused as a
  project of another pack
  ([A project for each client](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).

## Without environments

Nothing changes for a tenant that doesn't set an order. Its projects take
deploys as before.

To stop using an order, a tenant admin clears it with
`kindgi environments clear`. Its projects then take builds directly again.
