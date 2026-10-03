---
title: Add Kindgi to an existing app
description: Kindgi inside the app you already have — a Next.js or Node app, or a Python app — so your tools are your app's own code.
sidebar:
  order: 5
---

Kindgi doesn't need a project of its own. Run `kindgi init` in your app and
the pack lives beside your code: its tools import your app's modules, and
your app starts runs through the SDK.

## A TypeScript or Node app

In the app's root (where its `package.json` is), with no pack name:

```sh
npx @kindgi/cli init
pnpm install          # or the app's own package manager
```

`init` adds:

- `kindgi.config.ts`: the pack's id (from the app's name), version, and where
  its primitives live;
- a `kindgi/` folder for them: `kindgi/tools/`, `kindgi/agents/`,
  `kindgi/guardrails/`, `kindgi/flows/`;
- `@kindgi/sdk` (a dependency) and `@kindgi/cli` (a devDependency) in your
  `package.json`, at the CLI's own version;
- the skills for your coding agent under `.claude/skills/`, and
  `.gitignore` entries.

It creates no env files: `kindgi dev` reads your app's own `.env` and
`.env.local`. To keep the pack separate from the app instead, pass
`--new-repo`.

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

Inside `kindgi/`, import the pack's own modules relatively. Don't add an
`__init__.py` to `kindgi/`: the folder would shadow the `kindgi` package.

## Starting runs from your app

Your app calls Kindgi over HTTP, through the SDK's client:

```ts
// TypeScript
import { createClient } from '@kindgi/sdk/client';

const kindgi = createClient({
  apiUrl: process.env.KINDGI_API_URL!,
  auth: { kind: 'apiToken', token: process.env.KINDGI_API_TOKEN! },
});
const run = await kindgi.runs.start({ flow: 'acme.handle-message', input: { email, message } });
```

```python
# Python
from kindgi.client import Kindgi

kindgi = Kindgi()  # KINDGI_API_URL and KINDGI_API_TOKEN from the environment
run = kindgi.runs.start(flow="acme.handle-message", input={"email": email, "message": message})
```

A run can also start in the background (`options: { wait: false }`) and tell
your app when it's done through a signed webhook. See the
[guides](../../guides/).
