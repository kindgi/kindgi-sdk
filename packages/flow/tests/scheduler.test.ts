// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { EdgeId, FlowId, NodeId } from '@kindgi/types';

import { type SchedulerState, loadFlow, schedulerTick } from '../src/index.js';
import type { Flow } from '../src/index.js';

function mustLoad(input: unknown): Flow {
  const r = loadFlow(input);
  if (r.kind === 'err') throw new Error(`test fixture invalid: ${r.error.message}`);
  return r.value;
}

function s(over: Partial<SchedulerState> = {}): SchedulerState {
  return {
    completedNodes: new Set(),
    inFlightNodes: new Set(),
    edgeDecisions: new Map(),
    env: {},
    ...over,
  };
}

function nodeSet(...ids: string[]): ReadonlySet<NodeId> {
  return new Set(ids as NodeId[]);
}

function edgeMap(pairs: [string, boolean][]): ReadonlyMap<EdgeId, boolean> {
  return new Map(pairs.map(([k, v]) => [k as EdgeId, v]));
}

const linear = mustLoad({
  id: 'linear' as FlowId,
  version: '1.0.0',
  nodes: [
    { id: 'a', kind: 'tool', ref: 'x' },
    { id: 'b', kind: 'tool', ref: 'x' },
  ],
  edges: [
    { id: 'e0', from: '$start', to: 'a' },
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: '$end' },
  ],
});

const diamond = mustLoad({
  id: 'diamond' as FlowId,
  version: '1.0.0',
  nodes: [
    { id: 'a', kind: 'tool', ref: 'x' },
    { id: 'b', kind: 'tool', ref: 'x' },
    { id: 'c', kind: 'tool', ref: 'x' },
    { id: 'd', kind: 'tool', ref: 'x' },
  ],
  edges: [
    { id: 'e0', from: '$start', to: 'a' },
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'c' },
    { id: 'e3', from: 'b', to: 'd' },
    { id: 'e4', from: 'c', to: 'd' },
    { id: 'e5', from: 'd', to: '$end' },
  ],
});

const conditional = mustLoad({
  id: 'branchy' as FlowId,
  version: '1.0.0',
  nodes: [
    { id: 'route', kind: 'tool', ref: 'x' },
    { id: 'admin', kind: 'tool', ref: 'x' },
    { id: 'guest', kind: 'tool', ref: 'x' },
  ],
  edges: [
    { id: 'e0', from: '$start', to: 'route' },
    {
      id: 'e1',
      from: 'route',
      to: 'admin',
      when: {
        op: 'eq',
        left: { path: 'nodeOutputs.route.role' },
        right: { literal: 'admin' },
      },
    },
    {
      id: 'e2',
      from: 'route',
      to: 'guest',
      when: {
        op: 'eq',
        left: { path: 'nodeOutputs.route.role' },
        right: { literal: 'guest' },
      },
    },
    { id: 'e3', from: 'admin', to: '$end' },
    { id: 'e4', from: 'guest', to: '$end' },
  ],
});

describe('schedulerTick — linear', () => {
  test('empty state → dispatch a, request evaluation of e0', () => {
    const out = schedulerTick(linear, s());
    expect(out.edgeEvals.map((e) => e.edgeId)).toEqual(['e0']);
    expect(out.ready).toEqual(['a']);
    expect(out.done).toBe(false);
  });
  test('after a completes → dispatch b, evaluate e1', () => {
    const out = schedulerTick(
      linear,
      s({ completedNodes: nodeSet('a'), edgeDecisions: edgeMap([['e0', true]]) }),
    );
    expect(out.edgeEvals.map((e) => e.edgeId)).toEqual(['e1']);
    expect(out.ready).toEqual(['b']);
  });
  test('after b completes → done', () => {
    const out = schedulerTick(
      linear,
      s({
        completedNodes: nodeSet('a', 'b'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(out.ready).toEqual([]);
    expect(out.done).toBe(true);
  });
});

describe('schedulerTick — diamond fan-out and fan-in', () => {
  test('after a completes → b and c both ready this tick', () => {
    const out = schedulerTick(
      diamond,
      s({ completedNodes: nodeSet('a'), edgeDecisions: edgeMap([['e0', true]]) }),
    );
    expect(new Set(out.ready)).toEqual(new Set(['b', 'c']));
    expect(new Set(out.edgeEvals.map((e) => e.edgeId))).toEqual(new Set(['e1', 'e2']));
  });

  test('b completed but c still in-flight → d NOT ready', () => {
    const out = schedulerTick(
      diamond,
      s({
        completedNodes: nodeSet('a', 'b'),
        inFlightNodes: nodeSet('c'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(out.ready).toEqual([]);
    expect(out.done).toBe(false);
  });

  test('both b and c done → d ready, e3 and e4 evaluated', () => {
    const out = schedulerTick(
      diamond,
      s({
        completedNodes: nodeSet('a', 'b', 'c'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(out.ready).toEqual(['d']);
    expect(new Set(out.edgeEvals.map((e) => e.edgeId))).toEqual(new Set(['e3', 'e4']));
  });

  test('in-flight node is not re-ready', () => {
    const out = schedulerTick(
      diamond,
      s({
        completedNodes: nodeSet('a'),
        inFlightNodes: nodeSet('b'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
        ]),
      }),
    );
    // b is in-flight so not re-listed. c is ready.
    expect(out.ready).toEqual(['c']);
  });
});

describe('schedulerTick — conditional edges', () => {
  test('predicate matches admin → only admin branch fires', () => {
    const out = schedulerTick(
      conditional,
      s({
        completedNodes: nodeSet('route'),
        edgeDecisions: edgeMap([['e0', true]]),
        env: {
          nodeOutputs: new Map<NodeId, unknown>([['route' as NodeId, { role: 'admin' }]]),
        },
      }),
    );
    // Both e1 and e2 get evaluated; only e1 is taken; only admin becomes ready.
    expect(new Set(out.edgeEvals.map((e) => e.edgeId))).toEqual(new Set(['e1', 'e2']));
    const decisions = new Map(out.edgeEvals.map((e) => [e.edgeId, e.decision]));
    expect(decisions.get('e1' as EdgeId)).toBe(true);
    expect(decisions.get('e2' as EdgeId)).toBe(false);
    expect(out.ready).toEqual(['admin']);
  });

  test('predicate matches guest → only guest branch fires', () => {
    const out = schedulerTick(
      conditional,
      s({
        completedNodes: nodeSet('route'),
        edgeDecisions: edgeMap([['e0', true]]),
        env: {
          nodeOutputs: new Map<NodeId, unknown>([['route' as NodeId, { role: 'guest' }]]),
        },
      }),
    );
    expect(out.ready).toEqual(['guest']);
  });

  test('all incoming edges evaluated FALSE → node not ready (never runs)', () => {
    const out = schedulerTick(
      conditional,
      s({
        completedNodes: nodeSet('route'),
        edgeDecisions: edgeMap([['e0', true]]),
        env: {
          nodeOutputs: new Map<NodeId, unknown>([['route' as NodeId, { role: 'other' }]]),
        },
      }),
    );
    expect(out.ready).toEqual([]);
  });
});

describe('schedulerTick — priority-ordered dispatch', () => {
  // Two parallel branches: $start → a, $start → b, both terminate at $end
  // via distinct edges. Each incoming edge from $start carries a
  // distinct priority; both a and b are sole-incoming so priority
  // applies. This is the fixture used across the priority tests below.
  function twoBranchWithPriority(
    aPriority: number | undefined,
    bPriority: number | undefined,
  ): Flow {
    return mustLoad({
      id: 'prio.2b' as FlowId,
      version: '1.0.0',
      nodes: [
        { id: 'a', kind: 'tool', ref: 'x' },
        { id: 'b', kind: 'tool', ref: 'x' },
      ],
      edges: [
        {
          id: 'e-sa',
          from: '$start',
          to: 'a',
          ...(aPriority !== undefined && { policy: { priority: aPriority } }),
        },
        {
          id: 'e-sb',
          from: '$start',
          to: 'b',
          ...(bPriority !== undefined && { policy: { priority: bPriority } }),
        },
        { id: 'e-ae', from: 'a', to: '$end' },
        { id: 'e-be', from: 'b', to: '$end' },
      ],
    });
  }

  test('higher priority dispatches first when the ready set has two nodes', () => {
    const g = twoBranchWithPriority(50, 10);
    const out = schedulerTick(g, s());
    expect(out.ready).toEqual(['a', 'b']);
  });

  test('higher priority (b > a) reverses the natural lex order', () => {
    const g = twoBranchWithPriority(10, 50);
    const out = schedulerTick(g, s());
    // b's priority (50) beats a's (10) → b first even though a < b lexically.
    expect(out.ready).toEqual(['b', 'a']);
  });

  test('same priority → nodes dispatch in lexical id order (deterministic tiebreak)', () => {
    const g = twoBranchWithPriority(10, 10);
    const out = schedulerTick(g, s());
    expect(out.ready).toEqual(['a', 'b']);
  });

  test('three-way tie → all three fire in lexical order', () => {
    const g = mustLoad({
      id: 'prio.3tie' as FlowId,
      version: '1.0.0',
      nodes: [
        { id: 'zeta', kind: 'tool', ref: 'x' },
        { id: 'alpha', kind: 'tool', ref: 'x' },
        { id: 'mid', kind: 'tool', ref: 'x' },
      ],
      edges: [
        { id: 'e-sa', from: '$start', to: 'zeta', policy: { priority: 25 } },
        { id: 'e-sb', from: '$start', to: 'alpha', policy: { priority: 25 } },
        { id: 'e-sc', from: '$start', to: 'mid', policy: { priority: 25 } },
        { id: 'e-ze', from: 'zeta', to: '$end' },
        { id: 'e-ae', from: 'alpha', to: '$end' },
        { id: 'e-me', from: 'mid', to: '$end' },
      ],
    });
    const out = schedulerTick(g, s());
    expect(out.ready).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('extreme boundary values (-100 vs 100) order correctly', () => {
    const g = twoBranchWithPriority(-100, 100);
    const out = schedulerTick(g, s());
    expect(out.ready).toEqual(['b', 'a']);
  });

  test('undeclared priority defaults to 0 — declared 0 ties with default', () => {
    const g = twoBranchWithPriority(0, undefined);
    const out = schedulerTick(g, s());
    // Same effective priority (0 vs default 0) → lex order.
    expect(out.ready).toEqual(['a', 'b']);
  });

  test('positive priority beats default-0 sibling regardless of lex order', () => {
    const g = twoBranchWithPriority(undefined, 5);
    const out = schedulerTick(g, s());
    // b (priority 5) beats a (default 0) even though a < b lexically.
    expect(out.ready).toEqual(['b', 'a']);
  });

  test('negative priority loses to default-0 sibling', () => {
    const g = twoBranchWithPriority(undefined, -10);
    const out = schedulerTick(g, s());
    // a (default 0) beats b (-10).
    expect(out.ready).toEqual(['a', 'b']);
  });

  test('fan-in node inherits default 0 — declared priority on ONE incoming edge is ignored', () => {
    // Diamond: $start → a, $start → b, a → d, b → d, d → $end.
    // The a → d edge declares priority 99; but d has 2 incoming edges
    // (fan-in), so priority does NOT apply to d. Test: on the tick
    // where both a and b are done, d becomes ready and sits at the
    // default priority — this test just asserts loader-accept + no
    // crash + d appears eventually. (Fan-in single-node ready set has
    // trivial ordering; nothing else to compare against.)
    const g = mustLoad({
      id: 'prio.fanin' as FlowId,
      version: '1.0.0',
      nodes: [
        { id: 'a', kind: 'tool', ref: 'x' },
        { id: 'b', kind: 'tool', ref: 'x' },
        { id: 'd', kind: 'tool', ref: 'x' },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'a' },
        { id: 'e0b', from: '$start', to: 'b' },
        { id: 'e1', from: 'a', to: 'd', policy: { priority: 99 } },
        { id: 'e2', from: 'b', to: 'd' },
        { id: 'e3', from: 'd', to: '$end' },
      ],
    });
    const out = schedulerTick(
      g,
      s({
        completedNodes: nodeSet('a', 'b'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e0b', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(out.ready).toEqual(['d']);
  });

  test('idempotent priority ordering — same state → same ready sequence', () => {
    const g = twoBranchWithPriority(50, 10);
    const st = s();
    const a = schedulerTick(g, st);
    const b = schedulerTick(g, st);
    // Strict equality of ordered array, not just set-equality — the
    // determinism claim is that the order itself is stable.
    expect(a.ready).toEqual(b.ready);
  });
});

describe('schedulerTick — idempotence', () => {
  test('same state produces same output across ticks', () => {
    const st = s({
      completedNodes: nodeSet('a'),
      edgeDecisions: edgeMap([['e0', true]]),
    });
    const a = schedulerTick(diamond, st);
    const b = schedulerTick(diamond, st);
    expect(new Set(a.ready)).toEqual(new Set(b.ready));
    expect(a.edgeEvals.length).toBe(b.edgeEvals.length);
    expect(a.done).toBe(b.done);
  });
});

describe('schedulerTick — a conditional branch that rejoins (dead paths, 1.8.0)', () => {
  // A ranking shape: rank → nearest only when there is no strong match;
  // landscape runs either way, fed by rank and (maybe) nearest.
  const rejoin = mustLoad({
    id: 'rejoin' as FlowId,
    version: '1.0.0',
    nodes: [
      { id: 'rank', kind: 'tool', ref: 'x' },
      { id: 'nearest', kind: 'tool', ref: 'x' },
      { id: 'landscape', kind: 'tool', ref: 'x' },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 'rank' },
      {
        id: 'e1',
        from: 'rank',
        to: 'nearest',
        when: { op: 'eq', left: { path: 'nodeOutputs.rank.gate' }, right: { literal: 'weak' } },
      },
      { id: 'e2', from: 'rank', to: 'landscape' },
      { id: 'e3', from: 'nearest', to: 'landscape' },
      { id: 'e4', from: 'landscape', to: '$end' },
    ],
  });

  test('skipped arm: the join node is ready as soon as the taken arm resolves', () => {
    const tick = schedulerTick(
      rejoin,
      s({
        completedNodes: nodeSet('rank'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', false],
          ['e2', true],
        ]),
      }),
    );
    expect(tick.ready).toEqual(['landscape']);
    expect(tick.done).toBe(false);
  });

  test('skipped arm: once the join completes the run is done (the skipped node counts as resolved)', () => {
    const tick = schedulerTick(
      rejoin,
      s({
        completedNodes: nodeSet('rank', 'landscape'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', false],
          ['e2', true],
          ['e4', true],
        ]),
      }),
    );
    expect(tick.ready).toEqual([]);
    expect(tick.done).toBe(true);
  });

  test('taken arm: the join waits for it', () => {
    const waiting = schedulerTick(
      rejoin,
      s({
        completedNodes: nodeSet('rank'),
        inFlightNodes: nodeSet('nearest'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(waiting.ready).toEqual([]);
    const joined = schedulerTick(
      rejoin,
      s({
        completedNodes: nodeSet('rank', 'nearest'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', true],
          ['e2', true],
        ]),
      }),
    );
    expect(joined.ready).toEqual(['landscape']);
  });

  test('deadness propagates down a skipped chain', () => {
    const chain = mustLoad({
      id: 'chain' as FlowId,
      version: '1.0.0',
      nodes: [
        { id: 'a', kind: 'tool', ref: 'x' },
        { id: 'b', kind: 'tool', ref: 'x' },
        { id: 'c', kind: 'tool', ref: 'x' },
        { id: 'd', kind: 'tool', ref: 'x' },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'a' },
        { id: 'e1', from: 'a', to: 'b', when: { op: 'falsy', value: { literal: true } } },
        { id: 'e2', from: 'b', to: 'c' },
        { id: 'e3', from: 'c', to: 'd' },
        { id: 'e4', from: 'a', to: 'd' },
        { id: 'e5', from: 'd', to: '$end' },
      ],
    });
    const tick = schedulerTick(
      chain,
      s({
        completedNodes: nodeSet('a'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', false],
          ['e4', true],
        ]),
      }),
    );
    expect(tick.ready).toEqual(['d']);
  });

  test('every arm skipped: the join is dead too and the run is done', () => {
    const tick = schedulerTick(
      rejoin,
      s({
        completedNodes: nodeSet('rank'),
        edgeDecisions: edgeMap([
          ['e0', true],
          ['e1', false],
          ['e2', false],
        ]),
      }),
    );
    expect(tick.ready).toEqual([]);
    expect(tick.done).toBe(true);
  });
});
