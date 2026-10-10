// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// HITL binding surface — types + `HitlBinding` interface consumed by
// the approvals routes. Deployments plug in an implementation (the
// Kindgi runtime provides one); @kindgi/api never touches HITL storage
// directly.
//

import type { ReviewerRole } from '@kindgi/authz';
import type {
  ApprovalId,
  Cursor,
  ListScope,
  ProjectId,
  ProvenanceId,
  Result,
  ReviewerId,
  RunId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

// ---------- domain type surface ----------

export type ApprovalStatus =
  | 'pending'
  | 'assigned'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'expired'
  | 'withdrawn';

export type ReviewDecisionKind = 'approve' | 'reject' | 'escalate' | 'withdraw';

export interface Approval {
  readonly id: ApprovalId;
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly subjectKind: string;
  readonly subjectRef: Readonly<Record<string, unknown>>;
  readonly requiredRole: ReviewerRole;
  readonly status: ApprovalStatus;
  readonly assignedTo?: ReviewerId;
  readonly batchKey?: string;
  readonly title?: string;
  readonly description?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly provenanceRef?: {
    readonly runId: RunId;
    readonly provenanceId?: ProvenanceId;
  };
  readonly waitTokenId?: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly decidedAt?: Timestamp;
  readonly expiresAt?: Timestamp;
  /**
   * The reviewer's decision, once one is recorded. Absent while the
   * approval is open, and when it ended without one (it expired, or a
   * timeout escalated it).
   */
  readonly decision?: ReviewDecisionRecord;
}

export interface ReviewDecision {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly approvalId: ApprovalId;
  readonly reviewerId: ReviewerId;
  readonly decision: ReviewDecisionKind;
  readonly rationale?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly reviewerRoleAtDecision: ReviewerRole;
  readonly decidedAt: Timestamp;
}

// ---------- method inputs / outputs ----------

export interface ListApprovalsBindingInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  /** Only one project's approvals, or every project's in an org. Absent: the tenant's. */
  readonly scope?: ListScope;
  readonly status?: ApprovalStatus;
  /**
   * Only approvals in one of these statuses. With `status` too, both
   * apply. A binding that ignores it lists more: the route keeps only
   * these.
   */
  readonly statuses?: readonly ApprovalStatus[];
  /**
   * Only approvals assigned to this reviewer. A binding that ignores it
   * lists more: the route keeps only these.
   */
  readonly assignedTo?: ReviewerId;
  /**
   * `asc`: oldest first (`createdAt` asc, then `id` asc), and `after`
   * continues in that order. Default `desc`. A binding says which it
   * applied in `ListApprovalsBindingResult.order`.
   */
  readonly order?: 'asc' | 'desc';
  readonly requiredRole?: ReviewerRole;
  readonly since?: Timestamp;
  /** A bare time: approvals created before it. Milliseconds, no tie-breaker; `after` replaces it. */
  readonly cursor?: Cursor;
  /**
   * Only approvals whose `waitTokenId` is one of these: the approvals a
   * run's open waits belong to (T272). Absent: no filter.
   */
  readonly waitTokenIds?: readonly string[];
  /**
   * Only approvals after this one in the list's order (`createdAt` desc,
   * then `id` desc; ascending with `order: 'asc'`): where a page that
   * ended on it continues. Its `createdAt` is the binding's
   * `exactCreatedAt` for it.
   */
  readonly after?: ApprovalPosition;
}

/**
 * Where a page of approvals ends: an approval's `createdAt` as stored
 * (Postgres keeps microseconds), and its id. A JS `Date` keeps
 * milliseconds: a position built from one skips the approvals created
 * earlier in the same millisecond.
 */
export interface ApprovalPosition {
  readonly createdAt: string;
  readonly id: ApprovalId;
}

export interface ListApprovalsBindingResult {
  readonly approvals: readonly Approval[];
  readonly nextCursor?: Cursor;
  /**
   * The order the approvals are in: `asc` when the binding applied
   * `order: 'asc'`. Absent: `desc` (newest first), as a binding that
   * doesn't know `order` lists.
   */
  readonly order?: 'asc' | 'desc';
  /**
   * Each listed approval's `createdAt` as stored (microseconds), by id:
   * with the id, the `after` that continues past it. Absent from a binding
   * that doesn't give it; a caller then continues by `cursor`.
   */
  readonly exactCreatedAt?: Readonly<Record<string, string>>;
}

export interface SubmitReviewBindingInput {
  readonly tenantId: TenantId;
  readonly approvalId: ApprovalId;
  readonly reviewerId: ReviewerId;
  readonly decision: ReviewDecisionKind;
  readonly rationale?: string;
}

/**
 * Two shapes: `terminal` — reviewer's decision terminated the approval;
 * `escalated` — a new higher-tier approval was opened. Consumers narrow
 * `nextApproval` via the discriminant.
 */
export type SubmitReviewBindingResult =
  | { readonly kind: 'terminal'; readonly approval: Approval; readonly decision: ReviewDecision }
  | {
      readonly kind: 'escalated';
      readonly approval: Approval;
      readonly decision: ReviewDecision;
      readonly nextApproval: Approval;
    };

/**
 * An approval's recorded decision: on the approval it decided
 * (`Approval.decision`), and for the audit-bundle route. `null` from
 * `loadReviewDecision` = the approval terminated without a recorded
 * decision (e.g. status `expired`).
 */
export interface ReviewDecisionRecord {
  readonly decision: ReviewDecisionKind;
  /**
   * Who decided, as an actor: `user:<userId>`, the reviewer's user.
   * Absent from a binding that doesn't record it (the Kindgi runtime does).
   */
  readonly decidedBy?: string;
  readonly reviewerId: ReviewerId;
  readonly reviewerRoleAtDecision: ReviewerRole;
  readonly decidedAt: Timestamp;
  readonly rationale?: string;
}

// ---------- error shape ----------

/**
 * Structural error surface returned by `HitlBinding` methods.
 * Implementations emit these codes (`approval-not-found`,
 * `reviewer-not-found`, `reviewer-deactivated`, `insufficient-role`,
 * `approval-terminal`, `approval-already-decided`, `invalid-transition`,
 * `persistence-error`) — the routes pass them through to `statusFor()` /
 * `toWireError()`, which key off the string.
 */
export interface HitlBindingError {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

// ---------- binding ----------

/**
 * Approvals data-access binding. Every method takes typed inputs and
 * returns `Promise<Result<T, HitlBindingError>>`. The implementation
 * owns its storage, so callers never touch it directly; the Kindgi
 * runtime provides one.
 */
export interface HitlBinding {
  getApproval(
    tenantId: TenantId,
    approvalId: ApprovalId,
  ): Promise<Result<Approval, HitlBindingError>>;

  listApprovals(
    input: ListApprovalsBindingInput,
  ): Promise<Result<ListApprovalsBindingResult, HitlBindingError>>;

  submitReview(
    input: SubmitReviewBindingInput,
  ): Promise<Result<SubmitReviewBindingResult, HitlBindingError>>;

  /**
   * Hydrate the recorded decision row for an approval — used by the
   * audit-bundle route. Returns `null` when the approval terminated
   * without a recorded decision (status `expired`). `getApproval` and
   * `listApprovals` return the same decision on each approval.
   */
  loadReviewDecision(
    tenantId: TenantId,
    approvalId: ApprovalId,
  ): Promise<Result<ReviewDecisionRecord | null, HitlBindingError>>;
}
