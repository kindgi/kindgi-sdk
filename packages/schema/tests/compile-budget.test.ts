// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The compile budget's arithmetic: which compiles count, the 60-second
 * window, and when a refused tenant may compile again. The clock and the
 * compiles' durations are the test's.
 */

import type { TenantScope } from '@kindgi/bounds';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CompileBudget,
  FIRST_COMPILES,
  FORGET_AFTER_MS,
  SchemaCompileBudgetError,
} from '../src/compile-budget.js';

let clock = 0;

/** `ms` later, by the system clock. */
function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const recompiles: TenantScope = { tenantId: 'tenant-a', compiles: 'recompiles' };
const all: TenantScope = { tenantId: 'tenant-a', compiles: 'all' };

/** A compile that takes `ms`. */
function taking(ms: number): () => string {
  return () => {
    clock += ms;
    return 'compiled';
  };
}

/** What `budget.run` throws, or undefined. */
function refusedWith(run: () => unknown): SchemaCompileBudgetError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof SchemaCompileBudgetError) return error;
    throw error;
  }
}

describe('CompileBudget', () => {
  test('a first compile is free; the same schema again counts', () => {
    const budget = new CompileBudget(2_000);
    expect(budget.run(recompiles, 'a', taking(5_000))).toBe('compiled');
    expect(budget.run(recompiles, 'b', taking(5_000))).toBe('compiled');
    expect(budget.run(recompiles, 'a', taking(2_000))).toBe('compiled');
    expect(refusedWith(() => budget.run(recompiles, 'b', taking(1)))).toBeInstanceOf(
      SchemaCompileBudgetError,
    );
    // A first compile still goes through.
    expect(budget.run(recompiles, 'c', taking(1))).toBe('compiled');
  });

  test('in a scope that counts all, the first compile counts too', () => {
    const budget = new CompileBudget(2_000);
    budget.run(all, 'a', taking(2_000));
    expect(refusedWith(() => budget.run(all, 'b', taking(1)))).toBeInstanceOf(
      SchemaCompileBudgetError,
    );
    // A refused compile didn't run: in a call's scope, it's still a first compile.
    expect(refusedWith(() => budget.run(recompiles, 'b', taking(1)))).toBeUndefined();
    expect(refusedWith(() => budget.run(recompiles, 'a', taking(1)))).toBeInstanceOf(
      SchemaCompileBudgetError,
    );
  });

  test('the budget plus one compile: the compile that crosses it runs', () => {
    const budget = new CompileBudget(2_000);
    budget.run(all, 'a', taking(1_999));
    expect(budget.run(all, 'b', taking(5_000))).toBe('compiled');
    expect(refusedWith(() => budget.run(all, 'c', taking(1)))).toBeDefined();
  });

  test('refused until enough of the oldest compiles leave the 60-second window', () => {
    const budget = new CompileBudget(2_000);
    budget.run(all, 'a', taking(1_500));
    later(10_000);
    budget.run(all, 'b', taking(1_000));
    later(10_000);
    const refused = refusedWith(() => budget.run(all, 'c', taking(1)));
    // 2,500 ms spent: under again once the first leaves, 60 s after it started.
    expect(refused?.retryAfterMs).toBe(40_000);
    expect(refused?.budgetMs).toBe(2_000);
    expect(refused?.code).toBe('schema-compile-budget-exceeded');
    expect(refused?.message).toBe(
      'Schemas compiled for this workspace took its budget of 2000 ms in the last 60 seconds: try again in 40 s.',
    );
    later(39_999);
    expect(refusedWith(() => budget.run(all, 'c', taking(1)))).toBeDefined();
    later(1);
    expect(budget.run(all, 'c', taking(1))).toBe('compiled');
  });

  test('a compile that throws is charged all the same', () => {
    const budget = new CompileBudget(2_000);
    expect(() =>
      budget.run(all, 'a', () => {
        clock += 2_000;
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(refusedWith(() => budget.run(all, 'b', taking(1)))).toBeDefined();
  });

  test('each tenant has its own budget', () => {
    const budget = new CompileBudget(2_000);
    budget.run(all, 'a', taking(2_000));
    expect(refusedWith(() => budget.run(all, 'b', taking(1)))).toBeDefined();
    expect(budget.run({ tenantId: 'tenant-b', compiles: 'all' }, 'b', taking(1))).toBe('compiled');
  });

  test(`past ${FIRST_COMPILES} first compiles, every compile counts`, () => {
    const budget = new CompileBudget(2_000);
    for (let n = 0; n < FIRST_COMPILES; n += 1) budget.run(recompiles, `first-${n}`, taking(1_000));
    budget.run(recompiles, 'one-more', taking(2_000));
    expect(refusedWith(() => budget.run(recompiles, 'another', taking(1)))).toBeDefined();
  });

  test('a tenant that compiled nothing for an hour is forgotten: its compiles are first ones again', () => {
    const budget = new CompileBudget(2_000);
    budget.run(recompiles, 'a', taking(1));
    later(FORGET_AFTER_MS - 1);
    budget.run(all, 'x', taking(2_000));
    // Still remembered: compiling `a` again counts, past the budget.
    expect(refusedWith(() => budget.run(recompiles, 'a', taking(1)))).toBeDefined();
    later(FORGET_AFTER_MS);
    budget.run(all, 'y', taking(2_000));
    // Forgotten, as after a restart: `a` is a first compile again, and free.
    expect(budget.run(recompiles, 'a', taking(1))).toBe('compiled');
  });

  test('a schema that isn’t JSON always counts', () => {
    const budget = new CompileBudget(2_000);
    budget.run(recompiles, undefined, taking(2_000));
    expect(refusedWith(() => budget.run(recompiles, undefined, taking(1)))).toBeDefined();
  });

  test('outside a scope, or with no budget, nothing is refused', () => {
    const budget = new CompileBudget(2_000);
    for (let n = 0; n < 3; n += 1)
      expect(budget.run(undefined, 'a', taking(5_000))).toBe('compiled');
    const none = new CompileBudget(Number.POSITIVE_INFINITY);
    for (let n = 0; n < 3; n += 1) expect(none.run(all, 'a', taking(5_000))).toBe('compiled');
  });
});
