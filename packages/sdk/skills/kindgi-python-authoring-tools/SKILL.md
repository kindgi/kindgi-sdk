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
version: "0.1.7"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/src/kindgi/pack/define.py
  - sdks/python/src/kindgi/pack/context.py
  - sdks/python/src/kindgi/pack/service.py
---

# Authoring Kindgi tools in Python

> **Running `kindgi`:** the CLI is `kindgi-cli` from PyPI, pinned in the
> pack's dev group, so every `kindgi <command>` below runs as
> `uv run kindgi <command>` (Poetry: `poetry run kindgi <command>`). Python
> commands run in the pack's environment the same way: `uv run …` (or
> `.venv/bin/python …`).

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
  unannotated parameter, a non-object input, or an input or output
  schema the runtime's compile refuses, such as one with a keyword it
  doesn't know) raise `DefinitionError` where the tool is declared; the
  indexer reports it with the file.

## `ToolContext`

- `ctx.tenant_id` — the tenant the call is for. Key any per-tenant
  state by it.
- `ctx.run_id` — the run (an agent turn or a flow step) the call belongs to.
- `ctx.request_id` — this call, e.g. the model's tool-call id; for logs.
  A model's call id is only unique within one of its answers: don't
  dedupe on it.
- `ctx.idempotency_key` — the same every time this call runs (resumed,
  retried, or run again after a crash), different for every other call. A
  step can run more than once, so a tool that writes passes it to the
  system it writes to (an `Idempotency-Key` header, a client reference, a
  unique column) or looks for it there first: a refund never goes out
  twice. A UUID; `None` outside a run and from a runtime before 0.1.6.
  Docs: https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#make-a-side-effect-happen-once
- `ctx.project_id`, `ctx.org_id` — the run's project, and that project's
  org (`None` when it has none). The runtime sets them from the run, never
  from the input: to check an org or project id the input names, compare
  it with these instead of trusting it.
- `ctx.cancellation` — fires when the call's deadline passes or the
  caller disconnects. An `async def` handler is also cancelled at its
  next `await`. A `def` handler keeps running in its thread: check
  `ctx.cancellation.cancelled`, call `ctx.cancellation.raise_if_cancelled()`,
  or wait with `ctx.cancellation.wait(timeout)` between slow steps.
- `ctx.secrets` — the secrets the tool declares in `needs_spec`,
  resolved for the call's tenant (below).
- `ctx.env` — the env values the tool declares in `needs_spec`, resolved
  for the call: its project's value, else its org's, else the tenant's
  (`kindgi env set NAME <value> --scope=project:<id> --env=<env>`).
  Strings, and not secret. Empty from an older runtime.
- `ctx.config` — **reserved, empty today**.
- `ctx.log` — a logger bound to the call (its records carry the run's ids,
  the tool's id and the trace id): `ctx.log.info("refund issued",
  {"orderId": order_id, "amountCents": amount_cents})`, or the fields as
  keywords. Values go in the fields, never in the message. Log ids,
  amounts and outcomes, never what a person typed (a refund's reason, a
  message, an address): the log is read by whoever operates the runtime.
  `ToolContext.for_test(…)` logs nothing unless you pass it `log=`. Docs:
  https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#log-from-a-tool

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
pack's `.env` and `.env.local`, then Kindgi's own `.kindgi/secrets.env`, where
`kindgi secrets set` writes) — checks it against its schema, and
fails the call, naming the secret, when it is missing or doesn't match.
A declared secret is required, unless its schema names null
(`{"type": ["string", "null"]}`): an optional one the env doesn't have, or
has empty, is absent from `ctx.secrets` (read it with `.get`), and the call
goes on (runtime 0.1.6 or later; an older runtime requires it). In a test, pass them:
`ToolContext.for_test(secrets={"CITATOR_KEY": "…"})`.

A value that differs per tenant, org or project but isn't secret (a base URL, a region, an account id) is an **env value**: declared in `needs_spec`, read from `ctx.env`:

```python
@tool(
    id="acme.find-order",
    mutating=False,
    needs_spec={
        "env": {
            "ORDERS_BASE_URL": {"type": "string", "pattern": "^https://"},
            "ORDERS_REGION": {"type": "string", "enum": ["eu", "us"], "default": "eu"},
        }
    },
)
def find_order(lookup: Lookup, ctx: ToolContext) -> Found:
    """…"""
    return Found(url=f"{ctx.env['ORDERS_BASE_URL']}/{ctx.env['ORDERS_REGION']}/orders/{lookup.order_id}")
```

- **Which value a call gets:** its project's, else its org's, else the tenant's, in the runtime's env; a schema `default` makes a name optional. The values a call used are recorded with it, so a retry or a resume sees the same ones.
- **Setting them:** `kindgi env set ORDERS_REGION us --scope=project:<project-id> --env=local` (or `--scope=tenant`, for every project). Changing a value that's already set takes `--force`.
- **A declared value nobody set** stops the call before the tool runs. For a tool `acme-orders.needs-account` that declares `ACME_ACCOUNT_ID`, the message reads:
  ```text
  precondition-failed: Tool "acme-orders.needs-account" was not run: env-value-missing: tool "acme-orders.needs-account" needs env value "ACME_ACCOUNT_ID" in env "local", and none is set for project e889c1f5-eae7-45dc-8669-5bd029a5d85c, its org, or the tenant. Set it: kindgi env set ACME_ACCOUNT_ID <value> --scope=project:e889c1f5-eae7-45dc-8669-5bd029a5d85c --env=local (or --scope=tenant, for every project)
  ```
- **Not secret:** env values are recorded with each run that uses them and shown in its journal. A credential is a secret, never an env value.
- **In a test:** `ToolContext.for_test(tool=find_order, env={"ORDERS_BASE_URL": "…"})` decides them as a run does: a schema `default` fills a name the test doesn't set, each value is checked, and a missing or invalid one raises `ValueError`.

Everything else comes from the process environment: `os.environ["CITATOR_URL"]`.
The pack service runs with the pack's environment — in `kindgi dev`
that is the pack's `.env` and `.env.local` (or `[tool.kindgi.dev]
envFiles`), restarted when they change; nothing else from your shell
reaches it except `PATH`, `HOME` and `TMPDIR`. Put a setting there by
hand, and keep the env files out of git. A secret stored with `kindgi
secrets set NAME --env=local --scope=tenant` (a no-echo prompt) never
reaches the process environment: declare it and read it from
`ctx.secrets`. A model provider's key reaches no tool at all: a tool
that calls a model declares a key of its own. Declare every name the
code reads in `[tool.kindgi.env]` (`required`, `optional`): in an image
the pack service drops every other variable before your code loads
(`kindgi dev` keeps them), so an undeclared one works locally and is
unset once deployed. `KINDGI_*` names are Kindgi's own settings: a pack
can't declare one.

### Connections to other apps

A tool that acts in another app as a person or as the company (sending mail, opening an issue) declares a **connection**, never a secret holding someone's token, and reads the call's short-lived token from `ctx.connections` (runtime 0.2.0 or later):

```python
import httpx

from kindgi import ConnectionRejected, ToolContext, tool


@tool(
    id="my-pack.send-mail",
    needs_spec={"connections": {"mail": {"app": "google", "permissions": ["gmail.send"], "as": "person"}}},
)
def send_mail(message: Message, ctx: ToolContext) -> Sent:
    """Sends a message from the person's mailbox."""
    mail = ctx.connections["mail"]
    res = httpx.get(url, headers={"authorization": f"Bearer {mail.access_token}"})
    if res.status_code == 401:
        raise ConnectionRejected("mail")
    # …
```

- **Whose connection:** `"as": "person"` is the connection of the person the run acts as (whoever started it, or the owner of the schedule or webhook that did); `"as": "company"` is the company's. The runtime picks it from the run, never from the input or the model. A run that acts as nobody (a service account's, an event's) fails a `"person"` call with `connection-needs-a-person`.
- **The token:** `access_token` is current for this call only. Never keep, print, log or return it; it never reaches the journal. `account.label` says whose account it is (`ana@acme.com`).
- **A 401 from the app:** `raise ConnectionRejected("mail")`, with the connection's name (a second argument can say what the app answered, never the token), or raise your own error `from` it. The runtime renews the token once and runs the call again; refused again, the call fails with `connection-rejected`.
- **An HTTP tool** sends the token with no code: `authorization={"kind": "connection", "connection": "mail"}`.
- **Unattended runs:** in a run no person started, a tool that uses a `"person"` connection waits for that person's yes, reads included: `mutating=False` doesn't lift it. The agent's own approval settings can't lift it; only a trigger's `toolsAllowedUnattended` can, which a project admin sets, as for `needs_approval_when_unattended` (below). In a run a new mail started, the mail is a stranger's text, so two more calls wait: a call of a tool that isn't `mutating=False`, and, when the trigger reads the company's mailbox, a read with the company's connection to that app. The mail trigger's `toolsAllowedUnattended` lifts these too.
- **In a unit test:** `ToolContext.for_test(connections={"mail": ToolConnection(connection_id="c-1", app="google", app_name="Google", access_token="test", account=ConnectionAccount(id="1", label="ana@acme.com"))})`, all from `kindgi`. `ctx.connections` is empty when the tool declares none.

Docs: https://docs.kindgi.com/v0.3/guides/connections/use-a-connection/

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

And it decides what runs together: when a model step asks for several calls at
once, an agent runs calls to read-only tools (no changing effect either) that
come one after another at the same time, up to 8 of them, and any other call
on its own, in the order the model asked. A call that may wait, for another
system's answer or for the person who started the run to connect an app, runs
on its own too. The results reach the conversation and the model in that order
either way. `Agent(..., parallel_tool_calls=False)` runs every call on its
own.

In a run a new mail started, a call of a tool that isn't read-only waits
for a person's yes, unless the mail trigger's `toolsAllowedUnattended`
lists it.

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

## A person's yes when no one is watching: `needs_approval_when_unattended`

`needs_approval_when_unattended=True` declares that a person must say yes to every call of the tool in a run no person started: one a schedule, a webhook, a new mail, an event or a service account's key started. In such a run:

- **An agent's call waits** for a person's yes, whatever the agent's `conversation_policy` says in `hitl["tools"]`. The agent's rules can't lift it: agents are reused, and the tool's author knows what it does.
- **A flow's tool step that calls it is refused.** Put the tool behind an agent step instead, whose call waits.
- **A trigger can lift both, for its own runs only.** A project admin names the tool in a webhook trigger's, a schedule's or a mail trigger's `toolsAllowedUnattended` (`--allow-unattended=<tool-id>` on `kindgi webhooks`, `kindgi schedules` and `kindgi mail-triggers`). In that trigger's runs, the tool is then as in a run a person started. The tenant's approval rules still apply.

In a run a person started (signed in, or with their own API key), the agent's rules decide, as for any tool. Left out, it counts as `False`. Declare it on a tool that moves money or changes something people rely on:

```python
@tool(
    id="acme.refund",
    effects=[{"kind": "writes", "resource": "acme:refunds"}],
    mutating=True,
    needs_approval_when_unattended=True,
)
def refund(request: RefundRequest) -> Refunded:
    """Refunds an order."""
```

Docs: https://docs.kindgi.com/v0.3/guides/approvals/ask-before-a-tool-runs/#when-no-person-started-the-run

## Results that are text from outside: `result_is_outside_data`

`result_is_outside_data=True` says the tool's results are text from outside that nobody checked, such as a mail someone sent or a page a search found. An agent reads each result of the tool as data, not instructions, in that turn and in every later turn's history. It changes what the model is told, not what the tool may do: pair it with approvals for anything an agent could do with what it read. Absent means `false`.

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
  `mutating=False` for a request that changes nothing (a GET, usually), and
  `needs_approval_when_unattended=True` for one that moves money or
  changes something people rely on.
- `timeout_ms` covers the whole call, reading the response included, and
  so does a run's cancel. A response body over 10 MiB, counted after it's
  decompressed, fails the call. So point the tool at an endpoint that
  pages or filters, not one that returns everything.

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
2. **Reading `ctx.config`, or an undeclared `ctx.env` or `ctx.secrets` name.**
   `ctx.config` is empty, and `ctx.env` and `ctx.secrets` hold only what
   `needs_spec` declares; use `os.environ` for the rest.
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
   an agent's tool approval gate asks before it on first use, and an
   agent runs each call to it on its own.
10. **`mutating=False` on a tool that writes.** A dry run then runs it
    for real, and an agent may run it at the same time as other calls.
11. **A package a tool imports, only in a dev group.** The deployed pack
    installs without dev dependencies (`uv sync --no-dev`, or Poetry's
    main group only), so the import works under `kindgi dev` and fails in
    the image. Put what tools import in `[project].dependencies` (in a
    Poetry 1 app, `[tool.poetry.dependencies]`); test and build tools stay
    in dev groups.

12. **Turning the dev sandbox off for a file the tool needs.** Under `kindgi dev`
    the tool's code runs sandboxed: it can't read outside the app (the home
    folder, `~/.aws`) or any `.env*` file, and gets `EPERM` there. A tool that
    needs a path names it in `pyproject.toml`: `[tool.kindgi.dev.sandbox]` `allowRead = ["~/.aws"]`.
    Never set `KINDGI_DEV_SANDBOX=off` or `dev.sandbox: false` to get past it
    (https://docs.kindgi.com/v0.3/guides/secrets/dev-sandbox/).

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package (a schema derived wrong,
a misleading error, the pack service misbehaving) and not in the
tool's code, load `kindgi-framework-feedback` and file it with
`kindgi feedback write`.
