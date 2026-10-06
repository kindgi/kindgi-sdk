// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EdgeId, FlowId, NodeId, VersionDerivation } from '@kindgi/types';

import type { FlowPins } from './pins.js';

/**
 * Path roots addressable in edge predicates.
 *
 * Every path in an operand starts with one of these roots. The kernel resolves
 * each root against the current run state at the moment an edge is evaluated:
 *
 *   - `runInput`         → the input value passed to `runGraph()`.
 *   - `nodeOutputs.<id>` → the resolved output of a previously-completed node,
 *                          keyed by its declared `NodeId`. Immutable — one
 *                          writer per node, no fan-in contention.
 *   - `state`            → the run's cumulative state channel. Last-writer-wins
 *                          under concurrent writes; use `nodeOutputs.<id>` for
 *                          conflict-free per-node results.
 *   - `iterationIndex`   → 0-based iteration counter. Only meaningful inside a
 *                          loop node's `exitCondition`. Resolves to `undefined`
 *                          in any other context.
 *   - `iterationOutput`  → the `$loop-end` output of the just-completed
 *                          iteration. Only meaningful inside a loop node's
 *                          `exitCondition`. Resolves to `undefined` elsewhere.
 */
export type PathRoot =
  | 'runInput'
  | 'state'
  | `nodeOutputs.${string}`
  | 'iterationIndex'
  | 'iterationOutput';

/**
 * A path into the run's addressable state. Dot-separated segments, always
 * starting with a recognized root. Path syntax is deliberately narrow — no
 * wildcards, no array indexing, no filters. If a predicate needs more, the
 * caller should compute a normalized field into `state` from a prior node
 * and reference that.
 *
 * @example
 * 'runInput.userId'
 * 'nodeOutputs.classify.category'
 * 'state.retryCount'
 * 'iterationOutput.finishReason'  // only inside a loop exitCondition
 * 'iterationIndex'                 // only inside a loop exitCondition
 */
export type Path = string;

/** Literal operand — a JSON-serializable value compared against a path. */
export interface LiteralOperand {
  readonly literal: unknown;
}

/** Path operand — resolves at eval time against the current run's environment. */
export interface PathOperand {
  readonly path: Path;
}

/**
 * Operand = one side of a comparison. Every operand is either a static literal
 * or a path reference. Keeping them symmetric means predicates naturally
 * express path-vs-path comparisons (`state.attempts` vs `state.maxAttempts`)
 * without a second operator flavor.
 */
export type Operand = LiteralOperand | PathOperand;

/**
 * A declarative object (schema-version 1.8.0+): each key maps to an
 * Operand — a `{ literal }`, or a `{ path }` rooted at `runInput`,
 * `state` or `nodeOutputs.<nodeId>`. Resolved against the run
 * environment with `resolveMapping`; a path that doesn't resolve omits
 * its key, so a consumer can tell "not provided" from any real value.
 *
 * Used for a leaf node's `inputMapping`, a subgraph node's
 * `inputMapping` and a flow's `output`.
 */
export type Mapping = Readonly<Record<string, Operand>>;

/**
 * Predicate expression. Serializable JSON. Evaluated to a boolean at edge
 * dispatch time; an edge fires iff its `when` evaluates true (or is absent).
 *
 * Design constraint: closed operator set + JSON-serializable operand shape.
 * This is deliberately narrower than a JS closure so flows can round-trip
 * through storage, get rendered in a visual editor, and stay reproducible
 * across process restarts.
 */
export type Expr =
  | {
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: Operand;
      readonly right: Operand;
    }
  | { readonly op: 'in' | 'notIn'; readonly value: Operand; readonly set: Operand }
  | { readonly op: 'exists' | 'notExists' | 'truthy' | 'falsy'; readonly value: Operand }
  | { readonly op: 'and' | 'or'; readonly children: readonly Expr[] }
  | { readonly op: 'not'; readonly child: Expr };

/** The set of operator names recognized by the DSL, exported for tooling. */
export const OPERATORS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'exists',
  'notExists',
  'truthy',
  'falsy',
  'and',
  'or',
  'not',
] as const;

export type OperatorName = (typeof OPERATORS)[number];

/**
 * A leaf node — the classic "one handler" primitive. `kind` distinguishes what
 * this node executes:
 *   - `tool`  → an in-process or MCP tool call.
 *   - `agent` → an agent invocation.
 *
 * Invoking another flow is not a leaf kind: it is the `SubflowNode`
 * variant (`kind: 'subgraph'`, schema-version 1.7.0+) with `flowRef` /
 * `inputMapping` / `outputSchema` / `convergence`.
 *
 * The flow package holds no handler bindings; the runtime looks `ref` up
 * in its `HandlerRegistry` (`@kindgi/handler`).
 */
export interface LeafNode {
  /** Node id (unique within the containing flow). */
  readonly id: NodeId;
  /**
   * Which handler kind runs at this node. `'tool'` dispatches
   * `ref` as a `ToolId`; `'agent'` dispatches `ref` as an `AgentId`.
   */
  readonly kind: 'tool' | 'agent';
  /**
   * Reference to the concrete implementation. Interpretation depends on
   * `kind` and is opaque to the flow package.
   */
  readonly ref: string;
  readonly config?: Readonly<Record<string, unknown>>;
  /**
   * What this node's handler receives (schema-version 1.8.0+): each key
   * resolved when the node dispatches, so a node can combine the run
   * input, state and the outputs of any earlier nodes. Absent → the
   * output of the node's single upstream node, or the run input for a
   * `$start` edge. The loader rejects paths that aren't rooted at
   * `runInput` / `state` / `nodeOutputs.<existing node>`.
   */
  readonly inputMapping?: Mapping;
}

/**
 * JSON Schema (draft 2020-12) describing the shape a loop's iteration
 * outputs must conform to. Stored as an opaque object at the flow layer;
 * the kernel validates each iteration's `$loop-end` output against this
 * schema at iteration boundary. Malformed schema surfaces at flow load
 * time via `LoopOutputSchemaError`.
 *
 * Kept as `object` here (not a specific TypeScript type) because JSON
 * Schema's full expressiveness doesn't map cleanly onto a static type.
 * The loader validates that the schema conforms to the draft-2020-12
 * meta-schema; the kernel treats it as opaque input to Ajv.
 */
export type LoopOutputSchema = Readonly<Record<string, unknown>>;

/**
 * Fields shared by every loop variant. See the concrete variants
 * (`WhileLoopNode`, `ForeachLoopNode`) for variant-specific fields.
 *
 * Every iteration produces distinct journal entries (`iteration.started`,
 * `iteration.completed`); body-node journal entries carry a `loopContext`
 * field attributing them to the enclosing iteration. Iterations run one
 * at a time, except in a foreach loop that sets `concurrency` (see
 * `ForeachLoopNode`).
 *
 * Node ids in the body must be globally unique across the entire flow
 * (including sibling loop bodies at any nesting level). This is enforced
 * by the loader.
 *
 * State inside a loop is always loop-internal: body-handler `stateDelta`
 * writes do NOT leak to outer flow state after loop completion. The
 * escape contract is `outputSchema` — required on every loop, no
 * exceptions. There is no `stateScope` option.
 */
interface LoopNodeCommon {
  /** Node id (unique across the ENTIRE flow including nested loop bodies). */
  readonly id: NodeId;
  /** Discriminant — always `'loop'` for this node kind. */
  readonly kind: 'loop';
  /** The body sub-flow iterated per loop pass. */
  readonly body: LoopBody;
  /**
   * Hard cap on iteration count. Required. Bounded to `1 ≤ maxIterations ≤ 10000`
   * by the loader. When the cap is reached, the loop exits with
   * `stopReason: 'max-iterations'`.
   */
  readonly maxIterations: number;
  /**
   * REQUIRED. JSON Schema (draft 2020-12) describing the shape every
   * iteration's `$loop-end` output must satisfy. Also constrains
   * `finalOutput` and (when `collectAllIterations`) each element of
   * `outputs[]`. Every loop declares a typed contract — no exceptions.
   */
  readonly outputSchema: LoopOutputSchema;
  /**
   * When true, the loop node's output includes an `outputs` array with
   * every iteration's `$loop-end` output. When false (default), only the
   * last iteration's output is exposed via `finalOutput`; callers wanting
   * history read the journal.
   */
  readonly collectAllIterations?: boolean;
}

/**
 * A `while`-style loop node: iteration is condition-driven. Runs the
 * body until `exitCondition` evaluates true (or `maxIterations` fires).
 *
 * `evaluationTiming` selects do-while (default) vs while semantics:
 *   - `'after'`  → body runs first, then exit condition is checked
 *                  against the just-completed iteration output. Loop
 *                  always runs at least once. This is `do { body } while (!exit)`.
 *   - `'before'` → exit condition is checked first, against the previous
 *                  iteration's output (or `null` on iteration 0). Body
 *                  may run zero times. This is `while (!exit) { body }`.
 *
 * Exit condition path roots: `state`, `iterationIndex`, `iterationOutput`,
 * and `nodeOutputs.<bodyNodeId>` (of the just-completed iteration; not
 * available on `before`-timed iteration 0).
 */
export interface WhileLoopNode extends LoopNodeCommon {
  readonly loopKind: 'while';
  readonly exitCondition: Expr;
  /**
   * When the exit condition is evaluated relative to the body. Default `'after'`.
   */
  readonly evaluationTiming?: 'before' | 'after';
}

/**
 * A `foreach`-style loop node: iteration is array-driven. Runs the body
 * once per element of `iterateOver` (up to `maxIterations`).
 *
 * `iterateOver` is resolved ONCE at loop-enter time (not re-resolved per
 * iteration) — the array is pinned for the duration of the loop. If it
 * resolves to a non-array, the loop fails immediately with
 * `stopReason: 'iterate-over-not-array'`.
 *
 * Each iteration's `$loop-start` input is the corresponding array element.
 * The loop exits when the array is exhausted (`stopReason: 'array-exhausted'`)
 * or `maxIterations` fires. No exit condition — attempting to declare one
 * is a load-time validation error.
 *
 * `state.$loop.currentElement` inside a foreach body handler is the
 * element fed to the current iteration. `iterationIndex` is the 0-based
 * position in the source array.
 */
export interface ForeachLoopNode extends LoopNodeCommon {
  readonly loopKind: 'foreach';
  /**
   * Operand that must resolve to an array at loop-enter time. Typical
   * shape: `{ path: 'runInput.items' }` or `{ path: 'nodeOutputs.list.records' }`.
   */
  readonly iterateOver: Operand;
  /**
   * Parallel-worker count for iteration dispatch. Default `1` (strictly
   * sequential). When set to N > 1, the
   * kernel spins up N workers that pull iteration indices from a shared
   * counter — iteration `i` is assigned in array order (0, 1, 2, …) but
   * may settle in wall-clock order.
   *
   * Bounded by the loader to `1 ≤ concurrency ≤ min(maxIterations, 32)`.
   * The upper cap of 32 is a fixed safety limit.
   *
   * Canonical guarantees under `concurrency > 1`:
   *   - `outputs[]` (when `collectAllIterations` is true) is sorted by
   *     iteration index, NOT settle order.
   *   - Journal `iteration.*` entries reflect wall-clock settle order.
   *     Consumers sort by `iteration` for canonical projection.
   *   - Handler failure in one iteration cancels all in-flight siblings
   *     cleanly (each journals `iteration.completed` with
   *     `stopReason: 'cancelled'`); the failed iteration journals
   *     `stopReason: 'body-failure'` and the loop node fails.
   *
   * State inside a loop body is per-iteration already (by design),
   * so parallel iterations cannot race on shared body state.
   */
  readonly concurrency?: number;
}

/**
 * A loop node — first-class iteration primitive (schema-version 1.2.0+).
 * Discriminated by `loopKind` into `while` and `foreach` variants.
 */
export type LoopNode = WhileLoopNode | ForeachLoopNode;

/**
 * Convergence mode for a `fanout` node — declared at flow-authoring time,
 * decidable at flow-load time (so downstream consumers know exactly what
 * shape they'll receive).
 *
 *   - `'all-succeed'` — fanout fails on the FIRST branch failure. In-flight
 *      sibling branches are cancelled through the standard kernel abort
 *      path. Output emitted only when EVERY branch succeeds; shape is
 *      `{ [branchId: string]: output }`.
 *   - `'any-succeed'` — fanout succeeds on the FIRST branch success. In-flight
 *      sibling branches are cancelled through the standard kernel abort path.
 *      Output shape is `{ winnerBranchId, output }`. Fails only when every
 *      branch fails.
 *   - `'settle-all'` — fanout waits for every branch to reach a terminal
 *      state (success or fail); no sibling cancellation on failure. Output
 *      shape is `{ [branchId: string]: { status: 'succeeded' | 'failed',
 *      output? | error? } }`. This is the default recommended mode for
 *      supervisor-style "invoke N in parallel and reduce" patterns.
 */
export type ConvergenceMode = 'all-succeed' | 'any-succeed' | 'settle-all';

/**
 * The set of convergence-mode names recognized by the runtime, exported for
 * tooling that needs the closed enum without repeating literals.
 */
export const CONVERGENCE_MODES = ['all-succeed', 'any-succeed', 'settle-all'] as const;

/**
 * One branch of a `fanout` node. Each branch is a distinct handler-registry
 * entry executed concurrently with its siblings; a branch is NOT a sub-flow
 * (unlike a loop body). `branchId` is the stable label used in the fan-in
 * output object and the journal; `handler` is the string key used to look
 * the handler up in the kernel's `HandlerRegistry` (same lookup mechanism
 * as a leaf node's `ref`). `outputSchema` is REQUIRED — the typed contract
 * for this branch's output, validated at settle time.
 */
export interface FanoutBranch {
  readonly branchId: string;
  readonly handler: string;
  readonly outputSchema: LoopOutputSchema;
}

/**
 * A fanout node — first-class parallel-branch primitive (schema-version
 * 1.6.0+). Runs N DIFFERENT handler bodies in parallel from a single
 * dispatch and converges by a declared mode. Complementary to `foreach`
 * (N iterations of the SAME body): fanout invokes N distinct handlers
 * concurrently.
 *
 * The fanout node itself is treated by the outer scheduler as an ordinary
 * node with a single output — its incoming edges resolve the input passed
 * to every branch, and its outgoing edges receive the fan-in output. The
 * fan-in shape depends on `convergence` (see `ConvergenceMode`).
 *
 * Sibling cancellation for `all-succeed` / `any-succeed` propagates via a
 * shared `AbortController` composed with the outer abort signal, so
 * cooperative branch handlers observe cancellation through their
 * `NodeContext.abortSignal` — same discipline as parallel foreach and
 * the outer executor's cancelRun path.
 *
 * Replay semantics: the outer envelope (`step.started` / `step.completed`
 * / `step.failed` for the fanout node id) is journaled as with any other
 * node. Per-branch progress is journaled through the fanout-specific
 * `JournalKind` values (`fanout.dispatched`, `fanout.branch-completed`,
 * `fanout.branch-failed`, `fanout.converged`, `fanout.cancelled-siblings`).
 * On resume, if the fanout's outer `step.completed` is present the
 * converged output is already in `nodeOutputs`; otherwise the whole
 * fanout re-dispatches (same rule as loops — branch handlers are
 * expected to be idempotent, or to use waitForToken for durable side
 * effects).
 */
export interface FanoutNode {
  /** Node id (unique within the containing flow). */
  readonly id: NodeId;
  /** Discriminant — always `'fanout'` for this node kind. */
  readonly kind: 'fanout';
  /**
   * Parallel branches to dispatch. Each branch is one handler (see
   * `FanoutBranch`), not a sub-flow. All branches receive the same
   * input; convergence collects their outputs.
   */
  readonly branches: readonly FanoutBranch[];
  /**
   * Optional bounded worker-pool count. Default: `branches.length` (all
   * branches dispatch concurrently). Loader enforces `1 ≤ concurrency ≤
   * branches.length`. When `concurrency < branches.length`, branches are
   * pulled from the queue in declaration order (deterministic +
   * replay-safe).
   */
  readonly concurrency?: number;
  /** The convergence rule. Decides the fan-in shape (see `ConvergenceMode`). */
  readonly convergence: ConvergenceMode;
}

/**
 * Convergence mode for a `subgraph` node (schema-version 1.7.0+). Declared
 * at flow-authoring time; decidable at flow-load time so downstream
 * consumers know exactly what shape they'll receive from the parent node.
 *
 *   - `'success-only'` — child failure fails the PARENT node. The
 *     parent's `nodeOutputs` entry is never written; the journal records
 *     `subgraph.failed` and the parent step transitions to `step.failed`
 *     with an attribution that names the child run id + stop reason.
 *   - `'settle-all'` — the parent node's output is always a settled
 *     envelope: `{ status: 'succeeded'; output }` when the child run
 *     completed cleanly + its terminal output validated against the
 *     subgraph node's declared `outputSchema`; `{ status: 'failed';
 *     error }` otherwise (child failure, cancellation, or output
 *     schema violation). The parent step transitions to `step.completed`
 *     regardless of child outcome — the failure is DATA at the parent
 *     boundary, not a fault. This is the default recommended mode for
 *     supervisor-style orchestration where "sub-run failed" is a
 *     first-class outcome the parent flow handles explicitly.
 */
export type SubflowConvergence = 'success-only' | 'settle-all';

/**
 * The set of subgraph convergence-mode names recognized by the runtime,
 * exported for tooling that needs the closed enum without duplicating
 * literals.
 */
export const SUBGRAPH_CONVERGENCE_MODES = ['success-only', 'settle-all'] as const;

/**
 * Reference to another registered flow resolvable via
 * `FlowRegistryBinding.getVersion(...)`. Version is an EXACT semver — no
 * ranges — so deterministic replay always resolves the same child flow.
 * Cross-tenant lookup is rejected by construction: the kernel invokes the
 * resolver with the PARENT run's tenantId; a flow registered under a
 * different tenant will not be found.
 */
export interface SubflowRef {
  readonly flowId: string;
  readonly version: string;
}

/**
 * A first-class subgraph-invocation node (schema-version 1.7.0+).
 * Dispatches a full kernel run of another registered flow as one
 * outer-node step. The sub-run has its own independent journal, replay
 * semantics, lease/cancel machinery — every kernel durability
 * guarantee is inherited without re-invention.
 *
 * Complementary to the loop + fanout primitives:
 *   - `loop.foreach` runs the SAME body × N iterations,
 *   - `fanout` runs N DIFFERENT bodies concurrently,
 *   - `subgraph` runs a whole OTHER flow inline as a node.
 *
 * `inputMapping` is a declarative object whose values are `Operand`s
 * (path into `runInput` / `state` / `nodeOutputs.<id>`, or a `literal`).
 * The sub-run's `runInput` is the object produced by resolving every
 * mapping at dispatch time.
 *
 * `outputSchema` is the ESCAPE CONTRACT declared on the parent — decoupled
 * from the sub-flow's own internal shape. Parents state what they can
 * consume; the kernel validates the sub-run's terminal output against
 * this schema at settle time. A validation failure is a `settle-all`
 * `{ status: 'failed', error }` OR a `success-only` parent-step failure.
 *
 * A kernel-enforced max depth (default 10, configurable via
 * `RunOptions.maxSubflowDepth`) prevents runaway recursion. Exceeding
 * the depth fails the parent node at dispatch with attribution
 * `subgraph-depth-exceeded`.
 */
export interface SubflowNode {
  /** Node id (unique within the parent flow). */
  readonly id: NodeId;
  /** Discriminant — always `'subgraph'` for this node kind. */
  readonly kind: 'subgraph';
  /**
   * Which flow to invoke. `{flowId, version}` — `loadFlow` checks
   * only the shape (exact semver). The runtime resolves the sub-flow
   * through the run's `FlowResolver` (`@kindgi/runtime`) when the node
   * dispatches; a flow it can't find fails the node with
   * `subgraph-flow-not-found`. The exact version pins the child flow,
   * so a mid-flight sub-run survives parent-flow edits.
   */
  readonly flowRef: SubflowRef;
  /**
   * Declarative object mapping each top-level key of the sub-run's
   * `runInput` to an Operand. Loader statically verifies every value is
   * a valid Operand; runtime resolution mirrors edge-predicate operand
   * resolution.
   */
  readonly inputMapping: Mapping;
  /**
   * REQUIRED. JSON Schema (draft 2020-12) describing the shape the
   * sub-run's terminal output must satisfy at the parent boundary. The
   * loader validates well-formedness via `InvalidSubflowNodeError`;
   * the kernel validates the sub-run's output at settle time.
   */
  readonly outputSchema: LoopOutputSchema;
  /**
   * Convergence mode — closed enum, extensible additively. See
   * `SubflowConvergence` for the semantics.
   */
  readonly convergence: SubflowConvergence;
}

/**
 * A flow node — either a leaf (tool / agent), a loop (iterating a body
 * sub-flow until an exit condition or array is exhausted), a fanout
 * (running N different bodies in parallel with declared convergence),
 * or a subgraph (invoking another registered flow as a full kernel
 * sub-run). Discriminated by `kind`.
 *
 * Leaf nodes are the majority case. Loop nodes are used for iterative
 * primitives (agent turn loops, retrieval refinement, batch ingest,
 * retry-with-backoff). Fanout nodes are used for supervisor "invoke N
 * sub-agents in parallel and reduce" patterns. Subgraph nodes are used
 * for hierarchical orchestration — composing a large workflow out of
 * smaller registered flows.
 */
export type FlowNode = LeafNode | LoopNode | FanoutNode | SubflowNode;

/**
 * Backoff shape for `RetryPolicy`. Selects how the base `delayMs` grows
 * across successive retry attempts.
 *
 *   - `'fixed'`       → same `delayMs` every retry.
 *   - `'linear'`      → `delayMs * attempt` (capped by `maxDelayMs`).
 *   - `'exponential'` → `delayMs * 2^(attempt - 1)` (capped by `maxDelayMs`).
 *
 * `attempt` is 1-based: the first retry (after the initial failure) uses
 * `attempt = 1`, the second retry `attempt = 2`, etc.
 */
export type BackoffShape = 'fixed' | 'linear' | 'exponential';

/**
 * Declarative retry policy attached to a `FlowEdge` via `policy.retry`.
 * When the destination node's handler fails and the destination has exactly
 * one incoming edge carrying this policy, the kernel schedules successive
 * attempts up to `maxAttempts` (inclusive of the initial call) before
 * journaling `step.failed` terminally.
 *
 * Fan-in nodes (destinations with 2+ incoming edges) intentionally do NOT
 * apply retry — there is no rule for which incoming edge's retry policy
 * would win. A fan-in node with a retry policy on any
 * incoming edge fails on first handler failure exactly as it would with no
 * policy declared.
 */
export interface RetryPolicy {
  /**
   * Total handler attempts, including the first invocation. Bounded to
   * `1 ≤ maxAttempts ≤ 10` by the loader. `1` is equivalent to omitting
   * the policy (no retries). Values above 10 are a design smell — retry-
   * heavy control flow belongs in a supervising flow, not on an edge.
   */
  readonly maxAttempts: number;
  /**
   * Base delay between retries in milliseconds. Default `0`. Combined with
   * `backoff` to produce the actual per-attempt delay. Must be non-negative.
   */
  readonly delayMs?: number;
  /**
   * Backoff shape. Default `'fixed'`. `'exponential'` REQUIRES `maxDelayMs`
   * so the delay cannot grow unbounded.
   */
  readonly backoff?: BackoffShape;
  /**
   * Ceiling on the per-retry delay for `'linear'` / `'exponential'` backoff.
   * Required when `backoff = 'exponential'`; ignored when `backoff = 'fixed'`.
   * For `'linear'`, defaults to `60_000` ms if unset.
   */
  readonly maxDelayMs?: number;
}

/**
 * Per-edge runtime policy. Every field is optional. Four fields are
 * honored by the kernel and are the complete set: `retry`,
 * `timeoutMs`, `concurrencyKey`, and `priority`. There is no `suspend`
 * field — declarative suspension uses `ctx.waitForToken` at handler
 * level.
 * Unknown keys are rejected at load time (`additionalProperties:
 * false` on the JSON schema).
 */
export interface EdgePolicy {
  /**
   * Retry policy for the destination handler. When the sole incoming
   * edge has this set, the kernel retries `step.failed` up to
   * `maxAttempts` with the configured backoff. `retry` is bounded to
   * `1 ≤ maxAttempts ≤ 10`.
   */
  readonly retry?: RetryPolicy;
  /**
   * Per-edge handler-invocation timeout in milliseconds. When set on the
   * SOLE incoming edge of a destination node, the kernel aborts the
   * handler's `ctx.abortSignal` after `timeoutMs` and journals
   * `step.failed` with `payload.reason: 'timeout'`, `limitMs`, and
   * `elapsedMs`. Fan-in nodes (2+ incoming) ignore the timeout — same
   * constraint as `retry`.
   *
   * Bounded to `1 ≤ timeoutMs ≤ 3_600_000` (1 hour). Larger values are
   * almost always a design mistake: long-running work belongs behind
   * `ctx.waitForToken` (durable) or in a `foreach` with `concurrency`
   * (parallelization).
   *
   * Interaction with `retry`: a timed-out attempt counts as one failed
   * attempt. If `retry.maxAttempts > 1`, the node retries the timed-out
   * attempt on the standard schedule.
   *
   * Interaction with cancel: `cancelRun` and the timeout both abort the
   * same handler. Whichever aborts first wins in the journal — cancel
   * fires with `reason: 'cancelled'`, timeout with `reason: 'timeout'`.
   */
  readonly timeoutMs?: number;
  /**
   * Per-key kernel semaphore. When set on the SOLE incoming edge of a
   * destination node, the kernel serializes dispatch across every node
   * (across every run, across every flow, within a single tenant) that
   * shares the same key: at most one such node runs at a time.
   *
   * A node whose lease is unavailable at dispatch time is journaled as
   * `step.concurrency-deferred` and re-considered on the next tick. When
   * the current holder releases the lease (when that node completes,
   * fails or is cancelled), a deferred waiter can acquire it and
   * dispatch.
   *
   * Constraint: max length 256, printable ASCII only (Unicode >0x7E
   * rejected — the key is a coordination handle, not a display label).
   * Empty strings rejected.
   *
   * Fan-in nodes (2+ incoming) ignore `concurrencyKey` — same rule as
   * retry + timeoutMs.
   *
   * Interaction with `retry`: retry-scheduled attempts RE-ACQUIRE the
   * lease on each retry (they don't hold across the backoff delay).
   *
   * Interaction with `timeoutMs`: a timed-out handler releases its
   * lease when the terminal `step.failed` lands.
   *
   * Interaction with cancellation: `cancelRun` releases the lease when
   * the run's holding node journals its terminal event.
   *
   * Interaction with `waitForToken`: a suspending handler RELEASES the
   * lease so peers can proceed. Resumed handler re-acquires the lease
   * before continuing.
   *
   * Sweeper: on `resumeRun` boot, orphaned leases (holder run terminal)
   * are cleaned before scheduling continues.
   */
  readonly concurrencyKey?: string;
  /**
   * Declarative scheduler priority. When the ready set has more than one
   * node, higher-priority nodes dispatch first; ties are broken by
   * ascending lexical node id (deterministic + replay-safe). Applied to
   * the destination node when it has EXACTLY ONE incoming edge — fan-in
   * nodes (2+ incoming) inherit the default (`0`) regardless of any
   * declared priority. Same fan-in rule as retry / timeoutMs /
   * concurrencyKey.
   *
   * Integer, `-100 ≤ priority ≤ 100`. Default `0` (baseline). Positive
   * = more urgent than baseline; negative = background. Integer-only:
   * floats introduce IEEE-754 comparison ambiguity in a sort key that
   * must round-trip identically across every replay. Bounded ±100
   * because the primitive expresses tiers ("urgent" / "normal" /
   * "background") plus finer-grained ordering within a tier — wider
   * ranges add no expressive power.
   *
   * `priority` orders WHICH nodes dispatch first, not HOW MANY dispatch
   * at once. `maxParallelism` still caps the concurrent dispatch count
   * — priority just picks the top-N of the ready set.
   *
   * Interaction with `concurrencyKey`: when multiple nodes contend for
   * the same lease within one executor tick, the priority sort applies
   * before lease acquisition — the higher-priority node attempts (and
   * wins) the lease first; the lower-priority sibling journals
   * `step.concurrency-deferred` and re-attempts on the next tick.
   * Priority does not order nodes that are already waiting on a lease
   * across runs or processes.
   *
   * Interaction with loop bodies: iterations of a loop body dispatch
   * per-iteration; each iteration reads the priority from the body
   * node's edges independently.
   *
   * Determinism: because priority is declarative (from the flow) and
   * tiebreak is lexical (from the node id), the same flow + same
   * journal + same ready set produce the same dispatch order on every
   * replay. No JournalKind is emitted — priority is a scheduling hint,
   * not a durable state transition.
   */
  readonly priority?: number;
}

/**
 * Minimum + maximum values for `EdgePolicy.priority`. Kept as exported
 * constants so downstream tooling (linters, UI editors, docs) can share
 * the same bounds without duplicating literals.
 */
export const EDGE_POLICY_PRIORITY_MIN = -100 as const;
export const EDGE_POLICY_PRIORITY_MAX = 100 as const;
/** The `EdgePolicy.priority` default when the field is unset. */
export const EDGE_POLICY_PRIORITY_DEFAULT = 0 as const;

/**
 * A directed edge from one node (or the flow's virtual start) to another
 * (or the flow's virtual end).
 *
 * Sentinel endpoints:
 *   - `$start` — the flow entry point. At least one edge must originate here.
 *   - `$end`   — the flow exit. Zero or more edges may terminate here.
 */
export interface FlowEdge {
  readonly id: EdgeId;
  readonly from: NodeId | '$start';
  readonly to: NodeId | '$end';
  /**
   * Optional predicate. When absent, the edge fires unconditionally as soon
   * as its `from` node completes. When present, the edge fires iff the
   * predicate evaluates true against the current run environment.
   */
  readonly when?: Expr;
  /**
   * Optional per-edge runtime policy. Complete set of honored fields
   * (each applies only when the destination has EXACTLY ONE incoming
   * edge; fan-in destinations ignore per-edge policy): `retry`,
   * `timeoutMs`, `concurrencyKey`, `priority`.
   */
  readonly policy?: EdgePolicy;
}

/**
 * A directed edge inside a loop body. Same structure as `FlowEdge` but
 * uses `$loop-start` / `$loop-end` sentinels instead of `$start` / `$end`.
 * Enforcing distinct sentinels per scope makes journal queries unambiguous
 * ("was this `$end` for the outer flow or a loop body?").
 */
export interface LoopEdge {
  readonly id: EdgeId;
  readonly from: NodeId | '$loop-start';
  readonly to: NodeId | '$loop-end';
  readonly when?: Expr;
}

/**
 * The sub-flow a loop node iterates. Must be a DAG (own cycle check runs
 * at load time). Node ids must not collide with any other node in the
 * enclosing flow or in sibling loop bodies at any nesting level.
 */
export interface LoopBody {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly LoopEdge[];
}

/**
 * A durable, versioned task flow. Serializable JSON — the same flow
 * definition can execute on any conforming runtime. Runs pin to a specific
 * `version` so mid-flight executions survive flow edits.
 */
export interface Flow {
  /**
   * Globally-unique flow identifier. Convention:
   * `<pack-id>.<flow-name>` (kebab-case, dot-namespaced) — e.g.
   * `acme.brief-review-flow`. The framework's built-in agent-turn
   * flow is `agent.turn` (`AGENT_TURN_FLOW_ID` in `@kindgi/agents`).
   */
  readonly id: FlowId;
  /**
   * Semver — REQUIRED. Runs pin to a specific flow version at
   * `runGraph` time so mid-flight executions survive later flow
   * edits. `SubflowNode.flowRef.version` names one of these versions
   * exactly.
   */
  readonly version: string;
  /** Human-readable name shown in UI + provenance. Doesn't affect execution. */
  readonly name?: string;
  /** Prose describing what the flow does. Surfaced in the flow catalog. */
  readonly description?: string;
  /**
   * All nodes in the flow. Each node has a `kind` (`tool`, `agent`,
   * `loop`, `fanout`, `subgraph`) and kind-specific fields.
   * Order in the array doesn't matter — execution follows the edge
   * DAG, not array order.
   */
  readonly nodes: readonly FlowNode[];
  /**
   * Directed edges connecting node ids. Each edge carries an optional
   * `policy` (`retry`, `timeoutMs`, `concurrencyKey`, `priority`). `$start` + `$end`
   * sentinels are the outer flow's entry/exit.
   */
  readonly edges: readonly FlowEdge[];
  /**
   * Flow-level default for concurrent node dispatch. Kernel uses this
   * when `runGraph` is called without an explicit `options.maxParallelism`.
   * Absent → `DEFAULT_MAX_PARALLELISM` (8) from `@kindgi/runtime`.
   * Per-invocation overrides always win.
   */
  readonly maxParallelism?: number;
  /**
   * Free-form key/value metadata that rides with the flow. Not
   * interpreted by the framework — passthrough for pack-authored
   * annotations (owner, ticket, tags).
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * The run's declared output (schema-version 1.8.0+), resolved when the
   * run completes. Absent → the output of the node feeding the run's
   * `$end` edge (the lowest-id taken one when several fire).
   */
  readonly output?: FlowOutputSpec;
  /**
   * The exact tool and agent versions this flow version runs, resolved by
   * the runtime when the version was published (see `FlowPins`). Never
   * authored: `loadFlow` refuses it. Absent on a flow version published
   * before pins existed; it binds the latest versions per run.
   */
  readonly pins?: FlowPins;
  /** `flowPinsDigest(pins)`, recorded when the version was published. */
  readonly pinsDigest?: string;
  /**
   * Set by the runtime on a version a deploy registered under another
   * number than the definition's (see `VersionDerivation`). Never authored.
   */
  readonly derivedFrom?: VersionDerivation;
}

/**
 * A flow's declared output: what the run returns, built from the
 * finished run's environment rather than from whichever node happened to
 * reach `$end` last.
 */
export interface FlowOutputSpec {
  readonly mapping: Mapping;
  /**
   * Optional JSON Schema (draft 2020-12) the resolved output must
   * satisfy. The loader checks it compiles; the kernel fails the run on
   * a violation.
   */
  readonly schema?: LoopOutputSchema;
}

/**
 * Sentinel node ids used by flow edges. `$start` / `$end` are the outer
 * flow's entry/exit. `$loop-start` / `$loop-end` are the body-scope
 * entry/exit inside a loop node.
 *
 * These sentinels are never present in `flow.nodes` or `LoopBody.nodes` —
 * they're virtual, and no handler executes at them.
 */
export const START_NODE = '$start' as const;
export const END_NODE = '$end' as const;
export const LOOP_START_NODE = '$loop-start' as const;
export const LOOP_END_NODE = '$loop-end' as const;

/** All sentinel ids. Useful for validators that need to reject them as node ids. */
export const SENTINEL_IDS = [START_NODE, END_NODE, LOOP_START_NODE, LOOP_END_NODE] as const;

/** Type guard: is this node a loop node? */
export function isLoopNode(node: FlowNode): node is LoopNode {
  return node.kind === 'loop';
}

/** Type guard: is this node a fanout node? */
export function isFanoutNode(node: FlowNode): node is FanoutNode {
  return node.kind === 'fanout';
}

/** Type guard: is this node a subgraph-invocation node? */
export function isSubflowNode(node: FlowNode): node is SubflowNode {
  return node.kind === 'subgraph';
}

/** Type guard: is this node a leaf? */
export function isLeafNode(node: FlowNode): node is LeafNode {
  return node.kind !== 'loop' && node.kind !== 'fanout' && node.kind !== 'subgraph';
}
