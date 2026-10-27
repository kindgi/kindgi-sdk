---
title: Projects, packs and values
description: Which project a pack's items belong to, what a project's runs can use, and where the values they read are kept.
sidebar:
  order: 4
---

This page explains how a pack, the projects you deploy it into, and the
values its code reads fit together. So you can predict what a run can call,
and which value it gets.

## A pack goes into one project

A pack is your app's Kindgi code, in its `kindgi/` folder or a pack of its
own. Every id in it starts with the pack's id, such as `acme-desk.triage`
([Packs and primitives](../packs/)).

`kindgi deploy` registers the whole pack in one project: the one
`--project` names, else the tenant's Default project. Its agents, flows,
tools and guardrails belong to that project from then on. An item stays in
the project its first version went into: publishing a version of it in
another project is refused, and nothing is written.

So one pack serves one project. Deploying it into a second project is
refused, because its ids already belong to the first, and nothing is
deployed. For a second client, make a copy of the pack with `kindgi init`,
which gives every id the new pack's id.
[Deploy a client's pack into its project](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)
shows how.

A copy runs on a runtime that runs each deployment as a service of its
own (`KINDGI_PACK_ROUTING=per-deployment`, which only a runtime serving
many tenants can set). A runtime with one pack service,
such as a self-host serving one tenant, runs only the pack it was given,
so a copy's code wouldn't run there. There, a second project gets the same
items through an environment order: put both projects in one order
(`kindgi environments set`), and `kindgi promote` the build from the first
to the second. The `409` names the fix your runtime has.

## What a project's runs can use

A run is in one project, and it can use only what that project reaches:

- **A pack's items**, its tools, agents, flows, guardrails, data blocks and
  test cases, reach only runs in their own project.
- **An MCP server's tools** reach the projects its endpoint was registered
  for: every project in the tenant, every project in one org, or one
  project
  ([Use an MCP server's tools](../../guides/tools/mcp-servers/#give-some-projects-its-tools)).
- **`demo.echo`,** the tool `kindgi dev` adds for trying a run without a
  model key, works in every project.

Naming anything else is refused, with one answer whether the item is in
another project or doesn't exist, so a refusal never says what another
project holds:

- **Before anything is written.** Publishing or deploying an agent or flow
  that names a tool, agent, flow, guardrail or data block its project
  doesn't reach answers `400 reference-out-of-scope`, with each one in
  `details.issues`. So does starting a run, in a project, of an agent or
  flow that project doesn't reach. For one tool, the message is:
  `This project can't reference tool "<id>": it isn't registered in this project, its org or the tenant`.
- **When it runs.** A tool call from a run whose project doesn't reach the
  tool isn't run: `reference-out-of-scope`,
  `tool "<id>" isn't registered in this project, its org or the tenant`.

## One tool for several clients

A pack's tool stays in its own project, so there are two ways to give
several clients' projects the same tool:

- **Run it as an MCP server,** and register its endpoint for the tenant or
  for one org. Every project there calls the same tool: one service you
  run, and a change made once reaches them all.
- **Copy the pack for each client,** each in its own project. Each copy has
  its own versions and releases, so one client can stay on a version while
  another moves on, and a fix goes into every copy.

## Where values live

A run uses four kinds of values, each kept in its own place.

- **Model keys.** A model provider is the tenant's (on Kindgi Cloud, your
  workspace's), and runs in every project can use it. Its key is a secret
  of an env, read on each model call where the call's run is (runtime
  0.1.9 or later): the run's project's key, else its org's, else the
  tenant's. So a project or an org can have a key of its own, set with
  `kindgi secrets set <KEY_NAME> --env=<env> --scope=project:<project-id>`,
  or `--scope=org:<org-id>`. Unlike a tool's secrets, where it's read isn't
  recorded: a key set later in the run's project is used from the next
  call. A key revoked without `--hard` stops the model calls that read it
  (`secret-revoked`): they don't fall back to a wider scope's key. An older
  runtime reads the tenant's key only
  ([Models](../../guides/models/#keys)).
- **A tool's secrets,** in `ctx.secrets`. Where a tool version reads each
  secret is decided once, when that version is registered, and recorded on
  it. Kindgi looks in the tool's project, then that project's org, then the
  tenant, and records the first that holds the secret. With authorization
  on, only the scopes whoever registers it administers count. If none holds
  the secret yet, a deploy (runtime 0.1.9 or later) records where its
  `--sync-secrets` writes: the project the deploy named, or the tenant for
  a deploy without `--project`. A promotion records where the promoted
  deployment's `--sync-secrets` writes: the project it promotes into, or
  the tenant when that's the Default project. A tool registered any other
  way records the broadest of those scopes: the tenant for a tenant admin,
  the project for a project admin. So does a promotion into the Default
  project by someone who doesn't administer the tenant. That version then
  reads the secret there and nowhere else. A value set later at another scope isn't
  read until a new version of the tool is registered. An MCP endpoint's
  credentials and a webhook trigger's signing secret are also read only at
  a scope recorded for them: when the endpoint is registered, or when the
  trigger names its secret.
- **A tool's env values,** in `ctx.env`. Each call reads the run's
  project's value, else its org's, else the tenant's. A name none of them
  sets takes its default
  ([Give a tool per-project values](../../guides/tools/give-a-tool-env-values/)).
- **The pack service's own environment,** in `process.env` or
  `os.environ`: what your code reads to set itself up.
  [Declare the environment your code reads](../../guides/secrets/pack-env/#in-a-deployment)
  says where a deployment's pack service gets it.

`kindgi deploy --sync-secrets` stores the values in the pack's
`.env.<env>` file as secrets, after the deploy lands: in the project the
deploy named, or the tenant's for a deploy without `--project`. A secret
set nowhere when the deploy ran is read there (runtime 0.1.9 or later),
so set it later in that same place: after
`kindgi deploy --project=<project-id>`, that's
`kindgi secrets set <name> --env=<env> --scope=project:<project-id>`.

Every value belongs to an env, the `--env` you set it with, and a runtime
reads the one it serves. Kindgi Cloud serves one env, `prod`, so every
value there is set with `--env=prod`.

## Values aren't part of a version

An agent version holds the agent: its instructions, the tools and
guardrails it names, and the data blocks it pins. It doesn't hold secrets,
env values or model keys. A run reads those when it runs. So:

- **Several versions can wait** while one is live, and you can run any of
  them by its number:
  `kindgi runs start --agent=<agent-id> --agent-version=<version>`.
- **A value only a new version reads** can be set before you make that
  version live.
- **Changing a value the live version reads** changes live runs from the
  next run, before you make anything live.
- **`--sync-secrets` writes at deploy time,** so it can change what the
  live version reads, though the new version isn't live yet.
- **A conversation keeps its version.** One that's already open goes on
  with the version it started with
  ([Conversations keep their version](../../guides/evals/live-versions-reference/#conversations-keep-their-version)).

On Kindgi Cloud,
[Change your agent once it's live](../../hosted/deploy-your-agent/#change-your-agent-once-its-live)
shows how to try a new version in the same project before you make it
live.
