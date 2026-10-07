---
name: kindgi-python-authoring-agents
description: >
  Covers writing agents for a Kindgi pack in Python (the `kindgi`
  package): declaring an `Agent(...)` at module level, wiring tools
  (Tool objects or {id, version} refs) and guardrails, capabilities and
  model choice (preferred_provider / preferred_model), conversation
  policy, turn budgets, prompt template parameters, typed output from a
  pydantic model, and tool-error retries. Load this whenever you are
  authoring or editing code inside a Python pack's agents/ directory
  (a pack whose config is `[tool.kindgi]` in pyproject.toml), defining
  an agent, or when the user asks to add, modify or refactor one.
  Python tools are covered by kindgi-python-authoring-tools, Python
  guardrails by kindgi-python-authoring-guardrails, connecting a real
  model by kindgi-authoring-providers.
type: core
library: "kindgi (Python)"
version: "0.1.1"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/src/kindgi/pack/define.py
  - sdks/python/src/kindgi/pack/index.py
---

# Authoring Kindgi agents in Python

> **Running `kindgi`:** the CLI is `kindgi-cli` from PyPI, pinned in the
> pack's dev group, so every `kindgi <command>` below runs as
> `uv run kindgi <command>` (Poetry: `poetry run kindgi <command>`). Python
> commands run in the pack's environment the same way: `uv run …` (or
> `.venv/bin/python …`).

An **agent** is a versioned, model-driven orchestrator: instructions (a
prompt template), the tools it may call, the capabilities its model
needs, guardrails that gate its answer, and an optional conversation
policy. In a Python pack it is **data**: an `Agent(...)` assigned at
module level in a file under `agents/`. The model runs in the Kindgi
runtime, not in your Python process; your Python code runs only inside
the agent's tools and guardrail checks.

## Ask before building

"Add an agent" is a conversation opener, not a ticket. Before writing a
file, ask:

- **What should the agent do?** The purpose drives everything else.
- **Which tools does it need?** New ones, or existing ones?
- **Multi-turn or one-shot?** History changes the shape.
- **Any rules it must respect?** Those become guardrails.

The pack's sample agent proves the runtime works end to end. It is not
the shape to imitate unless the user asks for that.

## An agent

```python
# agents/brief_writer.py
from pydantic import BaseModel

from kindgi import Agent

from ..guardrails.citations import no_fabricated_quotes
from ..tools.citations import fetch_precedent, verify_citation


class Brief(BaseModel):
    argument: str
    citations: list[str]


brief_writer = Agent(
    id="acme.brief-writer",
    version="0.1.0",
    name="Brief Writer",
    description="Drafts appellate briefs from a case file; cites precedents.",
    instructions=(
        "You are drafting a brief in {{ jurisdiction }}. The user provides the case "
        "facts; you produce a Section IV argument citing at least two precedents. "
        "Call acme.verify-citation on every cite before using it. Never invent one."
    ),
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[verify_citation, fetch_precedent],      # Tool objects — or {"id", "version"} refs
    guardrails=[no_fabricated_quotes],             # Guardrail objects — or ids
    parameters=[{"name": "jurisdiction", "type": "string", "required": True}],
    conversation_policy={"historyLimit": 20},
    budget={"maxSteps": 8, "maxCostUsd": 0.5, "maxWallMs": 60_000},
    output=Brief,                                  # typed answer (optional)
)
```

- Import tools and guardrails with **relative imports** — every file in
  the pack is imported as part of one package rooted at the pack.
- **Dict-valued fields keep the wire's camelCase keys**: `maxSteps`,
  `maxCostUsd`, `maxWallMs`, `historyLimit`, `maxRetries`, `retryOn`.
  Only the `Agent` keyword arguments themselves are snake_case.
- A file may define several agents; each must be assigned at module
  level (an agent built inside a function is invisible to the indexer).
- `Agent(...)` checks the id (non-empty) and the version (an exact
  semver) where it is written. Everything else is checked when Kindgi
  reads the pack: `uv run python -m kindgi.pack index --pack-dir .`
  shows what it sees, and `kindgi dev` reports a problem with its file.

## Field by field

- **`id`** — `<pack-id>.<agent-name>`, kebab-case, dot-namespaced.
- **`version`** — exact semver. Conversations pin the version they
  started on.
- **`name`**, **`description`**, **`tags`** — for people and listings.
- **`instructions`** — a LiquidJS template. `{{ variable }}` comes from
  `parameters` or the runtime's own variables (`today`, `now`,
  `agent.*`, `conversation.*`), rendered strictly: an unknown variable
  fails the turn. Write it as a brief for a capable colleague: what to
  do, which tools to prefer, what to refuse, the quality bar.
- **`capabilities`** — what the model must support, e.g.
  `[{"needs": [{"feature": "tool-use"}]}]`. The turn routes its first
  capability to pick a provider and model; none declared fails the turn.
- **`tools`** — `Tool` objects (pinned to that tool's version, or the
  pack's) or `{"id": "acme.x", "version": "^0.1.0"}` refs, where
  `version` is a semver **range**; the highest active matching version
  is picked at turn start. A bare string is rejected. Empty = a
  chat-only agent.
- **`guardrails`** — `Guardrail` objects or ids. Evaluated once per
  turn on the final answer, before it is stored. An id with no
  registered guardrail fails the turn (`unresolved-guardrail`).
- **`parameters`** — inputs the caller supplies per run
  (`{"name", "type", "required"}`); they fill `{{ … }}` in the
  instructions.
- **`preferred_provider`** / **`preferred_model`** — soft hints: the
  router prefers that provider id (e.g. `"anthropic"`) and/or model name
  (e.g. `"claude-haiku-4-5"`) when they satisfy the capabilities. To
  *require* a model, put it in the capability:
  `{"needs": [{"feature": "tool-use"}, {"models": {"allow": ["claude-haiku-4-5"]}}]}`.
- **`conversation_policy`** — `{"historyLimit": n}` caps the prior
  messages loaded; `hitl` configures approval gates. Absent = the full
  history, no gates. A tenant's `hitl` policy can tighten the gates
  (shorter timeout, higher reviewer role, stricter per tool), never
  loosen them.
- **`budget`** — per turn: `maxSteps` (model calls, default 8),
  `maxCostUsd`, `maxWallMs` (default 120 000). Steps or cost exceeded
  fails the turn (`budget-exceeded`); out of wall time aborts it. Leave
  room for real models: a turn with tool calls can take tens of seconds.
- **`output`** — a typed answer: a pydantic model class (or any type
  pydantic understands, or a JSON Schema dict), or the full
  `{"schema", "name", "maxRepairs"}` object. The final answer must be
  JSON matching it; a wrong one goes back to the model with the problems
  (`maxRepairs`, default 1), then the turn fails
  (`output-schema-violation`). The parsed answer is the turn result's
  `output` — a dict on the wire (with `kindgi.client`:
  `Brief.model_validate(run.output["output"])`), and in a flow
  `nodeOutputs.<step>.output.<field>`.
- **`tool_errors`** — `{"maxRetries": 1, "retryOn": [...]}`: a failed
  tool call goes back to the model as the call's result so it can fix
  the call. Default kinds are `invalid-arguments` and `unknown-tool`
  (nothing ran); add `tool-error` only when retrying the tool is safe.
  Each retry costs a step.
- **`retrieval`** — memory retrieval declarations; usually `[]`.

## Which model answers

Agents run on a registered model provider; the router picks one whose
models satisfy `capabilities`. `kindgi dev` gives a new pack `dev-echo`,
a **fallback** that answers only while no other provider fits — it
calls the first tool and replies "Tool responded: …", and the turn
carries a `fallback-provider` warning. Register a real model and it
takes over: see `kindgi-authoring-providers`
(`kindgi providers register --preset=anthropic`).

## Iterating

Save the file; `kindgi dev` re-indexes and the next run uses it. No
version bump, no restart. Bump `version` when you break what callers
rely on (a removed parameter, an incompatible output), not on every
save.

Run an agent from another terminal in the pack directory:

```sh
kindgi runs start --agent=acme.brief-writer --input='{"userMessage":"…"}'
```

or from Python with `kindgi.client` (`Kindgi().runs.start(agent=…, input=…)`).

## Common mistakes

1. **Building an agent without asking what it should do.** Copying the
   sample's shape answers the wrong question.
2. **`tools=["acme.x"]`.** A tool is a `Tool` object or an
   `{"id", "version"}` ref; a bare string fails the index.
3. **snake_case inside the dicts.** `budget={"max_steps": 4}` is not a
   budget; the keys are `maxSteps`, `historyLimit`, `maxRetries`, ….
4. **An unregistered guardrail id.** Pass the `Guardrail` object you
   import, or make sure the id is one the tenant has.
5. **`{{ variable }}` not in `parameters`.** The turn fails when the
   instructions render.
6. **No `capabilities`.** The turn can't pick a model.
7. **Defining the agent inside a function or under `if __name__`.** Only
   module-level primitives are collected.
8. **A tight `maxWallMs` with a real model.** 15 s aborts real turns
   under load; 60 s is a safer start.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package itself (the index
dropping a field, a misleading error, the router picking the wrong
model) and not in the pack's code, load `kindgi-framework-feedback` and
file it with `kindgi feedback write`.
