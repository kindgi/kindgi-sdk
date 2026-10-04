// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { HandlerResult, LoopContext } from '@kindgi/handler';
import type { EdgeId, NodeId } from '@kindgi/types';

import type { JournalEntry, ValueRecordedPayload } from './types.js';

/**
 * Pure functions that project journal entries into the state shapes the
 * scheduler + evaluator consume. The journal is the sole source of truth
 * for run state — every derivation goes through here.
 */

export interface DerivedRunState {
  readonly completedNodes: Set<NodeId>;
  readonly inFlightNodes: Set<NodeId>;
  readonly failedNodes: Set<NodeId>;
  /**
   * Nodes whose most recent state transition is `wait.suspended` with no
   * matching `wait.resumed` yet. The executor treats these as "in-progress
   * from the scheduler's POV" (merged with `inFlightNodes` when building
   * `SchedulerState`) so they don't get re-dispatched while the wait is
   * outstanding, and terminates the tick loop as `suspended` when every
   * outstanding node is in this bucket.
   */
  readonly suspendedNodes: Set<NodeId>;
  /**
   * Nodes whose most recent transition is `step.concurrency-deferred` with
   * no subsequent `step.started` / `step.failed`. Recorded so the tick
   * loop knows the ready-set entry is "waiting on a lease" — dispatch
   * skips these until the lease releases, then re-attempts acquisition
   * on the next tick. Not merged into `inFlightNodes` (they haven't run
   * yet); a deferred-only run isn't `suspended` (which is a wait-token
   * concept) — it's transiently blocked on a peer.
   */
  readonly deferredNodes: Set<NodeId>;
  readonly edgeDecisions: Map<EdgeId, boolean>;
  readonly nodeOutputs: Map<NodeId, unknown>;
  readonly state: Record<string, unknown>;
  /**
   * Ordered log of step.failed messages, first-seen order. Used to build
   * `run.failed`'s summary payload.
   */
  readonly failureMessages: string[];
  /**
   * Resolved wait values, keyed by `${nodeId}::${tokenId}`. Populated from
   * `wait.resumed` journal entries. Handlers re-invoked after resume read
   * from this map inside `ctx.waitForToken()` to return the resolved value
   * instead of suspending again.
   */
  readonly waitResolutions: Map<string, unknown>;
  /**
   * Cancelled wait reasons, keyed by `${nodeId}::${tokenId}`. Populated from
   * `wait.cancelled` journal entries. Handlers re-invoked after cancel read
   * from this map inside `ctx.waitForToken()` to throw a
   * `WaitpointCancelledError` instead of returning a value.
   */
  readonly waitCancellations: Map<string, string>;
  /**
   * Attempt counter per node, derived by counting `step.retry-scheduled`
   * journal entries for that node. `0` on the initial dispatch. After N
   * retries the counter is `N`. Exposed for observability + the executor's
   * retry decision path; not consulted by the scheduler otherwise.
   */
  readonly nodeAttempts: Map<NodeId, number>;
  /**
   * Loop-body steps that completed, keyed by `bodyStepKey(nodeId,
   * loopContext)`. A loop replays from iteration zero on resume; the loop
   * executor hands a body step that already completed its journaled
   * result instead of running it again, as the outer flow does for its
   * own completed steps.
   */
  readonly completedBodySteps: Map<string, CompletedBodyStep>;
  /**
   * Steps' recorded decisions (`NodeContext.record`, `clockNow`), keyed
   * by `recordedValueKey(scope, key)`. Populated from `value.recorded`
   * entries; a step that runs again reads its own back instead of
   * deciding again. The last entry for a key wins.
   */
  readonly recordedValues: Map<string, unknown>;
}

/** What a loop-body step journaled when it completed. */
export interface CompletedBodyStep {
  readonly output: unknown;
  readonly stateDelta?: Readonly<Record<string, unknown>>;
}

/** Composite key for `waitResolutions` lookups. */
export function waitResolutionKey(nodeId: NodeId, tokenId: string): string {
  return `${nodeId}::${tokenId}`;
}

/** Composite key for `recordedValues` lookups: the step's scope, and the decision's key. */
export function recordedValueKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

/** A loop-body step's key in `completedBodySteps`: the node, at its iteration of every enclosing loop. */
export function bodyStepKey(nodeId: NodeId, loopContext: LoopContext): string {
  return `${nodeId}@${loopContext.path.map((p) => `${p.loopNodeId}#${p.iteration}`).join('/')}`;
}

/**
 * Fold journal entries into the run state view the scheduler needs.
 *
 * Rules:
 *   - `step.started` puts the node into `inFlightNodes`.
 *   - `step.completed` removes it from `inFlightNodes`, adds to `completedNodes`,
 *     records its `output` in `nodeOutputs`, and shallow-merges any `stateDelta`
 *     into `state` (last-writer-wins by journal sequence).
 *   - `step.failed` removes it from `inFlightNodes`, adds to `failedNodes`, and
 *     records the failure message.
 *   - `edge.evaluated` records the decision keyed by edgeId.
 *   - `wait.suspended` moves the node from `inFlightNodes` to
 *     `suspendedNodes`; `wait.resumed` / `wait.cancelled` take it out of
 *     `suspendedNodes` and record the value / reason by
 *     `waitResolutionKey(nodeId, tokenId)`.
 *   - `step.retry-scheduled` clears the node's failed / in-flight markers
 *     and increments `nodeAttempts`.
 *   - `step.concurrency-deferred` adds the node to `deferredNodes`.
 *   - a `step.completed` with a `loopContext` (a loop-body step) is also
 *     recorded in `completedBodySteps`.
 *   - `value.recorded` records the value by `recordedValueKey(scope, key)`.
 *   - Every other kind is informational (run.started, run.completed, etc.).
 */
export function deriveRunState(journal: readonly JournalEntry[]): DerivedRunState {
  const state = createRunState();
  for (const entry of journal) applyJournalEntry(state, entry);
  return state;
}

/** The state of a run with no journal entries — `deriveRunState([])`. */
export function createRunState(): DerivedRunState {
  return {
    completedNodes: new Set<NodeId>(),
    inFlightNodes: new Set<NodeId>(),
    failedNodes: new Set<NodeId>(),
    suspendedNodes: new Set<NodeId>(),
    deferredNodes: new Set<NodeId>(),
    edgeDecisions: new Map<EdgeId, boolean>(),
    nodeOutputs: new Map<NodeId, unknown>(),
    state: {},
    failureMessages: [],
    waitResolutions: new Map<string, unknown>(),
    waitCancellations: new Map<string, string>(),
    nodeAttempts: new Map<NodeId, number>(),
    completedBodySteps: new Map<string, CompletedBodyStep>(),
    recordedValues: new Map<string, unknown>(),
  };
}

/**
 * Apply one journal entry to `state`, in place, by the rules of
 * `deriveRunState` (which folds the journal with it). A runtime that
 * keeps a run's state in memory reads the journal once, then applies each
 * entry it writes, instead of reading the journal again.
 */
export function applyJournalEntry(state: DerivedRunState, entry: JournalEntry): void {
  applyEntry(state as MutableDerivedState, entry);
}

/**
 * A copy of `state` that later `applyJournalEntry` calls on `state` don't
 * change — what a step sees should be the run as it stood when the step
 * was dispatched. Values (node outputs, state values) are shared, not
 * copied; the journal never changes a value in place.
 */
export function cloneRunState(state: DerivedRunState): DerivedRunState {
  return {
    completedNodes: new Set(state.completedNodes),
    inFlightNodes: new Set(state.inFlightNodes),
    failedNodes: new Set(state.failedNodes),
    suspendedNodes: new Set(state.suspendedNodes),
    deferredNodes: new Set(state.deferredNodes),
    edgeDecisions: new Map(state.edgeDecisions),
    nodeOutputs: new Map(state.nodeOutputs),
    state: { ...state.state },
    failureMessages: [...state.failureMessages],
    waitResolutions: new Map(state.waitResolutions),
    waitCancellations: new Map(state.waitCancellations),
    nodeAttempts: new Map(state.nodeAttempts),
    completedBodySteps: new Map(state.completedBodySteps),
    recordedValues: new Map(state.recordedValues),
  };
}

interface MutableDerivedState {
  completedNodes: Set<NodeId>;
  inFlightNodes: Set<NodeId>;
  failedNodes: Set<NodeId>;
  suspendedNodes: Set<NodeId>;
  deferredNodes: Set<NodeId>;
  edgeDecisions: Map<EdgeId, boolean>;
  nodeOutputs: Map<NodeId, unknown>;
  state: Record<string, unknown>;
  failureMessages: string[];
  waitResolutions: Map<string, unknown>;
  waitCancellations: Map<string, string>;
  nodeAttempts: Map<NodeId, number>;
  completedBodySteps: Map<string, CompletedBodyStep>;
  recordedValues: Map<string, unknown>;
}

function applyEntry(acc: MutableDerivedState, entry: JournalEntry): void {
  switch (entry.kind) {
    case 'step.started':
      applyStepStarted(acc, entry);
      return;
    case 'step.completed':
      applyStepCompleted(acc, entry);
      return;
    case 'step.failed':
      applyStepFailed(acc, entry);
      return;
    case 'edge.evaluated':
      applyEdgeEvaluated(acc, entry);
      return;
    case 'wait.suspended':
      applyWaitSuspended(acc, entry);
      return;
    case 'wait.resumed':
      applyWaitResumed(acc, entry);
      return;
    case 'wait.cancelled':
      applyWaitCancelled(acc, entry);
      return;
    case 'step.retry-scheduled':
      applyStepRetryScheduled(acc, entry);
      return;
    case 'step.concurrency-deferred':
      applyStepConcurrencyDeferred(acc, entry);
      return;
    case 'value.recorded':
      applyValueRecorded(acc, entry);
      return;
    default:
      // iteration.*, fanout.*, subgraph.*, run.*, clock.read: informational.
      // Derivation observes them via their paired step.* entries.
      return;
  }
}

function applyStepStarted(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  // Re-dispatch after wait.resumed: node moves out of suspendedNodes and
  // back into inFlightNodes. Duplicate step.started entries collapse
  // idempotently — first occurrence wins, subsequent ones are no-ops
  // beyond ensuring the node is in inFlightNodes.
  acc.suspendedNodes.delete(entry.nodeId);
  // A prior step.concurrency-deferred no longer applies once the node
  // starts — clear the deferred marker so the scheduler no longer treats
  // this node as waiting on a lease.
  acc.deferredNodes.delete(entry.nodeId);
  acc.inFlightNodes.add(entry.nodeId);
}

function applyStepCompleted(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  acc.inFlightNodes.delete(entry.nodeId);
  // Clear residual suspended-marker in case this completion is a body
  // node re-run after a loop-level resume (the suspend was written
  // against the body node too).
  acc.suspendedNodes.delete(entry.nodeId);
  acc.deferredNodes.delete(entry.nodeId);
  acc.completedNodes.add(entry.nodeId);
  const p = entry.payload as
    | {
        readonly output?: unknown;
        readonly stateDelta?: Record<string, unknown>;
        readonly loopContext?: LoopContext;
      }
    | undefined;
  if (p !== undefined && 'output' in p) acc.nodeOutputs.set(entry.nodeId, p.output);
  if (p?.stateDelta !== undefined) {
    for (const [k, v] of Object.entries(p.stateDelta)) acc.state[k] = v;
  }
  if (p?.loopContext !== undefined) {
    acc.completedBodySteps.set(bodyStepKey(entry.nodeId, p.loopContext), {
      output: p.output,
      ...(p.stateDelta !== undefined && { stateDelta: p.stateDelta }),
    });
  }
}

function applyStepFailed(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  acc.inFlightNodes.delete(entry.nodeId);
  acc.suspendedNodes.delete(entry.nodeId);
  acc.deferredNodes.delete(entry.nodeId);
  acc.failedNodes.add(entry.nodeId);
  const m = (entry.payload as { readonly message?: unknown } | undefined)?.message;
  if (typeof m === 'string') acc.failureMessages.push(m);
}

function applyEdgeEvaluated(acc: MutableDerivedState, entry: JournalEntry): void {
  const p = entry.payload as { readonly edgeId?: string; readonly decision?: unknown } | undefined;
  if (p?.edgeId !== undefined && typeof p.decision === 'boolean') {
    acc.edgeDecisions.set(p.edgeId as EdgeId, p.decision);
  }
}

function applyWaitSuspended(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  // Handler suspended mid-flight: drop from inFlightNodes, mark suspended.
  // The step.started for this node stays "logically active" — resume
  // dispatch re-fires step.started, which flips node back to inFlightNodes.
  acc.inFlightNodes.delete(entry.nodeId);
  acc.suspendedNodes.add(entry.nodeId);
}

function applyStepRetryScheduled(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  // Retry-scheduled means: the handler just failed, the executor decided
  // to retry, and is about to re-dispatch. Clear residual failure /
  // in-flight markers so the node is re-dispatched cleanly on the next
  // tick's ready set. Attempt counter increments monotonically.
  acc.failedNodes.delete(entry.nodeId);
  acc.inFlightNodes.delete(entry.nodeId);
  const current = acc.nodeAttempts.get(entry.nodeId) ?? 0;
  acc.nodeAttempts.set(entry.nodeId, current + 1);
}

function applyStepConcurrencyDeferred(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  // Deferred means: the dispatcher tried to acquire the lease and failed.
  // The node is not yet in-flight; a subsequent step.started (once the
  // lease is free) clears this marker. Duplicate deferred entries collapse
  // idempotently — the node is either in deferredNodes or not, count is
  // observability-only via the raw journal.
  acc.deferredNodes.add(entry.nodeId);
}

function applyWaitResumed(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  acc.suspendedNodes.delete(entry.nodeId);
  const p = entry.payload as { readonly tokenId?: unknown; readonly value?: unknown } | undefined;
  if (p !== undefined && typeof p.tokenId === 'string') {
    // Record the resolved value against the (nodeId, tokenId) pair so the
    // handler re-invocation reads it back through `ctx.waitForToken()`.
    acc.waitResolutions.set(waitResolutionKey(entry.nodeId, p.tokenId), p.value);
  }
}

function applyWaitCancelled(acc: MutableDerivedState, entry: JournalEntry): void {
  if (entry.nodeId === undefined) return;
  // Cancel resolves the suspension too — the node moves out of suspendedNodes
  // and is redispatched so its handler re-runs, reads the cancellation
  // from waitCancellations via ctx.waitForToken(), and throws
  // WaitpointCancelledError to propagate through the flow as a failure.
  acc.suspendedNodes.delete(entry.nodeId);
  const p = entry.payload as { readonly tokenId?: unknown; readonly reason?: unknown } | undefined;
  if (p !== undefined && typeof p.tokenId === 'string') {
    const reason = typeof p.reason === 'string' ? p.reason : 'unknown';
    acc.waitCancellations.set(waitResolutionKey(entry.nodeId, p.tokenId), reason);
  }
}

function applyValueRecorded(acc: MutableDerivedState, entry: JournalEntry): void {
  const p = entry.payload as Partial<ValueRecordedPayload> | undefined;
  if (p === undefined || typeof p.scope !== 'string' || typeof p.key !== 'string') return;
  acc.recordedValues.set(recordedValueKey(p.scope, p.key), p.value);
}

/**
 * Normalize a raw handler return into a HandlerResult shape. Bare values
 * become `{ output: value }`; already-structured values pass through.
 */
export function normalizeHandlerResult(raw: unknown): HandlerResult {
  if (raw !== null && typeof raw === 'object' && 'output' in raw) {
    const r = raw as Partial<HandlerResult>;
    if (r.stateDelta !== undefined) {
      return { output: r.output, stateDelta: r.stateDelta };
    }
    return { output: r.output };
  }
  return { output: raw };
}
