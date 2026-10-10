---
name: kindgi-python-getting-started
description: >
  Getting a Python Kindgi pack running: what a pack is, scaffolding one
  (`kindgi init <name> --template=python`) or adding `[tool.kindgi]` to
  an existing Python app, `uv sync`, `kindgi dev`, the first agent run,
  connecting a real model, flows, calling the Kindgi API from Python
  (`kindgi.client`), and building an image. Load this when a Python
  project has no `[tool.kindgi]` table yet and the user asks to "add
  Kindgi", "make an agent", "set up a pack", or when you are orienting
  in a Python pack (pyproject.toml with `[tool.kindgi]`) for the first
  time. Authoring tools, guardrails and agents is covered by
  kindgi-python-authoring-tools, kindgi-python-authoring-guardrails and
  kindgi-python-authoring-agents; models by kindgi-authoring-providers.
type: core
library: "kindgi (Python)"
version: "0.1.7"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/README.md
  - sdks/python/src/kindgi/pack/config.py
  - sdks/python/src/kindgi/pack/discovery.py
---

# Getting started with Kindgi in Python

> **Running `kindgi`:** the CLI is `kindgi-cli` from PyPI (the Kindgi CLI
> with its own Node, so no Node install), pinned in the pack's dev group.
> Every `kindgi <command>` below runs as `uv run kindgi <command>` (Poetry:
> `poetry run kindgi <command>`). Python commands run in the pack's
> environment the same way: `uv run …`.

## What a pack is

A **pack** is a project Kindgi indexes and runs. Its config is the
`[tool.kindgi]` table of `pyproject.toml`; its primitives live in four
folders, one or more per `.py` file, at module level:

- **Tools** (`tools/*.py`, `@tool`) — your Python code an agent or flow
  calls.
- **Guardrails** (`guardrails/*.py`, `@guardrail`) — checks over an
  agent's turn.
- **Agents** (`agents/*.py`, `Agent(...)`) — data: instructions, tools,
  capabilities. The model runs in Kindgi.
- **Flows** (`flows/*.py`, `Flow(...)`) — data: steps (tool or agent
  nodes) and the edges between them.

Kindgi runs the tools and checks in the pack's own Python process (the
pack service) and calls them over HTTP; everything else runs in the
Kindgi runtime. A module whose name starts with `_` is a helper, not a
primitive; `test_*.py`, `*_test.py` and `conftest.py` are skipped.

## Scaffold a new pack

```sh
uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-pack --template=python
cd my-pack
uv sync            # .venv with the kindgi package and the kindgi CLI
uv run pytest
uv run kindgi dev  # boots Kindgi locally and runs this pack, reloading on save
```

`kindgi dev` needs Postgres: it starts one in Docker unless
`KINDGI_DATABASE_URL` points at yours. It runs the pack with
`.venv/bin/python` (or `dev.python` in `[tool.kindgi]`, e.g.
`["uv", "run", "python"]`), checks that interpreter can import
`kindgi`, and swaps the code on every save.

## Add Kindgi to an existing Python app

In the app's directory (where its `pyproject.toml` is):

```sh
uv add --dev "kindgi-cli>=0.1,<0.2"   # the CLI (Poetry: poetry add --group dev …)
uv run kindgi init     # --pack-id=<id> if the app's name doesn't make one
uv sync                # or what it prints for Poetry / pip
uv run kindgi dev
```

`kindgi init` edits the app's `pyproject.toml` in place — your layout and
comments stay — appending the `[tool.kindgi]` tables (the pack id from
`[project].name`, or `[tool.poetry].name` in a Poetry 1 app; discovery
under `kindgi/`; in a Poetry app, `dev.python` runs `poetry run python`)
and adding `kindgi` to `[project].dependencies`; where it can't edit the
dependencies (Poetry 1, `dynamic`), it prints the command to run. It adds the `kindgi/tools`,
`guardrails`, `agents` and `flows` folders, these skills and `.gitignore`
entries. An app with a `package.json` too gets a TypeScript pack unless you
pass `--template=python`.

The pack root is on `sys.path`, so tools import the app's own packages by
name (`from acme.text import normalize`); inside `kindgi/`, import the pack's
modules relatively. Don't add an `__init__.py` to `kindgi/` — the folder
would then shadow the `kindgi` package. `kindgi dev` reads the app's `.env`
/ `.env.local` — values already there reach the tools as environment
variables; a model provider's key, and a secret stored with `kindgi secrets
set`, don't (a tool reads a secret from `ctx.secrets`). A package a tool imports must be in the app's main dependencies,
not a dev group: the deployed pack installs without dev dependencies (see
`kindgi-python-authoring-tools`).

## Layout of the template

```
my-pack/
├── pyproject.toml                     # [tool.kindgi] — id, version, (discovery, dev, environments)
├── tools/echo.py, tools/greet.py      # @tool
├── guardrails/response_not_empty.py   # @guardrail
├── agents/echo_agent.py               # Agent(...)
├── flows/echo_flow.py                 # Flow(...)
├── tests/test_tools.py                # the tools and the check, called directly
├── README.md
└── .claude/skills/                    # these skills (`kindgi skills sync` refreshes them)
```

The `[tool.kindgi]` keys are the ones `kindgi.config.ts` takes —
`pack`, `discovery`, `dev`, `env`, `environments` — spelled the same.

## First run

With `kindgi dev` running, from another terminal in the pack directory:

```sh
uv run kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
```

The answer comes from `dev-echo`, a **fallback** provider a new pack
gets: no model, no key — it calls the first tool and replies "⚠
dev-echo isn't a real model: …" then "Tool responded: …", and the turn
carries the `fallback-provider` and `dev-echo-not-a-model` warnings. For a
real model, put an LLM provider's key in `.env` and register its preset
(Anthropic below; `kindgi providers presets` lists OpenAI, Gemini, Groq and
OpenRouter too):

```sh
uv run kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # no-echo prompt
uv run kindgi providers register --preset=anthropic
```

It takes over at the next turn. That registration is in this project's dev
database only. To have `kindgi dev` register it on every boot, in every
worktree and after `--reset`, declare it in `pyproject.toml` instead:

```toml
[[tool.kindgi.providers]]
preset = "anthropic"   # its key, ANTHROPIC_API_KEY, from the env files
```

Details and other providers: `kindgi-authoring-providers`.

`uv run python -m kindgi.pack index --pack-dir .` prints what Kindgi
sees (the index); `kindgi dev` reports a broken file with its path and
keeps serving the rest.

## Flows

A flow is data: nodes and edges (`flow.schema.json`). A node's `ref` may
be the `Tool` object:

```python
# flows/record.py
from kindgi import Flow

from ..tools.ledger import record_expense

record = Flow(
    id="acme.ledger.record-flow",
    version="0.1.0",
    nodes=[{"id": "record", "kind": "tool", "ref": record_expense}],
    edges=[
        {"id": "e-start", "from": "$start", "to": "record"},
        {"id": "e-end", "from": "record", "to": "$end"},
    ],
)
```

A node gets its single upstream node's output (the run input after
`$start`), or what its `inputMapping` says: each key a `{"literal": …}`
or a `{"path": …}` rooted at `runInput`, `state` or
`nodeOutputs.<nodeId>`. The indexer checks every flow against the
schema. Run one with `kindgi runs start --flow=<id> --input='{…}'`;
branches, loops and agent steps → `kindgi-python-authoring-flows`.

## Calling Kindgi from Python

`kindgi.client` covers the whole API:

```python
from kindgi.client import Kindgi

client = Kindgi()  # KINDGI_API_URL + KINDGI_API_TOKEN, or Kindgi(url, token=…)
run = client.runs.start(agent="my-pack.echo-agent", input={"userMessage": "Ada"})
print(run.status, run.output["response"]["content"])
for event in client.runs.follow(run.id):  # to the run's end, reconnecting
    print(event.kind)
```

`AsyncKindgi` is the asyncio twin. `kindgi dev` prints the URL and the
token; `.kindgirc.json` in the pack holds them for the CLI.

## Your app and Kindgi's data

When the app keeps something a run did (a ticket a flow triaged, an answer
an agent gave), its own row stores the run's id, in a column such as
`kindgi_run_id` (`run = client.runs.start(flow=…, input=…, options={"wait": False})`,
then `run.id`). The app reads the rest through the API, server side, with
`Kindgi()` from `kindgi.client`:

- **Status, output, timing:** `client.runs.get(run_id)`
  (`GET /v1/runs/{runId}`); status and timing only: `client.runs.progress(run_id)`.
- **The audit, step by step:** `client.runs.journal(run_id).data`
  (`GET /v1/runs/{runId}/journal`).
- **Where an agent's answer came from:** `client.provenance.get(run_id)`
  (`GET /v1/provenance/{runId}`). A flow run has none of its own: each agent
  step's `step.completed` entry in the flow's journal names its turn's run
  (`entry.payload["output"]["runId"]`).
- **What it cost:** `client.cost.records.list(root_run_id=run_id).data`
  (`GET /v1/cost/records?rootRunId={runId}`): one record per model call,
  with its `model`, `usage` (`prompt_tokens`, `completion_tokens`) and
  `cost_usd` (a float, US dollars), a flow's agent steps included. For one
  customer's spend, see below.
- **When a run finished:** the `run.finished` webhook (the run's id, its
  outcome and its cost in `data.run.usage`; no output, so then `runs.get`),
  not polling.

**One customer's spend:** give each customer an org, and start their runs in a
project of that org. Then one call sums their month:

```python
from datetime import datetime, timezone

# Once per customer. Project slugs are unique across the tenant: put the customer in them.
org = client.orgs.create(slug="acme-customer-one", name="Customer one")
project = client.projects.create(org_id=str(org.id), slug="acme-customer-one-app", name="App")
# save org.id and project.id on the customer's row; start their runs with project_id=project.id

now = datetime.now(timezone.utc)
month = client.cost.aggregate(
    group_by="month",
    scope_kind="org",
    scope_id=str(org.id),
    from_=now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(),
    to=now.isoformat(),  # exclusive
)
# month.total_usd; month.groups[i].key ({"month": "2026-10"}), .total_usd, .tokens
```

Docs: https://docs.kindgi.com/v0.1/guides/observability/cost-per-run/

Show it in the app's own UI. **Never:**

- **query Kindgi's database**, even on the app's own Postgres server, and
  never map its tables into the app's ORM (SQLAlchemy, Django models). Its
  schema is private and changes with every release (migrations only go
  forward), row-level security guards every tenant query, and a runtime
  Kindgi hosts gives no database access.
- **link users to Kindgi's console** or any Kindgi UI for this data.

To keep a copy (reporting, search), pull it through the API into the app's
own tables. Docs: https://docs.kindgi.com/v0.1/guides/runs/show-runs-in-your-app/

## Build an image

`kindgi build --env=<name>` (an `[tool.kindgi.environments.<name>]`
block) builds the pack's image. Its dependencies install from the pack's
lockfile, frozen, main dependencies only: `uv.lock` (run `uv lock`
first), or in a Poetry app `poetry.lock` (`poetry lock`; the image brings
its own pinned Poetry). The index is built in the image; the pack service
is its entrypoint. An app with only `requirements.txt` can't build yet.

Debian packages the code needs (OCR, PDF tools, `libmagic`, …) are
declared in `pyproject.toml`; the image installs them, for the build and
at run time:

```toml
[tool.kindgi.image]
system-packages = ["tesseract-ocr", "poppler-utils"]   # names, or name=version
```

The variables the code reads from `os.environ` (a database URL, a bucket)
are declared too, names only. A deployed pack service missing a `required`
one isn't ready, and its `/readyz` names it:

```toml
[tool.kindgi.env]
required = ["DATABASE_URL"]
optional = ["SENTRY_DSN"]
```

A `[tool.uv] required-version` that excludes the image's uv stops the
build before anything uploads, with the range to use.

## Two things need the human

- **The pack id and version** in `[tool.kindgi.pack]`. The id prefixes
  every primitive (`<pack-id>.<name>`); pick it once.
- **Model credentials.** Ask for the key; never invent or hard-code one.

## Keys and tokens: hands off

Never open, read, grep, `cat`, copy or print the files that hold keys and
tokens, and never print their values (`env`, `printenv`, or code that echoes
the process environment):

- `.env`, `.env.local` and any other `.env.*`: the app's settings, and any key
  put there by hand;
- `.kindgi/secrets.env`: Kindgi's own secrets, where `kindgi secrets set` writes;
- `.kindgi/dev/runtime.env`: the dev runtime's token and database URL;
- a self-hosted deployment's `kindgi.env` or `pack.env`.

A value you read lands in your context and in every later request to the
model provider. To see which secrets exist, run
`kindgi secrets list --env=local --scope=tenant` (names only). To store one,
ask the person to run `kindgi secrets set NAME --env=local --scope=tenant`
themselves: it prompts without echoing. Never put a value on a command line.
`kindgi init` adds these files to the deny rules in `.claude/settings.json`.

## Next

- A tool → `kindgi-python-authoring-tools`.
- A guardrail → `kindgi-python-authoring-guardrails`.
- An agent → `kindgi-python-authoring-agents`.
- A flow → `kindgi-python-authoring-flows`.
- A real model → `kindgi-authoring-providers`.
- An external resource (a database) for the coding agent →
  `kindgi-authoring-mcp-servers`.

## Keeping skills up to date

`kindgi skills sync` refreshes `.claude/skills/` from the CLI's copy
(local edits are kept unless `--force`); `kindgi dev` says when they are
out of date.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package and not in the pack's
code, load `kindgi-framework-feedback` and file it with
`kindgi feedback write`.
