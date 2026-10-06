---
name: kindgi-getting-started
description: >
  Bootstrap a Kindgi pack from scratch: scaffold with
  kindgi init, understand the pack layout (tools / agents /
  guardrails / flows), boot the dev harness with kindgi dev, and hit
  the first end-to-end run with kindgi runs start. Load this when a
  project has no kindgi.config.ts yet and the user asks to "add
  Kindgi", "create a pack", "scaffold a Kindgi pack", "start a
  new pack", or when the user needs the mental model for what a Kindgi
  pack IS. Once the pack is scaffolded and you are authoring code,
  switch to kindgi-authoring-tools / kindgi-authoring-agents /
  kindgi-authoring-guardrails / kindgi-authoring-flows for the specific
  primitive.
type: core
library: "@kindgi/sdk"
version: "0.3.8"
sdk_version: "0.0.0"
pack_languages: [node]
---

# Getting started with Kindgi

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

Scaffold a Kindgi pack — a versioned, deployable bundle
of tools, agents, guardrails, and flows — and run it end-to-end
locally.

## What a pack IS

A pack is one directory containing four primitive kinds authored via
`@kindgi/sdk`:

- **Tools** (`tools/<name>/index.ts`) — callable units of work.
- **Agents** (`agents/<name>/index.ts`) — LLM orchestrators that call
  tools.
- **Guardrails** (`guardrails/<name>/index.ts`) — safety checks that
  gate agent turns.
- **Flows** (`flows/<name>/index.ts`) — declarative workflows
  composing multiple nodes.

Each primitive is a single TypeScript file whose default export is the
definition: `defineTool` / `defineAgent` / `defineFlow` build tools,
agents and flows; a guardrail file default-exports its declaration and
builds its check with `defineCheck` (see
`kindgi-authoring-guardrails`). The pack indexer discovers them by
folder convention.

## Scaffold

**A new pack:**

```bash
npx @kindgi/cli init my-pack
cd my-pack
pnpm install
```

**Kindgi inside an existing app** (Next.js, NestJS, …) — in the app's
root, no pack name:

```bash
npx @kindgi/cli init
pnpm install          # or the app's own package manager
```

This adds `kindgi.config.ts` and a `kindgi/` folder beside the app's code,
and never creates env files: `kindgi dev` reads the app's own `.env` /
`.env.local`. A package a tool imports must be in the app's `dependencies`,
not `devDependencies`: the deployed pack installs production dependencies
only (see `kindgi-authoring-tools`).

Either way, `init` adds `@kindgi/sdk` and `@kindgi/cli` to the project's
`package.json`, so the project runs the `kindgi` it pins — never a global
one. (`npx @kindgi/cli` is the scoped package; a bare `npx kindgi` would
fetch an unrelated package.)

Two templates:

- `--template=minimal` (default) — folder structure only, no example
  primitives. Right when you know what you want to build.
- `--template=sample` — worked kitchen-sink example (echo tool + agent
  + guardrail + flow). Right for exploring the primitive kinds.

## Boot the dev harness

```bash
pnpm exec kindgi dev
```

`kindgi dev` boots a local Kindgi runtime (starting the services it
needs on first run), indexes the pack, registers every primitive, and
re-registers on every save. The banner prints the API URL, the seeded
bearer token, and (if the console is bundled) the `/console/` URL.

Each git worktree of the project can run its own `kindgi dev` at the same
time, with its own runtime, database, tenant and token. Give each one its
own port (`pnpm exec kindgi dev --port 4001`): only one can have the default
4000. Ctrl+C or `--reset` in one leaves the others alone.

Until a model provider is registered, agents answer with `dev-echo`, a
stand-in that calls the agent's first tool with `{"message": <userMessage>}`
and replies with what the tool returned. It checks the wiring only: it can't
fill in any other tool input or produce a typed `output` (that turn fails
with `output-schema-violation`). Register a provider
(`kindgi-authoring-providers`) before building a real agent.

## First run

From a second terminal, with `cd my-pack`:

```bash
pnpm exec kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"hi"}'
```

`my-pack.echo-agent` is the agent the `sample` template ships (`<pack-id>.echo-agent`);
a `minimal` pack has no agent until you write one.

The CLI reads `.kindgirc.json` (auto-written by `kindgi dev`) for the
API URL + token, so second-terminal commands work without flags.

Once you author your own agent, run it by its own id.

## Layout

```
my-pack/
├── kindgi.config.ts        # pack id + version + discovery patterns
├── package.json               # @kindgi/sdk + zod; devDependency @kindgi/cli
├── tsconfig.json
├── .claude/
│   └── skills/                # auto-copied from @kindgi/sdk on init
├── tools/                  # place `<name>/index.ts` per tool
├── agents/                    # place `<name>/index.ts` per agent
├── guardrails/                # place `<name>/index.ts` per guardrail
└── flows/                    # place `<name>/index.ts` per flow
```

## Next steps

When authoring a primitive, switch to the specific skill:

- **Adding a tool** → `kindgi-authoring-tools`
- **Adding an agent** → `kindgi-authoring-agents`
- **Adding a guardrail** → `kindgi-authoring-guardrails`
- **Adding a flow** → `kindgi-authoring-flows`

Each of those skills is auto-loaded when working in the corresponding
folder or when the user's request mentions the primitive kind.

## Two things need the human

Most of the setup is automatable, but two require your knowledge:

- **The pack id + version** in `kindgi.config.ts` — the pack id
  becomes the namespace prefix (`<pack-id>.<primitive-name>`) for
  every primitive. Pick a stable kebab-case name; changing it later
  breaks all published references.
- **Real LLM provider credentials** — the built-in dev-echo provider
  returns canned responses (great for the loop test, useless for real
  agents). It is a fallback, so it steps aside once a real provider is
  registered. Declare it in `kindgi.config.ts`
  (`providers: [{ preset: 'anthropic' }]`, the key in `.env`) and `kindgi dev`
  registers it on every boot, in every worktree and after `--reset`; or once,
  by hand: `kindgi providers register --preset=anthropic`. See
  `kindgi-authoring-providers`.

## Your app and Kindgi's data

When the app keeps something a run did (a ticket a flow triaged, an answer
an agent gave), its own row stores the run's id, in a column such as
`kindgi_run_id`. The app starts the run and reads the rest through the API,
server side, with `createClient()` from `@kindgi/sdk/client`:

```ts
import { createClient } from '@kindgi/sdk/client';

const kindgi = createClient(); // KINDGI_API_URL + KINDGI_API_TOKEN
const run = await kindgi.runs.start({
  flow: 'my-pack.triage-ticket',
  input: { ticketId },
  options: { wait: false }, // the run id now; run.finished tells you when it ends
});
// save run.id as the ticket's kindgi_run_id
```


- **Status, output, timing:** `kindgi.runs.get(runId)`
  (`GET /v1/runs/{runId}`); status and timing only: `kindgi.runs.progress(runId)`.
- **The audit, step by step:** `kindgi.runs.journal(runId)`
  (`GET /v1/runs/{runId}/journal`).
- **Where an agent's answer came from:** `kindgi.provenance.get(runId)`
  (`GET /v1/provenance/{runId}`). A flow run has none of its own: each agent
  step's `step.completed` entry in the flow's journal names its turn's run
  (`payload.output.runId`).
- **What it cost:** `kindgi.cost.usage.query({ rootRunId: runId })`
  (`GET /v1/cost/records?rootRunId={runId}`): `.items`, one record per model
  call, with its `model`, `usage` (`promptTokens`, `completionTokens`) and
  `costUsd` (a number, US dollars), a flow's agent steps included. For one
  customer's spend, see below.
- **When a run finished:** the `run.finished` webhook (the run's id, its
  outcome and its cost in `data.run.usage`; no output, so then `runs.get`),
  not polling.

**One customer's spend:** give each customer an org, and start their runs in a
project of that org. Then one call sums their month:

```ts
import type { Timestamp } from '@kindgi/sdk/types';

// Once per customer. A project's slug is unique in its org, so every customer can have an `app` project.
const org = await kindgi.orgs.create({ slug: 'acme-customer-one', name: 'Customer one' });
const project = await kindgi.projects.create({ orgId: org.id, slug: 'app', name: 'App' });
// save org.id and project.id on the customer's row; start their runs with projectId: project.id

const now = new Date();
const month = await kindgi.cost.usage.summary({
  scope: { kind: 'org', orgId: org.id },
  from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() as Timestamp,
  to: now.toISOString() as Timestamp, // exclusive
  groupBy: ['month'],
});
// month.totalUsd; month.groups[i].key ({ month: '2026-10' }), .totalUsd, .tokens
```

Docs: https://docs.kindgi.com/v0.1/guides/observability/cost-per-run/

Show it in the app's own UI. **Never:**

- **query Kindgi's database**, even on the app's own Postgres server, and
  never map its tables into the app's ORM. Its schema is private and changes
  with every release (migrations only go forward), row-level security guards
  every tenant query, and a runtime Kindgi hosts gives no database access.
- **link users to Kindgi's console** or any Kindgi UI for this data.

To keep a copy (reporting, search), pull it through the API into the app's
own tables. Docs: https://docs.kindgi.com/v0.1/guides/runs/show-runs-in-your-app/

## References

- Full CLI surface: `kindgi --help`.
- SDK hover docs: every `@kindgi/sdk/define` + `@kindgi/sdk/types`
  export ships with JSDoc — hover in your editor.
- Companion API docs: `pnpm --filter @kindgi/sdk exec typedoc`
  regenerates markdown at `packages/sdk/docs/`.

## Keeping skills up to date

Skills in `.claude/skills/` are copied at `kindgi init` time. When the
framework SDK ships a new version of a skill (better docs, corrected
example, new capabilities), the pack's local copy stays stale until
you resync. `kindgi dev` boot prints a warning when it detects drift;
run `kindgi skills sync` to pull the latest framework skills.
Local edits are preserved by default (marked `skipped-modified`);
pass `--force` to overwrite them.

## When the framework itself is the problem

Kindgi is early. You will hit rough edges — SDK type drift, wire
schemas that silently drop a field, misleading error messages, CLI
friction. When you diagnose that the bug is in the framework (not in
your pack), load the `kindgi-framework-feedback` skill and file a
structured report with `kindgi feedback write`. Your diagnostic is
exactly what the maintainers need.
