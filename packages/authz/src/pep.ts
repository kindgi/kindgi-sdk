// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// PEP-side primitives — framework-neutral helpers callable from any
// HTTP layer (Hono, Express, Fastify, gRPC). The Hono middleware of
// `@kindgi/api` lives in `packages/api/src/middleware/`.
//
// Two exports:
//   - `principalFromToken`   — TokenResolution → Principal, honoring
//                              service-account vs user semantics
//   - `denyPayload`          — canonical structured 403 body shape
//

import type { TenantId, UserId } from '@kindgi/types';

import type { Action, ObjectType } from '@kindgi/authz';

import { type Principal, serviceAccountPrincipal, userPrincipal } from './principal.js';

/**
 * Subset of `TokenResolution` (`@kindgi/api`) that principal construction
 * actually needs. Any bearer/session middleware can adapt its shape
 * to this before calling `principalFromToken`.
 */
export interface TokenLike {
  readonly tenantId: TenantId;
  readonly userId?: UserId;
  /**
   * Stable id for a capability-only bearer (service account). When
   * the token carries no `userId`, this becomes the actor id.
   * Deployments typically hash the token or use a token-record uuid.
   */
  readonly tokenId?: string;
}

/**
 * Map a resolved token to a Principal.
 *
 * Priority:
 *   1. userId present → userPrincipal (human session)
 *   2. tokenId present → serviceAccountPrincipal (integration key)
 *   3. Neither → throw (unauthenticated shouldn't reach the PEP)
 *
 * Delegation chains (agent-on-behalf-of-user) are constructed by
 * the caller after this returns — the token itself is always a
 * single principal.
 */
export function principalFromToken(token: TokenLike): Principal {
  if (token.userId !== undefined) {
    return userPrincipal(token.userId, token.tenantId);
  }
  if (token.tokenId !== undefined) {
    return serviceAccountPrincipal(token.tokenId, token.tenantId);
  }
  throw new Error(
    'principalFromToken: token has neither userId nor tokenId — bearer middleware should have rejected earlier',
  );
}

/**
 * Canonical 403 body shape. Structured so clients can distinguish
 * "you didn't have permission" from "your input was invalid" —
 * different remediation flows. Avoids leaking full evidence (that
 * belongs in the audit trail); reason is a human-readable summary
 * safe to return.
 */
export interface DenyPayload {
  readonly code: 'permission-denied';
  readonly action: Action;
  readonly resource: string;
  readonly reason: string;
}

export function denyPayload(
  action: Action,
  resourceType: ObjectType,
  resourceId: string,
  reason: string,
): DenyPayload {
  return {
    code: 'permission-denied',
    action,
    resource: `${resourceType}:${resourceId}`,
    reason,
  };
}
