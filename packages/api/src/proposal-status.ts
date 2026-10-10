// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvalRun, EvalRunStatus } from './eval-run-binding.js';
import type { JudgedComparisonSummary } from './judged-dispatcher.js';
import type { Promotion } from './live-version-binding.js';
import type { ProposalObjective, StoredProposal } from './supervisor-binding.js';

/**
 * Where an improvement proposal stands. Never stored: it follows from the
 * proposal's own steps, its comparison eval run and its promotion.
 *
 * - `draft`: not evaluated yet.
 * - `evaluating`: its comparison is queued or running.
 * - `evaluated`: the comparison finished and the candidate beat the
 *   recorded outputs on the objective metric by more than the noise.
 * - `not-better`: the comparison finished; the candidate didn't.
 * - `evaluation-failed`: the comparison failed or was cancelled.
 * - `in-review`: requested; the gate passed and an approval is open.
 * - `promoted`: the candidate went live for the scope.
 * - `refused`: requested; the gate refused it.
 * - `rejected`: the reviewer rejected it.
 * - `expired`: the approval expired undecided.
 * - `superseded`: approved after the scope's live version or policy changed.
 * - `rolled-back`: rolled back through the proposal.
 * - `withdrawn`: withdrawn.
 */
export type FixProposalStatus =
  | 'draft'
  | 'evaluating'
  | 'evaluated'
  | 'not-better'
  | 'evaluation-failed'
  | 'in-review'
  | 'promoted'
  | 'refused'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'rolled-back'
  | 'withdrawn';

export const FIX_PROPOSAL_STATUSES: readonly FixProposalStatus[] = [
  'draft',
  'evaluating',
  'evaluated',
  'not-better',
  'evaluation-failed',
  'in-review',
  'promoted',
  'refused',
  'rejected',
  'expired',
  'superseded',
  'rolled-back',
  'withdrawn',
];

/** What a finished comparison says about the candidate, on the proposal's objective. */
export interface ProposalEvaluationOutcome {
  readonly runStatus: EvalRunStatus;
  readonly objective: ProposalObjective;
  /** The recorded (judged) outputs' score. `null` without judged evidence. */
  readonly baseline?: number | null;
  readonly candidate?: number | null;
  readonly delta?: number | null;
  /** With more than one repetition: the candidate's max − min. The noise a delta must beat. */
  readonly spread?: number;
  readonly cases?: number;
  /** Set once the comparison finished. */
  readonly better?: boolean;
}

/** Room for float rounding. */
const EPSILON = 1e-9;

/** A finished comparison's summary, or `null` for any other eval run. */
export function comparisonSummaryOf(run: EvalRun): JudgedComparisonSummary | null {
  const summary = run.result?.summary;
  return run.kind === 'judged' && summary !== null && typeof summary === 'object'
    ? (summary as JudgedComparisonSummary)
    : null;
}

/** The proposal's evaluation, read off its eval run. */
export function evaluationOutcome(
  objective: ProposalObjective,
  run: EvalRun,
): ProposalEvaluationOutcome {
  const summary = run.status === 'completed' ? comparisonSummaryOf(run) : null;
  if (summary === null) return { runStatus: run.status, objective };
  const metric = summary.metrics[objective];
  const noise = metric.spread ?? 0;
  return {
    runStatus: run.status,
    objective,
    baseline: metric.baseline,
    candidate: metric.candidate,
    delta: metric.delta,
    ...(metric.spread !== undefined && { spread: metric.spread }),
    cases: summary.cases,
    better: metric.delta !== null && metric.delta > noise + EPSILON,
  };
}

const PROMOTION_STATUS: Readonly<Record<NonNullable<Promotion['status']>, FixProposalStatus>> = {
  'pending-approval': 'in-review',
  promoted: 'promoted',
  refused: 'refused',
  rejected: 'rejected',
  expired: 'expired',
  superseded: 'superseded',
};

/**
 * A proposal's status from what's recorded: its own steps first
 * (withdrawn, rolled back), then its promotion, then its comparison.
 * `promotion` and `evaluation` are what the proposal's ids resolve to
 * (`undefined` when it has none).
 */
export function proposalStatus(
  proposal: StoredProposal,
  promotion: Promotion | null | undefined,
  evaluation: ProposalEvaluationOutcome | null | undefined,
): FixProposalStatus {
  if (proposal.withdrawn !== undefined) return 'withdrawn';
  if (proposal.rolledBack !== undefined) return 'rolled-back';
  if (promotion !== undefined && promotion !== null) {
    return PROMOTION_STATUS[promotion.status ?? 'promoted'];
  }
  if (evaluation === undefined || evaluation === null) {
    return proposal.evaluation === undefined ? 'draft' : 'evaluation-failed';
  }
  switch (evaluation.runStatus) {
    case 'pending':
    case 'running':
      return 'evaluating';
    case 'failed':
    case 'cancelled':
      return 'evaluation-failed';
    case 'completed':
      return evaluation.better === true ? 'evaluated' : 'not-better';
  }
}

/** The lifecycle calls, and the statuses each starts from. */
export const PROPOSAL_ACTIONS = {
  evaluate: [
    'draft',
    'evaluated',
    'not-better',
    'evaluation-failed',
    'refused',
    'superseded',
    'expired',
  ],
  // Its latest evaluation scored again: once that comparison completed.
  rescore: ['evaluated', 'not-better', 'refused', 'superseded', 'expired'],
  // The gate decides what goes live: a candidate that isn't measurably
  // better (a wording change) can still be requested through it.
  request: ['evaluated', 'not-better', 'refused', 'superseded', 'expired'],
  rollback: ['promoted'],
  withdraw: [
    'draft',
    'evaluated',
    'not-better',
    'evaluation-failed',
    'refused',
    'superseded',
    'expired',
  ],
} as const satisfies Readonly<Record<string, readonly FixProposalStatus[]>>;

export type ProposalAction = keyof typeof PROPOSAL_ACTIONS;

export function proposalActionAllowed(action: ProposalAction, status: FixProposalStatus): boolean {
  return (PROPOSAL_ACTIONS[action] as readonly FixProposalStatus[]).includes(status);
}
