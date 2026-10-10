---
name: kindgi-authoring-flows
description: >
  Covers writing flows for a Kindgi pack with @kindgi/sdk: defineFlow,
  tool and agent steps, edges and `when` conditions, branches that join
  again, inputMapping from runInput / nodeOutputs, typed agent output in
  a flow, the flow's declared output, loops (foreach / while) and fanout,
  per-edge retry and timeout, and running a flow (kindgi runs start
  --flow, in the background, as a dry run) and reading its journal. Load
  this whenever you are authoring or editing code inside a pack's flows/
  directory, defining a flow, or when the user asks to add, change or
  debug one. Tools are covered by kindgi-authoring-tools, agents by
  kindgi-authoring-agents.
type: core
library: "@kindgi/sdk"
version: "0.1.3"
sdk_version: "0.0.0"
pack_languages: [node]
sources:
  - packages/flow/src/types.ts
  - packages/flow/src/define.ts
---

# Authoring Kindgi flows

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

A **flow** is a versioned, durable graph of steps: tools (your code) and
agents (a model's judgment), joined by edges that can carry conditions.
It is **data**, not code: `defineFlow({...})` in `flows/<name>/index.ts`.
The runtime runs it step by step, journals every step, and can resume a
run that was interrupted. A run pins the flow version it started on.

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
- **What does it change outside Kindgi?** A tool that only reads
  declares `mutating: false`, and a dry run runs it. A tool that writes
  doesn't (leaving it out counts as mutating), and a dry run stops there.

## A flow

```ts
// flows/triage-ticket/index.ts
import { defineFlow } from '@kindgi/sdk/define';

const isBilling = {
  op: 'eq',
  left: { path: 'nodeOutputs.classify.output.category' },
  right: { literal: 'billing' },
} as const;

const defined = defineFlow({
  id: 'acme.triage-ticket',
  version: '0.1.0',
  name: 'Triage a support ticket',
  description: 'Parses a ticket, classifies it, looks up billing when needed, drafts a reply.',
  nodes: [
    {
      id: 'parse',
      kind: 'tool',
      ref: 'acme.parse-ticket',
      inputMapping: { ticket: { path: 'runInput.ticket' } },
    },
    {
      id: 'classify',
      kind: 'agent',
      ref: 'acme.ticket-classifier', // an agent with a typed `output`
      inputMapping: { text: { path: 'nodeOutputs.parse.text' } },
      config: { parameters: { product: 'acme-cloud' } },
    },
    {
      id: 'billing',
      kind: 'tool',
      ref: 'acme.lookup-invoice',
      inputMapping: { customerId: { path: 'runInput.ticket.customerId' } },
    },
    {
      id: 'reply',
      kind: 'tool',
      ref: 'acme.draft-reply',
      inputMapping: {
        category: { path: 'nodeOutputs.classify.output.category' },
        invoice: { path: 'nodeOutputs.billing.invoice' }, // absent when billing didn't run
      },
    },
  ],
  edges: [
    { id: 'e0', from: '$start', to: 'parse' },
    { id: 'e1', from: 'parse', to: 'classify' },
    { id: 'e2', from: 'classify', to: 'billing', when: isBilling },
    { id: 'e3', from: 'classify', to: 'reply', when: { op: 'not', child: isBilling } },
    { id: 'e4', from: 'billing', to: 'reply' },
    { id: 'e5', from: 'reply', to: '$end' },
  ],
  output: {
    mapping: {
      category: { path: 'nodeOutputs.classify.output.category' },
      reply: { path: 'nodeOutputs.reply.text' },
    },
    schema: {
      type: 'object',
      properties: { category: { type: 'string' }, reply: { type: 'string' } },
      required: ['category', 'reply'],
    },
  },
});

if (defined.kind === 'err') {
  throw new Error(`acme.triage-ticket failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

`defineFlow` checks the shape where it is written: ids, the version,
edges between nodes that exist, `$start` / `$end`, no cycles, paths
rooted where they may be. It doesn't check that `acme.parse-ticket`
exists. That is checked when a run starts (see "Running a flow").

## Nodes

- **`kind: 'tool'`** runs the tool `ref` (its id). The tool's input is
  what the node's `inputMapping` builds, else the output of the node's
  single upstream node (the run input after `$start`). It is validated
  against the tool's input schema, so a mismatch fails the step with
  `input-validation-failed`. The node's output is the tool's return value.
- **`kind: 'agent'`** runs one turn of the agent `ref` as a child run of
  the flow run. The agent gets the node's input in two ways:
  - as **structured input**: `{{ input.text }}` in its instructions;
  - as its user message (the input as JSON).

  `config.parameters` fills the agent's `parameters` (string, number or
  boolean values). `config.version` pins an agent version; without it
  the latest active version runs.

  The node's output:
  - `output` is the agent's typed answer (its `output` schema);
  - `text` is the answer as text;
  - `runId` and `conversationId` belong to the child run.

  Read a field as `nodeOutputs.<node>.output.<field>`. An answer that
  doesn't fit the agent's `output` schema, after its repairs, fails the
  step with `output-schema-violation`.

  An approval inside the agent's turn parks the flow until it's decided.
- **`kind: 'loop'`** repeats a body: `loopKind: 'foreach'` once per
  element of `iterateOver` (`concurrency` up to 32 in parallel), or
  `loopKind: 'while'` until `exitCondition`.
  - The body has its own nodes and edges, with `$loop-start` /
    `$loop-end`; the element is the body's input.
  - `maxIterations` and `outputSchema` are required.
  - The loop's output is `finalOutput`, plus `outputs` with
    `collectAllIterations: true`.
  - Node ids must be unique across the whole flow, bodies included.
- **`kind: 'fanout'`** runs several handlers on the same input at once,
  each a `branch` with an `outputSchema`. `convergence` decides the
  result:
  - `'all-succeed'`: every branch must succeed;
  - `'any-succeed'`: the first success wins;
  - `'settle-all'`: wait for every branch and report each.
- **`kind: 'subgraph'`** (a sub-flow) is part of the flow schema, but a
  run refuses it today (`flow-unbound`). Inline the steps instead.

## Edges and conditions

An edge goes from a node (or `$start`) to a node (or `$end`). Without
`when` it fires when its source completes; with `when` it fires only if
the condition is true. Conditions are JSON:

| Operator | Shape |
|---|---|
| `eq` `ne` `lt` `lte` `gt` `gte` | `{ op, left, right }` |
| `in` `notIn` | `{ op, value, set }` |
| `exists` `notExists` `truthy` `falsy` | `{ op, value }` |
| `and` `or` | `{ op, children: [...] }` |
| `not` | `{ op, child }` |

Each operand is `{ literal: … }` or `{ path: … }`. When a path doesn't
resolve, `eq`, `lt`, `lte`, `gt` and `gte` are false and `ne` is true. So
for the "otherwise" branch, write `not` around the condition (as above),
rather than a second comparison: it covers exactly what the first edge
doesn't.

**Joining branches.** A node with several incoming edges runs once every
one of them is decided and at least one fired. In the example, `reply`
runs after `billing` on the billing branch, and straight after `classify`
otherwise. A node none of whose incoming edges fired is skipped, and so
is everything only it leads to.

**Edge policy** (`policy` on the edge into a node with a single incoming
edge):
- `retry: { maxAttempts, delayMs?, backoff?, maxDelayMs? }`: up to 10
  attempts in all;
- `timeoutMs`: a step that takes longer fails with `reason: 'timeout'`;
- `concurrencyKey`: at most one such step at a time in the tenant;
- `priority`: −100 to 100.

A node with several incoming edges ignores them.

## Inputs and the output

`inputMapping` maps each key to a `{ literal }` or a `{ path }`. Paths are
dot-separated (a number segment indexes an array: `items.0.sku`), rooted at:
- `runInput.…`: the input the run was started with;
- `nodeOutputs.<nodeId>.…`: a step's output. For an agent step, add
  `.output.<field>` to read its typed answer;
- `state.…`: values written by the runtime's own handlers. Pack tools
  don't write it, so use `nodeOutputs`.

A path that doesn't resolve leaves its key out. A step after a branch
that didn't run gets no `invoice` key at all, rather than `invoice:
undefined`. Make that key optional in the tool's input schema.

`output` is what the run returns: a `mapping` resolved when the run
finishes, checked against `schema` if you give one. A run whose output
doesn't match fails. Without `output`, the run returns the output of the
step that reached `$end`.

## Running a flow

From another terminal in the pack directory, while `kindgi dev` runs:

```sh
kindgi runs start --flow=acme.triage-ticket --input='{"ticket":{"customerId":"c-1","body":"Charged twice"}}'
kindgi runs start --flow=acme.triage-ticket --input=@ticket.json --no-wait   # the run id now; it finishes in the background
kindgi runs start --flow=acme.triage-ticket --input=@ticket.json --dry-run   # runs only read-only tools
kindgi runs get <run-id>        # status, output, failureMessage
kindgi runs journal <run-id>    # every step.started / step.completed / edge.evaluated
kindgi runs stream <run-id>     # follow a running one
kindgi runs cancel <run-id>
```

- **A refusal before the run exists:** `422 flow-unbound` names the
  nodes a run can't bind: a tool or agent id the tenant doesn't have, or
  a sub-flow. Fix the ids; nothing ran.
- **A failed step fails the run**, and `failureMessage` says which step
  and why. Retry it on its edge with `policy.retry` only if running the
  step twice is safe.
- **`--no-wait`** is how an application starts runs (`options: { wait:
  false }` with `@kindgi/sdk/client`). It answers with the run id at once;
  poll `GET /v1/runs/<id>` or follow the stream.
- **`--dry-run`** runs a tool only if it's declared read-only:
  `mutating: false`, and no `writes`, `deletes`, `spawns-run`,
  `emits-event` or `external-side-effect` effect. The first other tool
  stops the run with `dry-run-effectful-tool`, and everything before it
  really ran. That's useful for checking the wiring without the writes.

## Iterating on a flow

Save the file and `kindgi dev` re-indexes; the next run uses the new
definition, with no restart. A run already in flight keeps the version it
started on. Bump `version` when callers' contract changes (the input or
the output), not on every save.

## Common mistakes

1. **Building a flow without asking what goes in and comes out.** The
   pack's `echo-flow` proves the runtime works. It isn't a template for
   the user's flow.
2. **A second comparison for "otherwise".** On a path that may be
   missing, `eq` is false and `ne` is true, and `lt`/`gt` are both false,
   so a hand-written opposite can miss a case or overlap. Use `not` around
   the positive condition: it covers exactly what the first edge doesn't.
3. **Reading an agent step's answer at `nodeOutputs.<step>.<field>`.**
   The typed answer is under `.output`: `nodeOutputs.<step>.output.<field>`.
   An agent without an `output` schema has only `text`.
4. **A required input key fed by a branch that may not run.** The key is
   omitted, the tool's input check fails, and so does the step. Make the
   key optional in the tool's input schema.
5. **`mutating: false` on a tool that writes.** A dry run runs it for
   real unless its `effects` declare the write, and an agent's tool
   gates (when on, with no rule for it) let it through unasked.
6. **A read-only tool without `mutating: false`.** Leaving it out counts
   as mutating: a dry run stops at the tool, and an agent's tool gates
   ask before it. kindgi-authoring-tools has the details.
7. **A sub-flow node.** A run refuses it (`flow-unbound`) until
   sub-flows are supported.
8. **Duplicate node ids inside a loop body.** Ids are unique across the
   whole flow, bodies included.
9. **Missing `Result` unwrap.** Check `defined.kind === 'err'` and throw,
   so a broken flow fails when its module loads, not on the first run.

## When the framework itself is the problem

If the bug is in Kindgi or `@kindgi/sdk` (a step's output missing a
field, a condition that evaluates wrongly, a misleading error) and not in
the pack's code, load `kindgi-framework-feedback` and file it with
`kindgi feedback write`.
