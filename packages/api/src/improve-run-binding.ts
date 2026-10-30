// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, LiveScope, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import type { PromotionActor } from './live-version-binding.js';
import type { SuggestedChangeObjective } from './supervisor-binding.js';
import type { EvalGroupWeights } from './test-run-binding.js';

/**
 * Improve runs (`POST /v1/improve-runs`,
 * `/v1/improve-runs`): the runtime looks for better values for an
 * agent version's tunable settings (`x-kindgi-tunable`) on a test set,
 * within a budget, and writes the best as a suggested change, which
 * a reviewer then decides like any other. How an Improve run searches is the
 * runtime's own; this is what starts one and reads it back.
 *
 * Optional: without it, `improve` answers `501 improve-unsupported`.
 */
export interface ImproveRunBinding {
  /** Record an Improve run as `running` and start it; it carries on in the background. */
  start(input: StartImproveRunInput): Promise<ImproveRun>;
  /** An Improve run, or `null` when the tenant has none with that id. */
  get(input: {
    readonly tenantId: TenantId;
    readonly improveRunId: string;
  }): Promise<ImproveRun | null>;
  /** The tenant's Improve runs, newest first; `agentId` narrows them. */
  list(input: ListImproveRunsInput): Promise<{
    readonly data: readonly ImproveRun[];
    readonly nextCursor?: Cursor;
  }>;
  /** Stop a running Improve run: it ends `cancelled`, writing no suggested change. */
  cancel(input: {
    readonly tenantId: TenantId;
    readonly improveRunId: string;
    readonly by: string;
  }): Promise<
    | { readonly kind: 'ok'; readonly improveRun: ImproveRun }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'finished'; readonly improveRun: ImproveRun }
  >;
  /**
   * The basis for a cost estimate of an Improve run this input would start: how many
   * replay runs its comparisons make, and the version's mean cost over its
   * recent completed runs. Optional: without it, `POST
   * /v1/improve-runs/check` answers `501 improve-unsupported`.
   */
  checkBasis?(input: CheckImproveRunInput): Promise<ImproveRunCheckBasis>;
}

/** What an Improve run tunes: settings values, or (drafted by a model) a prompt template. */
export type ImprovementTier = 'settings' | 'prompt';

/** A provider and model, by the tenant's provider id. */
export interface ImprovementModel {
  readonly providerId: string;
  readonly model: string;
}

export interface ImprovementBudget {
  /** The most the Improve run's comparisons may cost, in US dollars. */
  readonly maxCostUsd: number;
  /** The most candidates it compares. */
  readonly maxCandidates: number;
}

export interface StartImproveRunInput {
  readonly tenantId: TenantId;
  /**
   * The project the Improve run works in: its test set is one the project
   * reaches, and its test runs run there. Absent when the agent store
   * records no projects.
   */
  readonly projectId?: ProjectId;
  readonly agentId: string;
  /** The version whose settings it tunes. */
  readonly fromVersion: string;
  /** The live scope the suggested change it writes is for. */
  readonly scope: LiveScope;
  /** The test set it searches and proves on (split into a search and a hold-out part). */
  readonly testSetId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  /**
   * Which corrections its comparisons count: everyone (`as-recorded`) or trusted
   * only (`experts-only`).
   */
  readonly groupWeights: EvalGroupWeights;
  /** For a prompt Improve run: what drafts the templates. */
  readonly model?: ImprovementModel;
  /** For a prompt Improve run: how many templates it drafts. */
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  readonly requestedBy: PromotionActor;
}

/**
 * What a cost estimate reads: the Improve run's shape, without a budget or requester.
 * The budget cap is applied by the route (it clamps the estimate); the basis
 * doesn't need it.
 */
export interface CheckImproveRunInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /**
   * The resolved version whose cost history the estimate reads. The route
   * resolves it from the body (the one serving `scope` when the body names
   * none) and 404s an unknown or inactive one, so the binding always gets a
   * real version.
   */
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly testSetId: string;
  readonly tiers: readonly ImprovementTier[];
  /** For a prompt Improve run: what drafts the templates. */
  readonly model?: ImprovementModel;
  /** For a prompt Improve run: how many templates it drafts. */
  readonly candidates?: number;
}

/** What the route turns into a cost estimate. */
export interface ImproveRunCheckBasis {
  /** How many replay runs the Improve run's comparisons would make (from the comparison code). */
  readonly replays: number;
  /**
   * The version's mean cost over its recent completed runs (US dollars, a
   * decimal string); absent when the version has no cost history.
   */
  readonly meanRunCostUsd?: string;
}

/**
 * When an `improve` schedule's fire starts an Improve run: enough "no" corrections on
 * the agent's runs in the scope since its last Improve run, across enough runs, from
 * enough correctors. Everyone's "no" counts until an expert group is
 * named (in the tenant, the project, or on the agent), then only trusted ones
 * do; with no corrector-group binding wired, trusted only. One corrector can't start
 * an Improve run alone.
 */
export interface ImproveThreshold {
  readonly corrections: number;
  readonly runs: number;
  readonly correctors: number;
}

/** An `improve` schedule's input (`config.input`): when a fire starts an Improve run, and the Improve run's options. */
export interface ImproveScheduleInput {
  readonly tiers: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  /**
   * Which corrections each Improve run's comparisons count. Omitted: each fire
   * resolves the project default — everyone (`as-recorded`) until the
   * project names an expert group, then `experts-only`.
   */
  readonly groupWeights?: EvalGroupWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  /** Each Improve run's budget; never more than what's left of the month's cap. */
  readonly budget: ImprovementBudget;
  readonly threshold: ImproveThreshold;
  /** The most its Improve runs may cost in a calendar month (UTC), in US dollars. */
  readonly monthlyCapUsd: number;
}

export const IMPROVE_SCHEDULE_DEFAULTS = {
  threshold: { corrections: 5, runs: 3, correctors: 2 },
  monthlyCapUsd: 20,
  /** The shortest interval between an `improve` schedule's occurrences: an Improve run costs money. */
  minIntervalSeconds: 3600,
} as const;

export interface ListImproveRunsInput {
  readonly tenantId: TenantId;
  readonly agentId?: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export type ImproveRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** What a finished Improve run found. */
export type ImproveRunOutcome =
  /** Its best candidate beat the current values on the hold-out part: a suggested change. */
  | { readonly kind: 'suggested'; readonly suggestedChangeId: string }
  /** No candidate beat them by more than the noise (or within the budget); no suggested change. */
  | {
      readonly kind: 'nothing-found';
      readonly reason: string;
      /** The best candidate's hold-out numbers, when one got that far. */
      readonly holdOut?: {
        readonly baseline: number | null;
        readonly candidate: number | null;
        readonly delta: number | null;
        readonly spread?: number;
      };
    }
  | { readonly kind: 'failed'; readonly message: string };

export interface ImproveRun {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly testSetId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  readonly groupWeights: EvalGroupWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  /** `user:<id>` or `service:<id>`. */
  readonly requestedBy: string;
  readonly status: ImproveRunStatus;
  /** Candidates compared so far. */
  readonly candidatesEvaluated: number;
  /** What its comparisons have cost so far, in US dollars (a decimal string). */
  readonly costUsd: string;
  /** Set once it ends. */
  readonly outcome?: ImproveRunOutcome;
  /**
   * Why a `cancelled` Improve run stopped when nobody cancelled it: a comparison's
   * test run was cancelled for it (its `cancelReason`, e.g.
   * `project-suspended`). Absent when it was cancelled.
   */
  readonly cancelReason?: string;
  /** Its comparisons so far, each a test run to open. */
  readonly comparisons?: readonly ImproveRunComparison[];
  /** The `improve` schedule and fire that started it; absent for an Improve run a person started. */
  readonly trigger?: { readonly triggerId: string; readonly fireId: string };
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly finishedAt?: Timestamp;
}

/** One comparison an Improve run ran: the version as it is, a candidate, or the suggested change's proof. */
export interface ImproveRunComparison {
  /** Absent until it started. */
  readonly testRunId?: string;
  /**
   * `reference`: the version as it is (on the hold-out part too for a
   * model-settings change: what its proof is held to); `candidate`: other
   * values; `proof`: the suggested change, on the hold-out part.
   */
  readonly role: 'reference' | 'candidate' | 'proof';
  readonly part: 'search' | 'hold-out';
  /** For a candidate: its block, and the values it changed. */
  readonly blockId?: string;
  readonly changed?: Readonly<Record<string, unknown>>;
  /** Its score on the Improve run's objective, once it finished (`null`: no evidence from corrections). */
  readonly score?: number | null;
  /** Why it didn't run or finish, when it didn't. */
  readonly failed?: string;
  /** For a drafted template that was never compared: why the check refused it. */
  readonly refused?: readonly { readonly path: string; readonly message: string }[];
  /** For a drafted template: what the drafter meant it to change. */
  readonly why?: string;
}
