// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Schema-version 1.8.0 data flow: leaf `inputMapping`, the flow-level
 * `output`, `maxParallelism`, and `resolveMapping`.
 */

import { describe, expect, test } from 'vitest';

import type { NodeId } from '@kindgi/types';

import { loadFlow, resolveMapping } from '../src/index.js';

function flow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'test.mapping',
    version: '1.0.0',
    nodes: [
      { id: 'load', kind: 'tool', ref: 'pack.load' },
      {
        id: 'rank',
        kind: 'tool',
        ref: 'pack.rank',
        inputMapping: {
          axes: { path: 'nodeOutputs.load.axes' },
          organizationId: { path: 'runInput.organizationId' },
          limit: { literal: 10 },
        },
      },
    ],
    edges: [
      { id: 'e0', from: '$start', to: 'load' },
      { id: 'e1', from: 'load', to: 'rank' },
      { id: 'e2', from: 'rank', to: '$end' },
    ],
    ...overrides,
  };
}

function withRankMapping(mapping: Record<string, unknown>): Record<string, unknown> {
  const base = flow();
  const nodes = (base.nodes as Record<string, unknown>[]).map((n) =>
    n.id === 'rank' ? { ...n, inputMapping: mapping } : n,
  );
  return { ...base, nodes };
}

describe('resolveMapping', () => {
  const env = {
    runInput: { grievanceId: 'g-1', organizationId: 'org-1' },
    state: { attempts: 2 },
    nodeOutputs: new Map([
      ['load' as NodeId, { axes: { remedy: ['reinstatement'] }, organizationId: 'org-1' }],
    ]),
  };

  test('resolves literals and paths into one object', () => {
    expect(
      resolveMapping(
        {
          grievanceId: { path: 'runInput.grievanceId' },
          remedy: { path: 'nodeOutputs.load.axes.remedy' },
          attempts: { path: 'state.attempts' },
          limit: { literal: 10 },
        },
        env,
      ),
    ).toEqual({ grievanceId: 'g-1', remedy: ['reinstatement'], attempts: 2, limit: 10 });
  });

  test('a path that does not resolve omits its key', () => {
    const out = resolveMapping(
      { present: { path: 'runInput.grievanceId' }, absent: { path: 'nodeOutputs.nope.x' } },
      env,
    );
    expect(out).toEqual({ present: 'g-1' });
    expect('absent' in out).toBe(false);
  });

  test('a whole node output maps as-is; a literal null stays null', () => {
    expect(
      resolveMapping({ grievance: { path: 'nodeOutputs.load' }, none: { literal: null } }, env),
    ).toEqual({
      grievance: { axes: { remedy: ['reinstatement'] }, organizationId: 'org-1' },
      none: null,
    });
  });
});

describe('loadFlow — leaf inputMapping (1.8.0)', () => {
  test('accepts runInput, state, nodeOutputs and literal operands', () => {
    const r = loadFlow(
      withRankMapping({
        a: { path: 'runInput.x' },
        b: { path: 'state.y' },
        c: { path: 'nodeOutputs.load' },
        d: { literal: { any: 'json' } },
      }),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const rank = r.value.nodes.find((n) => n.id === 'rank');
      expect(rank && 'inputMapping' in rank && rank.inputMapping).toMatchObject({
        c: { path: 'nodeOutputs.load' },
      });
    }
  });

  test.each([
    ['unknown node', { path: 'nodeOutputs.missing.x' }, 'nodeOutputs.missing names no node'],
    ['own output', { path: 'nodeOutputs.rank.x' }, 'cannot map its own output'],
    ['loop-only root', { path: 'iterationIndex' }, "only available in a loop's exitCondition"],
  ])('rejects %s', (_label, operand, reason) => {
    const r = loadFlow(withRankMapping({ bad: operand }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error).toMatchObject({ code: 'invalid-mapping', nodeId: 'rank', key: 'bad' });
      expect(r.error.message).toContain(reason);
    }
  });

  test.each([
    ['an unknown path root', { bad: { path: 'input.x' } }],
    ['nodeOutputs without a node id', { bad: { path: 'nodeOutputs' } }],
    ['an empty key', { '': { literal: 1 } }],
    ['a non-operand value', { x: 'runInput.x' }],
  ])('%s fails schema validation', (_label, mapping) => {
    const r = loadFlow(withRankMapping(mapping));
    expect(r.kind === 'err' && r.error.code).toBe('schema-validation-failed');
  });

  test('checks nodes inside loop bodies too', () => {
    const r = loadFlow(
      flow({
        nodes: [
          { id: 'load', kind: 'tool', ref: 'pack.load' },
          {
            id: 'loop',
            kind: 'loop',
            loopKind: 'foreach',
            iterateOver: { path: 'nodeOutputs.load.items' },
            maxIterations: 5,
            outputSchema: { type: 'object' },
            body: {
              nodes: [
                {
                  id: 'inner',
                  kind: 'tool',
                  ref: 'pack.inner',
                  inputMapping: { x: { path: 'nodeOutputs.ghost' } },
                },
              ],
              edges: [
                { id: 'b0', from: '$loop-start', to: 'inner' },
                { id: 'b1', from: 'inner', to: '$loop-end' },
              ],
            },
          },
        ],
        edges: [
          { id: 'e0', from: '$start', to: 'load' },
          { id: 'e1', from: 'load', to: 'loop' },
          { id: 'e2', from: 'loop', to: '$end' },
        ],
      }),
    );
    expect(r.kind === 'err' && r.error).toMatchObject({ code: 'invalid-mapping', nodeId: 'inner' });
  });
});

describe('loadFlow — flow output (1.8.0)', () => {
  test('accepts an output mapping with a schema, and maxParallelism', () => {
    const r = loadFlow(
      flow({
        maxParallelism: 4,
        output: {
          mapping: { ranked: { path: 'nodeOutputs.rank.ranked' }, id: { path: 'runInput.id' } },
          schema: {
            type: 'object',
            properties: { ranked: { type: 'array' }, id: { type: 'string' } },
            required: ['ranked'],
          },
        },
      }),
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.maxParallelism).toBe(4);
      expect(r.value.output?.mapping.ranked).toEqual({ path: 'nodeOutputs.rank.ranked' });
    }
  });

  test('an output path naming no node is invalid-mapping without a nodeId', () => {
    const r = loadFlow(flow({ output: { mapping: { x: { path: 'nodeOutputs.nope' } } } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error).toMatchObject({ code: 'invalid-mapping', key: 'x' });
      expect('nodeId' in r.error).toBe(false);
      expect(r.error.message).toContain('The flow output');
    }
  });

  test('an output schema that does not compile is invalid-flow-output', () => {
    const r = loadFlow(
      flow({ output: { mapping: { x: { literal: 1 } }, schema: { type: 'not-a-type' } } }),
    );
    expect(r.kind === 'err' && r.error.code).toBe('invalid-flow-output');
  });

  test('output needs a mapping; maxParallelism must be a positive integer', () => {
    expect(loadFlow(flow({ output: { schema: { type: 'object' } } })).kind).toBe('err');
    expect(loadFlow(flow({ maxParallelism: 0 })).kind).toBe('err');
  });
});
