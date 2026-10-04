---
name: kindgi-python-authoring-tools
description: >
  Covers writing tools for a Kindgi pack in Python (the `kindgi`
  package): the `@tool` decorator, input and output schemas from pydantic
  models / TypedDicts / dataclasses (or JSON Schema), sync and async
  handlers, `ToolContext` and cancellation, reading configuration and
  secrets, errors, tool id and version conventions, unit tests, and
  wiring a tool onto an agent. Load this whenever you are authoring or
  editing code inside a Python pack's tools/ directory (a pack whose
  config is `[tool.kindgi]` in pyproject.toml), defining a tool, or
  wiring one onto an agent. Python agents are covered by
  kindgi-python-authoring-agents, getting started by
  kindgi-python-getting-started.
type: core
library: "kindgi (Python)"
version: "0.1.1"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/src/kindgi/pack/define.py
  - sdks/python/src/kindgi/pack/context.py
  - sdks/python/src/kindgi/pack/service.py
---

# Authoring Kindgi tools in Python

> **Running `kindgi`:** a Python pack has no Node project, so the
> `kindgi` CLI is the one on `PATH`. Python commands run in the pack's
> environment: `uv run …` (or `.venv/bin/python …`).

A **tool** is a unit of work an agent (or a flow step) calls: typed
input, typed output, your code in between. In a Python pack it is a
function decorated with `@tool` at module level in a file under
`tools/`. Kindgi runs it in the pack's own Python process (the pack
service) and calls it over HTTP; the model sees its id, description and
input schema.

Before writing one, establish what it should **do** — what it computes
or fetches, what the caller provides, what it returns. "Add a tool" is
a conversation opener. The pack's sample tools prove the runtime works;
they are not the shape to copy unless the user asks.

## A tool

```python
# tools/citations.py
import os

from pydantic import BaseModel, Field

from kindgi import ToolContext, tool

from ._citator import lookup   # a helper module: the leading `_` keeps it out of discovery


class Citation(BaseModel):
    citation: str = Field(min_length=1)
    jurisdiction: str = Field(pattern="^(US|UK|EU)$")


class Verdict(BaseModel):
    found: bool
    canonical_cite: str | None = Field(None, alias="canonicalCite")


@tool(id="acme.verify-citation")
def verify_citation(citation: Citation, ctx: ToolContext) -> Verdict:
    """Verify a legal citation against the citator; returns whether it resolves and its canonical form."""
    hit = lookup(os.environ["CITATOR_URL"], citation.citation, citation.jurisdiction)
    return Verdict(found=hit is not None, canonicalCite=hit)
```

- **Id** — `<pack-id>.<tool-name>`, kebab-case, dot-namespaced.
- **Description** — the docstring, or `description=`. The model reads
  it to decide when to call the tool: say what it does and returns.
- **Version** — the pack's version, or `version=` (an exact semver).
- **Schemas** — from the annotations: the first parameter is the input,
  the return annotation the output. A pydantic model, a `TypedDict`, a
  dataclass — anything pydantic understands — or `input=` / `output=`
  (a type, or a JSON Schema dict). **Field aliases are the names on the
  wire** — use them for camelCase (`alias="canonicalCite"`), and
  construct the model with the alias. The input must be an **object**:
  a model calls a tool with an object of arguments.
- **Handler** — `(input)` or `(input, ctx)`; `def` or `async def`. A
  `def` handler runs in a worker thread, so blocking I/O is fine; an
  `async def` one runs on the event loop — don't block it (use an async
  client, or `asyncio.to_thread`).
- **Validation** — before your handler runs, the input is checked
  against the schema (JSON Schema defaults filled in) and your model's
  own validators run; what you return is validated against the output
  schema. A bad input comes back as `input-validation-failed` with the
  field's path (a bad output as `output-validation-failed`); the agent's
  `tool_errors` policy decides whether the model gets to fix the call.
- **Problems in the declaration** (a missing docstring, an
  unannotated parameter, a non-object input) raise `DefinitionError`
  where the tool is declared; the indexer reports it with the file.

## `ToolContext`

- `ctx.tenant_id` — the tenant the call is for. Key any per-tenant
  state by it.
- `ctx.run_id` — the run (an agent turn or a flow step) the call belongs to.
- `ctx.request_id` — this call, e.g. the model's tool-call id; useful
  for logs and idempotency keys.
- `ctx.cancellation` — fires when the call's deadline passes or the
  caller disconnects. An `async def` handler is also cancelled at its
  next `await`. A `def` handler keeps running in its thread: check
  `ctx.cancellation.cancelled`, call `ctx.cancellation.raise_if_cancelled()`,
  or wait with `ctx.cancellation.wait(timeout)` between slow steps.
- `ctx.secrets` — the secrets the tool declares in `needs_spec`,
  resolved for the call's tenant (below).
- `ctx.env`, `ctx.config` — **reserved, empty today**.

## Configuration and secrets

A secret that belongs to the tenant — an API key a customer gives you —
is declared, and read from `ctx.secrets`:

```python
@tool(
    id="acme.verify-citation",
    needs_spec={"secrets": {"CITATOR_KEY": {"type": "string", "minLength": 20}}},
)
def verify_citation(citation: Citation, ctx: ToolContext) -> Verdict:
    """…"""
    key = ctx.secrets["CITATOR_KEY"]
```

The runtime resolves every declared secret on every call — for the
call's tenant, in its env (`KINDGI_ENV`; in `kindgi dev`, `local`: the
pack's `.env` and `.env.local`) — checks it against its schema, and
fails the call, naming the secret, when it is missing or doesn't match.
Every declared secret is required. In a test, pass them:
`ToolContext.for_test(secrets={"CITATOR_KEY": "…"})`.

Everything else comes from the process environment: `os.environ["CITATOR_URL"]`.
The pack service runs with the pack's environment — in `kindgi dev`
that is the pack's `.env` and `.env.local` (or `[tool.kindgi.dev]
envFiles`), restarted when they change; nothing else from your shell
reaches it except `PATH`, `HOME` and `TMPDIR`. Put a secret there by
hand or with `kindgi secrets set NAME --env=local --scope=tenant` (a
no-echo prompt), and keep the env files out of git. `KINDGI_*` names
are Kindgi's own settings and never reach pack code.

## Errors and output

- Raise an exception for a failure: the call fails with
  `handler-throw` and the exception's message. In an agent turn the
  failure goes to the model only when the agent's `tool_errors` policy
  includes `tool-error` — retrying must be safe for that tool.
- `print()` and `logging` go to the pack service's stdout/stderr
  (`kindgi dev` shows them as `[pack] …`), never into a result.

## Other declarations

**`mutating=False`** declares a tool read-only: it changes nothing
outside itself (a lookup, a search, a calculation). A read-only tool
runs in a dry run (`kindgi runs start --dry-run`). Leave it out — or
`mutating=True` — for anything that writes, sends or deletes: such a
tool stops a dry run.

It also sets the tool's approval default. An agent that turns tool
approval gates on (`conversation_policy={"hitl": {"tools": {...}}}`)
and has neither an override for the tool nor a `default` doesn't ask
before a read-only tool, and asks before any other on first use.

```python
@tool(id="acme.find-citations", mutating=False)
def find_citations(query: CitationQuery) -> Citations:
    """Searches the citator. Changes nothing."""
```

`@tool(...)` also takes `effects=` (side effects, e.g.
`[{"kind": "writes", "resource": "db:ledger"}]`; a dry run also stops at
a tool with a `writes`, `deletes`, `spawns-run`, `emits-event` or
`external-side-effect` effect), `needs=` / `needs_spec=`, `sandbox=`,
`limits=` and `network=`. They are recorded in the pack's index for
policy and review; declare what the tool really does.

## HTTP tools — one request, no code

A tool that is a single HTTP request needs no handler. `http_tool(...)`
declares the request; the Kindgi runtime makes it (TypeScript's
`defineTool({ spec: { kind: 'http' } })`):

```python
# tools/citator.py
from kindgi import http_tool

lookup_case = http_tool(
    id="acme.lookup-case",
    description="Looks a case up in the citator by court and number.",
    input=CaseRef,                  # pydantic models, as for @tool
    output=CaseRecord,
    method="GET",
    url_template="https://citator.example.com/{court}/{case_number}",
    headers={"Accept": "application/json"},
    authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "CITATOR_KEY"}},
)
```

- `{name}` placeholders in `url_template` are filled from the input's
  fields, URL-encoded; each must be a field of the input model, or the
  indexer reports it.
- `authorization`: `{"kind": "bearer", "secretRef": …}` or
  `{"kind": "header", "headerName": "X-Api-Key", "secretRef": …}`. The
  runtime resolves the secret on every call — `envName` `local` is the
  pack's `.env` under `kindgi dev` — and fails the call, naming it, when
  it's missing.
- `request_body`: `{"kind": "json-input"}` (the input's fields the URL
  didn't use, as JSON — the default for POST, PUT and PATCH),
  `{"kind": "input-passthrough"}` (the whole input), or
  `{"kind": "text", "template": "…{field}…"}` (sent as `text/plain`).
- Also `timeout_ms=` (default 30000), `parse_json=` (default `True`),
  `success_status=(200, 299)`, `effects=`, `version=`, and
  `mutating=False` for a request that changes nothing (a GET, usually).

The spec is checked where it's declared, against the same schema as
TypeScript's. Calling the tool in Python raises: it runs in Kindgi, so
test it through `kindgi dev` (`kindgi runs start --flow=…`). Anything
more than one request — paging, retries, shaping the answer — is a
`@tool` handler with `httpx`.

## Testing

A `Tool` is still callable — test the function directly:

```python
# tests/test_citations.py — the template's pytest config puts the pack root on sys.path
from kindgi import ToolContext
from tools.citations import Citation, verify_citation


def test_unknown_citation(monkeypatch):
    monkeypatch.setenv("CITATOR_URL", "http://citator.test")
    out = verify_citation(Citation(citation="1 U.S. 1", jurisdiction="US"), ToolContext.for_test())
    assert out.found is False
```

`ToolContext.for_test(tenant_id=…, run_id=…)` builds a context.
`uv run pytest` runs the pack's tests (`test_*.py` files are never
indexed). `uv run python -m kindgi.pack index --pack-dir .` shows the
schemas Kindgi derives.

## Wiring the tool onto an agent

Pass the `Tool` object — it pins that tool's version:

```python
from ..tools.citations import verify_citation

brief_writer = Agent(..., tools=[verify_citation])
```

or a ref with a semver **range**, `{"id": "acme.verify-citation",
"version": "^0.1.0"}`: the highest active version matching it is picked
at turn start. A bare string is not a tool ref. In a flow, a node's
`ref` may be the `Tool` object too.

## Iterating

Save the file; `kindgi dev` rebuilds and the next call runs the new
code (a syntax error is reported `file:line:col` and the previous code
keeps serving). Bump `version` when callers' contract changes — a
removed field, a narrower type — not on every save.

## Common mistakes

1. **Copying the sample tool's shape without asking what the tool should do.**
2. **Reading `ctx.env` / `ctx.config`, or an undeclared `ctx.secrets` name.**
   The first two are empty, and `ctx.secrets` holds only what `needs_spec`
   declares; use `os.environ` for the rest.
3. **A non-object input** (`def f(n: int)`): the input must be a model,
   TypedDict, dataclass or object schema.
4. **No docstring and no `description=`**, or an unannotated input or
   return: `DefinitionError`.
5. **Snake_case on the wire.** Without an alias, the field name *is* the
   wire name; add `alias="camelCase"` (and build models with the alias).
6. **Defining the tool inside a function, or a helper module without a
   leading `_`** under `tools/` — the first is never found; the second is
   indexed and must define a primitive.
7. **Absolute imports of sibling pack modules inside the pack**
   (`from tools._db import …` in `tools/x.py`): Kindgi imports the pack's
   files as one package, so use relative imports there (`from ._db import
   …`); import your app's own packages by name. (Tests are not pack
   modules — the template's import `tools.x` directly.)
8. **Blocking inside `async def`.** Use a `def` handler for blocking I/O.
9. **A read-only tool without `mutating=False`.** A dry run stops at it,
   and an agent's tool approval gate asks before it on first use.
10. **`mutating=False` on a tool that writes.** A dry run then runs it
    for real.
11. **A package a tool imports, only in a dev group.** The deployed pack
    installs without dev dependencies (`uv sync --no-dev`, or Poetry's
    main group only), so the import works under `kindgi dev` and fails in
    the image. Put what tools import in `[project].dependencies` (in a
    Poetry 1 app, `[tool.poetry.dependencies]`); test and build tools stay
    in dev groups.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package (a schema derived wrong,
a misleading error, the pack service misbehaving) and not in the
tool's code, load `kindgi-framework-feedback` and file it with
`kindgi feedback write`.
