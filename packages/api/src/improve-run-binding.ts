// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import type { PinActor } from './agent-pin-binding.js';
import type { SuggestedChangeObjective } from './supervisor-binding.js';
import type { TestRunGroupWeights } from './test-run-binding.js';

/**
 * Improve runs (`POST /v1/improve-runs`,
 * `/v1/improve-runs`): the runtime takes a project's corrections, looks for
 * better wording or better values for the tunable settings
 * (`x-kindgi-tunable`) of the version the project runs, on the project's
 * test set, within a budget, and writes what it keeps as a suggested change,
 * which a reviewer then decides like any other. How an Improve run searches is the
 * runtime's own; this is what starts one and reads it back.
 *
 * Optional: without it, `improve` answers `501 improve-unsupported`.
 */
export interface ImproveRunBinding {
  /**
   * Take the project's corrections, record an Improve run as `running` and
   * start it; it carries on in the background. When the agent already has a
   * running Improve run in the project, it starts nothing and answers that
   * run's id: one runs at a time per agent and project.
   */
  start(
    input: StartImproveRunInput,
  ): Promise<
    | { readonly kind: 'started'; readonly improveRun: ImproveRun }
    | { readonly kind: 'running'; readonly improveRunId: string }
  >;
  /** An Improve run, or `null` when the tenant has none with that id. */
  get(input: {
    readonly tenantId: TenantId;
    readonly improveRunId: string;
  }): Promise<ImproveRun | null>;
  /** The tenant's Improve runs, newest first; `agentId`, `projectId` and `status` narrow them. */
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
   * What `POST /v1/improve-runs/check` reads from the runtime: what the
   * Improve run would start from, what it has to work on, the agent and
   * project's running run, and the basis for its cost estimate. The route
   * adds the caller's permission, the registry and the project's state.
   */
  check(input: CheckImproveRunInput): Promise<ImproveRunCheck>;
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
   * The project the Improve run works in: it takes the project's corrections,
   * freezes the project's test set and searches and proves on it, and its
   * test runs run there. It starts from the version the project runs.
   */
  readonly projectId: ProjectId;
  readonly agentId: string;
  /**
   * What it tries, the prompt tier first, within one budget. Absent: every
   * tier that's ready (`prompt` when a prompt block is pinned, `settings`
   * when a pinned settings block has tunable keys).
   */
  readonly tiers?: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  /**
   * Which corrections it takes and its comparisons count: everyone
   * (`as-recorded`) or trusted only (`experts-only`).
   */
  readonly groupWeights: TestRunGroupWeights;
  /**
   * For the prompt tier: what drafts the templates. Absent: the provider and
   * model of the version's own model-settings block.
   */
  readonly model?: ImprovementModel;
  /** For the prompt tier: how many templates it drafts. */
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  readonly requestedBy: PinActor;
}

/**
 * What a readiness check reads: the Improve run's shape, without a budget or
 * requester. The budget cap is applied by the route (it clamps the estimate);
 * the basis doesn't need it.
 */
export interface CheckImproveRunInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly agentId: string;
  /** Absent: every tier that's ready. */
  readonly tiers?: readonly ImprovementTier[];
  /** For the prompt tier: what drafts the templates (absent: the version's own model). */
  readonly model?: ImprovementModel;
  /** For the prompt tier: how many templates it drafts. */
  readonly candidates?: number;
  readonly groupWeights: TestRunGroupWeights;
}

/**
 * What the runtime knows about an Improve run this input would start. The
 * route turns it into the readiness list and the cost estimate.
 */
export interface ImproveRunCheck {
  /** The version it would start from; absent when no version of the agent runs in the project. */
  readonly startsFrom?: ImproveRunStart;
  /**
   * The prompt tier has something to work on: a prompt block is pinned, and a
   * model drafts (the body's, or the version's own).
   */
  readonly wording: boolean;
  /** The settings tier has something to work on: a pinned settings block has tunable keys. */
  readonly settings: boolean;
  /** The project's active cases of the agent's test set. */
  readonly testCases: number;
  /** The agent and project's running Improve run, when there is one. */
  readonly runningId?: string;
  readonly basis: ImproveRunCheckBasis;
  /**
   * This UTC month's spend on the agent and project's Improve runs (started by
   * hand or by the schedule) against the Improve schedule's monthly cap, in
   * US dollars (decimal strings). Present when the agent and project have an
   * Improve schedule.
   */
  readonly month?: { readonly spentUsd: string; readonly capUsd: string };
}

/** The version an Improve run starts from, and why: the project's pin, or its latest. */
export interface ImproveRunStart {
  readonly version: string;
  readonly follows: 'pin' | 'latest';
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
 * An `improve` schedule's input (`config.input`): when a fire starts an
 * Improve run, and what the run may spend. A fire starts one when the
 * project has `corrections` open corrections sorted to `improve`, from
 * `from`, made or sorted to `improve` since the schedule's last Improve run
 * started. One a run gave back waits for new ones; then the run takes every
 * open one.
 */
export interface ImproveScheduleInput {
  /** How many new corrections start a run. */
  readonly corrections: number;
  /** Whose corrections count: the project's experts only, or everyone's. */
  readonly from: 'experts' | 'everyone';
  /** The most one run may cost, in US dollars; never more than what's left of the month's cap. */
  readonly runCapUsd: number;
  /**
   * The most the agent and project's Improve runs may cost in a calendar
   * month (UTC), in US dollars. At the cap, the schedule waits for the next
   * month.
   */
  readonly monthCapUsd: number;
  /** What each run tries; absent: every tier that's ready. */
  readonly tiers?: readonly ImprovementTier[];
  /** For the prompt tier: what drafts the templates; absent: the version's own model. */
  readonly model?: ImprovementModel;
}

export const IMPROVE_SCHEDULE_DEFAULTS = {
  corrections: 5,
  from: 'experts',
  runCapUsd: 5,
  monthCapUsd: 20,
  /** The shortest interval between an `improve` schedule's occurrences: an Improve run costs money. */
  minIntervalSeconds: 3600,
} as const;

export interface ListImproveRunsInput {
  readonly tenantId: TenantId;
  readonly agentId?: string;
  readonly projectId?: ProjectId;
  readonly status?: ImproveRunStatus;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export type ImproveRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** What a finished Improve run found. */
export type ImproveRunOutcome =
  /**
   * A candidate passed more cases than the version it started from, and no
   * case that passed before fails with it: a suggested change.
   */
  | { readonly kind: 'suggested'; readonly suggestedChangeId: string }
  /** No candidate it tried did better; no suggested change. */
  | {
      readonly kind: 'nothing-better';
      readonly reason: string;
      /**
       * The best change's proof numbers, when one got that far: on every
       * case, or on the set-aside part for a run stored before that.
       */
      readonly holdOut?: {
        readonly baseline: number | null;
        readonly candidate: number | null;
        readonly delta: number | null;
        readonly spread?: number;
      };
    }
  /** It reached its budget with nothing kept: what it spent, in US dollars (a decimal string). */
  | { readonly kind: 'cost-cap'; readonly spentUsd: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface ImproveRun {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly agentId: string;
  /**
   * The project it works in; absent on a run started for a tenant or an org
   * before Improve runs worked in a project.
   */
  readonly projectId?: ProjectId;
  readonly startsFrom: ImproveRunStart;
  /** The version of the project's test set it searches and proves on; absent until frozen. */
  readonly testSetVersion?: string;
  /** The test set's cases set aside for the proof (`cases` of `of`); none with fewer than five. */
  readonly setAside: { readonly cases: number; readonly of: number };
  /** The tiers it tries, the prompt tier first. */
  readonly tiers: readonly ImprovementTier[];
  readonly objective: SuggestedChangeObjective;
  readonly groupWeights: TestRunGroupWeights;
  readonly model?: ImprovementModel;
  readonly candidates?: number;
  readonly budget: ImprovementBudget;
  /** `user:<id>` or `service:<id>`. */
  readonly requestedBy: string;
  /** The `improve` schedule and fire that started it; absent when a person started it. */
  readonly trigger?: { readonly triggerId: string; readonly fireId: string };
  readonly status: ImproveRunStatus;
  /** Candidates tried so far. */
  readonly tried: number;
  /** What its comparisons have cost so far, in US dollars (a decimal string). */
  readonly costUsd: string;
  /** Set once it ends. */
  readonly outcome?: ImproveRunOutcome;
  /** The ids of the corrections it took when it started. */
  readonly takes: readonly string[];
  /**
   * Why a `cancelled` Improve run stopped when nobody cancelled it: a comparison's
   * test run was cancelled for it (its `cancelReason`, e.g.
   * `project-suspended`). Absent when it was cancelled.
   */
  readonly cancelReason?: string;
  /** Its comparisons so far, each a test run to open. */
  readonly comparisons?: readonly ImproveRunComparison[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly finishedAt?: Timestamp;
}

/** One comparison an Improve run ran: the version as it is, a candidate, or the suggested change's proof. */
export interface ImproveRunComparison {
  /** Absent until it started. */
  readonly testRunId?: string;
  /**
   * `reference`: the version as it is, on each part (what the proof is held
   * to, case by case); `candidate`: other values or wording, on the search
   * part (what picks the change to suggest); `proof`: the suggested change,
   * on every case at the reference's repetitions (what keeps it or not).
   */
  readonly role: 'reference' | 'candidate' | 'proof';
  /**
   * The cases it ran: the search part, the hold-out part, or `all` of them
   * (a proof; an Improve run from before 0.4 ran its proof on the
   * hold-out part).
   */
  readonly part: 'search' | 'hold-out' | 'all';
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
