// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Action, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { NodeId, RunId, TenantId } from '@kindgi/types';

/**
 * A node handler is the concrete code the runtime invokes when a flow
 * node becomes ready. The handler is entirely user-authored; the
 * runtime only knows how to route input, capture output, and journal
 * state.
 *
 * Handlers may return:
 *   - a bare `unknown` value → recorded as `nodeOutputs[nodeId]`.
 *   - a `HandlerResult` with `{ output, stateDelta? }` → same, plus the
 *     `stateDelta` is shallow-merged into the run's cumulative `state`.
 *
 * `input` is the node's resolved `inputMapping` when the flow declares one
 * for it; otherwise the output of the single upstream node, or the run
 * input for a `$start` edge. Fan-in handlers (a node with N > 1 upstream
 * edges) without an `inputMapping` receive `input === undefined` and read
 * their siblings' outputs via `ctx.nodeOutputs.get(id)`.
 */
export type NodeHandler = (input: unknown, ctx: NodeContext) => Promise<HandlerResult | unknown>;

/**
 * Structured handler return. Prefer this over a bare value when the node
 * contributes to cumulative `state`.
 */
export interface HandlerResult {
  readonly output: unknown;
  /**
   * Shallow-merged into the run's cumulative `state` on next tick. Under
   * concurrent completions the highest journal sequence wins per key.
   */
  readonly stateDelta?: Readonly<Record<string, unknown>>;
}

/**
 * Runtime binding of `NodeId → NodeHandler`. Passed to the runtime
 * alongside the flow. Every node in the flow must have a matching
 * handler entry; missing handlers are rejected at run start.
 */
export type HandlerRegistry = ReadonlyMap<NodeId, NodeHandler>;

/**
 * Context passed to a node handler. All non-deterministic operations
 * (clock reads, random) MUST go through this so replay from journal
 * yields the same values.
 *
 * Also exposes the read-only cumulative state and prior node outputs the
 * handler may consult — same view the edge predicates saw when this node
 * was scheduled.
 */
export interface NodeContext {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The tenant this run belongs to — required for any tenant-scoped I/O. */
  readonly tenantId: TenantId;
  /**
   * Read-only outputs of previously-completed nodes, keyed by `NodeId`.
   * Present for fan-in and cross-branch reads.
   */
  readonly nodeOutputs: ReadonlyMap<NodeId, unknown>;
  /** Read-only cumulative state at the moment this node was dispatched. */
  readonly state: Readonly<Record<string, unknown>>;
  /**
   * Signal that fires when the run is being torn down — either because
   * cancelRun() was invoked or because a sibling handler failed and the
   * runtime is completing outstanding siblings before marking the run failed.
   *
   * Cooperative handlers should observe this and exit early; uncooperative
   * handlers still run to completion, and the runtime journals whatever they
   * return / throw. The run does not become terminal until every in-flight
   * handler settles.
   */
  readonly abortSignal: AbortSignal;
  /**
   * `true` when this run was started with `RunOptions.dryRun: true`.
   * Handlers with side effects (tool invocation, model calls, DB writes,
   * memory writes) should observe this and self-mock — return
   * schema-conformant planned outputs without actually causing the side
   * effect. Runtime-managed journal writes still happen as normal; the
   * run record is marked `dryRun: true`.
   */
  readonly dryRun: boolean;
  /**
   * The Principal that started this run — user session, agent
   * delegation chain, service_account, or systemPrincipal. Present
   * ONLY when the run was started with a `principal`
   * (`RunFlowInput.principal` in `@kindgi/runtime`); absent otherwise.
   *
   * Handlers that need to construct sub-principals for downstream
   * calls (e.g. delegate(agent, this.principal)) read this here.
   */
  readonly principal?: Principal;
  /**
   * Authz check that THROWS on deny. Preferred inside handlers that
   * expect the happy path (invoke tool, read secret). The thrown
   * error is caught by the runtime's dispatch loop and journaled as
   * `step.failed` with reason `permission-denied`.
   *
   * No-op when the run was started without `authz` configured —
   * exists so handlers can be written uniformly for runs with and
   * without authorization.
   */
  authorize(action: Action, resource: ResourceRef): Promise<void>;
  /** Non-throwing check — returns a boolean. For conditional logic. */
  can(action: Action, resource: ResourceRef): Promise<boolean>;
  /** Full Decision — for advanced cases needing reason/evidence. */
  check(action: Action, resource: ResourceRef): Promise<Decision>;
  /**
   * Read the clock, as `record` does: each call journals `Date.now()`.
   * When the step resumes after a wait, its first call returns the time
   * the first call read before, its second the second's, and so on; calls
   * past those read the clock. A retry after a failure reads it afresh.
   * **Determinism:** call it in the same order every time the step runs.
   */
  clockNow(): Promise<number>;
  /**
   * Decide once for this step. The first call for `key` runs `decide`,
   * journals its result, then returns it. When the step runs again
   * (resumed after a wait, or retried after a failure), the call returns
   * the journaled result and `decide` doesn't run, whatever the data it
   * decided from says now.
   *
   * For a decision the step must keep across a wait: an approval gate's
   * (did the policy ask for a review, under which token), so a policy
   * changed meanwhile can't undo the park or lose the reviewer's answer.
   *
   * - The result is kept as JSON, and returned as JSON the first time too
   *   (a `Date` comes back as its string): `decide` returns JSON data.
   * - `undefined` isn't journaled: the next call decides again.
   * - `key` names the decision within the step; a step in a loop body
   *   keeps one per iteration. Calls for one key at the same time share
   *   one decision.
   */
  record<T>(key: string, decide: () => T | Promise<T>): Promise<T>;
  /**
   * Suspend the handler and wait for an external `completeToken(tokenId,
   * value)`. On first invocation: journals `wait.suspended`, inserts a
   * pending waitpoint row, and throws an internal suspension signal — the
   * executor catches this specific class, marks the run `suspended`, and
   * exits the tick loop cleanly (no `step.failed`).
   *
   * On handler re-invocation after `completeToken` + `resumeRun`, the same
   * `ctx.waitForToken(tokenId)` call reads the `wait.resumed` value from
   * the journal and returns it.
   *
   * **Determinism:** callers must issue `waitForToken` with the same
   * `tokenId` in the same call order across replays. The value type `T`
   * is caller-asserted; the runtime does not validate the resolved shape.
   *
   * **Node re-runs on resume.** Any handler side effects that happened
   * before the first `waitForToken` will re-run on each resume — structure
   * work so side effects live *after* the wait, or make them idempotent.
   *
   * `timeoutMs`: optional deadline. When set, the waitpoint timeout
   * sleeper (`WaitpointBinding` in `@kindgi/runtime`) cancels this
   * waitpoint with `reason: 'timeout'` if it hasn't resolved by
   * `Date.now() + timeoutMs`. The handler's re-invocation after cancel
   * throws `WaitpointCancelledError` from `waitForToken`. Timeout is
   * stored on the waitpoint row — durable across process restarts.
   */
  waitForToken<T>(tokenId: string, options?: { timeoutMs?: number }): Promise<T>;
}

/**
 * Loop-context annotation attached to journal payloads of nodes and edges
 * that ran inside a loop body. Absent on outer-flow entries.
 *
 * `iteration` is the 0-based index within the enclosing loop.
 * `path` is the innermost-first stack of enclosing loops when nested
 * (single-element for a flat loop, N-element for N-deep nesting).
 */
export interface LoopContext {
  readonly loopNodeId: NodeId;
  readonly iteration: number;
  readonly path: readonly { readonly loopNodeId: NodeId; readonly iteration: number }[];
}

/**
 * The output produced by a loop node (visible to downstream outer-flow
 * nodes as `nodeOutputs.get(loopNodeId)` and matches the loop's declared
 * `outputSchema` for `finalOutput` and each element of `outputs`).
 *
 * `stopReason` on the loop-node output cannot be `'output-schema-violation'`,
 * `'body-failure'`, or `'cancelled'` — those cause the loop node itself
 * to fail (`step.failed`), so no `nodeOutputs` entry is written for the
 * loop.
 */
export interface LoopNodeOutput<TFinal = unknown> {
  readonly finalOutput: TFinal;
  readonly iterations: number;
  readonly stopReason: 'exit-condition' | 'max-iterations' | 'array-exhausted';
  readonly outputs?: readonly TFinal[];
}
