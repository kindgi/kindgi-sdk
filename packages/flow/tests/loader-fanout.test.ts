// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { loadFlow } from '../src/index.js';

// ---------- fixture builders ----------

const anySchema = { type: 'object' } as const;

function fanoutBranch(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    branchId: 'b1',
    handler: 'h1',
    outputSchema: anySchema,
    ...overrides,
  };
}

function fanoutNode(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 'fan-1',
    kind: 'fanout',
    convergence: 'settle-all',
    branches: [
      { branchId: 'a', handler: 'ha', outputSchema: anySchema },
      { branchId: 'b', handler: 'hb', outputSchema: anySchema },
    ],
    ...overrides,
  };
}

function outerWith(node: unknown, extras: readonly unknown[] = []): unknown {
  const id = (node as { id: string }).id;
  return {
    id: 'test.fanout',
    version: '1.0.0',
    nodes: [node, ...extras],
    edges: [
      { id: 'oe1', from: '$start', to: id },
      { id: 'oe2', from: id, to: '$end' },
    ],
  };
}

// ---------- happy paths ----------

describe('loadFlow — fanout happy path', () => {
  test('accepts a settle-all fanout with two branches', () => {
    const r = loadFlow(outerWith(fanoutNode()));
    expect(r.kind).toBe('ok');
  });

  test('accepts an all-succeed fanout', () => {
    const r = loadFlow(outerWith(fanoutNode({ convergence: 'all-succeed' })));
    expect(r.kind).toBe('ok');
  });

  test('accepts an any-succeed fanout', () => {
    const r = loadFlow(outerWith(fanoutNode({ convergence: 'any-succeed' })));
    expect(r.kind).toBe('ok');
  });

  test('accepts a fanout with three branches and explicit concurrency=2', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          concurrency: 2,
          branches: [
            fanoutBranch({ branchId: 'a', handler: 'ha' }),
            fanoutBranch({ branchId: 'b', handler: 'hb' }),
            fanoutBranch({ branchId: 'c', handler: 'hc' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('ok');
  });

  test('accepts a fanout with concurrency equal to branches.length', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          concurrency: 2,
        }),
      ),
    );
    expect(r.kind).toBe('ok');
  });

  test('accepts distinct branches that share the same handler ref', () => {
    // Deliberate: handler is stateless from the kernel's POV, so reusing
    // one handler across branches is valid (e.g., "run the same worker
    // against 3 different inputs" is a foreach; but "run the same worker
    // against 3 identical inputs and take the first successful" is a
    // valid fanout use case).
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            fanoutBranch({ branchId: 'a', handler: 'shared-h' }),
            fanoutBranch({ branchId: 'b', handler: 'shared-h' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('ok');
  });
});

// ---------- validation failures ----------

describe('loadFlow — fanout validation failures', () => {
  test('rejects a fanout with only one branch (JSON schema minItems=2)', () => {
    const r = loadFlow(
      outerWith(fanoutNode({ branches: [fanoutBranch({ branchId: 'a', handler: 'ha' })] })),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level minItems=2 fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout with duplicate branchIds', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            fanoutBranch({ branchId: 'dup', handler: 'h1' }),
            fanoutBranch({ branchId: 'dup', handler: 'h2' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('invalid-fanout-node');
    if (r.error.code !== 'invalid-fanout-node') return;
    expect(r.error.field).toBe('branch-id');
    expect(r.error.branchId).toBe('dup');
  });

  test('rejects a fanout with concurrency > branches.length', () => {
    const r = loadFlow(outerWith(fanoutNode({ concurrency: 5 })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('invalid-fanout-node');
    if (r.error.code !== 'invalid-fanout-node') return;
    expect(r.error.field).toBe('concurrency');
  });

  test('rejects a fanout with concurrency < 1', () => {
    const r = loadFlow(outerWith(fanoutNode({ concurrency: 0 })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // JSON schema catches minimum=1 first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout with unknown convergence mode', () => {
    const r = loadFlow(outerWith(fanoutNode({ convergence: 'first-wins' })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level enum check fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout branch missing outputSchema', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            { branchId: 'a', handler: 'ha' },
            { branchId: 'b', handler: 'hb', outputSchema: anySchema },
          ],
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema-level required=[outputSchema] fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout branch with a malformed outputSchema', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            fanoutBranch({ branchId: 'a', handler: 'ha', outputSchema: { type: 'not-a-type' } }),
            fanoutBranch({ branchId: 'b', handler: 'hb' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('invalid-fanout-node');
    if (r.error.code !== 'invalid-fanout-node') return;
    expect(r.error.field).toBe('branch-output-schema');
    expect(r.error.branchId).toBe('a');
  });

  test('rejects a fanout branch with an empty branchId', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            { branchId: '', handler: 'ha', outputSchema: anySchema },
            fanoutBranch({ branchId: 'b', handler: 'hb' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // JSON schema minLength=1 fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout branch with an empty handler', () => {
    const r = loadFlow(
      outerWith(
        fanoutNode({
          branches: [
            { branchId: 'a', handler: '', outputSchema: anySchema },
            fanoutBranch({ branchId: 'b', handler: 'hb' }),
          ],
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // JSON schema minLength=1 on handler fails first.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout with a sentinel id', () => {
    const r = loadFlow(outerWith(fanoutNode({ id: '$end' })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('reserved-id');
  });

  test('rejects a fanout with unknown property (additionalProperties: false)', () => {
    const r = loadFlow(outerWith(fanoutNode({ policy: { retry: { maxAttempts: 2 } } })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout with non-integer concurrency', () => {
    const r = loadFlow(outerWith(fanoutNode({ concurrency: 1.5 })));
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    // Schema requires integer.
    expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a fanout whose node id collides with a leaf outer node', () => {
    const r = loadFlow({
      id: 'test.fanout',
      version: '1.0.0',
      nodes: [fanoutNode({ id: 'dup' }), { id: 'dup', kind: 'tool', ref: 'noop' }],
      edges: [
        { id: 'oe1', from: '$start', to: 'dup' },
        { id: 'oe2', from: 'dup', to: '$end' },
      ],
    });
    expect(r.kind).toBe('err');
    if (r.kind !== 'err') return;
    expect(r.error.code).toBe('duplicate-node-id');
  });
});

// ---------- composability: fanout inside a loop body ----------

describe('loadFlow — fanout composability', () => {
  test('accepts a fanout node nested inside a loop body', () => {
    const flow = {
      id: 'test.fanout-in-loop',
      version: '1.0.0',
      nodes: [
        {
          id: 'batch',
          kind: 'loop',
          loopKind: 'foreach',
          iterateOver: { path: 'runInput.items' },
          maxIterations: 10,
          outputSchema: anySchema,
          body: {
            nodes: [fanoutNode({ id: 'inner-fanout' })],
            edges: [
              { id: 'be1', from: '$loop-start', to: 'inner-fanout' },
              { id: 'be2', from: 'inner-fanout', to: '$loop-end' },
            ],
          },
        },
      ],
      edges: [
        { id: 'oe1', from: '$start', to: 'batch' },
        { id: 'oe2', from: 'batch', to: '$end' },
      ],
    };
    const r = loadFlow(flow);
    expect(r.kind).toBe('ok');
  });
});
