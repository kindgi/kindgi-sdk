// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A budget kept per tenant: what's charged, the 60-second window, when a
 * refused tenant may go again, and that tenants don't share one. The
 * clock is the test's.
 */

import { describe, expect, test } from 'vitest';

import {
  BUDGET_WINDOW_MS,
  type BudgetClock,
  TenantBudgetError,
  TenantTimeBudget,
} from '../src/index.js';

/** A clock that moves only when the test says. */
function testClock() {
  const clock = {
    wall: 1_000_000,
    monotonic: 0,
    later(ms: number): void {
      clock.wall += ms;
      clock.monotonic += ms;
    },
  };
  const reads: BudgetClock = { now: () => clock.wall, monotonic: () => clock.monotonic };
  return { clock, reads };
}

function budgetOf(budgetMs: number) {
  const { clock, reads } = testClock();
  const budget = new TenantTimeBudget(
    budgetMs,
    (budget, retryAfterMs) =>
      new TenantBudgetError('over', 'template-render-time', budget, retryAfterMs),
    reads,
  );
  /** Work that takes `ms`, as `tenant`'s. */
  const work = (tenant: string, ms: number) =>
    budget.charge(tenant, () => {
      clock.later(ms);
      return ms;
    });
  return { budget, clock, work };
}

function refusal(run: () => unknown): TenantBudgetError {
  try {
    run();
  } catch (error) {
    if (error instanceof TenantBudgetError) return error;
    throw error;
  }
  throw new Error('not refused');
}

describe('a budget kept per tenant', () => {
  test('work runs until the tenant has spent its budget; the next is refused before it starts', () => {
    const { budget, work } = budgetOf(5_000);
    expect(work('tenant-a', 3_000)).toBe(3_000);
    // 3 s spent, under 5 s: runs, and takes the tenant past it.
    expect(work('tenant-a', 2_500)).toBe(2_500);
    let ran = false;
    const error = refusal(() =>
      budget.charge('tenant-a', () => {
        ran = true;
      }),
    );
    expect(ran).toBe(false);
    expect(error).toMatchObject({ limit: 'template-render-time', budgetMs: 5_000 });
    // Under again once the first 3 s leave the window: they started 5.5 s ago.
    expect(error.retryAfterMs).toBe(BUDGET_WINDOW_MS - 5_500);
  });

  test('a piece of work that fails is charged too', () => {
    const { budget, clock } = budgetOf(1_000);
    expect(() =>
      budget.charge('tenant-a', () => {
        clock.later(1_000);
        throw new Error('the render failed');
      }),
    ).toThrow('the render failed');
    expect(refusal(() => budget.charge('tenant-a', () => 0)).budgetMs).toBe(1_000);
  });

  test('once the work leaves the 60-second window, the tenant goes again', () => {
    const { budget, clock, work } = budgetOf(1_000);
    work('tenant-a', 1_000);
    const { retryAfterMs } = refusal(() => work('tenant-a', 1));
    clock.later(retryAfterMs - 1);
    refusal(() => work('tenant-a', 1));
    clock.later(1);
    expect(budget.charge('tenant-a', () => 'ran')).toBe('ran');
  });

  test('each tenant has its own budget', () => {
    const { work } = budgetOf(1_000);
    work('tenant-a', 1_000);
    refusal(() => work('tenant-a', 1));
    expect(work('tenant-b', 999)).toBe(999);
  });

  test('an infinite budget refuses nothing and reads no clock', () => {
    const budget = new TenantTimeBudget(
      Number.POSITIVE_INFINITY,
      () => {
        throw new Error('never refused');
      },
      {
        now: () => {
          throw new Error('no clock');
        },
        monotonic: () => {
          throw new Error('no clock');
        },
      },
    );
    for (let i = 0; i < 3; i += 1) expect(budget.charge('tenant-a', () => i)).toBe(i);
  });
});
