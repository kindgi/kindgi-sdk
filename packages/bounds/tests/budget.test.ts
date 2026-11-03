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

  test('many small pieces: each one counts, and leaves the window on its own', () => {
    const { budget, clock, work } = budgetOf(1_000);
    // 4,000 pieces of 0.25 ms, one every 10.25 ms: the whole budget, in 41 s.
    for (let i = 0; i < 4_000; i += 1) {
      work('tenant-a', 0.25);
      clock.later(10);
    }
    const { retryAfterMs } = refusal(() => work('tenant-a', 0.25));
    // Under again once the first piece leaves the window.
    expect(retryAfterMs).toBe(BUDGET_WINDOW_MS - 41_000);
    // Once the first 3,000 have left, the last 1,000 hold 250 ms: 750 ms more runs, and no more.
    // (Timed on the monotonic clock alone, so no more pieces leave while it runs.)
    clock.later(retryAfterMs + 2_999 * 10.25);
    expect(
      budget.charge('tenant-a', () => {
        clock.monotonic += 750;
        return 750;
      }),
    ).toBe(750);
    refusal(() => work('tenant-a', 0.25));
    // Once all of them have left, the whole budget runs again.
    clock.later(BUDGET_WINDOW_MS);
    expect(work('tenant-a', 999.75)).toBe(999.75);
    expect(work('tenant-a', 0.25)).toBe(0.25);
    refusal(() => work('tenant-a', 0.25));
  });

  test('work is kept in the order it started, when the wall clock is set back', () => {
    const { clock, work } = budgetOf(1_000);
    work('tenant-a', 600);
    clock.wall -= 30_000;
    work('tenant-a', 600);
    // The second piece started first by the wall clock, so it leaves the window first.
    expect(refusal(() => work('tenant-a', 1)).retryAfterMs).toBe(BUDGET_WINDOW_MS - 600);
  });

  test('a tenant under its budget goes, when the wall clock is set back after a refusal', () => {
    const { clock, work } = budgetOf(1_000);
    work('tenant-a', 1_000);
    const { retryAfterMs } = refusal(() => work('tenant-a', 1));
    clock.later(retryAfterMs);
    expect(work('tenant-a', 100)).toBe(100);
    clock.wall -= 10_000;
    expect(work('tenant-a', 100)).toBe(100);
  });

  test('a tenant whose work left the window while it charged nothing goes, when the wall clock is set back', () => {
    const { clock, work } = budgetOf(1_000);
    work('tenant-a', 900);
    clock.later(10_000);
    work('tenant-a', 100);
    refusal(() => work('tenant-a', 1));
    // Past the wait, another tenant's work drops tenant-a's first piece: 100 ms of it are left.
    clock.later(50_000);
    work('tenant-b', 1);
    clock.wall -= 10_000;
    expect(work('tenant-a', 100)).toBe(100);
  });

  test('work that started before a refusal and ends after it moves the wait', () => {
    const { budget, clock, work } = budgetOf(1_000);
    work('tenant-a', 600);
    budget.charge('tenant-a', () => {
      // Inside it: work that takes the tenant to its budget, then work that's refused.
      work('tenant-a', 400);
      refusal(() => work('tenant-a', 1));
      clock.later(600);
    });
    // The outer piece started 1 s ago and took 1 s: the tenant is under again once it leaves.
    expect(refusal(() => work('tenant-a', 1)).retryAfterMs).toBe(BUDGET_WINDOW_MS - 1_000);
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
    const work = budget.admit('tenant-a');
    work.start();
    work.end();
  });
});

describe('work that runs elsewhere (admit)', () => {
  test('charged from its start to its end, as work that started then: the wait before it is not', () => {
    const { budget, clock } = budgetOf(1_000);
    const work = budget.admit('tenant-a');
    // Queued 5 s behind other work, then 1 s on its own.
    clock.later(5_000);
    work.start();
    clock.later(1_000);
    work.end();
    const error = refusal(() => budget.admit('tenant-a'));
    expect(error.budgetMs).toBe(1_000);
    // It started 1 s ago, not 6: the tenant is under again once it leaves the window.
    expect(error.retryAfterMs).toBe(BUDGET_WINDOW_MS - 1_000);
  });

  test('refused when admitted, once the tenant has spent its budget, before anything starts', () => {
    const { budget, work } = budgetOf(1_000);
    work('tenant-a', 1_000);
    expect(refusal(() => budget.admit('tenant-a')).retryAfterMs).toBe(BUDGET_WINDOW_MS - 1_000);
    expect(budget.admit('tenant-b')).toBeDefined();
  });

  test('admitted work and work charged here share one budget', () => {
    const { budget, clock, work } = budgetOf(1_000);
    const elsewhere = budget.admit('tenant-a');
    elsewhere.start();
    clock.later(600);
    elsewhere.end();
    expect(work('tenant-a', 400)).toBe(400);
    refusal(() => work('tenant-a', 1));
  });

  test('work that never started is charged nothing; a second start or end changes nothing', () => {
    const { budget, clock } = budgetOf(1_000);
    const dropped = budget.admit('tenant-a');
    clock.later(5_000);
    dropped.end();
    dropped.start();
    clock.later(5_000);
    dropped.end();
    const twice = budget.admit('tenant-a');
    twice.start();
    clock.later(600);
    twice.start();
    twice.end();
    clock.later(600);
    twice.end();
    // Only 600 ms charged: still under the budget.
    expect(budget.admit('tenant-a')).toBeDefined();
  });

  test('ends out of the order they started: each is charged as work that started when it did', () => {
    const { budget, clock } = budgetOf(1_000);
    const first = budget.admit('tenant-a');
    const second = budget.admit('tenant-a');
    first.start();
    clock.later(100);
    second.start();
    clock.later(500);
    second.end();
    clock.later(400);
    first.end();
    // 1,000 + 500 ms charged; under again once the first (started 1 s ago) leaves.
    expect(refusal(() => budget.admit('tenant-a')).retryAfterMs).toBe(BUDGET_WINDOW_MS - 1_000);
  });
});
