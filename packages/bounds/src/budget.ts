// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Budgets kept per tenant: the time a tenant's work of one kind (its
 * schema compiles, its template renders) takes in any 60 seconds. That
 * work holds the event loop while it runs, so a tenant past its budget
 * waits instead of the others: its next piece of that work is refused
 * until the window moves on, and may be retried then. The budget doesn't
 * stop a piece it let start, so a tenant's minute can run past the budget
 * by one piece.
 */

/** The window a budget kept per tenant counts over, in milliseconds. */
export const BUDGET_WINDOW_MS = 60_000;

/** Which budget refused: what the API's refusal names in `details.limit`. */
export type TenantBudgetLimit = 'schema-compile-time' | 'template-render-time';

/**
 * A tenant's work refused: it spent its budget of `budgetMs` (`limit`) in
 * the last 60 seconds, and is under it again after `retryAfterMs`. Every
 * budget's refusal is one of these, so what answers for one (the API, an
 * agent's turn, a run's step) answers for them all.
 */
export class TenantBudgetError extends Error {
  constructor(
    message: string,
    readonly limit: TenantBudgetLimit,
    readonly budgetMs: number,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'TenantBudgetError';
  }
}

/** Where a budget reads the time. */
export interface BudgetClock {
  /** The wall time, in milliseconds: where a piece of work sits in the window. */
  now(): number;
  /** A monotonic time, in milliseconds: how long a piece of work took. */
  monotonic(): number;
}

/** The system's clock, read when asked: `Date.now` and `performance.now`. */
export const SYSTEM_CLOCK: BudgetClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

interface Spent {
  readonly at: number;
  readonly ms: number;
}

/**
 * The time each tenant spent on one kind of work in the last 60 seconds,
 * against `budgetMs`; `refuse` makes the error for a tenant past it. An
 * infinite budget keeps no count.
 */
export class TenantTimeBudget {
  private readonly spent = new Map<string, Spent[]>();
  private sweptAt = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly refuse: (budgetMs: number, retryAfterMs: number) => TenantBudgetError,
    private readonly clock: BudgetClock = SYSTEM_CLOCK,
  ) {}

  /**
   * Runs `work` as `tenant`'s, and returns what it returns: refused with
   * `refuse`'s error, before it starts, once the tenant has spent its
   * budget. Its time is charged, a failed piece's too.
   */
  charge<T>(tenant: string, work: () => T): T {
    if (this.budgetMs === Number.POSITIVE_INFINITY) return work();
    const now = this.clock.now();
    this.sweep(now);
    this.check(tenant, now);
    const started = this.clock.monotonic();
    try {
      return work();
    } finally {
      this.spend(tenant, now, this.clock.monotonic() - started);
    }
  }

  /** Once a window: drops the work that left it. */
  private sweep(now: number): void {
    if (now - this.sweptAt <= BUDGET_WINDOW_MS) return;
    this.sweptAt = now;
    for (const tenant of [...this.spent.keys()]) this.recent(tenant, now);
  }

  /** Throws `refuse`'s error when `tenant` has spent its budget. */
  private check(tenant: string, now: number): void {
    const recent = this.recent(tenant, now);
    let total = recent.reduce((sum, spent) => sum + spent.ms, 0);
    if (total < this.budgetMs) return;
    // Under the budget again once enough of the oldest work leaves the window.
    let under = now;
    for (const spent of recent) {
      total -= spent.ms;
      under = spent.at + BUDGET_WINDOW_MS;
      if (total < this.budgetMs) break;
    }
    throw this.refuse(this.budgetMs, under - now);
  }

  /** Charges `tenant` for work started `at` that took `ms`. */
  private spend(tenant: string, at: number, ms: number): void {
    const list = this.spent.get(tenant);
    if (list === undefined) this.spent.set(tenant, [{ at, ms }]);
    else list.push({ at, ms });
  }

  /** `tenant`'s work in the window ending `now`, oldest first; kept for the next call. */
  private recent(tenant: string, now: number): Spent[] {
    const kept = (this.spent.get(tenant) ?? []).filter(
      (spent) => spent.at > now - BUDGET_WINDOW_MS,
    );
    if (kept.length > 0) this.spent.set(tenant, kept);
    else this.spent.delete(tenant);
    return kept;
  }
}
