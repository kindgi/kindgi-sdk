---
title: Start runs from your app
description: Your app starts an agent's run through the SDK's client, follows it, and reads its answer, in TypeScript or Python.
sidebar:
  order: 5.45
---

Your app starts runs, follows them and reads their answers through the
SDK's client, which calls Kindgi over HTTP. This page shows it in TypeScript
and in Python. For Java, see [Call Kindgi from a Java app](../java-app/).

**Before you start**, add Kindgi to your app:
[TypeScript or Node](../existing-app-typescript/) or
[Python](../existing-app-python/).

Your app calls Kindgi over HTTP, through the SDK's client.

## Connect your app to the runtime

In development, `kindgi dev` is enough: it writes the API's URL and a token
to `.kindgirc.json`, and the client finds them there, with a one-time warning
to set them. For production, and to silence the warning, give them to your
app as `KINDGI_API_URL` and `KINDGI_API_TOKEN` in your env file (`.env` /
`.env.local`). `kindgi dev` prints them (`API` and `Token` in its banner):

```sh
# .env.local
KINDGI_API_URL=http://127.0.0.1:4000
KINDGI_API_TOKEN=kgi_bt_…
```

The client looks for them when it's first used, not when you create it. So
`const kindgi = createClient()` at the top of a module is safe in a
production build that runs without them: `next build`, for one, loads every
route's module. If they're still missing when your app first uses the client,
that use throws an error that names what to set. Python's `Kindgi()` and
`AsyncKindgi()` do the same, so a module-scope `kindgi = Kindgi()` doesn't
break a build step that imports your app, such as Django's `collectstatic`.
The first request raises `ValueError`, naming what to set.

The banner's first line, `Console`, is the console's address
(`http://127.0.0.1:4000/console/`; `kindgi console` opens it). Sign in there
with **Sign in as seeded user**, or with the same token.

The token stays the same when you restart `kindgi dev`. `kindgi dev --reset`
starts the project over, dropping its database
([after asking](../install/#where-kindgi-dev-keeps-its-data)), with a new
token: copy the new token after it (the client warns when the token in your
env file no longer matches).
In production they're your deployment's URL and API token. To pass them
yourself instead: `createClient({ apiUrl, auth: { kind: 'apiToken', token } })`,
or `Kindgi(url, token=…)` in Python.

## In a CommonJS app

An app that isn't `"type": "module"`, or that compiles to CommonJS, loads
the client with `require()`:

```js
const { createClient } = require('@kindgi/sdk/client');
```

- **Node 22.12 or later.** The SDK is ES modules, and Node's `require()`
  loads ES modules from 22.12 on.
- **TypeScript that compiles to CommonJS:** TypeScript 5.8 or later, with
  `"module": "nodenext"`. In an app a bundler builds, `"moduleResolution":
  "bundler"` works too. With `"moduleResolution": "node10"` (or `"node"`),
  TypeScript doesn't find the SDK's types.

Pack code (`kindgi/`) is ES modules in every app; `init` sets that up.

## Run an agent and read its answer

Ask your coding agent: "I want our app to run the triage agent on a support
request and use its answer." For reference, the code looks like this:

```ts
// src/lib/kindgi.ts
import { createClient } from '@kindgi/sdk/client';

export const kindgi = createClient(); // KINDGI_API_URL, KINDGI_API_TOKEN, or the running kindgi dev
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
# triage.py
from kindgi.client import Kindgi, KindgiApiError

kindgi = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN, or the running kindgi dev
try:
    run = kindgi.runs.start(agent="acme-support.triage", input={"userMessage": "Triage REQ-1002"})
    if run.output is None:  # a run that didn't complete has no output
        raise SystemExit(f"Run {run.id} ended {run.status}: {run.failure_message}")
    triage = run.output["output"]
except KindgiApiError as error:
    print(error.code, error.server_code, error.message)
```

## Follow a run as it runs

Start the run with `wait: false` and the call returns as soon as the run
exists. Its events then arrive as they happen, through to its last one. Ask
your coding agent: "I want our app to stream the triage run's progress
live." For reference, the route looks like this:

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
      for await (const event of kindgi.runs.follow(run.id)) {
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
`kindgi.runs.follow(run.id)` is an iterator of the same events, through to
the run's end.

A browser can also follow a run directly, with a short-lived read-only
token, without your API token: see
[Follow a run from the browser](../../guides/runs/follow-from-the-browser/).
To be told when a run ends instead, have Kindgi send your app a signed
webhook: see [Get a webhook when a run finishes](../../guides/webhooks/receive-run-finished/).

## Keep what a run did

Store the run's id on your own row (a `kindgi_run_id` column), and read its
status, output, steps and sources through the API when your app shows them.
Never from Kindgi's database, and never by sending users to Kindgi's
console: see [Show runs in your app](../../guides/runs/show-runs-in-your-app/).

## Next

- [Follow a run](../../guides/runs/follow-a-run/): every way to watch one.
- [Show runs in your app](../../guides/runs/show-runs-in-your-app/).
- [Retry a start safely](../../guides/runs/retry-a-start-safely/).

<!-- check-samples: stand-ins for your app's own code that the samples above import; the docs' sample check reads them, readers don't see them.

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*.ts", "kindgi/**/*.ts"]
}
```
-->
