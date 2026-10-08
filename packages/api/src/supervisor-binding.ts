// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type {
  AgentId,
  ApprovalId,
  Cursor,
  FixProposalId,
  ObservationId,
  ProvenanceId,
  RunId,
  Semver,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

/**
 * Caller-plugged surface for the supervisor's fix-proposal lifecycle
 * + observation readback. Same shape as
 * `AgentRegistryBinding` / `MemoryBinding` / `ReviewerBinding`: the API
 * package does NOT own supervisor runtime, agent registry, HITL wiring,
 * or eval invocation. A binding implementation composes:
 *
 *   - the supervisor runtime (draft, dry-run, submit for review, apply,
 *     roll back, withdraw, list / get proposals, query observations);
 *   - its `Supervisor` registry (`supervisorId → Supervisor`);
 *   - its agent registry (for the dry-run baseline lookup + `apply`);
 *   - its eval dataset + judge registries and an agent-invocation
 *     closure (all needed by the dry-run);
 *   - its HITL surface (submitting for review enqueues an approval —
 *     the binding surfaces the resulting `ApprovalId` back to the route
 *     so the response body carries it).
 *
 * Every proposal method is tenant-scoped AND supervisor-scoped: callers
 * pass both `tenantId` and `supervisorId`. `supervisorId` comes from the
 * `X-Supervisor-Id` request header — tenant flows from the token,
 * supervisor is a per-request scope the caller supplies.
 *
 * State transitions are enforced by the supervisor runtime
 * (`invalid-transition` domain error). The route layer surfaces those
 * as `409 conflict` with error code
 * `proposal-invalid-state-transition` — out-of-order lifecycle calls
 * are caller/state conflicts.
 *
 * `queryObservations` is the supervisor readback for `/v1/observations`
 * — a straight paginated list over the observation stream. Tenant-scoped
 * only; `supervisorId` is an optional filter, not a mount-time scope.
 */
export interface SupervisorBinding {
  /**
   * Cursor-paginated list of proposals scoped to `(tenantId,
   * supervisorId)`. Filters:
   *   - `status`  — single `FixProposalStatus` value.
   *   - `agentId` — exact match on target agent id.
   *   - `tier`    — `'prompt' | 'retrieval' | 'tool-config'`.
   *
   * Sort order is binding-defined (for example `createdAt desc, id desc`).
   */
  listProposals(input: SupervisorListProposalsInput): Promise<SupervisorProposalPage>;
  /**
   * Get a proposal by id, or `null` when unknown. The route surfaces
   * `null` as `404 proposal-not-found`. The binding MUST also return
   * `null` when the proposal exists but is not owned by the caller's
   * supervisor id — cross-supervisor reads leak tier boundaries the
   * same way cross-tenant reads leak resource existence (avoid via
   * `null → 404` per `docs/API-ROUTE-CONVENTIONS.md` §2.4).
   */
  getProposal(input: SupervisorGetProposalInput): Promise<FixProposal | null>;
  /**
   * Draft a new proposal in `draft` state. The dedup fingerprint is
   * computed from `(tier, agentId, agentVersion, canonical(change))`;
   * duplicate proposals short-circuit to the existing non-terminal row —
   * discriminated on `SupervisorDraftOutcome.kind`.
   */
  draftProposal(input: SupervisorDraftProposalInput): Promise<SupervisorDraftOutcome>;
  /**
   * Trigger a dry-run for a proposal. A dry-run needs a dataset, judges,
   * eval bindings and an agent-invocation closure — all of which the
   * binding assembles from `input.datasetId` / `input.datasetVersion`
   * and its own runtime wiring. Returns the updated proposal (`dry-run-passed` or
   * `dry-run-failed`) or a discriminated error outcome so the route
   * can map `invalid-transition` → `409` without touching the runtime
   * error union directly.
   */
  dryRunProposal(input: SupervisorDryRunProposalInput): Promise<SupervisorDryRunOutcome>;
  /**
   * Submit an approved dry-run proposal for HITL review. The binding
   * forwards the resolved `Supervisor` (for ground-layer enforcement +
   * meta-fix detection) and enqueues the approval. Returns the updated proposal (in
   * `proposed-for-review` state) plus the created approval id so the
   * route can surface it in the response body (the SDK correlates
   * proposal → approval via that id).
   */
  submitReview(input: SupervisorSubmitReviewInput): Promise<SupervisorSubmitReviewOutcome>;
  /**
   * Apply an `approved` proposal — registers a new agent version.
   * Returns a minimal ack shape
   * (`proposalId`, `appliedVersion`, `appliedAt`) rather than the
   * full runtime result — the route body stays lean; callers who
   * need the full `Agent` snapshot can `GET /v1/agents/:agentId`.
   */
  applyProposal(input: SupervisorApplyProposalInput): Promise<SupervisorApplyOutcome>;
  /**
   * Roll back an `applied` proposal — unregisters the applied
   * version from the agent registry + transitions to `rolled-back`.
   */
  rollbackProposal(input: SupervisorRollbackProposalInput): Promise<SupervisorRollbackOutcome>;
  /**
   * Withdraw a non-terminal proposal. Legal from any of
   * `draft | dry-running | dry-run-passed | dry-run-failed |
   * proposed-for-review`. Terminal states surface as
   * `invalid-transition` (which the route maps to 409).
   */
  withdrawProposal(input: SupervisorWithdrawProposalInput): Promise<SupervisorWithdrawOutcome>;
  /**
   * Cursor-paginated observation readback for `/v1/observations`.
   * Tenant-scoped; supervisor/agent/conversation/time-window filters
   * are optional. Returns a discriminated `err` outcome for the runtime
   * failure paths
   * (persistence + envelope decode); the route surfaces those via
   * `statusFor(code)`.
   */
  queryObservations(
    input: SupervisorQueryObservationsInput,
  ): Promise<SupervisorQueryObservationsOutcome>;
}

// ============ inputs ============

export interface SupervisorListProposalsInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly status?: FixProposalStatus;
  readonly agentId?: AgentId;
  readonly tier?: ProposedChange['tier'];
  /**
   * Narrow the list to a specific scope. Absent = no scope narrow
   * (return every row in the tenant the caller can see — admin/audit
   * default).
   *
   * Content-scoped semantics (this binding — fix-proposals attribute
   * to the project of the agent they target):
   * - `{ kind: 'project', projectId }` — rows in that project.
   * - `{ kind: 'org', orgId }` — rows in every project belonging to
   *   that org.
   * - `{ kind: 'tenant', tenantId }` — every row in the tenant.
   *
   * Proposals are content: every row belongs to a project, so `inherit`
   * has no effect here.
   */
  readonly scope?: Scope;
  /**
   * `false` = literal-at-this-scope only (admin/audit view).
   * `true` (default) = inheritance walk (user-facing view).
   * No-op for content-scoped bindings (rows only exist at
   * project-level — there is no upward hierarchy to walk). Kept for
   * uniformity: scope-aware bindings share one filter shape across the
   * SDK and OpenAPI schemas.
   */
  readonly inherit?: boolean;
}

export interface SupervisorGetProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
}

export interface SupervisorDraftProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly tier: ProposedChange['tier'];
  readonly change: ProposedChange['change'];
  readonly patternRefs: readonly PatternRef[];
  readonly hypothesis: string;
  readonly proposerRuleId: string;
}

export interface SupervisorDryRunProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
  /**
   * Dataset the binding uses for the dry-run.
   * The wire carries just `(datasetId, datasetVersion)` — the binding
   * resolves both to the actual `Dataset<TInput, TExpected>` from its
   * own registry.
   */
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly criterion: PassCriterion;
}

export interface SupervisorSubmitReviewInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
  readonly requiredRole?: 'standard' | 'senior' | 'admin';
  readonly expiresAt?: Timestamp;
}

export interface SupervisorApplyProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
  readonly newVersion?: string;
}

export interface SupervisorRollbackProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
  readonly reason: string;
}

export interface SupervisorWithdrawProposalInput {
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly proposalId: FixProposalId;
  readonly reason: string;
}

/**
 * Observation readback filter. Tenant-scoped; every other filter is
 * optional. `since` / `until` bound `observedAt`; `cursor` is an opaque
 * ISO timestamp from a prior page's `nextCursor`. `limit` is clamped by
 * the binding.
 */
export interface SupervisorQueryObservationsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly status?: ObservationStatus;
  readonly supervisorId?: SupervisorId;
  readonly agentId?: AgentId;
  readonly agentVersion?: Semver;
  readonly conversationId?: RunId;
  readonly since?: Timestamp;
  readonly until?: Timestamp;
}

// ============ outputs ============

export interface SupervisorProposalPage {
  readonly data: readonly FixProposal[];
  readonly nextCursor?: Cursor;
}

/**
 * Result of a draft attempt. Deduplication is by
 * `(supervisorId, fingerprint)`:
 *
 *   - `ok`      — a new draft row was inserted.
 *   - `dedup`   — an existing non-terminal proposal has the same
 *                 fingerprint; caller can treat it as their own
 *                 draft. `proposal` is the pre-existing row.
 */
export type SupervisorDraftOutcome =
  | { readonly kind: 'ok'; readonly proposal: FixProposal }
  | { readonly kind: 'dedup'; readonly proposal: FixProposal };

/**
 * Result of a dry-run attempt. `ok` carries the updated proposal
 * (either `dry-run-passed` or `dry-run-failed` — both are legitimate
 * outcomes; `failed` means "the criterion was not met," not "the
 * request errored"). Failure outcomes surface as discriminated errors
 * the route layer maps to specific HTTP statuses.
 */
export type SupervisorDryRunOutcome =
  | { readonly kind: 'ok'; readonly proposal: FixProposal; readonly passed: boolean }
  | { readonly kind: 'not-found'; readonly proposalId: FixProposalId }
  | {
      readonly kind: 'invalid-transition';
      readonly proposalId: FixProposalId;
      readonly from: FixProposalStatus;
      readonly to: FixProposalStatus;
    }
  | {
      /**
       * Wire back `apply-change-failed` (change couldn't be applied
       * against the current baseline), `baseline-mismatch` (proposal
       * targets a stale version), or any other runtime failure. The
       * route maps the code through `statusFor`: the two named codes are
       * `422 unprocessable` (the request was well-formed but the domain
       * state prevents dry-running); unknown codes are `500`.
       */
      readonly kind: 'runtime-error';
      readonly code: string;
      readonly message: string;
    };

export type SupervisorSubmitReviewOutcome =
  | {
      readonly kind: 'ok';
      readonly proposal: FixProposal;
      readonly approvalId: ApprovalId;
      readonly metaFix: boolean;
    }
  | { readonly kind: 'not-found'; readonly proposalId: FixProposalId }
  | {
      readonly kind: 'invalid-transition';
      readonly proposalId: FixProposalId;
      readonly from: FixProposalStatus;
      readonly to: FixProposalStatus;
    }
  | {
      readonly kind: 'ground-layer-violation';
      readonly proposalId: FixProposalId;
      readonly guardrailId: string;
      readonly reason: string;
    }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

export type SupervisorApplyOutcome =
  | {
      readonly kind: 'ok';
      readonly proposalId: FixProposalId;
      readonly appliedVersion: string;
      readonly appliedAt: Timestamp;
    }
  | { readonly kind: 'not-found'; readonly proposalId: FixProposalId }
  | {
      readonly kind: 'invalid-transition';
      readonly proposalId: FixProposalId;
      readonly from: FixProposalStatus;
      readonly to: FixProposalStatus;
    }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

export type SupervisorRollbackOutcome =
  | {
      readonly kind: 'ok';
      readonly proposalId: FixProposalId;
      readonly rolledBackAt: Timestamp;
    }
  | { readonly kind: 'not-found'; readonly proposalId: FixProposalId }
  | {
      readonly kind: 'invalid-transition';
      readonly proposalId: FixProposalId;
      readonly from: FixProposalStatus;
      readonly to: FixProposalStatus;
    }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

export type SupervisorWithdrawOutcome =
  | { readonly kind: 'ok'; readonly proposal: FixProposal }
  | { readonly kind: 'not-found'; readonly proposalId: FixProposalId }
  | {
      readonly kind: 'invalid-transition';
      readonly proposalId: FixProposalId;
      readonly from: FixProposalStatus;
      readonly to: FixProposalStatus;
    }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

export interface SupervisorObservationPage {
  readonly data: readonly Observation[];
  readonly nextCursor?: Cursor;
}

export type SupervisorQueryObservationsOutcome =
  | { readonly kind: 'ok'; readonly page: SupervisorObservationPage }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

// ============ wire types ============
//
// Every field the wire surfaces is declared here, so @kindgi/api does
// not depend on the supervisor runtime's own types. A binding
// implementation maps its types into these shapes.

/**
 * Lifecycle of a fix proposal.
 *
 * `draft` — initial state after `POST /v1/proposals`.
 * `dry-running` — transient state while a dry-run executes.
 * `dry-run-passed` / `dry-run-failed` — dry-run terminated with a
 *   criterion result. `failed` is a legitimate domain outcome, not an
 *   error.
 * `proposed-for-review` — submitted for HITL. `reviewApprovalId` is set.
 * `approved` / `rejected` — HITL terminal states.
 * `applied` — the change materialized. `appliedVersion` + `appliedAt` set.
 * `rolled-back` — a prior `applied` proposal was undone.
 * `withdrawn` — the caller withdrew the proposal before terminal review.
 */
export type FixProposalStatus =
  | 'draft'
  | 'dry-running'
  | 'dry-run-passed'
  | 'dry-run-failed'
  | 'proposed-for-review'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'rolled-back'
  | 'withdrawn';

/** The aggregated fingerprint kind for a failure pattern. */
export type PatternKind =
  | 'guardrail-violation'
  | 'tool-error'
  | 'budget-exceeded'
  | 'model-error'
  | 'aborted';

/**
 * A change to an agent's prompt (the `instructions` string). Three
 * kinds cover the common shapes. Extensible via the `kind` discriminant.
 */
export type PromptChange =
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'replace-section'; readonly section: string; readonly newText: string }
  | { readonly kind: 'replace'; readonly beforeText: string; readonly afterText: string };

/**
 * A retrieval intent — mirror of `Agent.retrieval[]` shape.
 */
export interface RetrievalIntentShape {
  readonly types: readonly string[];
  readonly scope: 'same-conversation' | 'same-user' | 'same-project' | 'tenant';
  readonly limit?: number;
}

export type RetrievalChange =
  | { readonly kind: 'add-intent'; readonly intent: RetrievalIntentShape }
  | { readonly kind: 'remove-intent'; readonly index: number }
  | {
      readonly kind: 'replace-intent';
      readonly index: number;
      readonly intent: RetrievalIntentShape;
    }
  | { readonly kind: 'update-limit'; readonly index: number; readonly limit: number };

export type ToolConfigChange =
  | {
      readonly kind: 'add-tool';
      readonly toolId: string;
      readonly toolVersion: string;
    }
  | { readonly kind: 'remove-tool'; readonly toolId: string }
  | {
      readonly kind: 'set-tools';
      readonly tools: readonly { readonly id: string; readonly version: string }[];
    };

/**
 * The change payload — polymorphic over tier.
 */
export type ProposedChange =
  | { readonly tier: 'prompt'; readonly change: PromptChange }
  | { readonly tier: 'retrieval'; readonly change: RetrievalChange }
  | { readonly tier: 'tool-config'; readonly change: ToolConfigChange };

/**
 * A reference to a failure pattern that motivated a proposal.
 */
export interface PatternRef {
  readonly kind: PatternKind;
  readonly key: string;
  readonly count: number;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly sampleConversations: readonly RunId[];
}

/**
 * A fix proposal drafted by the supervisor. Every field is declared here
 * so the API package does not depend on the supervisor runtime's types.
 */
export interface FixProposal {
  readonly id: FixProposalId;
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly tier: ProposedChange['tier'];
  readonly change: ProposedChange['change'];
  readonly patternRefs: readonly PatternRef[];
  readonly hypothesis: string;
  readonly proposerRuleId: string;
  readonly status: FixProposalStatus;
  readonly fingerprint: string;
  readonly resolutionReason?: string;
  readonly reviewApprovalId?: ApprovalId;
  readonly appliedVersion?: string;
  readonly appliedAt?: Timestamp;
  readonly rolledBackAt?: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly resolvedAt?: Timestamp;
}

/** Dry-run pass criterion. */
export type PassCriterion =
  | { readonly kind: 'min-pass-rate'; readonly minPassRate: number }
  | {
      readonly kind: 'strict-improvement';
      readonly baselinePassRate: number;
      readonly minDelta: number;
    };

/**
 * Classified outcome of an observed turn. The observations route
 * validates the query param against this union.
 */
export type ObservationStatus =
  | 'succeeded'
  | 'guardrail-violation'
  | 'guardrail-warning'
  | 'tool-error'
  | 'model-error'
  | 'budget-exceeded'
  | 'aborted'
  | 'other';

export interface ObservedViolation {
  readonly guardrailId: string;
  readonly action: string;
  readonly severity: string;
  readonly passed: boolean;
  readonly reason?: string;
}

/**
 * Wire shape of a supervisor observation — the atomic unit persisted
 * per observed agent turn. Serialized 1:1 into the `/v1/observations`
 * response body.
 */
export interface Observation {
  readonly id: ObservationId;
  readonly tenantId: TenantId;
  readonly supervisorId: SupervisorId;
  readonly agentId: AgentId;
  readonly agentVersion: string;
  readonly conversationId: RunId;
  readonly turnNumber: number;
  readonly status: ObservationStatus;
  readonly failureCode?: string;
  readonly violations: readonly ObservedViolation[];
  readonly failureDetail?: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  readonly costUsd: string;
  readonly provider?: { readonly id: string; readonly model: string };
  readonly provenanceRef?: {
    readonly runId: RunId;
    readonly provenanceId?: ProvenanceId;
  };
  readonly observedAt: Timestamp;
}
