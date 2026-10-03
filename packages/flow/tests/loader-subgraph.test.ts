// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { loadFlow } from '../src/index.js';

// ---------- fixture builders ----------

const anySchema = { type: 'object' } as const;

function subgraphNode(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 'sg-1',
    kind: 'subgraph',
    flowRef: { flowId: 'child.flow', version: '1.0.0' },
    inputMapping: {
      userId: { path: 'runInput.userId' },
      hint: { literal: 'go' },
    },
    outputSchema: anySchema,
    convergence: 'settle-all',
    ...overrides,
  };
}

function outerWith(node: unknown, extras: readonly unknown[] = []): unknown {
  const id = (node as { id: string }).id;
  return {
    id: 'test.subgraph',
    version: '1.0.0',
    nodes: [node, ...extras],
    edges: [
      { id: 'oe1', from: '$start', to: id },
      { id: 'oe2', from: id, to: '$end' },
    ],
  };
}

// ---------- happy paths ----------

describe('loadFlow — subgraph happy path', () => {
  test('accepts a settle-all subgraph with path + literal input mapping', () => {
    const r = loadFlow(outerWith(subgraphNode()));
    expect(r.kind).toBe('ok');
  });

  test('accepts a success-only convergence subgraph', () => {
    const r = loadFlow(outerWith(subgraphNode({ convergence: 'success-only' })));
    expect(r.kind).toBe('ok');
  });

  test('accepts an empty inputMapping (sub-run runs with {} as its runInput)', () => {
    const r = loadFlow(outerWith(subgraphNode({ inputMapping: {} })));
    expect(r.kind).toBe('ok');
  });

  test('accepts a pre-release semver version like 1.2.3-alpha.1', () => {
    const r = loadFlow(
      outerWith(subgraphNode({ flowRef: { flowId: 'child.flow', version: '1.2.3-alpha.1' } })),
    );
    expect(r.kind).toBe('ok');
  });
});

// ---------- flowRef validation ----------

describe('loadFlow — subgraph flowRef validation', () => {
  test('rejects a missing flowRef (schema-level)', () => {
    const r = loadFlow(outerWith(subgraphNode({ flowRef: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // JSON schema `required: ['flowRef']` fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a flowRef with a non-exact semver range like ^1.0.0', () => {
    const r = loadFlow(
      outerWith(subgraphNode({ flowRef: { flowId: 'child.flow', version: '^1.0.0' } })),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level pattern check fails first (^1.0.0 is not exact semver).
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a flowRef missing flowId', () => {
    const r = loadFlow(
      outerWith(
        subgraphNode({
          flowRef: { version: '1.0.0' } as unknown as { flowId: string; version: string },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level required=[flowId] fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects an empty-string flowId', () => {
    const r = loadFlow(outerWith(subgraphNode({ flowRef: { flowId: '', version: '1.0.0' } })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level minLength=1 fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });
});

// ---------- inputMapping validation ----------

describe('loadFlow — subgraph inputMapping validation', () => {
  test('rejects an inputMapping whose value is neither literal nor path', () => {
    const r = loadFlow(
      outerWith(
        subgraphNode({
          inputMapping: {
            bad: { garbage: 'field' },
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // JSON schema Operand oneOf catches the shape first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects an inputMapping value that is a scalar (not an Operand object)', () => {
    const r = loadFlow(
      outerWith(
        subgraphNode({
          inputMapping: {
            bad: 'raw-string' as unknown,
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects an inputMapping that is an array (not an object)', () => {
    const r = loadFlow(
      outerWith(subgraphNode({ inputMapping: [] as unknown as Record<string, unknown> })),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('schema-validation-failed');
  });
});

// ---------- outputSchema validation ----------

describe('loadFlow — subgraph outputSchema validation', () => {
  test('rejects a missing outputSchema (schema-level)', () => {
    const r = loadFlow(outerWith(subgraphNode({ outputSchema: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects an outputSchema that is not valid JSON Schema draft 2020-12', () => {
    const r = loadFlow(outerWith(subgraphNode({ outputSchema: { type: 'not-a-real-type' } })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('invalid-subgraph-node');
    if (r.error.code !== 'invalid-subgraph-node') return;
    expect(r.error.field).toBe('output-schema');
    expect(r.error.subgraphNodeId).toBe('sg-1');
  });
});

// ---------- convergence validation ----------

describe('loadFlow — subgraph convergence validation', () => {
  test('rejects an unknown convergence value', () => {
    const r = loadFlow(outerWith(subgraphNode({ convergence: 'quantum' })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level enum fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a missing convergence field (schema-level)', () => {
    const r = loadFlow(outerWith(subgraphNode({ convergence: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('schema-validation-failed');
  });
});

// ---------- interaction with sentinels / unique ids ----------

describe('loadFlow — subgraph interactions', () => {
  test('rejects a subgraph node whose id is a sentinel', () => {
    const r = loadFlow({
      id: 'test.sentinel',
      version: '1.0.0',
      nodes: [subgraphNode({ id: '$start' })],
      edges: [{ id: 'oe1', from: '$start', to: '$end' }],
    });
    expect(r.kind).toBe('err');
  });

  test('rejects duplicate node id across leaf + subgraph nodes', () => {
    const r = loadFlow({
      id: 'test.dupe',
      version: '1.0.0',
      nodes: [{ id: 'dup', kind: 'tool', ref: 't1' }, subgraphNode({ id: 'dup' })],
      edges: [
        { id: 'oe1', from: '$start', to: 'dup' },
        { id: 'oe2', from: 'dup', to: '$end' },
      ],
    });
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('duplicate-node-id');
  });

  test('rejects the legacy leaf-typed `kind: "subgraph"` shape (1.6.0 placeholder removed in 1.7.0)', () => {
    const r = loadFlow({
      id: 'test.legacy',
      version: '1.0.0',
      nodes: [{ id: 'sg', kind: 'subgraph', ref: 'legacy-ref' }],
      edges: [
        { id: 'oe1', from: '$start', to: 'sg' },
        { id: 'oe2', from: 'sg', to: '$end' },
      ],
    });
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // No LeafNode variant matches (kind enum tightened); Node.oneOf falls through.
    expect(r.error.code).toBe('schema-validation-failed');
  });
});
