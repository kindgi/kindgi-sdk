// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EdgeId, NodeId } from '@kindgi/types';

import { type EvalEnv, evaluateExpr } from './evaluator.js';
import type { Flow, FlowEdge } from './types.js';
import { EDGE_POLICY_PRIORITY_DEFAULT, END_NODE, START_NODE } from './types.js';

/**
 * State the scheduler needs from the kernel to decide what to dispatch next.
 * Everything here is derived from journal entries — the kernel is the source
 * of truth. The scheduler is pure and stateless.
 */
export interface SchedulerState {
  /** Nodes whose `step.completed` has been journaled. */
  readonly completedNodes: ReadonlySet<NodeId>;
  /** Nodes currently dispatched (in-flight) but not yet completed. */
  readonly inFlightNodes: ReadonlySet<NodeId>;
  /**
   * Per-edge evaluation outcomes recorded so far. An edge appears here iff
   * its `edge.evaluated` journal entry has been written. Missing edges have
   * not yet been evaluated.
   */
  readonly edgeDecisions: ReadonlyMap<EdgeId, boolean>;
  /** Evaluation environment (runInput, state, nodeOutputs) for predicate evaluation. */
  readonly env: EvalEnv;
}

/**
 * The scheduler's per-tick output.
 *
 *   - `ready`    → nodes to dispatch this tick (not yet started, all
 *                  upstream edges resolved, at least one upstream taken).
 *   - `edgeEvals`→ edges the caller must evaluate + journal before the
 *                  next tick. Contains one entry per edge whose `from` has
 *                  completed (or is `$start`) but whose `edge.evaluated`
 *                  hasn't been written.
 *   - `done`     → true iff every node is completed or dead (can never
 *                  fire), every edge whose source completed has a decision,
 *                  and nothing is in flight. The kernel should write
 *                  `run.completed` after this tick.
 */
export interface SchedulerTick {
  readonly ready: readonly NodeId[];
  readonly edgeEvals: readonly PendingEdgeEval[];
  readonly done: boolean;
}

export interface PendingEdgeEval {
  readonly edgeId: EdgeId;
  readonly edge: FlowEdge;
  /**
   * Precomputed decision if the caller wants to short-circuit and just
   * write the journal entry. If `when` is absent, decision is always true.
   */
  readonly decision: boolean;
}

/**
 * Compute the next set of actions the kernel should take. Idempotent: the
 * same state produces the same output. Safe to call from a replay path.
 *
 * The scheduler classifies edges into three buckets:
 *   1. Edges from $start or from a completed node → evaluate now (if not
 *      already), then contribute to downstream readiness.
 *   2. Edges from a not-yet-completed node → skipped this tick.
 *   3. Edges from a node that completed and edges already evaluated → their
 *      recorded decisions drive readiness only.
 *
 * An incoming edge is TAKEN (source completed, evaluated true), NOT TAKEN
 * (source completed and evaluated false, or source dead) or PENDING
 * (source not completed yet, or not evaluated yet).
 *
 * A node is ready iff:
 *   - it exists in `flow.nodes`
 *   - it is not in `completedNodes` or `inFlightNodes`
 *   - none of its incoming edges is pending
 *   - at least one incoming edge is taken
 *
 * So a fan-in node waits for every upstream edge to be resolved before
 * dispatching — no partial firing — and a node whose every incoming edge
 * is not taken is dead: it never fires, and its outgoing edges count as
 * not taken. That is what lets a conditional branch rejoin: the join node
 * doesn't wait on the skipped arm forever.
 */
export function schedulerTick(flow: Flow, s: SchedulerState): SchedulerTick {
  const edgesByTo = groupEdgesByDestination(flow);

  const edgeEvals = computePendingEdgeEvals(flow, s);
  const effectiveDecisions = mergeDecisions(s.edgeDecisions, edgeEvals);
  const dead = computeDeadNodes(flow, s, edgesByTo, effectiveDecisions);
  const ready = computeReady(flow, s, edgesByTo, effectiveDecisions, dead);
  const done = computeDone(flow, s, effectiveDecisions, dead);

  return { ready, edgeEvals, done };
}

/**
 * Serial: `evaluateExpr` is synchronous and CPU-only. Ordering of `out`
 * follows `flow.edges` and is stable — callers that journal edge
 * decisions rely on that.
 */
function computePendingEdgeEvals(flow: Flow, s: SchedulerState): PendingEdgeEval[] {
  const out: PendingEdgeEval[] = [];
  for (const edge of flow.edges) {
    if (s.edgeDecisions.has(edge.id)) continue;
    if (!sourceCompleted(edge, s.completedNodes)) continue;
    const decision = edge.when === undefined ? true : evaluateExpr(edge.when, s.env);
    out.push({ edgeId: edge.id, edge, decision });
  }
  return out;
}

function mergeDecisions(
  base: ReadonlyMap<EdgeId, boolean>,
  additions: readonly PendingEdgeEval[],
): ReadonlyMap<EdgeId, boolean> {
  const merged = new Map<EdgeId, boolean>(base);
  for (const pe of additions) merged.set(pe.edgeId, pe.decision);
  return merged;
}

function computeReady(
  flow: Flow,
  s: SchedulerState,
  edgesByTo: ReadonlyMap<NodeId, readonly FlowEdge[]>,
  effectiveDecisions: ReadonlyMap<EdgeId, boolean>,
  dead: ReadonlySet<NodeId>,
): NodeId[] {
  const ready: NodeId[] = [];
  for (const node of flow.nodes) {
    if (isNodeReady(node.id, s, edgesByTo, effectiveDecisions, dead)) ready.push(node.id);
  }
  // Priority-ordered dispatch. Sort DESCENDING by
  // `EdgePolicy.priority` on the node's sole incoming edge; ties broken
  // by ASCENDING lexical node id. Deterministic + replay-safe: the same
  // flow + same ready set always produces the same order, so callers
  // that slice `ready.slice(0, maxParallelism)` pick the highest-
  // priority nodes without needing any additional coordination. Fan-in
  // nodes and nodes whose edge has no `priority` field use the default
  // (0), so flows without priorities sort by node id alone (the loader
  // forbids duplicate ids across a flow, so the order is total).
  ready.sort((a, b) => {
    const pa = getEffectivePriority(edgesByTo, a);
    const pb = getEffectivePriority(edgesByTo, b);
    if (pa !== pb) return pb - pa; // higher priority first
    return a.localeCompare(b);
  });
  return ready;
}

/**
 * Resolve the effective scheduler priority for a ready node. Priority is
 * declared on `FlowEdge.policy.priority` and applies ONLY when the
 * destination has exactly one incoming edge — fan-in nodes (2+ incoming)
 * inherit the default (`EDGE_POLICY_PRIORITY_DEFAULT`). Same fan-in rule
 * as retry / timeoutMs / concurrencyKey.
 *
 * Exported for tests + observability. The kernel does not journal
 * priority (it's a scheduling hint, not durable state); code that needs
 * to inspect the effective priority of a node reads this directly.
 */
export function getEffectivePriority(
  edgesByTo: ReadonlyMap<NodeId, readonly FlowEdge[]>,
  nodeId: NodeId,
): number {
  const incoming = edgesByTo.get(nodeId) ?? [];
  if (incoming.length !== 1) return EDGE_POLICY_PRIORITY_DEFAULT;
  const edge = incoming[0];
  const p = edge?.policy?.priority;
  return typeof p === 'number' ? p : EDGE_POLICY_PRIORITY_DEFAULT;
}

type EdgeState = 'taken' | 'not-taken' | 'pending';

function edgeState(
  edge: FlowEdge,
  completed: ReadonlySet<NodeId>,
  effectiveDecisions: ReadonlyMap<EdgeId, boolean>,
  dead: ReadonlySet<NodeId>,
): EdgeState {
  if (edge.from !== START_NODE && dead.has(edge.from as NodeId)) return 'not-taken';
  if (!sourceCompleted(edge, completed)) return 'pending';
  const decision = effectiveDecisions.get(edge.id);
  if (decision === undefined) return 'pending';
  return decision ? 'taken' : 'not-taken';
}

function isNodeReady(
  nodeId: NodeId,
  s: SchedulerState,
  edgesByTo: ReadonlyMap<NodeId, readonly FlowEdge[]>,
  effectiveDecisions: ReadonlyMap<EdgeId, boolean>,
  dead: ReadonlySet<NodeId>,
): boolean {
  if (s.completedNodes.has(nodeId)) return false;
  if (s.inFlightNodes.has(nodeId)) return false;
  const incoming = edgesByTo.get(nodeId) ?? [];
  if (incoming.length === 0) return false;

  let anyTaken = false;
  for (const edge of incoming) {
    const state = edgeState(edge, s.completedNodes, effectiveDecisions, dead);
    if (state === 'pending') return false;
    if (state === 'taken') anyTaken = true;
  }
  return anyTaken;
}

function computeDone(
  flow: Flow,
  s: SchedulerState,
  effectiveDecisions: ReadonlyMap<EdgeId, boolean>,
  dead: ReadonlySet<NodeId>,
): boolean {
  const allNodesResolved = flow.nodes.every((n) => s.completedNodes.has(n.id) || dead.has(n.id));
  const allEdgesResolved = flow.edges.every((edge) => {
    if (!sourceCompleted(edge, s.completedNodes)) return true;
    return effectiveDecisions.has(edge.id);
  });
  return allNodesResolved && allEdgesResolved && s.inFlightNodes.size === 0;
}

/**
 * Nodes that will never fire: no incoming edge at all, or every incoming
 * edge not taken — including edges out of other dead nodes, so deadness
 * propagates down a skipped branch. Iterates to a fixpoint (the loader
 * guarantees the edges form a DAG, so it terminates in at most one pass
 * per node). Unreached nodes — some incoming edge still pending — are
 * NOT dead; they might still fire once upstream completes.
 */
function computeDeadNodes(
  flow: Flow,
  s: SchedulerState,
  edgesByTo: ReadonlyMap<NodeId, readonly FlowEdge[]>,
  effectiveDecisions: ReadonlyMap<EdgeId, boolean>,
): ReadonlySet<NodeId> {
  const dead = new Set<NodeId>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of flow.nodes) {
      if (dead.has(node.id) || s.completedNodes.has(node.id) || s.inFlightNodes.has(node.id)) {
        continue;
      }
      const incoming = edgesByTo.get(node.id) ?? [];
      const allNotTaken = incoming.every(
        (edge) => edgeState(edge, s.completedNodes, effectiveDecisions, dead) === 'not-taken',
      );
      if (allNotTaken) {
        dead.add(node.id);
        changed = true;
      }
    }
  }
  return dead;
}

function sourceCompleted(edge: FlowEdge, completed: ReadonlySet<NodeId>): boolean {
  if (edge.from === START_NODE) return true;
  return completed.has(edge.from as NodeId);
}

function groupEdgesByDestination(flow: Flow): ReadonlyMap<NodeId, readonly FlowEdge[]> {
  const by = new Map<NodeId, FlowEdge[]>();
  for (const edge of flow.edges) {
    if (edge.to === END_NODE) continue;
    const arr = by.get(edge.to as NodeId) ?? [];
    arr.push(edge);
    by.set(edge.to as NodeId, arr);
  }
  return by;
}
