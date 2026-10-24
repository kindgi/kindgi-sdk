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
  /** When the piece of work started, by the wall clock. */
  readonly at: number;
  /** How long it took, in whole microseconds. */
  readonly us: number;
}

/**
 * One tenant's work in the window: its pieces in the order they started,
 * from `head` on, and their total. Whole microseconds, so adding pieces
 * and dropping them never drifts from what they add up to.
 */
interface Ledger {
  pieces: Spent[];
  head: number;
  spentUs: number;
  /**
   * Once refused: when the tenant is under its budget again. Read only
   * while it's over the budget; a piece charged clears it.
   */
  refusedUntil: number;
}

/**
 * A piece of a tenant's work that runs somewhere else and ends later (a
 * render in a child process), charged for the time from its `start` to
 * its `end`.
 */
export interface TenantWork {
  /** The work started: its time counts from now. A second call changes nothing. */
  start(): void;
  /**
   * The work ended: charges the time since `start`, a failed piece's too.
   * Work that never started is charged nothing. A second call changes nothing.
   */
  end(): void;
}

/** Work no budget counts. */
const UNCOUNTED: TenantWork = Object.freeze({ start: () => undefined, end: () => undefined });

/**
 * The time each tenant spent on one kind of work in the last 60 seconds,
 * against `budgetMs`; `refuse` makes the error for a tenant past it. An
 * infinite budget keeps no count. Charging a piece costs the same however
 * many pieces the window holds.
 */
export class TenantTimeBudget {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly budgetUs: number;
  private sweptAt = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly refuse: (budgetMs: number, retryAfterMs: number) => TenantBudgetError,
    private readonly clock: BudgetClock = SYSTEM_CLOCK,
  ) {
    this.budgetUs = budgetMs * 1_000;
  }

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

  /**
   * For work that runs somewhere else and ends later (a render in a worker
   * thread): refused as `charge` refuses, now, before it's handed over,
   * once the tenant has spent its budget. The work returned is charged for
   * the time from its `start()` to its `end()`, as work that started then,
   * so time it spends waiting to start isn't counted.
   */
  admit(tenant: string): TenantWork {
    if (this.budgetMs === Number.POSITIVE_INFINITY) return UNCOUNTED;
    const now = this.clock.now();
    this.sweep(now);
    this.check(tenant, now);
    let started: { readonly at: number; readonly monotonic: number } | undefined;
    let ended = false;
    return {
      start: () => {
        if (started !== undefined || ended) return;
        started = { at: this.clock.now(), monotonic: this.clock.monotonic() };
      },
      end: () => {
        if (ended) return;
        ended = true;
        if (started === undefined) return;
        this.spend(tenant, started.at, this.clock.monotonic() - started.monotonic);
      },
    };
  }

  /** Once a window: drops the work that left it, and the tenants with none left. */
  private sweep(now: number): void {
    if (now - this.sweptAt <= BUDGET_WINDOW_MS) return;
    this.sweptAt = now;
    for (const [tenant, ledger] of this.ledgers) {
      if (this.inWindow(ledger, now) === 0) this.ledgers.delete(tenant);
    }
  }

  /** Throws `refuse`'s error when `tenant` has spent its budget. */
  private check(tenant: string, now: number): void {
    const ledger = this.ledgerOf(tenant);
    this.inWindow(ledger, now);
    if (ledger.spentUs < this.budgetUs) return;
    // Read after the count, so a wall clock set back never refuses a tenant under its budget.
    if (now < ledger.refusedUntil) throw this.refuse(this.budgetMs, ledger.refusedUntil - now);
    // Under the budget again once enough of the oldest work leaves the window.
    let left = ledger.spentUs;
    let under = now;
    for (let i = ledger.head; i < ledger.pieces.length; i += 1) {
      const spent = ledger.pieces[i] as Spent;
      left -= spent.us;
      under = spent.at + BUDGET_WINDOW_MS;
      if (left < this.budgetUs) break;
    }
    // It holds until a piece is charged: what the tenant starts now is refused.
    ledger.refusedUntil = under;
    throw this.refuse(this.budgetMs, under - now);
  }

  /** Charges `tenant` for work started `at` that took `ms`. */
  private spend(tenant: string, at: number, ms: number): void {
    const ledger = this.ledgerOf(tenant);
    const us = Math.round(ms * 1_000);
    ledger.spentUs += us;
    // A piece that started before a refusal can end after it, and move the wait.
    ledger.refusedUntil = 0;
    // Work ends in the order it started, but for a piece inside another one.
    let i = ledger.pieces.length;
    while (i > ledger.head && (ledger.pieces[i - 1] as Spent).at > at) i -= 1;
    ledger.pieces.splice(i, 0, { at, us });
  }

  /** Drops `ledger`'s work that left the window ending `now`; returns how many pieces are left. */
  private inWindow(ledger: Ledger, now: number): number {
    const { pieces } = ledger;
    while (
      ledger.head < pieces.length &&
      (pieces[ledger.head] as Spent).at <= now - BUDGET_WINDOW_MS
    ) {
      ledger.spentUs -= (pieces[ledger.head] as Spent).us;
      ledger.head += 1;
    }
    // Copied down once as many were dropped as are kept: each piece is copied about once.
    if (ledger.head > 0 && ledger.head * 2 >= pieces.length) {
      ledger.pieces = pieces.slice(ledger.head);
      ledger.head = 0;
    }
    return ledger.pieces.length - ledger.head;
  }

  private ledgerOf(tenant: string): Ledger {
    let ledger = this.ledgers.get(tenant);
    if (ledger === undefined) {
      ledger = { pieces: [], head: 0, spentUs: 0, refusedUntil: 0 };
      this.ledgers.set(tenant, ledger);
    }
    return ledger;
  }
}
