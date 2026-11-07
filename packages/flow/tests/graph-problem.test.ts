// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import { flowGraphProblem, loadFlow } from '../src/index.js';

// Every flow the loader tests imported below hand `loadFlow` goes through
// `flowGraphProblem` too. A flow `loadFlow`'s schema accepts gets the same
// answer from both: `ok`, or the same error, code and message.
vi.mock('../src/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/index.js')>();
  const { expect: expectHere } = await import('vitest');
  return {
    ...real,
    loadFlow: (input: unknown) => {
      const loaded = real.loadFlow(input);
      if (loaded.kind === 'err' && loaded.error.code === 'schema-validation-failed') return loaded;
      expectHere(real.flowGraphProblem(input), 'flowGraphProblem, beside loadFlow').toEqual(
        loaded.kind === 'ok' ? { kind: 'ok' } : { kind: 'err', error: loaded.error },
      );
      return loaded;
    },
  };
});

import './loader.test.js';
import './loop-loader.test.js';
import './loader-fanout.test.js';
import './loader-subgraph.test.js';

function edge(id: string, from: string, to: string): Record<string, unknown> {
  return { id, from, to };
}

function tool(id: string): Record<string, unknown> {
  return { id, kind: 'tool', ref: 'noop' };
}

function flow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test.flow',
    version: '1.0.0',
    nodes: [tool('a'), tool('b')],
    edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', '$end')],
    ...overrides,
  };
}

const cycle = [
  edge('e1', '$start', 'a'),
  edge('e2', 'a', 'b'),
  edge('e3', 'b', 'a'),
  edge('e4', 'b', '$end'),
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('flowGraphProblem', () => {
  test('a flow loadFlow accepts is ok', () => {
    expect(flowGraphProblem(flow())).toEqual({ kind: 'ok' });
  });

  test('a cycle is refused with the code and message loadFlow gives', () => {
    const checked = flowGraphProblem(flow({ edges: cycle }));
    expect(checked.kind).toBe('err');
    if (checked.kind !== 'err') return;
    expect(checked.error.code).toBe('cycle-detected');
    expect(checked.error.message).toMatch(/^Flow "test\.flow" contains a cycle: /);
  });

  test.each([
    [
      'an edge to a step that does not exist',
      { edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'gone')] },
      'unknown-node-reference',
    ],
    [
      'an edge from a step that does not exist',
      { edges: [edge('e1', '$start', 'a'), edge('e2', 'gone', 'b')] },
      'unknown-node-reference',
    ],
    [
      'no edge from $start',
      { edges: [edge('e1', 'a', 'b'), edge('e2', 'b', '$end')] },
      'missing-start-edge',
    ],
    ['two steps with one id', { nodes: [tool('a'), tool('a')] }, 'duplicate-node-id'],
    [
      'two edges with one id',
      { edges: [edge('e1', '$start', 'a'), edge('e1', 'a', 'b')] },
      'duplicate-edge-id',
    ],
  ])('%s is refused', (_what, overrides, code) => {
    const checked = flowGraphProblem(flow(overrides));
    expect(checked).toMatchObject({ kind: 'err', error: { code } });
  });

  test('a field this version does not know is passed over, where loadFlow refuses it', () => {
    const newer = flow({
      shape: 'from a newer SDK',
      nodes: [{ ...tool('a'), retries: 3 }, tool('b')],
      edges: [
        edge('e1', '$start', 'a'),
        {
          ...edge('e2', 'a', 'b'),
          when: { op: 'eq', left: { path: 'runInput.x', note: 'n' }, right: { literal: 1 } },
        },
        { ...edge('e3', 'b', '$end'), weight: 2 },
      ],
    });
    expect(loadFlow(newer)).toMatchObject({
      kind: 'err',
      error: { code: 'schema-validation-failed' },
    });
    expect(flowGraphProblem(newer)).toEqual({ kind: 'ok' });
  });

  test('the graph checks still run on a flow with fields this version does not know', () => {
    const checked = flowGraphProblem(flow({ shape: 'from a newer SDK', edges: cycle }));
    expect(checked).toMatchObject({ kind: 'err', error: { code: 'cycle-detected' } });
  });

  test.each([
    [
      'an unknown node kind',
      flow({ nodes: [{ id: 'a', kind: 'teleport', ref: 'noop' }, tool('b')] }),
    ],
    ['a step with no ref', flow({ nodes: [{ id: 'a', kind: 'tool' }, tool('b')] })],
    ['a flow with no edges', flow({ edges: undefined })],
    ['not an object', 'test.flow'],
    ['null', null],
  ])('%s is not judged, with the schema reason', (_what, input) => {
    const checked = flowGraphProblem(input);
    expect(checked.kind).toBe('not-judged');
    if (checked.kind === 'not-judged') expect(checked.reason).not.toBe('');
  });

  test('leaves the flow it is given as it was', () => {
    const given = deepFreeze(flow({ edges: cycle }));
    const copy = structuredClone(given);
    expect(flowGraphProblem(given).kind).toBe('err');
    expect(given).toEqual(copy);
  });
});
