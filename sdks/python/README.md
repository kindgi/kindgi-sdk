# `kindgi` — Kindgi™ for Python

Write a Kindgi pack's **tools** and **guardrail checks** in Python — agents
and flows are data, declared next to them — and call the Kindgi API from
Python. The Kindgi runtime calls your code over
[pack protocol v2](../../packages/specs/schemas/pack-protocol.schema.json) —
the contract its Node pack service speaks, checked by the same
[conformance suite](../../packages/pack-conformance/).

```sh
uv add kindgi        # or: pip install kindgi
```

Requires Python 3.11+. Dependencies: pydantic ≥ 2.10, uvicorn ≥ 0.27, httpx ≥
0.27, jsonschema ≥ 4.18 — CI runs the tests and the pack conformance suite at
those minimums as well as at the lock.

## A pack

```
ledger/
├── pyproject.toml          # [tool.kindgi] — the pack's id and version
├── tools/ledger.py         # @tool
├── tools/_db.py            # a helper (a leading `_`: not a primitive)
├── guardrails/response.py  # @guardrail
├── agents/bookkeeper.py    # Agent(...)
└── flows/record.py         # Flow(...)
```

```toml
# pyproject.toml
[tool.kindgi.pack]
id = "acme.ledger"
version = "1.0.0"
```

The `[tool.kindgi]` table takes the keys `kindgi.config.ts` takes (`pack`,
`discovery`, `dev`, `env`, `environments`, …), spelled the same.

A pack declares the process env its code and libraries read from
`os.environ`, names only; the index carries them:

```toml
[tool.kindgi.env]
required = ["DATABASE_URL"]   # unset or "" → the pack service isn't ready
optional = ["SENTRY_DSN"]     # read when set
```

`KINDGI_*` names configure Kindgi itself and can't be declared.

### Tools

```python
# tools/ledger.py
import os

from pydantic import BaseModel, Field

from kindgi import ToolContext, tool

from ._db import insert_expense


class Expense(BaseModel):
    vendor: str = Field(min_length=1)
    amount_cents: int = Field(alias="amountCents", ge=0)


class Recorded(BaseModel):
    expense_id: str = Field(alias="expenseId")


@tool(id="acme.ledger.record-expense", effects=[{"kind": "writes", "resource": "db:ledger"}])
def record_expense(expense: Expense, ctx: ToolContext) -> Recorded:
    """Records an expense in the ledger."""
    expense_id = insert_expense(os.environ["LEDGER_DATABASE_URL"], ctx.tenant_id, expense)
    return Recorded(expenseId=expense_id)
```

- The input and output schemas come from the handler's annotations — a
  pydantic model, a `TypedDict`, a dataclass, anything pydantic understands —
  or from `input=` / `output=` (a type, or a JSON Schema dict). Field aliases
  are the names on the wire. The input is an object: a model calls a tool with
  an object of arguments.
- The description is the docstring (or `description=`); the version is the
  pack's (or `version=`, an exact semver).
- `mutating=False` declares a tool read-only: it runs in a dry run, and an
  agent with tool approval gates on (and no override or `default` for it)
  doesn't ask before it. Without it a tool may change something (as with
  `mutating=True`).
- The handler is `(input)` or `(input, ctx)`, `def` or `async def`. A `def`
  handler runs in a worker thread, so blocking I/O is fine.
- Before calling you, the pack service validates the input against the schema
  and runs your model's own validators; it validates what you return, too.
- `ctx` carries `tenant_id`, `run_id`, `request_id` and `cancellation`.
  `ctx.secrets` holds the secrets the tool declares
  (`needs_spec={"secrets": {"CITATOR_KEY": {"type": "string"}}}`): the
  runtime resolves them on every call, for the call's tenant, in its env
  (`KINDGI_ENV`; in `kindgi dev`, `local` — the pack's `.env` and
  `.env.local`), and fails the call, naming the secret, when one is missing.
  `ctx.env` and `ctx.config` are reserved and still empty: read other
  configuration from the process environment — the pack service's, which in
  `kindgi dev` is the pack's `.env` and `.env.local`.

**Cancellation.** When a call passes its deadline or the caller disconnects,
the runtime gets `deadline-exceeded` / `cancelled` at once and
`ctx.cancellation` fires. An `async def` handler is also cancelled at its next
`await` (`asyncio.CancelledError`). A `def` handler keeps running in its
thread — check `ctx.cancellation.cancelled`, or wait on it
(`ctx.cancellation.wait(timeout)`), between slow steps.

**Output.** `print()` and logging go to the pack service's own stdout and
stderr (`kindgi dev` shows them as `[pack] …`), never into a response.

**HTTP tools.** A tool that is one HTTP request needs no handler:
`http_tool(...)` declares it, and the Kindgi runtime makes the request (the
counterpart of TypeScript's `defineTool({ spec: { kind: 'http' } })`).

```python
from kindgi import http_tool

lookup_vendor = http_tool(
    id="acme.ledger.lookup-vendor",
    description="Looks a vendor up in the vendor registry.",
    input=VendorRef,
    output=Vendor,
    method="GET",
    url_template="https://vendors.example.com/v1/{vendor_id}",
    authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "VENDORS_TOKEN"}},
)
```

`{name}` placeholders come from the input's fields (each must be one). The
runtime resolves the secret per call, and the spec (`headers`,
`request_body`, `timeout_ms`, `success_status`, …) is checked where it's
declared, against the same schema as TypeScript's. Calling it in Python
raises: it runs in Kindgi.

### Guardrail checks

```python
# guardrails/response.py
from pydantic import BaseModel, Field

from kindgi import CheckResult, RunTrace, guardrail


class Config(BaseModel):
    min_length: int = Field(1, alias="minLength", ge=0)


@guardrail(id="acme.ledger.response-not-empty", on_violation="halt", severity="error")
def response_not_empty(config: Config, trace: RunTrace) -> CheckResult:
    text = (trace.output or "").strip()
    if len(text) < config.min_length:
        return CheckResult(passed=False, reason=f"Response too short ({len(text)} chars)")
    return CheckResult(passed=True)
```

A check is `(config, trace)` and returns a `CheckResult`, a dict with a
boolean `passed`, or a bool. Its config type is the first parameter's
annotation (or `config_type=`); `config=` on the decorator is what it runs
with, keyed as on the wire (`config={"minLength": 20}`), checked against the
type here — without it the check gets `{}`, its defaults. `RunTrace` holds the run's `output`,
`tool_calls`, `tool_results`, `model_calls`, … (snake_case here, camelCase on
the wire). `on_violation` names the action (`halt`, `retry`, `escalate`,
`log-only`, `compensate`); `action=` takes the whole object
(`{"on-violation": "retry", "retry": {"maxAttempts": 2}}`).

### Agents and flows

```python
# agents/bookkeeper.py
from kindgi import Agent

from ..guardrails.response import response_not_empty
from ..tools.ledger import record_expense

bookkeeper = Agent(
    id="acme.ledger.bookkeeper",
    version="1.0.0",
    name="Bookkeeper",
    instructions="Record each expense the user describes with acme.ledger.record-expense.",
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[record_expense],             # Tool objects, or {"id", "version"} refs
    guardrails=[response_not_empty],
)
```

```python
# flows/record.py
from kindgi import Flow

from ..tools.ledger import record_expense

record = Flow(
    id="acme.ledger.record-flow",
    version="1.0.0",
    nodes=[{"id": "record", "kind": "tool", "ref": record_expense}],
    edges=[
        {"id": "e-start", "from": "$start", "to": "record"},
        {"id": "e-end", "from": "record", "to": "$end"},
    ],
)
```

Flows follow [`flow.schema.json`](../../packages/specs/schemas/flow.schema.json);
the indexer checks them against it.

## Imports inside a pack

Each file is imported as part of one package rooted at the pack, so relative
imports work (`from ._db import …`, `from ..tools.ledger import …`), and a
folder named `tools/` or `agents/` never collides with an installed
distribution. The pack root is also on `sys.path`, so an application's own
packages import by name — a pack can live inside an existing app:

```toml
[tool.kindgi.discovery]
tools = "kindgi/tools/**/*.py"
guardrails = "kindgi/guardrails/**/*.py"
agents = "kindgi/agents/**/*.py"
flows = "kindgi/flows/**/*.py"
```

Every module under a discovery folder defines at least one primitive at
module level; helper modules start with `_`. Tests (`test_*.py`, `*_test.py`,
`conftest.py`) are skipped.

## Running it

`kindgi dev` indexes the pack, runs it in a local pack service with the pack's
own interpreter and environment, and swaps the code on every save. Underneath
are two commands you can run yourself:

```sh
python -m kindgi.pack index --pack-dir .                         # → index.json
KINDGI_PACK_SERVICE_TOKEN=… python -m kindgi.pack serve --index index.json
```

`serve` has the Node pack service's process contract: `--index`,
`--module-root` and `--host`; `KINDGI_PACK_SERVICE_TOKEN`, `PORT`,
`KINDGI_PACK_SERVICE_MAX_CONCURRENCY` and `KINDGI_PACK_ENV_CHECK`; JSON log
lines on stderr; SIGTERM drains in-flight calls for up to 8 s.

At startup it checks the index's `env.required`. Under
`KINDGI_PACK_ENV_CHECK=strict` (the default), a name that is unset or `""`
holds `/readyz` and every call at 503 `{"error": "missing env",
"missingEnv": [...]}`; under `warn` it serves. Either way the names are
logged once (`{"kind": "missing-env", …}`) and `/v1/info` lists them in
`missingEnv`.

## Calling the Kindgi API

`kindgi.client` covers every operation of the API — generated from
[`openapi.json`](../../packages/api/openapi.json), so it can't fall behind it.
An operation id `approvals.reviewers.list` is `client.approvals.reviewers.list()`.

```python
from kindgi.client import GuardrailViolationError, Kindgi, paginate

client = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN — or Kindgi(url, token=…)

run = client.runs.start(flow="acme.ledger.record-flow", input={"vendor": "Acme", "amountCents": 1299})
print(run.status, run.output)

try:
    turn = client.runs.start(agent="acme.ledger.bookkeeper", input={"userMessage": "Lunch, $12.99"})
except GuardrailViolationError as blocked:
    print(blocked.violations)

for event in client.runs.stream(str(turn.id)):        # SSE, resumes after a drop
    print(event.kind)

for agent in paginate(client.agents.list, limit=50):  # every page
    print(agent.id)
```

- A request body is a model from `kindgi.client.models`, a mapping, or its
  fields as keywords (snake_case or the wire's camelCase); answers are models.
- Path parameters are positional; query and header parameters keyword-only.
- An operation that takes an `Idempotency-Key` gets one when you pass none, so
  a retry never runs it twice. Calls that are safe to repeat are retried on a
  connection error, 429, 502, 503 or 504 (`max_retries=2`, honouring
  `Retry-After`).
- Errors are typed: `NotFoundError`, `ConflictError`, `InvalidRequestError`,
  `GuardrailViolationError`, `AuthError`, `RateLimitedError`, `ServerError`,
  `NetworkError` — all `KindgiApiError`, with `.status`, `.server_code`,
  `.details` and `.request_id`.
- `AsyncKindgi` is the same with asyncio (`apaginate` for its pages).

A pack's tools can use it to call back into Kindgi (memory, events, other runs).

## Receiving webhooks

Kindgi signs the webhooks it sends (`run.finished`, `webhook.test`; see
[webhooks](https://docs.kindgi.com/v0.1/guides/webhooks/verify-a-webhook/)) in the
[Standard Webhooks](https://www.standardwebhooks.com) format. Verify the
**raw** body, before parsing it, with the secret the endpoint's `secretRef`
names:

```python
import os

from fastapi import FastAPI, Request, Response
from kindgi import webhooks

app = FastAPI()

@app.post("/hooks/kindgi")
async def kindgi_hook(request: Request) -> Response:
    body = await request.body()  # the bytes as sent, never re-serialized JSON
    try:
        delivery = webhooks.verify(os.environ["KINDGI_WEBHOOK_SECRET"], request.headers, body)
    except webhooks.WebhookVerificationError:
        return Response(status_code=401)
    if already_handled(delivery.id):  # delivery is at least once
        return Response(status_code=204)
    event = webhooks.parse_event(body)  # RunFinishedEvent | WebhookTestEvent
    if event.type == "run.finished":
        print(event.data.run.flow_id, event.data.run.status)
    return Response(status_code=204)
```

- `verify` takes the headers as any mapping (Starlette, Django, aiohttp, a
  `dict`), Werkzeug's `Headers` or `http.server`'s, names in any case. It rejects a timestamp
  more than 5 minutes from your clock (`tolerance_seconds=`) and compares in
  constant time; `WebhookVerificationError.reason` says which check failed.
- During a secret rotation requests carry a signature per secret, so the old
  and the new secret both verify.
- `sign` / `signed_headers` make signed requests, for testing a receiver;
  `generate_secret` makes a strong secret.

## Testing your code

A `Tool` and a `Guardrail` stay callable:

```python
from kindgi import ToolContext

def test_record_expense():
    out = record_expense(Expense(vendor="Acme", amountCents=100), ToolContext.for_test())
    assert out.expense_id
```

## Developing this package

With uv 0.12 (`[tool.uv] required-version` in `pyproject.toml`; uv refuses
to run here otherwise, and CI installs its version from that line):

```sh
uv sync                     # .venv with the dev tools
uv run pytest
uv run ruff check src tests && uv run ruff format --check src tests
uv run pyright              # strict
```

The vendored schemas in `src/kindgi/_specs` are copies of `@kindgi/specs`;
`tests/test_specs_drift.py` fails when they drift. The client's
`_models.py` and `_resources.py` are generated —
`uv run python scripts/gen_client.py` after `openapi.json` changes;
`tests/test_client.py` fails while they are out of step. `@kindgi/pack-conformance`
runs its suite against this package's `.venv`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
