---
title: Add Kindgi to an existing app
description: Kindgi inside the app you already have (a Next.js or Node app, or a Python app), so your tools are your app's own code.
sidebar:
  order: 5
---

Kindgi doesn't need a project of its own. Run `kindgi init` in your app and
the pack lives beside your code: its tools import your app's modules, and
your app starts runs through the SDK.

:::tip[Your coding agent can do most of this]
`kindgi init` gives your app Kindgi's skills, in `.claude/skills/`. After
that, you can ask your coding agent instead of following each step: "make
a Kindgi tool from our order lookup", "add an agent that uses it", "run
it". It writes the code next to yours, runs it with `kindgi dev`, and asks
you for your model's key. [How it knows Kindgi](../coding-agents/).
:::

## A TypeScript or Node app

In the app's root (where its `package.json` is), with no pack name:

```sh
npx @kindgi/cli init
pnpm install          # or the app's own package manager
```

:::note[On Kindgi 0.1.0 (fixed in 0.1.1)]
- In a pnpm 11+ app, the first `pnpm install` stops with
  `ERR_PNPM_IGNORED_BUILDS` for `esbuild`. In `pnpm-workspace.yaml`, set
  `esbuild: false` under `allowBuilds:` (replacing pnpm's placeholder), then
  install again. esbuild works without its install script: its native
  binary comes from its `@esbuild/<platform>` package.
- `init` doesn't add Zod, which tools and agents use for their schemas:
  `pnpm add zod`.
:::

`init` adds:

- the pack's config: its id (from the app's name), version, and where its
  primitives live. It's `kindgi.config.ts` in an app whose `package.json`
  says `"type": "module"`, and `kindgi.config.mts` in any other;
- a `kindgi/` folder for the primitives: `kindgi/tools/`, `kindgi/agents/`,
  `kindgi/guardrails/`, `kindgi/flows/`. In an app that isn't
  `"type": "module"`, it also gets a one-line `package.json` that makes
  them ES modules;
- `@kindgi/sdk` (a dependency) and `@kindgi/cli` (a devDependency) in your
  `package.json`, at the CLI's own version, and, from 0.1.1, `zod`;
- from 0.1.1, in a pnpm app, `allowBuilds: { esbuild: false }` in
  `pnpm-workspace.yaml`: pnpm 11+ won't install until every dependency's
  install script has a decision, and esbuild (the CLI's bundler) doesn't
  need its script. A decision the app already has, `true` or `false`, is
  kept;
- the skills for your coding agent under `.claude/skills/`, and
  `.gitignore` entries (`.kindgi/`, `.kindgirc.json`, `.env.local`).

It creates no env files: `kindgi dev` reads your app's own `.env` and
`.env.local`. If your app lints with ESLint, leave out what Kindgi builds:
add `".kindgi/**"` to the `globalIgnores` in `eslint.config.mjs`. To keep
the pack separate from the app instead, pass `--new-repo`.

### Your code as a tool

A tool imports your app's modules like any other file in it, path aliases
(`@/…`) included:

```ts
// kindgi/tools/get-request/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

import { findRequest } from '@/lib/requests'; // your app's own code

const defined = defineTool({
  id: 'acme-support.get-request' as ToolId,
  description: 'Looks up a support request by its id (REQ-1234).',
  version: '0.1.0',
  input: z.object({ id: z.string() }),
  output: z.object({
    found: z.boolean(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  effects: [],
  mutating: false,
  handler: async ({ id }) => {
    const request = findRequest(id);
    return request
      ? { found: true, subject: request.subject, body: request.body }
      : { found: false };
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

Ids start with the pack's id (`acme-support`, from the app's name).
`mutating: false` says the tool only reads, so a dry run may call it.

A package a tool imports (an ORM client such as `@prisma/client`, an API
SDK) must be in your app's `dependencies`, not `devDependencies`: the
deployed pack installs production dependencies only, so a dev-only import
works under `kindgi dev` and fails once deployed. `kindgi dev` warns when a
tool imports one, and `kindgi build` refuses the pack until it moves.
Build-time tools (the `prisma` CLI, `typescript`) stay in `devDependencies`.

### An agent that uses it

```ts
// kindgi/agents/triage/index.ts
import { defineAgent } from '@kindgi/sdk/define';
import type { AgentId, Semver } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineAgent({
  id: 'acme-support.triage' as AgentId,
  version: '0.1.0' as Semver,
  name: 'Triage',
  description: 'Reads a support request and sets its priority.',
  instructions:
    'The user names a support request id. Look it up with `acme-support.get-request`, ' +
    'then answer with its priority and a one-sentence summary.',
  capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
  tools: [{ id: 'acme-support.get-request', version: '^0.1.0' }],
  retrieval: [],
  guardrails: [],
  output: {
    schema: z.object({
      priority: z.enum(['low', 'normal', 'urgent']),
      summary: z.string(),
    }),
  },
  budget: { maxSteps: 4, maxCostUsd: 0.05, maxWallMs: 60_000 },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

`output` makes the answer typed: the model has to answer with JSON that
fits the schema, and your app gets it as an object.

### Run it

```sh
pnpm exec kindgi dev
```

`kindgi dev` builds the pack from `kindgi/`, runs its tools in a process
started from your app's root, and reloads on every save.

Until you register a model, agents answer with `dev-echo`, which only checks
the wiring: it calls the agent's first tool with `{"message": …}` and can't
produce a typed answer, so this agent fails with `output-schema-violation`.
Register a model first:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env.local
pnpm exec kindgi providers register --preset=anthropic
pnpm exec kindgi runs start --agent=acme-support.triage --input='{"userMessage":"Triage REQ-1002"}'
```

```text
  "status": "completed",
…
    "output": {
      "summary": "User unable to log in due to expired password with non-functional password reset email delivery.",
      "priority": "urgent"
    },
```

## A Python app

In the app's directory (where its `pyproject.toml` is):

```sh
npx --yes @kindgi/cli@0.1 init   # --pack-id=<id> if the app's name doesn't make one
uv sync                # or what it prints for Poetry or pip
npx --yes @kindgi/cli@0.1 dev
```

`init` edits your `pyproject.toml` in place, keeping its layout and
comments:

- it adds the `[tool.kindgi]` tables: the pack id from `[project].name`,
  discovery under `kindgi/`, and, in a Poetry app, `dev.python` set to run
  `poetry run python`;
- it adds `kindgi` to `[project].dependencies`. Where it can't edit them
  (Poetry 1, or `dynamic` dependencies), it prints the command to run
  instead.

Then the `kindgi/tools`, `guardrails`, `agents` and `flows` folders, the
Python skills and `.gitignore` entries. An app with both a `package.json`
and a `pyproject.toml` gets a TypeScript pack unless you pass
`--template=python`.

The app's root is on `sys.path`, so a tool imports your packages by name:

```python
# kindgi/tools/orders.py
from typing import Any

from pydantic import BaseModel

from acme.orders import find_orders  # your app's own code
from kindgi import tool


class Customer(BaseModel):
    customer_id: str


class Orders(BaseModel):
    orders: list[dict[str, Any]]


@tool(id="acme.customer-orders", mutating=False)
def customer_orders(input: Customer) -> Orders:
    """The customer's orders, newest first."""
    return Orders(orders=find_orders(input.customer_id))
```

`mutating=False` says the tool only reads, so a dry run may call it.

A package a tool imports must be in your app's main dependencies
(`[project].dependencies`), not a dev group: the deployed pack installs
without dev dependencies, so a dev-only import works under `kindgi dev` and
fails once deployed.

Inside `kindgi/`, import the pack's own modules relatively. Don't add an
`__init__.py` to `kindgi/`: the folder would shadow the `kindgi` package.

## Starting runs from your app

Your app calls Kindgi over HTTP, through the SDK's client.

### Connect your app to the runtime

`kindgi dev` prints the API's URL and a token (`API` and `Token` in its
banner) and writes them to `.kindgirc.json`. Give them to your app as
`KINDGI_API_URL` and `KINDGI_API_TOKEN`; in a Next.js app, in `.env.local`:

```sh
# .env.local
KINDGI_API_URL=http://127.0.0.1:4000
KINDGI_API_TOKEN=kgi_bt_…
```

The token stays the same when you restart `kindgi dev`. `kindgi dev --reset`
starts over with a new tenant and a new token: copy the new token after it.
In production they're your deployment's URL and API token.

### Run an agent and read its answer

```ts
// src/lib/kindgi.ts
import { createClient } from '@kindgi/sdk/client';

export const kindgi = createClient({
  apiUrl: process.env.KINDGI_API_URL!,
  auth: { kind: 'apiToken', token: process.env.KINDGI_API_TOKEN! },
});
```

```ts
// src/app/api/requests/[id]/triage/route.ts
import { KindgiApiError } from '@kindgi/sdk/client';

import { kindgi } from '@/lib/kindgi';

type Triage = { priority: 'low' | 'normal' | 'urgent'; summary: string };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const run = await kindgi.runs.start({
      agent: 'acme-support.triage',
      input: { userMessage: `Triage ${id}` },
    });
    const { output } = run.output as { output: Triage }; // the agent's typed answer
    return Response.json(output);
  } catch (error) {
    if (error instanceof KindgiApiError) {
      const code = error.error.code === 'server' ? error.error.serverCode : error.error.code;
      return Response.json({ error: code, message: error.error.message }, { status: 502 });
    }
    throw error;
  }
}
```

- An agent's input is `{ userMessage }`. `runs.start` waits for the answer.
- `run.output.output` is the typed answer of an agent with an `output`;
  `run.output.response.content` is the answer as text. A flow's
  `run.output` is the flow's own output.
- When the turn fails, or the API refuses the call, `runs.start` throws a
  `KindgiApiError`. `error.error.code` says what kind of failure it is
  (`not-found`, `auth`, `network`, …); for a failure on the server
  (`server`), `error.error.serverCode` is the server's own code, such as
  `output-schema-violation`.

In Python:

```python
from kindgi.client import Kindgi, KindgiApiError

kindgi = Kindgi()  # KINDGI_API_URL and KINDGI_API_TOKEN from the environment
try:
    run = kindgi.runs.start(agent="acme-support.triage", input={"userMessage": "Triage REQ-1002"})
    triage = run.output["output"]
except KindgiApiError as error:
    print(error.code, error.server_code, error.message)
```

### Follow a run as it runs

Start the run with `wait: false` and the call returns as soon as the run
exists. Its events then arrive as they happen, through to its last one:

```ts
// src/app/api/requests/[id]/triage/stream/route.ts
import { kindgi } from '@/lib/kindgi';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await kindgi.runs.start({
    agent: 'acme-support.triage',
    input: { userMessage: `Triage ${id}` },
    options: { wait: false }, // returns as soon as the run exists
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of kindgi.runs.stream(run.id)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
```

Each event has a `kind` (`run.started`, `run.step-started`,
`run.step-completed`, …, `run.completed`) and a `payload`; the
`run.completed` event's `payload.output` is the run's output. In Python,
`kindgi.runs.stream(run.id)` is an iterator of the same events.

A browser can also follow a run directly, with a short-lived read-only
token, without your API token: see
[Follow a run from the browser](../../guides/runs/follow-from-the-browser/).
To be told when a run ends instead, have Kindgi send your app a signed
webhook: see [Get a webhook when a run finishes](../../guides/webhooks/receive-run-finished/).

### Keep what a run did

Store the run's id on your own row (a `kindgi_run_id` column), and read its
status, output, steps and sources through the API when your app shows them.
Never from Kindgi's database, and never by sending users to Kindgi's
console: see [Show runs in your app](../../guides/runs/show-runs-in-your-app/).
