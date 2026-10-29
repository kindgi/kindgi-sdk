// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a flow version's pins cover is what the runtime binds: every tool
 * the flow runs (tool nodes, fanout branches, nodes in loop bodies) and
 * every agent it runs at no named version. The digest is one string for
 * one set of pins.
 */

import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { canonicalize } from '@kindgi/schema';

import {
  type Flow,
  type SubflowNode,
  flowPinsDigest,
  flowRefs,
  loadFlow,
  overridableRefs,
  overridableTreeRefs,
  subflowVersion,
  withVersions,
} from '../src/index.js';

const anySchema = { type: 'object' };

const flow = loadFlow({
  id: 'acme.review',
  version: '2.0.0',
  nodes: [
    { id: 'score', kind: 'tool', ref: 'acme.score' },
    { id: 'match', kind: 'agent', ref: 'acme.matcher' },
    { id: 'audit', kind: 'agent', ref: 'acme.auditor', config: { version: '0.9.0' } },
    {
      id: 'fan',
      kind: 'fanout',
      convergence: 'settle-all',
      branches: [
        { branchId: 'a', handler: 'acme.rank', outputSchema: anySchema },
        { branchId: 'b', handler: 'acme.score', outputSchema: anySchema },
      ],
    },
    {
      id: 'each',
      kind: 'loop',
      loopKind: 'foreach',
      iterateOver: { path: 'runInput.items' },
      maxIterations: 10,
      body: {
        nodes: [
          { id: 'lookup', kind: 'tool', ref: 'acme.lookup' },
          { id: 'ask', kind: 'agent', ref: 'acme.helper' },
        ],
        edges: [
          { id: 'b0', from: '$loop-start', to: 'lookup' },
          { id: 'b1', from: 'lookup', to: 'ask' },
          { id: 'b2', from: 'ask', to: '$loop-end' },
        ],
      },
      outputSchema: anySchema,
    },
  ],
  edges: [
    { id: 'e0', from: '$start', to: 'score' },
    { id: 'e1', from: 'score', to: 'match' },
    { id: 'e2', from: 'match', to: 'audit' },
    { id: 'e3', from: 'audit', to: 'fan' },
    { id: 'e4', from: 'fan', to: 'each' },
    { id: 'e5', from: 'each', to: '$end' },
  ],
});

describe('flowRefs', () => {
  test('every tool the flow runs, and every agent it runs at no named version, once each', () => {
    if (flow.kind === 'err') throw new Error(flow.error.message);
    expect(flowRefs(flow.value)).toEqual({
      tools: ['acme.lookup', 'acme.rank', 'acme.score'],
      agents: ['acme.helper', 'acme.matcher'],
      flows: [],
    });
  });

  test('every sub-flow it runs at no named version, in loop bodies too, once each', () => {
    const parent = withSubflows([
      step('a', 'acme.child'),
      step('b', 'acme.named', '1.2.0'),
      step('c', 'acme.child'),
    ]);
    expect(flowRefs(parent)).toEqual({
      tools: [],
      agents: [],
      flows: ['acme.child', 'acme.inner'],
    });
  });
});

describe('overridableRefs', () => {
  test('every tool, and every agent at a named version or not: what withVersions can override', () => {
    if (flow.kind === 'err') throw new Error(flow.error.message);
    expect(overridableRefs(flow.value)).toEqual({
      tools: ['acme.lookup', 'acme.rank', 'acme.score'],
      agents: ['acme.auditor', 'acme.helper', 'acme.matcher'],
    });
  });
});

describe('flowPinsDigest', () => {
  test("key order doesn't change it; a version does", () => {
    const pins = {
      tools: { 'acme.score': '1.1.0', 'acme.lookup': '0.2.0' },
      agents: { 'acme.matcher': '1.4.1' },
    };
    const reordered = {
      agents: { 'acme.matcher': '1.4.1' },
      tools: { 'acme.lookup': '0.2.0', 'acme.score': '1.1.0' },
    };
    expect(flowPinsDigest(reordered)).toBe(flowPinsDigest(pins));
    expect(flowPinsDigest(pins)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flowPinsDigest({ ...pins, agents: { 'acme.matcher': '1.4.2' } })).not.toBe(
      flowPinsDigest(pins),
    );
  });

  test('pins with no sub-flow entries hash as they did before sub-flows were pinned', () => {
    const pins = { tools: { 'acme.score': '1.1.0' }, agents: { 'acme.matcher': '1.4.1' } };
    const before = `sha256:${createHash('sha256').update(canonicalize(pins), 'utf8').digest('hex')}`;
    expect(flowPinsDigest(pins)).toBe(before);
    expect(flowPinsDigest({ ...pins, flows: {} })).toBe(before);
    expect(flowPinsDigest({ ...pins, flows: { 'acme.child': '1.0.0' } })).not.toBe(before);
    expect(flowPinsDigest({ ...pins, flows: { 'acme.child': '1.0.1' } })).not.toBe(
      flowPinsDigest({ ...pins, flows: { 'acme.child': '1.0.0' } }),
    );
  });
});

describe('withVersions', () => {
  const published = (): Flow => {
    if (flow.kind === 'err') throw new Error(flow.error.message);
    const pins = {
      tools: { 'acme.score': '1.1.0', 'acme.rank': '0.2.0', 'acme.lookup': '0.2.0' },
      agents: { 'acme.matcher': '1.4.1', 'acme.helper': '0.3.0' },
    };
    return { ...flow.value, pins, pinsDigest: flowPinsDigest(pins) };
  };
  const nodeVersion = (f: Flow, id: string) =>
    (f.nodes.find((n) => n.id === id) as { config?: { version?: string } } | undefined)?.config
      ?.version;

  test('runs blocks at other versions through the pins, and recomputes the digest', () => {
    const base = published();
    const swapped = withVersions(base, {
      tools: { 'acme.score': '2.0.0' },
      agents: { 'acme.matcher': '1.5.0' },
    });
    expect(swapped.pins).toEqual({
      tools: { 'acme.score': '2.0.0', 'acme.rank': '0.2.0', 'acme.lookup': '0.2.0' },
      agents: { 'acme.matcher': '1.5.0', 'acme.helper': '0.3.0' },
    });
    expect(swapped.pinsDigest).toBe(flowPinsDigest(swapped.pins as NonNullable<Flow['pins']>));
    expect(swapped.pinsDigest).not.toBe(base.pinsDigest);
    expect(base.pins?.agents['acme.matcher']).toBe('1.4.1');
  });

  test("an agent node's own config.version takes the override, since it wins over a pin", () => {
    const swapped = withVersions(published(), { agents: { 'acme.auditor': '1.0.0' } });
    expect(nodeVersion(swapped, 'audit')).toBe('1.0.0');
    expect(nodeVersion(published(), 'audit')).toBe('0.9.0');
    expect(swapped.pins?.agents['acme.auditor']).toBe('1.0.0');
  });

  test('a flow version published before pins gets pins of the overrides only', () => {
    if (flow.kind === 'err') throw new Error(flow.error.message);
    const swapped = withVersions(flow.value, { agents: { 'acme.matcher': '1.5.0' } });
    expect(swapped.pins).toEqual({ tools: {}, agents: { 'acme.matcher': '1.5.0' } });
  });

  test("keeps the sub-flow pins: a run's versions don't name sub-flows", () => {
    const pins = { tools: {}, agents: {}, flows: { 'acme.child': '1.0.0' } };
    const parent = { ...withSubflows([step('a', 'acme.child')]), pins };
    const swapped = withVersions(parent, { tools: { 'acme.score': '2.0.0' } });
    expect(swapped.pins?.flows).toEqual({ 'acme.child': '1.0.0' });
    expect(swapped.pinsDigest).toBe(flowPinsDigest(swapped.pins as NonNullable<Flow['pins']>));
  });
});

/** A sub-flow step; `version` is the one its flowRef names. */
function step(id: string, flowId: string, version?: string): SubflowNode {
  return {
    id,
    kind: 'subgraph',
    flowRef: { flowId, ...(version !== undefined && { version }) },
    inputMapping: {},
    outputSchema: anySchema,
    convergence: 'settle-all',
  } as unknown as SubflowNode;
}

/** A flow running `steps` one after the other, then a loop whose body runs `acme.inner`. */
function withSubflows(
  steps: readonly SubflowNode[],
  id = 'acme.parent',
  version = '1.0.0',
  pins?: Flow['pins'],
): Flow {
  const ids = [...steps.map((s) => s.id as unknown as string), 'each'];
  const r = loadFlow({
    id,
    version,
    nodes: [
      ...steps,
      {
        id: 'each',
        kind: 'loop',
        loopKind: 'foreach',
        iterateOver: { path: 'runInput.items' },
        maxIterations: 3,
        body: {
          nodes: [step('inner', 'acme.inner')],
          edges: [
            { id: 'b0', from: '$loop-start', to: 'inner' },
            { id: 'b1', from: 'inner', to: '$loop-end' },
          ],
        },
        outputSchema: anySchema,
      },
    ],
    edges: [
      { id: 'e0', from: '$start', to: ids[0] },
      ...ids.slice(1).map((to, i) => ({ id: `e${i + 1}`, from: ids[i], to })),
      { id: 'end', from: 'each', to: '$end' },
    ],
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return pins === undefined ? r.value : { ...r.value, pins };
}

/** A flow with one tool node and one agent node. */
function leafFlow(id: string, version: string, tool: string, agent: string): Flow {
  const r = loadFlow({
    id,
    version,
    nodes: [
      { id: 't', kind: 'tool', ref: tool },
      { id: 'a', kind: 'agent', ref: agent, config: { version: '0.1.0' } },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 't' },
      { id: 'e1', from: 't', to: 'a' },
      { id: 'e2', from: 'a', to: '$end' },
    ],
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

describe('subflowVersion', () => {
  const pins = { tools: {}, agents: {}, flows: { 'acme.child': '1.0.0', 'acme.named': '9.9.9' } };

  test("the version the step names, over the parent's pin", () => {
    const parent = withSubflows([step('b', 'acme.named', '1.2.0')], undefined, undefined, pins);
    expect(subflowVersion(parent, step('b', 'acme.named', '1.2.0'))).toBe('1.2.0');
  });

  test("the parent's pin when the step names none", () => {
    const parent = withSubflows([step('a', 'acme.child')], undefined, undefined, pins);
    expect(subflowVersion(parent, step('a', 'acme.child'))).toBe('1.0.0');
  });

  test('none on a parent with no pin for it', () => {
    expect(subflowVersion(withSubflows([step('a', 'acme.child')]), step('a', 'acme.child'))).toBe(
      undefined,
    );
  });
});

describe('overridableTreeRefs', () => {
  const pins = { tools: {}, agents: {}, flows: { 'acme.child': '1.0.0', 'acme.inner': '2.0.0' } };
  const parent = withSubflows(
    [step('a', 'acme.child'), step('b', 'acme.named', '1.2.0'), step('c', 'acme.child')],
    undefined,
    undefined,
    pins,
  );
  const store = new Map<string, Flow>([
    ['acme.child@1.0.0', leafFlow('acme.child', '1.0.0', 'acme.fetch', 'acme.reader')],
    ['acme.named@1.2.0', leafFlow('acme.named', '1.2.0', 'acme.send', 'acme.writer')],
    ['acme.inner@2.0.0', leafFlow('acme.inner', '2.0.0', 'acme.lookup', 'acme.helper')],
  ]);

  test('the blocks of the flow and of each sub-flow version it runs, at any depth', async () => {
    const reads: string[] = [];
    const refs = await overridableTreeRefs(parent, async ({ flowId, version }) => {
      reads.push(`${flowId}@${version}`);
      return store.get(`${flowId}@${version}`) ?? null;
    });
    expect(refs).toEqual({
      tools: ['acme.fetch', 'acme.lookup', 'acme.send'],
      agents: ['acme.helper', 'acme.reader', 'acme.writer'],
    });
    // Two steps run acme.child@1.0.0: it's read once.
    expect(reads.sort()).toEqual(['acme.child@1.0.0', 'acme.inner@2.0.0', 'acme.named@1.2.0']);
  });

  test("a sub-flow that isn't there, or a step with no version to run, adds nothing", async () => {
    const unpinned = withSubflows([step('a', 'acme.child')]);
    const reads: string[] = [];
    const refs = await overridableTreeRefs(unpinned, async ({ flowId, version }) => {
      reads.push(`${flowId}@${version}`);
      return null;
    });
    expect(refs).toEqual({ tools: [], agents: [] });
    expect(reads).toEqual([]);
  });

  test('a flow that runs itself is read once, and the walk ends', async () => {
    const self = withSubflows([step('again', 'acme.loop', '1.0.0')], 'acme.loop', '1.0.0');
    let reads = 0;
    const refs = await overridableTreeRefs(self, async () => {
      reads += 1;
      return self;
    });
    expect(reads).toBe(0);
    expect(refs).toEqual({ tools: [], agents: [] });
  });

  test('stops at the depth a run stops at', async () => {
    // acme.d0 runs acme.d1, which runs acme.d2, and so on; each has its own tool.
    const chain = (n: number): Flow => {
      const r = loadFlow({
        id: `acme.d${n}`,
        version: '1.0.0',
        nodes: [
          { id: 't', kind: 'tool', ref: `acme.tool${n}` },
          step('next', `acme.d${n + 1}`, '1.0.0'),
        ],
        edges: [
          { id: 'e0', from: '$start', to: 't' },
          { id: 'e1', from: 't', to: 'next' },
          { id: 'e2', from: 'next', to: '$end' },
        ],
      });
      if (r.kind === 'err') throw new Error(r.error.message);
      return r.value;
    };
    const refs = await overridableTreeRefs(chain(0), async ({ flowId }) =>
      chain(Number(flowId.slice('acme.d'.length))),
    );
    // The root and 10 levels of sub-flows below it.
    expect(refs.tools).toHaveLength(11);
    expect(refs.tools).toContain('acme.tool10');
    expect(refs.tools).not.toContain('acme.tool11');
  });
});
