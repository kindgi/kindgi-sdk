// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The time each tenant's templates spend rendering, in any 60 seconds,
 * against the bounds' `templateRenderBudgetMs`. A render holds the event
 * loop while it runs, or one of a few render workers, so a tenant past its
 * budget waits instead of the others. Only a render done as a tenant's work
 * (`runAsTenant`) counts; outside any scope, nothing is charged.
 */

import {
  type BudgetClock,
  SYSTEM_CLOCK,
  TenantBudgetError,
  type TenantInputBounds,
  TenantTimeBudget,
  type TenantWork,
  currentTenant,
  tenantInputBounds,
} from '@kindgi/bounds';

/** A tenant's render refused: it spent `budgetMs` in the last 60 seconds. Retry after `retryAfterMs`. */
export class TemplateRenderBudgetError extends TenantBudgetError {
  readonly code = 'template-render-budget-exceeded';

  constructor(budgetMs: number, retryAfterMs: number) {
    super(
      `Templates rendered for this workspace took its budget of ${budgetMs} ms in the last 60 seconds: try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.`,
      'template-render-time',
      budgetMs,
      retryAfterMs,
    );
    this.name = 'TemplateRenderBudgetError';
  }
}

/** A render budget of `budgetMs` per tenant, read from `clock`. */
export function renderBudget(
  budgetMs: number,
  clock: BudgetClock = SYSTEM_CLOCK,
): TenantTimeBudget {
  return new TenantTimeBudget(
    budgetMs,
    (budget, retryAfterMs) => new TemplateRenderBudgetError(budget, retryAfterMs),
    clock,
  );
}

let state: { readonly bounds: TenantInputBounds; readonly budget: TenantTimeBudget } | undefined;

/** The render budget under the process's bounds: a new one when they change (a test's override). */
function currentBudget(): TenantTimeBudget {
  const bounds = tenantInputBounds();
  if (state?.bounds !== bounds) {
    state = { bounds, budget: renderBudget(bounds.templateRenderBudgetMs) };
  }
  return state.budget;
}

/**
 * Runs `render` as the current tenant's work, under its render budget:
 * refused with `TemplateRenderBudgetError` once the tenant has spent it.
 */
export function chargeRender<T>(render: () => T): T {
  const scope = currentTenant();
  if (scope === undefined) return render();
  return currentBudget().charge(scope.tenantId, render);
}

/** A render no budget counts: one done outside any tenant's scope. */
const UNCOUNTED: TenantWork = Object.freeze({ start: () => undefined, end: () => undefined });

/**
 * For a render done in a child process, as the current tenant's work:
 * refused now with `TemplateRenderBudgetError`, before it's queued, once
 * the tenant has spent its render budget. The render is charged for the
 * time from the work's `start()` (a worker took it) to its `end()`, the
 * same budget a render on this thread is charged to.
 */
export function admitRender(): TenantWork {
  const scope = currentTenant();
  if (scope === undefined) return UNCOUNTED;
  return currentBudget().admit(scope.tenantId);
}
