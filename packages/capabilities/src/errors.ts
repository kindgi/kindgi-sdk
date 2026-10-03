// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Errors emitted by @kindgi/capabilities. Every variant carries a `code`
 * for pattern matching; messages are human-readable, not API contract.
 */
export type CapabilityError =
  | InvalidCapabilityError
  | InvalidProviderError
  | DuplicateProviderError
  | CapabilityUnsatisfiableError
  | BudgetExceededError;

/** `defineCapability` rejected the declaration shape (schema mismatch). */
export interface InvalidCapabilityError {
  readonly code: 'invalid-capability';
  readonly message: string;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/** Provider registration (`createProviderRegistry(...).register`) rejected the metadata shape. */
export interface InvalidProviderError {
  readonly code: 'invalid-provider';
  readonly message: string;
  readonly reason: string;
}

/** Provider registration was called with an id already registered for the tenant. */
export interface DuplicateProviderError {
  readonly code: 'duplicate-provider';
  readonly message: string;
  readonly providerId: string;
}

/**
 * The router couldn't find any provider satisfying the capability
 * declaration + tenant policy. `reasons` explains which requirement
 * rejected which `(provider, model)` candidate.
 */
export interface CapabilityUnsatisfiableError {
  readonly code: 'capability-unsatisfiable';
  readonly message: string;
  /**
   * One entry per requirement, indicating which providers matched
   * and which didn't. Each rejection carries a structured
   * `RejectionReason` — callers can `switch (r.reason.code)` to route
   * on specific failure modes (e.g. surface an "add region" tip when
   * every failure is `region-mismatch`).
   */
  readonly reasons: readonly {
    readonly requirement: string;
    readonly satisfyingProviders: readonly string[];
    readonly rejectingProviders: readonly {
      readonly id: string;
      readonly reason: import('./types.js').RejectionReason;
    }[];
  }[];
  readonly tenantId?: TenantId;
}

/**
 * A model invocation exceeded the caller's declared `budget`. Cost meter
 * emits this either pre-flight (if the estimated cost is already over
 * budget) or post-flight (if actual cost overran).
 */
export interface BudgetExceededError {
  readonly code: 'budget-exceeded';
  readonly message: string;
  readonly limit: { readonly kind: 'cost' | 'tokens' | 'duration'; readonly value: number };
  readonly actual: number;
}
