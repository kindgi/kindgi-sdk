// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The time each tenant's schemas spend compiling, in any 60 seconds,
 * against the bounds' `schemaCompileBudgetMs`. Compiling a large schema
 * holds the event loop (a 256 KiB one up to 0.75 s), so a tenant past its
 * budget waits instead of the others.
 *
 * Which compiles count is the tenant's scope's (`runAsTenant`): every one
 * in a request that publishes schemas (`all`), and otherwise only a
 * schema compiled again (`recompiles`), which is what a tenant whose
 * schemas don't fit in the cache makes each call do. A tenant's first
 * compile of a schema in the process is free, up to `FIRST_COMPILES`
 * schemas; past them, every compile counts. A tenant that compiled
 * nothing for an hour is forgotten, as a restart would forget it: its next
 * compiles are first ones again. The window and the refusal are the
 * bounds' budget kept per tenant (`TenantTimeBudget`).
 */

import {
  BUDGET_WINDOW_MS,
  type BudgetClock,
  SYSTEM_CLOCK,
  TenantBudgetError,
  type TenantScope,
  TenantTimeBudget,
} from '@kindgi/bounds';

/** The schemas a tenant may compile once for free, in a process. */
export const FIRST_COMPILES = 4_096;

/** How long a tenant compiles nothing before it's forgotten. */
export const FORGET_AFTER_MS = 60 * 60_000;

/** A tenant's compile refused: it spent `budgetMs` in the last 60 seconds. Retry after `retryAfterMs`. */
export class SchemaCompileBudgetError extends TenantBudgetError {
  readonly code = 'schema-compile-budget-exceeded';

  constructor(budgetMs: number, retryAfterMs: number) {
    super(
      `Schemas compiled for this workspace took its budget of ${budgetMs} ms in the last 60 seconds: try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.`,
      'schema-compile-time',
      budgetMs,
      retryAfterMs,
    );
    this.name = 'SchemaCompileBudgetError';
  }
}

export class CompileBudget {
  private readonly time: TenantTimeBudget;
  /** Each tenant's schemas compiled once, by key, up to `FIRST_COMPILES`, and when it last compiled. */
  private readonly compiled = new Map<string, { readonly seen: Set<string>; at: number }>();
  private sweptAt = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly clock: BudgetClock = SYSTEM_CLOCK,
  ) {
    this.time = new TenantTimeBudget(
      budgetMs,
      (budget, retryAfterMs) => new SchemaCompileBudgetError(budget, retryAfterMs),
      clock,
    );
  }

  /**
   * Runs `compile`, the compile of the schema `key` (undefined: one that
   * isn't JSON, which always counts), as `scope`'s work. When it counts,
   * it's refused with `SchemaCompileBudgetError` once the tenant has spent
   * its budget, and its time is charged.
   */
  run<T>(scope: TenantScope | undefined, key: string | undefined, compile: () => T): T {
    if (scope === undefined || this.budgetMs === Number.POSITIVE_INFINITY) return compile();
    const now = this.clock.now();
    this.forget(now);
    const seen = this.compiledBy(scope.tenantId, now);
    const first = key !== undefined && !seen.has(key) && seen.size < FIRST_COMPILES;
    if (first && scope.compiles === 'recompiles') {
      seen.add(key);
      return compile();
    }
    // Noted once it runs: a refused compile leaves the schema a first one.
    const noted = first ? key : undefined;
    return this.time.charge(scope.tenantId, () => {
      if (noted !== undefined) seen.add(noted);
      return compile();
    });
  }

  /** The schemas `tenant` has compiled once, by key; it compiles `now`. */
  private compiledBy(tenant: string, now: number): Set<string> {
    const kept = this.compiled.get(tenant);
    if (kept !== undefined) {
      kept.at = now;
      return kept.seen;
    }
    const seen = new Set<string>();
    this.compiled.set(tenant, { seen, at: now });
    return seen;
  }

  /** Once a window: forgets the tenants idle past `FORGET_AFTER_MS`. */
  private forget(now: number): void {
    if (now - this.sweptAt <= BUDGET_WINDOW_MS) return;
    this.sweptAt = now;
    for (const [tenant, kept] of [...this.compiled]) {
      if (now - kept.at >= FORGET_AFTER_MS) this.compiled.delete(tenant);
    }
  }
}
