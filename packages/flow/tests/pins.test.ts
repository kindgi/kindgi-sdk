// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a flow version's pins cover is what the runtime binds: every tool
 * the flow runs (tool nodes, fanout branches, nodes in loop bodies) and
 * every agent it runs at no named version. The digest is one string for
 * one set of pins.
 */

import { describe, expect, test } from 'vitest';

import { type Flow, flowPinsDigest, flowRefs, loadFlow, withVersions } from '../src/index.js';

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
});
