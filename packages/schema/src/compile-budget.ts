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
 * schemas; past them, every compile counts. A compile isn't stopped part
 * way, so a tenant's minute can run past the budget by one compile.
 */

import type { TenantScope } from '@kindgi/bounds';

const WINDOW_MS = 60_000;

/** The schemas a tenant may compile once for free, in a process. */
export const FIRST_COMPILES = 4_096;

/** A tenant's compile refused: it spent `budgetMs` in the last 60 seconds. Retry after `retryAfterMs`. */
export class SchemaCompileBudgetError extends Error {
  readonly code = 'schema-compile-budget-exceeded';

  constructor(
    readonly budgetMs: number,
    readonly retryAfterMs: number,
  ) {
    super(
      `Schemas compiled for this tenant took its budget of ${budgetMs} ms in the last 60 seconds: try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.`,
    );
    this.name = 'SchemaCompileBudgetError';
  }
}

interface Spent {
  readonly at: number;
  readonly ms: number;
}

export class CompileBudget {
  private readonly spent = new Map<string, Spent[]>();
  /** Each tenant's schemas compiled once, by key, up to `FIRST_COMPILES`. */
  private readonly compiled = new Map<string, Set<string>>();
  private sweptAt = 0;

  constructor(private readonly budgetMs: number) {}

  /**
   * Runs `compile`, the compile of the schema `key` (undefined: one that
   * isn't JSON, which always counts), as `scope`'s work. When it counts,
   * it's refused with `SchemaCompileBudgetError` once the tenant has spent
   * its budget, and its time is charged.
   */
  run<T>(scope: TenantScope | undefined, key: string | undefined, compile: () => T): T {
    if (scope === undefined || this.budgetMs === Number.POSITIVE_INFINITY) return compile();
    const seen = this.compiledBy(scope.tenantId);
    const first = key !== undefined && !seen.has(key) && seen.size < FIRST_COMPILES;
    if (first && scope.compiles === 'recompiles') {
      seen.add(key);
      return compile();
    }
    const now = Date.now();
    this.check(scope.tenantId, now);
    // Noted once it runs: a refused compile leaves the schema a first one.
    if (first) seen.add(key);
    const started = performance.now();
    try {
      return compile();
    } finally {
      this.spend(scope.tenantId, now, performance.now() - started);
    }
  }

  /** The schemas `tenant` has compiled once, by key. */
  private compiledBy(tenant: string): Set<string> {
    let seen = this.compiled.get(tenant);
    if (seen === undefined) {
      seen = new Set();
      this.compiled.set(tenant, seen);
    }
    return seen;
  }

  /** Throws `SchemaCompileBudgetError` when `tenant` has spent its budget. */
  private check(tenant: string, now: number): void {
    const recent = this.recent(tenant, now);
    let total = recent.reduce((sum, spent) => sum + spent.ms, 0);
    if (total < this.budgetMs) return;
    // Under the budget again once enough of the oldest compiles leave the window.
    let under = now;
    for (const spent of recent) {
      total -= spent.ms;
      under = spent.at + WINDOW_MS;
      if (total < this.budgetMs) break;
    }
    throw new SchemaCompileBudgetError(this.budgetMs, under - now);
  }

  /** Charges `tenant` for a compile started `at` that took `ms`. */
  private spend(tenant: string, at: number, ms: number): void {
    const list = this.spent.get(tenant);
    if (list === undefined) this.spent.set(tenant, [{ at, ms }]);
    else list.push({ at, ms });
    // Tenants that stopped compiling, dropped once a window.
    if (at - this.sweptAt > WINDOW_MS) {
      this.sweptAt = at;
      for (const other of [...this.spent.keys()]) this.recent(other, at);
    }
  }

  /** `tenant`'s compiles in the window ending `now`, oldest first; kept for the next call. */
  private recent(tenant: string, now: number): Spent[] {
    const kept = (this.spent.get(tenant) ?? []).filter((spent) => spent.at > now - WINDOW_MS);
    if (kept.length > 0) this.spent.set(tenant, kept);
    else this.spent.delete(tenant);
    return kept;
  }
}
