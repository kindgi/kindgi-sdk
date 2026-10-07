---
name: kindgi-python-authoring-guardrails
description: >
  Covers writing guardrails (safety checks on an agent's turn) for a
  Kindgi pack in Python (the `kindgi` package): the `@guardrail`
  decorator over a `(config, trace)` check, `RunTrace` and
  `CheckResult`, config models, actions (halt / retry / escalate /
  log-only / compensate), severity and scope, unit tests, and wiring a
  guardrail onto an agent. Load this whenever you are authoring or
  editing code inside a Python pack's guardrails/ directory (a pack
  whose config is `[tool.kindgi]` in pyproject.toml), defining a check,
  or wiring a guardrail onto an agent. Python agents are covered by
  kindgi-python-authoring-agents, Python tools by
  kindgi-python-authoring-tools.
type: core
library: "kindgi (Python)"
version: "0.1.2"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/src/kindgi/pack/define.py
  - sdks/python/src/kindgi/pack/trace.py
  - sdks/python/src/kindgi/pack/service.py
---

# Authoring Kindgi guardrails in Python

> **Running `kindgi`:** the CLI is `kindgi-cli` from PyPI, pinned in the
> pack's dev group, so every `kindgi <command>` below runs as
> `uv run kindgi <command>` (Poetry: `poetry run kindgi <command>`). Python
> commands run in the pack's environment the same way: `uv run …` (or
> `.venv/bin/python …`).

A **guardrail** is a rule an agent's turn must satisfy: a **check** (a
function over the turn's trace) plus an **action** (what happens when it
fails). In a Python pack, `@guardrail(...)` on a function at module
level in a file under `guardrails/` declares both. For an agent turn,
the runtime evaluates every guardrail the agent lists once, on the final
answer, before it is stored.

Ask what the rule should catch before writing one; the sample
`response-not-empty` guardrail is a demonstration, not a template.

## A guardrail

```python
# guardrails/citations.py
from pydantic import BaseModel, Field

from kindgi import CheckResult, RunTrace, guardrail


class Config(BaseModel):
    min_lookups: int = Field(1, alias="minLookups", ge=0)


@guardrail(
    id="acme.no-fabricated-quotes",
    name="No fabricated quotations",
    on_violation="halt",
    severity="critical",
    config={"minLookups": 2},   # what the check runs with — keyed as on the wire
)
def no_fabricated_quotes(config: Config, trace: RunTrace) -> CheckResult:
    lookups = [c for c in trace.tool_calls if c.tool_name == "acme.verify-citation"]
    if len(lookups) < config.min_lookups:
        return CheckResult(
            passed=False,
            reason=f"Only {len(lookups)} citation lookups (need {config.min_lookups}+).",
        )
    return CheckResult(passed=True)
```

- **The check** is `(config, trace)`, `def` or `async def`, and returns a
  `CheckResult`, a dict with a boolean `"passed"`, or a `bool`. A failed
  result's `reason` is what the violation reports — make it say what was
  wrong.
- **`trace`** is a `RunTrace` (snake_case here, camelCase on the wire):
  `output` (the final answer text), `tool_calls` (`tool_id`,
  `tool_name`, `arguments`), `tool_results` (`tool_call_id`, `output`),
  `model_calls` (`provider_id`, `model`, tokens), `user_input`,
  `agent_id`, `conversation_id`, `turn_number`, `total_cost_usd`,
  `duration_ms`, `mode` (`"runtime"` or `"ci"`). Annotate it `dict` to get
  the raw wire dict instead.
- **`config`** — its type comes from the first parameter's annotation
  (or `config_type=`) and becomes the guardrail's config schema. The
  values are `config=` on the decorator, keyed as on the wire (the
  model's aliases): `@guardrail(..., config={"minLookups": 2})`. They are
  checked against the type where declared, go into the index, and the
  check runs with them. Without `config=` the check runs with `{}` — so
  give every field a default; a required field without a value fails
  every evaluation (`input-validation-failed`).
- An exception in the check fails the evaluation (`handler-throw`);
  return a failed `CheckResult` for a rule that isn't met.
- A check gets no model and no provider: it can't call an LLM. Keep it a
  pure function of the trace (fast, deterministic, free).

## `@guardrail(...)`

- **`id`** — `<pack-id>.<guardrail-name>`, kebab-case. Name the rule as
  a positive assertion: `no-fabricated-quotes`, `response-not-empty`.
- **`on_violation`** — the action: `"halt"`, `"retry"`, `"escalate"`,
  `"log-only"`, `"compensate"`. For one that needs settings pass the
  whole object with `action=` instead (exactly one of the two):
  `action={"on-violation": "retry", "retry": {"maxAttempts": 2}}`,
  `{"on-violation": "escalate", "escalateTo": …}`,
  `{"on-violation": "compensate", "compensateWith": "<tool id>"}`.
  In an agent turn a failed `halt` guardrail fails the turn
  (`guardrail-violation`) and the answer is not stored; any other action
  reports the failure in the turn result's `violations` and the turn
  completes. In 0.1 the runtime acts only on `halt`: `retry`, `escalate`
  and `compensate` are recorded on the violation, with no second attempt,
  escalation or compensating call.
- **`severity`** — `"info"`, `"warn"`, `"error"` (default), `"critical"`.
  Independent of the action: dashboards group by severity, execution
  follows the action.
- **`scope`** — when it applies: `{"when": "always" | "ci-only" |
  "runtime-only"}`, narrowed by `agents`, `flows`, `tenants` lists.
- **`kind`** — `"zero-llm"` (default): a check over the trace — what a
  pack writes.
- **`config`** — the values the check runs with (above); **`config_type`**
  — the config's type when the check's first parameter isn't annotated
  with it.
- **`name`** — a display name. **`check_id`** — defaults to the id.
- `sandbox=`, `limits=`, `network=` are recorded in the index.

## Testing

A `Guardrail` is still callable:

```python
# tests/test_guardrails.py
from kindgi import RunTrace
from guardrails.citations import Config, no_fabricated_quotes


def test_no_lookups_fails():
    trace = RunTrace(run_id="r", tenant_id="t", output="As held in Smith v. Jones…")
    assert not no_fabricated_quotes(Config(), trace).passed
```

`RunTrace(...)` takes snake_case fields; `tool_calls` entries are
`ToolCallRecord(tool_id=…, tool_name=…, arguments={…}, at="…")`.

## Wiring onto an agent

```python
from ..guardrails.citations import no_fabricated_quotes

brief_writer = Agent(..., guardrails=[no_fabricated_quotes])
```

The `Guardrail` object (or its id). `kindgi dev` registers the pack's
guardrails; an agent naming an id with no registered guardrail fails the
turn before the model is called (`Error [invalid-request]: Agent "…"
references guardrails not in the registry: <id>`).

## Common mistakes

1. **A required config field with no `config=` value.** Without
   `config=` the check runs with `{}`; give the field a default or the
   guardrail its values.
2. **Snake_case keys in `config=`.** It is keyed like the wire — the
   model's aliases (`{"minLookups": 2}`), not the field names.
3. **Both `on_violation=` and `action=`, or neither** — `DefinitionError`.
4. **Expecting another attempt.** `halt` stops the turn, and in 0.1
   `retry` doesn't run the turn again: it's only recorded.
5. **Calling a model from the check.** Not available; keep checks pure.
6. **Raising for a broken rule.** Return `CheckResult(passed=False,
   reason=…)`; an exception is an evaluation error, not a violation.
7. **Defining the guardrail inside a function** — only module-level
   primitives are indexed.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package (a trace field missing,
a misleading error) and not in the check, load
`kindgi-framework-feedback` and file it with `kindgi feedback write`.
