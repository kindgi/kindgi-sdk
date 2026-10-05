// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ReviewerRole } from '@kindgi/authz';
import type { Cursor, ReviewerId, TenantId, Timestamp, UserId } from '@kindgi/types';

/**
 * Translates the bearer-token identity (`UserId`) into the `ReviewerId`
 * that `HitlBinding.submitReview` needs, and the reviewer role the
 * approvals surface is scoped by. The API package intentionally does
 * NOT own the `user ↔ reviewer` mapping — deployments plug that in via
 * this binding, same pattern as `TokenResolver` (for auth read) and
 * `TokenAdmin` (for mint/revoke).
 *
 * Both return `null` when the user has no active reviewer row for the
 * tenant (leads to `403 permission-denied` from the approvals route).
 */
export interface ReviewerBinding {
  resolveReviewer(input: ReviewerLookupInput): Promise<ReviewerId | null>;
  /**
   * The user's reviewer role in the tenant. Consulted for a token that
   * carries no `reviewerRole` of its own (a session or API key of a
   * registered reviewer), so the roster, not the token, says who reviews.
   * A binding without it: only a token that carries its role reviews.
   */
  resolveReviewerRole?(input: ReviewerLookupInput): Promise<ReviewerRole | null>;
}

export interface ReviewerLookupInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

// ================ ReviewerRegistryBinding ================

/**
 * Caller-plugged surface for the reviewer roster. Same pattern as
 * `AgentRegistryBinding` / `ToolRegistryBinding`: the API package does
 * NOT own persistence. Deployments wire the runtime's reviewer store —
 * or their own — through this binding.
 *
 * Distinct from `ReviewerBinding` (which resolves a token's `UserId` to
 * a `ReviewerId`): a deployment may want a durable registry backend for
 * the roster surface while keeping the resolver in-process. Callers
 * mount them independently.
 */
export interface ReviewerRegistryBinding {
  list(input: ReviewerListInput): Promise<ReviewerPage>;
  get(input: ReviewerGetInput): Promise<ReviewerRecord | null>;
  register(input: ReviewerRegisterInput): Promise<ReviewerRegisterOutcome>;
  /**
   * Unregister a reviewer. Semantic is "soft-delete / deactivate" so
   * the audit trail survives — reviewer stops receiving approvals but
   * historical decisions still resolve. Returns
   * `{ unregistered: false }` when the id is unknown; the route flips
   * that to `404`.
   */
  unregister(input: ReviewerUnregisterInput): Promise<ReviewerUnregisterOutcome>;
}

export interface ReviewerListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly role?: ReviewerRole;
}

export interface ReviewerGetInput {
  readonly tenantId: TenantId;
  readonly reviewerId: ReviewerId;
}

export interface ReviewerRegisterInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: ReviewerRole;
  readonly displayName?: string;
}

export interface ReviewerUnregisterInput {
  readonly tenantId: TenantId;
  readonly reviewerId: ReviewerId;
}

export interface ReviewerRecord {
  readonly id: ReviewerId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: ReviewerRole;
  readonly displayName?: string;
  readonly createdAt: Timestamp;
  readonly deactivatedAt?: Timestamp;
}

export interface ReviewerPage {
  readonly data: readonly ReviewerRecord[];
  readonly nextCursor?: Cursor;
}

export type ReviewerRegisterOutcome = {
  readonly kind: 'ok';
  readonly reviewer: ReviewerRecord;
};

export type ReviewerUnregisterOutcome = {
  readonly unregistered: boolean;
};
