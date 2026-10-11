// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentId,
  Cursor,
  FixProposalId,
  LiveScope,
  ObservationId,
  ProjectId,
  ProvenanceId,
  RunId,
  Semver,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

/**
 * Caller-plugged store behind improvement proposals (`/v1/proposals`)
 * and the supervisor's observation readback (`/v1/observations`). Same
 * shape as `AgentRegistryBinding` / `MemoryBinding`: the API package
 * doesn't own the storage.
 *
 * A proposal is a change to one data block an agent version pins (new
 * settings values, or a new prompt template), for one live scope. The
 * API package runs its lifecycle from bindings that exist already:
 * evaluating publishes the block version and derives the agent version
 * (both serve nowhere until promoted) and starts a comparison eval run;
 * requesting runs the scope's gated promotion. This binding only keeps
 * the rows: what was proposed, then each step's outcome, recorded with
 * a compare-and-set on `revision`. A proposal's status is never stored:
 * the route derives it from the eval run and the promotion
 * (`proposalStatus`).
 *
 * `queryObservations` is the supervisor readback for `/v1/observations`
 * — a straight paginated list over the observation stream. Tenant-scoped
 * only; `supervisorId` is an optional filter.
 */
export interface SupervisorBinding {
  /**
   * Cursor-paginated proposals in the tenant, newest first
   * (`createdAt desc, id desc`). Filters are optional.
   */
  listProposals(input: ListProposalsInput): Promise<StoredProposalPage>;
  /** One proposal, or `null` when the tenant has none with that id. */
  getProposal(input: GetProposalInput): Promise<StoredProposal | null>;
  /**
   * Store a new proposal at revision 1. One with the same `fingerprint`
   * that isn't withdrawn yet answers `dedup` with that row instead.
   */
  createProposal(input: CreateProposalInput): Promise<CreateProposalOutcome>;
  /**
   * Record a step on a proposal if it's still at `expectRevision`; the
   * row's revision goes up by one. `conflict` when another call recorded
   * a step first: the caller reads it again.
   */
  recordProposal(input: RecordProposalInput): Promise<RecordProposalOutcome>;
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

// ============ proposals ============

/** What a proposal changes: a data block the agent version pins. */
export type ProposalTier = 'settings-block' | 'prompt-block';

/**
 * The change: one block, from the version the agent version pins, to new
 * content. Settings proposals give new `values` (the schema carries
 * over); prompt proposals give a new `template` (the parameters carry
 * over).
 */
export type ProposedChange =
  | {
      readonly tier: 'settings-block';
      readonly change: {
        readonly blockId: string;
        readonly fromVersion: string;
        readonly content: { readonly values: Readonly<Record<string, unknown>> };
      };
    }
  | {
      readonly tier: 'prompt-block';
      readonly change: {
        readonly blockId: string;
        readonly fromVersion: string;
        readonly content: { readonly template: string };
      };
    };

/** Who wrote a proposal: a person, or one of the runtime's drafters. */
export type ProposalDrafter =
  | { readonly kind: 'person'; readonly by: string }
  | {
      readonly kind: 'settings-optimizer' | 'prompt-drafter';
      readonly version: string;
      readonly model?: { readonly providerId: string; readonly model: string };
      /** The improvement pass that drafted it. */
      readonly passId?: string;
    };

/** What a proposal rests on. */
export interface ProposalEvidence {
  /** The judgments that motivated it. */
  readonly judgmentIds?: readonly string[];
}

/** The versions evaluating a proposal published: inert until a promotion makes them live. */
export interface ProposalCandidate {
  /** The derived agent version (`derivedFrom.proposalId` names this proposal). */
  readonly agentVersion: string;
  /** The block version published from the proposal's content. */
  readonly blockVersion: string;
  readonly pinsDigest: string;
}

/** The metric that says whether a candidate is better. */
export type ProposalObjective = 'weightedYesShare' | 'weightedPrecisionAtK';

/** The comparison a proposal was evaluated with. */
export interface ProposalEvaluationRef {
  readonly evalRunId: string;
  readonly suiteId: string;
  readonly objective: ProposalObjective;
  readonly startedAt: Timestamp;
}

/** A proposal as the binding stores it (no status: that's derived). */
export interface StoredProposal {
  readonly id: FixProposalId;
  readonly tenantId: TenantId;
  /** The agent version's project, when known. */
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  /** The agent version the change applies to. */
  readonly fromVersion: string;
  /** The live scope it's for. */
  readonly scope: LiveScope;
  readonly tier: ProposalTier;
  readonly change: ProposedChange['change'];
  readonly hypothesis: string;
  readonly evidence?: ProposalEvidence;
  readonly drafter: ProposalDrafter;
  /** Dedup key: the same change for the same scope is one proposal. */
  readonly fingerprint: string;
  /** Goes up by one with each recorded step. */
  readonly revision: number;
  readonly candidate?: ProposalCandidate;
  readonly evaluation?: ProposalEvaluationRef;
  /** The promotion its request made (the latest, after a re-request). */
  readonly promotionId?: string;
  readonly rolledBack?: {
    readonly at: Timestamp;
    /** The rollback's own promotion row. */
    readonly promotionId: string;
    readonly by: string;
    readonly reason?: string;
  };
  readonly withdrawn?: { readonly at: Timestamp; readonly by: string; readonly reason: string };
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface ListProposalsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly agentId?: AgentId;
  readonly tier?: ProposalTier;
  /** Only proposals for exactly this live scope. */
  readonly liveScope?: LiveScope;
}

export interface GetProposalInput {
  readonly tenantId: TenantId;
  readonly proposalId: FixProposalId;
}

export interface CreateProposalInput {
  readonly tenantId: TenantId;
  /** The agent version's project, when the agent store records one: what a scoped list narrows by. */
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly tier: ProposalTier;
  readonly change: ProposedChange['change'];
  readonly hypothesis: string;
  readonly evidence?: ProposalEvidence;
  readonly drafter: ProposalDrafter;
  readonly fingerprint: string;
}

export type CreateProposalOutcome =
  | { readonly kind: 'ok'; readonly proposal: StoredProposal }
  | { readonly kind: 'dedup'; readonly proposal: StoredProposal };

/**
 * One step's outcome, recorded on the proposal. An `evaluation` replaces
 * the one before and clears `promotionId`: a new comparison starts the
 * request over. A `candidate` is recorded once.
 */
export type ProposalStep =
  | { readonly kind: 'candidate'; readonly candidate: ProposalCandidate }
  | { readonly kind: 'evaluation'; readonly evaluation: ProposalEvaluationRef }
  | { readonly kind: 'promotion'; readonly promotionId: string }
  | { readonly kind: 'rolled-back'; readonly rolledBack: NonNullable<StoredProposal['rolledBack']> }
  | { readonly kind: 'withdrawn'; readonly withdrawn: NonNullable<StoredProposal['withdrawn']> };

export interface RecordProposalInput {
  readonly tenantId: TenantId;
  readonly proposalId: FixProposalId;
  readonly expectRevision: number;
  readonly step: ProposalStep;
}

export type RecordProposalOutcome =
  | { readonly kind: 'ok'; readonly proposal: StoredProposal }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict'; readonly proposal: StoredProposal };

export interface StoredProposalPage {
  readonly data: readonly StoredProposal[];
  readonly nextCursor?: Cursor;
}

// ============ observations ============

/**
 * Observation readback filter. Tenant-scoped; every other filter is
 * optional. `since` / `until` bound `observedAt`; `cursor` is an opaque
 * ISO timestamp from a prior page's `nextCursor`; `after` is a prior
 * page's `next`. `limit` is clamped by the binding.
 */
export interface SupervisorQueryObservationsInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  /** A bare time: observations before it. No tie-breaker; `after` replaces it. */
  readonly cursor?: Cursor;
  /**
   * Only observations after this one in the list's order (`observedAt`
   * desc, then `id` desc): where a page that ended on it continues.
   */
  readonly after?: ObservationPosition;
  readonly status?: ObservationStatus;
  readonly supervisorId?: SupervisorId;
  readonly agentId?: AgentId;
  readonly agentVersion?: Semver;
  readonly conversationId?: RunId;
  readonly since?: Timestamp;
  readonly until?: Timestamp;
}

export interface SupervisorObservationPage {
  readonly data: readonly Observation[];
  readonly nextCursor?: Cursor;
  /**
   * Where the next page starts: the page's last observation, its
   * `observedAt` as stored and its id. Set with `nextCursor`. Absent from
   * a binding that doesn't give it: the caller then continues by
   * `nextCursor`, a bare time that skips observations at the same instant.
   */
  readonly next?: ObservationPosition;
}

/** Where a page of observations ends: an observation's `observedAt` as stored, and its id. */
export interface ObservationPosition {
  readonly observedAt: string;
  readonly id: string;
}

export type SupervisorQueryObservationsOutcome =
  | { readonly kind: 'ok'; readonly page: SupervisorObservationPage }
  | { readonly kind: 'runtime-error'; readonly code: string; readonly message: string };

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
