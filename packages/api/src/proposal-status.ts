// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EvalRun, EvalRunStatus } from './eval-run-binding.js';
import type { JudgedComparisonSummary } from './judged-dispatcher.js';
import type { Promotion } from './live-version-binding.js';
import type { ProposalObjective, ProposalRule, StoredProposal } from './supervisor-binding.js';

/**
 * Where an improvement proposal stands. Never stored: it follows from the
 * proposal's own steps, its comparison eval run and its promotion.
 *
 * - `draft`: not evaluated yet.
 * - `evaluating`: its comparison is queued or running.
 * - `evaluated`: the comparison finished and the candidate beat the
 *   recorded outputs on the objective metric by more than the noise.
 *   Under `rule: 'cheaper'`, it was instead no worse than the current
 *   version on the same cases and cost less; with a reference (a
 *   model-settings change), also no correction the current version
 *   passes failed.
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
  /** How the candidate is kept (`ProposalEvaluationRef.rule`). Absent: `better`. */
  readonly rule?: ProposalRule;
  /** With a reference: its eval run's status (the candidate's is `runStatus`). */
  readonly referenceStatus?: EvalRunStatus;
  /** With a reference, once both finished: each side's replays' cost, when both reported one. */
  readonly costUsd?: { readonly current: number; readonly candidate: number };
  /** With a reference, once both finished: the corrections the current version was checked on. */
  readonly decisions?: ProposalDecisions;
  /**
   * With a reference, once both finished: whether the candidate is kept
   * under its rule, its decisions kept; `notKept` says why not.
   */
  readonly kept?: boolean;
  readonly notKept?: ProposalNotKept;
}

/**
 * The corrections the current version (the reference) was checked on,
 * against the candidate: `held`, it passed them and so did the candidate;
 * `broken`, it passed them and the candidate didn't; `stillWrong`,
 * neither passed. The rest the candidate fixed.
 */
export interface ProposalDecisions {
  readonly checked: number;
  readonly held: number;
  readonly broken: number;
  readonly stillWrong: number;
}

/**
 * Why a candidate with a reference isn't kept, the first that applies:
 * no correction was checked; one the current version passes broke; the
 * two comparisons didn't run the same cases (the candidate errored on
 * one, or they counted others); it's no better (`better`) or worse than
 * the current version (`cheaper`); it doesn't cost less beyond the
 * cost's own spread.
 */
export type ProposalNotKept =
  | 'no-decisions'
  | 'decisions-broken'
  | 'other-cases'
  | 'not-better'
  | 'worse'
  | 'not-cheaper';

/** Room for float rounding. */
const EPSILON = 1e-9;

/** A finished comparison's summary, or `null` for any other eval run. */
export function comparisonSummaryOf(run: EvalRun): JudgedComparisonSummary | null {
  const summary = run.result?.summary;
  return run.kind === 'judged' && summary !== null && typeof summary === 'object'
    ? (summary as JudgedComparisonSummary)
    : null;
}

/**
 * The proposal's evaluation, read off its eval run, and with a reference
 * (the current version replayed on the same cases) held to it under its
 * rule.
 */
export function evaluationOutcome(
  objective: ProposalObjective,
  run: EvalRun,
  against?: { readonly rule: ProposalRule; readonly reference: EvalRun },
): ProposalEvaluationOutcome {
  const rule = against !== undefined && { rule: against.rule };
  const referenceStatus = against !== undefined && { referenceStatus: against.reference.status };
  const summary = run.status === 'completed' ? comparisonSummaryOf(run) : null;
  if (summary === null) return { runStatus: run.status, objective, ...rule, ...referenceStatus };
  const metric = summary.metrics[objective];
  const noise = metric.spread ?? 0;
  const better = metric.delta !== null && metric.delta > noise + EPSILON;
  const reference =
    against?.reference.status === 'completed' ? comparisonSummaryOf(against.reference) : null;
  return {
    runStatus: run.status,
    objective,
    baseline: metric.baseline,
    candidate: metric.candidate,
    delta: metric.delta,
    ...(metric.spread !== undefined && { spread: metric.spread }),
    cases: summary.cases,
    better,
    ...rule,
    ...referenceStatus,
    ...(against !== undefined &&
      reference !== null &&
      heldTo(objective, against.rule, summary, reference, better)),
  };
}

/** A finished candidate held to its finished reference under the rule. */
function heldTo(
  objective: ProposalObjective,
  rule: ProposalRule,
  candidate: JudgedComparisonSummary,
  reference: JudgedComparisonSummary,
  better: boolean,
): Pick<ProposalEvaluationOutcome, 'costUsd' | 'decisions' | 'kept' | 'notKept'> {
  const decisions = decisionsOf(reference, candidate);
  const current = reference.costUsd;
  const cost = candidate.costUsd;
  let notKept: ProposalNotKept | undefined;
  if (decisions.checked === 0) notKept = 'no-decisions';
  else if (decisions.broken > 0) notKept = 'decisions-broken';
  else if (rule === 'better') notKept = better ? undefined : 'not-better';
  else notKept = notCheaper(objective, candidate, reference);
  return {
    ...(current !== undefined &&
      cost !== undefined && {
        costUsd: { current: current.candidate, candidate: cost.candidate },
      }),
    decisions,
    kept: notKept === undefined,
    ...(notKept !== undefined && { notKept }),
  };
}

/**
 * Under `cheaper`, why the candidate isn't kept: it didn't run the same
 * cases with a cost for each, it's worse beyond the reference's spread,
 * or it doesn't cost less beyond the cost's own; `undefined` when it's kept.
 */
function notCheaper(
  objective: ProposalObjective,
  candidate: JudgedComparisonSummary,
  reference: JudgedComparisonSummary,
): ProposalNotKept | undefined {
  const current = reference.costUsd;
  const cost = candidate.costUsd;
  if (
    candidate.errors !== 0 ||
    candidate.cases !== reference.cases ||
    current === undefined ||
    cost === undefined ||
    cost.cases !== current.cases
  ) {
    return 'other-cases';
  }
  const mine = candidate.metrics[objective].candidate;
  const theirs = reference.metrics[objective];
  if (mine === null || theirs.candidate === null) return 'worse';
  if (mine < theirs.candidate - (theirs.spread ?? 0) - EPSILON) return 'worse';
  return current.candidate - cost.candidate > (current.spread ?? 0) + EPSILON
    ? undefined
    : 'not-cheaper';
}

/** The corrections the reference was checked on, against the candidate's, by judgment. */
function decisionsOf(
  reference: JudgedComparisonSummary,
  candidate: JudgedComparisonSummary,
): ProposalDecisions {
  const passed = new Set(
    (candidate.corrections?.judgments ?? []).filter((j) => j.pass).map((j) => j.judgmentId),
  );
  let held = 0;
  let broken = 0;
  let stillWrong = 0;
  const checked = reference.corrections?.judgments ?? [];
  for (const j of checked) {
    const kept = passed.has(j.judgmentId);
    if (j.pass && kept) held += 1;
    else if (j.pass) broken += 1;
    else if (!kept) stillWrong += 1;
  }
  return { checked: checked.length, held, broken, stillWrong };
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
      return finishedStatus(evaluation);
  }
}

/**
 * A finished comparison's status. With a reference, the candidate is kept
 * only once that's finished too.
 */
function finishedStatus(evaluation: ProposalEvaluationOutcome): FixProposalStatus {
  const reference = evaluation.referenceStatus;
  if (reference === undefined) return evaluation.better === true ? 'evaluated' : 'not-better';
  switch (reference) {
    case 'pending':
    case 'running':
      return 'evaluating';
    case 'failed':
    case 'cancelled':
      return 'evaluation-failed';
    case 'completed':
      return evaluation.kept === true ? 'evaluated' : 'not-better';
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
