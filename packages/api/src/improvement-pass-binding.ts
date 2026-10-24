// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, LiveScope, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import type { EvalClassWeights } from './eval-run-binding.js';
import type { PromotionActor } from './live-version-binding.js';
import type { ProposalObjective } from './supervisor-binding.js';

/**
 * Improvement passes (`POST /v1/proposals/improve`,
 * `/v1/improvement-passes`): the runtime looks for better values for an
 * agent version's tunable settings (`x-kindgi-tunable`) on a test set,
 * within a budget, and writes the best as an improvement proposal, which
 * a reviewer then decides like any other. How a pass searches is the
 * runtime's own; this is what starts one and reads it back.
 *
 * Optional: without it, `improve` answers `501 improve-unsupported`.
 */
export interface ImprovementPassBinding {
  /** Record a pass as `running` and start it; it carries on in the background. */
  start(input: StartImprovementPassInput): Promise<ImprovementPass>;
  /** A pass, or `null` when the tenant has none with that id. */
  get(input: {
    readonly tenantId: TenantId;
    readonly passId: string;
  }): Promise<ImprovementPass | null>;
  /** The tenant's passes, newest first; `agentId` narrows them. */
  list(input: ListImprovementPassesInput): Promise<{
    readonly data: readonly ImprovementPass[];
    readonly nextCursor?: Cursor;
  }>;
  /** Stop a running pass: it ends `cancelled`, writing no proposal. */
  cancel(input: {
    readonly tenantId: TenantId;
    readonly passId: string;
    readonly by: string;
  }): Promise<
    | { readonly kind: 'ok'; readonly pass: ImprovementPass }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'finished'; readonly pass: ImprovementPass }
  >;
  /**
   * The basis for a cost estimate of a pass this input would start: how many
   * replay runs its comparisons make, and the version's mean cost over its
   * recent completed runs. Optional: without it, `POST
   * /v1/proposals/improve/estimate` answers `501 improve-unsupported`.
   */
  estimateBasis?(input: EstimateImprovementPassInput): Promise<ImprovementPassEstimateBasis>;
}

/** What a pass tunes: settings values, or (drafted by a model) a prompt template. */
export type ImprovementTier = 'settings' | 'prompt';

/** A provider and model, by the tenant's provider id. */
export interface ImprovementModel {
  readonly providerId: string;
  readonly model: string;
}

export interface ImprovementBudget {
  /** The most the pass's comparisons may cost, in US dollars. */
  readonly maxCostUsd: number;
  /** The most candidates it compares. */
  readonly maxCandidates: number;
}

export interface StartImprovementPassInput {
  readonly tenantId: TenantId;
  /**
   * The project the pass works in: its test set is one the project
   * reaches, and its eval runs run there. Absent when the agent store
   * records no projects.
   */
  readonly projectId?: ProjectId;
  readonly agentId: string;
  /** The version whose settings it tunes. */
  readonly fromVersion: string;
  /** The live scope the proposal it writes is for. */
  readonly scope: LiveScope;
  /** The test set it searches and proves on (split into a search and a hold-out part). */
  readonly suiteId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: ProposalObjective;
  /**
   * Which judgments its comparisons count: everyone (`as-recorded`) or trusted
   * only (`restricted-only`).
   */
  readonly classWeights: EvalClassWeights;
  /** For a prompt pass: what drafts the templates. */
  readonly model?: ImprovementModel;
  /** For a prompt pass: how many templates it drafts. */
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  readonly requestedBy: PromotionActor;
}

/**
 * What a cost estimate reads: the pass's shape, without a budget or requester.
 * The budget cap is applied by the route (it clamps the estimate); the basis
 * doesn't need it.
 */
export interface EstimateImprovementPassInput {
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
  readonly suiteId: string;
  readonly tiers: readonly ImprovementTier[];
  /** For a prompt pass: what drafts the templates. */
  readonly model?: ImprovementModel;
  /** For a prompt pass: how many templates it drafts. */
  readonly candidates?: number;
}

/** What the route turns into a cost estimate. */
export interface ImprovementPassEstimateBasis {
  /** How many replay runs the pass's comparisons would make (from the comparison code). */
  readonly replays: number;
  /**
   * The version's mean cost over its recent completed runs (US dollars, a
   * decimal string); absent when the version has no cost history.
   */
  readonly meanRunCostUsd?: string;
}

/**
 * When an `improve` schedule's fire starts a pass: enough "no" judgments on
 * the agent's runs in the scope since its last pass, across enough runs, from
 * enough judges. Everyone's "no" counts until a restricted judge class is
 * named (in the tenant, the project, or on the agent), then only trusted ones
 * do; with no judge-class binding wired, trusted only. One judge can't start a
 * pass alone.
 */
export interface ImproveThreshold {
  readonly judgments: number;
  readonly runs: number;
  readonly judges: number;
}

/** An `improve` schedule's input (`config.input`): when a fire starts a pass, and the pass's options. */
export interface ImproveScheduleInput {
  readonly tiers: readonly ImprovementTier[];
  readonly objective: ProposalObjective;
  /**
   * Which judgments each pass's comparisons count. Omitted: each fire
   * resolves the project default — everyone (`as-recorded`) until the
   * project names a restricted judge class, then `restricted-only`.
   */
  readonly classWeights?: EvalClassWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  /** Each pass's budget; never more than what's left of the month's cap. */
  readonly budget: ImprovementBudget;
  readonly threshold: ImproveThreshold;
  /** The most its passes may cost in a calendar month (UTC), in US dollars. */
  readonly monthlyCapUsd: number;
}

export const IMPROVE_SCHEDULE_DEFAULTS = {
  threshold: { judgments: 5, runs: 3, judges: 2 },
  monthlyCapUsd: 20,
  /** The shortest interval between an `improve` schedule's occurrences: a pass costs money. */
  minIntervalSeconds: 3600,
} as const;

export interface ListImprovementPassesInput {
  readonly tenantId: TenantId;
  readonly agentId?: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export type ImprovementPassStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** What a finished pass found. */
export type ImprovementPassOutcome =
  /** Its best candidate beat the current values on the hold-out part: an improvement proposal. */
  | { readonly kind: 'proposed'; readonly proposalId: string }
  /** No candidate beat them by more than the noise (or within the budget); no proposal. */
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

export interface ImprovementPass {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly suiteId: string;
  readonly tiers: readonly ImprovementTier[];
  readonly objective: ProposalObjective;
  readonly classWeights: EvalClassWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  /** `user:<id>` or `service:<id>`. */
  readonly requestedBy: string;
  readonly status: ImprovementPassStatus;
  /** Candidates compared so far. */
  readonly candidatesEvaluated: number;
  /** What its comparisons have cost so far, in US dollars (a decimal string). */
  readonly costUsd: string;
  /** Set once it ends. */
  readonly outcome?: ImprovementPassOutcome;
  /**
   * Why a `cancelled` pass stopped when nobody cancelled it: a comparison's
   * eval run was cancelled for it (its `cancelReason`, e.g.
   * `project-suspended`). Absent when it was cancelled.
   */
  readonly cancelReason?: string;
  /** Its comparisons so far, each an eval run to open. */
  readonly comparisons?: readonly ImprovementPassComparison[];
  /** The `improve` schedule and fire that started it; absent for a pass a person started. */
  readonly trigger?: { readonly triggerId: string; readonly fireId: string };
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly finishedAt?: Timestamp;
}

/** One comparison a pass ran: the version as it is, a candidate, or the proposal's proof. */
export interface ImprovementPassComparison {
  /** Absent until it started. */
  readonly evalRunId?: string;
  /**
   * `reference`: the version as it is (on the hold-out part too for a
   * model-settings change: what its proof is held to); `candidate`: other
   * values; `proof`: the proposal, on the hold-out part.
   */
  readonly role: 'reference' | 'candidate' | 'proof';
  readonly part: 'search' | 'hold-out';
  /** For a candidate: its block, and the values it changed. */
  readonly blockId?: string;
  readonly changed?: Readonly<Record<string, unknown>>;
  /** Its score on the pass's objective, once it finished (`null`: no judged evidence). */
  readonly score?: number | null;
  /** Why it didn't run or finish, when it didn't. */
  readonly failed?: string;
  /** For a drafted template that was never compared: why the check refused it. */
  readonly refused?: readonly { readonly path: string; readonly message: string }[];
  /** For a drafted template: what the drafter meant it to change. */
  readonly hypothesis?: string;
}
