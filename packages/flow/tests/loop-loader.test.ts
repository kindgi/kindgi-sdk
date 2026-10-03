// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import { LOOP_END_NODE, LOOP_START_NODE, loadFlow } from '../src/index.js';

// ---------- fixture builders ----------

function outerNode(id: string, ref = 'noop'): unknown {
  return { id, kind: 'tool', ref };
}

function bodyNode(id: string, ref = 'noop'): unknown {
  return { id, kind: 'tool', ref };
}

function outerEdge(id: string, from: string, to: string): unknown {
  return { id, from, to };
}

function bodyEdge(id: string, from: string, to: string): unknown {
  return { id, from, to };
}

/** Minimal valid draft-2020-12 schema — accepts anything. */
const anySchema = { type: 'object' };

/** Predicate `iterationIndex >= 3` — a trivial termination expression. */
const trivialExit = {
  op: 'gte',
  left: { path: 'iterationIndex' },
  right: { literal: 3 },
};

function whileLoopNode(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 'loop-1',
    kind: 'loop',
    loopKind: 'while',
    body: {
      nodes: [bodyNode('worker')],
      edges: [bodyEdge('be1', LOOP_START_NODE, 'worker'), bodyEdge('be2', 'worker', LOOP_END_NODE)],
    },
    exitCondition: trivialExit,
    maxIterations: 5,
    outputSchema: anySchema,
    ...overrides,
  };
}

function foreachLoopNode(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 'foreach-1',
    kind: 'loop',
    loopKind: 'foreach',
    body: {
      nodes: [bodyNode('worker')],
      edges: [bodyEdge('be1', LOOP_START_NODE, 'worker'), bodyEdge('be2', 'worker', LOOP_END_NODE)],
    },
    iterateOver: { path: 'runInput.items' },
    maxIterations: 1000,
    outputSchema: anySchema,
    ...overrides,
  };
}

function outerWith(loopNode: unknown, extraOuterNodes: readonly unknown[] = []): unknown {
  const loopId = (loopNode as { id: string }).id;
  return {
    id: 'test.flow',
    version: '1.0.0',
    nodes: [loopNode, ...extraOuterNodes],
    edges: [outerEdge('oe1', '$start', loopId), outerEdge('oe2', loopId, '$end')],
  };
}

// ---------- happy path ----------

describe('loadFlow — happy path for loop nodes', () => {
  test('accepts a valid while loop (do-while default)', () => {
    const r = loadFlow(outerWith(whileLoopNode()));
    expect(r.kind).toBe('ok');
  });

  test('accepts a while loop with explicit evaluationTiming=before', () => {
    const r = loadFlow(outerWith(whileLoopNode({ evaluationTiming: 'before' })));
    expect(r.kind).toBe('ok');
  });

  test('accepts a while loop with explicit evaluationTiming=after', () => {
    const r = loadFlow(outerWith(whileLoopNode({ evaluationTiming: 'after' })));
    expect(r.kind).toBe('ok');
  });

  test('accepts a valid foreach loop', () => {
    const r = loadFlow(outerWith(foreachLoopNode()));
    expect(r.kind).toBe('ok');
  });

  test('accepts a foreach loop with literal iterateOver', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ iterateOver: { literal: [1, 2, 3] } })));
    expect(r.kind).toBe('ok');
  });
});

// ---------- variant integrity ----------

describe('loadFlow — variant integrity', () => {
  test('rejects a while loop missing exitCondition', () => {
    const r = loadFlow(outerWith(whileLoopNode({ exitCondition: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      // Schema-level rejection happens first because exitCondition is required
      // in the WhileLoopNode schema; the loader may return schema-validation-failed
      // OR loop-variant-mismatch depending on which fires first. Both are
      // acceptable outcomes for the same underlying issue.
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });

  test('rejects a foreach loop missing iterateOver', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ iterateOver: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });

  test('rejects a foreach loop that also declares exitCondition', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ exitCondition: trivialExit })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });

  test('rejects a while loop that also declares iterateOver', () => {
    const r = loadFlow(outerWith(whileLoopNode({ iterateOver: { path: 'runInput.x' } })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });

  test('rejects a foreach loop that declares evaluationTiming', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ evaluationTiming: 'after' })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });
});

// ---------- outputSchema ----------

describe('loadFlow — outputSchema', () => {
  test('rejects a loop missing outputSchema entirely', () => {
    const r = loadFlow(outerWith(whileLoopNode({ outputSchema: undefined })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects a loop with a malformed outputSchema (unknown keyword under strict mode)', () => {
    const r = loadFlow(
      outerWith(whileLoopNode({ outputSchema: { thisIsNotAValidKeyword: true } })),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('loop-invalid-output-schema');
  });

  test('rejects a loop with an outputSchema that is not JSON Schema (e.g. array)', () => {
    const r = loadFlow(outerWith(whileLoopNode({ outputSchema: [] })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      // Schema layer expects an object; either schema-validation-failed or
      // loop-invalid-output-schema is acceptable.
      expect(
        r.error.code === 'schema-validation-failed' ||
          r.error.code === 'loop-invalid-output-schema',
      ).toBe(true);
    }
  });

  test('accepts a complex valid outputSchema', () => {
    const r = loadFlow(
      outerWith(
        whileLoopNode({
          outputSchema: {
            type: 'object',
            required: ['finishReason', 'messages'],
            additionalProperties: false,
            properties: {
              finishReason: { type: 'string', enum: ['stop', 'length', 'tool-calls'] },
              messages: { type: 'array', items: { type: 'object' } },
            },
          },
        }),
      ),
    );
    expect(r.kind).toBe('ok');
  });
});

// ---------- maxIterations bounds ----------

describe('loadFlow — maxIterations', () => {
  test('rejects maxIterations = 0', () => {
    const r = loadFlow(outerWith(whileLoopNode({ maxIterations: 0 })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('rejects maxIterations > 10000', () => {
    const r = loadFlow(outerWith(whileLoopNode({ maxIterations: 10001 })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('accepts maxIterations at boundary (1 and 10000)', () => {
    expect(loadFlow(outerWith(whileLoopNode({ maxIterations: 1 }))).kind).toBe('ok');
    expect(loadFlow(outerWith(whileLoopNode({ maxIterations: 10000 }))).kind).toBe('ok');
  });
});

// ---------- foreach concurrency bounds ----------

describe('loadFlow — foreach concurrency', () => {
  test('accepts foreach without concurrency (default sequential)', () => {
    const r = loadFlow(outerWith(foreachLoopNode()));
    expect(r.kind).toBe('ok');
  });

  test('accepts concurrency at lower bound (1)', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ concurrency: 1 })));
    expect(r.kind).toBe('ok');
  });

  test('accepts concurrency at upper safety cap (32)', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ concurrency: 32, maxIterations: 100 })));
    expect(r.kind).toBe('ok');
  });

  test('rejects concurrency 0 (below minimum)', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ concurrency: 0 })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      // Schema-level rejection (minimum: 1) fires before the loader's
      // programmatic check.
      expect(r.error.code).toBe('schema-validation-failed');
    }
  });

  test('rejects concurrency exceeding the safety cap (33)', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ concurrency: 33, maxIterations: 100 })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      // Schema catches values > 32 via maximum; either code is acceptable.
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-invalid-concurrency',
      ).toBe(true);
    }
  });

  test('rejects concurrency > maxIterations (pointless)', () => {
    const r = loadFlow(outerWith(foreachLoopNode({ concurrency: 5, maxIterations: 3 })));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('loop-invalid-concurrency');
      if (r.error.code === 'loop-invalid-concurrency') {
        expect(r.error.reason).toBe('exceeds-max-iterations');
      }
    }
  });

  test('rejects while loop with concurrency (parallel while is semantically undefined)', () => {
    const r = loadFlow(outerWith(whileLoopNode({ concurrency: 2 } as never)));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      // Schema-level `additionalProperties: false` on WhileLoopNode fires
      // before the loader's programmatic variant check; the loader check
      // is belt-and-suspenders for TS callers that bypass the schema.
      expect(
        r.error.code === 'schema-validation-failed' || r.error.code === 'loop-variant-mismatch',
      ).toBe(true);
    }
  });
});

// ---------- body structural checks ----------

describe('loadFlow — loop body validation', () => {
  test('rejects a body with no $loop-start-rooted edge', () => {
    const r = loadFlow(
      outerWith(
        whileLoopNode({
          body: {
            nodes: [bodyNode('worker')],
            edges: [bodyEdge('be1', 'worker', LOOP_END_NODE)],
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('loop-body-missing-start-edge');
  });

  test('rejects a body with a cycle', () => {
    const r = loadFlow(
      outerWith(
        whileLoopNode({
          body: {
            nodes: [bodyNode('a'), bodyNode('b')],
            edges: [
              bodyEdge('be1', LOOP_START_NODE, 'a'),
              bodyEdge('be2', 'a', 'b'),
              bodyEdge('be3', 'b', 'a'),
              bodyEdge('be4', 'b', LOOP_END_NODE),
            ],
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('loop-body-cycle-detected');
  });

  test('rejects a body edge pointing to an unknown node', () => {
    const r = loadFlow(
      outerWith(
        whileLoopNode({
          body: {
            nodes: [bodyNode('worker')],
            edges: [bodyEdge('be1', LOOP_START_NODE, 'worker'), bodyEdge('be2', 'worker', 'ghost')],
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('loop-body-unknown-node-reference');
  });

  test('rejects body node id colliding with outer node id', () => {
    const r = loadFlow(outerWith(whileLoopNode(), [outerNode('worker')]));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-node-id');
  });

  test('rejects body node id equal to $loop-start sentinel', () => {
    const r = loadFlow(
      outerWith(
        whileLoopNode({
          body: {
            nodes: [bodyNode(LOOP_START_NODE)],
            edges: [
              bodyEdge('be1', LOOP_START_NODE, LOOP_START_NODE),
              bodyEdge('be2', LOOP_START_NODE, LOOP_END_NODE),
            ],
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('reserved-id');
  });
});

// ---------- canonical example fixture ----------

describe('loadFlow — canonical fixture', () => {
  test('@kindgi/specs/examples/flow.example.with-loop.json loads and typechecks', () => {
    const path = createRequire(import.meta.url).resolve(
      '@kindgi/specs/examples/flow.example.with-loop.json',
    );
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const r = loadFlow(raw);
    expect(r.kind).toBe('ok');
  });
});

// ---------- nested loops ----------

describe('loadFlow — nested loops', () => {
  test('accepts a foreach whose body contains a while loop', () => {
    const nested = whileLoopNode({
      id: 'inner-loop',
      body: {
        nodes: [bodyNode('inner-worker')],
        edges: [
          bodyEdge('inner-be1', LOOP_START_NODE, 'inner-worker'),
          bodyEdge('inner-be2', 'inner-worker', LOOP_END_NODE),
        ],
      },
    });
    const r = loadFlow(
      outerWith(
        foreachLoopNode({
          body: {
            nodes: [nested],
            edges: [
              bodyEdge('outer-be1', LOOP_START_NODE, 'inner-loop'),
              bodyEdge('outer-be2', 'inner-loop', LOOP_END_NODE),
            ],
          },
        }),
      ),
    );
    expect(r.kind).toBe('ok');
  });

  test('rejects nested loops with colliding node ids across bodies', () => {
    // Inner loop's body-node id is 'shared'; outer loop's body-node id is also 'shared'.
    const nested = whileLoopNode({
      id: 'inner-loop',
      body: {
        nodes: [bodyNode('shared')],
        edges: [
          bodyEdge('inner-be1', LOOP_START_NODE, 'shared'),
          bodyEdge('inner-be2', 'shared', LOOP_END_NODE),
        ],
      },
    });
    const r = loadFlow(
      outerWith(
        foreachLoopNode({
          body: {
            nodes: [bodyNode('shared'), nested],
            edges: [
              bodyEdge('outer-be1', LOOP_START_NODE, 'shared'),
              bodyEdge('outer-be2', 'shared', 'inner-loop'),
              bodyEdge('outer-be3', 'inner-loop', LOOP_END_NODE),
            ],
          },
        }),
      ),
    );
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-node-id');
  });
});
