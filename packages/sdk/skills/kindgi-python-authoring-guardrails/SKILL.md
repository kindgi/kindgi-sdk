---
name: kindgi-python-authoring-guardrails
description: >
  Covers writing guardrails (safety checks on an agent's turn) for a Kindgi
  pack in Python (the `kindgi` package): the `@guardrail` decorator over a
  `(config, trace)` check, `RunTrace` and `CheckResult`, config models,
  actions, severity and scope, unit tests, and wiring a guardrail onto an
  agent. halt fails the turn and retry sends the answer back to the model
  for a new one (escalate / compensate are only recorded in 0.1), and a
  check sees only the current turn: its user message and tool results, not
  earlier turns'. Load this whenever you are authoring or editing code
  inside a Python pack's guardrails/ directory (a pack whose config is
  `[tool.kindgi]` in pyproject.toml), defining a check, or wiring a
  guardrail onto an agent. Python agents are covered by
  kindgi-python-authoring-agents, Python tools by
  kindgi-python-authoring-tools.
type: core
library: "kindgi (Python)"
version: "0.1.7"
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

`@guardrail(...)` has no field for the other points a guardrail can run at (`at`, and a check's `points`), so a Python guardrail runs at the final answer only; the points are documented at https://docs.kindgi.com/v0.2/guides/guardrails/configure-a-guardrail/#where-in-the-turn-it-runs.

Ask what the rule should catch before writing one; the sample
`response-not-empty` guardrail is a demonstration, not a template.

## What a guardrail can do in 0.1

Read this before you plan a guardrail. Three limits decide what can be
built:

- **`halt` and `retry` act.** A failed `halt` guardrail fails the turn with
  `guardrail-violation`, and the answer is not stored. A failed `retry`
  guardrail sends the answer back to the model, with the check's reason in a
  user message, for a new one; the failed answer isn't stored. When it has
  failed `retry.maxAttempts` answers (the first one included; 2 when left
  out), the turn fails with `guardrail-violation` and
  `details.attempts`. Each new answer is a model call that the agent's
  `budget.maxSteps` counts. The `halt` and `retry` guardrails judge each
  answer, a judge's calls included, which `budget.maxCostUsd` doesn't count;
  the others judge only the answer that's sent. A new answer can call tools
  again, side-effecting ones included, with approvals as usual. `escalate`
  and `compensate` are recorded on the turn's violations, as `log-only` is,
  and the turn completes: nothing escalates or calls a compensating tool. So
  "block the reply and make the agent try again" is a `retry` guardrail.
- **A check sees one turn.** The trace holds the current turn only: its
  user message (`trace.user_input`), its tool calls and their results
  (`trace.tool_calls`, `trace.tool_results`) and its answer
  (`trace.output`). Earlier turns' messages, tool results and answers
  aren't in it. A check that every figure in the answer comes from a tool
  result or the user's message therefore blocks an answer that repeats a
  figure seen only in an earlier turn.
- **A check's in-memory state doesn't last.** The check runs in the pack
  service's process, so anything it keeps at module level (say, a dict
  keyed by `trace.conversation_id`) is lost when that process is replaced:
  under `kindgi dev`, on every reload after a save and on a restart; in a
  deployment, whenever an instance stops. With more than one instance,
  each keeps its own copy, and one conversation's turns can land on
  different instances. Don't keep a conversation's history this way.

What works today for a check on figures: tell the agent, in its
instructions, to call its tools again in every answer that quotes a
figure, so the figure is in that turn's tool results. It depends on the
model following the instruction, and it doesn't cover figures the user
typed in an earlier turn: `trace.user_input` is only the current turn's
message, so an answer that repeats them is still blocked.

## A guardrail

```python
# guardrails/citations.py
from pydantic import BaseModel, Field

from kindgi import CheckResult, RunTrace, guardrail


class Config(BaseModel):
    min_lookups: int = Field(default=1, alias="minLookups", ge=0)


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
  `"log-only"`, `"compensate"`. For one that needs settings pass the whole
  object with `action=` instead (exactly one of the two):
  `action={"on-violation": "retry", "retry": {"maxAttempts": 2}}`,
  `{"on-violation": "escalate", "escalateTo": …}`, `{"on-violation":
  "compensate", "compensateWith": "<tool id>"}`. In an agent turn a failed
  `halt` guardrail fails the turn (`guardrail-violation`) and the answer is
  not stored; a failed `retry` one sends the answer back for a new one
  (above); any other action reports the failure in the turn result's
  `violations` and the turn completes. `escalate` and `compensate` are
  recorded on the violation, with no escalation or compensating call in 0.1.
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
- **`name`** — a display name. **`check_id`** — defaults to the id. It
  can't be a built-in check's id (`must-cite`, `never-call-tool`,
  `max-tool-calls`, `output-matches`, `tool-order`, `required-substring`,
  `forbidden-substring`): a pack can't replace a built-in, and the
  decorator raises `DefinitionError`. Name yours
  `<pack>.checks.<name>`. A Python pack can't use a built-in check yet,
  since `@guardrail` always decorates a check function: write the rule
  as your own check.
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
4. **Expecting `halt` to try again.** `halt` stops the turn; `retry` asks
   the model for a new answer, and fails the turn once its `maxAttempts`
   answers have failed.
5. **Calling a model from the check.** Not available; keep checks pure.
6. **Raising for a broken rule.** Return `CheckResult(passed=False,
   reason=…)`; an exception is an evaluation error, not a violation.
7. **Defining the guardrail inside a function** — only module-level
   primitives are indexed.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package (a trace field missing,
a misleading error) and not in the check, load
`kindgi-framework-feedback` and file it with `kindgi feedback write`.
