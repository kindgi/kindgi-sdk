# `@kindgi/flow`

Flow type primitives, JSON-Schema validation, edge predicate evaluator, and scheduler-tick primitive for Kindgi. Consumed by the Kindgi runtime's kernel and any tool that authors, validates, or reasons about durable task flows.

## Exports

- **`defineFlow(spec)`** — authoring surface. Thin wrapper over `loadFlow` that mirrors `defineTool` / `defineCheck` / `defineAgent`; the recommended entry point for pack authors declaring flows in TypeScript. Returns `Result<Flow, FlowError>`.
- **`loadFlow(input)`** — validates against `flow.schema.json` + runs cross-cutting checks (reserved and duplicate ids, edge references, predicates, edge policy bounds, loop / fanout / subgraph rules, data-flow mappings, start edge, cycle detection, loop-body integrity). Returns `Result<Flow, FlowError>`. Kept as the wire-form entry point for JSON coming off disk / network. `GRAPH_SCHEMA_URI` is the `$id` it validates against.
- **`evaluateExpr(expr, env)`** — deterministic boolean evaluator over the closed Expr DSL.
- **`resolveMapping(mapping, env)`** — resolves a `Mapping` (leaf or subgraph `inputMapping`, flow `output.mapping`) against an `EvalEnv`; a path that doesn't resolve omits its key. `resolvePath(path, env)` resolves one path; `MISSING_PATH` is the marker it returns when the path doesn't resolve.
- **`schedulerTick(flow, state)`** — pure per-tick output (`{ ready, edgeEvals, done }`) from a `SchedulerState`.
- Type exports: `Flow`, `FlowSpec`, `FlowEdge`, `FlowNode`, `FlowOutputSpec`, `LeafNode`, `WhileLoopNode`, `ForeachLoopNode`, `LoopNode`, `LoopBody`, `LoopEdge`, `FanoutNode`, `FanoutBranch`, `ConvergenceMode`, `SubflowNode`, `SubflowRef`, `SubflowConvergence`, `Mapping`, `Expr`, `Operand`, `LiteralOperand`, `PathOperand`, `Path`, `PathRoot`, `OperatorName`, `LoopOutputSchema`, `EdgePolicy`, `RetryPolicy`, `BackoffShape`, `EvalEnv`, `SchedulerState`, `SchedulerTick`, `PendingEdgeEval`, and `FlowError` with one interface per error code.
- Value exports: `EDGE_POLICY_PRIORITY_DEFAULT` (0), `EDGE_POLICY_PRIORITY_MIN` (-100), `EDGE_POLICY_PRIORITY_MAX` (100), `getEffectivePriority(edgesByTo, nodeId)` (resolves the effective scheduler priority for a node, applying the fan-in default rule), `OPERATORS`, `CONVERGENCE_MODES`, `SUBGRAPH_CONVERGENCE_MODES`, the sentinels `START_NODE` / `END_NODE` / `LOOP_START_NODE` / `LOOP_END_NODE` / `SENTINEL_IDS`, and the type guards `isLeafNode` / `isLoopNode` / `isFanoutNode` / `isSubflowNode`.

## Authoring

Two entry points for building a `Flow`, both returning the same `Result<Flow, FlowError>` after the same validation gauntlet:

```ts
import { defineFlow, loadFlow } from '@kindgi/flow';
import type { FlowSpec } from '@kindgi/flow';

// Recommended for pack authors — mirrors defineTool / defineCheck / defineAgent.
const flow = defineFlow({
  id: 'my.flow',
  version: '1.0.0',
  nodes: [{ id: 'step-a', kind: 'tool', ref: 'noop' }],
  edges: [
    { id: 'e1', from: '$start', to: 'step-a' },
    { id: 'e2', from: 'step-a', to: '$end' },
  ],
} satisfies FlowSpec);

// Same validation surface — use loadFlow when the input is untrusted wire JSON.
const loaded = loadFlow(JSON.parse(bytesFromDisk));
```

`defineFlow` is byte-for-byte equivalent to `loadFlow` on the same input; the two share every check. Pick `defineFlow` when authoring in TypeScript to align with the other `define*` primitives; pick `loadFlow` when consuming flow JSON from disk, network, or an untrusted caller.

## Retry policy (schema-version 1.3.0+)

Per-edge retry is declared via `FlowEdge.policy.retry`. The kernel honors this policy only when the destination node has EXACTLY ONE incoming edge — fan-in destinations (2+ incoming edges) ignore retry policies (there is no rule for whose policy would win).

```ts
import type { FlowEdge, RetryPolicy } from '@kindgi/flow';

const retry: RetryPolicy = {
  maxAttempts: 5,           // 1..10; 1 = no retry
  delayMs: 100,             // ≥ 0; default 0
  backoff: 'exponential',   // 'fixed' | 'linear' | 'exponential'; default 'fixed'
  maxDelayMs: 5_000,        // required when backoff = 'exponential'
};

const edge: FlowEdge = {
  id: 'e1',
  from: 'produce',
  to: 'consume',
  policy: { retry },
};
```

### Valid ranges (enforced by `loadFlow`)

| Field | Range | Notes |
|---|---|---|
| `maxAttempts` | `1..10` (integer) | Larger values are a design smell — retry-heavy control flow belongs in a supervising flow. |
| `delayMs` | `≥ 0` (integer) | Default `0`. |
| `backoff` | `'fixed' \| 'linear' \| 'exponential'` | Default `'fixed'`. |
| `maxDelayMs` | `≥ 0` (integer) | REQUIRED when `backoff = 'exponential'`. Defaults to `60_000` for `linear`. |

Loader errors: `invalid-edge-policy` (with `field: 'retry.maxAttempts' | 'retry.delayMs' | 'retry.backoff' | 'retry.maxDelayMs'` and a `reason` string) for semantic violations; `schema-validation-failed` for shape violations.

### Delay formula

For the `attempt`-th retry (1-based; `attempt = 1` is the first retry after the initial failure):

| Shape | Formula |
|---|---|
| `fixed` | `delayMs` |
| `linear` | `min(delayMs * attempt, maxDelayMs ?? 60_000)` |
| `exponential` | `min(delayMs * 2^(attempt - 1), maxDelayMs)` |

Kernel runtime semantics + journal shape (`step.retry-scheduled`, resume behaviour, cancellation) are implemented by the Kindgi runtime's kernel.

## Timeout policy (schema-version 1.3.0+)

Per-edge handler-invocation timeout is declared via `FlowEdge.policy.timeoutMs`. Same fan-in rule as retry: applies only to a destination node with EXACTLY ONE incoming edge.

```ts
const edge: FlowEdge = {
  id: 'e1',
  from: 'produce',
  to: 'consume',
  policy: { timeoutMs: 5_000 },
};
```

### Valid ranges (enforced by `loadFlow`)

| Field | Range | Notes |
|---|---|---|
| `timeoutMs` | `1..3_600_000` (integer) | 1 hour cap. Longer work belongs behind `ctx.waitForToken` or in a `foreach` with `concurrency`. |

Loader errors: `invalid-edge-policy` with `field: 'timeoutMs'` for out-of-band values; `schema-validation-failed` for shape violations.

Kernel runtime semantics (timer wiring, `AbortSignal` composition, timeout+retry interaction, cancel+timeout attribution, loop-node bounding) are implemented by the Kindgi runtime's kernel.

## Concurrency policy (schema-version 1.4.0+)

Per-edge kernel semaphore is declared via `FlowEdge.policy.concurrencyKey`. When set on the sole incoming edge of a destination node, the kernel serializes dispatch across every node (across every run, across every flow, within a single tenant) that shares the same key: at most one such node runs at a time.

```ts
const edge: FlowEdge = {
  id: 'e-model',
  from: '$start',
  to: 'call-model',
  policy: { concurrencyKey: 'per-tenant:model-api' },
};
```

### Valid ranges (enforced by `loadFlow`)

| Field | Range | Notes |
|---|---|---|
| `concurrencyKey` | 1..256 chars, printable ASCII (0x20..0x7E) | Coordination handle, not a display label. Non-printable / non-ASCII rejected. |

Loader errors: `invalid-edge-policy` with `field: 'concurrencyKey'` for length / character-set violations; `schema-validation-failed` for shape violations.

Kernel runtime semantics (lease acquire/release lifecycle, `step.concurrency-deferred` journal kind, waitForToken suspend-release / resume-reacquire, retry re-acquire, sweep on resume) are implemented by the Kindgi runtime's kernel.

## Priority policy (schema-version 1.5.0+)

Per-edge scheduler priority is declared via `FlowEdge.policy.priority`. Same fan-in rule as retry / timeoutMs / concurrencyKey: applies only to a destination node with EXACTLY ONE incoming edge. Fan-in nodes inherit the default (`0`).

```ts
const highPriority: FlowEdge = {
  id: 'e-urgent',
  from: '$start',
  to: 'expedite',
  policy: { priority: 90 },
};

const background: FlowEdge = {
  id: 'e-lazy',
  from: '$start',
  to: 'cleanup',
  policy: { priority: -20 },
};
```

### Valid ranges (enforced by `loadFlow`)

| Field | Range | Notes |
|---|---|---|
| `priority` | `-100..100` (integer) | Default `0`. Integer-only: floats introduce IEEE-754 comparison ambiguity in a replay-critical sort key. Bounded range because the primitive expresses tiers ("urgent" / "normal" / "background") plus finer-grained ordering — wider ranges add no expressive power. |

Loader errors: `invalid-edge-policy` with `field: 'priority'` for range / integer / type violations; `schema-validation-failed` for shape violations.

Kernel runtime semantics (dispatch ordering, maxParallelism interaction, concurrencyKey interaction, determinism) are implemented by the Kindgi runtime's kernel.

### `EdgePolicy` is a closed surface

`retry` / `timeoutMs` / `concurrencyKey` / `priority` are the complete honored set. There is no `suspend` field — declarative suspension uses `ctx.waitForToken` at handler level. The schema enforces `additionalProperties: false`, so unknown edge-policy keys are rejected at load time.

## Loop primitive

Loop node types + `outputSchema` well-formedness live here; the runtime lives in the Kindgi runtime's kernel.

## Fanout primitive (schema-version 1.6.0+)

`FanoutNode` is a first-class node kind that runs N different handler bodies in parallel from a single dispatch, converging by a declared mode. Complementary to `foreach` (N iterations of the SAME body), fanout runs N DIFFERENT bodies concurrently.

Shape:

```jsonc
{
  "id": "the-fanout",
  "kind": "fanout",
  "branches": [                            // >= 2, unique branchIds
    { "branchId": "a", "handler": "h-a", "outputSchema": { /* draft 2020-12 */ } },
    { "branchId": "b", "handler": "h-b", "outputSchema": { /* draft 2020-12 */ } }
  ],
  "concurrency": 2,                        // optional, default = branches.length; 1..branches.length
  "convergence": "settle-all"              // 'all-succeed' | 'any-succeed' | 'settle-all'
}
```

Loader-enforced guardrails (`invalid-fanout-node`):

- `branches.length >= 2` (a single-branch fanout is just a leaf node).
- `branchId` non-empty + unique within a single fanout node.
- `handler` non-empty (opaque to the loader — the kernel resolves it against the HandlerRegistry).
- Per-branch `outputSchema` present + compiles against the draft-2020-12 meta-schema.
- `concurrency` (when set) integer in `[1, branches.length]`.
- `convergence` in the closed enum `{ 'all-succeed', 'any-succeed', 'settle-all' }`.

Kernel runtime semantics (dispatch, sibling cancellation, replay, fan-in shape per convergence) are implemented by the Kindgi runtime's kernel.

## Subgraph primitive (schema-version 1.7.0+)

`SubflowNode` is a first-class node kind that dispatches another registered flow as a full kernel sub-run. Complementary to loop + fanout: `loop.foreach` iterates the SAME body over N inputs; `fanout` runs N DIFFERENT bodies in parallel; `subgraph` runs a whole OTHER flow inline as a node.

Shape:

```jsonc
{
  "id": "the-subgraph",
  "kind": "subgraph",
  "flowRef": {
    "flowId": "child.flow.id",
    "version": "1.2.3"                      // EXACT semver (no ranges)
  },
  "inputMapping": {                          // Record<string, Operand>
    "target":  { "path": "runInput.target" },
    "hint":    { "literal": "expedite" }
  },
  "outputSchema": { /* draft 2020-12 */ },   // typed escape contract
  "convergence": "settle-all"                // 'success-only' | 'settle-all'
}
```

Loader-enforced guardrails (`invalid-subgraph-node`):

- `flowRef.flowId` non-empty.
- `flowRef.version` is EXACT semver (`^` / `~` / ranges rejected — deterministic replay requires exact resolution).
- `inputMapping` is a plain object whose every value is a valid `Operand` (`{ path }` or `{ literal }`).
- `outputSchema` present + compiles against the draft-2020-12 meta-schema (same discipline as loop / fanout output schemas).
- `convergence` in the closed enum `{ 'success-only', 'settle-all' }`.

Kernel runtime semantics (child-run dispatch, journal shape, replay via prior-dispatch reattach, cross-tenant guard, depth-limit enforcement) are implemented by the Kindgi runtime's kernel.

## Data flow (schema-version 1.8.0+)

A tool or agent node can declare an `inputMapping`, and the flow can declare an `output`. Both are `Mapping`s: each key maps to a `{ literal }` or a `{ path }` rooted at `runInput`, `state` or `nodeOutputs.<nodeId>`, resolved with `resolveMapping`. A path that doesn't resolve omits its key.

```jsonc
{
  "nodes": [
    { "id": "parse", "kind": "tool", "ref": "acme.parse-profile" },
    {
      "id": "rank",
      "kind": "tool",
      "ref": "acme.rank",
      "inputMapping": {                       // absent → the single upstream node's output
        "profile": { "path": "nodeOutputs.parse" },
        "orgId":   { "path": "runInput.orgId" }
      }
    }
  ],
  "output": {                                 // absent → the output of the node feeding $end
    "mapping": { "ranking": { "path": "nodeOutputs.rank" } },
    "schema": { "type": "object" }            // optional; must compile
  }
}
```

Loader errors: `invalid-mapping` when a mapping names a node the flow doesn't have, maps a node's own output, or uses a loop-only root (`iterationIndex` / `iterationOutput`); `invalid-flow-output` when `output.schema` doesn't compile; `schema-validation-failed` for a path with an unknown root.

A conditional branch can rejoin: `schedulerTick` treats a node whose every incoming edge is not taken, or comes from such a skipped node, as dead. A join after a skipped arm becomes ready once its taken arms resolve, and a join whose arms are all skipped is skipped too.

## Schema drift

`src/flow.schema.json` is bundled into the package for offline validation. It must match `@kindgi/specs/flow.schema.json` (a test compares the parsed JSON); the two change together.
