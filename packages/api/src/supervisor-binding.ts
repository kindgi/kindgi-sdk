// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentId,
  Cursor,
  LiveScope,
  ObservationId,
  ProjectId,
  ProvenanceId,
  RunId,
  Semver,
  SuggestedChangeId,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { PromotionActor } from './live-version-binding.js';

/**
 * Caller-plugged store behind suggested changes (`/v1/suggested-changes`)
 * and the supervisor's observation readback (`/v1/observations`). Same
 * shape as `AgentRegistryBinding` / `MemoryBinding`: the API package
 * doesn't own the storage.
 *
 * A suggested change is a change to one data block an agent version pins (new
 * settings values, or a new prompt template), for one live scope. The
 * API package runs its lifecycle from bindings that exist already:
 * evaluating publishes the block version and derives the agent version
 * (both serve nowhere until promoted) and starts a comparison test run;
 * requesting runs the scope's gated promotion. This binding only keeps
 * the rows: what was proposed, then each step's outcome, recorded with
 * a compare-and-set on `revision`. A suggested change's status is never stored:
 * the route derives it from the test run and the promotion
 * (`suggestedChangeStatus`).
 *
 * `queryObservations` is the supervisor readback for `/v1/observations`
 * — a straight paginated list over the observation stream. Tenant-scoped
 * only; `supervisorId` is an optional filter.
 */
export interface SupervisorBinding {
  /**
   * Cursor-paginated suggested changes in the tenant, newest first
   * (`createdAt desc, id desc`). Filters are optional.
   */
  listSuggestedChanges(input: ListSuggestedChangesInput): Promise<StoredSuggestedChangePage>;
  /** One suggested change, or `null` when the tenant has none with that id. */
  getSuggestedChange(input: GetSuggestedChangeInput): Promise<StoredSuggestedChange | null>;
  /**
   * Store a new suggested change at revision 1. One with the same `fingerprint`
   * that isn't withdrawn yet answers `dedup` with that row instead.
   */
  createSuggestedChange(input: CreateSuggestedChangeInput): Promise<CreateSuggestedChangeOutcome>;
  /**
   * Record a step on a suggested change if it's still at `expectRevision`; the
   * row's revision goes up by one. `conflict` when another call recorded
   * a step first: the caller reads it again.
   */
  recordSuggestedChange(input: RecordSuggestedChangeInput): Promise<RecordSuggestedChangeOutcome>;
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

// ============ suggested changes ============

/** What a suggested change changes: a data block the agent version pins. */
export type SuggestedChangeTier = 'settings-block' | 'prompt-block';

/**
 * The change: one block, from the version the agent version pins, to new
 * content. Settings suggested changes give new `values` (the schema carries
 * over); prompt suggested changes give a new `template` (the parameters carry
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

/** Who wrote a suggested change: a person, or one of the runtime's drafters. */
export type SuggestedChangeDrafter =
  | { readonly kind: 'person'; readonly by: string }
  | {
      readonly kind: 'settings-optimizer' | 'prompt-drafter';
      readonly version: string;
      readonly model?: { readonly providerId: string; readonly model: string };
      /** The improvement pass that drafted it. */
      readonly passId?: string;
    };

/**
 * Who or what made a suggested change: an Improve run, a person, a
 * service account, a deploy (for each pinned project its new version
 * reaches) or an offer (a change pinned in another project, offered to
 * one on Latest).
 */
export type SuggestedChangeMaker =
  | { readonly kind: 'improve-run'; readonly improveRunId: string; readonly scheduleId?: string }
  | { readonly kind: 'person'; readonly userId: string }
  | { readonly kind: 'service'; readonly id: string }
  | { readonly kind: 'deploy'; readonly deploymentId: string; readonly by: PromotionActor }
  | { readonly kind: 'offer'; readonly fromProjectId: string; readonly pinChangeId: string };

/** What a suggested change rests on. */
export interface SuggestedChangeEvidence {
  /** The corrections it fixes, by id. */
  readonly fixes?: readonly string[];
  /**
   * How many corrections it rests on, when `fixes` names only the first
   * of them: an improvement pass names at most 100. Absent when `fixes`
   * names them all.
   */
  readonly correctionCount?: number;
}

/** The versions evaluating a suggested change published: inert until a promotion makes them live. */
export interface SuggestedChangeCandidate {
  /** The derived agent version (`derivedFrom.suggestedChangeId` names this suggested change). */
  readonly agentVersion: string;
  /** The block version published from the suggested change's content. */
  readonly blockVersion: string;
  readonly pinsDigest: string;
}

/** The metric that says whether a candidate is better. */
export type SuggestedChangeObjective = 'weightedYesShare' | 'weightedPrecisionAtK';

/**
 * How a candidate is kept: `better`, it beat the recorded outputs on the
 * objective by more than the noise; `cheaper`, it's no worse than the
 * current version on the same cases (beyond the spread) and costs less
 * (beyond the cost's own spread).
 */
export type SuggestedChangeRule = 'better' | 'cheaper';

/** The comparison a suggested change was evaluated with. */
export interface SuggestedChangeEvaluationRef {
  readonly testRunId: string;
  readonly testSetId: string;
  readonly objective: SuggestedChangeObjective;
  readonly startedAt: Timestamp;
  /** How the candidate is kept. Absent: `better`. */
  readonly rule?: SuggestedChangeRule;
  /**
   * The current version replayed on the same cases: the comparison the
   * candidate's corrections and cost are held to. Set for a change to the
   * model-settings block an improvement pass suggests: no correction the
   * current version passes may fail, whichever the rule.
   */
  readonly reference?: { readonly testRunId: string };
}

/** A suggested change as the binding stores it (no status: that's derived). */
export interface StoredSuggestedChange {
  readonly id: SuggestedChangeId;
  readonly tenantId: TenantId;
  /** The agent version's project, when known. */
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  /** The agent version the change applies to. */
  readonly fromVersion: string;
  /** The live scope it's for. */
  readonly scope: LiveScope;
  readonly tier: SuggestedChangeTier;
  readonly change: ProposedChange['change'];
  readonly hypothesis: string;
  readonly evidence?: SuggestedChangeEvidence;
  readonly drafter: SuggestedChangeDrafter;
  /**
   * Who or what made it. Absent on one stored before it was recorded:
   * read from `drafter` (`suggestedChangeMaker`).
   */
  readonly madeBy?: SuggestedChangeMaker;
  /**
   * The version it's built on, once a rebuild moved it there (its
   * project's version changed first). Absent: `fromVersion`.
   */
  readonly builtOnVersion?: string;
  /** When it was last rebuilt. */
  readonly rebuiltAt?: Timestamp;
  /** Its version, added as its project's Latest: when, and by whom (`user:<id>`). */
  readonly addedAsLatest?: { readonly at: Timestamp; readonly by: string };
  /** Dedup key: the same change for the same scope is one suggested change. */
  readonly fingerprint: string;
  /** Goes up by one with each recorded step. */
  readonly revision: number;
  readonly candidate?: SuggestedChangeCandidate;
  readonly evaluation?: SuggestedChangeEvaluationRef;
  /** The promotion its pin made (the latest, after a re-pin). */
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

export interface ListSuggestedChangesInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly agentId?: AgentId;
  readonly tier?: SuggestedChangeTier;
  /** Only suggested changes for exactly this live scope. */
  readonly liveScope?: LiveScope;
}

export interface GetSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly suggestedChangeId: SuggestedChangeId;
}

export interface CreateSuggestedChangeInput {
  readonly tenantId: TenantId;
  /** The agent version's project, when the agent store records one: what a scoped list narrows by. */
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly tier: SuggestedChangeTier;
  readonly change: ProposedChange['change'];
  readonly hypothesis: string;
  readonly evidence?: SuggestedChangeEvidence;
  readonly drafter: SuggestedChangeDrafter;
  readonly madeBy: SuggestedChangeMaker;
  readonly fingerprint: string;
}

export type CreateSuggestedChangeOutcome =
  | { readonly kind: 'ok'; readonly suggestedChange: StoredSuggestedChange }
  | { readonly kind: 'dedup'; readonly suggestedChange: StoredSuggestedChange };

/**
 * One step's outcome, recorded on the suggested change. An `evaluation` replaces
 * the one before and clears `promotionId`: a new comparison starts the
 * request over. A `candidate` is recorded once.
 */
export type SuggestedChangeStep =
  | { readonly kind: 'candidate'; readonly candidate: SuggestedChangeCandidate }
  | { readonly kind: 'evaluation'; readonly evaluation: SuggestedChangeEvaluationRef }
  | { readonly kind: 'promotion'; readonly promotionId: string }
  | {
      readonly kind: 'withdrawn';
      readonly withdrawn: NonNullable<StoredSuggestedChange['withdrawn']>;
    };

export interface RecordSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly suggestedChangeId: SuggestedChangeId;
  readonly expectRevision: number;
  readonly step: SuggestedChangeStep;
}

export type RecordSuggestedChangeOutcome =
  | { readonly kind: 'ok'; readonly suggestedChange: StoredSuggestedChange }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict'; readonly suggestedChange: StoredSuggestedChange };

export interface StoredSuggestedChangePage {
  readonly data: readonly StoredSuggestedChange[];
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

/**
 * A page, or the runtime's failure to read one. A failure's `cause` is the
 * error it came from, if any: a storage failure marked `database-busy` down
 * it answers a GET `503` with `Retry-After`, not the code's status. It
 * never reaches the response body.
 */
export type SupervisorQueryObservationsOutcome =
  | { readonly kind: 'ok'; readonly page: SupervisorObservationPage }
  | {
      readonly kind: 'runtime-error';
      readonly code: string;
      readonly message: string;
      readonly cause?: unknown;
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
