// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { END_NODE, LOOP_START_NODE, START_NODE } from '@kindgi/flow';
import type { Flow, FlowNode, LoopNode } from '@kindgi/flow';
import { bodyStepKey } from '@kindgi/runtime';
import type { JournalEntryPosition, RunStatus } from '@kindgi/runtime';
import { canonicalize } from '@kindgi/schema';
import type { NodeId, ProvenanceId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { newBuilder } from './build.js';
import { signingBytes } from './canonical.js';
import type { Provenance, ProvenanceEdge, ProvenanceNode } from './types.js';

/**
 * The namespace of every flow record's id. Fixed: with it, anyone
 * reproduces a flow run's record id from the run id (`flowProvenanceId`).
 */
export const FLOW_PROVENANCE_NAMESPACE = '6836301c-3904-4d33-a02e-748d05fe4ba0';

const NAMESPACE_BYTES = Buffer.from(FLOW_PROVENANCE_NAMESPACE.replaceAll('-', ''), 'hex');

/**
 * A flow run's record id: a name-based UUID (RFC 9562 version 5, SHA-1)
 * under `FLOW_PROVENANCE_NAMESPACE`, over the UTF-8 bytes of the JSON
 * array `[runId, "flow-provenance"]`. One per run, known before the
 * record is written, so a parent names its child's record by it.
 */
export function flowProvenanceId(runId: RunId): ProvenanceId {
  const hash = createHash('sha1')
    .update(NAMESPACE_BYTES)
    .update(JSON.stringify([runId, 'flow-provenance']), 'utf8');
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ProvenanceId;
}

/** The record version a flow record is written at: `1.1.0` adds the `step` node kind. */
export const FLOW_PROVENANCE_VERSION = '1.1.0';

/**
 * A flow record's caps. Past `maxNodes` or `maxRecordBytes` (the
 * signing projection's canonical bytes), the record is cut from the
 * middle, in journal order. A node's attributes are cut at
 * `maxNodeAttributeBytes`. A loop execution keeps whole iterations
 * within its node budget, by its depth (1: a loop of the flow itself),
 * and at most `iterationsKeptPerEnd` from each end; the rest fold into
 * one node, which counts the loops run inside them too. An id over
 * `maxIdLength` takes a digest form.
 */
export const FLOW_PROVENANCE_LIMITS = {
  maxNodes: 5000,
  maxRecordBytes: 4 * 1024 * 1024,
  maxNodeAttributeBytes: 16 * 1024,
  loopNodeBudgets: [2500, 250, 25],
  iterationsKeptPerEnd: 25,
  maxIdLength: 256,
} as const;

/** A run a flow run's step started: an agent step's turn, a sub-flow's run. */
export interface FlowProvenanceChild {
  readonly runId: RunId;
  readonly flowId: string;
  readonly status: RunStatus;
  /**
   * The step that started it, as its run row keeps it: the node id, and
   * the scope, `''` for a step of the flow itself or the JSON of its loop
   * path (innermost first) for a loop-body step.
   */
  readonly parentNodeId: string;
  readonly parentScope: string;
  /** Its own record's id, when it has one or will have one. */
  readonly provenanceId?: ProvenanceId;
}

/** A result one of the run's steps reused: a source its tool named, read from the step's links. */
export interface FlowReusedSource {
  /** The step's scope: its node id, or its `bodyStepKey` in a loop body. */
  readonly scope: string;
  readonly runId?: RunId;
  readonly provenanceId?: ProvenanceId;
  /** A node inside that source's record. */
  readonly nodeId?: string;
}

/** The finished run a flow record describes. Ids, kinds, statuses and times only. */
export interface FlowProvenanceRun {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  /** The definition the run ran, at its `flowRef`. */
  readonly flow: Flow;
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** When the run ended: the record's `createdAt`. */
  readonly completedAt: Timestamp;
  /** Whether the run completed with an output. Never the output itself. */
  readonly hasOutput: boolean;
  /** On a replay: the run it replays, and its test run when it has one. */
  readonly replayOf?: RunId;
  readonly testRunId?: string;
  /** The runs its steps started, oldest first. */
  readonly children: readonly FlowProvenanceChild[];
  /** The results its completed tool steps reused, in the order they were written. */
  readonly reused?: readonly FlowReusedSource[];
}

/** Journal entries the build didn't read, between two pages: past the entries cap. */
export interface FlowJournalGap {
  readonly fromSequence: number;
  readonly toSequence: number;
  /** The gap's entries by kind, when they could be counted. */
  readonly omittedByKind?: Readonly<Record<string, number>>;
}

/**
 * Builds a finished flow run's record from its journal, read without
 * payloads: each entry's kind, node, sequence, time and `facts`. Hand it
 * the journal page by page (`add`), in sequence order; `skip` once where
 * entries weren't read; then `finish`. The record holds no value and no
 * digest of one: ids, kinds, statuses, times and codes.
 */
export interface FlowProvenanceBuilder {
  add(entries: readonly JournalEntryPosition[]): void;
  skip(gap: FlowJournalGap): void;
  /** The record, unsigned. Sign it with `signProvenance` when a key provider is bound. */
  finish(): Provenance;
}

type StepStatus = 'completed' | 'failed' | 'cancelled' | 'unfinished';
type StepNodeKind = 'tool' | 'agent' | 'loop' | 'fanout' | 'subgraph';

interface StepRef {
  readonly id: string;
  readonly version?: string;
}

interface StepAcc {
  readonly scope: string;
  readonly nodeId: string;
  readonly nodeKind: StepNodeKind;
  readonly ref?: StepRef;
  /** A loop-body step's loop execution and iteration. */
  readonly loopScope?: string;
  readonly iteration?: number;
  /** A fanout branch's fanout step, and its index in the definition. */
  readonly fanoutScope?: string;
  readonly branch?: number;
  status: StepStatus;
  firstSequence: number;
  lastSequence: number;
  startedAt: Timestamp;
  endedAt?: Timestamp | undefined;
  retries: number;
  failure?:
    | { readonly reason: string; readonly limitMs?: number; readonly elapsedMs?: number }
    | undefined;
  stopReason?: string;
  partial: boolean;
  readonly runs: FlowProvenanceChild[];
  /** By the source's canonical JSON: the same source named twice is one. */
  readonly reusedFrom: Map<string, ReusedRef>;
  readonly waits: WaitAcc[];
}

interface ReusedRef {
  readonly runId?: string;
  readonly provenanceId?: string;
  readonly nodeId?: string;
}

interface IterationAcc {
  readonly index: number;
  readonly firstSequence: number;
  readonly firstAt: Timestamp;
  completed: boolean;
  stopReason?: string;
  readonly steps: Set<string>;
  /** Edges taken in this iteration, by edge id. */
  readonly edges: Map<string, boolean>;
}

interface WaitAcc {
  readonly id: string;
  readonly kind: 'wait' | 'resume';
  readonly sequence: number;
  readonly at: Timestamp;
  /** A resume that is the wait's cancel, and the cancel's reason when the kernel kept it. */
  readonly cancelled?: { readonly reason?: string };
}

interface BodyNodeDef {
  readonly node: FlowNode;
  readonly loop: LoopNode;
  /** The loop of the flow itself this body sits in, at any depth. */
  readonly topLoopId: string;
}

/** A node of the record, before ids are fixed and edges are drawn. */
interface Candidate {
  readonly key: string;
  readonly sequence: number;
  readonly lastSequence: number;
  readonly node: ProvenanceNode;
  readonly isStep: boolean;
}

// ---------------------------------------------------------------------
// Node ids, as the record keeps them: part of its format.
// ---------------------------------------------------------------------

/** One level of a loop path, innermost first, as a run row's scope keeps it. */
interface LoopLevel {
  readonly loopNodeId: NodeId;
  readonly iteration: number;
}

/** A run row's scope as a loop path: `[]` for a step of the flow itself, and for a scope that doesn't parse. */
function loopPathOf(scope: string): LoopLevel[] {
  if (scope === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const path: LoopLevel[] = [];
  for (const level of parsed as unknown[]) {
    const l = level as { loopNodeId?: unknown; iteration?: unknown } | null;
    if (typeof l?.loopNodeId !== 'string' || typeof l.iteration !== 'number') return [];
    path.push({ loopNodeId: l.loopNodeId as NodeId, iteration: l.iteration });
  }
  return path;
}

/** A step's scope: its node id, or its `bodyStepKey` under its loop path. */
function scopeOf(nodeId: string, path: readonly LoopLevel[]): string {
  const inner = path[0];
  if (inner === undefined) return nodeId;
  return bodyStepKey(nodeId as NodeId, { ...inner, path: [...path] });
}

function stepKey(scope: string): string {
  return `step:${scope}`;
}

/** The id of a loop run's folded node. */
function foldedKey(loopScope: string): string {
  return `${stepKey(loopScope)}#folded`;
}

/** A node's id in the record: as built, or its digest form when it's long or could meet one. */
function recordIdOf(raw: string): string {
  if (raw.length <= FLOW_PROVENANCE_LIMITS.maxIdLength && !raw.startsWith('step:~')) return raw;
  return `step:~${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Where a child run is counted in its parent's record: a node's id, or `undefined`. */
export type FlowStepNodePlace = (
  child: Pick<FlowProvenanceChild, 'parentNodeId' | 'parentScope'>,
) => string | undefined;

/**
 * Finds, in a flow record's nodes, the node that counts a child run of
 * one of its steps: the step's own node, or, when its iteration was
 * folded, the folded node of the innermost loop whose `from`..`to`
 * holds it. `undefined` when the record has neither: the step was cut
 * with the record's middle, or the record has no such step. It computes
 * the builder's own ids, which are part of the record's format.
 */
export function stepNodePlacer(nodes: readonly ProvenanceNode[]): FlowStepNodePlace {
  const byId = new Map<string, ProvenanceNode>();
  for (const node of nodes) if (node.kind === 'step') byId.set(node.id, node);
  return ({ parentNodeId, parentScope }) => {
    const path = loopPathOf(parentScope);
    const own = recordIdOf(stepKey(scopeOf(parentNodeId, path)));
    if (byId.has(own)) return own;
    for (const [k, level] of path.entries()) {
      const id = recordIdOf(foldedKey(scopeOf(level.loopNodeId, path.slice(k + 1))));
      const range = foldedRange(byId.get(id));
      if (range !== undefined && level.iteration >= range.from && level.iteration <= range.to) {
        return id;
      }
    }
    return undefined;
  };
}

function foldedRange(node: ProvenanceNode | undefined): { from: number; to: number } | undefined {
  const folded = (node?.attributes as { folded?: { from?: unknown; to?: unknown } } | undefined)
    ?.folded;
  if (typeof folded?.from !== 'number' || typeof folded.to !== 'number') return undefined;
  return { from: folded.from, to: folded.to };
}

export function flowProvenanceBuilder(run: FlowProvenanceRun): FlowProvenanceBuilder {
  const L = FLOW_PROVENANCE_LIMITS;
  const topNodes = new Map<string, FlowNode>(run.flow.nodes.map((n) => [n.id, n]));
  /** Every loop body's nodes, by node id: ids are unique across the whole flow, bodies included. */
  const bodyNodes = new Map<string, BodyNodeDef>();
  for (const node of run.flow.nodes) {
    if (node.kind === 'loop') indexLoop(node, node.id);
  }
  function indexLoop(loop: LoopNode, topLoopId: string): void {
    for (const node of loop.body.nodes) {
      bodyNodes.set(node.id, { node, loop, topLoopId });
      if (node.kind === 'loop') indexLoop(node, topLoopId);
    }
  }

  const steps = new Map<string, StepAcc>();
  /** A loop execution's iterations, by its scope. */
  const iterations = new Map<string, Map<number, IterationAcc>>();
  const topEdges = new Map<string, boolean>();
  /**
   * Body steps whose start couldn't be placed, by the flow's own loop they
   * sit in: started before the kernel kept facts, or in a loop execution
   * whose own step wasn't seen.
   */
  const unplaced = new Map<string, number>();
  /** The flow's own loops with entries that couldn't be placed. */
  const partialLoops = new Set<string>();
  let runStartedAt: Timestamp | undefined;
  let firstAt: Timestamp | undefined;
  let lastSequence = -1;
  let gap: FlowJournalGap | undefined;

  function refOf(node: FlowNode): StepRef | undefined {
    const pins = run.flow.pins;
    switch (node.kind) {
      case 'tool': {
        const version = pins?.tools[node.ref];
        return { id: node.ref, ...(version !== undefined && { version }) };
      }
      case 'agent': {
        const version = pins?.agents[node.ref];
        return { id: node.ref, ...(version !== undefined && { version }) };
      }
      case 'subgraph':
        return { id: node.flowRef.flowId, version: node.flowRef.version };
      default:
        return undefined;
    }
  }

  function newStep(
    entry: JournalEntryPosition,
    scope: string,
    def: FlowNode,
    place: { loopScope?: string; iteration?: number },
  ): StepAcc {
    const ref = refOf(def);
    const step: StepAcc = {
      scope,
      nodeId: def.id,
      nodeKind: def.kind,
      ...(ref !== undefined && { ref }),
      ...(place.loopScope !== undefined && { loopScope: place.loopScope }),
      ...(place.iteration !== undefined && { iteration: place.iteration }),
      status: 'unfinished',
      firstSequence: entry.sequence,
      lastSequence: entry.sequence,
      startedAt: entry.timestamp,
      retries: 0,
      partial: false,
      runs: [],
      reusedFrom: new Map(),
      waits: [],
    };
    steps.set(scope, step);
    if (place.loopScope !== undefined && place.iteration !== undefined) {
      iterationOf(place.loopScope, place.iteration, entry).steps.add(scope);
    }
    return step;
  }

  function iterationOf(
    loopScope: string,
    index: number,
    entry: JournalEntryPosition,
  ): IterationAcc {
    let byIndex = iterations.get(loopScope);
    if (byIndex === undefined) {
      byIndex = new Map();
      iterations.set(loopScope, byIndex);
    }
    let it = byIndex.get(index);
    if (it === undefined) {
      it = {
        index,
        firstSequence: entry.sequence,
        firstAt: entry.timestamp,
        completed: false,
        steps: new Set(),
        edges: new Map(),
      };
      byIndex.set(index, it);
    }
    return it;
  }

  /** An entry of a loop's body that can't be placed: its step is counted, its loop is partial. */
  function cantPlace(nodeId: string | undefined, isStepStart: boolean): void {
    if (nodeId === undefined) return;
    const top =
      bodyNodes.get(nodeId)?.topLoopId ??
      (topNodes.get(nodeId)?.kind === 'loop' ? nodeId : undefined);
    if (top === undefined) return;
    partialLoops.add(top);
    if (isStepStart) unplaced.set(top, (unplaced.get(top) ?? 0) + 1);
  }

  /** The entry's node id when it names a top-level node of a kind `fits` accepts. */
  function topLevel(
    entry: JournalEntryPosition,
    fits: (kind: string) => boolean,
  ): string | undefined {
    const nodeId = entry.nodeId as string | undefined;
    const top = nodeId === undefined ? undefined : topNodes.get(nodeId);
    return top !== undefined && fits(top.kind) ? nodeId : undefined;
  }

  /** The step a `step.*` entry is about, created on its first entry; undefined when it can't be placed. */
  function stepOf(entry: JournalEntryPosition): StepAcc | undefined {
    const nodeId = entry.nodeId as string | undefined;
    if (nodeId === undefined) return undefined;
    const facts = entry.facts;
    if (facts?.scope !== undefined) {
      const known = steps.get(facts.scope);
      if (known !== undefined) return known;
      const def = bodyNodes.get(nodeId);
      // Its loop execution's own step must have been seen: one that started
      // before the kernel kept facts, or in the gap, wasn't.
      const loop = facts.loopScope === undefined ? undefined : steps.get(facts.loopScope);
      if (def === undefined || loop?.nodeId !== def.loop.id || facts.iteration === undefined) {
        cantPlace(nodeId, entry.kind === 'step.started');
        return undefined;
      }
      return newStep(entry, facts.scope, def.node, {
        loopScope: loop.scope,
        iteration: facts.iteration,
      });
    }
    const top = topNodes.get(nodeId);
    if (top !== undefined) return steps.get(nodeId) ?? newStep(entry, nodeId, top, {});
    cantPlace(nodeId, entry.kind === 'step.started');
    return undefined;
  }

  function branchOf(entry: JournalEntryPosition): StepAcc | undefined {
    const fanoutId = entry.nodeId as string | undefined;
    const branchId = entry.facts?.branchId;
    const fanout = fanoutId === undefined ? undefined : topNodes.get(fanoutId);
    if (fanout === undefined || fanout.kind !== 'fanout') return undefined;
    if (branchId === undefined) {
      const owner = steps.get(fanout.id);
      if (owner !== undefined) owner.partial = true;
      return undefined;
    }
    const scope = `${fanout.id}/${branchId}`;
    const known = steps.get(scope);
    if (known !== undefined) return known;
    const index = fanout.branches.findIndex((b) => b.branchId === branchId);
    const branchDef = index >= 0 ? fanout.branches[index] : undefined;
    if (branchDef === undefined) return undefined;
    const version = run.flow.pins?.tools[branchDef.handler];
    const step: StepAcc = {
      scope,
      nodeId: fanout.id,
      nodeKind: 'tool',
      ref: { id: branchDef.handler, ...(version !== undefined && { version }) },
      fanoutScope: fanout.id,
      branch: index,
      status: 'unfinished',
      firstSequence: entry.sequence,
      lastSequence: entry.sequence,
      startedAt: entry.timestamp,
      retries: 0,
      partial: false,
      runs: [],
      reusedFrom: new Map(),
      waits: [],
    };
    steps.set(scope, step);
    return step;
  }

  function touch(step: StepAcc, entry: JournalEntryPosition): void {
    if (entry.sequence > step.lastSequence) step.lastSequence = entry.sequence;
  }

  function ended(
    step: StepAcc,
    entry: JournalEntryPosition,
    failedReason: string | undefined,
  ): void {
    touch(step, entry);
    step.endedAt = entry.timestamp;
    if (failedReason === undefined) {
      step.status = 'completed';
      return;
    }
    step.status = failedReason === 'cancelled' ? 'cancelled' : 'failed';
  }

  function apply(entry: JournalEntryPosition): void {
    const facts = entry.facts;
    switch (entry.kind) {
      case 'run.started':
        runStartedAt = entry.timestamp;
        return;
      case 'step.started': {
        const step = stepOf(entry);
        if (step === undefined) return;
        touch(step, entry);
        if (step.status !== 'unfinished') {
          step.status = 'unfinished';
          step.endedAt = undefined;
        }
        return;
      }
      case 'step.completed': {
        const step = stepOf(entry);
        if (step !== undefined) ended(step, entry, undefined);
        return;
      }
      case 'step.failed': {
        const step = stepOf(entry);
        if (step === undefined) return;
        ended(step, entry, facts?.reason ?? 'failed');
        if (facts?.reason !== undefined) {
          step.failure = {
            reason: facts.reason,
            ...(facts.limitMs !== undefined && { limitMs: facts.limitMs }),
            ...(facts.elapsedMs !== undefined && { elapsedMs: facts.elapsedMs }),
          };
        } else {
          step.failure = undefined;
        }
        if (facts?.stopReason !== undefined) step.stopReason = facts.stopReason;
        return;
      }
      case 'step.retry-scheduled': {
        const step = stepOf(entry);
        if (step === undefined) return;
        touch(step, entry);
        step.retries += 1;
        step.status = 'unfinished';
        return;
      }
      case 'edge.evaluated': {
        if (facts?.edgeId === undefined || facts.decision === undefined) return;
        if (facts.loopScope !== undefined && facts.iteration !== undefined) {
          iterationOf(facts.loopScope, facts.iteration, entry).edges.set(
            facts.edgeId,
            facts.decision,
          );
        } else {
          topEdges.set(facts.edgeId, facts.decision);
        }
        return;
      }
      case 'iteration.started':
      case 'iteration.completed': {
        // Without a scope only a top-level loop's id names its execution:
        // a nested loop runs once per iteration of the loops above it.
        const loopScope = facts?.scope ?? topLevel(entry, (kind) => kind === 'loop');
        if (loopScope === undefined || facts?.iteration === undefined) {
          cantPlace(entry.nodeId as string | undefined, false);
          return;
        }
        const it = iterationOf(loopScope, facts.iteration, entry);
        if (entry.kind === 'iteration.completed') {
          it.completed = true;
          if (facts.stopReason !== undefined) it.stopReason = facts.stopReason;
        }
        const owner = steps.get(loopScope);
        if (owner !== undefined) touch(owner, entry);
        return;
      }
      case 'fanout.dispatched': {
        const branch = branchOf(entry);
        if (branch === undefined) return;
        touch(branch, entry);
        return;
      }
      case 'fanout.branch-completed':
      case 'fanout.branch-failed': {
        const branch = branchOf(entry);
        if (branch === undefined) return;
        ended(
          branch,
          entry,
          entry.kind === 'fanout.branch-completed' ? undefined : (facts?.reason ?? 'failed'),
        );
        if (entry.kind === 'fanout.branch-failed' && facts?.reason !== undefined) {
          branch.failure = { reason: facts.reason };
        }
        return;
      }
      case 'fanout.cancelled-siblings': {
        const owner = entry.nodeId === undefined ? undefined : steps.get(entry.nodeId);
        if (owner !== undefined && facts?.reason !== undefined) owner.stopReason = facts.reason;
        return;
      }
      case 'wait.suspended':
      case 'wait.resumed':
      case 'wait.cancelled': {
        // A waitpoint made before waits kept their scope gives none. Its
        // node id still names a top-level step, but under a loop it's the
        // loop's, which can't say which body step waited.
        const scope = facts?.scope ?? topLevel(entry, (kind) => kind !== 'loop');
        if (scope === undefined) {
          cantPlace(entry.nodeId as string | undefined, false);
          return;
        }
        const step = steps.get(scope);
        // An agent step's or a sub-flow's own wait is for its child run,
        // which the step's `runs` already link.
        if (step === undefined || step.nodeKind === 'agent' || step.nodeKind === 'subgraph') return;
        const kind = entry.kind === 'wait.suspended' ? 'wait' : 'resume';
        // A step can't wait again before it resumes: a second copy of the
        // same suspension (a loop body step's has two) is one wait.
        if (kind === 'wait' && step.waits[step.waits.length - 1]?.kind === 'wait') return;
        step.waits.push({
          id: `${kind}:${entry.sequence}`,
          kind,
          sequence: entry.sequence,
          at: entry.timestamp,
          // The step fails on replay; its resume node says the wait was cancelled, as a turn's does.
          ...(entry.kind === 'wait.cancelled' && {
            cancelled: { ...(facts?.reason !== undefined && { reason: facts.reason }) },
          }),
        });
        touch(step, entry);
        return;
      }
      default:
        return;
    }
  }

  function addReused(into: Map<string, ReusedRef>, ref: ReusedRef): void {
    if (ref.runId === undefined && ref.provenanceId === undefined) return;
    const key = canonicalize(ref);
    if (!into.has(key)) into.set(key, ref);
  }

  /** The scope of the step that started a child: its node id, or its `bodyStepKey` in a loop body. */
  function scopeOfChild(child: FlowProvenanceChild): string {
    return scopeOf(child.parentNodeId, loopPathOf(child.parentScope));
  }

  return {
    add(entries): void {
      for (const entry of entries) {
        if (entry.sequence <= lastSequence) {
          throw new Error(
            `flowProvenanceBuilder: entries must come in sequence order (${entry.sequence} after ${lastSequence})`,
          );
        }
        lastSequence = entry.sequence;
        firstAt ??= entry.timestamp;
        apply(entry);
      }
    },
    skip(skipped): void {
      if (gap !== undefined) throw new Error('flowProvenanceBuilder: only one gap');
      gap = skipped;
    },
    finish(): Provenance {
      for (const child of run.children) {
        steps.get(scopeOfChild(child))?.runs.push(child);
      }
      for (const source of run.reused ?? []) {
        const step = steps.get(source.scope);
        if (step === undefined) continue;
        const ref: ReusedRef = {
          ...(source.runId !== undefined && { runId: source.runId }),
          ...(source.provenanceId !== undefined && { provenanceId: source.provenanceId }),
          ...(source.nodeId !== undefined && { nodeId: source.nodeId }),
        };
        addReused(step.reusedFrom, ref);
      }
      return assemble();
    },
  };

  // ---------------------------------------------------------------------
  // Assembly: fold loops, lay the nodes out, cut to the caps, draw edges.
  // ---------------------------------------------------------------------

  function assemble(): Provenance {
    const folded = foldLoops();
    const candidates: Candidate[] = [];
    const startAt = runStartedAt ?? firstAt ?? run.completedAt;

    candidates.push({
      key: 'input',
      sequence: Number.NEGATIVE_INFINITY,
      lastSequence: Number.NEGATIVE_INFINITY,
      isStep: false,
      node: {
        id: 'input',
        kind: 'input',
        timestamp: startAt,
        ...((run.replayOf !== undefined || run.testRunId !== undefined) && {
          attributes: {
            ...(run.replayOf !== undefined && { replayOf: run.replayOf }),
            ...(run.testRunId !== undefined && { testRunId: run.testRunId }),
          },
        }),
      },
    });

    for (const step of steps.values()) {
      if (folded.hidden.has(step.scope)) continue;
      candidates.push({
        key: stepKey(step.scope),
        sequence: step.firstSequence,
        lastSequence: step.lastSequence,
        isStep: true,
        node: stepNode(step),
      });
      for (const wait of step.waits) {
        candidates.push({
          key: wait.id,
          sequence: wait.sequence,
          lastSequence: wait.sequence,
          isStep: false,
          node: {
            id: wait.id,
            kind: wait.kind,
            timestamp: wait.at,
            attributes: {
              ...(step.scope.length > L.maxIdLength
                ? { truncated: { reason: 'ids', idsOmitted: 1 } }
                : { scope: step.scope }),
              ...(wait.cancelled !== undefined && {
                decision: 'cancelled',
                ...(wait.cancelled.reason !== undefined && { reason: wait.cancelled.reason }),
              }),
            },
          },
        });
      }
    }
    for (const f of folded.nodes) candidates.push(f);
    if (gap !== undefined) {
      candidates.push({
        key: 'truncated:entries',
        sequence: gap.fromSequence,
        lastSequence: gap.toSequence,
        isStep: false,
        node: {
          id: 'truncated:entries',
          kind: 'event',
          timestamp: startAt,
          attributes: {
            truncated: {
              reason: 'entries',
              fromSequence: gap.fromSequence,
              toSequence: gap.toSequence,
              ...(gap.omittedByKind !== undefined && { omittedByKind: gap.omittedByKind }),
            },
          },
        },
      });
    }
    const hasOutput = run.status === 'completed' && run.hasOutput;
    if (hasOutput) {
      candidates.push({
        key: 'output',
        sequence: Number.POSITIVE_INFINITY,
        lastSequence: Number.POSITIVE_INFINITY,
        isStep: false,
        node: { id: 'output', kind: 'artifact', timestamp: run.completedAt },
      });
    }
    candidates.sort((a, b) => a.sequence - b.sequence);

    const ids = new Map<string, string>();
    const nodes = candidates.map((c) => fixId(c, ids));
    const edges = drawEdges(ids, hasOutput, folded.hidden);
    return cutToCaps(nodes, candidates, edges);
  }

  /** The node's id: `step:<scope>`, or its digest form when it's long or could meet one. */
  function fixId(candidate: Candidate, ids: Map<string, string>): ProvenanceNode {
    const raw = candidate.node.id;
    const id = recordIdOf(raw);
    ids.set(candidate.key, id);
    if (id === raw) return candidate.node;
    return {
      ...candidate.node,
      id,
      attributes: { ...candidate.node.attributes, idHead: raw.slice(0, L.maxIdLength) },
    };
  }

  function stepNode(step: StepAcc): ProvenanceNode {
    const reachedBy = takenInto(step);
    const loopIterations =
      step.nodeKind === 'loop'
        ? (iterations.get(step.scope) ?? new Map<number, IterationAcc>())
        : undefined;
    const branchCount =
      step.nodeKind === 'fanout'
        ? [...steps.values()].filter((s) => s.fanoutScope === step.scope).length
        : undefined;
    const partial = step.partial || (step.nodeKind === 'loop' && loopIsPartial(step));
    const attributes: Record<string, unknown> = {
      nodeId: step.nodeId,
      nodeKind: step.nodeKind,
      ...(step.ref !== undefined && { ref: step.ref }),
      ...(step.iteration !== undefined && { iteration: step.iteration }),
      ...(step.branch !== undefined && { branch: step.branch }),
      status: step.status,
      startedAt: step.startedAt,
      ...(step.endedAt !== undefined && { endedAt: step.endedAt }),
      attempts: step.retries + 1,
      ...(step.failure !== undefined && { failure: step.failure }),
      ...(reachedBy.length > 0 && { reachedBy }),
      ...(step.runs.length > 0 && {
        runs: step.runs.map((r) => ({
          runId: r.runId,
          flowId: r.flowId,
          status: r.status,
          ...(r.provenanceId !== undefined && { provenanceId: r.provenanceId }),
        })),
      }),
      ...(step.reusedFrom.size > 0 && { reusedFrom: [...step.reusedFrom.values()] }),
      // A loop whose iterations went unplaced has no count to give.
      ...(loopIterations !== undefined &&
        !(partial && loopIterations.size === 0) && {
          iterations: withStopReason(
            loopIterations.size,
            step.stopReason ?? lastStopReason(loopIterations),
          ),
        }),
      ...(branchCount !== undefined && {
        iterations: withStopReason(branchCount, step.stopReason),
      }),
      ...(partial && { partial: true }),
    };
    return {
      id: stepKey(step.scope),
      kind: 'step',
      timestamp: step.startedAt,
      attributes: capAttributes(attributes),
    };
  }

  function withStopReason(count: number, stopReason: string | undefined): Record<string, unknown> {
    return { count, ...(stopReason !== undefined && { stopReason }) };
  }

  function lastStopReason(byIndex: Map<number, IterationAcc>): string | undefined {
    let last: IterationAcc | undefined;
    for (const it of byIndex.values()) {
      if (it.stopReason !== undefined && (last === undefined || it.index > last.index)) last = it;
    }
    return last?.stopReason;
  }

  function loopIsPartial(step: StepAcc): boolean {
    if (step.loopScope === undefined && partialLoops.has(step.nodeId)) return true;
    if (gap === undefined) return false;
    const endsAfter = step.endedAt === undefined || step.lastSequence > gap.toSequence;
    return step.firstSequence < gap.fromSequence && endsAfter;
  }

  /** The edges taken into a step: from the flow, or from its iteration's body. */
  function takenInto(step: StepAcc): string[] {
    if (step.fanoutScope !== undefined) return [];
    if (step.loopScope === undefined) {
      return run.flow.edges
        .filter((e) => e.to === step.nodeId && topEdges.get(e.id) === true)
        .map((e) => e.id);
    }
    const loop = bodyNodes.get(step.nodeId)?.loop;
    const it =
      step.iteration === undefined
        ? undefined
        : iterations.get(step.loopScope)?.get(step.iteration);
    if (loop === undefined || it === undefined) return [];
    return loop.body.edges
      .filter((e) => e.to === step.nodeId && it.edges.get(e.id) === true)
      .map((e) => e.id);
  }

  /**
   * A node's attributes, cut at the node budget: an id over the cap is
   * dropped and counted, then `runs` and `reusedFrom` are cut from the
   * end until the attributes fit.
   */
  function capAttributes(input: Record<string, unknown>): Record<string, unknown> {
    const attributes: Record<string, unknown> = { ...input };
    const long = (id: unknown): boolean => typeof id === 'string' && id.length > L.maxIdLength;
    let idsOmitted = 0;
    const ref = attributes.ref as StepRef | undefined;
    if (ref !== undefined && long(ref.id)) {
      attributes.ref = undefined;
      idsOmitted += 1;
    }
    if (long(attributes.nodeId)) {
      attributes.nodeId = undefined;
      idsOmitted += 1;
    }
    const reachedBy = attributes.reachedBy as string[] | undefined;
    if (reachedBy !== undefined) {
      const kept = reachedBy.filter((id) => !long(id));
      idsOmitted += reachedBy.length - kept.length;
      attributes.reachedBy = kept.length > 0 ? kept : undefined;
    }
    const lists = {
      runs: attributes.runs as Record<string, unknown>[] | undefined,
      reusedFrom: attributes.reusedFrom as Record<string, unknown>[] | undefined,
    };
    for (const key of ['runs', 'reusedFrom'] as const) {
      const list = lists[key];
      if (list === undefined) continue;
      const kept = list.filter((item) => !Object.values(item).some(long));
      idsOmitted += list.length - kept.length;
      lists[key] = kept;
      attributes[key] = kept.length > 0 ? kept : undefined;
    }
    const omitted = { runs: 0, reusedFrom: 0 };
    const size = (): number => byteLength(canonicalize(attributes));
    for (const key of ['runs', 'reusedFrom'] as const) {
      while (size() > L.maxNodeAttributeBytes) {
        const list = lists[key];
        if (list === undefined || list.length === 0) break;
        // Cut a share at a time: one at a time is quadratic on a long list.
        const over = size() - L.maxNodeAttributeBytes;
        const perItem = Math.max(1, Math.floor(byteLength(canonicalize(list)) / list.length));
        const cut = Math.min(list.length, Math.max(1, Math.ceil(over / perItem)));
        lists[key] = list.slice(0, list.length - cut);
        omitted[key] += cut;
        attributes[key] = (lists[key]?.length ?? 0) > 0 ? lists[key] : undefined;
        attributes.truncated = truncatedForBytes(omitted, idsOmitted);
      }
    }
    if (omitted.runs === 0 && omitted.reusedFrom === 0 && idsOmitted > 0) {
      attributes.truncated = { reason: 'ids', idsOmitted };
    }
    return Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined));
  }

  function truncatedForBytes(
    omitted: { runs: number; reusedFrom: number },
    idsOmitted: number,
  ): Record<string, unknown> {
    return {
      reason: 'node-bytes',
      ...(omitted.runs > 0 && { runsOmitted: omitted.runs }),
      ...(omitted.reusedFrom > 0 && { reusedFromOmitted: omitted.reusedFrom }),
      ...(idsOmitted > 0 && { idsOmitted }),
    };
  }

  // ---------------------------------------------------------------------
  // Loops: keep whole iterations from both ends, fold the middle.
  // ---------------------------------------------------------------------

  interface Folding {
    /** Steps not shown: they sit in a folded iteration. */
    readonly hidden: Set<string>;
    /** The folded nodes of the loop runs still shown. */
    readonly nodes: Candidate[];
  }

  function foldLoops(): Folding {
    const hidden = new Set<string>();
    const nodes: { readonly loopScope: string; readonly node: Candidate }[] = [];
    const kept = new Map<string, number>();
    const loops = [...steps.values()].filter((s) => s.nodeKind === 'loop');
    const depth = (s: StepAcc): number => {
      let d = 1;
      let at = s.loopScope;
      while (at !== undefined) {
        d += 1;
        at = steps.get(at)?.loopScope;
      }
      return d;
    };
    // Deepest first, so an iteration's size counts its inner loops' kept nodes.
    loops.sort((a, b) => depth(b) - depth(a));

    const stepSize = (scope: string): number => {
      const s = steps.get(scope);
      if (s === undefined) return 0;
      return 1 + s.waits.length + (s.nodeKind === 'loop' ? (kept.get(scope) ?? 0) : 0);
    };

    for (const loop of loops) {
      const byIndex = iterations.get(loop.scope) ?? new Map<number, IterationAcc>();
      const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index);
      const budget = L.loopNodeBudgets[Math.min(depth(loop), L.loopNodeBudgets.length) - 1] ?? 0;
      // First, last, second, second to last…: whole iterations by index,
      // never by journal order, until the budget or the per-end cap.
      const order: IterationAcc[] = [];
      for (let k = 0; k < L.iterationsKeptPerEnd && k <= ordered.length - 1 - k; k += 1) {
        const front = ordered[k];
        const back = ordered[ordered.length - 1 - k];
        if (front !== undefined) order.push(front);
        if (back !== undefined && back !== front) order.push(back);
      }
      const keep = new Set<number>();
      let used = 0;
      for (const it of order) {
        const size = [...it.steps].reduce((n, scope) => n + stepSize(scope), 0);
        if (used + size > budget) break;
        used += size;
        keep.add(it.index);
      }
      const foldedIts = ordered.filter((it) => !keep.has(it.index));
      const unplacedHere = loop.loopScope === undefined ? (unplaced.get(loop.nodeId) ?? 0) : 0;
      // A partial loop that kept every iteration still gets its folded node when steps went unplaced.
      if (foldedIts.length > 0 || unplacedHere > 0) {
        used += 1;
        nodes.push({
          loopScope: loop.scope,
          node: foldedNode(loop, foldedIts, unplacedHere, hidden),
        });
      }
      kept.set(loop.scope, used);
    }
    // A loop run in a folded iteration has no node, and so no folded node:
    // the outer folded node counts its steps.
    return {
      hidden,
      nodes: nodes.filter((f) => !hidden.has(f.loopScope)).map((f) => f.node),
    };
  }

  function foldedNode(
    loop: StepAcc,
    foldedIts: IterationAcc[],
    unplacedHere: number,
    hidden: Set<string>,
  ): Candidate {
    const byStatus: Record<string, number> = {};
    let runs = 0;
    const reused = new Map<string, ReusedRef>();
    // Its own set, not `hidden`: an inner loop's fold hid some of these
    // steps already, and this node counts them too.
    const seen = new Set<string>();
    const hide = (scope: string): void => {
      if (seen.has(scope)) return;
      seen.add(scope);
      hidden.add(scope);
      const s = steps.get(scope);
      if (s === undefined) return;
      runs += s.runs.length;
      for (const [key, ref] of s.reusedFrom) if (!reused.has(key)) reused.set(key, ref);
      if (s.nodeKind === 'loop') {
        for (const inner of iterations.get(scope)?.values() ?? []) {
          for (const innerScope of inner.steps) hide(innerScope);
        }
      }
    };
    for (const it of foldedIts) {
      const status = iterationStatus(it);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      for (const scope of it.steps) hide(scope);
    }
    const first = foldedIts[0];
    const last = foldedIts[foldedIts.length - 1];
    const id = foldedKey(loop.scope);
    return {
      key: id,
      sequence: first?.firstSequence ?? loop.firstSequence,
      lastSequence: loop.lastSequence,
      isStep: true,
      node: {
        id,
        kind: 'step',
        timestamp: first?.firstAt ?? loop.startedAt,
        attributes: capAttributes({
          nodeId: loop.nodeId,
          folded: {
            ...(first !== undefined && last !== undefined && { from: first.index, to: last.index }),
            count: foldedIts.length,
            byStatus,
            runs,
            ...(unplacedHere > 0 && { unplaced: unplacedHere }),
          },
          ...(reused.size > 0 && { reusedFrom: [...reused.values()] }),
        }),
      },
    };
  }

  function iterationStatus(it: IterationAcc): StepStatus {
    let cancelled = false;
    for (const scope of it.steps) {
      const s = steps.get(scope);
      if (s?.status === 'failed') return 'failed';
      if (s?.status === 'cancelled') cancelled = true;
    }
    if (cancelled || it.stopReason === 'cancelled') return 'cancelled';
    return it.completed ? 'completed' : 'unfinished';
  }

  // ---------------------------------------------------------------------
  // Edges, from the effect to its cause.
  // ---------------------------------------------------------------------

  function drawEdges(
    ids: Map<string, string>,
    hasOutput: boolean,
    hidden: Set<string>,
  ): ProvenanceEdge[] {
    const edges: ProvenanceEdge[] = [];
    const seen = new Set<string>();
    const add = (fromKey: string, toKey: string, kind: ProvenanceEdge['kind']): void => {
      const from = ids.get(fromKey);
      const to = ids.get(toKey);
      if (from === undefined || to === undefined) return;
      const k = `${from}\u0000${to}\u0000${kind}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ from, to, kind });
    };

    for (const step of steps.values()) {
      if (hidden.has(step.scope)) continue;
      const self = stepKey(step.scope);
      if (step.fanoutScope !== undefined) {
        add(self, stepKey(step.fanoutScope), 'invoked');
      } else if (step.loopScope === undefined) {
        for (const edgeId of takenInto(step)) {
          const def = run.flow.edges.find((e) => e.id === edgeId);
          if (def === undefined) continue;
          if (def.from === START_NODE) add(self, 'input', 'caused-by');
          else add(self, stepKey(def.from), 'caused-by');
        }
      } else {
        add(self, stepKey(step.loopScope), 'invoked');
        const loop = bodyNodes.get(step.nodeId)?.loop;
        const it =
          step.iteration === undefined
            ? undefined
            : iterations.get(step.loopScope)?.get(step.iteration);
        for (const edgeId of takenInto(step)) {
          const def = loop?.body.edges.find((e) => e.id === edgeId);
          if (def === undefined || def.from === LOOP_START_NODE || it === undefined) continue;
          for (const scope of it.steps) {
            if (steps.get(scope)?.nodeId === def.from) add(self, stepKey(scope), 'caused-by');
          }
        }
      }
      let open: WaitAcc | undefined;
      for (const wait of step.waits) {
        if (wait.kind === 'wait') {
          add(self, wait.id, 'waited-on');
          open = wait;
        } else if (open !== undefined) {
          add(open.id, wait.id, 'resumed-from');
          open = undefined;
        }
      }
    }
    // A folded node stands for the body steps it folds: it was invoked by their loop step.
    for (const step of steps.values()) {
      if (step.nodeKind === 'loop' && !hidden.has(step.scope)) {
        add(foldedKey(step.scope), stepKey(step.scope), 'invoked');
      }
    }
    if (hasOutput) {
      for (const from of outputSources()) add('output', stepKey(from), 'produced');
    }
    return edges;
  }

  /**
   * The steps the run's output was taken from, as the kernel takes it: the
   * steps whose outputs the flow's declared `output.mapping` reads, or,
   * without one, the step feeding the lowest-id taken edge to `$end`.
   */
  function outputSources(): string[] {
    const declared = run.flow.output;
    if (declared !== undefined) {
      const read = new Set<string>();
      for (const operand of Object.values(declared.mapping)) {
        if (!('path' in operand)) continue;
        for (const node of run.flow.nodes) {
          const root = `nodeOutputs.${node.id}`;
          if (
            operand.path === root ||
            operand.path.startsWith(`${root}.`) ||
            operand.path.startsWith(`${root}[`)
          ) {
            if (steps.get(node.id)?.status === 'completed') read.add(node.id);
          }
        }
      }
      return [...read];
    }
    const ends = run.flow.edges
      .filter((e) => e.to === END_NODE && topEdges.get(e.id) === true)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of ends) {
      if (edge.from === START_NODE) continue;
      if (steps.get(edge.from)?.status === 'completed') return [edge.from];
    }
    return [];
  }

  // ---------------------------------------------------------------------
  // The record's caps: cut from the middle, in journal order.
  // ---------------------------------------------------------------------

  function cutToCaps(
    nodes: ProvenanceNode[],
    candidates: Candidate[],
    edges: ProvenanceEdge[],
  ): Provenance {
    const header = {
      id: flowProvenanceId(run.runId),
      runId: run.runId,
      tenantId: run.tenantId,
      flowRef: { id: run.flow.id, version: run.flow.version },
      version: FLOW_PROVENANCE_VERSION,
      createdAt: run.completedAt,
    };
    const whole = record(header, nodes, edges);
    if (nodes.length <= L.maxNodes && signingBytes(whole).length <= L.maxRecordBytes) return whole;

    const reason = nodes.length > L.maxNodes ? 'nodes' : 'bytes';
    const nodeBytes = nodes.map((n) => byteLength(canonicalize(n)) + 1);
    const outgoing = new Map<string, number>();
    for (const e of edges)
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + byteLength(canonicalize(e)) + 1);
    const cost = nodes.map((n, i) => (nodeBytes[i] ?? 0) + (outgoing.get(n.id) ?? 0));
    // The header, the gap's node and its edges: a generous reserve.
    const reserve = byteLength(canonicalize({ ...header, nodes: [], edges: [] })) + 4096;

    const lastIdx = nodes.length - 1;
    const pinnedEnd = candidates[lastIdx]?.key === 'output' ? 1 : 0;
    let budgetBytes =
      L.maxRecordBytes - reserve - (cost[0] ?? 0) - (pinnedEnd ? (cost[lastIdx] ?? 0) : 0);
    let budgetNodes = L.maxNodes - 2 - pinnedEnd;
    let lo = 1;
    let hi = lastIdx - pinnedEnd;
    let takeLo = true;
    const keepLo: number[] = [];
    const keepHi: number[] = [];
    while (lo <= hi && budgetNodes > 0) {
      const i = takeLo ? lo : hi;
      const c = cost[i] ?? 0;
      if (c > budgetBytes) break;
      budgetBytes -= c;
      budgetNodes -= 1;
      if (takeLo) {
        keepLo.push(i);
        lo += 1;
      } else {
        keepHi.push(i);
        hi -= 1;
      }
      takeLo = !takeLo;
    }
    for (;;) {
      const result = cut(header, nodes, candidates, edges, reason, keepLo, keepHi, pinnedEnd);
      if (signingBytes(result).length <= L.maxRecordBytes) return result;
      // The reserve fell short: give back one more from the middle.
      if (keepHi.length >= keepLo.length && keepHi.length > 0) keepHi.pop();
      else if (keepLo.length > 0) keepLo.pop();
      else return result;
    }
  }

  function cut(
    header: Omit<Provenance, 'nodes' | 'edges'>,
    nodes: ProvenanceNode[],
    candidates: Candidate[],
    edges: ProvenanceEdge[],
    reason: 'nodes' | 'bytes',
    keepLo: number[],
    keepHi: number[],
    pinnedEnd: number,
  ): Provenance {
    const lastIdx = nodes.length - 1;
    const keptIdx = new Set<number>([0, ...keepLo, ...keepHi, ...(pinnedEnd ? [lastIdx] : [])]);
    const keptIds = new Set<string>();
    let omittedSteps = 0;
    let fromSequence = Number.POSITIVE_INFINITY;
    let toSequence = Number.NEGATIVE_INFINITY;
    let entriesGap: unknown;
    nodes.forEach((n, i) => {
      if (keptIdx.has(i)) {
        keptIds.add(n.id);
        return;
      }
      const c = candidates[i];
      if (c === undefined) return;
      if (c.isStep) omittedSteps += 1;
      if (c.key === 'truncated:entries')
        entriesGap = (n.attributes as { truncated?: unknown }).truncated;
      fromSequence = Math.min(fromSequence, c.sequence);
      toSequence = Math.max(toSequence, c.lastSequence);
    });
    const gapAt =
      candidates[keepLo.length > 0 ? (keepLo[keepLo.length - 1] ?? 0) : 0]?.node.timestamp;
    const gapNode: ProvenanceNode = {
      id: 'truncated',
      kind: 'event',
      timestamp: gapAt ?? run.completedAt,
      attributes: {
        truncated: {
          reason,
          omittedSteps,
          fromSequence: Number.isFinite(fromSequence) ? fromSequence : 0,
          toSequence: Number.isFinite(toSequence) ? toSequence : 0,
          ...(entriesGap !== undefined && { entries: entriesGap }),
        },
      },
    };
    const keptNodes: ProvenanceNode[] = [];
    nodes.forEach((n, i) => {
      if (keptIdx.has(i)) keptNodes.push(n);
      if (i === (keepLo[keepLo.length - 1] ?? 0)) keptNodes.push(gapNode);
    });
    const keptEdges: ProvenanceEdge[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (!keptIds.has(e.from)) continue;
      const edge: ProvenanceEdge = keptIds.has(e.to)
        ? e
        : { from: e.from, to: 'truncated', kind: 'caused-by' };
      const k = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      keptEdges.push(edge);
    }
    return record(header, keptNodes, keptEdges);
  }

  function record(
    header: Omit<Provenance, 'nodes' | 'edges'>,
    nodes: readonly ProvenanceNode[],
    edges: readonly ProvenanceEdge[],
  ): Provenance {
    const b = newBuilder({
      id: header.id,
      runId: header.runId,
      tenantId: header.tenantId,
      ...(header.flowRef !== undefined && { flowRef: header.flowRef }),
      version: header.version,
      createdAt: header.createdAt,
    });
    for (const n of nodes) b.addNode(n);
    for (const e of edges) b.addEdge(e);
    return b.snapshot();
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
