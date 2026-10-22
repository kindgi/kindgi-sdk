---
title: Add Kindgi to a Python app
description: Add Kindgi to the Python app you already have, so your tools are your app's own modules.
sidebar:
  order: 5.2
  label: "Existing app: Python"
---

This page adds Kindgi to a Python app you already have. The pack lives
beside your code: its tools import your app's packages.

**Before you start**, set up what the [Install page](../install/) describes:
Python 3.11 or later, uv (or Poetry, or pip), Docker, and access to the
runtime image. In the app's folder,
`uvx --from "kindgi-cli>=0.1,<0.2" kindgi doctor` checks Docker and access to
the runtime image, and says how to fix what's missing. Run it again after
`kindgi init`, and it checks Python and uv too.

In the app's directory (where its `pyproject.toml` is):

```sh
uv add --dev "kindgi-cli>=0.1,<0.2"   # the CLI, pinned to Kindgi's minor version
uv run kindgi init     # --pack-id=<id> if the app's name doesn't make one
uv sync                # or what it prints for Poetry or pip
uv run kindgi dev
```

With Poetry, add the CLI with `poetry add --group dev "kindgi-cli>=0.1,<0.2"`
and run it as `poetry run kindgi`.

The four commands print, in order:

```text
…
 + kindgi-cli==…
 + nodejs-wheel-binaries==24.19.0
…
  Kindgi added to … (a Python pack in the app).
  Pack id: acme    Version: 0.1.0
  Wrote 16 files; skipped 0.
…
 + kindgi==…
…
  No primitives yet — add a tool or agent under kindgi/agents/, kindgi/flows/, kindgi/guardrails/, kindgi/tools/; it registers on save.
…
    ✓ Kindgi is up
…
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

The app's root is on `sys.path`, so a tool imports your packages by name.
Ask your coding agent: "Make a Kindgi tool from our customer order lookup."
Kindgi's skills in your app tell it how
([How it knows Kindgi](../coding-agents/)). For reference, the tool looks
like this:

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

## Next

- [Start runs from your app](../call-from-your-app/): your app calls the
  agent and reads its answer.
- [Write a tool](../../guides/tools/write-a-tool/).
- [The Python SDK reference](../../reference/python/).

<!-- check-samples: stand-ins for your app's own code that the samples above import; the docs' sample check reads them, readers don't see them.

```python
# acme/orders.py
from typing import Any


def find_orders(customer_id: str) -> list[dict[str, Any]]:
    return []
```
-->
