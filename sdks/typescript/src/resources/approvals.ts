// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ApprovalId,
  AuditBundleId,
  Filter,
  ReviewerId,
  RunId,
  Timestamp,
} from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import { singleStatusQuery } from '../status-query.js';
import type { Transport } from '../transport.js';
import type {
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  AuditBundle,
  AuditBundleMeta,
  AuditVerifyResult,
  CompleteApprovalResult,
  Reviewer,
  ReviewerRole,
  ReviewerSpec,
  UnregisterReviewerResult,
} from '../types.js';

/**
 * Approvals resource — human-in-the-loop approval queue.
 *
 * Approval queue, reviewer role classes, and signed audit exports. The
 * API routes:
 *   - `GET  /v1/approvals` (list, role-scoped, cursor-paginated)
 *   - `GET  /v1/approvals/{approvalId}` (fetch, role-scoped)
 *   - `POST /v1/approvals/{approvalId}/complete` (record a decision +
 *     optionally complete the linked run waitpoint in one call)
 *   - `POST /v1/approvals/{approvalId}/audit-bundle` (per-approval
 *     signed export bundle — Ed25519, same envelope as
 *     `provenance.export`)
 *   - `/v1/approvals/reviewers/*` sub-resource (list / get / register /
 *     unregister — roster management outside the reviewer-role gate)
 *
 * Reviewer-role scoping: every `/v1/approvals` route (except the
 * `reviewers` sub-resource) requires the caller's token to carry a
 * `reviewerRole`; reviewers only see approvals whose `requiredRole` rank
 * ≤ their rank (standard < senior < admin). Out-of-scope reads surface
 * as `404 approval-not-found` to avoid cross-tier existence leaks.
 *
 * `batch`, `assign`, `completeToken`, `audit.get`, `audit.list` and
 * `audit.verify` have no API route and throw `not-yet-wired`.
 * `reviewers.updateRole` has no dedicated route either — role rotation
 * happens via re-`register` (idempotent per `(tenantId, userId)`).
 */
export interface ApprovalsClient {
  /**
   * @wire `GET /v1/approvals` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals/get`. Role-scoped.
   */
  list(filter?: ApprovalFilter): Promise<ListPage<Approval>>;

  /**
   * @wire `GET /v1/approvals/{approvalId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1{approvalId}/get`.
   *   Returns `404 approval-not-found` for out-of-scope ids.
   */
  get(id: ApprovalId): Promise<Approval>;

  /**
   * Record a review decision (the HITL binding's `submitReview`). When
   * the approval carries a `waitTokenId` and the decision is `approve`
   * or `reject`, also completes the run's waitpoint so the suspended
   * run can resume.
   *
   * @wire `POST /v1/approvals/{approvalId}/complete` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1{approvalId}~1complete/post`.
   *   Returns `CompleteApprovalResult` (`{ kind, approval, decision,
   *   nextApproval?, waitpointResolved }`) — the recorded decision plus,
   *   when escalated, the next approval. Decisions are
   *   `approve | reject | escalate | withdraw`; the justification field
   *   is `rationale`.
   */
  decide(id: ApprovalId, input: DecideInput): Promise<CompleteApprovalResult>;

  /**
   * @unwired The API has no bulk-decide route; call `decide` per
   *   approval.
   */
  batch(input: BatchDecideInput): Promise<void>;

  /**
   * @unwired The API has no route to reassign an approval; the
   *   required reviewer role is fixed when the approval is created.
   */
  assign(id: ApprovalId, reviewerId: ReviewerId): Promise<void>;

  /**
   * @unwired The API has no standalone complete-token route. Waitpoint
   *   resume is part of `decide`: a terminating decision on an approval
   *   that carries a `waitTokenId` completes the waitpoint. There is no
   *   route that resumes a run without recording a review decision.
   */
  completeToken(id: ApprovalId, input: CompleteTokenInput): Promise<{ readonly runId: RunId }>;

  readonly reviewers: ReviewersClient;
  readonly audit: AuditClient;
}

/**
 * Reviewer roster management. Wire sub-resource
 * `/v1/approvals/reviewers/*` — lives OUTSIDE the reviewer-role gate
 * (registering reviewers is admin, not reviewer-only).
 */
export interface ReviewersClient {
  /**
   * @wire `POST /v1/approvals/reviewers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1reviewers/post`.
   *   Idempotent per `(tenantId, userId)` — re-registering rotates
   *   role/displayName rather than inserting a duplicate. Returns the
   *   full reviewer row (`id`, `tenantId`, `createdAt`, …).
   */
  register(spec: ReviewerSpec, options?: { readonly idempotencyKey?: string }): Promise<Reviewer>;

  /**
   * @wire `GET /v1/approvals/reviewers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1reviewers/get`.
   */
  list(filter?: ReviewerFilter): Promise<ListPage<Reviewer>>;

  /**
   * @wire `GET /v1/approvals/reviewers/{reviewerId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1reviewers~1{reviewerId}/get`.
   */
  get(id: ReviewerId): Promise<Reviewer>;

  /**
   * @unwired The API has no update-role route; re-`register` the
   *   reviewer with the new role instead (idempotent per
   *   `(tenantId, userId)`, it rewrites the role).
   */
  updateRole(id: ReviewerId, role: ReviewerRole): Promise<void>;

  /**
   * Soft-delete a reviewer — historical decisions retained, no new
   * approvals routed. Idempotent on already-deactivated ids (returns
   * `unregistered: true` in either case); unknown ids → `404`.
   *
   * @wire `POST /v1/approvals/reviewers/{reviewerId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1reviewers~1{reviewerId}~1unregister/post`.
   *   Returns `{ reviewerId, unregistered: true }`.
   */
  deactivate(
    id: ReviewerId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterReviewerResult>;
}

/**
 * Signed per-approval audit-bundle exports: one bundle per approval id.
 * Same signature envelope as `provenance.export` so callers reuse a
 * single verifier wrapper.
 */
export interface AuditClient {
  /**
   * Export a signed audit bundle for a decided approval. Server
   * canonicalizes approval + decision + evidence as sorted-key JSON and
   * signs it with the deployment signing key named by `signingKeyId`
   * (Ed25519). Only decided approvals can be exported — pending ones
   * return `409 approval-not-decided`.
   *
   * @wire `POST /v1/approvals/{approvalId}/audit-bundle` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1approvals~1{approvalId}~1audit-bundle/post`.
   *   Returns the signed bundle inline.
   */
  export(input: AuditExportInput): Promise<AuditBundle>;

  /**
   * @unwired The API does not store bundles: `export` returns the
   *   signed body inline and there is no `GET /v1/audit-bundles/{id}`
   *   route. Callers persist the bundle bytes themselves.
   */
  get(id: AuditBundleId): Promise<AuditBundle>;

  /**
   * @unwired The API has no `GET /v1/audit-bundles` route — bundles
   *   are not stored server-side (see `get`).
   */
  list(filter?: Filter): Promise<ListPage<AuditBundleMeta>>;

  /**
   * Verify a bundle's Ed25519 signature client-side.
   *
   * @unwired The SDK does not ship an Ed25519 verifier; the method
   *   throws `not-yet-wired` (as does `provenance.verify`).
   */
  verify(bundle: AuditBundle, publicKey: string): Promise<AuditVerifyResult>;
}

export interface ApprovalFilter extends Omit<Filter<ApprovalStatus>, 'status'> {
  /**
   * One status. `GET /v1/approvals` filters by a single `?status=`;
   * passing several is rejected client-side with `invalid-request`.
   */
  readonly status?: ApprovalStatus;
  /** Only one project's approvals (`kind: 'project'`), or every project's in an org (`kind: 'org'`). */
  readonly scope?: ScopeRef;
  /** Filter by required reviewer role. Caller must have rank ≥ value (else 403). */
  readonly requiredRole?: ReviewerRole;
  /** ISO 8601 timestamp — return approvals created strictly after this. */
  readonly createdAfter?: Timestamp;
  /**
   * Only approvals linked to one of these run waits (an approval's
   * `waitTokenId`; a run's journal names its open waits). At most 50.
   */
  readonly waitTokenIds?: readonly string[];
}

export interface ReviewerFilter extends Filter {
  /** Filter reviewers by role class. */
  readonly role?: ReviewerRole;
}

export interface DecideInput {
  readonly decision: ApprovalDecision;
  /** Free-form justification. Wire field name is `rationale`. */
  readonly rationale?: string;
  /**
   * Optional payload passed to the run's waitpoint (`completeToken`)
   * when the approval is linked to a suspended run and the decision is
   * `approve` or `reject`. Ignored otherwise.
   */
  readonly value?: unknown;
  readonly idempotencyKey?: string;
}

export interface BatchDecideInput {
  readonly ids: readonly ApprovalId[];
  readonly decision: ApprovalDecision;
  readonly rationale?: string;
}

export interface CompleteTokenInput {
  readonly value: unknown;
}

export interface AuditExportInput {
  /** Approval to export a bundle for. */
  readonly approvalId: ApprovalId;
  /** Signing key id from the deployment's `signingKey` binding. */
  readonly signingKeyId: string;
  /** Hydrate conversation messages tied to the approval's run. Default `false`. */
  readonly includeMessages?: boolean;
  readonly idempotencyKey?: string;
}

export function makeApprovalsClient(transport: Transport): ApprovalsClient {
  return {
    async list(filter) {
      const statusParam = singleStatusQuery('approvals.list', filter?.status);
      const page = await transport.request<WirePage<Approval>>({
        method: 'GET',
        path: '/v1/approvals',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(statusParam !== undefined && { status: statusParam }),
          ...(filter?.scope !== undefined && scopeToQuery(filter.scope)),
          ...(filter?.requiredRole !== undefined && { requiredRole: filter.requiredRole }),
          ...(filter?.createdAfter !== undefined && {
            createdAfter: filter.createdAfter as unknown as string,
          }),
          ...(filter?.waitTokenIds !== undefined &&
            filter.waitTokenIds.length > 0 && { waitTokenId: filter.waitTokenIds }),
        },
      });
      return listPage(page);
    },

    async get(id) {
      return transport.request<Approval>({
        method: 'GET',
        path: `/v1/approvals/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async decide(id, input) {
      const body: Record<string, unknown> = { decision: input.decision };
      if (input.rationale !== undefined) body.rationale = input.rationale;
      if (input.value !== undefined) body.value = input.value;
      return transport.request<CompleteApprovalResult>({
        method: 'POST',
        path: `/v1/approvals/${encodeURIComponent(id as unknown as string)}/complete`,
        body,
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      });
    },

    async batch(_input) {
      throw new KindgiApiError(
        notYetWired(
          'approvals.batch',
          'no bulk-decide route on the API — per-approval POST /v1/approvals/{id}/complete is the primitive; a bulk wrapper needs a design on partial-failure semantics',
        ),
      );
    },

    async assign(_id, _reviewerId) {
      throw new KindgiApiError(
        notYetWired(
          'approvals.assign',
          'no per-approval assign route on the API — assignment happens at approval-creation time via HITL binding resolveReviewer, external re-assign is a planned follow-up',
        ),
      );
    },

    async completeToken(_id, _input) {
      throw new KindgiApiError(
        notYetWired(
          'approvals.completeToken',
          'no standalone complete-token route on the API — wire fuses waitpoint resume into POST /v1/approvals/{id}/complete (any decide that terminates + carries a waitTokenId auto-resumes), use approvals.decide instead',
        ),
      );
    },

    reviewers: {
      async register(spec, options) {
        return transport.request<Reviewer>({
          method: 'POST',
          path: '/v1/approvals/reviewers',
          body: {
            userId: spec.userId as unknown as string,
            role: spec.role,
            ...(spec.displayName !== undefined && { displayName: spec.displayName }),
          },
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async list(filter) {
        const page = await transport.request<WirePage<Reviewer>>({
          method: 'GET',
          path: '/v1/approvals/reviewers',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.role !== undefined && { role: filter.role }),
          },
        });
        return listPage(page);
      },

      async get(id) {
        return transport.request<Reviewer>({
          method: 'GET',
          path: `/v1/approvals/reviewers/${encodeURIComponent(id as unknown as string)}`,
        });
      },

      async updateRole(_id, _role) {
        throw new KindgiApiError(
          notYetWired(
            'approvals.reviewers.updateRole',
            'no dedicated update-role route on the API — role rotation happens via re-register (idempotent per (tenantId, userId) rewrites the role), wire only if a bespoke audit-log entry for role changes is needed',
          ),
        );
      },

      async deactivate(id, options) {
        return transport.request<UnregisterReviewerResult>({
          method: 'POST',
          path: `/v1/approvals/reviewers/${encodeURIComponent(id as unknown as string)}/unregister`,
          body: {},
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },
    },

    audit: {
      async export(input) {
        return transport.request<AuditBundle>({
          method: 'POST',
          path: `/v1/approvals/${encodeURIComponent(input.approvalId as unknown as string)}/audit-bundle`,
          body: {
            signingKeyId: input.signingKeyId,
            ...(input.includeMessages !== undefined && {
              includeMessages: input.includeMessages,
            }),
          },
          ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
        });
      },

      async get(_id) {
        throw new KindgiApiError(
          notYetWired(
            'approvals.audit.get',
            'no GET /v1/audit-bundles/{id} route on the API — wire ships the signed body inline from export (bundles are not durably stored server-side today)',
          ),
        );
      },

      async list(_filter) {
        throw new KindgiApiError(
          notYetWired(
            'approvals.audit.list',
            'no GET /v1/audit-bundles route on the API — bundles are not durably stored server-side today',
          ),
        );
      },

      async verify(_bundle, _publicKey) {
        throw new KindgiApiError(
          notYetWired(
            'approvals.audit.verify',
            'client-side verifier requires the crypto module reachability from the SDK bundle — not yet vendored (same constraint as provenance.verify + webhooks.verify)',
          ),
        );
      },
    },
  };
}
