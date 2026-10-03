---
name: kindgi-python-authoring-flows
description: >
  Covers writing flows for a Kindgi pack in Python (the `kindgi`
  package): declaring a `Flow(...)` at module level, tool and agent
  steps (Tool and Agent objects as refs), edges and `when` conditions,
  branches that join again, inputMapping from runInput / nodeOutputs,
  typed agent output in a flow, the flow's declared output, loops
  (foreach / while) and fanout, per-edge retry and timeout, and running
  a flow (kindgi runs start --flow, in the background, as a dry run) and
  reading its journal. Load this whenever you are authoring or editing
  code inside a Python pack's flows/ directory (a pack whose config is
  `[tool.kindgi]` in pyproject.toml), defining a flow, or when the user
  asks to add, change or debug one. Python tools are covered by
  kindgi-python-authoring-tools, Python agents by
  kindgi-python-authoring-agents.
type: core
library: "kindgi (Python)"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [python]
sources:
  - sdks/python/src/kindgi/pack/define.py
  - sdks/python/src/kindgi/pack/index.py
  - packages/specs/schemas/flow.schema.json
---

# Authoring Kindgi flows in Python

> **Running `kindgi`:** a Python pack has no Node project, so the
> `kindgi` CLI is the one on `PATH`. Python commands run in the pack's
> environment: `uv run …` (or `.venv/bin/python …`).

A **flow** is a versioned, durable graph of steps: tools (your code) and
agents (a model's judgment), joined by edges that can carry conditions.
It is **data**, not code: a `Flow(...)` at module level in
`flows/<name>.py`. The runtime runs it step by step, journals every
step, and can resume a run that was interrupted. A run pins the flow
version it started on.

Use a flow when the order of the work is known: parse, then classify,
then branch, then write. Use a single agent when the model should decide
the order.

## Ask before building

- **What goes in, and what comes out?** The run input's shape and the
  output the caller reads. They become `runInput.*` paths and `output`.
- **Which steps are code, which are judgment?** Deterministic work
  (parse, rank, look up, write) is a tool; judgment (classify, draft,
  summarize) is an agent with a typed `output`.
- **Where does it branch?** Every branch needs a condition, and the
  steps after a branch must cope with the branch that didn't run.
- **What does it change outside Kindgi?** Know which tools write: a dry
  run stops before them (see "Running a flow").

## A flow

```python
# flows/triage_ticket.py
from kindgi import Flow

from ..agents.ticket_classifier import ticket_classifier
from ..tools.tickets import draft_reply, lookup_invoice, parse_ticket

IS_BILLING = {
    "op": "eq",
    "left": {"path": "nodeOutputs.classify.output.category"},
    "right": {"literal": "billing"},
}

triage_ticket = Flow(
    id="acme.triage-ticket",
    version="0.1.0",
    name="Triage a support ticket",
    description="Parses a ticket, classifies it, looks up billing when needed, drafts a reply.",
    nodes=[
        {
            "id": "parse",
            "kind": "tool",
            "ref": parse_ticket,
            "inputMapping": {"ticket": {"path": "runInput.ticket"}},
        },
        {
            "id": "classify",
            "kind": "agent",
            "ref": ticket_classifier,  # an Agent with output=
            "inputMapping": {"text": {"path": "nodeOutputs.parse.text"}},
            "config": {"parameters": {"product": "acme-cloud"}},
        },
        {
            "id": "billing",
            "kind": "tool",
            "ref": lookup_invoice,
            "inputMapping": {"customer_id": {"path": "runInput.ticket.customer_id"}},
        },
        {
            "id": "reply",
            "kind": "tool",
            "ref": draft_reply,
            "inputMapping": {
                "category": {"path": "nodeOutputs.classify.output.category"},
                "invoice": {"path": "nodeOutputs.billing.invoice"},  # absent when billing didn't run
            },
        },
    ],
    edges=[
        {"id": "e0", "from": "$start", "to": "parse"},
        {"id": "e1", "from": "parse", "to": "classify"},
        {"id": "e2", "from": "classify", "to": "billing", "when": IS_BILLING},
        {"id": "e3", "from": "classify", "to": "reply", "when": {"op": "not", "child": IS_BILLING}},
        {"id": "e4", "from": "billing", "to": "reply"},
        {"id": "e5", "from": "reply", "to": "$end"},
    ],
    output={
        "mapping": {
            "category": {"path": "nodeOutputs.classify.output.category"},
            "reply": {"path": "nodeOutputs.reply.text"},
        },
        "schema": {
            "type": "object",
            "properties": {"category": {"type": "string"}, "reply": {"type": "string"}},
            "required": ["category", "reply"],
        },
    },
)
```

- **Refs** are the `Tool` / `Agent` (or `Flow`) objects, imported
  relatively from the pack's own modules — anywhere in the flow, loop
  bodies and fanout branches included. A primitive from another pack is
  its id string. Ids are plain strings; no casts.
- **The dicts are the wire shape**, so their keys are camelCase
  (`inputMapping`, `loopKind`, `maxIterations`); `Flow`'s own keywords
  are snake_case (`max_parallelism`).
- **Where it's checked:** `Flow(...)` checks the id when the module
  loads. The indexer checks the rest against `flow.schema.json` —
  version, node and edge shapes, `$start` / `$end` — and `kindgi dev`
  reports a mistake as a file error that says what and where
  (`flow 'acme.triage-ticket' is invalid at /nodes/0: must NOT have
  additional properties ('input_mapping')`), while the pack's other
  primitives keep serving. That a ref's tool or agent
  exists is checked when a run starts (see "Running a flow").

## Nodes

- **`"kind": "tool"`** runs the tool `ref`. The tool's input is what the
  node's `inputMapping` builds, else the output of the node's single
  upstream node (the run input after `$start`). It is validated against
  the tool's input schema, so a mismatch fails the step with
  `input-validation-failed`. The node's output is the tool's return
  value, as JSON (field aliases, if the model has any).
- **`"kind": "agent"`** runs one turn of the agent `ref` as a child run
  of the flow run. The agent gets the node's input in two ways:
  - as **structured input**: `{{ input.text }}` in its instructions;
  - as its user message (the input as JSON).

  `"config": {"parameters": {…}}` fills the agent's `parameters`
  (string, number or boolean values). `"config": {"version": "1.2.0"}`
  pins an agent version; without it the latest active version runs.

  The node's output:
  - `output` is the agent's typed answer (its `output=` model);
  - `text` is the answer as text;
  - `runId` and `conversationId` belong to the child run.

  Read a field as `nodeOutputs.<node>.output.<field>`. An answer that
  doesn't fit the agent's `output`, after its repairs, fails the step
  with `output-schema-violation`. An approval inside the agent's turn
  parks the flow until it's decided.
- **`"kind": "loop"`** repeats a body: `"loopKind": "foreach"` once per
  element of `iterateOver` (`concurrency` up to 32 in parallel), or
  `"loopKind": "while"` until `exitCondition`.
  - The body (`"body": {"nodes": [...], "edges": [...]}`) has its own
    nodes and edges, with `$loop-start` / `$loop-end`; the element is
    the body's input.
  - `maxIterations` and `outputSchema` are required.
  - The loop's output is `finalOutput`, plus `outputs` with
    `"collectAllIterations": True`.
  - Node ids must be unique across the whole flow, bodies included.
- **`"kind": "fanout"`** runs several handlers on the same input at
  once, each a branch (`branchId`, `handler` — a `Tool` or an id —
  and `outputSchema`). `convergence` decides the result: `all-succeed`,
  `any-succeed` (the first success wins), or `settle-all` (wait for
  every branch and report each).
- **`"kind": "subgraph"`** (a sub-flow) is part of the flow schema, but a
  run refuses it today (`flow-unbound`). Inline the steps instead.

## Edges and conditions

An edge goes from a node (or `$start`) to a node (or `$end`). Without
`when` it fires when its source completes; with `when` it fires only if
the condition is true. Conditions are dicts:

| Operator | Shape |
|---|---|
| `eq` `ne` `lt` `lte` `gt` `gte` | `{"op", "left", "right"}` |
| `in` `notIn` | `{"op", "value", "set"}` |
| `exists` `notExists` `truthy` `falsy` | `{"op", "value"}` |
| `and` `or` | `{"op", "children": [...]}` |
| `not` | `{"op", "child"}` |

Each operand is `{"literal": …}` or `{"path": …}`. A comparison whose
path doesn't resolve is **false**, `ne` included. So to branch on "not
billing", write `not` around the `eq` (as above), not `ne`. A condition
used twice is easiest as a module-level constant (`IS_BILLING`).

**Joining branches.** A node with several incoming edges runs once every
one of them is decided and at least one fired. In the example, `reply`
runs after `billing` on the billing branch, and straight after
`classify` otherwise. A node none of whose incoming edges fired is
skipped, and so is everything only it leads to.

**Edge policy** (`"policy"` on the edge into a node with a single
incoming edge):
- `"retry": {"maxAttempts", "delayMs"?, "backoff"?, "maxDelayMs"?}`: up
  to 10 attempts in all;
- `"timeoutMs"`: a step that takes longer fails with `reason: timeout`;
- `"concurrencyKey"`: at most one such step at a time in the tenant;
- `"priority"`: −100 to 100.

A node with several incoming edges ignores them.

## Inputs and the output

`inputMapping` maps each key to a `{"literal": …}` or a `{"path": …}`.
Its keys are the tool's input **as it travels**: a pydantic field's name,
or its alias if it has one (a `customer_id` field is the key
`customer_id`; with `alias="customerId"`, it's `customerId`). Paths are
dot-separated, with no array indexing, rooted at:
- `runInput.…`: the input the run was started with;
- `nodeOutputs.<nodeId>.…`: a step's output. For an agent step, add
  `.output.<field>` to read its typed answer;
- `state.…`: values written by the runtime's own handlers. Pack tools
  don't write it, so use `nodeOutputs`.

A path that doesn't resolve leaves its key out. A step after a branch
that didn't run gets no `invoice` key at all, rather than `None`. Give
that field a default in the tool's input model
(`invoice: Invoice | None = None`).

`output` is what the run returns: a `mapping` resolved when the run
finishes, checked against `schema` if you give one. A run whose output
doesn't match fails. Without `output`, the run returns the output of the
step that reached `$end`.

## Running a flow

From another terminal in the pack directory, while `kindgi dev` runs:

```sh
kindgi runs start --flow=acme.triage-ticket --input='{"ticket":{"customer_id":"c-1","body":"Charged twice"}}'
kindgi runs start --flow=acme.triage-ticket --input=@ticket.json --no-wait   # the run id now; it finishes in the background
kindgi runs start --flow=acme.triage-ticket --input=@ticket.json --dry-run   # stops before a tool that may write
kindgi runs get <run-id>        # status, output, failureMessage
kindgi runs journal <run-id>    # every step.started / step.completed / edge.evaluated
kindgi runs stream <run-id>     # follow a running one
kindgi runs cancel <run-id>
```

Or from Python, with `kindgi.client`:
`Kindgi().runs.start(flow="acme.triage-ticket", input={...})`.

- **A refusal before the run exists:** `422 flow-unbound` names the
  nodes a run can't bind: a tool or agent id the tenant doesn't have, or
  a sub-flow. Fix the ids; nothing ran.
- **A failed step fails the run**, and `failureMessage` says which step
  and why. Retry it on its edge with `policy.retry` only if running the
  step twice is safe.
- **`--no-wait`** is how an application starts runs
  (`options={"wait": False}`). It answers with the run id at once; poll
  the run or follow its stream.
- **`--dry-run`** runs a tool only if it's declared read-only:
  `@tool(..., mutating=False)` (or `http_tool(..., mutating=False)`),
  and no `writes`, `deletes`, `spawns-run`, `emits-event` or
  `external-side-effect` effect. The first other tool stops the run with
  `dry-run-effectful-tool`, and everything before it really ran. That's
  useful for checking the wiring without the writes.

## Iterating on a flow

Save the file and `kindgi dev` re-indexes; the next run uses the new
definition, with no restart. A run already in flight keeps the version it
started on. Bump `version` when callers' contract changes (the input or
the output), not on every save.

## Common mistakes

1. **Building a flow without asking what goes in and comes out.** The
   pack's `echo_flow` proves the runtime works. It isn't a template for
   the user's flow.
2. **`ne` on a path that may be missing, to mean "otherwise".** A missing
   path makes every comparison false, so neither branch fires and
   everything after is skipped. Use `not` around the positive condition.
3. **Reading an agent step's answer at `nodeOutputs.<step>.<field>`.**
   The typed answer is under `.output`: `nodeOutputs.<step>.output.<field>`.
   An agent without `output=` has only `text`.
4. **A required input field fed by a branch that may not run.** The key
   is omitted, the tool's input check fails, and so does the step. Give
   the field a default.
5. **`inputMapping` keys in the wrong spelling.** They're the input's
   wire names (field names, or aliases): `customerId` doesn't fill a
   `customer_id` field that has no alias.
6. **snake_case keys inside the dicts** (`input_mapping`,
   `max_iterations`). The indexer refuses them, naming the key; the
   dicts are camelCase.
7. **A sub-flow node.** A run refuses it (`flow-unbound`) until
   sub-flows are supported.
8. **Duplicate node ids inside a loop body.** Ids are unique across the
   whole flow, bodies included.
9. **`mutating=False` on a tool that writes.** A dry run then runs it for
   real, and an agent's tool approval gate (when it falls back on
   `mutating`) won't ask before it.
10. **A read-only tool without `mutating=False`.** A dry run stops at it,
    and an agent's tool approval gate asks before it on first use.

## When the framework itself is the problem

If the bug is in Kindgi or the `kindgi` package (a step's output missing
a field, a condition that evaluates wrongly, a misleading error) and not
in the pack's code, load `kindgi-framework-feedback` and file it with
`kindgi feedback write`.
