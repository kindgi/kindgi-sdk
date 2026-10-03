// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LoopContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

/** Terminal states are `completed`, `failed`, `cancelled`. */
export type RunStatus = 'pending' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface RunResult<TOutput = unknown> {
  readonly runId: RunId;
  readonly status: RunStatus;
  /**
   * For completed runs: the flow's declared output (`Flow.output`) when the
   * flow has one; otherwise the output of the node whose edge reached
   * `$end`. When multiple `$end`-terminating edges fire, one is picked
   * deterministically (lowest edge id in traversal order).
   */
  readonly output?: TOutput;
  readonly failureMessage?: string;
  /** Free-form projectId echoed back if the run was bound to one. */
  readonly projectId?: ProjectId;
  readonly tenantId: TenantId;
}

/** Kernel journal entry kinds. */
export type JournalKind =
  | 'run.started'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.retry-scheduled'
  | 'step.concurrency-deferred'
  | 'edge.evaluated'
  | 'iteration.started'
  | 'iteration.completed'
  | 'fanout.dispatched'
  | 'fanout.branch-completed'
  | 'fanout.branch-failed'
  | 'fanout.converged'
  | 'fanout.cancelled-siblings'
  | 'subgraph.dispatched'
  | 'subgraph.completed'
  | 'subgraph.failed'
  | 'subgraph.cancelled'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'wait.suspended'
  | 'wait.resumed'
  | 'wait.cancelled'
  | 'clock.read';

/**
 * Journal payload for `step.retry-scheduled`. Emitted when a node handler
 * fails but the destination's sole incoming edge carries a `retry` policy
 * with attempts remaining. The executor waits `nextDelayMs` (subject to the
 * backoff shape) then re-dispatches the node.
 *
 * `attempt` is 1-based: `1` means the first retry (following the initial
 * failure), `2` the second, etc. The number of `step.retry-scheduled`
 * entries for a given node is the attempt count at derivation time.
 */
export interface StepRetryScheduledPayload {
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly nextDelayMs: number;
  readonly previousError: string;
}

/**
 * Journal payload for `step.concurrency-deferred`. Emitted when the
 * dispatcher attempts to acquire a `policy.concurrencyKey` lease for a
 * ready node and the lease is already held. The node stays in the ready
 * set (from the scheduler's POV) but is deferred for the current tick;
 * on the next tick, after the current holder releases, one waiter
 * acquires and dispatches.
 *
 * `holderRunId` + `holderNodeId` attribute the current holder so an
 * operator can debug "why is my node stuck?" without looking up other runs.
 * `holderRunId` may equal the deferred node's run (self-contention) or a
 * different run in the same tenant.
 *
 * Multiple `step.concurrency-deferred` entries for the same node are
 * expected under long-held leases — derivation records only that the
 * node is in the deferred bucket, not the count.
 */
export interface StepConcurrencyDeferredPayload {
  readonly nodeId: NodeId;
  readonly concurrencyKey: string;
  readonly holderRunId: RunId;
  readonly holderNodeId: NodeId;
}

/**
 * Journal payload doc shape for `iteration.started`.
 *
 * `bodyExecuted` is `false` only when a `while` loop with
 * `evaluationTiming: 'before'` short-circuits its exit check before the
 * body runs — in that case `exitConditionResult` is populated on
 * `iteration.started` (and `iteration.completed` isn't emitted for the
 * skipped iteration).
 */
export interface IterationStartedPayload {
  readonly iteration: number;
  readonly bodyExecuted: boolean;
  readonly exitConditionResult?: boolean | undefined;
  readonly loopContext?: LoopContext | undefined;
}

/**
 * Journal payload doc shape for `iteration.completed`.
 *
 * `outputSchemaValid` records whether the iteration's `$loop-end` output
 * validated against the loop's `outputSchema`. On failure, `stopReason`
 * is `'output-schema-violation'` and `schemaErrors` is populated.
 *
 * For `while` loops with `evaluationTiming: 'after'`, `exitConditionResult`
 * is populated. For `while+before`, the check happens on the NEXT
 * iteration's `iteration.started` and is absent here. For `foreach`, no
 * exit condition — absent.
 *
 * `stopReason` is only populated on the FINAL iteration (the one that
 * caused the loop to exit). Intermediate iterations have it as undefined.
 */
export interface IterationCompletedPayload {
  readonly iteration: number;
  readonly output: unknown;
  readonly outputSchemaValid: boolean;
  readonly schemaErrors?: readonly unknown[] | undefined;
  readonly exitConditionResult?: boolean | undefined;
  readonly stopReason?:
    | 'exit-condition'
    | 'max-iterations'
    | 'array-exhausted'
    | 'output-schema-violation'
    | 'body-failure'
    | 'cancelled'
    | 'iterate-over-not-array'
    | undefined;
  readonly loopContext?: LoopContext | undefined;
}

/**
 * Journal payload for `fanout.dispatched`. Emitted once per branch, before
 * the branch handler is invoked. `input` is the same value every branch of
 * the fanout receives (the fanout node's own resolved input).
 */
export interface FanoutDispatchedPayload {
  readonly fanoutNodeId: NodeId;
  readonly branchId: string;
  readonly handler: string;
  readonly input: unknown;
}

/**
 * Journal payload for `fanout.branch-completed`. Emitted when a branch's
 * handler returns AND the resulting output validates against the branch's
 * declared `outputSchema`.
 */
export interface FanoutBranchCompletedPayload {
  readonly fanoutNodeId: NodeId;
  readonly branchId: string;
  readonly output: unknown;
}

/**
 * Journal payload for `fanout.branch-failed`. Emitted when a branch fails.
 * `reason` narrows the failure attribution so consumers do not have to
 * match on the message. `schemaErrors` is populated when
 * `reason === 'output-schema-violation'`.
 */
export interface FanoutBranchFailedPayload {
  readonly fanoutNodeId: NodeId;
  readonly branchId: string;
  readonly message: string;
  readonly reason: 'handler-throw' | 'output-schema-violation' | 'cancelled';
  readonly schemaErrors?: readonly unknown[];
}

/**
 * Journal payload for `fanout.converged`. Emitted once, after the fanout
 * finalizes on a successful convergence. Carries the fan-in-shaped output
 * that will be handed to downstream consumers via `nodeOutputs`.
 */
export interface FanoutConvergedPayload {
  readonly fanoutNodeId: NodeId;
  readonly convergence: 'all-succeed' | 'any-succeed' | 'settle-all';
  readonly output: unknown;
}

/**
 * Journal payload for `fanout.cancelled-siblings`. Emitted once, when the
 * convergence mode short-circuits (all-succeed on first failure OR
 * any-succeed on first success) and in-flight sibling branches are
 * cancelled. `reason` records which convergence trigger fired;
 * `cancelledBranchIds` enumerates every branch that received the abort
 * signal (whether or not it had already settled — the journal captures
 * intent).
 */
export interface FanoutCancelledSiblingsPayload {
  readonly fanoutNodeId: NodeId;
  readonly cancelledBranchIds: readonly string[];
  readonly reason: 'first-failure' | 'first-success';
}

/**
 * Fan-in shape emitted by a fanout node whose convergence mode is
 * `'all-succeed'`. Object keyed by every branchId, mapping to that
 * branch's validated output.
 */
export interface FanoutAllSucceedOutput {
  readonly [branchId: string]: unknown;
}

/**
 * Fan-in shape emitted by a fanout node whose convergence mode is
 * `'any-succeed'`. Records the identity of the winning branch and its
 * validated output. In-flight siblings were cancelled and do not appear.
 */
export interface FanoutAnySucceedOutput {
  readonly winnerBranchId: string;
  readonly output: unknown;
}

/**
 * Per-branch outcome inside a `'settle-all'` fan-in output. `status` is
 * `'succeeded'` when the branch handler returned a schema-valid output
 * (present in `output`), `'failed'` when the branch failed (handler
 * threw OR output schema violation, message in `error`).
 */
export interface FanoutSettleAllBranchOutcome {
  readonly status: 'succeeded' | 'failed';
  readonly output?: unknown;
  readonly error?: string;
}

/**
 * Fan-in shape emitted by a fanout node whose convergence mode is
 * `'settle-all'`. Object keyed by every branchId, mapping to that
 * branch's terminal outcome.
 */
export interface FanoutSettleAllOutput {
  readonly [branchId: string]: FanoutSettleAllBranchOutcome;
}

/**
 * Journal payload for `subgraph.dispatched`. Emitted before the child
 * kernel run is started, so restarts observe consistent parent-journal
 * state. Carries the child `runId` so replay can resolve back to the
 * exact sub-run (rather than re-dispatching a fresh one).
 */
export interface SubflowDispatchedPayload {
  readonly subgraphNodeId: NodeId;
  readonly subRunId: RunId;
  readonly flowRef: { readonly flowId: string; readonly version: string };
  readonly subInput: unknown;
  readonly depth: number;
}

/**
 * Journal payload for `subgraph.completed`. Emitted when the child kernel
 * run reaches `status: 'completed'` AND its terminal output validates
 * against the parent's declared `outputSchema`. `validatedOutput` is the
 * schema-valid value; the parent node's own `step.completed` follows,
 * with an output shape decided by the parent's `convergence` mode.
 */
export interface SubflowCompletedPayload {
  readonly subgraphNodeId: NodeId;
  readonly subRunId: RunId;
  readonly output: unknown;
}

/**
 * Journal payload for `subgraph.failed`. Emitted when the child run
 * failed OR its terminal output failed schema validation. Attribution:
 *   - `child-failed`   → child kernel run terminated with `failed` status.
 *   - `output-schema-violation` → child completed but its output did not
 *     match the parent's declared `outputSchema`.
 *   - `subgraph-flow-not-found` → resolver returned null at dispatch.
 *   - `subgraph-depth-exceeded` → parent's `RunOptions.maxSubflowDepth`
 *     was hit at dispatch.
 *   - `subgraph-cross-tenant` → attempted lookup of a flow registered
 *     under a different tenant (reserved — cannot happen with the current
 *     resolver contract but journaled defensively).
 *   - `resolver-missing` → the run was started without a `flowResolver`
 *     dependency wired in, so the subgraph node cannot dispatch.
 */
export interface SubflowFailedPayload {
  readonly subgraphNodeId: NodeId;
  readonly subRunId?: RunId;
  readonly flowRef?: { readonly flowId: string; readonly version: string };
  readonly reason:
    | 'child-failed'
    | 'output-schema-violation'
    | 'subgraph-flow-not-found'
    | 'subgraph-depth-exceeded'
    | 'subgraph-cross-tenant'
    | 'resolver-missing';
  readonly message: string;
  readonly schemaErrors?: readonly unknown[];
}

/**
 * Journal payload for `subgraph.cancelled`. Emitted when the parent run is
 * being torn down (external `cancelRun`) OR when a sibling handler failed
 * and the composed abort signal cascades to the child. Under `settle-all`
 * convergence, the parent step still transitions to `step.completed` with
 * an `error` envelope; under `success-only`, the parent step transitions
 * to `step.failed`.
 */
export interface SubflowCancelledPayload {
  readonly subgraphNodeId: NodeId;
  readonly subRunId: RunId;
  readonly stopReason: 'cancelled';
}

/**
 * Fan-in shape emitted by a `subgraph` node whose convergence mode is
 * `'success-only'`. When the child run succeeded and its output
 * validated, the parent node's output IS the validated child output.
 * No wrapping envelope. When the child fails, the parent step
 * transitions to `step.failed` (no output written).
 */
export type SubflowSuccessOnlyOutput = unknown;

/**
 * Fan-in shape emitted by a `subgraph` node whose convergence mode is
 * `'settle-all'`. Always a settled envelope: on success the `output`
 * carries the schema-valid child output; on failure the `error` names
 * the attribution.
 */
export interface SubflowSettleAllOutput {
  readonly status: 'succeeded' | 'failed';
  readonly output?: unknown;
  readonly error?: string;
}

export interface JournalEntry {
  readonly sequence: number;
  readonly kind: JournalKind;
  readonly nodeId?: NodeId;
  readonly payload?: unknown;
  readonly timestamp: Timestamp;
}

/** Kernel run-configuration knobs. */
export interface RunOptions {
  /**
   * Maximum number of node handlers dispatched concurrently in a single
   * tick. Prevents accidental self-DoS on downstream systems from wide
   * fan-outs. Default: 8.
   */
  readonly maxParallelism?: number;
  /**
   * When `true`, the run executes in dry-run mode: `NodeContext.dryRun`
   * is exposed to every handler so they can self-mock side-effecting
   * calls (tool invocation, model calls, DB writes). The run record is
   * marked `dryRun: true` (`KernelRunRecord.dryRun`); the journal shape is
   * unchanged. Consumers (the client's `runs.dryRun`, cost estimators,
   * plan viewers) filter on that flag. Default: `false`.
   */
  readonly dryRun?: boolean;
  /**
   * Maximum sub-flow invocation depth. A parent run at depth 0 that
   * dispatches a `subgraph` node produces a child at depth 1; the child
   * dispatching its own subgraph node produces a grandchild at depth 2;
   * and so on. Exceeding this cap fails the subgraph node at dispatch
   * with `subgraph-depth-exceeded`. Default: 10. Configured on the
   * outermost `RunBinding.runGraph` call — children inherit the same cap.
   */
  readonly maxSubflowDepth?: number;
}

export const DEFAULT_MAX_PARALLELISM = 8;

/** Default cap on nested sub-flow depth. See `RunOptions.maxSubflowDepth`. */
export const DEFAULT_MAX_SUBGRAPH_DEPTH = 10;
