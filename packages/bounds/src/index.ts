// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  type TenantInputBounds,
  configureTenantInputBounds,
  tenantInputBounds,
} from './bounds.js';
export {
  BUDGET_WINDOW_MS,
  type BudgetClock,
  SYSTEM_CLOCK,
  TenantBudgetError,
  type TenantBudgetLimit,
  TenantTimeBudget,
  type TenantWork,
} from './budget.js';
export {
  type CompiledTenantPattern,
  type TenantPattern,
  compileTenantPattern,
  tenantPatternSyntaxProblem,
} from './pattern.js';
export {
  type RunAsTenantOptions,
  type TenantCompiles,
  type TenantScope,
  currentTenant,
  runAsTenant,
  runOutsideTenant,
} from './tenant.js';
