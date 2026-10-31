// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { FanoutNode, Flow, FlowEdge, FlowNode, LoopEdge, LoopNode } from '@kindgi/flow';
import { bodyStepKey } from '@kindgi/runtime';
import type { JournalEntryFacts, JournalEntryPosition, JournalKind } from '@kindgi/runtime';
import { canonicalize } from '@kindgi/schema';
import type {
  EdgeId,
  FlowId,
  NodeId,
  ProvenanceId,
  RunId,
  TenantId,
  Timestamp,
} from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import {
  FLOW_PROVENANCE_LIMITS,
  FLOW_PROVENANCE_VERSION,
  exportProvenance,
  flowProvenanceBuilder,
  flowProvenanceId,
  importProvenance,
  signingBytes,
  stepNodePlacer,
} from '../src/index.js';
import type {
  FlowJournalGap,
  FlowProvenanceChild,
  FlowProvenanceRun,
  FlowReusedSource,
  Provenance,
  ProvenanceEdge,
  ProvenanceNode,
} from '../src/index.js';

const L = FLOW_PROVENANCE_LIMITS;
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const at = (n: number): Timestamp => new Date(T0 + n * 1000).toISOString() as Timestamp;

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

const tool = (id: string, ref = `acme.${id}`): FlowNode => ({
  id: id as NodeId,
  kind: 'tool',
  ref,
});
const agent = (id: string, ref: string): FlowNode => ({ id: id as NodeId, kind: 'agent', ref });
const edge = (id: string, from: string, to: string): FlowEdge => ({
  id: id as EdgeId,
  from: from as NodeId,
  to: to as NodeId,
});
const loopEdge = (id: string, from: string, to: string): LoopEdge => ({
  id: id as EdgeId,
  from: from as NodeId,
  to: to as NodeId,
});
const foreach = (id: string, nodes: FlowNode[], edges: LoopEdge[]): LoopNode => ({
  id: id as NodeId,
  kind: 'loop',
  loopKind: 'foreach',
  iterateOver: { path: 'input.items' },
  body: { nodes, edges },
  maxIterations: 10000,
  outputSchema: {},
});
/** A loop whose body is the one node `inner`, from `$loop-start` to `$loop-end`. */
const loopOf = (id: string, inner: FlowNode): LoopNode =>
  foreach(
    id,
    [inner],
    [loopEdge(`${id}.in`, '$loop-start', inner.id), loopEdge(`${id}.out`, inner.id, '$loop-end')],
  );
const flowOf = (nodes: FlowNode[], edges: FlowEdge[], extra: Partial<Flow> = {}): Flow => ({
  id: 'acme.report' as FlowId,
  version: '1.0.0',
  nodes,
  edges,
  ...extra,
});
/** `$start → s0 → s1 → … → s(n-1) → $end`: edge `e<i>` into `s<i>`, `end` out of the last. */
function chainFlow(n: number, extra: Partial<Flow> = {}): Flow {
  const nodes = Array.from({ length: n }, (_, i) => tool(`s${i}`, 'acme.step'));
  const edges = [
    edge('e0', '$start', 's0'),
    ...Array.from({ length: n - 1 }, (_, i) => edge(`e${i + 1}`, `s${i}`, `s${i + 1}`)),
    edge('end', `s${n - 1}`, '$end'),
  ];
  return flowOf(nodes, edges, extra);
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

interface Place {
  readonly scope: string;
  readonly loopScope: string;
  readonly iteration: number;
}

type LoopContext = Parameters<typeof bodyStepKey>[1];

/** A loop path, innermost first, as the kernel keeps it. */
type LoopPath = { loopNodeId: string; iteration: number }[];

/** A loop body step's place: its `bodyStepKey`, its loop execution's scope, its iteration. */
function inBody(nodeId: string, path: LoopPath): Place {
  const [inner, ...outer] = path;
  if (inner === undefined) throw new Error('inBody: an empty path');
  return {
    scope: bodyStepKey(nodeId as NodeId, contextOf(path)),
    loopScope:
      outer.length === 0
        ? inner.loopNodeId
        : bodyStepKey(inner.loopNodeId as NodeId, contextOf(outer)),
    iteration: inner.iteration,
  };
}

function contextOf(path: LoopPath): LoopContext {
  const [inner] = path;
  if (inner === undefined) throw new Error('contextOf: an empty path');
  return {
    loopNodeId: inner.loopNodeId as NodeId,
    iteration: inner.iteration,
    path: path.map((p) => ({ loopNodeId: p.loopNodeId as NodeId, iteration: p.iteration })),
  } as unknown as LoopContext;
}

class Journal {
  readonly entries: JournalEntryPosition[] = [];
  private next = 0;

  add(kind: JournalKind, nodeId?: string, facts?: JournalEntryFacts): number {
    const sequence = this.next;
    this.next += 1;
    this.entries.push({
      sequence,
      kind,
      ...(nodeId !== undefined && { nodeId: nodeId as NodeId }),
      timestamp: at(sequence),
      ...(facts !== undefined && { facts }),
    });
    return sequence;
  }

  edge(edgeId: string, decision = true, place?: { loopScope: string; iteration: number }): void {
    this.add('edge.evaluated', undefined, { edgeId, decision, ...place });
  }

  /** A step that starts and completes; in a loop body when `place` is given. */
  step(nodeId: string, place?: Place): void {
    this.add('step.started', nodeId, place);
    this.add('step.completed', nodeId, place);
  }

  iteration(kind: 'started' | 'completed', loopNodeId: string, facts: JournalEntryFacts): void {
    this.add(`iteration.${kind}`, loopNodeId, facts);
  }
}

/** A loop execution at `path` (its own path, outermost last) running `count` iterations of `body`. */
function runLoop(
  j: Journal,
  loop: LoopNode,
  ownPlace: Place | undefined,
  outer: LoopPath,
  count: number,
  body: (path: LoopPath, iteration: number) => void,
): void {
  j.add('step.started', loop.id, ownPlace);
  const scope = ownPlace?.scope ?? loop.id;
  for (let i = 0; i < count; i += 1) {
    const path = [{ loopNodeId: loop.id, iteration: i }, ...outer];
    j.iteration('started', loop.id, { scope, iteration: i });
    body(path, i);
    j.iteration('completed', loop.id, {
      scope,
      iteration: i,
      ...(i === count - 1 && { stopReason: 'items-done' }),
    });
  }
  j.add('step.completed', loop.id, ownPlace);
}

/** One body node `inner` per iteration, its edges in, then the step. */
function oneStepBody(j: Journal, loop: LoopNode, inner: string) {
  return (path: LoopPath, i: number): void => {
    const place = inBody(inner, path);
    j.edge(`${loop.id}.in`, true, { loopScope: place.loopScope, iteration: i });
    j.step(inner, place);
    j.edge(`${loop.id}.out`, true, { loopScope: place.loopScope, iteration: i });
  };
}

// ---------------------------------------------------------------------------
// Runs and records
// ---------------------------------------------------------------------------

function runOf(flow: Flow, extra: Partial<FlowProvenanceRun> = {}): FlowProvenanceRun {
  return {
    runId: 'run-1' as RunId,
    tenantId: 'acme' as TenantId,
    flow,
    status: 'completed',
    completedAt: at(1_000_000),
    hasOutput: true,
    children: [],
    ...extra,
  };
}

/** Builds the record page by page, as the worker reads the journal. */
function build(
  run: FlowProvenanceRun,
  entries: readonly JournalEntryPosition[],
  options: { pageSize?: number; gap?: FlowJournalGap } = {},
): Provenance {
  const pageSize = options.pageSize ?? 1000;
  const b = flowProvenanceBuilder(run);
  const gap = options.gap;
  const before = gap === undefined ? entries : entries.filter((e) => e.sequence < gap.fromSequence);
  const after = gap === undefined ? [] : entries.filter((e) => e.sequence > gap.toSequence);
  for (let i = 0; i < before.length; i += pageSize) b.add(before.slice(i, i + pageSize));
  if (gap !== undefined) b.skip(gap);
  for (let i = 0; i < after.length; i += pageSize) b.add(after.slice(i, i + pageSize));
  const record = b.finish();
  expectWellFormed(record);
  return record;
}

/** Every record: unique ids, edges between its nodes, within the caps, and it round-trips. */
function expectWellFormed(record: Provenance): void {
  const ids = record.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  const known = new Set(ids);
  for (const e of record.edges) {
    expect(known.has(e.from), `edge from ${e.from}`).toBe(true);
    expect(known.has(e.to), `edge to ${e.to}`).toBe(true);
  }
  expect(record.nodes.length).toBeLessThanOrEqual(L.maxNodes);
  expect(signingBytes(record).length).toBeLessThanOrEqual(L.maxRecordBytes);
  for (const n of record.nodes) {
    if (n.kind === 'step') {
      expect(attributeBytes(n), n.id).toBeLessThanOrEqual(L.maxNodeAttributeBytes);
    }
  }
  expect(importProvenance(exportProvenance(record))).toEqual(record);
}

const attributeBytes = (n: ProvenanceNode): number =>
  Buffer.byteLength(canonicalize(n.attributes ?? {}), 'utf8');

function nodeOf(record: Provenance, id: string): ProvenanceNode {
  const n = record.nodes.find((x) => x.id === id);
  if (n === undefined)
    throw new Error(`no node ${id}: ${record.nodes.map((x) => x.id).join(', ')}`);
  return n;
}
const attrs = (record: Provenance, id: string): Record<string, unknown> =>
  (nodeOf(record, id).attributes ?? {}) as Record<string, unknown>;
const ids = (record: Provenance): string[] => record.nodes.map((n) => n.id);
const has = (record: Provenance, id: string): boolean => record.nodes.some((n) => n.id === id);
const edgeSet = (edges: readonly ProvenanceEdge[]): string[] =>
  edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`).sort();
const digestId = (raw: string): string =>
  `step:~${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)}`;

/** Every node is on an edge, and every folded node's loop step is in the record. */
function expectConnected(record: Provenance): void {
  const onEdge = new Set(record.edges.flatMap((e) => [e.from, e.to]));
  for (const n of record.nodes) expect(onEdge.has(n.id), `${n.id} has no edge`).toBe(true);
  for (const id of ids(record).filter((x) => x.endsWith('#folded'))) {
    expect(has(record, id.slice(0, -'#folded'.length)), `${id}'s loop`).toBe(true);
  }
}

/** The child runs a node counts: a step node's list and what it cut, a folded node's count. */
function runsCountedBy(node: ProvenanceNode): number {
  const a = (node.attributes ?? {}) as {
    runs?: unknown[];
    truncated?: { runsOmitted?: number };
    folded?: { runs?: number };
  };
  return (a.runs?.length ?? 0) + (a.truncated?.runsOmitted ?? 0) + (a.folded?.runs ?? 0);
}
const countedRuns = (record: Provenance): number =>
  record.nodes.reduce((n, node) => n + runsCountedBy(node), 0);

// ---------------------------------------------------------------------------

describe('flowProvenanceId', () => {
  test('is the RFC 9562 version 5 UUID of ["<runId>","flow-provenance"] in its namespace', () => {
    // Computed apart from this code, with Python's uuid.uuid5.
    expect(flowProvenanceId('run-1' as RunId)).toBe('53fe04c0-279b-532b-96c1-7f931469a2f5');
    expect(flowProvenanceId('run-2' as RunId)).toBe('5b7ad0ee-29e9-5af5-8e08-aa3b80d75235');
  });
});

describe('a flow run', () => {
  const flow = flowOf(
    [tool('fetch'), agent('write', 'acme.writer')],
    [edge('e1', '$start', 'fetch'), edge('e2', 'fetch', 'write'), edge('e3', 'write', '$end')],
    { pins: { tools: { 'acme.fetch': '1.2.0' }, agents: { 'acme.writer': '3' } } },
  );
  const turn: FlowProvenanceChild = {
    runId: 'turn-1' as RunId,
    flowId: 'acme.writer',
    status: 'completed',
    parentNodeId: 'write',
    parentScope: '',
    provenanceId: 'b5a3f7c2-0a51-4c55-9e8f-3d3a3f3c1e01' as ProvenanceId,
  };

  test('names its steps, why each ran, the runs they started and what made the output', () => {
    const j = new Journal();
    const started = j.add('run.started');
    j.edge('e1');
    j.add('step.started', 'fetch');
    j.add('step.retry-scheduled', 'fetch', { attempt: 1, nextDelayMs: 500 });
    j.add('step.completed', 'fetch');
    j.edge('e2');
    j.add('step.started', 'write');
    // The agent step parks on its turn: the turn's run is already in `runs`.
    j.add('wait.suspended', 'write', { scope: 'write' });
    j.add('wait.resumed', 'write', { scope: 'write' });
    j.add('step.completed', 'write');
    j.edge('e3');
    const record = build(runOf(flow, { children: [turn] }), j.entries);

    expect(record).toMatchObject({
      id: flowProvenanceId('run-1' as RunId),
      runId: 'run-1',
      tenantId: 'acme',
      flowRef: { id: 'acme.report', version: '1.0.0' },
      version: FLOW_PROVENANCE_VERSION,
      createdAt: at(1_000_000),
    });
    expect(ids(record)).toEqual(['input', 'step:fetch', 'step:write', 'output']);
    expect(nodeOf(record, 'input')).toEqual({ id: 'input', kind: 'input', timestamp: at(started) });
    expect(nodeOf(record, 'step:fetch')).toEqual({
      id: 'step:fetch',
      kind: 'step',
      timestamp: at(2),
      attributes: {
        nodeId: 'fetch',
        nodeKind: 'tool',
        ref: { id: 'acme.fetch', version: '1.2.0' },
        status: 'completed',
        startedAt: at(2),
        endedAt: at(4),
        attempts: 2,
        reachedBy: ['e1'],
      },
    });
    expect(attrs(record, 'step:write')).toEqual({
      nodeId: 'write',
      nodeKind: 'agent',
      ref: { id: 'acme.writer', version: '3' },
      status: 'completed',
      startedAt: at(6),
      endedAt: at(9),
      attempts: 1,
      reachedBy: ['e2'],
      runs: [
        {
          runId: 'turn-1',
          flowId: 'acme.writer',
          status: 'completed',
          provenanceId: 'b5a3f7c2-0a51-4c55-9e8f-3d3a3f3c1e01',
        },
      ],
    });
    expect(nodeOf(record, 'output')).toEqual({
      id: 'output',
      kind: 'artifact',
      timestamp: at(1_000_000),
    });
    expect(edgeSet(record.edges)).toEqual([
      'output -produced-> step:write',
      'step:fetch -caused-by-> input',
      'step:write -caused-by-> step:fetch',
    ]);
  });

  test('a failed step keeps its code and limits; a failed run has no output node', () => {
    const f = flowOf(
      [tool('a'), tool('b'), tool('c')],
      [edge('e1', '$start', 'a'), edge('e2', '$start', 'b'), edge('e3', '$start', 'c')],
    );
    const j = new Journal();
    j.add('run.started');
    for (const id of ['e1', 'e2', 'e3']) j.edge(id);
    j.add('step.started', 'a');
    j.add('step.started', 'b');
    j.add('step.started', 'c');
    j.add('step.failed', 'a', { reason: 'timeout', limitMs: 1000, elapsedMs: 1003 });
    j.add('step.failed', 'b', { reason: 'cancelled' });
    // From before the kernel kept facts: no reason to read.
    j.add('step.failed', 'c');
    const record = build(runOf(f, { status: 'failed', hasOutput: true }), j.entries);

    expect(has(record, 'output')).toBe(false);
    expect(attrs(record, 'step:a')).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', limitMs: 1000, elapsedMs: 1003 },
    });
    expect(attrs(record, 'step:b')).toMatchObject({
      status: 'cancelled',
      failure: { reason: 'cancelled' },
    });
    expect(attrs(record, 'step:c')).toMatchObject({ status: 'failed' });
    expect(attrs(record, 'step:c')).not.toHaveProperty('failure');
  });

  test('a step still running when the run ended is unfinished', () => {
    const f = flowOf([tool('a')], [edge('e1', '$start', 'a')]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'a');
    const record = build(runOf(f, { status: 'cancelled', hasOutput: false }), j.entries);
    expect(attrs(record, 'step:a')).toMatchObject({ status: 'unfinished' });
    expect(attrs(record, 'step:a')).not.toHaveProperty('endedAt');
  });

  test('a replay names the run it replays and its test run', () => {
    const j = new Journal();
    j.edge('e1');
    j.step('fetch');
    const record = build(
      runOf(flow, { replayOf: 'run-0' as RunId, testRunId: 'eval-7', hasOutput: false }),
      j.entries,
    );
    expect(attrs(record, 'input')).toEqual({ replayOf: 'run-0', testRunId: 'eval-7' });
  });

  test("a tool step's wait and resume are nodes of their own", () => {
    const f = flowOf([tool('approve')], [edge('e1', '$start', 'approve')]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'approve');
    const waited = j.add('wait.suspended', 'approve', { scope: 'approve' });
    // The same suspension again: still one wait.
    j.add('wait.suspended', 'approve', { scope: 'approve' });
    const resumed = j.add('wait.resumed', 'approve', { scope: 'approve' });
    j.add('step.completed', 'approve');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(ids(record)).toEqual(['input', 'step:approve', `wait:${waited}`, `resume:${resumed}`]);
    expect(nodeOf(record, `wait:${waited}`)).toEqual({
      id: `wait:${waited}`,
      kind: 'wait',
      timestamp: at(waited),
      attributes: { scope: 'approve' },
    });
    expect(attrs(record, `resume:${resumed}`)).toEqual({ scope: 'approve' });
    expect(edgeSet(record.edges)).toEqual([
      'step:approve -caused-by-> input',
      `step:approve -waited-on-> wait:${waited}`,
      `wait:${waited} -resumed-from-> resume:${resumed}`,
    ]);
  });

  test("a cancelled wait's resume says so, with the kernel's reason, and the step then fails", () => {
    const f = flowOf([tool('approve')], [edge('e1', '$start', 'approve')]);
    for (const [kept, said] of [
      [{ reason: 'timeout' }, { decision: 'cancelled', reason: 'timeout' }],
      // A reason the kernel doesn't know stays out of the facts.
      [{}, { decision: 'cancelled' }],
    ] as const) {
      const j = new Journal();
      j.edge('e1');
      j.add('step.started', 'approve');
      const waited = j.add('wait.suspended', 'approve', { scope: 'approve' });
      // The timeout sweep cancels the wait; on replay the step's handler throws.
      const cancelled = j.add('wait.cancelled', 'approve', { scope: 'approve', ...kept });
      j.add('step.failed', 'approve', {});
      const record = build(runOf(f, { status: 'failed', hasOutput: false }), j.entries);

      expect(nodeOf(record, `resume:${cancelled}`)).toEqual({
        id: `resume:${cancelled}`,
        kind: 'resume',
        timestamp: at(cancelled),
        attributes: { scope: 'approve', ...said },
      });
      expect(attrs(record, 'step:approve')).toMatchObject({ status: 'failed' });
      expect(edgeSet(record.edges)).toEqual([
        'step:approve -caused-by-> input',
        `step:approve -waited-on-> wait:${waited}`,
        `wait:${waited} -resumed-from-> resume:${cancelled}`,
      ]);
    }
  });

  test('a waitpoint from before waits kept their scope: a top-level step’s wait is placed by its node id', () => {
    const f = flowOf([tool('approve')], [edge('e1', '$start', 'approve')]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'approve');
    // Made before the upgrade: no facts. Resumed after it: facts, but the row has no scope.
    const waited = j.add('wait.suspended', 'approve');
    const resumed = j.add('wait.resumed', 'approve', {});
    j.add('step.completed', 'approve');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(ids(record)).toEqual(['input', 'step:approve', `wait:${waited}`, `resume:${resumed}`]);
    expect(edgeSet(record.edges)).toEqual([
      'step:approve -caused-by-> input',
      `step:approve -waited-on-> wait:${waited}`,
      `wait:${waited} -resumed-from-> resume:${resumed}`,
    ]);
  });

  describe('the output, as the kernel takes it', () => {
    const f = (extra: Partial<Flow> = {}) =>
      flowOf(
        [tool('a'), tool('b')],
        [
          edge('e1', '$start', 'a'),
          edge('e2', '$start', 'b'),
          edge('e9', 'a', '$end'),
          edge('e10', 'b', '$end'),
        ],
        extra,
      );
    const journal = (e10: boolean) => {
      const j = new Journal();
      j.edge('e1');
      j.edge('e2');
      j.step('a');
      j.step('b');
      j.edge('e9');
      j.edge('e10', e10);
      return j.entries;
    };

    test('from the step feeding the lowest-id taken edge to $end, by string order', () => {
      expect(edgeSet(build(runOf(f()), journal(true)).edges)).toContain(
        'output -produced-> step:b',
      );
      // An edge not taken doesn't count.
      expect(edgeSet(build(runOf(f()), journal(false)).edges)).toContain(
        'output -produced-> step:a',
      );
    });

    test('from the steps a declared output mapping reads', () => {
      const declared = f({ output: { mapping: { report: { path: 'nodeOutputs.a.text' } } } });
      const produced = build(runOf(declared), journal(true)).edges.filter(
        (e) => e.kind === 'produced',
      );
      expect(edgeSet(produced)).toEqual(['output -produced-> step:a']);
    });

    test('no output node when the run completed without one', () => {
      expect(has(build(runOf(f(), { hasOutput: false }), journal(true)), 'output')).toBe(false);
    });
  });
});

describe('loops', () => {
  const body = foreach(
    'L',
    [tool('x'), tool('y')],
    [
      loopEdge('le1', '$loop-start', 'x'),
      loopEdge('le2', 'x', 'y'),
      loopEdge('le3', 'y', '$loop-end'),
    ],
  );
  const flow = flowOf([body], [edge('e1', '$start', 'L'), edge('e2', 'L', '$end')]);
  const iterationOf = (j: Journal, i: number): void => {
    const x = inBody('x', [{ loopNodeId: 'L', iteration: i }]);
    const y = inBody('y', [{ loopNodeId: 'L', iteration: i }]);
    const place = { loopScope: 'L', iteration: i };
    j.edge('le1', true, place);
    j.step('x', x);
    j.edge('le2', true, place);
    j.step('y', y);
    j.edge('le3', true, place);
  };

  test('a body step is placed by its scope and iteration, and caused by its own iteration only', () => {
    const j = new Journal();
    j.edge('e1');
    runLoop(j, body, undefined, [], 3, (_, i) => iterationOf(j, i));
    j.edge('e2');
    const record = build(runOf(flow), j.entries);

    expect(ids(record)).toEqual([
      'input',
      'step:L',
      'step:x@L#0',
      'step:y@L#0',
      'step:x@L#1',
      'step:y@L#1',
      'step:x@L#2',
      'step:y@L#2',
      'output',
    ]);
    expect(attrs(record, 'step:L')).toMatchObject({
      nodeKind: 'loop',
      status: 'completed',
      iterations: { count: 3, stopReason: 'items-done' },
    });
    expect(attrs(record, 'step:L')).not.toHaveProperty('partial');
    expect(attrs(record, 'step:y@L#1')).toEqual({
      nodeId: 'y',
      nodeKind: 'tool',
      ref: { id: 'acme.y' },
      iteration: 1,
      status: 'completed',
      startedAt: nodeOf(record, 'step:y@L#1').timestamp,
      endedAt: expect.any(String),
      attempts: 1,
      reachedBy: ['le2'],
    });
    const edges = edgeSet(record.edges);
    expect(edges).toContain('step:y@L#1 -caused-by-> step:x@L#1');
    expect(edges).not.toContain('step:y@L#1 -caused-by-> step:x@L#0');
    expect(edges).toContain('step:x@L#1 -invoked-> step:L');
    expect(edges).toContain('step:L -caused-by-> input');
    expect(edges).toContain('output -produced-> step:L');
  });

  test('a foreach over no items ran 0 iterations', () => {
    const j = new Journal();
    j.edge('e1');
    j.step('L');
    const record = build(runOf(flow, { hasOutput: false }), j.entries);
    expect(attrs(record, 'step:L')).toMatchObject({ iterations: { count: 0 } });
    expect(has(record, 'step:L#folded')).toBe(false);
  });

  test('a loop replayed from iteration 0 on resume is one execution', () => {
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'L');
    for (const i of [0, 1]) {
      j.iteration('started', 'L', { scope: 'L', iteration: i });
      iterationOf(j, i);
      j.iteration('completed', 'L', { scope: 'L', iteration: i });
    }
    // Resumed: the kernel replays iterations 0 and 1 without their completed steps.
    for (const i of [0, 1]) {
      const place = { loopScope: 'L', iteration: i };
      j.iteration('started', 'L', { scope: 'L', iteration: i });
      j.edge('le1', true, place);
      j.edge('le2', true, place);
      j.edge('le3', true, place);
      j.iteration('completed', 'L', { scope: 'L', iteration: i });
    }
    j.iteration('started', 'L', { scope: 'L', iteration: 2 });
    iterationOf(j, 2);
    j.iteration('completed', 'L', { scope: 'L', iteration: 2 });
    j.add('step.completed', 'L');
    const record = build(runOf(flow, { hasOutput: false }), j.entries);

    expect(ids(record).filter((id) => id.startsWith('step:x@'))).toEqual([
      'step:x@L#0',
      'step:x@L#1',
      'step:x@L#2',
    ]);
    expect(attrs(record, 'step:L')).toMatchObject({ iterations: { count: 3 } });
    expect(attrs(record, 'step:x@L#0')).toMatchObject({ attempts: 1, reachedBy: ['le1'] });
  });

  test("an iteration with no scope is placed by a top-level loop's id", () => {
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'L');
    j.iteration('started', 'L', { iteration: 0 });
    iterationOf(j, 0);
    j.iteration('completed', 'L', { iteration: 0, stopReason: 'items-done' });
    j.add('step.completed', 'L');
    const record = build(runOf(flow, { hasOutput: false }), j.entries);

    expect(attrs(record, 'step:L')).toMatchObject({ iterations: { count: 1 } });
    expect(attrs(record, 'step:L')).not.toHaveProperty('partial');
    expect(has(record, 'step:x@L#0')).toBe(true);
  });

  test('a foreach finishing out of order keeps iterations 0..24 and the last 25, by index', () => {
    const inner = tool('x');
    const loop = loopOf('L', inner);
    const f = flowOf([loop], [edge('e1', '$start', 'L'), edge('e2', 'L', '$end')]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'L');
    const n = 60;
    // Two workers: each pair starts in swapped order; then all finish, last first.
    for (let k = 0; k < n; k += 1) {
      const i = k % 2 === 0 ? k + 1 : k - 1;
      j.iteration('started', 'L', { scope: 'L', iteration: i });
      j.add('step.started', 'x', inBody('x', [{ loopNodeId: 'L', iteration: i }]));
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      j.add('step.completed', 'x', inBody('x', [{ loopNodeId: 'L', iteration: i }]));
      j.iteration('completed', 'L', { scope: 'L', iteration: i });
    }
    j.add('step.completed', 'L');
    j.edge('e2');
    const record = build(runOf(f), j.entries);

    const kept = ids(record)
      .filter((id) => id.startsWith('step:x@'))
      .map((id) => Number(id.slice('step:x@L#'.length)))
      .sort((a, b) => a - b);
    expect(kept).toEqual([
      ...Array.from({ length: 25 }, (_, i) => i),
      ...Array.from({ length: 25 }, (_, i) => 35 + i),
    ]);
    expect(attrs(record, 'step:L#folded')).toEqual({
      nodeId: 'L',
      folded: { from: 25, to: 34, count: 10, byStatus: { completed: 10 }, runs: 0 },
    });
    expect(edgeSet(record.edges)).toContain('step:L#folded -invoked-> step:L');
    expect(attrs(record, 'step:L')).toMatchObject({ iterations: { count: 60 } });
  });

  test("nested loops keep the outer loop's last iterations, and the output", () => {
    const z = tool('z');
    const innerLoop = loopOf('I', z);
    const outer = loopOf('O', innerLoop);
    const f = flowOf([outer], [edge('e1', '$start', 'O'), edge('e2', 'O', '$end')]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, outer, undefined, [], 100, (path, i) => {
      const place = inBody('I', path);
      j.edge('O.in', true, { loopScope: place.loopScope, iteration: i });
      runLoop(j, innerLoop, place, path, 100, oneStepBody(j, innerLoop, 'z'));
      j.edge('O.out', true, { loopScope: place.loopScope, iteration: i });
    });
    j.edge('e2');
    const record = build(runOf(f), j.entries);

    // Depth 2 keeps 25 iterations from each end, and its folded node: 52 nodes an iteration.
    // Depth 1 keeps 48 of those within 2500: 0..23 and 76..99.
    expect(attrs(record, 'step:O#folded')).toMatchObject({
      folded: { from: 24, to: 75, count: 52, byStatus: { completed: 52 } },
    });
    for (const i of [0, 23, 76, 99]) {
      expect(has(record, `step:I@O#${i}`), `I@O#${i}`).toBe(true);
      expect(has(record, `step:z@I#0/O#${i}`)).toBe(true);
      expect(has(record, `step:z@I#99/O#${i}`)).toBe(true);
      expect(attrs(record, `step:I@O#${i}#folded`)).toMatchObject({
        folded: { from: 25, to: 74, count: 50 },
      });
    }
    expect(has(record, 'step:I@O#24')).toBe(false);
    expect(has(record, 'step:z@I#0/O#50')).toBe(false);
    // A run of I in a folded iteration of O has no folded node of its own.
    for (let i = 24; i <= 75; i += 1) {
      expect(has(record, `step:I@O#${i}#folded`), `I@O#${i}#folded`).toBe(false);
    }
    // O's nodes, within depth 1's budget: 48 iterations of 52, and its folded node. Then input, O, output.
    expect(record.nodes.length - 3).toBe(48 * 52 + 1);
    expect(record.nodes.length - 3).toBeLessThanOrEqual(L.loopNodeBudgets[0]);
    expectConnected(record);
    expect(edgeSet(record.edges)).toContain('step:z@I#99/O#99 -invoked-> step:I@O#99');
    expect(edgeSet(record.edges)).toContain('step:I@O#99 -invoked-> step:O');
    expect(edgeSet(record.edges)).toContain('output -produced-> step:O');
    expect(has(record, 'truncated')).toBe(false);
  });

  test('a loop three deep keeps 25 nodes of each execution', () => {
    const z = tool('z');
    const l3 = loopOf('L3', z);
    const l2 = loopOf('L2', l3);
    const l1 = loopOf('L1', l2);
    const f = flowOf([l1], [edge('e1', '$start', 'L1')]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, l1, undefined, [], 1, (p1) => {
      runLoop(j, l2, inBody('L2', p1), p1, 1, (p2) => {
        runLoop(j, l3, inBody('L3', p2), p2, 30, oneStepBody(j, l3, 'z'));
      });
    });
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    const l3Scope = inBody('L3', [
      { loopNodeId: 'L2', iteration: 0 },
      { loopNodeId: 'L1', iteration: 0 },
    ]).scope;
    expect(l3Scope).toBe('L3@L2#0/L1#0');
    // First, last, second, second to last…: 25 fit, 13..17 fold.
    expect(attrs(record, `step:${l3Scope}#folded`)).toMatchObject({
      folded: { from: 13, to: 17, count: 5 },
    });
    expect(has(record, 'step:z@L3#12/L2#0/L1#0')).toBe(true);
    expect(has(record, 'step:z@L3#18/L2#0/L1#0')).toBe(true);
    expect(has(record, 'step:z@L3#13/L2#0/L1#0')).toBe(false);
    expectConnected(record);
  });

  test('loops in a folded iteration have no folded nodes: the outer one counts their runs', () => {
    const w = agent('w', 'acme.writer');
    const l3 = loopOf('L3', w);
    const l2 = loopOf('L2', l3);
    const l1 = loopOf('L1', l2);
    const f = flowOf([l1], [edge('e1', '$start', 'L1')]);
    const j = new Journal();
    const children: FlowProvenanceChild[] = [];
    const body = oneStepBody(j, l3, 'w');
    j.edge('e1');
    runLoop(j, l1, undefined, [], 12, (p1) => {
      runLoop(j, l2, inBody('L2', p1), p1, 12, (p2) => {
        runLoop(j, l3, inBody('L3', p2), p2, 30, (p3, i) => {
          body(p3, i);
          children.push({
            runId: `turn-${children.length}` as RunId,
            flowId: 'acme.writer',
            status: 'completed',
            parentNodeId: 'w',
            parentScope: JSON.stringify(p3),
          });
        });
      });
    });
    const record = build(runOf(f, { hasOutput: false, children }), j.entries);

    // L3 keeps 25 of its 30 iterations: 26 nodes with its folded node. L2 keeps 9 of 12,
    // 27 nodes each, within 250. L1 keeps 10 of 12, 245 nodes each, within 2500.
    expect(attrs(record, 'step:L3@L2#0/L1#0#folded')).toMatchObject({
      folded: { from: 13, to: 17, count: 5, runs: 5 },
    });
    expect(attrs(record, 'step:L2@L1#0#folded')).toMatchObject({
      folded: { from: 5, to: 7, count: 3, runs: 3 * 30 },
    });
    expect(attrs(record, 'step:L1#folded')).toMatchObject({
      folded: { from: 5, to: 6, count: 2, runs: 2 * 12 * 30 },
    });
    // Folded by L2, folded by L1, and inside both.
    expect(has(record, 'step:L3@L2#5/L1#0#folded')).toBe(false);
    expect(has(record, 'step:L2@L1#5#folded')).toBe(false);
    expect(has(record, 'step:L3@L2#0/L1#5#folded')).toBe(false);
    expect(has(record, 'step:L3@L2#5/L1#5#folded')).toBe(false);
    // Each child is counted once.
    expect(countedRuns(record)).toBe(children.length);
    expectConnected(record);
  });

  test('body steps from before the kernel kept facts are counted, and their loop is partial', () => {
    const loop = loopOf('L', tool('x'));
    const f = flowOf([loop], [edge('e1', '$start', 'L')]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'L');
    for (let i = 0; i < 3; i += 1) {
      j.add('iteration.started', 'L');
      j.step('x');
      j.add('iteration.completed', 'L');
    }
    j.add('step.completed', 'L');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(ids(record)).toEqual(['input', 'step:L', 'step:L#folded']);
    expect(attrs(record, 'step:L')).toMatchObject({ partial: true });
    expect(attrs(record, 'step:L')).not.toHaveProperty('iterations');
    expect(attrs(record, 'step:L#folded')).toEqual({
      nodeId: 'L',
      folded: { count: 0, byStatus: {}, runs: 0, unplaced: 3 },
    });
  });

  test('two body steps waiting at once, resumed in reverse order: each wait on its own step', () => {
    const loop = loopOf('L', tool('x'));
    const f = flowOf([loop], [edge('e1', '$start', 'L')]);
    const x0 = inBody('x', [{ loopNodeId: 'L', iteration: 0 }]);
    const x1 = inBody('x', [{ loopNodeId: 'L', iteration: 1 }]);
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'L');
    for (const x of [x0, x1]) {
      j.iteration('started', 'L', { scope: 'L', iteration: x.iteration });
      j.add('step.started', 'x', x);
    }
    // Each suspension's two copies: the body node's, then the outer loop's.
    // The outer copies of both waits share one node id; only the scope tells them apart.
    const [waited0, waited1] = [x0, x1].map((x) => {
      const first = j.add('wait.suspended', 'x', { scope: x.scope });
      j.add('wait.suspended', 'L', { scope: x.scope });
      return first;
    });
    const resumed1 = j.add('wait.resumed', 'L', { scope: x1.scope });
    const resumed0 = j.add('wait.resumed', 'L', { scope: x0.scope });
    for (const x of [x1, x0]) {
      j.add('step.completed', 'x', x);
      j.iteration('completed', 'L', { scope: 'L', iteration: x.iteration });
    }
    j.add('step.completed', 'L');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(ids(record).filter((id) => /^(wait|resume):/.test(id))).toEqual([
      `wait:${waited0}`,
      `wait:${waited1}`,
      `resume:${resumed1}`,
      `resume:${resumed0}`,
    ]);
    const edges = edgeSet(record.edges);
    expect(edges).toContain(`step:x@L#0 -waited-on-> wait:${waited0}`);
    expect(edges).toContain(`wait:${waited0} -resumed-from-> resume:${resumed0}`);
    expect(edges).toContain(`step:x@L#1 -waited-on-> wait:${waited1}`);
    expect(edges).toContain(`wait:${waited1} -resumed-from-> resume:${resumed1}`);
    expect(attrs(record, 'step:L')).not.toHaveProperty('partial');
  });

  test('a waitpoint from before waits kept their scope, under a loop: not drawn, and the loop is partial', () => {
    const loop = loopOf('L', tool('x'));
    const f = flowOf([loop], [edge('e1', '$start', 'L')]);
    const x0 = inBody('x', [{ loopNodeId: 'L', iteration: 0 }]);
    const j = new Journal();
    j.edge('e1');
    // Before the upgrade: no facts.
    j.add('step.started', 'L');
    j.add('iteration.started', 'L');
    j.add('step.started', 'x');
    j.add('wait.suspended', 'x');
    j.add('wait.suspended', 'L');
    // After it: the waitpoint's row has no scope, so neither has its resume.
    j.add('wait.resumed', 'L', {});
    j.iteration('started', 'L', { scope: 'L', iteration: 0 });
    j.add('step.started', 'x', x0);
    j.add('step.completed', 'x', x0);
    j.iteration('completed', 'L', { scope: 'L', iteration: 0, stopReason: 'items-done' });
    j.add('step.completed', 'L');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    // In journal order: the folded node holds the step started before the upgrade.
    expect(ids(record)).toEqual(['input', 'step:L', 'step:L#folded', 'step:x@L#0']);
    expect(attrs(record, 'step:L')).toMatchObject({ partial: true });
    expect(attrs(record, 'step:x@L#0')).toMatchObject({ status: 'completed', iteration: 0 });
    expect(attrs(record, 'step:L#folded')).toMatchObject({ folded: { unplaced: 1 } });
  });

  test("a nested loop's iteration with no scope can't be placed: its top loop is partial", () => {
    const inner = loopOf('I', tool('z'));
    const outer = loopOf('O', inner);
    const f = flowOf([outer], [edge('e1', '$start', 'O')]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, outer, undefined, [], 1, (path) => {
      const place = inBody('I', path);
      j.add('step.started', 'I', place);
      // The plain loop id names no single execution of a nested loop.
      j.iteration('started', 'I', { iteration: 0 });
      j.step('z', inBody('z', [{ loopNodeId: 'I', iteration: 0 }, ...path]));
      j.iteration('completed', 'I', { scope: place.scope, iteration: 0 });
      j.add('step.completed', 'I', place);
    });
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(has(record, 'step:z@I#0/O#0')).toBe(true);
    expect(attrs(record, 'step:O')).toMatchObject({ partial: true });
  });

  test('across the upgrade, a body step of a nested loop whose own start had no facts is counted', () => {
    const inner = loopOf('I', tool('z'));
    const outer = loopOf('O', inner);
    const f = flowOf([outer], [edge('e1', '$start', 'O')]);
    const ownPlace = inBody('I', [{ loopNodeId: 'O', iteration: 0 }]);
    const z = inBody('z', [
      { loopNodeId: 'I', iteration: 0 },
      { loopNodeId: 'O', iteration: 0 },
    ]);
    const j = new Journal();
    j.edge('e1');
    // Before the upgrade: no facts.
    j.add('step.started', 'O');
    j.add('iteration.started', 'O');
    j.add('step.started', 'I');
    // After it: z names its loop execution, whose own step was never placed.
    j.iteration('started', 'I', { scope: ownPlace.scope, iteration: 0 });
    j.step('z', z);
    j.iteration('completed', 'I', {
      scope: ownPlace.scope,
      iteration: 0,
      stopReason: 'items-done',
    });
    j.add('step.completed', 'I', ownPlace);
    j.iteration('completed', 'O', { scope: 'O', iteration: 0, stopReason: 'items-done' });
    j.add('step.completed', 'O');
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    expect(has(record, `step:${z.scope}`)).toBe(false);
    expect(attrs(record, 'step:O')).toMatchObject({ partial: true });
    // I's start from before the upgrade, and z's after it.
    expect(attrs(record, 'step:O#folded')).toMatchObject({ folded: { unplaced: 2 } });
  });
});

describe('fanouts', () => {
  const fanout: FanoutNode = {
    id: 'F' as NodeId,
    kind: 'fanout',
    branches: [
      { branchId: 'b1', handler: 'acme.a', outputSchema: {} },
      { branchId: 'b2', handler: 'acme.b', outputSchema: {} },
    ],
    convergence: 'settle-all',
  };
  const flow = flowOf([fanout], [edge('e1', '$start', 'F')], {
    pins: { tools: { 'acme.a': '2.0.0' }, agents: {} },
  });

  test('each branch is a step its fanout invoked', () => {
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'F');
    j.add('fanout.dispatched', 'F', { fanoutNodeId: 'F', branchId: 'b1' });
    j.add('fanout.dispatched', 'F', { fanoutNodeId: 'F', branchId: 'b2' });
    j.add('fanout.branch-completed', 'F', { fanoutNodeId: 'F', branchId: 'b1' });
    j.add('fanout.branch-failed', 'F', {
      fanoutNodeId: 'F',
      branchId: 'b2',
      reason: 'handler-throw',
    });
    j.add('fanout.converged', 'F');
    j.add('step.completed', 'F');
    const record = build(runOf(flow, { hasOutput: false }), j.entries);

    expect(ids(record)).toEqual(['input', 'step:F', 'step:F/b1', 'step:F/b2']);
    expect(attrs(record, 'step:F')).toMatchObject({
      nodeKind: 'fanout',
      status: 'completed',
      iterations: { count: 2 },
    });
    expect(attrs(record, 'step:F/b1')).toMatchObject({
      nodeId: 'F',
      nodeKind: 'tool',
      ref: { id: 'acme.a', version: '2.0.0' },
      branch: 0,
      status: 'completed',
    });
    expect(attrs(record, 'step:F/b2')).toMatchObject({
      ref: { id: 'acme.b' },
      branch: 1,
      status: 'failed',
      failure: { reason: 'handler-throw' },
    });
    expect(edgeSet(record.edges)).toEqual([
      'step:F -caused-by-> input',
      'step:F/b1 -invoked-> step:F',
      'step:F/b2 -invoked-> step:F',
    ]);
  });

  test('cancelled siblings say why; a branch entry with no branch makes the fanout partial', () => {
    const j = new Journal();
    j.edge('e1');
    j.add('step.started', 'F');
    j.add('fanout.dispatched', 'F', { fanoutNodeId: 'F', branchId: 'b1' });
    j.add('fanout.dispatched', 'F');
    j.add('fanout.branch-failed', 'F', {
      fanoutNodeId: 'F',
      branchId: 'b1',
      reason: 'handler-throw',
    });
    j.add('fanout.cancelled-siblings', 'F', { reason: 'first-failure' });
    j.add('step.failed', 'F');
    const record = build(runOf(flow, { status: 'failed' }), j.entries);
    expect(attrs(record, 'step:F')).toMatchObject({
      status: 'failed',
      iterations: { count: 1, stopReason: 'first-failure' },
      partial: true,
    });
  });
});

describe('ids', () => {
  test('two scopes that share their first 256 characters get two digest ids', () => {
    const head = 'a'.repeat(256);
    const f = flowOf(
      [tool(`${head}1`, 'acme.one'), tool(`${head}2`, 'acme.two')],
      [edge('e1', '$start', `${head}1`), edge('e2', `${head}1`, `${head}2`)],
    );
    const j = new Journal();
    j.edge('e1');
    j.step(`${head}1`);
    j.edge('e2');
    j.step(`${head}2`);
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    const one = digestId(`step:${head}1`);
    const two = digestId(`step:${head}2`);
    expect(ids(record)).toEqual(['input', one, two]);
    expect(attrs(record, one)).toMatchObject({
      idHead: `step:${head}`.slice(0, 256),
      ref: { id: 'acme.one' },
      truncated: { reason: 'ids', idsOmitted: 1 },
    });
    expect(attrs(record, one)).not.toHaveProperty('nodeId');
    expect(edgeSet(record.edges)).toEqual([
      `${one} -caused-by-> input`,
      `${two} -caused-by-> ${one}`,
    ]);
  });

  test('a node named like a digest id takes the digest form too', () => {
    const name = `~${'0123456789abcdef'.repeat(2)}`;
    const f = flowOf([tool(name, 'acme.t')], [edge('e1', '$start', name)]);
    const j = new Journal();
    j.edge('e1');
    j.step(name);
    const record = build(runOf(f, { hasOutput: false }), j.entries);
    const id = digestId(`step:${name}`);
    expect(ids(record)).toEqual(['input', id]);
    expect(attrs(record, id)).toMatchObject({ nodeId: name, idHead: `step:${name}` });
  });

  test("a long loop's step and its folded node get two distinct digest ids", () => {
    const loopId = 'L'.repeat(300);
    const loop = loopOf(loopId, tool('x'));
    const f = flowOf([loop], [edge('e1', '$start', loopId)]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, loop, undefined, [], 60, oneStepBody(j, loop, 'x'));
    const record = build(runOf(f, { hasOutput: false }), j.entries);

    const step = digestId(`step:${loopId}`);
    const folded = digestId(`step:${loopId}#folded`);
    expect(step).not.toBe(folded);
    expect(attrs(record, step)).toMatchObject({ nodeKind: 'loop', iterations: { count: 60 } });
    expect(attrs(record, folded)).toMatchObject({
      idHead: `step:${loopId}`.slice(0, 256),
      folded: { from: 25, to: 34, count: 10 },
      truncated: { reason: 'ids', idsOmitted: 1 },
    });
    expect(edgeSet(record.edges)).toContain(`${folded} -invoked-> ${step}`);
  });

  test('a child run, a reused source or an edge id over 256 characters is dropped and counted', () => {
    const f = flowOf([tool('a')], [edge('e1', '$start', 'a')]);
    const j = new Journal();
    j.edge('e1');
    j.step('a');
    const long = 'r'.repeat(257);
    const record = build(
      runOf(f, {
        hasOutput: false,
        children: [
          {
            runId: long as RunId,
            flowId: 'acme.sub',
            status: 'completed',
            parentNodeId: 'a',
            parentScope: '',
          },
          {
            runId: 'r-2' as RunId,
            flowId: 'acme.sub',
            status: 'completed',
            parentNodeId: 'a',
            parentScope: '',
          },
        ],
        reused: [
          { scope: 'a', runId: long as RunId },
          { scope: 'a', runId: 'r-0' as RunId, nodeId: 'step:fetch' },
        ],
      }),
      j.entries,
    );
    expect(attrs(record, 'step:a')).toMatchObject({
      runs: [{ runId: 'r-2' }],
      reusedFrom: [{ runId: 'r-0', nodeId: 'step:fetch' }],
      truncated: { reason: 'ids', idsOmitted: 2 },
    });
  });
});

describe('child runs and reused results', () => {
  test("a child run in a loop body finds its step by the run row's scope, as bodyStepKey keys it", () => {
    const w = agent('w', 'acme.writer');
    const l2 = loopOf('L2', w);
    const l1 = loopOf('L1', l2);
    const f = flowOf([l1], [edge('e1', '$start', 'L1')]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, l1, undefined, [], 1, (p1) => {
      runLoop(j, l2, inBody('L2', p1), p1, 2, oneStepBody(j, l2, 'w'));
    });
    const path = [
      { loopNodeId: 'L2', iteration: 1 },
      { loopNodeId: 'L1', iteration: 0 },
    ];
    const child = (runId: string, parentScope: string): FlowProvenanceChild => ({
      runId: runId as RunId,
      flowId: 'acme.writer',
      status: 'completed',
      parentNodeId: 'w',
      parentScope,
    });
    const record = build(
      runOf(f, {
        hasOutput: false,
        children: [child('turn-1', JSON.stringify(path)), child('turn-2', '{not json')],
      }),
      j.entries,
    );
    const scope = bodyStepKey('w' as NodeId, contextOf(path));
    expect(scope).toBe('w@L2#1/L1#0');
    expect(attrs(record, `step:${scope}`)).toMatchObject({
      runs: [{ runId: 'turn-1', flowId: 'acme.writer', status: 'completed' }],
    });
    // A scope it can't read finds no step: the child is left out, never misplaced.
    expect(JSON.stringify(record)).not.toContain('turn-2');
  });

  test('a step lists each source it reused once; a folded node lists its iterations’ union', () => {
    const loop = loopOf('L', tool('x'));
    const f = flowOf([tool('a'), loop], [edge('e1', '$start', 'a'), edge('e2', 'a', 'L')]);
    const j = new Journal();
    j.edge('e1');
    j.step('a');
    j.edge('e2');
    runLoop(j, loop, undefined, [], 60, oneStepBody(j, loop, 'x'));
    const source = (scope: string, runId: string): FlowReusedSource => ({
      scope,
      runId: runId as RunId,
    });
    const record = build(
      runOf(f, {
        hasOutput: false,
        reused: [
          source('a', 'r-1'),
          source('a', 'r-1'),
          { scope: 'a', provenanceId: 'b5a3f7c2-0a51-4c55-9e8f-3d3a3f3c1e02' as ProvenanceId },
          // Folded iterations 25..34: two of them name r-2, one names r-3.
          source('x@L#25', 'r-2'),
          source('x@L#30', 'r-2'),
          source('x@L#34', 'r-3'),
          source('x@L#59', 'r-4'),
          // A step the record doesn't have.
          source('nowhere', 'r-5'),
        ],
      }),
      j.entries,
    );
    expect(attrs(record, 'step:a').reusedFrom).toEqual([
      { runId: 'r-1' },
      { provenanceId: 'b5a3f7c2-0a51-4c55-9e8f-3d3a3f3c1e02' },
    ]);
    expect(attrs(record, 'step:L#folded').reusedFrom).toEqual([{ runId: 'r-2' }, { runId: 'r-3' }]);
    expect(attrs(record, 'step:x@L#59').reusedFrom).toEqual([{ runId: 'r-4' }]);
    expect(JSON.stringify(record)).not.toContain('r-5');
  });
});

describe('the caps', () => {
  /** `n` steps of a chain, each with child runs filling ~15 KiB of its attributes. */
  function heavy(n: number, version: string): Provenance {
    const f = chainFlow(n + 1, { version });
    const j = new Journal();
    j.add('run.started');
    const children: FlowProvenanceChild[] = [];
    for (let i = 0; i < n; i += 1) {
      j.edge(`e${i}`);
      j.step(`s${i}`);
      for (let c = 0; c < 50; c += 1) {
        children.push({
          runId: `${'r'.repeat(190)}-${i}-${c}` as RunId,
          flowId: 'acme.sub',
          status: 'completed',
          parentNodeId: `s${i}`,
          parentScope: '',
          provenanceId: 'b5a3f7c2-0a51-4c55-9e8f-3d3a3f3c1e03' as ProvenanceId,
        });
      }
    }
    return build(runOf(f, { hasOutput: false, children }), j.entries);
  }

  test('a record at exactly 4 MiB of canonical bytes is whole; one more step cuts it (bytes)', () => {
    const probe = heavy(200, '1.0.0');
    const perStep = signingBytes(heavy(201, '1.0.0')).length - signingBytes(probe).length;
    const n = 200 + Math.floor((L.maxRecordBytes - signingBytes(probe).length) / perStep);
    const short = signingBytes(heavy(n, '1.0.0')).length;
    expect(short).toBeLessThanOrEqual(L.maxRecordBytes);
    // The flow's version is in the header once: pad it to the last byte.
    const version = `1.0.0-${'x'.repeat(L.maxRecordBytes - short - 1)}`;

    const whole = heavy(n, version);
    expect(signingBytes(whole).length).toBe(L.maxRecordBytes);
    expect(has(whole, 'truncated')).toBe(false);
    expect(whole.nodes.filter((x) => x.kind === 'step')).toHaveLength(n);

    const cut = heavy(n + 1, version);
    expect(signingBytes(cut).length).toBeLessThanOrEqual(L.maxRecordBytes);
    const truncated = attrs(cut, 'truncated').truncated as Record<string, unknown>;
    expect(truncated).toMatchObject({ reason: 'bytes', omittedSteps: expect.any(Number) });
    expect(truncated.omittedSteps as number).toBeGreaterThan(0);
    expect(has(cut, 'input')).toBe(true);
    expect(has(cut, 'step:s0')).toBe(true);
    expect(has(cut, `step:s${n}`)).toBe(true);
  });

  /** One step with `count` child runs, the last one's id `extra` characters longer. */
  function oneStep(count: number, extra: number): Provenance {
    const f = flowOf([tool('a')], [edge('e1', '$start', 'a')]);
    const j = new Journal();
    j.edge('e1');
    j.step('a');
    const children = Array.from({ length: count }, (_, c) => ({
      runId:
        `${'r'.repeat(40)}-${String(c).padStart(4, '0')}${c === count - 1 ? 'x'.repeat(extra) : ''}` as RunId,
      flowId: 'acme.sub',
      status: 'completed' as const,
      parentNodeId: 'a',
      parentScope: '',
    }));
    return build(runOf(f, { hasOutput: false, children }), j.entries);
  }

  test("a step's attributes at 16 KiB are whole; one byte past, its runs are cut from the end", () => {
    const one = attributeBytes(nodeOf(oneStep(1, 0), 'step:a'));
    const perRun = attributeBytes(nodeOf(oneStep(2, 0), 'step:a')) - one;
    const count = 1 + Math.floor((L.maxNodeAttributeBytes - one) / perRun);
    const extra = L.maxNodeAttributeBytes - attributeBytes(nodeOf(oneStep(count, 0), 'step:a'));
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThan(perRun);

    const at16 = attrs(oneStep(count, extra), 'step:a');
    expect(Buffer.byteLength(canonicalize(at16), 'utf8')).toBe(L.maxNodeAttributeBytes);
    expect(at16).not.toHaveProperty('truncated');
    expect(at16.runs).toHaveLength(count);

    const past = attrs(oneStep(count, extra + 1), 'step:a');
    expect(Buffer.byteLength(canonicalize(past), 'utf8')).toBeLessThanOrEqual(
      L.maxNodeAttributeBytes,
    );
    expect(past.truncated).toEqual({ reason: 'node-bytes', runsOmitted: expect.any(Number) });
    const runs = past.runs as { runId: string }[];
    expect(runs.length + (past.truncated as { runsOmitted: number }).runsOmitted).toBe(count);
    expect(runs[0]?.runId).toBe(`${'r'.repeat(40)}-0000`);
  });

  test('past 5000 nodes the record is cut from the middle, keeping the input, both ends and the output', () => {
    const n = 5200;
    const f = chainFlow(n);
    const j = new Journal();
    j.add('run.started');
    for (let i = 0; i < n; i += 1) {
      j.edge(`e${i}`);
      j.step(`s${i}`);
    }
    j.edge('end');
    const record = build(runOf(f), j.entries);

    expect(record.nodes).toHaveLength(L.maxNodes);
    const all = ids(record);
    expect(all[0]).toBe('input');
    expect(all[all.length - 1]).toBe('output');
    // 4997 steps kept, alternating ends: s0..s2498 and s2702..s5199.
    expect(all[2500]).toBe('truncated');
    expect(all[2499]).toBe('step:s2498');
    expect(all[2501]).toBe('step:s2702');
    expect(attrs(record, 'truncated')).toEqual({
      truncated: {
        reason: 'nodes',
        omittedSteps: 203,
        fromSequence: nodeSequence(j, 's2499'),
        toSequence: nodeSequence(j, 's2701') + 1,
      },
    });
    const edges = edgeSet(record.edges);
    expect(edges).toContain('step:s2702 -caused-by-> truncated');
    expect(edges).toContain(`output -produced-> step:s${n - 1}`);
    expect(edges).toContain('step:s0 -caused-by-> input');
  });

  test('a journal read as its first and last pages: the gap has its count by kind, the loop across it is partial', () => {
    const z = tool('z');
    const innerLoop = loopOf('I', z);
    const outer = loopOf('O', innerLoop);
    const f = flowOf([outer], [edge('e1', '$start', 'O'), edge('e2', 'O', '$end')]);
    const j = new Journal();
    j.add('run.started');
    j.edge('e1');
    runLoop(j, outer, undefined, [], 25, (path, i) => {
      const place = inBody('I', path);
      j.edge('O.in', true, { loopScope: place.loopScope, iteration: i });
      runLoop(j, innerLoop, place, path, 1665, oneStepBody(j, innerLoop, 'z'));
      j.edge('O.out', true, { loopScope: place.loopScope, iteration: i });
    });
    while (j.entries.length < 250_000) j.add('clock.read');
    j.edge('e2');
    expect(j.entries).toHaveLength(250_001);

    // The first 125,000 and the last 125,000 are read.
    const fromSequence = 125_000;
    const toSequence = 125_000;
    const omittedByKind: Record<string, number> = {};
    for (const e of j.entries.slice(fromSequence, toSequence + 1)) {
      omittedByKind[e.kind] = (omittedByKind[e.kind] ?? 0) + 1;
    }
    const record = build(runOf(f), j.entries, {
      pageSize: 5000,
      gap: { fromSequence, toSequence, omittedByKind },
    });

    expect(attrs(record, 'truncated:entries')).toEqual({
      truncated: { reason: 'entries', fromSequence, toSequence, omittedByKind },
    });
    expect(attrs(record, 'step:O')).toMatchObject({ status: 'completed', partial: true });
    expect(has(record, 'step:z@I#1664/O#24')).toBe(true);
    expect(edgeSet(record.edges)).toContain('output -produced-> step:O');
  });

  test('a gap whose count by kind timed out still has its sequences, and the loop across it is partial', () => {
    const loop = loopOf('L', tool('x'));
    const f = flowOf(
      [loop, tool('b')],
      [edge('e1', '$start', 'L'), edge('e2', 'L', 'b'), edge('e3', 'b', '$end')],
    );
    const j = new Journal();
    j.edge('e1');
    runLoop(j, loop, undefined, [], 20, oneStepBody(j, loop, 'x'));
    j.edge('e2');
    j.step('b');
    j.edge('e3');
    const gap = { fromSequence: 20, toSequence: 40 };
    const record = build(runOf(f), j.entries, { pageSize: 7, gap });

    expect(attrs(record, 'truncated:entries')).toEqual({
      truncated: { reason: 'entries', fromSequence: 20, toSequence: 40 },
    });
    expect(attrs(record, 'step:L')).toMatchObject({ partial: true });
    expect(attrs(record, 'step:b')).not.toHaveProperty('partial');
    expect(edgeSet(record.edges)).toContain('output -produced-> step:b');
  });
});

describe('stepNodePlacer', () => {
  const long = `w${'x'.repeat(300)}`;
  const longLoop = `P${'p'.repeat(249)}`;
  const scopeOfPath = (path: LoopPath): string => JSON.stringify(path);

  /**
   * One record past every limit, with a child run on each agent step: ids
   * over the cap (a step's, and a loop's folded node's while the loop's own
   * fits), a scope starting `~`, a step whose runs list is cut, loops two
   * and three deep past their budgets, and past 5000 nodes, so the middle
   * is cut.
   */
  function pastEveryLimit(): { record: Provenance; children: FlowProvenanceChild[] } {
    const i = loopOf('I', agent('w', 'acme.writer'));
    const o = loopOf('O', i);
    const s = loopOf('S', agent('v', 'acme.writer'));
    const r = loopOf('R', s);
    const q = loopOf('Q', r);
    const p = loopOf(longLoop, agent('x', 'acme.writer'));
    const f = flowOf(
      [agent('~a', 'acme.writer'), agent(long, 'acme.writer'), agent('m', 'acme.writer'), o, q, p],
      [
        edge('e0', '$start', '~a'),
        edge('e1', '~a', long),
        edge('e2', long, 'm'),
        edge('e3', 'm', 'O'),
        edge('e4', 'O', 'Q'),
        edge('e5', 'Q', longLoop),
      ],
    );
    const j = new Journal();
    const children: FlowProvenanceChild[] = [];
    const child = (parentNodeId: string, path: LoopPath = []): void => {
      children.push({
        runId: `turn-${children.length}` as RunId,
        flowId: 'acme.writer',
        status: 'completed',
        parentNodeId,
        parentScope: path.length === 0 ? '' : scopeOfPath(path),
      });
    };
    const agentBody = (loop: LoopNode, inner: string) => {
      const body = oneStepBody(j, loop, inner);
      return (path: LoopPath, n: number): void => {
        body(path, n);
        child(inner, path);
      };
    };
    j.edge('e0');
    j.step('~a');
    child('~a');
    j.edge('e1');
    j.step(long);
    child(long);
    j.edge('e2');
    j.step('m');
    for (let n = 0; n < 400; n += 1) child('m');
    j.edge('e3');
    runLoop(j, o, undefined, [], 60, (p1) => {
      runLoop(j, i, inBody('I', p1), p1, 60, agentBody(i, 'w'));
    });
    j.edge('e4');
    runLoop(j, q, undefined, [], 12, (p1) => {
      runLoop(j, r, inBody('R', p1), p1, 12, (p2) => {
        runLoop(j, s, inBody('S', p2), p2, 30, agentBody(s, 'v'));
      });
    });
    j.edge('e5');
    runLoop(j, p, undefined, [], 60, agentBody(p, 'x'));
    // Children the record has no step for: a scope that doesn't parse, a step that didn't run.
    children.push({
      ...(children[0] as FlowProvenanceChild),
      runId: 'turn-x' as RunId,
      parentNodeId: 'w',
      parentScope: '{not json',
    });
    children.push({
      ...(children[0] as FlowProvenanceChild),
      runId: 'turn-y' as RunId,
      parentNodeId: 'nowhere',
      parentScope: '',
    });
    return { record: build(runOf(f, { hasOutput: false, children }), j.entries), children };
  }

  test('places each child run on the node that counts it, past every limit', () => {
    const { record, children } = pastEveryLimit();
    // The fixture reaches each limit.
    expect(attrs(record, 'truncated')).toMatchObject({ truncated: { reason: 'nodes' } });
    expect(has(record, digestId('step:~a'))).toBe(true);
    expect(has(record, digestId(`step:${long}`))).toBe(true);
    expect(attrs(record, 'step:m')).toMatchObject({ truncated: { reason: 'node-bytes' } });
    expect(has(record, `step:${longLoop}`)).toBe(true);
    expect(has(record, digestId(`step:${longLoop}#folded`))).toBe(true);
    expect(has(record, 'step:O#folded')).toBe(true);
    expect(has(record, 'step:S@R#11/Q#11#folded')).toBe(true);

    const place = stepNodePlacer(record.nodes);
    const at = (parentNodeId: string, path: LoopPath): string | undefined =>
      place({ parentNodeId, parentScope: scopeOfPath(path) });
    // Kept, folded by its own loop, folded by an outer loop, and digested.
    expect(
      at('w', [
        { loopNodeId: 'I', iteration: 0 },
        { loopNodeId: 'O', iteration: 0 },
      ]),
    ).toBe('step:w@I#0/O#0');
    expect(
      at('w', [
        { loopNodeId: 'I', iteration: 30 },
        { loopNodeId: 'O', iteration: 0 },
      ]),
    ).toBe('step:I@O#0#folded');
    expect(
      at('w', [
        { loopNodeId: 'I', iteration: 0 },
        { loopNodeId: 'O', iteration: 30 },
      ]),
    ).toBe('step:O#folded');
    expect(at('x', [{ loopNodeId: longLoop, iteration: 30 }])).toBe(
      digestId(`step:${longLoop}#folded`),
    );
    expect(place({ parentNodeId: '~a', parentScope: '' })).toBe(digestId('step:~a'));

    // Every node gets exactly the children it counts; the rest are left out.
    const placed = new Map<string, number>();
    let leftOut = 0;
    for (const c of children) {
      const id = place(c);
      if (id === undefined) leftOut += 1;
      else placed.set(id, (placed.get(id) ?? 0) + 1);
    }
    for (const node of record.nodes) {
      expect(placed.get(node.id) ?? 0, node.id).toBe(runsCountedBy(node));
    }
    // The two with no step, and the children of steps cut with the middle.
    expect(leftOut).toBe(children.length - countedRuns(record));
    expect(leftOut).toBeGreaterThan(2);
  });

  test('a child whose step has no node in the record is left out', () => {
    const f = flowOf([agent('a', 'acme.writer')], [edge('e1', '$start', 'a')]);
    const j = new Journal();
    j.edge('e1');
    j.step('a');
    const record = build(runOf(f, { hasOutput: false }), j.entries);
    const place = stepNodePlacer(record.nodes);

    expect(place({ parentNodeId: 'a', parentScope: '' })).toBe('step:a');
    expect(place({ parentNodeId: 'b', parentScope: '' })).toBeUndefined();
    expect(
      place({ parentNodeId: 'a', parentScope: scopeOfPath([{ loopNodeId: 'L', iteration: 0 }]) }),
    ).toBeUndefined();
  });
});

describe('the builder', () => {
  const f = flowOf([tool('a')], [edge('e1', '$start', 'a')]);

  test('takes entries in sequence order only, and one gap', () => {
    const j = new Journal();
    j.edge('e1');
    j.step('a');
    const b = flowProvenanceBuilder(runOf(f));
    b.add(j.entries);
    expect(() => b.add(j.entries.slice(0, 1))).toThrow(/sequence order/);
    b.skip({ fromSequence: 10, toSequence: 11 });
    expect(() => b.skip({ fromSequence: 12, toSequence: 13 })).toThrow(/only one gap/);
  });

  test('the same journal in pages of any size gives the same record', () => {
    const loop = loopOf('L', tool('x'));
    const lf = flowOf([loop], [edge('e1', '$start', 'L'), edge('e2', 'L', '$end')]);
    const j = new Journal();
    j.edge('e1');
    runLoop(j, loop, undefined, [], 40, oneStepBody(j, loop, 'x'));
    j.edge('e2');
    const whole = build(runOf(lf), j.entries, { pageSize: j.entries.length });
    for (const pageSize of [1, 3, 50]) {
      expect(build(runOf(lf), j.entries, { pageSize })).toEqual(whole);
    }
  });
});

/** The sequence of a chain step's `step.started`. */
function nodeSequence(j: Journal, nodeId: string): number {
  const e = j.entries.find((x) => x.kind === 'step.started' && x.nodeId === nodeId);
  if (e === undefined) throw new Error(`no step.started for ${nodeId}`);
  return e.sequence;
}
