// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, LiveScope, ProjectId, TenantId, Timestamp } from '@kindgi/types';

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
}

/** What a pass tunes: settings blocks (prompts come later). */
export type ImprovementTier = 'settings';

export interface ImprovementBudget {
  /** The most the pass's comparisons may cost, in US dollars. */
  readonly maxCostUsd: number;
  /** The most candidates it compares. */
  readonly maxCandidates: number;
}

export interface StartImprovementPassInput {
  readonly tenantId: TenantId;
  /** The agent version's project, when the agent store records one. */
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
  readonly budget: ImprovementBudget;
  readonly requestedBy: PromotionActor;
}

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
  /** Its comparisons so far, each an eval run to open. */
  readonly comparisons?: readonly ImprovementPassComparison[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly finishedAt?: Timestamp;
}

/** One comparison a pass ran: the version as it is, a candidate, or the proposal's proof. */
export interface ImprovementPassComparison {
  /** Absent until it started. */
  readonly evalRunId?: string;
  /** `reference`: the version as it is; `candidate`: other values; `proof`: the proposal, on the hold-out part. */
  readonly role: 'reference' | 'candidate' | 'proof';
  readonly part: 'search' | 'hold-out';
  /** For a candidate: its block, and the values it changed. */
  readonly blockId?: string;
  readonly changed?: Readonly<Record<string, unknown>>;
  /** Its score on the pass's objective, once it finished (`null`: no judged evidence). */
  readonly score?: number | null;
  /** Why it didn't run or finish, when it didn't. */
  readonly failed?: string;
}
