// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { NodeId } from '@kindgi/types';

import { type EvalEnv, MISSING_PATH, evaluateExpr, resolvePath } from '../src/index.js';
import type { Expr } from '../src/index.js';

function env(over: Partial<EvalEnv> = {}): EvalEnv {
  return {
    runInput: { userId: 'u1', role: 'admin', tags: ['a', 'b'] },
    state: { count: 3, ready: true, note: '' },
    nodeOutputs: new Map<NodeId, unknown>([
      ['classify' as NodeId, { category: 'contract', score: 0.9 }],
      ['null-node' as NodeId, null],
    ]),
    ...over,
  };
}

describe('resolvePath', () => {
  test('runInput root walks the object', () => {
    expect(resolvePath('runInput.role', env())).toBe('admin');
  });
  test('state root walks the object', () => {
    expect(resolvePath('state.count', env())).toBe(3);
  });
  test('nodeOutputs.<id>.<field> walks node result', () => {
    expect(resolvePath('nodeOutputs.classify.category', env())).toBe('contract');
  });
  test('missing segment resolves to MISSING', () => {
    expect(resolvePath('runInput.absent', env())).toBe(MISSING_PATH);
  });
  test('walking into a null intermediate resolves to MISSING', () => {
    expect(resolvePath('nodeOutputs.null-node.x', env())).toBe(MISSING_PATH);
  });
  test('unknown node id resolves to MISSING', () => {
    expect(resolvePath('nodeOutputs.unknown.x', env())).toBe(MISSING_PATH);
  });
  test('unknown root resolves to MISSING', () => {
    expect(resolvePath('facts.x', env())).toBe(MISSING_PATH);
  });
});

describe('evaluateExpr — comparisons', () => {
  test('eq true when literals match', () => {
    const e: Expr = { op: 'eq', left: { path: 'runInput.role' }, right: { literal: 'admin' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('eq false when literals differ', () => {
    const e: Expr = { op: 'eq', left: { path: 'runInput.role' }, right: { literal: 'guest' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('eq false when either operand missing (missing != anything)', () => {
    const e: Expr = { op: 'eq', left: { path: 'runInput.absent' }, right: { literal: 'x' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('ne true when operands differ', () => {
    const e: Expr = { op: 'ne', left: { path: 'runInput.role' }, right: { literal: 'guest' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('lt / lte / gt / gte on numbers', () => {
    const mk = (op: 'lt' | 'lte' | 'gt' | 'gte', rhs: number): Expr => ({
      op,
      left: { path: 'state.count' },
      right: { literal: rhs },
    });
    expect(evaluateExpr(mk('lt', 5), env())).toBe(true);
    expect(evaluateExpr(mk('lte', 3), env())).toBe(true);
    expect(evaluateExpr(mk('gt', 2), env())).toBe(true);
    expect(evaluateExpr(mk('gte', 3), env())).toBe(true);
    expect(evaluateExpr(mk('lt', 3), env())).toBe(false);
  });
  test('ordering compares mixed types → false (no coercion)', () => {
    const e: Expr = { op: 'lt', left: { path: 'state.count' }, right: { literal: '5' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('path-vs-path comparison', () => {
    const e: Expr = {
      op: 'gt',
      left: { path: 'nodeOutputs.classify.score' },
      right: { literal: 0.5 },
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
});

describe('evaluateExpr — in / notIn', () => {
  test('in true when set contains value', () => {
    const e: Expr = {
      op: 'in',
      value: { literal: 'a' },
      set: { path: 'runInput.tags' },
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('in false when set missing value', () => {
    const e: Expr = { op: 'in', value: { literal: 'z' }, set: { path: 'runInput.tags' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('in false when set is not an array', () => {
    const e: Expr = { op: 'in', value: { literal: 'a' }, set: { path: 'runInput.role' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('notIn inverts membership', () => {
    const e: Expr = { op: 'notIn', value: { literal: 'z' }, set: { path: 'runInput.tags' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
});

describe('evaluateExpr — exists / truthy', () => {
  test('exists true for present path even if value is empty string', () => {
    const e: Expr = { op: 'exists', value: { path: 'state.note' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('exists false for missing path', () => {
    const e: Expr = { op: 'exists', value: { path: 'state.absent' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('notExists inverts', () => {
    const e: Expr = { op: 'notExists', value: { path: 'state.absent' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('truthy uses JS truthiness on the resolved value', () => {
    const e: Expr = { op: 'truthy', value: { path: 'state.ready' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('truthy false when value is empty string', () => {
    const e: Expr = { op: 'truthy', value: { path: 'state.note' } };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('falsy of missing path → true', () => {
    const e: Expr = { op: 'falsy', value: { path: 'state.absent' } };
    expect(evaluateExpr(e, env())).toBe(true);
  });
});

describe('evaluateExpr — and / or / not', () => {
  test('and requires all children true', () => {
    const e: Expr = {
      op: 'and',
      children: [
        { op: 'eq', left: { path: 'runInput.role' }, right: { literal: 'admin' } },
        { op: 'truthy', value: { path: 'state.ready' } },
      ],
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('and short-circuits false', () => {
    const e: Expr = {
      op: 'and',
      children: [
        { op: 'eq', left: { path: 'runInput.role' }, right: { literal: 'guest' } },
        { op: 'truthy', value: { path: 'state.ready' } },
      ],
    };
    expect(evaluateExpr(e, env())).toBe(false);
  });
  test('or true when any child true', () => {
    const e: Expr = {
      op: 'or',
      children: [
        { op: 'eq', left: { path: 'runInput.role' }, right: { literal: 'guest' } },
        { op: 'truthy', value: { path: 'state.ready' } },
      ],
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('not inverts', () => {
    const e: Expr = {
      op: 'not',
      child: { op: 'exists', value: { path: 'state.absent' } },
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
});

describe('evaluateExpr — loop context roots', () => {
  test('iterationIndex root resolves when populated', () => {
    const e: Expr = {
      op: 'gte',
      left: { path: 'iterationIndex' },
      right: { literal: 3 },
    };
    expect(evaluateExpr(e, { iterationIndex: 5 })).toBe(true);
    expect(evaluateExpr(e, { iterationIndex: 1 })).toBe(false);
  });

  test('iterationIndex outside loop context → MISSING (predicates evaluate to false)', () => {
    const e: Expr = {
      op: 'gte',
      left: { path: 'iterationIndex' },
      right: { literal: 0 },
    };
    expect(evaluateExpr(e, {})).toBe(false);
  });

  test('iterationOutput root walks like other roots', () => {
    const e: Expr = {
      op: 'eq',
      left: { path: 'iterationOutput.finishReason' },
      right: { literal: 'stop' },
    };
    expect(evaluateExpr(e, { iterationOutput: { finishReason: 'stop' } })).toBe(true);
    expect(evaluateExpr(e, { iterationOutput: { finishReason: 'length' } })).toBe(false);
  });

  test('iterationOutput = null (while+before iteration 0) resolves as null, not MISSING', () => {
    const e: Expr = {
      op: 'exists',
      value: { path: 'iterationOutput' },
    };
    expect(evaluateExpr(e, { iterationOutput: null })).toBe(true);
    expect(evaluateExpr(e, {})).toBe(false);
  });
});

describe('evaluateExpr — deep equality of arrays / objects', () => {
  test('eq array-vs-array structural', () => {
    const e: Expr = {
      op: 'eq',
      left: { path: 'runInput.tags' },
      right: { literal: ['a', 'b'] },
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
  test('eq object-vs-object structural', () => {
    const e: Expr = {
      op: 'eq',
      left: { path: 'nodeOutputs.classify' },
      right: { literal: { category: 'contract', score: 0.9 } },
    };
    expect(evaluateExpr(e, env())).toBe(true);
  });
});
