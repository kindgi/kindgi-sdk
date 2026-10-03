// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Principal — the composite identity passed to every authz check.
//
// Composed of:
//   actor:       the direct caller (who is REALLY doing this)
//   onBehalfOf:  optional delegator (the user this action serves)
//   scope:       optional downscoping (OAuth-style permission narrowing)
//
// Delegation semantics (as in cloud service-account impersonation and
// OAuth 2.0 token exchange, RFC 8693): the effective permission is the
// INTERSECTION of actor + onBehalfOf + scope. `AuthzCheckBinding.check`
// (`check.ts`) enforces this: it applies the scope filter locally, then
// checks the actor and (if set) `onBehalfOf` against FGA, and returns
// `allowed` only when every link permits the action.
//
// Actor kinds:
//   - `user`            — a human user session
//   - `agent`           — a machine agent acting during a run.
//                         First-class FGA subject; agents get least-
//                         privilege grants (`machineAccessTuple` in
//                         `tuples.ts`).
//   - `service_account` — machine identity for capability-only bearer
//                         tokens (CI/CD, integrations, deploy bots).
//                         First-class FGA subject; grants via
//                         `machineAccessTuple`. NOT tenant admin —
//                         starts with zero authority.
//   - `system`          — framework-initiated action (scheduled jobs,
//                         migrations, cleanup). Maps to the
//                         `user:system` subject, which the deployment's
//                         tenant setup grants tenant admin.
//
// Tools are not principals — they are objects that agents invoke.
//
// The intersection semantic guards against the confused-deputy
// problem: an agent must not be able to escalate a user's authority,
// and a user must not be able to escalate the agent's.
//

import type { TenantId } from '@kindgi/types';

import type { Action } from '@kindgi/authz';

// ============================================================
// TYPES
// ============================================================

export type PrincipalKind = 'user' | 'agent' | 'service_account' | 'system';

export interface PrincipalRef {
  readonly kind: PrincipalKind;
  readonly id: string;
  readonly tenantId: TenantId;
}

export interface DownscopedPermissions {
  /**
   * Whitelist. When set, only these actions are allowed regardless
   * of what FGA says. Matches OAuth 2.0 scope-narrowing.
   */
  readonly allowedActions?: readonly Action[];
  /**
   * Blacklist. When set, these actions are denied even if FGA allows.
   * Applied AFTER allowedActions.
   */
  readonly deniedActions?: readonly Action[];
}

export interface Principal {
  readonly actor: PrincipalRef;
  readonly onBehalfOf?: PrincipalRef;
  readonly scope?: DownscopedPermissions;
}

// ============================================================
// CONSTRUCTORS — thin factories for readable call sites
// ============================================================

export function userPrincipal(userId: string, tenantId: TenantId): Principal {
  return { actor: { kind: 'user', id: userId, tenantId } };
}

export function systemPrincipal(tenantId: TenantId): Principal {
  return { actor: { kind: 'system', id: 'system', tenantId } };
}

/**
 * Build a principal from a service-account token. `id` is typically
 * the token id (or a stable identifier derived from it) so grants can
 * be attached to a specific integration.
 */
export function serviceAccountPrincipal(serviceAccountId: string, tenantId: TenantId): Principal {
  return { actor: { kind: 'service_account', id: serviceAccountId, tenantId } };
}

/**
 * Build a delegated principal: `actor` acting on behalf of `onBehalfOf`.
 * Both must be in the same tenant (checked at construction; mismatches
 * are configuration bugs, not runtime authz denials).
 */
export function delegate(
  actor: PrincipalRef,
  onBehalfOf: PrincipalRef,
  scope?: DownscopedPermissions,
): Principal {
  if (actor.tenantId !== onBehalfOf.tenantId) {
    throw new Error(
      `delegate: cross-tenant delegation not supported (actor.tenantId=${actor.tenantId}, onBehalfOf.tenantId=${onBehalfOf.tenantId})`,
    );
  }
  return {
    actor,
    onBehalfOf,
    ...(scope !== undefined ? { scope } : {}),
  };
}

/**
 * Narrow an existing principal's permissions further. Composable with
 * delegation — an agent-on-behalf-of-user can be additionally scoped
 * to read-only for a specific request.
 */
export function downscope(principal: Principal, scope: DownscopedPermissions): Principal {
  return { ...principal, scope };
}

// ============================================================
// FGA MAPPING — encapsulated in one place
// ============================================================

/**
 * Return the FGA subject string for a PrincipalRef. This is the ONE
 * place that decides how principal kinds map to FGA subjects.
 *
 * - `user`            → `user:${id}` (real user UUID)
 * - `agent`           → `agent:${id}`
 * - `service_account` → `service_account:${id}` (machine identity
 *                       with narrow grants)
 * - `system`          → `user:system` (service identity the tenant's
 *                       setup grants tenant admin; with one FGA store
 *                       per tenant the string never crosses tenant
 *                       boundaries)
 */
export function fgaSubject(ref: PrincipalRef): string {
  switch (ref.kind) {
    case 'user':
      return `user:${ref.id}`;
    case 'agent':
      return `agent:${ref.id}`;
    case 'service_account':
      return `service_account:${ref.id}`;
    case 'system':
      return 'user:system';
  }
}
