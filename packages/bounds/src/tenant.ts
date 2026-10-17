// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whose work this is: the tenant a budget kept per tenant charges
 * (`schemaCompileBudgetMs`, `templateRenderBudgetMs`), and which of its
 * compiles count. The API runs each authenticated request with
 * `runAsTenant`, and a request that publishes schemas in a scope of its
 * own that counts every compile; a server that does a tenant's work
 * outside a request (a run, a job) wraps it the same way. The scope is an
 * `AsyncLocalStorage` context: it follows `fn`'s own awaits and callbacks,
 * never another request's, however they interleave. Outside any scope
 * (boot, Kindgi's own work), nothing is charged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which of a tenant's schema compiles count against its budget.
 * `recompiles`: compiling a schema again, after the cache dropped it; the
 * first compile of a schema the tenant published doesn't count, so a
 * restarted server compiles each tenant's schemas freely. `all`: every
 * compile, for a request that publishes, deploys or registers schemas,
 * which is where new ones come from.
 */
export type TenantCompiles = 'recompiles' | 'all';

/** The tenant whose work is running, and which of its compiles count. */
export interface TenantScope {
  readonly tenantId: string;
  readonly compiles: TenantCompiles;
}

/** `runAsTenant`'s options. */
export interface RunAsTenantOptions {
  /** Which of the tenant's compiles count: `recompiles` unless set. */
  readonly compiles?: TenantCompiles;
}

const scopes = new AsyncLocalStorage<TenantScope>();

/** Runs `fn` as `tenantId`'s work, and returns what it returns. */
export function runAsTenant<T>(tenantId: string, fn: () => T, options: RunAsTenantOptions = {}): T {
  return scopes.run({ tenantId, compiles: options.compiles ?? 'recompiles' }, fn);
}

/**
 * Runs `fn` outside any tenant's scope, and returns what it returns: for
 * Kindgi's own work that a tenant's request happens to start (compiling
 * one of Kindgi's schemas the first time, say), which no tenant is
 * charged for.
 */
export function runOutsideTenant<T>(fn: () => T): T {
  return scopes.exit(fn);
}

/** Whose work this is, or undefined outside `runAsTenant`. */
export function currentTenant(): TenantScope | undefined {
  return scopes.getStore();
}
